/**
 * Shared DevSpec "Open in Cursor" handoff logic.
 * Used by the devspec:// protocol handler and the macOS localhost bridge fallback.
 */
import fsSync from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { verifyHandoffToken } from './handoff-verify.mjs'
import { readHostAdapter } from './host-adapters.mjs'
import { isLaunchOwner } from './account-bindings.mjs'
import {
  FLEET_RECIPE_TOOLS,
  expandFleetRecipe,
  recipeFromHandoffPayload,
  resolveFleetSpawnPrompt,
  sessionIdFromHandoffPayload,
} from './fleet-recipe.mjs'
import { quoteWinCmdArg, composeWindowsConsoleTitle as composeWindowsCursorCliTitle, sanitizeWindowsConsoleTitle, windowsConsoleStartArgs as windowsCursorCliStartArgs } from './spawn.mjs'

const execFileAsync = promisify(execFile)

/**
 * Build a Windows `.cmd` body that runs node + launch args (cmd-style quoting).
 * @param {string} nodeBin
 * @param {string[]} launchArgs
 * @param {string} folderPath
 * @returns {string}
 */
export function buildWindowsCliLaunchBat(nodeBin, launchArgs, folderPath) {
  const batchArg = value => {
    if (/[\r\n\0]/.test(String(value))) throw new Error('Invalid terminal argument')
    return quoteWinCmdArg(value).replace(/%/g, '%%')
  }
  const cdLine = `cd /d ${batchArg(folderPath)}`
  const runLine = [nodeBin, ...launchArgs].map(batchArg).join(' ')
  return `@echo off\r\nsetlocal DisableDelayedExpansion\r\n${cdLine}\r\n${runLine}\r\n`
}

/**
 * @deprecated Prefer writing buildWindowsCliLaunchBat to a .cmd and starting it.
 * Kept for unit coverage of title/cmdline composition.
 * @param {string} nodeBin
 * @param {string[]} launchArgs
 * @param {string} [title]
 * @returns {string}
 */
export function buildWindowsCliStartCommand(nodeBin, launchArgs, title = composeWindowsCursorCliTitle()) {
  const safeTitle = sanitizeWindowsConsoleTitle(title) || composeWindowsCursorCliTitle()
  const cmdline = [nodeBin, ...launchArgs].map(quoteWinCmdArg).join(' ')
  return `start "${safeTitle}" cmd.exe /k ${cmdline}`
}

export const DEVSPEC_PROTOCOL_SCHEME = 'devspec'
export const DEVSPEC_OPEN_PATH = '/open'
/** Shared loopback listener — keep in sync with the web handoff port. */
export const DEVSPEC_LOCAL_OPEN_PORT = 42731
export const DEVSPEC_DIR = process.env.DEVSPEC_LAUNCHER_HOME || path.join(os.homedir(), '.devspec', 'launcher')
export const MAP_PATH = path.join(DEVSPEC_DIR, 'repo-folder-map.json')
export const HANDLER_LOG_PATH = path.join(DEVSPEC_DIR, 'handler.log')
/** Written by open-handler --install / extension activate so CLI launches use the live extension. */
export const EXTENSION_ROOT_MARKER = path.join(DEVSPEC_DIR, 'extension-root.json')

export async function ensureDevspecDir() {
  await fs.mkdir(DEVSPEC_DIR, { recursive: true })
}

/**
 * Record which Cursor extension package root last ran --install / activate.
 * Protocol launches prefer scripts under this root over a stale ~/.cursor/devspec copy.
 * @param {string} extensionRoot absolute path to the extension package root
 */
export async function writeExtensionRootMarker(extensionRoot) {
  const root = path.resolve(String(extensionRoot ?? '').trim())
  if (!root) {
    throw new Error('writeExtensionRootMarker: extensionRoot required')
  }
  await ensureDevspecDir()
  const payload = {
    v: 1,
    extensionRoot: root,
    updatedAt: new Date().toISOString(),
  }
  await fs.writeFile(EXTENSION_ROOT_MARKER, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
}

/**
 * @returns {Promise<string | null>}
 */
export async function readExtensionRootMarker() {
  try {
    const raw = await fs.readFile(EXTENSION_ROOT_MARKER, 'utf8')
    const parsed = JSON.parse(raw)
    const root = typeof parsed?.extensionRoot === 'string' ? parsed.extensionRoot.trim() : ''
    return root || null
  } catch (err) {
    if (err && typeof err === 'object' && 'code' in err && err.code === 'ENOENT') return null
    return null
  }
}

/**
 * Prefer the active extension's scripts/ launcher over a stale ~/.cursor/devspec copy.
 * Order: extension-root marker → installed DEVSPEC_DIR copy → sibling of this module.
 *
 * @param {string} scriptName e.g. 'launch-cli-session.mjs'
 * @param {{
 *   moduleDir: string,
 *   extensionRoot?: string | null,
 *   existsSync?: (p: string) => boolean,
 * }} opts
 * @returns {{ path: string, source: 'extension' | 'installed' | 'sibling' }}
 */
export function resolveCliLauncher(scriptName, opts) {
  const name = String(scriptName ?? '').trim()
  // Pi's launcher comes from this immutable release, never an unrelated
  // Cursor install. Credential-bearing adapters remain in their host plugins.
  if (name === 'launch-pi-session.mjs') {
    return { path: path.join(opts.moduleDir, name), source: 'sibling' }
  }
  if (!name) {
    throw new Error('resolveCliLauncher: scriptName required')
  }
  const exists = opts.existsSync ?? ((p) => fsSync.existsSync(p))
  const moduleDir = path.resolve(String(opts.moduleDir ?? ''))
  const extensionRoot =
    typeof opts.extensionRoot === 'string' && opts.extensionRoot.trim()
      ? path.resolve(opts.extensionRoot.trim())
      : null

  /** @type {{ path: string, source: 'extension' | 'installed' | 'sibling' }[]} */
  const candidates = []
  if (extensionRoot) {
    candidates.push({
      path: path.join(extensionRoot, 'scripts', name),
      source: 'extension',
    })
  }
  candidates.push({
    path: path.join(DEVSPEC_DIR, name),
    source: 'installed',
  })
  candidates.push({
    path: path.join(moduleDir, name),
    source: 'sibling',
  })

  for (const candidate of candidates) {
    if (exists(candidate.path)) return candidate
  }
  return candidates[candidates.length - 1]
}

export async function appendHandlerLog(line) {
  try {
    await ensureDevspecDir()
    await fs.appendFile(HANDLER_LOG_PATH, `${new Date().toISOString()} ${line}\n`, 'utf8')
  } catch {
    // ignore
  }
}

async function readMap() {
  try {
    const raw = await fs.readFile(MAP_PATH, 'utf8')
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch (err) {
    if (err && typeof err === 'object' && 'code' in err && err.code === 'ENOENT') return {}
    throw err
  }
}

async function writeMap(map) {
  await ensureDevspecDir()
  await fs.writeFile(MAP_PATH, JSON.stringify(map, null, 2), 'utf8')
}

function parseGitHubSlug(remoteUrl) {
  const match = String(remoteUrl).trim().match(/github\.com[:/]([^/\s]+)\/([^/\s#?.]+)/i)
  if (!match?.[1] || !match[2]) return null
  return `${match[1]}/${match[2].replace(/\.git$/i, '')}`
}

async function pathExists(folderPath) {
  try {
    await fs.access(folderPath)
    return true
  } catch {
    return false
  }
}

async function gitRemoteSlug(folderPath) {
  try {
    const { stdout } = await execFileAsync('git', ['-C', folderPath, 'remote', 'get-url', 'origin'], {
      timeout: 5000,
    })
    return parseGitHubSlug(stdout)
  } catch {
    return null
  }
}

/**
 * Tool-neutral connection state, written by EVERY DevSpec plugin's connect flow.
 * Deliberately `~/.devspec`, not `~/.cursor` — the folder facts below belong to the
 * machine, not to whichever plugin happens to be installed (memory `279bcc74`).
 */
const CONNECTIONS_DIR = path.join(os.homedir(), '.devspec', 'remote-control', 'connections')

/**
 * Resolve a repo folder from the working directories DevSpec plugins have already recorded.
 *
 * Every connect flow stamps `cwd` into ~/.devspec/remote-control/connections/<id>.json, so the
 * machine already KNOWS which folder holds which repo. discoverRepoFolder() below only knows a
 * fixed list of conventional layouts (~/repos, ~/Projects, ~/Developer, …) and silently misses
 * anything else — which is exactly how a Pi launch failed with `missing_mapping` on a machine
 * that had been running agents from the right folder for weeks (461 state files all naming it).
 * Recorded fact beats guessed convention, so this runs first.
 *
 * Cheap and bounded on purpose: one flat readdir, no filesystem walk, no symlink following.
 * Distinct cwds are deduped BEFORE any git call, and each resolves to its repo TOPLEVEL so a
 * connection opened in a subdirectory (…/apps/web) still maps the repo root rather than the
 * subfolder. Fails soft — any error just falls through to discoverRepoFolder().
 */
async function learnRepoFolderFromConnections(slug) {
  let entries
  try {
    entries = await fs.readdir(CONNECTIONS_DIR)
  } catch {
    return null
  }

  const cwds = new Set()
  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue
    try {
      const parsed = JSON.parse(await fs.readFile(path.join(CONNECTIONS_DIR, entry), 'utf8'))
      if (parsed && typeof parsed.cwd === 'string' && parsed.cwd) cwds.add(parsed.cwd)
    } catch {
      // A truncated or half-written state file is not a reason to abandon the rest.
    }
  }
  if (cwds.size === 0) return null

  const roots = new Set()
  for (const cwd of cwds) {
    if (!(await pathExists(cwd))) continue
    roots.add((await gitToplevel(cwd)) ?? cwd)
  }

  for (const root of roots) {
    if ((await gitRemoteSlug(root)) === slug) return root
  }
  return null
}

/** Repo root for a directory, so a cwd inside a subfolder still maps the whole repo. */
async function gitToplevel(folderPath) {
  try {
    const { stdout } = await execFileAsync('git', ['-C', folderPath, 'rev-parse', '--show-toplevel'], {
      timeout: 5000,
    })
    const root = stdout.trim()
    return root || null
  } catch {
    return null
  }
}

async function discoverRepoFolder(slug) {
  const [owner, name] = slug.split('/')
  if (!owner || !name) return null

  const home = os.homedir()
  const candidates = [
    path.join(home, 'Repositories', owner, name),
    path.join(home, 'Repositories', 'Combined', name),
    path.join(home, 'repos', owner, name),
    path.join(home, 'repos', name),
    path.join(home, 'Projects', owner, name),
    path.join(home, 'Projects', name),
    path.join(home, 'Developer', owner, name),
    path.join(home, 'Developer', name),
    path.join(home, 'src', owner, name),
    path.join(home, 'src', name),
    path.join(home, name),
  ]

  for (const candidate of candidates) {
    if (!(await pathExists(candidate))) continue
    const remoteSlug = await gitRemoteSlug(candidate)
    if (remoteSlug === slug) return candidate
  }

  const searchRoots = [
    path.join(home, 'Repositories'),
    path.join(home, 'repos'),
    path.join(home, 'Projects'),
    path.join(home, 'Developer'),
  ]

  for (const root of searchRoots) {
    if (!(await pathExists(root))) continue
    const hit = await walkForSlug(root, slug, 0, 4)
    if (hit) return hit
  }

  return null
}

async function walkForSlug(dir, slug, depth, maxDepth) {
  if (depth > maxDepth) return null
  let entries
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return null
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    if (entry.name === 'node_modules' || entry.name === '.git') continue
    const full = path.join(dir, entry.name)
    const remoteSlug = await gitRemoteSlug(full)
    if (remoteSlug === slug) return full
    const nested = await walkForSlug(full, slug, depth + 1, maxDepth)
    if (nested) return nested
  }
  return null
}

function resolveCursorExecutable() {
  if (process.platform === 'win32') {
    return path.join(process.env.LOCALAPPDATA ?? '', 'Programs', 'cursor', 'Cursor.exe')
  }
  return 'cursor'
}

/**
 * Resolve the Cursor Agent CLI binary (`agent`). Prefer PATH, then known install dirs.
 * @returns {Promise<string | null>}
 */
export async function resolveAgentExecutable() {
  const whichCmd = process.platform === 'win32' ? 'where' : 'which'
  try {
    const { stdout } = await execFileAsync(whichCmd, ['agent'], { timeout: 5000 })
    const first = String(stdout)
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find(Boolean)
    if (first && (await pathExists(first))) return first
  } catch {
    // fall through to known paths
  }

  const home = os.homedir()
  const candidates =
    process.platform === 'win32'
      ? [
          path.join(home, 'AppData', 'Local', 'cursor-agent', 'agent.exe'),
          path.join(home, 'AppData', 'Local', 'Programs', 'cursor', 'resources', 'app', 'bin', 'agent.exe'),
          path.join(process.env.LOCALAPPDATA ?? '', 'cursor-agent', 'agent.exe'),
        ]
      : [
          path.join(home, '.local', 'bin', 'agent'),
          '/usr/local/bin/agent',
          path.join(home, '.cursor', 'bin', 'agent'),
        ]

  for (const candidate of candidates) {
    if (candidate && (await pathExists(candidate))) return candidate
  }
  return null
}

function shellSingleQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`
}

/**
 * Resolve the OpenCode CLI binary (`opencode`). Prefer PATH, then known install dirs.
 * Mirrors resolveAgentExecutable's where/which + known-path fallback pattern.
 * @returns {Promise<string | null>}
 */
export async function resolveOpencodeExecutable() {
  const whichCmd = process.platform === 'win32' ? 'where' : 'which'
  try {
    const { stdout } = await execFileAsync(whichCmd, ['opencode'], { timeout: 5000 })
    const lines = String(stdout)
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean)
    // Real bug found live-testing: on Windows, `where opencode` can list a
    // bare extensionless file ahead of the real .cmd/.ps1 shim — npm always
    // generates that extensionless one as a POSIX `#!/bin/sh` script for
    // Git-Bash/WSL, which cmd.exe/PowerShell cannot execute at all. Taking
    // the first line unconditionally resolved to that unusable shim, and
    // the whole connect attempt failed completely silently (stdio was
    // 'ignore' the entire way up the spawn chain, so nothing surfaced).
    // Prefer a genuinely Windows-executable match when one exists.
    const preferred =
      process.platform === 'win32'
        ? lines.find((l) => /\.(cmd|exe|bat|ps1)$/i.test(l)) ?? lines[0]
        : lines[0]
    if (preferred && (await pathExists(preferred))) return preferred
  } catch {
    // fall through to known paths
  }

  const home = os.homedir()
  const candidates =
    process.platform === 'win32'
      ? [
          path.join(process.env.APPDATA ?? '', 'npm', 'opencode.cmd'),
          path.join(home, 'AppData', 'Roaming', 'npm', 'opencode.cmd'),
        ]
      : [
          path.join(home, '.local', 'bin', 'opencode'),
          '/usr/local/bin/opencode',
          path.join(home, '.opencode', 'bin', 'opencode'),
        ]

  for (const candidate of candidates) {
    if (candidate && (await pathExists(candidate))) return candidate
  }
  return null
}

/**
 * Resolve the Pi CLI binary (`pi`) from this user's machine only.
 * Mirrors the established OpenCode resolver, including Windows npm shims.
 * @returns {Promise<string | null>}
 */
export async function resolvePiExecutable() {
  const whichCmd = process.platform === 'win32' ? 'where' : 'which'
  try {
    const { stdout } = await execFileAsync(whichCmd, ['pi'], { timeout: 5000 })
    const lines = String(stdout)
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
    const preferred =
      process.platform === 'win32'
        ? lines.find((line) => /\.(cmd|exe|bat|ps1)$/i.test(line)) ?? lines[0]
        : lines[0]
    if (preferred && (await pathExists(preferred))) return preferred
  } catch {
    // fall through to known paths
  }

  const home = os.homedir()
  const candidates =
    process.platform === 'win32'
      ? [
          path.join(process.env.APPDATA ?? '', 'npm', 'pi.cmd'),
          path.join(home, 'AppData', 'Roaming', 'npm', 'pi.cmd'),
        ]
      : [
          path.join(home, '.local', 'bin', 'pi'),
          '/usr/local/bin/pi',
          path.join(home, '.npm-global', 'bin', 'pi'),
        ]

  for (const candidate of candidates) {
    if (candidate && (await pathExists(candidate))) return candidate
  }
  return null
}

/** Resolve Claude's native installer or npm shim without confusing it with `agent`. */
export async function resolveClaudeExecutable() {
  const windows = process.platform === 'win32'
  try {
    const { stdout } = await execFileAsync(windows ? 'where' : 'which', ['claude'], { timeout: 5000 })
    const paths = String(stdout).split(/\r?\n/).map(value => value.trim()).filter(Boolean)
    for (const candidate of paths) {
      if (windows && !/\.(exe|cmd|bat|ps1)$/i.test(candidate)) continue
      if (await pathExists(candidate)) return candidate
    }
  } catch { /* Desktop services may have a smaller PATH than the user's terminal. */ }
  const home = os.homedir()
  const candidates = windows
    ? [path.join(home, '.local', 'bin', 'claude.exe'), path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'npm', 'claude.cmd')]
    : [path.join(home, '.local', 'bin', 'claude'), '/opt/homebrew/bin/claude', '/usr/local/bin/claude', path.join(home, '.npm-global', 'bin', 'claude')]
  for (const candidate of candidates) if (await pathExists(candidate)) return candidate
  return null
}

/** Start a visible terminal; the prompt stays in a file, never in terminal shell syntax. */
export async function openInClaude({ folderPath, promptText, claudeBin, model }) {
  await ensureDevspecDir()
  const launchesDir = path.join(DEVSPEC_DIR, 'launches')
  await fs.mkdir(launchesDir, { recursive: true, mode: 0o700 })
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const promptFile = path.join(launchesDir, `${stamp}.prompt.txt`)
  await fs.writeFile(promptFile, promptText?.trim() ? `${promptText.trim()}\n` : '', { mode: 0o600 })
  // Always use this verified release, never a stale sibling plugin's launcher.
  const launcher = fileURLToPath(new URL('./launch-claude-session.mjs', import.meta.url))
  const args = [launcher, '--folder', folderPath, '--prompt-file', promptFile, '--claude', claudeBin]
  if (model?.trim()) args.push('--model', model.trim())
  const start = (bin, argv) => new Promise((resolve, reject) => {
    const child = spawn(bin, argv, { cwd: folderPath, detached: true, stdio: 'ignore', windowsHide: true })
    child.once('error', reject)
    child.once('spawn', () => { child.unref(); resolve() })
  })
  if (process.platform === 'win32') {
    const bat = path.join(launchesDir, `${stamp}.claude-launch.cmd`)
    await fs.writeFile(bat, buildWindowsCliLaunchBat(process.execPath, args, folderPath), 'utf8')
    await start('cmd.exe', windowsCursorCliStartArgs(bat, 'DevSpec Claude Code'))
    return
  }
  const cmd = `cd ${shellSingleQuote(folderPath)} && ${[process.execPath, ...args].map(shellSingleQuote).join(' ')}`
  if (process.platform === 'darwin') {
    await start('osascript', ['-e', `tell application "Terminal" to do script ${JSON.stringify(cmd)}`])
    return
  }
  for (const [bin, argv] of [
    ['x-terminal-emulator', ['-e', 'bash', '-lc', cmd]],
    ['gnome-terminal', ['--', 'bash', '-lc', cmd]],
    ['konsole', ['-e', 'bash', '-lc', cmd]],
    ['xfce4-terminal', ['-e', `bash -lc ${shellSingleQuote(cmd)}`]],
  ]) {
    try { await start(bin, argv); return } catch { /* Try the next installed terminal. */ }
  }
  throw new Error('No terminal emulator found to launch Claude Code')
}

/**
 * Open an OS terminal that runs launch-cli-session.mjs (interactive agent).
 * @param {{ folderPath: string, promptText: string | null, agentBin: string, model?: string | null }} opts
 */
export async function openInAgentCli({
  folderPath,
  promptText,
  agentBin,
  model,
  resumeChatId,
  settle = false,
}) {
  await ensureDevspecDir()
  const launchesDir = path.join(DEVSPEC_DIR, 'launches')
  await fs.mkdir(launchesDir, { recursive: true })

  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const promptFile = path.join(launchesDir, `${stamp}.prompt.txt`)
  await fs.writeFile(promptFile, promptText?.trim() ? `${promptText.trim()}\n` : '', 'utf8')

  // Prefer the extension recorded at --install/activate; never let a stale
  // ~/.cursor/devspec copy shadow mechanical fast-connect after a plugin update.
  const moduleDir = path.dirname(fileURLToPath(import.meta.url))
  const extensionRoot = await readExtensionRootMarker()
  const host = readHostAdapter(DEVSPEC_DIR, 'cursor')
  const resolved = host ? { path: host.launchScript, source: 'host-adapter' } : resolveCliLauncher('launch-cli-session.mjs', {
    moduleDir,
    extensionRoot,
  })
  const launcher = resolved.path
  await appendHandlerLog(
    `cli launcher source=${resolved.source} path=${launcher} settle=${settle}`,
  )

  const nodeBin = process.execPath
  const launchArgs = [
    launcher,
    '--folder',
    folderPath,
    '--prompt-file',
    promptFile,
    '--agent',
    agentBin,
  ]
  const modelId = typeof model === 'string' ? model.trim() : ''
  if (modelId) {
    launchArgs.push('--model', modelId)
  }
  const existingChatId = typeof resumeChatId === 'string' ? resumeChatId.trim() : ''
  if (existingChatId) {
    launchArgs.push('--resume-chat-id', existingChatId)
  }

  if (settle) {
    const settled = await runNodeLaunchSettled({
      nodeBin,
      launchArgs,
      cwd: folderPath,
      label: `cursor-cli settle ${stamp}`,
    })
    if (!settled.ok) {
      throw new Error(`Cursor CLI settle failed: ${settled.error}`)
    }
    return
  }

  if (process.platform === 'win32') {
    // Always open a titled cmd.exe /k window. Do NOT use
    // %LOCALAPPDATA%\Microsoft\WindowsApps\wt.exe — that path is an App Execution
    // Alias: fs.access succeeds, but spawn fails silently (stat is EACCES / 0-byte
    // stub). The protocol handler then logs success while the user only sees the
    // brief handler console flash.
    //
    // Write a .cmd launcher and `start` that file. Putting the full quoted node
    // command into one spawn argv makes Node's Windows quoter emit bash-style
    // `\"…\"`, and cmd fails with `'\"C:\…\node.exe\"' is not recognized`.
    const batPath = path.join(launchesDir, `${stamp}.launch.cmd`)
    await fs.writeFile(batPath, buildWindowsCliLaunchBat(nodeBin, launchArgs, folderPath), 'utf8')
    const startTitle = composeWindowsCursorCliTitle({ stamp })
    spawn('cmd.exe', windowsCursorCliStartArgs(batPath, startTitle), {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      cwd: folderPath,
    }).unref()
    return
  }

  if (process.platform === 'darwin') {
    const cmd = `cd ${shellSingleQuote(folderPath)} && ${shellSingleQuote(nodeBin)} ${launchArgs
      .map(shellSingleQuote)
      .join(' ')}`
    spawn('osascript', ['-e', `tell application "Terminal" to do script ${JSON.stringify(cmd)}`], {
      detached: true,
      stdio: 'ignore',
    }).unref()
    return
  }

  // Linux — try common terminal emulators.
  const linuxCmd = `${shellSingleQuote(nodeBin)} ${launchArgs.map(shellSingleQuote).join(' ')}`
  const terminals = [
    ['x-terminal-emulator', ['-e', 'bash', '-lc', linuxCmd]],
    ['gnome-terminal', ['--', 'bash', '-lc', linuxCmd]],
    ['konsole', ['-e', 'bash', '-lc', linuxCmd]],
    ['xfce4-terminal', ['-e', `bash -lc ${shellSingleQuote(linuxCmd)}`]],
  ]
  for (const [bin, args] of terminals) {
    try {
      await execFileAsync('which', [bin], { timeout: 2000 })
      spawn(bin, args, {
        detached: true,
        stdio: 'ignore',
        cwd: folderPath,
      }).unref()
      return
    } catch {
      // try next
    }
  }
  throw new Error('No terminal emulator found to launch Cursor CLI')
}

/**
 * OpenCode session launches — production default is headed (item a08a1885).
 *
 * `true`  → visible serve/client consoles (same class of UX as Pi / Cursor CLI).
 * `false` → hidden spawn; DevSpec's live work trail is then the only surface.
 *
 * Headless was the prior remote default (item 63662a98) when the trail was the
 * intended visibility surface. Launch agents made that inconsistent with every
 * other tool's visible terminal, so headed is the product default again.
 *
 * Fleet fan-out still awaits the settle ready-gate (item 8a288219) — headed
 * does not mean fire-and-forget; `--headed` is passed into the settled script.
 */
export const OPENCODE_LAUNCH_HEADED = true

/**
 * Default wait for a settled CLI launch script to exit.
 * OpenCode's fleet settle exits once the local server is healthy (see
 * DEVSPEC_FLEET_SETTLE in launch-opencode-session.mjs); Cursor CLI / Pi exit
 * after their launch script finishes spawning. Keep this generous for slow
 * cold starts, not for a whole agent turn.
 */
export const FLEET_SETTLE_TIMEOUT_MS = 180_000

/**
 * Run `node <launchArgs…>` in-process and wait until it exits.
 * Used by fleet fan-out so spawn N+1 never starts while spawn N is still
 * cold-starting (OpenCode DB lock, shared CLI binary races).
 *
 * @param {{ nodeBin: string, launchArgs: string[], cwd: string, label: string, timeoutMs?: number }} opts
 * @returns {Promise<{ ok: true, code: number } | { ok: false, error: string, code?: number | null }>}
 */
export function runNodeLaunchSettled({
  nodeBin,
  launchArgs,
  cwd,
  label,
  timeoutMs = FLEET_SETTLE_TIMEOUT_MS,
}) {
  return new Promise((resolve) => {
    let settled = false
    const finish = (result) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(result)
    }

    const child = spawn(nodeBin, launchArgs, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      env: {
        ...process.env,
        DEVSPEC_FLEET_SETTLE: '1',
      },
      // Not detached: we need the exit event for the ready-gate.
    })

    let tail = ''
    const appendTail = (chunk) => {
      tail = `${tail}${chunk}`.slice(-4000)
    }
    child.stdout?.on('data', (buf) => appendTail(String(buf)))
    child.stderr?.on('data', (buf) => appendTail(String(buf)))

    const timer = setTimeout(() => {
      try {
        child.kill()
      } catch {
        // ignore
      }
      void appendHandlerLog(
        `${label} settle timeout after ${timeoutMs}ms` +
          (tail ? ` tail=${JSON.stringify(tail.slice(-500))}` : ''),
      )
      finish({ ok: false, error: 'settle_timeout', code: null })
    }, timeoutMs)

    child.on('error', (err) => {
      void appendHandlerLog(`${label} settle spawn error: ${err?.message || err}`)
      finish({ ok: false, error: 'settle_spawn_failed', code: null })
    })

    // Prefer 'exit' over 'close': headed grandchildren can inherit the settle
    // child's piped stdio and keep 'close' from firing after process.exit
    // (item 914889b5). Drain pipes above so we still capture a failure tail.
    child.on('exit', (code) => {
      if (code === 0) {
        finish({ ok: true, code: 0 })
        return
      }
      void appendHandlerLog(
        `${label} settle exited code=${code}` +
          (tail ? ` tail=${JSON.stringify(tail.slice(-500))}` : ''),
      )
      finish({ ok: false, error: 'settle_failed', code })
    })
  })
}

/**
 * Launch OpenCode via launch-opencode-session.mjs.
 *
 * When `settle` is true (fleet fan-out), await the launch script exit — that is
 * the SQLite ready-gate. The script exits once the local OpenCode server is
 * healthy (DEVSPEC_FLEET_SETTLE), not when the connect client finishes its
 * remote turn. `OPENCODE_LAUNCH_HEADED` still applies: settle + headed passes
 * `--headed` into the awaited script so consoles are visible.
 * @param {{ folderPath: string, promptText: string | null, opencodeBin: string, model?: string | null, settle?: boolean }} opts
 */
export async function openInOpenCode({ folderPath, promptText, opencodeBin, model, settle = false }) {
  await ensureDevspecDir()
  const launchesDir = path.join(DEVSPEC_DIR, 'launches')
  await fs.mkdir(launchesDir, { recursive: true })

  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const promptFile = path.join(launchesDir, `${stamp}.prompt.txt`)
  await fs.writeFile(promptFile, promptText?.trim() ? `${promptText.trim()}\n` : '', 'utf8')

  const adapter = readHostAdapter(DEVSPEC_DIR, 'opencode')
  if (!adapter) throw new Error('Start OpenCode with the DevSpec plugin once to set up local launching.')
  const launcher = adapter.launchScript
  await appendHandlerLog(`opencode launcher source=host-adapter settle=${settle}`)

  const nodeBin = process.execPath
  const launchArgs = [launcher, '--folder', folderPath, '--prompt-file', promptFile, '--opencode', opencodeBin]
  const modelId = typeof model === 'string' ? model.trim() : ''
  if (modelId) {
    launchArgs.push('--model', modelId)
  }
  if (OPENCODE_LAUNCH_HEADED) {
    launchArgs.push('--headed')
  }

  // Fleet ready-gate: await connect/server-up (or failure). Never fire-and-forget.
  if (settle) {
    const settled = await runNodeLaunchSettled({
      nodeBin,
      launchArgs,
      cwd: folderPath,
      label: `opencode settle ${stamp}`,
    })
    if (!settled.ok) {
      throw new Error(`OpenCode settle failed: ${settled.error}`)
    }
    return
  }

  // Headed: reuse Cursor CLI's visible-terminal path so the user can watch the
  // launcher. Headless: keep the production hidden spawn (no console flash).
  if (OPENCODE_LAUNCH_HEADED) {
    if (process.platform === 'win32') {
      const batPath = path.join(launchesDir, `${stamp}.opencode-launch.cmd`)
      await fs.writeFile(batPath, buildWindowsCliLaunchBat(nodeBin, launchArgs, folderPath), 'utf8')
      spawn('cmd.exe', ['/c', 'start', 'DevSpec OpenCode', 'cmd.exe', '/k', batPath], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
        cwd: folderPath,
      }).unref()
      return
    }

    if (process.platform === 'darwin') {
      const cmd = `cd ${shellSingleQuote(folderPath)} && ${shellSingleQuote(nodeBin)} ${launchArgs
        .map(shellSingleQuote)
        .join(' ')}`
      spawn('osascript', ['-e', `tell application "Terminal" to do script ${JSON.stringify(cmd)}`], {
        detached: true,
        stdio: 'ignore',
      }).unref()
      return
    }

    const linuxCmd = `${shellSingleQuote(nodeBin)} ${launchArgs.map(shellSingleQuote).join(' ')}`
    const terminals = [
      ['x-terminal-emulator', ['-e', 'bash', '-lc', linuxCmd]],
      ['gnome-terminal', ['--', 'bash', '-lc', linuxCmd]],
      ['konsole', ['-e', 'bash', '-lc', linuxCmd]],
      ['xfce4-terminal', ['-e', `bash -lc ${shellSingleQuote(linuxCmd)}`]],
    ]
    for (const [bin, args] of terminals) {
      try {
        await execFileAsync('which', [bin], { timeout: 2000 })
        spawn(bin, args, {
          detached: true,
          stdio: 'ignore',
          cwd: folderPath,
        }).unref()
        return
      } catch {
        // try next
      }
    }
    throw new Error('No terminal emulator found to launch OpenCode headed')
  }

  spawn(nodeBin, launchArgs, {
    cwd: folderPath,
    stdio: 'ignore',
    detached: true,
    windowsHide: true,
  }).unref()
}

/**
 * Launch an interactive Pi TUI in a visible terminal. Model and thinking are
 * optional signed overrides; omitting both preserves Pi's own current/default
 * runtime configuration.
 *
 * When `settle` is true (fleet), await the launch script instead of opening a
 * fire-and-forget terminal window.
 * @param {{ folderPath: string, promptText: string | null, piBin: string, model?: string | null, thinking?: string | null, settle?: boolean }} opts
 */
export async function openInPi({
  folderPath,
  promptText,
  piBin,
  model,
  thinking,
  settle = false,
}) {
  await ensureDevspecDir()
  const launchesDir = path.join(DEVSPEC_DIR, 'launches')
  await fs.mkdir(launchesDir, { recursive: true })

  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const promptFile = path.join(launchesDir, `${stamp}.prompt.txt`)
  await fs.writeFile(promptFile, promptText?.trim() ? `${promptText.trim()}\n` : '', 'utf8')

  const moduleDir = path.dirname(fileURLToPath(import.meta.url))
  const extensionRoot = await readExtensionRootMarker()
  const resolved = resolveCliLauncher('launch-pi-session.mjs', {
    moduleDir,
    extensionRoot,
  })
  const launcher = resolved.path
  await appendHandlerLog(`pi launcher source=${resolved.source} path=${launcher} settle=${settle}`)

  const nodeBin = process.execPath
  const launchArgs = [launcher, '--folder', folderPath, '--prompt-file', promptFile, '--pi', piBin]
  const modelId = typeof model === 'string' ? model.trim() : ''
  if (modelId) launchArgs.push('--model', modelId)
  const thinkingLevel = typeof thinking === 'string' ? thinking.trim() : ''
  if (['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(thinkingLevel)) {
    launchArgs.push('--thinking', thinkingLevel)
  }

  if (settle) {
    const settled = await runNodeLaunchSettled({
      nodeBin,
      launchArgs,
      cwd: folderPath,
      label: `pi settle ${stamp}`,
    })
    if (!settled.ok) {
      throw new Error(`Pi settle failed: ${settled.error}`)
    }
    return
  }

  if (process.platform === 'win32') {
    const batPath = path.join(launchesDir, `${stamp}.pi-launch.cmd`)
    await fs.writeFile(batPath, buildWindowsCliLaunchBat(nodeBin, launchArgs, folderPath), 'utf8')
    spawn('cmd.exe', ['/c', 'start', 'DevSpec Pi', 'cmd.exe', '/k', batPath], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      cwd: folderPath,
    }).unref()
    return
  }

  if (process.platform === 'darwin') {
    const cmd = `cd ${shellSingleQuote(folderPath)} && ${shellSingleQuote(nodeBin)} ${launchArgs
      .map(shellSingleQuote)
      .join(' ')}`
    spawn('osascript', ['-e', `tell application "Terminal" to do script ${JSON.stringify(cmd)}`], {
      detached: true,
      stdio: 'ignore',
    }).unref()
    return
  }

  const linuxCmd = `${shellSingleQuote(nodeBin)} ${launchArgs.map(shellSingleQuote).join(' ')}`
  const terminals = [
    ['x-terminal-emulator', ['-e', 'bash', '-lc', linuxCmd]],
    ['gnome-terminal', ['--', 'bash', '-lc', linuxCmd]],
    ['konsole', ['-e', 'bash', '-lc', linuxCmd]],
    ['xfce4-terminal', ['-e', `bash -lc ${shellSingleQuote(linuxCmd)}`]],
  ]
  for (const [bin, args] of terminals) {
    try {
      await execFileAsync('which', [bin], { timeout: 2000 })
      spawn(bin, args, { detached: true, stdio: 'ignore', cwd: folderPath }).unref()
      return
    } catch {
      // try next
    }
  }
  throw new Error('No terminal emulator found to launch Pi')
}

const CURSOR_PROMPT_DEEPLINK_BASE = 'cursor://anysphere.cursor-deeplink/prompt'
const CURSOR_PROMPT_DEEPLINK_MAX = 8000
const PROMPT_DEEPLINK_DELAY_MS = 1500

function buildCursorPromptDeeplink(text) {
  const trimmed =
    text.length > CURSOR_PROMPT_DEEPLINK_MAX ? text.slice(0, CURSOR_PROMPT_DEEPLINK_MAX) : text
  return `${CURSOR_PROMPT_DEEPLINK_BASE}?text=${encodeURIComponent(trimmed)}`
}

function openCursorDeeplink(url) {
  if (process.platform === 'win32') {
    spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore', windowsHide: true }).unref()
    return
  }
  if (process.platform === 'darwin') {
    spawn('open', [url], { detached: true, stdio: 'ignore' }).unref()
    return
  }
  spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref()
}

function openExternalUrl(url) {
  if (process.platform === 'win32') {
    spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore', windowsHide: true }).unref()
    return
  }
  if (process.platform === 'darwin') {
    spawn('open', [url], { detached: true, stdio: 'ignore' }).unref()
    return
  }
  spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref()
}

/**
 * App origin for human pages (error interstitial, etc.).
 *
 * Order: explicit DEVSPEC_APP_URL → known MCP host pairs from the live
 * remote-control state → production app.devspec.ai.
 *
 * Staging dogfood machines often have MCP on api.devspecstaging.com without
 * setting DEVSPEC_APP_URL; falling through to app.devspec.ai then opens a
 * DNS-dead host ("site can't be reached"). Only the two settled host pairs
 * are rewritten — never invent a hostname from an arbitrary API URL.
 *
 * @param {{ env?: NodeJS.ProcessEnv, remoteControlPath?: string, readFileSync?: (path: string, encoding: string) => string }} [opts]
 * @returns {string}
 */
export function resolveAppBaseUrl(opts = {}) {
  const env = opts.env ?? process.env
  const fromEnv = typeof env.DEVSPEC_APP_URL === 'string' ? env.DEVSPEC_APP_URL.replace(/\/+$/, '') : ''
  if (fromEnv) return fromEnv

  const rcPath =
    opts.remoteControlPath ?? path.join(os.homedir(), '.devspec', 'remote-control.json')
  const readFile = opts.readFileSync ?? fsSync.readFileSync
  try {
    const raw = readFile(rcPath, 'utf8')
    const mcpUrl = JSON.parse(raw)?.mcp_url
    if (typeof mcpUrl === 'string') {
      if (mcpUrl.includes('api.devspecstaging.com')) return 'https://app.devspecstaging.com'
      if (mcpUrl.includes('api.devspec.ai')) return 'https://app.devspec.ai'
    }
  } catch {
    // missing/unreadable config — fall through to production default
  }
  return 'https://app.devspec.ai'
}

/**
 * `tool` is passed so the page can name the agent the person actually launched. Without it the
 * page defaults to Cursor and tells a Pi user to go and fix something in an editor they may not
 * have installed — the same wrong-default class already fixed on the interstitial.
 */
function launchErrorBrowserPage(slug, reason, tool = 'cursor') {
  // Human pages live on the app host (app.*), not the API host (api.*). Prefer
  // DEVSPEC_APP_URL; otherwise resolveAppBaseUrl mirrors the machine's MCP
  // staging/prod pair (item 2ed52078 / af6a1d20).
  const base = resolveAppBaseUrl()
  const params = new URLSearchParams({ repo: slug, reason, tool })
  openExternalUrl(`${base}/cursor-handoff/error?${params}`)
}

export function scheduleAgentPrompt(promptText) {
  if (!promptText?.trim()) return
  const deeplink = buildCursorPromptDeeplink(promptText.trim())
  setTimeout(() => openCursorDeeplink(deeplink), PROMPT_DEEPLINK_DELAY_MS)
}

export async function openInCursor(folderPath) {
  const cursorExe = resolveCursorExecutable()
  if (process.platform === 'win32' && !(await pathExists(cursorExe))) {
    throw new Error(`Cursor executable not found at ${cursorExe}`)
  }

  const child = spawn(cursorExe, [folderPath], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  })
  child.unref()
}

export async function resolveRepoFolder(slug) {
  const map = await readMap()
  const stored = map[slug]
  if (stored && (await pathExists(stored))) return stored

  const discovered = (await learnRepoFolderFromConnections(slug)) ?? (await discoverRepoFolder(slug))
  if (discovered) {
    map[slug] = discovered
    await writeMap(map)
    return discovered
  }

  return null
}

/** Normalize OS protocol invocations (devspec:open?x → devspec://open?x). */
export function normalizeProtocolUrl(raw) {
  let value = String(raw ?? '').trim()
  // Windows / Chrome sometimes wrap the URL in quotes when invoking the handler.
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    value = value.slice(1, -1).trim()
  }
  if (!value) return null
  if (value.startsWith('devspec:') && !value.startsWith('devspec://')) {
    value = `devspec://${value.slice('devspec:'.length)}`
  }
  try {
    return new URL(value)
  } catch {
    return null
  }
}

/**
 * True when the URL targets the handoff open path.
 *
 * Chrome often rewrites `devspec://open?t=…` to `devspec://open/?t=…`, which
 * the WHATWG URL parser stores as hostname=`open` + pathname=`/`. Older forms
 * use pathname `/open` with an empty host.
 */
export function isHandoffOpenUrl(url) {
  if (!url || url.protocol !== 'devspec:') return false
  const host = (url.hostname || '').toLowerCase()
  const path = url.pathname || ''
  if (host === 'open' && (path === '' || path === '/')) return true
  if ((host === '' || host === 'localhost') && (path === '/open' || path === 'open')) return true
  return false
}

/**
 * Parse devspec://open?repo=…&prompt=…&title=…&token=…
 * Returns null when the URL is not a supported handoff.
 */
export function parseHandoffUrl(raw) {
  const url = normalizeProtocolUrl(raw)
  if (!url || !isHandoffOpenUrl(url)) return null

  const token = url.searchParams.get('t') || url.searchParams.get('token')
  if (token) {
    const verified = verifyHandoffToken(token)
    if (!verified.ok) return { error: verified.error ?? 'invalid_token' }
    return {
      slug: verified.data.repo,
      requesterId: verified.data.requesterId,
      promptText: verified.data.prompt ?? null,
      itemTitle: verified.data.title ?? null,
      surface: verified.data.surface === 'cli' ? 'cli' : 'ide',
      tool: verified.data.tool,
      model: verified.data.model ?? null,
      thinking: verified.data.thinking ?? null,
      resumeChatId:
        typeof verified.data.resumeChatId === 'string' && verified.data.resumeChatId.trim()
          ? verified.data.resumeChatId.trim()
          : null,
      recipe: recipeFromHandoffPayload(verified.data),
      sessionId: sessionIdFromHandoffPayload(verified.data),
    }
  }

  const repo = url.searchParams.get('repo')
  if (!repo) return { error: 'missing_repo' }
  const surfaceRaw = url.searchParams.get('surface')
  const toolRaw = url.searchParams.get('tool') ?? 'cursor'
  if (!FLEET_RECIPE_TOOLS.includes(toolRaw)) return { error: 'unsupported_tool' }
  const modelRaw = url.searchParams.get('model')
  const thinkingRaw = url.searchParams.get('thinking')
  const resumeChatRaw = url.searchParams.get('resumeChatId')
  return {
    slug: decodeURIComponent(repo),
    promptText: url.searchParams.get('prompt')
      ? decodeURIComponent(url.searchParams.get('prompt'))
      : null,
    itemTitle: url.searchParams.get('title')
      ? decodeURIComponent(url.searchParams.get('title'))
      : null,
    surface: surfaceRaw === 'cli' ? 'cli' : 'ide',
    tool: toolRaw,
    model: modelRaw ? decodeURIComponent(modelRaw) : null,
    thinking: ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(thinkingRaw)
      ? thinkingRaw
      : null,
    resumeChatId:
      typeof resumeChatRaw === 'string' && resumeChatRaw.trim()
        ? decodeURIComponent(resumeChatRaw).trim()
        : null,
    /** Unsigned localhost bridge requests (macOS fallback only). */
    unsigned: true,
  }
}

/**
 * Execute a single-agent handoff (one IDE open or one CLI spawn).
 * @param {{ settle?: boolean }} [opts] — when true (fleet), await each CLI launch script exit before returning.
 * @returns {Promise<{ ok: true } | { ok: false, error: string, slug?: string }>}
 */
export async function executeSingleHandoff({
  slug,
  promptText,
  itemTitle,
  surface = 'ide',
  tool = 'cursor',
  model = null,
  thinking = null,
  resumeChatId = null,
  requireSignedToken = true,
  unsigned = false,
  settle = false,
  reportErrorsInBrowser = true,
}) {
  const openErrorPage = reportErrorsInBrowser ? launchErrorBrowserPage : () => {}
  if (requireSignedToken && unsigned) {
    await appendHandlerLog('rejected unsigned handoff')
    return { ok: false, error: 'unsigned_not_allowed', slug }
  }

  if (!FLEET_RECIPE_TOOLS.includes(tool)) {
    openErrorPage(slug, 'unsupported_tool', tool)
    return { ok: false, error: 'unsupported_tool', slug }
  }
  const folderPath = await resolveRepoFolder(slug)
  if (!folderPath) {
    await appendHandlerLog(`missing mapping for ${slug}`)
    openErrorPage(slug, 'missing_mapping', tool)
    return { ok: false, error: 'missing_mapping', slug }
  }

  if (tool === 'claude-code') {
    const claudeBin = await resolveClaudeExecutable()
    if (!claudeBin) {
      openErrorPage(slug, 'claude_missing', tool)
      return { ok: false, error: 'claude_missing', slug }
    }
    try {
      await openInClaude({ folderPath, promptText, claudeBin, model })
      await appendHandlerLog(`opened Claude Code ${slug} → ${folderPath}`)
      return { ok: true }
    } catch (error) {
      await appendHandlerLog(`Claude Code open failed: ${error.message}`)
      openErrorPage(slug, 'agent_launch_failed', tool)
      return { ok: false, error: 'agent_launch_failed', slug }
    }
  }

  if (tool === 'pi') {
    const piBin = await resolvePiExecutable()
    if (!piBin) {
      await appendHandlerLog(`pi missing for handoff ${slug}`)
      openErrorPage(slug, 'pi_missing', tool)
      return { ok: false, error: 'pi_missing', slug }
    }
    try {
      await openInPi({ folderPath, promptText, piBin, model, thinking, settle })
      await appendHandlerLog(`opened Pi ${slug} → ${folderPath} via ${piBin}`)
      return { ok: true }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      await appendHandlerLog(`Pi open failed: ${message}`)
      openErrorPage(slug, 'agent_launch_failed', tool)
      return { ok: false, error: 'agent_launch_failed', slug }
    }
  }

  // OpenCode has no separate "ide" surface — it's always a terminal, so it
  // never falls through to the Cursor-app-open branch below regardless of
  // the surface field.
  if (tool === 'opencode') {
    const opencodeBin = await resolveOpencodeExecutable()
    if (!opencodeBin) {
      await appendHandlerLog(`opencode missing for handoff ${slug}`)
      openErrorPage(slug, 'opencode_missing', tool)
      return { ok: false, error: 'opencode_missing', slug }
    }
    try {
      await openInOpenCode({ folderPath, promptText, opencodeBin, model, settle })
      await appendHandlerLog(`opened OpenCode ${slug} → ${folderPath} via ${opencodeBin}`)
      return { ok: true }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      await appendHandlerLog(`OpenCode open failed: ${message}`)
      openErrorPage(slug, 'agent_launch_failed', tool)
      return { ok: false, error: 'agent_launch_failed', slug }
    }
  }

  // Session/web remote-control prompts cannot include a machine-local PLUGIN=
  // path or the Cursor skill body. Expand here so Cursor agents never hunt
  // Claude marketplace caches (item 57d8b288) or mislabel as Claude Code.
  let pinnedPrompt = promptText
  const cursorHost = readHostAdapter(DEVSPEC_DIR, 'cursor')
  const cursorRoot = await readExtensionRootMarker()
  const promptModule = cursorHost?.promptModule ?? (cursorRoot ? path.join(cursorRoot, 'scripts', 'pin-remote-plugin.mjs') : null)
  if (promptModule && fsSync.existsSync(promptModule)) {
    const { expandRemoteControlLaunchPrompt } = await import(pathToFileURL(promptModule).href)
    pinnedPrompt = expandRemoteControlLaunchPrompt(promptText)
  }

  if (surface === 'cli') {
    const agentBin = await resolveAgentExecutable()
    if (!agentBin) {
      await appendHandlerLog(`agent missing for CLI handoff ${slug}`)
      openErrorPage(slug, 'agent_missing', tool)
      return { ok: false, error: 'agent_missing', slug }
    }
    try {
      await openInAgentCli({
        folderPath,
        promptText: pinnedPrompt,
        agentBin,
        model,
        resumeChatId,
        settle,
      })
      await appendHandlerLog(`opened CLI ${slug} → ${folderPath} via ${agentBin}`)
      return { ok: true }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      await appendHandlerLog(`CLI open failed: ${message}`)
      openErrorPage(slug, 'agent_launch_failed', tool)
      return { ok: false, error: 'agent_launch_failed', slug }
    }
  }

  try {
    await openInCursor(folderPath)
    scheduleAgentPrompt(pinnedPrompt)
    await appendHandlerLog(`opened ${slug} → ${folderPath}`)
    return { ok: true }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    await appendHandlerLog(`open failed: ${message}`)
    openErrorPage(slug, 'open_failed', tool)
    return { ok: false, error: 'open_failed', slug }
  }
}

/**
 * Small pause after a settled spawn. The ready-gate is the awaited launch
 * script; this gap only softens residual CLI binary contention.
 */
const FLEET_SPAWN_GAP_MS = 250

/**
 * Execute the handoff: open Cursor IDE (default) or spawn interactive Cursor CLI.
 * When `recipe` is set, fans out to N independent CLI sessions (brief ba6bd58e).
 * @returns {{ ok: true, spawned?: number, failures?: Array<{ index: number, tool: string, error: string }> } | { ok: false, error: string, slug?: string, failures?: Array<{ index: number, tool: string, error: string }> }}
 */
export async function executeHandoff({
  requesterId,
  slug,
  promptText,
  itemTitle,
  surface = 'ide',
  tool = 'cursor',
  model = null,
  thinking = null,
  resumeChatId = null,
  recipe = null,
  sessionId = null,
  requireSignedToken = true,
  unsigned = false,
  reportErrorsInBrowser = true,
}) {
  if (!isLaunchOwner(DEVSPEC_DIR, requesterId)) return { ok: false, error: 'account_not_paired' }
  if (recipe && typeof recipe === 'object') {
    const tools = expandFleetRecipe(recipe)
    if (tools.length === 0) {
      await appendHandlerLog(
        `fleet recipe empty for ${slug} recipe=${JSON.stringify(recipe)}`,
      )
      return { ok: false, error: 'empty_recipe', slug }
    }

    await appendHandlerLog(
      `fleet fan-out ${slug}: ${tools.length} spawn(s) [${tools.join(', ')}] ` +
        `recipe=${JSON.stringify(recipe)} title=${JSON.stringify(itemTitle ?? null)}` +
        (sessionId ? ` session=${sessionId}` : ''),
    )

    /** @type {Array<{ index: number, tool: string, error: string }>} */
    const failures = []
    let spawned = 0

    for (let i = 0; i < tools.length; i++) {
      const spawnTool = tools[i]
      await appendHandlerLog(
        `fleet spawn ${i + 1}/${tools.length} starting tool=${spawnTool}`,
      )
      // Never pass null/empty — OpenCode rejects empty messages and Cursor
      // skips mechanical Connect when the prompt is not remote-connect
      // (item f053c2ed). Prefer a handoff prompt when present; else the same
      // per-tool remote shape as a single coding-agent launch (item f2fe858e).
      const spawnPrompt = resolveFleetSpawnPrompt(promptText, {
        tool: spawnTool,
        sessionId,
      })
      // Only OpenCode needs the settled ready-gate (SQLite DB race — item
      // 8a288219). Pi / Cursor CLI use the fire-and-forget visible terminal
      // path so Launch agents matches session-launch UX (item 6649667f).
      const result = await executeSingleHandoff({
        slug,
        promptText: spawnPrompt,
        itemTitle: null,
        surface: 'cli',
        tool: spawnTool,
        model: null,
        thinking: null,
        resumeChatId: null,
        requireSignedToken,
        unsigned,
        settle: spawnTool === 'opencode',
        reportErrorsInBrowser,
      })
      if (result.ok) {
        spawned += 1
        await appendHandlerLog(
          `fleet spawn ${i + 1}/${tools.length} (${spawnTool}) ok` +
            ` prompt_chars=${spawnPrompt.length}`,
        )
      } else {
        failures.push({
          index: i,
          tool: spawnTool,
          error: result.error ?? 'unknown',
        })
        await appendHandlerLog(
          `fleet spawn ${i + 1}/${tools.length} (${spawnTool}) failed: ${result.error}`,
        )
      }
      if (i < tools.length - 1) {
        await new Promise((resolve) => setTimeout(resolve, FLEET_SPAWN_GAP_MS))
      }
    }

    if (spawned === 0) {
      await appendHandlerLog(
        `fleet fan-out done ${slug}: 0/${tools.length} ok (all failed)`,
      )
      return { ok: false, error: 'fleet_all_failed', slug, failures }
    }
    await appendHandlerLog(
      `fleet fan-out done ${slug}: ${spawned}/${tools.length} ok` +
        (failures.length ? `, ${failures.length} failed` : ''),
    )
    return { ok: true, spawned, failures: failures.length ? failures : undefined }
  }

  await appendHandlerLog(
    `single handoff ${slug} tool=${tool} surface=${surface} ` +
      `prompt_chars=${typeof promptText === 'string' ? promptText.length : 0} ` +
      `title=${JSON.stringify(itemTitle ?? null)} (no fleet recipe)`,
  )

  return executeSingleHandoff({
    slug,
    promptText,
    itemTitle,
    surface,
    tool,
    model,
    thinking,
    resumeChatId,
    requireSignedToken,
    unsigned,
    reportErrorsInBrowser,
  })
}

export async function handleProtocolUrl(raw, opts = {}) {
  const parsed = parseHandoffUrl(raw)
  if (!parsed) {
    await appendHandlerLog('handoff failed: bad_url')
    return { ok: false, error: 'bad_url' }
  }
  if ('error' in parsed && !parsed.slug) return { ok: false, error: parsed.error }
  if (parsed.error && !parsed.slug) return { ok: false, error: parsed.error }

  const recipe = parsed.recipe ?? null
  const sessionId = parsed.sessionId ?? null
  await appendHandlerLog(
    `handoff parsed slug=${parsed.slug} tool=${parsed.tool ?? 'cursor'} ` +
      `surface=${parsed.surface ?? 'ide'} ` +
      `recipe=${recipe ? JSON.stringify(recipe) : 'none'} ` +
      `prompt_chars=${typeof parsed.promptText === 'string' ? parsed.promptText.length : 0} ` +
      `title=${JSON.stringify(parsed.itemTitle ?? null)}` +
      (sessionId ? ` session=${sessionId}` : ''),
  )

  return executeHandoff({
    requesterId: parsed.requesterId,
    slug: parsed.slug,
    promptText: parsed.promptText,
    itemTitle: parsed.itemTitle,
    surface: parsed.surface === 'cli' ? 'cli' : 'ide',
    tool: parsed.tool ?? 'cursor',
    model: parsed.model ?? null,
    thinking: parsed.thinking ?? null,
    resumeChatId: parsed.resumeChatId ?? null,
    recipe,
    sessionId,
    unsigned: parsed.unsigned,
    requireSignedToken: true,
  })
}
