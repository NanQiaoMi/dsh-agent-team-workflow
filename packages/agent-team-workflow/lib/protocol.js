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

/**
 * Render the workflow protocol injected into every Team member system prompt.
 * @param settings - effective plugin settings.
 * @returns prompt section text.
 */
export function buildPolicy(settings) {
  return `## Agent Team Workflow

This Team runs the standard injected workflow: plan → parallel independent execution → mutual review → quality gates → convergence. The workflow board is authoritative. Call \`team_flow_status\` before acting; treat its \`next_actions\` list as your assignment and re-read it after every state change.

Phases and ownership:
- **Plan (Lead only).** \`team_flow_plan\` turns the objective into work items. Each item carries an owner, a disjoint write scope, a definition of done, dependencies, and at least one independent reviewer. Planning refuses circular dependencies, self-review, and write-scope overlap inside one execution wave.
- **Staff (Lead only).** Spawn one teammate per work item using the exact \`spawn\` prompt the plan returns, with \`context: "${settings.workerContext}"\`. Never paraphrase a spawn brief: it contains the scope, the definition of done, and the protocol the worker is graded on.
- **Execute (parallel, independent).** A worker claims its backing shared task (\`team_task_update\` action \`claim\` with the current revision), edits only its declared write scope, and reports through \`team_flow_report\` with files, commands that carry integer \`exit_code\`, quoted evidence, open questions, and risks.
- **Review (mutual, adversarial).** The assigned reviewer inspects the author's real files and evidence, then submits \`team_flow_review_submit\` with a verdict and severity-tagged findings that name a file and line. Approving without evidence is a gate failure, not a shortcut.
- **Respond (author).** The author answers *every* finding through \`team_flow_review_respond\` with \`fixed\`, \`rebut\`, or \`accepted_risk\` plus evidence. A rebutted blocker escalates to the Lead for arbitration. Review rounds are capped at ${settings.maxReviewRounds}; when they run out the engine escalates instead of letting a loop spin.
- **Gate and converge (Lead only).** \`team_flow_gate\` checks report presence, evidence quality, reviewer approval, unresolved findings, write-scope discipline, and blocking escalations. Only a passing gate may finalize the run and write the report.

Non-negotiable rules:
- **Independence.** Work only inside your declared write scope. Reviewers never edit the author's files and never fix what they review. Every member reasons from its own context and its own evidence; state assumptions instead of relying on another member's conversation.
- **Evidence over assertion.** A claim without a path, command, exit code, or quoted output is not verification. Unknowns go in \`open_questions\` and \`risks\`, not into a confident summary.
- **Communication.** Use \`send_message\` with a self-contained message; prefix \`[BLOCKER]\`, \`[QUESTION]\`, \`[REVIEW]\`, or \`[HANDOFF]\` and the item id. A successful send does not mean the peer has processed it, so re-read \`team_flow_status\` after a reply. Never assume a peer's silent agreement.
- **Escalate instead of stalling.** Use \`team_flow_escalate\` for a genuine blocker, conflicting requirements, a scope change, or exhausted review rounds. The Lead must resolve blocking escalations before the gate can pass.
- **Board hygiene.** The plugin owns the \`.agentteam\` artifact directory; never edit \`state.json\` or the report by hand. Use the tools so every transition is auditable.
- **No unilateral scope creep.** If the work needs files outside your scope, escalate \`scope_change\` rather than editing them.`
}

/** @returns a bullet list, or one placeholder line when empty. */
function bullets(values, empty = '(none)') {
  if (!Array.isArray(values) || values.length === 0) return `- ${empty}`
  return values.map((value) => `- ${value}`).join('\n')
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

Dependencies: ${blockers}. Do not start until every dependency is approved (team_flow_status shows readiness).
Backing shared task: ${item.taskId ?? '(none)'} — read it with team_task_get (or team_flow_status item_id="${item.id}" for the current revision), then claim it with team_task_update {task_id, expected_revision, action:"claim"}.

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
# Required workflow
1. Call team_flow_status and read your next_actions.
2. Claim the backing shared task, then do the work.
3. Verify by running the actual commands.
4. Call team_flow_report with: summary, files (workspace-relative), commands [{command, exit_code, note}], evidence (quoted output or paths), open_questions, risks, deviation (what you did differently, or omit).
5. A reviewer will inspect your work. If changes are requested, fix them and call team_flow_review_respond with one response per finding id (fixed | rebut | accepted_risk) plus evidence.
6. When no action is assigned to you, stop. The Lead will message you.

# Communication
- Message the Lead with send_message({target:"lead"}) or a peer by member name. Prefix [BLOCKER]/[QUESTION]/[HANDOFF] and the item id.
- Raise a real blocker with team_flow_escalate instead of idling silently.
- Do not send a "done" message instead of reporting: the report tool is the deliverable.`
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
    .map((item) => `- ${item.id} — "${item.subject}" (owner: ${item.owner}; scope: ${item.writeScopes.join(', ') || 'n/a'})`)
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
2. For each assigned item: read the author's report (files, commands with exit codes, evidence, risks) and then read the actual files. Re-run cheap verification yourself when practical; treat unverified claims as unverified.
3. Check at minimum: definition-of-done coverage; correctness and edge cases; scope discipline (did the author touch files outside its scope); quality of evidence; missing tests; interface and contract consistency; silent placeholders or TODO stubs; unstated risk.
4. Submit with team_flow_review_submit: verdict (approve | approve_with_nits | request_changes | block), a summary, findings [{id, severity: blocker|major|minor|nit, file, line, claim, suggestion}], and evidence_checked (what you actually inspected).
5. A non-approving verdict must carry at least one finding, and every finding must name a file (and line when possible) plus a concrete claim. Blockers need a reproduction or a precise reasoning chain, never taste.
6. Independence: never modify the author's files, never fix the code you review, never let the author's summary stand in for your own inspection. You have a fresh context on purpose.
7. After submitting you go idle; the Lead or author will notify you for the next round. Do not poll.

# Communication
- Message the author with send_message({target:"<author>"}) if you need a clarification, prefixing [QUESTION] and the item id.
- Message the Lead with [BLOCKER] for a hard disagreement instead of approving under pressure.
- Round budget per item is ${state.settings.maxReviewRounds}; a request_changes starts a new author→reviewer round, so write findings that can be resolved in one iteration.`
  return {
    name: reviewer,
    description: `Independent reviewer for ${items.map((item) => item.id).join(', ') || 'assigned items'}`.slice(0, 200),
    context: 'fresh',
    prompt,
  }
}

/** @returns a compact findings digest for a peer notification. */
export function findingDigest(review) {
  if (review.findings.length === 0) return '- (no findings)'
  return review.findings
    .map((finding) => `- ${finding.id} [${finding.severity}] ${finding.file ?? '(no file)'}${finding.line ? `:${finding.line}` : ''} — ${finding.claim}`)
    .join('\n')
}

/**
 * Render the message the engine sends when a review becomes pending.
 * @param state - run state.
 * @param item - item under review.
 * @returns self-contained message text.
 */
export function reviewRequestMessage(state, item) {
  const review = pendingReview(item)
  const report = item.report
  return `[REVIEW] ${item.id} "${item.subject}" is ready for your review (round ${review?.round ?? '?'}).

Author: ${item.owner}
Files reported:
${bullets(report?.files ?? [])}
Commands reported:
${bullets((report?.commands ?? []).map((command) => `\`${command.command}\` → exit ${command.exitCode}`))}
Author summary: ${report?.summary ?? '(missing)'}
Author-declared risks: ${bullets(report?.risks ?? [], 'none')}

Definition of done:
${bullets(item.definitionOfDone)}

Action: inspect the real files and evidence, then call team_flow_review_submit with a verdict, findings, and evidence_checked. Run id ${state.runId}.`
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

Reviewer summary: ${review.summary || '(none)'}

Findings:
${findingDigest(review)}

Evidence the reviewer checked: ${bullets(review.evidenceChecked, 'not declared')}

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
