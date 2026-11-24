/**
 * Report submission, mutual review lifecycle, and escalation arbitration.
 */

import { validateReviewSubmission } from '../review-policy.js'
import {
  appendEvent,
  findItem,
  ITEM_STATUS,
  openBlockingProposals,
  planPending,
  RUN_PHASE,
  WorkflowError,
} from './constants.js'

/** @returns a fresh escalation id for one run. */
function nextEscalationId(state) {
  return `esc-${state.escalations.length + 1}`
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

/** @returns all currently pending reviews of one item. */
export function pendingReviews(item) {
  return (Array.isArray(item?.reviews) ? item.reviews : []).filter((review) => review.status === 'pending')
}

/** @returns the currently pending review for one specific reviewer, or `null`. */
export function pendingReviewFor(item, reviewer) {
  return (Array.isArray(item?.reviews) ? item.reviews : []).find((review) => review.status === 'pending' && review.reviewer === reviewer) ?? null
}

/** @returns unique names of reviewers with a currently pending review on one item. */
export function pendingReviewerNames(item) {
  return [...new Set(pendingReviews(item).map((review) => review.reviewer).filter(Boolean))]
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
  if (item.archived === true) return true
  if (item.reviewers.length === 0) return false
  return item.reviewers.every((reviewer) => {
    const latest = lastReviewOf(item, reviewer)
    return latest !== null && isApproving(latest.verdict)
  })
}

/** @returns the reviewers of one item that have not approved yet. */
export function outstandingReviewers(item) {
  if (item.needsReview === false || item.archived === true) return []
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
  if (item.archived === true) return []
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
  item.pendingReviewer = pendingReview(item)?.reviewer ?? reviewer
  item.pendingReviewers = pendingReviewerNames(item)
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
  if (planPending(state, item)) {
    throw new WorkflowError(
      `item "${item.id}" is plan-first: submit a plan with team_flow_plan_approval and get it approved before reporting`,
      'WORKFLOW_PLAN_REQUIRED',
    )
  }
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
  if (input.handoffPacket !== undefined) {
    item.handoffPacket = input.handoffPacket
  }
  item.report = {
    summary: report.summary,
    files: report.files,
    commands: report.commands,
    evidence: report.evidence,
    openQuestions: report.openQuestions,
    risks: report.risks,
    deviation: report.deviation ?? null,
    ...(report.hostVerified ? { hostVerified: report.hostVerified } : {}),
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

  const opened = []
  if (item.needsReview === false) {
    item.status = ITEM_STATUS.APPROVED
    item.approvedAt = now
    item.approvedBy = 'self'
    item.pendingReviewer = null
    item.pendingReviewers = []
  } else {
    // A new report invalidates earlier verdicts by construction (they bind to
    // the previous reportSeq), so every declared reviewer must sign this
    // version. There is deliberately no "already approved" shortcut here.
    const parallel = input.settings?.parallelReviews !== false
    const remaining = outstandingReviewers(item)
    const pool = remaining.length > 0 ? remaining : item.reviewers
    const targets = pool.length === 0 ? [] : (parallel ? [...pool] : [pool[0]])
    if (targets.length === 0) {
      // Open-queue item without a declared reviewer: the author must invite a
      // peer, so the item waits in review with no pending review yet. The nudge
      // stays in next_actions instead of the channel: a channel post here used
      // to trigger a storm of "already handled" replies once the owner invited
      // a reviewer seconds later (observed in run-20261102052850-il6f).
      item.status = ITEM_STATUS.IN_REVIEW
      item.pendingReviewer = null
      item.pendingReviewers = []
    } else {
      for (const targetReviewer of targets) {
        opened.push(openReview(item, targetReviewer, { now, actor: input.caller }))
      }
      item.pendingReviewer = opened[0].reviewer
      item.pendingReviewers = pendingReviewerNames(item)
    }
  }
  state.phase = state.items.every((candidate) => candidate.status === ITEM_STATUS.APPROVED) ? RUN_PHASE.CONVERGED : RUN_PHASE.REVIEWING
  state.updatedAt = now
  return {
    item,
    review: opened[0] ?? null,
    reviews: opened,
    nextReviewer: opened[0]?.reviewer ?? null,
    nextReviewers: opened.map((entry) => entry.reviewer),
  }
}

/**
 * Apply one reviewer verdict.
 * @param state - run state (mutated).
 * @param input - `{ itemId, reviewer, verdict, summary, findings, evidenceChecked, dodChecks?, settings?, now }`.
 * @returns `{ item, review, nextReviewer, nextReview, nextReviewOpened }`.
 */
export function applyReviewSubmit(state, input) {
  const item = findItem(state, input.itemId)
  const review = pendingReviewFor(item, input.reviewer) ?? pendingReview(item)
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
  const effectiveDepth = item.resolvedReview?.depth ?? (item.reviewDepth && item.reviewDepth !== 'auto' ? item.reviewDepth : 'standard')
  const effectiveProfile = item.resolvedReview?.profile ?? (item.reviewProfile && item.reviewProfile !== 'auto' ? item.reviewProfile : 'code')
  const dodChecks = Array.isArray(input.dodChecks) ? input.dodChecks : []
  const rubricCheck = validateReviewSubmission({
    item,
    reviewDepth: effectiveDepth,
    verdict: input.verdict,
    findings,
    dodChecks,
    settings: input.settings ?? state.settings ?? {},
  })
  if (!rubricCheck.ok) {
    throw new WorkflowError(rubricCheck.message, rubricCheck.code)
  }
  review.status = 'submitted'
  review.verdict = input.verdict
  review.summary = input.summary
  review.findings = findings
  review.evidenceChecked = input.evidenceChecked
  review.dodChecks = dodChecks
  review.reviewDepth = effectiveDepth
  review.reviewProfile = effectiveProfile
  review.reviewedSha = input.reviewedSha ?? item.git?.sha ?? null
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
  let nextReviewOpened = false
  if (isApproving(input.verdict)) {
    if (allReviewersApproved(item)) {
      item.status = ITEM_STATUS.APPROVED
      item.approvedAt = input.now
      item.approvedBy = 'review'
    } else if (unresolvedFindings(item).length > 0) {
      item.status = ITEM_STATUS.CHANGES_REQUESTED
    } else {
      item.status = ITEM_STATUS.IN_REVIEW
      nextReviewer = outstandingReviewers(item)[0] ?? null
      if (nextReviewer !== null) {
        const existingPending = pendingReviewFor(item, nextReviewer)
        if (existingPending !== null) {
          nextReview = existingPending
        } else {
          nextReview = openReview(item, nextReviewer, { now: input.now, actor: input.reviewer })
          nextReviewOpened = true
        }
      }
    }
  } else {
    item.status = ITEM_STATUS.CHANGES_REQUESTED
  }
  state.phase = state.items.every((candidate) => candidate.status === ITEM_STATUS.APPROVED) ? RUN_PHASE.CONVERGED : RUN_PHASE.REVIEWING
  item.pendingReviewer = pendingReview(item)?.reviewer ?? null
  item.pendingReviewers = pendingReviewerNames(item)
  state.updatedAt = input.now
  return { item, review, nextReview, nextReviewer, nextReviewOpened }
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

  const seq = currentReportSeq(item)
  const currentReviews = item.reviews.filter(
    (review) => review.status === 'submitted' && (Number.isInteger(review.reportSeq) ? review.reportSeq : 0) === seq,
  )
  const rebuttedBlocker = currentReviews.some((review) =>
    review.findings.some((finding) => finding.severity === 'blocker' && finding.resolution?.state === 'rebut'),
  )
  const lastReview = currentReviews.at(-1) ?? item.reviews.filter((review) => review.status === 'submitted').at(-1)
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
    return { item, nextReview: null, nextReviewer: null, nextReviewers: [], escalated: true }
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
    return { item, nextReview: null, nextReviewer: null, nextReviewers: [], escalated: true }
  }

  const nonApprovingReviewers = [
    ...new Set(
      currentReviews
        .filter((review) => !isApproving(review.verdict))
        .map((review) => review.reviewer)
        .filter(Boolean),
    ),
  ]
  const fallbackReviewer = lastReview?.reviewer ?? outstandingReviewers(item)[0] ?? item.reviewers[0]
  const candidateReviewers = nonApprovingReviewers.length > 0 ? nonApprovingReviewers : (fallbackReviewer ? [fallbackReviewer] : [])
  const parallel = input.settings?.parallelReviews !== false
  const targetReviewers = parallel ? candidateReviewers : candidateReviewers.slice(0, 1)

  const opened = []
  for (const reviewer of targetReviewers) {
    if (pendingReviewFor(item, reviewer) === null) {
      opened.push(openReview(item, reviewer, { now: input.now, actor: input.author }))
    }
  }
  item.status = ITEM_STATUS.IN_REVIEW
  item.pendingReviewer = pendingReview(item)?.reviewer ?? null
  item.pendingReviewers = pendingReviewerNames(item)
  appendEvent(state, { at: input.now, type: 'item/responded', actor: input.author, detail: `${item.id}: responded to ${input.responses.length} finding(s)` })
  state.updatedAt = input.now
  const firstNext = opened[0] ?? pendingReview(item)
  return {
    item,
    nextReview: firstNext,
    nextReviewer: firstNext?.reviewer ?? null,
    nextReviewers: opened.map((entry) => entry.reviewer),
    escalated: false,
  }
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
