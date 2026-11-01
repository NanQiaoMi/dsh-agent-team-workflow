/**
 * Offline unit tests for the pure dashboard snapshot aggregator.
 *
 * `lib/dashboard.js` has no imports at all — no Cordis, no filesystem, no
 * clock beyond the documented fallback — so the whole docs/09 §2 snapshot
 * contract can be exercised here with plain data. The cases below follow the
 * documented contract: empty board, waves and dependency cycles, status
 * normalization, review records and open findings, counts, truncation limits,
 * gate/escalation passthrough, event ordering, and defensive degradation.
 * Snapshot version 2 also covers the peer-collaboration aggregation of
 * docs/12 §5 (channel, proposals/votes, open queue, review invitations,
 * handoffs, per-item threads, distilled peer→peer edges) and the member
 * autonomy additions of docs/14 §4 (item origin/createdBy, proposal
 * deadline/quorum/autoResolved, with their documented defaults).
 *
 * Run: node --test test/
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { SNAPSHOT_VERSION, buildSnapshot, computeWaves, normalizeItemStatus, normalizeStatus, tailEvents } from '../lib/dashboard.js'

const NOW = '2026-11-01T00:00:00.000Z'
const ARTIFACT_ROOT = '/work/.agentteam'
const STATE_PATH = '/work/.agentteam/teams/team-1/state.json'
const REPORT_PATH = '/work/.agentteam/teams/team-1/report.md'

/** Build one blackboard item the way `team_flow_plan` normalizes it. */
function makeItem(overrides = {}) {
  return {
    id: 'W1',
    subject: 'Implement the snapshot aggregator',
    owner: 'impl',
    role: 'implementer',
    writeScopes: ['lib/dashboard.js'],
    blockedBy: [],
    definitionOfDone: ['snapshot matches docs/09 §2'],
    needsReview: true,
    reviewers: ['rev'],
    evidenceOptional: false,
    status: 'pending',
    taskId: null,
    report: null,
    reportSeq: 0,
    reviews: [],
    reviewSeq: 0,
    overrideReason: null,
    repairLog: [],
    createdAt: NOW,
    updatedAt: NOW,
    reportedAt: null,
    approvedAt: null,
    approvedBy: null,
    ...overrides,
  }
}

/** Build one blackboard review record. */
function makeReview(overrides = {}) {
  return {
    round: 1,
    reportSeq: 1,
    reviewer: 'rev',
    requestedBy: 'impl',
    requestedAt: NOW,
    status: 'submitted',
    verdict: 'approve',
    summary: 'looks good',
    findings: [],
    evidenceChecked: ['diff'],
    submittedAt: NOW,
    ...overrides,
  }
}

/** Build one review finding. */
function makeFinding(overrides = {}) {
  return {
    id: 'F1',
    severity: 'major',
    file: 'lib/dashboard.js',
    line: 12,
    claim: 'missing guard',
    suggestion: 'add a guard',
    resolution: null,
    ...overrides,
  }
}

/** Build one blackboard channel message (docs/12 §2). */
function makeMessage(overrides = {}) {
  return {
    id: 'm1',
    at: NOW,
    from: 'impl',
    to: 'team',
    kind: 'note',
    text: 'a message',
    replyTo: null,
    refs: {},
    ...overrides,
  }
}

/** Build one proposal vote. */
function makeVote(overrides = {}) {
  return { by: 'rev', at: NOW, vote: 'yes', comment: null, ...overrides }
}

/** Build one blackboard proposal (docs/12 §2). */
function makeProposal(overrides = {}) {
  return {
    id: 'p1',
    at: NOW,
    by: 'impl',
    kind: 'dod',
    itemId: null,
    text: 'proposal text',
    status: 'open',
    votes: [],
    resolvedAt: null,
    resolution: null,
    ...overrides,
  }
}

/** Build one peer review invitation (docs/12 §2 `reviewRequests`). */
function makeReviewRequest(overrides = {}) {
  return { by: 'impl', at: NOW, reviewer: 'rev', status: 'open', respondedAt: null, response: null, ...overrides }
}

/** Build one item handoff (docs/12 §2 `items[].handoffs`). */
function makeItemHandoff(overrides = {}) {
  return { by: 'impl', at: NOW, to: 'rev', reason: 'hand over', status: 'offered', respondedAt: null, ...overrides }
}

/** Build one item claim record. */
function makeClaim(overrides = {}) {
  return { by: 'impl', at: NOW, leaseMinutes: 30, note: null, ...overrides }
}

/** The collaboration block a version-1 board must still produce. */
const EMPTY_COLLABORATION = Object.freeze({
  channel: [],
  proposals: [],
  openQueue: [],
  pendingReviews: [],
  handoffs: [],
  edges: [],
})

/** Build one blackboard run state the way `createRun` does. */
function makeState(overrides = {}) {
  return {
    schemaVersion: 1,
    workflowVersion: 1,
    runId: 'run-test-1',
    teamId: 'team-1',
    objective: 'Ship the live Agent Team dashboard',
    acceptanceCriteria: ['snapshot matches docs/09 §2'],
    constraints: ['zero imports'],
    phase: 'reviewing',
    createdAt: NOW,
    updatedAt: NOW,
    settings: {
      maxReviewRounds: 2,
      maxParallelItems: 4,
      workerContext: 'fresh',
      strictScopes: false,
      allowScopeOverlap: false,
      requireReviewEvidence: true,
    },
    items: [],
    escalations: [],
    events: [],
    gate: null,
    artifacts: { statePath: STATE_PATH, reportPath: null, root: ARTIFACT_ROOT },
    finalizedAt: null,
    ...overrides,
  }
}

/** Build the roster/task block the route passes in. */
function makeTeam(overrides = {}) {
  return {
    me: { name: 'lead', role: 'lead' },
    members: [
      { name: 'lead', role: 'lead', status: 'running', context: null },
      { name: 'impl', role: 'teammate', status: 'running', context: 'fresh' },
      { name: 'rev', role: 'teammate', status: 'inactive', context: 'fresh' },
    ],
    tasks: [],
    ...overrides,
  }
}

/** Build one `buildSnapshot` input. */
function makeInput(state, extra = {}) {
  return {
    state,
    team: makeTeam(),
    artifacts: { root: ARTIFACT_ROOT, statePath: STATE_PATH, reportPath: null },
    now: NOW,
    diagnostics: { boardSource: state === null ? 'missing' : 'file', warnings: [] },
    sessionId: 'session-test',
    ...extra,
  }
}

/**
 * Assert that `waves` and `items[].wave` describe the same layering in both
 * directions: every item above wave 0 is listed in its wave, and every id in
 * `waves` is an item that reports that wave.
 */
function assertWavesConsistent(run) {
  for (const item of run.items) {
    if (item.wave === 0) {
      assert.equal(
        run.waves.some((wave) => wave.includes(item.id)),
        false,
        `item ${item.id} is wave 0 and must not appear in waves`,
      )
      continue
    }
    const bucket = run.waves[item.wave - 1]
    assert.ok(bucket !== undefined, `item ${item.id} claims wave ${item.wave}, but that wave does not exist`)
    assert.ok(bucket.includes(item.id), `item ${item.id} claims wave ${item.wave}, but is not listed there`)
  }
  for (let index = 0; index < run.waves.length; index += 1) {
    for (const id of run.waves[index]) {
      const item = run.items.find((candidate) => candidate.id === id)
      assert.ok(item !== undefined, `wave ${index + 1} references ${id}, which is not a snapshot item`)
      assert.equal(item.wave, index + 1)
    }
  }
}

/** Assert the counts block agrees with the serialized items. */
function assertCountsConsistent(run) {
  const counts = { total: run.items.length, approved: 0, pending: 0, inReview: 0, changesRequested: 0, escalated: 0 }
  for (const item of run.items) {
    if (item.status === 'approved') counts.approved += 1
    else if (item.status === 'pending' || item.status === 'running') counts.pending += 1
    else if (item.status === 'in_review') counts.inReview += 1
    else if (item.status === 'changes_requested') counts.changesRequested += 1
    else if (item.status === 'escalated') counts.escalated += 1
  }
  assert.deepEqual(run.counts, counts)
  assert.equal(counts.approved + counts.pending + counts.inReview + counts.changesRequested + counts.escalated, counts.total)
}

test('run=null still returns the team and diagnostics (empty board, not an error)', () => {
  const input = makeInput(null, {
    team: makeTeam({
      tasks: [{ id: 'task-7', revision: 3, status: 'in_progress', subject: 'do the work', ownerName: 'impl' }],
    }),
    diagnostics: { boardSource: 'missing', warnings: ['state.json not found'] },
  })
  const snapshot = buildSnapshot(input)
  assert.equal(snapshot.ok, true)
  assert.equal(snapshot.version, SNAPSHOT_VERSION)
  assert.equal(snapshot.version, 2)
  assert.equal(snapshot.generatedAt, NOW)
  assert.equal(snapshot.sessionId, 'session-test')
  assert.equal(snapshot.run, null)
  assert.deepEqual(snapshot.team.me, { name: 'lead', role: 'lead' })
  assert.equal(snapshot.team.members.length, 3)
  assert.deepEqual(snapshot.team.tasks, [{ id: 'task-7', revision: 3, status: 'in_progress', subject: 'do the work', ownerName: 'impl' }])
  assert.deepEqual(snapshot.diagnostics, { boardSource: 'missing', warnings: ['state.json not found'] })
})

test('two items with a dependency produce consistent waves', () => {
  const state = makeState({
    items: [makeItem({ id: 'W1', taskId: 'task-1' }), makeItem({ id: 'W2', blockedBy: ['W1'], taskId: 'task-2', subject: 'review pass' })],
  })
  const team = makeTeam({
    tasks: [
      { id: 'task-1', revision: 2, status: 'completed', subject: 'do the work', ownerName: 'impl' },
      { id: 'task-2', revision: 1, status: 'pending', subject: 'review pass', ownerName: 'rev' },
    ],
  })
  const snapshot = buildSnapshot(makeInput(state, { team }))
  const run = snapshot.run
  assert.deepEqual(run.waves, [['W1'], ['W2']])
  assert.deepEqual(run.items.map((item) => item.wave), [1, 2])
  assertWavesConsistent(run)
  assert.deepEqual(run.items[0].task, { id: 'task-1', revision: 2, status: 'completed' })
  assert.deepEqual(run.items[1].task, { id: 'task-2', revision: 1, status: 'pending' })
  assert.deepEqual(run.items[1].blockedBy, ['W1'])

  // computeWaves itself is order-independent and 1-indexed.
  const direct = computeWaves([{ id: 'W2', blockedBy: ['W1'] }, { id: 'W1' }])
  assert.deepEqual(direct.waves, [['W1'], ['W2']])
  assert.deepEqual(direct.waveOf, { W1: 1, W2: 2 })
  assert.deepEqual(direct.cycle, [])

  // A task id that is not on the board still yields a null task, not a crash.
  const orphan = buildSnapshot(makeInput(makeState({ items: [makeItem({ id: 'W9', taskId: 'task-missing' })] })))
  assert.equal(orphan.run.items[0].task, null)
})

test('a dependency cycle degrades to wave 0 with a warning instead of throwing', () => {
  const items = [
    makeItem({ id: 'A', blockedBy: ['B'] }),
    makeItem({ id: 'B', blockedBy: ['A'] }),
    makeItem({ id: 'C', blockedBy: ['A'] }),
  ]
  const snapshot = buildSnapshot(makeInput(makeState({ items })))
  assert.equal(snapshot.ok, true)
  assert.deepEqual(snapshot.run.waves, [])
  assert.deepEqual(snapshot.run.items.map((item) => item.wave), [0, 0, 0])
  assert.ok(snapshot.diagnostics.warnings.some((warning) => /dependency cycle/i.test(warning)))

  const direct = computeWaves([
    { id: 'A', blockedBy: ['B'] },
    { id: 'B', blockedBy: ['A'] },
    { id: 'C', blockedBy: ['A'] },
  ])
  assert.deepEqual([...direct.cycle].sort(), ['A', 'B', 'C'])
  assert.deepEqual(computeWaves([{ id: 'S', blockedBy: ['S'] }]), { waves: [], waveOf: { S: 0 }, cycle: ['S'] })
  assert.deepEqual(computeWaves(), { waves: [], waveOf: {}, cycle: [] })
  // A blocker that is not on the board cannot gate anything.
  assert.deepEqual(computeWaves([{ id: 'W1', blockedBy: ['ghost'] }]).waveOf, { W1: 1 })
})

test('normalizeItemStatus covers the blackboard × native-task matrix', () => {
  const cases = [
    [{ status: 'pending' }, null, 'pending'],
    [{ status: 'pending' }, { status: 'in_progress' }, 'running'],
    [{ status: 'running' }, { status: 'in_progress' }, 'running'],
    [{ status: 'running' }, null, 'running'],
    [{ status: 'reported' }, null, 'in_review'],
    [{ status: 'in_review' }, { status: 'completed' }, 'in_review'],
    [{ status: 'changes_requested' }, { status: 'completed' }, 'changes_requested'],
    [{ status: 'approved' }, { status: 'completed' }, 'approved'],
    [{ status: 'escalated' }, { status: 'completed' }, 'escalated'],
    [{ status: 'pending', report: { summary: 'done' } }, { status: 'in_progress' }, 'in_review'],
    [{ status: 'running', report: { summary: 'done' } }, null, 'in_review'],
    [{}, null, 'pending'],
    [{ status: 'PENDING' }, { status: 'IN_PROGRESS' }, 'running'],
    [null, null, 'pending'],
    ['not-an-item', 'not-a-task', 'pending'],
  ]
  for (const [item, task, expected] of cases) {
    assert.equal(normalizeItemStatus(item, task), expected, `normalizeItemStatus(${JSON.stringify(item)}, ${JSON.stringify(task)})`)
  }
  assert.equal(normalizeStatus, normalizeItemStatus)

  const state = makeState({
    items: [makeItem({ id: 'W1', status: 'pending', taskId: 'task-1' })],
  })
  const snapshot = buildSnapshot(
    makeInput(state, {
      team: makeTeam({ tasks: [{ id: 'task-1', revision: 1, status: 'in_progress', subject: 'work', ownerName: 'impl' }] }),
    }),
  )
  assert.equal(snapshot.run.items[0].status, 'running')
})

test('review records keep verdicts, findings resolutions, and open findings', () => {
  const reviews = [
    makeReview({
      round: 1,
      reportSeq: 1,
      reviewer: 'rev',
      verdict: 'request_changes',
      summary: 'needs fixes',
      findings: [
        makeFinding({ id: 'F1', severity: 'major', resolution: null }),
        makeFinding({ id: 'F2', severity: 'nit', resolution: { state: 'fixed', evidence: 'diff', note: null, at: NOW, by: 'impl' } }),
      ],
    }),
    makeReview({ round: 2, reportSeq: 1, reviewer: 'rev', status: 'pending', verdict: null, summary: '', findings: [], evidenceChecked: [], submittedAt: null }),
    makeReview({ round: 3, reportSeq: 1, reviewer: 'other', status: 'superseded', verdict: null, summary: 'stale', findings: [], submittedAt: null }),
    makeReview({
      round: 4,
      reportSeq: 2,
      reviewer: 'rev',
      verdict: 'approve',
      summary: 'now fine',
      findings: [makeFinding({ id: 'F3', severity: 'nit', resolution: { state: 'accepted_by_reviewer', at: NOW, by: 'rev' } })],
    }),
  ]
  const state = makeState({
    items: [makeItem({ id: 'W1', status: 'in_review', reportSeq: 2, reworkTotal: 1, reviews })],
  })
  const item = buildSnapshot(makeInput(state)).run.items[0]

  assert.equal(item.status, 'in_review')
  // Only submitted verdicts are surfaced, in board order.
  assert.deepEqual(item.reviews.verdicts, [
    { reviewer: 'rev', verdict: 'request_changes', round: 1, reportSeq: 1 },
    { reviewer: 'rev', verdict: 'approve', round: 4, reportSeq: 2 },
  ])
  assert.equal(item.reviews.submittedRounds, 2)
  assert.equal(item.reviews.reworkRounds, 1)
  assert.equal(item.reviews.maxRounds, 2)
  assert.equal(item.reviews.pendingReviewer, 'rev')

  // Every status is kept in `records`; the resolution collapses to its state.
  assert.deepEqual(
    item.reviews.records.map((record) => record.status),
    ['submitted', 'pending', 'superseded', 'submitted'],
  )
  assert.deepEqual(
    item.reviews.records[0].findings.map((finding) => finding.resolution),
    [null, 'fixed'],
  )
  assert.equal(item.reviews.records[3].findings[0].resolution, 'accepted_by_reviewer')
  assert.deepEqual(item.reviews.records[0].findings[0], {
    id: 'F1',
    severity: 'major',
    file: 'lib/dashboard.js',
    line: 12,
    claim: 'missing guard',
    resolution: null,
  })

  // F1 is the only finding without a resolution; approving findings are
  // engine-marked as accepted and must not be filtered a second time.
  assert.equal(item.openFindings, 1)
})

test('counts are consistent with the serialized items', () => {
  const items = [
    makeItem({ id: 'W1', status: 'approved' }),
    makeItem({ id: 'W2', status: 'in_review' }),
    makeItem({ id: 'W3', status: 'running' }),
    makeItem({ id: 'W4', status: 'pending', taskId: 'task-4' }),
    makeItem({ id: 'W5', status: 'changes_requested' }),
    makeItem({ id: 'W6', status: 'escalated' }),
  ]
  const team = makeTeam({
    tasks: [{ id: 'task-4', revision: 1, status: 'in_progress', subject: 'work', ownerName: 'impl' }],
  })
  const run = buildSnapshot(makeInput(makeState({ items }), { team })).run
  assert.deepEqual(
    run.items.map((item) => item.status),
    ['approved', 'in_review', 'running', 'running', 'changes_requested', 'escalated'],
  )
  // `pending` carries both pending and running: the contract has no running bucket.
  assert.deepEqual(run.counts, { total: 6, approved: 1, pending: 2, inReview: 1, changesRequested: 1, escalated: 1 })
  assertCountsConsistent(run)
})

test('items, events, members, and records are truncated to their ceilings', () => {
  const events = Array.from({ length: 300 }, (_, index) => ({
    at: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
    type: 'item/reported',
    actor: 'impl',
    detail: `event-${index}`,
  }))
  const members = Array.from({ length: 20 }, (_, index) => ({ name: `member-${index}`, role: 'teammate', status: 'inactive', context: 'fresh' }))
  const manyReviews = Array.from({ length: 20 }, (_, index) => makeReview({ round: index + 1, reviewer: 'rev' }))
  const items = [
    makeItem({ id: 'W1', reviews: manyReviews }),
    ...Array.from({ length: 64 }, (_, index) => makeItem({ id: `W${index + 2}` })),
  ]
  assert.equal(items.length, 65)
  const snapshot = buildSnapshot(makeInput(makeState({ items, events }), { team: makeTeam({ members }) }))
  const run = snapshot.run

  assert.equal(run.items.length, 64)
  assert.equal(run.items.at(-1).id, 'W64')
  assertWavesConsistent(run)

  assert.equal(run.events.length, 200)
  assert.equal(run.events[0].detail, 'event-100')
  assert.equal(run.events.at(-1).detail, 'event-299')

  assert.equal(snapshot.team.members.length, 16)

  assert.equal(run.items[0].reviews.records.length, 12)
  assert.equal(run.items[0].reviews.records[0].round, 9)
  assert.equal(run.items[0].reviews.records.at(-1).round, 20)
  assert.equal(run.items[0].reviews.verdicts.length, 12)

  assert.ok(snapshot.diagnostics.warnings.some((warning) => /work items truncated/i.test(warning)))
  assert.ok(snapshot.diagnostics.warnings.some((warning) => /events truncated/i.test(warning)))
  assert.ok(snapshot.diagnostics.warnings.some((warning) => /roster truncated/i.test(warning)))
  assertCountsConsistent(run)
})

test('long text fields are clipped, never thrown on', () => {
  const state = makeState({
    objective: 'x'.repeat(5000),
    items: [
      makeItem({
        id: 'W1',
        report: {
          summary: 'y'.repeat(5000),
          files: ['lib/dashboard.js'],
          commands: [
            { command: 'node --test test/dashboard.test.mjs', exitCode: 0, note: null },
            { command: 'node --check lib/dashboard.js', exitCode: 0, note: 'syntax' },
          ],
          evidence: ['ok'],
          risks: [],
          openQuestions: [],
          deviation: null,
          submittedAt: NOW,
        },
      }),
    ],
    events: [{ at: NOW, type: 'item/reported', actor: 'impl', detail: 'z'.repeat(1200) }],
  })
  const run = buildSnapshot(makeInput(state)).run
  assert.equal(run.objective, `${'x'.repeat(4000)}…`)
  assert.equal(run.items[0].report.summary, `${'y'.repeat(4000)}…`)
  assert.equal(run.events[0].detail, `${'z'.repeat(500)}…`)
  assert.equal(run.events[0].detail.length, 501)
  assert.deepEqual(run.items[0].report.commands, [
    { command: 'node --test test/dashboard.test.mjs', exitCode: 0, note: null },
    { command: 'node --check lib/dashboard.js', exitCode: 0, note: 'syntax' },
  ])
  assert.deepEqual(run.items[0].report.files, ['lib/dashboard.js'])
})

test('gate and escalations pass through every engine field (including waived)', () => {
  const gate = {
    pass: true,
    evaluatedAt: NOW,
    itemGates: [
      {
        id: 'W1',
        pass: true,
        overridden: true,
        overrideReason: 'accepted without a final command rerun',
        waived: ['no verification command recorded'],
        failures: ['no verification command recorded'],
        warnings: ['backing Team task pending'],
      },
    ],
    teamFailures: [],
    blockingEscalations: [],
  }
  const escalations = [
    {
      id: 'esc-1',
      kind: 'conflict',
      subject: 'Two items claim the same file',
      detail: 'W1 and W2 both write lib/dashboard.js',
      blocking: false,
      itemId: 'W1',
      createdBy: 'impl',
      createdAt: NOW,
      resolved: true,
      resolution: 'Lead split the scopes',
      resolvedBy: 'lead',
      resolvedAt: NOW,
    },
  ]
  const state = makeState({ items: [makeItem({ status: 'approved' })], gate, escalations })
  const run = buildSnapshot(makeInput(state)).run
  assert.deepEqual(run.gate, gate)
  assert.deepEqual(run.escalations, escalations)
  assert.equal(run.gate.itemGates[0].waived[0], 'no verification command recorded')
  assert.equal(run.escalations[0].resolved, true)
  assert.equal(run.escalations[0].resolvedBy, 'lead')

  const empty = buildSnapshot(makeInput(makeState())).run
  assert.equal(empty.gate, null)
  assert.deepEqual(empty.escalations, [])
})

test('events are ordered ascending and bounded by tailEvents', () => {
  const events = [
    { at: '2026-11-01T00:00:03.000Z', type: 'review/submitted', actor: 'rev', detail: 'third' },
    { at: '2026-11-01T00:00:01.000Z', type: 'run/planned', actor: 'lead', detail: 'first' },
    { at: '2026-11-01T00:00:02.000Z', type: 'item/reported', actor: 'impl', detail: 'second' },
  ]
  assert.deepEqual(
    tailEvents(events).map((event) => event.detail),
    ['first', 'second', 'third'],
  )
  assert.deepEqual(
    tailEvents(events, 2).map((event) => event.detail),
    ['second', 'third'],
  )
  assert.deepEqual(tailEvents(events, 0), [])
  assert.deepEqual(tailEvents(undefined), [])
  assert.deepEqual(tailEvents('not-an-array'), [])
  // Equal timestamps keep the append order, so the board does not flicker.
  const tied = [
    { at: NOW, detail: 'a' },
    { at: NOW, detail: 'b' },
  ]
  assert.deepEqual(
    tailEvents(tied).map((event) => event.detail),
    ['a', 'b'],
  )

  const run = buildSnapshot(makeInput(makeState({ events }))).run
  assert.deepEqual(
    run.events.map((event) => event.detail),
    ['first', 'second', 'third'],
  )
  const times = run.events.map((event) => Date.parse(event.at))
  assert.deepEqual(times, [...times].sort((left, right) => left - right))
  assert.deepEqual(run.events[0], { at: '2026-11-01T00:00:01.000Z', type: 'run/planned', actor: 'lead', detail: 'first' })
})

test('missing or malformed input degrades instead of throwing', () => {
  const empty = buildSnapshot()
  assert.equal(empty.ok, true)
  assert.equal(empty.run, null)
  assert.deepEqual(empty.team, { me: null, members: [], tasks: [] })
  assert.equal(empty.diagnostics.boardSource, 'missing')
  assert.deepEqual(empty.diagnostics.warnings, [])
  assert.equal(Number.isNaN(Date.parse(empty.generatedAt)), false)

  const garbage = buildSnapshot({ state: 'not-a-run', team: 42, artifacts: [], now: 123, diagnostics: null })
  assert.equal(garbage.run, null)
  assert.equal(garbage.team.me, null)
  assert.equal(Number.isNaN(Date.parse(garbage.generatedAt)), false)

  for (const value of [null, undefined, 0, false]) {
    assert.equal(buildSnapshot(value).ok, true)
  }

  // Broken fields inside a real run: no throw, nulls/empties instead.
  const broken = buildSnapshot({
    state: {
      runId: 7,
      phase: 42,
      objective: { nope: true },
      items: [
        null,
        {},
        'ghost',
        { id: 'W9', status: 7, blockedBy: 'nope', reviews: 'nope', report: 'nope', writeScopes: 12 },
        { id: 'W9', status: 'pending' },
      ],
      settings: 'nope',
      gate: 'nope',
      escalations: [null, 'nope'],
      events: [null, { detail: 99 }],
      artifacts: null,
    },
    team: { me: 'nope', members: [null, 3], tasks: [null, { id: 5 }] },
    artifacts: { root: 5, statePath: STATE_PATH },
    now: {},
    diagnostics: { boardSource: 12, warnings: 'nope' },
  })
  assert.equal(broken.ok, true)
  assert.equal(broken.run.id, '7')
  assert.equal(broken.run.objective, '')
  assert.equal(broken.run.items.length, 1)
  assert.equal(broken.run.items[0].id, 'W9')
  assert.deepEqual(broken.run.items[0].reviews, {
    reworkRounds: 0,
    submittedRounds: 0,
    maxRounds: null,
    pendingReviewer: null,
    verdicts: [],
    records: [],
  })
  assert.equal(broken.run.items[0].report, null)
  assert.equal(broken.run.items[0].status, 'pending')
  assert.equal(broken.run.gate, null)
  assert.deepEqual(broken.run.escalations, [])
  assert.equal(broken.run.events.length, 1)
  assert.equal(broken.run.events[0].detail, '99')
  assert.equal(broken.run.artifacts.root, null)
  assert.equal(broken.run.artifacts.statePath, STATE_PATH)
  assert.equal(broken.diagnostics.boardSource, 'file')

  // Ill-typed gate/escalation fields still normalize to contract types.
  const illTyped = buildSnapshot(
    makeInput(
      makeState({
        gate: { pass: 'yes', evaluatedAt: 5, itemGates: [{ id: 1, pass: 1, overridden: 'no', overrideReason: { x: 1 }, waived: 'nope' }], teamFailures: null },
        escalations: [{ id: 'e1', resolved: 'yes', resolution: { state: 'x' } }],
      }),
    ),
  ).run
  assert.deepEqual(illTyped.gate, {
    pass: false,
    evaluatedAt: null,
    itemGates: [{ id: '1', pass: false, overridden: false, overrideReason: null, waived: [], failures: [], warnings: [] }],
    teamFailures: [],
    blockingEscalations: [],
  })
  assert.equal(illTyped.escalations[0].resolved, false)
  assert.equal(illTyped.escalations[0].resolution, null)
  assert.equal(broken.team.me, null)
  assert.equal(broken.team.members.length, 0)
  assert.equal(broken.team.tasks[0].id, '5')
})

test('artifacts come from the route and fall back to the blackboard', () => {
  const state = makeState({ artifacts: { root: ARTIFACT_ROOT, statePath: STATE_PATH, reportPath: null } })
  const fromRoute = buildSnapshot(
    makeInput(state, { artifacts: { root: '/route/root', statePath: '/route/state.json', reportPath: REPORT_PATH } }),
  )
  assert.deepEqual(fromRoute.run.artifacts, { root: '/route/root', statePath: '/route/state.json', reportPath: REPORT_PATH })

  const fromState = buildSnapshot({
    state,
    team: makeTeam(),
    now: NOW,
    diagnostics: { boardSource: 'file', warnings: [] },
  })
  assert.deepEqual(fromState.run.artifacts, { root: ARTIFACT_ROOT, statePath: STATE_PATH, reportPath: null })
})

test('sessionId falls back to the board team id when the route omits it', () => {
  const state = makeState({ teamId: 'session-lead' })
  const withoutSession = { ...makeInput(state) }
  delete withoutSession.sessionId
  assert.equal(buildSnapshot(withoutSession).sessionId, 'session-lead')
  // An explicit conversation id still wins.
  assert.equal(buildSnapshot(makeInput(state, { sessionId: 'session-worker' })).sessionId, 'session-worker')
  // No board and no explicit id is null, not a guess.
  assert.equal(buildSnapshot({ state: null, team: makeTeam(), now: NOW }).sessionId, null)
})

test('buildSnapshot is deterministic for a given input', () => {
  const state = makeState({
    items: [
      makeItem({ id: 'W1', status: 'approved', taskId: 'task-1' }),
      makeItem({ id: 'W2', blockedBy: ['W1'], status: 'in_review', taskId: 'task-2' }),
    ],
    events: [{ at: NOW, type: 'run/planned', actor: 'lead', detail: 'planned 2 work item(s)' }],
  })
  const input = makeInput(state, {
    team: makeTeam({ tasks: [{ id: 'task-1', revision: 1, status: 'completed', subject: 'one', ownerName: 'impl' }] }),
  })
  assert.deepEqual(buildSnapshot(input), buildSnapshot(input))
  assert.deepEqual(JSON.parse(JSON.stringify(buildSnapshot(input))), buildSnapshot(input))

  // Collaboration data must be just as deterministic (sorting, ranking, caps).
  const collaborative = makeState({
    items: [makeItem({ id: 'W1', assignment: 'open', owner: null, claim: makeClaim() })],
    channel: [
      makeMessage({ id: 'm2', at: '2026-11-02T00:00:02.000Z', from: 'impl', to: 'team', kind: 'question', refs: { itemId: 'W1' } }),
      makeMessage({ id: 'm1', at: '2026-11-02T00:00:01.000Z', from: 'rev', to: 'impl', kind: 'answer', refs: { itemId: 'W1' } }),
    ],
    proposals: [makeProposal({ id: 'p1', itemId: 'W1', votes: [makeVote({ by: 'impl' }), makeVote({ by: 'rev', vote: 'no' })] })],
  })
  const collaborativeInput = makeInput(collaborative)
  assert.deepEqual(buildSnapshot(collaborativeInput), buildSnapshot(collaborativeInput))
})

// ---------------------------------------------------------------------------
// Peer collaboration (docs/12 §5, snapshot version 2)
// ---------------------------------------------------------------------------

test('a version-1 board yields an empty collaboration block and v2 item defaults', () => {
  const run = buildSnapshot(makeInput(makeState({ items: [makeItem()] }))).run
  // Never null: the client can render the collaboration panels unconditionally.
  assert.deepEqual(run.collaboration, EMPTY_COLLABORATION)
  const item = run.items[0]
  assert.equal(item.assignment, 'lead')
  assert.equal(item.claim, null)
  assert.deepEqual(item.reviewRequests, [])
  assert.deepEqual(item.handoffs, [])
  assert.deepEqual(item.thread, [])
  assert.equal(item.openProposals, 0)
  // An unknown assignment degrades to the documented v1 default.
  const weird = buildSnapshot(makeInput(makeState({ items: [makeItem({ assignment: 'volunteer' })] }))).run
  assert.equal(weird.items[0].assignment, 'lead')
})

test('channel messages keep their refs, sort ascending, and clip text at 500', () => {
  const channel = [
    makeMessage({
      id: 'm2',
      at: '2026-11-02T00:00:02.000Z',
      from: 'rev',
      to: 'impl',
      kind: 'answer',
      text: 'x'.repeat(600),
      replyTo: 'm1',
      refs: { itemId: 'W1', findingId: 'F1' },
    }),
    makeMessage({ id: 'm1', at: '2026-11-02T00:00:01.000Z', from: 'impl', to: 'team', kind: 'question', text: 'why?', refs: { itemId: 'W1' } }),
    makeMessage({ id: 'm3', at: '2026-11-02T00:00:03.000Z', from: 'lead', to: 'impl', refs: { proposalId: 'p1' } }),
  ]
  const messages = buildSnapshot(makeInput(makeState({ channel, items: [makeItem()] }))).run.collaboration.channel
  assert.deepEqual(
    messages.map((message) => message.id),
    ['m1', 'm2', 'm3'],
  )
  assert.deepEqual(messages[0], {
    id: 'm1',
    at: '2026-11-02T00:00:01.000Z',
    from: 'impl',
    to: 'team',
    kind: 'question',
    text: 'why?',
    itemId: 'W1',
    findingId: null,
    proposalId: null,
    replyTo: null,
  })
  assert.equal(messages[1].text, `${'x'.repeat(500)}…`)
  assert.equal(messages[1].findingId, 'F1')
  assert.equal(messages[1].replyTo, 'm1')
  assert.equal(messages[2].kind, 'note')
  assert.equal(messages[2].proposalId, 'p1')
  assert.equal(messages[2].itemId, null)
})

test('channel keeps the most recent 60 messages and warns about the truncation', () => {
  const channel = Array.from({ length: 70 }, (_, index) =>
    makeMessage({
      id: `m${index + 1}`,
      at: new Date(Date.UTC(2026, 10, 2, 0, 0, index)).toISOString(),
      text: `message-${index + 1}`,
    }),
  )
  const snapshot = buildSnapshot(makeInput(makeState({ channel })))
  const messages = snapshot.run.collaboration.channel
  assert.equal(messages.length, 60)
  assert.equal(messages[0].id, 'm11')
  assert.equal(messages.at(-1).id, 'm70')
  const times = messages.map((message) => Date.parse(message.at))
  assert.deepEqual(times, [...times].sort((left, right) => left - right))
  assert.ok(snapshot.diagnostics.warnings.some((warning) => /collaboration channel truncated/.test(warning)))
})

test('proposal tallies count votes and the right affected electorate', () => {
  const items = [makeItem({ id: 'W1', owner: 'impl', reviewers: ['rev', 'rev'] })]
  const proposals = [
    makeProposal({
      id: 'p1',
      itemId: 'W1',
      votes: [makeVote({ by: 'rev', vote: 'yes' }), makeVote({ by: 'impl', vote: 'no' })],
    }),
    makeProposal({ id: 'p2', kind: 'scope', itemId: null, votes: [makeVote({ by: 'lead', vote: 'abstain' }), makeVote({ by: 'impl', vote: 'yes' })] }),
    makeProposal({ id: 'p3', itemId: 'ghost', status: 'accepted', votes: [] }),
  ]
  const proposalsOut = buildSnapshot(makeInput(makeState({ items, proposals }))).run.collaboration.proposals
  // An item proposal affects owner + reviewers (de-duplicated): impl + rev = 2.
  assert.deepEqual(proposalsOut[0].tally, { yes: 1, no: 1, abstain: 0, affected: 2, total: 2 })
  assert.deepEqual(
    proposalsOut[0].votes.map((vote) => `${vote.by}:${vote.vote}`),
    ['rev:yes', 'impl:no'],
  )
  // A team-wide proposal affects the whole roster; an unknown item degrades to that too.
  assert.deepEqual(proposalsOut[1].tally, { yes: 1, no: 0, abstain: 1, affected: 3, total: 2 })
  assert.deepEqual(proposalsOut[2].tally, { yes: 0, no: 0, abstain: 0, affected: 3, total: 0 })
  assert.equal(proposalsOut[2].status, 'accepted')
})

test('proposals and votes are capped with diagnostics warnings', () => {
  const proposals = Array.from({ length: 35 }, (_, index) => makeProposal({ id: `p${index + 1}` }))
  proposals[34].votes = Array.from({ length: 20 }, (_, index) => makeVote({ by: `voter-${index}` }))
  const snapshot = buildSnapshot(makeInput(makeState({ proposals })))
  const proposalsOut = snapshot.run.collaboration.proposals
  assert.equal(proposalsOut.length, 32)
  assert.equal(proposalsOut[0].id, 'p4')
  assert.equal(proposalsOut.at(-1).id, 'p35')
  assert.equal(proposalsOut.at(-1).votes.length, 16)
  // The tally is authoritative: it counts every (de-duplicated) vote, not just
  // the votes the display cap kept.
  assert.equal(proposalsOut.at(-1).tally.total, 20)
  assert.ok(snapshot.diagnostics.warnings.some((warning) => /collaboration proposals truncated/.test(warning)))
  assert.ok(snapshot.diagnostics.warnings.some((warning) => /proposal votes truncated/.test(warning)))
})

test('collaboration edges count direct messages and expand broadcasts', () => {
  const channel = [
    makeMessage({ id: 'm1', at: '2026-11-02T00:00:01.000Z', from: 'impl', to: 'rev', kind: 'question' }),
    makeMessage({ id: 'm2', at: '2026-11-02T00:00:02.000Z', from: 'impl', to: 'rev', kind: 'answer' }),
    makeMessage({ id: 'm3', at: '2026-11-02T00:00:03.000Z', from: 'impl', to: 'team', kind: 'status' }),
    makeMessage({ id: 'm4', at: '2026-11-02T00:00:04.000Z', from: 'lead', to: 'impl', kind: 'ack' }),
    makeMessage({ id: 'm5', at: '2026-11-02T00:00:05.000Z', from: 'impl', to: 'impl', kind: 'note' }),
    makeMessage({ id: 'm6', at: '2026-11-02T00:00:06.000Z', from: 'rev', to: 'team', kind: 'handoff' }),
    // Engine notices are posted as 'system'; they are not peers and own no node
    // in the topology, so they must not produce an edge.
    makeMessage({ id: 'm7', at: '2026-11-02T00:00:07.000Z', from: 'system', to: 'team', kind: 'status' }),
    // A concrete target that is not on the roster is not a drawable node either.
    makeMessage({ id: 'm8', at: '2026-11-02T00:00:08.000Z', from: 'impl', to: 'ghost', kind: 'question' }),
  ]
  const edges = buildSnapshot(makeInput(makeState({ channel }))).run.collaboration.edges
  // impl → rev: 2 direct messages + 1 broadcast; broadcast edges fan out to
  // every other roster member; the self message is dropped; ranking is by count.
  assert.deepEqual(edges, [
    { from: 'impl', to: 'rev', count: 3, kinds: ['answer', 'question', 'status'] },
    { from: 'impl', to: 'lead', count: 1, kinds: ['status'] },
    { from: 'lead', to: 'impl', count: 1, kinds: ['ack'] },
    { from: 'rev', to: 'impl', count: 1, kinds: ['handoff'] },
    { from: 'rev', to: 'lead', count: 1, kinds: ['handoff'] },
  ])
})

test('collaboration edges are capped and ranked by count', () => {
  const names = Array.from({ length: 9 }, (_, index) => `m${index}`)
  const members = names.map((name, index) => ({ name, role: index === 0 ? 'lead' : 'teammate', status: 'running', context: 'fresh' }))
  const channel = []
  let sequence = 0
  for (const from of names) {
    for (const to of names) {
      if (from === to) continue
      sequence += 1
      channel.push(makeMessage({ id: `m${sequence}`, at: new Date(Date.UTC(2026, 10, 2, 0, 0, sequence)).toISOString(), from, to }))
    }
  }
  // 9 members produce 9 * 8 = 72 distinct directed edges.
  const snapshot = buildSnapshot(makeInput(makeState({ channel }), { team: makeTeam({ me: { name: 'm0', role: 'lead' }, members }) }))
  const edges = snapshot.run.collaboration.edges
  assert.equal(edges.length, 64)
  assert.deepEqual(edges[0], { from: 'm0', to: 'm1', count: 1, kinds: ['note'] })
  assert.deepEqual(edges.at(-1), { from: 'm7', to: 'm8', count: 1, kinds: ['note'] })
  assert.ok(snapshot.diagnostics.warnings.some((warning) => /collaboration edges truncated/.test(warning)))
})

test('open queue, pending review requests, and handoffs keep only live entries', () => {
  const items = [
    makeItem({ id: 'W1', owner: null, assignment: 'open', status: 'pending' }),
    makeItem({ id: 'W2', owner: 'impl', assignment: 'open', status: 'pending' }),
    makeItem({ id: 'W3', owner: null, assignment: 'open', status: 'in_review' }),
    makeItem({
      id: 'W4',
      owner: null,
      assignment: 'lead',
      status: 'pending',
      pendingReviewer: 'rev',
      reviewRequests: [makeReviewRequest({ by: 'impl', reviewer: 'rev', at: NOW })],
    }),
    makeItem({ id: 'W5', status: 'pending', reviewRequests: [makeReviewRequest({ by: 'lead', reviewer: null, at: NOW })] }),
    makeItem({ id: 'W6', status: 'in_review', reviews: [makeReview({ status: 'pending', reviewer: 'rev' })] }),
    makeItem({ id: 'W7', reviewRequests: [makeReviewRequest({ status: 'accepted' })] }),
  ]
  const run = buildSnapshot(makeInput(makeState({ items }))).run
  assert.deepEqual(run.collaboration.openQueue, ['W1'])
  assert.deepEqual(run.collaboration.pendingReviews, [
    { itemId: 'W4', requestedBy: 'impl', reviewer: 'rev', at: NOW },
    { itemId: 'W5', requestedBy: 'lead', reviewer: null, at: NOW },
    { itemId: 'W6', requestedBy: null, reviewer: 'rev', at: null },
  ])
  // Only 'offered' transfers surface at the run level, ascending by time.
  const handoffItems = [
    makeItem({
      id: 'W1',
      handoffs: [
        makeItemHandoff({ to: 'rev', at: '2026-11-02T00:00:01.000Z' }),
        makeItemHandoff({ to: 'lead', status: 'accepted', at: '2026-11-02T00:00:02.000Z' }),
      ],
    }),
    makeItem({ id: 'W2', handoffs: [makeItemHandoff({ by: 'rev', to: 'impl', at: '2026-11-02T00:00:03.000Z' })] }),
  ]
  const handoffRun = buildSnapshot(makeInput(makeState({ items: handoffItems }))).run
  assert.deepEqual(handoffRun.collaboration.handoffs, [
    { itemId: 'W1', by: 'impl', to: 'rev', reason: 'hand over', status: 'offered', at: '2026-11-02T00:00:01.000Z' },
    { itemId: 'W2', by: 'rev', to: 'impl', reason: 'hand over', status: 'offered', at: '2026-11-02T00:00:03.000Z' },
  ])
  // The item itself keeps every transfer status for the detail drawer.
  assert.equal(handoffRun.items[0].handoffs.length, 2)
  assert.equal(handoffRun.items[0].handoffs[1].status, 'accepted')
})

test('items expose their channel thread and open proposal count', () => {
  const channel = [
    makeMessage({ id: 'm1', refs: { itemId: 'W1' } }),
    makeMessage({ id: 'm2', refs: { itemId: 'W1' } }),
    makeMessage({ id: 'm3', refs: { itemId: 'W2' } }),
    makeMessage({ id: 'm4', refs: {} }),
  ]
  const proposals = [
    makeProposal({ id: 'p1', itemId: 'W1', status: 'open' }),
    makeProposal({ id: 'p2', itemId: 'W1', status: 'open' }),
    makeProposal({ id: 'p3', itemId: 'W1', status: 'accepted' }),
    makeProposal({ id: 'p4', itemId: 'W2', status: 'open' }),
    // A non-blocking team-wide proposal is tracked, but it does not block items.
    makeProposal({ id: 'p5', kind: 'review_policy', itemId: null, status: 'open' }),
    // A blocking team-wide proposal blocks every item (engine openBlockingProposals).
    makeProposal({ id: 'p6', kind: 'replan', itemId: null, status: 'open' }),
    // An escalated (tied) blocking proposal still blocks its item until the
    // Lead arbitrates; a resolved non-blocking one never does.
    makeProposal({ id: 'p7', kind: 'scope', itemId: 'W1', status: 'escalated' }),
    makeProposal({ id: 'p8', kind: 'handoff', itemId: 'W1', status: 'open' }),
  ]
  const items = [makeItem({ id: 'W1' }), makeItem({ id: 'W2' })]
  const run = buildSnapshot(makeInput(makeState({ items, channel, proposals }))).run
  assert.deepEqual(
    run.items[0].thread.map((message) => message.id),
    ['m1', 'm2'],
  )
  assert.deepEqual(
    run.items[1].thread.map((message) => message.id),
    ['m3'],
  )
  // W1: p1 + p2 (open) + p6 (blocking team-wide) + p7 (escalated);
  // p3 is accepted, p5 is review_policy, p8 is a non-blocking handoff.
  assert.equal(run.items[0].openProposals, 4)
  // W2: p4 + p6; p7 targets W1 only.
  assert.equal(run.items[1].openProposals, 2)
})

test('item threads are capped at 20 with a diagnostics warning', () => {
  const channel = Array.from({ length: 25 }, (_, index) =>
    makeMessage({ id: `m${index + 1}`, at: new Date(Date.UTC(2026, 10, 2, 0, 0, index)).toISOString(), refs: { itemId: 'W1' } }),
  )
  const snapshot = buildSnapshot(makeInput(makeState({ items: [makeItem({ id: 'W1' })], channel })))
  const thread = snapshot.run.items[0].thread
  assert.equal(thread.length, 20)
  assert.equal(thread[0].id, 'm6')
  assert.equal(thread.at(-1).id, 'm25')
  assert.ok(snapshot.diagnostics.warnings.some((warning) => /item threads truncated/.test(warning)))
})

test('item collaboration records are normalized for the drawer', () => {
  const item = makeItem({
    id: 'W1',
    assignment: 'open',
    claim: makeClaim({ by: 'impl', leaseMinutes: null, note: 'mine', at: NOW }),
    reviewRequests: [makeReviewRequest({ reviewer: null, status: 'accepted', respondedAt: NOW, response: 'on it' })],
    handoffs: [makeItemHandoff({ status: 'accepted', respondedAt: NOW })],
  })
  const snapshotItem = buildSnapshot(makeInput(makeState({ items: [item] }))).run.items[0]
  assert.equal(snapshotItem.assignment, 'open')
  assert.deepEqual(snapshotItem.claim, { by: 'impl', at: NOW, leaseMinutes: null, note: 'mine' })
  assert.deepEqual(snapshotItem.reviewRequests, [
    { by: 'impl', at: NOW, reviewer: null, status: 'accepted', respondedAt: NOW, response: 'on it' },
  ])
  assert.deepEqual(snapshotItem.handoffs, [
    { by: 'impl', at: NOW, to: 'rev', reason: 'hand over', status: 'accepted', respondedAt: NOW },
  ])
})

test('malformed collaboration data degrades instead of throwing', () => {
  const snapshot = buildSnapshot({
    state: {
      runId: 'run-bad',
      items: [
        { id: 'W1', assignment: 42, claim: 'nope', reviewRequests: 'nope', handoffs: [null, 3], status: 'pending', owner: null, reviewers: null },
        { id: 'W2', handoffs: { not: 'array' }, pendingReviewer: {}, reviews: 'nope' },
      ],
      channel: ['nope', null, { id: 3, at: 9, from: {}, to: [], kind: {}, text: 5, refs: 'x' }, { from: 'impl', to: 'team', kind: 'note', at: NOW }],
      proposals: [
        { id: 1, votes: 'nope' },
        { id: 'p2', itemId: 7, votes: [{ by: 'rev', vote: 'maybe', at: 5 }, 'x', null] },
      ],
      artifacts: null,
    },
    team: { me: null, members: [{ name: 'lead' }, { name: '' }, null], tasks: [] },
    now: NOW,
    diagnostics: { boardSource: 'file', warnings: [] },
  })
  assert.equal(snapshot.ok, true)
  const collaboration = snapshot.run.collaboration
  assert.equal(collaboration.channel.length, 2)
  const numeric = collaboration.channel.find((message) => message.text === '5')
  assert.ok(numeric !== undefined)
  assert.equal(numeric.kind, 'note')
  assert.equal(numeric.itemId, null)
  assert.equal(collaboration.proposals.length, 2)
  assert.deepEqual(
    collaboration.proposals[1].votes.map((vote) => [vote.by, vote.vote]),
    [['rev', 'maybe']],
  )
  // The engine tallies an unknown vote value as abstain and counts every vote.
  assert.deepEqual(collaboration.proposals[1].tally, { yes: 0, no: 0, abstain: 1, affected: 1, total: 1 })
  assert.deepEqual(collaboration.openQueue, [])
  // The roster only holds 'lead', so a message from a non-member sender cannot
  // become a topology edge once the sender is filtered out.
  assert.deepEqual(collaboration.edges, [])
  assert.equal(snapshot.run.items[0].assignment, 'lead')
  assert.equal(snapshot.run.items[0].claim, null)
  assert.deepEqual(snapshot.run.items[0].reviewRequests, [])
  assert.deepEqual(snapshot.run.items[0].handoffs, [])
  assert.equal(snapshot.run.items[1].assignment, 'lead')
  assert.equal(snapshot.run.items[1].claim, null)
})

test('items expose origin and createdBy for member-created work', () => {
  const items = [
    makeItem({ id: 'W1' }),
    makeItem({ id: 'S1', origin: 'member', createdBy: 'impl' }),
    makeItem({ id: 'S2', origin: 'weird', createdBy: 42 }),
  ]
  const run = buildSnapshot(makeInput(makeState({ items }))).run
  // Planned items keep the documented defaults.
  assert.equal(run.items[0].origin, 'plan')
  assert.equal(run.items[0].createdBy, null)
  // A member-created item is marked and attributes its author.
  assert.equal(run.items[1].origin, 'member')
  assert.equal(run.items[1].createdBy, 'impl')
  // Only the literal documented marker is trusted; everything else is a plan item.
  assert.equal(run.items[2].origin, 'plan')
  assert.equal(run.items[2].createdBy, null)
})

test('proposals expose deadline, quorum and the auto-resolution flag', () => {
  const items = [
    makeItem({ id: 'W1', owner: 'impl', reviewers: ['rev'] }),
    makeItem({ id: 'W2', owner: null, reviewers: [], assignment: 'open' }),
    makeItem({ id: 'W3', owner: 'impl', reviewers: [] }),
  ]
  const proposals = [
    makeProposal({
      id: 'p1',
      itemId: 'W1',
      status: 'accepted',
      deadline: '2026-11-02T02:00:00.000Z',
      quorum: 2,
      autoResolved: true,
      resolvedAt: NOW,
      resolution: 'deadline passed: yes won without a full ballot',
    }),
    makeProposal({ id: 'p2', itemId: 'W1' }),
    makeProposal({ id: 'p3', itemId: null }),
    makeProposal({ id: 'p4', itemId: 'W2' }),
    makeProposal({ id: 'p5', itemId: 'W3' }),
    makeProposal({ id: 'p6', itemId: 'W1', quorum: 0 }),
    makeProposal({ id: 'p7', itemId: 'W1', quorum: 3 }),
  ]
  const out = buildSnapshot(makeInput(makeState({ items, proposals }))).run.collaboration.proposals
  // Engine-written liveness fields pass through untouched.
  assert.equal(out[0].deadline, '2026-11-02T02:00:00.000Z')
  assert.equal(out[0].quorum, 2)
  assert.equal(out[0].autoResolved, true)
  assert.equal(out[0].resolution, 'deadline passed: yes won without a full ballot')
  // Older/pre-autonomy proposals: no deadline, not auto-resolved, derived quorum.
  assert.equal(out[1].deadline, null)
  assert.equal(out[1].autoResolved, false)
  assert.equal(out[1].quorum, 1) // affected 2 -> ceil(2 / 2) = 1
  // Team-wide proposal: the roster is 3 -> ceil(3 / 2) = 2.
  assert.equal(out[2].quorum, 2)
  // Affected 0 (unclaimed item, no reviewers) still requires the documented floor of 1.
  assert.equal(out[3].quorum, 1)
  // Affected 1 -> ceil(1 / 2) = 1.
  assert.equal(out[4].quorum, 1)
  // An engine-written quorum wins, but never below the documented floor.
  assert.equal(out[5].quorum, 1)
  assert.equal(out[6].quorum, 3)
})

test('a pre-autonomy board yields the documented autonomy defaults', () => {
  const state = makeState({
    settings: { maxReviewRounds: 2, proposalTimeoutMinutes: 15 },
    items: [makeItem({ id: 'W1' }), makeItem({ id: 'W2', assignment: 'open', owner: null })],
    channel: [makeMessage({ id: 'm1', refs: { itemId: 'W1' } })],
    proposals: [makeProposal({ id: 'p1', itemId: 'W1' }), makeProposal({ id: 'p2', itemId: null })],
  })
  const run = buildSnapshot(makeInput(state)).run
  assert.deepEqual(
    run.items.map((item) => [item.origin, item.createdBy]),
    [
      ['plan', null],
      ['plan', null],
    ],
  )
  assert.deepEqual(
    run.collaboration.proposals.map((proposal) => [proposal.deadline, proposal.autoResolved, proposal.quorum]),
    [
      [null, false, 1],
      [null, false, 2],
    ],
  )
  // docs/14 §4 freezes the timeout into run settings; the generic passthrough keeps it.
  assert.equal(run.settings.proposalTimeoutMinutes, 15)

  // A version-1 board has no proposals at all and still defaults the item fields.
  const v1Run = buildSnapshot(makeInput(makeState({ items: [makeItem()] }))).run
  assert.deepEqual(v1Run.collaboration, EMPTY_COLLABORATION)
  assert.equal(v1Run.items[0].origin, 'plan')
  assert.equal(v1Run.items[0].createdBy, null)
})

test('malformed autonomy fields degrade instead of throwing', () => {
  const snapshot = buildSnapshot({
    state: {
      runId: 'run-bad-2',
      items: [
        { id: 'W1', origin: { nope: 1 }, createdBy: [], owner: 'impl', reviewers: 'nope', status: 'pending' },
        { id: 'W2', origin: 7, createdBy: false },
        { id: 'W3' },
      ],
      proposals: [
        { id: 'p1', itemId: 'W1', deadline: 42, autoResolved: 'yes', quorum: 'many' },
        { id: 'p2', itemId: null, deadline: 'not-a-date', autoResolved: 1, quorum: 1.5, status: 'open', votes: 'nope' },
        { id: 'p3', itemId: 'ghost', deadline: null, autoResolved: true, quorum: -3, status: 'accepted' },
      ],
    },
    team: { me: { name: 'lead', role: 'lead' }, members: [{ name: 'lead' }, { name: 'impl' }, { name: 'rev' }], tasks: [] },
    now: NOW,
    diagnostics: { boardSource: 'file', warnings: [] },
  })
  assert.equal(snapshot.ok, true)
  const items = snapshot.run.items
  // Only a literal 'member' marker is trusted, and createdBy must be a name.
  for (const item of items) {
    assert.equal(item.origin, 'plan')
    assert.equal(item.createdBy, null)
  }
  const proposals = snapshot.run.collaboration.proposals
  assert.equal(proposals[0].deadline, null) // a non-string deadline is not an ISO timestamp
  assert.equal(proposals[0].autoResolved, false) // only the literal boolean true marks auto-resolution
  assert.equal(proposals[0].quorum, 1) // unparsable quorum -> affected 1 fallback, floor 1
  assert.equal(proposals[1].deadline, 'not-a-date') // strings are passed through; the client parses them
  assert.equal(proposals[1].autoResolved, false)
  assert.equal(proposals[1].quorum, 2) // team-wide, affected 3 -> ceil(3 / 2)
  assert.equal(proposals[2].autoResolved, true)
  assert.equal(proposals[2].quorum, 1) // negative quorum clamped to the documented floor
})
