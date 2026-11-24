/**
 * Peer collaboration tools: item creation, channel messages, open queue/handoff/review invites, proposals/votes, and inbox read.
 */

import * as W from '../workflow.js'
import { autoProvisionWorktrees } from '../worktree-manager.js'
import {
  assertMemberName,
  assertRoleAllowed,
  audienceFor,
  isLiveMember,
  jsonOutput,
  requireLead,
  requireRun,
  requireWritableRun,
  resolveCaller,
  runHook,
  sendPeer,
  taskDescription,
} from './shared.js'

export function buildDomainTools({ ctx, settings, store, refreshMemberTools, triggerOrchestrator }) {
  return [
    {
      name: 'team_flow_item',
      description:
        'Add a missing work item to the live run (same scope, DoD, and review rules as planned items).',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['create'] },
          subject: { type: 'string' },
          role: { type: 'string', description: 'Default implementer.' },
          write_scopes: { type: 'array', items: { type: 'string' } },
          definition_of_done: { type: 'array', items: { type: 'string' } },
          owner: { type: 'string', description: '"self" (default), "open", or member name.' },
          blocked_by: { type: 'array', items: { type: 'string' } },
          needs_review: { type: 'boolean', description: 'Default true.' },
          reviewers: { type: 'array', items: { type: 'string' } },
          evidence_optional: { type: 'boolean', description: 'True only for read-only/research.' },
          lease_minutes: { type: 'integer', description: 'Advisory claim lease minutes.' },
          complexity: { type: 'string', enum: ['trivial', 'normal', 'complex'] },
          thinking_tier: { type: 'string', enum: ['off', 'low', 'medium', 'high', 'max', 'inherit'] },
          review_depth: { type: 'string', enum: ['auto', 'light', 'standard', 'deep'] },
          review_profile: { type: 'string', enum: ['auto', 'code', 'security', 'api', 'docs', 'tests', 'refactor'] },
        },
        required: ['action', 'subject', 'write_scopes', 'definition_of_done'],
        additionalProperties: false,
      },
      output: jsonOutput({
        type: 'object',
        properties: {
          item_id: { type: 'string' },
          subject: { type: 'string' },
          owner: {},
          assignment: { type: 'string' },
          status: { type: 'string' },
          task_id: {},
          origin: { type: 'string' },
          created_by: { type: 'string' },
          notifications: { type: 'array', items: { type: 'string' } },
          warnings: { type: 'array', items: { type: 'string' } },
          next_actions: { type: 'array', items: { type: 'string' } },
        },
        required: ['item_id', 'subject'],
      }),
      async execute(args, exec) {
        const { agent, membership } = resolveCaller(ctx, exec, 'team_flow_item')
        if (String(args.action ?? 'create') !== 'create') throw new Error('team_flow_item supports action:"create"')
        const writeScopes = Array.isArray(args.write_scopes) ? args.write_scopes : []
        const definitionOfDone = Array.isArray(args.definition_of_done) ? args.definition_of_done : []
        let item = null
        const warnings = []
        await store.mutateState(agent, async (current) => {
          if (current === null) throw new Error('no workflow run exists yet; the Lead must call team_flow_plan first')
          requireWritableRun(current, 'team_flow_item')
          assertRoleAllowed(settings, current, membership.name, 'team_flow_item')
          const taskIdByItem = new Map(current.items.filter((candidate) => typeof candidate.taskId === 'string').map((candidate) => [candidate.id, candidate.taskId]))
          const blockedByTasks = (Array.isArray(args.blocked_by) ? args.blocked_by : [])
            .map((blocker) => taskIdByItem.get(String(blocker)))
            .filter((taskId) => typeof taskId === 'string')
          item = W.createItem(current, {
            by: membership.name,
            subject: args.subject,
            role: args.role,
            writeScopes,
            definitionOfDone,
            owner: args.owner,
            blockedBy: args.blocked_by,
            needsReview: args.needs_review,
            reviewers: args.reviewers,
            evidenceOptional: args.evidence_optional,
            leaseMinutes: args.lease_minutes,
            complexity: args.complexity,
            thinkingTier: args.thinking_tier,
            reviewDepth: args.review_depth,
            reviewProfile: args.review_profile,
            now: new Date().toISOString(),
            maxItems: settings.maxItems,
            allowScopeOverlap: current.settings?.allowScopeOverlap,
          })
          await runHook('taskCreated', {
            item: { id: item.id, subject: item.subject, role: item.role, owner: item.owner === '' ? null : item.owner, assignment: item.assignment, writeScopes: item.writeScopes },
            objective: current.objective,
            actor: membership.name,
          }, { agent, settings: current.settings, store })
          try {
            const task = await ctx.agentTeams.createTask(agent, {
              subject: item.subject.slice(0, 200),
              description: taskDescription(current, item).slice(0, 16_384),
              ...(blockedByTasks.length === 0 ? {} : { blockedBy: blockedByTasks }),
              ...(item.writeScopes.length === 0 ? {} : { writeScopes: item.writeScopes }),
              signal: exec.signal,
            })
            item.taskId = task.id
            if (item.owner === membership.name) {
              try {
                await ctx.agentTeams.updateTask(agent, { taskId: task.id, expectedRevision: task.revision, action: 'claim' })
              } catch (error) {
                warnings.push(`backing task ${task.id} not claimed: ${error instanceof Error ? error.message : String(error)}`)
              }
            }
          } catch (error) {
            warnings.push(`backing Team task not created: ${error instanceof Error ? error.message : String(error)}`)
          }
          if (typeof item.owner === 'string' && item.owner.length > 0 && typeof item.role === 'string' && item.role.length > 0) {
            current.roleAssignments = { ...(current.roleAssignments ?? {}), [item.owner]: current.roleAssignments?.[item.owner] ?? item.role }
          }
          return current
        })
        const notifications = []
        if (item.owner !== undefined && item.owner !== null && item.owner !== '' && item.owner !== membership.name) {
          const failure = await sendPeer(ctx, agent, item.owner, `[ITEM] ${membership.name} created ${item.id} "${item.subject}" for you.\nScope: ${item.writeScopes.join(', ')}\nDoD:\n${item.definitionOfDone.map((entry) => `- ${entry}`).join('\n')}\nAction: call team_flow_status, then do the work and report with team_flow_report.`, exec.signal)
          if (failure === null) notifications.push(item.owner)
          else warnings.push(failure)
        } else if (item.owner === '' || item.owner === null || item.owner === undefined) {
          const targets = audienceFor(await store.readState(agent), membership.name)
          for (const target of targets) {
            const failure = await sendPeer(ctx, agent, target, `[ITEM] open queue item ${item.id} "${item.subject}" published by ${membership.name}: claim it with team_flow_work {action:"claim", item_id:"${item.id}"}.`, exec.signal)
            if (failure === null) notifications.push(target)
            else warnings.push(failure)
          }
        }
        const cwd = store.workingDir(agent)
        await autoProvisionWorktrees({ cwd, state: await store.readState(agent), agent, store }).catch(() => {})
        const state = await store.readState(agent)
        refreshMemberTools?.(agent, null, state)
        return {
          item_id: item.id,
          subject: item.subject,
          owner: item.owner === '' || item.owner === null || item.owner === undefined ? null : item.owner,
          assignment: item.assignment,
          status: item.status,
          task_id: item.taskId ?? null,
          origin: item.origin ?? 'member',
          created_by: item.createdBy ?? membership.name,
          notifications,
          warnings,
          next_actions: state === null ? [] : W.nextActions(state, { me: { name: membership.name, role: membership.role }, role: membership.role, members: ctx.agentTeams.listMembers(agent).map((member) => ({ name: member.name, role: member.role })), settings: state.settings, now: new Date().toISOString() }),
        }
      },
    },
    {
      name: 'team_flow_talk',
      description:
        'Peer channel: send a message to a teammate or "team" and record it on the board.',
      parameters: {
        type: 'object',
        properties: {
          target: { type: 'string', description: 'Teammate name or "team".' },
          kind: { type: 'string', enum: [...W.CHANNEL_KINDS], description: 'Default "note".' },
          text: { type: 'string' },
          item_id: { type: 'string' },
          finding_id: { type: 'string' },
          reply_to: { type: 'string', description: 'Channel message id being answered.' },
        },
        required: ['target', 'text'],
        additionalProperties: false,
      },
      output: jsonOutput({
        type: 'object',
        properties: {
          message_id: { type: 'string' },
          from: { type: 'string' },
          target: { type: 'string' },
          delivered_to: { type: 'array', items: { type: 'string' } },
          warnings: { type: 'array', items: { type: 'string' } },
        },
        required: ['message_id'],
      }),
      async execute(args, exec) {
        const { agent, membership } = resolveCaller(ctx, exec, 'team_flow_talk')
        const rawTarget = String(args.target ?? '').trim()
        const text = String(args.text ?? '').trim()
        if (text.length === 0) throw new Error('team_flow_talk needs non-empty text')
        let to = 'team'
        if (rawTarget !== 'team') {
          to = rawTarget
          if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(to)) throw new Error(`target "${to}" is not a member name (lower-kebab-case, digits allowed)`)
          if (!isLiveMember(ctx, agent, to)) {
            throw new Error(`"${to}" is not in the live roster; call team_flow_status to see the members, or use target:"team"`)
          }
        }
        let message = null
        await store.mutateState(agent, (current) => {
          if (current === null) throw new Error('no workflow run exists yet; the Lead must call team_flow_plan first')
          requireWritableRun(current, 'team_flow_talk')
          message = W.postChannelMessage(current, {
            from: membership.name,
            to,
            kind: args.kind,
            text,
            itemId: args.item_id,
            findingId: args.finding_id,
            replyTo: args.reply_to,
            now: new Date().toISOString(),
          })
          return current
        })
        const warnings = []
        const delivered = []
        const roster = ctx.agentTeams.listMembers(agent).map((member) => member.name).filter((name) => name !== membership.name)
        const targets = to === 'team' ? audienceFor(await store.readState(agent), membership.name) : [to]
        const prefix = `[CHANNEL ${message.id}] ${membership.name}${to === 'team' ? ' (to team)' : ''}${args.item_id ? ` [item ${args.item_id}]` : ''}: `
        for (const name of targets) {
          const failure = await sendPeer(ctx, agent, name, `${prefix}${text}`, exec.signal)
          if (failure === null) delivered.push(name)
          else warnings.push(failure)
        }
        return { message_id: message.id, from: membership.name, target: to, delivered_to: delivered, warnings }
      },
    },
    {
      name: 'team_flow_work',
      description:
        'Peer work coordination: claim/release open-queue items, request/take reviews, or hand off items.',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['claim', 'release', 'request_review', 'take_review', 'handoff_offer', 'handoff_accept', 'handoff_decline'],
          },
          item_id: { type: 'string' },
          reviewer: { type: 'string', description: 'request_review: peer name (omit for open).' },
          to: { type: 'string', description: 'handoff_offer: target peer.' },
          reason: { type: 'string' },
          note: { type: 'string' },
          lease_minutes: { type: 'integer', description: 'Claim lease minutes (default 30).' },
        },
        required: ['action', 'item_id'],
        additionalProperties: false,
      },
      output: jsonOutput({
        type: 'object',
        properties: {
          item_id: { type: 'string' },
          action: { type: 'string' },
          item_status: { type: 'string' },
          owner: {},
          reviewer: {},
          notifications: { type: 'array', items: { type: 'string' } },
          warnings: { type: 'array', items: { type: 'string' } },
        },
        required: ['item_id', 'action'],
      }),
      async execute(args, exec) {
        const { agent, membership } = resolveCaller(ctx, exec, 'team_flow_work')
        const action = String(args.action ?? '')
        const itemId = String(args.item_id ?? '').trim()
        if (itemId.length === 0) throw new Error('team_flow_work needs item_id')
        const now = new Date().toISOString()
        let outcome = null
        let state = null
        await store.mutateState(agent, (current) => {
          if (current === null) throw new Error('no workflow run exists yet; the Lead must call team_flow_plan first')
          requireWritableRun(current, 'team_flow_work')
          state = current
          if (action === 'claim') outcome = { kind: 'claim', item: W.claimItem(current, { itemId, caller: membership.name, now, leaseMinutes: args.lease_minutes, note: args.note }) }
          else if (action === 'release') outcome = { kind: 'release', ...W.releaseItem(current, { itemId, caller: membership.name, now, reason: args.reason }) }
          else if (action === 'request_review') {
            const reviewer = args.reviewer === undefined || args.reviewer === null || String(args.reviewer).trim() === '' ? null : String(args.reviewer).trim()
            if (reviewer !== null && !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(reviewer)) throw new Error(`reviewer "${reviewer}" is not a member name (lower-kebab-case, digits allowed)`)
            if (reviewer !== null && !isLiveMember(ctx, agent, reviewer)) throw new Error(`"${reviewer}" is not in the live roster`)
            outcome = { kind: 'request_review', item: W.findItem(current, itemId), request: W.requestReviewFromPeer(current, { itemId, caller: membership.name, reviewer, now }) }
          }
          else if (action === 'take_review') outcome = { kind: 'take_review', ...W.takeReview(current, { itemId, caller: membership.name, now }) }
          else if (action === 'handoff_offer') {
            const to = assertMemberName(args.to, 'to')
            if (!isLiveMember(ctx, agent, to)) throw new Error(`"${to}" is not in the live roster`)
            outcome = { kind: 'handoff_offer', item: W.findItem(current, itemId), handoff: W.offerHandoff(current, { itemId, caller: membership.name, to, reason: args.reason, now }) }
          } else if (action === 'handoff_accept' || action === 'handoff_decline') {
            outcome = { kind: action, ...W.respondHandoff(current, { itemId, caller: membership.name, accept: action === 'handoff_accept', reason: args.reason, now }) }
          } else {
            throw new Error(`unknown action "${action}"`)
          }
          return current
        })
        const item = outcome.item
        const notifications = []
        const warnings = []
        if (action === 'claim') {
          const taskId = item.taskId
          if (typeof taskId === 'string') {
            try {
              const task = ctx.agentTeams.getTask(agent, taskId)
              if (task.status === 'pending') await ctx.agentTeams.updateTask(agent, { taskId, expectedRevision: task.revision, action: 'claim' })
              else if (task.status !== 'in_progress') warnings.push(`backing Team task ${taskId} is ${task.status}; the board records the claim but the task is not claimable`)
            } catch (error) {
              warnings.push(`backing Team task ${taskId} not claimed: ${error instanceof Error ? error.message : String(error)}`)
            }
          }
          const failure = await sendPeer(ctx, agent, 'lead', `[CLAIM] ${membership.name} claimed ${item.id} "${item.subject}" from the open queue.`, exec.signal)
          if (failure !== null) warnings.push(failure)
        } else if (action === 'release') {
          const taskId = item.taskId
          if (typeof taskId === 'string') {
            try {
              const task = ctx.agentTeams.getTask(agent, taskId)
              if (task.status === 'in_progress') await ctx.agentTeams.updateTask(agent, { taskId, expectedRevision: task.revision, action: 'reopen' })
            } catch (error) {
              warnings.push(`backing Team task ${taskId} not reopened: ${error instanceof Error ? error.message : String(error)}`)
            }
          }
          const failure = await sendPeer(ctx, agent, 'lead', `[HANDOFF] ${membership.name} released ${item.id}${args.reason ? `: ${args.reason}` : '.'}`, exec.signal)
          if (failure !== null) warnings.push(failure)
        } else if (action === 'request_review') {
          const request = outcome.request
          const targets = request.reviewer === null
            ? audienceFor(await store.readState(agent), membership.name)
            : [request.reviewer]
          const text = `[REVIEW] ${membership.name} requests a peer review of ${item.id} "${item.subject}".${request.reviewer === null ? ' This is an open invitation: take it with team_flow_work {action:"take_review", item_id:"' + item.id + '"}.' : ' It is addressed to you; accept with team_flow_work {action:"take_review", item_id:"' + item.id + '"}, or decline in the channel.'}`
          for (const target of targets) {
            const failure = await sendPeer(ctx, agent, target, text, exec.signal)
            if (failure === null) notifications.push(target)
            else warnings.push(failure)
          }
        } else if (action === 'take_review') {
          const owner = item.owner
          if (typeof owner === 'string' && owner.length > 0) {
            const failure = await sendPeer(ctx, agent, owner, `[REVIEW] ${membership.name} accepted the review of ${item.id}; findings will arrive through team_flow_review_submit and the channel.`, exec.signal)
            if (failure === null) notifications.push(owner)
            else warnings.push(failure)
          }
        } else if (action === 'handoff_offer') {
          const failure = await sendPeer(ctx, agent, outcome.handoff.to, `[HANDOFF] ${membership.name} offers you ${item.id} "${item.subject}"${args.reason ? `: ${args.reason}` : '.'}\nAccept with team_flow_work {action:"handoff_accept", item_id:"${item.id}"} or decline with {action:"handoff_decline"}.`, exec.signal)
          if (failure === null) notifications.push(outcome.handoff.to)
          else warnings.push(failure)
        } else {
          const taskId = item.taskId
          if (action === 'handoff_accept' && typeof taskId === 'string') {
            try {
              const task = ctx.agentTeams.getTask(agent, taskId)
              if (task.status === 'pending' || task.status === 'in_progress') {
                await ctx.agentTeams.updateTask(agent, { taskId, expectedRevision: task.revision, action: 'reassign', owner: membership.name })
              }
            } catch (error) {
              warnings.push(`backing Team task ${taskId} not reassigned: ${error instanceof Error ? error.message : String(error)}`)
            }
          }
          const failure = await sendPeer(ctx, agent, outcome.handoff.by, `[HANDOFF] ${membership.name} ${action === 'handoff_accept' ? 'accepted' : 'declined'} ${item.id}${args.reason ? `: ${args.reason}` : '.'}`, exec.signal)
          if (failure === null) notifications.push(outcome.handoff.by)
          else warnings.push(failure)
        }
        triggerOrchestrator(agent)
        if (action === 'take_review' || action === 'claim' || action === 'handoff_accept') {
          refreshMemberTools?.(agent, membership.name, state)
        } else if (action === 'request_review' && outcome.request?.reviewer) {
          refreshMemberTools?.(agent, outcome.request.reviewer, state)
        }
        return {
          item_id: item.id,
          action,
          item_status: item.status,
          owner: item.owner ?? null,
          reviewer: action === 'request_review' ? (outcome.request?.reviewer ?? null) : action === 'take_review' ? membership.name : null,
          notifications,
          warnings,
        }
      },
    },
    {
      name: 'team_flow_decide',
      description:
        'Peer decision protocol: propose/vote/withdraw DoD, scope, or policy changes; Lead resolves ties.',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['propose', 'vote', 'withdraw', 'resolve'], description: 'resolve is Lead-only.' },
          kind: { type: 'string', enum: [...W.PROPOSAL_KINDS], description: 'propose: proposal kind.' },
          item_id: { type: 'string', description: 'propose: item id (omit for team-wide).' },
          text: { type: 'string', description: 'propose: change and rationale.' },
          proposal_id: { type: 'string' },
          vote: { type: 'string', enum: ['yes', 'no', 'abstain'] },
          comment: { type: 'string' },
          timeout_minutes: { type: 'integer', description: 'propose: auto-settle minutes (1-1440).' },
          outcome: { type: 'string', enum: ['accepted', 'rejected'], description: 'resolve: Lead decision.' },
        },
        required: ['action'],
        additionalProperties: false,
      },
      output: jsonOutput({
        type: 'object',
        properties: {
          proposal_id: { type: 'string' },
          status: { type: 'string' },
          kind: {},
          item_id: {},
          deadline: {},
          quorum: {},
          votes: {},
          tally: {},
          resolution: {},
          notifications: { type: 'array', items: { type: 'string' } },
          warnings: { type: 'array', items: { type: 'string' } },
        },
        required: ['proposal_id', 'status'],
      }),
      async execute(args, exec) {
        const { agent, membership } = resolveCaller(ctx, exec, 'team_flow_decide')
        const action = String(args.action ?? '')
        const now = new Date().toISOString()
        const members = ctx.agentTeams.listMembers(agent).map((member) => ({ name: member.name, role: member.role }))
        let outcome = null
        await store.mutateState(agent, (current) => {
          if (current === null) throw new Error('no workflow run exists yet; the Lead must call team_flow_plan first')
          requireWritableRun(current, 'team_flow_decide')
          if (action === 'propose') {
            const proposal = W.proposeDecision(current, { by: membership.name, kind: args.kind, itemId: args.item_id ?? null, text: args.text, timeoutMinutes: args.timeout_minutes, settings: current.settings, members, now })
            outcome = { kind: 'propose', proposal, affected: W.affectedMembersFor(proposal, current, members) }
          } else if (action === 'vote') {
            if (!args.proposal_id) throw new Error('team_flow_decide vote needs proposal_id')
            outcome = { kind: 'vote', ...W.voteDecision(current, { proposalId: String(args.proposal_id), by: membership.name, vote: args.vote, comment: args.comment, members, settings: current.settings, now }) }
          } else if (action === 'withdraw') {
            if (!args.proposal_id) throw new Error('team_flow_decide withdraw needs proposal_id')
            outcome = { kind: 'withdraw', proposal: W.withdrawProposal(current, { proposalId: String(args.proposal_id), caller: membership.name, now }) }
          } else if (action === 'resolve') {
            requireLead(membership, 'team_flow_decide resolve')
            if (!args.proposal_id) throw new Error('team_flow_decide resolve needs proposal_id')
            outcome = { kind: 'resolve', proposal: W.settleProposalByLead(current, { proposalId: String(args.proposal_id), outcome: args.outcome, comment: args.comment, actor: membership.name, now }) }
          } else {
            throw new Error(`unknown action "${action}"`)
          }
          return current
        })
        const notifications = []
        const warnings = []
        const proposal = outcome.proposal
        if (action === 'propose') {
          for (const name of outcome.affected) {
            if (name === membership.name) continue
            const failure = await sendPeer(ctx, agent, name, `[PROPOSAL] ${membership.name} opened ${proposal.id} (${proposal.kind}${proposal.itemId ? ` on ${proposal.itemId}` : ''}): ${proposal.text}\nVote with team_flow_decide {action:"vote", proposal_id:"${proposal.id}", vote:"yes|no|abstain"}.`, exec.signal)
            if (failure === null) notifications.push(name)
            else warnings.push(failure)
          }
        } else if (action === 'vote') {
          const tally = outcome.tally
          if (proposal.by !== membership.name) {
            const failure = await sendPeer(ctx, agent, proposal.by, `[VOTE] ${membership.name} voted ${args.vote ?? 'yes'} on ${proposal.id}; tally yes=${tally.yes} no=${tally.no} abstain=${tally.abstain} of ${tally.affected} affected.`, exec.signal)
            if (failure === null) notifications.push(proposal.by)
            else warnings.push(failure)
          }
          if (outcome.resolution === 'escalated') {
            const failure = await sendPeer(ctx, agent, 'lead', `[DECISION] ${proposal.id} ended in a tie and needs Lead arbitration: ${proposal.text}`, exec.signal)
            if (failure === null) notifications.push('lead')
            else warnings.push(failure)
          }
        } else if (action === 'resolve') {
          for (const name of members.map((member) => member.name)) {
            if (name === membership.name) continue
            const failure = await sendPeer(ctx, agent, name, `[DECISION] The Lead settled ${proposal.id}: ${proposal.resolution ?? ''}`, exec.signal)
            if (failure === null) notifications.push(name)
            else warnings.push(failure)
          }
        } else {
          for (const name of members.map((member) => member.name)) {
            if (name === membership.name) continue
            const failure = await sendPeer(ctx, agent, name, `[PROPOSAL] ${membership.name} withdrew ${proposal.id}.`, exec.signal)
            if (failure === null) notifications.push(name)
            else warnings.push(failure)
          }
        }
        return {
          proposal_id: proposal.id,
          status: proposal.status,
          kind: proposal.kind,
          item_id: proposal.itemId,
          deadline: proposal.deadline ?? null,
          quorum: proposal.quorum ?? null,
          votes: action === 'vote' ? outcome.tally : proposal.votes.length,
          tally: action === 'vote' ? outcome.tally : null,
          resolution: action === 'vote' ? (proposal.resolution ?? null) : (proposal.resolution ?? null),
          notifications,
          warnings,
        }
      },
    },
    {
      name: 'team_flow_read',
      description:
        'Read collaboration inbox: channel tail, proposals, open queue, review invites, handoffs, and item thread.',
      parameters: {
        type: 'object',
        properties: {
          item_id: { type: 'string', description: 'Include item thread/handoffs.' },
          archive_item_id: { type: 'string', description: 'Retrieve archived item report/reviews.' },
          limit: { type: 'integer', description: 'Channel messages limit (default 30, max 100).' },
        },
        additionalProperties: false,
      },
      output: jsonOutput({
        type: 'object',
        properties: {
          channel: { type: 'array', items: {} },
          proposals: { type: 'array', items: {} },
          open_queue: { type: 'array', items: { type: 'string' } },
          my_review_requests: { type: 'array', items: {} },
          my_handoffs: { type: 'array', items: {} },
          questions_to_me: { type: 'array', items: {} },
          item: {},
          archived_item: {},
          next_actions: { type: 'array', items: { type: 'string' } },
          warnings: { type: 'array', items: { type: 'string' } },
        },
      }),
      async execute(args, exec) {
        const { agent, membership } = resolveCaller(ctx, exec, 'team_flow_read')
        let state = await requireRun(store, agent, 'team_flow_read')
        W.ensureCollaboration(state)
        {
          const liveMembers = (() => { try { return ctx.agentTeams.listMembers(agent).map((member) => ({ name: member.name, role: member.role })) } catch { return [] } })()
          const settled = W.settleExpiredProposals(state, { now: new Date().toISOString(), settings: state.settings, members: liveMembers })
          if (settled.length > 0) await store.writeState(agent, state)
        }
        const limit = Math.min(Math.max(Number.isInteger(args.limit) ? args.limit : 30, 1), 100)
        const members = ctx.agentTeams.listMembers(agent).map((member) => ({ name: member.name, role: member.role }))
        const summary = W.collaborationSummary(state, { me: membership.name, role: membership.role, members })
        const itemId = args.item_id === undefined || args.item_id === null || String(args.item_id).trim() === '' ? null : String(args.item_id).trim()
        let item = null
        if (itemId !== null) {
          const found = W.findItem(state, itemId)
          item = {
            id: found.id,
            subject: found.subject,
            status: found.status,
            owner: found.owner ?? null,
            assignment: found.assignment ?? 'lead',
            claim: found.claim ?? null,
            pending_reviewer: W.pendingReview(found)?.reviewer ?? null,
            review_requests: found.reviewRequests ?? [],
            handoffs: found.handoffs ?? [],
            handoff_packet: found.handoffPacket ?? null,
            definition_of_done: found.definitionOfDone,
            open_proposals: W.openBlockingProposals(state, found.id).map((proposal) => proposal.id),
          }
        }
        const archiveItemId = args.archive_item_id === undefined || args.archive_item_id === null || String(args.archive_item_id).trim() === '' ? null : String(args.archive_item_id).trim()
        let archivedItem = null
        if (archiveItemId !== null) {
          archivedItem = await store.readArchivedItem(agent, archiveItemId)
        }
        const channelSource = itemId === null
          ? state.channel
          : state.channel.filter((message) => message.refs?.itemId === itemId)
        const channel = channelSource.slice(-limit).map((message) => ({
          id: message.id,
          at: message.at,
          from: message.from,
          to: message.to,
          kind: message.kind,
          text: message.text,
          reply_to: message.replyTo ?? null,
          item_id: message.refs?.itemId ?? null,
          finding_id: message.refs?.findingId ?? null,
          proposal_id: message.refs?.proposalId ?? null,
        }))
        const proposals = state.proposals.map((proposal) => {
          const affected = W.affectedMembersFor(proposal, state, members)
          return {
            id: proposal.id,
            kind: proposal.kind,
            item_id: proposal.itemId,
            by: proposal.by,
            status: proposal.status,
            text: proposal.text,
            tally: W.tallyProposal(proposal, affected),
            votes: proposal.votes.map((vote) => ({ by: vote.by, vote: vote.vote, comment: vote.comment })),
            resolution: proposal.resolution ?? null,
          }
        })
        return {
          channel,
          proposals,
          open_queue: summary.open_queue,
          my_review_requests: summary.review_invites,
          my_handoffs: summary.handoffs_to_me,
          questions_to_me: summary.questions_to_me,
          item,
          archived_item: archivedItem,
          next_actions: W.nextActions(state, { me: { name: membership.name, role: membership.role }, role: membership.role, members, settings: state.settings }),
          warnings: [],
        }
      },
    },
  ]
}
