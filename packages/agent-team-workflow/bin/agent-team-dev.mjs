#!/usr/bin/env node

/**
 * Agent Team DevKit CLI
 *
 * Local zero-grep architecture inspection, contract management, and mock stub generation.
 *
 * Commands:
 *   agent-team-dev scan [dir] [--refresh]
 *   agent-team-dev inspect [module]
 *   agent-team-dev contracts
 *   agent-team-dev contract <contractId>
 *   agent-team-dev stub <contractId> [--format esm|dts|json] [--write <file>]
 *   agent-team-dev validate <contractId> (--exports <sym1,sym2> | --entry <file>)
 */

import { resolve } from 'node:path'
import {
  ensureDevkit,
  generateContractStub,
  listContracts,
  lookupStructure,
  readContract,
  validateItemHandoff,
} from '../lib/devkit.js'

function printHelp() {
  console.log(`
Agent Team DevKit CLI - Zero-Grep Codebase Architecture & Contract Registry

Usage:
  agent-team-dev <command> [options]

Commands:
  scan [dir] [--refresh]                               Scan codebase & update manifest.json
  inspect [module]                                     Inspect project structure or a specific module
  contracts                                            List all registered interface contracts
  contract <contract-id>                               View full contract specification
  stub <contract-id> [--format <fmt>] [--write <path>] Generate mock/dts stub (esm|dts|json)
  validate <contract-id> [--entry <file>] [--exports <a,b>] Validate exports against a contract

Options:
  --cwd <path>      Specify working directory (default: current directory)
  --format <fmt>    Stub format: esm (default), dts, or json
  --write <path>    Write generated stub to file path
  --refresh         Force fresh codebase scan
  --json            Output raw JSON response
  --help, -h        Show this help message
`)
}

// Parse args
const argv = process.argv.slice(2)
if (argv.length === 0 || argv.includes('--help') || argv.includes('-h')) {
  printHelp()
  process.exit(0)
}

const command = argv[0].toLowerCase()

// Helper to extract flags
function getFlag(flag) {
  const idx = argv.indexOf(flag)
  if (idx !== -1 && idx + 1 < argv.length) return argv[idx + 1]
  return null
}
const isJson = argv.includes('--json')
const isRefresh = argv.includes('--refresh')
const cwd = resolve(getFlag('--cwd') ?? process.cwd())

async function run() {
  switch (command) {
    case 'scan': {
      const targetDir = argv.slice(1).find((a) => !a.startsWith('--')) ?? cwd
      const resolvedDir = resolve(targetDir)
      console.log(`[devkit] Scanning codebase at: ${resolvedDir}`)
      const res = await ensureDevkit(resolvedDir, { refresh: true })
      if (isJson) {
        console.log(JSON.stringify(res.manifest, null, 2))
      } else {
        console.log(`[devkit] Manifest written to: ${res.devkitPath}/manifest.json`)
        console.log(`[devkit] Project: ${res.manifest.project} (${res.manifest.runtime.type}/${res.manifest.runtime.module})`)
        console.log(`[devkit] Discovered ${Object.keys(res.manifest.modules).length} modules:`)
        for (const [name, mod] of Object.entries(res.manifest.modules)) {
          console.log(`  - ${name.padEnd(16)} entry: ${mod.entry ?? '(none)'}`)
        }
      }
      break
    }
    case 'inspect': {
      const modName = argv.slice(1).find((a) => !a.startsWith('--'))
      if (modName) {
        const res = await lookupStructure(cwd, { action: 'module', module: modName })
        if (isJson) {
          console.log(JSON.stringify(res, null, 2))
        } else if (!res.found) {
          console.log(`[devkit] Module "${modName}" not found in manifest. Run 'scan' first.`)
        } else {
          const details = res.details || {}
          console.log(`Module: ${res.module}`)
          console.log(`  Path:         ${details.path}`)
          console.log(`  Entry:        ${details.entry ?? '(none)'}`)
          console.log(`  Exports (${(details.exports || []).length}):  ${(details.exports || []).join(', ') || '(none)'}`)
          console.log(`  Tests (${(details.tests || []).length}):    ${(details.tests || []).join(', ') || '(none)'}`)
          console.log(`  Dependencies: ${(details.dependencies || []).join(', ') || '(none)'}`)
        }
      } else {
        const res = await lookupStructure(cwd, { action: 'modules' })
        if (isJson) {
          console.log(JSON.stringify(res, null, 2))
        } else {
          console.log(`Project: ${res.project} (${res.runtime.type}/${res.runtime.module})`)
          console.log(`Modules (${res.count}):`)
          for (const [name, mod] of Object.entries(res.modules)) {
            console.log(`  - ${name.padEnd(16)} ${mod.entry ?? mod.path}`)
          }
        }
      }
      break
    }
    case 'contracts': {
      const contracts = await listContracts(cwd)
      if (isJson) {
        console.log(JSON.stringify(contracts, null, 2))
      } else if (contracts.length === 0) {
        console.log('[devkit] No interface contracts found in .agentteam/devkit/contracts/')
      } else {
        console.log(`Registered Interface Contracts (${contracts.length}):`)
        for (const c of contracts) {
          console.log(`  - ${c.id.padEnd(24)} "${c.title}" (v${c.version}) -> [${c.methods.join(', ')}]`)
        }
      }
      break
    }
    case 'contract': {
      const contractId = argv.slice(1).find((a) => !a.startsWith('--'))
      if (!contractId) {
        console.error('Error: missing contract id. Usage: agent-team-dev contract <contractId>')
        process.exit(1)
      }
      const contract = await readContract(cwd, contractId)
      if (!contract) {
        console.error(`Error: contract "${contractId}" not found.`)
        process.exit(1)
      }
      if (isJson) {
        console.log(JSON.stringify(contract, null, 2))
      } else {
        console.log(`Contract: ${contract.$id ?? contract.id} - ${contract.title} (v${contract.version})`)
        console.log('Methods:')
        for (const [name, def] of Object.entries(contract.methods || {})) {
          console.log(`  - ${name}: ${def.description ?? '(no description)'}`)
        }
        if (contract.mock) {
          console.log(`Mocks available: ${Object.keys(contract.mock).join(', ')}`)
        }
      }
      break
    }
    case 'stub': {
      const contractId = argv.slice(1).find((a) => !a.startsWith('--'))
      if (!contractId) {
        console.error('Error: missing contract id. Usage: agent-team-dev stub <contractId> [--format esm|dts|json] [--write <path>]')
        process.exit(1)
      }
      const contract = await readContract(cwd, contractId)
      if (!contract) {
        console.error(`Error: contract "${contractId}" not found.`)
        process.exit(1)
      }
      const format = getFlag('--format') ?? 'esm'
      const writeTo = getFlag('--write')
      const res = await generateContractStub(cwd, contract, { format, writeTo })
      if (res.written) {
        console.log(`[devkit] Generated ${format.toUpperCase()} stub written to: ${res.path}`)
      } else {
        console.log(res.code)
      }
      break
    }
    case 'validate': {
      const contractId = argv.slice(1).find((a) => !a.startsWith('--'))
      if (!contractId) {
        console.error('Error: missing contract id. Usage: agent-team-dev validate <contractId> [--entry <file>] [--exports <a,b>]')
        process.exit(1)
      }
      const entry = getFlag('--entry')
      const exportsStr = getFlag('--exports')
      const exports = exportsStr ? exportsStr.split(',').map((s) => s.trim()).filter(Boolean) : []
      const res = await validateItemHandoff(cwd, {
        contract_id: contractId,
        entry,
        exports,
      })
      if (isJson) {
        console.log(JSON.stringify(res, null, 2))
      } else if (res.ok) {
        console.log(`[devkit] Contract "${contractId}" is SATISFIED!`)
        console.log(`  Methods declared: ${res.declaredMethods.join(', ')}`)
        console.log(`  Actual exports:   ${res.actualExports.join(', ')}`)
      } else {
        console.error(`[devkit] Contract "${contractId}" FAILED validation!`)
        if (res.error) console.error(`  Error: ${res.error}`)
        if (res.missing?.length > 0) console.error(`  Missing required methods: ${res.missing.join(', ')}`)
        process.exit(1)
      }
      break
    }
    default: {
      console.error(`Unknown command: "${command}"`)
      printHelp()
      process.exit(1)
    }
  }
}

run().catch((err) => {
  console.error(`[devkit] Error: ${err.message}`)
  process.exit(1)
})
