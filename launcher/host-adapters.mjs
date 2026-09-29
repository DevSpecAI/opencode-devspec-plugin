/** Hosts register their own credential-bearing launch adapter. The shared
 * launcher stores a local pointer; it never copies that host's auth code.
 */
import fs from 'node:fs'
import path from 'node:path'
import { atomicWrite } from './payload.mjs'
const TOOLS = new Set(['cursor', 'opencode'])
function assertFile(value) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || !fs.statSync(value).isFile()) throw new Error('Host launch adapter is unavailable')
  return value
}
export function registerHostAdapter({ home, tool, launchScript, promptModule }) {
  if (!TOOLS.has(tool)) throw new Error('Unsupported host adapter')
  const value = { version: 1, launchScript: assertFile(launchScript), ...(promptModule ? { promptModule: assertFile(promptModule) } : {}) }
  const dir = path.join(home, 'adapters')
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  const file = path.join(dir, `${tool}.json`), body = JSON.stringify(value) + '\n'
  let current
  try { current = fs.readFileSync(file, 'utf8') } catch (error) { if (error.code !== 'ENOENT') throw error }
  if (current !== body) atomicWrite(file, body)
}
export function readHostAdapter(home, tool) {
  if (!TOOLS.has(tool)) throw new Error('Unsupported host adapter')
  try {
    const value = JSON.parse(fs.readFileSync(path.join(home, 'adapters', `${tool}.json`), 'utf8'))
    if (value?.version !== 1) throw new Error('Unsupported host adapter version')
    return { launchScript: assertFile(value.launchScript), ...(value.promptModule ? { promptModule: assertFile(value.promptModule) } : {}) }
  } catch (error) { if (error.code === 'ENOENT') return null; throw error }
}
