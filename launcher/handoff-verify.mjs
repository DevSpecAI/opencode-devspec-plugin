/** Ed25519 request verification. The private key stays on DevSpec's server. */
import { createPublicKey, verify } from 'node:crypto'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
let cachedPublicKey
function loadPublicKey() {
  return cachedPublicKey ??= createPublicKey(fs.readFileSync(fileURLToPath(new URL('./handoff-public-key.pem', import.meta.url))))
}
import { FLEET_RECIPE_TOOLS } from './fleet-recipe.mjs'
const tools = new Set(FLEET_RECIPE_TOOLS)
const thinking = new Set(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'])
const bounded = (value, length) => typeof value === 'string' && value.length <= length && !value.includes('\0')

export function materializeHandoffData(data, now = Math.floor(Date.now() / 1000)) {
  if (!data || typeof data !== 'object' || Array.isArray(data) || !bounded(data.repo, 300) || !/^[\w.-]+\/[\w.-]+$/.test(data.repo)) return { ok: false, error: 'invalid_payload' }
  if (!Number.isSafeInteger(data.exp) || data.exp <= now || data.exp > now + 600) return { ok: false, error: 'expired' }
  if (data.recipientKey != null && (typeof data.recipientKey !== 'string' || !/^[a-f0-9]{64}$/.test(data.recipientKey))) return { ok: false, error: 'invalid_recipient' }
  if (data.requesterId != null && !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(data.requesterId)) return { ok: false, error: 'invalid_requester' }
  if (data.tool != null && !tools.has(data.tool)) return { ok: false, error: 'unsupported_tool' }
  if (data.surface != null && !['ide', 'cli'].includes(data.surface)) return { ok: false, error: 'invalid_surface' }
  for (const [name, limit] of [['prompt', 16000], ['title', 500], ['model', 200], ['resumeChatId', 200]]) {
    if (data[name] != null && (!bounded(data[name], limit) || (name !== 'prompt' && /[\u0000-\u001f\u007f]/.test(data[name])))) return { ok: false, error: 'invalid_payload' }
  }
  if ([data.model, data.resumeChatId].some(value => typeof value === 'string' && value.trim().startsWith('-'))) return { ok: false, error: 'invalid_payload' }
  // Until native resume is wired for a tool, refuse it instead of opening a
  // fresh conversation that looks like a successful resume.
  if (data.resumeChatId && (data.tool ?? 'cursor') !== 'cursor') return { ok: false, error: 'resume_not_supported' }
  if (data.thinking != null && !thinking.has(data.thinking)) return { ok: false, error: 'invalid_payload' }
  const sessionId = data.sessionId ?? data.session_id
  if (sessionId != null && (!bounded(sessionId, 36) || !/^[a-f0-9-]{8,36}$/i.test(sessionId))) return { ok: false, error: 'invalid_session' }
  let recipe
  if (data.recipe != null) {
    if (typeof data.recipe !== 'object' || Array.isArray(data.recipe)) return { ok: false, error: 'invalid_recipe' }
    recipe = {}; let total = 0
    for (const [tool, count] of Object.entries(data.recipe)) {
      if (!tools.has(tool) || !Number.isInteger(count) || count < 0 || count > 8) return { ok: false, error: 'invalid_recipe' }
      if (count) { recipe[tool] = count; total += count }
    }
    if (!total || total > 24 || data.resumeChatId) return { ok: false, error: 'invalid_recipe' }
  }
  return { ok: true, data: {
    repo: data.repo, exp: data.exp, requesterId: data.requesterId, recipientKey: data.recipientKey, tool: data.tool ?? 'cursor', surface: data.surface ?? 'ide',
    prompt: data.prompt ?? undefined, title: data.title ?? undefined, model: data.model ?? undefined,
    thinking: data.thinking ?? undefined, resumeChatId: data.resumeChatId ?? undefined,
    recipe, sessionId: sessionId ?? undefined,
  } }
}

/** Optional verification key is injected only by in-process tests, never request data. */
export function verifySignedData(token, { publicKey } = {}) {
  if (typeof token !== 'string' || !token) return { ok: false, error: 'missing_token' }
  if (token.length > 32768 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)) return { ok: false, error: 'malformed_token' }
  const [payload, signature] = token.split('.')
  try {
    const bytes = Buffer.from(payload, 'base64url'), sig = Buffer.from(signature, 'base64url')
    if (sig.length !== 64 || !verify(null, bytes, publicKey ?? loadPublicKey(), sig)) return { ok: false, error: 'bad_signature' }
    return { ok: true, data: JSON.parse(bytes.toString('utf8')) }
  } catch { return { ok: false, error: 'invalid_token' } }
}

export function verifyHandoffToken(token, options = {}) {
  const signed = verifySignedData(token, options)
  return signed.ok ? materializeHandoffData(signed.data, options.now) : signed
}
