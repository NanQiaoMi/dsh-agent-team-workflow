/**
 * Zero-grep codebase lookup and interface contract tools.
 */

import {
  ensureDevkit,
  generateContractStub,
  listContracts,
  lookupStructure,
  publishContract,
  readContract,
  scaffoldContract,
  validateContract,
} from '../devkit.js'
import { jsonOutput, resolveCaller } from './shared.js'

export function buildDomainTools({ ctx, store, version }) {
  return [
    {
      name: 'team_dev_lookup',
      description:
        'Structural query against codebase manifest, modules, contracts, or templates.',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['modules', 'module', 'commands', 'contracts', 'templates', 'search'] },
          module: { type: 'string' },
          export_name: { type: 'string' },
          refresh: { type: 'boolean' },
        },
        additionalProperties: false,
      },
      output: jsonOutput({
        type: 'object',
        properties: {
          found: { type: 'boolean' },
          project: { type: 'string' },
          runtime: {},
          modules: {},
          module: { type: 'string' },
          details: {},
          commands: {},
          contracts: { type: 'array', items: {} },
          archetypes: {},
          symbol: { type: 'string' },
          matches: { type: 'array', items: {} },
          error: { type: 'string' },
          available_modules: { type: 'array', items: { type: 'string' } },
        },
      }),
      async execute(args, exec) {
        const { agent } = resolveCaller(ctx, exec, 'team_dev_lookup')
        const cwd = store.workingDir(agent)
        if (args.refresh) {
          await ensureDevkit(cwd, { refresh: true })
        }
        return await lookupStructure(cwd, args)
      },
    },
    {
      name: 'team_dev_contract',
      description:
        'Manage interface contracts: list, read, publish, validate, stub, or scaffold.',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['list', 'read', 'publish', 'validate', 'stub', 'scaffold'] },
          contract_id: { type: 'string' },
          module: { type: 'string' },
          entry: { type: 'string' },
          contract: { type: 'object' },
          exports: { type: 'array', items: { type: 'string' } },
          format: { type: 'string', enum: ['esm', 'dts', 'json'] },
          write_to: { type: 'string' },
        },
        required: ['action'],
        additionalProperties: false,
      },
      output: jsonOutput({
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          contract_id: { type: 'string' },
          path: { type: 'string' },
          code: { type: 'string' },
          written: { type: 'boolean' },
          methods: { type: 'array', items: { type: 'string' } },
          method_count: { type: 'number' },
          contract: {},
          contracts: { type: 'array', items: {} },
          validation: {},
          error: { type: 'string' },
        },
      }),
      async execute(args, exec) {
        const { agent } = resolveCaller(ctx, exec, 'team_dev_contract')
        const cwd = store.workingDir(agent)
        const action = String(args.action ?? '').toLowerCase().trim()

        if (action === 'list') {
          const contracts = await listContracts(cwd)
          return { ok: true, contracts }
        }
        if (action === 'read') {
          if (!args.contract_id) throw new Error('team_dev_contract { action: "read" } requires contract_id')
          const contract = await readContract(cwd, args.contract_id)
          if (!contract) return { ok: false, error: `contract "${args.contract_id}" not found` }
          return { ok: true, contract }
        }
        if (action === 'publish') {
          if (!args.contract) throw new Error('team_dev_contract { action: "publish" } requires contract definition object')
          const published = await publishContract(cwd, args.contract)
          return { ok: true, contract_id: published.contractId, path: published.path }
        }
        if (action === 'validate') {
          if (!args.contract_id) throw new Error('team_dev_contract { action: "validate" } requires contract_id')
          const contract = await readContract(cwd, args.contract_id)
          if (!contract) return { ok: false, error: `contract "${args.contract_id}" not found` }
          const validation = validateContract(contract, args.exports ?? [])
          return { ok: validation.ok, contract_id: args.contract_id, validation }
        }
        if (action === 'stub' || action === 'mock') {
          if (!args.contract_id) throw new Error('team_dev_contract { action: "stub" } requires contract_id')
          const contract = await readContract(cwd, args.contract_id)
          if (!contract) return { ok: false, error: `contract "${args.contract_id}" not found` }
          const res = await generateContractStub(cwd, contract, {
            format: args.format,
            writeTo: args.write_to,
          })
          return { ok: true, contract_id: args.contract_id, ...res }
        }
        if (action === 'scaffold') {
          const res = await scaffoldContract(cwd, {
            module: args.module,
            entry: args.entry,
            contractId: args.contract_id,
            title: args.contract?.title,
            version: args.contract?.version,
          })
          return {
            ok: true,
            contract_id: res.contractId,
            path: res.path,
            methods: res.methods,
            method_count: res.methodCount,
          }
        }
        throw new Error(`unknown action "${action}"; use list, read, publish, validate, stub, or scaffold`)
      },
    },
  ]
}
