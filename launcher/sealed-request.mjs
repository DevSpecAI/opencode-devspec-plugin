/** Hybrid RSA-OAEP/AES-GCM transport. A different process taking the loopback
 * port cannot read a launch prompt, even after a successful readiness probe.
 */
import { constants, createDecipheriv, privateDecrypt } from 'node:crypto'
export function openSealedRequest(envelope, privateKey) {
  if (!envelope || envelope.v !== 1) throw new Error('Invalid encrypted launch')
  for (const name of ['key', 'iv', 'tag', 'data']) {
    if (typeof envelope[name] !== 'string' || !/^[A-Za-z0-9_-]+$/.test(envelope[name])) throw new Error('Invalid encrypted launch')
  }
  if (envelope.data.length > 48_000 || envelope.key.length > 1000) throw new Error('Encrypted launch too large')
  const key = privateDecrypt({ key: privateKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, Buffer.from(envelope.key, 'base64url'))
  const iv = Buffer.from(envelope.iv, 'base64url'), tag = Buffer.from(envelope.tag, 'base64url')
  if (key.length !== 32 || iv.length !== 12 || tag.length !== 16) throw new Error('Invalid encrypted launch')
  const decipher = createDecipheriv('aes-256-gcm', key, iv)
  decipher.setAAD(Buffer.from('devspec-launcher-request-v1'))
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(Buffer.from(envelope.data, 'base64url')), decipher.final()]).toString('utf8')
}
