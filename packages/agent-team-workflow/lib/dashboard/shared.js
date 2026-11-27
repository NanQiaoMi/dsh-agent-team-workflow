/**
 * Shared constants, defensive scalar/array normalizers, and public status/wave
 * helpers for the dashboard snapshot builder.
 *
 * Zero imports so every dashboard submodule layers cleanly above this leaf.
 */

/** Snapshot schema version; bump only for a breaking shape change. */
export const SNAPSHOT_VERSION = 2

/** Stop-request states accepted by the snapshot contract. */
export const STOP_STATUSES = new Set(['pending', 'accepted', 'rejected', 'interrupted'])

/** Plan-review states accepted by the snapshot contract. */
export const PLAN_STATUSES = new Set(['pending', 'approved', 'rejected'])

/** Ceilings that keep one snapshot bounded (see docs/09 §2). */
export const MAX_EVENTS = 200
export const MAX_ITEMS = 64
export const MAX_MEMBERS = 16
export const MAX_TASKS = 64
export const MAX_ESCALATIONS = 64
export const MAX_RECORDS = 12
/** Ceiling for free-text fields that have no tighter documented limit. */
export const MAX_TEXT = 4000
/** Ceiling for one audit-event detail line (docs/09 §2 truncation list). */
export const MAX_EVENT_DETAIL = 500
/** Appended once to a clipped string, so a truncated field is visible as such. */
export const ELLIPSIS = '…'
/** Documented board provenance values (docs/09 §2 `diagnostics.boardSource`). */
export const BOARD_SOURCES = new Set(['file', 'memory', 'missing'])
/** Peer-collaboration ceilings (docs/12 §5). */
export const MAX_CHANNEL = 60
/** Channel text is clipped harder than other free text: it is a chat feed. */
export const MAX_CHANNEL_TEXT = 500
export const MAX_PROPOSALS = 32
export const MAX_VOTES = 16
export const MAX_HANDOFFS = 64
export const MAX_THREAD = 20
export const MAX_EDGES = 64
/** Defensive per-item caps for the collaboration sub-lists (not in the doc). */
export const MAX_ITEM_REQUESTS = 16
export const MAX_ITEM_HANDOFFS = 16
/** Proposal kinds that block approval while still open (mirrors the engine). */
export const BLOCKING_PROPOSAL_KINDS = new Set(['dod', 'scope', 'replan'])

/** @returns whether one value is a plain object (not null, not an array). */
export function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * Coerce one value to text without ever throwing (a Symbol or an object with a
 * throwing `toString` must not break a snapshot).
 * @param value - any board value.
 * @param fallback - text to use for a missing/unrepresentable value.
 * @returns string text.
 */
export function textOf(value, fallback = '') {
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return fallback
}

/** @returns only the plain objects of one array value. */
export function recordList(value) {
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
export function textList(value, max = MAX_TEXT) {
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
export function clip(value, max = MAX_TEXT) {
  const text = textOf(value)
  return text.length > max ? `${text.slice(0, max)}${ELLIPSIS}` : text
}

/** @returns one integer value, or the fallback (null by default). */
export function integerOf(value, fallback = null) {
  return Number.isInteger(value) ? value : fallback
}

/** @returns one non-empty string value, or null. */
export function isoOf(value) {
  return typeof value === 'string' && value.length > 0 ? value : null
}

/** @returns the epoch milliseconds of one timestamp; 0 when unparseable. */
export function parseAt(value) {
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
export function sortByAt(records) {
  return records
    .map((record, index) => ({ record, index, time: parseAt(record.at) }))
    .sort((left, right) => (left.time === right.time ? left.index - right.index : left.time - right.time))
    .map((entry) => entry.record)
}

/** @returns whether one verdict string counts as an approval (mirrors the engine). */
export function isApprovingVerdict(verdict) {
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
export function resolutionState(resolution) {
  if (typeof resolution === 'string') return resolution.length > 0 ? resolution : null
  if (!isRecord(resolution)) return null
  return textOf(resolution.state) || null
}

/**
 * Count the rework rounds of one item. The engine stores the cumulative counter
 * as `reworkTotal`; when an older/foreign board omits it, the count of
 * submitted non-approving verdicts is the faithful fallback.
 * @param item - blackboard item.
 * @returns non-negative round count.
 */
export function countReworkRounds(item) {
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
 * Resolve the review one item is waiting on, whether the engine stored it as a
 * pending review record (v1) or as the v2 `pendingReviewer` field (which also
 * tracks a peer review invitation that nobody has taken yet).
 * @param item - raw blackboard item.
 * @returns reviewer name, or null.
 */
export function pendingReviewerOf(item) {
  const pending = recordList(item.reviews).find((review) => textOf(review.status) === 'pending')
  const fromRecord = pending === undefined ? '' : textOf(pending.reviewer)
  if (fromRecord.length > 0) return fromRecord
  const declared = textOf(item.pendingReviewer)
  return declared.length > 0 ? declared : null
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
