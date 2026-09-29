/** Carry only explicit launcher state forward; never copy old executable code,
 * credentials, hooks or arbitrary files from a Cursor-owned installation.
 */
import fs from 'node:fs'
import path from 'node:path'
import { atomicWrite } from './payload.mjs'
const readObject = file => {
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid launcher state')
    return value
  } catch (error) { if (error.code === 'ENOENT') return null; throw error }
}
const validMapping = ([slug, folder]) => /^[\w.-]+\/[\w.-]+$/.test(slug) && typeof folder === 'string' && path.isAbsolute(folder) && !folder.includes('\0')
export function migrateLegacyState({ home, legacyHome }) {
  fs.mkdirSync(home, { recursive: true, mode: 0o700 })
  const target = path.join(home, 'repo-folder-map.json')
  const old = readObject(path.join(legacyHome, 'repo-folder-map.json'))
  let carried = 0
  if (old) {
    const current = readObject(target) ?? {}
    const merged = { ...current }
    for (const [slug, folder] of Object.entries(old).filter(validMapping)) {
      // Shared explicit selections win. Never pick another clone over one.
      if (!Object.hasOwn(merged, slug)) { merged[slug] = folder; carried++ }
    }
    if (carried) atomicWrite(target, JSON.stringify(merged, null, 2) + '\n')
  }
  const marker = path.join(home, 'extension-root.json')
  if (!fs.existsSync(marker)) {
    const prior = readObject(path.join(legacyHome, 'extension-root.json'))
    if (prior && typeof prior.extensionRoot === 'string' && path.isAbsolute(prior.extensionRoot)) {
      atomicWrite(marker, JSON.stringify({ v: 1, extensionRoot: prior.extensionRoot }) + '\n')
    }
  }
  return { carried }
}
