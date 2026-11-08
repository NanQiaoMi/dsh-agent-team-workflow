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

import { appendEvent, evaluateGates, ITEM_STATUS, RUN_PHASE } from './workflow.js'
import { renderReportMarkdown } from './protocol.js'
import { autoCleanupRunWorktrees, getWorktreeDiffSummary } from './worktree-manager.js'

/**
 * Build an orchestrator instance bound to the plugin context and store.
 * @param options - `{ ctx, store, settings }`
 * @returns orchestrator interface.
 */
export function createOrchestrator({ ctx, store, settings, tokenUsage = () => null }) {
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
  // Last state revision an action was sent for, so a slow member that still
  // reports `inactive` is not woken again and again while its turn is queued.
  const sentForRev = new Map()
  const lastRevByTeam = new Map()

  function shouldThrottle(teamId, action, target, itemId = '') {
    const key = `${teamId}:${action}:${target}:${itemId}`
    const now = Date.now()
    const last = cooldowns.get(key) ?? 0
    if (now - last < COOLDOWN_MS) return true
    cooldowns.set(key, now)
    return false
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
   * Read the Host token-meter projection for every member. Used by the
   * autonomous finalize path and the live budget breaker; a missing projection
   * yields null and never blocks the run.
   */
  function readUsage(members) {
    const read = typeof tokenUsage === 'function' ? tokenUsage() : null
    if (typeof read !== 'function') return null
    const usage = { capturedAt: new Date().toISOString(), members: {}, totals: { uncachedInputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 } }
    for (const member of members) {
      if (member.agent === undefined || member.agent === null) continue
      let raw = null
      try {
        raw = read(member.agent)
      } catch {
        raw = null
      }
      if (raw === null || raw === undefined) continue
      const totals = raw.totals !== undefined && raw.totals !== null && typeof raw.totals === 'object' ? raw.totals : raw
      usage.members[member.name] = {
        uncachedInputTokens: Number.isFinite(totals.uncachedInputTokens) ? totals.uncachedInputTokens : 0,
        outputTokens: Number.isFinite(totals.outputTokens) ? totals.outputTokens : 0,
        cacheReadTokens: Number.isFinite(totals.cacheReadTokens) ? totals.cacheReadTokens : 0,
        cacheWriteTokens: Number.isFinite(totals.cacheWriteTokens) ? totals.cacheWriteTokens : 0,
      }
      for (const key of Object.keys(usage.totals)) usage.totals[key] += Number.isFinite(totals[key]) ? totals[key] : 0
    }
    return usage
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

    if (state.phase === RUN_PHASE.FINALIZED || state.phase === RUN_PHASE.ABORTED) {
      return { actionsTaken: [], converged: false, skipped: 'inactive-run' }
    }

    const teamId = state.teamId ?? root.id
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
    const stateRev = Number.isInteger(state.rev) ? state.rev : 0
    lastRevByTeam.set(teamId, stateRev)

    // Live budget breaker: sampling the projection is cheap and lets the team
    // stop spending before the gate, instead of only failing at finalize.
    const sampledUsage = readUsage(members)
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
        if (!alreadySentForRev(teamId, 'budget-alert', 'lead', '', stateRev)) {
          const leadMember = members.find((m) => m.role === 'lead') ?? { name: 'lead' }
          await sendNotice(root, leadMember.name, `[BUDGET] ${violations.join('; ')}. Automatic wakes are paused at this revision; inspect team_flow_status {view:"full"} and either raise the budget or stop the run.`)
          markSentForRev(teamId, 'budget-alert', leadMember.name, '', stateRev)
        }
        return { actionsTaken: [{ type: 'budget-paused' }], converged: false, budgetExceeded: true }
      }
    }

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
              if (options.force || (!shouldThrottle(teamId, 'wake-worker', item.owner, item.id) && !alreadySentForRev(teamId, 'wake-worker', item.owner, item.id, stateRev))) {
                // Auto-claim backing shared task if pending
                if (item.taskId) {
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

                const scopes = Array.isArray(item.writeScopes) && item.writeScopes.length > 0
                  ? item.writeScopes.join(', ')
                  : '(entire workspace)'
                const wt = item.git?.worktreePath ? ` Worktree: ${item.git.worktreePath}.` : ''

                const isRework = item.status === ITEM_STATUS.CHANGES_REQUESTED
                let msg
                if (isRework) {
                  const latestReview = Array.isArray(item.reviews) && item.reviews.length > 0 ? item.reviews.at(-1) : null
                  const findings = latestReview?.findings ?? []
                  const findingsDigest = findings.length > 0
                    ? findings.map((f, i) => `  ${i + 1}. [${f.id ?? `F${i + 1}`}] (${f.severity ?? 'issue'}): ${f.file ? `${f.file}:${f.line ?? ''} ` : ''}${f.claim ?? f.comment ?? ''}`).join('\n')
                    : '  (Reviewer requested changes; please inspect review record in status.)'
                  msg = `[AUTO_DISPATCH] Task ${item.id} "${item.subject}" requires rework based on reviewer findings (Round ${latestReview?.round ?? '?'}).${wt}\nReviewer findings:\n${findingsDigest}\n\nPlease address these findings inside your worktree, run tests, and call team_flow_review_respond with one response per finding id (fixed | rebut | accepted_risk) and updated evidence.`
                } else {
                  msg = `[AUTO_DISPATCH] Task ${item.id} "${item.subject}" is ready and unblocked.${wt} The backing task has been automatically claimed for you. Declared write scopes: ${scopes}. Start work directly inside your worktree (do not call team_flow_status or claim again), and call team_flow_report when done.`
                }

                const ok = await sendNotice(root, item.owner, msg)
                if (ok) {
                  markSentForRev(teamId, 'wake-worker', item.owner, item.id, stateRev)
                  actionsTaken.push({ type: 'wake-worker', target: item.owner, itemId: item.id, isRework })
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
                if (options.force || (!shouldThrottle(teamId, 'wake-reviewer', revName, item.id) && !alreadySentForRev(teamId, 'wake-reviewer', revName, item.id, stateRev))) {
                  const cwd = store.workingDir(root)
                  const rawDiff = await getWorktreeDiffSummary({ cwd, state, item, maxLines: settings.reviewDiffLines }).catch(() => null)
                  const diff = rawDiff !== null && settings.reviewDiffBytes > 0 && rawDiff.length > settings.reviewDiffBytes
                    ? `${rawDiff.slice(0, settings.reviewDiffBytes)}\n… (diff truncated to ${settings.reviewDiffBytes} bytes)`
                    : rawDiff
                  const wt = item.git?.worktreePath ? ` Worktree: ${item.git.worktreePath}.` : ''
                  const diffSummary = diff ? `\n\n${diff}` : ''
                  const roundInfo = item.reviews?.length ? ` (Round ${item.reviews.length + 1})` : ''
                  const msg = `[AUTO_DISPATCH] Item ${item.id} "${item.subject}"${roundInfo} is awaiting your review.${wt}${diffSummary}\n\nPlease inspect the changes and evidence above and call team_flow_review_submit.`
                  const ok = await sendNotice(root, revName, msg)
                  if (ok) {
                    markSentForRev(teamId, 'wake-reviewer', revName, item.id, stateRev)
                    actionsTaken.push({ type: 'wake-reviewer', target: revName, itemId: item.id })
                  }
                }
              }
            }
          }
        }
      }
    }

    // 3. Check escalated items and wake Lead for arbitration
    for (const item of state.items) {
      if (item.status === ITEM_STATUS.ESCALATED) {
        if (options.force || (!shouldThrottle(teamId, 'arbitrate-escalation', 'lead', item.id) && !alreadySentForRev(teamId, 'arbitrate-escalation', 'lead', item.id, stateRev))) {
          const leadMember = members.find((m) => m.role === 'lead') ?? { name: 'lead' }
          const reviewCount = item.reviews?.length ?? 0
          const reason = item.escalation?.reason ?? 'Maximum rework rounds exceeded or unresolvable blocker'
          const msg = `[LEAD_ARBITRATION_REQUIRED] Task ${item.id} "${item.subject}" is ESCALATED (after ${reviewCount} review rounds).\nReason: ${reason}.\nPlease inspect the item with team_flow_status { item_id: "${item.id}" } and intervene via team_flow_repair or reassign.`
          const ok = await sendNotice(root, leadMember.name, msg)
          if (ok) {
            markSentForRev(teamId, 'arbitrate-escalation', leadMember.name, item.id, stateRev)
            actionsTaken.push({ type: 'wake-arbitration', target: leadMember.name, itemId: item.id })
          }
        }
      }
    }

    // 4. Check worktree auto-merge conflicts and notify Lead and Worker
    for (const item of state.items) {
      if (item.status === ITEM_STATUS.APPROVED && item.git?.worktreeMergeError) {
        if (options.force || !shouldThrottle(teamId, 'worktree-conflict', 'lead', item.id)) {
          const leadMember = members.find((m) => m.role === 'lead') ?? { name: 'lead' }
          const workerName = item.owner ?? 'worker'
          const msg = `[AUTO_DISPATCH] Task ${item.id} "${item.subject}" is APPROVED but encountered a merge conflict during auto-merge into branch "${state.git?.branch ?? ''}".\nError: ${item.git.worktreeMergeError}\nAction required: Worker or Lead can run team_flow_git { action: "worktree_sync", item_id: "${item.id}" } to pull updates and resolve conflicts.`
          await sendNotice(root, leadMember.name, msg)
          if (workerName !== leadMember.name && memberMap.has(workerName)) {
            await sendNotice(root, workerName, msg)
          }
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
        const usage = readUsage(members)
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
        if (options.force || (!shouldThrottle(teamId, 'converge-notice', 'lead') && !alreadySentForRev(teamId, 'converge-notice', 'lead', '', stateRev))) {
          const leadMember = members.find((m) => m.role === 'lead') ?? { name: 'lead' }
          const msg = `[TEAM_CONVERGED] All ${state.items.length} work items have been approved! The team has converged. Please run team_flow_gate {finalize: true} to verify final quality gates and produce the final delivery report.`
          const ok = await sendNotice(root, leadMember.name, msg)
          if (ok) {
            markSentForRev(teamId, 'converge-notice', leadMember.name, '', stateRev)
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
