/**
 * Offline unit tests for the pure dashboard snapshot aggregator.
 *
 * `lib/dashboard.js` has no imports at all — no Cordis, no filesystem, no
 * clock beyond the documented fallback — so the whole docs/09 §2 snapshot
 * contract can be exercised here with plain data. The cases below follow the
 * documented contract: empty board, waves and dependency cycles, status
 * normalization, review records and open findings, counts, truncation limits,
 * gate/escalation passthrough, event ordering, and defensive degradation.
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
  assert.equal(snapshot.version, 1)
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
})
