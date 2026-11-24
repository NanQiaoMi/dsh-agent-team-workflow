/**
 * Telemetry and token attribution for Agent Teams.
 *
 * Computes per-role breakdown (Lead, Worker, Reviewer) and token shares
 * to provide fine-grained cost visibility without external dependencies.
 */

/**
 * Resolve the attribution role of a team member.
 *
 * @param {object} member - team member object `{ name, role }`.
 * @param {object} [state] - current run state with items.
 * @returns {'lead'|'worker'|'reviewer'|string}
 */
export function resolveAttributionRole(member, state = null) {
  const normRole = String(member?.role ?? '').toLowerCase().trim()
  if (normRole === 'lead') return 'lead'
  if (normRole === 'reviewer') return 'reviewer'

  if (state?.items && Array.isArray(state.items)) {
    const isOwner = state.items.some((item) => item.owner === member.name)
    const isReviewer = state.items.some((item) => Array.isArray(item.reviewers) && item.reviewers.includes(member.name))
    if (isReviewer && !isOwner) return 'reviewer'
    if (isOwner) return 'worker'
  }

  if (normRole === 'worker' || normRole === 'implementer' || normRole === 'teammate') return 'worker'
  if (normRole === 'verifier') return 'reviewer'
  return normRole || 'worker'
}

/**
 * Calculate token usage attribution grouped by member and role.
 *
 * @param {object} options
 * @param {Array<object>} options.members - list of member objects `{ name, role, agent }`.
 * @param {Function|null} options.read - function `read(agent)` returning raw token totals.
 * @param {object|null} [options.state] - current workflow run state.
 * @param {string} [options.now] - timestamp ISO string.
 * @returns {object} usage record with `{ capturedAt, members, totals, byRole, tokenShare }`.
 */
export function computeUsage({ members = [], read = null, state = null, now = new Date().toISOString() } = {}) {
  const usage = {
    capturedAt: now,
    members: {},
    totals: { uncachedInputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
    byRole: {},
    tokenShare: {},
  }
  if (typeof read !== 'function') return usage

  for (const member of members) {
    let raw = null
    try {
      raw = read(member?.agent)
    } catch {
      raw = null
    }
    if (raw === null || raw === undefined) continue
    const totals = raw.totals !== undefined && raw.totals !== null && typeof raw.totals === 'object' ? raw.totals : raw
    const uncachedInputTokens = Number.isFinite(totals.uncachedInputTokens) ? totals.uncachedInputTokens : 0
    const outputTokens = Number.isFinite(totals.outputTokens) ? totals.outputTokens : 0
    const cacheReadTokens = Number.isFinite(totals.cacheReadTokens) ? totals.cacheReadTokens : 0
    const cacheWriteTokens = Number.isFinite(totals.cacheWriteTokens) ? totals.cacheWriteTokens : 0
    const memberTotal = uncachedInputTokens + outputTokens + cacheReadTokens + cacheWriteTokens

    usage.members[member.name] = {
      uncachedInputTokens,
      outputTokens,
      cacheReadTokens,
      cacheWriteTokens,
    }

    usage.totals.uncachedInputTokens += uncachedInputTokens
    usage.totals.outputTokens += outputTokens
    usage.totals.cacheReadTokens += cacheReadTokens
    usage.totals.cacheWriteTokens += cacheWriteTokens

    const role = resolveAttributionRole(member, state)
    if (!usage.byRole[role]) {
      usage.byRole[role] = {
        uncachedInputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        totalTokens: 0,
      }
    }
    usage.byRole[role].uncachedInputTokens += uncachedInputTokens
    usage.byRole[role].outputTokens += outputTokens
    usage.byRole[role].cacheReadTokens += cacheReadTokens
    usage.byRole[role].cacheWriteTokens += cacheWriteTokens
    usage.byRole[role].totalTokens += memberTotal
  }

  const grandTotal =
    usage.totals.uncachedInputTokens +
    usage.totals.outputTokens +
    usage.totals.cacheReadTokens +
    usage.totals.cacheWriteTokens

  for (const [role, data] of Object.entries(usage.byRole)) {
    usage.tokenShare[role] = grandTotal > 0 ? Math.round((data.totalTokens / grandTotal) * 10000) / 10000 : 0
  }

  return usage
}

/**
 * Compute run-level reliability and efficiency attribution metrics from blackboard state.
 * Safe and total on null or partial state objects.
 *
 * @param {object|null} [state]
 * @returns {object}
 */
export function computeReliabilityMetrics(state = null) {
  const items = Array.isArray(state?.items) ? state.items : []
  const events = Array.isArray(state?.events) ? state.events : []

  let approvedItems = 0
  let firstPassApproved = 0
  let reworkRounds = 0

  for (const item of items) {
    if (!item || typeof item !== 'object') continue
    const reviews = Array.isArray(item.reviews) ? item.reviews : []
    let hadRework = false
    for (const review of reviews) {
      if (!review || review.status !== 'submitted') continue
      if (review.verdict !== 'approve' && review.verdict !== 'approve_with_nits') {
        reworkRounds += 1
        hadRework = true
      }
    }
    if (item.status === 'approved') {
      approvedItems += 1
      if (!hadRework) firstPassApproved += 1
    }
  }

  let stallNudges = 0
  let stallEscalations = 0
  let autoCommits = 0
  let autoPresyncs = 0
  let mergeConflicts = 0
  let hostVerifiedPasses = 0
  let hostVerifiedFailures = 0

  for (const event of events) {
    if (!event || typeof event !== 'object') continue
    const type = event.type
    if (type === 'member/stall-nudge') stallNudges += 1
    else if (type === 'member/stall-escalated') stallEscalations += 1
    else if (type === 'git/auto-commit') autoCommits += 1
    else if (type === 'git/worktree-presynced') autoPresyncs += 1
    else if (type === 'git/worktree-merge-conflict') mergeConflicts += 1
    else if (type === 'git/host-verified') {
      const detail = String(event.detail ?? '')
      if (/\bpassed\b/i.test(detail)) hostVerifiedPasses += 1
      else if (/\bfailed\b/i.test(detail)) hostVerifiedFailures += 1
    }
  }

  const rawIntegration = state?.integrationGate
  const integrationGate =
    rawIntegration !== null && rawIntegration !== undefined && typeof rawIntegration === 'object'
      ? {
          pass: rawIntegration.pass === true,
          durationMs: Number.isFinite(rawIntegration.durationMs) ? rawIntegration.durationMs : 0,
          ranAt: typeof rawIntegration.ranAt === 'string' && rawIntegration.ranAt.trim().length > 0 ? rawIntegration.ranAt : null,
        }
      : null

  return {
    totalItems: items.length,
    approvedItems,
    firstPassApproved,
    firstPassApproveRate: approvedItems > 0 ? Math.round((firstPassApproved / approvedItems) * 10000) / 10000 : null,
    reworkRounds,
    stallNudges,
    stallEscalations,
    autoCommits,
    autoPresyncs,
    mergeConflicts,
    hostVerifiedPasses,
    hostVerifiedFailures,
    integrationGate,
  }
}
