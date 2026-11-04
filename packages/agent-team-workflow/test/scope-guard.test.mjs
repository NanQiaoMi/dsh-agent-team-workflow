/**
 * Unit tests for the runtime write-scope guard (v1.16).
 *
 * Pins the decision table: only direct file writes are judged; the caller must
 * own an active item; the path must fall inside its declared scopes; reviewers,
 * finished items, escapes and the disabled flag never block or always allow as
 * documented.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { activeScopesOf, pathInScope, scopeGuardReason, toWorkspacePath } from '../lib/scope-guard.js'

const LEAD = { id: 'session-lead' }
const WORKER = { id: 'session-worker' }
const REVIEWER = { id: 'session-reviewer' }
const OUTSIDER = { id: 'session-outsider' }

const ITEMS = [
  {
    id: 'W1',
    owner: 'worker',
    status: 'running',
    writeScopes: ['team-web-demo/index.html', 'team-web-demo/styles.css'],
  },
]

function harness({ items = ITEMS, enforce = true, state = true } = {}) {
  const memberships = new Map([
    [LEAD.id, { root: LEAD, id: 'team-1', role: 'lead', name: 'lead' }],
    [WORKER.id, { root: LEAD, id: 'team-1', role: 'teammate', name: 'worker' }],
    [REVIEWER.id, { root: LEAD, id: 'team-1', role: 'teammate', name: 'reviewer' }],
  ])
  const ctx = { agentTeams: { tryMembership: (agent) => memberships.get(agent.id) } }
  const store = {
    cachedState: () => (state ? { items } : null),
    workingDir: () => '/ws',
  }
  return { ctx, store, settings: { enforceWriteScopes: enforce } }
}

test('scoped writes inside the declared scope pass, outside are denied', () => {
  const { ctx, store, settings } = harness()
  assert.equal(scopeGuardReason({ name: 'write', agent: WORKER, arguments: { file_path: 'team-web-demo/index.html' } }, ctx, store, settings), undefined)
  assert.equal(scopeGuardReason({ name: 'edit', agent: WORKER, arguments: { file_path: '/ws/team-web-demo/styles.css' } }, ctx, store, settings), undefined)
  const outside = scopeGuardReason({ name: 'write', agent: WORKER, arguments: { file_path: 'team-web-demo/app.js' } }, ctx, store, settings)
  assert.match(outside, /outside the declared write scope of W1/)
  const escape = scopeGuardReason({ name: 'write', agent: WORKER, arguments: { file_path: '../secret.txt' } }, ctx, store, settings)
  assert.match(escape, /escapes the Team working directory/)
})

test('reviewers, finished items and unknown callers follow the documented rules', () => {
  const { ctx, store, settings } = harness()
  const reviewer = scopeGuardReason({ name: 'write', agent: REVIEWER, arguments: { file_path: 'team-web-demo/index.html' } }, ctx, store, settings)
  assert.match(reviewer, /no active work item with a declared write scope/)
  assert.match(reviewer, /reviewers never write/)

  const done = harness({ items: [{ ...ITEMS[0], status: 'approved' }] })
  assert.match(scopeGuardReason({ name: 'write', agent: WORKER, arguments: { file_path: 'team-web-demo/index.html' } }, done.ctx, done.store, done.settings), /no active work item/)

  assert.equal(scopeGuardReason({ name: 'write', agent: LEAD, arguments: { file_path: 'anything.txt' } }, ctx, store, settings), undefined)
  assert.equal(scopeGuardReason({ name: 'write', agent: OUTSIDER, arguments: { file_path: 'anything.txt' } }, ctx, store, settings), undefined)
  assert.equal(scopeGuardReason({ name: 'write', agent: WORKER, arguments: { file_path: 'anything.txt' } }, harness({ enforce: false }).ctx, harness({ enforce: false }).store, harness({ enforce: false }).settings), undefined)
})

test('only direct file-writing tools are judged', () => {
  const { ctx, store, settings } = harness()
  for (const name of ['read', 'grep', 'glob', 'bash', 'terminal_open', 'web_search', 'team_flow_report']) {
    assert.equal(scopeGuardReason({ name, agent: WORKER, arguments: { file_path: 'nope.txt' } }, ctx, store, settings), undefined, name + ' stays allowed')
  }
  assert.match(scopeGuardReason({ name: 'str_replace_editor', agent: WORKER, arguments: { file_path: 'nope.txt' } }, ctx, store, settings), /outside the declared write scope/)
})

test('path helpers normalize scopes and workspace paths', () => {
  assert.equal(toWorkspacePath('/ws', 'a/b.txt'), 'a/b.txt')
  assert.equal(toWorkspacePath('/ws', '/ws/a/b.txt'), 'a/b.txt')
  assert.equal(toWorkspacePath('/ws', '../x'), null)
  assert.equal(pathInScope('team-web-demo/index.html', 'team-web-demo/index.html'), true)
  assert.equal(pathInScope('team-web-demo/a/b.js', 'team-web-demo/'), true)
  assert.equal(pathInScope('team-web-demo-2/a.js', 'team-web-demo'), false)
  assert.equal(pathInScope('any/file.txt', '.'), true)
  assert.deepEqual(activeScopesOf({ items: ITEMS }, 'worker'), { ids: ['W1'], scopes: ['team-web-demo/index.html', 'team-web-demo/styles.css'] })
  assert.deepEqual(activeScopesOf({ items: ITEMS }, 'nobody'), { ids: [], scopes: [] })
})
