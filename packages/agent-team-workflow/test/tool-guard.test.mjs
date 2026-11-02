/**
 * Unit tests for the native-tool sandbox (docs/25).
 *
 * These pin the decision table: lead/outsider never blocked, workflow tools
 * skip the native guard, readOnly denies mutating native tools, deny/allow
 * lists match exact tool names, and an unknown role fails open.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { memberRoleOf, NATIVE_MUTATING_TOOLS, toolGuardReason } from '../lib/tool-guard.js'

const LEAD = { id: 'session-lead' }
const WORKER = { id: 'session-worker' }
const OUTSIDER = { id: 'session-outsider' }

function harness({ state = { roleAssignments: { worker: 'worker' }, items: [] }, roles = {} } = {}) {
  const memberships = new Map([
    [LEAD.id, { root: LEAD, id: 'team-1', role: 'lead', name: 'lead' }],
    [WORKER.id, { root: LEAD, id: 'team-1', role: 'teammate', name: 'worker' }],
  ])
  const ctx = { agentTeams: { tryMembership: (agent) => memberships.get(agent.id) } }
  const store = { cachedState: () => state }
  return { ctx, store, settings: { roles } }
}

test('memberRoleOf prefers an explicit assignment and falls back to the unique owned role', () => {
  const state = { roleAssignments: { a: 'reviewer' }, items: [{ owner: 'b', role: 'implementer' }, { owner: 'c', role: 'x' }, { owner: 'c', role: 'y' }] }
  assert.equal(memberRoleOf(state, 'a'), 'reviewer')
  assert.equal(memberRoleOf(state, 'b'), 'implementer')
  assert.equal(memberRoleOf(state, 'c'), null, 'ambiguous owned roles stay unassigned')
  assert.equal(memberRoleOf(null, 'a'), null)
})

test('readOnly denies mutating native tools and allows read-only ones', () => {
  for (const tool of NATIVE_MUTATING_TOOLS) {
    const { ctx, store, settings } = harness({ roles: { worker: { readOnly: true } } })
    const reason = toolGuardReason({ name: tool, agent: WORKER }, ctx, store, settings)
    assert.match(reason, /read-only/, `${tool} must be denied`)
  }
  const { ctx, store, settings } = harness({ roles: { worker: { readOnly: true } } })
  assert.equal(toolGuardReason({ name: 'read', agent: WORKER }, ctx, store, settings), undefined)
  assert.equal(toolGuardReason({ name: 'grep', agent: WORKER }, ctx, store, settings), undefined)
})

test('deny lists match exact native names and allow lists are exhaustive', () => {
  const denied = harness({ roles: { worker: { deny: ['bash'] } } })
  assert.match(toolGuardReason({ name: 'bash', agent: WORKER }, denied.ctx, denied.store, denied.settings), /denies it/)
  assert.equal(toolGuardReason({ name: 'read', agent: WORKER }, denied.ctx, denied.store, denied.settings), undefined)

  const allowed = harness({ roles: { worker: { allow: ['read', 'grep'] } } })
  assert.equal(toolGuardReason({ name: 'read', agent: WORKER }, allowed.ctx, allowed.store, allowed.settings), undefined)
  assert.match(toolGuardReason({ name: 'write', agent: WORKER }, allowed.ctx, allowed.store, allowed.settings), /may only use read, grep/)
})

test('the lead, outsiders, unknown agents and workflow tools all pass through', () => {
  const { ctx, store, settings } = harness({ roles: { worker: { readOnly: true } } })
  assert.equal(toolGuardReason({ name: 'write', agent: LEAD }, ctx, store, settings), undefined)
  assert.equal(toolGuardReason({ name: 'write', agent: OUTSIDER }, ctx, store, settings), undefined)
  assert.equal(toolGuardReason({ name: 'team_flow_report', agent: WORKER }, ctx, store, settings), undefined, 'workflow tools enforce their own policy')
  assert.equal(toolGuardReason({ name: 'write', agent: undefined }, ctx, store, settings), undefined)
})

test('a role with no tool policy and an unprimed cache fail open', () => {
  const noPolicy = harness({ roles: {} })
  assert.equal(toolGuardReason({ name: 'write', agent: WORKER }, noPolicy.ctx, noPolicy.store, noPolicy.settings), undefined)
  const unprimed = harness({ state: null, roles: { worker: { readOnly: true } } })
  assert.equal(toolGuardReason({ name: 'write', agent: WORKER }, unprimed.ctx, unprimed.store, unprimed.settings), undefined)
})
