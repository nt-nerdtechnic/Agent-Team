// Loader for locally-installed plugins — generalizes the hard-wired built-in
// descriptors into "scan an installed-plugins directory, read each manifest,
// derive a launch descriptor". PURE parsing/validation plus a thin `node:fs`
// scan shell (no `electron` import), so the whole module is unit-testable.
//
// An installed plugin lives at `<root>/<id>/` and contains:
//   * `manifest.json` — the same trimmed manifest the backend host validates.
//   * the built frontend entry the manifest's `entry` field points at.
// This loader covers third-party installs; the bundled builtin mini-IDE dir is
// validated through the same code via `loadPluginDir` (see frontendPluginManager).

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import {
  assertKnownCapabilities,
  assertSafeEntryPath,
  verifyEd25519,
  PluginVerifyError,
} from './pluginVerify'
import type { PluginLaunchDescriptor } from './frontendPluginManager'

const ID_RE = /^[a-z0-9][a-z0-9-]*\.[a-z0-9][a-z0-9-]*$/
const SEMVER_RE = /^\d+\.\d+\.\d+$/

export interface InstalledManifest {
  id: string
  version: string
  requires: string[]
  entry: string
}

export class InstalledPluginError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'InstalledPluginError'
  }
}

/**
 * Validate a raw manifest object into the fields the loader needs. Enforces the
 * id shape, semver version, a present entry, and that every declared capability
 * is a known namespace (scope over-reach is rejected via `assertKnownCapabilities`).
 */
export function parseInstalledManifest(raw: unknown): InstalledManifest {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new InstalledPluginError('manifest must be a JSON object')
  }
  const m = raw as Record<string, unknown>
  const id = m.id
  if (typeof id !== 'string' || !ID_RE.test(id)) {
    throw new InstalledPluginError(`manifest id must be '<publisher>.<name>' lowercase, got ${String(id)}`)
  }
  const version = m.version
  if (typeof version !== 'string' || !SEMVER_RE.test(version)) {
    throw new InstalledPluginError(`manifest version must be semver, got ${String(version)}`)
  }
  const entry = m.entry
  if (typeof entry !== 'string' || entry.length === 0) {
    throw new InstalledPluginError(`manifest ${id} has no 'entry' (frontend bundle path)`)
  }
  // The entry is joined onto the plugin dir to build the load path, so it must
  // not escape it: reject absolute paths, drive letters, backslashes, and any
  // `..` segment (path traversal). Same policy as zip-slip on unpack.
  try {
    assertSafeEntryPath(entry)
  } catch (err) {
    if (err instanceof PluginVerifyError) {
      throw new InstalledPluginError(`manifest ${id} has unsafe entry path: ${entry}`)
    }
    throw err
  }
  const requires = Array.isArray(m.requires) ? m.requires.map(String) : []
  try {
    assertKnownCapabilities(requires)
  } catch (err) {
    if (err instanceof PluginVerifyError) throw new InstalledPluginError(err.message)
    throw err
  }
  return { id, version, requires, entry }
}

/**
 * Build a launch descriptor from a parsed manifest and its on-disk directory.
 * Installed plugins are prebuilt bundles loaded from a file (never the dev
 * server), so `devUrl` is empty. `query` carries the same workspace/http params
 * the mini-IDE consumes; callers pass an already-encoded `?a=b` string or omit.
 */
export function manifestToDescriptor(
  manifest: InstalledManifest,
  pluginDir: string,
  query = ''
): PluginLaunchDescriptor {
  return {
    id: manifest.id,
    requires: manifest.requires,
    devUrl: '',
    entryFile: join(pluginDir, manifest.entry),
    query,
  }
}

// ── Official install receipt ────────────────────────────────────────────────
//
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
 * Read one plugin directory: parse + validate its `manifest.json` and derive a
 * launch descriptor. Any failure (missing dir, unreadable/invalid manifest) is
 * returned as an `error` instead of thrown. Shared by the installed-root scan
 * below and by the bundled builtin mini-IDE resolution, so the bundled copy
 * goes through exactly the same manifest validation as a marketplace install.
 */
export function loadPluginDir(dir: string): ScannedPlugin {
  try {
    const raw = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'))
    const manifest = parseInstalledManifest(raw)
    return { dir, descriptor: manifestToDescriptor(manifest, dir) }
  } catch (err) {
    return { dir, error: err instanceof Error ? err.message : String(err) }
  }
}

/**
 * Scan an installed-plugins root, returning one {@link ScannedPlugin} per
 * immediate sub-directory. A directory with a missing/invalid manifest is
 * reported with an `error` rather than throwing, so one bad plugin never blocks
 * the rest. A non-existent root yields an empty list.
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
