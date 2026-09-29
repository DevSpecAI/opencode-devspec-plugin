/** Per-user OS integration. No shell interpolation, elevation or policy bypass.
 * Keep command planning pure so every platform can exercise its exact artifact
 * contract on CI; a generated artifact is NOT proof of live platform support.
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { execFileSync } from 'node:child_process'
import { atomicWrite } from './payload.mjs'
import { mimeappsCandidatePaths, stripConflictingSchemeAssociations } from './register-protocol.mjs'

export const SERVICE = 'devspec-launcher'
export const MAC_LABEL = 'ai.devspec.launcher'
export const WINDOWS_TASK = 'DevSpec Launcher'
export const DESKTOP = 'devspec-protocol.desktop'
const scheme = 'x-scheme-handler/devspec'

function safe(value) {
  if (typeof value !== 'string' || !value || /[\u0000-\u001f\u007f]/.test(value)) throw new Error('Invalid integration path or identity')
  return value
}
export const xml = value => safe(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c])
export const systemdArg = value => `"${safe(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/%/g, '%%').replace(/\$/g, () => '$$')}"`
export const desktopArg = value => `"${safe(value).replace(/(["`$\\])/g, '\\$1').replace(/%/g, '%%')}"`
/** Windows CreateProcess argv quoting, not cmd.exe shell quoting. */
export const windowsArg = value => `"${safe(value).replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, '$1$1')}"`

export function integrationPlan({ platform = process.platform, userHome = os.homedir(), home, entry, node = process.execPath, uid = process.getuid?.(), sid, env = process.env }) {
  for (const value of [userHome, home, entry, node]) safe(value)
  const argv = [entry, 'serve', '--home', home]
  const files = []
  const register = []
  let probe, start, restart, stop, schemeProbe = null, expectedScheme = null
  if (platform === 'linux') {
    const config = env.XDG_CONFIG_HOME || path.join(userHome, '.config')
    const data = env.XDG_DATA_HOME || path.join(userHome, '.local', 'share')
    const unit = path.join(config, 'systemd', 'user', `${SERVICE}.service`)
    files.push({ path: unit, body: `[Unit]\nDescription=DevSpec Launcher\nStartLimitIntervalSec=60\nStartLimitBurst=5\n\n[Service]\nType=simple\nExecStart=${[node, ...argv].map(systemdArg).join(' ')}\nRestart=on-failure\nRestartSec=3\nUMask=0077\n\n[Install]\nWantedBy=default.target\n` })
    const desktop = path.join(data, 'applications', DESKTOP)
    files.push({ path: desktop, body: `[Desktop Entry]\nName=DevSpec Launcher\nType=Application\nNoDisplay=true\nTerminal=false\nExec=${[node, entry, 'open', '--home', home].map(desktopArg).join(' ')} %u\nMimeType=${scheme};\n` })
    register.push(['systemctl', ['--user', 'daemon-reload']], ['systemctl', ['--user', 'enable', `${SERVICE}.service`]], ['xdg-mime', ['default', DESKTOP, scheme]])
    probe = ['systemctl', ['--user', 'is-enabled', `${SERVICE}.service`]]
    schemeProbe = ['xdg-mime', ['query', 'default', scheme]]
    expectedScheme = DESKTOP
    start = ['systemctl', ['--user', 'start', `${SERVICE}.service`]]
    restart = ['systemctl', ['--user', 'restart', `${SERVICE}.service`]]
    stop = ['systemctl', ['--user', 'disable', '--now', `${SERVICE}.service`]]
  } else if (platform === 'darwin') {
    if (!Number.isSafeInteger(uid) || uid < 0) throw new Error('Cannot resolve current macOS user')
    const plist = path.join(userHome, 'Library', 'LaunchAgents', `${MAC_LABEL}.plist`)
    files.push({ path: plist, body: `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>\n<key>Label</key><string>${MAC_LABEL}</string>\n<key>ProgramArguments</key><array>${[node, ...argv].map(v => `<string>${xml(v)}</string>`).join('')}</array>\n<key>RunAtLoad</key><true/>\n<key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>\n<key>ThrottleInterval</key><integer>10</integer>\n<key>ProcessType</key><string>Background</string>\n</dict></plist>\n` })
    register.push(['launchctl', ['bootstrap', `gui/${uid}`, plist]])
    probe = ['launchctl', ['print', `gui/${uid}/${MAC_LABEL}`]]
    start = ['launchctl', ['kickstart', `gui/${uid}/${MAC_LABEL}`]]
    restart = ['launchctl', ['kickstart', '-k', `gui/${uid}/${MAC_LABEL}`]]
    stop = ['launchctl', ['bootout', `gui/${uid}/${MAC_LABEL}`]]
  } else if (platform === 'win32') {
    if (!/^S-1-[\d-]+$/.test(sid || '')) throw new Error('Cannot resolve current Windows user SID')
    const task = path.join(home, 'service-task.xml')
    files.push({ path: task, body: `<?xml version="1.0" encoding="UTF-16"?>\n<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task"><Triggers><LogonTrigger><Enabled>true</Enabled><UserId>${xml(sid)}</UserId></LogonTrigger></Triggers><Principals><Principal id="User"><UserId>${xml(sid)}</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals><Settings><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy><DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries><StopIfGoingOnBatteries>false</StopIfGoingOnBatteries><StartWhenAvailable>true</StartWhenAvailable><AllowStartOnDemand>true</AllowStartOnDemand><Enabled>true</Enabled><Hidden>true</Hidden><ExecutionTimeLimit>PT0S</ExecutionTimeLimit><RestartOnFailure><Interval>PT1M</Interval><Count>3</Count></RestartOnFailure></Settings><Actions Context="User"><Exec><Command>${xml(node)}</Command><Arguments>${xml(argv.map(windowsArg).join(' '))}</Arguments></Exec></Actions></Task>\n`, encoding: 'utf16le' })
    register.push(['schtasks.exe', ['/Create', '/TN', WINDOWS_TASK, '/XML', task, '/F']])
    const command = [node, entry, 'open', '--home', home].map(windowsArg).join(' ') + ' "%1"'
    const root = 'HKCU\\Software\\Classes\\devspec'
    register.push(['reg.exe', ['add', root, '/ve', '/d', 'URL:DevSpec Protocol', '/f']], ['reg.exe', ['add', root, '/v', 'URL Protocol', '/d', '', '/f']], ['reg.exe', ['add', `${root}\\shell\\open\\command`, '/ve', '/d', command, '/f']])
    probe = ['schtasks.exe', ['/Query', '/TN', WINDOWS_TASK]]
    schemeProbe = ['reg.exe', ['query', `${root}\\shell\\open\\command`, '/ve']]
    expectedScheme = command
    start = ['schtasks.exe', ['/Run', '/TN', WINDOWS_TASK]]
    restart = start
    stop = ['schtasks.exe', ['/End', '/TN', WINDOWS_TASK]]
  } else throw new Error(`Unsupported launcher platform: ${platform}`)
  return { platform, files, register, probe, start, restart, stop, schemeProbe, expectedScheme,
    associationFiles: platform === 'linux' ? mimeappsCandidatePaths(env, userHome) : [],
    desktopDirectory: platform === 'linux' ? path.dirname(files[1].path) : null,
  }
}

/** Remove only artifacts that still match our generated integration. User data
 * and release history are deliberately retained for a later explicit reinstall. */
export function removeIntegration(plan, { run = runIntegrationCommand } = {}) {
  // Do not silently delete modified files or claim a complete uninstall while
  // leaving them behind. Inspect ownership before stopping the named service.
  for (const file of plan.files) {
    try {
      writableOwnedFile(file.path)
      if (!fs.readFileSync(file.path).equals(bytesFor(file))) throw new Error('Launcher integration was modified; repair it before uninstalling.')
    } catch (error) { if (error.code !== 'ENOENT') throw error }
  }
  run(plan.stop)
  if (plan.platform === 'win32') {
    run(['schtasks.exe', ['/Delete', '/TN', WINDOWS_TASK, '/F']])
    const registration = run(plan.schemeProbe)
    if (registration.split(/\r?\n/).some(line => line.split(/REG_SZ\s+/)[1]?.trim() === plan.expectedScheme)) {
      run(['reg.exe', ['delete', 'HKCU\\Software\\Classes\\devspec', '/f']])
    }
  }
  for (const file of plan.files) {
    try {
      if (fs.readFileSync(file.path).equals(bytesFor(file))) fs.unlinkSync(file.path)
    } catch (error) { if (error.code !== 'ENOENT') throw error }
  }
  if (plan.platform === 'linux') run(['systemctl', ['--user', 'daemon-reload']])
  return { removed: true }
}

export function runIntegrationCommand([command, args]) {
  return execFileSync(command, args, { encoding: 'utf8', timeout: 10_000, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 128 * 1024 })
}
export function windowsUserSid(run = runIntegrationCommand) {
  const result = run(['whoami.exe', ['/user', '/fo', 'csv', '/nh']])
  const sid = result.match(/\bS-1-[\d-]+\b/)?.[0]
  if (!sid) throw new Error('Cannot resolve current Windows user SID')
  return sid
}

function bytesFor(file) {
  return Buffer.from(file.encoding === 'utf16le' ? `\uFEFF${file.body}` : file.body, file.encoding || 'utf8')
}
function writableOwnedFile(file) {
  const stat = fs.lstatSync(file)
  if (!stat.isFile() || !(stat.mode & 0o200) || (process.getuid && stat.uid !== process.getuid())) throw new Error('Launcher configuration is protected or not owned by this user')
  return stat
}
function repairLinuxAssociations(plan) {
  for (const file of plan.associationFiles) {
    let target, original
    try { target = fs.realpathSync(file); original = fs.readFileSync(target, 'utf8') }
    catch (error) { if (error.code === 'ENOENT') continue; throw error }
    const repaired = stripConflictingSchemeAssociations(original)
    if (!repaired.changed) continue
    const stat = writableOwnedFile(target)
    atomicWrite(target, repaired.contents)
    fs.chmodSync(target, stat.mode & 0o777)
  }
}
function refreshLinuxDesktop(plan, run) {
  try { run(['update-desktop-database', [plan.desktopDirectory]]) } catch { /* optional desktop utility */ }
  for (const command of ['kbuildsycoca6', 'kbuildsycoca5']) {
    try { run([command, ['--noincremental']]); break } catch { /* optional KDE cache */ }
  }
}

/** No home mutations outside the explicit per-user registration plan. */
export function configureIntegration(plan, { run = runIntegrationCommand, ready = false } = {}) {
  let changed = false
  for (const file of plan.files) {
    const bytes = bytesFor(file)
    let current = null
    try {
      const stat = fs.lstatSync(file.path)
      if (!stat.isFile() || (process.getuid && stat.uid !== process.getuid() && stat.uid !== 0)) throw new Error('Launcher integration is not a trusted regular file')
      current = fs.readFileSync(file.path)
    } catch (error) { if (error.code !== 'ENOENT') throw error }
    if (!current?.equals(bytes)) {
      if (current !== null) writableOwnedFile(file.path)
      fs.mkdirSync(path.dirname(file.path), { recursive: true, mode: 0o700 })
      atomicWrite(file.path, bytes)
      changed = true
    }
  }
  let registered = false
  try { run(plan.probe); registered = true } catch { /* absent or policy denied: registration below returns the real failure */ }
  if (plan.platform === 'darwin' && changed && registered) {
    run(plan.stop)
    registered = false
  }
  let schemeReady = !plan.schemeProbe
  if (plan.schemeProbe) {
    try {
      const output = run(plan.schemeProbe)
      schemeReady = plan.platform === 'win32'
        ? output.split(/\r?\n/).some(line => line.split(/REG_SZ\s+/)[1]?.trim() === plan.expectedScheme)
        : output.trim() === plan.expectedScheme
    } catch { /* repair known registration without guessing from a payload marker */ }
  }
  if (changed || !registered || !schemeReady) {
    if (plan.platform === 'linux' && !schemeReady) repairLinuxAssociations(plan)
    for (const command of plan.register) run(command)
    if (plan.platform === 'linux') refreshLinuxDesktop(plan, run)
  }
  if (plan.schemeProbe) {
    const output = run(plan.schemeProbe)
    const verified = plan.platform === 'win32'
      ? output.split(/\r?\n/).some(line => line.split(/REG_SZ\s+/)[1]?.trim() === plan.expectedScheme)
      : output.trim() === plan.expectedScheme
    if (!verified) throw new Error('The operating system did not accept DevSpec launcher registration.')
  }
  if (!ready || changed || !registered) {
    if (plan.platform === 'win32' && registered && !ready) {
      try { run(plan.stop) } catch { /* scheduled task may not be running */ }
    }
    run(registered ? plan.restart : plan.start)
  }
  // Only reports configuration, never claims the listener answered or an agent launched.
  return { configured: true, changed }
}
