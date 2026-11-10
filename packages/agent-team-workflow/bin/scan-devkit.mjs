#!/usr/bin/env node

/**
 * Scan codebase and generate or refresh the local devkit structural manifest.
 *
 * Usage:
 *   node bin/scan-devkit.mjs [cwd] [--refresh]
 */

import { resolve } from 'node:path'
import { ensureDevkit } from '../lib/devkit.js'

const args = process.argv.slice(2)
const refresh = args.includes('--refresh')
const targetDir = args.find((a) => !a.startsWith('--')) ?? process.cwd()
const cwd = resolve(targetDir)

try {
  console.log(`[devkit] Scanning codebase at: ${cwd}`)
  const { devkitPath, manifest } = await ensureDevkit(cwd, { refresh: true })
  console.log(`[devkit] Manifest written to: ${devkitPath}/manifest.json`)
  console.log(`[devkit] Project: ${manifest.project} (${manifest.runtime.type}/${manifest.runtime.module})`)
  console.log(`[devkit] Modules discovered: ${Object.keys(manifest.modules).length}`)
  for (const [name, mod] of Object.entries(manifest.modules)) {
    console.log(`  - ${name}: entry="${mod.entry ?? '(none)'}", exports=${mod.exports.length}, tests=${mod.tests.length}`)
  }
} catch (err) {
  console.error(`[devkit] Scan failed: ${err.message}`)
  process.exit(1)
}
