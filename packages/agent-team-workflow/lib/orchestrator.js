/**
 * Team Orchestrator — autonomous event-driven coordinator and deadlock watchdog
 * for Agent Teams.
 *
 * It bridges the gap between passive tools and an active autonomous team:
 * 1. Auto-dispatch: When an item's dependencies are satisfied, wake the assigned
 *    worker or announce to the open queue.
 * 2. Auto-review: When a worker reports progress, ensure the reviewer is woken.
 * 3. Auto-convergence: When all items in a run are approved, notify the Lead
 *    that the team has converged and quality gate is ready for finalization.
 * 4. Watchdog: Periodically monitors active teams to ensure no item or member
 *    is stalled without progress.
 */

import { appendEvent, evaluateGates, ITEM_STATUS, pendingReview, pendingReviews, RUN_PHASE } from './workflow.js'
import { classifyDiffRisk } from './review-policy.js'
import {
  renderReportMarkdown,
  renderReviewerBrief,
  renderWorkerBrief,
  reReviewRequestMessage,
  reviewRequestMessage,
  roleGuidance,
  stallNudgeMessage,
} from './protocol.js'
import { computeUsage } from './telemetry.js'
import { autoCleanupRunWorktrees, getWorktreeDiffSummary } from './worktree-manager.js'

/**
 * Build an orchestrator instance bound to the plugin context and store.
 * @param options - `{ ctx, store, settings, tokenUsage }`
 * @returns orchestrator interface.
 */
export function createOrchestrator({ ctx, store, settings, tokenUsage = () => null, thinkingRouter = null, now = () => Date.now() }) {
  if (!settings?.autoOrchestrate) {
    return {
      reconcile: async () => ({ actionsTaken: [], converged: false }),
      scheduleReconcile: () => {},
      markNotified: () => {},
      whenIdle: async () => {},
      startWatchdog: () => {},
      stopWatchdog: () => {},
      isWatchdogRunning: () => false,
    }
  }

  // Cooldown map: key = `${teamId}:${action}:${target}:${itemId}` -> timestamp
  const cooldowns = new Map()
  const COOLDOWN_MS = 30_000
  // Last state revision an action was sent for, so a slow member that still
  // reports `inactive` is not woken again and again while its turn is queued.
  const sentForRev = new Map()
  const lastRevByTeam = new Map()
  // Per-(team, action, target, item) stall tracking for graduated nudging & Lead escalation
  const stallTracker = new Map()
  // Single-flight concurrency guards per team
  const inFlight = new Set()
  const inFlightPromises = new Map()
  const pendingRerun = new Map()
  const activeRuns = new Set()
  // Event-driven debounce timers and adaptive watchdog backoff state
  const debounceTimers = new Map()
  const idleStreaks = new Map()

  function itemProgressFingerprint(item) {
    if (!item) return ''
    const submittedCount = Array.isArray(item.reviews)
      ? item.reviews.filter((r) => r.status === 'submitted').length
      : 0
    return `${item.status ?? ''}:${item.report?.seq ?? 0}:${item.reviews?.length ?? 0}:${submittedCount}:${item.owner ?? ''}`
  }

  function isThrottled(teamId, action, target, itemId = '') {
    const key = `${teamId}:${action}:${target}:${itemId}`
    const currentNow = now()
    const last = cooldowns.get(key) ?? 0
    return currentNow - last < COOLDOWN_MS
  }

  /** @returns whether this exact notice was already sent for the same revision. */
  function alreadySentForRev(teamId, action, target, itemId, rev) {
    const key = `${teamId}:${action}:${target}:${itemId}`
    const previous = sentForRev.get(key)
    return previous !== undefined && previous === rev
  }

  /** Remember that one notice went out for this revision/member/action. */
  function markSentForRev(teamId, action, target, itemId, rev) {
    sentForRev.set(`${teamId}:${action}:${target}:${itemId}`, rev)
    // A bounded map is enough: one entry per (team, action, target, item) and
    // teams/items are bounded by the run size.
    if (sentForRev.size > 5000) {
      const first = sentForRev.keys().next().value
      if (first !== undefined) sentForRev.delete(first)
    }
    lastRevByTeam.set(teamId, rev)
  }

  /**
   * Unified deduplication registration called both by the orchestrator after
   * sending notices and by tools after direct peer sends.
   */
  function markNotified(teamId, action, target, itemId = '', rev = null, progress = null) {
    if (!teamId || !action || !target) return
    const key = `${teamId}:${action}:${target}:${itemId}`
    const currentNow = now()
    cooldowns.set(key, currentNow)
    if (cooldowns.size > 5000) {
      const first = cooldowns.keys().next().value
      if (first !== undefined) cooldowns.delete(first)
    }
    if (Number.isInteger(rev)) {
      markSentForRev(teamId, action, target, itemId, rev)
    }
    if ((action === 'wake-worker' || action === 'wake-reviewer') && itemId) {
      const existing = stallTracker.get(key)
      const progressChanged = progress !== null && existing && existing.progress !== null && existing.progress !== progress
      const revChanged = progress === null && Number.isInteger(rev) && existing && existing.rev !== rev
      if (!existing || progressChanged || revChanged) {
        stallTracker.set(key, {
          teamId,
          action,
          target,
          itemId,
          rev: Number.isInteger(rev) ? rev : (existing?.rev ?? null),
          progress,
          firstWokenAt: currentNow,
          lastSentAt: currentNow,
          nudgesSent: 0,
          sawRunning: false,
          escalated: false,
        })
        if (stallTracker.size > 5000) {
          const first = stallTracker.keys().next().value
          if (first !== undefined) stallTracker.delete(first)
        }
      } else if (progress !== null && existing.progress === null) {
        existing.progress = progress
      }
    }
  }

  /**
   * Read the Host token-meter projection for every member. Used by the
   * autonomous finalize path and the live budget breaker; a missing projection
   * yields null and never blocks the run.
   */
  function readUsage(members, state = null) {
    const read = typeof tokenUsage === 'function' ? tokenUsage() : null
    if (typeof read !== 'function') return null
    return computeUsage({ members, read, state })
  }

  async function sendNotice(root, target, message) {
    try {
      await ctx.agentTeams.sendMessage(root, {
        target,
        content: [{ type: 'text', text: message }],
        signal: AbortSignal.timeout(10_000),
      })
      return true
    } catch (err) {
      ctx.logger?.warn?.(`[orchestrator] failed to send notice to "${target}": ${err?.message ?? err}`)
      return false
    }
  }

  async function runReconcilePass(root, teamKey, options = {}) {
    let state
    try {
      state = await store.readState(root)
    } catch {
      return { actionsTaken: [], converged: false }
    }
    if (!state || !Array.isArray(state.items) || state.items.length === 0) {
      return { actionsTaken: [], converged: false }
    }

    if (state.phase === RUN_PHASE.FINALIZED || state.phase === RUN_PHASE.ABORTED) {
      return { actionsTaken: [], converged: false, skipped: 'inactive-run' }
    }

    const teamId = state.teamId ?? teamKey ?? root.id
    const actionsTaken = []
    let members = []
    try {
      members = ctx.agentTeams.listMembers(root).map((member) => ({
        ...member,
        agent: (() => {
          try {
            return ctx.agents?.get?.(member.id)
          } catch {
            return undefined
          }
        })(),
      }))
    } catch {
      members = []
    }
    const memberMap = new Map(members.map((m) => [m.name, m]))
    let stateRev = Number.isInteger(state.rev) ? state.rev : 0
    lastRevByTeam.set(teamId, stateRev)

    // Refresh stall tracking against current item progress and member activity
    const currentNow = now()
    const itemById = new Map(state.items.map((it) => [it.id, it]))
    for (const [key, entry] of stallTracker.entries()) {
      if (entry.teamId !== teamId) continue
      const trackedItem = itemById.get(entry.itemId)
      if (!trackedItem || trackedItem.status === ITEM_STATUS.APPROVED) {
        stallTracker.delete(key)
        continue
      }
      const currProg = itemProgressFingerprint(trackedItem)
      if (entry.progress !== null && entry.progress !== currProg) {
        stallTracker.delete(key)
        continue
      }
      if (entry.progress === null) entry.progress = currProg
      const trackedMember = memberMap.get(entry.target)
      if (trackedMember?.status === 'running') {
        entry.sawRunning = true
        entry.lastSentAt = currentNow
      }
    }

    async function recordStallEvent(event) {
      const prevRev = stateRev
      try {
        const updated = await store.mutateState(root, (s) => {
          appendEvent(s, event)
          return s
        })
        const nextRev = updated?.rev
        if (Number.isInteger(nextRev) && nextRev !== prevRev) {
          for (const [k, v] of sentForRev.entries()) {
            if (k.startsWith(`${teamId}:`) && v === prevRev) {
              sentForRev.set(k, nextRev)
            }
          }
          for (const entry of stallTracker.values()) {
            if (entry.teamId === teamId && entry.rev === prevRev) {
              entry.rev = nextRev
            }
          }
          stateRev = nextRev
          lastRevByTeam.set(teamId, nextRev)
        }
      } catch {
        /* best effort audit event */
      }
    }

    async function maybeHandleStall({ action, targetName, item, role, expectedTool, requiredFields }) {
      const maxNudges = state.settings?.maxStallNudges ?? settings.maxStallNudges ?? 2
      if (maxNudges <= 0) return false
      const delaySeconds = state.settings?.stallNudgeDelaySeconds ?? settings.stallNudgeDelaySeconds ?? 45
      const delayMs = delaySeconds * 1000
      const key = `${teamId}:${action}:${targetName}:${item.id}`
      const entry = stallTracker.get(key)
      if (!entry || entry.escalated) return false
      const checkNow = now()
      if (checkNow - entry.lastSentAt < delayMs) return false

      if (entry.nudgesSent < maxNudges) {
        const attempt = entry.nudgesSent + 1
        const msg = stallNudgeMessage({
          item,
          role,
          expectedTool,
          requiredFields,
          attempt,
          maxAttempts: maxNudges,
        })
        const ok = await sendNotice(root, targetName, msg)
        if (!ok) return false
        entry.nudgesSent = attempt
        entry.lastSentAt = checkNow
        entry.sawRunning = false
        cooldowns.set(key, checkNow)
        await recordStallEvent({
          at: new Date(checkNow).toISOString(),
          type: 'member/stall-nudge',
          actor: 'orchestrator',
          detail: `${targetName} on ${item.id} (${role}, nudge ${attempt}/${maxNudges})`,
        })
        actionsTaken.push({ type: 'stall-nudge', target: targetName, itemId: item.id, attempt, maxAttempts: maxNudges })
        return true
      }

      const leadMember = members.find((m) => m.role === 'lead') ?? { name: 'lead' }
      const stalledSeconds = Math.max(0, Math.round((checkNow - entry.firstWokenAt) / 1000))
      const msg = `[LEAD_ARBITRATION_REQUIRED] Member "${targetName}" appears stalled on ${item.id} "${item.subject}" (${role}) after ${entry.nudgesSent} automatic nudge(s) (${stalledSeconds}s without workflow progress).\nAction: inspect with team_flow_status { item_id: "${item.id}" } and intervene via team_flow_repair { action: "reopen" | "reassign", item_id: "${item.id}", reason: "member stalled without tool progress" }.`
      const ok = await sendNotice(root, leadMember.name, msg)
      if (!ok) return false
      entry.escalated = true
      entry.lastSentAt = checkNow
      await recordStallEvent({
        at: new Date(checkNow).toISOString(),
        type: 'member/stall-escalated',
        actor: 'orchestrator',
        detail: `${targetName} on ${item.id} (${role}, after ${entry.nudgesSent} nudges)`,
      })
      actionsTaken.push({
        type: 'stall-escalated',
        target: leadMember.name,
        stalledMember: targetName,
        itemId: item.id,
        nudges: entry.nudgesSent,
      })
      return true
    }

    // Live budget breaker: sampling the projection is cheap and lets the team
    // stop spending before the gate, instead of only failing at finalize.
    const sampledUsage = readUsage(members, state)
    if (sampledUsage !== null && (settings.tokenBudgetPerMember > 0 || settings.tokenBudgetPerRun > 0)) {
      const total = (totals) => ['uncachedInputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens'].reduce((sum, key) => sum + (Number.isFinite(totals?.[key]) ? totals[key] : 0), 0)
      const violations = []
      if (settings.tokenBudgetPerRun > 0 && total(sampledUsage.totals) > settings.tokenBudgetPerRun) {
        violations.push(`run used ${total(sampledUsage.totals)} tokens (budget ${settings.tokenBudgetPerRun})`)
      }
      if (settings.tokenBudgetPerMember > 0) {
        for (const [name, totals] of Object.entries(sampledUsage.members)) {
          if (total(totals) > settings.tokenBudgetPerMember) violations.push(`member "${name}" used ${total(totals)} tokens (budget ${settings.tokenBudgetPerMember})`)
        }
      }
      if (violations.length > 0) {
        const leadMember = members.find((m) => m.role === 'lead') ?? { name: 'lead' }
        if (!alreadySentForRev(teamId, 'budget-alert', leadMember.name, '', stateRev)) {
          const ok = await sendNotice(root, leadMember.name, `[BUDGET] ${violations.join('; ')}. Automatic wakes are paused at this revision; inspect team_flow_status {view:"full"} and either raise the budget or stop the run.`)
          if (ok) markNotified(teamId, 'budget-alert', leadMember.name, '', stateRev)
        }
        return { actionsTaken: [{ type: 'budget-paused' }], converged: false, budgetExceeded: true }
      }
    }

    const lazyEnabled = Boolean(settings.lazyStaffing ?? state.settings?.lazyStaffing)
    const TEAM_MEMBER_LIMIT = 8

    async function autoClaimTask(item) {
      if (!item.taskId) return
      try {
        const task = ctx.agentTeams.getTask(root, item.taskId)
        if (task && task.status === 'pending') {
          await ctx.agentTeams.updateTask(root, {
            taskId: item.taskId,
            expectedRevision: task.revision,
            action: 'claim',
          })
        }
      } catch {
        /* auto-claim is best effort */
      }
    }

    async function tryLazySpawn({ name, kind, item, description, promptText, context = 'fresh', role = '' }) {
      if (!lazyEnabled || typeof ctx.agentTeams?.spawnTeammate !== 'function') return false
      if (members.length >= TEAM_MEMBER_LIMIT || memberMap.has(name)) return false
      if (!options.force && (isThrottled(teamId, kind, name, item.id) || alreadySentForRev(teamId, kind, name, item.id, stateRev))) {
        return false
      }
      const configuredProvider = typeof role === 'string' && role.length > 0 ? settings.roles?.[role]?.provider : undefined
      const resolvedContext = context === 'fork' ? 'fork' : 'fresh'
      const provider = typeof configuredProvider === 'string' && configuredProvider.length > 0
        ? configuredProvider
        : resolvedContext === 'fork'
          ? (settings.forkProvider ?? 'fork')
          : (settings.freshProvider ?? 'spawn')
      try {
        await ctx.agentTeams.spawnTeammate(root, {
          name,
          description: String(description ?? `${kind} for ${item.id}`).slice(0, 200),
          prompt: [{ type: 'text', text: String(promptText ?? '') }],
          context: resolvedContext,
          provider,
          signal: AbortSignal.timeout(15_000),
        })
        const spawnedMember = { name, role: 'teammate', status: 'provisioning' }
        members.push(spawnedMember)
        memberMap.set(name, spawnedMember)
        markNotified(teamId, kind, name, item.id, stateRev, itemProgressFingerprint(item))
        const wakeAction = kind === 'lazy-spawn-reviewer' ? 'wake-reviewer' : 'wake-worker'
        markNotified(teamId, wakeAction, name, item.id, stateRev, itemProgressFingerprint(item))
        actionsTaken.push({ type: kind, target: name, itemId: item.id })
        return true
      } catch (err) {
        ctx.logger?.warn?.(`[orchestrator] failed to lazy-spawn "${name}" for ${item.id}: ${err?.message ?? err}`)
        return false
      }
    }

    async function computeDiffForItem(item, sinceSha = null) {
      const cwd = store.workingDir(root)
      const rawDiff = await getWorktreeDiffSummary({
        cwd,
        state,
        item,
        maxLines: settings.reviewDiffLines,
        sinceSha,
      }).catch(() => null)
      if (rawDiff === null) return null
      if (settings.reviewDiffBytes > 0 && rawDiff.length > settings.reviewDiffBytes) {
        return `${rawDiff.slice(0, settings.reviewDiffBytes)}\n… (diff truncated to ${settings.reviewDiffBytes} bytes)`
      }
      return rawDiff
    }

    // Per-member queue so multiple unblocked/review assignments coalesce into 1 digest
    const queuedDispatches = new Map()
    const enqueueDispatch = (targetName, entry) => {
      const list = queuedDispatches.get(targetName) ?? []
      list.push(entry)
      queuedDispatches.set(targetName, list)
    }

    // Set of approved item IDs
    const approvedIds = new Set(
      state.items.filter((it) => it.status === ITEM_STATUS.APPROVED).map((it) => it.id),
    )

    // 1. Check unblocked tasks and wake or lazy-spawn assigned workers
    if (settings.autoWakeUnblocked) {
      for (const item of state.items) {
        const blockers = Array.isArray(item.blockedBy) ? item.blockedBy : []
        const isUnblocked = blockers.every((bid) => approvedIds.has(bid))

        if ((item.status === ITEM_STATUS.PENDING || item.status === ITEM_STATUS.CHANGES_REQUESTED) && isUnblocked) {
          if (item.owner && typeof item.owner === 'string' && item.owner.length > 0) {
            const m = memberMap.get(item.owner)
            const scopes = Array.isArray(item.writeScopes) && item.writeScopes.length > 0
              ? item.writeScopes.join(', ')
              : '(entire workspace)'
            const wt = item.git?.worktreePath ? ` Worktree: ${item.git.worktreePath}.` : ''
            const isRework = item.status === ITEM_STATUS.CHANGES_REQUESTED

            const upstreamHandoffs = blockers
              .map((bid) => state.items.find((it) => it.id === bid))
              .filter((it) => it && it.handoffPacket)
              .map((it) => {
                const hp = it.handoffPacket
                const parts = [`Item ${it.id}`]
                const cid = hp.contract_id ?? hp.contractId
                if (cid) parts.push(`contract: ${cid}`)
                if (hp.entry) parts.push(`entry: ${hp.entry}`)
                if (Array.isArray(hp.exports) && hp.exports.length > 0) parts.push(`exports: ${hp.exports.join(', ')}`)
                if (hp.notes) parts.push(`notes: ${hp.notes}`)
                return parts.join(' | ')
              })

            if (!m && lazyEnabled) {
              if (options.force || (!isThrottled(teamId, 'lazy-spawn-worker', item.owner, item.id) && !alreadySentForRev(teamId, 'lazy-spawn-worker', item.owner, item.id, stateRev))) {
                await autoClaimTask(item)
                const reviewing = state.items.filter((other) => Array.isArray(other.reviewers) && other.reviewers.includes(item.owner)).map((other) => other.id)
                const role = state.roleAssignments?.[item.owner] ?? (settings.roles?.[item.role] === undefined ? '' : item.role)
                const brief = renderWorkerBrief(state, item, reviewing, state.settings?.workerContext ?? settings.workerContext)
                const handoffNote = upstreamHandoffs.length > 0 ? `\n\nUpstream handoffs:\n${upstreamHandoffs.map((h) => `  - ${h}`).join('\n')}` : ''
                await tryLazySpawn({
                  name: item.owner,
                  kind: 'lazy-spawn-worker',
                  item,
                  description: brief.description,
                  promptText: `${brief.prompt}${roleGuidance(settings, role)}${handoffNote}`,
                  context: brief.context,
                  role,
                })
              }
              continue
            }

            // If worker is currently inactive, enqueue wakeup!
            if (m && m.status === 'inactive') {
              if (options.force || (!isThrottled(teamId, 'wake-worker', item.owner, item.id) && !alreadySentForRev(teamId, 'wake-worker', item.owner, item.id, stateRev))) {
                await autoClaimTask(item)

                let msg
                let shortLine
                let detailSnippet
                if (isRework) {
                  const latestReview = Array.isArray(item.reviews) && item.reviews.length > 0 ? item.reviews.at(-1) : null
                  const findings = latestReview?.findings ?? []
                  const findingsDigest = findings.length > 0
                    ? findings.map((f, i) => `  ${i + 1}. [${f.id ?? `F${i + 1}`}] (${f.severity ?? 'issue'}): ${f.file ? `${f.file}:${f.line ?? ''} ` : ''}${f.claim ?? f.comment ?? ''}`).join('\n')
                    : '  (Reviewer requested changes; please inspect review record in status.)'
                  msg = `[AUTO_DISPATCH] Task ${item.id} "${item.subject}" requires rework based on reviewer findings (Round ${latestReview?.round ?? '?'}).${wt}\nReviewer findings:\n${findingsDigest}\n\nDo NOT call team_flow_status (findings are self-contained above). Address these findings inside your worktree, run real tests, and call team_flow_review_respond with one response per finding id (fixed | rebut | accepted_risk) and updated evidence.`
                  shortLine = `[REWORK] ${item.id} "${item.subject}" (Round ${latestReview?.round ?? '?'})${wt}`
                  detailSnippet = findingsDigest.slice(0, 600)
                } else {
                  const dod = Array.isArray(item.definitionOfDone) && item.definitionOfDone.length > 0
                    ? ` Definition of done:\n${item.definitionOfDone.map((d) => `  - ${d}`).join('\n')}`
                    : ''
                  const handoffInfo = upstreamHandoffs.length > 0
                    ? `\nUpstream handoffs:\n${upstreamHandoffs.map((h) => `  - ${h}`).join('\n')}`
                    : ''
                  msg = `[AUTO_DISPATCH] Task ${item.id} "${item.subject}" is ready and unblocked.${wt} The backing task has been automatically claimed for you. Declared write scopes: ${scopes}.${dod}${handoffInfo}\n\nDo NOT call team_flow_status or claim again. Start work directly inside your worktree, verify with real commands, and call team_flow_report when done.`
                  shortLine = `[TASK] ${item.id} "${item.subject}" (scope: ${scopes})${wt}`
                  detailSnippet = `${dod.trim()}${handoffInfo}`.slice(0, 600) || `Scope: ${scopes}`
                }

                enqueueDispatch(item.owner, {
                  kind: 'wake-worker',
                  itemId: item.id,
                  progress: itemProgressFingerprint(item),
                  message: msg,
                  shortLine,
                  detailSnippet,
                  actionRecord: { type: 'wake-worker', target: item.owner, itemId: item.id, isRework },
                })
              } else if (alreadySentForRev(teamId, 'wake-worker', item.owner, item.id, stateRev)) {
                await maybeHandleStall({
                  action: 'wake-worker',
                  targetName: item.owner,
                  item,
                  role: isRework ? 'worker (rework)' : 'worker',
                  expectedTool: isRework ? 'team_flow_review_respond' : 'team_flow_report',
                  requiredFields: isRework
                    ? ['item_id', 'responses']
                    : ['item_id', 'summary', 'files', 'commands', 'evidence'],
                })
              }
            }
          }
        }
      }
    }

    // 2. Check pending reviews and wake or lazy-spawn assigned reviewers
    if (settings.autoWakeReviewers) {
      for (const item of state.items) {
        if (
          item.status === ITEM_STATUS.IN_REVIEW ||
          (item.report &&
            item.status !== ITEM_STATUS.APPROVED &&
            item.status !== ITEM_STATUS.CHANGES_REQUESTED &&
            item.status !== ITEM_STATUS.ESCALATED)
        ) {
          const pendingList = pendingReviews(item)
          const reviewers = pendingList.length > 0
            ? [...new Set(pendingList.map((r) => r.reviewer).filter(Boolean))]
            : (Array.isArray(item.reviewers) ? item.reviewers : [])
          const submitted = Array.isArray(item.reviews) ? item.reviews.filter((r) => r.status === 'submitted') : []

          for (const rev of reviewers) {
            const revName = typeof rev === 'string' ? rev : rev?.name
            if (!revName) continue
            const m = memberMap.get(revName)
            const prevByMe = submitted.filter((r) => r.reviewer === revName).at(-1) ?? null

            if (!m && lazyEnabled) {
              if (options.force || (!isThrottled(teamId, 'lazy-spawn-reviewer', revName, item.id) && !alreadySentForRev(teamId, 'lazy-spawn-reviewer', revName, item.id, stateRev))) {
                const diff = await computeDiffForItem(item, prevByMe?.reviewedSha ?? null)
                const risk = item.resolvedReview ?? classifyDiffRisk({ files: item.report?.files ?? [], diff, item, settings })
                const reviewed = state.items.filter((other) => Array.isArray(other.reviewers) && other.reviewers.includes(revName))
                const role = state.roleAssignments?.[revName] ?? (settings.roles?.reviewer === undefined ? '' : 'reviewer')
                const brief = renderReviewerBrief(state, revName, reviewed)
                const reviewContext = prevByMe !== null
                  ? reReviewRequestMessage(state, item, prevByMe, diff)
                  : reviewRequestMessage(state, item, diff, risk)
                await tryLazySpawn({
                  name: revName,
                  kind: 'lazy-spawn-reviewer',
                  item,
                  description: brief.description,
                  promptText: `${brief.prompt}${roleGuidance(settings, role)}\n\n${reviewContext}`,
                  context: brief.context,
                  role,
                })
              }
              continue
            }

            if (m && m.status === 'inactive') {
              if (options.force || (!isThrottled(teamId, 'wake-reviewer', revName, item.id) && !alreadySentForRev(teamId, 'wake-reviewer', revName, item.id, stateRev))) {
                const diff = await computeDiffForItem(item, prevByMe?.reviewedSha ?? null)
                const risk = item.resolvedReview ?? classifyDiffRisk({ files: item.report?.files ?? [], diff, item, settings })
                const pendingForRev = pendingList.find((r) => r.reviewer === revName) ?? pendingReview(item)
                const wt = item.git?.worktreePath ? ` Worktree: ${item.git.worktreePath}.` : ''
                const msg = prevByMe !== null
                  ? reReviewRequestMessage(state, item, prevByMe, diff)
                  : reviewRequestMessage(state, item, diff, risk)
                enqueueDispatch(revName, {
                  kind: 'wake-reviewer',
                  itemId: item.id,
                  progress: itemProgressFingerprint(item),
                  message: msg,
                  shortLine: `[${prevByMe ? 'RE-REVIEW' : 'REVIEW'}] ${item.id} "${item.subject}" [${risk.depth}/${risk.profile}] (owner: ${item.owner})${wt}`,
                  detailSnippet: (prevByMe
                    ? `Re-review round ${pendingForRev?.round ?? (submitted.length + 1)} addressing round ${prevByMe.round}.`
                    : `Standard: ${risk.depth}/${risk.profile}. ${item.report?.summary ? `Summary: ${item.report.summary.slice(0, 220)}` : 'Awaiting review.'}${diff ? `\n${diff.slice(0, 300)}` : ''}`),
                  actionRecord: { type: 'wake-reviewer', target: revName, itemId: item.id },
                })
              } else if (alreadySentForRev(teamId, 'wake-reviewer', revName, item.id, stateRev)) {
                await maybeHandleStall({
                  action: 'wake-reviewer',
                  targetName: revName,
                  item,
                  role: 'reviewer',
                  expectedTool: 'team_flow_review_submit',
                  requiredFields: ['item_id', 'verdict', 'summary', 'evidence_checked'],
                })
              }
            }
          }
        }
      }
    }

    // Flush coalesced per-member dispatches (1 message per member)
    for (const [targetName, entries] of queuedDispatches.entries()) {
      if (entries.length === 1) {
        const entry = entries[0]
        const ok = await sendNotice(root, targetName, entry.message)
        if (ok) {
          markNotified(teamId, entry.kind, targetName, entry.itemId, stateRev, entry.progress ?? null)
          actionsTaken.push(entry.actionRecord)
        }
      } else if (entries.length > 1) {
        const header = `[AUTO_DISPATCH] Multiple assignments ready (${entries.length} items) in run ${state.runId}:`
        const body = entries.map((entry, idx) => `### ${idx + 1}. ${entry.shortLine}\n${entry.detailSnippet}`).join('\n\n')
        const footer = 'Do NOT call team_flow_status. Work on each item above directly and submit via team_flow_report / team_flow_review_respond / team_flow_review_submit.'
        const digestMsg = `${header}\n\n${body}\n\n${footer}`
        const ok = await sendNotice(root, targetName, digestMsg)
        if (ok) {
          for (const entry of entries) {
            markNotified(teamId, entry.kind, targetName, entry.itemId, stateRev, entry.progress ?? null)
            actionsTaken.push(entry.actionRecord)
          }
        }
      }
    }

    // 3. Check escalated items and wake Lead for arbitration
    for (const item of state.items) {
      if (item.status === ITEM_STATUS.ESCALATED) {
        const leadMember = members.find((m) => m.role === 'lead') ?? { name: 'lead' }
        if (options.force || (!isThrottled(teamId, 'arbitrate-escalation', leadMember.name, item.id) && !alreadySentForRev(teamId, 'arbitrate-escalation', leadMember.name, item.id, stateRev))) {
          const reviewCount = item.reviews?.length ?? 0
          const reason = item.escalation?.reason ?? 'Maximum rework rounds exceeded or unresolvable blocker'
          const msg = `[LEAD_ARBITRATION_REQUIRED] Task ${item.id} "${item.subject}" is ESCALATED (after ${reviewCount} review rounds).\nReason: ${reason}.\nPlease inspect the item with team_flow_status { item_id: "${item.id}" } and intervene via team_flow_repair or reassign.`
          const ok = await sendNotice(root, leadMember.name, msg)
          if (ok) {
            markNotified(teamId, 'arbitrate-escalation', leadMember.name, item.id, stateRev)
            actionsTaken.push({ type: 'wake-arbitration', target: leadMember.name, itemId: item.id })
          }
        }
      }
    }

    // 4. Check worktree auto-merge conflicts and notify Lead and Worker
    for (const item of state.items) {
      if (item.status === ITEM_STATUS.APPROVED && item.git?.worktreeMergeError) {
        if (options.force || !isThrottled(teamId, 'worktree-conflict', 'lead', item.id)) {
          const leadMember = members.find((m) => m.role === 'lead') ?? { name: 'lead' }
          const workerName = item.owner ?? 'worker'
          const msg = `[AUTO_DISPATCH] Task ${item.id} "${item.subject}" is APPROVED but encountered a merge conflict during auto-merge into branch "${state.git?.branch ?? ''}".\nError: ${item.git.worktreeMergeError}\nAction required: Worker or Lead can run team_flow_git { action: "worktree_sync", item_id: "${item.id}" } to pull updates and resolve conflicts.`
          const okLead = await sendNotice(root, leadMember.name, msg)
          if (workerName !== leadMember.name && memberMap.has(workerName)) {
            await sendNotice(root, workerName, msg)
          }
          if (okLead) markNotified(teamId, 'worktree-conflict', 'lead', item.id, stateRev)
          actionsTaken.push({ type: 'notify-worktree-conflict', itemId: item.id, error: item.git.worktreeMergeError })
        }
      }
    }

    // 5. Check team convergence
    const allApproved = state.items.length > 0 && state.items.every((it) => it.status === ITEM_STATUS.APPROVED)
    const allApprovedAndMerged = allApproved && state.items.every((it) => !it.git?.worktreeMergeError)
    const converged = allApproved || state.phase === RUN_PHASE.CONVERGED

    if (converged && state.phase !== RUN_PHASE.FINALIZED) {
      // Auto-finalize if configured and all items are approved and merged cleanly
      if (settings.autoFinalize && allApprovedAndMerged) {
        let nativeTasks = []
        try {
          nativeTasks = ctx.agentTeams.listTasks(root).map((task) => ({ id: task.id, status: task.status, revision: task.revision }))
        } catch {
          nativeTasks = []
        }
        const now = new Date().toISOString()
        const usage = readUsage(members, state)
        const routingSnapshot = thinkingRouter?.snapshot?.(teamId) ?? null
        if (usage !== null && routingSnapshot !== null) usage.routing = routingSnapshot
        const gate = evaluateGates(state, { settings: state.settings, members, nativeTasks, overrides: [], now })
        // The autonomous path must capture usage exactly like team_flow_gate
        // does, otherwise live budgets and the board's usage panel are blind.
        if (usage !== null) gate.usage = usage
        if (usage !== null) {
          const tokenTotal = (totals) => ['uncachedInputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens'].reduce((sum, key) => sum + (Number.isFinite(totals?.[key]) ? totals[key] : 0), 0)
          const budget = { perMember: state.settings.tokenBudgetPerMember, perRun: state.settings.tokenBudgetPerRun }
          if (budget.perMember > 0) {
            for (const [name, totals] of Object.entries(usage.members)) {
              const used = tokenTotal(totals)
              if (used > budget.perMember) gate.teamFailures.push(`member "${name}" used ${used} tokens (budget ${budget.perMember})`)
            }
          }
          if (budget.perRun > 0 && tokenTotal(usage.totals) > budget.perRun) {
            gate.teamFailures.push(`run used ${tokenTotal(usage.totals)} tokens (budget ${budget.perRun})`)
          }
          if (gate.teamFailures.length > 0) gate.pass = false
        }
        if (gate.pass) {
          let reportPath = null
          await store.mutateState(root, async (current) => {
            current.gate = gate
            if (usage !== null) current.usage = usage
            current.updatedAt = now
            current.phase = RUN_PHASE.FINALIZED
            current.finalizedAt = now
            const markdown = renderReportMarkdown(current, gate)
            reportPath = await store.writeArtifact(root, `teams/${store.teamIdOf(root)}/report.md`, markdown)
            current.artifacts = { ...(current.artifacts ?? {}), reportPath }
            appendEvent(current, {
              at: now,
              type: 'run/finalized',
              actor: 'orchestrator',
              detail: reportPath === null ? 'finalized' : `report at ${reportPath}`,
            })
            return current
          })

          // Close shared tasks
          for (const item of state.items) {
            if (item.taskId === null) continue
            try {
              const task = ctx.agentTeams.getTask(root, item.taskId)
              if (task.status === 'pending') {
                const claimed = await ctx.agentTeams.updateTask(root, { taskId: item.taskId, expectedRevision: task.revision, action: 'claim' })
                await ctx.agentTeams.updateTask(root, { taskId: item.taskId, expectedRevision: claimed.revision, action: 'complete' })
              } else if (task.status === 'in_progress') {
                await ctx.agentTeams.updateTask(root, { taskId: item.taskId, expectedRevision: task.revision, action: 'complete' })
              }
            } catch {
              /* best effort */
            }
          }

          // Clean up worktrees
          const cwd = store.workingDir(root)
          await autoCleanupRunWorktrees({ cwd, state, agent: root, store }).catch(() => {})

          actionsTaken.push({ type: 'auto-finalize', runId: state.runId, reportPath })

          const leadMember = members.find((m) => m.role === 'lead') ?? { name: 'lead' }
          const reportNotice = reportPath ? ` Final report written to ${reportPath}.` : ''
          const msg = `[TEAM_FINALIZED] All ${state.items.length} work items in run "${state.runId}" are approved and all quality gates have passed! The run has been automatically finalized.${reportNotice}`
          await sendNotice(root, leadMember.name, msg)

          return { actionsTaken, converged: true, finalized: true }
        }
      }

      if (settings.autoNotifyConverged && !state.convergedNotified) {
        const leadMember = members.find((m) => m.role === 'lead') ?? { name: 'lead' }
        if (options.force || (!isThrottled(teamId, 'converge-notice', leadMember.name, '') && !alreadySentForRev(teamId, 'converge-notice', leadMember.name, '', stateRev))) {
          const msg = `[TEAM_CONVERGED] All ${state.items.length} work items have been approved! The team has converged. Please run team_flow_gate {finalize: true} to verify final quality gates and produce the final delivery report.`
          const ok = await sendNotice(root, leadMember.name, msg)
          if (ok) {
            markNotified(teamId, 'converge-notice', leadMember.name, '', stateRev)
            actionsTaken.push({ type: 'notify-converged', target: leadMember.name })
            try {
              await store.mutateState(root, (s) => {
                s.convergedNotified = true
                return s
              })
            } catch {}
          }
        }
      }
    }

    return { actionsTaken, converged }
  }

  /**
   * Run a single-flight reconciliation pass on the Team belonging to `agent`.
   * @param agent - any active member or Lead in the Team.
   * @param options - execution options `{ watchdog?: boolean, force?: boolean }`.
   * @returns `{ actionsTaken: Array<{ type, target, itemId? }>, converged: boolean }`.
   */
  async function reconcile(agent, options = {}) {
    const run = (async () => {
      if (!ctx.agentTeams) return { actionsTaken: [], converged: false }
      const membership = ctx.agentTeams.tryMembership?.(agent)
      const root = membership?.root ?? agent
      if (!root) return { actionsTaken: [], converged: false }
      const flightKey = store.teamIdOf?.(root) ?? root.id ?? 'default'

      if (inFlight.has(flightKey)) {
        if (options.force) {
          const active = inFlightPromises.get(flightKey)
          if (active) {
            const prior = await active.catch(() => null)
            if (prior?.finalized === true) return prior
          }
          if (inFlight.has(flightKey)) {
            return { actionsTaken: [], converged: false, coalesced: true }
          }
        } else {
          const prev = pendingRerun.get(flightKey)
          pendingRerun.set(flightKey, {
            agent: root,
            options: { ...options, force: Boolean(prev?.options?.force || options.force) },
          })
          return { actionsTaken: [], converged: false, coalesced: true }
        }
      }

      inFlight.add(flightKey)
      const passPromise = runReconcilePass(root, flightKey, options)
      inFlightPromises.set(flightKey, passPromise)
      let result
      try {
        result = await passPromise
      } finally {
        inFlight.delete(flightKey)
        inFlightPromises.delete(flightKey)
      }

      if (pendingRerun.has(flightKey) && result?.finalized !== true) {
        const next = pendingRerun.get(flightKey)
        pendingRerun.delete(flightKey)
        await reconcile(next.agent, next.options).catch(() => {})
      }
      return result
    })()
    activeRuns.add(run)
    try {
      return await run
    } finally {
      activeRuns.delete(run)
    }
  }

  async function whenIdle() {
    while (activeRuns.size > 0) {
      await Promise.allSettled([...activeRuns])
    }
  }

  /**
   * Debounced event-driven orchestration trigger (e.g. on agent/status idle).
   */
  function scheduleReconcile(agent, delayMs = 200) {
    if (!ctx.agentTeams) return
    const membership = ctx.agentTeams.tryMembership?.(agent)
    const root = membership?.root ?? agent
    if (!root) return
    const teamKey = store.teamIdOf?.(root) ?? root.id ?? 'default'
    idleStreaks.set(teamKey, 0)
    const existing = debounceTimers.get(teamKey)
    if (existing !== undefined) clearTimeout(existing)
    const wait = Number.isFinite(delayMs) && delayMs >= 0 ? Math.trunc(delayMs) : 200
    const handle = setTimeout(() => {
      debounceTimers.delete(teamKey)
      void reconcile(root).catch(() => {})
    }, wait)
    handle.unref?.()
    debounceTimers.set(teamKey, handle)
  }

  let timer = null
  let watchdogRunning = false

  function computeNextWatchdogDelayMs() {
    const baseSec = settings.watchdogIntervalSeconds
    const maxSec = Math.max(baseSec, settings.watchdogMaxIntervalSeconds ?? 180)
    if (idleStreaks.size === 0) return baseSec * 1000
    const minStreak = Math.min(...idleStreaks.values())
    const factor = Math.min(8, 2 ** Math.min(minStreak, 3))
    return Math.min(maxSec, baseSec * factor) * 1000
  }

  function scheduleNextWatchdogTick() {
    if (!watchdogRunning) return
    const delayMs = computeNextWatchdogDelayMs()
    timer = setTimeout(async () => {
      timer = null
      if (!watchdogRunning) return
      try {
        if (ctx.agents) {
          for (const agent of ctx.agents.list()) {
            const membership = ctx.agentTeams?.tryMembership?.(agent)
            if (membership?.role !== 'lead') continue
            const teamKey = store.teamIdOf?.(agent) ?? agent.id
            const cached = store.cachedState?.(agent)
            if (cached && (cached.phase === RUN_PHASE.FINALIZED || cached.phase === RUN_PHASE.ABORTED)) {
              continue
            }
            const prevRev = lastRevByTeam.get(teamKey)
            const res = await reconcile(agent, { watchdog: true })
            const currRev = lastRevByTeam.get(teamKey)
            if ((res?.actionsTaken?.length ?? 0) > 0 || (currRev !== undefined && currRev !== prevRev)) {
              idleStreaks.set(teamKey, 0)
            } else {
              idleStreaks.set(teamKey, (idleStreaks.get(teamKey) ?? 0) + 1)
            }
          }
        }
      } catch (err) {
        ctx.logger?.debug?.(`[orchestrator.watchdog] error: ${err?.message ?? err}`)
      } finally {
        if (watchdogRunning) scheduleNextWatchdogTick()
      }
    }, delayMs)
    timer.unref?.()
  }

  function startWatchdog() {
    if (watchdogRunning) return
    const intervalSec = settings.watchdogIntervalSeconds
    if (typeof intervalSec !== 'number' || intervalSec <= 0) return
    watchdogRunning = true
    scheduleNextWatchdogTick()
  }

  function stopWatchdog() {
    watchdogRunning = false
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
    for (const handle of debounceTimers.values()) clearTimeout(handle)
    debounceTimers.clear()
  }

  return {
    reconcile,
    scheduleReconcile,
    markNotified,
    whenIdle,
    startWatchdog,
    stopWatchdog,
    isWatchdogRunning: () => watchdogRunning,
  }
}
