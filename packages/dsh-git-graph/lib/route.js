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
        const customCwd = url.searchParams.get('cwd') ?? ''
        const limitRaw = url.searchParams.get('limit')
        const limit = limitRaw && /^\d+$/.test(limitRaw) ? Math.min(parseInt(limitRaw, 10), 100) : 50

        // Resolve workspace directory for target session / agent
        let cwd = customCwd ? customCwd.trim() : ''

        if (!cwd && sessionId && ctx.agents?.get) {
          const agent = ctx.agents.get(sessionId)
          if (agent && ctx.workingDirectory?.ensure) {
            try {
              cwd = await ctx.workingDirectory.ensure(agent)
            } catch {
              /* fallback */
            }
          }
        }

        // If cwd is still empty or is an application bundle root, inspect active agents
        if ((!cwd || cwd === '/' || cwd.includes('.app')) && ctx.agents?.list && ctx.workingDirectory?.ensure) {
          try {
            const list = ctx.agents.list()
            for (const a of list) {
              const candidate = await ctx.workingDirectory.ensure(a)
              if (candidate && candidate !== '/' && !candidate.includes('.app')) {
                cwd = candidate
                break
              }
            }
          } catch {
            /* ignore */
          }
        }

        if (!cwd) {
          cwd = process.env.DSH_WORKSPACE_DIR || process.cwd()
        }

        const snapshot = await getGitSnapshot(cwd, limit)
        return jsonResponse(200, snapshot)
      } catch (error) {
        return jsonResponse(200, {
          ok: false,
          isGitRepo: false,
          error: error?.message || 'Failed to inspect Git repository',
          generatedAt: new Date().toISOString(),
        })
      }
    },
  })
}
