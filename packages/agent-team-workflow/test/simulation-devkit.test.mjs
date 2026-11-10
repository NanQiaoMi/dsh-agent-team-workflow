/**
 * Simulation: Local DevKit, Interface Contracts, and Mock Stub Multi-Agent Workflow
 *
 * Verifies:
 * 1. Zero-grep codebase structure lookup via team_dev_lookup & CLI (inspect/scan)
 * 2. Contract publishing & parallel unblocking of downstream workers via mock stub generation
 * 3. Handoff packet automated static contract validation during team_flow_report
 * 4. Strict contract violation rejection & compliance approval
 * 5. Downstream worker waking with upstream handoff packet payload
 * 6. Gate finalization and CLI verification end-to-end
 */

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import test from 'node:test'

import { resolveSettings } from '../lib/config.js'
import { ensureDevkit, publishContract } from '../lib/devkit.js'
import { createOrchestrator } from '../lib/orchestrator.js'
import { createStore } from '../lib/store.js'
import { buildTools } from '../lib/tools.js'
import * as W from '../lib/workflow.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const CLI_PATH = join(__dirname, '../bin/agent-team-dev.mjs')

function createSimulationHarness(cwd) {
  const agents = new Map()
  const members = []
  const tasks = new Map()
  const messages = []

  function addMember(name, role, id) {
    const agent = { id }
    agents.set(id, agent)
    members.push({ name, role, id, status: role === 'lead' ? 'running' : 'inactive' })
    return agent
  }

  const leadAgent = addMember('lead', 'lead', 'session-lead')
  const aliceAgent = addMember('alice', 'implementer', 'session-alice')
  const bobAgent = addMember('bob', 'implementer', 'session-bob')
  const carolAgent = addMember('carol', 'reviewer', 'session-carol')

  const agentTeams = {
    tryMembership(agent) {
      const m = members.find((entry) => entry.id === agent?.id)
      if (!m) return undefined
      return { root: leadAgent, id: agent.id, name: m.name, role: m.role }
    },
    membership(agent) {
      const res = this.tryMembership(agent)
      if (!res) throw new Error('not a team member')
      return res
    },
    listMembers() {
      return [...members]
    },
    async getTask(_agent, taskId) {
      return tasks.get(taskId) ?? null
    },
    async createTask(_agent, req) {
      const task = {
        id: `task-${tasks.size + 1}`,
        subject: req.subject,
        description: req.description,
        status: req.status ?? 'pending',
        revision: 1,
      }
      tasks.set(task.id, task)
      return { ...task }
    },
    async updateTask(_agent, req) {
      const task = tasks.get(req.taskId)
      if (!task) throw new Error(`task "${req.taskId}" not found`)
      if (req.status) task.status = req.status
      task.revision += 1
      return { ...task }
    },
    async sendMessage(caller, req) {
      const sender = members.find((m) => m.id === caller?.id)?.name ?? caller?.id
      messages.push({ from: sender, to: req.target, text: req.content[0]?.text ?? '' })
      return { messageId: `msg-${messages.length}` }
    },
  }

  const ctx = {
    agents: {
      list: () => [...agents.values()],
      get: (id) => agents.get(id),
    },
    workingDirectory: { get: () => cwd, defaultDirectory: cwd },
    agentTeams,
    logger: { info() {}, warn() {}, error() {} },
  }

  return { ctx, lead: leadAgent, alice: aliceAgent, bob: bobAgent, carol: carolAgent, messages, tasks, members }
}

test('end-to-end devkit & contracts simulation: scan, lookup, stub parallelization, contract gating, handoff transfer, and CLI', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'devkit-sim-'))
  try {
    // 1. Prepare codebase structure
    await writeFile(
      join(cwd, 'package.json'),
      JSON.stringify(
        {
          name: '@demo/commerce-service',
          version: '1.0.0',
          type: 'module',
          scripts: { test: 'node --test' },
        },
        null,
        2,
      ),
      'utf8',
    )
    await mkdir(join(cwd, 'src/auth'), { recursive: true })
    await mkdir(join(cwd, 'src/checkout'), { recursive: true })
    await writeFile(join(cwd, 'src/auth/index.js'), 'export const DUMMY = 1\n', 'utf8')
    await writeFile(join(cwd, 'src/checkout/index.js'), 'export const DUMMY = 2\n', 'utf8')

    // 2. Run CLI scan & inspect
    const scanOutput = execFileSync(process.execPath, [CLI_PATH, 'scan', '--cwd', cwd], { encoding: 'utf8' })
    assert.match(scanOutput, /Project: @demo\/commerce-service/)
    assert.match(scanOutput, /Discovered 2 modules/)

    const inspectOutput = execFileSync(process.execPath, [CLI_PATH, 'inspect', 'auth', '--cwd', cwd], { encoding: 'utf8' })
    assert.match(inspectOutput, /Module: auth/)
    assert.match(inspectOutput, /Entry:\s+src\/auth\/index\.js/)

    // 3. Initialize multi-agent workflow harness
    const harness = createSimulationHarness(cwd)
    const settings = resolveSettings({
      writeArtifacts: true,
      strictContracts: true,
      autoOrchestrate: true,
      autoWakeUnblocked: true,
      autoWakeReviewers: true,
      requireReviewEvidence: true,
    })
    const store = createStore({ ctx: harness.ctx, settings })
    let orchestrator = null
    const allTools = buildTools({
      ctx: harness.ctx,
      settings,
      store,
      version: '1.27.0',
      triggerOrchestrator: () => {
        if (orchestrator) orchestrator.reconcile(harness.lead, { force: true }).catch(() => {})
      },
    })
    orchestrator = createOrchestrator({
      ctx: harness.ctx,
      store,
      settings,
    })

    const tool = (name) => {
      const t = allTools.find((candidate) => candidate.name === name)
      if (!t) throw new Error(`tool "${name}" not found`)
      return t
    }

    // 4. Lead planning phase using devkit
    const lookupRes = await tool('team_dev_lookup').execute({ action: 'modules' }, { agent: harness.lead })
    assert.equal(lookupRes.project, '@demo/commerce-service')
    assert.ok(lookupRes.modules.auth)
    assert.ok(lookupRes.modules.checkout)

    const planRes = await tool('team_flow_plan').execute(
      {
        objective: 'Implement decoupled Auth and Checkout services with contracts',
        acceptance_criteria: ['Auth satisfies auth-contract-v1', 'Checkout verifies using Auth contract'],
        items: [
          {
            id: 'W1',
            subject: 'Auth Token Service',
            owner: 'alice',
            reviewers: ['carol'],
            write_scopes: ['src/auth/'],
            definition_of_done: ['exports verifyToken and signToken', 'passes unit test'],
          },
          {
            id: 'W2',
            subject: 'Checkout Price Calculator',
            owner: 'bob',
            reviewers: ['carol'],
            blocked_by: ['W1'],
            write_scopes: ['src/checkout/', 'mocks/'],
            definition_of_done: ['consumes auth and calculates cart totals'],
          },
        ],
      },
      { agent: harness.lead },
    )
    assert.equal(planRes.phase, W.RUN_PHASE.PLANNED)

    // 5. Alice publishes contract
    const contractDef = {
      $id: 'auth-contract-v1',
      title: 'Auth Service Contract',
      version: '1.0.0',
      methods: {
        verifyToken: {
          description: 'Verify JWT and return payload',
          input: { type: 'object', required: ['token'], properties: { token: { type: 'string' } } },
          output: { type: 'object', required: ['valid', 'userId'], properties: { valid: { type: 'boolean' }, userId: { type: 'string' } } },
        },
        signToken: {
          description: 'Sign payload into JWT token',
          input: { type: 'object', required: ['userId'], properties: { userId: { type: 'string' } } },
          output: { type: 'object', required: ['token'], properties: { token: { type: 'string' } } },
        },
      },
      mock: {
        verifyToken: { valid: true, userId: 'user-vip-42' },
        signToken: { token: 'jwt-mock-secret' },
      },
    }
    const pubRes = await tool('team_dev_contract').execute(
      { action: 'publish', contract: contractDef },
      { agent: harness.alice },
    )
    assert.equal(pubRes.ok, true)
    assert.equal(pubRes.contract_id, 'auth-contract-v1')

    // 6. Bob (blocked on W1) unblocks himself in parallel by generating a mock stub!
    const stubRes = await tool('team_dev_contract').execute(
      {
        action: 'stub',
        contract_id: 'auth-contract-v1',
        format: 'esm',
        write_to: 'mocks/auth.mock.js',
      },
      { agent: harness.bob },
    )
    assert.equal(stubRes.ok, true)
    assert.equal(stubRes.written, true)

    // Bob writes checkout logic against the mock stub immediately
    await writeFile(
      join(cwd, 'src/checkout/index.js'),
      `
      import { verifyToken } from '../../mocks/auth.mock.js'

      export async function calculateTotal(cart, token) {
        const auth = await verifyToken({ token })
        if (!auth.valid) throw new Error('Unauthorized')
        const discount = auth.userId === 'user-vip-42' ? 0.2 : 0
        const subtotal = cart.items.reduce((acc, i) => acc + i.price * i.qty, 0)
        return { total: subtotal * (1 - discount), userId: auth.userId }
      }
      `,
      'utf8',
    )

    // Bob runs test against mock stub -> passes!
    const mockContent = await readFile(join(cwd, 'mocks/auth.mock.js'), 'utf8')
    assert.match(mockContent, /export async function verifyToken/)
    assert.match(mockContent, /user-vip-42/)

    // 7. Alice implements Auth Service but accidentally forgets signToken
    await writeFile(
      join(cwd, 'src/auth/index.js'),
      `
      export async function verifyToken({ token }) {
        return { valid: token === 'real-jwt', userId: 'user-vip-42' }
      }
      `,
      'utf8',
    )

    // Alice tries to report in strictContracts mode -> REJECTED because signToken is missing!
    await assert.rejects(
      async () => {
        await tool('team_flow_report').execute(
          {
            item_id: 'W1',
            summary: 'Auth service implemented without signToken',
            files: ['src/auth/index.js'],
            commands: [{ command: 'node src/auth/index.js', exit_code: 0 }],
            handoff_packet: {
              contract_id: 'auth-contract-v1',
              entry: 'src/auth/index.js',
            },
          },
          { agent: harness.alice },
        )
      },
      /contract "auth-contract-v1" violation.*missing required methods.*signToken/,
    )

    // Alice fixes implementation to fulfill contract completely
    await writeFile(
      join(cwd, 'src/auth/index.js'),
      `
      export async function verifyToken({ token }) {
        return { valid: token === 'real-jwt', userId: 'user-vip-42' }
      }
      export async function signToken({ userId }) {
        return { token: 'real-jwt' }
      }
      `,
      'utf8',
    )

    // Alice reports again -> APPROVED into review!
    const aliceReport = await tool('team_flow_report').execute(
      {
        item_id: 'W1',
        summary: 'Auth service fully conforms to contract',
        files: ['src/auth/index.js'],
        commands: [{ command: 'node src/auth/index.js', exit_code: 0 }],
        evidence: ['All methods exported: verifyToken, signToken'],
        handoff_packet: {
          contract_id: 'auth-contract-v1',
          entry: 'src/auth/index.js',
          notes: 'Production RSA signed token provider',
        },
      },
      { agent: harness.alice },
    )
    assert.equal(aliceReport.status, W.ITEM_STATUS.IN_REVIEW)
    assert.equal(aliceReport.contract_validation.ok, true)
    assert.deepEqual(aliceReport.contract_warnings, [])
    assert.equal(aliceReport.handoff_packet.validation.ok, true)

    // Carol reviews and approves W1
    const carolReview = await tool('team_flow_review_submit').execute(
      {
        item_id: 'W1',
        verdict: 'approve',
        evidence_checked: ['Verified verifyToken and signToken exports against contract'],
      },
      { agent: harness.carol },
    )
    assert.equal(carolReview.item_status, W.ITEM_STATUS.APPROVED)

    // 8. Reconcile orchestrator: W1 approved -> wakes Bob for W2 with upstream handoff packet
    await orchestrator.reconcile(harness.lead, { force: true })

    const bobMsg = harness.messages.find((m) => m.to === 'bob' && m.text.includes('[AUTO_DISPATCH]'))
    assert.ok(bobMsg, 'Bob received auto-dispatch wake message')
    assert.match(bobMsg.text, /Upstream handoffs:/)
    assert.match(bobMsg.text, /Item W1/)
    assert.match(bobMsg.text, /contract: auth-contract-v1/)
    assert.match(bobMsg.text, /entry: src\/auth\/index\.js/)
    assert.match(bobMsg.text, /exports: signToken, verifyToken/)

    // 9. Bob swaps to real implementation and reports W2
    await writeFile(
      join(cwd, 'src/checkout/index.js'),
      `
      import { verifyToken } from '../auth/index.js'

      export async function calculateTotal(cart, token) {
        const auth = await verifyToken({ token })
        if (!auth.valid) throw new Error('Unauthorized')
        const discount = auth.userId === 'user-vip-42' ? 0.2 : 0
        const subtotal = cart.items.reduce((acc, i) => acc + i.price * i.qty, 0)
        return { total: subtotal * (1 - discount), userId: auth.userId }
      }
      `,
      'utf8',
    )

    const bobReport = await tool('team_flow_report').execute(
      {
        item_id: 'W2',
        summary: 'Checkout engine integrated with real Auth entry point',
        files: ['src/checkout/index.js'],
        commands: [{ command: 'node src/checkout/index.js', exit_code: 0 }],
        evidence: ['calculateTotal works with real auth'],
      },
      { agent: harness.bob },
    )
    assert.equal(bobReport.status, W.ITEM_STATUS.IN_REVIEW)

    // Carol approves W2
    await tool('team_flow_review_submit').execute(
      {
        item_id: 'W2',
        verdict: 'approve',
        evidence_checked: ['Checked integration with src/auth/index.js'],
      },
      { agent: harness.carol },
    )

    // 10. Lead finalizes gate
    const gateRes = await tool('team_flow_gate').execute({ finalize: true }, { agent: harness.lead })
    assert.equal(gateRes.pass, true)
    assert.equal(gateRes.finalized, true)

    // 11. Validate CLI end-to-end against the final files
    const cliContracts = execFileSync(process.execPath, [CLI_PATH, 'contracts', '--cwd', cwd], { encoding: 'utf8' })
    assert.match(cliContracts, /auth-contract-v1/)

    const cliVal = execFileSync(
      process.execPath,
      [CLI_PATH, 'validate', 'auth-contract-v1', '--entry', 'src/auth/index.js', '--cwd', cwd],
      { encoding: 'utf8' },
    )
    assert.match(cliVal, /is SATISFIED!/)
    assert.match(cliVal, /verifyToken, signToken/)
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
})
