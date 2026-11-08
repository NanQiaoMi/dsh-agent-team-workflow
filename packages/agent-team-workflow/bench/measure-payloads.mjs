#!/usr/bin/env node
/**
 * Payload bench for the token-efficiency plan (docs/40).
 *
 * Builds a fixed 2-item run (one approved, one changes_requested with a long
 * report/finding) and prints every hot-path payload size. `--check` fails when
 * one exceeds the documented budget, so CI catches context regressions.
 *
 * Usage: node bench/measure-payloads.mjs [--check]
 */

import { resolveSettings } from '../lib/config.js'
import { buildBriefStatus, buildStatus, WORKFLOW_VERSION } from '../lib/workflow.js'
import { buildPolicy, renderQueueBrief, renderReviewerBrief, renderWorkerBrief } from '../lib/protocol.js'
import * as W from '../lib/workflow.js'

const CHECK = process.argv.includes('--check')
const NOW = '2026-11-01T00:00:00.000Z'
const SETTINGS = resolveSettings({})
const bytes = (value) => Buffer.byteLength(typeof value === 'string' ? value : JSON.stringify(value), 'utf8')

function item(overrides = {}) {
  return {
    id: 'W1', subject: 'Implement the core module with a reasonably descriptive subject', owner: 'impl', role: 'implementer',
    writeScopes: ['src/core/'], blockedBy: [], definitionOfDone: ['module exports run()', 'unit tests pass'], needsReview: true,
    reviewers: ['rev'], evidenceOptional: false, status: W.ITEM_STATUS.PENDING, taskId: 'task-1', report: null, reviews: [],
    reviewSeq: 0, overrideReason: null, createdAt: NOW, updatedAt: NOW, reportedAt: null, approvedAt: null, approvedBy: null,
    ...overrides,
  }
}

const state = W.createRun({
  workflowVersion: WORKFLOW_VERSION, runId: 'run-bench-1', teamId: 'session-lead',
  objective: 'Ship a verified module without wasting tokens on repeated full-board reads',
  acceptanceCriteria: ['module is importable', 'tests are green', 'evidence is quoted'],
  constraints: ['no new dependencies'], settings: SETTINGS,
  items: [
    item({ id: 'W1', status: W.ITEM_STATUS.APPROVED, reviewers: ['rev'], report: { summary: 'x'.repeat(2000), files: ['src/core/run.js'], commands: [{ command: 'node --test', exitCode: 0, note: null }], evidence: ['4 passing'], openQuestions: [], risks: [], deviation: null }, reportedAt: NOW, approvedAt: NOW, approvedBy: 'rev' }),
    item({ id: 'W2', owner: 'impl2', status: W.ITEM_STATUS.CHANGES_REQUESTED, writeScopes: ['src/util/'], reviewers: ['rev'], reviews: [{ round: 1, reportSeq: 1, reviewer: 'rev', requestedBy: 'impl2', requestedAt: NOW, status: 'submitted', verdict: 'request_changes', summary: 'y'.repeat(2000), findings: [{ id: 'F1', severity: 'major', file: 'src/util/a.js', line: 3, claim: 'z'.repeat(600), suggestion: null, resolution: null }], evidenceChecked: ['read src/util/a.js'] }], reviewSeq: 1 }),
  ],
  actor: 'lead', now: NOW, artifacts: { statePath: '/tmp/state.json', reportPath: null, root: '/tmp' },
})
state.rev = 10

const input = {
  me: { name: 'lead', role: 'lead' }, role: 'lead', settings: SETTINGS,
  members: [{ name: 'lead', role: 'lead', status: 'running' }, { name: 'impl', role: 'implementer', status: 'inactive' }],
  artifacts: {}, tasksById: new Map(),
}

const rows = [
  ['status.full', bytes(buildStatus(state, { ...input, detailItemId: null }))],
  ['status.detail', bytes(buildStatus(state, { ...input, detailItemId: 'W1' }))],
  ['status.brief.first', bytes(buildBriefStatus(state, input, { sinceRev: null }))],
  ['status.brief.repeat', bytes(buildBriefStatus(state, input, { sinceRev: 9 }))],
  ['status.unchanged', bytes(buildStatus(state, { ...input, view: 'brief', sinceRev: 10 }))],
  ['brief.worker', bytes(renderWorkerBrief(state, state.items[1], [], 'fresh').prompt)],
  ['brief.reviewer', bytes(renderReviewerBrief(state, 'rev', [state.items[1]]).prompt)],
  ['brief.queue', bytes(renderQueueBrief(state, 'impl', state.items, 'fresh').prompt)],
  ['policy.worker', bytes(buildPolicy(SETTINGS, 'implementer'))],
  ['policy.reviewer', bytes(buildPolicy(SETTINGS, 'reviewer'))],
  ['policy.lead', bytes(buildPolicy(SETTINGS))],
]

const budgets = {
  'status.full': 40000,
  'status.detail': 40000,
  'status.brief.first': 7500,
  'status.brief.repeat': 6000,
  'status.unchanged': 600,
  'brief.worker': 4600,
  'brief.reviewer': 3700,
  'brief.queue': 3800,
  'policy.worker': 2200,
  'policy.reviewer': 1800,
  'policy.lead': 6200,
}

let failed = false
for (const [name, size] of rows) {
  const budget = budgets[name]
  const ok = size <= budget
  if (!ok) failed = true
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name.padEnd(22)} ${String(size).padStart(6)} bytes  (budget ${budget})`)
}
if (CHECK && failed) {
  console.error('payload budgets exceeded')
  process.exitCode = 1
}
