/**
 * Run creation, wave planning, static preflight/validation, plan-first approval,
 * and dynamic member item creation.
 */

import { classifyDiffRisk, REVIEW_DEPTHS, REVIEW_PROFILES } from '../review-policy.js'
import {
  appendEvent,
  DEFAULT_LEASE_MINUTES,
  ensureCollaboration,
  findItem,
  ITEM_STATUS,
  normalizeScope,
  PLAN_STATUS,
  requiresPlan,
  RUN_PHASE,
  scopesOverlap,
  WorkflowError,
} from './constants.js'
import { postChannelMessage } from './collaboration.js'

/**
 * Create the initial run record from a validated plan.
 * @param input - normalized plan input.
 * @returns a new run state.
 */
export function createRun(input) {
  const now = input.now ?? new Date().toISOString()
  const run = {
    schemaVersion: 2,
    workflowVersion: input.workflowVersion,
    runId: input.runId,
    teamId: input.teamId,
    preset: input.preset ?? null,
    objective: input.objective,
    acceptanceCriteria: input.acceptanceCriteria,
    constraints: input.constraints,
    phase: RUN_PHASE.PLANNED,
    createdAt: now,
    updatedAt: now,
    settings: input.settings,
    items: input.items,
    escalations: [],
    events: [],
    channel: [],
    proposals: [],
    staffPool: [],
    roleAssignments: input.roleAssignments ?? {},
    stops: [],
    stopSeq: 0,
    git: null,
    messageSeq: 0,
    proposalSeq: 0,
    gate: null,
    artifacts: input.artifacts ?? null,
    finalizedAt: null,
  }
  ensureCollaboration(run)
  appendEvent(run, { at: now, type: 'run/planned', actor: input.actor, detail: `planned ${input.items.length} work item(s)` })
  return run
}

/** @returns the unique reviewer names involved in a run, in first-seen order. */
export function collectReviewers(items) {
  const seen = new Set()
  for (const item of items) {
    if (item.needsReview === false) continue
    for (const reviewer of item.reviewers) {
      if (!seen.has(reviewer)) seen.add(reviewer)
    }
  }
  return [...seen]
}

/** @returns the unique worker owner names involved in a run, in first-seen order. */
export function collectOwners(items) {
  const seen = new Set()
  for (const item of items) if (typeof item.owner === 'string' && item.owner.length > 0 && !seen.has(item.owner)) seen.add(item.owner)
  return [...seen]
}

/**
 * Compute execution waves from item blockers.
 * @param items - normalized items with `blockedBy` item ids.
 * @returns `{ waves, cycle }`; `cycle` lists items that can never run.
 */
export function computeWaves(items) {
  const remaining = new Map(items.map((item) => [item.id, new Set(item.blockedBy)]))
  const waves = []
  const done = new Set()
  for (;;) {
    const ready = [...remaining.keys()].filter((id) => [...remaining.get(id)].every((blocker) => done.has(blocker))).sort()
    if (ready.length === 0) break
    waves.push(ready)
    for (const id of ready) {
      done.add(id)
      remaining.delete(id)
    }
  }
  return { waves, cycle: [...remaining.keys()].sort() }
}

/**
 * Report every pair of same-wave items whose write scopes overlap.
 * @param items - normalized items.
 * @param waves - execution waves from {@link computeWaves}.
 * @returns conflict records `{ wave, left, right, scopes }`.
 */
export function findScopeConflicts(items, waves) {
  const byId = new Map(items.map((item) => [item.id, item]))
  const conflicts = []
  waves.forEach((wave, index) => {
    for (let i = 0; i < wave.length; i += 1) {
      for (let j = i + 1; j < wave.length; j += 1) {
        const left = byId.get(wave[i])
        const right = byId.get(wave[j])
        if (left === undefined || right === undefined) continue
        const overlaps = []
        for (const a of left.writeScopes) {
          for (const b of right.writeScopes) {
            if (scopesOverlap(a, b)) overlaps.push(`${a} <> ${b}`)
          }
        }
        if (overlaps.length > 0) conflicts.push({ wave: index + 1, left: left.id, right: right.id, scopes: [...new Set(overlaps)] })
      }
    }
  })
  return conflicts
}

/**
 * Static plan preflight checks: detects unsafe writeScopes, broad wildcards in
 * multi-item plans, overloaded items, terse DoDs, and high-risk items lacking
 * verification commands.
 * @param plan - normalized `{ items }` plan.
 * @param settings - run-scoped settings.
 * @returns `{ errors: string[], warnings: string[] }`.
 */
export function preflightPlan(plan, settings = {}) {
  const errors = []
  const warnings = []
  const items = Array.isArray(plan?.items) ? plan.items : []
  const verifyCommands = Array.isArray(settings?.gitVerifyCommands)
    ? settings.gitVerifyCommands.filter((c) => typeof c === 'string' && c.trim().length > 0)
    : []

  for (const item of items) {
    const id = item?.id ?? '(unknown)'
    const scopes = Array.isArray(item?.writeScopes) ? item.writeScopes : []
    const dod = Array.isArray(item?.definitionOfDone) ? item.definitionOfDone : []
    const evidenceCmds = Array.isArray(item?.evidenceCommands)
      ? item.evidenceCommands.filter((c) => typeof c === 'string' && c.trim().length > 0)
      : []

    for (const rawScope of scopes) {
      const scope = String(rawScope ?? '').trim().replaceAll('\\', '/')
      if (scope.startsWith('/') || /^[A-Za-z]:\//.test(scope)) {
        errors.push(`item "${id}" writeScope "${rawScope}" must be workspace-relative, not an absolute path`)
      } else if (/(?:^|\/)\.\.(?:\/|$)/.test(scope)) {
        errors.push(`item "${id}" writeScope "${rawScope}" contains unsafe parent traversal ".."`)
      } else if (items.length > 1 && (scope === '*' || scope === '**' || scope === '.')) {
        warnings.push(`item "${id}" uses broad wildcard writeScope "${rawScope}" in a multi-item plan; narrow it to reduce conflicts`)
      }
    }

    if (scopes.length > 8) {
      warnings.push(`item "${id}" declares ${scopes.length} writeScopes; consider splitting into smaller focused items`)
    }
    if (dod.length > 8) {
      warnings.push(`item "${id}" declares ${dod.length} definition_of_done entries; consider splitting into smaller items`)
    }
    for (const entry of dod) {
      if (String(entry ?? '').trim().length < 4) {
        warnings.push(`item "${id}" has an overly terse definition_of_done entry ("${String(entry ?? '').trim()}"); make acceptance criteria specific`)
      }
    }

    const risk = classifyDiffRisk({ files: scopes, item, settings })
    if (risk.depth === 'deep' && evidenceCmds.length === 0 && verifyCommands.length === 0) {
      warnings.push(`item "${id}" touches high-risk scope (${risk.profile}/${risk.depth}) without evidence_commands or gitVerifyCommands; add verification commands`)
    }
  }

  return { errors, warnings }
}

/**
 * Validate a normalized plan against the workflow rules.
 * @param plan - `{ objective, acceptanceCriteria, constraints, items }`.
 * @param settings - run-scoped settings.
 * @returns `{ errors, warnings, waves, conflicts }`.
 */
export function validatePlan(plan, settings) {
  const errors = []
  const warnings = []
  const items = plan.items
  if (typeof plan.objective !== 'string' || plan.objective.trim().length === 0) errors.push('objective must be a non-empty string')
  if (plan.objective && plan.objective.length > 4000) errors.push('objective must be at most 4000 characters')
  if (!Array.isArray(plan.acceptanceCriteria) || plan.acceptanceCriteria.length === 0) errors.push('acceptance_criteria must declare at least one verifiable acceptance criterion')
  if (items.length === 0) errors.push('items must declare at least one work item')
  if (items.length > settings.maxItems) errors.push(`items declares ${items.length} work items; the configured maximum is ${settings.maxItems}`)

  const ids = new Set()
  for (const item of items) {
    if (!/^[A-Za-z0-9._-]{1,32}$/.test(item.id)) errors.push(`item id "${item.id}" must match [A-Za-z0-9._-]{1,32}`)
    if (ids.has(item.id)) errors.push(`duplicate item id "${item.id}"`)
    ids.add(item.id)
    if (!item.subject) errors.push(`item "${item.id}" needs a non-empty subject`)
    if (item.subject && item.subject.length > 200) errors.push(`item "${item.id}" subject must be at most 200 characters`)
    if (item.assignment === 'open' && (item.owner === undefined || item.owner === null || item.owner === '')) {
      // Open-queue items are claimed by a peer after the plan is published.
    } else if (!item.owner) {
      errors.push(`item "${item.id}" needs an owner member name (or assignment:"open" to publish it for self-claim)`)
    } else if (item.owner === 'lead') {
      errors.push(`item "${item.id}" cannot be owned by the Lead; the Lead coordinates and gates`)
    } else if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(item.owner)) {
      errors.push(`item "${item.id}" owner "${item.owner}" is not a spawnable member name (lower-kebab-case, digits allowed)`)
    }
    if (!Array.isArray(item.definitionOfDone) || item.definitionOfDone.length === 0) errors.push(`item "${item.id}" needs at least one definition_of_done entry`)
    if (!Array.isArray(item.writeScopes) || item.writeScopes.length === 0) warnings.push(`item "${item.id}" declares no write scope; scope discipline cannot be checked`)
    for (const scope of item.writeScopes) {
      if (normalizeScope(scope).length === 0) errors.push(`item "${item.id}" declares an empty/root write scope`)
      if (normalizeScope(scope).startsWith('/')) errors.push(`item "${item.id}" write scope "${scope}" must be workspace-relative`)
    }
  }

  for (const item of items) {
    for (const blocker of item.blockedBy) {
      if (!ids.has(blocker)) errors.push(`item "${item.id}" blocked_by unknown item "${blocker}"`)
      if (blocker === item.id) errors.push(`item "${item.id}" cannot block itself`)
    }
    if (item.needsReview === false) continue
    if (item.reviewers.length === 0) {
      if (item.assignment === 'open') warnings.push(`item "${item.id}" publishes review as an open invitation; the owner must request a peer review after reporting`)
      else errors.push(`item "${item.id}" requires review but declares no reviewers (set needs_review=false to opt out explicitly)`)
    }
    for (const reviewer of item.reviewers) {
      if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(reviewer)) errors.push(`item "${item.id}" reviewer "${reviewer}" is not a spawnable member name (lower-kebab-case, digits allowed)`)
      if (reviewer === item.owner) errors.push(`item "${item.id}" lists its own owner "${reviewer}" as reviewer; reviews must be independent`)
      if (reviewer === 'lead') warnings.push(`item "${item.id}" is reviewed by the Lead; that is permitted but weaker than an independent peer`)
    }
    if (new Set(item.reviewers).size !== item.reviewers.length) errors.push(`item "${item.id}" repeats a reviewer`)
  }

  const { waves, cycle } = computeWaves(items)
  for (const item of cycle) errors.push(`item "${item.id}" participates in a dependency cycle`)
  for (const wave of waves) {
    if (wave.length > settings.maxParallelItems) {
      warnings.push(`wave ${waves.indexOf(wave) + 1} runs ${wave.length} items in parallel; the configured recommendation is ${settings.maxParallelItems}`)
    }
  }
  const conflicts = findScopeConflicts(items, waves)
  if (conflicts.length > 0) {
    const detail = conflicts.map((conflict) => `wave ${conflict.wave}: ${conflict.left} vs ${conflict.right} (${conflict.scopes.join(', ')})`).join('; ')
    if (settings.worktreeIsolation === 'parallel') {
      // Each item owns a separate checkout, so overlapping scopes cannot race.
      warnings.push(`overlapping write scopes in one wave are isolated by parallel worktrees: ${detail}`)
    } else if (settings.allowScopeOverlap) warnings.push(`overlapping write scopes in one wave are allowed by configuration: ${detail}`)
    else errors.push(`overlapping write scopes inside one execution wave would race: ${detail}`)
  }

  const owners = collectOwners(items)
  if (owners.length > 8) errors.push(`plan needs ${owners.length} workers; Agent Teams allows at most 8 members including the Lead`)
  if (items.length > 0 && items.every((item) => item.needsReview === false)) {
    warnings.push('no item requires independent review; the workflow will not provide mutual-review assurance for this run')
  }
  return { errors, warnings, waves, conflicts }
}

/** @returns the next free member-created item id (`S1`, `S2`, ...). */
function nextMemberItemId(state) {
  const taken = new Set((state.items ?? []).map((item) => item.id))
  for (let index = 1; ; index += 1) {
    const candidate = `S${index}`
    if (!taken.has(candidate)) return candidate
  }
}

/**
 * Submit a short implementation plan for one item.
 * @param state - run state (mutated).
 * @param input - `{ itemId, by, plan: {steps, files, risks}, now, autoApprove }`.
 */
export function submitPlan(state, input) {
  ensureCollaboration(state)
  const now = input.now ?? new Date().toISOString()
  const item = findItem(state, input.itemId)
  if (!requiresPlan(state, item)) throw new WorkflowError(`item "${item.id}" does not require a plan`, 'WORKFLOW_PLAN_NOT_REQUIRED')
  if (item.owner !== input.by) throw new WorkflowError(`only the owner of "${item.id}" may submit its plan`, 'WORKFLOW_PLAN_OWNER_REQUIRED')
  const steps = (Array.isArray(input.plan?.steps) ? input.plan.steps : []).map((step) => String(step).trim()).filter((step) => step.length > 0).slice(0, 40)
  if (steps.length === 0) throw new WorkflowError('a plan needs at least one step', 'WORKFLOW_PLAN_STEPS_REQUIRED')
  const files = (Array.isArray(input.plan?.files) ? input.plan.files : []).map((file) => String(file).trim()).filter((file) => file.length > 0).slice(0, 40)
  const risks = (Array.isArray(input.plan?.risks) ? input.plan.risks : []).map((risk) => String(risk).trim()).filter((risk) => risk.length > 0).slice(0, 20)
  const autoApprove = input.autoApprove === true
  item.plan = {
    steps,
    files,
    risks,
    submittedAt: now,
    submittedBy: input.by,
    status: autoApprove ? PLAN_STATUS.approved : PLAN_STATUS.pending,
    decidedAt: autoApprove ? now : null,
    decidedBy: autoApprove ? 'auto' : null,
    reason: null,
  }
  item.updatedAt = now
  appendEvent(state, { at: now, type: `plan/${item.plan.status}`, actor: input.by, detail: `${item.id}${autoApprove ? ' (auto-approved)' : ''}` })
  postChannelMessage(state, { from: input.by, to: autoApprove ? 'team' : 'lead', kind: 'status', text: `plan ${item.plan.status} for ${item.id}: ${steps.length} step(s)${autoApprove ? ' (auto-approved)' : ', waiting for approval'}`, itemId: item.id, now })
  return item.plan
}

/** Approve or reject a pending plan. */
export function decidePlan(state, input) {
  ensureCollaboration(state)
  const now = input.now ?? new Date().toISOString()
  const item = findItem(state, input.itemId)
  if (item.plan === null || item.plan.status !== PLAN_STATUS.pending) throw new WorkflowError(`item "${item.id}" has no pending plan`, 'WORKFLOW_PLAN_NONE')
  item.plan.status = input.accept === true ? PLAN_STATUS.approved : PLAN_STATUS.rejected
  item.plan.decidedAt = now
  item.plan.decidedBy = input.by
  item.plan.reason = typeof input.reason === 'string' && input.reason.trim().length > 0 ? input.reason.trim().slice(0, 2000) : null
  item.updatedAt = now
  appendEvent(state, { at: now, type: `plan/${item.plan.status}`, actor: input.by, detail: item.id })
  postChannelMessage(state, { from: input.by, to: item.owner, kind: 'status', text: `plan ${item.plan.status} for ${item.id}${item.plan.reason === null ? '' : `: ${item.plan.reason}`}`, itemId: item.id, now })
  return item.plan
}

/**
 * Let one member add a new work item to the live run.
 *
 * A real Team grows work while it runs: a worker notices a missing example, a
 * reviewer finds an untested branch, and the fix is local. The new item joins
 * the same board, the same review rules and the same gate as a planned item —
 * autonomy is not an exemption from verification.
 * @param state - run state (mutated).
 * @param input - `{ by, subject, role, writeScopes, definitionOfDone, owner,
 *   blockedBy, needsReview, reviewers, evidenceOptional, now, maxItems,
 *   allowScopeOverlap, leaseMinutes }`.
 * @returns the created item record.
 */
export function createItem(state, input) {
  ensureCollaboration(state)
  const now = input.now ?? new Date().toISOString()
  const subject = String(input.subject ?? '').trim()
  if (subject.length === 0) throw new WorkflowError('a member-created item needs a non-empty subject', 'WORKFLOW_ITEM_SUBJECT_REQUIRED')
  if (subject.length > 200) throw new WorkflowError('a member-created item subject must be at most 200 characters', 'WORKFLOW_ITEM_SUBJECT_REQUIRED')
  const definitionOfDone = (Array.isArray(input.definitionOfDone) ? input.definitionOfDone : []).map((entry) => String(entry).trim()).filter((entry) => entry.length > 0)
  if (definitionOfDone.length === 0) throw new WorkflowError('a member-created item needs at least one definition_of_done entry', 'WORKFLOW_ITEM_DOD_REQUIRED')
  const writeScopes = (Array.isArray(input.writeScopes) ? input.writeScopes : []).map((entry) => normalizeScope(entry)).filter((entry) => entry.length > 0)
  if (writeScopes.length === 0) throw new WorkflowError('a member-created item needs at least one write scope', 'WORKFLOW_ITEM_SCOPE_REQUIRED')
  for (const scope of writeScopes) {
    if (scope.startsWith('/')) throw new WorkflowError(`write scope "${scope}" must be workspace-relative`, 'WORKFLOW_ITEM_SCOPE_REQUIRED')
  }
  const maxItems = Number.isInteger(input.maxItems) ? input.maxItems : Number.POSITIVE_INFINITY
  if (state.items.length >= maxItems) throw new WorkflowError(`this run already holds ${state.items.length} work items (max ${maxItems})`, 'WORKFLOW_ITEM_LIMIT')
  const blockedBy = [...new Set((Array.isArray(input.blockedBy) ? input.blockedBy : []).map((entry) => String(entry).trim()).filter((entry) => entry.length > 0))]
  for (const blocker of blockedBy) findItem(state, blocker)
  const reviewers = [...new Set((Array.isArray(input.reviewers) ? input.reviewers : []).map((entry) => String(entry).trim()).filter((entry) => entry.length > 0))]
  const requestedOwner = input.owner === undefined || input.owner === null || String(input.owner).trim() === '' || String(input.owner).trim() === 'self'
    ? input.by
    : String(input.owner).trim()
  const open = requestedOwner === 'open'
  const owner = open ? '' : requestedOwner
  if (owner !== '' && owner === 'lead') throw new WorkflowError('the Lead coordinates and gates; create the item with owner:"self" or owner:"open"', 'WORKFLOW_ITEM_OWNER_REQUIRED')
  if (owner !== '' && !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(owner)) throw new WorkflowError(`owner "${owner}" is not a member name (lower-kebab-case, digits allowed)`, 'WORKFLOW_ITEM_OWNER_REQUIRED')
  for (const reviewer of reviewers) {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(reviewer)) throw new WorkflowError(`reviewer "${reviewer}" is not a member name (lower-kebab-case, digits allowed)`, 'WORKFLOW_ITEM_REVIEWER_REQUIRED')
    if (reviewer === owner) throw new WorkflowError(`item cannot list its own owner "${reviewer}" as reviewer; reviews must be independent`, 'WORKFLOW_ITEM_SELF_REVIEW')
  }
  const id = nextMemberItemId(state)
  const rawComplexity = typeof input.complexity === 'string' ? input.complexity.trim().toLowerCase() : 'normal'
  const complexity = ['trivial', 'normal', 'complex'].includes(rawComplexity) ? rawComplexity : 'normal'
  const rawTier = typeof input.thinkingTier === 'string' ? input.thinkingTier.trim().toLowerCase() : ''
  const thinkingTier = ['off', 'low', 'medium', 'high', 'max', 'inherit'].includes(rawTier) ? rawTier : null
  const rawDepth = typeof input.reviewDepth === 'string' ? input.reviewDepth.trim().toLowerCase() : 'auto'
  const reviewDepth = REVIEW_DEPTHS.includes(rawDepth) ? rawDepth : 'auto'
  const rawProfile = typeof input.reviewProfile === 'string' ? input.reviewProfile.trim().toLowerCase() : 'auto'
  const reviewProfile = REVIEW_PROFILES.includes(rawProfile) ? rawProfile : 'auto'
  const item = {
    id,
    subject,
    owner,
    assignment: open ? 'open' : 'lead',
    claim: null,
    reviewRequests: [],
    handoffs: [],
    handoffPacket: null,
    pendingReviewer: null,
    pendingReviewers: [],
    role: String(input.role ?? 'implementer').trim() || 'implementer',
    complexity,
    thinkingTier,
    reviewDepth,
    reviewProfile,
    resolvedReview: null,
    writeScopes,
    blockedBy,
    definitionOfDone,
    needsReview: input.needsReview !== false,
    planFirst: input.planFirst === true,
    plan: null,
    reviewers,
    evidenceOptional: input.evidenceOptional === true,
    status: ITEM_STATUS.PENDING,
    taskId: null,
    report: null,
    reportSeq: 0,
    reviews: [],
    reviewSeq: 0,
    overrideReason: null,
    repairLog: [],
    origin: 'member',
    createdBy: input.by,
    git: null,
    createdAt: now,
    updatedAt: now,
    reportedAt: null,
    approvedAt: null,
    approvedBy: null,
  }
  const tentative = [...state.items, item]
  const { waves } = computeWaves(tentative)
  const conflicts = findScopeConflicts(tentative, waves).filter((conflict) => conflict.left === id || conflict.right === id)
  if (conflicts.length > 0 && input.allowScopeOverlap !== true) {
    const detail = conflicts.map((conflict) => `wave ${conflict.wave}: ${conflict.left} vs ${conflict.right} (${conflict.scopes.join(', ')})`).join('; ')
    throw new WorkflowError(`the new item would race with an existing item in the same wave: ${detail}`, 'WORKFLOW_ITEM_SCOPE_CONFLICT')
  }
  state.items.push(item)
  if (open === false && owner === input.by) {
    item.claim = { by: input.by, at: now, leaseMinutes: Number.isInteger(input.leaseMinutes) ? input.leaseMinutes : DEFAULT_LEASE_MINUTES, note: 'self-created' }
  }
  appendEvent(state, { at: now, type: 'item/created', actor: input.by, detail: `${id} ${open ? '(open queue)' : `→ ${owner}`}: ${subject.slice(0, 120)}` })
  postChannelMessage(state, {
    from: input.by,
    to: open ? 'team' : owner === input.by ? 'team' : owner,
    kind: 'status',
    text: `created ${id}${open ? ' (open queue)' : ` for ${owner}`}: ${subject.slice(0, 200)}`,
    itemId: id,
    now,
  })
  return item
}
