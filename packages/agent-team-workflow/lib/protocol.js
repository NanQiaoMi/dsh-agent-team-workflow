/**
 * Text rendering: the injected protocol, the per-role spawn briefs, the
 * structured peer notifications, and the final run report.
 *
 * Keeping every model-facing string here makes the protocol reviewable as
 * prose, separate from the state machine that enforces it.
 */

import { outstandingReviewers, pendingReview, submittedRounds, unresolvedFindings } from './workflow.js'

/** Role names with a dedicated duty line; other roles get a generic duty. */
export const ROLE_DUTIES = Object.freeze({
  implementer: 'Own the deliverable end to end: implement the change, verify it with real commands, and report evidence.',
  verifier: 'Own verification: derive checks from the definition of done, run them, and report exact commands with exit codes and quoted output. You must not edit the implementation you are verifying unless your item explicitly says so.',
  researcher: 'Own investigation: answer the open question with primary sources, quote them, and report findings plus remaining uncertainty. Prefer read-only work; write only inside your declared scope.',
  architect: 'Own the design decision: compare options, state the chosen approach and its tradeoffs, and record it where the definition of done requires. Keep it implementable.',
  writer: 'Own documentation: make it accurate against the real code, runnable as written, and consistent with the acceptance criteria.',
  reviewer: 'Own independent review: inspect the artifact adversarially against the definition of done and evidence, and report severity-tagged findings.',
})

/** @returns the duty text for one role. */
export function roleDuty(role) {
  return ROLE_DUTIES[role] ?? 'Own the assigned item, apply the team protocol, and report verifiable evidence.'
}

/** Render the role-specific guidance for one member, or an empty string. */
export function roleGuidance(settings, role) {
  const def = typeof role === 'string' && role.length > 0 ? settings?.roles?.[role] : undefined
  if (def === undefined || typeof def.prompt !== 'string' || def.prompt.length === 0) return ''
  return `\n\n# Role: ${role}\n${def.prompt}`
}

/**
 * Render the workflow protocol injected into every Team member system prompt.
 * Tailors instructions by role to minimize token overhead while maximizing instruction following.
 * @param settings - effective plugin settings.
 * @param role - optional member role ('lead', 'reviewer', 'worker', 'implementer', etc.)
 * @returns prompt section text.
 */
export function buildPolicy(settings, role = null) {
  if (role && (role === 'implementer' || role === 'worker' || role === 'writer' || role === 'coder')) {
    return `## Agent Team Workflow (Worker Protocol)

You are an implementing teammate. Do NOT plan, delegate, or spawn. Work directly inside your assigned scope.

1. Worktree & Scopes: Perform ALL file edits and test executions inside your assigned git worktree directory. Only touch files declared in your write scope.
2. Direct Execution: Your task is already claimed for you upon dispatch. Do NOT call team_flow_status to check state or claim again. Directly edit files and verify with real shell commands.
3. Reporting: When work is verified, call \`team_flow_report\` with: \`item_id\`, \`summary\`, \`files\`, \`commands\` (including integer exit_code), and \`evidence\`.
4. Review & Respond: If your reviewer requests changes, fix the code in your worktree, run tests, and answer findings with \`team_flow_review_respond\`.
5. Non-negotiable: Never edit files outside your declared scope or another member's worktree. Never edit .agentteam metadata files.

Peer & communication rules:
- The Team channel is the coordination surface: ask with team_flow_talk (kind:"question"), answer with kind:"answer" + reply_to, and claim/announce work through the tools.
- After reporting, invite a peer reviewer with team_flow_work {action:"request_review", item_id, reviewer?}; accept invitations only when independent.
- Disagreements about a definition of done or scope go through team_flow_decide proposals and votes, never silent deviation.
- If work outside the plan appears, create it with team_flow_item instead of expanding your scope.
- Message the Lead with send_message({target:"lead"}) or a peer by name, prefixing [BLOCKER]/[QUESTION]/[HANDOFF] and the item id.`
  }

  if (role && (role === 'reviewer' || role === 'verifier' || role === 'auditor')) {
    return `## Agent Team Workflow (Reviewer Protocol)

You are an independent adversarial reviewer. Do NOT modify the author's code or files.

1. Inspect Real Changes: When notified of a pending review, inspect the provided Git Diff and test exit codes. Re-run verification in the author's worktree if needed.
2. Submit Verdict: Call \`team_flow_review_submit\` with:
   - \`verdict\`: 'approve' (or 'approve_with_nits', 'request_changes', 'block')
   - \`summary\`: One paragraph assessment
   - \`evidence_checked\`: Mandatory list of commands/diffs/files you actually checked
   - \`findings\`: If requesting changes, provide file, line, severity, and exact actionable critique.
3. Independence: Never fix what you review; keep your role strictly adversarial and objective.

Peer & communication rules:
- Clarify with the author in the channel (team_flow_talk), keep the thread on the board, and vote on proposals that affect your reviewed items.
- Accept peer review invitations only when independent; never review your own work.
- Create a follow-up item (team_flow_item) for out-of-scope findings instead of fixing them yourself.
- Message the Lead with [BLOCKER] for hard disagreements instead of approving under pressure.`
  }

  return `## Agent Team Workflow

This Team runs the standard injected workflow: plan → parallel independent execution → mutual review → quality gates → convergence. The workflow board is authoritative. Call \`team_flow_status\` before acting; treat its \`next_actions\` list as your assignment and re-read it after every state change.

Phases and ownership:
- **Plan (Lead only).** \`team_flow_plan\` turns the objective into work items. Each item carries an owner, a disjoint write scope, a definition of done, dependencies, and at least one independent reviewer. Planning refuses circular dependencies, self-review, and write-scope overlap inside one execution wave.
- **Staff (Lead only).** Spawn one teammate per work item using the exact \`spawn\` prompt the plan returns, with \`context: "${settings.workerContext}"\`. Never paraphrase a spawn brief: it contains the scope, the definition of done, and the protocol the worker is graded on.
- **Execute (parallel, independent).** A worker claims its backing shared task (\`team_task_update\` action \`claim\` with the current revision), edits only its declared write scope, and reports through \`team_flow_report\` with files, commands that carry integer \`exit_code\`, quoted evidence, open questions, and risks.
- **Review (mutual, adversarial).** The assigned reviewer inspects the author's real files and evidence, then submits \`team_flow_review_submit\` with a verdict and severity-tagged findings that name a file and line. Approving without evidence is a gate failure, not a shortcut.
- **Respond (author).** The author answers *every* finding through \`team_flow_review_respond\` with \`fixed\`, \`rebut\`, or \`accepted_risk\` plus evidence. A rebutted blocker escalates to the Lead for arbitration. Review rounds are capped at ${settings.maxReviewRounds}; when they run out the engine escalates instead of letting a loop spin.
- **Gate and converge (Lead only).** \`team_flow_gate\` checks report presence, evidence quality, reviewer approval, unresolved findings, write-scope discipline, and blocking escalations. Only a passing gate may finalize the run and write the report.

Peer collaboration (workflow v2):
- **Direct peer channel.** \`team_flow_talk\` posts to the Team channel or to one member and delivers it through the native Team transport. Ask the peer who owns the interface you depend on, answer questions addressed to you, and record objections where the board can replay them. Do not route peer coordination through the Lead.
- **Open queue.** Items planned with \`assignment:"open"\` are unowned. Claim one with \`team_flow_work {action:"claim", item_id}\`, then work and report exactly like an assigned item. Release it if you cannot finish.
- **Peer review by invitation.** After reporting, invite a peer with \`team_flow_work {action:"request_review", item_id, reviewer?}\`; omit \`reviewer\` to publish an open invitation any peer can take with \`{action:"take_review"}\`. Discuss findings with the author in the channel before submitting a verdict.
- **Negotiation and votes.** Disagreement about a definition of done, scope, or the plan is a proposal: \`team_flow_decide {action:"propose", kind, item_id?, text}\`. Every affected member (the item owner and reviewers, or the whole Team) votes once with \`{action:"vote", proposal_id, vote:"yes|no|abstain"}\`. Accepted \`dod\` proposals amend the item's definition of done. Ties escalate to the Lead.
- **Handoffs.** An owner may offer an unfinished item to a peer with \`team_flow_work {action:"handoff_offer", item_id, to}\`; the peer accepts or declines with \`handoff_accept\`/\`handoff_decline\`. Ownership transfers only after acceptance.
- **Own the work you discover.** When the plan misses something (a missing example, an untested branch, a contract bug), add it yourself with \`team_flow_item\` instead of waiting for the Lead: give it a write scope and a definition of done, and it joins the same review and gate rules. Use \`owner:"open"\` if a peer should pick it up.
- **Decisions have a clock.** Proposals auto-settle after the configured deadline (majority of affected members is the quorum; ties and missed quorums escalate to the Lead). Vote before the deadline or the decision happens without you.
- **Read the board.** \`team_flow_read\` returns the channel tail, open queue, your review invitations, handoffs offered to you, unanswered questions addressed to you, and open proposals awaiting your vote.

Non-negotiable rules:
- **Independence.** Work only inside your declared write scope. Reviewers never edit the author's files and never fix what they review. Every member reasons from its own context and its own evidence; state assumptions instead of relying on another member's conversation.
- **Evidence over assertion.** A claim without a path, command, exit code, or quoted output is not verification. Unknowns go in \`open_questions\` and \`risks\`, not into a confident summary.
- **Communication.** Use \`send_message\` with a self-contained message; prefix \`[BLOCKER]\`, \`[QUESTION]\`, \`[REVIEW]\`, or \`[HANDOFF]\` and the item id. A successful send does not mean the peer has processed it, so re-read \`team_flow_status\` after a reply. Never assume a peer's silent agreement.
- **Escalate instead of stalling.** Use \`team_flow_escalate\` for a genuine blocker, conflicting requirements, a scope change, or exhausted review rounds. The Lead must resolve blocking escalations before the gate can pass.
- **Board hygiene.** The plugin owns the \`.agentteam\` artifact directory; never edit \`state.json\` or the report by hand. Use the tools so every transition is auditable.
- **No unilateral scope creep.** If the work needs files outside your scope, escalate \`scope_change\` rather than editing them.`
}

/** @returns a bullet list, or one placeholder line when empty. */
function clipText(value, max) {
  const text = String(value ?? '')
  return text.length > max ? `${text.slice(0, max)}…` : text
}

function bullets(values, empty = '(none)') {
  if (!Array.isArray(values) || values.length === 0) return `- ${empty}`
  return values.map((value) => `- ${value}`).join('\n')
}


/**
 * Render the spawn brief for one member of the open-queue claim pool.
 * @param state - run state.
 * @param name - teammate name to spawn.
 * @param items - items published with `assignment:"open"`.
 * @param contextMode - `fresh` (default) or `fork`, from plugin settings.
 * @returns `{ description, prompt, context }` to pass to `spawn_teammate`.
 */
export function renderQueueBrief(state, name, items, contextMode = 'fresh') {
  const queue = items
    .map((item) => `- ${item.id} — "${item.subject}" (role: ${item.role}; scope: ${item.writeScopes.join(', ') || 'n/a'})`)
    .join('\n')
  const prompt = `You are teammate "${name}" in an Agent Team. Your Team Lead is "lead". You are a worker in the open-queue pool: work items are published unowned and you claim what you can do.

# Team mission
Objective: ${state.objective}

Acceptance criteria (team-level):
${bullets(state.acceptanceCriteria)}

Team constraints:
${bullets(state.constraints)}

# Open queue
${queue}

# How you get work
1. Call team_flow_read and team_flow_status; both show the open queue and your next_actions.
2. Claim one item that matches your ability and its dependencies are approved: \`team_flow_work {action:"claim", item_id:"<id>"}\`. Claiming also claims the shared task. Do not claim two items in the same wave.
3. Do the work inside the item's declared write scope, verify with real commands, then call team_flow_report exactly like an assigned item (summary, files, commands with integer exit_code, evidence, risks).
4. If you cannot finish, release it (\`{action:"release", item_id}\`) so a peer can take it, or offer a handoff.
5. If the queue is empty or nothing is claimable, read the channel, then stop and wait for a peer message.

# Peer collaboration
- The Team channel is the coordination surface: ask peers with \`team_flow_talk\` (kind:"question"), answer with kind:"answer" + reply_to, and claim/announce work through the tools so the board shows who is doing what.
- After reporting, invite a peer reviewer: \`team_flow_work {action:"request_review", item_id, reviewer?}\`.
- Disagreements about a definition of done or scope go through \`team_flow_decide\` proposals and votes, not silent deviation.
- Never edit another member's write scope, the .agentteam artifacts, or the review of your own work.

# Independence rules
- You share the filesystem and boards with the Team, not the Lead's conversation; state assumptions and quote your evidence.
- Never spawn teammates or delegate; you are a leaf worker.
- Report honestly: the gate cross-checks files, commands, exit codes, and write scope.`
  return {
    name,
    description: `Open-queue worker for ${items.map((item) => item.id).join(', ') || 'the team'}`.slice(0, 200),
    context: contextMode === 'fork' ? 'fork' : 'fresh',
    prompt,
  }
}

/**
 * Render the self-contained spawn brief for one work item.
 * @param state - run state.
 * @param item - work item.
 * @param reviewing - item ids this same member also reviews (it owns another
 *   item, so it must not be spawned twice); empty when it only produces work.
 * @param contextMode - `fresh` (default) or `fork`, from plugin settings.
 * @returns `{ description, prompt, context }` to pass to `spawn_teammate`.
 */
/** @returns a worktree-isolation paragraph for the brief, or ''. */
function worktreeLine(item) {
  const worktree = item?.git?.worktreePath
  if (typeof worktree !== 'string' || worktree.length === 0) return ''
  const branch = item?.git?.worktreeBranch ?? '(unknown branch)'
  return `Worktree isolation: do ALL of your work inside this git worktree — ${worktree}
Its branch is "${branch}" (already checked out there). Paths in your write scope and in the report are relative to that worktree directory, not the Lead's checkout. Never edit the Lead's checkout; commit with team_flow_git {action:"commit", item_id:"${item.id}"} and let the Lead merge the branch.`
}

export function renderWorkerBrief(state, item, reviewing = [], contextMode = 'fresh') {
  const lead = 'lead'
  const blockers = item.blockedBy.length === 0 ? '(none)' : item.blockedBy.join(', ')
  const failureMode = item.evidenceOptional === true ? 'This item is marked evidence-optional: state what you verified and what you could not verify.' : 'At least one real command with an integer exit code is mandatory for this item.'
  const prompt = `You are teammate "${item.owner}" in an Agent Team. Your Team Lead is "${lead}". You are the owner of workflow item ${item.id}.

# Team mission
Objective: ${state.objective}

Acceptance criteria (team-level):
${bullets(state.acceptanceCriteria)}

Team constraints:
${bullets(state.constraints)}

# Your work item: ${item.id} — ${item.subject}
Role: ${item.role}. ${roleDuty(item.role)}

Definition of done:
${bullets(item.definitionOfDone)}

Write scope — you may create or modify ONLY these workspace-relative paths:
${bullets(item.writeScopes, 'no explicit scope (stay minimal and say what you touched)')}
Do not modify anything outside this scope. Other members are editing their own scopes concurrently; overlapping edits corrupt the run.
${worktreeLine(item)}

Dependencies: ${blockers}. Do not start until every dependency is approved (team_flow_status shows readiness).
Backing shared task: ${item.taskId ?? '(none)'} — automatically claimed upon dispatch (inspect details via team_task_get if needed). You may begin implementation immediately.

# Independence rules
- You start with a fresh context: you share the filesystem, the shared task board, and the workflow board, not the Lead's conversation. State assumptions you rely on.
- Never spawn teammates or delegate; you are a leaf worker.
- Never edit .agentteam artifacts or another member's files.
- ${failureMode}
- Report honestly. The Lead's gate cross-checks your declared files, commands, and scope.

${reviewing.length === 0 ? '' : `
# Additional duty: independent reviewer
You also review these items, because one member cannot be spawned twice: ${reviewing.join(', ')}.
- Never edit a reviewed author's files and never fix what you review; keep your author and reviewer roles separate in your own reasoning.
- When team_flow_status shows a pending review assigned to you, follow the review protocol: inspect the real files and the author's evidence, then call team_flow_review_submit with a verdict, severity-tagged findings (file + line + claim), and evidence_checked.
`}
Before acting call team_flow_read/team_flow_status; peer, proposal, review-invite and item-creation rules are in TEAM_POLICY.

# Required workflow
1. The backing task is already claimed for you. Work directly inside your assigned write scope and worktree.
2. Verify by running the actual test/lint commands.
3. Call team_flow_report with: summary, files (workspace-relative), commands [{command, exit_code, note}], evidence (quoted output or paths), open_questions, risks, deviation (what you did differently, or omit).
4. A reviewer will inspect your work. If changes are requested, fix them and call team_flow_review_respond with one response per finding id (fixed | rebut | accepted_risk) plus evidence.
5. When no action is assigned to you, stop. The Lead or Orchestrator will message you.

Do not send a "done" message instead of reporting: the report tool is the deliverable.`
  return {
    name: item.owner,
    description: `${item.role} for ${item.id}: ${item.subject}`.slice(0, 200),
    context: contextMode === 'fork' ? 'fork' : 'fresh',
    prompt,
  }
}

/**
 * Render the self-contained spawn brief for one reviewer.
 * @param state - run state.
 * @param reviewer - reviewer member name.
 * @param items - items this reviewer reviews.
 * @returns `{ name, description, context, prompt }`.
 */
export function renderReviewerBrief(state, reviewer, items) {
  const scope = items
    .map((item) => {
      const wt = item.git?.worktreePath ? `; worktree: ${item.git.worktreePath}` : ''
      return `- ${item.id} — "${item.subject}" (owner: ${item.owner}; scope: ${item.writeScopes.join(', ') || 'n/a'}${wt})`
    })
    .join('\n')
  const dod = items.map((item) => `### ${item.id}\nDefinition of done:\n${bullets(item.definitionOfDone)}`).join('\n\n')
  const prompt = `You are teammate "${reviewer}" in an Agent Team. Your Team Lead is "lead". You are an independent reviewer, not an implementer.

# Team mission
Objective: ${state.objective}

Acceptance criteria (team-level):
${bullets(state.acceptanceCriteria)}

# Items you review
${scope || '- none yet'}

${dod}

# Review protocol
1. Call team_flow_status. It lists the reviews currently assigned to you and the exact next actions.
2. For each assigned item: read the author's report (files, commands with exit codes, evidence, risks) and then read the actual files (in the item's worktree if worktree isolation is active). Re-run cheap verification yourself when practical; treat unverified claims as unverified.
3. Check at minimum: definition-of-done coverage; correctness and edge cases; scope discipline (did the author touch files outside its scope); quality of evidence; missing tests; interface and contract consistency; silent placeholders or TODO stubs; unstated risk.
4. Submit with team_flow_review_submit: verdict (approve | approve_with_nits | request_changes | block), a summary, findings [{id, severity: blocker|major|minor|nit, file, line, claim, suggestion}], and evidence_checked (what you actually inspected).
5. A non-approving verdict must carry at least one finding, and every finding must name a file (and line when possible) plus a concrete claim. Blockers need a reproduction or a precise reasoning chain, never taste.
6. Independence: never modify the author's files, never fix the code you review, never let the author's summary stand in for your own inspection. You have a fresh context on purpose.
7. After submitting you go idle; the Lead or author will notify you for the next round. Do not poll.

Peer, proposal and communication rules are in TEAM_POLICY; round budget per item is ${state.settings.maxReviewRounds}.`
  return {
    name: reviewer,
    description: `Independent reviewer for ${items.map((item) => item.id).join(', ') || 'assigned items'}`.slice(0, 200),
    context: 'fresh',
    prompt,
  }
}

/** @returns a compact findings digest for a peer notification. */
export function findingDigest(review, maxFindings = 8) {
  if (review.findings.length === 0) return '- (no findings)'
  const findings = review.findings.slice(0, maxFindings)
  const lines = findings.map((finding) => {
    const claim = String(finding.claim ?? '')
    const clipped = claim.length > 400 ? `${claim.slice(0, 400)}…` : claim
    return `- ${finding.id} [${finding.severity}] ${finding.file ?? '(no file)'}${finding.line ? `:${finding.line}` : ''} — ${clipped}`
  })
  if (review.findings.length > maxFindings) lines.push(`- … ${review.findings.length - maxFindings} more finding(s); read the review record for the rest.`)
  return lines.join('\n')
}

/**
 * Render the message the engine sends when a review becomes pending.
 * @param state - run state.
 * @param item - item under review.
 * @returns self-contained message text.
 */
export function reviewRequestMessage(state, item, diff = null) {
  const review = pendingReview(item)
  const report = item.report
  const wt = item.git?.worktreePath ? `\nWorktree path: ${item.git.worktreePath}` : ''
  const diffSection = diff ? `\n\n# Code Changes (Diff)\n${diff}` : ''
  return `[REVIEW] ${item.id} "${item.subject}" is ready for your review (round ${review?.round ?? '?'}).${wt}

Author: ${item.owner}
Files reported:
${bullets(report?.files ?? [])}
Commands reported:
${bullets((report?.commands ?? []).map((command) => `\`${command.command}\` → exit ${command.exitCode}`))}
Author summary: ${clipText(report?.summary ?? '(missing)', 900)}
Author-declared risks: ${bullets((report?.risks ?? []).slice(0, 3).map((risk) => clipText(risk, 200)), 'none')}${diffSection}

Definition of done:
${bullets(item.definitionOfDone)}

Action: inspect the changes and evidence above, then call team_flow_review_submit with a verdict, findings, and evidence_checked. Run id ${state.runId}.`
}

/**
 * Render the message the engine sends to the author after a non-approving review.
 * @param state - run state.
 * @param item - item reviewed.
 * @param review - submitted review.
 * @returns self-contained message text.
 */
export function changesRequestedMessage(state, item, review) {
  return `[REVIEW] ${item.id} "${item.subject}" — verdict: ${review.verdict} (round ${review.round}) by ${review.reviewer}.

Reviewer summary: ${clipText(review.summary || '(none)', 700)}

Findings:
${findingDigest(review)}

Evidence the reviewer checked: ${bullets((review.evidenceChecked ?? []).slice(0, 5).map((entry) => clipText(entry, 240)), 'not declared')}

Action: fix what is valid, then call team_flow_review_respond with one response per finding id (fixed | rebut | accepted_risk) and the evidence for each. A rebutted blocker is escalated to the Lead. Run id ${state.runId}.`
}

/**
 * Render the message the engine sends to the author after approval.
 * @param state - run state.
 * @param item - approved item.
 * @param review - approving review.
 * @returns self-contained message text.
 */
export function approvedMessage(state, item, review) {
  const remaining = outstandingReviewers(item)
  return `[REVIEW] ${item.id} "${item.subject}" — approved (round ${review.round}) by ${review.reviewer}${remaining.length > 0 ? `; still awaiting: ${remaining.join(', ')}` : '; all required reviewers have approved'}.

Reviewer summary: ${review.summary || '(none)'}

Action: ${item.status === 'approved' ? 'nothing further for this item; stop unless the Lead assigns more work.' : 'no action is assigned to you for this item right now.'} Run id ${state.runId}.`
}

/**
 * Render the human-readable run report written at finalize.
 * @param state - run state with the accepted gate result.
 * @param gate - gate result from `team_flow_gate`.
 * @returns markdown report.
 */
export function renderReportMarkdown(state, gate) {
  const lines = []
  lines.push(`# Agent Team Workflow Report — ${state.runId}`)
  lines.push('')
  lines.push(`- Phase: **${state.phase}**`)
  lines.push(`- Created: ${state.createdAt}`)
  lines.push(`- Finalized: ${state.finalizedAt ?? '(not finalized)'}`)
  lines.push(`- Team Lead: ${state.teamId ? 'recorded' : 'unrecorded'}`)
  lines.push('')
  lines.push('## Objective')
  lines.push('')
  lines.push(state.objective)
  lines.push('')
  lines.push('## Acceptance criteria')
  lines.push('')
  for (const criterion of state.acceptanceCriteria) lines.push(`- [ ] ${criterion}`)
  if (state.constraints.length > 0) {
    lines.push('')
    lines.push('## Constraints')
    lines.push('')
    for (const constraint of state.constraints) lines.push(`- ${constraint}`)
  }
  lines.push('')
  lines.push('## Execution waves and work items')
  lines.push('')
  for (const item of state.items) {
    const itemGate = gate.itemGates.find((candidate) => candidate.id === item.id)
    lines.push(`### ${item.id} — ${item.subject}`)
    lines.push('')
    lines.push(`- Owner: ${item.owner} (${item.role})`)
    lines.push(`- Status: ${item.status}${itemGate?.overridden ? ' (Lead override)' : ''}`)
    lines.push(`- Write scope: ${item.writeScopes.join(', ') || '(none declared)'}`)
    lines.push(`- Dependencies: ${item.blockedBy.join(', ') || '(none)'}`)
    lines.push(`- Backing shared task: ${item.taskId ?? '(none)'}`)
    lines.push(`- Definition of done: ${item.definitionOfDone.join('; ')}`)
    if (item.report !== null) {
      lines.push('')
      lines.push(`**Report:** ${item.report.summary}`)
      lines.push('')
      lines.push('Files:')
      for (const file of item.report.files) lines.push(`- \`${file}\``)
      if (item.report.commands.length > 0) {
        lines.push('')
        lines.push('Commands:')
        for (const command of item.report.commands) lines.push(`- \`${command.command}\` → exit ${command.exitCode}${command.note ? ` (${command.note})` : ''}`)
      }
      if (item.report.evidence.length > 0) {
        lines.push('')
        lines.push('Evidence:')
        for (const evidence of item.report.evidence) lines.push(`- ${evidence}`)
      }
      if (item.report.openQuestions.length > 0) {
        lines.push('')
        lines.push('Open questions:')
        for (const question of item.report.openQuestions) lines.push(`- ${question}`)
      }
      if (item.report.risks.length > 0) {
        lines.push('')
        lines.push('Risks:')
        for (const risk of item.report.risks) lines.push(`- ${risk}`)
      }
    }
    if (item.reviews.length > 0) {
      lines.push('')
      lines.push('Reviews:')
      for (const review of item.reviews) {
        lines.push(`- round ${review.round} by ${review.reviewer}: **${review.verdict ?? review.status}** — ${review.summary || '(no summary)'}`)
        for (const finding of review.findings) {
          const resolution = finding.resolution === null ? 'unresolved' : `${finding.resolution.state}${finding.resolution.evidence ? ` (${finding.resolution.evidence})` : ''}`
          lines.push(`  - ${finding.id} [${finding.severity}] ${finding.file ?? ''}${finding.line ? `:${finding.line}` : ''} — ${finding.claim} → ${resolution}`)
        }
      }
    }
    if (itemGate !== undefined && itemGate.warnings.length > 0) {
      lines.push('')
      lines.push('Gate warnings:')
      for (const warning of itemGate.warnings) lines.push(`- ${warning}`)
    }
    lines.push('')
  }
  if (state.escalations.length > 0) {
    lines.push('## Escalations')
    lines.push('')
    for (const escalation of state.escalations) {
      lines.push(`- ${escalation.id} [${escalation.kind}] ${escalation.subject} — ${escalation.resolved ? `resolved by ${escalation.resolvedBy}: ${escalation.resolution}` : 'OPEN'}`)
      lines.push(`  - ${escalation.detail}`)
    }
    lines.push('')
  }
  lines.push('## Gate result')
  lines.push('')
  const overriddenItems = gate.itemGates.filter((itemGate) => itemGate.overridden)
  lines.push(
    overriddenItems.length === 0
      ? (gate.pass ? 'All required gates passed.' : 'Gate did not pass.')
      : `All required gates passed, with ${overriddenItems.length} item(s) explicitly accepted by Lead override: ${overriddenItems.map((itemGate) => itemGate.id).join(', ')}.`,
  )
  if (gate.teamFailures.length > 0) {
    for (const failure of gate.teamFailures) lines.push(`- team failure: ${failure}`)
  }
  lines.push('')
  lines.push('| item | pass | failures | warnings |')
  lines.push('| --- | --- | --- | --- |')
  for (const itemGate of gate.itemGates) {
    lines.push(`| ${itemGate.id} | ${itemGate.pass ? 'yes' : 'no'} | ${itemGate.failures.join('; ') || '-'} | ${itemGate.warnings.join('; ') || '-'} |`)
  }
  lines.push('')
  lines.push('## Audit trail (tail)')
  lines.push('')
  for (const event of state.events.slice(-40)) lines.push(`- ${event.at} [${event.type}] ${event.actor}: ${event.detail}`)
  lines.push('')
  return lines.join('\n')
}

/** @returns a compact human summary of one item's review state. */
export function reviewStatusLine(item) {
  if (item.needsReview === false) return 'no review required'
  const pending = pendingReview(item)
  if (pending !== null) return `round ${pending.round} pending with ${pending.reviewer}`
  const latest = item.reviews.filter((review) => review.status !== 'pending').at(-1)
  if (latest === undefined) return `${submittedRounds(item)} round(s) submitted`
  return `latest round ${latest.round}: ${latest.verdict} by ${latest.reviewer}`
}
