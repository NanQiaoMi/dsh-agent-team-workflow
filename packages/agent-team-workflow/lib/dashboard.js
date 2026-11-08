/**
 * Pure aggregation for the live Agent Team dashboard snapshot.
 *
 * This module is deliberately dependency-free: it has **zero imports** (not
 * even Node built-ins), does not read files, does not touch Cordis, and never
 * mutates its input. `dashboard-route.js` feeds it plain data read from the
 * blackboard and the Team board, and the Web client consumes the JSON it
 * returns — so the whole shape of docs/09 §2 and the peer-collaboration layer
 * of docs/12 §5 can be unit-tested offline.
 *
 * Rules this module keeps:
 * - **Never throw on board data.** Every field is read defensively; a missing,
 *   wrongly typed, or absurdly large value degrades to null / [] / 0 instead of
 *   failing the whole snapshot request.
 * - **Every array is bounded.** `events` (200), `items` (64), `members` (16),
 *   `records` (12), `tasks`/`escalations` (64), plus the collaboration caps of
 *   docs/12 §5 — `channel` (60), `proposals` (32), votes (16), `handoffs` (64),
 *   `thread` (20), `edges` (64) — and the long free-text fields are truncated,
 *   so one corrupt board cannot produce a multi-megabyte body.
 * - **Deterministic.** The same input yields the same output; the only clock
 *   read is the documented `generatedAt` fallback when the caller passes no
 *   `now`.
 *
 * Output field names are camelCase and follow docs/09 §2 exactly (e.g.
 * `changesRequested`, `reworkRounds`, `pendingReviewer`, `openFindings`,
 * `writeScopes`, `definitionOfDone`, `acceptanceCriteria`, `finalizedAt`,
 * `statePath`).
 *
 * Version 2 adds the peer-collaboration layer of docs/12 §5: a
 * `run.collaboration` block plus collaboration fields on every item. A
 * version-1 board (one with no collaboration fields at all) still yields the
 * same base snapshot with `collaboration` present but empty, so old runs stay
 * viewable instead of failing.
 *
 * docs/14 (member autonomy / proposal liveness) is additive on the same
 * snapshot version: `items[].origin` + `createdBy`, and
 * `proposals[].deadline` + `autoResolved` + `quorum`. Those blackboard fields
 * are newer than the rest, so their absence is normal and every one of them
 * has a documented default (`plan` / null / null / false / ceil(affected/2)).
 */

/** Snapshot schema version; bump only for a breaking shape change. */
export const SNAPSHOT_VERSION = 2

/** Stop-request states accepted by the snapshot contract. */
const STOP_STATUSES = new Set(['pending', 'accepted', 'rejected', 'interrupted'])

/** Ceilings that keep one snapshot bounded (see docs/09 §2). */
const MAX_EVENTS = 200
const MAX_ITEMS = 64
const MAX_MEMBERS = 16
const MAX_TASKS = 64
const MAX_ESCALATIONS = 64
const MAX_RECORDS = 12
/** Ceiling for free-text fields that have no tighter documented limit. */
const MAX_TEXT = 4000
/** Ceiling for one audit-event detail line (docs/09 §2 truncation list). */
const MAX_EVENT_DETAIL = 500
/** Appended once to a clipped string, so a truncated field is visible as such. */
const ELLIPSIS = '…'
/** Documented board provenance values (docs/09 §2 `diagnostics.boardSource`). */
const BOARD_SOURCES = new Set(['file', 'memory', 'missing'])
/** Peer-collaboration ceilings (docs/12 §5). */
const MAX_CHANNEL = 60
/** Channel text is clipped harder than other free text: it is a chat feed. */
const MAX_CHANNEL_TEXT = 500
const MAX_PROPOSALS = 32
const MAX_VOTES = 16
const MAX_HANDOFFS = 64
const MAX_THREAD = 20
const MAX_EDGES = 64
/** Defensive per-item caps for the collaboration sub-lists (not in the doc). */
const MAX_ITEM_REQUESTS = 16
const MAX_ITEM_HANDOFFS = 16
/** Proposal kinds that block approval while still open (mirrors the engine). */
const BLOCKING_PROPOSAL_KINDS = new Set(['dod', 'scope', 'replan'])

/** @returns whether one value is a plain object (not null, not an array). */
function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * Coerce one value to text without ever throwing (a Symbol or an object with a
 * throwing `toString` must not break a snapshot).
 * @param value - any board value.
 * @param fallback - text to use for a missing/unrepresentable value.
 * @returns string text.
 */
function textOf(value, fallback = '') {
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return fallback
}

/** @returns only the plain objects of one array value. */
function recordList(value) {
  return Array.isArray(value) ? value.filter(isRecord) : []
}

/**
 * Normalize one array field into a bounded list of short/medium text entries.
 * Non-scalar entries (nested objects, arrays) are dropped: the client renders
 * strings, and an object there would only stringify to `[object Object]`.
 * @param value - raw array field.
 * @param max - per-entry text ceiling.
 * @returns array of strings.
 */
function textList(value, max = MAX_TEXT) {
  if (!Array.isArray(value)) return []
  const result = []
  for (const entry of value) {
    const text = textOf(entry)
    if (text.length > 0) result.push(text.length > max ? `${text.slice(0, max)}${ELLIPSIS}` : text)
  }
  return result
}

/**
 * Clip one long text field, marking the truncation with an ellipsis.
 * @param value - raw text.
 * @param max - maximum retained characters (the ellipsis is extra).
 * @returns clipped text.
 */
function clip(value, max = MAX_TEXT) {
  const text = textOf(value)
  return text.length > max ? `${text.slice(0, max)}${ELLIPSIS}` : text
}

/** @returns one integer value, or the fallback (null by default). */
function integerOf(value, fallback = null) {
  return Number.isInteger(value) ? value : fallback
}

/** @returns one non-empty string value, or null. */
function isoOf(value) {
  return typeof value === 'string' && value.length > 0 ? value : null
}

/** @returns the epoch milliseconds of one timestamp; 0 when unparseable. */
function parseAt(value) {
  const parsed = Date.parse(textOf(value))
  return Number.isNaN(parsed) ? 0 : parsed
}

/**
 * Sort records by their `at` timestamp, oldest first.
 *
 * Records without a parseable timestamp sort first (they are the least useful
 * on a live board, and they fall off a cap first). Equal timestamps keep the
 * original append order, so the output is stable and deterministic.
 * @param records - records carrying an `at` field.
 * @returns a sorted copy.
 */
function sortByAt(records) {
  return records
    .map((record, index) => ({ record, index, time: parseAt(record.at) }))
    .sort((left, right) => (left.time === right.time ? left.index - right.index : left.time - right.time))
    .map((entry) => entry.record)
}

/** @returns whether one verdict string counts as an approval (mirrors the engine). */
function isApprovingVerdict(verdict) {
  return verdict === 'approve' || verdict === 'approve_with_nits'
}

/**
 * Read the resolution state of one finding.
 *
 * The engine stores a resolution as an object (`{ state, evidence, note, at,
 * by }`) and leaves it `null` while the finding is open. A plain string is
 * tolerated so an older/foreign board still renders.
 * @param resolution - raw `finding.resolution`.
 * @returns the state string (`fixed` / `rebut` / `accepted_risk` /
 *   `accepted_by_reviewer`), or `null` when the finding is still open.
 */
function resolutionState(resolution) {
  if (typeof resolution === 'string') return resolution.length > 0 ? resolution : null
  if (!isRecord(resolution)) return null
  return textOf(resolution.state) || null
}

/**
 * Compute the execution waves of a run from item dependencies.
 *
 * This mirrors the workflow engine's layering: an item that declares no
 * blockers lands in wave 1, an item lands one wave after its last blocker, and
 * every item that can never become ready (a dependency cycle, or an item
 * blocked by one) is reported in `cycle` with `waveOf == 0`. Dependencies on an
 * item id that is not part of the board are ignored: the dashboard must not
 * hang forever waiting for a phantom item.
 * @param items - `[{ id, blockedBy }]` (missing/ill-typed entries are skipped).
 * @returns `{ waves, waveOf, cycle }` where `waves` is 1-indexed by position,
 *   `waveOf` maps item id → wave number (0 = can never run), and `cycle` lists
 *   the ids that can never run, sorted.
 */
export function computeWaves(items) {
  const entries = recordList(items)
  const ids = []
  const known = new Set()
  for (const item of entries) {
    const id = textOf(item.id)
    if (id.length === 0 || known.has(id)) continue
    known.add(id)
    ids.push(id)
  }
  /** @type {Map<string, string[]>} */
  const dependencies = new Map()
  for (const item of entries) {
    const id = textOf(item.id)
    if (!known.has(id) || dependencies.has(id)) continue
    const declared = Array.isArray(item.blockedBy) ? item.blockedBy : []
    const deps = []
    for (const blocker of declared) {
      const dep = textOf(blocker)
      if (dep.length === 0 || !known.has(dep) || deps.includes(dep)) continue
      deps.push(dep)
    }
    dependencies.set(id, deps)
  }

  const done = new Set()
  const waves = []
  for (;;) {
    const ready = ids.filter((id) => !done.has(id) && dependencies.get(id).every((dep) => done.has(dep))).sort()
    if (ready.length === 0) break
    waves.push(ready)
    for (const id of ready) done.add(id)
  }

  const cycle = ids.filter((id) => !done.has(id)).sort()
  const waveOf = {}
  waves.forEach((wave, index) => {
    for (const id of wave) waveOf[id] = index + 1
  })
  for (const id of cycle) waveOf[id] = 0
  return { waves, waveOf, cycle }
}

/**
 * Normalize one work item's blackboard state plus its backing Team task into
 * the display status set used by the snapshot.
 *
 * Mapping (docs/09 §2):
 * - `approved` / `in_review` / `changes_requested` / `escalated` pass through;
 * - `reported` is a review wait → `in_review`;
 * - `running` is only shown while no report exists (a report means the item is
 *   waiting on review) — a blackboard `running` is trusted, and a `pending`
 *   item with a native task that is `in_progress` is promoted to `running`;
 * - everything else is `pending`.
 * @param item - blackboard item (may be missing/ill-typed).
 * @param task - backing native task (`{ status }`) or null.
 * @returns one of `pending | running | in_review | changes_requested |
 *   approved | escalated`.
 */
export function normalizeItemStatus(item, task) {
  const source = isRecord(item) ? item : {}
  const status = textOf(source.status).trim().toLowerCase()
  const taskStatus = isRecord(task) ? textOf(task.status).trim().toLowerCase() : ''
  const reported = isRecord(source.report)
  if (status === 'approved') return 'approved'
  if (status === 'escalated') return 'escalated'
  if (status === 'changes_requested' || status === 'changes-requested' || status === 'changesrequested') return 'changes_requested'
  if (status === 'in_review' || status === 'in-review' || status === 'reported') return 'in_review'
  if (status === 'running') return reported ? 'in_review' : 'running'
  if (reported) return 'in_review'
  return taskStatus === 'in_progress' ? 'running' : 'pending'
}

/** Alias kept for docs/09 §3, which names the helper `normalizeStatus`. */
export const normalizeStatus = normalizeItemStatus

/**
 * Keep the most recent `limit` audit events, returned oldest → newest.
 *
 * Events without a parseable `at` sort first (they are the least useful on a
 * live board) and therefore fall off first when the array is trimmed. Ties keep
 * the original append order, so the output is stable.
 * @param events - raw blackboard events (missing/ill-typed entries dropped).
 * @param limit - how many events to keep (default 200).
 * @returns the retained event objects, ascending by time.
 */
export function tailEvents(events, limit = MAX_EVENTS) {
  const list = recordList(events)
  const max = Number.isFinite(limit) ? Math.max(0, Math.trunc(limit)) : MAX_EVENTS
  if (max === 0) return []
  return sortByAt(list).slice(-max)
}

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
 * Count the rework rounds of one item. The engine stores the cumulative counter
 * as `reworkTotal`; when an older/foreign board omits it, the count of
 * submitted non-approving verdicts is the faithful fallback.
 * @param item - blackboard item.
 * @returns non-negative round count.
 */
function countReworkRounds(item) {
  const stored = integerOf(item.reworkTotal)
  if (stored !== null) return Math.max(0, stored)
  let derived = 0
  for (const review of recordList(item.reviews)) {
    if (textOf(review.status) !== 'submitted') continue
    if (!isApprovingVerdict(textOf(review.verdict))) derived += 1
  }
  return derived
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
  return {
    summary: clip(report.summary),
    files: textList(report.files),
    commands,
    evidence: textList(report.evidence),
    risks: textList(report.risks),
    openQuestions: textList(report.openQuestions),
    deviation: typeof report.deviation === 'string' ? clip(report.deviation) : null,
    submittedAt: isoOf(report.submittedAt),
  }
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
 * Normalize one work item.
 * @param raw - blackboard item.
 * @param id - the item's resolved id.
 * @param context - `{ waveOf, taskById, maxRounds, channelEntries, openProposalCounts, stats }`.
 * @returns snapshot item.
 */
function buildItem(raw, id, context) {
  const taskId = textOf(raw.taskId)
  const task = taskId.length === 0 ? null : (context.taskById.get(taskId) ?? null)
  const reviews = recordList(raw.reviews)
  const submitted = reviews.filter((review) => textOf(review.status) === 'submitted')
  const thread = context.channelEntries.filter((entry) => entry.itemId === id)
  if (thread.length > MAX_THREAD) context.stats.threadClipped += 1
  const report = buildReport(raw.report)
  const summaryPreview = report && report.summary ? clip(report.summary, 140) : null
  return {
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
    // docs/14 §4: a peer may create work items mid-run; planned items keep the
    // documented defaults, and only the documented 'member' marker is trusted.
    origin: textOf(raw.origin).trim().toLowerCase() === 'member' ? 'member' : 'plan',
    createdBy: isoOf(raw.createdBy),
    plan: buildPlan(raw.plan),
    git: buildItemGit(raw.git),
  }
}

/**
 * Aggregate one item's git record (docs/16 §2.3): commit, verification and PR.
 * @param raw - raw `item.git`.
 * @returns normalized git record or null.
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

/** Plan-review states accepted by the snapshot contract. */
const PLAN_STATUSES = new Set(['pending', 'approved', 'rejected'])

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
    worktreePath: textOf(raw.worktreePath) || null,
    worktreeMergeError: textOf(raw.worktreeMergeError) || null,
  }
}

/**
 * Aggregate the run-level git record: branch, push and pull request state.
 * @param raw - raw `state.git`.
 * @returns normalized run git record or null.
 */
function buildRunGit(raw) {
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

/**
 * Aggregate the token-usage snapshot captured at gate time (docs/19 §6).
 * @param raw - raw `state.usage`.
 * @returns `{capturedAt, members, totals}` or null.
 */
function buildUsage(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
  const bucket = (value) => {
    if (value === null || typeof value !== 'object') return null
    return {
      uncachedInputTokens: integerOf(value.uncachedInputTokens),
      outputTokens: integerOf(value.outputTokens),
      cacheReadTokens: integerOf(value.cacheReadTokens),
      cacheWriteTokens: integerOf(value.cacheWriteTokens),
    }
  }
  const members = {}
  if (raw.members !== null && typeof raw.members === 'object' && !Array.isArray(raw.members)) {
    for (const [name, totals] of Object.entries(raw.members).slice(0, 32)) {
      const normalized = bucket(totals)
      if (normalized !== null) members[String(name)] = normalized
    }
  }
  const totals = bucket(raw.totals)
  if (totals === null && Object.keys(members).length === 0) return null
  return { capturedAt: isoOf(raw.capturedAt), members, totals }
}

/**
 * Build the counts block from the already-normalized items, so the numbers can
 * never disagree with what the client renders.
 * `pending` deliberately includes `running`: the contract has no separate
 * `running` bucket, and the six buckets must add up to `total`.
 * @param items - normalized snapshot items.
 * @returns counts record.
 */
function buildCounts(items) {
  const counts = { total: items.length, approved: 0, pending: 0, inReview: 0, changesRequested: 0, escalated: 0 }
  for (const item of items) {
    if (item.status === 'approved') counts.approved += 1
    else if (item.status === 'pending' || item.status === 'running') counts.pending += 1
    else if (item.status === 'in_review') counts.inReview += 1
    else if (item.status === 'changes_requested') counts.changesRequested += 1
    else if (item.status === 'escalated') counts.escalated += 1
  }
  return counts
}

/**
 * Pass the run-scoped settings through unchanged.
 *
 * The engine freezes `{ maxReviewRounds, maxParallelItems, workerContext,
 * strictScopes, allowScopeOverlap, requireReviewEvidence }` into the run;
 * docs/09 §2 also shows `autoNotify`. Field names must stay exactly as the
 * blackboard stores them — no renaming to `maxRounds` etc.
 * @param settings - blackboard run settings.
 * @returns plain object of scalar settings.
 */
function buildSettings(settings) {
  if (!isRecord(settings)) return {}
  const result = {}
  for (const [key, value] of Object.entries(settings)) {
    if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') result[key] = value
  }
  return result
}

/**
 * Resolve one artifact path. An explicitly passed route value (including an
 * explicit `null`, which means "artifacts are disabled") wins over the copy the
 * engine froze into the run at plan time.
 * @param inputArtifacts - `artifacts` handed in by the route.
 * @param stateArtifacts - `state.artifacts` from the blackboard.
 * @param key - `root` / `statePath` / `reportPath`.
 * @returns the path, or null.
 */
function artifactPath(inputArtifacts, stateArtifacts, key) {
  const source = Object.hasOwn(inputArtifacts, key) ? inputArtifacts : stateArtifacts
  return isoOf(source[key])
}

/**
 * Build the run's artifact block from the route-supplied paths and the copy
 * frozen into the blackboard.
 * @param stateArtifacts - `state.artifacts`.
 * @param inputArtifacts - route-supplied artifacts.
 * @returns `{ root, statePath, reportPath }` (fields may be null).
 */
function buildArtifacts(stateArtifacts, inputArtifacts) {
  const fromState = isRecord(stateArtifacts) ? stateArtifacts : {}
  const fromInput = isRecord(inputArtifacts) ? inputArtifacts : {}
  return {
    root: artifactPath(fromInput, fromState, 'root'),
    statePath: artifactPath(fromInput, fromState, 'statePath'),
    reportPath: artifactPath(fromInput, fromState, 'reportPath'),
  }
}

/**
 * Pass through the engine gate result.
 *
 * Every field the engine writes is preserved — including `waived`, the
 * `overrideReason` that explains it, and the ids of blocking escalations —
 * because the gate panel and the final report are built from exactly this
 * record.
 * @param gate - `state.gate`.
 * @returns gate record, or null when the gate never ran.
 */
function buildGate(gate) {
  if (!isRecord(gate)) return null
  return {
    pass: gate.pass === true,
    evaluatedAt: isoOf(gate.evaluatedAt),
    itemGates: recordList(gate.itemGates).map((itemGate) => ({
      id: textOf(itemGate.id),
      pass: itemGate.pass === true,
      overridden: itemGate.overridden === true,
      overrideReason: typeof itemGate.overrideReason === 'string' ? clip(itemGate.overrideReason) : null,
      waived: textList(itemGate.waived),
      failures: textList(itemGate.failures),
      warnings: textList(itemGate.warnings),
    })),
    teamFailures: textList(gate.teamFailures),
    blockingEscalations: textList(gate.blockingEscalations),
  }
}

/**
 * Pass through the escalation log (oldest first), bounded and clipped.
 * @param escalations - `state.escalations`.
 * @param warnings - diagnostics array to append truncation warnings to.
 * @returns array of escalation records.
 */
function buildEscalations(escalations, warnings) {
  const list = recordList(escalations)
  if (list.length > MAX_ESCALATIONS) warnings.push(`escalations truncated to the most recent ${MAX_ESCALATIONS} of ${list.length}`)
  const kept = list.length > MAX_ESCALATIONS ? list.slice(-MAX_ESCALATIONS) : list
  return kept.map((escalation) => ({
    id: textOf(escalation.id),
    kind: textOf(escalation.kind),
    subject: clip(escalation.subject),
    detail: clip(escalation.detail),
    blocking: escalation.blocking === true,
    itemId: isoOf(escalation.itemId),
    createdBy: textOf(escalation.createdBy) || null,
    createdAt: isoOf(escalation.createdAt),
    resolved: escalation.resolved === true,
    resolution: typeof escalation.resolution === 'string' ? clip(escalation.resolution) : null,
    resolvedBy: textOf(escalation.resolvedBy) || null,
    resolvedAt: isoOf(escalation.resolvedAt),
  }))
}

/**
 * Build the bounded, ascending audit-event list.
 * @param events - `state.events`.
 * @param warnings - diagnostics array to append truncation warnings to.
 * @returns array of `{ at, type, actor, detail }` records.
 */
function buildEvents(events, warnings) {
  const list = recordList(events)
  if (list.length > MAX_EVENTS) warnings.push(`events truncated to the most recent ${MAX_EVENTS} of ${list.length}`)
  return tailEvents(list, MAX_EVENTS).map((event) => ({
    at: textOf(event.at),
    type: textOf(event.type),
    actor: textOf(event.actor) || 'system',
    detail: clip(event.detail, MAX_EVENT_DETAIL),
  }))
}

/**
 * Normalize the Team runtime block: who I am, who is around, and the native
 * task board. This block is returned even when no run exists.
 * @param team - `{ me, members, tasks }` from the route.
 * @param warnings - diagnostics array to append truncation warnings to.
 * @returns `{ me, members, tasks }`.
 */
function buildTeam(team, warnings) {
  const me = isRecord(team.me) ? team.me : null
  const members = recordList(team.members)
  if (members.length > MAX_MEMBERS) warnings.push(`roster truncated to the first ${MAX_MEMBERS} of ${members.length} member(s)`)
  const tasks = recordList(team.tasks)
  if (tasks.length > MAX_TASKS) warnings.push(`team tasks truncated to the first ${MAX_TASKS} of ${tasks.length}`)
  return {
    me: me === null ? null : { name: textOf(me.name), role: textOf(me.role) || null },
    members: members.slice(0, MAX_MEMBERS).map((member) => ({
      name: textOf(member.name),
      role: textOf(member.role) || null,
      status: textOf(member.status) || null,
      context: textOf(member.context) || null,
    })),
    tasks: tasks.slice(0, MAX_TASKS).map((task) => ({
      id: textOf(task.id),
      revision: integerOf(task.revision),
      status: textOf(task.status) || null,
      subject: clip(task.subject),
      ownerName: textOf(task.ownerName) || null,
    })),
  }
}

// ---------------------------------------------------------------------------
// Peer collaboration (docs/12 §5, snapshot version 2)
//
// Every collaboration field is optional on the blackboard: a version-1 board
// has none of them, so the aggregation degrades to empty lists instead of a
// null block or an exception. All of it is derived, never written.
// ---------------------------------------------------------------------------

/**
 * Normalize one channel message and flatten its refs.
 * @param message - blackboard channel entry.
 * @returns `{ id, at, from, to, kind, text, itemId, findingId, proposalId, replyTo }`.
 */
function buildChannelEntry(message) {
  const refs = isRecord(message.refs) ? message.refs : {}
  return {
    id: textOf(message.id),
    at: textOf(message.at),
    from: textOf(message.from),
    to: textOf(message.to),
    kind: textOf(message.kind) || 'note',
    text: clip(message.text, MAX_CHANNEL_TEXT),
    itemId: isoOf(refs.itemId) ?? isoOf(message.itemId),
    findingId: isoOf(refs.findingId) ?? isoOf(message.findingId),
    proposalId: isoOf(refs.proposalId) ?? isoOf(message.proposalId),
    replyTo: isoOf(message.replyTo),
  }
}

/**
 * Normalize one item claim record; `null` in, `null` out.
 * @param claim - blackboard `item.claim`.
 * @returns `{ by, at, leaseMinutes, note }`, or null when the item is unclaimed.
 */
function buildClaim(claim) {
  if (!isRecord(claim)) return null
  return {
    by: textOf(claim.by) || null,
    at: isoOf(claim.at),
    leaseMinutes: integerOf(claim.leaseMinutes),
    note: typeof claim.note === 'string' ? clip(claim.note) : null,
  }
}

/**
 * Normalize one peer review invitation (docs/12 §2 `reviewRequests`).
 * @param request - blackboard review request.
 * @returns `{ by, at, reviewer, status, respondedAt, response }`.
 */
function buildReviewRequest(request) {
  return {
    by: textOf(request.by) || null,
    at: isoOf(request.at),
    reviewer: isoOf(request.reviewer),
    status: textOf(request.status) || null,
    respondedAt: isoOf(request.respondedAt),
    response: typeof request.response === 'string' ? clip(request.response) : null,
  }
}

/**
 * Normalize one item handoff (docs/12 §2 `items[].handoffs`).
 * @param handoff - blackboard handoff.
 * @returns `{ by, at, to, reason, status, respondedAt }`.
 */
function buildItemHandoff(handoff) {
  return {
    by: textOf(handoff.by) || null,
    at: isoOf(handoff.at),
    to: textOf(handoff.to) || null,
    reason: typeof handoff.reason === 'string' ? clip(handoff.reason) : null,
    status: textOf(handoff.status) || null,
    respondedAt: isoOf(handoff.respondedAt),
  }
}

/**
 * Normalize one proposal's votes, oldest first.
 *
 * A member changes their vote through the engine, which updates the existing
 * entry in place, so one voter appears once on a healthy board; this helper
 * deliberately does not de-duplicate, keeping the tally identical to the
 * engine's `tallyProposal`. The `votes` array the snapshot exposes is only the
 * most recent `MAX_VOTES` for rendering, so on an oversized board the tally can
 * legitimately count more votes than the list shows.
 * @param votes - raw `proposal.votes`.
 * @returns normalized votes.
 */
function normalizeVotes(votes) {
  return recordList(votes).map((vote) => ({
    by: textOf(vote.by),
    vote: textOf(vote.vote) || null,
    comment: typeof vote.comment === 'string' ? clip(vote.comment) : null,
    at: isoOf(vote.at),
  }))
}

/**
 * @param votes - normalized votes of one proposal.
 * @returns the yes/no/abstain counters, exactly as the engine's
 *   `tallyProposal` computes them (an unknown vote value counts as abstain).
 */
function countVotes(votes) {
  const tally = { yes: 0, no: 0, abstain: 0 }
  for (const vote of votes) {
    if (vote.vote === 'yes') tally.yes += 1
    else if (vote.vote === 'no') tally.no += 1
    else tally.abstain += 1
  }
  return tally
}

/**
 * Count the members affected by one proposal (docs/12 §2).
 *
 * An item proposal affects that item's owner plus its reviewers, de-duplicated;
 * a team-wide proposal affects the whole roster (the Lead is included through
 * the roster like everyone else). An item id that is not on the board is
 * treated as team-wide: the dashboard cannot name a narrower electorate from
 * data it does not have.
 * @param itemId - proposal item id, or null for a team-wide topic.
 * @param context - `{ itemsById, memberNames }`.
 * @returns number of affected members.
 */
function affectedCount(itemId, context) {
  const item = itemId === null ? null : (context.itemsById.get(itemId) ?? null)
  if (item === null) return context.memberNames.length
  const names = new Set()
  const owner = textOf(item.owner)
  if (owner.length > 0) names.add(owner)
  for (const reviewer of textList(item.reviewers)) names.add(reviewer)
  return names.size
}

/**
 * Count the blocking proposals of every item, mirroring the engine's
 * `openBlockingProposals`: a proposal blocks while it is `open` or `escalated`
 * (a tie is handed to the Lead but still blocks approval until arbitrated),
 * only for `dod` / `scope` / `replan` (the kinds that block approval), and a
 * team-wide proposal (no item id) blocks every item. The count is taken over
 * all proposals, before the display cap.
 * @param proposals - `state.proposals`.
 * @returns map of item id -> blocking proposal count.
 */
function countOpenProposals(proposals) {
  const blocking = recordList(proposals).filter((proposal) => {
    const status = textOf(proposal.status)
    if (status !== 'open' && status !== 'escalated') return false
    return BLOCKING_PROPOSAL_KINDS.has(textOf(proposal.kind))
  })
  return {
    forItem(itemId) {
      return blocking.filter((proposal) => isoOf(proposal.itemId) === null || isoOf(proposal.itemId) === itemId).length
    },
  }
}

/**
 * Build the bounded proposal list, including each proposal's vote tally and
 * the docs/14 liveness fields (deadline / quorum / autoResolved).
 * @param proposals - `state.proposals`.
 * @param context - `{ itemsById, memberNames, warnings }`.
 * @returns normalized proposals, oldest first.
 */
function buildProposals(proposals, context) {
  const list = recordList(proposals)
  if (list.length > MAX_PROPOSALS) context.warnings.push(`collaboration proposals truncated to the most recent ${MAX_PROPOSALS} of ${list.length}`)
  let truncatedVotes = 0
  const kept = list.slice(-MAX_PROPOSALS).map((proposal) => {
    const votes = normalizeVotes(proposal.votes)
    if (votes.length > MAX_VOTES) truncatedVotes += 1
    const tally = countVotes(votes)
    const itemId = isoOf(proposal.itemId)
    const affected = affectedCount(itemId, context)
    const declaredQuorum = integerOf(proposal.quorum)
    return {
      id: textOf(proposal.id),
      at: textOf(proposal.at),
      by: textOf(proposal.by),
      kind: textOf(proposal.kind) || null,
      itemId,
      text: clip(proposal.text),
      status: textOf(proposal.status) || 'open',
      // docs/14 §2: the proposer freezes a deadline, and the quorum the engine
      // settles against is ceil(affected/2) with a floor of 1. The engine
      // writes both; older boards only carry the shape, so derive the quorum.
      deadline: isoOf(proposal.deadline),
      quorum: declaredQuorum === null ? Math.max(1, Math.ceil(affected / 2)) : Math.max(1, declaredQuorum),
      votes: votes.slice(-MAX_VOTES),
      tally: {
        yes: tally.yes,
        no: tally.no,
        abstain: tally.abstain,
        affected,
        // The engine counts every recorded vote here, including one it could
        // not classify (which it tallies as abstain).
        total: votes.length,
      },
      autoResolved: proposal.autoResolved === true,
      resolvedAt: isoOf(proposal.resolvedAt),
      resolution: typeof proposal.resolution === 'string' ? clip(proposal.resolution) : null,
    }
  })
  if (truncatedVotes > 0) context.warnings.push(`proposal votes truncated to the most recent ${MAX_VOTES} in ${truncatedVotes} proposal(s)`)
  return kept
}

/**
 * @param item - raw blackboard item.
 * @returns whether the item is an unclaimed open-queue item (docs/12 §2).
 */
function isOpenQueueItem(item) {
  if (textOf(item.assignment).trim().toLowerCase() !== 'open') return false
  if (textOf(item.owner).length > 0) return false
  return textOf(item.status).trim().toLowerCase() === 'pending'
}

/**
 * Resolve the review one item is waiting on, whether the engine stored it as a
 * pending review record (v1) or as the v2 `pendingReviewer` field (which also
 * tracks a peer review invitation that nobody has taken yet).
 * @param item - raw blackboard item.
 * @returns reviewer name, or null.
 */
function pendingReviewerOf(item) {
  const pending = recordList(item.reviews).find((review) => textOf(review.status) === 'pending')
  const fromRecord = pending === undefined ? '' : textOf(pending.reviewer)
  if (fromRecord.length > 0) return fromRecord
  const declared = textOf(item.pendingReviewer)
  return declared.length > 0 ? declared : null
}

/**
 * Build the review invitations that are still waiting for a taker
 * (docs/12 §5 `pendingReviews`): who asked, whom they asked, and when.
 *
 * A review request with `reviewer: null` is an open invitation, which is why
 * the entry's `reviewer` can be null; `requestedBy`/`at` come from the matching
 * open request when the board recorded one.
 * @param items - kept `{ id, raw }` item entries.
 * @returns pending review entries.
 */
function buildPendingReviews(items) {
  const entries = []
  for (const item of items) {
    const requests = recordList(item.raw.reviewRequests)
    const open = requests.filter((request) => (textOf(request.status) || 'open') === 'open')
    const reviewer = pendingReviewerOf(item.raw)
    if (reviewer === null && open.length === 0) continue
    const match =
      reviewer === null
        ? (open.at(-1) ?? null)
        : (open.find((request) => textOf(request.reviewer) === reviewer) ??
           [...requests].reverse().find((request) => textOf(request.reviewer) === reviewer) ??
           open.at(-1) ??
           requests.at(-1) ??
           null)
    entries.push({
      itemId: item.id,
      requestedBy: match === null ? null : textOf(match.by) || null,
      reviewer: reviewer ?? (match === null ? null : isoOf(match.reviewer)),
      at: match === null ? null : isoOf(match.at),
    })
  }
  return entries
}

/**
 * Flatten the offered handoffs of every item into the run-level handoff list.
 *
 * Only `status === 'offered'` transfers are still pending, which is what the
 * board surfaces; accepted/declined ones stay visible on the item itself.
 * @param items - kept `{ id, raw }` item entries.
 * @param warnings - diagnostics array for truncation warnings.
 * @returns bounded handoffs, ascending by time.
 */
function buildRunHandoffs(items, warnings) {
  const flat = []
  for (const item of items) {
    for (const handoff of recordList(item.raw.handoffs)) {
      if (textOf(handoff.status) !== 'offered') continue
      flat.push({
        itemId: item.id,
        by: textOf(handoff.by) || null,
        to: textOf(handoff.to) || null,
        reason: typeof handoff.reason === 'string' ? clip(handoff.reason) : null,
        status: 'offered',
        at: isoOf(handoff.at),
      })
    }
  }
  const sorted = sortByAt(flat)
  if (sorted.length > MAX_HANDOFFS) {
    warnings.push(`collaboration handoffs truncated to the most recent ${MAX_HANDOFFS} of ${sorted.length}`)
    return sorted.slice(-MAX_HANDOFFS)
  }
  return sorted
}

/**
 * Distill the peer↔peer topology from the channel (docs/12 §5 `edges`).
 *
 * One directed message adds 1 to its `from → to` edge. A `to: "team"`
 * broadcast adds 1 to every other roster member's edge, which is what the
 * topology panel draws. Both endpoints must be roster members: an edge the
 * client cannot draw (a peer outside the roster, or one of the engine's
 * `system` notices such as a vote resolution) is not a `peer↔peer` edge, and
 * emitting it would make the topology reference nodes that do not exist. Self
 * edges are dropped. Edges are ranked by message count (descending) and capped.
 * @param channel - normalized channel entries.
 * @param memberNames - roster names (the nodes the topology can draw).
 * @param warnings - diagnostics array for truncation warnings.
 * @returns directed edges `{ from, to, count, kinds }`.
 */
function buildEdges(channel, memberNames, warnings) {
  const members = []
  const seen = new Set()
  for (const name of memberNames) {
    const member = textOf(name)
    if (member.length === 0 || seen.has(member)) continue
    seen.add(member)
    members.push(member)
  }
  const edges = new Map()
  const add = (from, to, kind) => {
    if (from.length === 0 || to.length === 0 || from === to) return
    const key = `${from}\u0000${to}`
    let edge = edges.get(key)
    if (edge === undefined) {
      edge = { from, to, count: 0, kinds: [] }
      edges.set(key, edge)
    }
    edge.count += 1
    if (!edge.kinds.includes(kind)) edge.kinds.push(kind)
  }
  for (const message of channel) {
    const from = textOf(message.from)
    if (from.length === 0 || !seen.has(from)) continue
    const kind = textOf(message.kind) || 'note'
    const to = textOf(message.to)
    if (to === 'team') {
      for (const member of members) add(from, member, kind)
      continue
    }
    if (!seen.has(to)) continue
    add(from, to, kind)
  }
  const ranked = [...edges.values()]
    .map((edge) => ({ from: edge.from, to: edge.to, count: edge.count, kinds: [...edge.kinds].sort() }))
    .sort((left, right) => {
      if (right.count !== left.count) return right.count - left.count
      if (left.from !== right.from) return left.from < right.from ? -1 : 1
      return left.to < right.to ? -1 : left.to > right.to ? 1 : 0
    })
  if (ranked.length > MAX_EDGES) {
    warnings.push(`collaboration edges truncated to the ${MAX_EDGES} busiest of ${ranked.length}`)
    return ranked.slice(0, MAX_EDGES)
  }
  return ranked
}

/**
 * Build the peer-collaboration block of the run (docs/12 §5).
 *
 * A version-1 board has none of the underlying fields; the block is still
 * returned with every list empty, so the client can render the panel
 * unconditionally and old runs remain viewable.
 * @param state - blackboard run record.
 * @param context - `{ channelEntries, items, itemsById, memberNames, warnings, stats }`.
 * @returns `{ channel, proposals, openQueue, pendingReviews, handoffs, edges }`.
 */
function buildCollaboration(state, context) {
  const warnings = context.warnings
  const channelEntries = context.channelEntries
  let channel = channelEntries
  if (channelEntries.length > MAX_CHANNEL) {
    warnings.push(`collaboration channel truncated to the most recent ${MAX_CHANNEL} of ${channelEntries.length} message(s)`)
    channel = channelEntries.slice(-MAX_CHANNEL)
  }
  const proposals = buildProposals(state.proposals, context)
  const openQueue = context.items.filter((item) => isOpenQueueItem(item.raw)).map((item) => item.id)
  const pendingReviews = buildPendingReviews(context.items)
  const handoffs = buildRunHandoffs(context.items, warnings)
  const edges = buildEdges(channelEntries, context.memberNames, warnings)
  if (context.stats.threadClipped > 0) {
    warnings.push(`item threads truncated to the most recent ${MAX_THREAD} message(s) in ${context.stats.threadClipped} item(s)`)
  }
  const stops = recordList(state.stops).slice(-16).map((stop) => ({
    id: textOf(stop.id) || null,
    at: isoOf(stop.at),
    by: textOf(stop.by) || null,
    target: textOf(stop.target) || null,
    mode: textOf(stop.mode) === 'interrupt' ? 'interrupt' : 'graceful',
    status: STOP_STATUSES.has(textOf(stop.status)) ? textOf(stop.status) : 'pending',
    reason: clip(stop.reason, 400),
    decidedAt: isoOf(stop.decidedAt),
  }))
  return { channel, proposals, openQueue, pendingReviews, handoffs, edges, stops }
}

/**
 * Derive the macro collaboration pipeline stage.
 * @param state - blackboard run state
 * @param items - normalized items
 * @returns 'planning' | 'implementing' | 'reviewing' | 'reworking' | 'converged' | 'finalized'
 */
function computePipelineStage(state, items) {
  const phase = textOf(state.phase).trim().toLowerCase()
  if (state.finalizedAt || phase === 'finalized' || phase === 'completed') {
    return 'finalized'
  }
  if (phase === 'converged' || phase === 'gate') {
    return 'converged'
  }
  if (items.length === 0) {
    return 'planning'
  }
  if (items.every((it) => it.status === 'approved')) {
    return 'converged'
  }
  if (items.some((it) => it.status === 'changes_requested')) {
    return 'reworking'
  }
  if (items.some((it) => it.status === 'in_review')) {
    return 'reviewing'
  }
  if (items.some((it) => it.status === 'running' || (it.git && it.git.commits && it.git.commits.length > 0))) {
    return 'implementing'
  }
  return 'planning'
}

/**
 * Build the run block of the snapshot.
 * @param state - blackboard run record (non-null).
 * @param context - `{ tasks, artifacts, memberNames, warnings }`.
 * @returns snapshot run.
 */
function buildRun(state, context) {
  const warnings = context.warnings
  const rawItems = recordList(state.items)
  const identified = []
  for (const raw of rawItems) {
    const id = textOf(raw.id).trim()
    if (id.length === 0) continue
    if (identified.some((entry) => entry.id === id)) continue
    identified.push({ raw, id })
  }
  if (identified.length < rawItems.length) warnings.push(`${rawItems.length - identified.length} work item(s) without a unique id were skipped`)
  const kept = identified.slice(0, MAX_ITEMS)
  if (identified.length > MAX_ITEMS) warnings.push(`work items truncated to the first ${MAX_ITEMS} of ${identified.length}`)

  const waveInfo = computeWaves(kept.map((entry) => ({ id: entry.id, blockedBy: entry.raw.blockedBy })))
  if (waveInfo.cycle.length > 0) {
    warnings.push(`dependency cycle detected among work items: ${waveInfo.cycle.join(', ')}; those items can never run and report wave 0`)
  }

  const taskById = new Map()
  for (const task of recordList(context.tasks)) {
    const id = textOf(task.id).trim()
    if (id.length > 0 && !taskById.has(id)) taskById.set(id, task)
  }
  // The collaboration block and the item threads read one normalized channel.
  const channelEntries = sortByAt(recordList(state.channel).map(buildChannelEntry))
  const itemsById = new Map(identified.map((entry) => [entry.id, entry.raw]))
  const settings = isRecord(state.settings) ? state.settings : {}
  const itemContext = {
    waveOf: waveInfo.waveOf,
    taskById,
    maxRounds: integerOf(settings.maxReviewRounds),
    channelEntries,
    openProposalCounts: countOpenProposals(state.proposals),
    stats: { threadClipped: 0 },
  }
  const items = kept.map((entry) => buildItem(entry.raw, entry.id, itemContext))
  const collaboration = buildCollaboration(state, {
    channelEntries,
    items: kept,
    itemsById,
    memberNames: context.memberNames,
    warnings,
    stats: itemContext.stats,
  })

  return {
    id: textOf(state.runId).trim() || textOf(state.id).trim() || null,
    phase: textOf(state.phase).trim() || 'unknown',
    pipelineStage: computePipelineStage(state, items),
    objective: clip(state.objective),
    acceptanceCriteria: textList(state.acceptanceCriteria),
    constraints: textList(state.constraints),
    createdAt: isoOf(state.createdAt),
    updatedAt: isoOf(state.updatedAt),
    finalizedAt: isoOf(state.finalizedAt),
    settings: buildSettings(state.settings),
    counts: buildCounts(items),
    waves: waveInfo.waves,
    items,
    gate: buildGate(state.gate),
    escalations: buildEscalations(state.escalations, warnings),
    events: buildEvents(state.events, warnings),
    collaboration,
    git: buildRunGit(state.git),
    usage: buildUsage(state.usage),
    artifacts: buildArtifacts(state.artifacts, context.artifacts),
  }
}

/**
 * Aggregate one dashboard snapshot (docs/09 §2 plus docs/12 §5, version 2).
 *
 * The function is total: it never throws for any input, and `run` is `null`
 * when the blackboard is missing — a missing board is an empty state, not an
 * error. `team` and `diagnostics` are always present so the client can still
 * show who is online.
 * @param input - `{ state, team, artifacts, now, diagnostics, sessionId? }`.
 *   `state` is the blackboard run (or null), `team` is `{ me, members, tasks }`,
 *   `artifacts` is `{ root, statePath, reportPath }`, `now` is the ISO time the
 *   route sampled the board, `diagnostics` is `{ boardSource, warnings }`, and
 *   `sessionId` is the id of the conversation the snapshot is for. Omit
 *   `sessionId` and the snapshot falls back to the board's `teamId`: the store
 *   keys every board by the Lead Session id, so that is the conversation which
 *   owns the run.
 * @returns the snapshot object.
 */
export function buildSnapshot(input) {
  const source = isRecord(input) ? input : {}
  const state = isRecord(source.state) ? source.state : null
  const teamInput = isRecord(source.team) ? source.team : {}
  const diagnosticsInput = isRecord(source.diagnostics) ? source.diagnostics : null
  const warnings = []
  for (const warning of textList(diagnosticsInput === null ? [] : diagnosticsInput.warnings)) warnings.push(warning)

  const team = buildTeam(teamInput, warnings)
  const run =
    state === null
      ? null
      : buildRun(state, {
          tasks: teamInput.tasks,
          artifacts: source.artifacts,
          memberNames: team.members.map((member) => member.name).filter((name) => name.length > 0),
          warnings,
        })

  const declaredSource = textOf(diagnosticsInput === null ? '' : diagnosticsInput.boardSource).trim()
  const boardSource = BOARD_SOURCES.has(declaredSource) ? declaredSource : state === null ? 'missing' : 'file'
  // The route passes the exact conversation id when it knows it; otherwise the
  // board's Team id is the best available identity (a board is keyed by the
  // Lead Session id), and null is the honest answer when there is no board.
  const sessionId = isoOf(source.sessionId) ?? (state === null ? null : isoOf(state.teamId))
  return {
    ok: true,
    version: SNAPSHOT_VERSION,
    // Monotonic board revision (state.rev): clients use it as an ETag and for
    // "has anything changed since N?" deltas without comparing whole payloads.
    rev: state !== null && Number.isInteger(state.rev) ? state.rev : 0,
    generatedAt: isoOf(source.now) ?? new Date().toISOString(),
    sessionId,
    run,
    team,
    diagnostics: { boardSource, warnings },
  }
}
