#!/usr/bin/env node
/** Safe release/package check: reads bundled files only, never installs anything. */
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { readVerifiedPayload } from './payload.mjs'
export function checkBundle(dir = path.dirname(fileURLToPath(import.meta.url))) {
  return readVerifiedPayload(dir)
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { manifest } = checkBundle()
    console.log(`DevSpec launcher ${manifest.version}: all bundled files verified`)
  } catch { console.error('DevSpec launcher payload differs from its release manifest. Regenerate it from DevSpec-Launcher.'); process.exitCode = 1 }
}
