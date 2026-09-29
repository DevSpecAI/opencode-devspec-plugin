/** Cooperative bakery lock for a local per-user installation directory.
 * Every worker owns a unique claim file; recovery NEVER deletes a shared lock
 * name that another worker may have acquired. Dead processes are ignored. No
 * second network listener, stale-time lease stealing, elevation or policy bypass.
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { atomicWrite } from './payload.mjs'
import { launcherHome } from './paths.mjs'
const WORKER = Symbol.for('devspec.launcher.installWorker')
const workerId = globalThis[WORKER] ??= randomUUID()
const CLAIM = /^\d+-[a-f0-9-]{36}-[a-f0-9-]{36}\.json$/

function alive(pid) {
  try { process.kill(pid, 0); return true }
  catch (error) { return error.code !== 'ESRCH' }
}
/** Start metadata only, never another process's command line or credentials. */
function processStart(pid) {
  try {
    if (process.platform === 'linux') {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8')
      return stat.slice(stat.lastIndexOf(')') + 1).trim().split(/\s+/)[19] ?? null
    }
    if (process.platform === 'darwin') {
      return execFileSync('ps', ['-p', String(pid), '-o', 'lstart='], { encoding: 'utf8', timeout: 2000, env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' }, stdio: ['ignore', 'pipe', 'pipe'] }).trim() || null
    }
    if (process.platform === 'win32') {
      return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().Ticks`], { encoding: 'utf8', timeout: 2000, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim() || null
    }
  } catch { /* unavailable process metadata is UNKNOWN, never permission to steal */ }
  return null
}

export async function withInstallerLock(operation, { home = launcherHome() } = {}) {
  const dir = path.join(home, 'install-claims')
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  const id = `${process.pid}-${workerId}-${randomUUID()}.json`
  const file = path.join(dir, id)
  const claim = { version: 1, pid: process.pid, workerId, machine: os.hostname(), start: null, created: Date.now(), choosing: true, ticket: 0 }
  const busy = () => ({ ok: false, outcome: 'busy', reason: 'Another launcher installation is active or could not be safely identified. Retry shortly; Copy commands remain available.' })
  function peers() {
    const rows = []
    for (const name of fs.readdirSync(dir).filter(name => CLAIM.test(name) && name !== id)) {
      const peerFile = path.join(dir, name)
      let peer
      try { peer = JSON.parse(fs.readFileSync(peerFile, 'utf8')) }
      catch (error) {
        if (error.code === 'ENOENT') continue
        const pid = Number(name.split('-')[0])
        if (Number.isSafeInteger(pid) && pid > 0 && pid <= 0xffffffff && !alive(pid)) { fs.rmSync(peerFile, { force: true }); continue }
        rows.push({ choosing: true, ticket: 0, id: name }); continue
      }
      if (peer.machine !== claim.machine) {
        // Shared/network-synchronized launcher state is not a supported local
        // process namespace. Do not probe or delete another machine's claim.
        rows.push({ choosing: true, ticket: 0, id: name }); continue
      }
      if (!Number.isSafeInteger(peer.pid) || peer.pid <= 0 || peer.pid > 0xffffffff || peer.pid !== Number(name.split('-')[0])) { rows.push({ choosing: true, ticket: 0, id: name }); continue }
      let live = alive(peer.pid)
      if (peer.pid === process.pid && peer.workerId !== workerId) live = false
      // Normal contention needs only kill(0). For an old surviving claim, an
      // immutable start identifier distinguishes PID reuse without a time lease.
      if (live && peer.start && Date.now() - peer.created > 60_000) {
        const current = processStart(peer.pid)
        if (current && current !== peer.start) live = false
      }
      if (!live) { fs.rmSync(peerFile, { force: true }); continue }
      if (peer.version !== 1 || typeof peer.choosing !== 'boolean' || !Number.isSafeInteger(peer.ticket) || peer.ticket < 0) rows.push({ choosing: true, ticket: 0, id: name })
      else rows.push({ ...peer, id: name })
    }
    return rows
  }
  // Cheap busy path avoids starting a process-metadata query per racing host.
  if (peers().length) return busy()
  atomicWrite(file, JSON.stringify(claim))
  try {
    claim.start = processStart(process.pid)
    claim.ticket = Math.max(0, ...peers().map(row => row.ticket)) + 1
    claim.choosing = false
    atomicWrite(file, JSON.stringify(claim))
    for (const peer of peers()) {
      if (peer.choosing || peer.ticket < claim.ticket || (peer.ticket === claim.ticket && peer.id < id)) return busy()
    }
    return await operation()
  } finally { fs.rmSync(file, { force: true }) }
}
