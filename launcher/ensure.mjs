/** Legacy import compatibility. There is only one installation implementation;
 * a flat file copy or a version marker is never a readiness result.
 */
import fs from 'node:fs'
import path from 'node:path'
import { launcherHome } from './paths.mjs'
export const LAUNCHER_HOME = launcherHome()
export const VERSION_MARKER = '.launcher-version'

/** Legacy metadata helper; not an integrity or readiness check. */
export function compareVersions(a, b) {
  const parse = value => String(value ?? '').trim().split('.').map(part => {
    const number = Number.parseInt(part, 10)
    return Number.isFinite(number) ? number : -1
  })
  const left = parse(a), right = parse(b)
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const difference = (left[i] ?? 0) - (right[i] ?? 0)
    if (difference) return difference
  }
  return 0
}
export function readInstalledVersion(home = LAUNCHER_HOME, io = fs) {
  try {
    const value = JSON.parse(io.readFileSync(path.join(home, VERSION_MARKER), 'utf8'))
    return typeof value?.version === 'string' ? value.version.trim() || null : null
  } catch { return null }
}

/** @deprecated Await this compatibility entry or use ensureLauncherReady directly.
 * The manifest, not the caller's version argument, determines what is installed.
 */
export async function ensureLauncherInstalled({ sourceDir, home = LAUNCHER_HOME } = {}) {
  if (!sourceDir) return { ok: false, outcome: 'failed', reason: 'sourceDir is required' }
  const { ensureLauncherReady } = await import('./launcher.mjs')
  return ensureLauncherReady({ source: sourceDir, home })
}
