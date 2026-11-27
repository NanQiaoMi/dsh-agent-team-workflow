/**
 * Work item, review/report record, devkit manifest, and git record normalizers
 * for the dashboard snapshot.
 */

import {
  clip,
  countReworkRounds,
  integerOf,
  isoOf,
  isRecord,
  MAX_ITEM_HANDOFFS,
  MAX_ITEM_REQUESTS,
  MAX_RECORDS,
  MAX_THREAD,
  normalizeItemStatus,
  pendingReviewerOf,
  PLAN_STATUSES,
  recordList,
  resolutionState,
  textList,
  textOf,
} from './shared.js'
import { buildClaim, buildItemHandoff, buildReviewRequest } from './collaboration.js'

/**
 * Count the findings of one item that still have no resolution.
 *
 * Approving verdicts mark their findings as `accepted_by_reviewer` in the
 * engine, so they are already excluded here by the resolution test alone — do
 * not add a second verdict-based filter on top.
 * @param reviews - normalized review records of one item.
 * @returns number of open findings.
 */
function countOpenFindings(reviews) {
  let count = 0
  for (const review of reviews) {
    for (const finding of recordList(review.findings)) {
      if (resolutionState(finding.resolution) === null) count += 1
    }
  }
  return count
}

/**
 * Normalize one submitted/pending/superseded review into a snapshot record.
 * @param review - blackboard review.
 * @returns record with the documented camelCase fields.
 */
function buildReviewRecord(review) {
  const findings = recordList(review.findings).map((finding) => ({
    id: textOf(finding.id),
    severity: textOf(finding.severity) || null,
    file: textOf(finding.file) || null,
    line: integerOf(finding.line),
    claim: clip(finding.claim),
    resolution: resolutionState(finding.resolution),
  }))
  return {
    round: integerOf(review.round, 0),
    reviewer: textOf(review.reviewer),
    status: textOf(review.status) || null,
    verdict: textOf(review.verdict) || null,
    summary: clip(review.summary),
    findings,
  }
}

/**
 * Normalize one work report; `null` in, `null` out.
 * @param report - blackboard report.
 * @returns report with the documented fields, or null.
 */
function buildReport(report) {
  if (!isRecord(report)) return null
  const commands = recordList(report.commands).map((command) => ({
    command: clip(command.command),
    exitCode: integerOf(command.exitCode),
    note: command.note === null || command.note === undefined ? null : clip(command.note),
  }))
  const rep = {
    summary: clip(report.summary),
    files: textList(report.files),
    commands,
    evidence: textList(report.evidence),
    risks: textList(report.risks),
    openQuestions: textList(report.openQuestions),
    deviation: typeof report.deviation === 'string' ? clip(report.deviation) : null,
    submittedAt: isoOf(report.submittedAt),
  }
  if (report.archived === true) {
    rep.archived = true
    if (report.archivePath) rep.archivePath = textOf(report.archivePath)
  }
  return rep
}

/**
 * Extract the most recent open finding for an item, to give quick visibility
 * on the dashboard card.
 * @param reviews - blackboard item reviews
 * @returns { id, severity, file, line, claim } or null
 */
function extractLatestFinding(reviews) {
  const list = recordList(reviews)
  for (let r = list.length - 1; r >= 0; r -= 1) {
    const findings = recordList(list[r].findings)
    for (let f = findings.length - 1; f >= 0; f -= 1) {
      const finding = findings[f]
      if (resolutionState(finding.resolution) === null) {
        return {
          id: textOf(finding.id) || null,
          severity: textOf(finding.severity) || 'major',
          file: textOf(finding.file) || null,
          line: integerOf(finding.line),
          claim: clip(finding.claim, 160),
        }
      }
    }
  }
  return null
}

/**
 * Normalize an item's cross-agent handoff packet.
 * @param raw - raw `item.handoffPacket`.
 * @returns normalized handoff packet or null.
 */
function buildHandoffPacket(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
  const val = isRecord(raw.validation) ? raw.validation : null
  return {
    contractId: textOf(raw.contract_id ?? raw.contractId) || null,
    entry: textOf(raw.entry) || null,
    exports: textList(raw.exports),
    notes: typeof raw.notes === 'string' ? clip(raw.notes) : null,
    validation: val
      ? {
          ok: val.ok === true,
          missing: textList(val.missing),
          error: textOf(val.error) || null,
        }
      : null,
  }
}

/**
 * Aggregate an item's plan-first plan record.
 * @param raw - raw `item.plan`.
 * @returns normalized plan record or null.
 */
function buildPlan(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
  const status = textOf(raw.status).trim()
  if (!PLAN_STATUSES.has(status)) return null
  return {
    status,
    steps: textList(raw.steps).slice(0, 40),
    files: textList(raw.files).slice(0, 40),
    risks: textList(raw.risks).slice(0, 20),
    submittedAt: isoOf(raw.submittedAt),
    submittedBy: textOf(raw.submittedBy) || null,
    decidedAt: isoOf(raw.decidedAt),
    decidedBy: textOf(raw.decidedBy) || null,
    reason: textOf(raw.reason) || null,
  }
}

/**
 * Aggregate one item's git record (docs/16 §2.3): commit, verification and PR.
 * @param raw - raw `item.git`.
 * @returns normalized git record or null.
 */
function buildItemGit(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
  const commits = Array.isArray(raw.commits)
    ? raw.commits.slice(-10).map((commit) => ({
        sha: textOf(commit?.sha) || null,
        at: isoOf(commit?.at),
        message: clip(commit?.message, 200),
        files: textList(commit?.files).slice(0, 20),
      }))
    : []
  const verify = raw.verify !== null && typeof raw.verify === 'object'
    ? { ok: raw.verify.ok === true, at: isoOf(raw.verify.at), results: recordList(raw.verify.results).slice(-8).map((entry) => ({
        command: clip(entry?.command, 300),
        exitCode: integerOf(entry?.exitCode),
        outputTail: clip(entry?.outputTail, 400),
      })) }
    : null
  const prReview = raw.prReview !== null && typeof raw.prReview === 'object'
    ? { verdict: textOf(raw.prReview.verdict) || null, at: isoOf(raw.prReview.at), mode: textOf(raw.prReview.mode) || null }
    : null
  return {
    sha: textOf(raw.sha) || null,
    commits,
    verify,
    prReview,
    worktree: textOf(raw.worktree) || null,
    worktreeBranch: textOf(raw.worktreeBranch) || null,
    worktreeMergedAt: isoOf(raw.worktreeMergedAt),
    worktreeMerged: raw.worktreeMerged === true || isoOf(raw.worktreeMergedAt) !== null,
    worktreePresyncedAt: isoOf(raw.worktreePresyncedAt),
    worktreePresynced: raw.worktreePresynced === true || isoOf(raw.worktreePresyncedAt) !== null,
    worktreePath: textOf(raw.worktreePath) || null,
    worktreeMergeError: textOf(raw.worktreeMergeError) || null,
  }
}

/**
 * Normalize one work item.
 * @param raw - blackboard item.
 * @param id - the item's resolved id.
 * @param context - `{ waveOf, taskById, maxRounds, channelEntries, openProposalCounts, stats }`.
 * @returns snapshot item.
 */
export function buildItem(raw, id, context) {
  const taskId = textOf(raw.taskId)
  const task = taskId.length === 0 ? null : (context.taskById.get(taskId) ?? null)
  const reviews = recordList(raw.reviews)
  const submitted = reviews.filter((review) => textOf(review.status) === 'submitted')
  const thread = context.channelEntries.filter((entry) => entry.itemId === id)
  if (thread.length > MAX_THREAD) context.stats.threadClipped += 1
  const report = buildReport(raw.report)
  const summaryPreview = report && report.summary ? clip(report.summary, 140) : null
  const item = {
    id,
    subject: clip(raw.subject),
    owner: textOf(raw.owner),
    role: textOf(raw.role) || 'implementer',
    status: normalizeItemStatus(raw, task),
    wave: integerOf(context.waveOf[id], 0),
    writeScopes: textList(raw.writeScopes),
    blockedBy: textList(raw.blockedBy),
    definitionOfDone: textList(raw.definitionOfDone),
    reviewers: textList(raw.reviewers),
    needsReview: raw.needsReview !== false,
    task:
      task === null
        ? null
        : {
            id: textOf(task.id) || taskId,
            revision: integerOf(task.revision),
            status: textOf(task.status) || null,
          },
    report,
    summaryPreview,
    latestFinding: extractLatestFinding(raw.reviews),
    reviews: {
      reworkRounds: countReworkRounds(raw),
      submittedRounds: submitted.length,
      maxRounds: context.maxRounds,
      pendingReviewer: pendingReviewerOf(raw),
      verdicts: submitted.slice(-MAX_RECORDS).map((review) => ({
        reviewer: textOf(review.reviewer),
        verdict: textOf(review.verdict) || null,
        round: integerOf(review.round, 0),
        reportSeq: integerOf(review.reportSeq, 0),
      })),
      records: reviews.slice(-MAX_RECORDS).map(buildReviewRecord),
    },
    openFindings: countOpenFindings(reviews),
    override: textOf(raw.overrideReason) || null,
    assignment: textOf(raw.assignment).trim().toLowerCase() === 'open' ? 'open' : 'lead',
    claim: buildClaim(raw.claim),
    reviewRequests: recordList(raw.reviewRequests).slice(-MAX_ITEM_REQUESTS).map(buildReviewRequest),
    handoffs: recordList(raw.handoffs).slice(-MAX_ITEM_HANDOFFS).map(buildItemHandoff),
    thread: thread.slice(-MAX_THREAD),
    openProposals: context.openProposalCounts.forItem(id),
    complexity: (() => {
      const c = textOf(raw.complexity).trim().toLowerCase()
      return c === 'trivial' || c === 'complex' ? c : 'normal'
    })(),
    reviewDepth: textOf(raw.resolvedReview?.depth) || (textOf(raw.reviewDepth) && textOf(raw.reviewDepth) !== 'auto' ? textOf(raw.reviewDepth) : null),
    reviewProfile: textOf(raw.resolvedReview?.profile) || (textOf(raw.reviewProfile) && textOf(raw.reviewProfile) !== 'auto' ? textOf(raw.reviewProfile) : null),
    pendingReviewers: [...new Set(reviews.filter((r) => textOf(r.status) === 'pending').map((r) => textOf(r.reviewer)).filter(Boolean))],
    // docs/14 §4: a peer may create work items mid-run; planned items keep the
    // documented defaults, and only the documented 'member' marker is trusted.
    origin: textOf(raw.origin).trim().toLowerCase() === 'member' ? 'member' : 'plan',
    createdBy: isoOf(raw.createdBy),
    plan: buildPlan(raw.plan),
    git: buildItemGit(raw.git),
    handoffPacket: buildHandoffPacket(raw.handoffPacket),
  }
  if (raw.archived === true) item.archived = true
  return item
}

/**
 * Aggregate local devkit architecture manifest and registered contracts.
 * @param raw - raw devkit object.
 * @returns normalized devkit block or null.
 */
export function buildDevkit(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
  const modules = {}
  if (isRecord(raw.modules)) {
    for (const [name, mod] of Object.entries(raw.modules)) {
      if (isRecord(mod)) {
        modules[name] = {
          path: textOf(mod.path),
          entry: textOf(mod.entry),
          exportsCount: integerOf(mod.exportsCount ?? (Array.isArray(mod.exports) ? mod.exports.length : 0)),
          testsCount: integerOf(mod.testsCount ?? (Array.isArray(mod.tests) ? mod.tests.length : 0)),
          exports: Array.isArray(mod.exports) ? textList(mod.exports).slice(0, 50) : [],
        }
      }
    }
  }
  const contracts = []
  if (Array.isArray(raw.contracts)) {
    for (const c of raw.contracts) {
      if (isRecord(c)) {
        contracts.push({
          id: textOf(c.id ?? c.$id),
          title: textOf(c.title),
          version: textOf(c.version),
          methods: textList(c.methods),
          file: textOf(c.file),
        })
      }
    }
  }
  return {
    project: textOf(raw.project) || null,
    runtime: isRecord(raw.runtime)
      ? {
          type: textOf(raw.runtime.type),
          module: textOf(raw.runtime.module),
          testRunner: textOf(raw.runtime.testRunner),
        }
      : null,
    modules,
    contracts,
  }
}

/**
 * Aggregate the run-level git record: branch, push and pull request state.
 * @param raw - raw `state.git`.
 * @returns normalized run git record or null.
 */
export function buildRunGit(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
  const pr = raw.pr !== null && typeof raw.pr === 'object'
    ? {
        url: textOf(raw.pr.url) || null,
        number: raw.pr.number === null || raw.pr.number === undefined ? null : integerOf(raw.pr.number),
        mode: textOf(raw.pr.mode) || null,
        status: textOf(raw.pr.status) || null,
      }
    : null
  return {
    branch: textOf(raw.branch) || null,
    base: textOf(raw.base) || null,
    remote: textOf(raw.remote) || null,
    branchCreated: raw.branchCreated === true,
    pushedAt: isoOf(raw.pushedAt),
    pushedSha: textOf(raw.pushedSha) || null,
    pr,
    mergedAt: isoOf(raw.mergedAt),
    mergeSha: textOf(raw.mergeSha) || null,
    mergedInto: textOf(raw.mergedInto) || null,
    mergeMode: textOf(raw.mergeMode) || null,
  }
}
