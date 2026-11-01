/**
 * Pure aggregation for the live Agent Team dashboard snapshot.
 *
 * This module is deliberately dependency-free: it has **zero imports** (not
 * even Node built-ins), does not read files, does not touch Cordis, and never
 * mutates its input. `dashboard-route.js` feeds it plain data read from the
 * blackboard and the Team board, and the Web client consumes the JSON it
 * returns — so the whole shape of docs/09 §2 can be unit-tested offline.
 *
 * Rules this module keeps:
 * - **Never throw on board data.** Every field is read defensively; a missing,
 *   wrongly typed, or absurdly large value degrades to null / [] / 0 instead of
 *   failing the whole snapshot request.
 * - **Every array is bounded.** `events` (200), `items` (64), `members` (16),
 *   `records` (12), `tasks`/`escalations` (64) and the long free-text fields
 *   are truncated, so one corrupt board cannot produce a multi-megabyte body.
 * - **Deterministic.** The same input yields the same output; the only clock
 *   read is the documented `generatedAt` fallback when the caller passes no
 *   `now`.
 *
 * Output field names are camelCase and follow docs/09 §2 exactly (e.g.
 * `changesRequested`, `reworkRounds`, `pendingReviewer`, `openFindings`,
 * `writeScopes`, `definitionOfDone`, `acceptanceCriteria`, `finalizedAt`,
 * `statePath`).
 */

/** Snapshot schema version; bump only for a breaking shape change. */
export const SNAPSHOT_VERSION = 1

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
  const indexed = list.map((event, index) => {
    const parsed = Date.parse(textOf(event.at))
    return { event, index, time: Number.isNaN(parsed) ? 0 : parsed }
  })
  indexed.sort((left, right) => (left.time === right.time ? left.index - right.index : left.time - right.time))
  const start = Math.max(0, indexed.length - max)
  return indexed.slice(start).map((entry) => entry.event)
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
 * Normalize one work item.
 * @param raw - blackboard item.
 * @param id - the item's resolved id.
 * @param context - `{ waveOf, taskById, maxRounds }`.
 * @returns snapshot item.
 */
function buildItem(raw, id, context) {
  const taskId = textOf(raw.taskId)
  const task = taskId.length === 0 ? null : (context.taskById.get(taskId) ?? null)
  const reviews = recordList(raw.reviews)
  const submitted = reviews.filter((review) => textOf(review.status) === 'submitted')
  const pending = reviews.find((review) => textOf(review.status) === 'pending') ?? null
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
    report: buildReport(raw.report),
    reviews: {
      reworkRounds: countReworkRounds(raw),
      submittedRounds: submitted.length,
      maxRounds: context.maxRounds,
      pendingReviewer: pending === null ? null : textOf(pending.reviewer) || null,
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
  }
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

/**
 * Build the run block of the snapshot.
 * @param state - blackboard run record (non-null).
 * @param context - `{ tasks, artifacts, warnings }`.
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
  const settings = isRecord(state.settings) ? state.settings : {}
  const itemContext = { waveOf: waveInfo.waveOf, taskById, maxRounds: integerOf(settings.maxReviewRounds) }
  const items = kept.map((entry) => buildItem(entry.raw, entry.id, itemContext))

  return {
    id: textOf(state.runId).trim() || textOf(state.id).trim() || null,
    phase: textOf(state.phase).trim() || 'unknown',
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
    artifacts: buildArtifacts(state.artifacts, context.artifacts),
  }
}

/**
 * Aggregate one dashboard snapshot (docs/09 §2, version 1).
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
    generatedAt: isoOf(source.now) ?? new Date().toISOString(),
    sessionId,
    run,
    team,
    diagnostics: { boardSource, warnings },
  }
}
