#!/usr/bin/env node
/** Legacy executable name, one implementation. Never maintain a second installer. */
import { main } from './launcher.mjs'
const args = process.argv.slice(2)
const urlAt = args.indexOf('--url')
const forwarded = args.includes('--install') ? ['install']
  : urlAt >= 0 ? ['open', args[urlAt + 1]]
  : args.length === 1 && args[0].startsWith('devspec:') ? ['open', args[0]] : args
main(forwarded).then(code => { if (code !== undefined) process.exitCode = code }).catch(() => {
  console.error('DevSpec Launcher could not complete this request.')
  process.exitCode = 1
})
