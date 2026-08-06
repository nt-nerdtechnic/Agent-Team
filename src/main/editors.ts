import { accessSync, constants, existsSync } from 'node:fs'
import { delimiter, isAbsolute, join } from 'node:path'

// Default-editor routing. Every "open this file" in the app funnels through
// window:openEditor, so this module decides — per request — whether it goes to
// the mini-IDE (the default and the only surface that can render a diff), to
// the OS default application, or to an external IDE the user picked.
//
// Kept free of Electron imports so index.ts can stay a thin caller and the
// decision logic is unit-testable, mirroring editor-fallback.ts.

/** Where an open request is sent. */
export type EditorKind = 'mini-ide' | 'system' | 'external'

/** A built-in editor Navide knows how to drive. */
export interface EditorDefinition {
  id: string
  kind: EditorKind
  /** Executable names looked up on PATH, in order. */
  commands: string[]
  /** Absolute paths tried when PATH has no hit (macOS ships the CLI inside
   *  the .app, and installing it onto PATH is a manual opt-in most users skip). */
  bundledPaths: string[]
  /** Argv after the executable for a file open. */
  fileArgs: (file: string, line?: number) => string[]
  /** Argv after the executable for a folder open. */
  folderArgs: (dir: string) => string[]
}

const vscodeLike = (id: string, command: string, appName: string): EditorDefinition => ({
  id,
  kind: 'external',
  commands: [command],
  bundledPaths: [
    `/Applications/${appName}.app/Contents/Resources/app/bin/${command}`,
    `${process.env.HOME ?? ''}/Applications/${appName}.app/Contents/Resources/app/bin/${command}`,
  ],
  // -g is the goto form: without it the file:line suffix is taken literally as
  // part of the filename.
  fileArgs: (file, line) => (line && line > 0 ? ['-g', `${file}:${line}`] : [file]),
  folderArgs: (dir) => [dir],
})

/** The editors offered in Settings, in display order. `mini-ide` and `system`
 *  are handled by the host (plugin view / shell.openPath) and so carry no
 *  command; `custom` is driven entirely by the user's template. */
export const BUILT_IN_EDITORS: EditorDefinition[] = [
  vscodeLike('vscode', 'code', 'Visual Studio Code'),
  vscodeLike('cursor', 'cursor', 'Cursor'),
]

/** Editor ids that need no detection because the host implements them. */
export const HOST_EDITOR_IDS = ['mini-ide', 'system'] as const

export const DEFAULT_EDITOR_ID = 'mini-ide'

/** Normalize a stored preference to a known id. Unknown/blank → the default,
 *  so a settings file written by a newer build never breaks opening files. */
export function normalizeEditorId(raw: unknown, customCommand: readonly string[] = []): string {
  if (typeof raw !== 'string') return DEFAULT_EDITOR_ID
  const id = raw.trim()
  if ((HOST_EDITOR_IDS as readonly string[]).includes(id)) return id
  if (BUILT_IN_EDITORS.some((e) => e.id === id)) return id
  // `custom` is only meaningful once a command exists; otherwise selecting it
  // would silently open nothing.
  if (id === 'custom' && customCommand.length > 0) return id
  return DEFAULT_EDITOR_ID
}

/** The user's resolved editor preference, as main reads it from ui_settings. */
export interface EditorPreference {
  editorId: string
  /** argv template for `custom`, e.g. ['code', '-g', '{file}:{line}']. */
  customCommand: string[]
}

/** What to do with one open request. */
export type OpenRoute =
  | { via: 'mini-ide'; reason: 'preference' | 'diff' | 'bare' | 'sidebar' }
  | { via: 'system' }
  | { via: 'external'; editorId: string }

/**
 * Decide where an editor-open request goes.
 *
 * Exemptions always win over the preference — they are the requests an external
 * editor structurally cannot serve:
 *  - diff / branch-diff: a computed diff has no file on disk to hand over.
 *  - bare opens (no filepath): "show me the mini-IDE", not "open this file".
 *  - sidebar-driven opens (Find in Files, the git sidebar): they ask for a
 *    mini-IDE panel, and the filepath — when present — is incidental.
 */
export function classifyOpenRequest(
  params: Record<string, string>,
  preference: EditorPreference
): OpenRoute {
  if (params.diff_filepath || params.branch_diff_base) return { via: 'mini-ide', reason: 'diff' }
  if (!params.filepath) return { via: 'mini-ide', reason: 'bare' }
  if (params.sidebar === 'search' || params.sidebar === 'git') {
    return { via: 'mini-ide', reason: 'sidebar' }
  }
  const id = normalizeEditorId(preference.editorId, preference.customCommand)
  if (id === 'mini-ide') return { via: 'mini-ide', reason: 'preference' }
  if (id === 'system') return { via: 'system' }
  return { via: 'external', editorId: id }
}

/** Placeholder values an argv template can reference. */
export interface TemplateVars {
  file?: string
  dir?: string
  line?: number
  workspace?: string
}

/**
 * Expand {file}/{dir}/{line}/{workspace} in a custom argv template.
 *
 * Substitution is whole-value: a placeholder is replaced inside its own argv
 * entry and the result stays one entry, so a path containing spaces or shell
 * metacharacters can never split into extra arguments. An entry whose only
 * content is an unset placeholder is dropped (e.g. no line number → no
 * dangling `--line` value); an entry mixing text with an unset placeholder
 * keeps the text with the placeholder resolved to an empty string.
 */
export function expandTemplate(template: readonly string[], vars: TemplateVars): string[] {
  const out: string[] = []
  for (const entry of template) {
    const solePlaceholder = /^\{(file|dir|line|workspace)\}$/.exec(entry)
    if (solePlaceholder) {
      const value = resolveVar(solePlaceholder[1]!, vars)
      if (value === '') continue // unset — drop the argument entirely
      out.push(value)
      continue
    }
    out.push(
      entry.replace(/\{(file|dir|line|workspace)\}/g, (_m, key: string) => resolveVar(key, vars))
    )
  }
  return out
}

function resolveVar(key: string, vars: TemplateVars): string {
  switch (key) {
    case 'file':
      return vars.file ?? ''
    case 'dir':
      return vars.dir ?? ''
    case 'line':
      return vars.line && vars.line > 0 ? String(vars.line) : ''
    case 'workspace':
      return vars.workspace ?? ''
    default:
      return ''
  }
}

/** One entry of the editor list Settings renders. */
export interface DetectedEditor {
  id: string
  /** Resolved absolute path of the executable, or '' when not found. */
  command: string
  available: boolean
}

/** Does this path exist and carry the executable bit? */
function isExecutable(path: string, access: (p: string, mode: number) => void = accessSync): boolean {
  try {
    access(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

/**
 * Resolve an executable name against a PATH string. Returns the absolute path
 * of the first executable hit, or null.
 */
export function whichIn(
  name: string,
  pathEnv: string,
  exists: (p: string) => boolean = existsSync,
  executable: (p: string) => boolean = isExecutable
): string | null {
  if (isAbsolute(name)) return exists(name) && executable(name) ? name : null
  for (const dir of pathEnv.split(delimiter).filter(Boolean)) {
    const candidate = join(dir, name)
    if (exists(candidate) && executable(candidate)) return candidate
  }
  return null
}

/**
 * Resolve one editor's executable: PATH first, then its .app-bundled CLI.
 *
 * The bundled fallback is not an edge case on macOS — a machine can have
 * VS Code and Cursor installed while neither `code` nor `cursor` is on PATH,
 * because that shell command is a separate opt-in install step.
 */
export function resolveEditorCommand(
  def: EditorDefinition,
  pathEnv: string,
  exists: (p: string) => boolean = existsSync,
  executable: (p: string) => boolean = isExecutable
): string | null {
  for (const name of def.commands) {
    const hit = whichIn(name, pathEnv, exists, executable)
    if (hit) return hit
  }
  for (const path of def.bundledPaths) {
    if (path && exists(path) && executable(path)) return path
  }
  return null
}

/** Detect every built-in editor against a PATH. Host-implemented entries
 *  (`mini-ide`, `system`) are always available and are not listed here. */
export function detectEditors(
  pathEnv: string,
  exists: (p: string) => boolean = existsSync,
  executable: (p: string) => boolean = isExecutable
): DetectedEditor[] {
  return BUILT_IN_EDITORS.map((def) => {
    const command = resolveEditorCommand(def, pathEnv, exists, executable)
    return { id: def.id, command: command ?? '', available: command !== null }
  })
}

/** The part of a spawned child that launch detection observes. */
export interface EditorProcess {
  once(event: 'error', listener: () => void): unknown
  once(event: 'exit', listener: (code: number | null) => void): unknown
  unref(): void
}

/** Starts the editor. Throws (or returns a child that errors) on failure. */
export type EditorSpawner = () => EditorProcess

/** How long a freshly spawned editor gets to fail before it counts as
 *  launched. GUI editors hand off to an already-running instance and exit 0
 *  almost immediately, so only a NON-ZERO exit inside the window is a failure —
 *  treating any early exit as failure would reject every successful open. */
export const EDITOR_LAUNCH_FAILURE_WINDOW_MS = 800

/**
 * Spawn an editor and report whether it started.
 *
 * Resolves false when the process could not be spawned at all, or died with a
 * non-zero status inside the failure window — those are the cases where the
 * user would otherwise see nothing happen at all, so the caller falls back.
 */
export function launchEditorProcess(
  spawner: EditorSpawner,
  failureWindowMs: number = EDITOR_LAUNCH_FAILURE_WINDOW_MS
): Promise<boolean> {
  return new Promise((resolve) => {
    let child: EditorProcess
    try {
      child = spawner()
    } catch {
      resolve(false)
      return
    }
    let settled = false
    const settle = (ok: boolean): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(ok)
    }
    const timer = setTimeout(() => {
      // Survived the window: detach so quitting Navide doesn't take the editor
      // down with it.
      child.unref()
      settle(true)
    }, failureWindowMs)
    child.once('error', () => settle(false))
    child.once('exit', (code) => {
      if (code !== 0) settle(false)
    })
  })
}

/** The argv (executable + arguments) for an external open, or null when the
 *  editor is unknown, undetected, or its custom template expands to nothing. */
export function buildEditorArgv(
  editorId: string,
  detected: readonly DetectedEditor[],
  customCommand: readonly string[],
  vars: TemplateVars
): string[] | null {
  if (editorId === 'custom') {
    const expanded = expandTemplate(customCommand, vars)
    return expanded.length > 0 ? expanded : null
  }
  const def = BUILT_IN_EDITORS.find((e) => e.id === editorId)
  if (!def) return null
  const hit = detected.find((d) => d.id === editorId)
  if (!hit?.available || !hit.command) return null
  const args = vars.dir ? def.folderArgs(vars.dir) : def.fileArgs(vars.file ?? '', vars.line)
  return [hit.command, ...args]
}
