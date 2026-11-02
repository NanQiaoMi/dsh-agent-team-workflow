/**
 * Offline tests for @local/dsh-tool-guard-kit.
 *
 * The kit is pure: no DSH import, no filesystem, no timers. Everything here
 * pins the decision table and the `ctx.tools.guard` lifecycle contract.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  createTeamSubjectResolver,
  createToolSandbox,
  installToolSandbox,
  isMutatingTool,
  normalizePolicies,
  roleFromTeamState,
} from '../index.js'

const POLICY = { worker: { readOnly: true }, docs: { allow: ['read', 'grep', 'write'] }, audit: { deny: ['bash'] } }

test('mutating classification covers exact names and tool families', () => {
  for (const name of ['write', 'edit', 'bash', 'terminal', 'terminal_open', 'terminal_send', 'str_replace_editor']) {
    assert.equal(isMutatingTool(name), true, `${name} must be mutating`)
  }
  for (const name of ['read', 'grep', 'glob', 'team_flow_status', '']) {
    assert.equal(isMutatingTool(name), false, `${name} must not be mutating`)
  }
  assert.equal(isMutatingTool('terminal', { prefixes: [] }), true, 'exact names still match without prefixes')
  assert.equal(isMutatingTool('terminal_open', { prefixes: [] }), false)
})

test('policies normalize from objects and Maps without leaking unknown fields', () => {
  const table = normalizePolicies({
    worker: { readOnly: true, provider: 'x', prompt: 'ignored' },
    docs: { allow: ['read', 'read', ' write '], deny: [] },
    broken: null,
  })
  assert.equal(table.size, 2)
  assert.deepEqual(table.get('worker'), { readOnly: true, allow: [], deny: [] })
  assert.deepEqual(table.get('docs'), { readOnly: false, allow: ['read', 'write'], deny: [] })
  const fromMap = normalizePolicies(new Map([['x', { deny: ['bash'] }]]))
  assert.deepEqual(fromMap.get('x'), { readOnly: false, allow: [], deny: ['bash'] })
  assert.equal(normalizePolicies(null).size, 0)
})

test('check allows unknown subjects and applies readOnly, deny and allow', () => {
  const sandbox = createToolSandbox({ policies: POLICY, resolveSubject: (exec) => ({ key: exec.who, role: exec.role }) })
  assert.equal(sandbox.check({ name: 'write', who: 'nobody', role: 'missing' }), undefined)
  assert.equal(sandbox.check({ name: 'write', who: 'w', role: 'nobody' }), undefined)
  assert.match(sandbox.check({ name: 'write', who: 'w', role: 'worker' }), /read-only/)
  assert.equal(sandbox.check({ name: 'read', who: 'w', role: 'worker' }), undefined)
  assert.match(sandbox.check({ name: 'bash', who: 'a', role: 'audit' }), /denies it/)
  assert.equal(sandbox.check({ name: 'grep', who: 'd', role: 'docs' }), undefined)
  assert.match(sandbox.check({ name: 'bash', who: 'd', role: 'docs' }), /may only use read, grep, write/)
  assert.equal(sandbox.check({ name: 'read', who: 'd', role: 'docs' }), undefined)
})

test('fail-open is the default and fail-closed is opt-in', () => {
  const boom = () => {
    throw new Error('resolver exploded')
  }
  const open = createToolSandbox({ policies: POLICY, resolveSubject: boom })
  assert.equal(open.check({ name: 'write' }), undefined)
  assert.equal(open.stats.failed, 1)
  const closed = createToolSandbox({ policies: POLICY, resolveSubject: boom, failOpen: false })
  assert.match(closed.check({ name: 'write' }), /could not resolve a subject/)
})

test('a custom resolvePolicy overrides the static table', () => {
  const sandbox = createToolSandbox({
    policies: {},
    resolveSubject: () => ({ key: 'k', role: 'dynamic' }),
    resolvePolicy: (subject) => (subject.role === 'dynamic' ? { allow: ['read'] } : null),
  })
  assert.equal(sandbox.check({ name: 'read' }), undefined)
  assert.match(sandbox.check({ name: 'write' }), /may only use read/)
})

test('denials are audited, observable and bounded', () => {
  const denied = []
  const sandbox = createToolSandbox({
    policies: { worker: { readOnly: true } },
    resolveSubject: () => ({ key: 'worker', role: 'worker' }),
    auditLimit: 2,
    now: () => '2026-01-01T00:00:00.000Z',
    onDeny: (entry) => denied.push(entry.tool),
  })
  for (const name of ['write', 'edit', 'bash']) sandbox.check({ name })
  assert.deepEqual(denied, ['write', 'edit', 'bash'])
  assert.equal(sandbox.stats.denied, 3)
  assert.equal(sandbox.stats.checked, 3)
  const audit = sandbox.audit()
  assert.equal(audit.length, 2, 'the ring is bounded')
  assert.deepEqual(audit.at(-1), { at: '2026-01-01T00:00:00.000Z', tool: 'bash', subject: { key: 'worker', role: 'worker' }, reason: audit.at(-1).reason })
  assert.equal(sandbox.audit(1).length, 1)
})

test('setPolicies swaps the table without rebuilding the instance', () => {
  const sandbox = createToolSandbox({ resolveSubject: () => ({ key: 'k', role: 'r' }), policies: {} })
  assert.equal(sandbox.check({ name: 'write' }), undefined)
  sandbox.setPolicies({ r: { deny: ['write'] } })
  assert.match(sandbox.check({ name: 'write' }), /denies it/)
  assert.equal(sandbox.policies.get('r').deny[0], 'write')
})

test('installToolSandbox registers exactly one guard and disposes it', () => {
  const guards = []
  const effects = []
  const ctx = {
    tools: {
      guard(fn) {
        guards.push(fn)
        return () => {
          const index = guards.indexOf(fn)
          if (index >= 0) guards.splice(index, 1)
        }
      },
    },
    effect(factory) {
      effects.push(factory())
      return () => {}
    },
  }
  const sandbox = installToolSandbox(ctx, { policies: POLICY, resolveSubject: (exec) => ({ key: 'w', role: 'worker' }) })
  assert.equal(guards.length, 1)
  assert.equal(effects.length, 1, 'the guard is owned by a ctx.effect')
  assert.match(guards[0]({ name: 'write' }), /read-only/)
  sandbox.dispose()
  assert.equal(guards.length, 0, 'dispose unregisters the guard')
  sandbox.dispose()
  assert.equal(guards.length, 0, 'dispose is idempotent')
})

test('team resolver maps teammates to roles and never blocks others', () => {
  const lead = { id: 'lead' }
  const teammate = { id: 'worker-1' }
  const state = { roleAssignments: {}, items: [{ owner: 'worker-1', role: 'worker' }] }
  const ctx = {
    agentTeams: {
      tryMembership: (agent) =>
        agent === lead ? { root: lead, role: 'lead', name: 'lead' } : agent === teammate ? { root: lead, role: 'teammate', name: 'worker-1' } : undefined,
    },
  }
  const resolveSubject = createTeamSubjectResolver({ ctx, stateFor: () => state })
  assert.equal(resolveSubject({ agent: lead }), null)
  assert.deepEqual(resolveSubject({ agent: teammate }), { key: 'worker-1', role: 'worker' })
  assert.equal(resolveSubject({ agent: { id: 'outsider' } }), null)
  assert.equal(resolveSubject({}), null)
  assert.equal(roleFromTeamState({ roleAssignments: { a: 'x' } }, 'a'), 'x')
  assert.equal(roleFromTeamState({ items: [{ owner: 'b', role: 'r' }] }, 'b'), 'r')
  assert.equal(roleFromTeamState(null, 'b'), null)
})
