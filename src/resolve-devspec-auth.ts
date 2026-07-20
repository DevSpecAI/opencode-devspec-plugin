/**
 * Resolve DevSpec MCP URL + Bearer token for this plugin's remote-control
 * hook, using OpenCode's own config shape (opencode.json) rather than
 * Claude Code's `.mcp.json` / `~/.claude.json` — everything else about this
 * resolver (env-var priority, never printing the raw token) mirrors
 * claude-code-devspec-autopilot's `resolve-mcp-auth.mjs`.
 *
 * Lookup order:
 * 1. DEVSPEC_MCP_TOKEN / DEVSPEC_TOKEN (+ DEVSPEC_MCP_URL)
 * 2. Project opencode.json (the `directory` OpenCode handed the plugin, and parents)
 * 3. Global opencode.json (~/.config/opencode/opencode.json)
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const DEFAULT_PROD_URL = 'https://devspec.ai/api/mcp'

export interface DevspecAuth {
  ok: boolean
  token?: string
  mcp_url?: string
  source?: string
  error?: string
}

function readJson(file: string): any {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

function extractBearer(headers: unknown): string | null {
  if (!headers || typeof headers !== 'object') return null
  const h = headers as Record<string, unknown>
  const auth = h.Authorization ?? h.authorization
  if (typeof auth !== 'string') return null
  const m = auth.match(/^Bearer\s+(.+)$/i)
  return m ? m[1]!.trim() : auth.trim() || null
}

function fromServerEntry(entry: any): { mcp_url: string; token: string | null } | null {
  if (!entry || typeof entry !== 'object') return null
  const url = entry.url || entry.serverUrl || null
  const token = extractBearer(entry.headers) || entry.token || null
  if (!url && !token) return null
  return { mcp_url: url || DEFAULT_PROD_URL, token: token || null }
}

/** OpenCode's config nests the DevSpec server under `mcp.devspec` — see the README. */
function fromOpencodeConfig(file: string): (ReturnType<typeof fromServerEntry> & { source: string }) | null {
  const j = readJson(file)
  if (!j) return null
  const servers = j.mcp || {}
  const entry = servers.devspec || servers.DevSpec
  const got = fromServerEntry(entry)
  if (!got) return null
  return { ...got, source: file }
}

function walkOpencodeJson(startDir: string) {
  let dir = path.resolve(startDir || process.cwd())
  for (let i = 0; i < 12; i++) {
    const file = path.join(dir, 'opencode.json')
    if (fs.existsSync(file)) {
      const got = fromOpencodeConfig(file)
      if (got?.token || got?.mcp_url) return got
    }
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return null
}

function fromGlobalConfig() {
  const file = path.join(os.homedir(), '.config', 'opencode', 'opencode.json')
  return fromOpencodeConfig(file)
}

export function resolveDevspecAuth(cwd: string = process.cwd()): DevspecAuth {
  const envToken = process.env.DEVSPEC_MCP_TOKEN || process.env.DEVSPEC_TOKEN || null
  const envUrl = process.env.DEVSPEC_MCP_URL || null
  if (envToken) {
    return { ok: true, token: envToken, mcp_url: envUrl || DEFAULT_PROD_URL, source: 'env' }
  }

  const fromProject = walkOpencodeJson(cwd)
  if (fromProject?.token) {
    return { ok: true, token: fromProject.token, mcp_url: envUrl || fromProject.mcp_url || DEFAULT_PROD_URL, source: fromProject.source }
  }

  const fromGlobal = fromGlobalConfig()
  if (fromGlobal?.token) {
    return { ok: true, token: fromGlobal.token, mcp_url: envUrl || fromGlobal.mcp_url || DEFAULT_PROD_URL, source: fromGlobal.source }
  }

  if (fromProject?.mcp_url) {
    return {
      ok: false,
      mcp_url: envUrl || fromProject.mcp_url,
      source: fromProject.source,
      error:
        'Found a DevSpec MCP URL in opencode.json but no Bearer token. Set DEVSPEC_MCP_TOKEN or add mcp.devspec.headers.Authorization.',
    }
  }

  return {
    ok: false,
    mcp_url: envUrl || DEFAULT_PROD_URL,
    error: 'No DevSpec MCP token found. Set DEVSPEC_MCP_TOKEN, or configure mcp.devspec.headers.Authorization in opencode.json.',
  }
}
