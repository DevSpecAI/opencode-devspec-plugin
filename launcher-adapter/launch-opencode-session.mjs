#!/usr/bin/env node
/**
 * OpenCode cold-launch session runner (runs invisibly — no terminal window).
 *
 * Real bug found live-testing: a one-shot `opencode run ...` process exits
 * the instant it finishes the connect handshake, leaving nothing running to
 * ever receive a dispatched message afterward — the whole point of remote
 * control. Proven fix: start a persistent `opencode serve` (detached,
 * survives after this script exits), then run the connect/message command
 * against it via `opencode run --attach <server-url> ...` — verified live
 * twice that the server keeps responding after the attached run command
 * completes.
 *
 * This trades a visible interactive terminal (Cursor's cold-launch opens
 * one) for "definitely works, no window" — an explicit choice, not an
 * oversight: getting slash-command expansion to work reliably in OpenCode's
 * interactive TUI mode could not be cleanly verified in the time available.
 *
 * Real bug found live-testing (round 2): `stdio: 'ignore'` alone does NOT
 * suppress the window. spawnAgent's Windows fallback wraps the binary in a
 * `cmd.exe /c` call, and cmd.exe opens its own visible console regardless of
 * the child's stdio config — both the server and client spawns below popped
 * a titled cmd window that then sat there (blank, or showing the server's
 * startup banner) until closed. `windowsHide: true` on both spawn calls is
 * required in addition to `stdio: 'ignore'`.
 *
 * Real bug found live-testing (round 3): windowsHide + stdio:'ignore' still
 * wasn't enough on its own — one window (server's startup banner) stayed
 * visible. Root cause was one level deeper, in launch-cli-session.mjs's
 * resolveWindowsAgentInvocation: OpenCode ships a real compiled `.exe`, not
 * an npm `.cmd`/`.ps1` shim trio like Cursor's `agent` — so it fell through
 * to the generic cmd.exe-wrapping fallback (built for shim binaries that
 * genuinely need a shell) instead of being spawned directly. That extra,
 * unnecessary cmd.exe hop is what the visible console was attached to.
 * Fixed by adding a dedicated `.exe` → direct-spawn branch there.
 *
 * Real bug found live-testing (round 4 — active incident, not just a delivery
 * gap): the plugin's local state file (src/remote-control.ts's `stateFile`)
 * is keyed ONLY by project directory, on the assumption of at most one live
 * OpenCode remote-control connection per directory. Nothing enforced that
 * assumption here — repeated cold-launches against the same project left
 * MULTIPLE `opencode serve` processes running concurrently, all sharing and
 * clobbering that one state file. Observed live: two servers stomping on
 * each other's `sessionId` caused replies to mirror into a stale, already
 * -archived session neither owner was watching, in a tight repost loop
 * (every ~4s) — total silence on the real session, an actively growing mess
 * on the wrong one. Fixed by enforcing a single server per directory: kill
 * any previously-recorded server (tracked via a PID sidecar file) and clear
 * its now-stale state before starting a fresh one.
 *
 * Real bug found live-testing (round 6 — this is why round 4's fix kept
 * failing): the pid recorded and killed was spawn()'s own return value —
 * the PowerShell wrapper's pid (the powershell-ps1 invocation path in
 * launch-cli-session.mjs). Confirmed live with Get-CimInstance: that
 * wrapper process exits shortly after launching opencode.exe (opencode.ps1
 * runs it as a foreground `&` call, but control returns to PowerShell well
 * before the long-running `serve` command actually finishes) — leaving the
 * REAL server process alive as an orphan, completely untracked by the pid
 * we recorded. Every subsequent launch's killExistingServer call was
 * therefore always targeting an already-dead pid, a guaranteed no-op, while
 * the actual server piled up untouched — explaining why Axiom showed 3-4x
 * the expected single-server call volume sustained for 20+ minutes. Fixed
 * by looking up the ACTUAL listening pid for the port via `netstat -ano`
 * once the server responds, and recording THAT instead of spawn()'s pid.
 *
 * Invoked by open-handler-core when tool=opencode:
 *   node launch-opencode-session.mjs --folder <path> --prompt-file <path> [--opencode <path>] [--model <id>] [--headed]
 *
 * `--headed` is an optional DEBUG escape hatch (visible serve/client consoles).
 * Production omits it. The open-handler default is headless (`OPENCODE_LAUNCH_HEADED=false`
 * in open-handler-core.mjs) now that DevSpec streams the live work trail — set
 * that constant to true only while diagnosing launch, then flip it back.
 */
import { execFile, spawn, spawnSync } from 'node:child_process'
import crypto from 'node:crypto'
import fsPromises from 'node:fs/promises'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { quoteWinCmdArg, spawnAgent } from '../launcher/spawn.mjs'
import { buildOpenCodeLaunchEnv } from '../launcher/opencode-mapped-permissions.mjs'

const execFileAsync = promisify(execFile)

/** @param {unknown} value */
function shellSingleQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`
}

/**
 * Windows `cmd /c start … /k` argv for a visible OpenCode connect client
 * (fleet headed — item ea464dc2). Same class as Pi's DevSpec Pi console.
 * @param {string} opencodeBin
 * @param {string[]} runArgs
 */
export function buildWindowsVisibleOpenCodeStartArgs(opencodeBin, runArgs) {
  const cmdline = [quoteWinCmdArg(opencodeBin), ...runArgs.map(quoteWinCmdArg)].join(' ')
  return ['/c', 'start', 'DevSpec OpenCode', 'cmd.exe', '/k', cmdline]
}

/**
 * Open a visible console for the OpenCode connect client under fleet settle
 * when headed. Settle still exits immediately after spawn — the /k window
 * outlives this process.
 * @param {{ opencodeBin: string, runArgs: string[], folder: string, env?: NodeJS.ProcessEnv }} opts
 */
export function spawnVisibleOpenCodeClient({ opencodeBin, runArgs, folder, env }) {
  if (process.platform === 'win32') {
    return spawn('cmd.exe', buildWindowsVisibleOpenCodeStartArgs(opencodeBin, runArgs), {
      cwd: folder,
      env,
      detached: true,
      stdio: 'ignore',
      // Hide the ephemeral `start` helper — not the /k console it opens.
      windowsHide: true,
    })
  }

  if (process.platform === 'darwin') {
    const cmd = `cd ${shellSingleQuote(folder)} && ${shellSingleQuote(opencodeBin)} ${runArgs
      .map(shellSingleQuote)
      .join(' ')}`
    return spawn('osascript', ['-e', `tell application "Terminal" to do script ${JSON.stringify(cmd)}`], {
      env,
      detached: true,
      stdio: 'ignore',
    })
  }

  const linuxCmd = `cd ${shellSingleQuote(folder)} && ${shellSingleQuote(opencodeBin)} ${runArgs
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
        env,
        detached: true,
        stdio: 'ignore',
      })
      if (child.pid) return child
    } catch {
      // try next emulator
    }
  }
  return spawnAgent(opencodeBin, runArgs, {
    cwd: folder,
    env,
    stdio: 'ignore',
    detached: true,
    windowsHide: false,
    encoding: 'utf8',
  })
}

/** Default OpenCode serve basic-auth username (OpenCode docs). */
export const OPENCODE_SERVER_USERNAME_DEFAULT = 'opencode'

/**
 * Resolve the local OpenCode HTTP basic-auth password for a rocket launch.
 *
 * Prefer a non-empty `OPENCODE_SERVER_PASSWORD` already in the environment
 * (power users / interactive habits). Otherwise mint a strong one-time secret
 * for this serve process only. Never upload this to DevSpec — it only locks
 * the laptop-local `opencode serve` door between launcher and attach client.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {{ password: string, username: string, source: 'env' | 'minted' }}
 */
export function resolveServeAuth(env = process.env) {
  const usernameRaw = String(env.OPENCODE_SERVER_USERNAME || '').trim()
  const username = usernameRaw || OPENCODE_SERVER_USERNAME_DEFAULT
  const existing = String(env.OPENCODE_SERVER_PASSWORD || '').trim()
  if (existing) {
    return { password: existing, username, source: 'env' }
  }
  return {
    password: crypto.randomBytes(32).toString('base64url'),
    username,
    source: 'minted',
  }
}

/**
 * HTTP `Authorization: Basic …` header value for OpenCode serve health/API.
 * @param {string} username
 * @param {string} password
 */
export function basicAuthHeaderValue(username, password) {
  const token = Buffer.from(`${username}:${password}`, 'utf8').toString('base64')
  return `Basic ${token}`
}

/**
 * Apply serve auth onto a child env without mutating the caller's object.
 * @param {NodeJS.ProcessEnv} env
 * @param {{ username: string, password: string }} auth
 * @returns {NodeJS.ProcessEnv}
 */
export function withServeAuthEnv(env, auth) {
  return {
    ...env,
    OPENCODE_SERVER_USERNAME: auth.username,
    OPENCODE_SERVER_PASSWORD: auth.password,
  }
}

/**
 * Redact secrets from argv before logging (defence in depth if `--password` is ever added).
 * @param {string[]} args
 * @returns {string[]}
 */
export function redactArgsForLog(args) {
  const out = []
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (a === '--password' || a === '-p') {
      out.push(a, '<redacted>')
      if (i + 1 < args.length) i++
      continue
    }
    out.push(a)
  }
  return out
}

/**
 * Find the pid actually LISTENING on 127.0.0.1:<port> right now, via
 * `netstat -ano`. See the "round 6" note above for why this — not
 * spawn()'s own returned pid — is the only reliable thing to track and
 * kill later.
 */
async function findListeningPid(port) {
  if (process.platform !== 'win32') return null
  try {
    const { stdout } = await execFileAsync('netstat', ['-ano'])
    for (const line of stdout.split(/\r?\n/)) {
      if (!line.includes(`127.0.0.1:${port}`) || !line.includes('LISTENING')) continue
      const parts = line.trim().split(/\s+/)
      const pid = Number(parts[parts.length - 1])
      if (Number.isInteger(pid) && pid > 0) return pid
    }
  } catch {
    // best-effort — fall back to spawn()'s pid if this fails
  }
  return null
}

/**
 * Same key scheme as the plugin's own state file (src/remote-control.ts
 * `stateFile`) — colocated, not shared code (different repos). Round 9: folds
 * the target DevSpec session id into the key when known, so each session
 * gets its own pid/state file instead of every launch for a folder sharing
 * one — see killExistingServer's doc for why that's what lets two `opencode
 * serve` processes for the SAME folder coexist. A bare (sessionless) launch
 * keeps the folder-only key, unchanged from before.
 *
 * Round 10 (confirmed live, same day): plain `Buffer.from(raw).toString(
 * 'base64url').slice(0, 32)` did NOT actually distinguish sessions — a
 * typical resolved project path is already 100+ characters (130+ once
 * base64-encoded), so truncating to 32 chars keeps only the folder's own
 * encoding and never reaches the appended `:sessionId`. Three different
 * sessions for one folder produced the byte-identical key, silently
 * collapsing back to folder-only behavior. A real hash (sha256, not
 * truncated raw encoding) is required so every input byte — including ones
 * past position ~24 — affects every output character.
 */
/**
 * Stable key for OpenCode server pid/state files.
 * @param {string} folder
 * @param {string | null | undefined} sessionId
 * @param {string | null | undefined} [instanceId] fleet/sessionless disambiguator
 */
export function directoryKey(folder, sessionId, instanceId) {
  const base = path.resolve(folder)
  let raw = sessionId ? `${base}:${sessionId}` : base
  const instance = typeof instanceId === 'string' ? instanceId.trim() : ''
  if (instance) raw = `${raw}:instance:${instance}`
  return crypto.createHash('sha256').update(raw).digest('base64url').slice(0, 32)
}

/**
 * Fleet Launch agents mint a unique prompt-file stamp per spawn. Use that as
 * the sessionless instance id so two bare OpenCodes in one folder do not share
 * a pid file and kill each other (item 9d213c07).
 * @param {string | null | undefined} promptFile
 * @returns {string | null}
 */
export function fleetInstanceIdFromPromptFile(promptFile) {
  if (process.env.DEVSPEC_FLEET_SETTLE !== '1') return null
  if (typeof promptFile !== 'string' || !promptFile.trim()) return null
  // Prompt-file paths may have been serialized on Windows; win32.basename
  // understands both separators regardless of the inspecting host's platform.
  const stamp = path.win32.basename(promptFile).replace(/\.prompt\.txt$/i, '').trim()
  return stamp || null
}

function remoteControlDir() {
  return path.join(os.homedir(), '.devspec', 'opencode-remote-control')
}

function serverPidFile(folder, sessionId, instanceId) {
  return path.join(remoteControlDir(), `${directoryKey(folder, sessionId, instanceId)}.server.pid`)
}

function remoteControlStateFile(folder, sessionId, instanceId) {
  return path.join(remoteControlDir(), `${directoryKey(folder, sessionId, instanceId)}.json`)
}

/** True if a process with this pid currently exists (no signal actually sent on any platform). */
function isPidAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/**
 * Replace THIS session's own prior server, if one is still alive — never a
 * different session's. Round 9: now that pid/state files are keyed by
 * (folder, sessionId) (see directoryKey), a live server for a DIFFERENT
 * DevSpec session against the same folder lives in a completely separate pid
 * file this call never even reads, so it's simply left running untouched.
 * Free port allocation already means two servers for one folder can coexist
 * (findFreePort, per launch) once each owns its own isolated pid/state file —
 * the only thing actually stopping that before was this function reading and
 * killing whatever ONE folder-wide pid happened to be recorded, regardless of
 * which session it belonged to.
 *
 * Round 8's cross-session warn-then-kill is gone along with the cross-session
 * kill it was warning about — a different session's server is no longer
 * touched at all, so there is nothing left to warn its owner about. A bare
 * (sessionless) launch keeps the original folder-only single-server
 * enforcement (unchanged, out of scope here — see the sibling item that
 * makes connection identity itself session-scoped).
 *
 * Real bug found live-testing (round 7, still applies): `taskkill` can fail
 * silently against a pid that IS genuinely still alive — verify the pid is
 * actually gone afterward and retry once before giving up (logged either
 * way), rather than trusting the exit status.
 *
 * @param {string} folder
 * @param {{ incomingSessionId?: string | null, incomingModel?: string | null, instanceId?: string | null }} [ctx]
 */
async function killExistingServer(folder, ctx = {}) {
  const sessionId = ctx.incomingSessionId || null
  const instanceId = ctx.instanceId || null
  const pidFile = serverPidFile(folder, sessionId, instanceId)
  let pid
  try {
    pid = Number((await fsPromises.readFile(pidFile, 'utf8')).trim())
  } catch {
    return
  }
  if (!Number.isInteger(pid) || pid <= 0) return

  if (isPidAlive(pid)) {
    await log(`relaunch: replacing this session's own prior server pid=${pid} session=${sessionId || 'none'}`)
  }

  for (let attempt = 1; attempt <= 2; attempt++) {
    if (!isPidAlive(pid)) {
      await log(`prior server pid=${pid} already gone (attempt ${attempt})`)
      break
    }
    await log(`killing prior server pid=${pid} (attempt ${attempt})`)
    try {
      if (process.platform === 'win32') {
        const result = spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], {
          encoding: 'utf8',
          windowsHide: true,
        })
        await log(
          `taskkill pid=${pid} status=${result.status} stdout=${(result.stdout || '').trim()} stderr=${(result.stderr || '').trim()}`,
        )
      } else {
        process.kill(pid, 'SIGKILL')
      }
    } catch (err) {
      await log(`kill pid=${pid} threw: ${err}`)
    }
    await new Promise((r) => setTimeout(r, 300))
    if (!isPidAlive(pid)) {
      await log(`confirmed prior server pid=${pid} is gone`)
      break
    }
    if (attempt === 2) {
      await log(`WARNING: prior server pid=${pid} still alive after 2 kill attempts — giving up, may be orphaned`)
    }
  }

  try {
    await fsPromises.unlink(remoteControlStateFile(folder, sessionId, instanceId))
  } catch {
    // already gone
  }
}

function parseArgs(argv) {
  const out = { headed: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--folder' && argv[i + 1]) out.folder = argv[++i]
    else if (a === '--prompt-file' && argv[i + 1]) out.promptFile = argv[++i]
    else if (a === '--opencode' && argv[i + 1]) out.opencode = argv[++i]
    else if (a === '--model' && argv[i + 1]) out.model = argv[++i]
    else if (a === '--headed') out.headed = true
  }
  return out
}

/**
 * Build `opencode serve` argv for a DevSpec cold-launch.
 *
 * Do NOT pass `--auto` here. OpenCode 1.18+ `serve` rejects unknown flags
 * (yargs prints help and exits), so `serve --auto --port N` never binds and
 * waitForServer times out. Permission auto-approve belongs on `run` — see
 * {@link buildOpencodeRunArgs} — which is where prompts actually happen.
 *
 * @param {number|string} port
 * @returns {string[]}
 */
export function buildOpencodeServeArgs(port) {
  return ['serve', '--port', String(port)]
}

/**
 * Build the `opencode run` argv (minus `--attach`, added by the caller) for a
 * prompt body + optional model.
 *
 * Always includes `--auto` so permission prompts that would hang an
 * headless remote session (notably `external_directory` for Temp paths)
 * are auto-approved unless explicitly denied in config/env. Interactive
 * `opencode` TUI launches (not via this script) are unchanged.
 *
 * `opencode run` does NOT expand a leading "/command args" string the way
 * typing it into the interactive TUI does — passed as a plain positional
 * message, the model just receives it as inert text (observed live: it
 * tried to execute "/devspec.remote --session <uuid>" as a shell path).
 * The registered-command form needs the dedicated --command flag instead,
 * with "--" so yargs doesn't reparse the command's own flags (e.g.
 * --session) as opencode's own.
 * @param {string} promptBody
 * @param {string} [model]
 * @returns {string[]}
 */
export function buildOpencodeRunArgs(promptBody, model) {
  const runArgs = ['run', '--auto']
  const trimmedModel = typeof model === 'string' ? model.trim() : ''
  if (trimmedModel) runArgs.push('--model', trimmedModel)

  const slashCommand = promptBody.match(/^\/([a-zA-Z0-9_.-]+)\s*(.*)$/s)
  if (slashCommand) {
    const [, commandName, commandArgs] = slashCommand
    runArgs.push('--command', commandName)
    if (commandArgs) runArgs.push('--', commandArgs)
  } else {
    runArgs.push(promptBody)
  }
  return runArgs
}

const LAUNCHER_LOG_FILE = path.join(remoteControlDir(), 'launcher.log')
const UUID_RE =
  /[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/i

/**
 * This script is always spawned with `stdio: 'ignore'` by open-handler-core
 * (it must run invisibly — see the file header) — which means every
 * console.log/console.error call before this fix went straight into the
 * void. Real gap found live-testing: a launch that failed partway through
 * (server never came up, client errored) left zero trace anywhere, making
 * it indistinguishable from "still working, just slow." Persist the same
 * milestones to a log file instead of only stdio.
 *
 * Round 8 (stuck MiniMax + flash-closed window): client `stdio: 'ignore'`
 * also threw away the ONLY copy of the failure reason (model/auth errors,
 * session.error). We now tee client stdout/stderr into this same log and
 * post non-zero exits into the DevSpec session when we can resolve a token.
 */
async function log(line) {
  try {
    await fsPromises.mkdir(path.dirname(LAUNCHER_LOG_FILE), { recursive: true })
    await fsPromises.appendFile(LAUNCHER_LOG_FILE, `${new Date().toISOString()} ${line}\n`, 'utf8')
  } catch {
    // best-effort — logging must never be why a launch fails
  }
}

/** Pull `--session <uuid>` (or bare uuid after /devspec.remote) from the connect prompt. */
export function extractSessionIdFromPrompt(promptBody) {
  if (typeof promptBody !== 'string' || !promptBody.trim()) return null
  const flagged = promptBody.match(/--session\s+([0-9a-f-]{36})/i)
  if (flagged?.[1]) return flagged[1]
  const bare = promptBody.match(UUID_RE)
  return bare?.[0] ?? null
}

function extractBearer(headers) {
  if (!headers || typeof headers !== 'object') return null
  const auth = headers.Authorization || headers.authorization
  if (typeof auth !== 'string') return null
  const m = auth.match(/^Bearer\s+(.+)$/i)
  return m?.[1]?.trim() || null
}

/**
 * Minimal self-contained MCP auth (this file is copied alone to
 * ~/.cursor/devspec — cannot rely on hooks/scripts at runtime).
 */
async function resolveMcpAuthForFolder(folder) {
  const envToken = process.env.DEVSPEC_MCP_TOKEN || process.env.DEVSPEC_TOKEN || null
  const envUrl = process.env.DEVSPEC_MCP_URL || null
  if (envToken) {
    return {
      ok: true,
      token: envToken,
      mcp_url: (envUrl || 'https://api.devspec.ai/api/mcp').replace(/\/+$/, ''),
      source: 'env',
    }
  }

  let dir = path.resolve(folder || process.cwd())
  for (let i = 0; i < 12; i++) {
    for (const name of ['.mcp.json', 'mcp.json']) {
      try {
        const raw = await fsPromises.readFile(path.join(dir, name), 'utf8')
        const json = JSON.parse(raw)
        const servers = json?.mcpServers || json?.mcp || {}
        for (const [key, entry] of Object.entries(servers)) {
          if (!/devspec/i.test(key) || !entry || typeof entry !== 'object') continue
          const token = extractBearer(entry.headers) || entry.token || null
          const url = typeof entry.url === 'string' ? entry.url.replace(/\/+$/, '') : null
          if (token && url) {
            return { ok: true, token, mcp_url: url, source: path.join(dir, name) }
          }
        }
      } catch {
        // missing / invalid — keep walking
      }
    }
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }

  return { ok: false, token: null, mcp_url: null, source: null }
}

async function postToDevspecSession({ folder, sessionId, message, agentName = 'OpenCode' }) {
  if (!sessionId || !message) {
    await log(`postToDevspecSession skipped (sessionId=${sessionId || 'null'})`)
    return false
  }
  const auth = await resolveMcpAuthForFolder(folder)
  if (!auth.ok || !auth.token || !auth.mcp_url) {
    await log(`postToDevspecSession auth failed — cannot notify session ${sessionId}`)
    return false
  }
  await log(`postToDevspecSession → session=${sessionId} via ${auth.source}`)
  try {
    const body = {
      jsonrpc: '2.0',
      id: Date.now(),
      method: 'tools/call',
      params: {
        name: 'post_session_message',
        arguments: {
          session_id: sessionId,
          message,
          agent_name: agentName,
        },
      },
    }
    const res = await fetch(auth.mcp_url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${auth.token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify(body),
    })
    const text = await res.text()
    if (!res.ok) {
      await log(`postToDevspecSession HTTP ${res.status}: ${text.slice(0, 300)}`)
      return false
    }
    await log(`postToDevspecSession ok (${text.length} bytes)`)
    return true
  } catch (err) {
    await log(`postToDevspecSession threw: ${err}`)
    return false
  }
}

/**
 * Tee a child stream into launcher.log. Returns a buffer of the last ~8KB
 * for inclusion in failure posts.
 *
 * Real gap found live-testing (round 11): the client is always spawned with
 * stdio ['ignore','pipe','pipe'] regardless of `--headed` — only the SERVER's
 * stdio flips to 'inherit' when headed. So the "headed" console only ever
 * showed the server's startup banner; the client's own output (the model's
 * narration, register/attach calls, the final status block) went straight
 * into launcher.log and was never visible in the window the owner opened
 * specifically to watch it. When headed, also mirror each chunk to this
 * script's own stdout/stderr (inherited by the visible console) IN ADDITION
 * to the log — never instead of it, since the log capture is what round 8's
 * failure-posting relies on.
 */
function attachStreamLogging(stream, label, capture, headed) {
  if (!stream) return
  stream.setEncoding('utf8')
  stream.on('data', (chunk) => {
    const text = String(chunk)
    capture.chunks.push(text)
    capture.bytes += text.length
    // Keep a bounded tail for DevSpec posts
    while (capture.bytes > 8192 && capture.chunks.length > 1) {
      const dropped = capture.chunks.shift()
      capture.bytes -= dropped.length
    }
    if (headed) {
      const out = label === 'stderr' ? process.stderr : process.stdout
      out.write(text)
    }
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue
      void log(`client ${label}: ${line}`)
    }
  })
}

function captureTail(capture) {
  return capture.chunks.join('').trim().slice(-2000)
}

function waitForChildExit(child) {
  return new Promise((resolve) => {
    child.once('error', (err) => resolve({ code: 1, signal: null, error: err }))
    child.once('exit', (code, signal) => resolve({ code, signal, error: null }))
  })
}

/** Find a free TCP port on localhost for the headless server to listen on. */
function findFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.listen(0, '127.0.0.1', () => {
      const address = srv.address()
      srv.close(() => resolve(typeof address === 'object' && address ? address.port : 0))
    })
    srv.on('error', reject)
  })
}

/**
 * Poll until the headless OpenCode server is accepting requests.
 *
 * Real bug found live-testing: this used to hit `/doc` (OpenAPI — ~480KB on
 * OpenCode 1.18) with a bare `await fetch(...)` and no AbortSignal. When that
 * first request hung, the while-loop never advanced, the overall timeout
 * never fired, and the launcher sat forever after "spawned server" — no
 * client, no `/devspec.remote`, session stuck on "connecting". Confirmed:
 * `/global/health` returned `{"healthy":true}` while the launcher was still
 * wedged on `/doc`. Prefer the tiny health endpoint, and abort each attempt
 * so a hung fetch cannot outlive the deadline.
 */
async function waitForServer(port, timeoutMs = 15000, auth = null) {
  const deadline = Date.now() + timeoutMs
  const healthUrl = `http://127.0.0.1:${port}/global/health`
  /** @type {Record<string, string> | undefined} */
  const headers =
    auth && auth.password
      ? { Authorization: basicAuthHeaderValue(auth.username, auth.password) }
      : undefined
  while (Date.now() < deadline) {
    const remaining = deadline - Date.now()
    if (remaining <= 0) break
    const attemptMs = Math.min(2000, remaining)
    try {
      const res = await fetch(healthUrl, {
        signal: AbortSignal.timeout(attemptMs),
        headers,
      })
      if (res.ok) {
        // Prefer a JSON healthy:true when present, but any 2xx means the
        // server is accepting connections (older builds may differ).
        try {
          const body = await res.json()
          if (body && body.healthy === false) {
            await new Promise((r) => setTimeout(r, 300))
            continue
          }
        } catch {
          // non-JSON 2xx is still "up enough" to attach a client
        }
        return true
      }
    } catch {
      // not up yet / aborted — retry until deadline
    }
    await new Promise((r) => setTimeout(r, 300))
  }
  return false
}

export { waitForServer }

async function main() {
  const args = parseArgs(process.argv.slice(2))
  await log(`start argv=${JSON.stringify(process.argv.slice(2))}`)
  if (!args.folder || !args.promptFile) {
    console.error(
      'Usage: launch-opencode-session.mjs --folder <path> --prompt-file <path> [--opencode <path>] [--model <id>] [--headed]',
    )
    await log('missing --folder or --prompt-file')
    process.exitCode = 1
    return
  }

  const opencodeBin = args.opencode || 'opencode'
  let promptBody
  try {
    promptBody = (await fsPromises.readFile(args.promptFile, 'utf8')).trim()
  } catch (err) {
    console.error(`[devspec-opencode] could not read prompt file: ${err}`)
    await log(`could not read prompt file: ${err}`)
    process.exitCode = 1
    return
  }

  const sessionId = extractSessionIdFromPrompt(promptBody)
  const instanceId = fleetInstanceIdFromPromptFile(args.promptFile)
  await log(
    `prompt sessionId=${sessionId || 'none'} instanceId=${instanceId || 'none'} model=${args.model || 'auto'} promptBytes=${promptBody.length}`,
  )

  // Must happen before spawning the new server — see "round 4" note above.
  // A second live server for the same directory means two processes racing
  // to write the same state file, not two independent connections.
  // Fleet instance ids (item 9d213c07) keep each Launch-agents OpenCode on its
  // own pid file so siblings are not treated as replacements.
  await killExistingServer(args.folder, {
    incomingSessionId: sessionId,
    incomingModel: args.model || null,
    instanceId,
  })
  await log(`opencodeBin=${opencodeBin} folder=${args.folder}`)

  // Multi-repo automations need sibling mapped checkouts outside the launch
  // cwd. Derive OPENCODE_PERMISSION.external_directory from this user's
  // repo-folder-map — never hardcoded machine paths (SaaS-safe).
  const mapPath = path.join(os.homedir(), '.cursor', 'devspec', 'repo-folder-map.json')
  const permissionLaunch = await buildOpenCodeLaunchEnv({
    launchFolder: args.folder,
    mapPath,
  })
  const allowCount = Object.keys(permissionLaunch.externalDirectoryRules).length
  await log(
    `mappedFolders=${permissionLaunch.mappedFolderCount} externalDirectoryAllows=${allowCount}` +
      (allowCount
        ? ` patterns=${JSON.stringify(Object.keys(permissionLaunch.externalDirectoryRules))}`
        : ''),
  )

  // Local HTTP basic auth for `opencode serve` ↔ attach client only.
  // DevSpec's long-poll uses the MCP token and never sees this password.
  const serveAuth = resolveServeAuth(permissionLaunch.env)
  const launchEnv = withServeAuthEnv(permissionLaunch.env, serveAuth)
  await log(
    `serveAuth source=${serveAuth.source} username=${serveAuth.username} (password not logged)`,
  )

  const port = await findFreePort()
  await log(`chose port ${port}`)

  // Real bug found live-testing (round 5): `detached: true` reliably killed
  // the server on Windows before it ever bound its port — empty log, no
  // process, no trace, regardless of stdio/windowsHide. Isolated by testing
  // spawn configurations directly: `detached` alone (no windowsHide) failed
  // the same way, and `windowsHide` alone (no `detached`) started and
  // listened fine every time. Most likely cause: Windows' DETACHED_PROCESS
  // creation flag (what `detached` maps to) means NO console at all, which
  // conflicts with something PowerShell's own startup expects — whereas
  // `windowsHide` maps to CREATE_NO_WINDOW, a console that merely isn't
  // shown, which PowerShell tolerates fine.
  //
  // `detached` was never actually necessary for survival here: Windows does
  // NOT kill a child process when its parent exits (unlike POSIX process
  // groups) unless something explicitly ties their lifetimes together (e.g.
  // a Job Object with kill-on-close, which a launch from Explorer/browser
  // via the devspec:// protocol handler does not create). `windowsHide` +
  // `stdio: 'ignore'` alone is sufficient for both invisibility and survival.
  //
  // TEMP DEBUG / product headed: show the serve console when not under
  // fleet settle. Under DEVSPEC_FLEET_SETTLE never inherit — the settle
  // parent pipes stdout/stderr, and inherit keeps those pipes open in the
  // OpenCode child so runNodeLaunchSettled's 'close' never fires (item
  // 914889b5). windowsHide:!headed still shows a console when headed.
  const headed = args.headed === true
  const fleetSettleEarly = process.env.DEVSPEC_FLEET_SETTLE === '1'
  const serveArgs = buildOpencodeServeArgs(port)
  const server = spawnAgent(opencodeBin, serveArgs, {
    cwd: args.folder,
    env: launchEnv,
    stdio: fleetSettleEarly || !headed ? 'ignore' : 'inherit',
    windowsHide: !headed,
  })
  await log(`serve argv=${JSON.stringify(serveArgs)}`)
  server.unref()
  await log(`spawned server pid=${server.pid ?? 'unknown'} headed=${headed}`)

  const ready = await waitForServer(port, 15000, serveAuth)
  await log(`waitForServer ready=${ready}`)
  if (!ready) {
    console.error(`[devspec-opencode] server did not come up on port ${port} in time`)
    await log(`FATAL: server did not come up on port ${port} in time`)
    await postToDevspecSession({
      folder: args.folder,
      sessionId,
      message: `⚠️ OpenCode launch failed: headless server did not come up on port ${port} in time. See launcher.log under ~/.devspec/opencode-remote-control/.`,
    })
    process.exitCode = 1
    return
  }

  // Record the REAL listening pid, not spawn()'s own return value — see the
  // "round 6" note at the top of this file for why that pid goes stale
  // almost immediately and made every prior kill-existing-server attempt a
  // silent no-op.
  const realPid = (await findListeningPid(port)) ?? server.pid
  await log(`recording server pid=${realPid ?? 'unknown'} (spawn returned ${server.pid ?? 'unknown'})`)
  if (realPid) {
    await fsPromises.mkdir(remoteControlDir(), { recursive: true })
    await fsPromises.writeFile(
      serverPidFile(args.folder, sessionId, instanceId),
      String(realPid),
      'utf8',
    )
  }

  const attachUrl = `http://127.0.0.1:${port}`
  const runArgs = buildOpencodeRunArgs(promptBody, args.model)
  runArgs.splice(1, 0, '--attach', attachUrl)
  // Password stays in env (`OPENCODE_SERVER_PASSWORD`); OpenCode's CLI defaults
  // `--password` from that env. Avoid putting the secret on argv (and logs).

  console.log(
    `[devspec-opencode] Server up on ${attachUrl}; sending connect message (model=${args.model || 'auto'})`,
  )
  await log(`spawning client runArgs=${JSON.stringify(redactArgsForLog(runArgs))}`)
  // Reuses the Windows-safe invocation logic built for Cursor's `agent` binary
  // (prefer a sibling .ps1 over wrapping a .cmd in `cmd /c`, which loses the
  // real console TTY and flash-closes the window) — the same shim-resolution
  // problem applies to any npm-installed .cmd binary, not just Cursor's.
  //
  // Fleet ready-gate (items 2ed52078 / 9ed47884): settle means "server
  // healthy", not "connect client finished its whole remote turn". Exit this
  // process immediately after starting the client — piping stdout/stderr +
  // return kept Node alive on open pipes, so runNodeLaunchSettled never saw
  // spawn N ok and Pi never started.
  //
  // Headed fleet (item ea464dc2): open a visible cmd /k console for the
  // connect client (same class as Pi). Headless fleet keeps stdio-ignore
  // + windowsHide so settle stays silent.
  const fleetSettle = process.env.DEVSPEC_FLEET_SETTLE === '1'
  if (fleetSettle) {
    if (headed) {
      const client = spawnVisibleOpenCodeClient({
        opencodeBin,
        runArgs,
        folder: args.folder,
        env: launchEnv,
      })
      client.unref()
      console.log(
        `[devspec-opencode] Fleet settle: server healthy on ${attachUrl}; visible connect client started`,
      )
      await log(
        `fleet settle: visible client console started port=${port} client_pid=${client.pid ?? 'unknown'}`,
      )
      process.exit(0)
    }
    const client = spawnAgent(opencodeBin, runArgs, {
      cwd: args.folder,
      env: launchEnv,
      stdio: 'ignore',
      windowsHide: true,
    })
    client.unref()
    console.log(
      `[devspec-opencode] Fleet settle: server healthy on ${attachUrl}; connect client detached`,
    )
    await log(
      `fleet settle: server healthy port=${port} client_pid=${client.pid ?? 'unknown'} (stdio ignore; exiting)`,
    )
    process.exit(0)
  }

  // Round 8: pipe stdout/stderr into launcher.log so MiniMax/model failures
  // are not lost when the invisible client exits code 1 in a few seconds.
  // TEMP DEBUG (`--headed`): still pipe (so failure capture keeps working),
  // leave the window visible via windowsHide:false, and mirror the piped
  // output live into that window (see round 11 note on attachStreamLogging).
  const client = spawnAgent(opencodeBin, runArgs, {
    cwd: args.folder,
    env: launchEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: !headed,
  })
  await log(`spawned client pid=${client.pid ?? 'unknown'} headed=${headed}`)

  const stdoutCapture = { chunks: [], bytes: 0 }
  const stderrCapture = { chunks: [], bytes: 0 }
  attachStreamLogging(client.stdout, 'stdout', stdoutCapture, headed)
  attachStreamLogging(client.stderr, 'stderr', stderrCapture, headed)

  const exit = await waitForChildExit(client)
  if (exit.error) {
    console.error(`[devspec-opencode] failed to run connect command: ${exit.error}`)
    await log(`client error event: ${exit.error}`)
  }
  await log(`client exit code=${exit.code} signal=${exit.signal}`)

  const stderrTail = captureTail(stderrCapture)
  const stdoutTail = captureTail(stdoutCapture)
  if (stderrTail) await log(`client stderr tail (${stderrTail.length} chars):\n${stderrTail}`)
  if (stdoutTail) await log(`client stdout tail (${stdoutTail.length} chars):\n${stdoutTail}`)

  const failed = Boolean(exit.error) || Boolean(exit.signal) || (exit.code ?? 0) !== 0
  if (failed) {
    const modelLabel = args.model || 'auto'
    const detailParts = [
      `OpenCode connect failed (exit ${exit.code ?? 'n/a'}${exit.signal ? `, signal ${exit.signal}` : ''}).`,
      `Model: ${modelLabel}`,
      sessionId ? `Session: ${sessionId}` : null,
      stderrTail ? `Stderr:\n${stderrTail}` : null,
      !stderrTail && stdoutTail ? `Stdout:\n${stdoutTail}` : null,
      `Full log: ~/.devspec/opencode-remote-control/launcher.log`,
    ].filter(Boolean)
    await postToDevspecSession({
      folder: args.folder,
      sessionId,
      message: `⚠️ ${detailParts.join('\n\n')}`,
    })
    process.exitCode = 1
    return
  }

  // The persistent server is intentionally left running — only the one-shot
  // connect/message client call is done. Exit 0 here is normal.
  process.exitCode = 0
}

const isDirectRun =
  process.argv[1] &&
  (process.argv[1].endsWith('launch-opencode-session.mjs') ||
    process.argv[1].endsWith('launch-opencode-session.js'))

if (isDirectRun) {
  void main()
}
