/**
 * Pure review policy, diff risk classifier, domain rubrics, DoD verification
 * validator, and structured PR review Markdown formatter (M3).
 *
 * Zero I/O and zero external imports so workflow.js, protocol.js, tools.js,
 * orchestrator.js, and unit tests can share one source of truth.
 */

export const REVIEW_DEPTHS = Object.freeze(['light', 'standard', 'deep'])

export const REVIEW_PROFILES = Object.freeze(['code', 'security', 'api', 'docs', 'tests', 'refactor'])

export const DOD_CHECK_STATUSES = Object.freeze(['pass', 'fail', 'na'])

export const REVIEW_RUBRICS = Object.freeze({
  code: Object.freeze([
    'Correctness & edge cases: check null/empty inputs, error paths, state invariants, and boundary conditions.',
    'Scope & regression safety: confirm changes stay within declared scope and do not break existing callers or tests.',
    'Resource & concurrency hygiene: verify locks, disposers, timeouts, and cleanup on failure.',
    'Evidence verification: cross-check reported command exit codes and outputs against actual modified files.',
  ]),
  security: Object.freeze([
    'Auth & trust boundaries: verify caller identity, role authorization, fail-closed guards, and no privilege bypass.',
    'Input validation & injection: check path traversal, command/SQL/template injection, and schema bounds.',
    'Secrets & data exposure: ensure credentials, tokens, PII, and internal state never leak to logs, artifacts, or responses.',
    'Safe defaults & abuse resistance: verify rate/size limits, timeout enforcement, and safe error handling.',
  ]),
  api: Object.freeze([
    'Contract & schema compatibility: confirm request/response fields, types, defaults, and additionalProperties hold.',
    'Backward compatibility & migration: check existing callers, versioning, and graceful handling of legacy payloads.',
    'Error semantics: verify actionable error messages, machine codes, and deterministic failure behavior.',
    'Validation & serialization: check boundary clamping, enum enforcement, and round-trip fidelity.',
  ]),
  docs: Object.freeze([
    'Factual accuracy: verify file paths, symbol names, CLI flags, config keys, and commands match actual code.',
    'Completeness & clarity: ensure prerequisites, defaults, and caveats match acceptance criteria.',
    'Copy-paste runnability: confirm code snippets, configuration examples, and paths work as written.',
    'No contradictory or stale claims against updated behavior.',
  ]),
  tests: Object.freeze([
    'Behavior coverage: verify assertions test real outcomes and edge cases rather than trivial implementation mirrors.',
    'Failure & boundary paths: check negative inputs, permission failures, timeouts, and error propagation.',
    'Isolation & determinism: confirm tests use isolated fixtures, clean up temp dirs/timers, and are flake-free.',
    'Assertion strength: confirm mocks/stubs do not hide broken production contracts.',
  ]),
  refactor: Object.freeze([
    'Behavior preservation: verify public API signatures, outputs, side effects, and error codes remain unchanged unless specified.',
    'De-duplication & clarity: confirm extracted helpers reduce complexity without adding speculative abstraction.',
    'Dead code & import hygiene: verify no orphaned helpers, unused imports, or partial migrations remain.',
    'Full regression evidence: confirm callers across dependent modules pass verification.',
  ]),
})

const HIGH_RISK_SECURITY_RE = /(?:^|\/)(?:auth|authn|authz|crypto|cipher|secret|secrets|token|tokens|permission|permissions|policy|rules|middleware|guard|sandbox|rbac|acl)(?:[._/-]|$)/i
const HIGH_RISK_DB_RE = /(?:^|\/)(?:migrations?|schema|prisma|drizzle|store|storage)(?:[._/-]|$)|\.sql$/i
const HIGH_RISK_BUILD_RE = /(?:^|\/)\.github\/workflows\/|(?:^|\/)(?:dockerfile|docker-compose(?:\.[^/]+)?|package\.json|package-lock\.json|pnpm-lock\.yaml|yarn\.lock|tsconfig(?:\.[^/]+)?\.json|makefile)$/i
const HIGH_RISK_API_RE = /(?:^|\/)(?:api|protocol|contract|router|endpoint|schema|tools?)(?:[._/-]|$)/i

const DOCS_FILE_RE = /(?:^docs\/|\/docs\/|\.(?:md|mdx|txt|rst)$)/i
const TEST_FILE_RE = /(?:^|\/)(?:tests?|__tests__|specs?)(?:\/|$)|\.(?:test|spec)\.[cm]?[jt]sx?$/i
const STYLE_OR_DATA_FILE_RE = /\.(?:css|scss|less|svg|png|jpg|jpeg|gif|webp)$/i
const NON_CONFIG_JSON_RE = /\.json$/i

function normalizeFilePath(value) {
  return String(value ?? '')
    .trim()
    .replaceAll('\\', '/')
    .replace(/^\.\//, '')
}

function collectFiles({ files = [], diff = null, item = null } = {}) {
  const seen = new Set()
  const add = (candidate) => {
    const clean = normalizeFilePath(candidate)
    if (clean.length === 0 || clean === '/dev/null') return
    seen.add(clean)
  }
  if (Array.isArray(files)) {
    for (const file of files) add(file)
  }
  if (Array.isArray(item?.report?.files)) {
    for (const file of item.report.files) add(file)
  }
  if (typeof diff === 'string' && diff.length > 0) {
    for (const line of diff.split('\n')) {
      if (line.startsWith('+++ ')) {
        const raw = line.slice(4).trim()
        if (raw === '/dev/null') continue
        add(raw.startsWith('b/') ? raw.slice(2) : raw)
      }
    }
  }
  if (seen.size === 0 && Array.isArray(item?.writeScopes)) {
    for (const scope of item.writeScopes) add(scope)
  }
  return [...seen]
}

function countDiffChangedLines(diff) {
  if (typeof diff !== 'string' || diff.length === 0) return 0
  let count = 0
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++') || line.startsWith('---')) continue
    if (line.startsWith('+') || line.startsWith('-')) count += 1
  }
  return count
}

function isLowRiskFile(file) {
  if (HIGH_RISK_BUILD_RE.test(file) || HIGH_RISK_SECURITY_RE.test(file)) return false
  if (DOCS_FILE_RE.test(file)) return true
  if (TEST_FILE_RE.test(file)) return true
  if (STYLE_OR_DATA_FILE_RE.test(file)) return true
  if (NON_CONFIG_JSON_RE.test(file)) return true
  return false
}

/**
 * Classify change risk and resolve the appropriate review depth + rubric profile.
 *
 * @param {object} [input]
 * @param {string[]} [input.files]
 * @param {string|null} [input.diff]
 * @param {object|null} [input.item]
 * @param {object|null} [input.settings]
 * @returns {{ depth: 'light'|'standard'|'deep', profile: string, autoDetected: boolean, reasons: string[], changedFiles: number, changedLines: number, highRiskFiles: string[] }}
 */
export function classifyDiffRisk({ files = [], diff = null, item = null, settings = null } = {}) {
  const concreteFiles = []
  const seenConcrete = new Set()
  const addConcrete = (value) => {
    const clean = normalizeFilePath(value)
    if (clean.length === 0 || clean === '/dev/null' || seenConcrete.has(clean)) return
    seenConcrete.add(clean)
    concreteFiles.push(clean)
  }
  if (Array.isArray(files)) for (const f of files) addConcrete(f)
  if (Array.isArray(item?.report?.files)) for (const f of item.report.files) addConcrete(f)
  if (typeof diff === 'string' && diff.length > 0) {
    for (const line of diff.split('\n')) {
      if (line.startsWith('+++ ')) {
        const raw = line.slice(4).trim()
        if (raw !== '/dev/null') addConcrete(raw.startsWith('b/') ? raw.slice(2) : raw)
      }
    }
  }

  const uniqueFiles = concreteFiles.length > 0 ? concreteFiles : collectFiles({ files, diff, item })
  const changedLines = countDiffChangedLines(diff)
  const highRiskFiles = uniqueFiles.filter(
    (file) => HIGH_RISK_SECURITY_RE.test(file) || HIGH_RISK_DB_RE.test(file) || HIGH_RISK_BUILD_RE.test(file) || HIGH_RISK_API_RE.test(file),
  )
  const allLowRisk = concreteFiles.length > 0 && concreteFiles.every((file) => isLowRiskFile(file))

  const explicitDepth = typeof item?.reviewDepth === 'string' ? item.reviewDepth.trim().toLowerCase() : ''
  let depth = 'standard'
  let autoDetected = true
  const reasons = []

  if (REVIEW_DEPTHS.includes(explicitDepth)) {
    depth = explicitDepth
    autoDetected = false
    reasons.push('explicit-depth')
  } else {
    const deepReasons = []
    if (item?.complexity === 'complex') deepReasons.push('item-complex')
    if (highRiskFiles.length > 0) deepReasons.push(`high-risk-files(${highRiskFiles.length})`)
    if (changedLines > 300) deepReasons.push(`large-diff(${changedLines}L)`)
    if (uniqueFiles.length > 8) deepReasons.push(`wide-blast-radius(${uniqueFiles.length}F)`)

    if (deepReasons.length > 0) {
      depth = 'deep'
      reasons.push(...deepReasons)
    } else if (item?.complexity === 'trivial' && highRiskFiles.length === 0) {
      depth = 'light'
      reasons.push('item-trivial')
    } else if (allLowRisk && changedLines <= 120 && uniqueFiles.length <= 4) {
      depth = 'light'
      reasons.push('low-risk-docs-tests-assets')
    } else {
      const configuredDefault = typeof settings?.defaultReviewDepth === 'string' ? settings.defaultReviewDepth.trim().toLowerCase() : ''
      depth = REVIEW_DEPTHS.includes(configuredDefault) ? configuredDefault : 'standard'
      reasons.push(REVIEW_DEPTHS.includes(configuredDefault) ? `default-depth(${configuredDefault})` : 'default-standard')
    }
  }

  const explicitProfile = typeof item?.reviewProfile === 'string' ? item.reviewProfile.trim().toLowerCase() : ''
  let profile = 'code'
  if (REVIEW_PROFILES.includes(explicitProfile)) {
    profile = explicitProfile
  } else if (uniqueFiles.some((file) => HIGH_RISK_SECURITY_RE.test(file))) {
    profile = 'security'
  } else if (item?.role === 'writer' || (concreteFiles.length > 0 && concreteFiles.every((file) => DOCS_FILE_RE.test(file)))) {
    profile = 'docs'
  } else if (item?.role === 'verifier' || (concreteFiles.length > 0 && concreteFiles.every((file) => TEST_FILE_RE.test(file)))) {
    profile = 'tests'
  } else if (uniqueFiles.some((file) => HIGH_RISK_API_RE.test(file))) {
    profile = 'api'
  } else if (typeof item?.subject === 'string' && /\b(refactor|cleanup|clean up|extract|rename)\b/i.test(item.subject)) {
    profile = 'refactor'
  }

  return {
    depth,
    profile,
    autoDetected,
    reasons,
    changedFiles: uniqueFiles.length,
    changedLines,
    highRiskFiles,
  }
}

/**
 * Render a concise domain-specific review rubric and severity calibration guide.
 *
 * @param {object} [input]
 * @returns {string}
 */
export function renderReviewRubric({ depth = 'standard', profile = 'code', definitionOfDone = [], reasons = [] } = {}) {
  const safeDepth = REVIEW_DEPTHS.includes(depth) ? depth : 'standard'
  const safeProfile = REVIEW_PROFILES.includes(profile) ? profile : 'code'
  const checklist = REVIEW_RUBRICS[safeProfile] ?? REVIEW_RUBRICS.code
  const depthGuidance =
    safeDepth === 'light'
      ? 'Light check: verify DoD, accuracy, and no obvious regressions; approve_with_nits if clean.'
      : safeDepth === 'deep'
        ? 'Deep audit: trace every modified branch, edge case, failure mode, and security/contract invariant; verify each DoD item explicitly.'
        : 'Standard review: verify correctness, edge cases, test evidence, and DoD compliance.'

  const lines = [`## Review Standard (${safeDepth} / ${safeProfile})`, depthGuidance]
  if (Array.isArray(reasons) && reasons.length > 0) {
    lines.push(`Risk triggers: ${reasons.join(', ')}`)
  }
  lines.push('Focus checklist:')
  for (const entry of checklist) lines.push(`- ${entry}`)
  lines.push('Severity bar: blocker/major -> request_changes or block; minor/nit only -> approve_with_nits (do not bounce for style).')
  if (Array.isArray(definitionOfDone) && definitionOfDone.length > 0) {
    lines.push('DoD verification: record pass/fail/na per DoD condition in `dod_checks` when submitting.')
  }
  return lines.join('\n')
}

/**
 * Validate and normalize optional `dod_checks` entries from `team_flow_review_submit`.
 *
 * @param {unknown} raw
 * @returns {Array<{ item: string, status: 'pass'|'fail'|'na', note: string|null }>}
 */
export function normalizeDodChecks(raw) {
  if (raw === undefined || raw === null) return []
  if (!Array.isArray(raw)) throw new Error('dod_checks must be an array of { item, status, note? }')
  return raw.slice(0, 32).map((entry, index) => {
    const itemText = String(entry?.item ?? '').trim()
    if (itemText.length === 0) throw new Error(`dod_checks[${index}] needs a non-empty item description`)
    const status = String(entry?.status ?? '').trim().toLowerCase()
    if (!DOD_CHECK_STATUSES.includes(status)) {
      throw new Error(`dod_checks[${index}] status "${status}" must be one of ${DOD_CHECK_STATUSES.join(' | ')}`)
    }
    const rawNote = entry?.note === undefined || entry?.note === null ? '' : String(entry.note).trim()
    return {
      item: itemText.length > 300 ? `${itemText.slice(0, 299)}…` : itemText,
      status,
      note: rawNote.length === 0 ? null : (rawNote.length > 400 ? `${rawNote.slice(0, 399)}…` : rawNote),
    }
  })
}

/**
 * Enforce consistency between review verdict, finding severities, and DoD checks.
 *
 * Note: `minor` and `nit` findings are intentionally permitted on `approve_with_nits`.
 *
 * @param {object} input
 * @returns {{ ok: true } | { ok: false, code: string, message: string }}
 */
export function validateReviewSubmission({
  item = null,
  reviewDepth = 'standard',
  verdict,
  findings = [],
  dodChecks = [],
  settings = {},
} = {}) {
  if (verdict === 'approve' || verdict === 'approve_with_nits') {
    const blockingFinding = findings.find((f) => f.severity === 'blocker' || f.severity === 'major')
    if (blockingFinding !== undefined) {
      return {
        ok: false,
        code: 'WORKFLOW_VERDICT_MISMATCH',
        message: `cannot submit "${verdict}" with ${blockingFinding.severity} finding "${blockingFinding.id}"; use request_changes or block, or downgrade non-blocking observations to minor/nit`,
      }
    }
    const failedDod = dodChecks.find((check) => check.status === 'fail')
    if (failedDod !== undefined) {
      return {
        ok: false,
        code: 'WORKFLOW_DOD_FAILED',
        message: `cannot submit "${verdict}" while DoD check "${failedDod.item}" has status "fail"; use request_changes or block`,
      }
    }
    if (
      settings?.strictReviewRubric === true &&
      reviewDepth === 'deep' &&
      Array.isArray(item?.definitionOfDone) &&
      item.definitionOfDone.length > 0 &&
      dodChecks.length === 0
    ) {
      return {
        ok: false,
        code: 'WORKFLOW_DOD_CHECKS_REQUIRED',
        message: `deep review under strictReviewRubric requires dod_checks covering the item's ${item.definitionOfDone.length} definition_of_done item(s)`,
      }
    }
  }
  return { ok: true }
}

function verdictBadge(verdict) {
  if (verdict === 'approve') return 'APPROVE'
  if (verdict === 'approve_with_nits') return 'APPROVE WITH NITS'
  if (verdict === 'request_changes') return 'REQUEST CHANGES'
  if (verdict === 'block') return 'BLOCK'
  return String(verdict ?? 'COMMENT').toUpperCase()
}

/**
 * Format one workflow review into structured Markdown suitable for a GitHub PR review.
 *
 * @param {object} input - `{ item, review, state, risk }`
 * @returns {string}
 */
export function formatPrReviewMarkdown({ item, review, state = null, risk = null } = {}) {
  const effectiveRisk = risk ?? item?.resolvedReview ?? null
  const depth = review?.reviewDepth ?? effectiveRisk?.depth ?? 'standard'
  const profile = review?.reviewProfile ?? effectiveRisk?.profile ?? 'code'
  const lines = []
  lines.push(`### [${verdictBadge(review?.verdict)}] ${item?.id ?? 'Item'} — ${item?.subject ?? ''}`.trim())
  const metaParts = [
    `Reviewer: \`${review?.reviewer ?? 'unknown'}\``,
    `Round: ${review?.round ?? '?'}`,
    `Standard: \`${depth}/${profile}\``,
  ]
  if (review?.reviewedSha) metaParts.push(`Reviewed SHA: \`${String(review.reviewedSha).slice(0, 12)}\``)
  if (state?.runId) metaParts.push(`Run: \`${state.runId}\``)
  lines.push(metaParts.join(' · '))
  lines.push('')
  lines.push('**Summary**')
  lines.push(review?.summary && String(review.summary).trim().length > 0 ? String(review.summary).trim() : '_(no summary provided)_')

  const dodChecks = Array.isArray(review?.dodChecks) ? review.dodChecks : []
  if (dodChecks.length > 0) {
    lines.push('')
    lines.push('**Definition of Done Matrix**')
    lines.push('| Condition | Status | Notes |')
    lines.push('| --- | --- | --- |')
    for (const check of dodChecks) {
      const safeItem = String(check.item ?? '').replaceAll('|', '\\|')
      const safeNote = check.note ? String(check.note).replaceAll('|', '\\|') : '-'
      lines.push(`| ${safeItem} | **${String(check.status ?? '').toUpperCase()}** | ${safeNote} |`)
    }
  }

  const findings = Array.isArray(review?.findings) ? review.findings : []
  if (findings.length > 0) {
    lines.push('')
    lines.push('**Findings**')
    const order = ['blocker', 'major', 'minor', 'nit']
    for (const sev of order) {
      const bucket = findings.filter((f) => f.severity === sev)
      if (bucket.length === 0) continue
      lines.push(`- **${sev.toUpperCase()}** (${bucket.length})`)
      for (const f of bucket) {
        const loc = f.file ? `\`${f.file}${f.line ? `:${f.line}` : ''}\`` : '_(general)_'
        const suggestion = f.suggestion ? ` — _Suggestion:_ ${f.suggestion}` : ''
        lines.push(`  - \`${f.id}\` ${loc}: ${f.claim}${suggestion}`)
      }
    }
  }

  const evidence = Array.isArray(review?.evidenceChecked) ? review.evidenceChecked : []
  if (evidence.length > 0) {
    lines.push('')
    lines.push('**Evidence Checked**')
    for (const entry of evidence) lines.push(`- ${entry}`)
  }

  return lines.join('\n')
}
