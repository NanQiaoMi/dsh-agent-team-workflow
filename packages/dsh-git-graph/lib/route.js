/**
 * Authenticated HTTP route for Git Graph snapshot.
 *
 * Registered inside DSH Connection's Fetch fence:
 * `ctx.connection.fetch.register({ path, methods: ['GET'], requestBody: 'buffered', fetch })`
 */

import { getGitSnapshot } from './git-engine.js'

export const GIT_GRAPH_SNAPSHOT_PATH = '/api/git-graph.snapshot'

function jsonResponse(status, payload) {
  return Response.json(payload, {
    status,
    headers: {
      'cache-control': 'no-store',
      'content-type': 'application/json',
    },
  })
}

/**
 * Register the git-graph snapshot route.
 * @param {object} options - `{ connection, ctx }`
 * @returns {() => void} Disposer
 */
export function registerGitGraphRoute({ connection, ctx }) {
  if (!connection?.fetch?.register) {
    return () => {}
  }

  return connection.fetch.register({
    path: GIT_GRAPH_SNAPSHOT_PATH,
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: async (request) => {
      try {
        if (request.method !== 'GET') {
          return jsonResponse(405, { ok: false, error: 'Only GET is supported' })
        }

        const url = new URL(request.url, 'http://gitgraph.invalid')
        const sessionId = url.searchParams.get('session') ?? ''
        const limitRaw = url.searchParams.get('limit')
        const limit = limitRaw && /^\d+$/.test(limitRaw) ? Math.min(parseInt(limitRaw, 10), 100) : 50

        // Resolve workspace directory for target session / agent
        let cwd = process.cwd()

        if (sessionId && ctx.agents?.get) {
          const agent = ctx.agents.get(sessionId)
          if (agent && ctx.workingDirectory?.ensure) {
            try {
              cwd = await ctx.workingDirectory.ensure(agent)
            } catch {
              /* fallback to process.cwd */
            }
          }
        }

        const snapshot = await getGitSnapshot(cwd, limit)
        return jsonResponse(200, snapshot)
      } catch (error) {
        return jsonResponse(500, {
          ok: false,
          error: error?.message || 'Failed to inspect Git repository',
        })
      }
    },
  })
}
