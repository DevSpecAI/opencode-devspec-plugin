/** One execution per signed intent, shared by HTTP and the OS-scheme fallback. */
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { atomicWrite } from './payload.mjs'
import { isLaunchOwner } from './account-bindings.mjs'
import { verifyHandoffToken } from './handoff-verify.mjs'

export async function executeLaunchOnce({ home, token, publicKey, execute, rootKey, verify = value => verifyHandoffToken(value, { publicKey: rootKey }) }) {
  const checked = verify(token)
  if (!checked.ok) return { status: 403, result: { ok: false, error: 'invalid_or_expired_request' } }
  const data = checked.data
  if (data.recipientKey !== createHash('sha256').update(publicKey).digest('hex')) return { status: 403, result: { ok: false, error: 'wrong_installation' } }
  if (!isLaunchOwner(home, data.requesterId, rootKey)) return { status: 403, result: { ok: false, error: 'account_not_paired' } }
  const requestId = createHash('sha256').update(token).digest('hex')
  const dir = path.join(home, 'requests')
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  const file = path.join(dir, `${requestId}.json`)
  const pending = { status: 202, result: { ok: true, status: 'accepted', requestId } }
  try { fs.writeFileSync(file, JSON.stringify({ ...pending, exp: data.exp }), { flag: 'wx', mode: 0o600 }) }
  catch (error) {
    if (error.code !== 'EEXIST') throw error
    try {
      const prior = JSON.parse(fs.readFileSync(file, 'utf8'))
      return { status: prior.status, result: prior.result }
    } catch { return { status: 409, result: { ok: false, error: 'prior_request_outcome_unknown', requestId } } }
  }
  let receipt
  try {
    const outcome = await execute({ requesterId: data.requesterId, slug: data.repo, promptText: data.prompt ?? null, itemTitle: data.title ?? null,
      surface: data.surface ?? 'cli', tool: data.tool ?? 'cursor', model: data.model ?? null, thinking: data.thinking ?? null,
      resumeChatId: data.resumeChatId ?? null, recipe: data.recipe ?? null, sessionId: data.sessionId ?? null,
      requireSignedToken: true, unsigned: false })
    receipt = outcome.ok
      ? { status: 200, result: { ok: true, status: 'launch_requested', requestId, ...(outcome.failures?.length ? { partial: true } : {}) } }
      : { status: 422, result: { ok: false, error: /^[a-z_]+$/.test(outcome.error ?? '') ? outcome.error : 'launch_failed', requestId } }
  } catch { receipt = { status: 500, result: { ok: false, error: 'launch_failed', requestId } } }
  atomicWrite(file, JSON.stringify({ ...receipt, exp: data.exp }))
  return receipt
}
