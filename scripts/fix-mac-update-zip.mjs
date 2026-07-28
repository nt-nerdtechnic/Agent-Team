#!/usr/bin/env node
// Repackage the macOS update .zip so it preserves .framework symlinks.
//
// electron-builder 26.15.0's macOS `zip` target flattens the framework
// symlinks — Electron Framework.framework/Versions/Current and the top-level
// `Electron Framework`/`Helpers`/`Libraries`/`Resources` symlinks come out of
// the zip as real files/directories (and the 155 MB binary gets duplicated).
// Squirrel.Mac then rejects the extracted app during auto-update with
// "bundle format is ambiguous (could be app or framework)".
//
// macOS `ditto -c -k` preserves the symlinks, so we re-zip the already built,
// signed and notarized .app with ditto (overwriting electron-builder's broken
// zip) and refresh the sha512/size in latest-mac.yml so electron-updater's
// integrity check still matches. The .zip.blockmap is left as-is: latest-mac.yml
// carries no blockMapSize, so electron-updater does a full download and never
// consults the (now stale) blockmap.
//
// Usage: node scripts/fix-mac-update-zip.mjs [distDir]   (default: dist-release)

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const distDir = process.argv[2] ?? 'dist-release'

function die(msg) {
  console.error(`fix-mac-update-zip: ${msg}`)
  process.exit(1)
}

if (!existsSync(distDir)) die(`dist dir not found: ${distDir}`)

// Locate the packaged .app (electron-builder writes it under mac*/).
const macDir = readdirSync(distDir).find(
  (d) => d.startsWith('mac') && existsSync(join(distDir, d)) && readdirSync(join(distDir, d)).some((f) => f.endsWith('.app')),
)
if (!macDir) die(`no mac*/*.app found under ${distDir}`)
const appName = readdirSync(join(distDir, macDir)).find((f) => f.endsWith('.app'))
const appPath = join(distDir, macDir, appName)

// Locate the update zip (Navide-<version>-<arch>.zip, not the .blockmap).
const zipName = readdirSync(distDir).find((f) => f.endsWith('.zip') && !f.endsWith('.blockmap'))
if (!zipName) die(`no update .zip found under ${distDir}`)
const zipPath = join(distDir, zipName)

const ymlPath = join(distDir, 'latest-mac.yml')
if (!existsSync(ymlPath)) die(`latest-mac.yml not found under ${distDir}`)

console.log(`fix-mac-update-zip: re-zipping ${appPath} -> ${zipPath}`)
// ditto preserves the framework symlinks that electron-builder's zip flattens.
execFileSync('ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', appPath, zipPath], {
  stdio: 'inherit',
})

// Refresh sha512 (base64) + size so latest-mac.yml matches the new zip.
const buf = readFileSync(zipPath)
const sha512 = createHash('sha512').update(buf).digest('base64')
const size = buf.length

let yml = readFileSync(ymlPath, 'utf8')
// latest-mac.yml lists only the zip: one indented files[].sha512 + the
// top-level sha512 (identical), and one files[].size. Rewrite all of them.
yml = yml.replace(/^(\s*)sha512: .*$/gm, `$1sha512: ${sha512}`)
yml = yml.replace(/^(\s*)size: .*$/gm, `$1size: ${size}`)
writeFileSync(ymlPath, yml)

console.log(`fix-mac-update-zip: updated ${ymlPath}`)
console.log(`  size:   ${size}`)
console.log(`  sha512: ${sha512}`)
