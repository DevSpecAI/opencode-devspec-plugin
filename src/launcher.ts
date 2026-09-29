import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { resolveDevspecAuth } from './resolve-devspec-auth.js'

/** OpenCode owns its credential-bearing launch adapter; the shared payload
 * owns OS installation. Never delay native plugin initialization for setup.
 */
export async function setupSharedLauncher(directory = process.cwd()): Promise<void> {
  if (process.env.DEVSPEC_LAUNCHER_DISABLED === '1') return
  try {
    const url = new URL('../launcher/plugin-setup.mjs', import.meta.url).href
    const { setupFromPlugin } = await import(url)
    const auth = resolveDevspecAuth(directory)
    const token = auth.token ?? '', endpoint = auth.mcp_url ?? ''
    await setupFromPlugin({ opencodeRoot: fileURLToPath(new URL('../', import.meta.url)), account: auth.ok && token && endpoint ? {
      fingerprint: createHash('sha256').update(token).digest('hex'),
      endpoint,
      verifyAccount: async (publicKey: string) => {
        const response = await fetch(new URL('/api/launcher/pair', endpoint), { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ publicKey }), signal: AbortSignal.timeout(15000) })
        if (!response.ok) throw new Error('Local launcher account pairing failed')
        return response.json()
      },
    } : undefined })
  } catch {
    // The shared installer retains installation-status.json when possible.
    // Loss of one-click launching must not disable the OpenCode plugin.
  }
}
