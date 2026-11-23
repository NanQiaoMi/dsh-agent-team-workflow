/**
 * Unit tests for review policy, diff risk classification, rubrics, DoD matrix
 * validation, PR review Markdown formatting, and parallel multi-reviewer flows (M3).
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { resolveSettings } from '../lib/config.js'
import { reviewRequestMessage } from '../lib/protocol.js'
import {
  classifyDiffRisk,
  formatPrReviewMarkdown,
  normalizeDodChecks,
  renderReviewRubric,
  REVIEW_PROFILES,
  validateReviewSubmission,
} from '../lib/review-policy.js'
import { selectThinkingPlan } from '../lib/thinking-router.js'
import * as W from '../lib/workflow.js'

const NOW = '2026-11-21T00:00:00.000Z'

function makeItem(overrides = {}) {
  return {
    id: 'W1',
    subject: 'Implement auth session guard',
    owner: 'impl',
    assignment: 'lead',
    role: 'implementer',
    complexity: 'normal',
    thinkingTier: null,
    reviewDepth: 'auto',
    reviewProfile: 'auto',
    resolvedReview: null,
    writeScopes: ['src/'],
    blockedBy: [],
    definitionOfDone: ['rejects missing token', 'tests pass'],
    needsReview: true,
    reviewers: ['rev1', 'rev2'],
    evidenceOptional: false,
    status: W.ITEM_STATUS.PENDING,
    taskId: 'task-1',
    report: null,
    reportSeq: 0,
    reviews: [],
    reviewSeq: 0,
    pendingReviewer: null,
    pendingReviewers: [],
    overrideReason: null,
    repairLog: [],
    escalations: [],
    git: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  }
}

function makeReport(overrides = {}) {
  return {
    summary: 'Done.',
    files: ['src/core.js'],
    commands: [{ command: 'node --test', exitCode: 0, note: null }],
    evidence: ['all tests passed'],
    openQuestions: [],
    risks: [],
    deviation: null,
    ...overrides,
  }
}

function makeState(items = [makeItem()], extraSettings = {}) {
  return W.createRun({
    workflowVersion: W.WORKFLOW_VERSION,
    runId: 'run-review-1',
    teamId: 'session-lead',
    objective: 'Verify M3 review policy',
    acceptanceCriteria: ['passes tests'],
    constraints: [],
    settings: resolveSettings(extraSettings),
    items,
    actor: 'lead',
    now: NOW,
    artifacts: { statePath: '/tmp/state.json', reportPath: null, root: '/tmp' },
  })
}

test('classifyDiffRisk classifies security, DB, API, >300L, and docs/tests diffs accurately', () => {
  const sec = classifyDiffRisk({ files: ['src/auth/token-guard.js'] })
  assert.equal(sec.depth, 'deep')
  assert.equal(sec.profile, 'security')
  assert.ok(sec.highRiskFiles.includes('src/auth/token-guard.js'))

  const api = classifyDiffRisk({ files: ['lib/protocol.js'] })
  assert.equal(api.depth, 'deep')
  assert.equal(api.profile, 'api')

  const db = classifyDiffRisk({ files: ['migrations/001_init.sql'] })
  assert.equal(db.depth, 'deep')

  const ci = classifyDiffRisk({ files: ['.github/workflows/ci.yml'] })
  assert.equal(ci.depth, 'deep')

  const smallDocs = classifyDiffRisk({
    files: ['docs/guide.md'],
    diff: '+++ b/docs/guide.md\n+Added clarifying paragraph.\n',
  })
  assert.equal(smallDocs.depth, 'light')
  assert.equal(smallDocs.profile, 'docs')

  const smallTests = classifyDiffRisk({
    files: ['test/helper.test.mjs'],
    diff: '+++ b/test/helper.test.mjs\n+assert.equal(1, 1)\n',
  })
  assert.equal(smallTests.depth, 'light')
  assert.equal(smallTests.profile, 'tests')

  const bigDiff = Array.from({ length: 305 }, (_, i) => `+line ${i}`).join('\n')
  const large = classifyDiffRisk({ files: ['src/widget.js'], diff: `+++ b/src/widget.js\n${bigDiff}` })
  assert.equal(large.depth, 'deep')
  assert.ok(large.changedLines > 300)

  const refactor = classifyDiffRisk({
    item: { subject: 'Refactor cache helper into module', reviewDepth: 'standard', complexity: 'normal' },
    files: ['src/cache.js'],
  })
  assert.equal(refactor.depth, 'standard')
  assert.equal(refactor.profile, 'refactor')
  assert.equal(refactor.autoDetected, false)
})

test('renderReviewRubric supports all 6 profiles and depth variants', () => {
  for (const profile of REVIEW_PROFILES) {
    for (const depth of ['light', 'standard', 'deep']) {
      const md = renderReviewRubric({ depth, profile, definitionOfDone: ['passes'], reasons: ['test-trigger'] })
      assert.match(md, new RegExp(`Review Standard \\(${depth} / ${profile}\\)`))
      assert.match(md, /dod_checks/)
    }
  }
})

test('validateReviewSubmission enforces severity/DoD consistency while allowing minor/nit on approve_with_nits', () => {
  const item = makeItem({ definitionOfDone: ['tests pass', 'no leaks'] })

  const badMajor = validateReviewSubmission({
    item,
    reviewDepth: 'standard',
    verdict: 'approve',
    findings: [{ id: 'F1', severity: 'major', claim: 'bug' }],
    dodChecks: [],
  })
  assert.equal(badMajor.ok, false)
  assert.equal(badMajor.code, 'WORKFLOW_VERDICT_MISMATCH')

  const badBlocker = validateReviewSubmission({
    item,
    reviewDepth: 'standard',
    verdict: 'approve_with_nits',
    findings: [{ id: 'F1', severity: 'blocker', claim: 'vuln' }],
    dodChecks: [],
  })
  assert.equal(badBlocker.ok, false)
  assert.equal(badBlocker.code, 'WORKFLOW_VERDICT_MISMATCH')

  const allowMinorOnNits = validateReviewSubmission({
    item,
    reviewDepth: 'standard',
    verdict: 'approve_with_nits',
    findings: [
      { id: 'F1', severity: 'nit', claim: 'naming' },
      { id: 'F2', severity: 'minor', claim: 'add JSDoc' },
    ],
    dodChecks: [],
  })
  assert.equal(allowMinorOnNits.ok, true)

  const failDod = validateReviewSubmission({
    item,
    reviewDepth: 'standard',
    verdict: 'approve',
    findings: [],
    dodChecks: normalizeDodChecks([{ item: 'tests pass', status: 'fail', note: '1 failing' }]),
  })
  assert.equal(failDod.ok, false)
  assert.equal(failDod.code, 'WORKFLOW_DOD_FAILED')

  const strictDeepMissing = validateReviewSubmission({
    item,
    reviewDepth: 'deep',
    verdict: 'approve',
    findings: [],
    dodChecks: [],
    settings: { strictReviewRubric: true },
  })
  assert.equal(strictDeepMissing.ok, false)
  assert.equal(strictDeepMissing.code, 'WORKFLOW_DOD_CHECKS_REQUIRED')
})

test('formatPrReviewMarkdown renders verdict header, DoD table, grouped findings, and evidence', () => {
  const item = makeItem()
  const md = formatPrReviewMarkdown({
    item,
    state: { runId: 'run-42' },
    risk: { depth: 'deep', profile: 'security' },
    review: {
      reviewer: 'sec-rev',
      round: 2,
      verdict: 'request_changes',
      reviewedSha: 'deadbeef12345678',
      reviewDepth: 'deep',
      reviewProfile: 'security',
      summary: 'Found a missing signature check.',
      dodChecks: [
        { item: 'rejects missing token', status: 'fail', note: 'returns 200 on empty header' },
        { item: 'tests pass', status: 'pass', note: null },
      ],
      findings: [
        { id: 'F1', severity: 'blocker', file: 'src/auth.js', line: 42, claim: 'Missing JWT check', suggestion: 'Verify signature' },
        { id: 'F2', severity: 'nit', file: 'src/auth.js', line: 10, claim: 'Rename var' },
      ],
      evidenceChecked: ['read src/auth.js', 'ran node --test'],
    },
  })
  assert.match(md, /\[REQUEST CHANGES\] W1/)
  assert.match(md, /`sec-rev`/)
  assert.match(md, /`deep\/security`/)
  assert.match(md, /\| rejects missing token \| \*\*FAIL\*\* \| returns 200 on empty header \|/)
  assert.match(md, /\*\*BLOCKER\*\* \(1\)/)
  assert.match(md, /\*\*NIT\*\* \(1\)/)
  assert.match(md, /Missing JWT check/)
  assert.match(md, /ran node --test/)
})

test('parallel multi-reviewer workflow supports concurrent out-of-order submission, mixed verdicts, and thinking escalation', () => {
  const settings = resolveSettings({ parallelReviews: true })
  const state = makeState([makeItem({ reviewers: ['rev1', 'rev2'] })])

  const rep = W.applyReport(state, { itemId: 'W1', caller: 'impl', report: makeReport(), now: NOW, settings })
  assert.deepEqual(rep.nextReviewers, ['rev1', 'rev2'])
  assert.deepEqual(W.pendingReviewerNames(rep.item), ['rev1', 'rev2'])

  // Auto-classified deep review escalates both parallel reviewers to high thinking
  rep.item.resolvedReview = { depth: 'deep', profile: 'code', reasons: ['item-complex'] }
  assert.equal(selectThinkingPlan({ membership: { name: 'rev2', role: 'teammate' }, state, settings }).tier, 'high')

  // Request message embeds rubric
  const msg = reviewRequestMessage(state, rep.item, '+++ b/src/core.js\n+export const x = 1\n')
  assert.match(msg, /Review Standard \(deep \/ code\)/)

  // rev2 approves first (out-of-order parallel)
  const first = W.applyReviewSubmit(state, {
    itemId: 'W1',
    reviewer: 'rev2',
    verdict: 'approve',
    summary: 'rev2 approves',
    findings: [],
    evidenceChecked: ['read src/core.js'],
    dodChecks: [{ item: 'tests pass', status: 'pass', note: null }],
    settings,
    now: NOW,
  })
  assert.equal(first.item.status, W.ITEM_STATUS.IN_REVIEW)
  assert.equal(first.nextReviewer, 'rev1')
  assert.equal(first.nextReviewOpened, false, 'rev1 pending review already exists')

  // rev1 requests changes
  const second = W.applyReviewSubmit(state, {
    itemId: 'W1',
    reviewer: 'rev1',
    verdict: 'request_changes',
    summary: 'Missing guard',
    findings: [{ id: 'F1', severity: 'major', file: 'src/core.js', line: 4, claim: 'Null deref' }],
    evidenceChecked: ['read src/core.js'],
    settings,
    now: NOW,
  })
  assert.equal(second.item.status, W.ITEM_STATUS.CHANGES_REQUESTED)

  // Author responds -> only rev1 needs a new review round (rev2 already approved current reportSeq)
  const resp = W.applyReviewRespond(state, {
    itemId: 'W1',
    author: 'impl',
    responses: [{ findingId: 'F1', state: 'fixed', evidence: 'added null guard' }],
    now: NOW,
    settings,
  })
  assert.equal(resp.escalated, false)
  assert.deepEqual(resp.nextReviewers, ['rev1'])
  assert.equal(resp.item.status, W.ITEM_STATUS.IN_REVIEW)

  // rev1 approves -> item converges to APPROVED
  const finalSub = W.applyReviewSubmit(state, {
    itemId: 'W1',
    reviewer: 'rev1',
    verdict: 'approve',
    summary: 'Looks solid now',
    findings: [],
    evidenceChecked: ['re-read src/core.js'],
    settings,
    now: NOW,
  })
  assert.equal(finalSub.item.status, W.ITEM_STATUS.APPROVED)
})

test('preflightPlan rejects unsafe writeScopes with parent traversal or absolute paths', () => {
  const res = W.preflightPlan(
    {
      items: [
        { id: 'W1', writeScopes: ['../outside.js'], definitionOfDone: ['Valid DoD'], evidenceCommands: ['npm test'] },
        { id: 'W2', writeScopes: ['/etc/passwd'], definitionOfDone: ['Valid DoD'], evidenceCommands: ['npm test'] },
      ],
    },
    {},
  )
  assert.equal(res.errors.length, 2)
  assert.match(res.errors[0], /parent traversal "\.\."/)
  assert.match(res.errors[1], /not an absolute path/)
})

test('preflightPlan warns on broad wildcard scope, overloaded item, terse DoD, and unverified deep scope', () => {
  const res = W.preflightPlan(
    {
      items: [
        {
          id: 'W1',
          writeScopes: ['*', 'src/auth.js', 'a', 'b', 'c', 'd', 'e', 'f', 'g'],
          definitionOfDone: ['ok'],
          evidenceCommands: [],
        },
        {
          id: 'W2',
          writeScopes: ['docs/readme.md'],
          definitionOfDone: ['Update README examples'],
          evidenceCommands: [],
        },
      ],
    },
    { gitVerifyCommands: [] },
  )
  assert.equal(res.errors.length, 0)
  assert.ok(res.warnings.some((w) => w.includes('broad wildcard writeScope "*"')))
  assert.ok(res.warnings.some((w) => w.includes('declares 9 writeScopes')))
  assert.ok(res.warnings.some((w) => w.includes('overly terse definition_of_done')))
  assert.ok(res.warnings.some((w) => w.includes('touches high-risk scope') && w.includes('without evidence_commands')))
})
