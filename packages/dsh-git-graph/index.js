/**
 * @local/dsh-git-graph - Host Plugin
 *
 * Provides:
 * 1. Authenticated HTTP route for Web UI visualization (/api/git-graph.snapshot)
 * 2. Model tools: git_graph_status and git_graph_inspect
 * 3. System prompt section providing current Git branch and working tree summary
 */

import { registerGitGraphRoute } from './lib/route.js'
import { getGitSnapshot } from './lib/git-engine.js'

export const name = 'dsh-git-graph'

export const inject = ['tools', 'connection']

/** Standard Schema compliant Config (zero-import) */
export const Config = {
  '~standard': {
    version: 1,
    vendor: 'dsh-git-graph',
    validate(config) {
      if (typeof config !== 'object' || config === null || Array.isArray(config)) {
        return { issues: [{ message: 'config must be an object' }] }
      }
      return {
        value: {
          maxCommits: Number.isSafeInteger(config.maxCommits) ? config.maxCommits : 50,
          pollMs: Number.isSafeInteger(config.pollMs) ? config.pollMs : 2000,
          injectPrompt: config.injectPrompt !== false,
        },
      }
    },
  },
}

function jsonOutput(schema) {
  return {
    schema,
    render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
  }
}

const GIT_STATUS_SCHEMA = {
  type: 'object',
  additionalProperties: true,
  properties: {
    isGitRepo: { type: 'boolean' },
    currentBranch: { type: 'string' },
    isDirty: { type: 'boolean' },
    staged: { type: 'integer' },
    unstaged: { type: 'integer' },
    untracked: { type: 'integer' },
  },
  required: ['isGitRepo'],
}

const GIT_INSPECT_SCHEMA = {
  type: 'object',
  additionalProperties: true,
  properties: {
    isGitRepo: { type: 'boolean' },
    currentBranch: { type: 'string' },
    headHash: { type: 'string' },
    commits: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: true,
        properties: {
          hash: { type: 'string' },
          shortHash: { type: 'string' },
          subject: { type: 'string' },
          author: { type: 'string' },
          relativeTime: { type: 'string' },
        },
        required: ['hash', 'shortHash', 'subject'],
      },
    },
  },
  required: ['isGitRepo'],
}

/**
 * Apply the Host plugin.
 * @param {object} ctx - Cordis Context
 * @param {object} config - Validated config
 */
export function apply(ctx, config = {}) {
  const resolved = {
    maxCommits: config.maxCommits ?? 50,
    pollMs: config.pollMs ?? 2000,
    injectPrompt: config.injectPrompt ?? true,
  }

  // 1. Register HTTP snapshot route via Connection service
  ctx.effect(() => {
    return registerGitGraphRoute({ connection: ctx.connection, ctx })
  }, 'git-graph.route')

  // 2. Register tools for the model
  ctx.effect(() => {
    const disposers = []

    // Tool: git_graph_status
    disposers.push(
      ctx.tools.register({
        name: 'git_graph_status',
        description: 'Get structured status of current Git working tree (branch, ahead/behind, staged/unstaged changes).',
        parameters: {
          type: 'object',
          additionalProperties: false,
          properties: {},
        },
        output: jsonOutput(GIT_STATUS_SCHEMA),
        async execute(_args, exec) {
          let cwd = process.cwd()
          if (exec.agent && ctx.workingDirectory?.ensure) {
            try {
              cwd = await ctx.workingDirectory.ensure(exec.agent)
            } catch {
              /* fallback */
            }
          }
          const snapshot = await getGitSnapshot(cwd, 10)
          if (!snapshot.isGitRepo) {
            return { isGitRepo: false, error: snapshot.error }
          }
          return {
            isGitRepo: true,
            currentBranch: snapshot.status.headBranch,
            headOid: snapshot.status.headOid,
            upstream: snapshot.status.upstream,
            ahead: snapshot.status.ahead,
            behind: snapshot.status.behind,
            isDirty: snapshot.status.isDirty,
            staged: snapshot.status.staged,
            unstaged: snapshot.status.unstaged,
            untracked: snapshot.status.untracked,
            changedFiles: snapshot.status.files,
          }
        },
      })
    )

    // Tool: git_graph_inspect
    disposers.push(
      ctx.tools.register({
        name: 'git_graph_inspect',
        description: 'Inspect recent commits in the Git commit tree DAG with branch lanes, merge parents, and refs.',
        parameters: {
          type: 'object',
          additionalProperties: false,
          properties: {
            limit: { type: 'integer', description: 'Number of recent commits to inspect (default: 20, max: 50).' },
          },
        },
        output: jsonOutput(GIT_INSPECT_SCHEMA),
        async execute(args, exec) {
          const limit = typeof args?.limit === 'number' ? Math.min(Math.max(1, args.limit), 50) : 20
          let cwd = process.cwd()
          if (exec.agent && ctx.workingDirectory?.ensure) {
            try {
              cwd = await ctx.workingDirectory.ensure(exec.agent)
            } catch {
              /* fallback */
            }
          }
          const snapshot = await getGitSnapshot(cwd, limit)
          if (!snapshot.isGitRepo) {
            return { isGitRepo: false, error: snapshot.error }
          }
          return {
            isGitRepo: true,
            currentBranch: snapshot.status.headBranch,
            headHash: snapshot.status.headOid,
            totalCommitsFound: snapshot.graph.nodes.length,
            commits: snapshot.graph.nodes.map((n) => ({
              hash: n.hash,
              shortHash: n.shortHash,
              subject: n.subject,
              author: n.author,
              relativeTime: n.relativeTime,
              isHead: n.isHead,
              isMerge: n.isMerge,
              lane: n.lane,
              refs: n.refs,
            })),
          }
        },
      })
    )

    return () => {
      for (const d of disposers.reverse()) d()
    }
  }, 'git-graph.tools')

  // 3. Inject system prompt section if available
  if (resolved.injectPrompt && ctx.systemPrompt?.section) {
    ctx.effect(() => {
      return ctx.systemPrompt.section({
        name: 'git:status-helper',
        order: ctx.systemPrompt.getSectionOrder ? ctx.systemPrompt.getSectionOrder('STRUCTURED_OUTPUT') - 10 : 9800,
        text: () => {
          return `[Git Graph Visualizer active: You can call git_graph_status and git_graph_inspect to view branches and commit trees. The developer has an interactive visual Git Graph in the chat interface.]`
        },
      })
    }, 'git-graph.prompt')
  }
}
