/**
 * Member view route for the live board (docs/19 §5).
 *
 * GET returns the workflow-side view of one teammate (status, current items,
 * recent events, related channel messages, pending plan/stop) because the Host
 * does not expose another session's transcript. POST delivers a message from
 * the user to that teammate through the native Team transport.
 */

import { SNAPSHOT_VERSION } from './dashboard.js'

/** Exact Fetch path for the member view. */
export const MEMBER_PATH = '/api/agent-team-workflow.member'

/** Max messages returned in one member view. */
const MAX_CHANNEL = 12

/** Max events returned in one member view. */
const MAX_EVENTS = 12

function jsonResponse(status, payload) {
  return Response.json(payload, { status, headers: { 'cache-control': 'no-store' } })
}

function textOf(value, limit = 4000) {
  const text = typeof value === 'string' ? value : ''
  return text.length > limit ? `${text.slice(0, limit)}…` : text
}

/** Register the member route on one Connection service. */
export function registerMemberRoute({ connection, ctx, store, settings, transcript }) {
  return connection.fetch.register({
    path: MEMBER_PATH,
    methods: ['GET', 'POST'],
    requestBody: 'buffered',
    fetch: (request) => handleMemberRequest({ request, ctx, store, settings, transcript }),
  })
}

/** @returns the parsed member name and session id, or a 400 response. */
function parseTarget(url, body) {
  const sessionId = url.searchParams.get('session') ?? ''
  const name = url.searchParams.get('name') ?? body?.name ?? ''
  if (!/^[A-Za-z0-9._-]{1,160}$/.test(sessionId)) return { error: 'a valid ?session=<sessionId> query parameter is required' }
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) return { error: 'a valid member name is required' }
  return { sessionId, name }
}

async function handleMemberRequest({ request, ctx, store, settings, transcript }) {
  try {
    const url = new URL(request.url, 'http://dashboard.invalid')
    let body = null
    if (request.method === 'POST') {
      try {
        body = JSON.parse(await request.text())
      } catch {
        return jsonResponse(400, { ok: false, error: 'the request body must be JSON' })
      }
    }
    const target = parseTarget(url, body)
    if (target.error !== undefined) return jsonResponse(400, { ok: false, error: target.error })
    const agent = ctx.agents.get(target.sessionId)
    if (agent === undefined) return jsonResponse(404, { ok: false, error: 'that session is not live right now' })
    let membership = null
    try {
      membership = ctx.agentTeams.tryMembership(agent) ?? null
    } catch {
      membership = null
    }
    if (membership === null) return jsonResponse(400, { ok: false, error: 'that session is not a Team member' })
    const members = (() => {
      try {
        return ctx.agentTeams.listMembers(agent)
      } catch {
        return []
      }
    })()
    const member = members.find((entry) => entry.name === target.name)
    if (member === undefined) return jsonResponse(404, { ok: false, error: `no teammate named "${target.name}"` })

    if (request.method === 'POST') {
      const message = textOf(body?.message, 4000).trim()
      if (message.length === 0) return jsonResponse(400, { ok: false, error: 'message must be a non-empty string' })
      if (message.length > 4000) return jsonResponse(400, { ok: false, error: 'message must be at most 4000 characters' })
      try {
        await ctx.agentTeams.sendMessage(agent, {
          target: target.name,
          content: [{ type: 'text', text: message }],
          signal: AbortSignal.timeout(15_000),
        })
      } catch (error) {
        return jsonResponse(409, { ok: false, error: `the message was not accepted: ${error instanceof Error ? error.message : String(error)}` })
      }
      return jsonResponse(200, { ok: true, delivered: true, member: target.name })
    }

    let state = null
    try {
      state = await store.readState(agent)
    } catch {
      state = null
    }
    const items = Array.isArray(state?.items) ? state.items : []
    const owned = items.filter((item) => item.owner === target.name)
    const reviewing = items.filter((item) => Array.isArray(item.reviewers) && item.reviewers.includes(target.name) && item.status !== 'approved')
    const currentItems = [...owned, ...reviewing.filter((item) => !owned.includes(item))].map((item) => ({
      id: textOf(item.id, 64),
      subject: textOf(item.subject, 300),
      status: textOf(item.status, 64),
      role: textOf(item.role, 64),
    }))
    const events = (Array.isArray(state?.events) ? state.events : [])
      .filter((event) => event.actor === target.name || (typeof event.actor === 'string' && event.actor.length === 0))
      .slice(-MAX_EVENTS)
      .map((event) => ({ at: textOf(event.at, 64), type: textOf(event.type, 128), detail: textOf(event.detail, 400) }))
    const channel = (Array.isArray(state?.channel) ? state.channel : [])
      .filter((message) => message.from === target.name || message.to === target.name)
      .slice(-MAX_CHANNEL)
      .map((message) => ({ id: textOf(message.id, 64), at: textOf(message.at, 64), from: textOf(message.from, 64), to: textOf(message.to, 64), kind: textOf(message.kind, 32), text: textOf(message.text, 600), item_id: message.itemId === undefined ? null : message.itemId }))
    const stop = (Array.isArray(state?.stops) ? state.stops : []).filter((entry) => entry.target === target.name && (entry.status === 'pending' || entry.status === 'accepted')).at(-1) ?? null
    const planItem = owned.filter((item) => item.plan !== null && item.plan !== undefined).at(-1) ?? null
    const roleName = state?.roleAssignments?.[target.name]
    const roleDefinition = roleName !== undefined && settings.roles?.[roleName] !== undefined ? { role: roleName, ...settings.roles[roleName] } : null
    // The transcript is best-effort: a Host without the session-query service
    // (or a session that cannot be read) shows the workflow view only.
    let transcriptView = { available: false, messages: [], truncated: false, totalEvents: 0, error: null }
    if (typeof transcript === 'function') {
      try {
        const result = await transcript(member.id ?? member.sessionId ?? null, { limit: 40 })
        if (result !== null && result !== undefined) transcriptView = { available: true, ...result }
      } catch (error) {
        transcriptView = { available: false, messages: [], truncated: false, totalEvents: 0, error: error instanceof Error ? error.message : String(error) }
      }
    }
    void SNAPSHOT_VERSION
    return jsonResponse(200, {
      ok: true,
      sessionId: target.sessionId,
      member: {
        name: target.name,
        role: textOf(member.role, 32) || null,
        status: textOf(member.status, 32) || null,
        context: textOf(member.context, 32) || null,
        currentItems,
        recentActivity: events,
        channel,
        stop: stop === null ? null : { id: textOf(stop.id, 64), status: textOf(stop.status, 32), at: textOf(stop.at, 64) },
        plan: planItem === null ? null : { itemId: textOf(planItem.id, 64), status: textOf(planItem.plan.status, 32) },
        roleDefinition,
        transcript: transcriptView,
      },
    })
  } catch (error) {
    ctx.logger?.warn?.(`agent-team-workflow: member view failed: ${error instanceof Error ? error.message : String(error)}`)
    return jsonResponse(500, { ok: false, error: 'the member view failed; retry after the next change' })
  }
}
