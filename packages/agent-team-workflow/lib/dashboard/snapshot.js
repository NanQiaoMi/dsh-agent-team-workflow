/**
 * Top-level dashboard snapshot aggregation: timings, routing, usage, gates,
 * reliability metrics, and run assembly.
 */

import { computeReliabilityMetrics } from '../telemetry.js'
import {
  BOARD_SOURCES,
  clip,
  computeWaves,
  countReworkRounds,
  integerOf,
  isoOf,
  isRecord,
  MAX_ITEMS,
  parseAt,
  recordList,
  SNAPSHOT_VERSION,
  sortByAt,
  textList,
  textOf,
} from './shared.js'
import {
  buildChannelEntry,
  buildCollaboration,
  buildEscalations,
  buildEvents,
  buildTeam,
  countOpenProposals,
} from './collaboration.js'
import { buildDevkit, buildItem, buildRunGit } from './items-and-git.js'

/**
 * Aggregate the token-usage snapshot captured at gate time (docs/19 §6).
 * @param raw - raw `state.usage`.
 * @returns `{capturedAt, members, totals}` or null.
 */
function buildUsage(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
  const bucket = (value) => {
    if (value === null || typeof value !== 'object') return null
    return {
      uncachedInputTokens: integerOf(value.uncachedInputTokens),
      outputTokens: integerOf(value.outputTokens),
      cacheReadTokens: integerOf(value.cacheReadTokens),
      cacheWriteTokens: integerOf(value.cacheWriteTokens),
    }
  }
  const members = {}
  if (raw.members !== null && typeof raw.members === 'object' && !Array.isArray(raw.members)) {
    for (const [name, totals] of Object.entries(raw.members).slice(0, 32)) {
      const normalized = bucket(totals)
      if (normalized !== null) members[String(name)] = normalized
    }
  }
  const totals = bucket(raw.totals)
  if (totals === null && Object.keys(members).length === 0) return null

  const byRole = {}
  if (raw.byRole !== null && typeof raw.byRole === 'object' && !Array.isArray(raw.byRole)) {
    for (const [role, data] of Object.entries(raw.byRole).slice(0, 8)) {
      const normalized = bucket(data)
      if (normalized !== null) {
        normalized.totalTokens = integerOf(data.totalTokens ?? (normalized.uncachedInputTokens + normalized.outputTokens + normalized.cacheReadTokens + normalized.cacheWriteTokens))
        byRole[String(role)] = normalized
      }
    }
  }

  const tokenShare = {}
  if (raw.tokenShare !== null && typeof raw.tokenShare === 'object' && !Array.isArray(raw.tokenShare)) {
    for (const [role, share] of Object.entries(raw.tokenShare).slice(0, 8)) {
      const num = typeof share === 'number' && Number.isFinite(share) ? share : Number.parseFloat(String(share ?? ''))
      if (Number.isFinite(num)) tokenShare[String(role)] = Math.round(num * 10000) / 10000
    }
  }

  return {
    capturedAt: isoOf(raw.capturedAt),
    members,
    totals,
    byRole: Object.keys(byRole).length > 0 ? byRole : undefined,
    tokenShare: Object.keys(tokenShare).length > 0 ? tokenShare : undefined,
  }
}

function durationBetween(startIso, endIso) {
  const start = parseAt(startIso)
  const end = parseAt(endIso)
  if (start <= 0 || end <= 0) return null
  return Math.max(0, end - start)
}

function buildTimings(state, identifiedItems, waves, nowIso) {
  const createdMs = parseAt(state.createdAt)
  const itemTimings = []
  const implDurations = []
  const reviewDurations = []
  let reworkTotal = 0

  for (const entry of identifiedItems) {
    const raw = isRecord(entry?.raw) ? entry.raw : entry
    const id = textOf(entry?.id ?? raw?.id).trim()
    if (!id) continue
    const implementMs = durationBetween(raw.createdAt ?? state.createdAt, raw.reportedAt)
    const reviewMs = durationBetween(raw.reportedAt, raw.approvedAt)
    const endIso = isoOf(raw.approvedAt) ?? isoOf(raw.updatedAt) ?? null
    const totalMs = durationBetween(raw.createdAt ?? state.createdAt, endIso)
    const rounds = countReworkRounds(raw)
    reworkTotal += rounds
    if (implementMs !== null) implDurations.push(implementMs)
    if (reviewMs !== null) reviewDurations.push(reviewMs)
    itemTimings.push({ id, implementMs, reviewMs, totalMs, reworkRounds: rounds })
  }

  const endRunIso = isoOf(state.finalizedAt) ?? isoOf(state.updatedAt) ?? isoOf(nowIso)
  const totalMs = createdMs > 0 ? durationBetween(state.createdAt, endRunIso) : null
  if (totalMs === null && implDurations.length === 0 && reviewDurations.length === 0) return null

  const avg = (list) => (list.length === 0 ? null : Math.round(list.reduce((a, b) => a + b, 0) / list.length))
  const parallelPeak = Array.isArray(waves) && waves.length > 0 ? Math.max(0, ...waves.map((w) => (Array.isArray(w) ? w.length : 0))) : 0

  return {
    totalMs,
    avgImplementMs: avg(implDurations),
    avgReviewMs: avg(reviewDurations),
    reworkTotal,
    parallelPeak,
    items: itemTimings.slice(0, MAX_ITEMS),
  }
}

function buildRouting(rawRouting) {
  if (!isRecord(rawRouting)) return []
  const result = []
  for (const [member, rawEntry] of Object.entries(rawRouting).slice(0, 32)) {
    if (!isRecord(rawEntry)) continue
    const byEffort = {}
    if (isRecord(rawEntry.byEffort)) {
      for (const [eff, count] of Object.entries(rawEntry.byEffort)) {
        if (Number.isInteger(count) && count >= 0) byEffort[String(eff)] = count
      }
    }
    result.push({
      member: textOf(rawEntry.member) || String(member),
      role: textOf(rawEntry.role) || 'implementer',
      provider: isoOf(rawEntry.provider),
      model: isoOf(rawEntry.model),
      requestedTier: isoOf(rawEntry.requestedTier) ?? 'inherit',
      resolvedEffort: isoOf(rawEntry.resolvedEffort),
      stage: isoOf(rawEntry.stage),
      reason: isoOf(rawEntry.reason),
      budgetDowngraded: rawEntry.budgetDowngraded === true,
      itemId: isoOf(rawEntry.itemId),
      calls: integerOf(rawEntry.calls, 0),
      byEffort,
    })
  }
  return result
}

/**
 * Build the counts block from the already-normalized items, so the numbers can
 * never disagree with what the client renders.
 * `pending` deliberately includes `running`: the contract has no separate
 * `running` bucket, and the six buckets must add up to `total`.
 * @param items - normalized snapshot items.
 * @returns counts record.
 */
function buildCounts(items) {
  const counts = { total: items.length, approved: 0, pending: 0, inReview: 0, changesRequested: 0, escalated: 0 }
  for (const item of items) {
    if (item.status === 'approved') counts.approved += 1
    else if (item.status === 'pending' || item.status === 'running') counts.pending += 1
    else if (item.status === 'in_review') counts.inReview += 1
    else if (item.status === 'changes_requested') counts.changesRequested += 1
    else if (item.status === 'escalated') counts.escalated += 1
  }
  return counts
}

/**
 * Pass the run-scoped settings through unchanged.
 *
 * The engine freezes `{ maxReviewRounds, maxParallelItems, workerContext,
 * strictScopes, allowScopeOverlap, requireReviewEvidence }` into the run;
 * docs/09 §2 also shows `autoNotify`. Field names must stay exactly as the
 * blackboard stores them — no renaming to `maxRounds` etc.
 * @param settings - blackboard run settings.
 * @returns plain object of scalar settings.
 */
function buildSettings(settings) {
  if (!isRecord(settings)) return {}
  const result = {}
  for (const [key, value] of Object.entries(settings)) {
    if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') result[key] = value
  }
  return result
}

/**
 * Resolve one artifact path. An explicitly passed route value (including an
 * explicit `null`, which means "artifacts are disabled") wins over the copy the
 * engine froze into the run at plan time.
 * @param inputArtifacts - `artifacts` handed in by the route.
 * @param stateArtifacts - `state.artifacts` from the blackboard.
 * @param key - `root` / `statePath` / `reportPath`.
 * @returns the path, or null.
 */
function artifactPath(inputArtifacts, stateArtifacts, key) {
  const source = Object.hasOwn(inputArtifacts, key) ? inputArtifacts : stateArtifacts
  return isoOf(source[key])
}

/**
 * Build the run's artifact block from the route-supplied paths and the copy
 * frozen into the blackboard.
 * @param stateArtifacts - `state.artifacts`.
 * @param inputArtifacts - route-supplied artifacts.
 * @returns `{ root, statePath, reportPath }` (fields may be null).
 */
function buildArtifacts(stateArtifacts, inputArtifacts) {
  const fromState = isRecord(stateArtifacts) ? stateArtifacts : {}
  const fromInput = isRecord(inputArtifacts) ? inputArtifacts : {}
  return {
    root: artifactPath(fromInput, fromState, 'root'),
    statePath: artifactPath(fromInput, fromState, 'statePath'),
    reportPath: artifactPath(fromInput, fromState, 'reportPath'),
  }
}

/**
 * Pass through the engine gate result.
 *
 * Every field the engine writes is preserved — including `waived`, the
 * `overrideReason` that explains it, and the ids of blocking escalations —
 * because the gate panel and the final report are built from exactly this
 * record.
 * @param gate - `state.gate`.
 * @returns gate record, or null when the gate never ran.
 */
function buildGate(gate) {
  if (!isRecord(gate)) return null
  return {
    pass: gate.pass === true,
    evaluatedAt: isoOf(gate.evaluatedAt),
    itemGates: recordList(gate.itemGates).map((itemGate) => ({
      id: textOf(itemGate.id),
      pass: itemGate.pass === true,
      overridden: itemGate.overridden === true,
      overrideReason: typeof itemGate.overrideReason === 'string' ? clip(itemGate.overrideReason) : null,
      waived: textList(itemGate.waived),
      failures: textList(itemGate.failures),
      warnings: textList(itemGate.warnings),
    })),
    teamFailures: textList(gate.teamFailures),
    blockingEscalations: textList(gate.blockingEscalations),
  }
}

/**
 * Derive the macro collaboration pipeline stage.
 * @param state - blackboard run state
 * @param items - normalized items
 * @returns 'planning' | 'implementing' | 'reviewing' | 'reworking' | 'converged' | 'finalized'
 */
function computePipelineStage(state, items) {
  const phase = textOf(state.phase).trim().toLowerCase()
  if (state.finalizedAt || phase === 'finalized' || phase === 'completed') {
    return 'finalized'
  }
  if (phase === 'converged' || phase === 'gate') {
    return 'converged'
  }
  if (items.length === 0) {
    return 'planning'
  }
  if (items.every((it) => it.status === 'approved')) {
    return 'converged'
  }
  if (items.some((it) => it.status === 'changes_requested')) {
    return 'reworking'
  }
  if (items.some((it) => it.status === 'in_review')) {
    return 'reviewing'
  }
  if (items.some((it) => it.status === 'running' || (it.git && it.git.commits && it.git.commits.length > 0))) {
    return 'implementing'
  }
  return 'planning'
}

/**
 * Build the run block of the snapshot.
 * @param state - blackboard run record (non-null).
 * @param context - `{ tasks, artifacts, memberNames, warnings }`.
 * @returns snapshot run.
 */
function buildRun(state, context) {
  const warnings = context.warnings
  const rawItems = recordList(state.items)
  const identified = []
  for (const raw of rawItems) {
    const id = textOf(raw.id).trim()
    if (id.length === 0) continue
    if (identified.some((entry) => entry.id === id)) continue
    identified.push({ raw, id })
  }
  if (identified.length < rawItems.length) warnings.push(`${rawItems.length - identified.length} work item(s) without a unique id were skipped`)
  const kept = identified.slice(0, MAX_ITEMS)
  if (identified.length > MAX_ITEMS) warnings.push(`work items truncated to the first ${MAX_ITEMS} of ${identified.length}`)

  const waveInfo = computeWaves(kept.map((entry) => ({ id: entry.id, blockedBy: entry.raw.blockedBy })))
  if (waveInfo.cycle.length > 0) {
    warnings.push(`dependency cycle detected among work items: ${waveInfo.cycle.join(', ')}; those items can never run and report wave 0`)
  }

  const taskById = new Map()
  for (const task of recordList(context.tasks)) {
    const id = textOf(task.id).trim()
    if (id.length > 0 && !taskById.has(id)) taskById.set(id, task)
  }
  // The collaboration block and the item threads read one normalized channel.
  const channelEntries = sortByAt(recordList(state.channel).map(buildChannelEntry))
  const itemsById = new Map(identified.map((entry) => [entry.id, entry.raw]))
  const settings = isRecord(state.settings) ? state.settings : {}
  const itemContext = {
    waveOf: waveInfo.waveOf,
    taskById,
    maxRounds: integerOf(settings.maxReviewRounds),
    channelEntries,
    openProposalCounts: countOpenProposals(state.proposals),
    stats: { threadClipped: 0 },
  }
  const items = kept.map((entry) => buildItem(entry.raw, entry.id, itemContext))
  const collaboration = buildCollaboration(state, {
    channelEntries,
    items: kept,
    itemsById,
    memberNames: context.memberNames,
    warnings,
    stats: itemContext.stats,
  })

  return {
    id: textOf(state.runId).trim() || textOf(state.id).trim() || null,
    preset: isoOf(state.preset),
    phase: textOf(state.phase).trim() || 'unknown',
    pipelineStage: computePipelineStage(state, items),
    objective: clip(state.objective),
    acceptanceCriteria: textList(state.acceptanceCriteria),
    constraints: textList(state.constraints),
    createdAt: isoOf(state.createdAt),
    updatedAt: isoOf(state.updatedAt),
    finalizedAt: isoOf(state.finalizedAt),
    settings: buildSettings(state.settings),
    counts: buildCounts(items),
    waves: waveInfo.waves,
    items,
    gate: buildGate(state.gate),
    escalations: buildEscalations(state.escalations, warnings),
    events: buildEvents(state.events, warnings),
    collaboration,
    git: buildRunGit(state.git),
    usage: buildUsage(state.usage),
    timings: buildTimings(state, kept, waveInfo.waves, context.now),
    reliability: computeReliabilityMetrics(state),
    routing: buildRouting(context.routing ?? state.usage?.routing),
    artifacts: buildArtifacts(state.artifacts, context.artifacts),
  }
}

/**
 * Aggregate one dashboard snapshot (docs/09 §2 plus docs/12 §5, version 2).
 *
 * The function is total: it never throws for any input, and `run` is `null`
 * when the blackboard is missing — a missing board is an empty state, not an
 * error. `team` and `diagnostics` are always present so the client can still
 * show who is online.
 * @param input - `{ state, team, artifacts, now, diagnostics, sessionId? }`.
 *   `state` is the blackboard run (or null), `team` is `{ me, members, tasks }`,
 *   `artifacts` is `{ root, statePath, reportPath }`, `now` is the ISO time the
 *   route sampled the board, `diagnostics` is `{ boardSource, warnings }`, and
 *   `sessionId` is the id of the conversation the snapshot is for. Omit
 *   `sessionId` and the snapshot falls back to the board's `teamId`: the store
 *   keys every board by the Lead Session id, so that is the conversation which
 *   owns the run.
 * @returns the snapshot object.
 */
export function buildSnapshot(input) {
  const source = isRecord(input) ? input : {}
  const state = isRecord(source.state) ? source.state : null
  const teamInput = isRecord(source.team) ? source.team : {}
  const diagnosticsInput = isRecord(source.diagnostics) ? source.diagnostics : null
  const warnings = []
  for (const warning of textList(diagnosticsInput === null ? [] : diagnosticsInput.warnings)) warnings.push(warning)

  const team = buildTeam(teamInput, warnings)
  const run =
    state === null
      ? null
      : buildRun(state, {
          tasks: teamInput.tasks,
          artifacts: source.artifacts,
          routing: source.routing,
          now: source.now,
          memberNames: team.members.map((member) => member.name).filter((name) => name.length > 0),
          warnings,
        })

  const declaredSource = textOf(diagnosticsInput === null ? '' : diagnosticsInput.boardSource).trim()
  const boardSource = BOARD_SOURCES.has(declaredSource) ? declaredSource : state === null ? 'missing' : 'file'
  // The route passes the exact conversation id when it knows it; otherwise the
  // board's Team id is the best available identity (a board is keyed by the
  // Lead Session id), and null is the honest answer when there is no board.
  const sessionId = isoOf(source.sessionId) ?? (state === null ? null : isoOf(state.teamId))
  return {
    ok: true,
    version: SNAPSHOT_VERSION,
    // Monotonic board revision (state.rev): clients use it as an ETag and for
    // "has anything changed since N?" deltas without comparing whole payloads.
    rev: state !== null && Number.isInteger(state.rev) ? state.rev : 0,
    generatedAt: isoOf(source.now) ?? new Date().toISOString(),
    sessionId,
    run,
    team,
    devkit: buildDevkit(source.devkit),
    diagnostics: { boardSource, warnings },
  }
}
