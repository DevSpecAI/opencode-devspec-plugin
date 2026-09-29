#!/usr/bin/env node
/** The shared executable used by plugins, OS registration and the standalone CLI. */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { randomBytes } from 'node:crypto'
import { deviceIdentity, forgetDeviceIdentity, verifyHealth } from './device-identity.mjs'
import { openSealedRequest } from './sealed-request.mjs'
import { executeLaunchOnce } from './launch-receipt.mjs'
import { publishPayload, readActivePayload, readVerifiedPayload, atomicWrite } from './payload.mjs'
import { withInstallerLock } from './install-lock.mjs'
import { integrationPlan, configureIntegration, removeIntegration, windowsUserSid, runIntegrationCommand } from './integration.mjs'
import { LAUNCHER_PORT, createLauncherServer } from './launcher-server.mjs'
import { verifyHandoffToken } from './handoff-verify.mjs'
import { migrateLegacyState } from './legacy-state.mjs'
import { resolveNodeRuntime } from './node-runtime.mjs'
import { installationId as getInstallationId, launcherHome } from './account-bindings.mjs'

const execFileAsync = promisify(execFile)
const sourceDir = path.dirname(fileURLToPath(import.meta.url))
export const defaultHome = launcherHome
const disabledPath = home => path.join(home, 'disabled.json')

export async function launcherHealth({ version, identity, publicKey, installationId: expectedInstallation, port = LAUNCHER_PORT } = {}) {
  try {
    if (!publicKey) return { ok: false, error: 'local_launch_not_verified' }
    const challenge = randomBytes(32).toString('hex')
    const response = await fetch(`http://127.0.0.1:${port}/health?challenge=${challenge}`,  { signal: AbortSignal.timeout(1200), redirect: 'error' })
    if (!response.ok) return { ok: false, error: 'unreachable' }
    const value = await response.json()
    if (!verifyHealth(value, { challenge, publicKey })) return { ok: false, error: 'incompatible_listener' }
    if (value?.service !== 'devspec-launcher' || value.protocol !== 1 || !Array.isArray(value.capabilities) || !value.capabilities.includes('account-bound-launch')) return { ok: false, error: 'incompatible_listener' }
    if (expectedInstallation && value.installationId !== expectedInstallation) return { ok: false, error: 'different_installation' }
    if ((version && value.version !== version) || (identity && value.identity !== identity)) return { ok: false, error: 'different_release', version: value.version }
    if (value.status !== 'ready') return { ok: false, running: true, error: value.status === 'disabled' ? 'disabled' : 'account_not_paired' }
    return { ok: true, running: true, version: value.version, identity: value.identity }
  } catch { return { ok: false, error: 'unreachable' } }
}

/** The plugin calls this from its native first-execution hook. Never throws. */
export async function ensureLauncherReady({ source = sourceDir, home = defaultHome(), repair = false } = {}) {
  try {
    if (process.env.DEVSPEC_LAUNCHER_DISABLED === '1') return { ok: false, outcome: 'disabled', disabledByEnvironment: true }
    if (fs.existsSync(disabledPath(home))) return { ok: false, outcome: 'disabled', reason: 'Launcher disabled by this user. Use the launcher enable command to restore it.' }
    const node = resolveNodeRuntime()
    readVerifiedPayload(source)
    // The worker owns its process-identified claim and completes the transaction
    // even if the coding host exits. Recovery ignores dead claims, never steals
    // a live worker's shared lock name or opens a second network listener.
    const { stdout } = await execFileAsync(node, [path.join(source, 'launcher.mjs'), repair ? 'ensure-repair' : 'ensure', '--home', home], {
      encoding: 'utf8', timeout: 45_000, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024,
    })
    return JSON.parse(stdout.trim())
  } catch (error) {
    const nodeRequired = error.message === 'Node.js 20 or newer is required for local launching.'
    const result = { ok: false, outcome: 'failed', error: nodeRequired ? 'node_required' : 'setup_failed', reason: nodeRequired ? 'Install Node.js 20 or newer to enable local launching; Copy commands remain available.' : error.code === 'ETIMEDOUT' ? 'Launcher setup timed out. Check local service permissions.' : 'Launcher setup failed. Run the launcher status command for diagnostics.' }
    try { atomicWrite(path.join(home, 'installation-status.json'), JSON.stringify({ ...result, code: String(error.code || 'setup_failed') }) + '\n') } catch { /* unwritable home is already a failure */ }
    return result
  }
}

async function performInstallation(home, repair = false) {
  if (process.env.DEVSPEC_LAUNCHER_DISABLED === '1' || fs.existsSync(disabledPath(home))) return { ok: false, outcome: 'disabled' }
  return withInstallerLock(async () => {
    const release = publishPayload({ sourceDir, home, repair })
    const bootstrap = fs.readFileSync(path.join(release.dir, 'run.mjs'))
    const installedBootstrap = path.join(home, 'run.mjs')
    let prior
    try { prior = fs.readFileSync(installedBootstrap) } catch (error) { if (error.code !== 'ENOENT') throw error }
    if (!prior?.equals(bootstrap)) atomicWrite(installedBootstrap, bootstrap)
    // Always use the selected newest release's configuration implementation.
    const selected = await import(pathToFileURL(path.join(release.dir, 'launcher.mjs')).href)
    const configured = await selected.configureLauncher(home)
    const result = { ...configured, outcome: configured.ok ? release.outcome : 'not_ready', version: release.version }
    atomicWrite(path.join(home, 'installation-status.json'), JSON.stringify(result) + '\n')
    return result
  })
}

function planFor(home, _release, registered = false) {
  let node = process.execPath
  if (registered) {
    try {
      const prior = JSON.parse(fs.readFileSync(path.join(home, 'integration-runtime.json'), 'utf8'))
      if (prior.platform === process.platform && typeof prior.node === 'string' && path.isAbsolute(prior.node)) node = prior.node
    } catch { /* older installations have no recorded runtime */ }
  }
  return integrationPlan({ home, node, entry: path.join(home, 'run.mjs'), sid: process.platform === 'win32' ? windowsUserSid() : undefined })
}

export async function configureLauncher(home) {
  const release = readActivePayload(home)
  const verified = readVerifiedPayload(release.dir)
  if (verified.identity !== release.identity) throw new Error('Active release verification failed')
  if (fs.existsSync(disabledPath(home))) return { ok: false, error: 'disabled' }
  migrateLegacyState({ home, legacyHome: path.join(os.homedir(), '.cursor', 'devspec') })
  const expected = { ...release, publicKey: deviceIdentity(home).publicKey, installationId: getInstallationId(home) }
  const health = await launcherHealth(expected)
  // A foreign listener is not ours to kill or overwrite. An older genuine
  // release is stopped only through our named user-service integration.
  if (['incompatible_listener', 'different_installation'].includes(health.error)) return { ok: false, error: 'port_in_use' }
  try {
    configureIntegration(planFor(home, release), { ready: health.ok || health.running === true })
    atomicWrite(path.join(home, 'integration-runtime.json'), JSON.stringify({ node: process.execPath, platform: process.platform }) + '\n')
  }
  catch { return { ok: false, error: 'os_registration_failed' } }
  // Bounded readiness wait, not a promise that an agent launched.
  for (let i = 0; i < 10; i++) {
    const current = await launcherHealth(expected)
    if (current.ok) return { ok: true, status: 'ready', version: release.version }
    if (current.error === 'account_not_paired' || current.error === 'disabled') return current
    await new Promise(resolve => setTimeout(resolve, 200))
  }
  return { ok: false, error: 'service_not_ready' }
}

export async function main(argv = process.argv.slice(2)) {
  const args = [...argv]
  const homeIndex = args.indexOf('--home')
  let home = defaultHome()
  if (homeIndex >= 0) {
    if (homeIndex !== 1) throw new Error('Launcher options must precede request data')
    if (!args[homeIndex + 1]) throw new Error('--home requires a directory')
    home = path.resolve(args[homeIndex + 1]); args.splice(homeIndex, 2)
  }
  const command = args.shift()
  process.env.DEVSPEC_LAUNCHER_HOME = home
  if (command === 'install' || command === 'enable' || command === 'repair') {
    if (command === 'enable') fs.rmSync(disabledPath(home), { force: true })
    const result = await ensureLauncherReady({ home, repair: command === 'repair' })
    console.log(JSON.stringify(result)); return result.ok ? 0 : 1
  }
  if (command === 'version' || command === '--version') { console.log(readVerifiedPayload(sourceDir).manifest.version); return 0 }
  if (command === 'ensure' || command === 'ensure-repair') {
    console.log(JSON.stringify(await performInstallation(home, command === 'ensure-repair')))
    return 0
  }
  if (command === 'status' || command === 'health') {
    let installation = null
    try { installation = JSON.parse(fs.readFileSync(path.join(home, 'installation-status.json'), 'utf8')) } catch { /* no prior attempt */ }
    let expectedInstallation = null
    try { expectedInstallation = fs.readFileSync(path.join(home, 'installation-id'), 'utf8').trim() } catch { /* no verified install for this OS user */ }
    const health = expectedInstallation ? await launcherHealth({ installationId: expectedInstallation, publicKey: deviceIdentity(home, { create: false }).publicKey }) : { ok: false, error: 'local_launch_not_verified' }
    const disabled = fs.existsSync(disabledPath(home))
    console.log(JSON.stringify({ ...health, disabled, installation })); return health.ok && !disabled ? 0 : 1
  }
  if (command === 'disable' || command === 'uninstall') {
    fs.mkdirSync(home, { recursive: true, mode: 0o700 })
    atomicWrite(disabledPath(home), JSON.stringify({ disabled: true }) + '\n')
    const result = await withInstallerLock(async () => {
      try {
        const release = readActivePayload(home)
        const plan = planFor(home, release, true)
        if (command === 'uninstall') { removeIntegration(plan); forgetDeviceIdentity(home) }
        else runIntegrationCommand(plan.stop)
        return { ok: true, status: command === 'uninstall' ? 'integration_removed' : 'disabled' }
      } catch { return { ok: false, error: 'service_stop_or_removal_failed', disabled: true } }
    })
    console.log(JSON.stringify(result)); return result.ok ? 0 : 1
  }
  if (command === 'serve') {
    if (fs.existsSync(disabledPath(home))) return 0
    const payload = readVerifiedPayload(sourceDir)
    const { executeHandoff } = await import('./open-handler-core.mjs')
    const server = createLauncherServer({ home, version: payload.manifest.version, identity: payload.identity, verify: verifyHandoffToken, execute: executeHandoff })
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(LAUNCHER_PORT, '127.0.0.1', resolve) })
    for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => { server.closeAllConnections(); server.close(() => process.exit(0)) })
    return undefined // service lifetime belongs to the server, not a detached child
  }
  if (command === 'open' && args.length === 1) {
    const { executeHandoff, normalizeProtocolUrl, isHandoffOpenUrl } = await import('./open-handler-core.mjs')
    const url = normalizeProtocolUrl(args[0])
    const encoded = url && isHandoffOpenUrl(url) ? url.searchParams.get('e') : null
    if (!encoded || encoded.length > 90000 || !/^[A-Za-z0-9_-]+$/.test(encoded)) throw new Error('Encrypted launch required')
    const device = deviceIdentity(home, { create: false })
    const token = openSealedRequest(JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')), device.privateKey)
    const receipt = await executeLaunchOnce({ home, token, publicKey: device.publicKey, execute: executeHandoff })
    console.log(JSON.stringify(receipt.result)); return receipt.result.ok ? 0 : 1
  }
  console.log('DevSpec Launcher: install | repair | status | enable | disable | uninstall. Installation uses the bundled release and current-user OS services.')
  return command ? 1 : 0
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(code => { if (code !== undefined) process.exitCode = code }).catch(() => { console.error('DevSpec Launcher failed. Check installation and current-user service permissions.'); process.exitCode = 1 })
}
