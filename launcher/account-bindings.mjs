/** Account certificates contain public identity only. Host plugins own the
 * authenticated request; no MCP bearer token reaches the shared launcher.
 */
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { atomicWrite } from './payload.mjs'
import { verifySignedData } from './handoff-verify.mjs'
import { deviceIdentity, readPrivateJson } from './device-identity.mjs'
import { withInstallerLock } from './install-lock.mjs'
import { launcherHome } from './paths.mjs'
export { launcherHome } from './paths.mjs'
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i
const HASH = /^[a-f0-9]{64}$/
const isUserId = value => typeof value === 'string' && UUID.test(value)

export function trustedIdentityEndpoint(endpoint) {
  try {
    const url = new URL(endpoint)
    return ['https://api.devspec.ai', 'https://api.devspecstaging.com'].includes(url.origin) && url.pathname === '/api/mcp' && !url.username && !url.password
  } catch { return false }
}
function identityPayload(raw) {
  let payload = raw?.result ?? raw
  if (payload?.isError) return null
  if (payload?.structuredContent) payload = payload.structuredContent
  else if (Array.isArray(payload?.content)) {
    try { payload = JSON.parse(payload.content.find(block => block?.type === 'text')?.text) } catch { return null }
  }
  return payload
}
export function verifiedOwner(raw) {
  const payload = identityPayload(raw)
  return (payload?.authenticated === true || payload?.verified === true) && isUserId(payload.user_id) ? payload.user_id.toLowerCase() : null
}
export function certificateOwner(certificate, publicKey, rootKey) {
  const checked = verifySignedData(certificate, { publicKey: rootKey })
  const data = checked.data
  return checked.ok && data?.purpose === 'devspec-launcher-identity-v1' && data.publicKey === publicKey && isUserId(data.ownerId) && isUserId(data.tokenId) ? data.ownerId.toLowerCase() : null
}

export function rememberVerifiedCertificate({ home = launcherHome(), fingerprint, endpoint, certificate, rootKey }) {
  if (typeof fingerprint !== 'string' || !HASH.test(fingerprint) || !trustedIdentityEndpoint(endpoint)) throw new Error('Invalid launcher identity proof')
  const { publicKey } = deviceIdentity(home)
  if (!certificateOwner(certificate, publicKey, rootKey)) throw new Error('Invalid launcher identity certificate')
  const dir = path.join(home, 'accounts')
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  atomicWrite(path.join(dir, `${fingerprint}.json`), JSON.stringify({ version: 2, endpoint, certificate }) + '\n')
}

export async function ensureAccountBinding(options) {
  const home = options.home ?? launcherHome()
  if (process.env.DEVSPEC_LAUNCHER_DISABLED === '1' || fs.existsSync(path.join(home, 'disabled.json'))) return null
  const result = await withInstallerLock(() => pairAccountLocked({ ...options, home }), { home })
  return typeof result === 'string' ? result : null
}

async function pairAccountLocked({ home, fingerprint, endpoint, verifyAccount, rootKey }) {
  if (process.env.DEVSPEC_LAUNCHER_DISABLED === '1' || fs.existsSync(path.join(home, 'disabled.json'))) return null
  if (typeof fingerprint !== 'string' || !HASH.test(fingerprint) || !trustedIdentityEndpoint(endpoint)) throw new Error('Unsupported account verification endpoint')
  const { publicKey } = deviceIdentity(home)
  try {
    const record = readPrivateJson(path.join(home, 'accounts', `${fingerprint}.json`))
    const owner = certificateOwner(record.certificate, publicKey, rootKey)
    if (record.version === 2 && record.endpoint === endpoint && owner) return owner
  } catch { /* no cached authenticated device identity */ }
  // Only the host-owned callback carries credentials to the private pairing API.
  const response = await verifyAccount(publicKey)
  if (fs.existsSync(path.join(home, 'disabled.json'))) return null
  const owner = verifiedOwner(response)
  const certificate = identityPayload(response)?.launcher_certificate
  if (!owner || certificateOwner(certificate, publicKey, rootKey) !== owner) throw new Error('DevSpec did not certify this launcher for the authenticated account')
  rememberVerifiedCertificate({ home, fingerprint, endpoint, certificate, rootKey })
  return owner
}

export function pairedCertificates(home = launcherHome(), rootKey) {
  const result = new Map()
  let publicKey
  try { publicKey = deviceIdentity(home, { create: false }).publicKey } catch { return result }
  const dir = path.join(home, 'accounts')
  try {
    for (const name of fs.readdirSync(dir)) {
      if (!/^[a-f0-9]{64}\.json$/.test(name)) continue
      try {
        const record = readPrivateJson(path.join(dir, name))
        const owner = certificateOwner(record.certificate, publicKey, rootKey)
        if (record.version === 2 && owner && trustedIdentityEndpoint(record.endpoint)) result.set(owner, [...(result.get(owner) ?? []), record.certificate])
      } catch { /* corrupt or uncertified data never grants local execution */ }
    }
  } catch { /* no successful plugin verification yet */ }
  return result
}
export function pairedOwners(home = launcherHome(), rootKey) { return new Set(pairedCertificates(home, rootKey).keys()) }
export function isLaunchOwner(home, requesterId, rootKey) {
  return isUserId(requesterId) && !fs.existsSync(path.join(home, 'disabled.json')) && pairedOwners(home, rootKey).has(requesterId.toLowerCase())
}

export function installationId(home = launcherHome()) {
  deviceIdentity(home) // also enforces private per-user storage
  const file = path.join(home, 'installation-id')
  try {
    const id = fs.readFileSync(file, 'utf8').trim()
    if (!UUID.test(id)) throw new Error('Invalid launcher installation identity')
    return id
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
    const id = randomUUID()
    try { fs.writeFileSync(file, `${id}\n`, { flag: 'wx', mode: 0o600 }); return id }
    catch (writeError) {
      if (writeError.code !== 'EEXIST') throw writeError
      const existing = fs.readFileSync(file, 'utf8').trim()
      if (!UUID.test(existing)) throw new Error('Invalid launcher installation identity')
      return existing
    }
  }
}
