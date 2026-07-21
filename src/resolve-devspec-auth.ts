/**
 * Resolve DevSpec MCP URL + Bearer token for this plugin's remote-control
 * poller/heartbeat, using OpenCode's own config shape (opencode.json) rather
 * than Claude Code's `.mcp.json` / `~/.claude.json`. Never prints the raw token.
 *
 * TOKEN SYMMETRY (mirrors the Claude poller's item 74b29c76). The connection is
 * REGISTERED through OpenCode's own MCP client, which authenticates the `devspec`
 * server with the `mcp.devspec` token in opencode.json — OpenCode's MCP client
 * does NOT read `DEVSPEC_MCP_TOKEN`. This poller/heartbeat path MUST run under
 * that SAME token, or the server rejects it ("this connection belongs to a
 * different token") and dispatch/heartbeat delivery spams. So the opencode.json
 * token wins over the env token here — the opposite of the usual "env overrides"
 * convention, precisely because the env token can never be the one that
 * registered the connection.
 *
 * Lookup order (token):
 * 1. Project opencode.json (the `directory` OpenCode handed the plugin, and parents)
 * 2. Global opencode.json (~/.config/opencode/opencode.json)
 * 3. DEVSPEC_MCP_TOKEN / DEVSPEC_TOKEN env — fallback ONLY when no opencode.json
 *    token is configured (env-only setups). `DEVSPEC_MCP_URL` still overrides the
 *    resolved URL in every branch.
 *
 * Backward compatible: when only one token source is present the result is
 * unchanged; only the both-present-and-different case flips — and it now resolves
 * to the token that actually registered the connection.
 *
 * NOTE: this resolver feeds ONLY the in-process remote-control machinery
 * (register / heartbeat / poll / mirror in remote-control.ts). It is not the
 * auth path for OpenCode's own MCP tool calls, so re-prioritising it here keeps
 * register + poller symmetric without affecting anything else.
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

  // Token symmetry: the opencode.json `mcp.devspec` token (project, then global)
  // is the token OpenCode's MCP client used to REGISTER the connection, so the
  // poller/heartbeat must run under it. It therefore takes priority over the env
  // token — see the file header for why the usual env-override order is inverted.
  const fromProject = walkOpencodeJson(cwd)
  if (fromProject?.token) {
    return { ok: true, token: fromProject.token, mcp_url: envUrl || fromProject.mcp_url || DEFAULT_PROD_URL, source: fromProject.source }
  }

  const fromGlobal = fromGlobalConfig()
  if (fromGlobal?.token) {
    return { ok: true, token: fromGlobal.token, mcp_url: envUrl || fromGlobal.mcp_url || DEFAULT_PROD_URL, source: fromGlobal.source }
  }

  // Env token — fallback ONLY when no opencode.json token is configured. In that
  // setup it is the sole token source, so behavior is unchanged (backward compat).
  if (envToken) {
    return { ok: true, token: envToken, mcp_url: envUrl || DEFAULT_PROD_URL, source: 'env' }
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
