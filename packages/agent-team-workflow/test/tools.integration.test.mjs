/**
 * Integration tests for the tool adapters.
 *
 * Runs the real tool definitions against an in-memory Agent Teams double and a
 * real temporary artifact directory. It also validates every declared output
 * schema with the Harness' own JSON-Schema validator, which is exactly what the
 * live tool runtime does to a tool result — the failure mode this catches is a
 * schema/value mismatch that would otherwise only appear in a live session.
 *
 * Run: node --test test/
 */

import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { resolveSettings } from '../lib/config.js'
import { createStore } from '../lib/store.js'
import { buildTools } from '../lib/tools.js'

const DSH_TOOLS = '/Applications/DSH Desktop.app/Contents/Resources/app/node_modules/@deepseek-ai/dsh-tools/lib/index.js'
const { execFileSync } = await import('node:child_process')
const { assertSupportedJsonSchema, validateJsonSchemaValue } = await import(DSH_TOOLS)

/** In-memory double of the Agent Teams service plus the plugin's host needs. */
function createHarness(cwd) {
  const lead = { id: 'session-lead', session: { id: 'session-lead' } }
  const agents = new Map()
  const members = [{ name: 'lead', role: 'lead', id: lead.id, status: 'running', context: undefined }]
  /** @type {Array<{id: string, revision: number, subject: string, description: string, status: string, ownerId?: string, blockedBy: string[], writeScopes: string[]}>} */
  const tasks = []
  const messages = []
  const spawns = []
  const interrupts = []
  let taskNumber = 0

  const nameOf = (agent) => [...members].find((member) => member.id === agent.id)?.name

  const agentTeams = {
    tryMembership(agent) {
      const member = members.find((candidate) => candidate.id === agent.id)
      if (member === undefined) return undefined
      return { root: lead, id: agent.id, name: member.name, role: member.role }
    },
    membership(agent) {
      const result = agentTeams.tryMembership(agent)
      if (result === undefined) throw new Error('not a team member')
      return result
    },
    listMembers() {
      return members.map((member) => ({ ...member, diagnostics: [] }))
    },
    async createTask(caller, request) {
      taskNumber += 1
      const task = {
        id: `task-${taskNumber}`,
        revision: 1,
        subject: request.subject,
        description: request.description,
        status: 'pending',
        blockedBy: [...(request.blockedBy ?? [])],
        writeScopes: [...(request.writeScopes ?? [])],
      }
      tasks.push(task)
      return task
    },
    getTask(_caller, id) {
      const task = tasks.find((candidate) => candidate.id === id)
      if (task === undefined) throw new Error(`task ${id} not found`)
      return { ...task }
    },
    listTasks() {
      return tasks.map((task) => ({ ...task }))
    },
    async updateTask(caller, request) {
      const task = tasks.find((candidate) => candidate.id === request.taskId)
      if (task === undefined) throw new Error(`task ${request.taskId} not found`)
      if (task.revision !== request.expectedRevision) throw new Error(`stale revision on ${task.id}`)
      const ownerId = caller.id
      switch (request.action) {
        case 'claim':
          if (task.status !== 'pending') throw new Error('only a pending task can be claimed')
          task.status = 'in_progress'
          task.ownerId = ownerId
          break
        case 'complete':
          if (task.status !== 'in_progress') throw new Error('only an in-progress task can complete')
          task.status = 'completed'
          break
        case 'reopen':
          if (task.status !== 'completed') throw new Error('only a completed task can reopen')
          task.status = 'pending'
          delete task.ownerId
          break
        case 'reassign':
          if (task.status !== 'pending' && task.status !== 'in_progress') throw new Error('only a pending/in-progress task can be reassigned')
          task.ownerId = request.owner === undefined ? ownerId : undefined
          break
        case 'delete':
          task.status = 'deleted'
          break
        default:
          throw new Error(`unsupported action ${request.action}`)
      }
      task.revision += 1
      return { ...task }
    },
    async sendMessage(caller, request) {
      messages.push({ from: nameOf(caller) ?? caller.id, to: request.target, text: request.content[0].text })
      if (!members.some((member) => member.name === request.target)) throw new Error(`unknown member ${request.target}`)
      const target = members.find((member) => member.name === request.target)
      if (target.status === 'inactive') target.status = 'running'
      return { messageId: `msg-${messages.length}` }
    },
    interrupt(caller, targetName) {
      interrupts.push(targetName)
      return { previousStatus: 'running' }
    },
    async spawnTeammate(caller, request) {
      if (caller.id !== lead.id) throw new Error('only the Team Lead can create teammates')
      if (typeof request.provider !== 'string' || request.provider.length === 0) throw new Error('provider is required')
      if (members.some((member) => member.name === request.name)) throw new Error(`member ${request.name} already exists`)
      const agent = { id: `session-${request.name}`, session: { id: `session-${request.name}` } }
      agents.set(request.name, agent)
      members.push({ name: request.name, role: 'teammate', id: agent.id, status: 'provisioning', context: request.context })
      spawns.push({ name: request.name, provider: request.provider, context: request.context, prompt: request.prompt?.[0]?.text ?? '' })
      return { member: { name: request.name, id: agent.id, status: 'provisioning' } }
    },
  }

  const ctx = {
    logger: { info() {}, warn() {} },
    agents: {
      list: () => [...agents.values()],
      get: (id) => [...agents.values()].find((candidate) => candidate.id === id),
    },
    workingDirectory: { get: () => cwd, defaultDirectory: cwd },
    agentTeams,
  }

  const addTeammate = (name, context = 'fresh') => {
    const agent = { id: `session-${name}`, session: { id: `session-${name}` } }
    agents.set(name, agent)
    members.push({ name, role: 'teammate', id: agent.id, status: 'inactive', context })
    return agent
  }

  return { ctx, lead, agentTeams, addTeammate, tasks, messages, spawns, interrupts }
}

const settings = resolveSettings({})
const EXEC_SIGNAL = new AbortController().signal

function byName(tools, name) {
  const tool = tools.find((candidate) => candidate.name === name)
  assert.ok(tool !== undefined, `missing tool ${name}`)
  return tool
}

/** Assert one result satisfies the tool's declared output schema. */
function assertOutput(tool, value) {
  const violations = validateJsonSchemaValue(tool.output.schema, value, 'value')
  assert.deepEqual(violations, [], `${tool.name} output violates its own schema: ${violations.join('; ')}`)
}

async function withWorkspace(fn) {
  const cwd = await mkdtemp(join(tmpdir(), 'atw-'))
  try {
    return await fn(cwd)
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
}

test('every tool declares a supported output schema', () => {
  return withWorkspace(async (cwd) => {
    const { ctx } = createHarness(cwd)
    const tools = buildTools({ ctx, settings, store: createStore({ ctx, settings }), version: 'test' })
    assert.equal(tools.length, 17)
    for (const tool of tools) assertSupportedJsonSchema(tool.output.schema)
  })
})

test('full happy path: plan, report, review, gate, finalize', () => {
  return withWorkspace(async (cwd) => {
    const harness = createHarness(cwd)
    const store = createStore({ ctx: harness.ctx, settings })
    const tools = buildTools({ ctx: harness.ctx, settings, store, version: 'test' })
    const plan = byName(tools, 'team_flow_plan')
    const status = byName(tools, 'team_flow_status')
    const report = byName(tools, 'team_flow_report')
    const submit = byName(tools, 'team_flow_review_submit')
    const gate = byName(tools, 'team_flow_gate')

    const impl = harness.addTeammate('impl')
    const rev = harness.addTeammate('rev')

    const planResult = await plan.execute(
      {
        objective: 'Ship a verified hello module',
        acceptance_criteria: ['hello() returns the greeting', 'tests pass'],
        constraints: ['no new dependencies'],
        items: [
          {
            id: 'W1',
            subject: 'Implement hello()',
            owner: 'impl',
            role: 'implementer',
            write_scopes: ['src/'],
            definition_of_done: ['hello() exists', 'unit test passes'],
            reviewers: ['rev'],
          },
        ],
      },
      { agent: harness.lead, signal: EXEC_SIGNAL },
    )
    assertOutput(plan, planResult)
    assert.match(planResult.run_id, /^run-/)
    assert.deepEqual(planResult.waves, [['W1']])
    assert.equal(planResult.items[0].task_id, 'task-1')
    assert.equal(planResult.spawn.length, 1)
    assert.equal(planResult.spawn[0].name, 'impl')
    assert.equal(planResult.reviewer_spawn.length, 1)
    assert.match(planResult.spawn[0].prompt, /team_flow_report/)
    assert.match(planResult.reviewer_spawn[0].prompt, /team_flow_review_submit/)

    const leadStatus = await status.execute({}, { agent: harness.lead, signal: EXEC_SIGNAL })
    assertOutput(status, leadStatus)
    assert.equal(leadStatus.run_id, planResult.run_id)
    assert.equal(leadStatus.counts.pending, 1)

    const workerStatus = await status.execute({}, { agent: impl, signal: EXEC_SIGNAL })
    assertOutput(status, workerStatus)
    assert.match(workerStatus.next_actions.join(' '), /team_flow_report/)

    // The Lead may not report an item it does not own.
    await assert.rejects(
      report.execute({ item_id: 'W1', summary: 'x', files: [] }, { agent: harness.lead, signal: EXEC_SIGNAL }),
      /belongs to "impl"/,
    )

    const reported = await report.execute(
      {
        item_id: 'W1',
        summary: 'Added hello() and its test.',
        files: ['src/hello.js', 'test/hello.test.mjs'],
        commands: [{ command: 'node --test test/hello.test.mjs', exit_code: 0, note: '2 passing' }],
        evidence: ['test/hello.test.mjs: 2 passing'],
        risks: ['none observed'],
      },
      { agent: impl, signal: EXEC_SIGNAL },
    )
    assertOutput(report, reported)
    assert.equal(reported.reviewer, 'rev')
    assert.equal(harness.tasks[0].status, 'completed', 'backing task completes on report')
    assert.equal(harness.messages.at(-1).to, 'rev', 'reviewer is notified automatically')

    const reviewStatus = await status.execute({}, { agent: rev, signal: EXEC_SIGNAL })
    assert.match(reviewStatus.next_actions.join(' '), /team_flow_review_submit/)

    const approved = await submit.execute(
      {
        item_id: 'W1',
        verdict: 'approve',
        summary: 'The DoD is covered and the test command reproduces.',
        findings: [],
        evidence_checked: ['read src/hello.js', 'ran node --test test/hello.test.mjs'],
      },
      { agent: rev, signal: EXEC_SIGNAL },
    )
    assertOutput(submit, approved)
    assert.equal(approved.item_status, 'approved')
    assert.equal(harness.messages.at(-1).to, 'impl')

    const gateResult = await gate.execute({}, { agent: harness.lead, signal: EXEC_SIGNAL })
    assertOutput(gate, gateResult)
    assert.equal(gateResult.pass, true)

    const finalized = await gate.execute({ finalize: true }, { agent: harness.lead, signal: EXEC_SIGNAL })
    assert.equal(finalized.finalized, true)
    const reportText = await readFile(join(cwd, '.agentteam', 'teams', 'session-lead', 'report.md'), 'utf8')
    assert.match(reportText, /Agent Team Workflow Report/)
    assert.match(reportText, /W1/)
    assert.match(reportText, /node --test test\/hello\.test\.mjs/)
    const teamDir = join(cwd, '.agentteam', 'teams', 'session-lead')
    const files = await readdir(teamDir)
    assert.deepEqual(files.sort(), ['report.md', 'state.json'])

    const finalStatus = await status.execute({}, { agent: harness.lead, signal: EXEC_SIGNAL })
    assert.equal(finalStatus.phase, 'finalized')
    assert.match(finalStatus.next_actions.join(' '), /finalized/)
  })
})

test('changes requested reopens the shared task and the author answers findings', () => {
  return withWorkspace(async (cwd) => {
    const harness = createHarness(cwd)
    const store = createStore({ ctx: harness.ctx, settings })
    const tools = buildTools({ ctx: harness.ctx, settings, store, version: 'test' })
    harness.addTeammate('impl')
    harness.addTeammate('rev')
    await byName(tools, 'team_flow_plan').execute(
      {
        objective: 'Ship it',
        acceptance_criteria: ['works'],
        items: [{ id: 'W1', subject: 'Work', owner: 'impl', write_scopes: ['src/'], definition_of_done: ['done'], reviewers: ['rev'] }],
      },
      { agent: harness.lead, signal: EXEC_SIGNAL },
    )
    await byName(tools, 'team_flow_report').execute(
      { item_id: 'W1', summary: 'did it', files: ['src/a.js'], commands: [{ command: 'true', exit_code: 0 }] },
      { agent: harness.ctx.agents.list().find((agent) => agent.id === 'session-impl'), signal: EXEC_SIGNAL },
    )
    const reviewer = harness.ctx.agents.list().find((agent) => agent.id === 'session-rev')
    const changes = await byName(tools, 'team_flow_review_submit').execute(
      {
        item_id: 'W1',
        verdict: 'request_changes',
        summary: 'Edge case missing.',
        findings: [{ id: 'F1', severity: 'major', file: 'src/a.js', line: 9, claim: 'empty input crashes' }],
        evidence_checked: ['read src/a.js'],
      },
      { agent: reviewer, signal: EXEC_SIGNAL },
    )
    assert.equal(changes.item_status, 'changes_requested')
    assert.equal(harness.tasks[0].status, 'pending', 'rework reopens the backing task')
    const author = harness.ctx.agents.list().find((agent) => agent.id === 'session-impl')
    const response = await byName(tools, 'team_flow_review_respond').execute(
      { item_id: 'W1', responses: [{ finding_id: 'F1', state: 'fixed', evidence: 'guard added at src/a.js:9; test added' }] },
      { agent: author, signal: EXEC_SIGNAL },
    )
    assert.equal(response.item_status, 'in_review')
    assert.equal(response.next_round, 2)
    assert.equal(harness.messages.at(-1).to, 'rev')
  })
})

test('role, ownership, and verdict guards reject misuse', () => {
  return withWorkspace(async (cwd) => {
    const harness = createHarness(cwd)
    const store = createStore({ ctx: harness.ctx, settings })
    const tools = buildTools({ ctx: harness.ctx, settings, store, version: 'test' })
    const impl = harness.addTeammate('impl')
    harness.addTeammate('rev')
    const planArgs = {
      objective: 'Ship it',
      acceptance_criteria: ['works'],
      items: [{ id: 'W1', subject: 'Work', owner: 'impl', write_scopes: ['src/'], definition_of_done: ['done'], reviewers: ['rev'] }],
    }
    await assert.rejects(byName(tools, 'team_flow_plan').execute(planArgs, { agent: impl, signal: EXEC_SIGNAL }), /Lead-only/)

    // A second plan without replace is refused.
    await byName(tools, 'team_flow_plan').execute(planArgs, { agent: harness.lead, signal: EXEC_SIGNAL })
    await assert.rejects(byName(tools, 'team_flow_plan').execute(planArgs, { agent: harness.lead, signal: EXEC_SIGNAL }), /already exists/)

    // Invalid plan structures are refused with actionable reasons.
    await assert.rejects(
      byName(tools, 'team_flow_plan').execute(
        { ...planArgs, replace: true, items: [{ ...planArgs.items[0], reviewers: ['impl'] }] },
        { agent: harness.lead, signal: EXEC_SIGNAL },
      ),
      /own owner/,
    )

    // Reviewing before reporting is refused.
    await assert.rejects(
      byName(tools, 'team_flow_review_submit').execute(
        { item_id: 'W1', verdict: 'approve', summary: 'x', findings: [], evidence_checked: [] },
        { agent: harness.ctx.agents.list().find((agent) => agent.id === 'session-rev'), signal: EXEC_SIGNAL },
      ),
      /no pending review/,
    )

    // Only the Lead may gate.
    await assert.rejects(byName(tools, 'team_flow_gate').execute({}, { agent: impl, signal: EXEC_SIGNAL }), /Lead-only/)
  })
})

test('escalation blocks the gate until the Lead resolves it', () => {
  return withWorkspace(async (cwd) => {
    const harness = createHarness(cwd)
    const store = createStore({ ctx: harness.ctx, settings })
    const tools = buildTools({ ctx: harness.ctx, settings, store, version: 'test' })
    const impl = harness.addTeammate('impl')
    harness.addTeammate('rev')
    await byName(tools, 'team_flow_plan').execute(
      {
        objective: 'Ship it',
        acceptance_criteria: ['works'],
        items: [{ id: 'W1', subject: 'Work', owner: 'impl', write_scopes: ['src/'], definition_of_done: ['done'], reviewers: ['rev'] }],
      },
      { agent: harness.lead, signal: EXEC_SIGNAL },
    )
    const raised = await byName(tools, 'team_flow_escalate').execute(
      { kind: 'conflict', subject: 'two specs disagree', detail: 'docs/a.md says one thing, the ticket another', blocking: true, item_id: 'W1' },
      { agent: impl, signal: EXEC_SIGNAL },
    )
    assert.equal(raised.escalation_id, 'esc-1')
    assert.equal(harness.messages.at(-1).to, 'lead')

    const blocked = await byName(tools, 'team_flow_gate').execute({}, { agent: harness.lead, signal: EXEC_SIGNAL })
    assert.equal(blocked.pass, false)
    assert.match(blocked.team_failures.join(' '), /unresolved blocking escalation/)

    await assert.rejects(
      byName(tools, 'team_flow_gate').execute({ finalize: true }, { agent: harness.lead, signal: EXEC_SIGNAL }),
      /did not pass/,
    )

    const resolved = await byName(tools, 'team_flow_escalate').execute(
      { escalation_id: 'esc-1', resolution: 'docs/a.md wins; the ticket is stale' },
      { agent: harness.lead, signal: EXEC_SIGNAL },
    )
    assert.equal(resolved.resolved, true)
    assert.equal((await byName(tools, 'team_flow_status').execute({}, { agent: harness.lead, signal: EXEC_SIGNAL })).escalations[0].resolved, true)
  })
})

test('replace archives the previous run state', () => {
  return withWorkspace(async (cwd) => {
    const harness = createHarness(cwd)
    const store = createStore({ ctx: harness.ctx, settings })
    const tools = buildTools({ ctx: harness.ctx, settings, store, version: 'test' })
    harness.addTeammate('impl')
    harness.addTeammate('rev')
    const planArgs = {
      objective: 'Ship it',
      acceptance_criteria: ['works'],
      items: [{ id: 'W1', subject: 'Work', owner: 'impl', write_scopes: ['src/'], definition_of_done: ['done'], reviewers: ['rev'] }],
    }
    const first = await byName(tools, 'team_flow_plan').execute(planArgs, { agent: harness.lead, signal: EXEC_SIGNAL })
    const second = await byName(tools, 'team_flow_plan').execute({ ...planArgs, replace: true }, { agent: harness.lead, signal: EXEC_SIGNAL })
    assert.notEqual(first.run_id, second.run_id)
    const archived = await readdir(join(cwd, '.agentteam', 'teams', 'session-lead', 'runs'))
    assert.equal(archived.length, 1)
    const state = JSON.parse(await readFile(join(cwd, '.agentteam', 'teams', 'session-lead', 'state.json'), 'utf8'))
    assert.equal(state.runId, second.run_id)
  })
})

test('writeArtifacts:false keeps the run in memory without touching the workspace', () => {
  return withWorkspace(async (cwd) => {
    const harness = createHarness(cwd)
    const memorySettings = resolveSettings({ writeArtifacts: false })
    const store = createStore({ ctx: harness.ctx, settings: memorySettings })
    const tools = buildTools({ ctx: harness.ctx, settings: memorySettings, store, version: 'test' })
    harness.addTeammate('impl')
    harness.addTeammate('rev')
    const planned = await byName(tools, 'team_flow_plan').execute(
      {
        objective: 'Ship it in memory',
        acceptance_criteria: ['works'],
        items: [{ id: 'W1', subject: 'Work', owner: 'impl', write_scopes: ['src/'], definition_of_done: ['done'], reviewers: ['rev'] }],
      },
      { agent: harness.lead, signal: EXEC_SIGNAL },
    )
    const status = await byName(tools, 'team_flow_status').execute({}, { agent: harness.lead, signal: EXEC_SIGNAL })
    assert.equal(status.run_id, planned.run_id, 'status must see the in-memory run')
    assert.equal(status.phase, 'planned')
    await assert.rejects(readdir(join(cwd, '.agentteam')), /ENOENT/)
  })
})

test('a member that both owns work and reviews is spawned once with both duties', () => {
  return withWorkspace(async (cwd) => {
    const harness = createHarness(cwd)
    const store = createStore({ ctx: harness.ctx, settings })
    const tools = buildTools({ ctx: harness.ctx, settings, store, version: 'test' })
    const planned = await byName(tools, 'team_flow_plan').execute(
      {
        objective: 'Cross review',
        acceptance_criteria: ['works'],
        items: [
          { id: 'W1', subject: 'A', owner: 'impl', write_scopes: ['src/a/'], definition_of_done: ['a done'], reviewers: ['rev'] },
          { id: 'W2', subject: 'B', owner: 'rev', write_scopes: ['src/b/'], definition_of_done: ['b done'], reviewers: ['impl'] },
        ],
      },
      { agent: harness.lead, signal: EXEC_SIGNAL },
    )
    assert.equal(planned.spawn.length, 2)
    assert.deepEqual(planned.reviewer_spawn, [], 'no member needs a second spawn')
    const revBrief = planned.spawn.find((entry) => entry.name === 'rev')
    assert.match(revBrief.prompt, /Additional duty: independent reviewer/)
    assert.match(revBrief.prompt, /W1/)
    assert.match(planned.next_actions.join(' '), /Spawn rev, impl once/)
  })
})

test('an approving review must declare inspected evidence', () => {
  return withWorkspace(async (cwd) => {
    const harness = createHarness(cwd)
    const store = createStore({ ctx: harness.ctx, settings })
    const tools = buildTools({ ctx: harness.ctx, settings, store, version: 'test' })
    const impl = harness.addTeammate('impl')
    const rev = harness.addTeammate('rev')
    await byName(tools, 'team_flow_plan').execute(
      {
        objective: 'Ship it',
        acceptance_criteria: ['works'],
        items: [{ id: 'W1', subject: 'Work', owner: 'impl', write_scopes: ['src/'], definition_of_done: ['done'], reviewers: ['rev'] }],
      },
      { agent: harness.lead, signal: EXEC_SIGNAL },
    )
    await byName(tools, 'team_flow_report').execute(
      { item_id: 'W1', summary: 'done', files: ['src/a.js'], commands: [{ command: 'true', exit_code: 0 }] },
      { agent: impl, signal: EXEC_SIGNAL },
    )
    await assert.rejects(
      byName(tools, 'team_flow_review_submit').execute(
        { item_id: 'W1', verdict: 'approve', summary: 'rubber stamp', findings: [], evidence_checked: [] },
        { agent: rev, signal: EXEC_SIGNAL },
      ),
      /must declare what you actually inspected/,
    )
  })
})

test('escalating never rewrites an approved item, and repair tools restore a stuck item', () => {
  return withWorkspace(async (cwd) => {
    const harness = createHarness(cwd)
    const store = createStore({ ctx: harness.ctx, settings })
    const tools = buildTools({ ctx: harness.ctx, settings, store, version: 'test' })
    const impl = harness.addTeammate('impl')
    const rev = harness.addTeammate('rev')
    await byName(tools, 'team_flow_plan').execute(
      {
        objective: 'Repair paths',
        acceptance_criteria: ['works'],
        items: [{ id: 'W1', subject: 'Work', owner: 'impl', write_scopes: ['src/'], definition_of_done: ['done'], reviewers: ['rev'] }],
      },
      { agent: harness.lead, signal: EXEC_SIGNAL },
    )

    // R-02: an escalation records, but never flips an approved item back.
    await byName(tools, 'team_flow_report').execute(
      { item_id: 'W1', summary: 'done', files: ['src/a.js'], commands: [{ command: 'true', exit_code: 0 }], evidence: ['ok'] },
      { agent: impl, signal: EXEC_SIGNAL },
    )
    await byName(tools, 'team_flow_review_submit').execute(
      { item_id: 'W1', verdict: 'approve', summary: 'ok', findings: [], evidence_checked: ['read src/a.js'] },
      { agent: rev, signal: EXEC_SIGNAL },
    )
    const before = await byName(tools, 'team_flow_status').execute({}, { agent: harness.lead, signal: EXEC_SIGNAL })
    assert.equal(before.items[0].status, 'approved')
    await byName(tools, 'team_flow_escalate').execute(
      { kind: 'decision', subject: 'do not touch status', detail: 'probe', blocking: false, item_id: 'W1' },
      { agent: impl, signal: EXEC_SIGNAL },
    )
    const after = await byName(tools, 'team_flow_status').execute({}, { agent: harness.lead, signal: EXEC_SIGNAL })
    assert.equal(after.items[0].status, 'approved', 'escalation must not change item status')

    // R-04: a Lead can reopen for rework and the new version must be re-reviewed.
    const reopened = await byName(tools, 'team_flow_repair').execute(
      { item_id: 'W1', action: 'reopen', reason: 'acceptance criterion changed' },
      { agent: harness.lead, signal: EXEC_SIGNAL },
    )
    assert.equal(reopened.item_status, 'pending')
    const statusAfter = await byName(tools, 'team_flow_status').execute({ item_id: 'W1' }, { agent: harness.lead, signal: EXEC_SIGNAL })
    assert.equal(statusAfter.items[0].reported, false)
    assert.equal(statusAfter.items[0].repair_log.length, 1)

    // Non-Lead members cannot repair.
    await assert.rejects(
      byName(tools, 'team_flow_repair').execute({ item_id: 'W1', action: 'reopen', reason: 'x' }, { agent: impl, signal: EXEC_SIGNAL }),
      /Lead-only/,
    )

    // reset_review moves a stuck review to a named reviewer.
    await byName(tools, 'team_flow_report').execute(
      { item_id: 'W1', summary: 'v2', files: ['src/a.js'], commands: [{ command: 'true', exit_code: 0 }], evidence: ['ok'] },
      { agent: impl, signal: EXEC_SIGNAL },
    )
    const reset = await byName(tools, 'team_flow_repair').execute(
      { item_id: 'W1', action: 'reset_review', reason: 'reviewer went silent', reviewer: 'rev' },
      { agent: harness.lead, signal: EXEC_SIGNAL },
    )
    assert.equal(reset.item_status, 'in_review')
  })
})

test('status detail exposes the report and review records a reviewer needs', () => {
  return withWorkspace(async (cwd) => {
    const harness = createHarness(cwd)
    const store = createStore({ ctx: harness.ctx, settings })
    const tools = buildTools({ ctx: harness.ctx, settings, store, version: 'test' })
    const impl = harness.addTeammate('impl')
    harness.addTeammate('rev')
    await byName(tools, 'team_flow_plan').execute(
      {
        objective: 'Detail',
        acceptance_criteria: ['works'],
        items: [{ id: 'W1', subject: 'Work', owner: 'impl', write_scopes: ['src/'], definition_of_done: ['done'], reviewers: ['rev'] }],
      },
      { agent: harness.lead, signal: EXEC_SIGNAL },
    )
    await byName(tools, 'team_flow_report').execute(
      {
        item_id: 'W1',
        summary: 'did it',
        files: ['src/a.js'],
        commands: [{ command: 'node --test', exit_code: 0 }],
        evidence: ['1 passing'],
      },
      { agent: impl, signal: EXEC_SIGNAL },
    )
    const compact = await byName(tools, 'team_flow_status').execute({}, { agent: harness.ctx.agents.list().find((agent) => agent.id === 'session-rev'), signal: EXEC_SIGNAL })
    assert.deepEqual(compact.items[0].definition_of_done, ['done'])
    assert.deepEqual(compact.items[0].reviewers, ['rev'])
    assert.equal(compact.items[0].task.revision, 3, 'task revision is visible to the worker/reviewer (claim + complete)')
    assert.equal(compact.items[0].report, undefined, 'compact mode omits the full report')

    const detailed = await byName(tools, 'team_flow_status').execute({ item_id: 'W1' }, { agent: harness.ctx.agents.list().find((agent) => agent.id === 'session-rev'), signal: EXEC_SIGNAL })
    assert.equal(detailed.items[0].report.summary, 'did it')
    assert.equal(detailed.items[0].report.commands[0].exitCode, 0)
    assert.equal(detailed.items[0].review_records[0].reviewer, 'rev')
  })
})

test('a forked worker context is reported when the plugin is configured that way', () => {
  return withWorkspace(async (cwd) => {
    const harness = createHarness(cwd)
    const forkSettings = resolveSettings({ workerContext: 'fork' })
    const store = createStore({ ctx: harness.ctx, settings: forkSettings })
    const tools = buildTools({ ctx: harness.ctx, settings: forkSettings, store, version: 'test' })
    harness.addTeammate('impl')
    harness.addTeammate('rev')
    const planned = await byName(tools, 'team_flow_plan').execute(
      {
        objective: 'Fork',
        acceptance_criteria: ['works'],
        items: [{ id: 'W1', subject: 'Work', owner: 'impl', write_scopes: ['src/'], definition_of_done: ['done'], reviewers: ['rev'] }],
      },
      { agent: harness.lead, signal: EXEC_SIGNAL },
    )
    assert.equal(planned.spawn[0].context, 'fork')
    assert.match(planned.next_actions.join(' '), /fork/)
    assert.match(planned.spawn[0].prompt, /team_task_get/)
  })
})

test('a preview that needs overrides tells the Lead to pass them to finalize', () => {
  return withWorkspace(async (cwd) => {
    const harness = createHarness(cwd)
    const store = createStore({ ctx: harness.ctx, settings })
    const tools = buildTools({ ctx: harness.ctx, settings, store, version: 'test' })
    const impl = harness.addTeammate('impl')
    const rev = harness.addTeammate('rev')
    await byName(tools, 'team_flow_plan').execute(
      {
        objective: 'Override flow',
        acceptance_criteria: ['works'],
        items: [{ id: 'W1', subject: 'Work', owner: 'impl', write_scopes: ['src/'], definition_of_done: ['done'], reviewers: ['rev'] }],
      },
      { agent: harness.lead, signal: EXEC_SIGNAL },
    )
    // A report with a missing exit code fails G2, which the Lead then accepts.
    await byName(tools, 'team_flow_report').execute(
      { item_id: 'W1', summary: 'done, unverified', files: ['src/a.js'], commands: [{ command: 'npm test', exit_code: null }], evidence: ['manual check'] },
      { agent: impl, signal: EXEC_SIGNAL },
    )
    await byName(tools, 'team_flow_review_submit').execute(
      { item_id: 'W1', verdict: 'approve', summary: 'ok under override', findings: [], evidence_checked: ['read src/a.js'] },
      { agent: rev, signal: EXEC_SIGNAL },
    )
    const overrides = [{ item_id: 'W1', reason: 'CI unavailable in this environment; manual check accepted' }]
    const preview = await byName(tools, 'team_flow_gate').execute({ overrides }, { agent: harness.lead, signal: EXEC_SIGNAL })
    assert.equal(preview.pass, true)
    assert.match(preview.next_actions.join(' '), /overrides/)
    assert.match(preview.next_actions.join(' '), /W1/)

    // Following the preview instruction without the overrides must fail…
    await assert.rejects(
      byName(tools, 'team_flow_gate').execute({ finalize: true }, { agent: harness.lead, signal: EXEC_SIGNAL }),
      /did not pass/,
    )
    // …and passing them again finalizes, with the waiver visible in the report.
    const finalized = await byName(tools, 'team_flow_gate').execute({ finalize: true, overrides }, { agent: harness.lead, signal: EXEC_SIGNAL })
    assert.equal(finalized.finalized, true)
    const reportText = await readFile(join(cwd, '.agentteam', 'teams', 'session-lead', 'report.md'), 'utf8')
    assert.match(reportText, /Lead override/)
  })
})

test('reset_review defaults to the next outstanding reviewer and status reports rework rounds', () => {
  return withWorkspace(async (cwd) => {
    const harness = createHarness(cwd)
    const store = createStore({ ctx: harness.ctx, settings })
    const tools = buildTools({ ctx: harness.ctx, settings, store, version: 'test' })
    const impl = harness.addTeammate('impl')
    const rev = harness.addTeammate('rev')
    await byName(tools, 'team_flow_plan').execute(
      {
        objective: 'Reset defaults',
        acceptance_criteria: ['works'],
        items: [{ id: 'W1', subject: 'Work', owner: 'impl', write_scopes: ['src/'], definition_of_done: ['done'], reviewers: ['rev'] }],
      },
      { agent: harness.lead, signal: EXEC_SIGNAL },
    )
    await byName(tools, 'team_flow_report').execute(
      { item_id: 'W1', summary: 'v1', files: ['src/a.js'], commands: [{ command: 'true', exit_code: 0 }], evidence: ['ok'] },
      { agent: impl, signal: EXEC_SIGNAL },
    )
    await byName(tools, 'team_flow_review_submit').execute(
      {
        item_id: 'W1',
        verdict: 'request_changes',
        summary: 'one issue',
        findings: [{ id: 'F1', severity: 'major', file: 'src/a.js', line: 1, claim: 'bug' }],
        evidence_checked: ['read src/a.js'],
      },
      { agent: rev, signal: EXEC_SIGNAL },
    )
    await byName(tools, 'team_flow_review_respond').execute(
      { item_id: 'W1', responses: [{ finding_id: 'F1', state: 'fixed', evidence: 'patched' }] },
      { agent: impl, signal: EXEC_SIGNAL },
    )
    const status = await byName(tools, 'team_flow_status').execute({ item_id: 'W1' }, { agent: rev, signal: EXEC_SIGNAL })
    assert.equal(status.items[0].reviews.rework_rounds, 1, 'gate budget counts non-approving verdicts')
    assert.equal(status.items[0].reviews.submitted_rounds, 1)
    assert.equal(status.items[0].reviews.verdicts.length, 1, 'superseded/pending reviews are excluded')
    assert.equal(status.items[0].reviews.verdicts[0].verdict, 'request_changes')

    // reset_review without a reviewer picks the outstanding one.
    const reset = await byName(tools, 'team_flow_repair').execute(
      { item_id: 'W1', action: 'reset_review', reason: 'reviewer unavailable' },
      { agent: harness.lead, signal: EXEC_SIGNAL },
    )
    assert.equal(reset.item_status, 'in_review')
  })
})

test('open-queue plan publishes work, a peer claims it, and the channel records it', () => {
  return withWorkspace(async (cwd) => {
    const harness = createHarness(cwd)
    const store = createStore({ ctx: harness.ctx, settings })
    const tools = buildTools({ ctx: harness.ctx, settings, store, version: 'test' })
    const plan = byName(tools, 'team_flow_plan')
    const work = byName(tools, 'team_flow_work')
    const talk = byName(tools, 'team_flow_talk')
    const statusTool = byName(tools, 'team_flow_status')
    const read = byName(tools, 'team_flow_read')

    const impl = harness.addTeammate('impl2')
    const planResult = await plan.execute(
      {
        objective: 'Ship two independent modules together',
        acceptance_criteria: ['modules importable'],
        constraints: [],
        workers: ['impl2'],
        items: [
          {
            id: 'W1',
            subject: 'Implement the formatter',
            assignment: 'open',
            role: 'implementer',
            write_scopes: ['src/format/'],
            definition_of_done: ['formatter works'],
            needs_review: true,
          },
        ],
      },
      { agent: harness.lead, signal: EXEC_SIGNAL },
    )
    assertOutput(plan, planResult)
    assert.deepEqual(planResult.open_queue, ['W1'])
    assert.equal(planResult.queue_spawn.length, 1)
    assert.equal(planResult.queue_spawn[0].name, 'impl2')
    assert.equal(planResult.spawn.length, 0, 'open items do not produce owner spawns')
    assert.ok(byName(tools, 'team_flow_plan').parameters.properties.workers, 'the live schema must declare the workers pool parameter')
    assert.match(planResult.queue_spawn[0].prompt, /team_flow_work \{action:"claim"/)

    // The queue is visible to a peer before it is claimed.
    const before = await statusTool.execute({}, { agent: impl, signal: EXEC_SIGNAL })
    assert.deepEqual(before.collaboration.open_queue, ['W1'])

    const claimed = await work.execute({ action: 'claim', item_id: 'W1', lease_minutes: 20 }, { agent: impl, signal: EXEC_SIGNAL })
    assertOutput(work, claimed)
    assert.equal(claimed.owner, 'impl2')
    assert.equal(claimed.item_status, 'pending')
    const task = harness.tasks[0]
    assert.equal(task.status, 'in_progress', 'claiming also claims the backing Team task')
    assert.equal(task.ownerId, impl.id)

    const message = await talk.execute({ target: 'lead', kind: 'status', text: 'claimed W1 from the queue', item_id: 'W1' }, { agent: impl, signal: EXEC_SIGNAL })
    assertOutput(talk, message)
    assert.match(message.message_id, /^m\d+$/)
    assert.deepEqual(message.delivered_to, ['lead'])
    assert.match(harness.messages.at(-1).text, /\[CHANNEL m\d+\] impl2/)
    assert.equal(harness.messages.at(-1).to, 'lead')

    const readResult = await read.execute({ item_id: 'W1' }, { agent: impl, signal: EXEC_SIGNAL })
    assertOutput(read, readResult)
    assert.equal(readResult.channel.length, 2, 'claim status + talk are both on the item thread')
    assert.equal(readResult.item.owner, 'impl2')
    assert.equal(readResult.item.claim.by, 'impl2')
    assert.equal(readResult.open_queue.length, 0)
  })
})

test('peers invite, take, and finish a review through the collaboration tools', () => {
  return withWorkspace(async (cwd) => {
    const harness = createHarness(cwd)
    const store = createStore({ ctx: harness.ctx, settings })
    const tools = buildTools({ ctx: harness.ctx, settings, store, version: 'test' })
    const impl = harness.addTeammate('impl')
    const rev = harness.addTeammate('rev')
    await byName(tools, 'team_flow_plan').execute(
      {
        objective: 'Ship a module',
        acceptance_criteria: ['module works'],
        items: [
          { id: 'W1', subject: 'Implement it', assignment: 'open', role: 'implementer', write_scopes: ['src/'], definition_of_done: ['works'], needs_review: true },
        ],
        workers: ['impl'],
      },
      { agent: harness.lead, signal: EXEC_SIGNAL },
    )
    await byName(tools, 'team_flow_work').execute({ action: 'claim', item_id: 'W1' }, { agent: impl, signal: EXEC_SIGNAL })
    await byName(tools, 'team_flow_report').execute(
      {
        item_id: 'W1',
        summary: 'Implemented the module.',
        files: ['src/index.js'],
        commands: [{ command: 'node --test', exit_code: 0 }],
        evidence: ['3 tests pass'],
      },
      { agent: impl, signal: EXEC_SIGNAL },
    )

    const invited = await byName(tools, 'team_flow_work').execute({ action: 'request_review', item_id: 'W1', reviewer: 'rev' }, { agent: impl, signal: EXEC_SIGNAL })
    assert.deepEqual(invited.notifications, ['rev'])
    assert.match(harness.messages.at(-1).text, /\[REVIEW\] impl requests a peer review of W1/)

    // A reviewer who was not invited cannot take it; the invited one can.
    await assert.rejects(
      byName(tools, 'team_flow_work').execute({ action: 'take_review', item_id: 'W1' }, { agent: harness.lead, signal: EXEC_SIGNAL }),
      /belongs to "rev"|own work/,
    )
    const taken = await byName(tools, 'team_flow_work').execute({ action: 'take_review', item_id: 'W1' }, { agent: rev, signal: EXEC_SIGNAL })
    assert.equal(taken.reviewer, 'rev')

    const submitted = await byName(tools, 'team_flow_review_submit').execute(
      { item_id: 'W1', verdict: 'approve', summary: 'versus the DoD', findings: [], evidence_checked: ['read src/index.js'] },
      { agent: rev, signal: EXEC_SIGNAL },
    )
    assert.equal(submitted.item_status, 'approved')
  })
})

test('proposals are opened, voted, resolved, and can be arbitrated by the Lead', () => {
  return withWorkspace(async (cwd) => {
    const harness = createHarness(cwd)
    const store = createStore({ ctx: harness.ctx, settings })
    const tools = buildTools({ ctx: harness.ctx, settings, store, version: 'test' })
    const impl = harness.addTeammate('impl')
    const rev = harness.addTeammate('rev')
    await byName(tools, 'team_flow_plan').execute(
      {
        objective: 'Ship a module',
        acceptance_criteria: ['module works'],
        items: [{ id: 'W1', subject: 'Implement it', owner: 'impl', role: 'implementer', write_scopes: ['src/'], definition_of_done: ['works'], reviewers: ['rev'] }],
      },
      { agent: harness.lead, signal: EXEC_SIGNAL },
    )
    const decide = byName(tools, 'team_flow_decide')
    const proposal = await decide.execute(
      { action: 'propose', kind: 'dod', item_id: 'W1', text: 'Also assert the empty-input case' },
      { agent: impl, signal: EXEC_SIGNAL },
    )
    assertOutput(decide, proposal)
    assert.equal(proposal.proposal_id, 'p1')
    assert.deepEqual(proposal.notifications, ['rev'])
    assert.match(harness.messages.at(-1).text, /\[PROPOSAL\] impl opened p1/)

    const yes = await decide.execute({ action: 'vote', proposal_id: 'p1', vote: 'yes', comment: 'agreed' }, { agent: impl, signal: EXEC_SIGNAL })
    assert.equal(yes.status, 'open')
    const accepted = await decide.execute({ action: 'vote', proposal_id: 'p1', vote: 'yes' }, { agent: rev, signal: EXEC_SIGNAL })
    assert.equal(accepted.status, 'accepted')
    const status = await byName(tools, 'team_flow_status').execute({ item_id: 'W1' }, { agent: impl, signal: EXEC_SIGNAL })
    assert.equal(status.items[0].definition_of_done.includes('Also assert the empty-input case'), true, 'accepted dod proposals amend the item')

    // A tie escalates and the Lead settles it with the resolve action.
    const tied = await decide.execute({ action: 'propose', kind: 'scope', item_id: 'W1', text: 'Extend to the CLI' }, { agent: impl, signal: EXEC_SIGNAL })
    await decide.execute({ action: 'vote', proposal_id: tied.proposal_id, vote: 'yes' }, { agent: impl, signal: EXEC_SIGNAL })
    const tie = await decide.execute({ action: 'vote', proposal_id: tied.proposal_id, vote: 'no' }, { agent: rev, signal: EXEC_SIGNAL })
    assert.equal(tie.status, 'escalated')
    assert.match(tie.resolution, /tied vote/)
    await assert.rejects(decide.execute({ action: 'resolve', proposal_id: tied.proposal_id, outcome: 'rejected' }, { agent: impl, signal: EXEC_SIGNAL }), /Lead-only/)
    const settled = await decide.execute({ action: 'resolve', proposal_id: tied.proposal_id, outcome: 'rejected', comment: 'keep it tight' }, { agent: harness.lead, signal: EXEC_SIGNAL })
    assert.equal(settled.status, 'rejected')
    assert.match(harness.messages.at(-1).text, /\[DECISION\] The Lead settled/)
  })
})

test('handoffs move ownership between peers through the tools', () => {
  return withWorkspace(async (cwd) => {
    const harness = createHarness(cwd)
    const store = createStore({ ctx: harness.ctx, settings })
    const tools = buildTools({ ctx: harness.ctx, settings, store, version: 'test' })
    const impl = harness.addTeammate('impl')
    const impl2 = harness.addTeammate('impl2')
    await byName(tools, 'team_flow_plan').execute(
      {
        objective: 'Ship a module',
        acceptance_criteria: ['module works'],
        items: [{ id: 'W1', subject: 'Implement it', owner: 'impl', role: 'implementer', write_scopes: ['src/'], definition_of_done: ['works'], reviewers: ['impl2'] }],
      },
      { agent: harness.lead, signal: EXEC_SIGNAL },
    )
    const work = byName(tools, 'team_flow_work')
    await assert.rejects(work.execute({ action: 'handoff_accept', item_id: 'W1' }, { agent: impl2, signal: EXEC_SIGNAL }), /no handoff offered/)
    const offered = await work.execute({ action: 'handoff_offer', item_id: 'W1', to: 'impl2', reason: 'blocked on credentials' }, { agent: impl, signal: EXEC_SIGNAL })
    assert.deepEqual(offered.notifications, ['impl2'])
    assert.match(harness.messages.at(-1).text, /\[HANDOFF\] impl offers you W1/)
    const accepted = await work.execute({ action: 'handoff_accept', item_id: 'W1' }, { agent: impl2, signal: EXEC_SIGNAL })
    assert.equal(accepted.owner, 'impl2')
    const status = await byName(tools, 'team_flow_status').execute({}, { agent: harness.lead, signal: EXEC_SIGNAL })
    assert.equal(status.items[0].owner, 'impl2')
    assert.equal(status.items[0].claim.by, 'impl2')
  })
})

test('team_flow_read returns the channel tail, proposals and personal invitations', () => {
  return withWorkspace(async (cwd) => {
    const harness = createHarness(cwd)
    const store = createStore({ ctx: harness.ctx, settings })
    const tools = buildTools({ ctx: harness.ctx, settings, store, version: 'test' })
    const impl = harness.addTeammate('impl')
    const rev = harness.addTeammate('rev')
    await byName(tools, 'team_flow_plan').execute(
      {
        objective: 'Ship a module',
        acceptance_criteria: ['module works'],
        items: [{ id: 'W1', subject: 'Implement it', owner: 'impl', role: 'implementer', write_scopes: ['src/'], definition_of_done: ['works'], reviewers: ['rev'] }],
      },
      { agent: harness.lead, signal: EXEC_SIGNAL },
    )
    await byName(tools, 'team_flow_talk').execute({ target: 'rev', kind: 'question', text: 'Do you want the helper exported?', item_id: 'W1' }, { agent: impl, signal: EXEC_SIGNAL })
    const read = await byName(tools, 'team_flow_read').execute({}, { agent: rev, signal: EXEC_SIGNAL })
    assertOutput(byName(tools, 'team_flow_read'), read)
    assert.equal(read.questions_to_me.length, 1)
    assert.equal(read.questions_to_me[0].from, 'impl')
    assert.ok(read.next_actions.some((action) => action.includes('asked you in the channel')))
    await byName(tools, 'team_flow_talk').execute({ target: 'impl', kind: 'answer', text: 'Yes, export it.', reply_to: read.questions_to_me[0].id }, { agent: rev, signal: EXEC_SIGNAL })
    const after = await byName(tools, 'team_flow_read').execute({}, { agent: rev, signal: EXEC_SIGNAL })
    assert.equal(after.questions_to_me.length, 0)
  })
})

test('a member can add a work item and gets a real backing task', () => {
  return withWorkspace(async (cwd) => {
    const harness = createHarness(cwd)
    const store = createStore({ ctx: harness.ctx, settings })
    const tools = buildTools({ ctx: harness.ctx, settings, store, version: 'test' })
    const impl = harness.addTeammate('impl')
    const rev = harness.addTeammate('rev')
    await byName(tools, 'team_flow_plan').execute(
      {
        objective: 'Ship a module',
        acceptance_criteria: ['module works'],
        items: [{ id: 'W1', subject: 'Implement it', owner: 'impl', role: 'implementer', write_scopes: ['src/'], definition_of_done: ['works'], reviewers: ['rev'] }],
      },
      { agent: harness.lead, signal: EXEC_SIGNAL },
    )
    const before = harness.tasks.length
    const created = await byName(tools, 'team_flow_item').execute(
      {
        action: 'create',
        subject: 'Document the module',
        write_scopes: ['docs/module.md'],
        definition_of_done: ['docs describe the real API'],
        reviewers: ['rev'],
      },
      { agent: impl, signal: EXEC_SIGNAL },
    )
    assertOutput(byName(tools, 'team_flow_item'), created)
    assert.equal(created.item_id, 'S1')
    assert.equal(created.owner, 'impl')
    assert.equal(created.assignment, 'lead')
    assert.equal(created.origin, 'member')
    assert.equal(created.created_by, 'impl')
    assert.equal(typeof created.task_id, 'string')
    assert.equal(harness.tasks.length, before + 1, 'a backing task is created for autonomy too')
    assert.equal(harness.tasks.at(-1).status, 'in_progress', 'a self-owned item claims its backing task')

    const status = await byName(tools, 'team_flow_status').execute({}, { agent: impl, signal: EXEC_SIGNAL })
    const item = status.items.find((candidate) => candidate.id === 'S1')
    assert.equal(item?.assignment, 'lead')
    assert.ok(status.next_actions.some((action) => action.includes('S1')), 'the new item appears in the owner next actions')
  })
})

test('an item created for the open queue can be claimed by another peer', () => {
  return withWorkspace(async (cwd) => {
    const harness = createHarness(cwd)
    const store = createStore({ ctx: harness.ctx, settings })
    const tools = buildTools({ ctx: harness.ctx, settings, store, version: 'test' })
    const impl = harness.addTeammate('impl')
    const impl2 = harness.addTeammate('impl2')
    await byName(tools, 'team_flow_plan').execute(
      {
        objective: 'Ship a module',
        acceptance_criteria: ['module works'],
        items: [{ id: 'W1', subject: 'Implement it', owner: 'impl', role: 'implementer', write_scopes: ['src/'], definition_of_done: ['works'], reviewers: ['impl2'] }],
      },
      { agent: harness.lead, signal: EXEC_SIGNAL },
    )
    const created = await byName(tools, 'team_flow_item').execute(
      { action: 'create', subject: 'Write examples', write_scopes: ['examples/'], definition_of_done: ['examples run'], owner: 'open' },
      { agent: impl, signal: EXEC_SIGNAL },
    )
    assert.equal(created.owner, null)
    assert.equal(created.assignment, 'open')
    const status = await byName(tools, 'team_flow_status').execute({}, { agent: impl2, signal: EXEC_SIGNAL })
    assert.deepEqual(status.collaboration.open_queue, ['S1'])
    const claimed = await byName(tools, 'team_flow_work').execute({ action: 'claim', item_id: 'S1' }, { agent: impl2, signal: EXEC_SIGNAL })
    assert.equal(claimed.owner, 'impl2')
  })
})

test('status settles an expired proposal and persists the decision', () => {
  return withWorkspace(async (cwd) => {
    const harness = createHarness(cwd)
    const store = createStore({ ctx: harness.ctx, settings })
    const tools = buildTools({ ctx: harness.ctx, settings, store, version: 'test' })
    const impl = harness.addTeammate('impl')
    const rev = harness.addTeammate('rev')
    await byName(tools, 'team_flow_plan').execute(
      {
        objective: 'Ship a module',
        acceptance_criteria: ['module works'],
        items: [{ id: 'W1', subject: 'Implement it', owner: 'impl', role: 'implementer', write_scopes: ['src/'], definition_of_done: ['works'], reviewers: ['rev'] }],
      },
      { agent: harness.lead, signal: EXEC_SIGNAL },
    )
    const proposed = await byName(tools, 'team_flow_decide').execute(
      { action: 'propose', kind: 'dod', item_id: 'W1', text: 'Also assert the empty case', timeout_minutes: 1 },
      { agent: impl, signal: EXEC_SIGNAL },
    )
    assert.equal(typeof proposed.deadline, 'string')
    assert.equal(typeof proposed.quorum, 'number')
    assert.equal(proposed.quorum, 1, 'affected = owner + reviewer = 2, majority quorum is 1')

    // One affected member votes yes; quorum is 1, so the deadline decides acceptance.
    await byName(tools, 'team_flow_decide').execute(
      { action: 'vote', proposal_id: proposed.proposal_id, vote: 'yes', comment: 'agreed' },
      { agent: impl, signal: EXEC_SIGNAL },
    )
    // Rewind the deadline as if the vote window had already closed.
    const state = await store.readState(harness.lead)
    state.proposals[0].deadline = new Date(Date.now() - 60_000).toISOString()
    await store.writeState(harness.lead, state)

    const status = await byName(tools, 'team_flow_status').execute({}, { agent: impl, signal: EXEC_SIGNAL })
    assert.equal(status.items[0].open_proposals, 0, 'the expired blocking proposal no longer blocks')
    assert.deepEqual(status.collaboration.proposals_open, [])
    const readBack = await store.readState(harness.lead)
    assert.equal(readBack.proposals[0].status, 'accepted')
    assert.equal(readBack.proposals[0].autoResolved, true)
    assert.match(readBack.proposals[0].resolution, /auto-accepted/)
    assert.equal(readBack.items[0].definitionOfDone.includes('Also assert the empty case'), true)
  })
})

test('the plan staffs its own Team: spawns missing owners and wakes inactive reviewers', async () => {
  return withWorkspace(async (cwd) => {
    const harness = createHarness(cwd)
    const store = createStore({ ctx: harness.ctx, settings })
    const tools = buildTools({ ctx: harness.ctx, settings, store, version: 'test' })
    harness.addTeammate('rev-old')
    const plan = await byName(tools, 'team_flow_plan').execute(
      {
        objective: 'Ship a module',
        acceptance_criteria: ['module works'],
        items: [{ id: 'W1', subject: 'Implement it', owner: 'impl-new', write_scopes: ['src/'], definition_of_done: ['works'], reviewers: ['rev-old'] }],
      },
      { agent: harness.lead, signal: EXEC_SIGNAL },
    )
    assert.equal(plan.staffed.spawned.length, 1)
    assert.deepEqual(plan.staffed.spawned[0], { name: 'impl-new', kind: 'worker' })
    assert.deepEqual(plan.staffed.woken, ['rev-old'])
    assert.ok(harness.ctx.agentTeams.listMembers().some((member) => member.name === 'impl-new'))
    const resume = harness.messages.find((message) => message.to === 'rev-old')
    assert.match(resume.text, /^\[RESUME\]/)
  })
})

test('staffing respects the eight-member roster limit', async () => {
  return withWorkspace(async (cwd) => {
    const harness = createHarness(cwd)
    const store = createStore({ ctx: harness.ctx, settings })
    const tools = buildTools({ ctx: harness.ctx, settings, store, version: 'test' })
    for (const name of ['one', 'two', 'three', 'four', 'five', 'six', 'seven']) harness.addTeammate(name)
    const plan = await byName(tools, 'team_flow_plan').execute(
      {
        objective: 'Ship a module',
        acceptance_criteria: ['module works'],
        items: [{ id: 'W1', subject: 'Implement it', owner: 'impl-new', write_scopes: ['src/'], definition_of_done: ['works'], reviewers: ['one'] }],
      },
      { agent: harness.lead, signal: EXEC_SIGNAL },
    )
    assert.equal(plan.staffed.spawned.length, 0)
    assert.equal(plan.staffed.needs_spawn[0].name, 'impl-new')
    assert.match(plan.staffed.needs_spawn[0].reason, /limit 8/)
    assert.ok(!harness.ctx.agentTeams.listMembers().some((member) => member.name === 'impl-new'))
  })
})

test('team_flow_staff fills later waves on demand', async () => {
  return withWorkspace(async (cwd) => {
    const harness = createHarness(cwd)
    const store = createStore({ ctx: harness.ctx, settings })
    const tools = buildTools({ ctx: harness.ctx, settings, store, version: 'test' })
    const impl = harness.addTeammate('impl')
    harness.addTeammate('rev')
    await byName(tools, 'team_flow_plan').execute(
      {
        objective: 'Ship a module',
        acceptance_criteria: ['module works'],
        items: [
          { id: 'W1', subject: 'Implement it', owner: 'impl', write_scopes: ['src/'], definition_of_done: ['works'], reviewers: ['rev'] },
          { id: 'W2', subject: 'Write the guide', assignment: 'open', write_scopes: ['docs/'], definition_of_done: ['guide works'], reviewers: [] },
        ],
        workers: ['pool-a'],
        auto_spawn: false,
      },
      { agent: harness.lead, signal: EXEC_SIGNAL },
    )
    const staffed = await byName(tools, 'team_flow_staff').execute({}, { agent: harness.lead, signal: EXEC_SIGNAL })
    assertOutput(byName(tools, 'team_flow_staff'), staffed)
    assert.deepEqual(staffed.staffed.spawned.map((entry) => entry.name), ['pool-a'])
    const again = await byName(tools, 'team_flow_staff').execute({}, { agent: harness.lead, signal: EXEC_SIGNAL })
    assert.equal(again.staffed.spawned.length, 0, 'staffing is idempotent')
    assert.ok(again.staffed.skipped.includes('pool-a'))
  })
})

test('team_flow_git refuses to run while the workflow is disabled', () => {
  return withWorkspace(async (cwd) => {
    const harness = createHarness(cwd)
    const store = createStore({ ctx: harness.ctx, settings })
    const tools = buildTools({ ctx: harness.ctx, settings, store, version: 'test' })
    harness.addTeammate('impl')
    await byName(tools, 'team_flow_plan').execute(
      {
        objective: 'Ship a module',
        acceptance_criteria: ['module works'],
        items: [{ id: 'W1', subject: 'Implement it', owner: 'impl', write_scopes: ['src/'], definition_of_done: ['works'], reviewers: ['rev'] }],
        auto_spawn: false,
      },
      { agent: harness.lead, signal: EXEC_SIGNAL },
    )
    await assert.rejects(
      () => byName(tools, 'team_flow_git').execute({ action: 'status' }, { agent: harness.lead, signal: EXEC_SIGNAL }),
      /git workflow is disabled/,
    )
  })
})

test('git workflow end to end: prepare, commit, verify, push, PR, gate, merge', async () => {
  return withWorkspace(async (cwd) => {
    const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
    git('init', '-q', '-b', 'main')
    git('config', 'user.email', 'team@example.com')
    git('config', 'user.name', 'Agent Team')
    await (await import('node:fs/promises')).writeFile(join(cwd, 'README.md'), '# demo\n', 'utf8')
    await (await import('node:fs/promises')).writeFile(join(cwd, '.gitignore'), '.agentteam/\n', 'utf8')
    git('add', 'README.md', '.gitignore')
    git('commit', '-q', '-m', 'chore: baseline')
    const remoteDir = await mkdtemp(join(tmpdir(), 'atw-remote-'))
    execFileSync('git', ['init', '-q', '--bare', remoteDir], { stdio: 'ignore' })
    git('remote', 'add', 'origin', remoteDir)

    const gitSettings = resolveSettings({ gitEnabled: true, gitBaseBranch: 'main', gitVerifyCommands: ['printf verified'] })
    const harness = createHarness(cwd)
    const store = createStore({ ctx: harness.ctx, settings: gitSettings })
    const tools = buildTools({ ctx: harness.ctx, settings: gitSettings, store, version: 'test' })
    const impl = harness.addTeammate('impl')
    const rev = harness.addTeammate('rev')
    await byName(tools, 'team_flow_plan').execute(
      {
        objective: 'Ship a feature',
        acceptance_criteria: ['feature lands'],
        items: [{ id: 'W1', subject: 'Add feature', owner: 'impl', write_scopes: ['src/'], definition_of_done: ['feature works'], reviewers: ['rev'] }],
        auto_spawn: false,
      },
      { agent: harness.lead, signal: EXEC_SIGNAL },
    )
    const prepared = await byName(tools, 'team_flow_git').execute({ action: 'prepare' }, { agent: harness.lead, signal: EXEC_SIGNAL })
    assertOutput(byName(tools, 'team_flow_git'), prepared)
    assert.match(prepared.run_git.branch, /^agentteam\//)
    assert.equal(git('branch', '--show-current'), prepared.run_git.branch)

    await (await import('node:fs/promises')).mkdir(join(cwd, 'src'), { recursive: true })
    await (await import('node:fs/promises')).writeFile(join(cwd, 'src', 'feature.txt'), 'feature\n', 'utf8')
    const committed = await byName(tools, 'team_flow_git').execute(
      { action: 'commit', item_id: 'W1', files: ['src/feature.txt'] },
      { agent: impl, signal: EXEC_SIGNAL },
    )
    assert.equal(typeof committed.item_git.sha, 'string')
    const verified = await byName(tools, 'team_flow_git').execute({ action: 'verify', item_id: 'W1' }, { agent: impl, signal: EXEC_SIGNAL })
    assert.equal(verified.item_git.verify.ok, true)
    const pushed = await byName(tools, 'team_flow_git').execute({ action: 'push', item_id: 'W1' }, { agent: impl, signal: EXEC_SIGNAL })
    assert.equal(typeof pushed.run_git.pushedAt, 'string')
    const pr = await byName(tools, 'team_flow_git').execute({ action: 'pr', item_id: 'W1' }, { agent: impl, signal: EXEC_SIGNAL })
    assert.equal(pr.run_git.pr.mode, 'manual', 'a local bare remote cannot answer gh, so the workflow falls back to a manual PR record')

    const report = {
      summary: 'feature added', files: ['src/feature.txt'], commands: [{ command: 'true', exit_code: 0 }], evidence: ['file created'], openQuestions: [], risks: [],
    }
    await byName(tools, 'team_flow_report').execute({ item_id: 'W1', ...report }, { agent: impl, signal: EXEC_SIGNAL })
    await byName(tools, 'team_flow_review_submit').execute(
      { item_id: 'W1', verdict: 'approve', summary: 'verified', findings: [], evidence_checked: ['read src/feature.txt'] },
      { agent: rev, signal: EXEC_SIGNAL },
    )
    const gate = await byName(tools, 'team_flow_gate').execute({ finalize: true }, { agent: harness.lead, signal: EXEC_SIGNAL })
    assert.equal(gate.pass, true)
    const merged = await byName(tools, 'team_flow_git').execute({ action: 'merge' }, { agent: harness.lead, signal: EXEC_SIGNAL })
    assert.equal(typeof merged.run_git.mergedAt, 'string')
    assert.equal(merged.run_git.mergeMode, 'local')
    assert.equal(git('branch', '--show-current'), 'main')
    assert.match(git('show', '--stat', '--oneline', 'HEAD'), /feature|Merge/)
    const mergedText = await (await import('node:fs/promises')).readFile(join(cwd, 'src', 'feature.txt'), 'utf8')
    assert.equal(mergedText.trim(), 'feature')
  })
})

test('team-wide notices only reach run participants, not the idle roster', () => {
  return withWorkspace(async (cwd) => {
    const harness = createHarness(cwd)
    const store = createStore({ ctx: harness.ctx, settings })
    const tools = buildTools({ ctx: harness.ctx, settings, store, version: 'test' })
    const impl = harness.addTeammate('impl')
    const rev = harness.addTeammate('rev')
    const idle = harness.addTeammate('idle-one')
    const idle2 = harness.addTeammate('idle-two')
    await byName(tools, 'team_flow_plan').execute(
      {
        objective: 'Ship a module',
        acceptance_criteria: ['module works'],
        items: [{ id: 'W1', subject: 'Implement it', owner: 'impl', write_scopes: ['src/'], definition_of_done: ['works'], reviewers: ['rev'] }],
        auto_spawn: false,
      },
      { agent: harness.lead, signal: EXEC_SIGNAL },
    )
    await byName(tools, 'team_flow_report').execute(
      {
        item_id: 'W1',
        summary: 'implemented',
        files: ['src/core/run.js'],
        commands: [{ command: 'true', exit_code: 0 }],
        evidence: ['file exists'],
        open_questions: [],
        risks: [],
      },
      { agent: impl, signal: EXEC_SIGNAL },
    )
    // A team broadcast from the channel tool follows the participant rule.
    const beforeTalk = harness.messages.length
    await byName(tools, 'team_flow_talk').execute(
      { target: 'team', kind: 'note', text: 'standup in five' },
      { agent: impl, signal: EXEC_SIGNAL },
    )
    const talked = harness.messages.slice(beforeTalk).map((message) => message.to).sort()
    assert.deepEqual(talked, ['rev'], 'channel team messages are delivered to participants')

    // Publishing an open-queue item pings the pool, not the whole roster.
    const beforeItem = harness.messages.length
    await byName(tools, 'team_flow_item').execute(
      { action: 'create', subject: 'Write the guide', write_scopes: ['docs/'], definition_of_done: ['guide works'], owner: 'open' },
      { agent: impl, signal: EXEC_SIGNAL },
    )
    const posted = harness.messages.slice(beforeItem).map((message) => message.to)
    assert.ok(posted.includes('rev'), 'participants hear about a new open item')
    assert.ok(!posted.includes('idle-one') && !posted.includes('idle-two'), 'idle roster members are not woken')
    assert.equal(typeof idle.id, 'string')
    assert.equal(typeof idle2.id, 'string')
  })
})

test('a configured role picks the spawn provider and appends its guidance', () => {
  return withWorkspace(async (cwd) => {
    const harness = createHarness(cwd)
    const roleSettings = resolveSettings({
      roles: {
        'fast-reviewer': { provider: 'review-fast', prompt: 'Focus on injection, secrets and auth boundaries.' },
      },
    })
    const store = createStore({ ctx: harness.ctx, settings: roleSettings })
    const tools = buildTools({ ctx: harness.ctx, settings: roleSettings, store, version: 'test' })
    harness.addTeammate('rev')
    const plan = await byName(tools, 'team_flow_plan').execute(
      {
        objective: 'Ship a module',
        acceptance_criteria: ['module works'],
        items: [{ id: 'W1', subject: 'Implement it', owner: 'impl-new', role: 'fast-reviewer', write_scopes: ['src/'], definition_of_done: ['works'], reviewers: ['rev'] }],
      },
      { agent: harness.lead, signal: EXEC_SIGNAL },
    )
    assert.deepEqual(plan.staffed.spawned.map((entry) => entry.name), ['impl-new'])
    const spawn = harness.spawns.find((entry) => entry.name === 'impl-new')
    assert.equal(spawn.provider, 'review-fast', 'the role provider selects the spawn provider (and thus the model)')
    assert.match(spawn.prompt, /Focus on injection, secrets and auth boundaries/, 'role guidance is appended to the brief')
    assert.equal(spawn.context, 'fresh')
    // The role assignment is frozen into the run and surfaced by the status tool.
    const status = await byName(tools, 'team_flow_status').execute({}, { agent: harness.lead, signal: EXEC_SIGNAL })
    assert.equal(status.items[0].role, 'fast-reviewer')
    const raw = await store.readState(harness.lead)
    assert.equal(raw.roleAssignments['impl-new'], undefined, 'item roles live on the item; role assignments stay for explicit worker roles')
  })
})

test('graceful stop: request, accept and interrupt', () => {
  return withWorkspace(async (cwd) => {
    const harness = createHarness(cwd)
    const store = createStore({ ctx: harness.ctx, settings })
    const tools = buildTools({ ctx: harness.ctx, settings, store, version: 'test' })
    const impl = harness.addTeammate('impl')
    const rev = harness.addTeammate('rev')
    await byName(tools, 'team_flow_plan').execute(
      {
        objective: 'Ship a module',
        acceptance_criteria: ['works'],
        items: [{ id: 'W1', subject: 'Implement it', owner: 'impl', write_scopes: ['src/'], definition_of_done: ['works'], reviewers: ['rev'] }],
        auto_spawn: false,
      },
      { agent: harness.lead, signal: EXEC_SIGNAL },
    )
    const requested = await byName(tools, 'team_flow_stop').execute({ action: 'request', member: 'impl', reason: 'wind down' }, { agent: harness.lead, signal: EXEC_SIGNAL })
    assertOutput(byName(tools, 'team_flow_stop'), requested)
    assert.equal(requested.stop.status, 'pending')
    assert.equal(harness.messages.at(-1).to, 'impl')
    assert.match(harness.messages.at(-1).text, /^\[SHUTDOWN\]/)

    // A member cannot answer a request addressed to someone else.
    await assert.rejects(
      () => byName(tools, 'team_flow_stop').execute({ action: 'accept' }, { agent: rev, signal: EXEC_SIGNAL }),
      /no pending stop request/,
    )
    const accepted = await byName(tools, 'team_flow_stop').execute({ action: 'accept' }, { agent: impl, signal: EXEC_SIGNAL })
    assert.equal(accepted.stop.status, 'accepted')
    assert.match(harness.messages.at(-1).text, /impl accepted/)

    const forced = await byName(tools, 'team_flow_stop').execute({ action: 'interrupt', member: 'rev', reason: 'stuck' }, { agent: harness.lead, signal: EXEC_SIGNAL })
    assert.equal(forced.stop.status, 'interrupted')
    assert.equal(forced.stop.mode, 'interrupt')
    assert.deepEqual(harness.interrupts, ['rev'])
    const status = await byName(tools, 'team_flow_stop').execute({ action: 'status' }, { agent: harness.lead, signal: EXEC_SIGNAL })
    assert.equal(status.stops.length, 2)
  })
})

test('lifecycle hooks can veto item creation, approval and going idle', () => {
  return withWorkspace(async (cwd) => {
    const hookSettings = resolveSettings({
      hooks: { taskCreated: [{ command: 'exit 2' }] },
    })
    const harness = createHarness(cwd)
    const store = createStore({ ctx: harness.ctx, settings: hookSettings })
    const tools = buildTools({ ctx: harness.ctx, settings: hookSettings, store, version: 'test' })
    harness.addTeammate('impl')
    harness.addTeammate('rev')
    await assert.rejects(
      () => byName(tools, 'team_flow_plan').execute(
        {
          objective: 'blocked by hook',
          acceptance_criteria: ['x'],
          items: [{ id: 'W1', subject: 'Implement it', owner: 'impl', write_scopes: ['src/'], definition_of_done: ['works'], reviewers: ['rev'] }],
        },
        { agent: harness.lead, signal: EXEC_SIGNAL },
      ),
      /taskCreated hook blocked/,
    )
    assert.equal(await store.readState(harness.lead), null, 'a vetoed plan writes nothing')

    // Approval veto: plan without hooks, then submit with a blocking taskCompleted hook.
    const okSettings = resolveSettings({})
    const okStore = createStore({ ctx: harness.ctx, settings: okSettings })
    const okTools = buildTools({ ctx: harness.ctx, settings: okSettings, store: okStore, version: 'test' })
    await byName(okTools, 'team_flow_plan').execute(
      {
        objective: 'ship',
        acceptance_criteria: ['works'],
        items: [{ id: 'W1', subject: 'Implement it', owner: 'impl', write_scopes: ['src/'], definition_of_done: ['works'], reviewers: ['rev'] }],
        auto_spawn: false,
      },
      { agent: harness.lead, signal: EXEC_SIGNAL },
    )
    await byName(okTools, 'team_flow_report').execute(
      { item_id: 'W1', summary: 'done', files: ['src/x.js'], commands: [{ command: 'true', exit_code: 0 }], evidence: ['ran it'], open_questions: [], risks: [] },
      { agent: harness.addTeammate('impl'), signal: EXEC_SIGNAL },
    )
    // Swap in a blocking hook by rewriting the run settings, then approve.
    await okStore.mutateState(harness.lead, (state) => {
      state.settings.hooks = { taskCreated: [], taskCompleted: [{ command: 'echo "tests not green" >&2; exit 2' }], teammateIdle: [] }
      return state
    })
    const reviewer = harness.addTeammate('rev')
    await assert.rejects(
      () => byName(okTools, 'team_flow_review_submit').execute(
        { item_id: 'W1', verdict: 'approve', summary: 'looks good', findings: [], evidence_checked: ['read src/x.js'] },
        { agent: reviewer, signal: EXEC_SIGNAL },
      ),
      /taskCompleted hook blocked/,
    )
    const state = await okStore.readState(harness.lead)
    assert.notEqual(state.items[0].status, 'approved', 'the vetoed approval did not land')

    // Idle veto: a stop request cannot be accepted while the idle hook blocks.
    await okStore.mutateState(harness.lead, (current) => {
      current.settings.hooks = { taskCreated: [], taskCompleted: [], teammateIdle: [{ command: 'exit 2' }] }
      return current
    })
    await byName(okTools, 'team_flow_stop').execute({ action: 'request', member: 'rev' }, { agent: harness.lead, signal: EXEC_SIGNAL })
    await assert.rejects(
      () => byName(okTools, 'team_flow_stop').execute({ action: 'accept' }, { agent: reviewer, signal: EXEC_SIGNAL }),
      /teammateIdle hook blocked/,
    )
    const after = await okStore.readState(harness.lead)
    assert.equal(after.stops[0].status, 'pending', 'the member stays running and can retry')
  })
})

test('plan-first: submit, block, approve, then report', () => {
  return withWorkspace(async (cwd) => {
    const planSettings = resolveSettings({ planFirst: true, autoApprovePlan: false, planApprover: 'lead' })
    const harness = createHarness(cwd)
    const store = createStore({ ctx: harness.ctx, settings: planSettings })
    const tools = buildTools({ ctx: harness.ctx, settings: planSettings, store, version: 'test' })
    const impl = harness.addTeammate('impl')
    const rev = harness.addTeammate('rev')
    await byName(tools, 'team_flow_plan').execute(
      {
        objective: 'ship',
        acceptance_criteria: ['works'],
        items: [{ id: 'W1', subject: 'Implement it', owner: 'impl', write_scopes: ['src/'], definition_of_done: ['works'], reviewers: ['rev'] }],
        auto_spawn: false,
      },
      { agent: harness.lead, signal: EXEC_SIGNAL },
    )
    const reportArgs = { item_id: 'W1', summary: 'done', files: ['src/x.js'], commands: [{ command: 'true', exit_code: 0 }], evidence: ['ran it'], open_questions: [], risks: [] }
    await assert.rejects(
      () => byName(tools, 'team_flow_report').execute(reportArgs, { agent: impl, signal: EXEC_SIGNAL }),
      /plan-first/,
    )
    const submitted = await byName(tools, 'team_flow_plan_approval').execute(
      { action: 'submit', item_id: 'W1', plan: { steps: ['read', 'implement', 'test'], files: ['src/x.js'], risks: ['none'] } },
      { agent: impl, signal: EXEC_SIGNAL },
    )
    assertOutput(byName(tools, 'team_flow_plan_approval'), submitted)
    assert.equal(submitted.plan.status, 'pending')
    const blockedStatus = await byName(tools, 'team_flow_status').execute({}, { agent: harness.lead, signal: EXEC_SIGNAL })
    assert.ok(blockedStatus.next_actions.some((action) => action.includes('Plans awaiting approval')), 'the Lead is told a plan awaits approval')
    const approved = await byName(tools, 'team_flow_plan_approval').execute({ action: 'approve', item_id: 'W1' }, { agent: harness.lead, signal: EXEC_SIGNAL })
    assert.equal(approved.plan.status, 'approved')
    const reported = await byName(tools, 'team_flow_report').execute(reportArgs, { agent: impl, signal: EXEC_SIGNAL })
    assert.equal(reported.status, 'in_review')
  })
})

test('a role can deny specific workflow actions', () => {
  return withWorkspace(async (cwd) => {
    const roleSettings = resolveSettings({ roles: { auditor: { deny: ['team_flow_report', 'team_flow_item'] } } })
    const harness = createHarness(cwd)
    const store = createStore({ ctx: harness.ctx, settings: roleSettings })
    const tools = buildTools({ ctx: harness.ctx, settings: roleSettings, store, version: 'test' })
    const impl = harness.addTeammate('impl')
    const rev = harness.addTeammate('rev')
    await byName(tools, 'team_flow_plan').execute(
      {
        objective: 'audit',
        acceptance_criteria: ['audited'],
        items: [{ id: 'W1', subject: 'Audit it', owner: 'impl', role: 'auditor', write_scopes: ['src/'], definition_of_done: ['audited'], reviewers: ['rev'] }],
        workers: [{ name: 'impl', role: 'auditor' }],
        auto_spawn: false,
      },
      { agent: harness.lead, signal: EXEC_SIGNAL },
    )
    await assert.rejects(
      () => byName(tools, 'team_flow_report').execute(
        { item_id: 'W1', summary: 'done', files: ['src/x.js'], commands: [{ command: 'true', exit_code: 0 }], evidence: ['x'], open_questions: [], risks: [] },
        { agent: impl, signal: EXEC_SIGNAL },
      ),
      /role "auditor" may not use team_flow_report/,
    )
    await assert.rejects(
      () => byName(tools, 'team_flow_item').execute(
        { action: 'create', subject: 'extra', write_scopes: ['src/extra.js'], definition_of_done: ['works'] },
        { agent: impl, signal: EXEC_SIGNAL },
      ),
      /role "auditor" may not use team_flow_item/,
    )
    // The reviewer role is unrestricted.
    const status = await byName(tools, 'team_flow_status').execute({}, { agent: rev, signal: EXEC_SIGNAL })
    assert.equal(status.run_id !== undefined || status.phase !== undefined, true)
  })
})

test('the gate captures token usage and enforces budgets', () => {
  return withWorkspace(async (cwd) => {
    const harness = createHarness(cwd)
    const budgetSettings = resolveSettings({ tokenBudgetPerMember: 100 })
    const store = createStore({ ctx: harness.ctx, settings: budgetSettings })
    const usage = (agent) => ({ totals: agent?.id === 'session-impl' ? { uncachedInputTokens: 300, outputTokens: 250, cacheReadTokens: 0, cacheWriteTokens: 0 } : { uncachedInputTokens: 10, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 }, last: null })
    const tools = buildTools({ ctx: harness.ctx, settings: budgetSettings, store, version: 'test', tokenUsage: () => usage })
    const impl = harness.addTeammate('impl')
    const rev = harness.addTeammate('rev')
    await byName(tools, 'team_flow_plan').execute(
      {
        objective: 'ship',
        acceptance_criteria: ['works'],
        items: [{ id: 'W1', subject: 'Implement it', owner: 'impl', write_scopes: ['src/'], definition_of_done: ['works'], reviewers: ['rev'] }],
        auto_spawn: false,
      },
      { agent: harness.lead, signal: EXEC_SIGNAL },
    )
    await byName(tools, 'team_flow_report').execute(
      { item_id: 'W1', summary: 'done', files: ['src/x.js'], commands: [{ command: 'true', exit_code: 0 }], evidence: ['ran'], open_questions: [], risks: [] },
      { agent: impl, signal: EXEC_SIGNAL },
    )
    await byName(tools, 'team_flow_review_submit').execute(
      { item_id: 'W1', verdict: 'approve', summary: 'ok', findings: [], evidence_checked: ['read it'] },
      { agent: rev, signal: EXEC_SIGNAL },
    )
    const gate = await byName(tools, 'team_flow_gate').execute({ finalize: false }, { agent: harness.lead, signal: EXEC_SIGNAL })
    assert.equal(gate.pass, false)
    assert.ok(gate.team_failures.some((failure) => failure.includes('used 550 tokens')), 'the per-member budget failure is reported')
    const state = await store.readState(harness.lead)
    assert.equal(state.usage.members.impl.outputTokens, 250)
    assert.equal(state.usage.totals.outputTokens, 270)
  })
})
