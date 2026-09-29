/** Per-OS-user device key. It never leaves the launcher profile. Public identity
 * certificates and fresh challenge signatures let a browser distinguish our
 * listener from another process which happens to occupy the loopback port.
 */
import fs from 'node:fs'
import path from 'node:path'
import { createPrivateKey, createPublicKey, generateKeyPairSync, randomUUID, sign, verify, constants } from 'node:crypto'

export function readPrivateJson(file) {
  if (fs.lstatSync(file).isSymbolicLink()) throw new Error('Launcher state must not be a symlink')
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0))
  try {
    const stat = fs.fstatSync(fd)
    if (!stat.isFile() || stat.size > 16384 || (process.getuid && stat.uid !== process.getuid()) || (process.platform !== 'win32' && (stat.mode & 0o077) !== 0)) throw new Error('Launcher state is not private to this OS user')
    return JSON.parse(fs.readFileSync(fd, 'utf8'))
  } finally { fs.closeSync(fd) }
}

export function deviceIdentity(home, { create = true } = {}) {
  if (create) fs.mkdirSync(home, { recursive: true, mode: 0o700 })
  const stat = fs.lstatSync(home)
  if (!stat.isDirectory() || (process.getuid && stat.uid !== process.getuid())) throw new Error('Launcher home must belong to this OS user')
  if (create) fs.chmodSync(home, 0o700)
  else if (process.platform !== 'win32' && (stat.mode & 0o022)) throw new Error('Launcher home is writable by another OS user')
  const file = path.join(home, 'device-key.json')
  let stored
  try { stored = readPrivateJson(file) }
  catch (error) {
    if (error.code !== 'ENOENT' || !create) throw error
    const keys = generateKeyPairSync('rsa', { modulusLength: 3072 })
    const body = JSON.stringify({ version: 1, privateKey: keys.privateKey.export({ type: 'pkcs8', format: 'pem' }) })
    const temporary = path.join(home, `.device-key-${randomUUID()}`)
    try {
      fs.writeFileSync(temporary, body, { flag: 'wx', mode: 0o600 })
      // Publish a complete key without overwriting a concurrent winner's key.
      try { fs.linkSync(temporary, file) } catch (publishError) { if (publishError.code !== 'EEXIST') throw publishError }
    } finally { fs.rmSync(temporary, { force: true }) }
    stored = readPrivateJson(file)
  }
  if (stored.version !== 1 || typeof stored.privateKey !== 'string') throw new Error('Invalid launcher identity')
  const privateKey = createPrivateKey(stored.privateKey)
  if (privateKey.asymmetricKeyType !== 'rsa' || (privateKey.asymmetricKeyDetails?.modulusLength ?? 0) < 3072) throw new Error('Invalid launcher identity key')
  const publicKey = createPublicKey(privateKey).export({ type: 'spki', format: 'der' }).toString('base64url')
  return { privateKey, publicKey }
}

export function forgetDeviceIdentity(home) {
  // Never follow links or recursively delete user data. Only these dedicated
  // authentication files are ours; folder selections and release history remain.
  for (const name of ['device-key.json', 'installation-id']) fs.rmSync(path.join(home, name), { force: true })
  const dir = path.join(home, 'accounts')
  try {
    if (fs.lstatSync(dir).isSymbolicLink()) { fs.unlinkSync(dir); return }
    for (const name of fs.readdirSync(dir)) if (/^[a-f0-9]{64}\.(json|pending)$/.test(name)) fs.rmSync(path.join(dir, name), { force: true })
    if (fs.readdirSync(dir).length === 0) fs.rmdirSync(dir)
  } catch (error) { if (error.code !== 'ENOENT') throw error }
}

/** Identical fixed-field encoding at the API; no JSON property-order guess. */
export function healthProofMessage(health) {
  return Buffer.from(JSON.stringify([
    'devspec-launcher-health-v1', health.challenge, health.service, health.protocol,
    health.version, health.identity, health.installationId, health.status,
    health.capabilities, health.publicKey, health.certificates,
  ]))
}
export function signHealth(health, privateKey) {
  return sign('sha256', healthProofMessage(health), { key: privateKey, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: 32 }).toString('base64url')
}
export function verifyHealth(health, { challenge, publicKey }) {
  try {
    if (health.challenge !== challenge || health.publicKey !== publicKey || typeof health.signature !== 'string') return false
    const key = createPublicKey({ key: Buffer.from(publicKey, 'base64url'), format: 'der', type: 'spki' })
    return verify('sha256', healthProofMessage(health), { key, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: 32 }, Buffer.from(health.signature, 'base64url'))
  } catch { return false }
}
