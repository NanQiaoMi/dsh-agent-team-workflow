/**
 * Work reporting, review submission, finding responses, and escalation tools.
 */

import { validateItemHandoff } from '../devkit.js'
import * as G from '../git.js'
import {
  approvedMessage,
  changesRequestedMessage,
  reReviewRequestMessage,
  reviewRequestMessage,
} from '../protocol.js'
import { classifyDiffRisk, normalizeDodChecks } from '../review-policy.js'
import * as W from '../workflow.js'
import {
  autoCommitWorktreeIfSafe,
  autoMergeApprovedWorktree,
  autoProvisionWorktrees,
} from '../worktree-manager.js'
import {
  assertRoleAllowed,
  clip,
  formatToolValidationError,
  isLiveMember,
  jsonOutput,
  readHeadSha,
  reportView,
  requireLead,
  requireWritableRun,
  resolveCaller,
  resolveWorktreeHead,
  reviewDiffFor,
  runHook,
  sendPeer,
  syncTaskComplete,
  syncTaskReopen,
} from './shared.js'

export function buildDomainTools({ ctx, settings, store, orchestrator, triggerOrchestrator }) {
  return [
    {
      name: 'team_flow_report',
      description:
        'Owner-only. Submit work report (summary, files, commands with exit_code, evidence) to hand item to reviewer.',
      parameters: {
        type: 'object',
        properties: {
          item_id: { type: 'string' },
          summary: { type: 'string' },
          files: { type: 'array', items: { type: 'string' }, description: 'Modified relative paths.' },
          commands: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                command: { type: 'string' },
                exit_code: { type: 'integer' },
                note: { type: 'string' },
              },
              required: ['command', 'exit_code'],
            },
            description: 'Ran verification commands.',
          },
          evidence: { type: 'array', items: { type: 'string' }, description: 'Quoted outputs/tests.' },
          open_questions: { type: 'array', items: { type: 'string' } },
          risks: { type: 'array', items: { type: 'string' } },
          deviation: { type: 'string', description: 'Brief/DoD deviation and rationale.' },
          handoff_packet: {
            type: 'object',
            description: 'Optional handoff metadata.',
            properties: {
              contract_id: { type: 'string' },
              entry: { type: 'string' },
              exports: { type: 'array', items: { type: 'string' } },
              notes: { type: 'string' },
            },
          },
        },
        required: ['item_id', 'summary', 'files'],
      },
      output: jsonOutput({
        type: 'object',
        properties: {
          item_id: { type: 'string' },
          status: { type: 'string' },
          reported: { type: 'boolean' },
          files: { type: 'array', items: { type: 'string' } },
          commands: { type: 'array', items: {} },
          review_round: {},
          reviewer: {},
          handoff_packet: {},
          contract_validation: {},
          contract_warnings: { type: 'array', items: { type: 'string' } },
          scope_warnings: { type: 'array', items: { type: 'string' } },
          sequence_warnings: { type: 'array', items: { type: 'string' } },
          sync_warnings: { type: 'array', items: { type: 'string' } },
          notified: { type: 'array', items: { type: 'string' } },
          next_actions: { type: 'array', items: { type: 'string' } },
        },
      }),
      async execute(args, exec) {
        const { agent, membership } = resolveCaller(ctx, exec, 'team_flow_report')
        let outcome = null
        const now = new Date().toISOString()
        const commands = (Array.isArray(args.commands) ? args.commands : []).map((command) => ({
          command: String(command?.command ?? '').trim(),
          exitCode: Number.isInteger(command?.exit_code) ? command.exit_code : null,
          note: command?.note === undefined ? null : String(command.note),
        }))
        const files = (Array.isArray(args.files) ? args.files : []).map((file) => W.normalizePath(file)).filter((file) => file.length > 0)
        const cwd = store.workingDir(agent)
        const snapshot = await store.readState(agent)
        const targetItem = snapshot?.items?.find((it) => it.id === String(args.item_id ?? ''))
        let autoCommit = null
        let hostVerified = null
        if (targetItem && targetItem.owner === membership.name && targetItem.status !== W.ITEM_STATUS.APPROVED) {
          autoCommit = await autoCommitWorktreeIfSafe({ cwd, state: snapshot, item: targetItem })
          if (autoCommit.ok === false) {
            if (autoCommit.outOfScope && !args.deviation) {
              throw new Error(
                `team_flow_report rejected: worktree has uncommitted changes outside declared writeScopes (${autoCommit.outside.join(', ')}). Revert or move them inside scope before reporting, or explain in "deviation".`,
              )
            }
            if (!autoCommit.outOfScope && !args.deviation) {
              throw new Error(`team_flow_report rejected: failed to auto-commit worktree changes: ${autoCommit.error}`)
            }
          } else if (autoCommit.committed === true && Array.isArray(autoCommit.files)) {
            for (const committedFile of autoCommit.files) {
              const normalized = W.normalizePath(committedFile)
              if (normalized.length > 0 && !files.includes(normalized)) {
                files.push(normalized)
              }
            }
          }
          const hostVerifyEnabled = snapshot?.settings?.hostVerifyOnReport ?? settings.hostVerifyOnReport
          const verifyCommands = Array.isArray(snapshot?.settings?.gitVerifyCommands)
            ? snapshot.settings.gitVerifyCommands.filter((c) => typeof c === 'string' && c.trim().length > 0)
            : []
          if (hostVerifyEnabled !== false && verifyCommands.length > 0) {
            const verifyCwd = targetItem.git?.worktreePath || cwd
            const sha = await readHeadSha(verifyCwd)
            const verified = await G.gitVerify({ cwd: verifyCwd, commands: verifyCommands, timeoutMs: 60_000 })
            hostVerified = {
              ok: verified.ok === true,
              sha,
              cwd: verifyCwd,
              capturedAt: now,
              commands: (verified.results ?? []).map((r) => ({
                command: r.command,
                exitCode: r.exitCode,
                outputTail: clip(String(r.outputTail ?? ''), 300),
              })),
            }
            if (!hostVerified.ok && settings.preReportCheck !== false && !args.deviation) {
              const failing = hostVerified.commands.filter((c) => c.exitCode !== 0)
              const summary = failing.length > 0
                ? failing.map((c) => `"${c.command}" (exit ${c.exitCode})`).join(', ')
                : (verified.error ?? 'verification command failed')
              throw new Error(
                formatToolValidationError({
                  tool: 'team_flow_report',
                  reason: `host verification failed: ${summary}`,
                  missing: ['passing verification commands'],
                  example: 'Fix the failing command(s) in your workspace and re-run team_flow_report, or explain in "deviation".',
                }),
              )
            }
          }
        }
        const handoffPacket = args.handoff_packet && typeof args.handoff_packet === 'object'
          ? {
              contract_id: args.handoff_packet.contract_id ? String(args.handoff_packet.contract_id).trim() : null,
              entry: args.handoff_packet.entry ? String(args.handoff_packet.entry).trim() : null,
              exports: (Array.isArray(args.handoff_packet.exports) ? args.handoff_packet.exports : []).map((e) => String(e).trim()).filter(Boolean),
              notes: args.handoff_packet.notes ? clip(String(args.handoff_packet.notes).trim(), 1000) : null,
            }
          : null
        const contractValidation = handoffPacket?.contract_id
          ? await validateItemHandoff(cwd, handoffPacket)
          : null
        if (handoffPacket && contractValidation && contractValidation.skipped !== true) {
          if ((!handoffPacket.exports || handoffPacket.exports.length === 0) && Array.isArray(contractValidation.actualExports)) {
            handoffPacket.exports = contractValidation.actualExports
          }
          handoffPacket.validation = {
            ok: contractValidation.ok,
            contractId: contractValidation.contractId,
            missing: contractValidation.missing ?? [],
            error: contractValidation.error ?? null,
          }
        }
        const report = {
          summary: clip(String(args.summary ?? '').trim(), 4000),
          files,
          commands,
          evidence: (Array.isArray(args.evidence) ? args.evidence : []).map((entry) => clip(entry, 1000)),
          openQuestions: (Array.isArray(args.open_questions) ? args.open_questions : []).map((entry) => clip(entry, 1000)),
          risks: (Array.isArray(args.risks) ? args.risks : []).map((entry) => clip(entry, 1000)),
          deviation: args.deviation === undefined ? null : clip(args.deviation, 2000),
          contractValidation: contractValidation && contractValidation.skipped !== true ? contractValidation : null,
          hostVerified,
        }
        let state = await store.mutateState(agent, (current) => {
          if (current === null) throw new Error('no workflow run exists yet; the Lead must call team_flow_plan first')
          requireWritableRun(current, 'team_flow_report')
          assertRoleAllowed(settings, current, membership.name, 'team_flow_report')
          const item = W.findItem(current, String(args.item_id ?? ''))
          if (item.owner !== membership.name) {
            throw new Error(`item "${item.id}" belongs to "${item.owner}"; only its owner may report it. If the owner is stuck, message it or escalate.`)
          }
          if (item.status === W.ITEM_STATUS.APPROVED) throw new Error(`item "${item.id}" is already approved; do not report it again`)

          if (settings.preReportCheck !== false) {
            const failedCommands = commands.filter((c) => Number.isInteger(c.exitCode) && c.exitCode !== 0)
            if (failedCommands.length > 0 && !args.deviation) {
              const summary = failedCommands.map((c) => `"${c.command}" (exit code ${c.exitCode})`).join(', ')
              throw new Error(
                formatToolValidationError({
                  tool: 'team_flow_report',
                  reason: `verification command failed: ${summary}. Fix the failing command(s) before reporting, or explain the failure in "deviation".`,
                  missing: ['commands[].exit_code === 0'],
                  example: { item_id: item.id, summary: '...', files: ['...'], commands: [{ command: 'npm test', exit_code: 0 }], evidence: ['...'] },
                }),
              )
            }
            if (settings.strictScopes) {
              const outside = files.filter((f) => item.writeScopes.length > 0 && !item.writeScopes.some((s) => W.pathInScope(f, s)))
              if (outside.length > 0 && !args.deviation) {
                throw new Error(
                  formatToolValidationError({
                    tool: 'team_flow_report',
                    reason: `modified files outside declared writeScopes (${outside.join(', ')}). In strictScopes mode, revert outside files or explain in "deviation".`,
                    missing: ['files inside writeScopes'],
                    example: { item_id: item.id, files: item.writeScopes, deviation: 'explain why out-of-scope file was modified' },
                  }),
                )
              }
            }
            if (settings.strictContracts && contractValidation && !contractValidation.ok && !args.deviation) {
              const summary = contractValidation.error || `missing required methods [${contractValidation.missing.join(', ')}]`
              throw new Error(
                formatToolValidationError({
                  tool: 'team_flow_report',
                  reason: `contract "${contractValidation.contractId}" violation: ${summary}. Fix missing exports or explain in "deviation".`,
                  missing: contractValidation.missing ?? [],
                  example: { item_id: item.id, handoff_packet: { contract_id: contractValidation.contractId, entry: '...', exports: ['...'] } },
                }),
              )
            }
          }

          const applied = W.applyReport(current, { itemId: item.id, caller: membership.name, report, handoffPacket, now, settings: current.settings })
          if (autoCommit?.committed === true) {
            applied.item.git = {
              ...(applied.item.git ?? {}),
              lastAutoCommitSha: autoCommit.sha ?? null,
              autoCommitCount: (applied.item.git?.autoCommitCount ?? 0) + 1,
            }
            W.appendEvent(current, {
              at: now,
              type: 'git/auto-commit',
              actor: 'worktree-manager',
              detail: `${item.id} (${autoCommit.files.length} file(s), ${autoCommit.sha?.slice(0, 7) ?? ''})`,
            })
          }
          if (hostVerified !== null) {
            W.appendEvent(current, {
              at: now,
              type: 'git/host-verified',
              actor: 'host',
              detail: `${item.id} ${hostVerified.ok ? 'passed' : 'failed'} (${hostVerified.commands.length} command(s), ${hostVerified.sha?.slice(0, 7) ?? 'workspace'})`,
            })
          }
          applied.item.resolvedReview = classifyDiffRisk({ files: applied.item.report.files, item: applied.item, settings: current.settings })
          outcome = applied
          return current
        })
        const item = outcome.item
        const scopeWarnings = item.report.files.filter((file) => item.writeScopes.length > 0 && !item.writeScopes.some((scope) => W.pathInScope(file, scope)))
        const syncWarnings = []
        const completed = await syncTaskComplete(ctx, agent, item.taskId)
        if (completed !== null) syncWarnings.push(completed)
        const notified = []
        const teamKey = state.teamId ?? store.teamIdOf?.(agent) ?? agent.id
        if (item.status === W.ITEM_STATUS.ESCALATED) {
          const escalation = state.escalations.at(-1)
          const failure = await sendPeer(
            ctx,
            agent,
            'lead',
            `[BLOCKER] ${item.id} "${item.subject}" needs arbitration after reporting (escalation ${escalation?.id ?? 'unknown'}).\n${escalation?.detail ?? ''}\nCall team_flow_status, then resolve it with team_flow_escalate or record a gate override.`,
            exec.signal,
          )
          if (failure === null) {
            notified.push('lead')
            orchestrator?.markNotified?.(teamKey, 'arbitrate-escalation', 'lead', item.id, state.rev)
          } else syncWarnings.push(failure)
        } else {
          const reviewTargets = Array.isArray(outcome.nextReviewers) && outcome.nextReviewers.length > 0
            ? outcome.nextReviewers
            : (outcome.review !== null && outcome.nextReviewer !== null ? [outcome.nextReviewer] : [])
          if (reviewTargets.length > 0) {
            const cwd = store.workingDir(agent)
            const diff = await reviewDiffFor({ ctx, cwd, state, item, settings })
            const risk = classifyDiffRisk({ files: item.report.files, diff, item, settings: state.settings })
            if (risk.depth !== item.resolvedReview?.depth || risk.changedLines !== item.resolvedReview?.changedLines || risk.profile !== item.resolvedReview?.profile) {
              item.resolvedReview = risk
              state = await store.mutateState(agent, (current) => {
                if (current === null) return current
                const target = W.findItem(current, item.id)
                target.resolvedReview = risk
                return current
              })
            }
            for (const targetReviewer of reviewTargets) {
              if (!isLiveMember(ctx, agent, targetReviewer)) {
                if (!settings.lazyStaffing) {
                  syncWarnings.push(`reviewer "${targetReviewer}" is not in the roster; spawn it with the reviewer prompt from team_flow_plan, then the author can re-report or the Lead can re-notify.`)
                }
              } else if (settings.autoNotify) {
                const failure = await sendPeer(ctx, agent, targetReviewer, reviewRequestMessage(state, item, diff, risk), exec.signal)
                if (failure === null) {
                  notified.push(targetReviewer)
                  orchestrator?.markNotified?.(teamKey, 'wake-reviewer', targetReviewer, item.id, state.rev)
                } else syncWarnings.push(failure)
              }
            }
          }
        }
        const status = W.buildStatus(state, {
          me: { name: membership.name, role: membership.role },
          role: membership.role,
          settings: state.settings,
          members: [],
          artifacts: {},
        })
        triggerOrchestrator(agent)
        const contractWarnings = contractValidation && !contractValidation.ok
          ? [contractValidation.error || `contract "${contractValidation.contractId}" missing methods: [${contractValidation.missing.join(', ')}]`]
          : []
        return {
          ...reportView(item),
          status: item.status,
          review_round: outcome.review?.round ?? null,
          reviewer: outcome.nextReviewer,
          handoff_packet: item.handoffPacket ?? null,
          contract_validation: contractValidation && contractValidation.skipped !== true ? contractValidation : null,
          contract_warnings: contractWarnings,
          scope_warnings: scopeWarnings,
          sequence_warnings: item.report?.sequenceWarnings ?? [],
          sync_warnings: syncWarnings,
          notified,
          host_verified: hostVerified,
          auto_commit: autoCommit?.committed === true ? { committed: true, sha: autoCommit.sha ?? null, files: autoCommit.files } : null,
          next_actions: item.status === W.ITEM_STATUS.IN_REVIEW ? ['Stop and let the reviewer work; the Lead will message you if changes are requested.'] : status.next_actions,
        }
      },
    },
    {
      name: 'team_flow_review_submit',
      description:
        'Reviewer-only. Submit verdict, findings, and evidence_checked (non-approvals require >=1 finding).',
      parameters: {
        type: 'object',
        properties: {
          item_id: { type: 'string' },
          verdict: { type: 'string', enum: ['approve', 'approve_with_nits', 'request_changes', 'block'] },
          summary: { type: 'string' },
          findings: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string' },
                severity: { type: 'string', enum: ['blocker', 'major', 'minor', 'nit'] },
                file: { type: 'string' },
                line: { type: 'integer' },
                claim: { type: 'string' },
                suggestion: { type: 'string' },
              },
              required: ['id', 'severity', 'claim'],
            },
          },
          evidence_checked: { type: 'array', items: { type: 'string' } },
          dod_checks: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                item: { type: 'string' },
                status: { type: 'string', enum: ['pass', 'fail', 'na'] },
                note: { type: 'string' },
              },
              required: ['item', 'status'],
            },
          },
        },
        required: ['item_id', 'verdict', 'summary', 'findings', 'evidence_checked'],
      },
      output: jsonOutput({
        type: 'object',
        properties: {
          item_id: { type: 'string' },
          verdict: { type: 'string' },
          item_status: { type: 'string' },
          next_reviewer: {},
          notified: { type: 'array', items: { type: 'string' } },
          sync_warnings: { type: 'array', items: { type: 'string' } },
          next_actions: { type: 'array', items: { type: 'string' } },
        },
      }),
      async execute(args, exec) {
        const { agent, membership } = resolveCaller(ctx, exec, 'team_flow_review_submit')
        const now = new Date().toISOString()
        const findings = (Array.isArray(args.findings) ? args.findings : []).map((finding, index) => ({
          id: finding?.id === undefined ? `F${index + 1}` : String(finding.id),
          severity: String(finding?.severity ?? 'major'),
          file: finding?.file === undefined ? null : String(finding.file),
          line: Number.isInteger(finding?.line) ? finding.line : null,
          claim: clip(String(finding?.claim ?? '').trim(), 2000),
          suggestion: finding?.suggestion === undefined ? null : clip(finding.suggestion, 1000),
        }))
        for (const finding of findings) {
          if (!W.SEVERITIES.includes(finding.severity)) throw new Error(`finding "${finding.id}" has severity "${finding.severity}"; use one of ${W.SEVERITIES.join('/')}`)
          if (finding.claim.length === 0) throw new Error(`finding "${finding.id}" needs a non-empty claim`)
        }
        if (!W.VERDICTS.includes(args.verdict)) throw new Error(`verdict must be one of ${W.VERDICTS.join('/')}`)
        const dodChecks = normalizeDodChecks(args.dod_checks)

        if (
          settings.nitTolerance !== false &&
          args.verdict === 'request_changes' &&
          findings.length > 0 &&
          findings.every((f) => f.severity === 'nit')
        ) {
          throw new Error(
            formatToolValidationError({
              tool: 'team_flow_review_submit',
              reason:
                'all findings have "nit" severity. Non-blocking stylistic notes do not justify a blocking rework cycle. Use verdict: "approve_with_nits" to record observations without blocking the run, or elevate at least one finding to "minor", "major", or "blocker" if author rework is necessary.',
              missing: ['verdict: "approve_with_nits" or >=1 non-nit finding'],
              example: {
                item_id: String(args.item_id ?? 'W1'),
                verdict: 'approve_with_nits',
                summary: 'Approved with minor style observations',
                findings,
                evidence_checked: ['diff and tests verified'],
              },
            }),
          )
        }

        let outcome = null
        let state = await store.mutateState(agent, async (current) => {
          if (current === null) throw new Error('no workflow run exists yet')
          requireWritableRun(current, 'team_flow_review_submit')
          const item = W.findItem(current, String(args.item_id ?? ''))
          const pending = W.pendingReviewFor(item, membership.name) ?? W.pendingReview(item)
          if (pending === null) throw new Error(`item "${item.id}" has no pending review for you`)
          if (pending.reviewer !== membership.name) {
            throw new Error(`the pending review of "${item.id}" is assigned to "${pending.reviewer}", not "${membership.name}". Do not review items assigned to a peer.`)
          }
          const evidenceChecked = (Array.isArray(args.evidence_checked) ? args.evidence_checked : []).map((entry) => String(entry))
          if (W.isApproving(args.verdict) && evidenceChecked.length === 0 && current.settings.requireReviewEvidence !== false) {
            throw new W.WorkflowError(
              'an approving verdict must declare what you actually inspected in evidence_checked (read the files, re-run a command, or quote the evidence you checked)',
              'WORKFLOW_REVIEW_EVIDENCE_REQUIRED',
            )
          }
          if (W.isApproving(args.verdict)) {
            await runHook('taskCompleted', {
              item: { id: item.id, subject: item.subject, owner: item.owner, writeScopes: item.writeScopes, status: item.status },
              verdict: args.verdict,
              reviewer: membership.name,
            }, { agent, settings: current.settings, store })
          }
          const reviewedSha = await resolveWorktreeHead(item)
          outcome = W.applyReviewSubmit(current, {
            itemId: item.id,
            reviewer: membership.name,
            verdict: args.verdict,
            summary: clip(String(args.summary ?? '').trim(), 4000),
            findings,
            evidenceChecked,
            dodChecks,
            settings: current.settings,
            reviewedSha,
            now,
          })
          if (current.settings?.archiveApprovedItems && outcome.item.status === W.ITEM_STATUS.APPROVED) {
            const archivePath = await store.archiveItem(agent, outcome.item)
            outcome.item.archived = true
            if (outcome.item.report) {
              outcome.item.report.archived = true
              outcome.item.report.archivePath = archivePath
              outcome.item.report.evidence = []
              outcome.item.report.openQuestions = []
              outcome.item.report.risks = []
            }
            if (Array.isArray(outcome.item.reviews)) {
              outcome.item.reviews = outcome.item.reviews.map((r) => ({
                round: r.round,
                reviewer: r.reviewer,
                status: r.status ?? 'submitted',
                verdict: r.verdict ?? r.status,
                reportSeq: r.reportSeq ?? 0,
                evidenceChecked: r.evidenceChecked ?? ['archived'],
                findingsCount: Array.isArray(r.findings) ? r.findings.length : 0,
                findings: [],
                archived: true,
              }))
            }
          }
          return current
        })
        const item = outcome.item
        const syncWarnings = []
        if (item.status === W.ITEM_STATUS.CHANGES_REQUESTED) {
          const reopened = await syncTaskReopen(ctx, agent, item.taskId)
          if (reopened !== null) syncWarnings.push(reopened)
        }
        const notified = []
        const teamKey = state.teamId ?? store.teamIdOf?.(agent) ?? agent.id
        if (item.status === W.ITEM_STATUS.CHANGES_REQUESTED) {
          const failure = settings.autoNotify ? await sendPeer(ctx, agent, item.owner, changesRequestedMessage(state, item, outcome.review), exec.signal) : null
          if (failure === null && settings.autoNotify) {
            notified.push(item.owner)
            orchestrator?.markNotified?.(teamKey, 'wake-worker', item.owner, item.id, state.rev)
          } else if (failure !== null) syncWarnings.push(failure)
        } else if (item.status === W.ITEM_STATUS.APPROVED) {
          const failure = settings.autoNotify ? await sendPeer(ctx, agent, item.owner, approvedMessage(state, item, outcome.review), exec.signal) : null
          if (failure === null && settings.autoNotify) notified.push(item.owner)
          else if (failure !== null) syncWarnings.push(failure)
          const cwd = store.workingDir(agent)
          await autoMergeApprovedWorktree({ cwd, state, itemId: item.id, agent, store }).catch(() => {})
          state = (await store.readState(agent)) ?? state
          if (
            state?.settings?.worktreeIsolation === 'serial' ||
            (state?.settings?.worktreeIsolation === 'parallel' && state?.settings?.lazyWorktreeProvision !== false)
          ) {
            await autoProvisionWorktrees({ cwd, state, agent, store }).catch(() => {})
            state = (await store.readState(agent)) ?? state
          }
        }
        if (outcome.nextReviewOpened === true && outcome.nextReviewer !== null && outcome.nextReviewer !== undefined) {
          if (!isLiveMember(ctx, agent, outcome.nextReviewer)) {
            if (!settings.lazyStaffing) syncWarnings.push(`next reviewer "${outcome.nextReviewer}" is not in the roster`)
          } else if (settings.autoNotify) {
            const cwd = store.workingDir(agent)
            const diff = await reviewDiffFor({ ctx, cwd, state, item, settings })
            const failure = await sendPeer(ctx, agent, outcome.nextReviewer, reviewRequestMessage(state, item, diff, item.resolvedReview), exec.signal)
            if (failure === null) {
              notified.push(outcome.nextReviewer)
              orchestrator?.markNotified?.(teamKey, 'wake-reviewer', outcome.nextReviewer, item.id, state.rev)
            } else syncWarnings.push(failure)
          }
        }
        const status = W.buildStatus(state, {
          me: { name: membership.name, role: membership.role },
          role: membership.role,
          settings: state.settings,
          members: [],
          artifacts: {},
        })
        triggerOrchestrator(agent)
        return {
          item_id: item.id,
          verdict: outcome.review.verdict,
          item_status: item.status,
          next_reviewer: outcome.nextReviewer ?? null,
          notified,
          sync_warnings: syncWarnings,
          next_actions: status.next_actions,
        }
      },
    },
    {
      name: 'team_flow_review_respond',
      description:
        'Owner-only. Answer open findings (fixed|rebut|accepted_risk) with evidence; all answered triggers next round.',
      parameters: {
        type: 'object',
        properties: {
          item_id: { type: 'string' },
          responses: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                finding_id: { type: 'string' },
                state: { type: 'string', enum: ['fixed', 'rebut', 'accepted_risk'] },
                evidence: { type: 'string' },
                note: { type: 'string', description: 'Required for rebut/accepted_risk.' },
              },
              required: ['finding_id', 'state'],
            },
            description: 'One per open finding.',
          },
        },
        required: ['item_id', 'responses'],
      },
      output: jsonOutput({
        type: 'object',
        properties: {
          item_id: { type: 'string' },
          item_status: { type: 'string' },
          next_round: {},
          next_reviewer: {},
          escalated: { type: 'boolean' },
          notified: { type: 'array', items: { type: 'string' } },
          sync_warnings: { type: 'array', items: { type: 'string' } },
          next_actions: { type: 'array', items: { type: 'string' } },
        },
      }),
      async execute(args, exec) {
        const { agent, membership } = resolveCaller(ctx, exec, 'team_flow_review_respond')
        const now = new Date().toISOString()
        const responses = (Array.isArray(args.responses) ? args.responses : []).map((response) => ({
          findingId: String(response?.finding_id ?? ''),
          state: String(response?.state ?? ''),
          evidence: response?.evidence === undefined ? null : clip(response.evidence, 2000),
          note: response?.note === undefined ? null : clip(response.note, 2000),
        }))
        for (const response of responses) {
          if (!W.FINDING_RESOLUTIONS.includes(response.state)) {
            throw new Error(
              formatToolValidationError({
                tool: 'team_flow_review_respond',
                reason: `response for "${response.findingId}" has state "${response.state}"; use one of ${W.FINDING_RESOLUTIONS.join('/')}`,
                missing: ['responses[].state'],
                example: { item_id: String(args.item_id ?? 'W1'), responses: [{ finding_id: response.findingId || 'F1', state: 'fixed', evidence: 'test passed' }] },
              }),
            )
          }
          if ((response.state === 'rebut' || response.state === 'accepted_risk') && (response.note === null || response.note.length === 0)) {
            throw new Error(
              formatToolValidationError({
                tool: 'team_flow_review_respond',
                reason: `response for "${response.findingId}" is ${response.state} and needs a note explaining why`,
                missing: ['responses[].note'],
                example: { item_id: String(args.item_id ?? 'W1'), responses: [{ finding_id: response.findingId || 'F1', state: response.state, evidence: '...', note: 'rationale here' }] },
              }),
            )
          }
        }
        let outcome = null
        let state = await store.mutateState(agent, async (current) => {
          if (current === null) throw new Error('no workflow run exists yet')
          requireWritableRun(current, 'team_flow_review_respond')
          const item = W.findItem(current, String(args.item_id ?? ''))
          if (item.owner !== membership.name) throw new Error(`item "${item.id}" belongs to "${item.owner}"; only the author may answer its review`)
          outcome = W.applyReviewRespond(current, { itemId: item.id, author: membership.name, responses, now, settings: current.settings })
          return current
        })
        const item = outcome.item
        const syncWarnings = []
        const notified = []
        const teamKey = state.teamId ?? store.teamIdOf?.(agent) ?? agent.id
        if (outcome.escalated) {
          const escalation = state.escalations.at(-1)
          const failure = await sendPeer(
            ctx,
            agent,
            'lead',
            `[BLOCKER] ${item.id} "${item.subject}" needs arbitration (escalation ${escalation?.id ?? 'unknown'}).\n${escalation?.detail ?? ''}\nCall team_flow_status, then resolve it with team_flow_escalate or record a gate override.`,
            exec.signal,
          )
          if (failure === null) {
            notified.push('lead')
            orchestrator?.markNotified?.(teamKey, 'arbitrate-escalation', 'lead', item.id, state.rev)
          } else syncWarnings.push(failure)
        } else {
          const targets = Array.isArray(outcome.nextReviewers) && outcome.nextReviewers.length > 0
            ? outcome.nextReviewers
            : (outcome.nextReviewer !== null && outcome.nextReviewer !== undefined ? [outcome.nextReviewer] : [])
          const cwd = store.workingDir(agent)
          for (const targetReviewer of targets) {
            if (!isLiveMember(ctx, agent, targetReviewer)) {
              if (!settings.lazyStaffing) syncWarnings.push(`reviewer "${targetReviewer}" is not in the roster`)
            } else if (settings.autoNotify) {
              const previousReview = item.reviews.filter((r) => r.status === 'submitted' && r.reviewer === targetReviewer).at(-1) ??
                item.reviews.filter((r) => r.status === 'submitted').at(-1) ?? null
              const diff = await reviewDiffFor({ ctx, cwd, state, item, settings, sinceSha: previousReview?.reviewedSha ?? null })
              const msg = previousReview !== null
                ? reReviewRequestMessage(state, item, previousReview, diff)
                : reviewRequestMessage(state, item, diff, item.resolvedReview)
              const failure = await sendPeer(ctx, agent, targetReviewer, msg, exec.signal)
              if (failure === null) {
                notified.push(targetReviewer)
                orchestrator?.markNotified?.(teamKey, 'wake-reviewer', targetReviewer, item.id, state.rev)
              } else syncWarnings.push(failure)
            }
          }
        }
        const status = W.buildStatus(state, {
          me: { name: membership.name, role: membership.role },
          role: membership.role,
          settings: state.settings,
          members: [],
          artifacts: {},
        })
        triggerOrchestrator(agent)
        return {
          item_id: item.id,
          item_status: item.status,
          next_round: outcome.nextReview?.round ?? null,
          next_reviewer: outcome.nextReviewer ?? null,
          escalated: outcome.escalated === true,
          notified,
          sync_warnings: syncWarnings,
          next_actions: status.next_actions,
        }
      },
    },
    {
      name: 'team_flow_escalate',
      description:
        'Raise a structured escalation to the Lead (blocking pauses gate) or, as Lead, resolve one.',
      parameters: {
        type: 'object',
        properties: {
          kind: { type: 'string', enum: ['blocker', 'conflict', 'scope_change', 'decision', 'arbitration'] },
          subject: { type: 'string' },
          detail: { type: 'string', description: 'Context and attempts so far.' },
          blocking: { type: 'boolean', description: 'Default true.' },
          item_id: { type: 'string' },
          escalation_id: { type: 'string', description: 'Lead-only: escalation to resolve.' },
          resolution: { type: 'string', description: 'Lead-only: decision and rationale.' },
        },
      },
      output: jsonOutput({
        type: 'object',
        properties: {
          escalation_id: { type: 'string' },
          resolved: { type: 'boolean' },
          notified: { type: 'array', items: { type: 'string' } },
          sync_warnings: { type: 'array', items: { type: 'string' } },
          next_actions: { type: 'array', items: { type: 'string' } },
        },
      }),
      async execute(args, exec) {
        const { agent, membership } = resolveCaller(ctx, exec, 'team_flow_escalate')
        const now = new Date().toISOString()
        const resolving = typeof args.escalation_id === 'string' && args.escalation_id.length > 0
        if (resolving) {
          requireLead(membership, 'team_flow_escalate (resolve mode)')
          const resolution = String(args.resolution ?? '').trim()
          if (resolution.length === 0) throw new Error('resolving an escalation requires a resolution text recording the decision')
          const state = await store.mutateState(agent, async (current) => {
            if (current === null) throw new Error('no workflow run exists yet')
            W.resolveEscalation(current, { escalationId: String(args.escalation_id), resolution, actor: membership.name, now })
            return current
          })
          const status = W.buildStatus(state, { me: { name: membership.name, role: membership.role }, role: membership.role, settings: state.settings, members: [], artifacts: {} })
          return { escalation_id: String(args.escalation_id), resolved: true, notified: [], sync_warnings: [], next_actions: status.next_actions }
        }
        const kind = String(args.kind ?? 'blocker')
        if (!W.ESCALATION_KINDS.includes(kind)) throw new Error(`kind must be one of ${W.ESCALATION_KINDS.join('/')}`)
        const subject = String(args.subject ?? '').trim()
        if (subject.length === 0) throw new Error('a new escalation needs a subject')
        const detail = String(args.detail ?? '').trim()
        let escalation = null
        const state = await store.mutateState(agent, async (current) => {
          if (current === null) throw new Error('no workflow run exists yet')
          requireWritableRun(current, 'team_flow_escalate')
          const item = args.item_id === undefined ? null : W.findItem(current, String(args.item_id))
          escalation = W.raiseEscalation(current, {
            kind,
            subject,
            detail,
            blocking: args.blocking !== false,
            itemId: item?.id ?? null,
            actor: membership.name,
            now,
          })
          return current
        })
        const syncWarnings = []
        const notified = []
        if (membership.role !== 'lead') {
          const failure = await sendPeer(
            ctx,
            agent,
            'lead',
            `[BLOCKER] Escalation ${escalation.id} (${kind})${escalation.itemId === null ? '' : ` on ${escalation.itemId}`}: ${subject}\n\n${detail}\n\nCall team_flow_status and resolve it with team_flow_escalate {escalation_id:"${escalation.id}", resolution:"..."}.`,
            exec.signal,
          )
          if (failure === null) notified.push('lead')
          else syncWarnings.push(failure)
        }
        const status = W.buildStatus(state, { me: { name: membership.name, role: membership.role }, role: membership.role, settings: state.settings, members: [], artifacts: {} })
        return {
          escalation_id: escalation.id,
          resolved: false,
          notified,
          sync_warnings: syncWarnings,
          next_actions: status.next_actions,
        }
      },
    },
  ]
}
