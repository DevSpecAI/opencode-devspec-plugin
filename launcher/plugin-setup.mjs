#!/usr/bin/env node
/** First-execution entry for command-hook hosts. No stdout/model context, no
 * dependency fetch, and setup failure never blocks the host's own operation.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { ensureLauncherReady, defaultHome } from './launcher.mjs'
import { registerHostAdapter } from './host-adapters.mjs'
import { ensureAccountBinding } from './account-bindings.mjs'

export async function setupFromPlugin({ source = path.dirname(fileURLToPath(import.meta.url)), home = defaultHome(), cursorRoot, opencodeRoot, account, repair = false } = {}) {
  try {
    if (process.env.DEVSPEC_LAUNCHER_DISABLED === '1') return { ok: false, outcome: 'disabled', disabledByEnvironment: true }
    if (cursorRoot && !fs.existsSync(path.join(home, 'disabled.json'))) {
      const root = path.resolve(cursorRoot)
      registerHostAdapter({ home, tool: 'cursor', launchScript: path.join(root, 'scripts', 'launch-cli-session.mjs'), promptModule: path.join(root, 'scripts', 'pin-remote-plugin.mjs') })
    }
    if (opencodeRoot && !fs.existsSync(path.join(home, 'disabled.json'))) {
      registerHostAdapter({ home, tool: 'opencode', launchScript: path.join(path.resolve(opencodeRoot), 'launcher-adapter', 'launch-opencode-session.mjs') })
    }
    let accountFailed = false
    if (account) {
      try { await ensureAccountBinding({ ...account, home }) } catch { accountFailed = true }
    }
    const result = await ensureLauncherReady({ source, home, repair })
    return accountFailed ? { ...result, ok: false, outcome: 'not_ready', error: 'account_verification_failed' } : result
  } catch { return { ok: false, outcome: 'failed', error: 'plugin_setup_failed' } }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2)
  const cursorRoot = args.length === 2 && args[0] === '--cursor-root' ? args[1] : undefined
  const opencodeRoot = args.length === 2 && args[0] === '--opencode-root' ? args[1] : undefined
  if (args.length && !cursorRoot && !opencodeRoot) {
    console.error('DevSpec launcher setup: unsupported arguments. Copy commands remain available.')
  } else {
    const result = await setupFromPlugin({ cursorRoot, opencodeRoot })
    if (!result.ok && !['disabled', 'busy'].includes(result.outcome)) {
      // Host logs only. Details are retained in installation-status.json; never
      // print signed URLs, tokens, folder paths or child process command lines.
      console.error('DevSpec local launching is unavailable. Check launcher status or use Copy command.')
    }
  }
  process.exitCode = 0
}
