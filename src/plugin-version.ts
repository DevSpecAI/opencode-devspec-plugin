import { readFileSync } from 'node:fs'

/** Captured from this package at load, never the project cwd or a later checkout. */
function loadedVersion(): string | undefined {
  try {
    const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
    if (manifest.name !== 'opencode-devspec-plugin') return undefined
    if (typeof manifest.version !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._+\/-]{0,63}$/.test(manifest.version)) return undefined
    return manifest.version
  } catch { return undefined }
}

export const LOADED_PLUGIN_VERSION = loadedVersion()
let reportedHostVersion: string | undefined
let ambiguousHostVersion = false

/** Only a response from this host's authenticated SDK health endpoint is used. */
export function observeHostVersion(value: unknown): void {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._+\/-]{0,63}$/.test(value)) return
  if (reportedHostVersion && reportedHostVersion !== value) ambiguousHostVersion = true
  if (!ambiguousHostVersion) reportedHostVersion = value
}

export function connectionVersionArguments(args: Record<string, unknown>): Record<string, unknown> {
  const { plugin_version: _plugin, host_version: _host, ...rest } = args
  // No Node, PATH-binary, parent environment, or MCP-handshake guesses. A
  // pending/unavailable/ambiguous host probe leaves the optional value unknown.
  return {
    ...rest,
    ...(LOADED_PLUGIN_VERSION ? { plugin_version: LOADED_PLUGIN_VERSION,
      ...(!ambiguousHostVersion && reportedHostVersion ? { host_version: reportedHostVersion } : {}) } : {}),
  }
}
