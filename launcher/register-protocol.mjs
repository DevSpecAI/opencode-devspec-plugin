/** Compatibility helpers. OS mutation belongs only to the current installer;
 * never kill a process merely because a PID file or a port number names it.
 */
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
const execFileAsync = promisify(execFile)
export const DEVSPEC_SCHEME = 'x-scheme-handler/devspec'
export const DEVSPEC_DESKTOP_FILE = 'devspec-protocol.desktop'

export async function installProtocolHandler(_legacyHandlerPath) {
  const { ensureLauncherReady } = await import('./launcher.mjs')
  return ensureLauncherReady({ source: path.dirname(fileURLToPath(import.meta.url)) })
}
export async function uninstallLegacyBridge() {
  return { ok: false, error: 'use_owned_launcher_uninstall', reason: 'Use the launcher uninstall command; legacy PID files are not process ownership proof.' }
}
export async function stopLegacyBridgeServer() {
  return { ok: false, error: 'unverified_legacy_process', reason: 'A port number alone cannot authorize stopping another process.' }
}
export function isProtocolSupportedPlatform() { return process.platform === 'win32' || process.platform === 'linux' }
export async function queryLinuxSchemeOwner() {
  try { return (await execFileAsync('xdg-mime', ['query', 'default', DEVSPEC_SCHEME], { timeout: 10000 })).stdout.trim() || null }
  catch { return null }
}

/** Pure legacy formatting helpers retained for existing importers. */
export function quoteDesktopExecArg(value) { return `"${String(value).replace(/(["`$\\])/g, '\\$1')}"` }
export function linuxDesktopExecLine({ launcherPath, nodeBin, handlerPath }) {
  if (launcherPath) return `${quoteDesktopExecArg(launcherPath)} %u`
  return `${quoteDesktopExecArg(nodeBin)} ${quoteDesktopExecArg(handlerPath)} %u`
}
export function buildLinuxDesktopEntry(execLine) {
  return `[Desktop Entry]\nName=DevSpec Protocol Handler\nComment=Open DevSpec work in Cursor, OpenCode or Pi\nExec=${execLine}\nType=Application\nTerminal=false\nNoDisplay=true\nMimeType=x-scheme-handler/devspec;\n`
}

/** Change only the exact DevSpec scheme; preserve unrelated keys and comments. */
export function stripConflictingSchemeAssociations(contents, { scheme = DEVSPEC_SCHEME, desktopFile = DEVSPEC_DESKTOP_FILE } = {}) {
  const out = []; let section = null, changed = false
  for (const line of String(contents).split('\n')) {
    const heading = /^\s*\[(.+)\]\s*$/.exec(line)
    if (heading) { section = heading[1]; out.push(line); continue }
    const eq = line.indexOf('=')
    if (eq < 0 || line.trimStart().startsWith('#') || line.slice(0, eq).trim() !== scheme) { out.push(line); continue }
    const values = line.slice(eq + 1).split(';').map(value => value.trim()).filter(Boolean)
    if (section === 'Removed Associations') {
      const kept = values.filter(value => value !== desktopFile)
      if (kept.length === values.length) { out.push(line); continue }
      changed = true
      if (kept.length) out.push(`${scheme}=${kept.join(';')};`)
      continue
    }
    if (!['Default Applications', 'Added Associations'].includes(section)) { out.push(line); continue }
    const kept = values.filter(value => value === desktopFile)
    if (kept.length === values.length) { out.push(line); continue }
    changed = true
    if (kept.length) out.push(`${scheme}=${kept.join(';')};`)
  }
  return { contents: out.join('\n'), changed }
}
export function mimeappsCandidatePaths(env = process.env, homedir = os.homedir()) {
  const config = env.XDG_CONFIG_HOME || path.join(homedir, '.config')
  const data = env.XDG_DATA_HOME || path.join(homedir, '.local', 'share')
  const desktops = String(env.XDG_CURRENT_DESKTOP || '').split(':').map(value => value.trim().toLowerCase()).filter(value => /^[a-z0-9_-]+$/.test(value))
  return [...desktops.map(name => path.join(config, `${name}-mimeapps.list`)), path.join(config, 'mimeapps.list'), ...desktops.map(name => path.join(data, 'applications', `${name}-mimeapps.list`)), path.join(data, 'applications', 'mimeapps.list')]
}
