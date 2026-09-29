/** Verified, versioned payload publication. OS integration is deliberately separate.
 * A plugin may arrive while another is installing: one lock and an atomic pointer
 * prevent a mixed release from becoming executable (27b53001).
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

export const MANIFEST = 'LAUNCHER-MANIFEST.json'
export const ACTIVE = 'active.json'
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/
const FILE = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/

export function compareReleaseVersions(a, b) {
  if (!VERSION.test(a) || !VERSION.test(b)) throw new Error('Invalid launcher release version')
  const left = a.split('.').map(BigInt), right = b.split('.').map(BigInt)
  for (let i = 0; i < 3; i++) if (left[i] !== right[i]) return left[i] > right[i] ? 1 : -1
  return 0
}
const sha = bytes => `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`

export function readVerifiedPayload(dir) {
  if (!fs.lstatSync(dir).isDirectory()) throw new Error('Launcher payload directory must not be a symlink')
  const raw = fs.readFileSync(path.join(dir, MANIFEST))
  const manifest = JSON.parse(raw)
  if (!manifest || !VERSION.test(manifest.version) || !manifest.files || Array.isArray(manifest.files)) {
    throw new Error('Invalid launcher manifest')
  }
  const entries = Object.entries(manifest.files)
  if (!entries.length) throw new Error('Empty launcher manifest')
  const files = new Map()
  for (const [name, expected] of entries) {
    if (!FILE.test(name) || name === MANIFEST || !/^sha256:[a-f0-9]{64}$/.test(expected)) {
      throw new Error('Invalid launcher manifest entry')
    }
    const file = path.join(dir, name)
    if (!fs.lstatSync(file).isFile()) throw new Error('Launcher payload must contain regular files')
    const bytes = fs.readFileSync(file)
    if (sha(bytes) !== expected) throw new Error(`Launcher payload verification failed: ${name}`)
    files.set(name, bytes)
  }
  const expectedNames = new Set([MANIFEST, ...entries.map(([name]) => name)])
  if (fs.readdirSync(dir).some(name => !expectedNames.has(name))) throw new Error('Launcher payload contains unmanifested files')
  // Identity ignores manifest formatting/order, not file bytes.
  const identity = sha(JSON.stringify({ version: manifest.version, files: Object.fromEntries(entries.sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) })).slice(7)
  return { manifest, raw, files, identity }
}

export function readActivePayload(home) {
  const pointer = JSON.parse(fs.readFileSync(path.join(home, ACTIVE), 'utf8'))
  if (!VERSION.test(pointer.version) || !/^[a-f0-9]{64}$/.test(pointer.identity)) throw new Error('Invalid active launcher pointer')
  const dir = path.join(home, 'releases', `${pointer.version}-${pointer.identity}`)
  return { ...pointer, dir }
}

export function atomicWrite(file, bytes) {
  const temporary = `${file}.${crypto.randomUUID()}.tmp`
  try {
    fs.writeFileSync(temporary, bytes, { mode: 0o600, flag: 'wx' })
    fs.renameSync(temporary, file)
  } finally { fs.rmSync(temporary, { force: true }) }
}

function releaseHistory(home) {
  const releases = path.join(home, 'releases')
  let entries
  try {
    if (!fs.lstatSync(releases).isDirectory()) throw new Error('Launcher releases must not be a symlink')
    entries = fs.readdirSync(releases)
  } catch (error) { if (error.code === 'ENOENT') return null; throw error }
  const candidates = entries.flatMap(name => {
    const match = /^(\d+\.\d+\.\d+)-([a-f0-9]{64})$/.exec(name)
    if (!match || !VERSION.test(match[1])) return []
    const dir = path.join(releases, name)
    if (!fs.lstatSync(dir).isDirectory()) throw new Error('Launcher release must not be a symlink')
    return [{ version: match[1], identity: match[2], dir }]
  }).sort((a, b) => compareReleaseVersions(b.version, a.version))
  if (candidates.length > 1 && candidates[0].version === candidates[1].version) throw new Error('Conflicting release history; recover using the current plugin release')
  return candidates[0] ?? null
}
function legacyVersion(home) {
  try {
    const version = JSON.parse(fs.readFileSync(path.join(home, '.launcher-version'), 'utf8'))?.version
    return VERSION.test(version) ? version : null
  } catch (error) { if (error.code === 'ENOENT' || error instanceof SyntaxError) return null; throw error }
}

/** Caller holds the install lock until OS integration finishes as well. */
export function publishPayload({ sourceDir, home, repair = false }) {
  const offered = readVerifiedPayload(sourceDir)
  fs.mkdirSync(home, { recursive: true, mode: 0o700 })
  if (!fs.lstatSync(home).isDirectory()) throw new Error('Launcher home must be a dedicated directory, not a symlink')
  fs.chmodSync(home, 0o700)
  let active = null, recoveredPointer = false
  const legacy = legacyVersion(home)
  try { active = readActivePayload(home) }
  catch (error) {
    if (error.code !== 'ENOENT' && !repair) throw new Error('Launcher active pointer is damaged; explicit repair is required.')
    active = releaseHistory(home)
    if (error.code !== 'ENOENT' && !active && !legacy) throw new Error('Release history is missing; cannot determine a safe repair version.')
    recoveredPointer = true
  }
  if (legacy && compareReleaseVersions(legacy, offered.manifest.version) > 0 && (!active || compareReleaseVersions(legacy, active.version) > 0)) {
    throw new Error('A newer legacy launcher is installed; use its current plugin release to repair it.')
  }
  const restorePointer = () => {
    if (recoveredPointer) atomicWrite(path.join(home, ACTIVE), JSON.stringify({ version: active.version, identity: active.identity }) + '\n')
  }
  if (active) {
    const comparison = compareReleaseVersions(offered.manifest.version, active.version)
    if (comparison < 0) {
      // An old plugin must never repair a new release with old bytes.
      const installed = readVerifiedPayload(active.dir)
      if (installed.identity !== active.identity) throw new Error('Newer launcher is damaged; repair from its current plugin release.')
      restorePointer()
      return { ok: true, outcome: 'kept_newer', ...active }
    }
    if (comparison === 0 && offered.identity !== active.identity) throw new Error('Conflicting launcher payloads use the same version; publish a new release.')
    if (comparison === 0) {
      let intact = false
      try { intact = readVerifiedPayload(active.dir).identity === active.identity }
      catch { /* reconstruct exactly this verified release below */ }
      if (intact) {
        restorePointer()
        return { ok: true, outcome: recoveredPointer ? 'repaired' : 'current', ...active }
      }
    }
  }
  const releases = path.join(home, 'releases')
  fs.mkdirSync(releases, { recursive: true, mode: 0o700 })
  if (!fs.lstatSync(releases).isDirectory()) throw new Error('Launcher releases must not be a symlink')
  const dir = path.join(releases, `${offered.manifest.version}-${offered.identity}`)
  const temporary = path.join(releases, `.install-${crypto.randomUUID()}`)
  fs.mkdirSync(temporary, { mode: 0o700 })
  try {
    for (const [name, bytes] of offered.files) fs.writeFileSync(path.join(temporary, name), bytes, { mode: name.endsWith('.sh') ? 0o700 : 0o600 })
    fs.writeFileSync(path.join(temporary, MANIFEST), offered.raw, { mode: 0o600 })
    readVerifiedPayload(temporary)
    // A damaged same-version release cannot execute reliably already. Retain it
    // for diagnosis instead of mutating individual files beneath a live import.
    if (fs.existsSync(dir)) fs.renameSync(dir, `${dir}.damaged-${crypto.randomUUID()}`)
    fs.renameSync(temporary, dir)
    atomicWrite(path.join(home, ACTIVE), `${JSON.stringify({ version: offered.manifest.version, identity: offered.identity })}\n`)
    // Older Pi plugins know only this marker. Keep it so their flat copier
    // cannot overwrite the newer shared install on its next startup.
    atomicWrite(path.join(home, '.launcher-version'), `${JSON.stringify({ version: offered.manifest.version })}\n`)
    return { ok: true, outcome: active?.version === offered.manifest.version ? 'repaired' : 'installed', version: offered.manifest.version, identity: offered.identity, dir }
  } finally { fs.rmSync(temporary, { recursive: true, force: true }) }
}
