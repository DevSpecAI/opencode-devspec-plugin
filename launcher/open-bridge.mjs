#!/usr/bin/env node
/** Compatibility entry for the old macOS bridge. All platforms now use the
 * same signed-request server; there is no unsigned repo/prompt bypass.
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { isLauncherOrigin } from './launcher-server.mjs'
export const isAllowedOrigin = isLauncherOrigin
export function applyCors(req, res) {
  const origin = req.headers.origin
  if (!isAllowedOrigin(origin)) return
  res.setHeader('Access-Control-Allow-Origin', origin)
  res.setHeader('Vary', 'Origin')
  res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  res.setHeader('Access-Control-Allow-Private-Network', 'true')
}
export async function startMacOsBridgeServer() {
  const { main } = await import('./launcher.mjs')
  return main(['serve'])
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  startMacOsBridgeServer().catch(() => { console.error('DevSpec Launcher could not start. Check the local service and port.'); process.exitCode = 1 })
}
