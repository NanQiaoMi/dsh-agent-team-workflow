/**
 * Git branch, commit, verify, PR inspection/review, and worktree management tool.
 */

import path from 'node:path'

import * as G from '../git.js'
import { classifyDiffRisk, formatPrReviewMarkdown, renderReviewRubric } from '../review-policy.js'
import * as W from '../workflow.js'
import {
  assertRoleAllowed,
  jsonOutput,
  requireLead,
  requireRun,
  resolveCaller,
} from './shared.js'

export function buildDomainTools({ ctx, settings, store }) {
  return [
    {
      name: 'team_flow_git',
      description:
        'Git/PR workflow (when gitEnabled).',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['status', 'prepare', 'commit', 'verify', 'push', 'pr', 'pr_inspect', 'review', 'merge', 'worktree_add', 'worktree_remove', 'worktree_list', 'worktree_sync'] },
          item_id: { type: 'string' },
          pr_number: { type: 'integer' },
          message: { type: 'string' },
          files: { type: 'array', items: { type: 'string' } },
          commands: { type: 'array', items: { type: 'string' } },
          method: { type: 'string', enum: ['squash', 'merge', 'no-ff'] },
          title: { type: 'string' },
          body: { type: 'string' },
          abort_on_conflict: { type: 'boolean' },
        },
        required: ['action'],
        additionalProperties: false,
      },
      output: jsonOutput({
        type: 'object',
        properties: {
          action: { type: 'string' },
          item_id: {},
          repo: {},
          run_git: {},
          item_git: {},
          detail: {},
          merged: { type: 'boolean' },
          up_to_date: { type: 'boolean' },
          conflict: { type: 'boolean' },
          conflicted_files: { type: 'array', items: { type: 'string' } },
          warnings: { type: 'array', items: { type: 'string' } },
        },
        required: ['action'],
      }),
      async execute(args, exec) {
        const { agent, membership } = resolveCaller(ctx, exec, 'team_flow_git')
        if (settings.gitEnabled !== true) {
          throw new Error('the git workflow is disabled; enable it in the plugin config with gitEnabled: true')
        }
        const action = String(args.action ?? '')
        const state = action === 'pr_inspect'
          ? await store.readState(agent)
          : await requireRun(store, agent, 'team_flow_git')
        if (state !== null) W.ensureCollaboration(state)
        const cwd = store.workingDir(agent)
        const warnings = []
        assertRoleAllowed(settings, state, membership.name, 'team_flow_git', action)
        const requireItem = () => {
          if (typeof args.item_id !== 'string' || args.item_id.length === 0) throw new Error(`team_flow_git ${action} needs item_id`)
          return W.findItem(state, args.item_id)
        }
        const requireOwner = (item) => {
          if (membership.role !== 'lead' && item.owner !== membership.name) throw new Error(`item "${item.id}" belongs to "${item.owner}"; only its owner (or the Lead) may run ${action}`)
        }
        if (action === 'status') {
          const repo = await G.gitStatus({ cwd })
          return {
            action,
            repo,
            run_git: state.git ?? null,
            item_git: state.items.map((item) => ({ item_id: item.id, owner: item.owner ?? null, git: item.git ?? null })),
            warnings,
          }
        }
        if (action === 'pr_inspect') {
          const result = await G.gitPrInspect({
            cwd,
            number: args.pr_number ?? state?.git?.pr?.number,
            branch: state?.git?.branch,
            maxDiffBytes: settings.reviewDiffBytes > 0 ? Math.max(settings.reviewDiffBytes, 24576) : 24576,
          })
          if (result.ok !== true) throw new Error(`pr_inspect failed: ${result.error}`)
          const risk = classifyDiffRisk({
            files: (result.files ?? []).map((f) => f.path),
            diff: result.diff,
            settings: state?.settings ?? settings,
          })
          const rubric = renderReviewRubric({ depth: risk.depth, profile: risk.profile, reasons: risk.reasons })
          return { action, detail: { ...result, risk, rubric }, warnings }
        }
        if (action === 'worktree_list') {
          const result = await G.gitWorktreeList({ cwd })
          if (result.ok !== true) throw new Error(`worktree list failed: ${result.error}`)
          return {
            action,
            mode: state.settings.worktreeIsolation ?? 'off',
            worktrees: result.worktrees,
            item_worktrees: state.items
              .filter((item) => item.git?.worktreeBranch !== undefined)
              .map((item) => ({ item_id: item.id, owner: item.owner ?? null, worktree: item.git.worktree ?? null, path: item.git.worktreePath ?? null, branch: item.git.worktreeBranch, mergedAt: item.git.worktreeMergedAt ?? null })),
            warnings,
          }
        }
        if (action === 'worktree_add' || action === 'worktree_remove') {
          requireLead(membership, `team_flow_git ${action}`)
          const target = requireItem()
          const vs = state.settings
          const mode = vs.worktreeIsolation ?? 'off'
          if (mode === 'off') throw new Error('worktree isolation is disabled; set worktreeIsolation: "serial" or "parallel" in the plugin config')
          const slug = (value) => String(value).replace(/[^A-Za-z0-9._/-]+/g, '-')
          if (action === 'worktree_add') {
            if (target.git?.worktree && target.git?.worktreePath) {
              return {
                action,
                item_id: target.id,
                mode,
                worktree: {
                  relative: target.git.worktree,
                  absolute: target.git.worktreePath,
                  branch: target.git.worktreeBranch,
                  startPoint: target.git.worktreeBase ?? null,
                },
                detail: { ok: true, path: target.git.worktree, branch: target.git.worktreeBranch },
                warnings,
              }
            }
            if (mode === 'serial') {
              const other = state.items.find((item) => item.id !== target.id && item.git?.worktreeBranch !== undefined && item.git?.worktreeMergedAt == null)
              if (other !== undefined) throw new Error(`serial worktree isolation allows one active worktree at a time; item "${other.id}" still owns one (merge or remove it first)`)
            }
            const relative = `.agentteam/worktrees/${state.runId}/${target.id}`.replace(/[^A-Za-z0-9._/-]+/g, '-')
            const branch = slug(`agentteam-wt/${state.runId}/${target.id}`)
            const startPoint = typeof state.git?.branch === 'string' ? state.git.branch : undefined
            const result = await G.gitWorktreeAdd({ cwd, path: relative, branch, ...(startPoint === undefined ? {} : { startPoint }) })
            if (result.ok !== true) throw new Error(`worktree add failed: ${result.error}`)
            const absolute = path.resolve(cwd, relative)
            let next = null
            await store.mutateState(agent, (current) => {
              W.ensureCollaboration(current)
              const item = W.findItem(current, target.id)
              item.git = { ...(item.git ?? {}), worktree: relative, worktreePath: absolute, worktreeBranch: branch, worktreeBase: startPoint ?? null, worktreeCreatedAt: new Date().toISOString() }
              W.appendEvent(current, { at: new Date().toISOString(), type: 'git/worktree', actor: membership.name, detail: `${item.id} ${relative}` })
              next = current
              return current
            })
            return { action, item_id: target.id, mode, worktree: { relative, absolute, branch, startPoint: startPoint ?? null }, detail: result, warnings }
          }
          if (target.git?.worktreeRemovedAt || (!target.git?.worktree && !target.git?.worktreePath)) {
            return { action, item_id: target.id, already_removed: true, detail: { ok: true }, warnings }
          }
          const absolute = target.git?.worktreePath ?? path.resolve(cwd, target.git?.worktree ?? `.agentteam/worktrees/${state.runId}/${target.id}`)
          const result = await G.gitWorktreeRemove({ cwd, path: target.git?.worktree ?? `.agentteam/worktrees/${state.runId}/${target.id}` })
          if (result.ok !== true) throw new Error(`worktree remove failed: ${result.error}${absolute ? ` (${absolute})` : ''}`)
          await store.mutateState(agent, (current) => {
            W.ensureCollaboration(current)
            const item = W.findItem(current, target.id)
            item.git = { ...(item.git ?? {}), worktree: null, worktreePath: null, worktreeBranch: null, worktreeBase: null }
            W.appendEvent(current, { at: new Date().toISOString(), type: 'git/worktree-removed', actor: membership.name, detail: item.id })
            return current
          })
          return { action, item_id: target.id, detail: result, warnings }
        }
        if (action === 'worktree_sync') {
          const target = requireItem()
          requireOwner(target)
          if (!target.git?.worktreePath) {
            throw new Error(`item "${target.id}" has no worktreePath; worktree must be provisioned first`)
          }
          const fromBranch = state.git?.branch
          if (typeof fromBranch !== 'string' || fromBranch.length === 0) {
            throw new Error('no run branch recorded to sync from')
          }
          const syncResult = await G.gitWorktreeSync({
            cwd: target.git.worktreePath,
            fromBranch,
            abortOnConflict: args.abort_on_conflict === true,
          })
          if (syncResult.ok !== true) {
            if (syncResult.conflict) {
              warnings.push(`Merge conflict detected with ${fromBranch} in files: ${syncResult.conflictedFiles.join(', ')}`)
              return {
                action,
                item_id: target.id,
                merged: false,
                up_to_date: false,
                conflict: true,
                conflicted_files: syncResult.conflictedFiles,
                detail: syncResult,
                warnings,
              }
            }
            throw new Error(`worktree sync failed: ${syncResult.error}`)
          }
          return {
            action,
            item_id: target.id,
            merged: syncResult.merged,
            up_to_date: syncResult.upToDate,
            conflict: false,
            conflicted_files: [],
            detail: syncResult,
            warnings,
          }
        }
        if (action === 'prepare') {
          requireLead(membership, 'team_flow_git prepare')
          const branch = `${state.settings.gitBranchPrefix ?? 'agentteam/'}${state.runId}`.replace(/[^A-Za-z0-9._/-]+/g, '-')
          const base = state.settings.gitBaseBranch ?? 'main'
          const result = await G.gitEnsureBranch({ cwd, branch, base })
          if (result.ok !== true) throw new Error(`could not prepare the run branch: ${result.error}`)
          let next = null
          await store.mutateState(agent, (current) => {
            if (current === null) throw new Error('no workflow run exists yet')
            W.ensureCollaboration(current)
            current.git = {
              branch,
              base,
              remote: current.settings.gitRemote ?? 'origin',
              branchCreated: result.created === true,
              pushedAt: null,
              pr: null,
              mergedAt: null,
              mergeSha: null,
            }
            W.appendEvent(current, { at: new Date().toISOString(), type: 'git/prepared', actor: membership.name, detail: `${branch} (base ${base})` })
            next = current
            return current
          })
          return { action, repo: await G.gitStatus({ cwd }), run_git: next.git, warnings }
        }
        const item = action === 'merge' && typeof args.item_id !== 'string' ? null : requireItem()
        if (action === 'commit') {
          requireOwner(item)
          if (state.git === null || typeof state.git.branch !== 'string') throw new Error('no run branch yet; the Lead must run team_flow_git {action:"prepare"} first')
          // Parallel worktrees: commit inside the item worktree (its branch) so
          // concurrent items never race on one checkout.
          const isolated = typeof item.git?.worktreePath === 'string' && item.git.worktreePath.length > 0
          const workCwd = isolated ? item.git.worktreePath : cwd
          const expectedBranch = isolated ? item.git.worktreeBranch : state.git.branch
          const repo = await G.gitStatus({ cwd: workCwd })
          if (repo.ok !== true) throw new Error(`not a git repository: ${repo.error}`)
          if (repo.branch !== expectedBranch) throw new Error(`the ${isolated ? 'item worktree' : 'repository'} is on "${repo.branch}", not "${expectedBranch}"; check it out before committing`)
          const files = Array.isArray(args.files) && args.files.length > 0 ? args.files.map((file) => W.normalizePath(file)) : (item.report?.files ?? [])
          if (files.length === 0) throw new Error('nothing to commit: pass files or report the item first')
          const message = String(args.message ?? `agentteam(${item.id}): ${item.subject}`).slice(0, 200)
          const result = await G.gitCommit({ cwd: workCwd, files, message, ...(isolated ? { base: state.git.base } : {}) })
          if (result.ok !== true) throw new Error(`commit failed: ${result.error}`)
          let next = null
          await store.mutateState(agent, (current) => {
            W.ensureCollaboration(current)
            const target = W.findItem(current, item.id)
            const previous = target.git ?? {}
            target.git = {
              ...previous,
              sha: result.sha,
              commits: [...(previous.commits ?? []), { sha: result.sha, at: new Date().toISOString(), files: result.files ?? files, message }],
            }
            W.appendEvent(current, { at: new Date().toISOString(), type: 'git/committed', actor: membership.name, detail: `${target.id} ${result.sha}` })
            next = target
            return current
          })
          return { action, item_id: item.id, item_git: next.git, run_git: state.git, repo: await G.gitStatus({ cwd }), warnings }
        }
        if (action === 'verify') {
          const isAssignedReviewer = Array.isArray(item.reviewers) && item.reviewers.some((r) => (typeof r === 'string' ? r === membership.name : r?.name === membership.name))
          if (membership.role !== 'lead' && item.owner !== membership.name && !isAssignedReviewer) {
            requireOwner(item)
          }
          const commands = Array.isArray(args.commands) && args.commands.length > 0 ? args.commands.map((command) => String(command)) : (state.settings.gitVerifyCommands ?? [])
          if (commands.length === 0) throw new Error('no verification commands configured; pass commands or set gitVerifyCommands')
          // Isolated items verify their own worktree copy, not the shared checkout.
          const verifyCwd = typeof item.git?.worktreePath === 'string' && item.git.worktreePath.length > 0 ? item.git.worktreePath : cwd
          const result = await G.gitVerify({ cwd: verifyCwd, commands })
          let next = null
          await store.mutateState(agent, (current) => {
            W.ensureCollaboration(current)
            const target = W.findItem(current, item.id)
            target.git = { ...(target.git ?? {}), verify: { ok: result.ok === true, results: result.results, at: new Date().toISOString() } }
            W.appendEvent(current, { at: new Date().toISOString(), type: 'git/verified', actor: membership.name, detail: `${target.id}: ${result.ok === true ? 'ok' : 'failed'}` })
            next = target
            return current
          })
          return { action, item_id: item.id, item_git: next.git, detail: result, warnings }
        }
        if (action === 'push') {
          requireOwner(item)
          if (state.git === null || typeof state.git.branch !== 'string') throw new Error('no run branch yet; run prepare first')
          const result = await G.gitPush({ cwd, remote: state.git.remote, branch: state.git.branch })
          if (result.ok !== true) throw new Error(`push failed: ${result.error}`)
          let next = null
          await store.mutateState(agent, (current) => {
            W.ensureCollaboration(current)
            current.git = { ...(current.git ?? {}), pushedAt: new Date().toISOString(), pushedSha: result.sha ?? null }
            W.appendEvent(current, { at: new Date().toISOString(), type: 'git/pushed', actor: membership.name, detail: `${current.git.branch} → ${current.git.remote}` })
            next = current
            return current
          })
          return { action, item_id: item.id, run_git: next.git, detail: result, warnings }
        }
        if (action === 'pr') {
          if (membership.role !== 'lead' && item.owner !== membership.name) requireOwner(item)
          if (state.git === null || typeof state.git.branch !== 'string') throw new Error('no run branch yet; run prepare first')
          if (state.git.pushedAt === null || state.git.pushedAt === undefined) throw new Error('push the branch before opening a pull request')
          const title = String(args.title ?? `[agentteam] ${state.objective}`).slice(0, 120)
          const body = String(args.body ?? state.items.map((entry) => `- ${entry.id}: ${entry.subject} (${entry.status})`).join('\n')).slice(0, 8000)
          const result = await G.gitPrCreateOrUpdate({ cwd, branch: state.git.branch, base: state.git.base, title, body, remote: state.git.remote })
          if (result.ok !== true) throw new Error(`pull request failed: ${result.error}`)
          let next = null
          await store.mutateState(agent, (current) => {
            W.ensureCollaboration(current)
            current.git = {
              ...(current.git ?? {}),
              pr: { url: result.url ?? null, number: result.number ?? null, mode: result.mode, status: 'open', updatedAt: new Date().toISOString() },
            }
            W.appendEvent(current, { at: new Date().toISOString(), type: 'git/pr', actor: membership.name, detail: `${result.mode} ${result.url ?? ''}`.trim() })
            next = current
            return current
          })
          return { action, item_id: item.id, run_git: next.git, detail: result, warnings }
        }
        if (action === 'review') {
          if (membership.role !== 'lead' && item.owner === membership.name) throw new Error('authors do not review their own work')
          const isDeclaredReviewer = Array.isArray(item.reviewers) && item.reviewers.includes(membership.name)
          const mySubmitted = [...item.reviews].reverse().find((review) => review.reviewer === membership.name && review.status === 'submitted')
          const submitted = mySubmitted ?? (membership.role === 'lead' ? [...item.reviews].reverse().find((review) => review.status === 'submitted') : undefined)
          if (membership.role !== 'lead' && !isDeclaredReviewer && mySubmitted === undefined) {
            throw new Error(`you are not a reviewer of "${item.id}"`)
          }
          if (submitted === undefined) throw new Error(`no submitted verdict from you on "${item.id}" yet; submit the review first`)
          const verdict = submitted.verdict === 'approve' || submitted.verdict === 'approve_with_nits' ? 'approve' : submitted.verdict === 'request_changes' ? 'request-changes' : 'comment'
          const pr = state.git?.pr ?? null
          const prNumber = Number.isInteger(args.pr_number) ? args.pr_number : (pr?.number ?? null)
          const body = typeof args.body === 'string' && args.body.trim().length > 0
            ? args.body.trim()
            : formatPrReviewMarkdown({ item, review: submitted, state, risk: item.resolvedReview })
          const result = pr === null && prNumber === null
            ? { ok: true, mode: 'record-only', detail: 'no PR recorded; the verdict stays on the board', body }
            : await G.gitPrReview({ cwd, number: prNumber, verdict, body })
          if (result.ok !== true) throw new Error(`pr review failed: ${result.error}`)
          let next = null
          await store.mutateState(agent, (current) => {
            W.ensureCollaboration(current)
            const target = W.findItem(current, item.id)
            target.git = {
              ...(target.git ?? {}),
              prReview: { verdict, at: new Date().toISOString(), mode: result.mode ?? 'record-only', number: prNumber, reviewer: submitted.reviewer, round: submitted.round },
            }
            next = target
            return current
          })
          return { action, item_id: item.id, item_git: next.git, detail: result, warnings }
        }
        if (action === 'merge' && typeof args.item_id === 'string') {
          requireLead(membership, 'team_flow_git merge (item worktree)')
          const target = requireItem()
          if (typeof target.git?.worktreeBranch !== 'string') throw new Error(`item "${target.id}" has no worktree branch; run worktree_add first`)
          if (target.status !== W.ITEM_STATUS.APPROVED) throw new Error(`item "${target.id}" is "${target.status}"; merge its worktree branch only after it is approved`)
          if (state.git === null || typeof state.git.branch !== 'string') throw new Error('no run branch recorded; run prepare first')
          if (target.git.worktreeMergedAt != null) {
            return {
              action,
              item_id: target.id,
              item_git: target.git,
              run_git: state.git,
              detail: { ok: true, sha: target.git.worktreeMergeSha ?? null },
              already_merged: true,
              warnings,
            }
          }
          const method = args.method === 'squash' ? 'squash' : 'no-ff'
          const result = await G.gitMerge({
            cwd,
            branch: target.git.worktreeBranch,
            into: state.git.branch,
            method,
            message: String(args.message ?? `agentteam(${target.id}): merge worktree ${target.git.worktreeBranch}`),
          })
          if (result.ok !== true) throw new Error(`worktree merge failed: ${result.error}`)
          let nextItem = null
          await store.mutateState(agent, (current) => {
            W.ensureCollaboration(current)
            const item = W.findItem(current, target.id)
            item.git = { ...(item.git ?? {}), worktreeMergedAt: new Date().toISOString(), worktreeMergeSha: result.sha ?? null }
            W.appendEvent(current, { at: new Date().toISOString(), type: 'git/worktree-merged', actor: membership.name, detail: `${item.id} ${item.git?.worktreeBranch ?? ''} → ${current.git?.branch ?? ''}` })
            nextItem = item
            return current
          })
          return { action, item_id: target.id, item_git: nextItem.git, run_git: state.git, detail: result, warnings }
        }
        if (action === 'merge') {
          requireLead(membership, 'team_flow_git merge')
          if (state.phase !== W.RUN_PHASE.CONVERGED && state.phase !== W.RUN_PHASE.FINALIZED) throw new Error(`the run is "${state.phase}"; merge only after every item is approved`)
          if (state.gate === null || state.gate.pass !== true) throw new Error('the quality gate has not passed; run team_flow_gate first')
          if (state.git === null || typeof state.git.branch !== 'string') throw new Error('no run branch recorded')
          if (state.git.mergedAt !== null && state.git.mergedAt !== undefined) throw new Error('this run branch is already merged')
          const method = args.method === 'merge' || args.method === 'no-ff' ? args.method : 'squash'
          const pr = state.git.pr ?? null
          const result = pr !== null && pr.mode === 'gh'
            ? await G.gitPrMerge({ cwd, number: pr.number, method })
            : await G.gitMerge({ cwd, branch: state.git.branch, into: state.git.base, method: 'no-ff', message: String(args.message ?? `agentteam: merge ${state.runId}`) })
          if (result.ok !== true) throw new Error(`merge failed: ${result.error}`)
          let next = null
          await store.mutateState(agent, (current) => {
            W.ensureCollaboration(current)
            current.git = { ...(current.git ?? {}), mergedAt: new Date().toISOString(), mergeSha: result.sha ?? null, mergedInto: current.git?.base ?? null, mergeMode: result.mode ?? 'local' }
            if (current.git?.pr != null) current.git.pr = { ...current.git.pr, status: 'merged' }
            W.appendEvent(current, { at: new Date().toISOString(), type: 'git/merged', actor: membership.name, detail: `${current.git?.branch ?? ''} → ${current.git?.base ?? ''}` })
            next = current
            return current
          })
          return { action, run_git: next.git, detail: result, warnings }
        }
        throw new Error(`unknown team_flow_git action "${action}"`)
      },
    },
  ]
}
