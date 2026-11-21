/**
 * Adaptive Thinking / Reasoning Effort Router for Agent Teams.
 *
 * Maps workflow semantics (role × stage × item complexity) into concrete
 * provider-validated `reasoningEffort` values via DSH's `agent/request`
 * waterfall and `ctx.llm.resolveModelInfo`. Never invents unsupported efforts
 * and fails open when capability probing is unavailable.
 */

import { ITEM_STATUS, pendingReviewFor, RUN_PHASE } from './workflow.js'

export const THINKING_TIERS = Object.freeze(['off', 'low', 'medium', 'high', 'max'])
export const ITEM_COMPLEXITIES = Object.freeze(['trivial', 'normal', 'complex'])
export const THINKING_MODES = Object.freeze(['auto', 'role', 'off'])

const MODEL_CACHE_TTL_MS = 5 * 60_000
const MODEL_CACHE_MAX = 64

/**
 * Normalize reasoning efforts from `LlmModelReasoningInfo` into ordered string ids.
 * @param {object|null|undefined} reasoningInfo
 * @returns {string[]}
 */
function extractSupportedEfforts(reasoningInfo) {
  const raw = Array.isArray(reasoningInfo?.efforts) ? reasoningInfo.efforts : []
  const ids = []
  for (const entry of raw) {
    const id = typeof entry === 'string' ? entry : entry?.id
    if (typeof id === 'string' && id.trim().length > 0 && !ids.includes(id)) {
      ids.push(id)
    }
  }
  return ids
}

/**
 * Safely map a semantic thinking tier onto an effort declared by the model.
 * Invariant: whenever `effort !== undefined`, `supported.includes(effort)` holds.
 *
 * @param {string|null|undefined} tier - `'off' | 'low' | 'medium' | 'high' | 'max' | 'inherit'`
 * @param {object|null|undefined} reasoningInfo - `{ efforts, defaultEffort }`
 * @param {object} [options] - `{ bias?: 'low' | 'high' }`
 * @returns {{ effort: string|undefined, preserveInherited?: boolean, reason: string, supported: string[] }}
 */
export function mapTierToEffort(tier, reasoningInfo, options = {}) {
  const supported = extractSupportedEfforts(reasoningInfo)
  if (!tier || tier === 'inherit') {
    return { effort: undefined, preserveInherited: true, reason: 'inherit', supported }
  }
  if (supported.length === 0) {
    return { effort: undefined, reason: 'unsupported-model', supported }
  }
  if (supported.length === 1) {
    return { effort: supported[0], reason: 'single-effort', supported }
  }

  const byLower = new Map(supported.map((id) => [id.toLowerCase(), id]))
  const normalizedTier = String(tier).trim().toLowerCase()
  if (byLower.has(normalizedTier)) {
    return { effort: byLower.get(normalizedTier), reason: 'exact', supported }
  }

  const activeEfforts = supported.filter((id) => {
    const lower = id.toLowerCase()
    return lower !== 'off' && lower !== 'none'
  })
  const pickFirst = (candidates) => {
    for (const candidate of candidates) {
      if (byLower.has(candidate)) return byLower.get(candidate)
    }
    return undefined
  }

  let mapped
  if (normalizedTier === 'off') {
    mapped = pickFirst(['off', 'none', 'minimal', 'low']) ?? supported[0]
  } else if (normalizedTier === 'low') {
    mapped = pickFirst(['low', 'minimal']) ?? activeEfforts[0] ?? supported[0]
  } else if (normalizedTier === 'medium') {
    mapped = pickFirst(['medium', 'mid', 'balanced'])
    if (mapped === undefined) {
      if (options.bias === 'high') {
        mapped = pickFirst(['high']) ?? activeEfforts[Math.ceil((activeEfforts.length - 1) / 2)] ?? supported[0]
      } else {
        mapped = pickFirst(['low']) ?? activeEfforts[0] ?? supported[0]
      }
    }
  } else if (normalizedTier === 'high') {
    mapped = pickFirst(['high', 'xhigh', 'max']) ?? activeEfforts.at(-1) ?? supported.at(-1)
  } else if (normalizedTier === 'max') {
    mapped = pickFirst(['max', 'xhigh', 'high']) ?? activeEfforts.at(-1) ?? supported.at(-1)
  } else {
    mapped = undefined
  }

  return {
    effort: mapped,
    reason: mapped === undefined ? 'unmapped' : 'mapped',
    supported,
  }
}

/**
 * Determine the semantic thinking tier and optional role model route for a
 * Team member given the current workflow run state.
 *
 * @param {object} input - `{ membership, state, settings }`
 * @returns {{ tier: string, bias: 'low'|'high', llmProvider?: string, model?: string, maxTokens?: number, role: string, stage: string, itemId: string|null, reason: string }}
 */
export function selectThinkingPlan({ membership, state, settings }) {
  const memberName = membership?.name ?? ''
  const items = Array.isArray(state?.items) ? state.items : []
  const activeOwned = items.filter((it) => it.owner === memberName && it.status !== ITEM_STATUS.APPROVED)
  const primaryOwned =
    activeOwned.find((it) => it.status === ITEM_STATUS.CHANGES_REQUESTED) ??
    activeOwned.find((it) => it.status === ITEM_STATUS.RUNNING) ??
    activeOwned[0] ??
    null
  const pendingReviewItem = items.find((it) => pendingReviewFor(it, memberName) !== null) ?? null

  const assignedRole = typeof state?.roleAssignments?.[memberName] === 'string' ? state.roleAssignments[memberName] : ''
  const resolvedRole =
    assignedRole ||
    primaryOwned?.role ||
    (pendingReviewItem !== null ? 'reviewer' : '') ||
    membership?.role ||
    'implementer'

  const roleConfig = settings?.roles?.[resolvedRole] ?? {}
  const explicitRoleTier =
    typeof roleConfig.thinking === 'string' && roleConfig.thinking.length > 0 && roleConfig.thinking !== 'inherit'
      ? roleConfig.thinking
      : null

  const modelMeta = {
    llmProvider: roleConfig.llmProvider,
    model: roleConfig.model,
    maxTokens: roleConfig.maxTokens,
  }

  const mode = settings?.thinkingRouting ?? 'auto'
  if (mode === 'off') {
    return {
      tier: 'inherit',
      bias: 'low',
      llmProvider: undefined,
      model: undefined,
      maxTokens: undefined,
      role: resolvedRole,
      stage: 'off',
      itemId: null,
      reason: 'routing-off',
    }
  }

  if (mode === 'role') {
    const tier = roleConfig.thinking ?? 'inherit'
    return {
      tier,
      bias: tier === 'high' || tier === 'max' ? 'high' : 'low',
      ...modelMeta,
      role: resolvedRole,
      stage: 'role',
      itemId: primaryOwned?.id ?? pendingReviewItem?.id ?? null,
      reason: 'role-config',
    }
  }

  // 1. Team Lead routing
  if (membership?.role === 'lead') {
    const hasBlockingEscalation = Array.isArray(state?.escalations) && state.escalations.some((e) => e.blocking && !e.resolved)
    const hasEscalatedItem = items.some((it) => it.status === ITEM_STATUS.ESCALATED)
    const hasMergeConflict = items.some((it) => Boolean(it.git?.worktreeMergeError))
    if (hasBlockingEscalation || hasEscalatedItem || hasMergeConflict) {
      return { tier: 'high', bias: 'high', ...modelMeta, role: resolvedRole, stage: 'arbitration', itemId: null, reason: 'lead-arbitration' }
    }
    if (explicitRoleTier !== null) {
      return {
        tier: explicitRoleTier,
        bias: explicitRoleTier === 'high' || explicitRoleTier === 'max' ? 'high' : 'low',
        ...modelMeta,
        role: resolvedRole,
        stage: 'role-override',
        itemId: null,
        reason: 'role-override',
      }
    }
    if (!state || state.phase === RUN_PHASE.PLANNED) {
      return { tier: 'high', bias: 'high', ...modelMeta, role: resolvedRole, stage: 'plan', itemId: null, reason: 'lead-plan' }
    }
    if (state.phase === RUN_PHASE.CONVERGED || state.phase === RUN_PHASE.FINALIZED) {
      return { tier: 'low', bias: 'low', ...modelMeta, role: resolvedRole, stage: 'finalize', itemId: null, reason: 'lead-finalize' }
    }
    return { tier: 'low', bias: 'low', ...modelMeta, role: resolvedRole, stage: 'coordinate', itemId: null, reason: 'lead-coordinate' }
  }

  // 2. Active pending review takes precedence when assigned
  if (pendingReviewItem !== null) {
    const itemTier =
      typeof pendingReviewItem.thinkingTier === 'string' && pendingReviewItem.thinkingTier.length > 0 && pendingReviewItem.thinkingTier !== 'inherit'
        ? pendingReviewItem.thinkingTier
        : null
    if (itemTier !== null) {
      return {
        tier: itemTier,
        bias: itemTier === 'high' || itemTier === 'max' ? 'high' : 'low',
        ...modelMeta,
        role: resolvedRole,
        stage: 'review-override',
        itemId: pendingReviewItem.id,
        reason: 'item-override',
      }
    }
    const submitted = Array.isArray(pendingReviewItem.reviews)
      ? pendingReviewItem.reviews.filter((r) => r.status === 'submitted')
      : []
    if (submitted.length > 0) {
      const hasRebuttal = submitted.at(-1)?.findings?.some((f) => f.resolution?.state === 'rebut')
      if (hasRebuttal) {
        return {
          tier: 'high',
          bias: 'high',
          ...modelMeta,
          role: resolvedRole,
          stage: 're-review-rebuttal',
          itemId: pendingReviewItem.id,
          reason: 'rebuttal-escalation',
        }
      }
      if (explicitRoleTier !== null) {
        return {
          tier: explicitRoleTier,
          bias: explicitRoleTier === 'high' || explicitRoleTier === 'max' ? 'high' : 'low',
          ...modelMeta,
          role: resolvedRole,
          stage: 're-review',
          itemId: pendingReviewItem.id,
          reason: 'role-override',
        }
      }
      return {
        tier: 'low',
        bias: 'low',
        ...modelMeta,
        role: resolvedRole,
        stage: 're-review',
        itemId: pendingReviewItem.id,
        reason: 'delta-re-review',
      }
    }
    if (explicitRoleTier !== null) {
      return {
        tier: explicitRoleTier,
        bias: explicitRoleTier === 'high' || explicitRoleTier === 'max' ? 'high' : 'low',
        ...modelMeta,
        role: resolvedRole,
        stage: 'review-role-override',
        itemId: pendingReviewItem.id,
        reason: 'role-override',
      }
    }
    const effectiveDepth = pendingReviewItem.resolvedReview?.depth ?? pendingReviewItem.reviewDepth
    if (effectiveDepth === 'deep' || pendingReviewItem.complexity === 'complex') {
      return {
        tier: 'high',
        bias: 'high',
        ...modelMeta,
        role: resolvedRole,
        stage: 'review-deep',
        itemId: pendingReviewItem.id,
        reason: 'review-deep',
      }
    }
    if (effectiveDepth === 'light' || pendingReviewItem.complexity === 'trivial') {
      return {
        tier: 'low',
        bias: 'low',
        ...modelMeta,
        role: resolvedRole,
        stage: 'review-light',
        itemId: pendingReviewItem.id,
        reason: 'review-light',
      }
    }
    return {
      tier: 'medium',
      bias: 'high',
      ...modelMeta,
      role: resolvedRole,
      stage: 'review-standard',
      itemId: pendingReviewItem.id,
      reason: 'review-standard',
    }
  }

  // 3. Owned active work item
  if (primaryOwned !== null) {
    const itemTier =
      typeof primaryOwned.thinkingTier === 'string' && primaryOwned.thinkingTier.length > 0 && primaryOwned.thinkingTier !== 'inherit'
        ? primaryOwned.thinkingTier
        : null
    if (itemTier !== null) {
      return {
        tier: itemTier,
        bias: itemTier === 'high' || itemTier === 'max' ? 'high' : 'low',
        ...modelMeta,
        role: resolvedRole,
        stage: 'implement-override',
        itemId: primaryOwned.id,
        reason: 'item-override',
      }
    }
    if (primaryOwned.status === ITEM_STATUS.CHANGES_REQUESTED) {
      return {
        tier: 'high',
        bias: 'high',
        ...modelMeta,
        role: resolvedRole,
        stage: 'rework',
        itemId: primaryOwned.id,
        reason: 'rework-escalate',
      }
    }
    if (explicitRoleTier !== null) {
      return {
        tier: explicitRoleTier,
        bias: explicitRoleTier === 'high' || explicitRoleTier === 'max' ? 'high' : 'low',
        ...modelMeta,
        role: resolvedRole,
        stage: 'implement-role-override',
        itemId: primaryOwned.id,
        reason: 'role-override',
      }
    }
    if (primaryOwned.role === 'verifier') {
      return { tier: 'low', bias: 'low', ...modelMeta, role: resolvedRole, stage: 'verify', itemId: primaryOwned.id, reason: 'role-verifier' }
    }
    if (primaryOwned.role === 'architect' || primaryOwned.role === 'researcher') {
      return { tier: 'high', bias: 'high', ...modelMeta, role: resolvedRole, stage: 'design', itemId: primaryOwned.id, reason: `role-${primaryOwned.role}` }
    }
    if (primaryOwned.complexity === 'complex') {
      return { tier: 'high', bias: 'high', ...modelMeta, role: resolvedRole, stage: 'implement-complex', itemId: primaryOwned.id, reason: 'item-complex' }
    }
    if (primaryOwned.complexity === 'trivial') {
      return { tier: 'low', bias: 'low', ...modelMeta, role: resolvedRole, stage: 'implement-trivial', itemId: primaryOwned.id, reason: 'item-trivial' }
    }
    if (settings?.thinkingDefaultBias === 'high') {
      return { tier: 'high', bias: 'high', ...modelMeta, role: resolvedRole, stage: 'implement-normal', itemId: primaryOwned.id, reason: 'default-bias-high' }
    }
    return { tier: 'medium', bias: 'low', ...modelMeta, role: resolvedRole, stage: 'implement-normal', itemId: primaryOwned.id, reason: 'default-normal' }
  }

  // 4. Idle / unassigned fallback by role
  if (explicitRoleTier !== null) {
    return {
      tier: explicitRoleTier,
      bias: explicitRoleTier === 'high' || explicitRoleTier === 'max' ? 'high' : 'low',
      ...modelMeta,
      role: resolvedRole,
      stage: 'idle',
      itemId: null,
      reason: 'role-override',
    }
  }
  if (resolvedRole === 'verifier') {
    return { tier: 'low', bias: 'low', ...modelMeta, role: resolvedRole, stage: 'idle', itemId: null, reason: 'role-verifier' }
  }
  if (resolvedRole === 'reviewer') {
    return { tier: 'medium', bias: 'high', ...modelMeta, role: resolvedRole, stage: 'idle', itemId: null, reason: 'role-reviewer' }
  }
  if (resolvedRole === 'architect' || resolvedRole === 'researcher') {
    return { tier: 'high', bias: 'high', ...modelMeta, role: resolvedRole, stage: 'idle', itemId: null, reason: `role-${resolvedRole}` }
  }
  return { tier: 'low', bias: 'low', ...modelMeta, role: resolvedRole, stage: 'idle', itemId: null, reason: 'idle-default' }
}

/**
 * Create the per-plugin thinking router instance that installs `agent/request`
 * waterfall hooks on Team members, caches model capabilities, locks per-turn
 * routing, and tracks telemetry per Team run.
 */
export function createThinkingRouter({ ctx, store, settings, resolveModelInfo = () => null } = {}) {
  const modelCache = new Map() // `${provider}:${model}` -> { info, expiresAt }
  const turnDecisions = new Map() // agentId -> { turn, baseKey, patch, meta }
  const telemetryByTeam = new Map() // teamId -> Map<memberName, record>

  async function probeModelInfo(provider, model, signal) {
    if (!provider || !model) return null
    try {
      let fn = null
      if (typeof resolveModelInfo === 'function') {
        if (resolveModelInfo.length === 0) {
          const inner = resolveModelInfo()
          if (typeof inner === 'function') fn = inner
          else if (inner && typeof inner.then === 'function') {
            const awaited = await inner
            if (typeof awaited === 'function') fn = awaited
            else return awaited ?? null
          } else if (inner && typeof inner === 'object') {
            return inner
          }
        } else {
          fn = resolveModelInfo
        }
      }
      if (fn !== null) {
        return (await fn(provider, model, signal)) ?? null
      }
      if (typeof ctx?.llm?.resolveModelInfo === 'function') {
        return (await ctx.llm.resolveModelInfo(provider, model, signal)) ?? null
      }
      return null
    } catch (err) {
      ctx?.logger?.debug?.(`[thinking-router] resolveModelInfo(${provider}, ${model}) failed: ${err?.message ?? err}`)
      return null
    }
  }

  async function getCachedModelInfo(provider, model, signal) {
    if (!provider || !model) return null
    const key = `${provider}:${model}`
    const now = Date.now()
    const cached = modelCache.get(key)
    if (cached && cached.expiresAt > now) return cached.info
    const info = await probeModelInfo(provider, model, signal)
    if (info !== null) {
      if (modelCache.size >= MODEL_CACHE_MAX) {
        const oldest = modelCache.keys().next().value
        if (oldest !== undefined) modelCache.delete(oldest)
      }
      modelCache.set(key, { info, expiresAt: now + MODEL_CACHE_TTL_MS })
    }
    return info
  }

  function record(teamId, memberName, meta) {
    if (!teamId || !memberName) return
    let teamMap = telemetryByTeam.get(teamId)
    if (!teamMap) {
      teamMap = new Map()
      telemetryByTeam.set(teamId, teamMap)
    }
    const prev = teamMap.get(memberName) ?? {
      member: memberName,
      role: meta.role ?? 'implementer',
      provider: meta.provider ?? null,
      model: meta.model ?? null,
      requestedTier: meta.requestedTier ?? 'inherit',
      resolvedEffort: meta.resolvedEffort ?? null,
      stage: meta.stage ?? null,
      itemId: meta.itemId ?? null,
      calls: 0,
      byEffort: {},
      updatedAt: null,
    }
    const effortBucket = meta.resolvedEffort ?? 'default'
    const byEffort = { ...prev.byEffort, [effortBucket]: (prev.byEffort[effortBucket] ?? 0) + 1 }
    teamMap.set(memberName, {
      member: memberName,
      role: meta.role ?? prev.role,
      provider: meta.provider ?? prev.provider,
      model: meta.model ?? prev.model,
      requestedTier: meta.requestedTier ?? prev.requestedTier,
      resolvedEffort: meta.resolvedEffort ?? null,
      stage: meta.stage ?? prev.stage,
      itemId: meta.itemId ?? null,
      calls: prev.calls + 1,
      byEffort,
      updatedAt: new Date().toISOString(),
    })
  }

  function snapshot(teamId) {
    const teamMap = telemetryByTeam.get(teamId)
    if (!teamMap || teamMap.size === 0) return null
    const result = {}
    for (const [name, entry] of teamMap.entries()) {
      result[name] = { ...entry, byEffort: { ...entry.byEffort } }
    }
    return result
  }

  function clearAgent(agentId) {
    if (agentId) turnDecisions.delete(agentId)
  }

  function clearCache() {
    modelCache.clear()
    turnDecisions.clear()
  }

  function applyPatch(base, patch) {
    const next = {
      ...base,
      provider: patch.provider ?? base.provider,
      model: patch.model ?? base.model,
    }
    if (patch.effort !== undefined) {
      next.reasoningEffort = patch.effort
    } else if (!patch.preserveInherited) {
      delete next.reasoningEffort
    }
    if (Number.isInteger(patch.maxTokens) && patch.maxTokens > 0) {
      next.maxTokens = patch.maxTokens
    }
    return next
  }

  /**
   * Install the `agent/request` waterfall interceptor on a single Team member.
   * @param {object} agent - live Agent with `agent.ctx`.
   * @returns {() => void} disposer
   */
  function install(agent) {
    if (typeof agent?.ctx?.on !== 'function') return () => {}
    const dispose = agent.ctx.on(
      'agent/request',
      async (payload, next) => {
        const base = await next()
        if (!base || typeof base !== 'object') return base
        if (settings?.thinkingRouting === 'off') return base

        const targetAgent = payload?.agent ?? agent
        const membership = ctx?.agentTeams?.tryMembership?.(targetAgent)
        if (!membership) return base

        const turn = Number.isInteger(payload?.turn) ? payload.turn : 0
        const baseKey = `${base.provider ?? ''}:${base.model ?? ''}`
        const cachedTurn = turnDecisions.get(targetAgent.id)
        if (cachedTurn && cachedTurn.turn === turn && cachedTurn.baseKey === baseKey) {
          record(cachedTurn.teamId, membership.name, cachedTurn.meta)
          return applyPatch(base, cachedTurn.patch)
        }

        let state = null
        try {
          state = store?.cachedState?.(targetAgent) ?? null
          if (state === null && typeof store?.readState === 'function') {
            state = await store.readState(targetAgent)
          }
        } catch {
          state = null
        }

        const teamId = state?.teamId ?? store?.teamIdOf?.(membership.root ?? targetAgent) ?? membership.root?.id ?? targetAgent.id
        const effectiveSettings = state?.settings
          ? {
              ...settings,
              ...state.settings,
              roles: {
                ...(settings?.roles ?? {}),
                ...(state.settings.roles ?? {}),
              },
            }
          : settings
        const plan = selectThinkingPlan({ membership, state, settings: effectiveSettings })

        if (plan.tier === 'inherit' && (!plan.llmProvider || !plan.model) && !plan.maxTokens) {
          return base
        }

        let targetProvider = base.provider
        let targetModel = base.model
        let modelInfo = null

        if (typeof plan.llmProvider === 'string' && plan.llmProvider.length > 0 && typeof plan.model === 'string' && plan.model.length > 0) {
          const overrideInfo = await getCachedModelInfo(plan.llmProvider, plan.model, payload?.signal)
          if (overrideInfo !== null) {
            targetProvider = plan.llmProvider
            targetModel = plan.model
            modelInfo = overrideInfo
          } else {
            ctx?.logger?.warn?.(
              `[thinking-router] role "${plan.role}" model override ${plan.llmProvider}/${plan.model} unavailable; falling back to ${base.provider}/${base.model}`,
            )
          }
        }

        if (modelInfo === null && targetProvider && targetModel) {
          modelInfo = await getCachedModelInfo(targetProvider, targetModel, payload?.signal)
        }

        // Fail-open when capability metadata cannot be probed
        if (modelInfo === null && plan.tier !== 'inherit') {
          const patch = {
            provider: targetProvider,
            model: targetModel,
            effort: undefined,
            preserveInherited: true,
            maxTokens: plan.maxTokens,
          }
          const meta = {
            role: plan.role,
            provider: targetProvider,
            model: targetModel,
            requestedTier: plan.tier,
            resolvedEffort: base.reasoningEffort ?? null,
            stage: plan.stage,
            itemId: plan.itemId,
          }
          turnDecisions.set(targetAgent.id, { turn, baseKey, teamId, patch, meta })
          record(teamId, membership.name, meta)
          return applyPatch(base, patch)
        }

        const mapped = mapTierToEffort(plan.tier, modelInfo?.reasoning, { bias: plan.bias })
        const patch = {
          provider: targetProvider,
          model: targetModel,
          effort: mapped.effort,
          preserveInherited: mapped.preserveInherited === true,
          maxTokens: plan.maxTokens,
        }
        const resolvedEffort = mapped.effort !== undefined ? mapped.effort : (mapped.preserveInherited ? (base.reasoningEffort ?? null) : null)
        const meta = {
          role: plan.role,
          provider: targetProvider,
          model: targetModel,
          requestedTier: plan.tier,
          resolvedEffort,
          stage: plan.stage,
          itemId: plan.itemId,
        }
        turnDecisions.set(targetAgent.id, { turn, baseKey, teamId, patch, meta })
        record(teamId, membership.name, meta)
        return applyPatch(base, patch)
      },
      { prepend: true },
    )
    return typeof dispose === 'function' ? dispose : () => {}
  }

  return {
    install,
    snapshot,
    clearAgent,
    clearCache,
  }
}
