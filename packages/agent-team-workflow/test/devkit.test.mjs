/**
 * Unit & Integration tests for the Local Development Assistance & Structure Registry (devkit).
 *
 * Covers:
 * 1. extractExports zero-dependency syntax parser
 * 2. scanCodebase monorepo & package scanning
 * 3. ensureDevkit & default task archetypes seeding
 * 4. lookupStructure (modules, module, commands, templates, contracts, search)
 * 5. Contract publishing, reading, listing, and validation
 * 6. team_dev_lookup & team_dev_contract tools execution
 * 7. Cross-agent handoff_packet flow in team_flow_report and team_flow_read
 * 8. Orchestrator unblocked dispatch message with upstream handoff packet
 */

import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { resolveSettings } from '../lib/config.js'
import {
  ensureDevkit,
  extractExports,
  generateContractStub,
  listContracts,
  lookupStructure,
  publishContract,
  readContract,
  scanCodebase,
  validateContract,
  validateItemHandoff,
} from '../lib/devkit.js'
import { createOrchestrator } from '../lib/orchestrator.js'
import { createStore } from '../lib/store.js'
import { buildTools } from '../lib/tools.js'
import * as W from '../lib/workflow.js'

test('extractExports handles functions, classes, vars, and block exports', () => {
  const code = `
    export function alpha() {}
    export async function beta() {}
    export class GammaService {}
    export const DELTA = 42
    export let epsilon = 'test'
    export { zeta, eta as theta }
    function internal() {}
  `
  const exports = extractExports(code)
  assert.deepEqual(exports, ['DELTA', 'GammaService', 'alpha', 'beta', 'epsilon', 'theta', 'zeta'])
})

test('scanCodebase identifies root packages, scripts, entry points, and tests', async () => {
  const root = await mkdtemp(join(tmpdir(), 'devkit-scan-'))
  try {
    await writeFile(
      join(root, 'package.json'),
      JSON.stringify({
        name: 'test-app',
        type: 'module',
        scripts: { test: 'node --test', build: 'esbuild' },
      }),
      'utf8',
    )
    await writeFile(
      join(root, 'index.js'),
      'export function main() {}\nexport const VERSION = "1.0.0"',
      'utf8',
    )
    await mkdir(join(root, 'test'), { recursive: true })
    await writeFile(join(root, 'test', 'sample.test.js'), '// test', 'utf8')

    const manifest = await scanCodebase(root)
    assert.equal(manifest.project, 'test-app')
    assert.equal(manifest.runtime.module, 'esm')
    assert.equal(manifest.runtime.testRunner, 'npm test')
    assert.ok(manifest.commands.test)
    assert.ok(manifest.commands.build)
    assert.ok(manifest.modules.root)
    assert.equal(manifest.modules.root.entry, 'index.js')
    assert.deepEqual(manifest.modules.root.exports, ['VERSION', 'main'])
    assert.deepEqual(manifest.modules.root.tests, ['test/sample.test.js'])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('ensureDevkit seeds templates, contracts dir, and manifest.json', async () => {
  const root = await mkdtemp(join(tmpdir(), 'devkit-ensure-'))
  try {
    await writeFile(
      join(root, 'package.json'),
      JSON.stringify({ name: 'sample-project', scripts: { check: 'tsc' } }),
      'utf8',
    )
    const { devkitPath, manifest } = await ensureDevkit(root)
    assert.equal(manifest.project, 'sample-project')

    // Verify task-archetypes.json was seeded
    const archetypes = JSON.parse(await readFile(join(devkitPath, 'templates', 'task-archetypes.json'), 'utf8'))
    assert.ok(archetypes.archetypes.module_interface)
    assert.ok(archetypes.archetypes.core_implementation)
    assert.ok(archetypes.archetypes.integration_wiring)
    assert.ok(archetypes.archetypes.repro_bugfix)
    assert.ok(archetypes.archetypes.refactor_safe)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('lookupStructure responds to queries without grepping filesystem', async () => {
  const root = await mkdtemp(join(tmpdir(), 'devkit-lookup-'))
  try {
    await writeFile(
      join(root, 'package.json'),
      JSON.stringify({
        name: 'query-project',
        scripts: { test: 'node --test', lint: 'eslint' },
      }),
      'utf8',
    )
    await writeFile(
      join(root, 'index.js'),
      'export function greet(name) { return `hello ${name}` }\nexport function salute() {}',
      'utf8',
    )

    // 1. Modules overview
    const resModules = await lookupStructure(root, { action: 'modules' })
    assert.equal(resModules.found, true)
    assert.ok(resModules.modules.root)
    assert.equal(resModules.modules.root.exportsCount, 2)

    // 2. Specific module detail
    const resMod = await lookupStructure(root, { action: 'module', module: 'root' })
    assert.equal(resMod.found, true)
    assert.deepEqual(resMod.details.exports, ['greet', 'salute'])

    // 3. Unknown module
    const resUnknown = await lookupStructure(root, { action: 'module', module: 'nonexistent' })
    assert.equal(resUnknown.found, false)
    assert.ok(resUnknown.available_modules.includes('root'))

    // 4. Commands
    const resCmds = await lookupStructure(root, { action: 'commands' })
    assert.equal(resCmds.found, true)
    assert.ok(resCmds.commands.test)
    assert.ok(resCmds.commands.lint)

    // 5. Archetype templates
    const resTemplates = await lookupStructure(root, { action: 'templates' })
    assert.equal(resTemplates.found, true)
    assert.ok(resTemplates.archetypes.module_interface)

    // 6. Symbol search
    const resSearch = await lookupStructure(root, { action: 'search', export_name: 'greet' })
    assert.equal(resSearch.found, true)
    assert.equal(resSearch.matches.length, 1)
    assert.equal(resSearch.matches[0].module, 'root')

    const resMiss = await lookupStructure(root, { action: 'search', export_name: 'no_such_fn' })
    assert.equal(resMiss.found, false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('contract lifecycle: publish, list, read, and validate', async () => {
  const root = await mkdtemp(join(tmpdir(), 'devkit-contract-'))
  try {
    const contract = {
      $id: 'user-service-contract',
      title: 'User Service Contract',
      version: '1.0.0',
      methods: {
        getUser: { description: 'Get user by ID', params: ['id'], returns: 'User' },
        saveUser: { description: 'Save user', params: ['user'], returns: 'void' },
      },
    }

    // Publish
    const pub = await publishContract(root, contract)
    assert.equal(pub.ok, true)
    assert.equal(pub.contractId, 'user-service-contract')

    // List
    const list = await listContracts(root)
    assert.equal(list.length, 1)
    assert.equal(list[0].id, 'user-service-contract')
    assert.deepEqual(list[0].methods, ['getUser', 'saveUser'])

    // Read
    const read = await readContract(root, 'user-service-contract')
    assert.equal(read.$id, 'user-service-contract')
    assert.equal(read.title, 'User Service Contract')

    // Validate exports: complete
    const valGood = validateContract(read, ['getUser', 'saveUser', 'internalHelper'])
    assert.equal(valGood.ok, true)
    assert.deepEqual(valGood.missing, [])

    // Validate exports: incomplete
    const valBad = validateContract(read, ['getUser'])
    assert.equal(valBad.ok, false)
    assert.deepEqual(valBad.missing, ['saveUser'])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('tools integration: team_dev_lookup, team_dev_contract, handoff_packet in report and read', async () => {
  const root = await mkdtemp(join(tmpdir(), 'devkit-tools-'))
  try {
    await writeFile(
      join(root, 'package.json'),
      JSON.stringify({ name: 'tools-test-pkg', scripts: { test: 'node --test' } }),
      'utf8',
    )
    await writeFile(join(root, 'index.js'), 'export function execute() {}', 'utf8')

    const leadAgent = { id: 'agent-lead' }
    const workerAgent = { id: 'agent-worker' }
    const reviewerAgent = { id: 'agent-reviewer' }

    const members = [
      { name: 'lead', role: 'lead', id: leadAgent.id },
      { name: 'bob', role: 'implementer', id: workerAgent.id },
      { name: 'carol', role: 'reviewer', id: reviewerAgent.id },
    ]

    const ctx = {
      workingDirectory: { get: () => root, defaultDirectory: root },
      agentTeams: {
        tryMembership(agent) {
          const m = members.find((x) => x.id === agent.id)
          if (!m) return undefined
          return { root: leadAgent, id: agent.id, name: m.name, role: m.role }
        },
        membership(agent) {
          const res = this.tryMembership(agent)
          if (!res) throw new Error('not a team member')
          return res
        },
        listMembers() {
          return members.map((m) => ({ name: m.name, role: m.role, status: 'running' }))
        },
        sendMessage: async () => {},
        getTask: () => null,
        createTask: async (_agent, task) => ({ id: `task-${Date.now()}`, ...task }),
        updateTask: async () => {},
      },
    }

    const store = createStore({ ctx, settings: resolveSettings({}) })
    const tools = buildTools({ ctx, settings: resolveSettings({}), store, version: '1.27.0' })
    const lookupTool = tools.find((t) => t.name === 'team_dev_lookup')
    const contractTool = tools.find((t) => t.name === 'team_dev_contract')
    const planTool = tools.find((t) => t.name === 'team_flow_plan')
    const reportTool = tools.find((t) => t.name === 'team_flow_report')
    const readTool = tools.find((t) => t.name === 'team_flow_read')

    assert.ok(lookupTool)
    assert.ok(contractTool)

    // Test 1: team_dev_lookup
    const lookupRes = await lookupTool.execute({ action: 'modules' }, { agent: workerAgent })
    assert.equal(lookupRes.found, true)
    assert.equal(lookupRes.project, 'tools-test-pkg')

    // Test 2: team_dev_contract publish & read
    const pubRes = await contractTool.execute(
      {
        action: 'publish',
        contract: {
          $id: 'auth-contract',
          title: 'Auth Service',
          methods: { login: {}, logout: {} },
        },
      },
      { agent: workerAgent },
    )
    assert.equal(pubRes.ok, true)
    assert.equal(pubRes.contract_id, 'auth-contract')

    const readRes = await contractTool.execute({ action: 'read', contract_id: 'auth-contract' }, { agent: workerAgent })
    assert.equal(readRes.ok, true)
    assert.equal(readRes.contract.$id, 'auth-contract')

    const valRes = await contractTool.execute(
      { action: 'validate', contract_id: 'auth-contract', exports: ['login', 'logout'] },
      { agent: workerAgent },
    )
    assert.equal(valRes.ok, true)

    // Test 3: Plan items, report with handoff_packet, read back with team_flow_read
    await planTool.execute(
      {
        objective: 'Test handoff packet flow',
        acceptance_criteria: ['handoff packet persists'],
        items: [
          {
            id: 'W1',
            subject: 'Build Auth Interface',
            owner: 'bob',
            reviewers: ['carol'],
            write_scopes: ['index.js'],
            definition_of_done: ['contract published'],
          },
          {
            id: 'W2',
            subject: 'Consume Auth Interface',
            owner: 'bob',
            reviewers: ['carol'],
            blocked_by: ['W1'],
            write_scopes: ['consumer.js'],
            definition_of_done: ['uses auth'],
          },
        ],
      },
      { agent: leadAgent },
    )

    // Bob reports W1 with handoff_packet
    const reportRes = await reportTool.execute(
      {
        item_id: 'W1',
        summary: 'Auth interface built and contract published',
        files: ['index.js'],
        commands: [{ command: 'node --test', exit_code: 0 }],
        handoff_packet: {
          contract_id: 'auth-contract',
          entry: 'index.js',
          exports: ['login', 'logout'],
          notes: 'Call login with token',
        },
      },
      { agent: workerAgent },
    )
    assert.equal(reportRes.item_id, 'W1')
    assert.equal(reportRes.handoff_packet.contract_id, 'auth-contract')

    // Read back via team_flow_read
    const readBack = await readTool.execute({ item_id: 'W1' }, { agent: workerAgent })
    assert.ok(readBack.item)
    assert.equal(readBack.item.handoff_packet.contract_id, 'auth-contract')
    assert.equal(readBack.item.handoff_packet.entry, 'index.js')
    assert.deepEqual(readBack.item.handoff_packet.exports, ['login', 'logout'])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('orchestrator transmits upstream handoff packets when waking unblocked workers', async () => {
  const root = await mkdtemp(join(tmpdir(), 'devkit-orch-'))
  try {
    const leadAgent = { id: 'agent-lead' }
    const bobAgent = { id: 'agent-bob' }
    const sent = []

    const members = [
      { name: 'lead', role: 'lead', id: leadAgent.id, status: 'running' },
      { name: 'bob', role: 'implementer', id: bobAgent.id, status: 'inactive' },
    ]

    const ctx = {
      workingDirectory: { get: () => root, defaultDirectory: root },
      agentTeams: {
        tryMembership(agent) {
          const m = members.find((x) => x.id === agent.id)
          if (!m) return undefined
          return { root: leadAgent, id: agent.id, name: m.name, role: m.role }
        },
        membership(agent) {
          const res = this.tryMembership(agent)
          if (!res) throw new Error('not a team member')
          return res
        },
        listMembers() {
          return members
        },
        sendMessage: async (_agent, msg) => {
          sent.push(msg)
        },
        getTask: () => null,
      },
    }

    const store = createStore({ ctx, settings: resolveSettings({}) })
    const NOW = new Date().toISOString()
    const state = W.createRun({
      workflowVersion: W.WORKFLOW_VERSION,
      runId: 'run-handoff-test',
      teamId: leadAgent.id,
      objective: 'Verify handoff propagation',
      acceptanceCriteria: ['W2 receives W1 contract'],
      constraints: [],
      settings: resolveSettings({}),
      items: [
        {
          id: 'W1',
          subject: 'Auth contract',
          owner: 'bob',
          role: 'implementer',
          writeScopes: ['src/auth/'],
          blockedBy: [],
          definitionOfDone: ['done'],
          needsReview: false,
          reviewers: [],
          evidenceOptional: false,
          status: W.ITEM_STATUS.APPROVED,
          taskId: null,
          report: { summary: 'finished', files: ['src/auth/index.js'], commands: [], evidence: [], openQuestions: [], risks: [], deviation: null },
          reviews: [],
          reviewSeq: 0,
          overrideReason: null,
          createdAt: NOW,
          updatedAt: NOW,
          reportedAt: NOW,
          approvedAt: NOW,
          approvedBy: 'self',
          handoffPacket: {
            contract_id: 'auth-service',
            entry: 'src/auth/index.js',
            exports: ['login', 'logout'],
            notes: 'Requires token parameter',
          },
        },
        {
          id: 'W2',
          subject: 'Auth client',
          owner: 'bob',
          role: 'implementer',
          writeScopes: ['src/client/'],
          blockedBy: ['W1'],
          definitionOfDone: ['uses auth'],
          needsReview: false,
          reviewers: [],
          evidenceOptional: false,
          status: W.ITEM_STATUS.PENDING,
          taskId: null,
          report: null,
          reviews: [],
          reviewSeq: 0,
          overrideReason: null,
          createdAt: NOW,
          updatedAt: NOW,
          reportedAt: null,
          approvedAt: null,
          approvedBy: null,
          handoffPacket: null,
        },
      ],
      actor: 'lead',
      now: NOW,
      artifacts: { statePath: join(root, 'state.json'), reportPath: null, root },
    })

    await store.writeState(leadAgent, state)
    const orchestrator = createOrchestrator({ ctx, store, settings: resolveSettings({ autoOrchestrate: true }) })
    const result = await orchestrator.reconcile(leadAgent, { force: true })

    assert.equal(result.actionsTaken.length, 1)
    assert.equal(result.actionsTaken[0].type, 'wake-worker')
    assert.equal(result.actionsTaken[0].target, 'bob')
    assert.equal(result.actionsTaken[0].itemId, 'W2')

    assert.equal(sent.length, 1)
    const text = sent[0].content[0].text
    assert.match(text, /Upstream handoffs:/)
    assert.match(text, /Item W1/)
    assert.match(text, /contract: auth-service/)
    assert.match(text, /entry: src\/auth\/index\.js/)
    assert.match(text, /exports: login, logout/)
    assert.match(text, /notes: Requires token parameter/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('generateContractStub produces ESM, DTS, and JSON stubs, and writes to workspace', async () => {
  const root = await mkdtemp(join(tmpdir(), 'devkit-stub-'))
  try {
    const contract = {
      $id: 'billing-service-v1',
      title: 'Billing Service Contract',
      version: '1.2.0',
      methods: {
        chargeCustomer: {
          description: 'Charge a customer credit card or wallet',
          input: {
            type: 'object',
            required: ['customerId', 'amount'],
            properties: {
              customerId: { type: 'string' },
              amount: { type: 'number' },
              currency: { type: 'string' },
            },
          },
          output: {
            type: 'object',
            required: ['success', 'transactionId'],
            properties: {
              success: { type: 'boolean' },
              transactionId: { type: 'string' },
            },
          },
        },
        refundTransaction: {
          description: 'Refund a previous transaction',
          input: {
            type: 'object',
            required: ['transactionId'],
            properties: {
              transactionId: { type: 'string' },
            },
          },
        },
      },
      mock: {
        chargeCustomer: {
          success: true,
          transactionId: 'tx-mock-12345',
        },
      },
    }

    // 1. ESM format (default)
    const esmRes = await generateContractStub(root, contract, { format: 'esm' })
    assert.match(esmRes.code, /export const CONTRACT_ID = "billing-service-v1"/)
    assert.match(esmRes.code, /export const MOCK_FIXTURES = /)
    assert.match(esmRes.code, /export async function chargeCustomer\(args\)/)
    assert.match(esmRes.code, /export async function refundTransaction\(args\)/)
    assert.equal(esmRes.written, false)

    // 2. TypeScript DTS format
    const dtsRes = await generateContractStub(root, contract, { format: 'dts' })
    assert.match(dtsRes.code, /export interface ChargeCustomerInput/)
    assert.match(dtsRes.code, /customerId: string;/)
    assert.match(dtsRes.code, /amount: number;/)
    assert.match(dtsRes.code, /currency\?: string;/)
    assert.match(dtsRes.code, /export interface ChargeCustomerOutput/)
    assert.match(dtsRes.code, /export declare function chargeCustomer/)
    assert.match(dtsRes.code, /export declare function refundTransaction/)

    // 3. JSON format
    const jsonRes = await generateContractStub(root, contract, { format: 'json' })
    const parsed = JSON.parse(jsonRes.code)
    assert.equal(parsed.$id, 'billing-service-v1')
    assert.equal(parsed.mock.chargeCustomer.transactionId, 'tx-mock-12345')

    // 4. Write to file
    const writeRes = await generateContractStub(root, contract, {
      format: 'esm',
      writeTo: 'src/mocks/billing.mock.js',
    })
    assert.equal(writeRes.written, true)
    assert.equal(writeRes.path, 'src/mocks/billing.mock.js')

    const fileContent = await readFile(join(root, 'src/mocks/billing.mock.js'), 'utf8')
    assert.equal(fileContent, writeRes.code)

    // 5. Path traversal guard
    await assert.rejects(
      async () => {
        await generateContractStub(root, contract, {
          format: 'esm',
          writeTo: '../escaped.js',
        })
      },
      /escapes workspace root/,
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('validateItemHandoff inspects entry file exports and flags missing contract methods', async () => {
  const root = await mkdtemp(join(tmpdir(), 'devkit-handoff-val-'))
  try {
    const contract = {
      $id: 'crypto-service',
      title: 'Crypto Service',
      methods: {
        hashSha256: {},
        generateKey: {},
        signPayload: {},
      },
    }
    await publishContract(root, contract)

    // Case 1: Missing contract
    const resNoContract = await validateItemHandoff(root, { contract_id: 'unknown-contract' })
    assert.equal(resNoContract.ok, false)
    assert.match(resNoContract.error, /not found in devkit registry/)

    // Case 2: Incomplete exports (only 2 out of 3 methods)
    await mkdir(join(root, 'src'), { recursive: true })
    await writeFile(
      join(root, 'src/crypto.js'),
      `
      export function hashSha256(data) { return 'hash' }
      export function generateKey() { return 'key' }
      export function helper() {}
      `,
      'utf8',
    )

    const resIncomplete = await validateItemHandoff(root, {
      contract_id: 'crypto-service',
      entry: 'src/crypto.js',
    })
    assert.equal(resIncomplete.ok, false)
    assert.deepEqual(resIncomplete.missing, ['signPayload'])
    assert.equal(resIncomplete.entryExists, true)

    // Case 3: Complete exports via entry file
    await writeFile(
      join(root, 'src/crypto.js'),
      `
      export function hashSha256(data) { return 'hash' }
      export function generateKey() { return 'key' }
      export function signPayload(data, key) { return 'sig' }
      `,
      'utf8',
    )

    const resComplete = await validateItemHandoff(root, {
      contract_id: 'crypto-service',
      entry: 'src/crypto.js',
    })
    assert.equal(resComplete.ok, true)
    assert.deepEqual(resComplete.missing, [])

    // Case 4: Complete exports supplied explicitly via exports array
    const resExplicit = await validateItemHandoff(root, {
      contract_id: 'crypto-service',
      exports: ['hashSha256', 'generateKey', 'signPayload'],
    })
    assert.equal(resExplicit.ok, true)
    assert.deepEqual(resExplicit.missing, [])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('team_dev_contract action stub and team_flow_report auto-validation with strictContracts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'devkit-tools-val-'))
  try {
    const leadAgent = { id: 'agent-lead' }
    const workerAgent = { id: 'agent-worker' }
    const members = [
      { name: 'lead', role: 'lead', id: leadAgent.id },
      { name: 'alice', role: 'implementer', id: workerAgent.id },
    ]

    const ctx = {
      workingDirectory: { get: () => root, defaultDirectory: root },
      agentTeams: {
        tryMembership(agent) {
          const m = members.find((x) => x.id === agent.id)
          if (!m) return undefined
          return { root: leadAgent, id: agent.id, name: m.name, role: m.role }
        },
        membership(agent) {
          const res = this.tryMembership(agent)
          if (!res) throw new Error('not a team member')
          return res
        },
        listMembers() {
          return members.map((m) => ({ name: m.name, role: m.role, status: 'running' }))
        },
        sendMessage: async () => {},
        getTask: () => null,
        createTask: async (_agent, task) => ({ id: `task-${Date.now()}`, ...task }),
        updateTask: async () => {},
      },
    }

    const settings = resolveSettings({ strictContracts: true })
    const store = createStore({ ctx, settings })
    const tools = buildTools({ ctx, settings, store, version: '1.27.0' })
    const contractTool = tools.find((t) => t.name === 'team_dev_contract')
    const planTool = tools.find((t) => t.name === 'team_flow_plan')
    const reportTool = tools.find((t) => t.name === 'team_flow_report')

    // 1. Publish contract
    await contractTool.execute(
      {
        action: 'publish',
        contract: {
          $id: 'storage-contract',
          title: 'Storage Service',
          methods: { getFile: {}, putFile: {}, deleteFile: {} },
          mock: { getFile: { content: 'mock-file' } },
        },
      },
      { agent: workerAgent },
    )

    // 2. Generate stub via team_dev_contract { action: 'stub' }
    const stubRes = await contractTool.execute(
      {
        action: 'stub',
        contract_id: 'storage-contract',
        format: 'esm',
        write_to: 'mocks/storage.mock.js',
      },
      { agent: workerAgent },
    )
    assert.equal(stubRes.ok, true)
    assert.equal(stubRes.written, true)
    assert.match(stubRes.code, /export async function getFile/)

    // 3. Plan item
    await planTool.execute(
      {
        objective: 'Implement storage service',
        acceptance_criteria: ['contract fulfilled'],
        items: [
          {
            id: 'W1',
            subject: 'Storage implementation',
            owner: 'alice',
            needs_review: false,
            write_scopes: ['storage.js'],
            definition_of_done: ['exports all methods'],
          },
        ],
      },
      { agent: leadAgent },
    )

    // Write partial implementation missing deleteFile
    await writeFile(
      join(root, 'storage.js'),
      'export function getFile() {}\nexport function putFile() {}',
      'utf8',
    )

    // 4. In strictContracts mode: reporting with missing method throws!
    await assert.rejects(
      async () => {
        await reportTool.execute(
          {
            item_id: 'W1',
            summary: 'Storage partially done',
            files: ['storage.js'],
            commands: [{ command: 'node storage.js', exit_code: 0 }],
            handoff_packet: {
              contract_id: 'storage-contract',
              entry: 'storage.js',
            },
          },
          { agent: workerAgent },
        )
      },
      /contract "storage-contract" violation.*deleteFile/,
    )

    // 5. Complete implementation with deleteFile
    await writeFile(
      join(root, 'storage.js'),
      'export function getFile() {}\nexport function putFile() {}\nexport function deleteFile() {}',
      'utf8',
    )

    const goodReport = await reportTool.execute(
      {
        item_id: 'W1',
        summary: 'Storage fully implemented',
        files: ['storage.js'],
        commands: [{ command: 'node storage.js', exit_code: 0 }],
        handoff_packet: {
          contract_id: 'storage-contract',
          entry: 'storage.js',
        },
      },
      { agent: workerAgent },
    )
    assert.equal(goodReport.status, W.ITEM_STATUS.APPROVED)
    assert.equal(goodReport.contract_validation.ok, true)
    assert.deepEqual(goodReport.contract_warnings, [])
    assert.equal(goodReport.handoff_packet.validation.ok, true)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
