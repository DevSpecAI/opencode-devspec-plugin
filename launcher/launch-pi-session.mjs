#!/usr/bin/env node
/**
 * Start a fresh interactive Pi session for a signed DevSpec handoff.
 *
 * Runtime overrides are deliberately optional. Omitting --model and --thinking
 * lets Pi use the user's own current/default configuration.
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import { quoteWinCmdArg, spawnAgent, spawnAgentSync } from './spawn.mjs'

/** @param {unknown} value */
function shellSingleQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`
}

/**
 * Open a visible Pi terminal for fleet settle (match session / non-settle UX).
 * Returns the starter process (Windows `start`, macOS Terminal, Linux emulator).
 * @param {{ piBin: string, piArgs: string[], folder: string }} opts
 */
export function buildWindowsVisiblePiStartArgs(piBin, piArgs) {
  const cmdline = [quoteWinCmdArg(piBin), ...piArgs.map(quoteWinCmdArg)].join(' ')
  return ['/c', 'start', 'DevSpec Pi', 'cmd.exe', '/k', cmdline]
}

export function spawnVisiblePiTerminal({ piBin, piArgs, folder }) {
  if (process.platform === 'win32') {
    return spawn('cmd.exe', buildWindowsVisiblePiStartArgs(piBin, piArgs), {
      cwd: folder,
      detached: true,
      stdio: 'ignore',
      // Hide the ephemeral `start` helper — not the /k console it opens.
      windowsHide: true,
    })
  }

  if (process.platform === 'darwin') {
    const cmd = `cd ${shellSingleQuote(folder)} && ${shellSingleQuote(piBin)} ${piArgs
      .map(shellSingleQuote)
      .join(' ')}`
    return spawn('osascript', ['-e', `tell application "Terminal" to do script ${JSON.stringify(cmd)}`], {
      detached: true,
      stdio: 'ignore',
    })
  }

  const linuxCmd = `cd ${shellSingleQuote(folder)} && ${shellSingleQuote(piBin)} ${piArgs
    .map(shellSingleQuote)
    .join(' ')}`
  const terminals = [
    ['x-terminal-emulator', ['-e', 'bash', '-lc', linuxCmd]],
    ['gnome-terminal', ['--', 'bash', '-lc', linuxCmd]],
    ['konsole', ['-e', 'bash', '-lc', linuxCmd]],
    ['xfce4-terminal', ['-e', `bash -lc ${shellSingleQuote(linuxCmd)}`]],
  ]
  for (const [bin, termArgs] of terminals) {
    try {
      const child = spawn(bin, termArgs, {
        cwd: folder,
        detached: true,
        stdio: 'ignore',
      })
      if (child.pid) return child
    } catch {
      // try next emulator
    }
  }
  // Last resort: detached Pi without hiding the process group.
  return spawnAgent(piBin, piArgs, {
    cwd: folder,
    stdio: 'ignore',
    detached: true,
    windowsHide: false,
    encoding: 'utf8',
  })
}

export const PI_THINKING_LEVELS = Object.freeze([
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
])

export function parsePiLaunchArgs(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--folder' && argv[i + 1]) out.folder = argv[++i]
    else if (arg === '--prompt-file' && argv[i + 1]) out.promptFile = argv[++i]
    else if (arg === '--pi' && argv[i + 1]) out.pi = argv[++i]
    else if (arg === '--model' && argv[i + 1]) out.model = argv[++i]
    else if (arg === '--thinking' && argv[i + 1]) out.thinking = argv[++i]
  }
  return out
}

export function buildPiLaunchArgs(promptBody, options = {}) {
  const args = []
  const model = typeof options.model === 'string' ? options.model.trim() : ''
  if (model) args.push('--model', model)

  const thinking = typeof options.thinking === 'string' ? options.thinking.trim() : ''
  if (PI_THINKING_LEVELS.includes(thinking)) args.push('--thinking', thinking)

  const prompt = String(promptBody ?? '').trim()
  if (prompt) args.push('--', prompt)
  return args
}

async function main() {
  const args = parsePiLaunchArgs(process.argv.slice(2))
  if (!args.folder || !args.promptFile) {
    console.error(
      'Usage: launch-pi-session.mjs --folder <path> --prompt-file <path> [--pi <path>] [--model <provider/id>] [--thinking <level>]',
    )
    process.exitCode = 1
    return
  }

  let promptBody
  try {
    promptBody = await fs.readFile(args.promptFile, 'utf8')
  } catch (error) {
    console.error(`[devspec-pi] could not read prompt file: ${error}`)
    process.exitCode = 1
    return
  }

  const piBin = args.pi || 'pi'
  const piArgs = buildPiLaunchArgs(promptBody, {
    model: args.model,
    thinking: args.thinking,
  })

  // Fleet ready-gate: open a *visible* Pi terminal (same class as session
  // launch), then exit so the next recipe child can launch. Interactive
  // (non-fleet) waits on Pi in this process.
  if (process.env.DEVSPEC_FLEET_SETTLE === '1') {
    const child = spawnVisiblePiTerminal({
      piBin,
      piArgs,
      folder: args.folder,
    })
    child.on('error', (err) => {
      console.error(`[devspec-pi] failed to start Pi: ${err.message}`)
      process.exitCode = 1
    })
    if (!child.pid) {
      console.error('[devspec-pi] Pi spawn returned no pid')
      process.exitCode = 1
      return
    }
    try {
      child.unref()
    } catch {
      // ignore
    }
    console.log(`[devspec-pi] Fleet settle: visible Pi terminal started pid=${child.pid}`)
    process.exit(0)
  }

  const result = spawnAgentSync(piBin, piArgs, {
    cwd: args.folder,
    stdio: 'inherit',
    encoding: 'utf8',
  })
  if (result.error) {
    console.error(`[devspec-pi] failed to start Pi: ${result.error.message}`)
    process.exitCode = 1
    return
  }
  process.exitCode = result.status ?? 0
}

if (process.argv[1]?.endsWith('launch-pi-session.mjs')) {
  void main()
}
