/**
 * Pure workflow engine for one Agent Team run.
 *
 * Everything here is a deterministic reducer over plain data: no Cordis
 * service access, no filesystem, no clock. Tool implementations pass in the
 * caller identity, the current time, and current Team runtime facts, which
 * keeps the protocol auditable and unit-testable without a running Harness.
 */

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

/** Default claim lease in minutes (advisory; the engine never force-releases). */
export const DEFAULT_LEASE_MINUTES = 30

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
  if (!Number.isInteger(state.messageSeq)) state.messageSeq = 0
  if (!Number.isInteger(state.proposalSeq)) state.proposalSeq = 0
  if (Array.isArray(state.items)) {
    for (const item of state.items) {
      if (item.assignment !== 'open' && item.assignment !== 'lead') item.assignment = 'lead'
      if (item.claim === undefined) item.claim = null
      if (!Array.isArray(item.reviewRequests)) item.reviewRequests = []
      if (!Array.isArray(item.handoffs)) item.handoffs = []
      if (item.pendingReviewer === undefined) item.pendingReviewer = null
    }
  }
  if (Number.isInteger(state.workflowVersion) && state.workflowVersion < WORKFLOW_VERSION) state.workflowVersion = WORKFLOW_VERSION
  if (Number.isInteger(state.schemaVersion) && state.schemaVersion < 2) state.schemaVersion = 2
  return state
}

/** Public alias used by readers that migrate a board on read. */
export function upgradeState(state) {
  return ensureCollaboration(state)
}

const MAX_EVENTS = 200
const MAX_TEXT = 4000

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

/** @returns a fresh escalation id for one run. */
function nextEscalationId(state) {
  return `esc-${state.escalations.length + 1}`
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

/**
 * Create the initial run record from a validated plan.
 * @param input - normalized plan input.
 * @returns a new run state.
 */
export function createRun(input) {
  const now = input.now ?? new Date().toISOString()
  const run = {
    schemaVersion: 2,
    workflowVersion: input.workflowVersion,
    runId: input.runId,
    teamId: input.teamId,
    objective: input.objective,
    acceptanceCriteria: input.acceptanceCriteria,
    constraints: input.constraints,
    phase: RUN_PHASE.PLANNED,
    createdAt: now,
    updatedAt: now,
    settings: input.settings,
    items: input.items,
    escalations: [],
    events: [],
    channel: [],
    proposals: [],
    messageSeq: 0,
    proposalSeq: 0,
    gate: null,
    artifacts: input.artifacts ?? null,
    finalizedAt: null,
  }
  ensureCollaboration(run)
  appendEvent(run, { at: now, type: 'run/planned', actor: input.actor, detail: `planned ${input.items.length} work item(s)` })
  return run
}

/** @returns the unique reviewer names involved in a run, in first-seen order. */
export function collectReviewers(items) {
  const seen = new Set()
  for (const item of items) {
    if (item.needsReview === false) continue
    for (const reviewer of item.reviewers) {
      if (!seen.has(reviewer)) seen.add(reviewer)
    }
  }
  return [...seen]
}

/** @returns the unique worker owner names involved in a run, in first-seen order. */
export function collectOwners(items) {
  const seen = new Set()
  for (const item of items) if (typeof item.owner === 'string' && item.owner.length > 0 && !seen.has(item.owner)) seen.add(item.owner)
  return [...seen]
}

/**
 * Compute execution waves from item blockers.
 * @param items - normalized items with `blockedBy` item ids.
 * @returns `{ waves, cycle }`; `cycle` lists items that can never run.
 */
export function computeWaves(items) {
  const remaining = new Map(items.map((item) => [item.id, new Set(item.blockedBy)]))
  const waves = []
  const done = new Set()
  for (;;) {
    const ready = [...remaining.keys()].filter((id) => [...remaining.get(id)].every((blocker) => done.has(blocker))).sort()
    if (ready.length === 0) break
    waves.push(ready)
    for (const id of ready) {
      done.add(id)
      remaining.delete(id)
    }
  }
  return { waves, cycle: [...remaining.keys()].sort() }
}

/**
 * Report every pair of same-wave items whose write scopes overlap.
 * @param items - normalized items.
 * @param waves - execution waves from {@link computeWaves}.
 * @returns conflict records `{ wave, left, right, scopes }`.
 */
export function findScopeConflicts(items, waves) {
  const byId = new Map(items.map((item) => [item.id, item]))
  const conflicts = []
  waves.forEach((wave, index) => {
    for (let i = 0; i < wave.length; i += 1) {
      for (let j = i + 1; j < wave.length; j += 1) {
        const left = byId.get(wave[i])
        const right = byId.get(wave[j])
        if (left === undefined || right === undefined) continue
        const overlaps = []
        for (const a of left.writeScopes) {
          for (const b of right.writeScopes) {
            if (scopesOverlap(a, b)) overlaps.push(`${a} <> ${b}`)
          }
        }
        if (overlaps.length > 0) conflicts.push({ wave: index + 1, left: left.id, right: right.id, scopes: [...new Set(overlaps)] })
      }
    }
  })
  return conflicts
}

/**
 * Validate a normalized plan against the workflow rules.
 * @param plan - `{ objective, acceptanceCriteria, constraints, items }`.
 * @param settings - run-scoped settings.
 * @returns `{ errors, warnings, waves, conflicts }`.
 */
export function validatePlan(plan, settings) {
  const errors = []
  const warnings = []
  const items = plan.items
  if (typeof plan.objective !== 'string' || plan.objective.trim().length === 0) errors.push('objective must be a non-empty string')
  if (plan.objective && plan.objective.length > 4000) errors.push('objective must be at most 4000 characters')
  if (!Array.isArray(plan.acceptanceCriteria) || plan.acceptanceCriteria.length === 0) errors.push('acceptance_criteria must declare at least one verifiable acceptance criterion')
  if (items.length === 0) errors.push('items must declare at least one work item')
  if (items.length > settings.maxItems) errors.push(`items declares ${items.length} work items; the configured maximum is ${settings.maxItems}`)

  const ids = new Set()
  for (const item of items) {
    if (!/^[A-Za-z0-9._-]{1,32}$/.test(item.id)) errors.push(`item id "${item.id}" must match [A-Za-z0-9._-]{1,32}`)
    if (ids.has(item.id)) errors.push(`duplicate item id "${item.id}"`)
    ids.add(item.id)
    if (!item.subject) errors.push(`item "${item.id}" needs a non-empty subject`)
    if (item.subject && item.subject.length > 200) errors.push(`item "${item.id}" subject must be at most 200 characters`)
    if (item.assignment === 'open' && (item.owner === undefined || item.owner === null || item.owner === '')) {
      // Open-queue items are claimed by a peer after the plan is published.
    } else if (!item.owner) {
      errors.push(`item "${item.id}" needs an owner member name (or assignment:"open" to publish it for self-claim)`)
    } else if (item.owner === 'lead') {
      errors.push(`item "${item.id}" cannot be owned by the Lead; the Lead coordinates and gates`)
    } else if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(item.owner)) {
      errors.push(`item "${item.id}" owner "${item.owner}" is not a spawnable member name (lower-kebab-case, digits allowed)`)
    }
    if (!Array.isArray(item.definitionOfDone) || item.definitionOfDone.length === 0) errors.push(`item "${item.id}" needs at least one definition_of_done entry`)
    if (!Array.isArray(item.writeScopes) || item.writeScopes.length === 0) warnings.push(`item "${item.id}" declares no write scope; scope discipline cannot be checked`)
    for (const scope of item.writeScopes) {
      if (normalizeScope(scope).length === 0) errors.push(`item "${item.id}" declares an empty/root write scope`)
      if (normalizeScope(scope).startsWith('/')) errors.push(`item "${item.id}" write scope "${scope}" must be workspace-relative`)
    }
  }

  for (const item of items) {
    for (const blocker of item.blockedBy) {
      if (!ids.has(blocker)) errors.push(`item "${item.id}" blocked_by unknown item "${blocker}"`)
      if (blocker === item.id) errors.push(`item "${item.id}" cannot block itself`)
    }
    if (item.needsReview === false) continue
    if (item.reviewers.length === 0) {
      if (item.assignment === 'open') warnings.push(`item "${item.id}" publishes review as an open invitation; the owner must request a peer review after reporting`)
      else errors.push(`item "${item.id}" requires review but declares no reviewers (set needs_review=false to opt out explicitly)`)
    }
    for (const reviewer of item.reviewers) {
      if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(reviewer)) errors.push(`item "${item.id}" reviewer "${reviewer}" is not a spawnable member name (lower-kebab-case, digits allowed)`)
      if (reviewer === item.owner) errors.push(`item "${item.id}" lists its own owner "${reviewer}" as reviewer; reviews must be independent`)
      if (reviewer === 'lead') warnings.push(`item "${item.id}" is reviewed by the Lead; that is permitted but weaker than an independent peer`)
    }
    if (new Set(item.reviewers).size !== item.reviewers.length) errors.push(`item "${item.id}" repeats a reviewer`)
  }

  const { waves, cycle } = computeWaves(items)
  for (const item of cycle) errors.push(`item "${item.id}" participates in a dependency cycle`)
  for (const wave of waves) {
    if (wave.length > settings.maxParallelItems) {
      warnings.push(`wave ${waves.indexOf(wave) + 1} runs ${wave.length} items in parallel; the configured recommendation is ${settings.maxParallelItems}`)
    }
  }
  const conflicts = findScopeConflicts(items, waves)
  if (conflicts.length > 0) {
    const detail = conflicts.map((conflict) => `wave ${conflict.wave}: ${conflict.left} vs ${conflict.right} (${conflict.scopes.join(', ')})`).join('; ')
    if (settings.allowScopeOverlap) warnings.push(`overlapping write scopes in one wave are allowed by configuration: ${detail}`)
    else errors.push(`overlapping write scopes inside one execution wave would race: ${detail}`)
  }

  const owners = collectOwners(items)
  if (owners.length > 8) errors.push(`plan needs ${owners.length} workers; Agent Teams allows at most 8 members including the Lead`)
  if (items.length > 0 && items.every((item) => item.needsReview === false)) {
    warnings.push('no item requires independent review; the workflow will not provide mutual-review assurance for this run')
  }
  return { errors, warnings, waves, conflicts }
}

/** @returns the report version new verdicts must bind to. */
export function currentReportSeq(item) {
  return Number.isInteger(item.reportSeq) ? item.reportSeq : 0
}

/**
* Return the last review submitted by one reviewer **for the current report**.
* Approvals are version-bound: a verdict for an older report can never approve
* a newer one, which is what stops a re-report from inheriting old sign-off.
* @param item - item whose reviews to scan.
* @param reviewer - reviewer member name.
* @returns the review, or `null`.
*/
export function lastReviewOf(item, reviewer) {
  const seq = currentReportSeq(item)
  for (let index = item.reviews.length - 1; index >= 0; index -= 1) {
    const review = item.reviews[index]
    if (review.reviewer !== reviewer) continue
    if (review.status === 'superseded') continue
    if ((Number.isInteger(review.reportSeq) ? review.reportSeq : 0) !== seq) continue
    return review
  }
  return null
}

/** @returns the currently pending review of one item, if any. */
export function pendingReview(item) {
  return item.reviews.find((review) => review.status === 'pending') ?? null
}

/** @returns whether one verdict counts as approval. */
export function isApproving(verdict) {
  return verdict === 'approve' || verdict === 'approve_with_nits'
}

/** @returns whether every declared reviewer of an item has approved. */
export function allReviewersApproved(item) {
  if (item.needsReview === false) return true
  if (item.reviewers.length === 0) return false
  return item.reviewers.every((reviewer) => {
    const latest = lastReviewOf(item, reviewer)
    return latest !== null && isApproving(latest.verdict)
  })
}

/** @returns the reviewers of one item that have not approved yet. */
export function outstandingReviewers(item) {
  if (item.needsReview === false) return []
  return item.reviewers.filter((reviewer) => {
    const latest = lastReviewOf(item, reviewer)
    return latest === null || !isApproving(latest.verdict)
  })
}

/** @returns count of reviews actually submitted (pending and superseded excluded). */
export function submittedRounds(item) {
  return item.reviews.filter((review) => review.status === 'submitted').length
}

/**
* Count the rework rounds of one item. One round is a submitted non-approving
* verdict that forced changes; approvals by other reviewers do not consume the
* budget, so a multi-reviewer item can still iterate.
*
* The counter is cumulative for the item's lifetime on purpose: a fresh report
* must not reset it, otherwise an author could re-report after every response
* and never reach the escalation threshold. Only the Lead's explicit
* `reopen` repair clears it.
* @param item - item to inspect.
* @returns number of non-approving verdicts ever submitted for this item.
*/
export function reworkRounds(item) {
  return Number.isInteger(item.reworkTotal) ? item.reworkTotal : 0
}

/** @returns unresolved findings across the current report's submitted reviews. */
export function unresolvedFindings(item) {
  const seq = currentReportSeq(item)
  const result = []
  for (const review of item.reviews) {
    if ((Number.isInteger(review.reportSeq) ? review.reportSeq : 0) !== seq) continue
    for (const finding of review.findings) {
      if (finding.resolution === null || finding.resolution === undefined) result.push({ review, finding })
    }
  }
  return result
}

/**
 * Create one pending review round and attach it to the item.
 * @param item - item to attach to (mutated).
 * @param reviewer - reviewer member name.
 * @param options - `{ now, actor }`.
 * @returns the created review.
 */
export function openReview(item, reviewer, options) {
  const review = {
    round: item.reviewSeq + 1,
    reportSeq: currentReportSeq(item),
    reviewer,
    requestedBy: options.actor,
    requestedAt: options.now,
    status: 'pending',
    verdict: null,
    summary: '',
    findings: [],
    evidenceChecked: [],
    submittedAt: null,
  }
  item.reviewSeq += 1
  item.reviews.push(review)
  item.pendingReviewer = reviewer
  item.status = ITEM_STATUS.IN_REVIEW
  return review
}

/**
 * Apply one work report from an item owner.
 * @param state - run state (mutated).
 * @param input - `{ itemId, caller, report, now, settings }`.
 * @returns `{ item, review, nextReviewer }`.
 */
export function applyReport(state, input) {
  const item = findItem(state, input.itemId)
  const now = input.now
  const report = input.report
  const open = unresolvedFindings(item)
  if (open.length > 0) {
    const ids = open.map((entry) => entry.finding.id).join(', ')
    throw new WorkflowError(
      `item "${item.id}" still has unresolved review findings (${ids}); answer them with team_flow_review_respond before reporting again`,
      'WORKFLOW_OPEN_FINDINGS',
    )
  }
  const unapprovedBlockers = item.blockedBy.filter((blocker) => {
    const dependency = findItem(state, blocker)
    return dependency.status !== ITEM_STATUS.APPROVED && dependency.overrideReason === null
  })
  if (unapprovedBlockers.length > 0) {
    throw new WorkflowError(
      `item "${item.id}" depends on ${unapprovedBlockers.join(', ')}, which is not approved yet. Wait for the dependency, or have the Lead accept its risk with a gate override, before reporting.`,
      'WORKFLOW_DEPENDENCY_NOT_APPROVED',
    )
  }
  item.reportSeq = currentReportSeq(item) + 1
  item.report = {
    summary: report.summary,
    files: report.files,
    commands: report.commands,
    evidence: report.evidence,
    openQuestions: report.openQuestions,
    risks: report.risks,
    deviation: report.deviation ?? null,
    sequenceWarnings: [],
    submittedBy: input.caller,
    submittedAt: now,
  }
  item.updatedAt = now
  item.reportedAt = now
  item.overrideReason = null
  for (const review of item.reviews) {
    if (review.status === 'pending') review.status = 'superseded'
  }
  appendEvent(state, { at: now, type: 'item/reported', actor: input.caller, detail: `${item.id}: ${report.summary.slice(0, 160)}` })

  let review = null
  let nextReviewer = null
  if (item.needsReview === false) {
    item.status = ITEM_STATUS.APPROVED
    item.approvedAt = now
    item.approvedBy = 'self'
  } else {
    // A new report invalidates earlier verdicts by construction (they bind to
    // the previous reportSeq), so every declared reviewer must sign this
    // version. There is deliberately no "already approved" shortcut here.
    const prospective = outstandingReviewers(item)[0] ?? item.reviewers[0]
    if (prospective === undefined) {
      // Open-queue item without a declared reviewer: the author must invite a
      // peer, so the item waits in review with no pending review yet.
      item.status = ITEM_STATUS.IN_REVIEW
      item.pendingReviewer = null
      postChannelMessage(state, {
        from: input.caller,
        to: 'team',
        kind: 'question',
        text: `${item.id} is reported and needs a peer reviewer: invite one with team_flow_work {action:"request_review", item_id:"${item.id}"}`,
        itemId: item.id,
        now,
      })
    } else {
      nextReviewer = prospective
      review = openReview(item, nextReviewer, { now, actor: input.caller })
    }
  }
  state.phase = state.items.every((candidate) => candidate.status === ITEM_STATUS.APPROVED) ? RUN_PHASE.CONVERGED : RUN_PHASE.REVIEWING
  state.updatedAt = now
  return { item, review, nextReviewer }
}

/**
 * Apply one reviewer verdict.
 * @param state - run state (mutated).
 * @param input - `{ itemId, reviewer, verdict, summary, findings, evidenceChecked, now }`.
 * @returns `{ item, review, nextReviewer }`.
 */
export function applyReviewSubmit(state, input) {
  const item = findItem(state, input.itemId)
  const review = pendingReview(item)
  if (review === null) throw new WorkflowError(`item "${item.id}" has no pending review`, 'WORKFLOW_NO_PENDING_REVIEW')
  if (review.reviewer !== input.reviewer) {
    throw new WorkflowError(`the pending review of "${item.id}" is assigned to "${review.reviewer}", not "${input.reviewer}"`, 'WORKFLOW_NOT_REVIEWER')
  }
  if (isApproving(input.verdict)) {
    const blocking = openBlockingProposals(state, item.id)
    if (blocking.length > 0) {
      throw new WorkflowError(
        `item "${item.id}" has open blocking proposal(s) ${blocking.map((proposal) => proposal.id).join(', ')}; settle them with team_flow_decide before approving`,
        'WORKFLOW_OPEN_PROPOSAL',
      )
    }
  }
  const findingIds = new Set()
  const findings = input.findings.map((finding, index) => {
    const id = finding.id ?? `F${index + 1}`
    if (findingIds.has(id)) throw new WorkflowError(`duplicate finding id "${id}" in one review`, 'WORKFLOW_DUPLICATE_FINDING')
    findingIds.add(id)
    return {
      id,
      severity: finding.severity,
      file: finding.file ?? null,
      line: finding.line ?? null,
      claim: finding.claim,
      suggestion: finding.suggestion ?? null,
      resolution: null,
    }
  })
  if (!isApproving(input.verdict) && findings.length === 0) {
    throw new WorkflowError('a non-approving verdict must report at least one finding', 'WORKFLOW_FINDINGS_REQUIRED')
  }
  for (const finding of findings) {
    if ((finding.severity === 'blocker' || finding.severity === 'major') && (finding.file === null || finding.file.length === 0)) {
      throw new WorkflowError(`finding "${finding.id}" is ${finding.severity} and must name the file it is about`, 'WORKFLOW_FINDING_FILE_REQUIRED')
    }
  }
  review.status = 'submitted'
  review.verdict = input.verdict
  review.summary = input.summary
  review.findings = findings
  review.evidenceChecked = input.evidenceChecked
  review.submittedAt = input.now
  if (isApproving(input.verdict)) {
    // Approving with observations is an early stop, not a rework request: the
    // reviewer accepts the work, so its findings are recorded as accepted and
    // never block the gate or assign work to the author.
    for (const finding of findings) {
      finding.resolution = {
        state: 'accepted_by_reviewer',
        evidence: null,
        note: 'recorded together with an approving verdict',
        at: input.now,
        by: input.reviewer,
      }
    }
  } else {
    item.reworkTotal = reworkRounds(item) + 1
  }
  item.updatedAt = input.now
  appendEvent(state, { at: input.now, type: 'review/submitted', actor: input.reviewer, detail: `${item.id} round ${review.round}: ${input.verdict}` })

  let nextReviewer = null
  let nextReview = null
  if (isApproving(input.verdict)) {
    if (allReviewersApproved(item)) {
      item.status = ITEM_STATUS.APPROVED
      item.approvedAt = input.now
      item.approvedBy = 'review'
    } else {
      nextReviewer = outstandingReviewers(item)[0]
      if (nextReviewer !== undefined) nextReview = openReview(item, nextReviewer, { now: input.now, actor: input.reviewer })
    }
  } else {
    item.status = ITEM_STATUS.CHANGES_REQUESTED
  }
  state.phase = state.items.every((candidate) => candidate.status === ITEM_STATUS.APPROVED) ? RUN_PHASE.CONVERGED : RUN_PHASE.REVIEWING
  item.pendingReviewer = pendingReview(item)?.reviewer ?? null
  state.updatedAt = input.now
  return { item, review, nextReview, nextReviewer }
}

/**
 * Apply one author response to review findings.
 * @param state - run state (mutated).
 * @param input - `{ itemId, author, responses, now, settings }`.
 * @returns `{ item, nextReview, nextReviewer, escalated }`.
 */
export function applyReviewRespond(state, input) {
  const item = findItem(state, input.itemId)
  const pending = unresolvedFindings(item)
  if (pending.length === 0) {
    throw new WorkflowError(`item "${item.id}" has no unresolved review findings to respond to`, 'WORKFLOW_NOTHING_TO_RESOLVE')
  }
  const byId = new Map()
  for (const { finding } of pending) byId.set(finding.id, finding)
  for (const response of input.responses) {
    const finding = byId.get(response.findingId)
    if (finding === undefined) throw new WorkflowError(`unknown or already resolved finding "${response.findingId}"`, 'WORKFLOW_UNKNOWN_FINDING')
    finding.resolution = {
      state: response.state,
      evidence: response.evidence ?? null,
      note: response.note ?? null,
      at: input.now,
      by: input.author,
    }
  }
  const stillOpen = unresolvedFindings(item)
  if (stillOpen.length > 0) {
    const missing = stillOpen.map((entry) => entry.finding.id).join(', ')
    throw new WorkflowError(`every finding needs a response; still open: ${missing}`, 'WORKFLOW_FINDINGS_UNRESOLVED')
  }

  const pendingReviewRecord = item.reviews.filter((review) => review.status === 'submitted').at(-1)
  const rebuttedBlocker = pendingReviewRecord?.findings.some((finding) => finding.severity === 'blocker' && finding.resolution?.state === 'rebut')
  const lastReview = pendingReviewRecord
  if (rebuttedBlocker) {
    item.status = ITEM_STATUS.ESCALATED
    raiseEscalation(state, {
      kind: 'arbitration',
      subject: `Blocker rebutted on ${item.id}`,
      detail: `The author rebutted a blocker finding; the Lead must decide. Review round ${lastReview?.round ?? '?'} by ${lastReview?.reviewer ?? 'unknown'}.`,
      blocking: true,
      actor: input.author,
      itemId: item.id,
      now: input.now,
    })
    state.updatedAt = input.now
    return { item, nextReview: null, nextReviewer: null, escalated: true }
  }

  if (reworkRounds(item) >= input.settings.maxReviewRounds) {
    item.status = ITEM_STATUS.ESCALATED
    raiseEscalation(state, {
      kind: 'arbitration',
      subject: `Review rounds exhausted for ${item.id}`,
      detail: `The author addressed all findings but ${reworkRounds(item)} rework round(s) are already used (maximum ${input.settings.maxReviewRounds}) without approval.`,
      blocking: true,
      actor: 'workflow',
      itemId: item.id,
      now: input.now,
    })
    state.updatedAt = input.now
    return { item, nextReview: null, nextReviewer: null, escalated: true }
  }

  const reviewer = lastReview?.reviewer ?? outstandingReviewers(item)[0] ?? item.reviewers[0]
  const nextReview = openReview(item, reviewer, { now: input.now, actor: input.author })
  appendEvent(state, { at: input.now, type: 'item/responded', actor: input.author, detail: `${item.id}: responded to ${input.responses.length} finding(s)` })
  state.updatedAt = input.now
  return { item, nextReview, nextReviewer: reviewer, escalated: false }
}

/**
 * Create one escalation record.
 * @param state - run state (mutated).
 * @param input - escalation fields.
 * @returns the created escalation.
 */
export function raiseEscalation(state, input) {
  if (input.itemId !== undefined && input.itemId !== null) {
    const existing = state.escalations.find((candidate) => !candidate.resolved && candidate.itemId === input.itemId && candidate.kind === input.kind)
    if (existing !== undefined) return existing
  }
  const escalation = {
    id: nextEscalationId(state),
    kind: input.kind,
    subject: input.subject,
    detail: input.detail,
    blocking: input.blocking,
    itemId: input.itemId ?? null,
    createdBy: input.actor,
    createdAt: input.now,
    resolved: false,
    resolution: null,
    resolvedBy: null,
    resolvedAt: null,
  }
  state.escalations.push(escalation)
  appendEvent(state, { at: input.now, type: 'escalation/raised', actor: input.actor, detail: `${escalation.id} ${input.subject}` })
  return escalation
}

/**
 * Resolve one escalation.
 * @param state - run state (mutated).
 * @param input - `{ escalationId, resolution, actor, now }`.
 * @returns the resolved escalation.
 */
export function resolveEscalation(state, input) {
  const escalation = state.escalations.find((candidate) => candidate.id === input.escalationId)
  if (escalation === undefined) throw new WorkflowError(`unknown escalation "${input.escalationId}"`, 'WORKFLOW_UNKNOWN_ESCALATION')
  if (escalation.resolved) throw new WorkflowError(`escalation "${escalation.id}" is already resolved`, 'WORKFLOW_ESCALATION_ALREADY_RESOLVED')
  escalation.resolved = true
  escalation.resolution = input.resolution
  escalation.resolvedBy = input.actor
  escalation.resolvedAt = input.now
  appendEvent(state, { at: input.now, type: 'escalation/resolved', actor: input.actor, detail: `${escalation.id}: ${input.resolution.slice(0, 160)}` })
  state.updatedAt = input.now
  return escalation
}

/**
 * Evaluate every quality gate of a run.
 * @param state - run state.
 * @param input - `{ settings, members, nativeTasks, overrides }`.
 * @returns gate result object.
 */
export function evaluateGates(state, input) {
  const overrides = new Map((input.overrides ?? []).map((entry) => [entry.itemId, entry.reason]))
  const nativeById = new Map((input.nativeTasks ?? []).map((task) => [task.id, task]))
  const memberByName = new Map((input.members ?? []).map((member) => [member.name, member]))
  const itemGates = state.items.map((item) => {
    const failures = []
    const warnings = []
    const override = overrides.get(item.id) ?? null

    if (item.report === null) failures.push('no work report submitted')
    const commands = item.report?.commands ?? []
    const missingExit = commands.filter((command) => !Number.isInteger(command.exitCode))
    const emptyCommand = commands.filter((command) => String(command.command ?? '').trim().length === 0)
    if (item.evidenceOptional !== true) {
      if (commands.length === 0) failures.push('no verification command recorded')
      else if (missingExit.length > 0) failures.push(`${missingExit.length} command(s) recorded without an integer exit_code`)
      if (emptyCommand.length > 0) failures.push(`${emptyCommand.length} command(s) recorded with an empty command line`)
      if ((item.report?.evidence ?? []).length === 0) failures.push('no supporting evidence quoted or referenced')
    }

    const unapprovedDependencies = item.blockedBy.filter((blocker) => {
      const dependency = state.items.find((candidate) => candidate.id === blocker)
      return dependency === undefined || (dependency.status !== ITEM_STATUS.APPROVED && dependency.overrideReason === null)
    })
    if (unapprovedDependencies.length > 0) failures.push(`dependencies not approved: ${unapprovedDependencies.join(', ')}`)

    const submitted = item.reviews.filter((review) => review.status === 'submitted')
    const unverifiedApprovals = submitted.filter((review) => isApproving(review.verdict) && review.evidenceChecked.length === 0)
    if (input.settings.requireReviewEvidence !== false) {
      for (const review of unverifiedApprovals) failures.push(`review round ${review.round} by ${review.reviewer} approved without declaring any inspected evidence`)
    } else if (unverifiedApprovals.length > 0) {
      warnings.push(`${unverifiedApprovals.length} approving review(s) declare no inspected evidence`)
    }
    for (const warning of item.report?.sequenceWarnings ?? []) warnings.push(warning)

    const outstanding = outstandingReviewers(item)
    if (item.needsReview !== false && outstanding.length > 0) {
      failures.push(`review not approved by: ${outstanding.join(', ')}`)
    }
    if (item.needsReview !== false && item.reviewers.length === 0) {
      failures.push('no peer reviewer was ever assigned; the owner must invite one with team_flow_work {action:"request_review"}')
    }
    const blockingProposals = openBlockingProposals(state, item.id)
    if (blockingProposals.length > 0) {
      failures.push(`open blocking proposal(s): ${blockingProposals.map((proposal) => `${proposal.id}(${proposal.kind})`).join(', ')}`)
    }
    if (reworkRounds(item) > input.settings.maxReviewRounds) {
      warnings.push(`${reworkRounds(item)} rework round(s) exceeded the configured maximum`)
    }
    const openFindings = unresolvedFindings(item)
    if (openFindings.length > 0) failures.push(`${openFindings.length} unresolved review finding(s)`)

    const outside = []
    if (item.report !== null) {
      for (const file of item.report.files) {
        if (item.writeScopes.length === 0) continue
        if (!item.writeScopes.some((scope) => pathInScope(file, scope))) outside.push(file)
      }
    }
    if (outside.length > 0) {
      if (input.settings.strictScopes) failures.push(`files outside the declared write scope: ${outside.join(', ')}`)
      else warnings.push(`files outside the declared write scope: ${outside.join(', ')}`)
    }

    for (const reviewer of item.reviewers) {
      const member = memberByName.get(reviewer)
      if (member?.context === 'fork') warnings.push(`reviewer "${reviewer}" was spawned with forked context; independence is weaker than a fresh reviewer`)
      if (reviewer === item.owner) failures.push(`reviewer "${reviewer}" is also the author`)
    }

    const nativeTask = item.taskId === null ? null : nativeById.get(item.taskId)
    if (nativeTask !== undefined && nativeTask !== null && nativeTask.status !== 'completed') {
      warnings.push(`backing Team task ${nativeTask.status}`)
    }
    if (nativeTask === undefined && item.taskId !== null) warnings.push(`backing Team task ${item.taskId} not found on the board`)

    const waived = override === null ? [] : [...failures]
    const pass = failures.length === 0 || override !== null
    return {
      id: item.id,
      pass,
      overridden: override !== null,
      overrideReason: override,
      waived,
      failures,
      warnings,
    }
  })

  const blockingEscalations = state.escalations.filter((escalation) => escalation.blocking && !escalation.resolved)
  const teamFailures = []
  if (blockingEscalations.length > 0) teamFailures.push(`unresolved blocking escalation(s): ${blockingEscalations.map((escalation) => escalation.id).join(', ')}`)
  if (state.phase === RUN_PHASE.FINALIZED) teamFailures.push('run is already finalized')
  const pass = itemGates.every((gate) => gate.pass) && teamFailures.length === 0
  return {
    pass,
    evaluatedAt: input.now,
    itemGates,
    teamFailures,
    blockingEscalations: blockingEscalations.map((escalation) => escalation.id),
  }
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

/**
 * Summarize the peer-collaboration state for status and next actions.
 * @param state - run state.
 * @param input - `{ me, role, members }`.
 * @returns open queue, invitations, ballots and unanswered questions.
 */
export function collaborationSummary(state, input) {
  ensureCollaboration(state)
  const me = typeof input.me === 'string' ? input.me : (input.me?.name ?? '')
  const isLead = input.role === 'lead'
  const members = input.members ?? []
  const open_queue = state.items.filter((item) => item.assignment === 'open' && item.report === null && (typeof item.owner !== 'string' || item.owner.length === 0)).map((item) => item.id)
  const review_invites = []
  const handoffs_to_me = []
  const questions_to_me = []
  for (const item of state.items) {
    const hasPendingReview = pendingReview(item) !== null
    for (const request of item.reviewRequests) {
      if (hasPendingReview) break
      if (request.status !== 'open') continue
      if (request.by === me) continue
      if (request.reviewer !== null && request.reviewer !== me) continue
      if (!isLead && item.owner === me) continue
      review_invites.push({ itemId: item.id, reviewer: request.reviewer, by: request.by })
    }
    for (const handoff of item.handoffs) {
      if (handoff.status === 'offered' && handoff.to === me) handoffs_to_me.push({ itemId: item.id, by: handoff.by, reason: handoff.reason })
    }
  }
  const proposals_awaiting_vote = []
  for (const proposal of state.proposals) {
    if (proposal.status !== 'open') continue
    if (proposal.votes.some((vote) => vote.by === me)) continue
    const affected = affectedMembersFor(proposal, state, members)
    if (affected.includes(me)) proposals_awaiting_vote.push({ id: proposal.id, kind: proposal.kind, itemId: proposal.itemId, by: proposal.by })
  }
  for (const message of state.channel) {
    if (message.kind !== 'question') continue
    if (message.from === me) continue
    if (message.to !== 'team' && message.to !== me) continue
    const answered = state.channel.some((candidate) => candidate.replyTo === message.id && candidate.from === me)
    if (answered) continue
    questions_to_me.push({ id: message.id, from: message.from, text: message.text, itemId: message.refs?.itemId ?? null })
  }
  return {
    open_queue,
    review_invites,
    handoffs_to_me,
    proposals_awaiting_vote,
    questions_to_me: questions_to_me.slice(-5),
  }
}

/**
 * Role-aware next actions for one member. This is the workflow engine's
 * steering surface: `team_flow_status` returns it so no member has to infer
 * the protocol from prose.
 * @param state - run state.
 * @param input - `{ me, role, settings, members }`.
 * @returns ordered action strings.
 */
export function nextActions(state, input) {
  const actions = []
  const me = typeof input.me === 'string' ? input.me : (input.me?.name ?? '')
  const isLead = input.role === 'lead'
  const openBlocking = state.escalations.filter((escalation) => escalation.blocking && !escalation.resolved)

  if (state.phase === RUN_PHASE.FINALIZED) {
    return [`Run ${state.runId} is finalized; the report is at ${state.artifacts?.reportPath ?? 'the artifact directory'}.`]
  }

  const approved = state.items.filter((item) => item.status === ITEM_STATUS.APPROVED).length
  const allApproved = approved === state.items.length

  const collaboration = collaborationSummary(state, { me, role: input.role, members: input.members ?? [] })

  if (isLead) {
    for (const escalation of openBlocking) actions.push(`Resolve escalation ${escalation.id} ("${escalation.subject}") with team_flow_escalate {escalation_id:"${escalation.id}", resolution:"..."}.`)
    const needsOwner = state.items.filter((item) => item.status === ITEM_STATUS.PENDING || item.status === ITEM_STATUS.RUNNING)
    if (needsOwner.length > 0) {
      const names = [...new Set(needsOwner.map((item) => item.owner))]
      actions.push(`Ensure these owners are spawned and running: ${names.join(', ')}. Use the spawn prompts returned by team_flow_plan; message an inactive owner with send_message to resume it.`)
    }
    const escalated = state.items.filter((item) => item.status === ITEM_STATUS.ESCALATED)
    for (const item of escalated) {
      actions.push(`Arbitrate ${item.id}: read the review history with team_flow_status {item_id:"${item.id}"}, then either team_flow_repair {action:"reopen", item_id:"${item.id}", reason:"..."} to require rework, or record a gate override with a reason.`)
    }
    const stuckReviews = state.items.filter((item) => item.status === ITEM_STATUS.IN_REVIEW && pendingReview(item) !== null)
    if (stuckReviews.length > 0) {
      actions.push(`If a pending review stays stuck because its reviewer is inactive or was never spawned, use team_flow_repair {action:"reset_review", item_id:"<id>", reviewer:"<member>"} (or reassign the item) instead of waiting forever.`)
    }
    if (collaboration.open_queue.length > 0) {
      actions.push(`Open queue: ${collaboration.open_queue.join(', ')}. Let peers claim them (they run team_flow_work {action:"claim"}); spawn or wake the workers if nobody is active, instead of assigning by hand.`)
    }
    const waitingReviewers = state.items.filter((item) => item.needsReview !== false && item.reviewers.length === 0 && item.report !== null)
    if (waitingReviewers.length > 0) {
      actions.push(`These reported items still need a peer reviewer: ${waitingReviewers.map((item) => item.id).join(', ')}. Their owners should invite one; if they are inactive, ask a peer to team_flow_work {action:"take_review"}.`)
    }
    const openProposalList = state.proposals.filter((proposal) => proposal.status === 'open')
    if (openProposalList.length > 0) {
      actions.push(`Open proposals: ${openProposalList.map((proposal) => `${proposal.id}(${proposal.kind})`).join(', ')}. Let affected peers vote with team_flow_decide {action:"vote"}; arbitrate only ties or deadlocks.`)
    }
    if (allApproved && openBlocking.length === 0) actions.push('All items are approved: run team_flow_gate {finalize:true} to evaluate the gates, write the report, and converge the run.')
    else if (!allApproved) actions.push(`Wait for reviews using wait_agent, then re-read team_flow_status. Approved ${approved}/${state.items.length}.`)
    return actions
  }

  const owned = state.items.filter((item) => item.owner === me)
  for (const item of owned) {
    if (item.status === ITEM_STATUS.PENDING || item.status === ITEM_STATUS.RUNNING) {
      actions.push(`Do ${item.id} ("${item.subject}") inside ${item.writeScopes.length > 0 ? item.writeScopes.join(', ') : 'no declared scope'}; then call team_flow_report with files and verification commands.`)
    } else if (item.status === ITEM_STATUS.CHANGES_REQUESTED) {
      actions.push(`Read the findings for ${item.id} in team_flow_status, fix them, then call team_flow_review_respond with one response per finding id.`)
    } else if (item.status === ITEM_STATUS.ESCALATED) {
      actions.push(`${item.id} is waiting on the Lead's arbitration; do not change it unless the Lead messages you.`)
    }
  }
  const assigned = state.items.filter((item) => {
    const review = pendingReview(item)
    return review !== null && review.reviewer === me
  })
  for (const item of assigned) {
    const review = pendingReview(item)
    actions.push(`Review ${item.id} round ${review.round}: inspect the reported files and evidence, then call team_flow_review_submit with a verdict and evidence-backed findings.`)
  }
  for (const itemId of collaboration.open_queue) {
    const item = state.items.find((candidate) => candidate.id === itemId)
    if (item === undefined) continue
    actions.push(`Open queue item ${item.id} ("${item.subject}"): claim it with team_flow_work {action:"claim", item_id:"${item.id}"} if you can take it, then work inside ${item.writeScopes.length > 0 ? item.writeScopes.join(', ') : 'its declared scope'}.`)
  }
  for (const request of collaboration.review_invites) {
    actions.push(`Peer review invitation for ${request.itemId}${request.reviewer === null ? ' (open to anyone)' : ''}: accept with team_flow_work {action:"take_review", item_id:"${request.itemId}"} to become its reviewer.`)
  }
  for (const handoff of collaboration.handoffs_to_me) {
    actions.push(`${handoff.by} offers you ${handoff.itemId}${handoff.reason ? ` ("${handoff.reason}")` : ''}: accept with team_flow_work {action:"handoff_accept", item_id:"${handoff.itemId}"} or decline with {action:"handoff_decline"}.`)
  }
  for (const proposal of collaboration.proposals_awaiting_vote) {
    actions.push(`Proposal ${proposal.id} (${proposal.kind}${proposal.itemId === null ? '' : ` ${proposal.itemId}`}) needs your vote: team_flow_decide {action:"vote", proposal_id:"${proposal.id}", vote:"yes|no|abstain"}.`)
  }
  for (const question of collaboration.questions_to_me) {
    actions.push(`${question.from} asked you in the channel${question.itemId === null ? '' : ` about ${question.itemId}`}: "${question.text.slice(0, 160)}". Answer with team_flow_talk {target:"${question.from}", kind:"answer", reply_to:"${question.id}", item_id:"${question.itemId ?? ''}"}.`)
  }
  if (actions.length === 0) {
    const waiting = state.items.some((item) => item.reviews.some((review) => review.status === 'pending'))
    actions.push(waiting ? 'No action is assigned to you right now. Read the channel and status after a peer message; the Lead will steer the next round.' : 'No action is assigned to you right now; wait for the Lead or claim an open item.')
  }
  return actions
}

/**
 * Build the compact status object returned by `team_flow_status`.
 * @param state - run state.
 * @param input - `{ me, role, settings, members, artifacts }`.
 * @returns model-facing status record.
 */
export function buildStatus(state, input) {
  const me = input.me
  const items = state.items.map((item) => {
    const pending = pendingReview(item)
    const latest = item.reviews.filter((review) => review.status !== 'pending').at(-1) ?? null
    const task = item.taskId === null ? null : (input.tasksById?.get(item.taskId) ?? null)
    return {
      id: item.id,
      subject: item.subject,
      owner: item.owner,
      role: item.role,
      status: item.status,
      task_id: item.taskId,
      task: task === null ? null : { id: item.taskId, revision: task.revision, status: task.status },
      definition_of_done: item.definitionOfDone,
      reviewers: item.reviewers,
      repair_log: item.repairLog ?? [],
      write_scopes: item.writeScopes,
      blocked_by: item.blockedBy,
      reported: item.report !== null,
      reviews: {
        // `rework_rounds` is the number the gate budgets; `submitted_rounds`
        // counts every submitted verdict including approvals. They differ by
        // design and are both surfaced so the Lead never has to guess.
        rework_rounds: reworkRounds(item),
        submitted_rounds: submittedRounds(item),
        max_rounds: input.settings.maxReviewRounds,
        pending_reviewer: pending?.reviewer ?? null,
        verdicts: item.reviews
          .filter((review) => review.status === 'submitted')
          .map((review) => ({ reviewer: review.reviewer, verdict: review.verdict, round: review.round, report_seq: review.reportSeq ?? 0 })),
        latest_summary: latest?.summary ?? null,
      },
      open_findings: unresolvedFindings(item).length,
      report_summary: item.report?.summary ?? null,
      override: item.overrideReason ?? null,
      assignment: item.assignment ?? 'lead',
      claim: item.claim ?? null,
      pending_reviewer: pending?.reviewer ?? item.pendingReviewer ?? null,
      review_requests: item.reviewRequests ?? [],
      handoffs: item.handoffs ?? [],
      open_proposals: openBlockingProposals(state, item.id).length,
      ...(input.detailItemId === item.id
        ? {
            // Detailed records get their own keys: overwriting the compact
            // `reviews` summary with the raw array would break every reader
            // that asks for the counters.
            report: item.report,
            review_records: item.reviews,
          }
        : {}),
    }
  })
  const counts = {
    total: state.items.length,
    approved: state.items.filter((item) => item.status === ITEM_STATUS.APPROVED).length,
    pending: state.items.filter((item) => item.status === ITEM_STATUS.PENDING || item.status === ITEM_STATUS.RUNNING).length,
    in_review: state.items.filter((item) => item.status === ITEM_STATUS.IN_REVIEW).length,
    changes_requested: state.items.filter((item) => item.status === ITEM_STATUS.CHANGES_REQUESTED).length,
    escalated: state.items.filter((item) => item.status === ITEM_STATUS.ESCALATED).length,
  }
  const members = (input.members ?? []).map((member) => ({ name: member.name, role: member.role, status: member.status, context: member.context }))
  return {
    workflow_version: state.workflowVersion,
    run_id: state.runId,
    phase: state.phase,
    objective: state.objective.length > 400 ? `${state.objective.slice(0, 400)}…` : state.objective,
    acceptance_criteria: state.acceptanceCriteria,
    constraints: state.constraints,
    artifacts: input.artifacts,
    settings: input.settings,
    me: { name: me.name, role: input.role },
    counts,
    items,
    escalations: state.escalations.map((escalation) => ({
      id: escalation.id,
      kind: escalation.kind,
      subject: escalation.subject,
      blocking: escalation.blocking,
      item_id: escalation.itemId,
      resolved: escalation.resolved,
      resolution: escalation.resolution,
      created_by: escalation.createdBy,
    })),
    team: members,
    collaboration: (() => {
      const summary = collaborationSummary(state, { me: me.name, role: input.role, members: input.members ?? [] })
      return {
        open_queue: summary.open_queue,
        review_invites: summary.review_invites,
        handoffs_to_me: summary.handoffs_to_me,
        proposals_awaiting_vote: summary.proposals_awaiting_vote,
        questions_to_me: summary.questions_to_me,
        proposals_open: state.proposals.filter((proposal) => proposal.status === 'open').map((proposal) => ({ id: proposal.id, kind: proposal.kind, item_id: proposal.itemId, by: proposal.by })),
        channel_tail: state.channel.slice(-10).map((message) => ({ id: message.id, at: message.at, from: message.from, to: message.to, kind: message.kind, text: message.text.slice(0, 300), item_id: message.refs?.itemId ?? null })),
      }
    })(),
    next_actions: nextActions(state, { ...input, me: me.name }),
  }
}


// ---------------------------------------------------------------------------
// Peer collaboration layer (workflow v2)
//
// Members talk to each other directly, claim open work, invite peers to
// review, negotiate scope/DoD through proposals and votes, and hand work off.
// Every action lands on the blackboard so the board can replay who did what
// with whom; the Lead only arbitrates deadlocks and gates the run.
// ---------------------------------------------------------------------------

/** @returns the proposal with one id, throwing a stable error when absent. */
export function findProposal(state, proposalId) {
  const proposal = (state.proposals ?? []).find((candidate) => candidate.id === proposalId)
  if (proposal === undefined) throw new WorkflowError(`unknown proposal "${proposalId}"`, 'WORKFLOW_UNKNOWN_PROPOSAL')
  return proposal
}

/** Record one peer channel message; the transport (sendMessage) happens in the tool layer. */
export function postChannelMessage(state, input) {
  ensureCollaboration(state)
  const now = input.now ?? new Date().toISOString()
  const kind = CHANNEL_KINDS.includes(input.kind) ? input.kind : 'note'
  const text = String(input.text ?? '').trim()
  if (text.length === 0) throw new WorkflowError('a channel message needs non-empty text', 'WORKFLOW_EMPTY_MESSAGE')
  state.messageSeq += 1
  const message = {
    id: `m${state.messageSeq}`,
    at: now,
    from: input.from,
    to: input.to === undefined || input.to === null || input.to === '' ? 'team' : input.to,
    kind,
    text: text.slice(0, 4000),
    replyTo: input.replyTo ?? null,
    refs: {
      itemId: input.itemId ?? null,
      findingId: input.findingId ?? null,
      proposalId: input.proposalId ?? null,
    },
  }
  state.channel.push(message)
  if (state.channel.length > CHANNEL_LIMIT) state.channel.splice(0, state.channel.length - CHANNEL_LIMIT)
  state.updatedAt = now
  return message
}

/** @returns the reviewers whose sign-off one item still needs. */
function needsIndependentReview(item) {
  return item.needsReview !== false
}

/** Return the members a proposal affects: item owner+reviewers, or the whole Team. */
export function affectedMembersFor(proposal, state, members) {
  if (proposal.itemId !== null && proposal.itemId !== undefined) {
    const item = (state.items ?? []).find((candidate) => candidate.id === proposal.itemId)
    if (item === undefined) return []
    const names = new Set()
    for (const name of [item.owner, ...item.reviewers]) if (typeof name === 'string' && name.length > 0) names.add(name)
    return [...names]
  }
  return [...new Set((members ?? []).map((member) => member.name).filter((name) => typeof name === 'string' && name.length > 0))]
}

/** Tally one proposal against its affected set. */
export function tallyProposal(proposal, affected) {
  const votes = Array.isArray(proposal.votes) ? proposal.votes : []
  const tally = { yes: 0, no: 0, abstain: 0, affected: affected.length, total: votes.length }
  for (const vote of votes) {
    if (vote.vote === 'yes') tally.yes += 1
    else if (vote.vote === 'no') tally.no += 1
    else tally.abstain += 1
  }
  return tally
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

/** Claim one open-queue item for the caller. */
export function claimItem(state, input) {
  ensureCollaboration(state)
  const now = input.now ?? new Date().toISOString()
  const item = findItem(state, input.itemId)
  if (item.assignment !== 'open') {
    throw new WorkflowError(`item "${item.id}" is assigned by the Lead, not open for claiming; message the Lead if it should be reassigned`, 'WORKFLOW_ITEM_NOT_OPEN')
  }
  if (typeof item.owner === 'string' && item.owner.length > 0) {
    throw new WorkflowError(`item "${item.id}" is already claimed by "${item.owner}"`, 'WORKFLOW_ITEM_CLAIMED')
  }
  if (item.report !== null) throw new WorkflowError(`item "${item.id}" is already reported and cannot be claimed`, 'WORKFLOW_ITEM_REPORTED')
  if (item.status !== ITEM_STATUS.PENDING && item.status !== ITEM_STATUS.RUNNING) {
    throw new WorkflowError(`item "${item.id}" is "${item.status}" and cannot be claimed now`, 'WORKFLOW_ITEM_NOT_CLAIMABLE')
  }
  item.owner = input.caller
  item.claim = {
    by: input.caller,
    at: now,
    leaseMinutes: Number.isInteger(input.leaseMinutes) ? input.leaseMinutes : DEFAULT_LEASE_MINUTES,
    note: input.note === undefined ? null : String(input.note).slice(0, 1000),
  }
  item.updatedAt = now
  appendEvent(state, { at: now, type: 'item/claimed', actor: input.caller, detail: `${item.id} claimed` })
  postChannelMessage(state, { from: input.caller, to: 'team', kind: 'status', text: `claimed ${item.id}: ${item.subject}`, itemId: item.id, now })
  return item
}

/** Release one claimed/owned item back to the queue before it is reported. */
export function releaseItem(state, input) {
  ensureCollaboration(state)
  const now = input.now ?? new Date().toISOString()
  const item = findItem(state, input.itemId)
  if (item.owner !== input.caller) {
    throw new WorkflowError(`only the current owner of "${item.id}" may release it (owner: "${item.owner ?? 'nobody'}")`, 'WORKFLOW_NOT_OWNER')
  }
  if (item.report !== null) {
    throw new WorkflowError(`item "${item.id}" is already reported; ask a peer for a handoff instead of releasing it`, 'WORKFLOW_ITEM_REPORTED')
  }
  const previous = item.owner
  item.owner = null
  item.claim = null
  item.updatedAt = now
  appendEvent(state, { at: now, type: 'item/released', actor: input.caller, detail: `${item.id} released${input.reason ? `: ${String(input.reason).slice(0, 160)}` : ''}` })
  postChannelMessage(state, { from: input.caller, to: 'team', kind: 'status', text: `released ${item.id}${input.reason ? `: ${String(input.reason)}` : ''}`, itemId: item.id, now })
  return { item, previous }
}

/** Invite one peer (or the whole Team when `reviewer` is null) to review a reported item. */
export function requestReviewFromPeer(state, input) {
  ensureCollaboration(state)
  const now = input.now ?? new Date().toISOString()
  const item = findItem(state, input.itemId)
  if (item.owner !== input.caller) {
    throw new WorkflowError(`only the owner of "${item.id}" may request its review`, 'WORKFLOW_NOT_OWNER')
  }
  if (item.report === null) {
    throw new WorkflowError(`item "${item.id}" has no report yet; report the work before requesting review`, 'WORKFLOW_NOT_REPORTED')
  }
  if (needsIndependentReview(item) === false) {
    throw new WorkflowError(`item "${item.id}" opted out of review (needs_review=false)`, 'WORKFLOW_REVIEW_DISABLED')
  }
  const reviewer = input.reviewer === undefined || input.reviewer === null || input.reviewer === '' ? null : String(input.reviewer)
  if (reviewer !== null && reviewer === input.caller) {
    throw new WorkflowError('you cannot review your own work; invite a peer', 'WORKFLOW_SELF_REVIEW')
  }
  if (pendingReview(item) !== null) {
    throw new WorkflowError(`item "${item.id}" already has a pending review by "${pendingReview(item).reviewer}"`, 'WORKFLOW_REVIEW_PENDING')
  }
  const request = { by: input.caller, at: now, reviewer, status: 'open', respondedAt: null, response: null }
  item.reviewRequests.push(request)
  if (reviewer !== null && !item.reviewers.includes(reviewer)) item.reviewers.push(reviewer)
  if (reviewer !== null) {
    // A named invitation assigns the round immediately: only that peer may
    // submit, exactly like a plan-assigned reviewer. An open invitation waits
    // for take_review before any review round exists.
    openReview(item, reviewer, { now, actor: input.caller })
  }
  item.pendingReviewer = reviewer
  item.updatedAt = now
  appendEvent(state, { at: now, type: 'review/requested', actor: input.caller, detail: `${item.id} review requested${reviewer === null ? ' (open invitation)' : ` from ${reviewer}`}` })
  postChannelMessage(state, {
    from: input.caller,
    to: reviewer === null ? 'team' : reviewer,
    kind: 'question',
    text: `peer review requested for ${item.id}${reviewer === null ? ' (anyone may take it)' : ''}`,
    itemId: item.id,
    now,
  })
  return request
}

/** Accept one open (or personally addressed) review invitation, creating the pending review. */
export function takeReview(state, input) {
  ensureCollaboration(state)
  const now = input.now ?? new Date().toISOString()
  const item = findItem(state, input.itemId)
  if (item.owner === input.caller) {
    throw new WorkflowError('you cannot review your own work', 'WORKFLOW_SELF_REVIEW')
  }
  if (item.report === null) throw new WorkflowError(`item "${item.id}" has no report to review yet`, 'WORKFLOW_NOT_REPORTED')
  const current = pendingReview(item)
  if (current !== null) {
    if (current.reviewer !== input.caller) {
      throw new WorkflowError(`the pending review of "${item.id}" belongs to "${current.reviewer}"`, 'WORKFLOW_NOT_REVIEWER')
    }
    return { item, review: current, request: null }
  }
  const request = [...item.reviewRequests].reverse().find((candidate) => {
    if (candidate.status !== 'open') return false
    return candidate.reviewer === null || candidate.reviewer === input.caller
  })
  if (request === undefined) {
    throw new WorkflowError(`item "${item.id}" has no open review invitation for you`, 'WORKFLOW_NO_REVIEW_INVITE')
  }
  request.status = 'accepted'
  request.respondedAt = now
  request.response = 'accepted'
  if (!item.reviewers.includes(input.caller)) item.reviewers.push(input.caller)
  const review = openReview(item, input.caller, { now, actor: input.caller })
  item.updatedAt = now
  appendEvent(state, { at: now, type: 'review/taken', actor: input.caller, detail: `${item.id} review accepted` })
  postChannelMessage(state, { from: input.caller, to: item.owner ?? 'team', kind: 'ack', text: `taking review of ${item.id}`, itemId: item.id, now })
  return { item, review, request }
}

/** Offer one unreported item to a peer. */
export function offerHandoff(state, input) {
  ensureCollaboration(state)
  const now = input.now ?? new Date().toISOString()
  const item = findItem(state, input.itemId)
  if (item.owner !== input.caller) throw new WorkflowError(`only the owner of "${item.id}" may hand it off`, 'WORKFLOW_NOT_OWNER')
  if (item.report !== null) throw new WorkflowError(`item "${item.id}" is already reported; ask a peer for a rework handoff instead`, 'WORKFLOW_ITEM_REPORTED')
  if (input.to === input.caller) throw new WorkflowError('you cannot hand an item to yourself', 'WORKFLOW_SELF_HANDOFF')
  const offered = item.handoffs.find((handoff) => handoff.status === 'offered' && handoff.to === input.to)
  if (offered !== undefined) throw new WorkflowError(`a handoff of "${item.id}" to "${input.to}" is already pending`, 'WORKFLOW_HANDOFF_PENDING')
  const handoff = { by: input.caller, at: now, to: input.to, reason: input.reason === undefined ? null : String(input.reason).slice(0, 2000), status: 'offered', respondedAt: null }
  item.handoffs.push(handoff)
  item.updatedAt = now
  appendEvent(state, { at: now, type: 'handoff/offered', actor: input.caller, detail: `${item.id} → ${input.to}` })
  postChannelMessage(state, { from: input.caller, to: input.to, kind: 'handoff', text: `offering ${item.id} to you${handoff.reason ? `: ${handoff.reason}` : ''}`, itemId: item.id, now })
  return handoff
}

/** Accept or decline a handoff offered to the caller. */
export function respondHandoff(state, input) {
  ensureCollaboration(state)
  const now = input.now ?? new Date().toISOString()
  const item = findItem(state, input.itemId)
  const handoff = [...item.handoffs].reverse().find((candidate) => candidate.status === 'offered' && candidate.to === input.caller)
  if (handoff === undefined) throw new WorkflowError(`item "${item.id}" has no handoff offered to you`, 'WORKFLOW_NO_HANDOFF')
  handoff.respondedAt = now
  handoff.status = input.accept ? 'accepted' : 'declined'
  if (input.accept) {
    const previous = item.owner
    item.owner = input.caller
    item.claim = { by: input.caller, at: now, leaseMinutes: DEFAULT_LEASE_MINUTES, note: `handoff from ${previous ?? 'nobody'}` }
    appendEvent(state, { at: now, type: 'handoff/accepted', actor: input.caller, detail: `${item.id} ← ${previous ?? 'nobody'}` })
  } else {
    appendEvent(state, { at: now, type: 'handoff/declined', actor: input.caller, detail: item.id })
  }
  item.updatedAt = now
  postChannelMessage(state, {
    from: input.caller,
    to: handoff.by,
    kind: 'handoff',
    text: `${input.accept ? 'accepted' : 'declined'} the handoff of ${item.id}${input.reason ? `: ${String(input.reason)}` : ''}`,
    itemId: item.id,
    now,
  })
  return { item, handoff }
}

/** Open one proposal for the affected peers to vote on. */
export function proposeDecision(state, input) {
  ensureCollaboration(state)
  const now = input.now ?? new Date().toISOString()
  if (!PROPOSAL_KINDS.includes(input.kind)) throw new WorkflowError(`proposal kind must be one of ${PROPOSAL_KINDS.join(', ')}`, 'WORKFLOW_BAD_PROPOSAL_KIND')
  const text = String(input.text ?? '').trim()
  if (text.length === 0) throw new WorkflowError('a proposal needs non-empty text', 'WORKFLOW_EMPTY_PROPOSAL')
  const itemId = input.itemId === undefined || input.itemId === null || input.itemId === '' ? null : String(input.itemId)
  if (itemId !== null) findItem(state, itemId)
  if (state.proposals.length >= PROPOSAL_LIMIT) throw new WorkflowError(`this run already holds ${state.proposals.length} proposals`, 'WORKFLOW_PROPOSAL_LIMIT')
  state.proposalSeq += 1
  const proposal = {
    id: `p${state.proposalSeq}`,
    at: now,
    by: input.by,
    kind: input.kind,
    itemId,
    text: text.slice(0, 4000),
    status: 'open',
    votes: [],
    resolvedAt: null,
    resolution: null,
  }
  state.proposals.push(proposal)
  appendEvent(state, { at: now, type: 'proposal/opened', actor: input.by, detail: `${proposal.id} ${input.kind}${itemId === null ? '' : ` on ${itemId}`}` })
  postChannelMessage(state, {
    from: input.by,
    to: 'team',
    kind: 'proposal',
    text: `${proposal.id} (${input.kind}${itemId === null ? '' : ` ${itemId}`}): ${text}`,
    itemId,
    now,
  })
  return proposal
}

/** Record one vote and resolve the proposal when every affected member voted. */
export function voteDecision(state, input) {
  ensureCollaboration(state)
  const now = input.now ?? new Date().toISOString()
  const proposal = findProposal(state, input.proposalId)
  if (proposal.status !== 'open') throw new WorkflowError(`proposal "${proposal.id}" is already ${proposal.status}`, 'WORKFLOW_PROPOSAL_CLOSED')
  const affected = affectedMembersFor(proposal, state, input.members)
  if (!affected.includes(input.by)) {
    throw new WorkflowError(`you are not affected by proposal "${proposal.id}"; only ${affected.join(', ') || 'affected members'} vote`, 'WORKFLOW_NOT_AFFECTED')
  }
  const vote = input.vote === 'no' || input.vote === 'abstain' ? input.vote : 'yes'
  const existing = proposal.votes.find((candidate) => candidate.by === input.by)
  if (existing !== undefined) {
    existing.vote = vote
    existing.comment = input.comment === undefined ? existing.comment : String(input.comment).slice(0, 1000)
    existing.at = now
  } else {
    proposal.votes.push({ by: input.by, at: now, vote, comment: input.comment === undefined ? null : String(input.comment).slice(0, 1000) })
  }
  const tally = tallyProposal(proposal, affected)
  appendEvent(state, { at: now, type: 'proposal/voted', actor: input.by, detail: `${proposal.id} ${vote} (${tally.yes}/${tally.no}/${tally.abstain})` })
  let resolution = null
  if (tally.total >= affected.length) {
    let status = 'rejected'
    let text = ''
    if (tally.yes > tally.no) {
      status = 'accepted'
      text = `accepted by vote (yes ${tally.yes}, no ${tally.no}, abstain ${tally.abstain})`
    } else if (tally.no > tally.yes) {
      status = 'rejected'
      text = `rejected by vote (yes ${tally.yes}, no ${tally.no}, abstain ${tally.abstain})`
    } else {
      status = 'escalated'
      text = `tied vote (yes ${tally.yes}, no ${tally.no}, abstain ${tally.abstain}); escalated to the Lead`
      raiseEscalation(state, {
        kind: 'conflict',
        subject: `Proposal ${proposal.id} ended in a tie`,
        detail: `${proposal.kind}${proposal.itemId === null ? '' : ` on ${proposal.itemId}`}: ${proposal.text.slice(0, 500)}`,
        blocking: BLOCKING_PROPOSAL_KINDS.includes(proposal.kind),
        itemId: proposal.itemId,
        actor: input.by,
        now,
      })
    }
    proposal.status = status
    proposal.resolvedAt = now
    proposal.resolution = text
    resolution = status
    if (status === 'accepted' && proposal.kind === 'dod' && proposal.itemId !== null) {
      const item = findItem(state, proposal.itemId)
      if (!item.definitionOfDone.includes(proposal.text)) item.definitionOfDone.push(proposal.text)
    }
    appendEvent(state, { at: now, type: 'proposal/resolved', actor: 'system', detail: `${proposal.id} ${status}` })
    postChannelMessage(state, { from: 'system', to: 'team', kind: 'status', text: `${proposal.id} ${status}: ${text}`, itemId: proposal.itemId, proposalId: proposal.id, now })
  }
  state.updatedAt = now
  return { proposal, tally, affected, resolution }
}


/**
 * Settle one open or escalated proposal by Lead arbitration.
 *
 * A tied vote escalates the proposal; the Lead must decide so the run can keep
 * moving. The linked escalation is resolved in the same transition.
 * @param state - run state (mutated).
 * @param input - `{ proposalId, outcome: 'accepted'|'rejected', comment, actor, now }`.
 * @returns the settled proposal.
 */
export function settleProposalByLead(state, input) {
  ensureCollaboration(state)
  const now = input.now ?? new Date().toISOString()
  const proposal = findProposal(state, input.proposalId)
  if (proposal.status !== 'open' && proposal.status !== 'escalated') {
    throw new WorkflowError(`proposal "${proposal.id}" is already ${proposal.status}`, 'WORKFLOW_PROPOSAL_CLOSED')
  }
  const outcome = input.outcome === 'rejected' ? 'rejected' : 'accepted'
  proposal.status = outcome
  proposal.resolvedAt = now
  proposal.resolution = `settled by Lead arbitration (${outcome})${input.comment ? `: ${String(input.comment).slice(0, 1000)}` : ''}`
  if (outcome === 'accepted' && proposal.kind === 'dod' && proposal.itemId !== null) {
    const item = findItem(state, proposal.itemId)
    if (!item.definitionOfDone.includes(proposal.text)) item.definitionOfDone.push(proposal.text)
  }
  const escalation = state.escalations.find((entry) => !entry.resolved && (String(entry.subject).includes(proposal.id) || String(entry.detail).includes(proposal.id)))
  if (escalation !== undefined) {
    escalation.resolved = true
    escalation.resolution = proposal.resolution
    escalation.resolvedBy = input.actor
    escalation.resolvedAt = now
    appendEvent(state, { at: now, type: 'escalation/resolved', actor: input.actor, detail: `${escalation.id}: ${proposal.resolution.slice(0, 160)}` })
  }
  appendEvent(state, { at: now, type: 'proposal/resolved', actor: input.actor, detail: `${proposal.id} ${outcome} by arbitration` })
  postChannelMessage(state, { from: input.actor, to: 'team', kind: 'status', text: `${proposal.id} ${outcome} by arbitration${input.comment ? `: ${String(input.comment)}` : ''}`, itemId: proposal.itemId, proposalId: proposal.id, now })
  state.updatedAt = now
  return proposal
}

/** Withdraw one open proposal of the caller. */
export function withdrawProposal(state, input) {
  ensureCollaboration(state)
  const now = input.now ?? new Date().toISOString()
  const proposal = findProposal(state, input.proposalId)
  if (proposal.by !== input.caller) throw new WorkflowError(`only the author of "${proposal.id}" may withdraw it`, 'WORKFLOW_NOT_PROPOSAL_AUTHOR')
  if (proposal.status !== 'open') throw new WorkflowError(`proposal "${proposal.id}" is already ${proposal.status}`, 'WORKFLOW_PROPOSAL_CLOSED')
  proposal.status = 'withdrawn'
  proposal.resolvedAt = now
  proposal.resolution = 'withdrawn by the author'
  appendEvent(state, { at: now, type: 'proposal/withdrawn', actor: input.caller, detail: proposal.id })
  postChannelMessage(state, { from: input.caller, to: 'team', kind: 'status', text: `withdrew ${proposal.id}`, itemId: proposal.itemId, proposalId: proposal.id, now })
  return proposal
}

/** Stable workflow error with a machine-readable code. */
export class WorkflowError extends Error {
  constructor(message, code) {
    super(message)
    this.name = 'WorkflowError'
    this.code = code
  }
}
