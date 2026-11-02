/**
 * Offline tests for the teammate transcript projection (docs/21).
 *
 * The summarizer is pure and defensive: these tests pin the message shapes the
 * Host actually emits (user/message, assistant/message with text and tool-call
 * blocks, tool/result) and prove unknown shapes degrade to "no line".
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { summarizeTranscript } from '../lib/transcript.js'

const EVENTS = [
  { seq: 1, type: 'session' },
  { seq: 2, type: 'user/message', data: { role: 'user', content: [{ type: 'text', text: '请实现 quote 模块' }] } },
  { seq: 3, type: 'assistant/message', data: { message: { role: 'assistant', content: [{ type: 'text', text: '好的，先看契约。' }, { type: 'tool-call', name: 'read', arguments: { path: 'quote.mjs' } }] } } },
  { seq: 4, type: 'tool/result', data: { message: { source: { callId: 'c1' }, content: [{ type: 'text', text: 'file contents' }] } } },
  { seq: 5, type: 'system/message', data: { message: { content: [{ type: 'text', text: '系统提示' }] } } },
  { seq: 6, type: 'llm/request-header', data: { anything: true } },
  { seq: 7, type: 'assistant/message', data: { message: { content: [] } } },
]

test('it projects the real message events into roles and text', () => {
  const result = summarizeTranscript(EVENTS)
  assert.deepEqual(result.messages.map((entry) => entry.role), ['user', 'assistant', 'tool', 'system'])
  assert.match(result.messages[1].text, /好的/)
  assert.match(result.messages[1].text, /\[tool\] read \{"path":"quote\.mjs"\}/)
  assert.equal(result.truncated, false)
  assert.equal(result.totalEvents, EVENTS.length)
})

test('it caps the tail and marks truncation', () => {
  const many = []
  for (let index = 0; index < 60; index += 1) {
    many.push({ seq: index, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: `m${index}` }] } } })
  }
  const result = summarizeTranscript(many, { limit: 5 })
  assert.equal(result.messages.length, 5)
  assert.equal(result.messages.at(-1).text, 'm59')
  assert.equal(result.truncated, true)
})

test('unknown, empty and malformed events never throw', () => {
  const result = summarizeTranscript([
    null,
    'nope',
    { type: 'user/message', data: null },
    { type: 'assistant/message', data: { message: { content: 'not-an-array' } } },
    { type: 'tool/result', data: { message: { content: [{ type: 'image' }] } } },
    { type: 'weird/type', data: {} },
  ])
  assert.deepEqual(result.messages.map((entry) => entry.text), ['[image]'])
})

test('it clamps very long text blocks', () => {
  const result = summarizeTranscript(
    [{ type: 'user/message', data: { content: [{ type: 'text', text: 'x'.repeat(5000) }] } }],
    { textLimit: 100 },
  )
  assert.equal(result.messages[0].text.length, 101)
  assert.match(result.messages[0].text, /…$/)
})
