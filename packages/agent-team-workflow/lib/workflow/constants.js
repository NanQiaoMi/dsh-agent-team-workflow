/**
 * Core workflow constants, error type, and state/scope helpers.
 */

import { REVIEW_DEPTHS, REVIEW_PROFILES } from '../review-policy.js'

/** Current workflow schema version written into run state. */
export const WORKFLOW_VERSION = 2

/** Item lifecycle states. */
export const ITEM_STATUS = Object.freeze({
  PENDING: 'pending',
  RUNNING: 'running',
  CHANGES_REQUESTED: 'changes_requested',
  IN_REVIEW: 'in_review',
  APPROVED: 'approved',
  ESCALATED: 'escalated',
})

/** Run lifecycle phases. */
export const RUN_PHASE = Object.freeze({
  PLANNED: 'planned',
  EXECUTING: 'executing',
  REVIEWING: 'reviewing',
  CONVERGED: 'converged',
  FINALIZED: 'finalized',
  ABORTED: 'aborted',
})

/** Review verdicts a reviewer may return. */
export const VERDICTS = Object.freeze(['approve', 'approve_with_nits', 'request_changes', 'block'])

/** Finding severities, most severe first. */
export const SEVERITIES = Object.freeze(['blocker', 'major', 'minor', 'nit'])

/** Escalation kinds a member may raise to the Lead. */
export const ESCALATION_KINDS = Object.freeze(['blocker', 'conflict', 'scope_change', 'decision', 'arbitration'])

/** Resolution states an author may set on one finding. */
export const FINDING_RESOLUTIONS = Object.freeze(['fixed', 'rebut', 'accepted_risk'])

/** Peer channel message kinds (workflow v2). */
export const CHANNEL_KINDS = Object.freeze(['note', 'question', 'answer', 'proposal', 'objection', 'handoff', 'ack', 'status'])

/** Proposal kinds a member may open before peers vote (workflow v2). */
export const PROPOSAL_KINDS = Object.freeze(['dod', 'scope', 'replan', 'review_policy', 'handoff'])

/** Proposal kinds that block approval while they are still open. */
export const BLOCKING_PROPOSAL_KINDS = Object.freeze(['dod', 'scope', 'replan'])

/** Channel length cap: the blackboard is a live log, not an archive. */
export const CHANNEL_LIMIT = 200

/** Proposal length cap. */
export const PROPOSAL_LIMIT = 100

/** Plan-review states (workflow v1.4). */
export const PLAN_STATUS = Object.freeze({ pending: 'pending', approved: 'approved', rejected: 'rejected' })

/** Stop-request states (workflow v1.4). */
export const STOP_STATUS = Object.freeze({ pending: 'pending', accepted: 'accepted', rejected: 'rejected', interrupted: 'interrupted' })

/** Default claim lease in minutes (advisory; the engine never force-releases). */
export const DEFAULT_LEASE_MINUTES = 30

/** Default proposal deadline in minutes; 0 disables auto-settlement. */
export const DEFAULT_PROPOSAL_TIMEOUT_MINUTES = 15

/** Accepted proposal timeout override range, in minutes. */
export const PROPOSAL_TIMEOUT_MIN = 1
export const PROPOSAL_TIMEOUT_MAX = 1440

const MAX_EVENTS = 200
const MAX_TEXT = 4000

/** Stable workflow error with a machine-readable code. */
export class WorkflowError extends Error {
  constructor(message, code) {
    super(message)
    this.name = 'WorkflowError'
    this.code = code
  }
}

/**
 * Fill the v2 collaboration fields on one run state in place.
 *
 * v1 boards stay readable: every peer field is additive and defaults to the
 * delegation behavior, so an old run keeps converging exactly as before.
 * @param state - run state to complete.
 * @returns the same state, now structurally v2.
 */
export function ensureCollaboration(state) {
  if (!Array.isArray(state.channel)) state.channel = []
  if (!Array.isArray(state.proposals)) state.proposals = []
  if (!Array.isArray(state.staffPool)) state.staffPool = []
  if (state.roleAssignments === null || typeof state.roleAssignments !== 'object' || Array.isArray(state.roleAssignments)) state.roleAssignments = {}
  if (state.git === undefined) state.git = null
  if (!Array.isArray(state.stops)) state.stops = []
  if (!Number.isInteger(state.stopSeq)) state.stopSeq = 0
  if (!Number.isInteger(state.messageSeq)) state.messageSeq = 0
  if (!Number.isInteger(state.proposalSeq)) state.proposalSeq = 0
  if (state.preset === undefined) state.preset = null
  if (Array.isArray(state.items)) {
    for (const item of state.items) {
      if (item.assignment !== 'open' && item.assignment !== 'lead') item.assignment = 'lead'
      if (item.claim === undefined) item.claim = null
      if (!Array.isArray(item.reviewRequests)) item.reviewRequests = []
      if (!Array.isArray(item.handoffs)) item.handoffs = []
      if (item.handoffPacket === undefined) item.handoffPacket = null
      if (item.pendingReviewer === undefined) item.pendingReviewer = null
      if (!Array.isArray(item.pendingReviewers)) {
        item.pendingReviewers = [
          ...new Set(
            (Array.isArray(item.reviews) ? item.reviews : [])
              .filter((review) => review.status === 'pending')
              .map((review) => review.reviewer)
              .filter(Boolean),
          ),
        ]
      }
      if (item.origin !== 'member') item.origin = 'plan'
      if (item.createdBy === undefined) item.createdBy = null
      if (item.git === undefined) item.git = null
      if (item.plan === undefined) item.plan = null
      if (item.complexity !== 'trivial' && item.complexity !== 'normal' && item.complexity !== 'complex') item.complexity = 'normal'
      if (item.thinkingTier === undefined) item.thinkingTier = null
      if (item.reviewDepth !== 'auto' && !REVIEW_DEPTHS.includes(item.reviewDepth)) item.reviewDepth = 'auto'
      if (item.reviewProfile !== 'auto' && !REVIEW_PROFILES.includes(item.reviewProfile)) item.reviewProfile = 'auto'
      if (item.resolvedReview === undefined) item.resolvedReview = null
    }
  }
  for (const proposal of Array.isArray(state.proposals) ? state.proposals : []) {
    if (proposal.deadline === undefined) proposal.deadline = null
    if (proposal.autoResolved === undefined) proposal.autoResolved = false
    if (!Number.isInteger(proposal.quorum)) proposal.quorum = null
  }
  if (Number.isInteger(state.workflowVersion) && state.workflowVersion < WORKFLOW_VERSION) state.workflowVersion = WORKFLOW_VERSION
  if (Number.isInteger(state.schemaVersion) && state.schemaVersion < 2) state.schemaVersion = 2
  return state
}

/** Public alias used by readers that migrate a board on read. */
export function upgradeState(state) {
  return ensureCollaboration(state)
}

/**
 * Normalize one advisory write scope to a relative POSIX prefix.
 * @param value - raw scope string.
 * @returns normalized scope without leading `./` or trailing `/`.
 */
export function normalizeScope(value) {
  const text = String(value ?? '')
    .trim()
    .replaceAll('\\', '/')
  const withoutPrefix = text.replace(/^\.\//, '').replace(/\/+$/, '')
  return withoutPrefix === '.' ? '' : withoutPrefix
}

/**
 * Normalize one workspace-relative file path for scope comparison.
 * @param value - raw path.
 * @returns normalized path without leading `./`.
 */
export function normalizePath(value) {
  return String(value ?? '')
    .trim()
    .replaceAll('\\', '/')
    .replace(/^\.\//, '')
}

/** @returns whether a file path falls inside a normalized write scope. */
export function pathInScope(path, scope) {
  const file = normalizePath(path)
  const prefix = normalizeScope(scope)
  if (file.length === 0) return false
  if (prefix.length === 0) return true
  return file === prefix || file.startsWith(`${prefix}/`)
}

/** @returns whether two normalized scopes overlap on path components. */
export function scopesOverlap(left, right) {
  const a = normalizeScope(left)
  const b = normalizeScope(right)
  if (a.length === 0 || b.length === 0) return true
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`)
}

/**
 * Append one bounded audit event.
 * @param state - run state (mutated in place).
 * @param event - `{ type, actor, detail }`.
 */
export function appendEvent(state, event) {
  state.events.push({ at: event.at ?? new Date().toISOString(), type: event.type, actor: event.actor ?? 'system', detail: String(event.detail ?? '').slice(0, MAX_TEXT) })
  if (state.events.length > MAX_EVENTS) state.events.splice(0, state.events.length - MAX_EVENTS)
}

/** @returns the item with one id, throwing a stable error when absent. */
export function findItem(state, itemId) {
  const item = state.items.find((candidate) => candidate.id === itemId)
  if (item === undefined) throw new WorkflowError(`unknown work item "${itemId}"; valid ids: ${state.items.map((candidate) => candidate.id).join(', ')}`, 'WORKFLOW_UNKNOWN_ITEM')
  return item
}

/** @returns the item whose backing Team task id matches, or `undefined`. */
export function findItemByTaskId(state, taskId) {
  return state.items.find((item) => item.taskId === taskId)
}

/** @returns the proposal with one id, throwing a stable error when absent. */
export function findProposal(state, proposalId) {
  const proposal = (state.proposals ?? []).find((candidate) => candidate.id === proposalId)
  if (proposal === undefined) throw new WorkflowError(`unknown proposal "${proposalId}"`, 'WORKFLOW_UNKNOWN_PROPOSAL')
  return proposal
}

/** @returns open blocking proposals that cover one item (or the whole run). */
export function openBlockingProposals(state, itemId) {
  ensureCollaboration(state)
  return state.proposals.filter((proposal) => {
    if (proposal.status !== 'open' && proposal.status !== 'escalated') return false
    if (!BLOCKING_PROPOSAL_KINDS.includes(proposal.kind)) return false
    if (itemId === undefined || itemId === null) return true
    return proposal.itemId === null || proposal.itemId === itemId
  })
}

/** @returns whether the item must submit a plan and have it approved first. */
export function requiresPlan(state, item) {
  return item.planFirst === true || state.settings?.planFirst === true
}

/** @returns whether the item is still missing an approved plan. */
export function planPending(state, item) {
  return requiresPlan(state, item) && (item.plan === null || item.plan.status !== PLAN_STATUS.approved)
}
