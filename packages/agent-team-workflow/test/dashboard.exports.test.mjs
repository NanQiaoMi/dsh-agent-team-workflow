import test from 'node:test'
import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as D from '../lib/dashboard.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const LIB_DIR = join(HERE, '..', 'lib')

const EXPECTED_EXPORTS = [
  'SNAPSHOT_VERSION',
  'buildSnapshot',
  'computeWaves',
  'normalizeItemStatus',
  'normalizeStatus',
  'tailEvents',
]

test('lib/dashboard.js barrel preserves exact public exports', () => {
  assert.deepEqual(Object.keys(D).sort(), EXPECTED_EXPORTS)
})

test('lib/dashboard/ submodules stay within line budgets and remain strictly acyclic', async () => {
  const facadeSrc = await readFile(join(LIB_DIR, 'dashboard.js'), 'utf8')
  const facadeLines = facadeSrc.split('\n').length
  assert.ok(facadeLines < 80, `lib/dashboard.js facade has ${facadeLines} lines (expected < 80)`)

  const dashboardDir = join(LIB_DIR, 'dashboard')
  const files = (await readdir(dashboardDir)).filter((f) => f.endsWith('.js')).sort()
  assert.deepEqual(files, [
    'collaboration.js',
    'items-and-git.js',
    'shared.js',
    'snapshot.js',
  ])

  const graph = new Map()
  const importRe = /(?:import|export)\s+[\s\S]*?\s+from\s+['"]\.\/([^'"]+)['"]/g
  for (const file of files) {
    const src = await readFile(join(dashboardDir, file), 'utf8')
    const lineCount = src.split('\n').length
    assert.ok(lineCount < 650, `lib/dashboard/${file} has ${lineCount} lines (expected < 650)`)
    const deps = []
    for (const match of src.matchAll(importRe)) {
      if (files.includes(match[1])) deps.push(match[1])
    }
    graph.set(file, deps)
  }

  // DFS cycle detection across internal lib/dashboard/*.js imports
  const state = new Map()
  const visit = (node, stack) => {
    const cur = state.get(node)
    if (cur === 'visiting') {
      assert.fail(`cycle detected in lib/dashboard/: ${[...stack, node].join(' -> ')}`)
    }
    if (cur === 'visited') return
    state.set(node, 'visiting')
    for (const dep of graph.get(node) ?? []) {
      visit(dep, [...stack, node])
    }
    state.set(node, 'visited')
  }
  for (const file of files) visit(file, [])
})
