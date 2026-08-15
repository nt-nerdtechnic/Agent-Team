// Loader for locally-installed plugins. Manifest parsing and permission policy
// live in the format-specific modules behind `pluginManifest.ts`; this module
// keeps the compatibility exports plus descriptor/receipt/scan I/O.
// PURE parsing/validation plus a thin `node:fs` scan shell (no `electron`
// import), so the whole module is unit-testable.
//
// An installed plugin lives at `<root>/<id>/` and contains:
//   * `manifest.json` — the same strict manifest the backend host validates.
//   * every built frontend/backend asset referenced by the manifest.
// This loader covers third-party installs; bundled builtin directories are
// validated through the same `loadPluginDir` path.

import { lstatSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { TextDecoder } from 'node:util'
import { join } from 'node:path'
import { verifyEd25519 } from './pluginVerify'
import {
  assertManifestFiles,
  isManifestV2,
  manifestCapabilityPolicy,
  manifestCapabilities,
  manifestReferencedFiles,
  parseInstalledManifest,
  parseManifestJson,
  type InstalledManifest,
} from './pluginManifest'
import type { PluginLaunchDescriptor, PluginViewLaunchDescriptor } from './frontendPluginManager'

export {
  assertManifestFiles,
  isManifestV2,
  manifestCapabilityPolicy,
  manifestCapabilities,
  manifestReferencedFiles,
  parseInstalledManifest,
  parseManifestJson,
  InstalledPluginError,
  type InstalledManifest,
  type LegacyInstalledManifest,
  type PluginManifestV2,
  type PluginManifestV2View,
} from './pluginManifest'

const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })

function readUtf8File(path: string, label: string): string {
  try {
    return UTF8_DECODER.decode(readFileSync(path))
  } catch (error) {
    throw new Error(
      `${label} is not valid UTF-8: ${error instanceof Error ? error.message : String(error)}`
    )
  }
}

function assertManifestFilesOnDisk(manifest: InstalledManifest, pluginDir: string): void {
  try {
    const root = lstatSync(pluginDir)
    if (root.isSymbolicLink() || !root.isDirectory()) throw new Error('invalid plugin root')
  } catch {
    throw new Error(`plugin directory is missing or unsafe: ${pluginDir}`)
  }
  for (const path of manifestReferencedFiles(manifest)) {
    try {
      let current = pluginDir
      const segments = path.split('/')
      for (const [index, segment] of segments.entries()) {
        current = join(current, segment)
        const entry = lstatSync(current)
        if (entry.isSymbolicLink()) throw new Error('symlink entry')
        if (index === segments.length - 1) {
          if (!entry.isFile()) throw new Error('not a regular file')
        } else if (!entry.isDirectory()) {
          throw new Error('invalid package directory')
        }
      }
    } catch {
      throw new Error(`manifest referenced file is missing or unsafe: ${path}`)
    }
  }
}

/**
 * Build a launch descriptor from a parsed manifest and its on-disk directory.
 * Installed plugins are prebuilt bundles loaded from a file (never the dev
 * server), so `devUrl` is empty.
 */
export function manifestToDescriptor(
  manifest: InstalledManifest,
  pluginDir: string,
  query = ''
): PluginLaunchDescriptor {
  if (isManifestV2(manifest)) {
    const views = manifest.contributes?.views ?? []
    if (views.length === 0) {
      throw new Error(`manifest ${manifest.id} has no frontend custom view contribution`)
    }
    const launchViews: PluginViewLaunchDescriptor[] = views.map((view) => ({
      id: view.id,
      contributionKey: `${manifest.id}.${view.id}`,
      kind: view.kind,
      location: view.location,
      title: view.title,
      icon: view.icon,
      entryFile: join(pluginDir, view.entry),
    }))
    return {
      id: manifest.id,
      requires: manifestCapabilities(manifest),
      capabilityPolicy: manifestCapabilityPolicy(manifest),
      devUrl: '',
      entryFile: launchViews[0].entryFile,
      query,
      views: launchViews,
    }
  }
  return {
    id: manifest.id,
    requires: manifest.requires,
    capabilityPolicy: manifestCapabilityPolicy(manifest),
    devUrl: '',
    entryFile: join(pluginDir, manifest.entry),
    query,
  }
}

// ── Official install receipt ────────────────────────────────────────────────

// How install-time verification reaches load-time: when `commitInstall` writes
// an official (`navide.`) package it also writes `.navide-receipt.json` into
// the plugin dir, recording the package digest and its Ed25519 signature. At
// load time the loader re-verifies that signature against the CURRENT pinned
// official key — so a `navide.` dir with a missing/forged receipt, or a pin
// that has since changed/been removed, is refused (fail-closed). The receipt is
// evidence carried forward, not a trusted flag: nothing trusts a bare
// `official: true` boolean.

/** Receipt filename written by commitInstall into an official plugin's dir. */
export const OFFICIAL_RECEIPT_NAME = '.navide-receipt.json'

export interface OfficialReceipt {
  id: string
  version: string
  /** sha256 hex digest of the installed package bytes. */
  digest: string
  /** Detached base64 Ed25519 signature over the digest (official key). */
  signature: string
}

/**
 * Decide whether an installed `navide.` plugin dir may register: read its
 * receipt, check it names this plugin id, and re-verify the recorded package
 * signature against the pinned official key. Returns `ok: false` with a reason
 * on ANY failure (no receipt, malformed, id mismatch, no pinned key, bad
 * signature) — the caller must then refuse to register the descriptor.
 */
export function verifyOfficialInstall(
  pluginDir: string,
  pluginId: string,
  pinnedKey: string | null
): { ok: true } | { ok: false; reason: string } {
  if (!pinnedKey) {
    return { ok: false, reason: 'no pinned official publisher key configured' }
  }
  let receipt: Partial<OfficialReceipt>
  try {
    receipt = JSON.parse(readFileSync(join(pluginDir, OFFICIAL_RECEIPT_NAME), 'utf8'))
  } catch {
    return { ok: false, reason: `missing or unreadable ${OFFICIAL_RECEIPT_NAME}` }
  }
  if (
    typeof receipt !== 'object' ||
    receipt === null ||
    typeof receipt.digest !== 'string' ||
    typeof receipt.signature !== 'string' ||
    receipt.id !== pluginId
  ) {
    return { ok: false, reason: `malformed ${OFFICIAL_RECEIPT_NAME}` }
  }
  if (!verifyEd25519(receipt.digest, receipt.signature, pinnedKey)) {
    return {
      ok: false,
      reason: 'install receipt signature failed verification against the pinned official key',
    }
  }
  return { ok: true }
}

export interface ScannedPlugin {
  /** The plugin's on-disk directory. */
  dir: string
  /** The parsed descriptor, when the manifest was valid. */
  descriptor?: PluginLaunchDescriptor
  /** The parse/validation error message, when the directory was rejected. */
  error?: string
}

/**
 * Read one plugin directory: parse + validate its `manifest.json`, verify all
 * Manifest v2 referenced files are safe regular files, and derive a launch
 * descriptor. Any failure is returned as an `error` instead of thrown.
 */
export function loadPluginDir(dir: string): ScannedPlugin {
  try {
    const raw = parseManifestJson(readUtf8File(join(dir, 'manifest.json'), 'manifest.json'))
    const manifest = parseInstalledManifest(raw)
    if (isManifestV2(manifest)) assertManifestFilesOnDisk(manifest, dir)
    return { dir, descriptor: manifestToDescriptor(manifest, dir) }
  } catch (error) {
    return { dir, error: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * Scan an installed-plugins root, returning one {@link ScannedPlugin} per
 * immediate sub-directory. A directory with a missing/invalid manifest or
 * unsafe referenced file is reported with an `error` rather than throwing, so
 * one bad plugin never blocks the rest. A non-existent root yields an empty
 * list.
 */
export function scanInstalledPlugins(root: string): ScannedPlugin[] {
  let names: string[]
  try {
    names = readdirSync(root)
  } catch {
    return []
  }
  const out: ScannedPlugin[] = []
  for (const name of names) {
    const dir = join(root, name)
    try {
      if (!statSync(dir).isDirectory()) continue
    } catch {
      continue
    }
    out.push(loadPluginDir(dir))
  }
  return out
}
