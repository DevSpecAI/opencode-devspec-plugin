/** An embedded host's process.execPath can be OpenCode, Bun or an editor, not
 * Node. Never launch that host as if it were a script interpreter (27b53001).
 */
import fs from 'node:fs'
import nativePath from 'node:path'
import os from 'node:os'
import { execFileSync } from 'node:child_process'

export function nodeRuntimeCandidates({ execPath = process.execPath, env = process.env, home = os.homedir(), platform = process.platform, versions = process.versions, list = dir => fs.readdirSync(dir) } = {}) {
  const path = platform === 'win32' ? nativePath.win32 : nativePath.posix
  const executable = platform === 'win32' ? 'node.exe' : 'node'
  const paths = []
  if (env.DEVSPEC_NODE) paths.push(env.DEVSPEC_NODE)
  if (!versions.bun && /^node(?:js)?(?:\.exe)?$/i.test(path.basename(execPath))) paths.push(execPath)
  for (const dir of String(env.PATH || '').split(platform === 'win32' ? ';' : ':').filter(Boolean)) paths.push(path.join(dir, executable))
  for (const [base, suffix] of [
    [path.join(home, '.nvm', 'versions', 'node'), ['bin', 'node']],
    [path.join(home, '.local', 'share', 'fnm', 'node-versions'), ['installation', 'bin', 'node']],
    [path.join(home, '.volta', 'tools', 'image', 'node'), ['bin', 'node']],
    [path.join(home, '.asdf', 'installs', 'nodejs'), ['bin', 'node']],
  ]) {
    try { for (const version of list(base).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))) paths.push(path.join(base, version, ...suffix)) } catch { /* manager not installed */ }
  }
  return [...new Set(paths)].filter(value => typeof value === 'string' && path.isAbsolute(value) && !/[\r\n\0]/.test(value))
}

/** Recognize npm's generated Windows shim and run its declared JS entry with
 * Node directly. This preserves argv and needs no PowerShell policy override.
 * Unknown/custom wrappers remain on the ordinary host path.
 */
export function npmNodeShimEntry(shim, { read = file => fs.readFileSync(file, 'utf8'), exists = fs.existsSync } = {}) {
  if (!/\.cmd$/i.test(shim)) return null
  try {
    const text = read(shim)
    if (text.length > 16_384 || !/SET\s+dp0=%~dp0/i.test(text)) return null
    const match = /"%_prog%"\s+"%dp0%[\\/]([^"\r\n]+\.[cm]?js)"\s+%\*/i.exec(text)
    if (!match || /[%\x00]/.test(match[1])) return null
    const base = nativePath.win32.dirname(shim)
    const entry = nativePath.win32.resolve(base, match[1])
    const relative = nativePath.win32.relative(base, entry)
    if (!relative || relative.startsWith('..') || nativePath.win32.isAbsolute(relative) || !exists(entry)) return null
    return entry
  } catch { return null }
}

export function resolveNodeRuntime(options = {}) {
  const run = options.run ?? ((exe, args) => execFileSync(exe, args, { encoding: 'utf8', timeout: 2000, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1024 }))
  const exists = options.exists ?? (file => { try { fs.accessSync(file, process.platform === 'win32' ? fs.constants.F_OK : fs.constants.X_OK); return fs.statSync(file).isFile() } catch { return false } })
  for (const candidate of nodeRuntimeCandidates(options)) {
    if (!exists(candidate)) continue
    try {
      const output = run(candidate, ['-p', "!process.versions.bun && process.release.name === 'node' ? process.versions.node : ''"]).trim()
      const version = /^(\d+)\.\d+\.\d+$/.exec(output)
      if (version && Number(version[1]) >= 20) return candidate
    } catch { /* wrong runtime, old Node, policy denial or dead installation */ }
  }
  throw new Error('Node.js 20 or newer is required for local launching.')
}
