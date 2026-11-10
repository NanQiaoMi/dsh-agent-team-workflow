/**
 * Payload budgets for the token-efficiency plan (docs/40).
 *
 * These are hard regression gates: the model-facing status/brief payloads must
 * stay small enough that a member can poll them every step without flooding its
 * context. They pin the measured 2026-11-09 numbers so a later feature cannot
 * silently grow the hot path.
 */

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import { resolveSettings } from '../lib/config.js'
import { buildBriefStatus, buildStatus } from '../lib/workflow.js'
import { buildPolicy, renderQueueBrief, renderReportMarkdown, renderReviewerBrief, renderWorkerBrief } from '../lib/protocol.js'
import { buildSnapshot } from '../lib/dashboard.js'
import { computeUsage } from '../lib/telemetry.js'
import { createStore } from '../lib/store.js'
import { buildTools } from '../lib/tools.js'
import { filterToolsByRole, resolveAllowedToolNames } from '../lib/tool-matrix.js'
import { createOrchestrator } from '../lib/orchestrator.js'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as W from '../lib/workflow.js'

const SETTINGS = resolveSettings({})
const NOW = '2026-11-01T00:00:00.000Z'
const bytes = (value) => Buffer.byteLength(typeof value === 'string' ? value : JSON.stringify(value), 'utf8')

function item(overrides = {}) {
  return {
    id: 'W1',
    subject: 'Implement the core module with a reasonably descriptive subject',
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

function makeState() {
  const state = W.createRun({
    workflowVersion: W.WORKFLOW_VERSION,
    runId: 'run-efficiency-1',
    teamId: 'session-lead',
    objective: 'Ship a verified module without wasting tokens on repeated full-board reads',
    acceptanceCriteria: ['module is importable', 'tests are green', 'evidence is quoted'],
    constraints: ['no new dependencies'],
    settings: SETTINGS,
    items: [
      item({ id: 'W1', status: W.ITEM_STATUS.APPROVED, reviewers: ['rev'], report: { summary: 'x'.repeat(2000), files: ['src/core/run.js'], commands: [{ command: 'node --test', exitCode: 0, note: null }], evidence: ['4 passing'], openQuestions: [], risks: [], deviation: null }, reportedAt: NOW, approvedAt: NOW, approvedBy: 'rev' }),
      item({ id: 'W2', owner: 'impl2', status: W.ITEM_STATUS.CHANGES_REQUESTED, writeScopes: ['src/util/'], reviewers: ['rev'], reviews: [{ round: 1, reportSeq: 1, reviewer: 'rev', requestedBy: 'impl2', requestedAt: NOW, status: 'submitted', verdict: 'request_changes', summary: 'y'.repeat(2000), findings: [{ id: 'F1', severity: 'major', file: 'src/util/a.js', line: 3, claim: 'z'.repeat(600), suggestion: null, resolution: null }], evidenceChecked: ['read src/util/a.js'] }], reviewSeq: 1 }),
    ],
    actor: 'lead',
    now: NOW,
    artifacts: { statePath: '/tmp/state.json', reportPath: null, root: '/tmp' },
  })
  state.rev = 10
  return state
}

const baseInput = {
  me: { name: 'lead', role: 'lead' },
  role: 'lead',
  settings: SETTINGS,
  members: [{ name: 'lead', role: 'lead', status: 'running' }, { name: 'impl', role: 'implementer', status: 'inactive' }],
  artifacts: {},
  tasksById: new Map(),
}

test('status projections stay within the docs/40 payload budgets', () => {
  const state = makeState()
  const full = buildStatus(state, { ...baseInput, detailItemId: null })
  const detail = buildStatus(state, { ...baseInput, detailItemId: 'W1' })
  const briefFirst = buildBriefStatus(state, baseInput, { sinceRev: null })
  const briefRepeat = buildBriefStatus(state, baseInput, { sinceRev: 9 })
  const unchanged = buildStatus(state, { ...baseInput, view: 'brief', sinceRev: 10 })

  assert.ok(bytes(full) >= 4000, 'the legacy full view is still available')
  assert.ok(bytes(briefFirst) <= 7500, `brief first read too large: ${bytes(briefFirst)} bytes`)
  assert.ok(bytes(briefRepeat) <= 6000, `brief repeat read too large: ${bytes(briefRepeat)} bytes`)
  assert.ok(bytes(unchanged) <= 600, `unchanged fast path too large: ${bytes(unchanged)} bytes`)
  assert.equal(unchanged.unchanged, true)
  assert.ok(bytes(detail) >= bytes(briefRepeat), 'detail view keeps the full report/reviews for the Lead')
  // Long report/review prose is clamped even in the full detail view.
  assert.ok(bytes(detail) < bytes(full) + 12000, `detail payload should stay bounded: ${bytes(detail)} bytes`)
})

test('spawn briefs and static policies stay small', () => {
  const state = makeState()
  const worker = renderWorkerBrief(state, state.items[1], [], 'fresh').prompt
  const reviewer = renderReviewerBrief(state, 'rev', [state.items[1]]).prompt
  const queue = renderQueueBrief(state, 'impl', state.items, 'fresh').prompt
  assert.ok(bytes(worker) <= 4600, `worker brief too large: ${bytes(worker)} bytes`)
  assert.ok(bytes(reviewer) <= 3700, `reviewer brief too large: ${bytes(reviewer)} bytes`)
  assert.ok(bytes(queue) <= 3800, `queue brief too large: ${bytes(queue)} bytes`)
  assert.ok(bytes(buildPolicy(SETTINGS, 'implementer')) <= 2200)
  assert.ok(bytes(buildPolicy(SETTINGS, 'reviewer')) <= 1800)
  assert.ok(bytes(buildPolicy(SETTINGS)) <= 6200)
})

test('every persisted mutation bumps state.rev exactly once', async () => {
  const cwd = process.cwd()
  const lead = { id: 'session-lead', session: { id: 'session-lead' } }
  const ctx = {
    agentTeams: { tryMembership: () => ({ root: lead, id: lead.id, name: 'lead', role: 'lead' }) },
    workingDirectory: { get: () => cwd, defaultDirectory: cwd },
  }
  const settings = resolveSettings({ writeArtifacts: false })
  const store = createStore({ ctx, settings })
  const state = makeState()
  delete state.rev
  await store.writeState(lead, state)
  const rev1 = (await store.readState(lead)).rev
  await store.writeState(lead, { ...state, rev: rev1 })
  const rev2 = (await store.readState(lead)).rev
  assert.equal(rev1, 1)
  assert.equal(rev2, 2)
})

test('the board client sends If-None-Match, handles 304 and backs off', async () => {
  const source = await readFile(new URL('../client.js', import.meta.url), 'utf8')
  assert.match(source, /if-none-match/)
  assert.match(source, /status === 304/)
  assert.match(source, /pollDelay/)
  assert.match(source, /idleTicksRef/)
  assert.match(source, /const POLL_MS = 1200/)
  assert.match(source, /since_rev/)
  assert.match(source, /data\.unchanged === true/)
  assert.match(source, /mergeSnapshotDelta/)
})

test('role-scoped tools drop schema size significantly', () => {
  const fakeCtx = { agentTeams: {}, agents: {}, tools: {} }
  const tools = buildTools({ ctx: fakeCtx, settings: SETTINGS, store: {}, version: '1.25.0', tokenUsage: () => null, orchestrator: {} })
  const toolSchemas = (toolList) => toolList.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters }))

  const leadTools = tools
  const workerTools = filterToolsByRole(tools, resolveAllowedToolNames({ role: 'implementer', settings: SETTINGS }))
  const reviewerTools = filterToolsByRole(tools, resolveAllowedToolNames({ role: 'reviewer', settings: SETTINGS }))
  const verifierTools = filterToolsByRole(tools, resolveAllowedToolNames({ role: 'verifier', settings: SETTINGS }))

  assert.equal(leadTools.length, 17)
  assert.equal(workerTools.length, 10)
  assert.equal(reviewerTools.length, 6)
  assert.equal(verifierTools.length, 4)

  const leadBytes = bytes(toolSchemas(leadTools))
  const workerBytes = bytes(toolSchemas(workerTools))
  const reviewerBytes = bytes(toolSchemas(reviewerTools))
  const verifierBytes = bytes(toolSchemas(verifierTools))

  assert.ok(workerBytes < leadBytes * 0.65, `worker tools should drop schema size by >35%: ${workerBytes} vs ${leadBytes}`)
  assert.ok(reviewerBytes < leadBytes * 0.40, `reviewer tools should drop schema size by >60%: ${reviewerBytes} vs ${leadBytes}`)
  assert.ok(verifierBytes < leadBytes * 0.25, `verifier tools should drop schema size by >75%: ${verifierBytes} vs ${leadBytes}`)
})

test('pre-report gate rejects non-zero exit codes fail-fast unless deviation explained', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'atw-report-gate-'))
  try {
    const lead = { id: 'session-lead', session: { id: 'session-lead' } }
    const impl = { id: 'session-impl', session: { id: 'session-impl' } }
    const members = [
      { name: 'lead', role: 'lead', id: lead.id, status: 'running' },
      { name: 'impl', role: 'implementer', id: impl.id, status: 'running' },
    ]
    const ctx = {
      agents: { list: () => [lead, impl] },
      agentTeams: {
        tryMembership: (agent) => {
          const m = members.find((cand) => cand.id === agent.id)
          return m ? { root: lead, id: m.id, name: m.name, role: m.role } : undefined
        },
        membership: (agent) => {
          const m = members.find((cand) => cand.id === agent.id)
          return { root: lead, id: m.id, name: m.name, role: m.role }
        },
        listMembers: () => members,
        listTasks: () => [],
        createTask: async (_caller, req) => ({ id: 'task-1', revision: 1, status: 'pending', ...req }),
        updateTask: async () => ({}),
      },
      workingDirectory: { get: () => cwd, defaultDirectory: cwd },
    }
    const settings = resolveSettings({ writeArtifacts: false, preReportCheck: true })
    const store = createStore({ ctx, settings })
    const tools = buildTools({ ctx, settings, store, version: '1.25.0', orchestrator: {} })
    const planTool = tools.find((t) => t.name === 'team_flow_plan')
    const reportTool = tools.find((t) => t.name === 'team_flow_report')

    await planTool.execute(
      {
        objective: 'Test pre-report gate',
        acceptance_criteria: ['Check exit codes'],
        items: [
          {
            id: 'W1',
            subject: 'Implement check',
            owner: 'impl',
            write_scopes: ['src/'],
            definition_of_done: ['Tests pass'],
            reviewers: ['lead'],
          },
        ],
      },
      { agent: lead, signal: new AbortController().signal },
    )

    // 1. Reporting with non-zero exit code without deviation must be rejected
    await assert.rejects(
      reportTool.execute(
        {
          item_id: 'W1',
          summary: 'Attempted implementation',
          files: ['src/index.js'],
          commands: [{ command: 'npm test', exit_code: 1 }],
        },
        { agent: impl, signal: new AbortController().signal },
      ),
      /verification command failed: "npm test" \(exit code 1\)/,
    )

    // 2. Reporting with deviation explains why and is accepted
    const success = await reportTool.execute(
      {
        item_id: 'W1',
        summary: 'Implementation with known test failure',
        files: ['src/index.js'],
        commands: [{ command: 'npm test', exit_code: 1 }],
        deviation: 'Known test failure expected in this phase',
      },
      { agent: impl, signal: new AbortController().signal },
    )
    assert.equal(success.reported, true)
    assert.equal(success.status, 'in_review')
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
})

test('nit tolerance rejects request_changes with pure nits to prevent wasted rework loops', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'atw-nit-gate-'))
  try {
    const lead = { id: 'session-lead', session: { id: 'session-lead' } }
    const impl = { id: 'session-impl', session: { id: 'session-impl' } }
    const rev = { id: 'session-rev', session: { id: 'session-rev' } }
    const members = [
      { name: 'lead', role: 'lead', id: lead.id, status: 'running' },
      { name: 'impl', role: 'implementer', id: impl.id, status: 'running' },
      { name: 'rev', role: 'reviewer', id: rev.id, status: 'running' },
    ]
    const ctx = {
      agents: { list: () => [lead, impl, rev] },
      agentTeams: {
        tryMembership: (agent) => {
          const m = members.find((cand) => cand.id === agent.id)
          return m ? { root: lead, id: m.id, name: m.name, role: m.role } : undefined
        },
        membership: (agent) => {
          const m = members.find((cand) => cand.id === agent.id)
          return { root: lead, id: m.id, name: m.name, role: m.role }
        },
        listMembers: () => members,
        listTasks: () => [],
        createTask: async (_caller, req) => ({ id: 'task-1', revision: 1, status: 'pending', ...req }),
        updateTask: async () => ({}),
      },
      workingDirectory: { get: () => cwd, defaultDirectory: cwd },
    }
    const settings = resolveSettings({ writeArtifacts: false, nitTolerance: true })
    const store = createStore({ ctx, settings })
    const tools = buildTools({ ctx, settings, store, version: '1.25.1', orchestrator: {} })
    const planTool = tools.find((t) => t.name === 'team_flow_plan')
    const reportTool = tools.find((t) => t.name === 'team_flow_report')
    const reviewTool = tools.find((t) => t.name === 'team_flow_review_submit')

    await planTool.execute(
      {
        objective: 'Test nit tolerance',
        acceptance_criteria: ['Check review verdicts'],
        items: [{ id: 'W1', subject: 'Work', owner: 'impl', write_scopes: ['src/'], definition_of_done: ['Done'], reviewers: ['rev'] }],
      },
      { agent: lead, signal: new AbortController().signal },
    )

    await reportTool.execute(
      { item_id: 'W1', summary: 'Implemented', files: ['src/a.js'], commands: [{ command: 'true', exit_code: 0 }] },
      { agent: impl, signal: new AbortController().signal },
    )

    // 1. request_changes with ONLY nit findings must be rejected
    await assert.rejects(
      reviewTool.execute(
        {
          item_id: 'W1',
          verdict: 'request_changes',
          summary: 'Looks good overall, just minor cosmetic nit',
          findings: [{ id: 'F1', severity: 'nit', claim: 'Typo in comment' }],
          evidence_checked: ['read src/a.js'],
        },
        { agent: rev, signal: new AbortController().signal },
      ),
      /all findings have "nit" severity.*approve_with_nits/,
    )

    // 2. approve_with_nits with nit findings succeeds
    const approved = await reviewTool.execute(
      {
        item_id: 'W1',
        verdict: 'approve_with_nits',
        summary: 'Ship it with non-blocking typo observation',
        findings: [{ id: 'F1', severity: 'nit', claim: 'Typo in comment' }],
        evidence_checked: ['read src/a.js'],
      },
      { agent: rev, signal: new AbortController().signal },
    )
    assert.equal(approved.item_status, 'approved')
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
})

test('archiveApprovedItems evicts heavy evidence and reviews to cold storage and team_flow_read retrieves them on demand', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'atw-cold-archive-'))
  try {
    const lead = { id: 'session-lead', session: { id: 'session-lead' } }
    const impl = { id: 'session-impl', session: { id: 'session-impl' } }
    const rev = { id: 'session-rev', session: { id: 'session-rev' } }
    const members = [
      { name: 'lead', role: 'lead', id: lead.id, status: 'running' },
      { name: 'impl', role: 'implementer', id: impl.id, status: 'running' },
      { name: 'rev', role: 'reviewer', id: rev.id, status: 'running' },
    ]
    const ctx = {
      agents: { list: () => [lead, impl, rev], get: (id) => [lead, impl, rev].find((a) => a.id === id) },
      agentTeams: {
        tryMembership: (agent) => {
          const m = members.find((cand) => cand.id === agent.id)
          return m ? { root: lead, id: m.id, name: m.name, role: m.role } : undefined
        },
        membership: (agent) => {
          const m = members.find((cand) => cand.id === agent.id)
          return { root: lead, id: m.id, name: m.name, role: m.role }
        },
        listMembers: () => members,
        listTasks: () => [],
        createTask: async (_caller, req) => ({ id: 'task-1', revision: 1, status: 'pending', ...req }),
        updateTask: async () => ({}),
      },
      workingDirectory: { get: () => cwd, defaultDirectory: cwd },
    }
    const settings = resolveSettings({ writeArtifacts: true, archiveApprovedItems: true })
    const store = createStore({ ctx, settings })
    const tools = buildTools({ ctx, settings, store, version: '1.26.0', orchestrator: {} })
    const planTool = tools.find((t) => t.name === 'team_flow_plan')
    const reportTool = tools.find((t) => t.name === 'team_flow_report')
    const reviewTool = tools.find((t) => t.name === 'team_flow_review_submit')
    const readTool = tools.find((t) => t.name === 'team_flow_read')
    const gateTool = tools.find((t) => t.name === 'team_flow_gate')

    await planTool.execute(
      {
        objective: 'Test cold archiving of approved items',
        acceptance_criteria: ['Archive approved item evidence'],
        items: [{ id: 'W1', subject: 'Work with heavy evidence', owner: 'impl', write_scopes: ['src/'], definition_of_done: ['Done'], reviewers: ['rev'] }],
      },
      { agent: lead, signal: new AbortController().signal },
    )

    await reportTool.execute(
      {
        item_id: 'W1',
        summary: 'Heavy implementation report',
        files: ['src/heavy.js'],
        commands: [{ command: 'npm test', exit_code: 0, note: 'all pass' }],
        evidence: ['Detailed log line 1', 'Detailed log line 2', 'Large benchmark output data...'],
        open_questions: ['Q1: can we optimize?'],
        risks: ['R1: potential latency'],
      },
      { agent: impl, signal: new AbortController().signal },
    )

    // Approve the item
    const outcome = await reviewTool.execute(
      {
        item_id: 'W1',
        verdict: 'approve',
        summary: 'Looks great to me',
        findings: [],
        evidence_checked: ['verified src/heavy.js logs'],
      },
      { agent: rev, signal: new AbortController().signal },
    )
    assert.equal(outcome.item_status, 'approved')

    // Read live state: heavy evidence and detailed reviews should be evicted
    const state = await store.readState(lead)
    const liveItem = state.items.find((i) => i.id === 'W1')
    assert.equal(liveItem.archived, true)
    assert.equal(liveItem.report.archived, true)
    assert.ok(liveItem.report.archivePath.includes('archive/W1.json'))
    assert.deepEqual(liveItem.report.evidence, [])
    assert.deepEqual(liveItem.report.openQuestions, [])
    assert.deepEqual(liveItem.report.risks, [])
    assert.equal(liveItem.reviews[0].archived, true)
    assert.deepEqual(liveItem.reviews[0].findings, [])

    // Cold storage record can be retrieved directly via store.readArchivedItem
    const archiveRecord = await store.readArchivedItem(lead, 'W1')
    assert.equal(archiveRecord.id, 'W1')
    assert.equal(archiveRecord.status, 'approved')
    assert.equal(archiveRecord.report.evidence.length, 3)
    assert.equal(archiveRecord.report.evidence[0], 'Detailed log line 1')
    assert.equal(archiveRecord.reviews[0].summary, 'Looks great to me')

    // On-demand retrieval via team_flow_read
    const readResult = await readTool.execute(
      { archive_item_id: 'W1' },
      { agent: impl, signal: new AbortController().signal },
    )
    assert.ok(readResult.archived_item !== null)
    assert.equal(readResult.archived_item.id, 'W1')
    assert.equal(readResult.archived_item.report.evidence.length, 3)

    // Quality gate should still pass on the archived item and finalize smoothly
    const gateResult = await gateTool.execute(
      { finalize: true },
      { agent: lead, signal: new AbortController().signal },
    )
    assert.equal(gateResult.pass, true)
    assert.equal(gateResult.finalized, true)
    const finalizedState = await store.readState(lead)
    assert.equal(finalizedState.phase, 'finalized')
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
})

test('telemetry computeUsage breaks down tokens by role and reports token share', () => {
  const members = [
    { name: 'lead', role: 'lead', agent: { id: 'lead' } },
    { name: 'worker1', role: 'implementer', agent: { id: 'w1' } },
    { name: 'worker2', role: 'worker', agent: { id: 'w2' } },
    { name: 'reviewer1', role: 'reviewer', agent: { id: 'r1' } },
  ]
  const tokenTable = {
    lead: { uncachedInputTokens: 100, outputTokens: 50, cacheReadTokens: 50, cacheWriteTokens: 0 }, // total 200 (20%)
    w1: { uncachedInputTokens: 200, outputTokens: 100, cacheReadTokens: 100, cacheWriteTokens: 0 }, // total 400
    w2: { uncachedInputTokens: 100, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0 }, // total 200 -> worker total 600 (60%)
    r1: { uncachedInputTokens: 100, outputTokens: 50, cacheReadTokens: 50, cacheWriteTokens: 0 }, // total 200 (20%)
  }
  const read = (agent) => ({ totals: tokenTable[agent.id] })
  const usage = computeUsage({ members, read, state: null })

  assert.equal(usage.totals.uncachedInputTokens, 500)
  assert.equal(usage.totals.outputTokens, 300)
  assert.equal(usage.totals.cacheReadTokens, 200)

  // Roles breakdown
  assert.equal(usage.byRole.lead.totalTokens, 200)
  assert.equal(usage.byRole.worker.totalTokens, 600)
  assert.equal(usage.byRole.reviewer.totalTokens, 200)

  // Shares
  assert.equal(usage.tokenShare.lead, 0.2)
  assert.equal(usage.tokenShare.worker, 0.6)
  assert.equal(usage.tokenShare.reviewer, 0.2)

  // Render markdown report with attribution section
  const mockState = {
    runId: 'run-usage-1',
    phase: 'finalized',
    objective: 'Test',
    acceptanceCriteria: [],
    constraints: [],
    items: [],
    escalations: [],
    events: [],
    usage,
  }
  const mockGate = { pass: true, itemGates: [], teamFailures: [] }
  const markdown = renderReportMarkdown(mockState, mockGate)
  assert.ok(markdown.includes('## Token attribution by role'))
  assert.ok(markdown.includes('| lead | 100 | 50 | 50 | 0 | 200 | 20.0% |'))
  assert.ok(markdown.includes('| worker | 300 | 200 | 100 | 0 | 600 | 60.0% |'))
  assert.ok(markdown.includes('| reviewer | 100 | 50 | 50 | 0 | 200 | 20.0% |'))

  // Dashboard snapshot reflects byRole and tokenShare
  const snapshot = buildSnapshot({
    state: mockState,
    team: { me: { name: 'lead', role: 'lead' }, members: [], tasks: [] },
    artifacts: {},
    diagnostics: { warnings: [] },
    sessionId: 'session-lead',
    now: '2026-11-01T00:00:00.000Z',
  })
  assert.equal(snapshot.run.usage.byRole.lead.totalTokens, 200)
  assert.equal(snapshot.run.usage.tokenShare.lead, 0.2)
  assert.equal(snapshot.run.usage.byRole.worker.totalTokens, 600)
  assert.equal(snapshot.run.usage.tokenShare.worker, 0.6)
})
