/**
 * Local Development Assistance & Standard Structure Library (devkit)
 *
 * Provides:
 * 1. Codebase structural scanning & zero-grep lookup (manifest.json)
 * 2. Standard machine-readable interface contract registry (contracts/*.json)
 * 3. Task archetype templates (templates/task-archetypes.json)
 * 4. Contract validation & cross-agent handoff utilities
 */

import { mkdir, readdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'

import DEFAULT_ARCHETYPES from './templates/task-archetypes.json' with { type: 'json' }

/**
 * Resolve devkit directory for a given working directory.
 * @param {string} cwd
 * @returns {string}
 */
export function devkitDir(cwd) {
  return join(cwd, '.agentteam', 'devkit')
}

/**
 * Extract exported symbols from file contents using zero-dependency regex.
 * @param {string} source - JavaScript / TypeScript source code.
 * @returns {string[]} list of exported symbol names.
 */
export function extractExports(source) {
  const exports = new Set()
  if (typeof source !== 'string' || source.length === 0) return []

  // export function foo / export async function foo / export class Foo
  const fnMatches = source.matchAll(/export\s+(?:async\s+)?(?:function\*?|class)\s+([A-Za-z0-9_$]+)/g)
  for (const m of fnMatches) if (m[1]) exports.add(m[1])

  // export const foo = / export let foo =
  const varMatches = source.matchAll(/export\s+(?:const|let|var)\s+([A-Za-z0-9_$]+)\s*=/g)
  for (const m of varMatches) if (m[1]) exports.add(m[1])

  // export { foo, bar as baz }
  const blockMatches = source.matchAll(/export\s*\{([^}]+)\}/g)
  for (const block of blockMatches) {
    if (!block[1]) continue
    const items = block[1].split(',')
    for (const item of items) {
      const parts = item.trim().split(/\s+as\s+/)
      const exportedName = (parts[1] ?? parts[0]).trim()
      if (/^[A-Za-z0-9_$]+$/.test(exportedName)) exports.add(exportedName)
    }
  }

  return [...exports].sort()
}

/**
 * Scan directory recursively for test files.
 * @param {string} dir
 * @returns {Promise<string[]>}
 */
async function findTestFiles(dir, rootDir) {
  const results = []
  try {
    const entries = await readdir(dir, { withFileTypes: true })
    for (const entry of entries) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === '.agentteam') continue
        const sub = await findTestFiles(full, rootDir)
        results.push(...sub)
      } else if (entry.isFile() && /\.(test|spec)\.(m?js|ts)$/.test(entry.name)) {
        results.push(relative(rootDir, full))
      }
    }
  } catch {
    /* directory unreadable, ignore */
  }
  return results
}

/**
 * Scan a project root or workspace to assemble a structural manifest.
 * @param {string} cwd - project root directory.
 * @returns {Promise<object>} manifest object.
 */
export async function scanCodebase(cwd) {
  const root = isAbsolute(cwd) ? cwd : join(process.cwd(), cwd)
  let pkg = {}
  try {
    const raw = await readFile(join(root, 'package.json'), 'utf8')
    pkg = JSON.parse(raw)
  } catch {
    pkg = {}
  }

  const manifest = {
    version: 1,
    project: pkg.name ?? basename(root),
    root: '.',
    runtime: {
      type: 'node',
      module: pkg.type === 'module' ? 'esm' : 'commonjs',
      testRunner: pkg.scripts?.test ? 'npm test' : 'node --test',
    },
    commands: {},
    modules: {},
    generatedAt: new Date().toISOString(),
  }

  // Extract commands from scripts
  if (pkg.scripts && typeof pkg.scripts === 'object') {
    for (const [name, command] of Object.entries(pkg.scripts)) {
      manifest.commands[name] = { command: String(command), description: `npm run ${name}` }
    }
  }

  // Scan root level entry
  const rootEntries = ['index.js', 'index.mjs', 'src/index.js', 'lib/index.js', 'main.js']
  let foundRootEntry = null
  for (const candidate of rootEntries) {
    try {
      const s = await stat(join(root, candidate))
      if (s.isFile()) {
        foundRootEntry = candidate
        break
      }
    } catch {}
  }

  if (foundRootEntry) {
    let exports = []
    try {
      const code = await readFile(join(root, foundRootEntry), 'utf8')
      exports = extractExports(code)
    } catch {}
    const rootTests = await findTestFiles(join(root, 'test'), root)
    manifest.modules['root'] = {
      path: '.',
      entry: foundRootEntry,
      exports,
      tests: rootTests,
      dependencies: Object.keys(pkg.dependencies ?? {}),
    }
  }

  // Scan src/*, lib/*, modules/* subdirectories for modular architectures
  for (const srcFolder of ['src', 'lib', 'modules']) {
    try {
      const parentDir = join(root, srcFolder)
      const entries = await readdir(parentDir, { withFileTypes: true })
      for (const entry of entries) {
        if (!entry.isDirectory()) continue
        const modDir = join(parentDir, entry.name)
        let modEntry = null
        for (const candidate of ['index.js', 'index.mjs', 'index.ts', `${entry.name}.js`, `${entry.name}.mjs`]) {
          try {
            const s = await stat(join(modDir, candidate))
            if (s.isFile()) {
              modEntry = join(srcFolder, entry.name, candidate)
              break
            }
          } catch {}
        }
        let modExports = []
        if (modEntry) {
          try {
            const code = await readFile(join(root, modEntry), 'utf8')
            modExports = extractExports(code)
          } catch {}
        }
        const modTests = await findTestFiles(join(root, 'test', entry.name), root)
        if (!manifest.modules[entry.name]) {
          manifest.modules[entry.name] = {
            path: join(srcFolder, entry.name),
            entry: modEntry,
            exports: modExports,
            tests: modTests,
            dependencies: [],
          }
        }
      }
    } catch {
      /* folder does not exist */
    }
  }

  // Scan packages/* directory if present (monorepo structure)
  try {
    const packagesDir = join(root, 'packages')
    const pkgs = await readdir(packagesDir, { withFileTypes: true })
    for (const p of pkgs) {
      if (!p.isDirectory()) continue
      const pkgDir = join(packagesDir, p.name)
      let subPkg = {}
      try {
        const raw = await readFile(join(pkgDir, 'package.json'), 'utf8')
        subPkg = JSON.parse(raw)
      } catch {
        subPkg = {}
      }

      let subEntry = null
      for (const candidate of ['index.js', 'index.mjs', 'lib/index.js', 'src/index.js']) {
        try {
          const s = await stat(join(pkgDir, candidate))
          if (s.isFile()) {
            subEntry = join('packages', p.name, candidate)
            break
          }
        } catch {}
      }

      let subExports = []
      if (subEntry) {
        try {
          const code = await readFile(join(root, subEntry), 'utf8')
          subExports = extractExports(code)
        } catch {}
      }

      const subTests = await findTestFiles(join(pkgDir, 'test'), root)
      const modName = subPkg.name ?? p.name
      manifest.modules[modName] = {
        path: join('packages', p.name),
        entry: subEntry,
        exports: subExports,
        tests: subTests,
        dependencies: Object.keys(subPkg.dependencies ?? {}),
      }
    }
  } catch {
    /* no packages directory, standard single-package repo */
  }

  return manifest
}

/**
 * Ensure the devkit directory and seed manifest/templates exist.
 * @param {string} cwd - project root directory.
 * @param {object} [options]
 * @param {boolean} [options.refresh] - force re-scan codebase manifest.
 * @returns {Promise<{ devkitPath: string, manifest: object }>}
 */
export async function ensureDevkit(cwd, options = {}) {
  const dir = devkitDir(cwd)
  await mkdir(join(dir, 'contracts'), { recursive: true })
  await mkdir(join(dir, 'templates'), { recursive: true })

  // Seed default task archetypes if not present
  const archetypesPath = join(dir, 'templates', 'task-archetypes.json')
  try {
    await stat(archetypesPath)
  } catch {
    await writeFile(archetypesPath, JSON.stringify(DEFAULT_ARCHETYPES, null, 2), 'utf8')
  }

  const manifestPath = join(dir, 'manifest.json')
  let manifest = null
  let exists = false
  try {
    const raw = await readFile(manifestPath, 'utf8')
    manifest = JSON.parse(raw)
    exists = true
  } catch {
    exists = false
  }

  if (!exists || options.refresh === true) {
    manifest = await scanCodebase(cwd)
    const tmp = `${manifestPath}.${process.pid}.${Date.now()}.tmp`
    await writeFile(tmp, JSON.stringify(manifest, null, 2), 'utf8')
    await rename(tmp, manifestPath)
  }

  return { devkitPath: dir, manifest }
}

/**
 * Fast zero-grep structural query against the local devkit.
 * @param {string} cwd - project root.
 * @param {object} query - `{ action, module, export_name }`
 * @returns {Promise<object>} query result.
 */
export async function lookupStructure(cwd, query = {}) {
  const { manifest } = await ensureDevkit(cwd)
  const action = String(query.action ?? (query.module ? 'module' : 'modules')).toLowerCase().trim()

  if (query.module || action === 'module') {
    const targetName = String(query.module ?? '').trim()
    const foundKey = Object.keys(manifest.modules).find(
      (k) => k === targetName || k.endsWith(`/${targetName}`) || targetName.endsWith(`/${k}`),
    )
    if (!foundKey) {
      return {
        found: false,
        error: `module "${targetName}" not found in devkit manifest`,
        available_modules: Object.keys(manifest.modules),
      }
    }
    return {
      found: true,
      module: foundKey,
      details: manifest.modules[foundKey],
    }
  }

  if (action === 'commands') {
    return {
      found: true,
      runtime: manifest.runtime,
      commands: manifest.commands,
    }
  }

  if (action === 'contracts') {
    const contracts = await listContracts(cwd)
    return {
      found: true,
      contracts,
    }
  }

  if (action === 'templates') {
    const archetypesPath = join(devkitDir(cwd), 'templates', 'task-archetypes.json')
    try {
      const raw = await readFile(archetypesPath, 'utf8')
      const parsed = JSON.parse(raw)
      return { found: true, archetypes: parsed.archetypes }
    } catch {
      return { found: true, archetypes: DEFAULT_ARCHETYPES.archetypes }
    }
  }

  if (action === 'search' || query.export_name) {
    const symbol = String(query.export_name ?? query.symbol ?? '').trim()
    const matches = []
    for (const [name, mod] of Object.entries(manifest.modules)) {
      if (Array.isArray(mod.exports) && mod.exports.includes(symbol)) {
        matches.push({ module: name, entry: mod.entry, path: mod.path })
      }
    }
    return {
      found: matches.length > 0,
      symbol,
      matches,
    }
  }

  // Default: list all known modules concisely
  const summary = {}
  for (const [name, mod] of Object.entries(manifest.modules)) {
    summary[name] = {
      path: mod.path,
      entry: mod.entry,
      exportsCount: mod.exports?.length ?? 0,
      testsCount: mod.tests?.length ?? 0,
    }
  }

  return {
    found: true,
    project: manifest.project,
    runtime: manifest.runtime,
    modules: summary,
  }
}

/**
 * List all interface contracts registered in devkit.
 * @param {string} cwd - project root.
 * @returns {Promise<Array<object>>} list of contract summaries.
 */
export async function listContracts(cwd) {
  const dir = join(devkitDir(cwd), 'contracts')
  const results = []
  try {
    const files = await readdir(dir)
    for (const file of files) {
      if (!file.endsWith('.json')) continue
      try {
        const raw = await readFile(join(dir, file), 'utf8')
        const parsed = JSON.parse(raw)
        results.push({
          id: parsed.$id ?? parsed.id ?? file.replace(/\.json$/, ''),
          title: parsed.title ?? file,
          version: parsed.version ?? '1.0.0',
          methods: Object.keys(parsed.methods ?? {}),
          file,
        })
      } catch {}
    }
  } catch {}
  return results
}

/**
 * Read a contract by ID from devkit.
 * @param {string} cwd
 * @param {string} contractId
 * @returns {Promise<object|null>}
 */
export async function readContract(cwd, contractId) {
  const safeId = String(contractId ?? '').replace(/[^A-Za-z0-9._-]/g, '_')
  const contractPath = join(devkitDir(cwd), 'contracts', `${safeId}.json`)
  try {
    const raw = await readFile(contractPath, 'utf8')
    return JSON.parse(raw)
  } catch {
    return null
  }
}

/**
 * Publish/persist an interface contract into devkit.
 * @param {string} cwd
 * @param {object} contract - `{ $id, title, version, methods, mock }`
 * @returns {Promise<{ ok: boolean, contractId: string, path: string }>}
 */
export async function publishContract(cwd, contract) {
  if (!contract || typeof contract !== 'object') throw new Error('Contract must be an object')
  const id = String(contract.$id ?? contract.id ?? '').trim()
  if (!id) throw new Error('Contract must have an "$id" or "id" field')
  if (!contract.methods || typeof contract.methods !== 'object') {
    throw new Error('Contract must specify a "methods" object')
  }

  const dir = join(devkitDir(cwd), 'contracts')
  await mkdir(dir, { recursive: true })
  const safeId = id.replace(/[^A-Za-z0-9._-]/g, '_')
  const target = join(dir, `${safeId}.json`)
  const tmp = `${target}.${process.pid}.${Date.now()}.tmp`
  await writeFile(tmp, JSON.stringify(contract, null, 2), 'utf8')
  await rename(tmp, target)

  return { ok: true, contractId: id, path: target }
}

/**
 * Validate that an array of exported function names satisfies a contract.
 * @param {object} contract
 * @param {string[]} exports - exported symbol names.
 * @returns {{ ok: boolean, missing: string[] }}
 */
export function validateContract(contract, exports = []) {
  if (!contract?.methods || typeof contract.methods !== 'object') {
    return { ok: true, missing: [] }
  }
  const declared = Object.keys(contract.methods)
  const actual = new Set(exports)
  const missing = declared.filter((m) => !actual.has(m))
  return {
    ok: missing.length === 0,
    missing,
  }
}

/**
 * Map JSON schema types to TypeScript types.
 * @param {string} [type]
 * @returns {string}
 */
function jsonTypeToTs(type) {
  switch (type) {
    case 'string': return 'string'
    case 'number':
    case 'integer': return 'number'
    case 'boolean': return 'boolean'
    case 'array': return 'any[]'
    case 'object': return 'Record<string, any>'
    default: return 'any'
  }
}

/**
 * Generate a sample default value from a schema.
 * @param {object} [schema]
 * @returns {any}
 */
function generateSampleValue(schema) {
  if (!schema || typeof schema !== 'object') return null
  if (schema.type === 'string') return ''
  if (schema.type === 'number' || schema.type === 'integer') return 0
  if (schema.type === 'boolean') return true
  if (schema.type === 'array') return []
  if (schema.properties && typeof schema.properties === 'object') {
    const obj = {}
    for (const [k, p] of Object.entries(schema.properties)) {
      obj[k] = generateSampleValue(p)
    }
    return obj
  }
  return null
}

/**
 * Generate a mock implementation stub, TypeScript definitions, or mock JSON for an interface contract.
 * @param {string} cwd - workspace root.
 * @param {object} contract - contract definition object.
 * @param {object} [options]
 * @param {'esm'|'dts'|'json'} [options.format='esm'] - target output format.
 * @param {string|null} [options.writeTo=null] - optional workspace-relative path to write the stub to.
 * @returns {Promise<{ code: string, path: string|null, written: boolean }>}
 */
export async function generateContractStub(cwd, contract, options = {}) {
  if (!contract || typeof contract !== 'object') throw new Error('Contract must be an object')
  const id = String(contract.$id ?? contract.id ?? 'unnamed-contract').trim()
  const title = String(contract.title ?? id).trim()
  const version = String(contract.version ?? '1.0.0').trim()
  const methods = contract.methods && typeof contract.methods === 'object' ? contract.methods : {}
  const mockFixtures = contract.mock && typeof contract.mock === 'object' ? contract.mock : {}
  const format = String(options.format ?? 'esm').toLowerCase().trim()

  let code = ''
  if (format === 'json' || format === 'mock') {
    code = JSON.stringify({ $id: id, title, version, mock: mockFixtures }, null, 2)
  } else if (format === 'dts' || format === 'ts') {
    const lines = [
      '/**',
      ` * TypeScript declarations for contract: ${title} (${version})`,
      ' * Auto-generated by Agent DevKit. Use for type checking and downstream integration.',
      ' */',
      '',
      'export const CONTRACT_ID: string;',
      '',
    ]

    for (const [name, def] of Object.entries(methods)) {
      const description = def?.description ? ` * ${def.description}\n` : ''
      const pascal = name.charAt(0).toUpperCase() + name.slice(1)
      const inputType = `${pascal}Input`
      const outputType = `${pascal}Output`

      lines.push(`export interface ${inputType} {`)
      if (def?.input?.properties && typeof def.input.properties === 'object') {
        const req = new Set(Array.isArray(def.input.required) ? def.input.required : [])
        for (const [prop, pDef] of Object.entries(def.input.properties)) {
          const opt = req.has(prop) ? '' : '?'
          const tsType = jsonTypeToTs(pDef?.type)
          lines.push(`  ${prop}${opt}: ${tsType};`)
        }
      } else {
        lines.push('  [key: string]: any;')
      }
      lines.push('}')
      lines.push('')

      lines.push(`export interface ${outputType} {`)
      if (def?.output?.properties && typeof def.output.properties === 'object') {
        const req = new Set(Array.isArray(def.output.required) ? def.output.required : [])
        for (const [prop, pDef] of Object.entries(def.output.properties)) {
          const opt = req.has(prop) ? '' : '?'
          const tsType = jsonTypeToTs(pDef?.type)
          lines.push(`  ${prop}${opt}: ${tsType};`)
        }
      } else {
        lines.push('  [key: string]: any;')
      }
      lines.push('}')
      lines.push('')

      lines.push('/**')
      if (description) lines.push(description.trimEnd())
      lines.push(` * @param args ${inputType}`)
      lines.push(` * @returns Promise<${outputType}>`)
      lines.push(' */')
      lines.push(`export declare function ${name}(args?: ${inputType}): Promise<${outputType}>;`)
      lines.push('')
    }
    code = lines.join('\n')
  } else {
    // ESM format (default)
    const lines = [
      '/**',
      ` * Mock implementation stub for contract: ${title} (${version})`,
      ' * Auto-generated by Agent DevKit for local mock testing & parallel development.',
      ' */',
      '',
      `export const CONTRACT_ID = ${JSON.stringify(id)}`,
      '',
      `export const MOCK_FIXTURES = ${JSON.stringify(mockFixtures, null, 2)}`,
      '',
    ]

    for (const [name, def] of Object.entries(methods)) {
      const description = def?.description ? ` * ${def.description}\n` : ''
      lines.push('/**')
      if (description) lines.push(description.trimEnd())
      lines.push(' * @param {any} [args]')
      lines.push(' * @returns {Promise<any>}')
      lines.push(' */')
      lines.push(`export async function ${name}(args) {`)
      lines.push(`  if (MOCK_FIXTURES[${JSON.stringify(name)}] !== undefined) {`)
      lines.push(`    return structuredClone(MOCK_FIXTURES[${JSON.stringify(name)}])`)
      lines.push('  }')
      const defaultReturn = generateSampleValue(def?.output)
      lines.push(`  return ${JSON.stringify(defaultReturn, null, 2)}`)
      lines.push('}')
      lines.push('')
    }
    code = lines.join('\n')
  }

  let written = false
  let targetPath = null
  if (options.writeTo && typeof options.writeTo === 'string') {
    const rawTarget = options.writeTo.trim()
    const resolved = resolve(cwd, rawTarget)
    const normalizedCwd = resolve(cwd)
    if (!resolved.startsWith(normalizedCwd)) {
      throw new Error(`Target path "${rawTarget}" escapes workspace root`)
    }
    await mkdir(dirname(resolved), { recursive: true })
    await writeFile(resolved, code, 'utf8')
    written = true
    targetPath = relative(cwd, resolved) || resolved
  }

  return { code, path: targetPath, written }
}

/**
 * Validate an item handoff packet against registered devkit contracts.
 * @param {string} cwd - workspace root.
 * @param {object} handoffPacket - handoff packet from report or item.
 * @returns {Promise<{ ok: boolean, contractId?: string, declaredMethods?: string[], actualExports?: string[], missing?: string[], entryExists?: boolean, error?: string, skipped?: boolean, reason?: string }>}
 */
export async function validateItemHandoff(cwd, handoffPacket) {
  if (!handoffPacket || typeof handoffPacket !== 'object') {
    return { ok: true, skipped: true, reason: 'no handoff packet' }
  }
  const contractId = String(handoffPacket.contractId ?? handoffPacket.contract_id ?? '').trim()
  if (!contractId) {
    return { ok: true, skipped: true, reason: 'no contract id specified' }
  }

  const contract = await readContract(cwd, contractId)
  if (!contract) {
    return {
      ok: false,
      contractId,
      error: `Contract "${contractId}" not found in devkit registry`,
      missing: [],
      declaredMethods: [],
      actualExports: [],
      entryExists: false,
    }
  }

  const exportsSet = new Set(
    Array.isArray(handoffPacket.exports) ? handoffPacket.exports.map(String).filter(Boolean) : []
  )

  let entryExists = false
  if (handoffPacket.entry && typeof handoffPacket.entry === 'string') {
    const entryPath = resolve(cwd, handoffPacket.entry)
    const normalizedCwd = resolve(cwd)
    if (entryPath.startsWith(normalizedCwd)) {
      try {
        const content = await readFile(entryPath, 'utf8')
        entryExists = true
        const parsed = extractExports(content)
        for (const exp of parsed) exportsSet.add(exp)
      } catch {
        entryExists = false
      }
    }
  }

  const actualExports = Array.from(exportsSet)
  const validation = validateContract(contract, actualExports)

  return {
    ok: validation.ok,
    contractId,
    declaredMethods: Object.keys(contract.methods || {}),
    actualExports,
    missing: validation.missing,
    entryExists,
  }
}
