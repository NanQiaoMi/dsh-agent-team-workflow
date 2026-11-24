/**
 * Quality gate evaluation, next-action steering, and full/brief status builders.
 */

import {
  ensureCollaboration,
  ITEM_STATUS,
  openBlockingProposals,
  pathInScope,
  planPending,
  RUN_PHASE,
} from './constants.js'
import {
  currentReportSeq,
  isApproving,
  outstandingReviewers,
  pendingReview,
  pendingReviewerNames,
  pendingReviewFor,
  pendingReviews,
  reworkRounds,
  submittedRounds,
  unresolvedFindings,
} from './review.js'
import { affectedMembersFor, settleExpiredProposals } from './collaboration.js'

/**
 * Evaluate every quality gate of a run.
 * @param state - run state.
 * @param input - `{ settings, members, nativeTasks, overrides }`.
 * @returns gate result object.
 */
export function evaluateGates(state, input) {
  settleExpiredProposals(state, { now: input.now, settings: input.settings, members: input.members })
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
    if (item.evidenceOptional !== true && item.archived !== true) {
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
    const resolvedDepth = item.resolvedReview?.depth ?? (item.reviewDepth && item.reviewDepth !== 'auto' ? item.reviewDepth : null)
    if (resolvedDepth === 'deep' && item.definitionOfDone.length > 0 && item.archived !== true) {
      const missingDodApprovals = submitted.filter(
        (review) =>
          (Number.isInteger(review.reportSeq) ? review.reportSeq : 0) === currentReportSeq(item) &&
          isApproving(review.verdict) &&
          (!Array.isArray(review.dodChecks) || review.dodChecks.length === 0),
      )
      if (missingDodApprovals.length > 0) {
        const msg = `deep review round ${missingDodApprovals.map((r) => r.round).join(', ')} omitted explicit dod_checks`
        if (input.settings?.strictReviewRubric === true) failures.push(msg)
        else warnings.push(msg)
      }
    }
    for (const warning of item.report?.sequenceWarnings ?? []) warnings.push(warning)

    const outstanding = outstandingReviewers(item)
    if (item.needsReview !== false && outstanding.length > 0) {
      failures.push(`review not approved by: ${outstanding.join(', ')}`)
    }
    if (item.needsReview !== false && item.reviewers.length === 0) {
      failures.push('no peer reviewer was ever assigned; the owner must invite one with team_flow_work {action:"request_review"}')
    }
    if (planPending(state, item)) failures.push('plan-first item has no approved plan')
    const contractVal = item.report?.contractValidation ?? item.handoffPacket?.validation ?? null
    if (contractVal && contractVal.ok === false) {
      const detail = contractVal.error || `missing required methods: [${(contractVal.missing || []).join(', ')}]`
      if (input.settings.strictContracts === true) {
        failures.push(`contract "${contractVal.contractId}" violation: ${detail}`)
      } else {
        warnings.push(`contract "${contractVal.contractId}" warning: ${detail}`)
      }
    }
    if (input.settings.gitRequireVerify === true) {
      const git = item.git ?? null
      if (git === null || git.verify === null || git.verify === undefined) failures.push('git verification missing (gitRequireVerify is on)')
      else if (git.verify.ok !== true) failures.push(`git verification failed (${git.verify.results?.filter((entry) => entry.exitCode !== 0).map((entry) => entry.command).join(', ') || 'commands not green'})`)
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
  settleExpiredProposals(state, { now: input.now, settings: input.settings, members: input.members })
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
    const stuckReviews = state.items.filter((item) => item.status === ITEM_STATUS.IN_REVIEW && pendingReviews(item).length > 0)
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
    const pendingPlans = state.items.filter((item) => item.plan !== null && item.plan.status === 'pending')
    if (pendingPlans.length > 0) {
      actions.push(`Plans awaiting approval: ${pendingPlans.map((item) => item.id).join(', ')}. Approve with team_flow_plan_approval {action:"approve", item_id:"<id>"} or reject with a reason.`)
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
    if (planPending(state, item)) {
      const plan = item.plan
      if (plan !== null && plan.status === 'pending') {
        actions.push(`${item.id}: your plan is waiting for approval; do not start implementing until it is approved.`)
      } else {
        actions.push(`${item.id} is plan-first: submit a plan with team_flow_plan_approval {action:"submit", item_id:"${item.id}", plan:{steps:[...]}} and wait for approval before doing the work.`)
      }
      continue
    }
    if (item.status === ITEM_STATUS.PENDING || item.status === ITEM_STATUS.RUNNING) {
      actions.push(`Do ${item.id} ("${item.subject}") inside ${item.writeScopes.length > 0 ? item.writeScopes.join(', ') : 'no declared scope'}; then call team_flow_report with files and verification commands.`)
    } else if (item.status === ITEM_STATUS.CHANGES_REQUESTED) {
      actions.push(`Read the findings for ${item.id} in team_flow_status, fix them, then call team_flow_review_respond with one response per finding id.`)
    } else if (item.status === ITEM_STATUS.ESCALATED) {
      actions.push(`${item.id} is waiting on the Lead's arbitration; do not change it unless the Lead messages you.`)
    }
  }
  const assigned = state.items.filter((item) => pendingReviewFor(item, me) !== null)
  for (const item of assigned) {
    const review = pendingReviewFor(item, me)
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
  settleExpiredProposals(state, { now: input.now, settings: input.settings, members: input.members })
  const view = input.view === 'brief' ? 'brief' : 'full'
  const sinceRev = Number.isInteger(input.sinceRev) ? input.sinceRev : null
  if (view === 'brief' && sinceRev !== null && state.rev === sinceRev) {
    // Fast path for "anything new since my last read?": a few dozen bytes
    // instead of the whole board. next_actions stays available because it is
    // the authoritative assignment, not free-form history.
    return {
      workflow_version: state.workflowVersion,
      run_id: state.runId,
      rev: state.rev,
      phase: state.phase,
      unchanged: true,
      next_actions: nextActions(state, { ...input, me: input.me.name }),
    }
  }
  if (view === 'brief') return buildBriefStatus(state, input, { sinceRev })
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
      plan: item.plan ?? null,
      git: item.git ?? null,
      pending_reviewer: pending?.reviewer ?? item.pendingReviewer ?? null,
      pending_reviewers: pendingReviewerNames(item),
      review_depth: item.resolvedReview?.depth ?? item.reviewDepth ?? 'auto',
      review_profile: item.resolvedReview?.profile ?? item.reviewProfile ?? 'auto',
      review_requests: item.reviewRequests ?? [],
      handoffs: item.handoffs ?? [],
      open_proposals: openBlockingProposals(state, item.id).length,
      ...(input.detailItemId === item.id
        ? {
            // Detailed records get their own keys: overwriting the compact
            // `reviews` summary with the raw array would break every reader
            // that asks for the counters. Strings are bounded so one long
            // report cannot flood a model context with megabytes.
            report: trimReport(item.report),
            review_records: trimReviews(item.reviews),
            handoff_packet: item.handoffPacket ?? null,
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
    preset: state.preset ?? null,
    rev: state.rev,
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
    git: state.git ?? null,
    usage: state.usage ?? null,
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

/** Bound one string for a model-facing record. */
function clipText(value, max) {
  if (value === null || value === undefined) return null
  const text = String(value)
  return text.length > max ? `${text.slice(0, max)}…` : text
}

/** @returns a bounded copy of one work report (shape preserved). */
export function trimReport(report) {
  if (report === null || report === undefined || typeof report !== 'object') return report ?? null
  return {
    ...report,
    summary: clipText(report.summary, 1200),
    evidence: Array.isArray(report.evidence) ? report.evidence.slice(0, 8).map((entry) => clipText(entry, 400)) : [],
    openQuestions: Array.isArray(report.openQuestions) ? report.openQuestions.slice(0, 5).map((entry) => clipText(entry, 300)) : [],
    risks: Array.isArray(report.risks) ? report.risks.slice(0, 5).map((entry) => clipText(entry, 300)) : [],
    deviation: clipText(report.deviation, 800),
    commands: Array.isArray(report.commands)
      ? report.commands.map((command) => ({ ...command, command: clipText(command.command, 300), note: clipText(command.note, 200) }))
      : [],
  }
}

/** @returns bounded review records (all rounds kept, long prose clipped). */
export function trimReviews(reviews) {
  if (!Array.isArray(reviews)) return []
  return reviews.map((review) => ({
    ...review,
    summary: clipText(review.summary, 800),
    findings: Array.isArray(review.findings)
      ? review.findings.map((finding) => ({ ...finding, claim: clipText(finding.claim, 400), suggestion: clipText(finding.suggestion, 300) }))
      : [],
    evidenceChecked: Array.isArray(review.evidenceChecked) ? review.evidenceChecked.slice(0, 6).map((entry) => clipText(entry, 300)) : [],
  }))
}

/**
 * Compact status projection (`view: "brief"`).
 *
 * Keeps the fields a member needs to act on its next step — ids, status,
 * reviewer/round counters, pending findings, scope and next_actions — and
 * drops mission prose, settings, full reports and the channel backlog. The
 * mission block is returned only on the first read (no/since_rev=0), and a
 * repeated read with the same revision collapses to a ~50-byte `unchanged`
 * answer before this function is even called.
 */
export function buildBriefStatus(state, input, options = {}) {
  settleExpiredProposals(state, { now: input.now, settings: input.settings, members: input.members })
  const me = input.me
  const sinceRev = Number.isInteger(options.sinceRev) ? options.sinceRev : null
  const firstRead = sinceRev === null || sinceRev <= 0
  const items = state.items.map((item) => {
    const pending = pendingReview(item)
    const latest = item.reviews.filter((review) => review.status !== 'pending').at(-1) ?? null
    const openFindings = unresolvedFindings(item)
    return {
      id: item.id,
      subject: item.subject,
      owner: item.owner,
      role: item.role,
      status: item.status,
      task_id: item.taskId,
      reviewers: item.reviewers,
      write_scopes: item.writeScopes,
      blocked_by: item.blockedBy,
      reported: item.report !== null,
      reassignment: item.assignment ?? 'lead',
      rework_rounds: reworkRounds(item),
      submitted_rounds: submittedRounds(item),
      max_rounds: input.settings.maxReviewRounds,
      pending_reviewer: pending?.reviewer ?? item.pendingReviewer ?? null,
      verdicts: item.reviews
        .filter((review) => review.status === 'submitted')
        .map((review) => ({ reviewer: review.reviewer, verdict: review.verdict, round: review.round })),
      latest_review_summary: clipText(latest?.summary ?? null, 240),
      open_findings: openFindings.length,
      // Rework needs the exact findings; only include them when they matter.
      findings:
        item.status === ITEM_STATUS.CHANGES_REQUESTED || item.status === ITEM_STATUS.ESCALATED
          ? openFindings.slice(0, 6).map((finding) => ({
              id: finding.id,
              severity: finding.severity,
              file: finding.file ?? null,
              line: finding.line ?? null,
              claim: clipText(finding.claim, 300),
            }))
          : undefined,
      report_summary: item.report === null ? null : clipText(item.report.summary, 320),
      plan_status: item.plan === null || item.plan === undefined ? null : item.plan.status,
      git_worktree: item.git?.worktreePath ?? null,
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
  const summary = collaborationSummary(state, { me: me.name, role: input.role, members: input.members ?? [] })
  const usage = state.usage ?? null
  return {
    workflow_version: state.workflowVersion,
    run_id: state.runId,
    preset: state.preset ?? null,
    rev: state.rev,
    phase: state.phase,
    ...(firstRead
      ? { objective: state.objective, acceptance_criteria: state.acceptanceCriteria, constraints: state.constraints }
      : {}),
    me: { name: me.name, role: input.role },
    counts,
    items,
    escalations: state.escalations.slice(-8).map((escalation) => ({
      id: escalation.id,
      kind: escalation.kind,
      subject: clipText(escalation.subject, 160),
      blocking: escalation.blocking,
      item_id: escalation.itemId,
      resolved: escalation.resolved,
    })),
    ...(usage === null || usage === undefined
      ? {}
      : { usage_totals: usage.totals ?? null }),
    collaboration: {
      open_queue: summary.open_queue,
      review_invites: summary.review_invites,
      handoffs_to_me: summary.handoffs_to_me,
      proposals_awaiting_vote: summary.proposals_awaiting_vote,
      questions_to_me: summary.questions_to_me,
      channel_tail: state.channel.slice(-3).map((message) => ({
        id: message.id,
        from: message.from,
        to: message.to,
        kind: message.kind,
        text: clipText(message.text, 160),
        item_id: message.refs?.itemId ?? null,
      })),
    },
    next_actions: nextActions(state, { ...input, me: me.name }),
  }
}
