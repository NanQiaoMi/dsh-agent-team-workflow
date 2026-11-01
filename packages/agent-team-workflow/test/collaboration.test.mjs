/**
 * Unit tests for the workflow v2 peer-collaboration layer.
 *
 * Covers the blackboard primitives that let members cooperate directly:
 * channel messages, open-queue claims, peer review invitations, handoffs,
 * proposals/votes, and the gates that keep collaboration from silently
 * bypassing verification.
 *
 * Run: node --test test/
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import * as W from '../lib/workflow.js'
import { renderQueueBrief } from '../lib/protocol.js'

const SETTINGS = Object.freeze({
  maxReviewRounds: 2,
  maxParallelItems: 4,
  workerContext: 'fresh',
  strictScopes: false,
  allowScopeOverlap: false,
  requireReviewEvidence: true,
})

const NOW = '2026-11-01T00:00:00.000Z'
const LATER = '2026-11-01T00:10:00.000Z'

/** The Team roster used when affected sets are computed. */
const MEMBERS = [{ name: 'lead', role: 'lead' }, { name: 'impl', role: 'teammate' }, { name: 'impl2', role: 'teammate' }, { name: 'rev', role: 'teammate' }]

/** Build one normalized item (v1 shape: collaboration defaults are filled on write). */
function item(overrides = {}) {
  return {
    id: 'W1',
    subject: 'Implement the core module',
    owner: 'impl',
    role: 'implementer',
    writeScopes: ['src/core/'],
    blockedBy: [],
    definitionOfDone: ['module exports run()', 'unit tests pass'],
    needsReview: true,
    reviewers: ['rev'],
    evidenceOptional: false,
    status: W.ITEM_STATUS.PENDING,
    taskId: 'task-1',
    report: null,
    reviews: [],
    reviewSeq: 0,
    overrideReason: null,
    createdAt: NOW,
    updatedAt: NOW,
    reportedAt: null,
    approvedAt: null,
    approvedBy: null,
    ...overrides,
  }
}

function run(items) {
  return W.createRun({
    workflowVersion: W.WORKFLOW_VERSION,
    runId: 'run-collab-1',
    teamId: 'session-lead',
    objective: 'Ship a verified module together',
    acceptanceCriteria: ['module is importable'],
    constraints: ['no new dependencies'],
    settings: SETTINGS,
    items,
    actor: 'lead',
    now: NOW,
    artifacts: { statePath: '/tmp/state.json', reportPath: null, root: '/tmp' },
  })
}

function report(overrides = {}) {
  return {
    summary: 'Implemented run() and added unit tests.',
    files: ['src/core/run.js'],
    commands: [{ command: 'node --test test/core.test.mjs', exitCode: 0, note: 'all pass' }],
    evidence: ['test/core.test.mjs: 4 passing'],
    openQuestions: [],
    risks: [],
    deviation: null,
    ...overrides,
  }
}

/** Report then invite the default reviewer, returning the mutated state. */
function reportedWithReview(state, itemId = 'W1') {
  W.applyReport(state, { itemId, caller: 'impl', report: report(), now: NOW, settings: SETTINGS })
  return state
}

test('v2 run starts with empty collaboration structures and v1 boards upgrade on demand', () => {
  const state = run([item()])
  assert.equal(W.WORKFLOW_VERSION, 2)
  assert.deepEqual(state.channel, [])
  assert.deepEqual(state.proposals, [])
  assert.equal(state.schemaVersion, 2)
  const itemState = state.items[0]
  assert.equal(itemState.assignment, 'lead')
  assert.equal(itemState.claim, null)
  assert.deepEqual(itemState.reviewRequests, [])
  assert.deepEqual(itemState.handoffs, [])

  // A board written by v1 has none of the collaboration fields.
  const legacy = { ...JSON.parse(JSON.stringify(state)) }
  delete legacy.channel
  delete legacy.proposals
  delete legacy.messageSeq
  delete legacy.proposalSeq
  legacy.schemaVersion = 1
  legacy.workflowVersion = 1
  for (const entry of legacy.items) {
    delete entry.assignment
    delete entry.claim
    delete entry.reviewRequests
    delete entry.handoffs
  }
  W.upgradeState(legacy)
  assert.deepEqual(legacy.channel, [])
  assert.deepEqual(legacy.proposals, [])
  assert.equal(legacy.items[0].assignment, 'lead')
  assert.equal(legacy.workflowVersion, 2)
  // v1 behavior is unchanged: a v1 board still validates and reports.
  const status = W.buildStatus(legacy, { me: { name: 'lead', role: 'lead' }, role: 'lead', settings: SETTINGS, members: [], artifacts: {} })
  assert.equal(status.workflow_version, 2)
  assert.equal(status.collaboration.open_queue.length, 0)
})

test('channel messages are recorded, capped, and keep their refs', () => {
  const state = run([item()])
  const first = W.postChannelMessage(state, { from: 'impl', to: 'team', kind: 'question', text: 'Which module path do you expect?', itemId: 'W1', now: NOW })
  assert.equal(first.id, 'm1')
  assert.deepEqual(first.refs, { itemId: 'W1', findingId: null, proposalId: null })
  assert.equal(first.to, 'team')
  assert.throws(() => W.postChannelMessage(state, { from: 'impl', text: '   ' }), /non-empty text/)

  const answer = W.postChannelMessage(state, { from: 'rev', to: 'impl', kind: 'answer', text: 'src/core/run.js', replyTo: first.id, now: LATER })
  assert.equal(answer.replyTo, 'm1')
  for (let index = 0; index < W.CHANNEL_LIMIT + 20; index += 1) {
    W.postChannelMessage(state, { from: 'impl', to: 'team', kind: 'note', text: `note ${index}`, now: NOW })
  }
  assert.equal(state.channel.length, W.CHANNEL_LIMIT)
  assert.equal(state.channel.at(-1).kind, 'note')
})

test('open-queue items can only be claimed once and release returns them to the queue', () => {
  const state = run([item({ owner: '', assignment: 'open' })])
  W.ensureCollaboration(state)
  assert.equal(state.items[0].assignment, 'open')
  assert.equal(state.items[0].owner, '')

  const claimed = W.claimItem(state, { itemId: 'W1', caller: 'impl2', now: NOW, leaseMinutes: 15 })
  assert.equal(claimed.owner, 'impl2')
  assert.equal(claimed.claim.by, 'impl2')
  assert.equal(claimed.claim.leaseMinutes, 15)
  assert.throws(() => W.claimItem(state, { itemId: 'W1', caller: 'impl', now: NOW }), /already claimed by "impl2"/)
  assert.throws(() => W.releaseItem(state, { itemId: 'W1', caller: 'impl', now: NOW }), /only the current owner/)

  const released = W.releaseItem(state, { itemId: 'W1', caller: 'impl2', now: LATER, reason: 'moving to W2' })
  assert.equal(released.item.owner, null)
  assert.equal(released.item.claim, null)
  assert.equal(state.events.some((event) => event.type === 'item/released'), true)
  // Released items can be claimed by somebody else.
  assert.equal(W.claimItem(state, { itemId: 'W1', caller: 'impl', now: NOW }).owner, 'impl')

  // Items the Lead assigned are not claimable and cannot be released by a stranger.
  const assigned = run([item()])
  assert.throws(() => W.claimItem(assigned, { itemId: 'W1', caller: 'impl2', now: NOW }), /open for claiming/)
  assert.throws(() => W.releaseItem(assigned, { itemId: 'W1', caller: 'impl2', now: NOW }), /only the current owner/)
})

test('a reported open-queue item can invite a named peer reviewer who then takes it', () => {
  const state = run([item({ owner: '', assignment: 'open', reviewers: [] })])
  W.ensureCollaboration(state)
  W.claimItem(state, { itemId: 'W1', caller: 'impl', now: NOW })
  const reported = W.applyReport(state, { itemId: 'W1', caller: 'impl', report: report(), now: NOW, settings: SETTINGS })
  // No declared reviewer: the item waits in review instead of inventing one.
  assert.equal(reported.review, null)
  assert.equal(state.items[0].status, W.ITEM_STATUS.IN_REVIEW)
  assert.equal(W.pendingReview(state.items[0]), null)

  const request = W.requestReviewFromPeer(state, { itemId: 'W1', caller: 'impl', reviewer: 'impl2', now: NOW })
  assert.equal(request.reviewer, 'impl2')
  assert.equal(state.items[0].pendingReviewer, 'impl2')
  assert.equal(state.items[0].reviewers.includes('impl2'), true)
  assert.throws(() => W.takeReview(state, { itemId: 'W1', caller: 'rev', now: NOW }), /belongs to "impl2"/)

  const taken = W.takeReview(state, { itemId: 'W1', caller: 'impl2', now: LATER })
  assert.equal(taken.review.reviewer, 'impl2')
  const approved = W.applyReviewSubmit(state, { itemId: 'W1', reviewer: 'impl2', verdict: 'approve', summary: 'verified', findings: [], evidenceChecked: ['inspected src/core/run.js'], now: NOW })
  assert.equal(approved.item.status, W.ITEM_STATUS.APPROVED)
  assert.equal(state.items[0].pendingReviewer, null)

  // The v1 flow already has a pending review for its planned reviewer.
  const legacy = reportedWithReview(run([item()]))
  assert.throws(() => W.requestReviewFromPeer(legacy, { itemId: 'W1', caller: 'impl', reviewer: 'impl2', now: NOW }), /pending review/)
})

test('an open review invitation can be taken by any independent peer', () => {
  const state = run([item({ owner: '', assignment: 'open', reviewers: [] })])
  W.ensureCollaboration(state)
  W.claimItem(state, { itemId: 'W1', caller: 'impl', now: NOW })
  W.applyReport(state, { itemId: 'W1', caller: 'impl', report: report(), now: NOW, settings: SETTINGS })
  W.requestReviewFromPeer(state, { itemId: 'W1', caller: 'impl', reviewer: null, now: NOW })
  assert.equal(state.items[0].pendingReviewer, null)
  assert.equal(state.items[0].reviewRequests.length, 1)
  const taken = W.takeReview(state, { itemId: 'W1', caller: 'rev', now: LATER })
  assert.equal(taken.review.reviewer, 'rev')
  assert.equal(state.items[0].pendingReviewer, 'rev')
  assert.deepEqual(state.items[0].reviewers, ['rev'])
  assert.throws(() => W.takeReview(state, { itemId: 'W1', caller: 'impl', now: NOW }), /own work/)

  // The reviewer's verdict now converges the item even though the plan listed no reviewer.
  const approved = W.applyReviewSubmit(state, { itemId: 'W1', reviewer: 'rev', verdict: 'approve', summary: 'verified', findings: [], evidenceChecked: ['inspected src/core/run.js'], now: NOW })
  assert.equal(approved.item.status, W.ITEM_STATUS.APPROVED)
})

test('handoffs transfer ownership only after the peer accepts', () => {
  const state = run([item()])
  const offered = W.offerHandoff(state, { itemId: 'W1', caller: 'impl', to: 'impl2', reason: 'I am blocked on access', now: NOW })
  assert.equal(offered.status, 'offered')
  assert.equal(state.items[0].owner, 'impl')
  assert.throws(() => W.respondHandoff(state, { itemId: 'W1', caller: 'rev', accept: true, now: NOW }), /no handoff offered to you/)

  const accepted = W.respondHandoff(state, { itemId: 'W1', caller: 'impl2', accept: true, now: LATER })
  assert.equal(accepted.handoff.status, 'accepted')
  assert.equal(accepted.item.owner, 'impl2')
  assert.equal(accepted.item.claim.by, 'impl2')
  assert.throws(() => W.respondHandoff(state, { itemId: 'W1', caller: 'impl2', accept: true, now: NOW }), /no handoff offered to you/)

  const declinedState = run([item()])
  W.offerHandoff(declinedState, { itemId: 'W1', caller: 'impl', to: 'impl2', now: NOW })
  const declined = W.respondHandoff(declinedState, { itemId: 'W1', caller: 'impl2', accept: false, reason: 'not my area', now: LATER })
  assert.equal(declined.handoff.status, 'declined')
  assert.equal(declined.item.owner, 'impl')
})

test('an item proposal is decided by the item owner and its reviewers', () => {
  const state = run([item()])
  const proposal = W.proposeDecision(state, { by: 'impl', kind: 'dod', itemId: 'W1', text: 'Also assert the empty name case', now: NOW })
  assert.equal(proposal.id, 'p1')
  assert.equal(proposal.status, 'open')
  assert.deepEqual(W.affectedMembersFor(proposal, state, MEMBERS), ['impl', 'rev'])
  assert.throws(() => W.voteDecision(state, { proposalId: 'p1', by: 'impl2', vote: 'yes', members: MEMBERS, now: NOW }), /not affected/)

  W.voteDecision(state, { proposalId: 'p1', by: 'impl', vote: 'yes', members: MEMBERS, now: NOW })
  assert.equal(W.findProposal(state, 'p1').status, 'open', 'a single vote does not close the proposal')
  const resolved = W.voteDecision(state, { proposalId: 'p1', by: 'rev', vote: 'yes', members: MEMBERS, now: LATER })
  assert.equal(resolved.resolution, 'accepted')
  assert.equal(W.findProposal(state, 'p1').status, 'accepted')
  // Accepted DoD proposals amend the item definition of done.
  assert.equal(state.items[0].definitionOfDone.includes('Also assert the empty name case'), true)
  assert.throws(() => W.voteDecision(state, { proposalId: 'p1', by: 'rev', vote: 'no', members: MEMBERS, now: NOW }), /already accepted/)
})

test('a tied vote escalates to the Lead and stays blocking until arbitrated', () => {
  const state = run([item()])
  W.proposeDecision(state, { by: 'impl', kind: 'scope', itemId: 'W1', text: 'Extend the scope to the CLI', now: NOW })
  W.voteDecision(state, { proposalId: 'p1', by: 'impl', vote: 'yes', members: MEMBERS, now: NOW })
  const tied = W.voteDecision(state, { proposalId: 'p1', by: 'rev', vote: 'no', members: MEMBERS, now: LATER })
  assert.equal(tied.resolution, 'escalated')
  const proposal = W.findProposal(state, 'p1')
  assert.equal(proposal.status, 'escalated')
  const escalation = state.escalations.find((entry) => entry.subject.includes('p1'))
  assert.equal(escalation?.blocking, true)

  // An unsettled tie keeps blocking approvals.
  W.applyReport(state, { itemId: 'W1', caller: 'impl', report: report(), now: NOW, settings: SETTINGS })
  assert.throws(
    () => W.applyReviewSubmit(state, { itemId: 'W1', reviewer: 'rev', verdict: 'approve', summary: 'ok', findings: [], evidenceChecked: ['read'], now: NOW }),
    /open blocking proposal/,
  )

  // Only the Lead settles it, which resolves the linked escalation too.
  const settled = W.settleProposalByLead(state, { proposalId: 'p1', outcome: 'rejected', comment: 'keep the scope tight', actor: 'lead', now: LATER })
  assert.equal(settled.status, 'rejected')
  assert.match(settled.resolution, /Lead arbitration/)
  assert.equal(state.escalations.find((entry) => entry.subject.includes('p1'))?.resolved, true)
  const approved = W.applyReviewSubmit(state, { itemId: 'W1', reviewer: 'rev', verdict: 'approve', summary: 'ok', findings: [], evidenceChecked: ['read'], now: NOW })
  assert.equal(approved.item.status, W.ITEM_STATUS.APPROVED)
})

test('open blocking proposals reject approvals and fail the gate', () => {
  const state = run([item()])
  W.proposeDecision(state, { by: 'impl', kind: 'replan', itemId: null, text: 'Split the run into two phases', now: NOW })
  // Team-wide proposals affect every member, including the Lead.
  assert.deepEqual(W.affectedMembersFor(W.findProposal(state, 'p1'), state, MEMBERS), ['lead', 'impl', 'impl2', 'rev'])
  W.applyReport(state, { itemId: 'W1', caller: 'impl', report: report(), now: NOW, settings: SETTINGS })
  assert.throws(
    () => W.applyReviewSubmit(state, { itemId: 'W1', reviewer: 'rev', verdict: 'approve', summary: 'ok', findings: [], evidenceChecked: ['read'], now: NOW }),
    /open blocking proposal/,
  )
  const gate = W.evaluateGates(state, { settings: SETTINGS, members: MEMBERS, nativeTasks: [], overrides: [] })
  assert.equal(gate.pass, false)
  assert.equal(gate.itemGates[0].failures.some((failure) => failure.includes('open blocking proposal')), true)
})

test('a withdrawn proposal unblocks the run', () => {
  const state = run([item()])
  W.proposeDecision(state, { by: 'impl', kind: 'scope', itemId: 'W1', text: 'Also touch docs/', now: NOW })
  assert.throws(() => W.withdrawProposal(state, { proposalId: 'p1', caller: 'rev', now: NOW }), /only the author/)
  const withdrawn = W.withdrawProposal(state, { proposalId: 'p1', caller: 'impl', now: LATER })
  assert.equal(withdrawn.status, 'withdrawn')
  assert.equal(W.openBlockingProposals(state, 'W1').length, 0)
})

test('peer questions addressed to a member surface as next actions until answered', () => {
  const state = run([item()])
  const question = W.postChannelMessage(state, { from: 'impl', to: 'rev', kind: 'question', text: 'Should the helper live in src/core/', itemId: 'W1', now: NOW })
  const reviewerActions = W.nextActions(state, { me: { name: 'rev', role: 'teammate' }, role: 'teammate', members: MEMBERS, settings: SETTINGS })
  assert.equal(reviewerActions.some((action) => action.includes(`asked you in the channel`) && action.includes('team_flow_talk')), true)
  W.postChannelMessage(state, { from: 'rev', to: 'impl', kind: 'answer', text: 'yes, src/core/helper.js', replyTo: question.id, now: LATER })
  const after = W.collaborationSummary(state, { me: 'rev', role: 'teammate', members: MEMBERS })
  assert.equal(after.questions_to_me.length, 0)
})

test('collaboration summary lists the open queue, invitations, handoffs and ballots', () => {
  const state = run([item({ owner: '', assignment: 'open' }), item({ id: 'W2', owner: 'impl2', reviewers: ['rev'], writeScopes: ['src/api/'] })])
  W.ensureCollaboration(state)
  state.items[0].assignment = 'open'
  state.items[0].owner = ''
  const summary = W.collaborationSummary(state, { me: 'impl2', role: 'teammate', members: MEMBERS })
  assert.deepEqual(summary.open_queue, ['W1'])

  // Offer the handoff while W2 is still unreported (reported work is reworked, not handed off).
  W.offerHandoff(state, { itemId: 'W2', caller: 'impl2', to: 'rev', now: NOW })
  W.applyReport(state, { itemId: 'W2', caller: 'impl2', report: report({ files: ['src/api/index.js'] }), now: NOW, settings: SETTINGS })
  assert.equal(W.pendingReview(state.items[1]).reviewer, 'rev')
  const proposal = W.proposeDecision(state, { by: 'impl2', kind: 'review_policy', itemId: 'W2', text: 'Second reviewer required', now: NOW })
  assert.deepEqual(W.affectedMembersFor(proposal, state, MEMBERS), ['impl2', 'rev'])
  const awaiting = W.collaborationSummary(state, { me: 'rev', role: 'teammate', members: MEMBERS })
  assert.deepEqual(awaiting.proposals_awaiting_vote.map((entry) => entry.id), ['p1'])
  assert.equal(awaiting.open_queue.includes('W1'), true)

  const withHandoff = W.collaborationSummary(state, { me: 'rev', role: 'teammate', members: MEMBERS })
  assert.deepEqual(withHandoff.handoffs_to_me.map((entry) => entry.itemId), ['W2'])
})

test('a buildStatus call exposes collaboration and per-item claim data', () => {
  const state = run([item({ owner: '', assignment: 'open' })])
  W.ensureCollaboration(state)
  state.items[0].assignment = 'open'
  state.items[0].owner = ''
  W.claimItem(state, { itemId: 'W1', caller: 'impl2', now: NOW })
  const status = W.buildStatus(state, { me: { name: 'impl2', role: 'teammate' }, role: 'teammate', settings: SETTINGS, members: MEMBERS, artifacts: {} })
  assert.equal(status.collaboration.open_queue.length, 0)
  assert.equal(status.items[0].assignment, 'open')
  assert.equal(status.items[0].claim.by, 'impl2')
  assert.equal(status.items[0].pending_reviewer, null)
  assert.equal(status.workflow_version, 2)
})

test('the queue brief names the open items and the collaboration duties', () => {
  const state = run([item({ owner: '', assignment: 'open' })])
  const brief = renderQueueBrief(state, 'impl2', [state.items[0]])
  assert.equal(brief.name, 'impl2')
  assert.equal(brief.context, 'fresh')
  assert.match(brief.prompt, /open-queue pool/)
  assert.match(brief.prompt, /team_flow_work \{action:"claim"/)
  assert.match(brief.prompt, /team_flow_talk/)
})


// ---------------------------------------------------------------------------
// v2.2: member-created items and proposal liveness
// ---------------------------------------------------------------------------

function autonomyRun() {
  return run([item()])
}

test('a member can add a new item, owning it or publishing it to the queue', () => {
  const state = autonomyRun()
  const created = W.createItem(state, {
    by: 'rev',
    subject: 'Add an empty-input example',
    writeScopes: ['collab-live/example.mjs'],
    definitionOfDone: ['example.mjs runs and matches README'],
    now: NOW,
  })
  assert.equal(created.id, 'S1')
  assert.equal(created.origin, 'member')
  assert.equal(created.createdBy, 'rev')
  assert.equal(created.owner, 'rev')
  assert.equal(created.assignment, 'lead')
  assert.equal(created.claim.by, 'rev')
  assert.equal(created.needsReview, true)
  assert.deepEqual(created.definitionOfDone, ['example.mjs runs and matches README'])
  assert.equal(state.events.some((event) => event.type === 'item/created'), true)
  assert.equal(state.channel.at(-1).kind, 'status')

  const open = W.createItem(state, {
    by: 'rev',
    subject: 'Write the changelog',
    writeScopes: ['collab-live/CHANGELOG.md'],
    definitionOfDone: ['changelog lists the API'],
    owner: 'open',
    now: NOW,
  })
  assert.equal(open.id, 'S2')
  assert.equal(open.owner, '')
  assert.equal(open.assignment, 'open')
  assert.equal(W.collaborationSummary(state, { me: 'impl2', role: 'teammate', members: MEMBERS }).open_queue.includes('S2'), true)

  const forPeer = W.createItem(state, {
    by: 'rev',
    subject: 'Review README examples',
    writeScopes: ['collab-live/README.md'],
    definitionOfDone: ['all examples verified'],
    owner: 'impl2',
    reviewers: ['rev'],
    now: NOW,
  })
  assert.equal(forPeer.owner, 'impl2')
  assert.deepEqual(forPeer.reviewers, ['rev'])
  assert.equal(state.channel.at(-1).to, 'impl2')
})

test('member-created items reject bad shapes and same-wave scope races', () => {
  const state = autonomyRun()
  const base = { by: 'rev', subject: 'x', writeScopes: ['collab-live/a.mjs'], definitionOfDone: ['done'], now: NOW }
  assert.throws(() => W.createItem(state, { ...base, subject: '   ' }), /non-empty subject/)
  assert.throws(() => W.createItem(state, { ...base, definitionOfDone: [] }), /definition_of_done/)
  assert.throws(() => W.createItem(state, { ...base, writeScopes: [] }), /write scope/)
  assert.throws(() => W.createItem(state, { ...base, writeScopes: ['/abs/path'] }), /workspace-relative/)
  assert.throws(() => W.createItem(state, { ...base, blockedBy: ['NOPE'] }), /unknown work item/)
  assert.throws(() => W.createItem(state, { ...base, owner: 'lead' }), /Lead coordinates/)
  assert.throws(() => W.createItem(state, { ...base, reviewers: ['rev'] }), /own owner/)
  // The existing item already writes src/core/ in wave 1, so an overlapping new item would race.
  assert.throws(
    () => W.createItem(state, { ...base, subject: 'overlap', writeScopes: ['src/core/extra.js'] }),
    /race with an existing item/,
  )
  const lenient = W.createItem(state, { ...base, subject: 'overlap allowed', writeScopes: ['src/core/extra.js'], allowScopeOverlap: true })
  assert.equal(lenient.id, 'S1')
})

test('member-created items join the same report/review/gate path', () => {
  const state = autonomyRun()
  const created = W.createItem(state, {
    by: 'impl',
    subject: 'Add the unicode example',
    writeScopes: ['collab-live/unicode.mjs'],
    definitionOfDone: ['example runs'],
    reviewers: ['rev'],
    now: NOW,
  })
  assert.equal(created.id, 'S1')
  // The planned item must still pass its own review for the run gate to pass.
  W.applyReport(state, { itemId: 'W1', caller: 'impl', report: report(), now: NOW, settings: SETTINGS })
  W.applyReviewSubmit(state, { itemId: 'W1', reviewer: 'rev', verdict: 'approve', summary: 'verified', findings: [], evidenceChecked: ['read src/core/run.js'], now: NOW })
  W.applyReport(state, {
    itemId: 'S1',
    caller: 'impl',
    report: { summary: 'example added', files: ['collab-live/unicode.mjs'], commands: [{ command: 'node collab-live/unicode.mjs', exitCode: 0 }], evidence: ['printed the expected string'], openQuestions: [], risks: [] },
    now: NOW,
    settings: SETTINGS,
  })
  W.applyReviewSubmit(state, { itemId: 'S1', reviewer: 'rev', verdict: 'approve', summary: 'verified', findings: [], evidenceChecked: ['read the example'], now: NOW })
  assert.equal(state.items.find((candidate) => candidate.id === 'S1').status, W.ITEM_STATUS.APPROVED)
  const gates = W.evaluateGates(state, { settings: SETTINGS, members: MEMBERS, nativeTasks: [], overrides: [], now: NOW })
  assert.equal(gates.pass, true)
})

test('proposals get a deadline and a quorum on creation', () => {
  const state = autonomyRun()
  const scoped = W.proposeDecision(state, { by: 'impl', kind: 'dod', itemId: 'W1', text: 'also cover empty names', settings: { proposalTimeoutMinutes: 15 }, members: MEMBERS, now: NOW })
  assert.equal(scoped.deadline, new Date(Date.parse(NOW) + 15 * 60_000).toISOString())
  assert.equal(scoped.quorum, W.proposalQuorumFor(['impl', 'rev']))
  assert.equal(scoped.autoResolved, false)

  const teamWide = W.proposeDecision(state, { by: 'impl', kind: 'replan', itemId: null, text: 'split the run', settings: { proposalTimeoutMinutes: 30 }, members: MEMBERS, now: NOW })
  assert.equal(teamWide.quorum, W.proposalQuorumFor(MEMBERS.map((member) => member.name)))
  const short = W.proposeDecision(state, { by: 'impl', kind: 'review_policy', itemId: null, text: 'two reviewers', timeoutMinutes: 1, settings: SETTINGS, members: MEMBERS, now: NOW })
  assert.equal(short.deadline, new Date(Date.parse(NOW) + 60_000).toISOString())
})

test('expired proposals settle lazily by quorum, and reset the board state', () => {
  const state = autonomyRun()
  const due = new Date(Date.parse(NOW) - 60_000).toISOString()
  W.proposeDecision(state, { by: 'impl', kind: 'dod', itemId: 'W1', text: 'cover empty input', settings: SETTINGS, members: MEMBERS, now: NOW })
  // Not due yet: untouched.
  assert.deepEqual(W.settleExpiredProposals(state, { now: NOW, settings: SETTINGS, members: MEMBERS }), [])
  assert.equal(W.findProposal(state, 'p1').status, 'open')
  // One yes vote with quorum 1 is enough once the deadline passes.
  W.voteDecision(state, { proposalId: 'p1', by: 'impl', vote: 'yes', settings: SETTINGS, members: MEMBERS, now: NOW })
  state.proposals[0].deadline = due
  const settled = W.settleExpiredProposals(state, { now: new Date(Date.parse(NOW) + 60_000).toISOString(), settings: SETTINGS, members: MEMBERS })
  assert.equal(settled.length, 1)
  const proposal = W.findProposal(state, 'p1')
  assert.equal(proposal.status, 'accepted')
  assert.equal(proposal.autoResolved, true)
  assert.match(proposal.resolution, /auto-accepted/)
  // The accepted dod proposal amended the item.
  assert.equal(state.items[0].definitionOfDone.includes('cover empty input'), true)
})

test('a proposal without quorum at its deadline escalates and keeps blocking', () => {
  const state = autonomyRun()
  const proposal = W.proposeDecision(state, { by: 'impl', kind: 'replan', itemId: null, text: 'restructure everything', timeoutMinutes: 1, settings: SETTINGS, members: MEMBERS, now: NOW })
  state.proposals[0].deadline = new Date(Date.parse(NOW) - 1).toISOString()
  const settled = W.settleExpiredProposals(state, { now: NOW, settings: SETTINGS, members: MEMBERS })
  assert.equal(settled[0].status, 'escalated')
  assert.equal(settled[0].autoResolved, true)
  assert.match(settled[0].resolution, /without quorum/)
  const escalation = state.escalations.find((entry) => entry.subject.includes(proposal.id))
  assert.equal(escalation?.blocking, true)
  // Blocking proposals keep the approval path closed until arbitration.
  W.applyReport(state, { itemId: 'W1', caller: 'impl', report: report(), now: NOW, settings: SETTINGS })
  assert.throws(
    () => W.applyReviewSubmit(state, { itemId: 'W1', reviewer: 'rev', verdict: 'approve', summary: 'ok', findings: [], evidenceChecked: ['read'], now: NOW }),
    /open blocking proposal/,
  )
  // The Lead settles it with the existing arbitration action.
  W.settleProposalByLead(state, { proposalId: 'p1', outcome: 'rejected', actor: 'lead', now: NOW })
  const approved = W.applyReviewSubmit(state, { itemId: 'W1', reviewer: 'rev', verdict: 'approve', summary: 'ok', findings: [], evidenceChecked: ['read'], now: NOW })
  assert.equal(approved.item.status, W.ITEM_STATUS.APPROVED)
})
