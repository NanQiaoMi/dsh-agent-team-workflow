import test from 'node:test'
import assert from 'node:assert/strict'
import { apply, Config } from '../index.js'

function createMockContext() {
  const tools = []
  const effects = []
  const sections = []
  const routes = []

  const ctx = {
    connection: {
      fetch: {
        register(route) {
          routes.push(route)
          return () => {
            const idx = routes.indexOf(route)
            if (idx !== -1) routes.splice(idx, 1)
          }
        },
      },
    },
    tools: {
      register(def) {
        tools.push(def)
        return () => {
          const idx = tools.indexOf(def)
          if (idx !== -1) tools.splice(idx, 1)
        }
      },
    },
    systemPrompt: {
      getSectionOrder: () => 9800,
      section(sec) {
        sections.push(sec)
        return () => {
          const idx = sections.indexOf(sec)
          if (idx !== -1) sections.splice(idx, 1)
        }
      },
    },
    effect(fn) {
      const disposer = fn()
      effects.push(disposer)
      return disposer
    },
  }

  return { ctx, tools, effects, sections, routes }
}

test('Config validation resolves defaults and rejects non-objects', () => {
  const schema = Config['~standard']
  assert.equal(schema.version, 1)

  const emptyRes = schema.validate({})
  assert.equal(emptyRes.value.maxCommits, 50)
  assert.equal(emptyRes.value.pollMs, 2000)
  assert.equal(emptyRes.value.injectPrompt, true)

  const customRes = schema.validate({ maxCommits: 25, pollMs: 1500, injectPrompt: false })
  assert.equal(customRes.value.maxCommits, 25)
  assert.equal(customRes.value.pollMs, 1500)
  assert.equal(customRes.value.injectPrompt, false)

  const invalidRes = schema.validate(123)
  assert.ok(invalidRes.issues)
})

test('apply registers tools, prompt section, and snapshot route', () => {
  const mock = createMockContext()
  apply(mock.ctx, {})

  assert.equal(mock.routes.length, 1)
  assert.equal(mock.routes[0].path, '/api/git-graph.snapshot')

  const toolNames = mock.tools.map((t) => t.name).sort()
  assert.deepEqual(toolNames, ['git_graph_inspect', 'git_graph_status'])

  assert.equal(mock.sections.length, 1)
  assert.equal(mock.sections[0].name, 'git:status-helper')
})

test('git_graph_status tool executes and returns valid schema output', async () => {
  const mock = createMockContext()
  apply(mock.ctx, {})

  const statusTool = mock.tools.find((t) => t.name === 'git_graph_status')
  assert.ok(statusTool)
  assert.ok(statusTool.output.schema)
  assert.ok(typeof statusTool.output.render === 'function')

  const result = await statusTool.execute({}, { agent: { id: 'test' } })
  assert.equal(result.isGitRepo, true)
  assert.ok(typeof result.currentBranch === 'string')

  const blocks = statusTool.output.render({}, result)
  assert.equal(blocks[0].type, 'text')
  assert.ok(blocks[0].text.includes('currentBranch'))
})

test('git_graph_inspect tool respects limit parameter', async () => {
  const mock = createMockContext()
  apply(mock.ctx, {})

  const inspectTool = mock.tools.find((t) => t.name === 'git_graph_inspect')
  assert.ok(inspectTool)

  const result = await inspectTool.execute({ limit: 3 }, { agent: { id: 'test' } })
  assert.equal(result.isGitRepo, true)
  assert.ok(Array.isArray(result.commits))
  assert.ok(result.commits.length <= 4) // up to 3 + optional working tree
})

test('disposers cleanly unwind registered resources', () => {
  const mock = createMockContext()
  apply(mock.ctx, {})

  assert.equal(mock.tools.length, 2)
  assert.equal(mock.routes.length, 1)
  assert.equal(mock.sections.length, 1)

  for (const d of mock.effects) {
    if (typeof d === 'function') d()
  }

  assert.equal(mock.tools.length, 0)
  assert.equal(mock.routes.length, 0)
  assert.equal(mock.sections.length, 0)
})
