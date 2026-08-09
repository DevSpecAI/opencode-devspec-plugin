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
 * 1. Project opencode config (the `directory` OpenCode handed the plugin, and
 *    parents) — opencode.jsonc / opencode.json / config.json, probed in reverse
 *    of OpenCode's own load order so the same file wins on conflict.
 * 2. Global opencode config (~/.config/opencode/) — same filenames.
 * 3. DEVSPEC_MCP_TOKEN / DEVSPEC_TOKEN env — fallback ONLY when no config-file
 *    token is configured (env-only setups). `DEVSPEC_MCP_URL` still overrides
 *    the resolved URL in every branch.
 *
 * Files are parsed as JSONC (comments + trailing commas tolerated) — OpenCode
 * documents .jsonc, and strict JSON.parse here once killed remote control
 * silently on a .jsonc-only machine (item 8e0bb031).
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

/**
 * OpenCode reads its config as JSONC — `opencode.jsonc` is the documented
 * recommendation — so this resolver must too. `JSON.parse` alone throws on
 * `//` comments and trailing commas, and readJson swallows that to null,
 * which upstream turns into the SILENT "not connected" idle path (live
 * incident 2026-08-08: global config was opencode.jsonc only, resolver found
 * no token, the connection never polled once).
 *
 * String-aware state machine — a naive regex strip would eat the `//` in
 * `"url": "https://..."` values. Also drops trailing commas (`,}` / `,]`),
 * which strict JSON rejects.
 */
function jsoncToJson(text: string): string {
  let out = ''
  let inString = false
  const n = text.length
  let i = 0
  while (i < n) {
    const c = text[i]!
    if (inString) {
      out += c
      if (c === '\\' && i + 1 < n) {
        out += text[i + 1]
        i += 2
        continue
      }
      if (c === '"') inString = false
      i++
      continue
    }
    if (c === '"') {
      inString = true
      out += c
      i++
      continue
    }
    if (c === '/' && text[i + 1] === '/') {
      while (i < n && text[i] !== '\n') i++
      continue
    }
    if (c === '/' && text[i + 1] === '*') {
      i += 2
      while (i < n && !(text[i] === '*' && text[i + 1] === '/')) i++
      i = Math.min(i + 2, n)
      continue
    }
    if (c === ',') {
      let j = i + 1
      while (j < n && /\s/.test(text[j]!)) j++
      if (text[j] === '}' || text[j] === ']') {
        i++ // trailing comma — drop it
        continue
      }
    }
    out += c
    i++
  }
  return out
}

export interface DevspecAuth {
  ok: boolean
  token?: string
  mcp_url?: string
  source?: string
  error?: string
}

function readJson(file: string): any {
  try {
    return JSON.parse(jsoncToJson(fs.readFileSync(file, 'utf8')))
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

/**
 * Config filenames OpenCode itself loads, in its load order (config.json →
 * opencode.json → opencode.jsonc — later deep-merges OVER earlier). A
 * first-hit resolver must therefore probe in REVERSE order so that on
 * conflict the same file wins that OpenCode's own MCP client would use.
 */
const CONFIG_FILENAMES = ['opencode.jsonc', 'opencode.json', 'config.json'] as const

function walkOpencodeJson(startDir: string) {
  let dir = path.resolve(startDir || process.cwd())
  for (let i = 0; i < 12; i++) {
    for (const name of CONFIG_FILENAMES) {
      const file = path.join(dir, name)
      if (fs.existsSync(file)) {
        const got = fromOpencodeConfig(file)
        if (got?.token || got?.mcp_url) return got
      }
    }
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return null
}

function fromGlobalConfig() {
  const dir = path.join(os.homedir(), '.config', 'opencode')
  for (const name of CONFIG_FILENAMES) {
    const got = fromOpencodeConfig(path.join(dir, name))
    if (got) return got
  }
  return null
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
        'Found a DevSpec MCP URL in opencode config but no Bearer token. Set DEVSPEC_MCP_TOKEN or add mcp.devspec.headers.Authorization.',
    }
  }

  return {
    ok: false,
    mcp_url: envUrl || DEFAULT_PROD_URL,
    error: 'No DevSpec MCP token found. Set DEVSPEC_MCP_TOKEN, or configure mcp.devspec.headers.Authorization in opencode.json / opencode.jsonc.',
  }
}
