/**
 * Offline unit tests for the pure workflow engine.
 *
 * The engine has no Cordis or filesystem dependency, so these tests exercise
 * the protocol's real rules — plan validation, review rounds, escalation,
 * gates, and role-aware steering — without a running Harness.
 *
 * Run: node --test test/
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import * as W from '../lib/workflow.js'
import { renderReviewerBrief, renderWorkerBrief } from '../lib/protocol.js'

const SETTINGS = Object.freeze({
  maxReviewRounds: 2,
  maxParallelItems: 4,
  workerContext: 'fresh',
  strictScopes: false,
  allowScopeOverlap: false,
})

const NOW = '2026-11-01T00:00:00.000Z'

/** Build one normalized item the way `team_flow_plan` does. */
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

function plan(items) {
  return {
    objective: 'Ship a verified module',
    acceptanceCriteria: ['module is importable', 'tests are green'],
    constraints: ['no new dependencies'],
    items,
  }
}

function run(items) {
  return W.createRun({
    workflowVersion: W.WORKFLOW_VERSION,
    runId: 'run-test-1',
    teamId: 'session-lead',
    objective: 'Ship a verified module',
    acceptanceCriteria: ['module is importable', 'tests are green'],
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

test('plan validation rejects self-review, cycles, scope races, and Lead-owned items', () => {
  const selfReview = W.validatePlan(plan([item({ reviewers: ['impl'] })]), SETTINGS)
  assert.equal(selfReview.errors.some((error) => error.includes('own owner')), true)

  const cyclic = W.validatePlan(
    plan([item({ id: 'W1', blockedBy: ['W2'] }), item({ id: 'W2', owner: 'impl2', reviewers: ['rev'], blockedBy: ['W1'] })]),
    SETTINGS,
  )
  assert.equal(cyclic.errors.some((error) => error.includes('dependency cycle')), true)

  const racing = W.validatePlan(
    plan([
      item({ id: 'W1', owner: 'impl', writeScopes: ['src/core/'] }),
      item({ id: 'W2', owner: 'impl2', reviewers: ['rev'], writeScopes: ['src/core/util.js'] }),
    ]),
    SETTINGS,
  )
  assert.equal(racing.errors.some((error) => error.includes('would race')), true)

  const leadOwned = W.validatePlan(plan([item({ owner: 'lead' })]), SETTINGS)
  assert.equal(leadOwned.errors.some((error) => error.includes('owned by the Lead')), true)

  const noReviewer = W.validatePlan(plan([item({ reviewers: [] })]), SETTINGS)
  assert.equal(noReviewer.errors.some((error) => error.includes('declares no reviewers')), true)

  const noDone = W.validatePlan(plan([item({ definitionOfDone: [] })]), SETTINGS)
  assert.equal(noDone.errors.some((error) => error.includes('definition_of_done')), true)
})

test('plan validation accepts a dependency-ordered plan and computes waves', () => {
  const items = [
    item({ id: 'W1' }),
    item({ id: 'W2', owner: 'impl2', reviewers: ['rev'], blockedBy: ['W1'], writeScopes: ['src/api/'] }),
    item({ id: 'W3', owner: 'impl3', reviewers: ['rev'], writeScopes: ['docs/'] }),
  ]
  const result = W.validatePlan(plan(items), SETTINGS)
  assert.deepEqual(result.errors, [])
  assert.deepEqual(result.waves, [['W1', 'W3'], ['W2']])
})

test('overlapping scopes are only warnings when configuration allows them', () => {
  const items = [item({ id: 'W1' }), item({ id: 'W2', owner: 'impl2', reviewers: ['rev'], writeScopes: ['src/core/util/'] })]
  const lenient = W.validatePlan(plan(items), { ...SETTINGS, allowScopeOverlap: true })
  assert.deepEqual(lenient.errors, [])
  assert.equal(lenient.warnings.some((warning) => warning.includes('overlapping write scopes')), true)
})

test('report opens a review round and the review must be approved to converge', () => {
  const state = run([item()])
  const reported = W.applyReport(state, { itemId: 'W1', caller: 'impl', report: report(), now: NOW, settings: SETTINGS })
  assert.equal(reported.item.status, W.ITEM_STATUS.IN_REVIEW)
  assert.equal(reported.item.reviews.length, 1)
  assert.equal(reported.review.reviewer, 'rev')
  assert.equal(reported.item.reviewSeq, 1)

  assert.throws(
    () => W.applyReviewSubmit(state, { itemId: 'W1', reviewer: 'impostor', verdict: 'approve', summary: 'lgtm', findings: [], evidenceChecked: [], now: NOW }),
    /assigned to "rev"/,
  )

  const approved = W.applyReviewSubmit(state, {
    itemId: 'W1',
    reviewer: 'rev',
    verdict: 'approve',
    summary: 'Definitions of done are covered and the test command reproduces.',
    findings: [],
    evidenceChecked: ['read src/core/run.js', 'ran node --test test/core.test.mjs'],
    now: NOW,
  })
  assert.equal(approved.item.status, W.ITEM_STATUS.APPROVED)
  assert.equal(state.phase, W.RUN_PHASE.CONVERGED)
})

test('changes requested must be answered finding by finding, then re-reviewed', () => {
  const state = run([item()])
  W.applyReport(state, { itemId: 'W1', caller: 'impl', report: report(), now: NOW, settings: SETTINGS })
  const submitted = W.applyReviewSubmit(state, {
    itemId: 'W1',
    reviewer: 'rev',
    verdict: 'request_changes',
    summary: 'Missing an error path.',
    findings: [{ id: 'F1', severity: 'major', file: 'src/core/run.js', line: 42, claim: 'run() swallows ENOENT' }],
    evidenceChecked: ['read src/core/run.js'],
    now: NOW,
  })
  assert.equal(submitted.item.status, W.ITEM_STATUS.CHANGES_REQUESTED)

  assert.throws(
    () => W.applyReviewRespond(state, { itemId: 'W1', author: 'impl', responses: [{ findingId: 'F9', state: 'fixed' }], now: NOW, settings: SETTINGS }),
    /unknown or already resolved finding/,
  )

  const responded = W.applyReviewRespond(state, {
    itemId: 'W1',
    author: 'impl',
    responses: [{ findingId: 'F1', state: 'fixed', evidence: 'run() now rethrows ENOENT; test added at test/core.test.mjs:88' }],
    now: NOW,
    settings: SETTINGS,
  })
  assert.equal(responded.escalated, false)
  assert.equal(responded.item.status, W.ITEM_STATUS.IN_REVIEW)
  assert.equal(responded.nextReview.round, 2)

  const approved = W.applyReviewSubmit(state, {
    itemId: 'W1',
    reviewer: 'rev',
    verdict: 'approve_with_nits',
    summary: 'Fix verified.',
    findings: [{ id: 'F2', severity: 'nit', file: 'src/core/run.js', line: 12, claim: 'naming could be clearer' }],
    evidenceChecked: ['read src/core/run.js', 'read test/core.test.mjs'],
    now: NOW,
  })
  assert.equal(approved.item.status, W.ITEM_STATUS.APPROVED)
})

test('a non-approving verdict requires findings', () => {
  const state = run([item()])
  W.applyReport(state, { itemId: 'W1', caller: 'impl', report: report(), now: NOW, settings: SETTINGS })
  assert.throws(
    () => W.applyReviewSubmit(state, { itemId: 'W1', reviewer: 'rev', verdict: 'block', summary: 'bad', findings: [], evidenceChecked: [], now: NOW }),
    /at least one finding/,
  )
})

test('a rebutted blocker escalates instead of looping', () => {
  const state = run([item()])
  W.applyReport(state, { itemId: 'W1', caller: 'impl', report: report(), now: NOW, settings: SETTINGS })
  W.applyReviewSubmit(state, {
    itemId: 'W1',
    reviewer: 'rev',
    verdict: 'block',
    summary: 'Design is wrong.',
    findings: [{ id: 'F1', severity: 'blocker', file: 'src/core/run.js', line: 1, claim: 'API shape contradicts the interface contract' }],
    evidenceChecked: ['read src/core/run.js'],
    now: NOW,
  })
  const responded = W.applyReviewRespond(state, {
    itemId: 'W1',
    author: 'impl',
    responses: [{ findingId: 'F1', state: 'rebut', note: 'The contract in docs/api.md allows this shape.' }],
    now: NOW,
    settings: SETTINGS,
  })
  assert.equal(responded.escalated, true)
  assert.equal(responded.item.status, W.ITEM_STATUS.ESCALATED)
  assert.equal(state.escalations.length, 1)
  assert.equal(state.escalations[0].blocking, true)
  assert.equal(state.escalations[0].kind, 'arbitration')
})

test('exhausted review rounds escalate', () => {
  const state = run([item()])
  W.applyReport(state, { itemId: 'W1', caller: 'impl', report: report(), now: NOW, settings: SETTINGS })
  for (let round = 1; round <= 2; round += 1) {
    W.applyReviewSubmit(state, {
      itemId: 'W1',
      reviewer: 'rev',
      verdict: 'request_changes',
      summary: `Round ${round} issues.`,
      findings: [{ id: 'F1', severity: 'major', file: 'src/core/run.js', line: round, claim: `issue ${round}` }],
      evidenceChecked: ['read src/core/run.js'],
      now: NOW,
    })
    W.applyReviewRespond(state, {
      itemId: 'W1',
      author: 'impl',
      responses: [{ findingId: 'F1', state: 'fixed', evidence: 'patched' }],
      now: NOW,
      settings: SETTINGS,
    })
  }
  const itemState = state.items[0]
  assert.equal(itemState.status, W.ITEM_STATUS.ESCALATED)
  assert.equal(state.escalations.length, 1)
  assert.match(state.escalations[0].detail, /rework round/i)
})

test('multiple reviewers must all approve', () => {
  const state = run([item({ reviewers: ['rev', 'rev2'] })])
  W.applyReport(state, { itemId: 'W1', caller: 'impl', report: report(), now: NOW, settings: SETTINGS })
  const first = W.applyReviewSubmit(state, {
    itemId: 'W1',
    reviewer: 'rev',
    verdict: 'approve',
    summary: 'First reviewer approves.',
    findings: [],
    evidenceChecked: ['read src/core/run.js'],
    now: NOW,
  })
  assert.equal(first.item.status, W.ITEM_STATUS.IN_REVIEW)
  assert.equal(first.nextReviewer, 'rev2')
  const second = W.applyReviewSubmit(state, {
    itemId: 'W1',
    reviewer: 'rev2',
    verdict: 'approve',
    summary: 'Second reviewer approves.',
    findings: [],
    evidenceChecked: ['ran the tests'],
    now: NOW,
  })
  assert.equal(second.item.status, W.ITEM_STATUS.APPROVED)
})

test('gates fail on missing evidence, unapproved review, unresolved findings, and scope escape', () => {
  const state = run([item()])
  const empty = W.evaluateGates(state, { settings: SETTINGS, members: [], nativeTasks: [], overrides: [], now: NOW })
  assert.equal(empty.pass, false)
  assert.match(empty.itemGates[0].failures.join('; '), /no work report/)

  W.applyReport(state, {
    itemId: 'W1',
    caller: 'impl',
    report: report({ commands: [{ command: 'npm test', exitCode: null }], files: ['src/core/run.js', 'outside/leak.js'] }),
    now: NOW,
    settings: SETTINGS,
  })
  const dirty = W.evaluateGates(state, { settings: SETTINGS, members: [], nativeTasks: [], overrides: [], now: NOW })
  assert.equal(dirty.pass, false)
  assert.match(dirty.itemGates[0].failures.join('; '), /without an integer exit_code/)
  assert.match(dirty.itemGates[0].warnings.join('; '), /outside the declared write scope/)

  const strict = W.evaluateGates(state, { settings: { ...SETTINGS, strictScopes: true }, members: [], nativeTasks: [], overrides: [], now: NOW })
  assert.match(strict.itemGates[0].failures.join('; '), /outside the declared write scope/)
})

test('a passing gate plus Lead override converges the run', () => {
  const state = run([item()])
  W.applyReport(state, { itemId: 'W1', caller: 'impl', report: report(), now: NOW, settings: SETTINGS })
  W.applyReviewSubmit(state, { itemId: 'W1', reviewer: 'rev', verdict: 'approve', summary: 'ok', findings: [], evidenceChecked: ['read the file'], now: NOW })
  const gate = W.evaluateGates(state, { settings: SETTINGS, members: [{ name: 'rev', role: 'teammate', status: 'inactive', context: 'fresh' }], nativeTasks: [], overrides: [], now: NOW })
  assert.equal(gate.pass, true)

  // Forked reviewers are flagged: independence is weaker than a fresh reviewer.
  const forked = W.evaluateGates(state, { settings: SETTINGS, members: [{ name: 'rev', role: 'teammate', status: 'inactive', context: 'fork' }], nativeTasks: [], overrides: [], now: NOW })
  assert.match(forked.itemGates[0].warnings.join('; '), /forked context/)

  const overridden = W.evaluateGates(state, { settings: SETTINGS, members: [], nativeTasks: [], overrides: [{ itemId: 'W1', reason: 'accepted residual risk' }], now: NOW })
  assert.equal(overridden.itemGates[0].overridden, true)
})

test('blocking escalations stop the gate; resolving them unblocks it', () => {
  const state = run([item()])
  W.applyReport(state, { itemId: 'W1', caller: 'impl', report: report(), now: NOW, settings: SETTINGS })
  W.applyReviewSubmit(state, { itemId: 'W1', reviewer: 'rev', verdict: 'approve', summary: 'ok', findings: [], evidenceChecked: ['read the file'], now: NOW })
  W.raiseEscalation(state, { kind: 'conflict', subject: 'two specs disagree', detail: 'docs/a.md vs docs/b.md', blocking: true, actor: 'impl', itemId: 'W1', now: NOW })
  const blocked = W.evaluateGates(state, { settings: SETTINGS, members: [], nativeTasks: [], overrides: [], now: NOW })
  assert.equal(blocked.pass, false)
  assert.match(blocked.teamFailures.join('; '), /unresolved blocking escalation/)

  W.resolveEscalation(state, { escalationId: 'esc-1', resolution: 'docs/a.md wins', actor: 'lead', now: NOW })
  const unblocked = W.evaluateGates(state, { settings: SETTINGS, members: [], nativeTasks: [], overrides: [], now: NOW })
  assert.equal(unblocked.pass, true)
})

test('status steers each role to its own next action', () => {
  const state = run([item()])
  const leadStatus = W.buildStatus(state, { me: { name: 'lead', role: 'lead' }, role: 'lead', settings: SETTINGS, members: [], artifacts: {} })
  assert.match(leadStatus.next_actions.join(' '), /Ensure these owners are spawned/)

  const ownerStatus = W.buildStatus(state, { me: { name: 'impl', role: 'teammate' }, role: 'teammate', settings: SETTINGS, members: [], artifacts: {} })
  assert.match(ownerStatus.next_actions.join(' '), /team_flow_report/)

  W.applyReport(state, { itemId: 'W1', caller: 'impl', report: report(), now: NOW, settings: SETTINGS })
  const reviewerStatus = W.buildStatus(state, { me: { name: 'rev', role: 'teammate' }, role: 'teammate', settings: SETTINGS, members: [], artifacts: {} })
  assert.match(reviewerStatus.next_actions.join(' '), /team_flow_review_submit/)
  assert.equal(reviewerStatus.counts.in_review, 1)
})

test('spawn briefs carry scope, definition of done, and the review contract', () => {
  const state = run([item({ blockedBy: ['W0'], reviewers: ['rev'] })])
  state.items[0].blockedBy = []
  const worker = renderWorkerBrief(state, state.items[0])
  assert.equal(worker.context, 'fresh')
  assert.match(worker.prompt, /You are teammate "impl"/)
  assert.match(worker.prompt, /src\/core\//)
  assert.match(worker.prompt, /unit tests pass/)
  assert.match(worker.prompt, /team_flow_report/)
  assert.match(worker.prompt, /Never spawn teammates/)

  const reviewer = renderReviewerBrief(state, 'rev', [state.items[0]])
  assert.match(reviewer.prompt, /independent reviewer/)
  assert.match(reviewer.prompt, /never modify the author's files/)
  assert.match(reviewer.prompt, /team_flow_review_submit/)
})

test('scope helpers normalize Windows separators and nested prefixes', () => {
  assert.equal(W.normalizeScope('.\\src\\core\\'), 'src/core')
  assert.equal(W.pathInScope('src/core/run.js', 'src/core'), true)
  assert.equal(W.pathInScope('src/core-extra/run.js', 'src/core'), false)
  assert.equal(W.scopesOverlap('src/core', 'src/core/util'), true)
  assert.equal(W.scopesOverlap('src/core', 'src/api'), false)
})

test('a new report cannot bury unresolved review findings', () => {
  const state = run([item()])
  W.applyReport(state, { itemId: 'W1', caller: 'impl', report: report(), now: NOW, settings: SETTINGS })
  W.applyReviewSubmit(state, {
    itemId: 'W1',
    reviewer: 'rev',
    verdict: 'request_changes',
    summary: 'needs work',
    findings: [{ id: 'F1', severity: 'major', file: 'src/core/run.js', line: 3, claim: 'missing guard' }],
    evidenceChecked: ['read the file'],
    now: NOW,
  })
  assert.throws(
    () => W.applyReport(state, { itemId: 'W1', caller: 'impl', report: report({ summary: 're-reported without answering' }), now: NOW, settings: SETTINGS }),
    /unresolved review findings/,
  )
})

test('an approving review that declares no inspected evidence fails the gate', () => {
  const state = run([item()])
  W.applyReport(state, { itemId: 'W1', caller: 'impl', report: report(), now: NOW, settings: SETTINGS })
  W.applyReviewSubmit(state, { itemId: 'W1', reviewer: 'rev', verdict: 'approve', summary: 'looks fine', findings: [], evidenceChecked: [], now: NOW })
  const strict = W.evaluateGates(state, { settings: { ...SETTINGS, requireReviewEvidence: true }, members: [], nativeTasks: [], overrides: [], now: NOW })
  assert.equal(strict.pass, false)
  assert.match(strict.itemGates[0].failures.join('; '), /without declaring any inspected evidence/)

  const lenient = W.evaluateGates(state, { settings: { ...SETTINGS, requireReviewEvidence: false }, members: [], nativeTasks: [], overrides: [], now: NOW })
  assert.equal(lenient.pass, true)
  assert.match(lenient.itemGates[0].warnings.join('; '), /no inspected evidence/)
})

test('a dependency must be approved before a dependent item can report', () => {
  const state = run([item({ id: 'W1', taskId: 'task-1' }), item({ id: 'W2', owner: 'impl2', reviewers: ['rev'], blockedBy: ['W1'], taskId: 'task-2' })])
  assert.throws(
    () => W.applyReport(state, { itemId: 'W2', caller: 'impl2', report: report({ files: ['src/core/b.js'] }), now: NOW, settings: SETTINGS }),
    /depends on W1, which is not approved yet/,
  )
  // Approving the dependency unblocks the dependent item.
  W.applyReport(state, { itemId: 'W1', caller: 'impl', report: report(), now: NOW, settings: SETTINGS })
  W.applyReviewSubmit(state, { itemId: 'W1', reviewer: 'rev', verdict: 'approve', summary: 'ok', findings: [], evidenceChecked: ['read it'], now: NOW })
  W.applyReport(state, { itemId: 'W2', caller: 'impl2', report: report({ files: ['src/core/b.js'] }), now: NOW, settings: SETTINGS })
  assert.equal(state.items[1].status, W.ITEM_STATUS.IN_REVIEW)
})

test('a plan that opts out of all review is flagged', () => {
  const result = W.validatePlan(plan([item({ needsReview: false, reviewers: [] })]), SETTINGS)
  assert.deepEqual(result.errors, [])
  assert.match(result.warnings.join('; '), /no item requires independent review/)
})

test('a new report version invalidates earlier approvals (no sign-off inheritance)', () => {
  const state = run([item({ reviewers: ['rev', 'rev2'] })])
  W.applyReport(state, { itemId: 'W1', caller: 'impl', report: report(), now: NOW, settings: SETTINGS })
  // First reviewer signs version 1 while the second is still pending.
  W.applyReviewSubmit(state, { itemId: 'W1', reviewer: 'rev', verdict: 'approve', summary: 'ok', findings: [], evidenceChecked: ['read v1'], now: NOW })
  assert.equal(state.items[0].status, W.ITEM_STATUS.IN_REVIEW)
  // The author re-reports: version 2 must be re-signed by BOTH reviewers.
  W.applyReport(state, { itemId: 'W1', caller: 'impl', report: report({ summary: 'v2 changed the implementation' }), now: NOW, settings: SETTINGS })
  assert.equal(state.items[0].reportSeq, 2)
  assert.deepEqual(W.outstandingReviewers(state.items[0]), ['rev', 'rev2'])
  const gate = W.evaluateGates(state, { settings: SETTINGS, members: [], nativeTasks: [], overrides: [], now: NOW })
  assert.equal(gate.pass, false)
  assert.match(gate.itemGates[0].failures.join('; '), /review not approved by: rev, rev2/)
})

test('gate fails when a report quotes no evidence or an empty command', () => {
  const state = run([item()])
  W.applyReport(state, {
    itemId: 'W1',
    caller: 'impl',
    report: report({ commands: [{ command: '   ', exitCode: 0 }], evidence: [] }),
    now: NOW,
    settings: SETTINGS,
  })
  W.applyReviewSubmit(state, { itemId: 'W1', reviewer: 'rev', verdict: 'approve', summary: 'ok', findings: [], evidenceChecked: ['read it'], now: NOW })
  const gate = W.evaluateGates(state, { settings: SETTINGS, members: [], nativeTasks: [], overrides: [], now: NOW })
  assert.equal(gate.pass, false)
  assert.match(gate.itemGates[0].failures.join('; '), /empty command line/)
  assert.match(gate.itemGates[0].failures.join('; '), /no supporting evidence/)
})

test('the gate carries unapproved dependencies as a failure', () => {
  const state = run([item({ id: 'W1', taskId: 'task-1' }), item({ id: 'W2', owner: 'impl2', reviewers: ['rev'], blockedBy: ['W1'], taskId: 'task-2' })])
  W.applyReport(state, { itemId: 'W1', caller: 'impl', report: report(), now: NOW, settings: SETTINGS })
  W.applyReviewSubmit(state, { itemId: 'W1', reviewer: 'rev', verdict: 'approve', summary: 'ok', findings: [], evidenceChecked: ['read it'], now: NOW })
  W.applyReport(state, { itemId: 'W2', caller: 'impl2', report: report({ files: ['src/core/b.js'] }), now: NOW, settings: SETTINGS })
  // Simulate the dependency being re-opened after the dependent reported.
  state.items[0].status = W.ITEM_STATUS.PENDING
  const gate = W.evaluateGates(state, { settings: SETTINGS, members: [], nativeTasks: [], overrides: [], now: NOW })
  assert.equal(gate.itemGates[1].pass, false)
  assert.match(gate.itemGates[1].failures.join('; '), /dependencies not approved: W1/)
})

test('member names are validated at plan time', () => {
  const badOwner = W.validatePlan(plan([item({ owner: 'Impl_1' })]), SETTINGS)
  assert.match(badOwner.errors.join('; '), /not a spawnable member name/)
  const badReviewer = W.validatePlan(plan([item({ reviewers: ['Rev A'] })]), SETTINGS)
  assert.match(badReviewer.errors.join('; '), /reviewer "Rev A" is not a spawnable member name/)
})

test('a multi-reviewer item can absorb one rework round without escalation', () => {
  const state = run([item({ reviewers: ['rev', 'rev2'] })])
  W.applyReport(state, { itemId: 'W1', caller: 'impl', report: report(), now: NOW, settings: SETTINGS })
  W.applyReviewSubmit(state, { itemId: 'W1', reviewer: 'rev', verdict: 'approve', summary: 'ok', findings: [], evidenceChecked: ['read it'], now: NOW })
  W.applyReviewSubmit(state, {
    itemId: 'W1',
    reviewer: 'rev2',
    verdict: 'request_changes',
    summary: 'one issue',
    findings: [{ id: 'F1', severity: 'major', file: 'src/core/run.js', line: 5, claim: 'edge case' }],
    evidenceChecked: ['read it'],
    now: NOW,
  })
  const responded = W.applyReviewRespond(state, {
    itemId: 'W1',
    author: 'impl',
    responses: [{ findingId: 'F1', state: 'fixed', evidence: 'patched and re-tested' }],
    now: NOW,
    settings: SETTINGS,
  })
  assert.equal(responded.escalated, false, 'one rework round is within the budget')
  assert.equal(responded.nextReviewer, 'rev2')
  const approved = W.applyReviewSubmit(state, { itemId: 'W1', reviewer: 'rev2', verdict: 'approve', summary: 'ok', findings: [], evidenceChecked: ['re-read'], now: NOW })
  assert.equal(approved.item.status, W.ITEM_STATUS.APPROVED)
})
