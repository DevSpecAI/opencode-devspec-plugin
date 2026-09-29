#!/usr/bin/env node
/** Stable OS entry. Verify the complete active release BEFORE importing it.
 * This file is copied atomically to the installation root; services never point
 * at a particular old release directory after an update (27b53001).
 */
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { fileURLToPath, pathToFileURL } from 'node:url'
const home = path.dirname(fileURLToPath(import.meta.url))
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
try {
  const active = JSON.parse(fs.readFileSync(path.join(home, 'active.json'), 'utf8'))
  if (!/^\d+\.\d+\.\d+$/.test(active.version) || !/^[a-f0-9]{64}$/.test(active.identity)) throw new Error('Invalid active release')
  const dir = path.join(home, 'releases', `${active.version}-${active.identity}`)
  if (!fs.lstatSync(dir).isDirectory()) throw new Error('Invalid release directory')
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'LAUNCHER-MANIFEST.json'), 'utf8'))
  if (manifest.version !== active.version || !manifest.files || Array.isArray(manifest.files)) throw new Error('Invalid release manifest')
  const entries = Object.entries(manifest.files).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
  if (sha(JSON.stringify({ version: manifest.version, files: Object.fromEntries(entries) })) !== active.identity) throw new Error('Manifest changed')
  if (!entries.length || !manifest.files['launcher.mjs']) throw new Error('Missing launcher')
  for (const [name, digest] of entries) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(name) || !/^sha256:[a-f0-9]{64}$/.test(digest)) throw new Error('Invalid file entry')
    const file = path.join(dir, name)
    if (!fs.lstatSync(file).isFile() || `sha256:${sha(fs.readFileSync(file))}` !== digest) throw new Error('Payload changed')
  }
  const args = process.argv.slice(2)
  const homeAt = args.indexOf('--home')
  if (homeAt !== -1) {
    if (homeAt !== 1 || path.resolve(args[homeAt + 1] || '') !== home) throw new Error('Unexpected installation path')
    args.splice(homeAt, 2)
  }
  const command = args.shift()
  const { main } = await import(pathToFileURL(path.join(dir, 'launcher.mjs')).href)
  const code = await main([command ?? '', '--home', home, ...args])
  if (code !== undefined) process.exitCode = code
} catch {
  console.error('DevSpec Launcher could not verify its installed release. Update the plugin and run its launcher repair command. Copy commands remain available.')
  process.exitCode = 1
}
