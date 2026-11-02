/**
 * Offline tests for the lifecycle hook runner (docs/18 P0-3).
 *
 * Handlers are real shell commands, so these tests exercise stdin delivery,
 * exit-code semantics (only 2 vetoes) and the fact that a failing command is
 * reported as data instead of throwing.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { fireHooks } from '../lib/hooks.js'

test('a hook receives the event JSON on stdin and a zero exit allows the action', async () => {
  const outcome = await fireHooks({
    handlers: [{ command: 'grep -q "taskCreated" && exit 0 || exit 9' }],
    event: 'taskCreated',
    payload: { item: { id: 'W1' } },
    cwd: process.cwd(),
    env: process.env,
  })
  assert.equal(outcome.blocked, false)
  assert.equal(outcome.results[0].exitCode, 0)
})

test('exit code 2 vetoes the action and keeps the handler output', async () => {
  const outcome = await fireHooks({
    handlers: [{ command: 'echo "scope check failed" >&2; exit 2' }],
    event: 'taskCompleted',
    payload: { item: { id: 'W1' } },
    cwd: process.cwd(),
    env: process.env,
  })
  assert.equal(outcome.blocked, true)
  assert.match(outcome.results[0].output, /scope check failed/)
})

test('a non-zero exit other than 2 is reported but does not block', async () => {
  const outcome = await fireHooks({
    handlers: [{ command: 'exit 3' }],
    event: 'teammateIdle',
    payload: {},
    cwd: process.cwd(),
    env: process.env,
  })
  assert.equal(outcome.blocked, false)
  assert.equal(outcome.results[0].exitCode, 3)
})

test('later handlers do not run once one vetoes', async () => {
  const outcome = await fireHooks({
    handlers: [{ command: 'exit 2' }, { command: 'exit 0' }],
    event: 'taskCreated',
    payload: {},
    cwd: process.cwd(),
    env: process.env,
  })
  assert.equal(outcome.blocked, true)
  assert.equal(outcome.results.length, 1)
})
