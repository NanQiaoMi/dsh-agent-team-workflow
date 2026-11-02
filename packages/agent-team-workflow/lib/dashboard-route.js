/**
 * Authenticated snapshot route for the live Agent Team board.
 *
 * The route is registered inside Connection's Fetch fence, so only the
 * application's own browser principal can read it; the Web view then polls it
 * to render the live board. This module performs no caching and stores nothing:
 * every response is derived from the Team board and the native roster.
 */

import { SNAPSHOT_VERSION, buildSnapshot } from './dashboard.js'
import { settleExpiredProposals } from './workflow.js'

/** Exact Fetch path the Web view polls. Connection requires the `/api/` channel. */
export const SNAPSHOT_PATH = '/api/agent-team-workflow.snapshot'

/** Build one JSON response with the live-fact cache policy. */
function jsonResponse(status, payload) {
  return Response.json(payload, { status, headers: { 'cache-control': 'no-store' } })
}

/** @returns a 400 response for one malformed request. */
function badRequest(message) {
  return jsonResponse(400, { ok: false, error: message })
}

/**
 * Register the snapshot route on one Connection service instance.
 * @param options - `{ connection, ctx, store, settings }`.
 * @returns the route disposer.
 */
export function registerDashboardRoute({ connection, ctx, store, settings }) {
  return connection.fetch.register({
    path: SNAPSHOT_PATH,
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: (request) => handleSnapshotRequest({ request, ctx, store, settings }),
  })
}

/**
 * Answer one snapshot request.
 * @param options - request plus the plugin's context, store, and settings.
 * @returns a `Response` that never rejects.
 */
async function handleSnapshotRequest({ request, ctx, store, settings }) {
  try {
    if (request.method !== 'GET') {
      return jsonResponse(405, { ok: false, error: 'the live board snapshot only supports GET' })
    }
    const url = new URL(request.url, 'http://dashboard.invalid')
    const sessionId = url.searchParams.get('session') ?? ''
    if (!/^[A-Za-z0-9._-]{1,160}$/.test(sessionId)) return badRequest('a valid ?session=<sessionId> query parameter is required')
    const agent = ctx.agents.get(sessionId)
    if (agent === undefined) return jsonResponse(404, { ok: false, error: 'that session is not live right now' })

    const diagnostics = { boardSource: 'missing', warnings: [] }
    let membership = null
    try {
      membership = ctx.agentTeams.tryMembership(agent) ?? null
    } catch (error) {
      diagnostics.warnings.push(`team membership unavailable: ${messageOf(error)}`)
    }

    const members = []
    const tasks = []
    if (membership !== null) {
      try {
        for (const member of ctx.agentTeams.listMembers(agent)) {
          members.push({ name: member.name, role: member.role, status: member.status, context: member.context })
        }
      } catch (error) {
        diagnostics.warnings.push(`roster unavailable: ${messageOf(error)}`)
      }
      try {
        for (const task of ctx.agentTeams.listTasks(agent)) {
          tasks.push({ id: task.id, revision: task.revision, status: task.status, subject: task.subject, ownerName: task.ownerName ?? null })
        }
      } catch (error) {
        diagnostics.warnings.push(`shared task board unavailable: ${messageOf(error)}`)
      }
    }

    let state = null
    try {
      state = await store.readState(agent)
      if (state !== null) {
        // Proposals settle lazily; the board must show the decision without
        // waiting for the next tool call, so settle while snapshotting and
        // persist only when something changed.
        try {
          const settled = settleExpiredProposals(state, { now: new Date().toISOString(), settings: state.settings, members })
          if (settled.length > 0) await store.writeState(agent, state)
        } catch (error) {
          diagnostics.warnings.push(`proposal settlement failed: ${messageOf(error)}`)
        }
      }
    } catch (error) {
      diagnostics.warnings.push(`workflow board unreadable: ${messageOf(error)}`)
    }
    diagnostics.boardSource = state === null ? 'missing' : settings.writeArtifacts ? 'file' : 'memory'

    const artifacts = artifactPaths({ agent, store, settings, state })
    const snapshot = buildSnapshot({
      state,
      sessionId,
      team: {
        me: membership === null ? null : { name: membership.name, role: membership.role },
        members,
        tasks,
      },
      artifacts,
      now: new Date().toISOString(),
      diagnostics,
    })
    // The request's session id is authoritative: the board's team id is the
    // Lead's session, which would be wrong for a teammate polling its own view.
    return jsonResponse(200, { ok: true, ...snapshot, version: SNAPSHOT_VERSION, sessionId })
  } catch (error) {
    ctx.logger?.warn?.(`agent-team-workflow: live board snapshot failed: ${messageOf(error)}`)
    return jsonResponse(500, { ok: false, error: 'the live board snapshot failed; retry after the next change' })
  }
}

/** Collect artifact paths without letting an unresolvable cwd break the response. */
function artifactPaths({ agent, store, settings, state }) {
  const artifacts = { root: null, statePath: null, reportPath: state?.artifacts?.reportPath ?? null }
  try {
    artifacts.root = store.describeRoot(agent)
    artifacts.statePath = settings.writeArtifacts ? store.statePath(agent) : null
  } catch (error) {
    /* a board that cannot resolve its path simply has no artifact links */
  }
  return artifacts
}

/** @returns a short message for any thrown value. */
function messageOf(error) {
  if (error instanceof Error) return error.message
  return String(error)
}
