/**
 * Spawning a coding agent, and the Windows plumbing that makes it survive a
 * console.
 *
 * Host-independent by design: nothing here knows which agent it is starting, and
 * nothing here talks to DevSpec. Resolving credentials and registering a
 * connection are the PLUGIN's job — the launcher's contract (ADR 8ced3e43, D1) is
 * signed-token verification, the repo->folder map, and this spawn ladder.
 *
 * Extracted from the Cursor plugin's launch-cli-session.mjs, which had grown both
 * halves; the connect half stayed behind with its host.
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawn, spawnSync, execFileSync } from 'node:child_process'
import { npmNodeShimEntry, resolveNodeRuntime } from './node-runtime.mjs'

/**
 * Quote a single Windows command-line argument for `cmd.exe /s /c`.
 * @param {string} value
 * @returns {string}
 */
export function quoteWinCmdArg(value) {
  const s = String(value)
  if (s.length === 0) return '""'
  if (!/[\s"&<>|^()]/.test(s)) return s
  return `"${s.replace(/"/g, '""')}"`
}

/**
 * Windows console titles cannot carry quotes or cmd metacharacters (item 20900b80).
 * @param {unknown} raw
 * @returns {string}
 */
export function sanitizeWindowsConsoleTitle(raw) {
  return String(raw ?? '')
    .replace(/["\r\n]/g, '')
    .replace(/[&|<>^%!]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Cursor CLI window title: server-minted codename after Live, unique launch stamp before.
 * Never the hardcoded `DevSpec Cursor CLI` (item 20900b80).
 * @param {{ codename?: string | null, stamp?: string | null }} [opts]
 * @returns {string}
 */
export function composeWindowsConsoleTitle(opts = {}) {
  const name = sanitizeWindowsConsoleTitle(opts.codename)
  if (name) return `DevSpec Cursor · ${name}`
  const stamp = sanitizeWindowsConsoleTitle(opts.stamp)
  if (stamp) return `DevSpec Cursor · ${stamp}`
  return 'DevSpec Cursor'
}

/**
 * argv for `cmd.exe` after the executable: titled cmd /k, never wt.exe.
 * @param {string} batPath
 * @param {string} title
 * @returns {string[]}
 */
export function windowsConsoleStartArgs(batPath, title) {
  const safe = sanitizeWindowsConsoleTitle(title) || composeWindowsConsoleTitle()
  return ['/c', 'start', safe, 'cmd.exe', '/k', batPath]
}

/**
 * Retitle this console after fast-connect so the cmd window shows the minted codename.
 * @param {string} title
 * @param {{
 *   platform?: NodeJS.Platform,
 *   setProcessTitle?: (t: string) => void,
 *   execTitle?: (safe: string) => void,
 * }} [io]
 */
export function applyWindowsConsoleTitle(title, io = {}) {
  const safe = sanitizeWindowsConsoleTitle(title)
  if (!safe) return { ok: false, title: '' }
  const setTitle = io.setProcessTitle || ((t) => {
    process.title = t
  })
  setTitle(safe)
  const platform = io.platform ?? process.platform
  if (platform === 'win32') {
    const execTitle =
      io.execTitle ||
      ((t) => {
        execFileSync('cmd.exe', ['/c', `title ${t}`], {
          stdio: 'ignore',
          windowsHide: true,
          timeout: 2000,
        })
      })
    try {
      execTitle(safe)
    } catch {
      /* process.title still applied */
    }
  }
  return { ok: true, title: safe }
}

/**
 * @deprecated Prefer resolveWindowsAgentInvocation + spawnAgent*.
 * @param {string} bin
 * @param {NodeJS.Platform} [platform]
 * @returns {string}
 */
export function resolveShellExecutable(bin, platform = process.platform) {
  const trimmed = String(bin ?? '').trim()
  if (!trimmed) return trimmed
  if (platform !== 'win32') return trimmed
  if (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2) {
    return trimmed
  }
  if (!/[\s&<>|^()"]/.test(trimmed)) return trimmed
  return `"${trimmed.replace(/"/g, '')}"`
}

/**
 * Resolve how to invoke the Cursor agent CLI without `shell: true` / nested `cmd /c`.
 *
 * On Windows, `agent.cmd` re-enters PowerShell; wrapping that in `cmd /c` loses a real
 * console TTY, so the interactive agent exits immediately and Windows Terminal
 * flash-closes. Prefer `powershell.exe -File <sibling>.ps1` with a normal argv array.
 *
 * @param {string} agentBin
 * @param {{ existsSync?: (p: string) => boolean }} [io]
 * @returns {{ command: string, prefixArgs: string[], mode: 'powershell-ps1' | 'direct' | 'cmd-fallback' }}
 */
export function resolveWindowsAgentInvocation(agentBin, io = { existsSync: fs.existsSync }) {
  const bin = String(agentBin ?? '').trim() || 'agent'
  if (process.platform !== 'win32') {
    return { command: bin, prefixArgs: [], mode: 'direct' }
  }

  const npmEntry = npmNodeShimEntry(bin, { exists: io.existsSync })
  if (npmEntry) return { command: resolveNodeRuntime(), prefixArgs: [npmEntry], mode: 'direct' }

  const lower = bin.toLowerCase()
  /** @type {string[]} */
  const ps1Candidates = []
  if (lower.endsWith('.ps1')) {
    ps1Candidates.push(bin)
  } else if (lower.endsWith('.cmd') || lower.endsWith('.bat')) {
    ps1Candidates.push(bin.replace(/\.(cmd|bat)$/i, '.ps1'))
    // agent.cmd and cursor-agent.cmd both ship a matching .ps1 beside them.
    const dir = path.dirname(bin)
    const base = path.basename(bin, path.extname(bin))
    ps1Candidates.push(path.join(dir, `${base}.ps1`))
    if (base.toLowerCase() === 'agent') {
      ps1Candidates.push(path.join(dir, 'cursor-agent.ps1'))
    }
  }

  for (const candidate of ps1Candidates) {
    if (candidate && io.existsSync(candidate)) {
      return {
        command: process.env.SystemRoot
          ? path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
          : 'powershell.exe',
        prefixArgs: ['-NoProfile', '-File', candidate],
        mode: 'powershell-ps1',
      }
    }
  }

  // A real native .exe (e.g. OpenCode, which ships a compiled binary rather
  // than an npm .cmd/.ps1 shim trio like Cursor's `agent`) needs no shell at
  // all — spawn it directly. Real bug found live-testing: routing a bare
  // .exe through the cmd.exe /c wrapping below added an unnecessary shell
  // hop that a visible console window kept leaking through on regardless of
  // windowsHide, even with stdio:'ignore' set on every spawn call.
  if (lower.endsWith('.exe')) {
    return { command: bin, prefixArgs: [], mode: 'direct' }
  }

  // Bare `agent` on PATH — let cmd resolve it (no absolute spaced path).
  if (!/[\\/]/.test(bin) && !/\.(cmd|bat|ps1|exe)$/i.test(bin)) {
    return { command: bin, prefixArgs: [], mode: 'cmd-fallback' }
  }

  return { command: bin, prefixArgs: [], mode: 'cmd-fallback' }
}

/**
 * Flatten multiline prompts for argv safety (newlines break `cmd /c` command lines).
 * @param {string} text
 * @returns {string}
 */
export function flattenPromptForArgv(text) {
  return String(text).replace(/\r\n/g, '\n').replace(/\n+/g, ' ').trim()
}

/**
 * @param {string} agentBin
 * @param {string[]} args
 * @param {import('node:child_process').SpawnSyncOptionsWithStringEncoding} opts
 */
export function spawnAgentSync(agentBin, args, opts) {
  const inv = resolveWindowsAgentInvocation(agentBin)
  if (inv.mode === 'powershell-ps1' || inv.mode === 'direct') {
    return spawnSync(inv.command, [...inv.prefixArgs, ...args], {
      ...opts,
      shell: false,
      windowsHide: true,
    })
  }
  if (process.platform !== 'win32') {
    return spawnSync(agentBin, args, { ...opts, shell: false })
  }
  // Fallback for absolute .cmd without a sibling .ps1: keep the quoted cmd /c path.
  const cmdLine = [quoteWinCmdArg(agentBin), ...args.map(quoteWinCmdArg)].join(' ')
  return spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `"${cmdLine}"`], {
    ...opts,
    windowsVerbatimArguments: true,
  })
}

/**
 * @param {string} agentBin
 * @param {string[]} args
 * @param {import('node:child_process').SpawnOptions} opts
 */
export function spawnAgent(agentBin, args, opts) {
  const inv = resolveWindowsAgentInvocation(agentBin)
  if (inv.mode === 'powershell-ps1' || inv.mode === 'direct') {
    return spawn(inv.command, [...inv.prefixArgs, ...args], {
      ...opts,
      shell: false,
    })
  }
  if (process.platform !== 'win32') {
    return spawn(agentBin, args, { ...opts, shell: false })
  }
  const cmdLine = [quoteWinCmdArg(agentBin), ...args.map(quoteWinCmdArg)].join(' ')
  return spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `"${cmdLine}"`], {
    ...opts,
    windowsVerbatimArguments: true,
  })
}
