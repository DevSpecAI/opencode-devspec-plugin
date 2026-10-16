import { readFileSync } from 'node:fs'
import { PLUGIN_ID } from './agent-identity.js'

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

/**
 * DevSpec tells plugins apart by `x-devspec-plugin: <id>/<version>` on every MCP
 * request (ADR "Protecting intent" §14; contract on DevSpec item 2295e089). It
 * identifies the plugin and unlocks nothing. The version is this package's own
 * manifest, read once at load, so the header can never name a release other than
 * the one running (item ae865d3e). An unreadable manifest sends no header rather
 * than a malformed one.
 */
export const PLUGIN_HEADER = 'x-devspec-plugin'

export function pluginHeaderValue(version: string | null | undefined = LOADED_PLUGIN_VERSION): string | undefined {
  if (typeof version !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/.test(version)) return undefined
  return `${PLUGIN_ID}/${version}`
}

export function pluginHeaders(version: string | null | undefined = LOADED_PLUGIN_VERSION): Record<string, string> {
  const value = pluginHeaderValue(version)
  return value ? { [PLUGIN_HEADER]: value } : {}
}

/** The `mcp` entries this plugin treats as DevSpec; resolve-devspec-auth.ts reads the same two. */
const DEVSPEC_MCP_KEYS = ['devspec', 'DevSpec'] as const

/**
 * OpenCode's own MCP client sends whatever headers its `mcp.devspec` entry holds,
 * and the plugin `config` hook is handed that live config before any MCP server
 * connects (measured on OpenCode 1.18.23: headers added here arrive on initialize,
 * tools/list and every tools/call). So the header is added at load from the running
 * package, never typed into a user's opencode.json where a later update would
 * leave it naming an old version. Only a remote entry carries HTTP headers; a
 * header already there is replaced, because only the running package knows its
 * version. Returns the entry names it stamped.
 */
export function identifyDevspecMcpServers(
  cfg: { mcp?: Record<string, unknown> },
  version: string | null | undefined = LOADED_PLUGIN_VERSION,
): string[] {
  const headers = pluginHeaders(version)
  if (!Object.keys(headers).length || !cfg.mcp || typeof cfg.mcp !== 'object') return []
  const stamped: string[] = []
  for (const key of DEVSPEC_MCP_KEYS) {
    const entry = cfg.mcp[key] as { type?: unknown; headers?: unknown } | undefined
    if (!entry || typeof entry !== 'object' || entry.type !== 'remote') continue
    const existing = entry.headers && typeof entry.headers === 'object' ? (entry.headers as Record<string, string>) : {}
    const kept = Object.fromEntries(Object.entries(existing).filter(([name]) => name.toLowerCase() !== PLUGIN_HEADER))
    entry.headers = { ...kept, ...headers }
    stamped.push(key)
  }
  return stamped
}
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
