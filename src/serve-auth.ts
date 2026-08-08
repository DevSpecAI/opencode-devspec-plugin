import { randomBytes } from 'node:crypto'

/** Default OpenCode serve basic-auth username (OpenCode docs). */
export const OPENCODE_SERVER_USERNAME_DEFAULT = 'opencode'

export type ServeAuth = {
  password: string
  username: string
  source: 'env' | 'minted'
}

/**
 * Resolve the local OpenCode HTTP basic-auth password for this process.
 *
 * Prefer a non-empty `OPENCODE_SERVER_PASSWORD` already in the environment
 * (power users / rocket launchers). Otherwise mint a strong one-time secret
 * for this process only. Never upload this to DevSpec — it only locks the
 * laptop-local HTTP door OpenCode opens for TUI ↔ server.
 *
 * Same rule as cursor-devspec-plugin `launch-opencode-session.mjs` rocket path.
 */
export function resolveServeAuth(env: NodeJS.ProcessEnv = process.env): ServeAuth {
  const usernameRaw = String(env.OPENCODE_SERVER_USERNAME || '').trim()
  const username = usernameRaw || OPENCODE_SERVER_USERNAME_DEFAULT
  const existing = String(env.OPENCODE_SERVER_PASSWORD || '').trim()
  if (existing) {
    return { password: existing, username, source: 'env' }
  }
  return {
    password: randomBytes(32).toString('base64url'),
    username,
    source: 'minted',
  }
}

/**
 * Ensure `process.env` (or a provided env bag) carries serve auth.
 * Mutates the bag in place so OpenCode's embedded server sees the password
 * when it reads env. Idempotent: a second call reuses the already-set value.
 */
export function ensureServeAuthEnv(env: NodeJS.ProcessEnv = process.env): ServeAuth {
  const auth = resolveServeAuth(env)
  env.OPENCODE_SERVER_USERNAME = auth.username
  env.OPENCODE_SERVER_PASSWORD = auth.password
  return auth
}

/**
 * Best-effort: attach Basic auth to the OpenCode plugin SDK client.
 *
 * Older OpenCode builds constructed the plugin `client` without Authorization
 * when OPENCODE_SERVER_PASSWORD was set (anomalyco/opencode#9706). Newer builds
 * inject it themselves; this is a no-op / defensive patch so remote-control
 * SDK calls keep working after we mint.
 */
export function applyServeAuthToPluginClient(
  client: unknown,
  auth: Pick<ServeAuth, 'username' | 'password'>,
): boolean {
  if (!client || typeof client !== 'object') return false
  const header = `Basic ${Buffer.from(`${auth.username}:${auth.password}`, 'utf8').toString('base64')}`

  // Prefer a public fetch wrapper if present; else reach the generated client's
  // request interceptor (shape varies across @opencode-ai/sdk versions).
  const anyClient = client as {
    _client?: {
      interceptors?: {
        request?: { use?: (fn: (req: { headers?: Record<string, string> }) => unknown) => void }
      }
      setConfig?: (cfg: { headers?: Record<string, string> }) => void
    }
  }
  const inner = anyClient._client
  if (inner?.interceptors?.request?.use) {
    inner.interceptors.request.use((req) => {
      const headers = req.headers ?? {}
      if (!headers.Authorization && !headers.authorization) {
        headers.Authorization = header
        req.headers = headers
      }
      return req
    })
    return true
  }
  if (typeof inner?.setConfig === 'function') {
    inner.setConfig({ headers: { Authorization: header } })
    return true
  }
  return false
}
