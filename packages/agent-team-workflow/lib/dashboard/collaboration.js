/**
 * Peer collaboration, escalations, audit events, and Team roster normalizers
 * for the dashboard snapshot.
 */

import {
  BLOCKING_PROPOSAL_KINDS,
  clip,
  integerOf,
  isoOf,
  isRecord,
  MAX_CHANNEL,
  MAX_CHANNEL_TEXT,
  MAX_EDGES,
  MAX_ESCALATIONS,
  MAX_EVENT_DETAIL,
  MAX_EVENTS,
  MAX_HANDOFFS,
  MAX_MEMBERS,
  MAX_PROPOSALS,
  MAX_TASKS,
  MAX_THREAD,
  MAX_VOTES,
  pendingReviewerOf,
  recordList,
  sortByAt,
  STOP_STATUSES,
  tailEvents,
  textList,
  textOf,
} from './shared.js'

/**
 * Pass through the escalation log (oldest first), bounded and clipped.
 * @param escalations - `state.escalations`.
 * @param warnings - diagnostics array to append truncation warnings to.
 * @returns array of escalation records.
 */
export function buildEscalations(escalations, warnings) {
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
export function buildEvents(events, warnings) {
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
export function buildTeam(team, warnings) {
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
 * Normalize one channel message and flatten its refs.
 * @param message - blackboard channel entry.
 * @returns `{ id, at, from, to, kind, text, itemId, findingId, proposalId, replyTo }`.
 */
export function buildChannelEntry(message) {
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
export function buildClaim(claim) {
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
export function buildReviewRequest(request) {
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
export function buildItemHandoff(handoff) {
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
export function countOpenProposals(proposals) {
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
export function buildCollaboration(state, context) {
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
