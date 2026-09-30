/** Account-bound, encrypted loopback execution. CORS is not authentication. */
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { installationId, pairedCertificates } from './account-bindings.mjs'
import { deviceIdentity, signHealth } from './device-identity.mjs'
import { openSealedRequest } from './sealed-request.mjs'
import { executeLaunchOnce } from './launch-receipt.mjs'
export const LAUNCHER_PORT = 42731
export const MAX_TOKEN_BYTES = 32768
const MAX_REQUEST_BYTES = 65536
const APP_ORIGINS = new Set(['https://app.devspec.ai', 'https://app.devspecstaging.com', 'https://devspec.ai', 'https://devspecstaging.com', 'https://staging.devspec.ai'])
export function isLauncherOrigin(value) {
  if (APP_ORIGINS.has(value)) return true
  try { const url = new URL(value); return url.origin === value && url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname) } catch { return false }
}
export function createLauncherServer({ home, version, identity, verify, execute, rootKey, port = LAUNCHER_PORT }) {
  if (!home || !version || !identity || !execute) throw new Error('Launcher server dependencies required')
  const device = deviceIdentity(home), instance = installationId(home)
  const requestsDir = path.join(home, 'requests')
  fs.mkdirSync(requestsDir, { recursive: true, mode: 0o700 })
  let inFlight = 0
  const recent = []
  const server = http.createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Referrer-Policy', 'no-referrer')
    const reply = (status, value) => {
      if (res.destroyed) return
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(value))
    }
    const actualPort = server.address()?.port ?? port
    if (![`127.0.0.1:${actualPort}`, `localhost:${actualPort}`].includes(req.headers.host)) { reply(403, { ok: false, error: 'invalid_host' }); return }
    const origin = req.headers.origin
    if (origin !== undefined && !isLauncherOrigin(origin)) { reply(403, { ok: false, error: 'origin_not_allowed' }); return }
    if (origin) {
      res.setHeader('Access-Control-Allow-Origin', origin); res.setHeader('Vary', 'Origin')
      res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, POST, OPTIONS'); res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
      res.setHeader('Access-Control-Allow-Private-Network', 'true')
    }
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return }
    try {
      if ((req.url?.length ?? 0) > 2048) { reply(413, { ok: false, error: 'request_too_large' }); return }
      const url = new URL(req.url, `http://127.0.0.1:${actualPort}`)
      if (url.pathname === '/health' && ['GET', 'HEAD'].includes(req.method)) {
        const challenge = url.searchParams.get('challenge') ?? ''
        if (challenge && !/^[a-f0-9]{64}$/.test(challenge)) { reply(400, { ok: false, error: 'invalid_challenge' }); return }
        const certificates = [...pairedCertificates(home, rootKey).values()].flat().slice(0, 64)
        const health = { ok: true, service: 'devspec-launcher', protocol: 1, version, identity, installationId: instance,
          capabilities: ['encrypted-launch-v1', 'account-bound-launch', 'fleet-v1', 'claude-code-launch-v1'],
          status: fs.existsSync(path.join(home, 'disabled.json')) ? 'disabled' : certificates.length ? 'ready' : 'requires_connection',
          publicKey: device.publicKey, certificates, challenge }
        reply(200, { ...health, ...(challenge ? { signature: signHealth(health, device.privateKey) } : {}) }); return
      }
      if (url.pathname !== '/open') { reply(404, { ok: false, error: 'not_found' }); return }
      // Never accept a plaintext signed token or the old unsigned macOS path.
      if (req.method !== 'POST') { reply(405, { ok: false, error: 'encrypted_post_required' }); return }
      if (req.headers['content-type']?.split(';')[0] !== 'application/json') { reply(415, { ok: false, error: 'json_required' }); return }
      while (recent.length && recent[0] < Date.now() - 60_000) recent.shift()
      if (inFlight >= 4 || recent.length >= 60) { reply(429, { ok: false, error: 'launcher_busy' }); return }
      recent.push(Date.now())
      let size = 0, body = ''
      const decoder = new TextDecoder()
      for await (const chunk of req) {
        size += chunk.length
        if (size > MAX_REQUEST_BYTES) { reply(413, { ok: false, error: 'request_too_large' }); return }
        body += decoder.decode(chunk, { stream: true })
      }
      body += decoder.decode()
      let token
      try { token = openSealedRequest(JSON.parse(body), device.privateKey) }
      catch { reply(403, { ok: false, error: 'invalid_encrypted_request' }); return }
      inFlight++
      try {
        const receipt = await executeLaunchOnce({ home, token, publicKey: device.publicKey, execute: request => execute({ ...request, reportErrorsInBrowser: false }), rootKey, verify })
        reply(receipt.status, receipt.result)
      } finally { inFlight-- }
    } catch { reply(500, { ok: false, error: 'launcher_error' }) }
  })
  const sweep = setInterval(() => {
    try {
      for (const name of fs.readdirSync(requestsDir)) {
        if (!/^[a-f0-9]{64}\.json$/.test(name)) continue
        const file = path.join(requestsDir, name)
        try { const row = JSON.parse(fs.readFileSync(file, 'utf8')); if (Number.isSafeInteger(row.exp) && row.exp < Date.now() / 1000 - 60) fs.unlinkSync(file) } catch { /* never replay an unreadable receipt */ }
      }
    } catch { /* cleanup failure does not grant permission */ }
  }, 60_000)
  sweep.unref(); server.on('close', () => clearInterval(sweep))
  server.requestTimeout = 20_000; server.headersTimeout = 10_000
  return server
}
