/**
 * Unit tests for the Adaptive Thinking / Reasoning Effort Router (M2).
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { resolveSettings } from '../lib/config.js'
import { renderReportMarkdown } from '../lib/protocol.js'
import { createStore } from '../lib/store.js'
import {
  BUDGET_DOWNGRADE_RATIO,
  computeBudgetPressure,
  createThinkingRouter,
  mapTierToEffort,
  selectThinkingPlan,
} from '../lib/thinking-router.js'
import * as W from '../lib/workflow.js'

const NOW = '2026-11-21T00:00:00.000Z'

function makeItem(overrides = {}) {
  return {
    id: 'W1',
    subject: 'Implement parser',
    owner: 'impl',
    assignment: 'lead',
    role: 'implementer',
    complexity: 'normal',
    thinkingTier: null,
    writeScopes: ['src/'],
    blockedBy: [],
    definitionOfDone: ['passes tests'],
    needsReview: true,
    reviewers: ['rev'],
    evidenceOptional: false,
    status: W.ITEM_STATUS.PENDING,
    taskId: 'task-1',
    report: null,
    reportSeq: 0,
    reviews: [],
    reviewSeq: 0,
    overrideReason: null,
    repairLog: [],
    escalations: [],
    git: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  }
}

function makeState(items = [makeItem()], extra = {}) {
  const state = W.createRun({
    workflowVersion: W.WORKFLOW_VERSION,
    runId: 'run-think-1',
    teamId: 'session-lead',
    objective: 'Test thinking router',
    acceptanceCriteria: ['passes'],
    constraints: [],
    settings: resolveSettings({}),
    items,
    actor: 'lead',
    now: NOW,
    artifacts: { statePath: '/tmp/state.json', reportPath: null, root: '/tmp' },
  })
  return { ...state, ...extra }
}

function makeScopedAgent(id) {
  const listeners = new Map()
  return {
    id,
    session: { id },
    ctx: {
      on(event, fn, opts = {}) {
        const list = listeners.get(event) ?? []
        if (opts.prepend) list.unshift(fn)
        else list.push(fn)
        listeners.set(event, list)
        return () => {
          const cur = listeners.get(event) ?? []
          listeners.set(event, cur.filter((c) => c !== fn))
        }
      },
    },
    async runRequest(payload, baseConfig) {
      const list = [...(listeners.get('agent/request') ?? [])]
      let idx = 0
      const next = async () => {
        if (idx < list.length) {
          const fn = list[idx]
          idx += 1
          return await fn({ ...payload, agent: this }, next)
        }
        return baseConfig
      }
      return await next()
    },
    listenerCount(event) {
      return (listeners.get(event) ?? []).length
    },
  }
}

test('mapTierToEffort maps safely across DeepSeek, disabled thinking, 5-tier, and non-reasoning models', () => {
  const deepseek = { efforts: [{ id: 'off' }, { id: 'low' }, { id: 'high' }, { id: 'max' }], defaultEffort: 'high' }
  assert.equal(mapTierToEffort('off', deepseek).effort, 'off')
  assert.equal(mapTierToEffort('low', deepseek).effort, 'low')
  assert.equal(mapTierToEffort('medium', deepseek, { bias: 'low' }).effort, 'low')
  assert.equal(mapTierToEffort('medium', deepseek, { bias: 'high' }).effort, 'high')
  assert.equal(mapTierToEffort('high', deepseek).effort, 'high')
  assert.equal(mapTierToEffort('max', deepseek).effort, 'max')

  const disabledDeepseek = { efforts: [{ id: 'off' }], defaultEffort: 'off' }
  for (const tier of ['off', 'low', 'medium', 'high', 'max']) {
    const res = mapTierToEffort(tier, disabledDeepseek)
    assert.equal(res.effort, 'off', `tier ${tier} on off-only model must fold to 'off'`)
  }

  const fiveTier = { efforts: ['minimal', 'low', 'medium', 'high', 'xhigh'].map((id) => ({ id })) }
  assert.equal(mapTierToEffort('off', fiveTier).effort, 'minimal')
  assert.equal(mapTierToEffort('low', fiveTier).effort, 'low')
  assert.equal(mapTierToEffort('medium', fiveTier, { bias: 'low' }).effort, 'medium')
  assert.equal(mapTierToEffort('high', fiveTier).effort, 'high')
  assert.equal(mapTierToEffort('max', fiveTier).effort, 'xhigh')

  assert.equal(mapTierToEffort('high', undefined).effort, undefined)
  assert.equal(mapTierToEffort('high', { efforts: [] }).effort, undefined)
  assert.equal(mapTierToEffort('inherit', deepseek).preserveInherited, true)
})

test('selectThinkingPlan covers Lead, Implementer, Reviewer, Verifier, and Architect across stages', () => {
  const settings = resolveSettings({})

  // Lead: plan -> high, coordinate -> low, escalation -> high, converged -> low
  assert.equal(selectThinkingPlan({ membership: { name: 'lead', role: 'lead' }, state: makeState([], { phase: W.RUN_PHASE.PLANNED }), settings }).tier, 'high')
  assert.equal(selectThinkingPlan({ membership: { name: 'lead', role: 'lead' }, state: makeState([makeItem()], { phase: W.RUN_PHASE.EXECUTING }), settings }).tier, 'low')
  assert.equal(
    selectThinkingPlan({
      membership: { name: 'lead', role: 'lead' },
      state: makeState([makeItem({ status: W.ITEM_STATUS.ESCALATED })], { phase: W.RUN_PHASE.REVIEWING }),
      settings,
    }).tier,
    'high',
  )
  assert.equal(selectThinkingPlan({ membership: { name: 'lead', role: 'lead' }, state: makeState([], { phase: W.RUN_PHASE.CONVERGED }), settings }).tier, 'low')

  // Implementer: trivial -> low, normal(bias:low) -> medium/low, complex -> high, rework -> high, override -> max
  const normalPlan = selectThinkingPlan({ membership: { name: 'impl', role: 'teammate' }, state: makeState([makeItem({ complexity: 'normal' })]), settings })
  assert.equal(normalPlan.tier, 'medium')
  assert.equal(normalPlan.bias, 'low')

  const highBiasSettings = resolveSettings({ thinkingDefaultBias: 'high' })
  assert.equal(
    selectThinkingPlan({ membership: { name: 'impl', role: 'teammate' }, state: makeState([makeItem({ complexity: 'normal' })]), settings: highBiasSettings }).tier,
    'high',
  )
  assert.equal(
    selectThinkingPlan({ membership: { name: 'impl', role: 'teammate' }, state: makeState([makeItem({ complexity: 'trivial' })]), settings }).tier,
    'low',
  )
  assert.equal(
    selectThinkingPlan({ membership: { name: 'impl', role: 'teammate' }, state: makeState([makeItem({ complexity: 'complex' })]), settings }).tier,
    'high',
  )
  assert.equal(
    selectThinkingPlan({ membership: { name: 'impl', role: 'teammate' }, state: makeState([makeItem({ status: W.ITEM_STATUS.CHANGES_REQUESTED })]), settings }).tier,
    'high',
  )
  assert.equal(
    selectThinkingPlan({ membership: { name: 'impl', role: 'teammate' }, state: makeState([makeItem({ thinkingTier: 'max' })]), settings }).tier,
    'max',
  )

  // Verifier & Architect
  assert.equal(
    selectThinkingPlan({ membership: { name: 'ver', role: 'teammate' }, state: makeState([makeItem({ owner: 'ver', role: 'verifier' })]), settings }).tier,
    'low',
  )
  assert.equal(
    selectThinkingPlan({ membership: { name: 'arch', role: 'teammate' }, state: makeState([makeItem({ owner: 'arch', role: 'architect' })]), settings }).tier,
    'high',
  )

  // Reviewer: initial standard -> medium(bias:high), deep -> high, light -> low, delta re-review -> low, rebuttal -> high
  const pendingBase = {
    id: 'W1',
    owner: 'impl',
    status: W.ITEM_STATUS.IN_REVIEW,
    reviews: [{ round: 1, status: 'pending', reviewer: 'rev', findings: [] }],
  }
  const stdRev = selectThinkingPlan({ membership: { name: 'rev', role: 'teammate' }, state: makeState([makeItem(pendingBase)]), settings })
  assert.equal(stdRev.tier, 'medium')
  assert.equal(stdRev.bias, 'high')

  assert.equal(
    selectThinkingPlan({ membership: { name: 'rev', role: 'teammate' }, state: makeState([makeItem({ ...pendingBase, reviewDepth: 'deep' })]), settings }).tier,
    'high',
  )
  assert.equal(
    selectThinkingPlan({ membership: { name: 'rev', role: 'teammate' }, state: makeState([makeItem({ ...pendingBase, reviewDepth: 'light' })]), settings }).tier,
    'low',
  )

  const reReviewItem = makeItem({
    status: W.ITEM_STATUS.IN_REVIEW,
    reviews: [
      { round: 1, status: 'submitted', reviewer: 'rev', verdict: 'request_changes', findings: [{ id: 'F1', resolution: { state: 'fixed' } }] },
      { round: 2, status: 'pending', reviewer: 'rev', findings: [] },
    ],
  })
  assert.equal(selectThinkingPlan({ membership: { name: 'rev', role: 'teammate' }, state: makeState([reReviewItem]), settings }).tier, 'low')

  const rebuttalItem = makeItem({
    status: W.ITEM_STATUS.IN_REVIEW,
    reviews: [
      { round: 1, status: 'submitted', reviewer: 'rev', verdict: 'request_changes', findings: [{ id: 'F1', resolution: { state: 'rebut' } }] },
      { round: 2, status: 'pending', reviewer: 'rev', findings: [] },
    ],
  })
  assert.equal(selectThinkingPlan({ membership: { name: 'rev', role: 'teammate' }, state: makeState([rebuttalItem]), settings }).tier, 'high')
})

test('createThinkingRouter locks effort per turn, updates on next turn, and handles role model overrides & fail-open', async () => {
  const lead = makeScopedAgent('session-lead')
  const impl = makeScopedAgent('session-impl')
  let currentState = makeState([makeItem({ owner: 'impl', complexity: 'normal' })])

  const members = [
    { id: lead.id, name: 'lead', role: 'lead' },
    { id: impl.id, name: 'impl', role: 'teammate' },
  ]
  const ctx = {
    agentTeams: {
      tryMembership: (a) => {
        const m = members.find((x) => x.id === a.id)
        return m ? { root: lead, id: a.id, name: m.name, role: m.role } : undefined
      },
    },
    logger: { warn() {}, debug() {} },
  }
  const store = {
    cachedState: () => currentState,
    teamIdOf: () => 'session-lead',
  }
  const settings = resolveSettings({
    roles: {
      implementer: { llmProvider: 'deepseek', model: 'deepseek-flash', maxTokens: 8192 },
    },
  })

  const router = createThinkingRouter({
    ctx,
    store,
    settings,
    resolveModelInfo: async (provider, model) => {
      if (provider === 'deepseek' && model === 'deepseek-flash') {
        return { id: model, reasoning: { efforts: [{ id: 'off' }, { id: 'low' }, { id: 'high' }, { id: 'max' }] } }
      }
      if (provider === 'plain' && model === 'no-reasoning') {
        return { id: model }
      }
      return null
    },
  })

  const disposeImpl = router.install(impl)

  // Turn 1 Step 1: normal implementer -> mapped to 'low' on DeepSeek + role model override
  const t1s1 = await impl.runRequest({ turn: 1, step: 1 }, { provider: 'deepseek', model: 'deepseek-v4-pro', reasoningEffort: 'max' })
  assert.equal(t1s1.provider, 'deepseek')
  assert.equal(t1s1.model, 'deepseek-flash')
  assert.equal(t1s1.reasoningEffort, 'low')
  assert.equal(t1s1.maxTokens, 8192)

  // Mutate state mid-turn to changes_requested -> Turn 1 Step 2 must stay locked at 'low'
  currentState = makeState([makeItem({ owner: 'impl', status: W.ITEM_STATUS.CHANGES_REQUESTED })])
  const t1s2 = await impl.runRequest({ turn: 1, step: 2 }, { provider: 'deepseek', model: 'deepseek-v4-pro', reasoningEffort: 'max' })
  assert.equal(t1s2.reasoningEffort, 'low', 'same turn must keep locked reasoningEffort')

  // Turn 2 Step 1: rework automatically upgrades to 'high'
  const t2s1 = await impl.runRequest({ turn: 2, step: 1 }, { provider: 'deepseek', model: 'deepseek-v4-pro', reasoningEffort: 'max' })
  assert.equal(t2s1.reasoningEffort, 'high')

  // Telemetry snapshot reflects calls and effort breakdown
  const snap = router.snapshot('session-lead')
  assert.equal(snap.impl.calls, 3)
  assert.deepEqual(snap.impl.byEffort, { low: 2, high: 1 })
  assert.equal(snap.impl.resolvedEffort, 'high')

  // Markdown report includes Model & thinking routing section
  const md = renderReportMarkdown(
    {
      ...currentState,
      usage: {
        totals: { uncachedInputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 },
        byRole: { worker: { uncachedInputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 15 } },
        tokenShare: { worker: 1 },
        routing: snap,
      },
    },
    { pass: true, itemGates: [], teamFailures: [] },
  )
  assert.match(md, /## Model & thinking routing/)
  assert.match(md, /\| impl \| implementer \| deepseek\/deepseek-flash \| high \| rework \| 3 \|/)

  disposeImpl()
  assert.equal(impl.listenerCount('agent/request'), 0)

  // Non-reasoning model strips inherited reasoningEffort cleanly
  const noReasonAgent = makeScopedAgent('session-nr')
  members.push({ id: noReasonAgent.id, name: 'nr', role: 'teammate' })
  const plainRouter = createThinkingRouter({
    ctx,
    store,
    settings: resolveSettings({}),
    resolveModelInfo: async () => ({ id: 'no-reasoning' }),
  })
  plainRouter.install(noReasonAgent)
  const nrRes = await noReasonAgent.runRequest({ turn: 1, step: 1 }, { provider: 'plain', model: 'no-reasoning', reasoningEffort: 'high' })
  assert.equal(Object.hasOwn(nrRes, 'reasoningEffort'), false, 'incompatible inherited effort must be stripped')

  // Failing probe fails open and preserves base config
  const failAgent = makeScopedAgent('session-fail')
  members.push({ id: failAgent.id, name: 'fail', role: 'teammate' })
  const failRouter = createThinkingRouter({
    ctx,
    store,
    settings: resolveSettings({}),
    resolveModelInfo: async () => {
      throw new Error('llm service offline')
    },
  })
  failRouter.install(failAgent)
  const failRes = await failAgent.runRequest({ turn: 1, step: 1 }, { provider: 'deepseek', model: 'deepseek-v4-pro', reasoningEffort: 'high' })
  assert.equal(failRes.reasoningEffort, 'high')
  assert.equal(failRes.model, 'deepseek-v4-pro')
})

test('selectThinkingPlan escalates multi-round/blocker rework to max and stall recovery nudges to high', () => {
  const settings = resolveSettings({})

  // Round-1 minor rework stays 'high'
  const minorRework = makeItem({
    status: W.ITEM_STATUS.CHANGES_REQUESTED,
    reviews: [{ round: 1, status: 'submitted', reviewer: 'rev', verdict: 'request_changes', findings: [{ id: 'F1', severity: 'minor' }] }],
  })
  const minorPlan = selectThinkingPlan({ membership: { name: 'impl', role: 'teammate' }, state: makeState([minorRework]), settings })
  assert.equal(minorPlan.tier, 'high')
  assert.equal(minorPlan.stage, 'rework')
  assert.equal(minorPlan.reason, 'rework-escalate')

  // Round-1 blocker rework upgrades to 'max' (rework-deep)
  const blockerRework = makeItem({
    status: W.ITEM_STATUS.CHANGES_REQUESTED,
    reviews: [{ round: 1, status: 'submitted', reviewer: 'rev', verdict: 'request_changes', findings: [{ id: 'F1', severity: 'blocker' }] }],
  })
  const blockerPlan = selectThinkingPlan({ membership: { name: 'impl', role: 'teammate' }, state: makeState([blockerRework]), settings })
  assert.equal(blockerPlan.tier, 'max')
  assert.equal(blockerPlan.stage, 'rework-deep')
  assert.equal(blockerPlan.reason, 'rework-max-escalate')

  // Round >= 2 rework upgrades to 'max' (rework-deep)
  const multiRoundRework = makeItem({
    status: W.ITEM_STATUS.CHANGES_REQUESTED,
    reviews: [
      { round: 1, status: 'submitted', reviewer: 'rev', verdict: 'request_changes', findings: [{ id: 'F1', severity: 'minor' }] },
      { round: 2, status: 'submitted', reviewer: 'rev', verdict: 'request_changes', findings: [{ id: 'F2', severity: 'minor' }] },
    ],
  })
  const multiPlan = selectThinkingPlan({ membership: { name: 'impl', role: 'teammate' }, state: makeState([multiRoundRework]), settings })
  assert.equal(multiPlan.tier, 'max')
  assert.equal(multiPlan.stage, 'rework-deep')

  // Stall nudge triggers high recovery tier for both worker and reviewer
  const workerStallState = makeState([makeItem({ complexity: 'trivial' })], {
    events: [{ type: 'member/stall-nudge', detail: 'impl on W1 (worker, nudge 1/2)' }],
  })
  const workerRecovery = selectThinkingPlan({ membership: { name: 'impl', role: 'teammate' }, state: workerStallState, settings })
  assert.equal(workerRecovery.tier, 'high')
  assert.equal(workerRecovery.stage, 'stall-recovery')
  assert.equal(workerRecovery.reason, 'stall-recovery-escalate')

  const reviewerStallState = makeState(
    [
      makeItem({
        status: W.ITEM_STATUS.IN_REVIEW,
        reviewDepth: 'light',
        reviews: [{ round: 1, status: 'pending', reviewer: 'rev', findings: [] }],
      }),
    ],
    {
      events: [{ type: 'member/stall-nudge', detail: 'rev on W1 (reviewer, nudge 1/2)' }],
    },
  )
  const reviewerRecovery = selectThinkingPlan({ membership: { name: 'rev', role: 'teammate' }, state: reviewerStallState, settings })
  assert.equal(reviewerRecovery.tier, 'high')
  assert.equal(reviewerRecovery.stage, 'review-stall-recovery')
  assert.equal(reviewerRecovery.reason, 'stall-recovery-escalate')
})

test('selectThinkingPlan downgrades non-blocking turns at >= 80% token budget while protecting critical stages', () => {
  const settings = resolveSettings({ tokenBudgetPerRun: 1000 })
  assert.equal(BUDGET_DOWNGRADE_RATIO, 0.8)

  const usage79 = { totals: { uncachedInputTokens: 700, outputTokens: 90, cacheReadTokens: 0, cacheWriteTokens: 0 } }
  const usage80 = { totals: { uncachedInputTokens: 700, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0 } }
  assert.equal(computeBudgetPressure(usage79, settings).active, false)
  assert.equal(computeBudgetPressure(usage80, settings).active, true)

  // Below 80%: normal complex item stays high
  const complexItem = makeItem({ complexity: 'complex' })
  assert.equal(
    selectThinkingPlan({ membership: { name: 'impl', role: 'teammate' }, state: makeState([complexItem]), settings, usage: usage79 }).tier,
    'high',
  )

  // At 80%: routine complex implementer, standard reviewer, and lead planning downgrade to low
  const downgradedImpl = selectThinkingPlan({ membership: { name: 'impl', role: 'teammate' }, state: makeState([complexItem]), settings, usage: usage80 })
  assert.equal(downgradedImpl.tier, 'low')
  assert.equal(downgradedImpl.bias, 'low')
  assert.equal(downgradedImpl.budgetDowngraded, true)
  assert.match(downgradedImpl.reason, /:budget-downgrade$/)

  const revItem = makeItem({
    status: W.ITEM_STATUS.IN_REVIEW,
    reviewDepth: 'standard',
    reviews: [{ round: 1, status: 'pending', reviewer: 'rev', findings: [] }],
  })
  const downgradedRev = selectThinkingPlan({ membership: { name: 'rev', role: 'teammate' }, state: makeState([revItem]), settings, usage: usage80 })
  assert.equal(downgradedRev.tier, 'low')
  assert.equal(downgradedRev.budgetDowngraded, true)

  const downgradedLeadPlan = selectThinkingPlan({
    membership: { name: 'lead', role: 'lead' },
    state: makeState([complexItem], { phase: W.RUN_PHASE.PLANNED }),
    settings,
    usage: usage80,
  })
  assert.equal(downgradedLeadPlan.tier, 'low')
  assert.equal(downgradedLeadPlan.budgetDowngraded, true)

  // Protected stages remain undowngraded at >= 80% budget
  const leadArb = selectThinkingPlan({
    membership: { name: 'lead', role: 'lead' },
    state: makeState([makeItem({ status: W.ITEM_STATUS.ESCALATED })]),
    settings,
    usage: usage80,
  })
  assert.equal(leadArb.tier, 'high')
  assert.equal(leadArb.budgetDowngraded, undefined)

  const reworkProtected = selectThinkingPlan({
    membership: { name: 'impl', role: 'teammate' },
    state: makeState([makeItem({ status: W.ITEM_STATUS.CHANGES_REQUESTED })]),
    settings,
    usage: usage80,
  })
  assert.equal(reworkProtected.tier, 'high')

  const rebuttalProtected = selectThinkingPlan({
    membership: { name: 'rev', role: 'teammate' },
    state: makeState([
      makeItem({
        status: W.ITEM_STATUS.IN_REVIEW,
        reviews: [
          { round: 1, status: 'submitted', reviewer: 'rev', verdict: 'request_changes', findings: [{ id: 'F1', resolution: { state: 'rebut' } }] },
          { round: 2, status: 'pending', reviewer: 'rev', findings: [] },
        ],
      }),
    ]),
    settings,
    usage: usage80,
  })
  assert.equal(rebuttalProtected.tier, 'high')

  const stallProtected = selectThinkingPlan({
    membership: { name: 'impl', role: 'teammate' },
    state: makeState([makeItem()], { events: [{ type: 'member/stall-nudge', detail: 'impl on W1 (worker, nudge 1/2)' }] }),
    settings,
    usage: usage80,
  })
  assert.equal(stallProtected.tier, 'high')

  const overrideProtected = selectThinkingPlan({
    membership: { name: 'impl', role: 'teammate' },
    state: makeState([makeItem({ thinkingTier: 'max' })]),
    settings,
    usage: usage80,
  })
  assert.equal(overrideProtected.tier, 'max')
})

test('createThinkingRouter dynamically downgrades reasoningEffort via live tokenUsage sampler at 80% budget', async () => {
  const lead = makeScopedAgent('session-lead')
  const impl = makeScopedAgent('session-impl')
  const members = [
    { id: lead.id, name: 'lead', role: 'lead', agent: lead },
    { id: impl.id, name: 'impl', role: 'teammate', agent: impl },
  ]
  const settings = resolveSettings({ tokenBudgetPerRun: 1000 })
  const state = makeState([makeItem({ owner: 'impl', complexity: 'complex' })], { settings })
  let used = 400
  const ctx = {
    agentTeams: {
      tryMembership: (a) => {
        const m = members.find((x) => x.id === a.id)
        return m ? { root: lead, id: a.id, name: m.name, role: m.role } : undefined
      },
      listMembers: () => members,
    },
    logger: { warn() {}, debug() {} },
  }
  const store = {
    cachedState: () => state,
    teamIdOf: () => 'session-lead',
  }
  const router = createThinkingRouter({
    ctx,
    store,
    settings,
    resolveModelInfo: async () => ({
      id: 'deepseek-v4-pro',
      reasoning: { efforts: [{ id: 'off' }, { id: 'low' }, { id: 'high' }, { id: 'max' }] },
    }),
    tokenUsage: () => (agent) => (agent?.id === impl.id ? { uncachedInputTokens: used, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 } : null),
  })
  router.install(impl)

  // Turn 1 (40% used): complex item gets 'high'
  const t1 = await impl.runRequest({ turn: 1, step: 1 }, { provider: 'deepseek', model: 'deepseek-v4-pro', reasoningEffort: 'high' })
  assert.equal(t1.reasoningEffort, 'high')

  // Turn 2 (85% used): complex non-blocking item automatically downgrades to 'low'
  used = 850
  const t2 = await impl.runRequest({ turn: 2, step: 1 }, { provider: 'deepseek', model: 'deepseek-v4-pro', reasoningEffort: 'high' })
  assert.equal(t2.reasoningEffort, 'low')
})
