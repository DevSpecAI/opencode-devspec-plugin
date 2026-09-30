#!/usr/bin/env node
/** Interactive Claude Code only; plugin hooks own DevSpec registration and delivery. */
import fs from 'node:fs/promises'
import { spawnAgentSync } from './spawn.mjs'

export function buildClaudeLaunchArgs(promptBody, { model } = {}) {
  const args = []
  const selected = typeof model === 'string' ? model.trim() : ''
  if (selected) {
    if (selected.startsWith('-') || /[\x00-\x1f\x7f]/.test(selected)) throw new Error('Invalid Claude Code model')
    args.push('--model', selected)
  }
  const prompt = String(promptBody ?? '').trim()
  if (prompt) args.push('--', prompt)
  return args
}

export function parseClaudeLaunchArgs(argv) {
  const out = {}
  const fields = { '--folder': 'folder', '--prompt-file': 'promptFile', '--claude': 'claude', '--model': 'model' }
  for (let i = 0; i < argv.length; i++) {
    const key = fields[argv[i]]
    if (!key || !argv[i + 1]) throw new Error('Invalid Claude Code launcher arguments')
    out[key] = argv[++i]
  }
  return out
}

async function main() {
  try {
    const args = parseClaudeLaunchArgs(process.argv.slice(2))
    if (!args.folder || !args.promptFile || !args.claude) throw new Error('Expected --folder, --prompt-file and --claude')
    const prompt = await fs.readFile(args.promptFile, 'utf8')
    // No --print, permission bypass, channel preview or frozen model defaults.
    const result = spawnAgentSync(args.claude, buildClaudeLaunchArgs(prompt, args), {
      cwd: args.folder, stdio: 'inherit', encoding: 'utf8',
    })
    if (result.error) throw result.error
    process.exitCode = result.status ?? 1
  } catch (error) {
    console.error(`[devspec-claude] ${error.message}`)
    process.exitCode = 1
  }
}
if (process.argv[1]?.endsWith('launch-claude-session.mjs')) void main()
