#!/usr/bin/env node

import {
  lstatSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { TextDecoder } from 'node:util'
import {
  canonicalArchivePath,
  comparePortableArchivePaths,
  manifestReferencedFiles,
  parseManifestJson,
  parseManifestV2,
  validatePortableArchiveEntries,
} from '@navide/plugin-contracts'
import { readRegularFileNoFollow } from './package-files.mjs'

const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })

function fail(message) {
  throw new Error(message)
}

function decodeUtf8(bytes, label) {
  try {
    return UTF8_DECODER.decode(bytes)
  } catch (error) {
    fail(`${label} is not valid UTF-8: ${error instanceof Error ? error.message : String(error)}`)
  }
}

function assertSafePath(path, label) {
  if (canonicalArchivePath(path, 'regular') === null) {
    fail(`${label} is not a safe package-relative path`)
  }
}

function readManifest(directory) {
  const path = join(directory, 'manifest.json')
  const stat = lstatSync(path, { bigint: true })
  if (!stat.isFile()) fail('manifest.json must be a regular file')
  const raw = parseManifestJson(decodeUtf8(readRegularFileNoFollow(path), 'manifest.json'))
  return parseManifestV2(raw)
}

function assertInsideRoot(root, candidate) {
  const relativePath = relative(root, realpathSync(candidate))
  if (relativePath.startsWith('..') || isAbsolute(relativePath)) {
    fail(`package entry '${candidate}' resolves outside the package root`)
  }
}

function collectFiles(directory, current = '', root = realpathSync(directory)) {
  const files = []
  const currentDirectory = join(directory, current)
  assertInsideRoot(root, currentDirectory)
  for (const entry of readdirSync(currentDirectory, { withFileTypes: true })) {
    const path = current ? `${current}/${entry.name}` : entry.name
    assertSafePath(path, `package entry '${path}'`)
    const fullPath = join(directory, path)
    const stat = lstatSync(fullPath, { bigint: true })
    if (stat.isDirectory()) {
      assertInsideRoot(root, fullPath)
      files.push(...collectFiles(directory, path, root))
    } else if (stat.isFile()) {
      assertInsideRoot(root, fullPath)
      files.push({ path, bytes: readRegularFileNoFollow(fullPath) })
    } else {
      fail(`package entry '${path}' must be a regular file or directory`)
    }
  }
  return files
}

function validateFiles(manifest, files) {
  const paths = new Set(files.map((file) => file.path))
  if (!paths.has('manifest.json')) fail('package must contain manifest.json at its root')
  for (const path of paths) {
    if (path === 'manifest.json' || path === 'README.md') continue
    if (!path.startsWith('frontend/') && !path.startsWith('assets/')) {
      fail(`package entry '${path}' is outside the frontend/assets package boundary`)
    }
  }
  for (const path of manifestReferencedFiles(manifest)) {
    if (!paths.has(path)) fail(`manifest references '${path}', but that file does not exist`)
  }
}

function validateDirectory(directory) {
  const root = resolve(directory)
  if (!lstatSync(root, { bigint: true }).isDirectory()) {
    fail(`package directory '${directory}' is not a directory`)
  }
  const rootRealPath = realpathSync(root)
  const manifest = readManifest(root)
  const files = collectFiles(root, '', rootRealPath).sort((left, right) =>
    comparePortableArchivePaths(left.path, right.path)
  )
  const issue = validatePortableArchiveEntries(
    files.map((file) => ({ path: file.path, type: 'regular' }))
  )
  if (issue) {
    if (issue.kind === 'unsafe-path') {
      fail(`package entry '${issue.path}' is not a safe package-relative path`)
    }
    if (issue.kind === 'duplicate') {
      fail(`portable archive collision: '${issue.path}' duplicates another entry`)
    }
    fail(`portable archive collision: '${issue.path}' is a regular-file ancestor`)
  }
  validateFiles(manifest, files)
  return { root, manifest, files }
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let index = 0; index < table.length; index += 1) {
    let value = index
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
    }
    table[index] = value >>> 0
  }
  return table
})()

function crc32(bytes) {
  let value = 0xffffffff
  for (const byte of bytes) value = CRC_TABLE[(value ^ byte) & 0xff] ^ (value >>> 8)
  return (value ^ 0xffffffff) >>> 0
}

function u16(value) {
  const buffer = Buffer.alloc(2)
  buffer.writeUInt16LE(value, 0)
  return buffer
}

function u32(value) {
  const buffer = Buffer.alloc(4)
  buffer.writeUInt32LE(value >>> 0, 0)
  return buffer
}

function makeZip(files) {
  const local = []
  const central = []
  let offset = 0
  for (const file of files) {
    const name = Buffer.from(file.path, 'utf8')
    const checksum = crc32(file.bytes)
    const header = Buffer.concat([
      u32(0x04034b50),
      u16(20),
      u16(0),
      u16(0),
      u16(0),
      u16(0),
      u32(checksum),
      u32(file.bytes.length),
      u32(file.bytes.length),
      u16(name.length),
      u16(0),
      name,
      file.bytes,
    ])
    local.push(header)
    central.push(
      Buffer.concat([
        u32(0x02014b50),
        u16(20),
        u16(20),
        u16(0),
        u16(0),
        u16(0),
        u16(0),
        u32(checksum),
        u32(file.bytes.length),
        u32(file.bytes.length),
        u16(name.length),
        u16(0),
        u16(0),
        u16(0),
        u16(0),
        u32(0),
        u32(offset),
        name,
      ])
    )
    offset += header.length
  }
  const centralBytes = Buffer.concat(central)
  const localBytes = Buffer.concat(local)
  return Buffer.concat([
    localBytes,
    centralBytes,
    u32(0x06054b50),
    u16(0),
    u16(0),
    u16(files.length),
    u16(files.length),
    u32(centralBytes.length),
    u32(localBytes.length),
    u16(0),
  ])
}

function packageDirectory(directory, output) {
  const result = validateDirectory(directory)
  if (result.manifest.backend) fail('backend packaging is deferred beyond Issue 06')
  const outputPath = resolve(output ?? `${result.manifest.id}-${result.manifest.version}.vsix`)
  mkdirSync(dirname(outputPath), { recursive: true })
  writeFileSync(outputPath, makeZip(result.files))
  return { outputPath, manifest: result.manifest }
}

function usage() {
  return [
    'Usage:',
    '  navide-plugin validate <directory>',
    '  navide-plugin package <directory> [--out <file>]',
  ].join('\n')
}

function main(argv) {
  const [command, directory, ...rest] = argv
  if (!command || !directory || !['validate', 'package'].includes(command)) fail(usage())
  if (command === 'validate') {
    if (rest.length !== 0) fail(usage())
    const result = validateDirectory(directory)
    console.log(`Validated ${result.manifest.id}@${result.manifest.version}`)
    return
  }
  let output
  if (rest.length === 2 && rest[0] === '--out') output = rest[1]
  else if (rest.length !== 0) fail(usage())
  const result = packageDirectory(directory, output)
  console.log(`Packaged ${result.manifest.id}@${result.manifest.version} to ${result.outputPath}`)
}

try {
  main(process.argv.slice(2))
} catch (error) {
  console.error(`navide-plugin: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
}
