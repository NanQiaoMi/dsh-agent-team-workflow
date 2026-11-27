/**
 * Peer collaboration layer: channel messages, claims, peer review invites,
 * handoffs, proposals/voting, deadline settlement, and graceful shutdown.
 */

import {
  appendEvent,
  BLOCKING_PROPOSAL_KINDS,
  CHANNEL_KINDS,
  CHANNEL_LIMIT,
  DEFAULT_LEASE_MINUTES,
  DEFAULT_PROPOSAL_TIMEOUT_MINUTES,
  ensureCollaboration,
  findItem,
  findProposal,
  ITEM_STATUS,
  PROPOSAL_KINDS,
  PROPOSAL_LIMIT,
  PROPOSAL_TIMEOUT_MAX,
  PROPOSAL_TIMEOUT_MIN,
  STOP_STATUS,
  WorkflowError,
} from './constants.js'
import { openReview, pendingReview, raiseEscalation } from './review.js'

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

/** @returns the smallest vote count that is a majority for one affected set. */
export function proposalQuorumFor(affected) {
  return Math.max(1, Math.ceil(affected.length / 2))
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
  const configuredTimeout = Number.isInteger(input.settings?.proposalTimeoutMinutes) ? input.settings.proposalTimeoutMinutes : DEFAULT_PROPOSAL_TIMEOUT_MINUTES
  const requestedTimeout = Number.isInteger(input.timeoutMinutes) && input.timeoutMinutes > 0 ? input.timeoutMinutes : null
  const timeoutMinutes = requestedTimeout === null ? configuredTimeout : Math.min(Math.max(requestedTimeout, PROPOSAL_TIMEOUT_MIN), PROPOSAL_TIMEOUT_MAX)
  const affected = affectedMembersFor({ itemId }, state, input.members ?? [])
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
    deadline: timeoutMinutes > 0 ? new Date(Date.parse(now) + timeoutMinutes * 60_000).toISOString() : null,
    autoResolved: false,
    quorum: proposalQuorumFor(affected),
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
  settleExpiredProposals(state, { now, settings: input.settings, members: input.members })
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

/**
 * Ask one member to stop. The Leader only records the request here; the tool
 * layer delivers it and the transport may interrupt after a rejection.
 * @returns the stop record.
 */
export function requestStop(state, input) {
  ensureCollaboration(state)
  const now = input.now ?? new Date().toISOString()
  const target = String(input.target ?? '').trim()
  if (target.length === 0 || target === 'lead') throw new WorkflowError('a stop request needs a teammate name (not the Lead)', 'WORKFLOW_STOP_TARGET_REQUIRED')
  const existing = state.stops.find((stop) => stop.target === target && (stop.status === STOP_STATUS.pending || stop.status === STOP_STATUS.accepted))
  if (existing !== undefined) throw new WorkflowError(`a stop request for "${target}" is already ${existing.status}`, 'WORKFLOW_STOP_EXISTS')
  const mode = input.mode === 'interrupt' ? 'interrupt' : 'graceful'
  state.stopSeq += 1
  const record = {
    id: `stop${state.stopSeq}`,
    at: now,
    by: input.by,
    target,
    mode,
    reason: typeof input.reason === 'string' && input.reason.trim().length > 0 ? input.reason.trim().slice(0, 1000) : null,
    status: mode === 'interrupt' ? STOP_STATUS.interrupted : STOP_STATUS.pending,
    decidedAt: mode === 'interrupt' ? now : null,
    decisionReason: null,
  }
  state.stops.push(record)
  appendEvent(state, { at: now, type: `stop/${record.status}`, actor: input.by, detail: `${target} (${mode})` })
  postChannelMessage(state, { from: input.by, to: target, kind: 'status', text: `[SHUTDOWN] ${mode === 'interrupt' ? 'interrupted' : 'requested'} ${target}${record.reason === null ? '' : `: ${record.reason}`}`, now })
  return record
}

/** Answer a pending stop request addressed to the caller. */
export function respondStop(state, input) {
  ensureCollaboration(state)
  const now = input.now ?? new Date().toISOString()
  const by = String(input.by ?? '')
  const record = state.stops.find((stop) => stop.target === by && stop.status === STOP_STATUS.pending)
  if (record === undefined) throw new WorkflowError(`no pending stop request for "${by}"`, 'WORKFLOW_STOP_NONE')
  record.status = input.accept === true ? STOP_STATUS.accepted : STOP_STATUS.rejected
  record.decidedAt = now
  record.decisionReason = typeof input.reason === 'string' && input.reason.trim().length > 0 ? input.reason.trim().slice(0, 1000) : null
  appendEvent(state, { at: now, type: `stop/${record.status}`, actor: by, detail: record.id })
  postChannelMessage(state, { from: by, to: 'lead', kind: 'status', text: `[SHUTDOWN] ${record.status} ${record.id}${record.decisionReason === null ? '' : `: ${record.decisionReason}`}`, now })
  return record
}

/** Escalate one accepted/pending stop to an interrupt after the member failed to stop. */
export function escalateStopToInterrupt(state, input) {
  ensureCollaboration(state)
  const now = input.now ?? new Date().toISOString()
  const record = state.stops.find((stop) => stop.id === input.stopId)
  if (record === undefined) throw new WorkflowError(`unknown stop request "${input.stopId}"`, 'WORKFLOW_STOP_UNKNOWN')
  if (record.status === STOP_STATUS.interrupted) return record
  record.status = STOP_STATUS.interrupted
  record.mode = 'interrupt'
  record.decidedAt = now
  appendEvent(state, { at: now, type: 'stop/interrupted', actor: input.by, detail: record.target })
  return record
}

/** @returns the pending stop record for one member, or null. */
export function pendingStopFor(state, name) {
  ensureCollaboration(state)
  return state.stops.find((stop) => stop.target === name && stop.status === STOP_STATUS.pending) ?? null
}

/**
 * Settle every proposal whose deadline passed.
 *
 * Pure, lazy and deterministic: callers pass the current time, so there is no
 * timer to leak and a replay of the board reaches the same state. A proposal
 * passes when its side is known and at least a majority of affected members
 * voted; ties and missed quorums escalate instead of silently passing.
 * @param state - run state (mutated).
 * @param input - `{ now, settings, members }`.
 * @returns settled proposals.
 */
export function settleExpiredProposals(state, input = {}) {
  ensureCollaboration(state)
  const now = input.now ?? new Date().toISOString()
  const settings = input.settings ?? state.settings ?? {}
  const configured = Number.isInteger(settings.proposalTimeoutMinutes) ? settings.proposalTimeoutMinutes : DEFAULT_PROPOSAL_TIMEOUT_MINUTES
  if (configured <= 0) return []
  const nowMs = Date.parse(now)
  const settled = []
  for (const proposal of state.proposals) {
    if (proposal.status !== 'open') continue
    if (proposal.deadline === null || proposal.deadline === undefined) continue
    const deadlineMs = Date.parse(proposal.deadline)
    if (!Number.isFinite(deadlineMs) || deadlineMs > nowMs) continue
    const affected = affectedMembersFor(proposal, state, input.members ?? [])
    const tally = tallyProposal(proposal, affected)
    const quorum = Number.isInteger(proposal.quorum) ? proposal.quorum : proposalQuorumFor(affected)
    proposal.autoResolved = true
    proposal.resolvedAt = now
    if (tally.total < quorum) {
      proposal.status = 'escalated'
      proposal.resolution = `deadline passed without quorum (${tally.total}/${quorum} votes); escalated to the Lead`
      if (BLOCKING_PROPOSAL_KINDS.includes(proposal.kind)) {
        raiseEscalation(state, {
          kind: 'decision',
          subject: `Proposal ${proposal.id} expired without quorum`,
          detail: `${proposal.kind}${proposal.itemId === null ? '' : ` on ${proposal.itemId}`}: ${proposal.text.slice(0, 500)}; votes yes=${tally.yes} no=${tally.no} abstain=${tally.abstain}, quorum ${quorum}`,
          blocking: true,
          itemId: proposal.itemId,
          actor: 'system',
          now,
        })
      }
    } else if (tally.yes > tally.no) {
      proposal.status = 'accepted'
      proposal.resolution = `auto-accepted after deadline (yes ${tally.yes}, no ${tally.no}, abstain ${tally.abstain}; quorum ${quorum})`
      if (proposal.kind === 'dod' && proposal.itemId !== null) {
        const item = findItem(state, proposal.itemId)
        if (!item.definitionOfDone.includes(proposal.text)) item.definitionOfDone.push(proposal.text)
      }
    } else if (tally.no > tally.yes) {
      proposal.status = 'rejected'
      proposal.resolution = `auto-rejected after deadline (yes ${tally.yes}, no ${tally.no}, abstain ${tally.abstain}; quorum ${quorum})`
    } else {
      proposal.status = 'escalated'
      proposal.resolution = `tied vote at deadline (yes ${tally.yes}, no ${tally.no}); escalated to the Lead`
      if (BLOCKING_PROPOSAL_KINDS.includes(proposal.kind)) {
        raiseEscalation(state, {
          kind: 'conflict',
          subject: `Proposal ${proposal.id} tied at its deadline`,
          detail: `${proposal.kind}${proposal.itemId === null ? '' : ` on ${proposal.itemId}`}: ${proposal.text.slice(0, 500)}`,
          blocking: true,
          itemId: proposal.itemId,
          actor: 'system',
          now,
        })
      }
    }
    appendEvent(state, { at: now, type: 'proposal/auto-resolved', actor: 'system', detail: `${proposal.id} ${proposal.status}` })
    postChannelMessage(state, { from: 'system', to: 'team', kind: 'status', text: `${proposal.id} ${proposal.status}: ${proposal.resolution}`, itemId: proposal.itemId, proposalId: proposal.id, now })
    settled.push(proposal)
  }
  if (settled.length > 0) state.updatedAt = now
  return settled
}
