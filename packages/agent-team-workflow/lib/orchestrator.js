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

import { ITEM_STATUS, RUN_PHASE } from './workflow.js'

/**
 * Build an orchestrator instance bound to the plugin context and store.
 * @param options - `{ ctx, store, settings }`
 * @returns orchestrator interface.
 */
export function createOrchestrator({ ctx, store, settings }) {
  if (!settings?.autoOrchestrate) {
    return {
      reconcile: async () => ({ actionsTaken: [], converged: false }),
      startWatchdog: () => {},
      stopWatchdog: () => {},
      isWatchdogRunning: () => false,
    }
  }

  // Cooldown map: key = `${teamId}:${action}:${target}:${itemId}` -> timestamp
  const cooldowns = new Map()
  const COOLDOWN_MS = 30_000

  function shouldThrottle(teamId, action, target, itemId = '') {
    const key = `${teamId}:${action}:${target}:${itemId}`
    const now = Date.now()
    const last = cooldowns.get(key) ?? 0
    if (now - last < COOLDOWN_MS) return true
    cooldowns.set(key, now)
    return false
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

  /**
   * Run a reconciliation pass on the Team belonging to `agent`.
   * @param agent - any active member or Lead in the Team.
   * @param options - execution options `{ watchdog?: boolean, force?: boolean }`.
   * @returns `{ actionsTaken: Array<{ type, target, itemId? }>, converged: boolean }`.
   */
  async function reconcile(agent, options = {}) {
    if (!ctx.agentTeams) return { actionsTaken: [], converged: false }
    const membership = ctx.agentTeams.tryMembership?.(agent)
    const root = membership?.root ?? agent
    if (!root) return { actionsTaken: [], converged: false }

    let state
    try {
      state = await store.readState(root)
    } catch {
      return { actionsTaken: [], converged: false }
    }
    if (!state || !Array.isArray(state.items) || state.items.length === 0) {
      return { actionsTaken: [], converged: false }
    }

    if (state.phase === RUN_PHASE.FINALIZED) {
      return { actionsTaken: [], converged: false }
    }

    const teamId = state.teamId ?? root.id
    const actionsTaken = []
    let members = []
    try {
      members = ctx.agentTeams.listMembers(root)
    } catch {
      members = []
    }
    const memberMap = new Map(members.map((m) => [m.name, m]))

    // Set of approved item IDs
    const approvedIds = new Set(
      state.items.filter((it) => it.status === ITEM_STATUS.APPROVED).map((it) => it.id),
    )

    // 1. Check unblocked tasks and wake assigned workers
    if (settings.autoWakeUnblocked) {
      for (const item of state.items) {
        const blockers = Array.isArray(item.blockedBy) ? item.blockedBy : []
        const isUnblocked = blockers.every((bid) => approvedIds.has(bid))

        if ((item.status === ITEM_STATUS.PENDING || item.status === ITEM_STATUS.CHANGES_REQUESTED) && isUnblocked) {
          if (item.owner && typeof item.owner === 'string' && item.owner.length > 0) {
            const m = memberMap.get(item.owner)
            // If worker is currently inactive, wake it up!
            if (m && m.status === 'inactive') {
              if (options.force || !shouldThrottle(teamId, 'wake-worker', item.owner, item.id)) {
                const scopes = Array.isArray(item.writeScopes) && item.writeScopes.length > 0
                  ? item.writeScopes.join(', ')
                  : '(entire workspace)'
                const msg = `[AUTO_DISPATCH] Task ${item.id} "${item.subject}" is ready and unblocked. Declared write scopes: ${scopes}. Please claim the task, begin work, and call team_flow_report when done.`
                const ok = await sendNotice(root, item.owner, msg)
                if (ok) {
                  actionsTaken.push({ type: 'wake-worker', target: item.owner, itemId: item.id })
                }
              }
            }
          }
        }
      }
    }

    // 2. Check pending reviews and wake assigned reviewers
    if (settings.autoWakeReviewers) {
      for (const item of state.items) {
        if (
          item.status === ITEM_STATUS.IN_REVIEW ||
          (item.report &&
            item.status !== ITEM_STATUS.APPROVED &&
            item.status !== ITEM_STATUS.CHANGES_REQUESTED &&
            item.status !== ITEM_STATUS.ESCALATED)
        ) {
          const reviewers = Array.isArray(item.reviewers) ? item.reviewers : []
          for (const rev of reviewers) {
            const revName = typeof rev === 'string' ? rev : rev?.name
            if (revName && memberMap.has(revName)) {
              const m = memberMap.get(revName)
              if (m && m.status === 'inactive') {
                if (options.force || !shouldThrottle(teamId, 'wake-reviewer', revName, item.id)) {
                  const msg = `[AUTO_DISPATCH] Item ${item.id} "${item.subject}" is awaiting your review. Please inspect evidence and call team_flow_review_submit.`
                  const ok = await sendNotice(root, revName, msg)
                  if (ok) {
                    actionsTaken.push({ type: 'wake-reviewer', target: revName, itemId: item.id })
                  }
                }
              }
            }
          }
        }
      }
    }

    // 3. Check team convergence
    const allApproved = state.items.length > 0 && state.items.every((it) => it.status === ITEM_STATUS.APPROVED)
    const converged = allApproved || state.phase === RUN_PHASE.CONVERGED
    if (converged && state.phase !== RUN_PHASE.FINALIZED) {
      if (settings.autoNotifyConverged && !state.convergedNotified) {
        if (options.force || !shouldThrottle(teamId, 'converge-notice', 'lead')) {
          const nonLeadAgent = agent.id !== root.id ? agent : (ctx.agents?.list?.().find((a) => a.id !== root.id) ?? root)
          const leadMember = members.find((m) => m.role === 'lead') ?? { name: 'lead' }
          const msg = `[TEAM_CONVERGED] All ${state.items.length} work items have been approved! The team has converged. Please run team_flow_gate {finalize: true} to verify final quality gates and produce the final delivery report.`
          const ok = await sendNotice(nonLeadAgent, leadMember.name, msg)
          if (ok) {
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

  let timer = null
  function startWatchdog() {
    if (timer !== null) return
    const intervalSec = settings.watchdogIntervalSeconds
    if (typeof intervalSec !== 'number' || intervalSec <= 0) return
    timer = setInterval(async () => {
      try {
        if (!ctx.agents) return
        for (const agent of ctx.agents.list()) {
          const membership = ctx.agentTeams?.tryMembership?.(agent)
          if (membership?.role === 'lead') {
            await reconcile(agent, { watchdog: true })
          }
        }
      } catch (err) {
        ctx.logger?.debug?.(`[orchestrator.watchdog] error: ${err?.message ?? err}`)
      }
    }, intervalSec * 1000)
    timer.unref?.()
  }

  function stopWatchdog() {
    if (timer !== null) {
      clearInterval(timer)
      timer = null
    }
  }

  return {
    reconcile,
    startWatchdog,
    stopWatchdog,
    isWatchdogRunning: () => timer !== null,
  }
}
