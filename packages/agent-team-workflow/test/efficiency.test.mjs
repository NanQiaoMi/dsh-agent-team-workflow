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
import { buildPolicy, renderQueueBrief, renderReviewerBrief, renderWorkerBrief } from '../lib/protocol.js'
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
