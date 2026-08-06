import { computed, onScopeDispose, ref, shallowRef, watch } from 'vue'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import { WebglAddon } from '@xterm/addon-webgl'
import '@xterm/xterm/css/xterm.css'
import type { useBackend } from './useBackend'
import { bufferTail, createRedrawGuard, dropTuiNoise, stripAnsi } from '../lib/buffer'
import { createResizeController, type ResizeController } from './useTerminalResize'
import { installTerminalZoomShortcuts, terminalFontSize } from './useTerminalFontSize'
import { getResumeConcurrency } from '../lib/resumeConcurrency'
import { chunkForPty, shouldOpenMentionMenu } from '../lib/cliContext'
import { settingsGet, settingsSet } from '../lib/settings'
import { TERMINAL_CREATE_TIMEOUT_MS } from '../lib/resume-command'
import { setContext } from '../keybindings/contextService'
import {
  formatTerminalExit,
  isTerminalCrashLoopOpen,
  recordTerminalExit,
  terminalCrashKey,
  type TerminalExitDetails,
  type TerminalStartupProbe,
} from '../lib/spawnHistory'

import type { ITheme } from '@xterm/xterm'

// Per-app-theme xterm palettes. CSS vars can't be used directly because
// getPropertyValue returns the raw `var(--gray-12)` token, not the resolved hex.
// The light palette remaps ANSI white/brightWhite so TUI apps (designed for dark
// terminals) stay readable on a light background.
// Shared ANSI 16-color palette for dark themes, aligned to the base.css color
// scales so CLI output (green spinners, syntax highlight, etc.) matches the app
// design instead of falling back to xterm.js's built-in defaults.
const DARK_ANSI = {
  black: '#484f58',   brightBlack: '#6e7681',
  red: '#ff7b72',     brightRed: '#ffa198',
  green: '#3fb950',   brightGreen: '#56d364',
  yellow: '#d29922',  brightYellow: '#e3b341',
  blue: '#58a6ff',    brightBlue: '#79c0ff',
  magenta: '#bc8cff', brightMagenta: '#d2a8ff',
  cyan: '#56d4dd',    brightCyan: '#b3f0ff',
  white: '#b1bac4',   brightWhite: '#ffffff',
}

// Scrollbar slider colors applied directly to ITheme so Monaco's overlay
// scrollbar is legible. Default (foreground @ 20%) is too faint on dark bg.
const DARK_SCROLLBAR = {
  scrollbarSliderBackground:       'rgba(255,255,255,0.55)',
  scrollbarSliderHoverBackground:  'rgba(255,255,255,0.75)',
  scrollbarSliderActiveBackground: 'rgba(255,255,255,0.90)',
}

const XTERM_THEMES: Record<string, ITheme> = {
  'dark-github': {
    background: '#0d1117', foreground: '#e6edf3',
    cursor: '#58a6ff', selectionBackground: 'rgba(56,139,253,0.35)',
    ...DARK_ANSI, ...DARK_SCROLLBAR,
  },
  'dark-midnight': {
    background: '#0a0e14', foreground: '#c5d0e6',
    cursor: '#6cb0ff', selectionBackground: 'rgba(56,139,253,0.3)',
    ...DARK_ANSI, ...DARK_SCROLLBAR,
  },
  'dark-forest': {
    background: '#0c130d', foreground: '#e9f2e7',
    cursor: '#6fc28a', selectionBackground: 'rgba(111,194,138,0.3)',
    ...DARK_ANSI, ...DARK_SCROLLBAR,
  },
  'light': {
    background: '#ffffff', foreground: '#1f2328',
    cursor: '#0969da', selectionBackground: 'rgba(9,105,218,0.2)',
    scrollbarSliderBackground:       'rgba(0,0,0,0.35)',
    scrollbarSliderHoverBackground:  'rgba(0,0,0,0.55)',
    scrollbarSliderActiveBackground: 'rgba(0,0,0,0.70)',
    black: '#1f2328',    brightBlack: '#59636e',
    red: '#cf222e',      brightRed: '#a40e26',
    green: '#1a7f37',    brightGreen: '#22863a',
    yellow: '#9a6700',   brightYellow: '#7d4e00',
    blue: '#0969da',     brightBlue: '#0550ae',
    magenta: '#8250df',  brightMagenta: '#6639ba',
    cyan: '#1b7c83',     brightCyan: '#3192aa',
    white: '#d0d7de',    brightWhite: '#8c959f',  // NOT pure white — readable on light bg
  },
  'high-contrast': {
    // Match the app canvas (--bg-base #0a0c10) like every other theme, so the
    // pane's padding frame is seamless. White-on-#0a0c10 is still ~20:1 contrast.
    background: '#0a0c10', foreground: '#ffffff',
    cursor: '#71b7ff', selectionBackground: 'rgba(113,183,255,0.35)',
    ...DARK_SCROLLBAR,
    black: '#686868',   brightBlack: '#a0a0a0',
    red: '#ff6b66',     brightRed: '#ff9a94',
    green: '#56d364',   brightGreen: '#7ee787',
    yellow: '#e3b341',  brightYellow: '#f2cc60',
    blue: '#79c0ff',    brightBlue: '#a5d6ff',
    magenta: '#d2a8ff', brightMagenta: '#e2c5ff',
    cyan: '#56d4dd',    brightCyan: '#b3f0ff',
    white: '#e6edf3',   brightWhite: '#ffffff',
  },
}

function readXtermTheme(): ITheme {
  const id = typeof document !== 'undefined'
    ? (document.documentElement.getAttribute('data-theme') ?? 'dark-github')
    : 'dark-github'
  return XTERM_THEMES[id] ?? XTERM_THEMES['dark-github']
}

export interface SpawnOptions {
  command: string | string[]
  cwd: string
  env?: Record<string, string>
  agentKey?: string
  metadata?: Record<string, unknown>
  outputLogFile?: string  // if set, backend writes ANSI-stripped output to this path
  // Stable CLI session id (e.g. claude --session-id). Used as the reattach
  // persistence key so a PTY can be rebound after a reload — the paneId is
  // regenerated on restore and would never match. Falls back to paneId if absent.
  resumeKey?: string
  // True when the command resumes a prior session (reprints the conversation),
  // so the PTY must be created at the real measured width. A fresh spawn is
  // empty and may be created immediately even while hidden (see createWhenMeasurable).
  isResume?: boolean
  // If 'fresh', ignores the localStorage scrollback snapshot even if resuming.
  restoreMode?: 'memory-resume' | 'fresh'
  // If true, prevents reattaching to an existing PTY (useful for explicit rebuilds).
  skipReattach?: boolean
  // CLI account profile id for an isolated LOGIN pane: the backend runs the
  // CLI inside that profile's login home (see credential_vault login homes).
  loginProfileId?: string
}

/**
 * Encode the shared Shift+Enter UX for the active CLI's terminal protocol.
 *
 * There is no vendor-neutral byte sequence for a modified Enter key in a
 * traditional PTY. Codex understands the CSI-u representation, while Claude
 * Code's xterm.js terminal setup uses ESC+CR. Keep the user-facing shortcut
 * uniform and contain the protocol difference here.
 */
export function encodeShiftEnter(agentKey?: string): string {
  const key = agentKey?.toLowerCase()
  if (key === 'codex') return '\x1b[13;2u'
  // Claude, Grok, Antigravity, and Kimi all support bracketed paste.
  // Using bracketed paste LF guarantees a literal newline insertion without submitting.
  if (key === 'claude' || key === 'claude-code' || key === 'agy' || key === 'antigravity' || key === 'grok' || key === 'kimi') {
    return '\x1b[200~\n\x1b[201~'
  }
  // Plain shells (bash/zsh) treat \x1b\r as Enter and do not always have bracketed paste enabled.
  // Ctrl+V (\x16) + Ctrl+J (\x0a) is the standard way to insert a literal newline in readline/ZLE.
  return '\x16\x0a'
}

/** Clipboard bytes per `terminal.input` write, matching App.vue's injectText. */
const PASTE_CHUNK = 512

/** Set once the "hold ⌥ to select" hint has been shown — it teaches once.
 *  Goes through settings (backend-persisted) rather than localStorage, which
 *  this app has been migrating away from and which plugin bundles don't share. */
const OPTION_SELECT_HINT_KEY = 'agentTeam.terminal.optionSelectHintSeen'

/** Agents whose TUI keeps bracketed paste on — see pasteFromClipboard(). */
function agentUsesBracketedPaste(agentKey?: string): boolean {
  const key = agentKey?.toLowerCase()
  return key === 'claude' || key === 'claude-code' || key === 'agy' ||
    key === 'antigravity' || key === 'grok' || key === 'kimi' || key === 'codex'
}

// ── Edit > Copy bridge ──────────────────────────────────────────────────────
// Main cannot read an xterm selection (`.xterm` is user-select: none, so
// webContents.copy() sees nothing). Publish it on a global that Edit > Copy
// evaluates in the focused page (see TERMINAL_SELECTION_EXPRESSION in menu.ts).
// A global rather than an IPC listener on purpose: a page without one — no
// terminal mounted yet, or a plugin view on a different preload — yields '' and
// main falls back to its built-in copy, so Copy can never end up doing nothing.
//
// The FOCUSED pane answers. Keying off focus rather than "who has a selection"
// keeps a stale highlight in a background pane from hijacking a Copy aimed at
// the editor or a plain input.
let _focusOwner: Terminal | null = null
let _selectionGlobalInstalled = false

function installTerminalSelectionGlobal(): void {
  if (_selectionGlobalInstalled) return
  _selectionGlobalInstalled = true
  window.__navideTerminalSelection = () => {
    try {
      return _focusOwner?.getSelection() ?? ''
    } catch {
      return ''  // disposed terminal — let main run the built-in copy
    }
  }
}

export type TerminalStatus = 'idle' | 'starting' | 'running' | 'exited' | 'error' | 'stopped'

// The reattach key (`terminal-pty:<resumeKey>`) follows the CLI's session id,
// but a CLI rewrites its session id on every resume (claude --resume A records
// a NEW session B). Carry the live PTY id over to the rotated key — otherwise
// the next restore can't find the running PTY, spawns a second CLI, and the
// old one lingers detached until the backend janitor reaps it.
export function migrateTerminalPtyKey(oldKey: string, newKey: string): void {
  if (!oldKey || !newKey || oldKey === newKey) return
  try {
    const pty = localStorage.getItem(`terminal-pty:${oldKey}`)
    if (pty) {
      localStorage.setItem(`terminal-pty:${newKey}`, pty)
      localStorage.removeItem(`terminal-pty:${oldKey}`)
    }
  } catch { /* ignore */ }
}

// Cached dimensions from any visible terminal. Hidden tabs use these to start
// their PTY at the real layout size instead of xterm's 80x24 default: a PTY
// created too narrow makes the CLI draw its banner and footer narrow, and that
// already-printed output never widens again (static output can't re-wrap wider,
// and an idle alt-buffer TUI ignores the later SIGWINCH). Persisted so the
// spawns right after an app restart — a workspace restore fires them while
// every pane is still hidden — have a size to borrow as well.
const LAST_SIZE_KEY = 'terminal-last-size'
let _lastKnownCols = 0
let _lastKnownRows = 0
try {
  const raw = localStorage.getItem(LAST_SIZE_KEY)
  const parsed = raw ? (JSON.parse(raw) as { cols?: unknown; rows?: unknown }) : null
  if (typeof parsed?.cols === 'number' && typeof parsed?.rows === 'number'
      && parsed.cols > 0 && parsed.rows > 0) {
    _lastKnownCols = Math.trunc(parsed.cols)
    _lastKnownRows = Math.trunc(parsed.rows)
  }
} catch { /* no persisted size — the 80x24 fallback still applies */ }

// VS Code-style unix path regex (no extension whitelist).
const _EXCL_S = `[^\\x00<>?\\s!\`&*()[\\]'"\\\\;]`
const _EXCL   = `[^\\x00<>?\\s!\`&*()'"\\\\;]`
const FILE_LINK_RE = new RegExp(
  `((?:\\.{1,2}|~|(?:${_EXCL_S}${_EXCL}*))?(?:\\/${_EXCL}+)+)`,
  'g'
)

const _SUFFIX_RE = /(?::([\d]+)(?:[.:]([\d]+))?|[(\[]([\d]+)(?:[,:]([\d]+))?[)\]]|#([\d]+)(?::([\d]+))?)$/

function splitSuffix(raw: string): { filepath: string; line?: number } {
  const m = raw.match(_SUFFIX_RE)
  if (!m || m.index === undefined) return { filepath: raw }
  const lineStr = m[1] ?? m[3] ?? m[5]
  return { filepath: raw.slice(0, m.index), line: lineStr ? parseInt(lineStr, 10) : undefined }
}

// URLs are matched separately from file paths: raw terminal URLs are ASCII, so
// stopping at any non-ASCII naturally sheds CJK prose glued around them. The
// trailing punctuation the surrounding prose contributed (".", ",", ")") is
// trimmed off afterwards; closing brackets survive only while a matching
// opener exists inside the URL itself.
const URL_LINK_RE = /https?:\/\/[^\s<>"'`\u00A0-\uFFFF]+/gi
const _URL_TRAIL = new Set(['.', ',', ';', ':', '!', '?'])
const _URL_BRACKETS: Record<string, string> = { ')': '(', ']': '[', '}': '{' }
export function trimUrlTrailing(raw: string): string {
  let url = raw
  while (url.length) {
    const last = url[url.length - 1]
    if (_URL_TRAIL.has(last)) { url = url.slice(0, -1); continue }
    const open = _URL_BRACKETS[last]
    if (open) {
      const opens = url.split(open).length - 1
      const closes = url.split(last).length - 1
      if (closes > opens) { url = url.slice(0, -1); continue }
    }
    break
  }
  return url
}

// Scheme-less ("bare") domains like `leankoo.com`. Inherently guessy —
// `檔名.com` is also a valid filename — so the match is deliberately
// conservative; a false positive HIJACKS a click into the browser, so missing
// beats guessing on every axis:
//   • TLD allowlist holds only TLDs that are not plausible file extensions
//     (`deploy.sh`, `Electron.app`, `socket.io` must never linkify). Rarer
//     TLDs (io/dev/ai/…) linkify only with an explicit scheme or www. prefix.
//   • www. requires a dotted, TLD-shaped tail (`www.a` is prose, not a host).
//   • No path tail, and a following '/' kills the match: `leankoo.com/app/x.php`
//     is a relative file path (a checkout dir named after its domain) — the
//     pre-existing file-link pipeline can stat-verify it; a URL guess can't be
//     verified at all.
// The lookbehind keeps scheme URLs, path segments, and e-mail hosts from
// re-matching; the lookahead also rejects domain-shaped filenames
// (`index.com.js`) and prose glued after a port (`host:8080abc`).
const _BARE_TLDS = 'com|net|org|edu|gov|tw|jp'
const BARE_URL_RE = new RegExp(
  '(?<![A-Za-z0-9@.\\-/])' +
    `(?:www\\.[A-Za-z0-9-]+(?:\\.[A-Za-z0-9-]+)*\\.[A-Za-z]{2,}|[A-Za-z0-9-]+(?:\\.[A-Za-z0-9-]+)*\\.(?:${_BARE_TLDS}))` +
    '(?::\\d+)?' +
    '(?![A-Za-z0-9\\-/:]|\\.[A-Za-z0-9])',
  'gi'
)

type _AgentApi = {
  openEditorWindow?: (a: Record<string, unknown>) => Promise<unknown>
  openPlansWindow?: (a: { workspace_path: string; rel_path?: string }) => Promise<unknown>
}

// A plan doc reference embedded in CLI prose ("計畫已建立：.agent-team/plans/x.html
// （stage:…"). Extract just the ASCII plan rel-path, matching isHtmlPlanDoc's shape
// (top-level, non-'_' name under .agent-team/plans/). Because the class is
// ASCII-only, any surrounding CJK/full-width characters the FILE_LINK_RE swallowed
// are naturally shed. Returns the workspace-relative path, or undefined.
const _PLAN_DOC_RE = /\.agent-team\/plans\/[A-Za-z0-9.-][A-Za-z0-9._-]*\.html/
export function extractPlanDocRelPath(raw: string): string | undefined {
  return raw.match(_PLAN_DOC_RE)?.[0]
}

// Full-width CJK punctuation (（）、。：「」…) marks the seam between a CLI's
// CJK sentence and an embedded path ("報告書：foo/bar.html（說明）") — the
// path regex can't exclude it outright because CJK ideographs must stay legal
// path chars (Chinese filenames). Instead, candidates are re-cut here: split
// on punctuation, keep the piece that still has a '/'. Ideographs and CJK
// word characters (iteration marks U+3005-3007, Hangzhou numerals / kana
// repeat marks U+3021-302F and U+3031-303C, full-width alphanumerics U+FF10-FF19 / FF21-FF3A
// / FF41-FF5A) are never split on. Returns undefined when the string carries
// no such punctuation.
const _CJK_PUNCT_RE =
  /[\u3000-\u3004\u3008-\u3020\u3030\u303D-\u303F\uFF01-\uFF0F\uFF1A-\uFF20\uFF3B-\uFF40\uFF5B-\uFF65]+/
/** All '/'-containing pieces of `raw` after splitting on full-width CJK
 *  punctuation, with their offsets in `raw`. Empty when `raw` carries no such
 *  punctuation (caller keeps the raw token) or no piece has a '/'. */
export function shedCjkPieces(raw: string): Array<{ index: number; text: string }> {
  const re = new RegExp(_CJK_PUNCT_RE.source, 'g')
  const out: Array<{ index: number; text: string }> = []
  let last = 0
  let sawPunct = false
  let m: RegExpExecArray | null
  while ((m = re.exec(raw)) !== null) {
    sawPunct = true
    const t = raw.slice(last, m.index)
    if (t.includes('/')) out.push({ index: last, text: t })
    last = m.index + m[0].length
  }
  if (!sawPunct) return []
  const tail = raw.slice(last)
  if (tail.includes('/')) out.push({ index: last, text: tail })
  return out
}

/** The shed piece containing 0-based `pos` in `raw` — so a click on the
 *  second of two punctuation-joined paths ("結果:a.ts、b.ts" in full-width)
 *  sheds to THAT path — falling back to the first '/'-containing piece when
 *  `pos` sits on the punctuation/prose itself. Undefined when `raw` carries
 *  no full-width punctuation. */
export function shedCjkProse(raw: string, pos = -1): string | undefined {
  const pieces = shedCjkPieces(raw)
  if (!pieces.length) return undefined
  return (pieces.find((p) => pos >= p.index && pos < p.index + p.text.length) ?? pieces[0]).text
}

/** Route a stat-verified workspace-internal .html file to the Plan window's
 *  rendered preview (its non-plan-doc branch mounts FilePreviewPane): report
 *  files live outside `.agent-team/plans/` — loop reports, exported docs —
 *  and the mini-IDE would only show their raw source. Undefined for files
 *  outside the pane's workspace (no workspace to anchor the Plan window). */
export function htmlReportRoute(
  absPath: string,
  wsPath: string | undefined
): { workspace_path: string; rel_path: string } | undefined {
  if (!wsPath || !/\.html?$/i.test(absPath)) return undefined
  const root = wsPath.replace(/\/+$/, '')
  if (!absPath.startsWith(`${root}/`)) return undefined
  return { workspace_path: root, rel_path: absPath.slice(root.length + 1) }
}

/** Open a clicked path in the mini-IDE. Files inside the pane's workspace open
 *  as a workspace-relative path; files outside it keep `workspace_path` on the
 *  workspace and name their own root in `file_ws` (their parent directory), so
 *  the mini-IDE adds a tab instead of reloading onto a different workspace and
 *  losing every open tab. Without a pane workspace there is nothing to stay
 *  on, so the file's own directory becomes the workspace (previous behaviour). */
function openInEditor(absPath: string, line: number | undefined, workspacePath?: string): void {
  const api = (window as Window & { agentTeam?: _AgentApi }).agentTeam
  if (!api?.openEditorWindow) return
  const slash = absPath.lastIndexOf('/')
  const dir = slash > 0 ? absPath.slice(0, slash) : '/'
  const root = workspacePath?.replace(/\/+$/, '')
  const inWorkspace = !!root && absPath.startsWith(`${root}/`)
  void api.openEditorWindow({
    workspace_path: root || dir,
    filepath: inWorkspace ? absPath.slice(root.length + 1) : absPath.slice(slash + 1),
    ...(root && !inWorkspace ? { file_ws: dir } : {}),
    ...(line !== undefined ? { line } : {}),
  })
}

// '~/'-prefixed links (shell output loves them) resolve against the user's
// home directory: the expanded absolute form is used for stat/open, while the
// picker keeps displaying the '~' form. Home is fetched once over IPC and
// cached for the sync display path.
let _homeDir = ''
async function fetchHomeDir(): Promise<string> {
  if (_homeDir) return _homeDir
  try {
    const api = (window as Window & { agentTeam?: { getHomeDir?: () => Promise<string> } }).agentTeam
    _homeDir = (await api?.getHomeDir?.()) || ''
  } catch { /* ignore — '~' links just fall back to fuzzy search */ }
  return _homeDir
}

export function expandHomePath(fp: string, home: string): string {
  if (!home || (fp !== '~' && !fp.startsWith('~/'))) return fp
  return home.replace(/\/+$/, '') + fp.slice(1)
}

export function collapseHomePath(p: string, home: string): string {
  if (!home) return p
  const h = home.replace(/\/+$/, '')
  return p === h || p.startsWith(`${h}/`) ? `~${p.slice(h.length)}` : p
}

export interface PickerItem {
  abs: string
  name: string
  dir: string
}

/** Merge a click-resolved absolute path into the workspace-search results:
 *  pull it to the front if already present, insert it if absent. Only on the
 *  initial (basename) query — once the user types, plain results show. This is
 *  the sole way a file outside the workspace, or any file when the pane has no
 *  workspace to search, reaches the picker, so it must run even when the
 *  workspace search returned (or could not run) with nothing. */
export function mergePreferredPath(
  items: PickerItem[],
  preferredAbsPath: string | undefined,
  isInitialQuery: boolean
): PickerItem[] {
  if (!preferredAbsPath || !isInitialQuery) return items
  const idx = items.findIndex((item) => item.abs === preferredAbsPath)
  if (idx === 0) return items
  if (idx > 0) {
    const copy = items.slice()
    copy.unshift(copy.splice(idx, 1)[0])
    return copy
  }
  const parts = preferredAbsPath.split('/')
  const name = parts.pop() ?? preferredAbsPath
  return [{ abs: preferredAbsPath, name, dir: parts.join('/') }, ...items]
}

// A single character matching the FILE_LINK_RE path-body class (used to test
// whether a path-like token runs right up against a row boundary).
const _PATH_CHAR_RE = new RegExp(_EXCL)

// Content-boundary joining: a row only counts as pre-wrapped if no row within
// this window is more than this many chars longer than it — a pre-wrap break
// happens only where the CLI ran out of width, so a genuinely broken row must
// be about as long as the longest row nearby. Rows measurably shorter than a
// neighbour ended by content, not by the width limit (git's aligned
// `create mode …` output, ls -l, …), and joining them corrupts the path.
const _PREWRAP_WINDOW = 4
const _PREWRAP_SLACK = 8

// A wrapped logical line, reconstructed from two signals:
//   • xterm's `isWrapped` flag — authoritative for genuine terminal-width
//     wraps (works for any content).
//   • a content-boundary check — CLI TUIs (Claude Code, Codex, etc.) measure
//     the terminal themselves and pre-wrap their output with real newlines at
//     a width narrower than the pane, so isWrapped is never set and rows never
//     reach term.cols. We join a row to the previous one when the previous row
//     ends in a path char, this row's FIRST NON-GUTTER char is a path char,
//     and the previous row is about as long as the longest row nearby (only a
//     row that hit the width limit can be a genuine pre-wrap break — see
//     _PREWRAP_WINDOW / _PREWRAP_SLACK).
//     Continuation rows carry the block's gutter indent, so that leading
//     whitespace is stripped from fullText; `strips` records how much, keeping
//     buffer col ↔ fullText offset mapping exact.
// Joining is deliberately permissive — text alone cannot distinguish "one
// path wrapped across rows" from "two paths on adjacent rows"; the click
// handler resolves that ambiguity via fs.stat_path (see _cmdClickHandler).
// Shared by the hover/underline link provider and the click handler so both
// always agree on where a path starts/ends, even across multiple rows.
export interface WrappedLineGroup {
  groupStart: number // absolute buffer row where the group starts
  lineLengths: number[] // per-row contribution length in fullText (gutter stripped)
  strips: number[] // per-row count of leading gutter chars dropped from fullText
  fullText: string // concatenated text of every row in the group
  // fullText offsets where a content-heuristic (non-isWrapped) join occurred.
  // Paths may cross these (the click handler disambiguates via fs.stat_path);
  // URLs must not — an unverifiable URL absorbing the next row's prose would
  // open a wrong address, so URL matching treats these as hard breaks.
  heuristicBreaks: number[]
}

// A line made of nothing but box-drawing glyphs and spaces — the frame of a
// CLI's bottom input widget (╭──╮ / ╰──╯). At least one box char is required so
// a plain blank line isn't matched here (blanks are handled separately).
const BOX_ONLY_LINE_RE = /^[\s─-╿]*[─-╿][\s─-╿]*$/

/** Serialize the RENDERED scrollback (what the user actually sees) as text.
 *  Unlike the raw-stream cleanBuffer, TUI repaints overwrite buffer lines in
 *  place, so a status footer that repaints 1000 times appears once here.
 *  Walks backwards from the cursor row, drops the trailing blank / box-only
 *  frame lines, takes at most `maxLines` rows and returns them oldest→newest.
 *  READ-ONLY: never mutates the terminal. */
/** Text of the cursor's row up to the cursor column. Module-level (like
 *  serializeRenderedBuffer) so tests can drive it with a buffer fixture. */
export function readBufferLineBeforeCursor(term: import('@xterm/xterm').Terminal): string {
  const buf = term.buffer.active
  const line = buf.getLine(buf.baseY + buf.cursorY)?.translateToString(true) ?? ''
  return line.slice(0, buf.cursorX)
}

export function serializeRenderedBuffer(term: import('@xterm/xterm').Terminal, maxLines: number): string {
  const buffer = term.buffer.active
  const lines: string[] = []
  let inTrailingTail = true
  for (let i = buffer.baseY + buffer.cursorY; i >= 0 && lines.length < maxLines; i--) {
    const text = buffer.getLine(i)?.translateToString(true) ?? ''
    if (inTrailingTail) {
      if (!text.trim() || BOX_ONLY_LINE_RE.test(text)) continue
      inTrailingTail = false
    }
    lines.push(text)
  }
  lines.reverse()
  return lines.join('\n')
}

// Approximate rendered cell width of a string: CJK/full-width glyphs and
// non-BMP glyphs (emoji) take two cells, everything else one. Mirrors the
// wide ranges xterm's Unicode service treats as width 2 closely enough for
// the pre-wrap width comparisons; exactness is not required there (slack 8).
const _WIDE_CH_RE = /[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFF60\uFFE0-\uFFE6]/
export function visualWidth(s: string): number {
  let w = 0
  for (const ch of s) w += ch.length > 1 || _WIDE_CH_RE.test(ch) ? 2 : 1
  return w
}

export function getWrappedLineGroup(term: import('@xterm/xterm').Terminal, bufferRow: number): WrappedLineGroup {
  const buffer = term.buffer.active
  const lineTextAt = (r: number): string | null => {
    const ln = buffer.getLine(r)
    return ln ? ln.translateToString(true) : null
  }
  const leadingWs = (s: string): number => s.length - s.trimStart().length
  // Whether row `r` could have been broken by the CLI's width limit: no row
  // within the window is measurably longer than it. Lengths are VISUAL cell
  // widths, not string lengths — the CLI wraps by cells, and a CJK-heavy row
  // near the width limit holds roughly half the string characters of an ASCII
  // row, so string-length comparison wrongly rejects the join for CJK paths.
  const nearWidthLimit = (r: number): boolean => {
    const len = visualWidth(lineTextAt(r) ?? '')
    for (let i = r - _PREWRAP_WINDOW; i <= r + _PREWRAP_WINDOW; i++) {
      if (i !== r && visualWidth(lineTextAt(i) ?? '') > len + _PREWRAP_SLACK) return false
    }
    return true
  }
  // Whether row `r` is a continuation of row `r - 1`.
  const continuesFromPrev = (r: number): boolean => {
    if (r <= 0) return false
    if (buffer.getLine(r)?.isWrapped) return true
    const cur = lineTextAt(r)
    const prev = lineTextAt(r - 1)
    if (!cur || !prev) return false
    return (
      _PATH_CHAR_RE.test(prev[prev.length - 1]) &&
      _PATH_CHAR_RE.test(cur[leadingWs(cur)]) &&
      nearWidthLimit(r - 1)
    )
  }

  let groupStart = bufferRow
  for (let steps = 0; steps < 8 && groupStart > 0 && continuesFromPrev(groupStart); steps++) {
    groupStart--
  }

  const lineLengths: number[] = []
  const strips: number[] = []
  const heuristicBreaks: number[] = []
  let fullText = ''
  for (let r = groupStart, steps = 0; steps < 16; r++, steps++) {
    const lineText = lineTextAt(r)
    if (lineText === null) break
    // True xterm wraps keep their cells verbatim; only pre-wrapped (CLI-drawn)
    // continuations have a gutter indent to strip.
    const strip = r === groupStart || buffer.getLine(r)?.isWrapped ? 0 : leadingWs(lineText)
    strips.push(strip)
    lineLengths.push(lineText.length - strip)
    fullText += lineText.slice(strip)
    if (!continuesFromPrev(r + 1)) break
    if (!buffer.getLine(r + 1)?.isWrapped) heuristicBreaks.push(fullText.length)
  }

  return { groupStart, lineLengths, strips, fullText, heuristicBreaks }
}

/** Convert a 0-based offset into `group.fullText` back to an absolute buffer row/col. */
export function groupPosToRowCol(group: WrappedLineGroup, pos: number): { row: number; col: number } {
  let remaining = pos
  for (let i = 0; i < group.lineLengths.length; i++) {
    const len = group.lineLengths[i]
    if (i === group.lineLengths.length - 1 || remaining < len) {
      return { row: group.groupStart + i, col: remaining + group.strips[i] }
    }
    remaining -= len
  }
  return { row: group.groupStart, col: pos }
}

/** Convert an absolute buffer row/col to a 0-based offset into `group.fullText`,
 *  or -1 when the position falls outside the row's contributed text (in the
 *  stripped gutter, or right of the trimmed content). */
export function groupRowColToPos(group: WrappedLineGroup, bufferRow: number, col: number): number {
  const rowInGroup = bufferRow - group.groupStart
  if (rowInGroup < 0 || rowInGroup >= group.lineLengths.length) return -1
  const inRow = col - group.strips[rowInGroup]
  if (inRow < 0 || inRow >= group.lineLengths[rowInGroup]) return -1
  let pos = inRow
  for (let i = 0; i < rowInGroup; i++) pos += group.lineLengths[i]
  return pos
}

// Cell column ↔ translateToString offset for one buffer row. Two corrections
// (same pair as VS Code's convertLinkRangeToBuffer):
//   • a double-width glyph (CJK) occupies two cells but one string position —
//     translateToString emits nothing for the width-0 trailing half-cell;
//   • a multi-code-unit glyph (emoji, surrogate pairs) occupies one glyph cell
//     but getChars().length string positions.
// (VS Code's third term — the empty spacer cell a wide glyph leaves when it
// early-wraps at the row edge — needs no handling here: per-row lengths come
// from the trimmed translateToString, so the spacer is trailing whitespace
// that already maps past the row's content.) Identity when the line surface
// lacks getCell (unit-test mocks); pure-ASCII rows map 1:1.
export function cellColToStrCol(
  term: import('@xterm/xterm').Terminal,
  bufferRow: number,
  cellCol: number
): number {
  const line = term.buffer.active.getLine(bufferRow)
  if (!line || typeof line.getCell !== 'function') return cellCol
  let str = 0
  let glyphStart = 0
  for (let x = 0; x <= cellCol && x < line.length; x++) {
    const cell = line.getCell(x)
    if (!cell) break
    if (cell.getWidth() === 0) continue // trailing half-cell → previous glyph
    glyphStart = str
    str += Math.max(1, cell.getChars().length)
  }
  return glyphStart
}

export function strColToCellCol(
  term: import('@xterm/xterm').Terminal,
  bufferRow: number,
  strCol: number
): number {
  const line = term.buffer.active.getLine(bufferRow)
  if (!line || typeof line.getCell !== 'function') return strCol
  let str = 0
  for (let x = 0; x < line.length; x++) {
    const cell = line.getCell(x)
    if (!cell) break
    if (cell.getWidth() === 0) continue
    const len = Math.max(1, cell.getChars().length)
    if (strCol < str + len) return x // strCol falls inside this glyph
    str += len
  }
  return strCol
}

/** The FILE_LINK_RE match containing 0-based `pos` in `text`, or null. */
export function findFileLinkMatchAt(text: string, pos: number): { text: string; index: number } | null {
  if (pos < 0) return null
  FILE_LINK_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = FILE_LINK_RE.exec(text)) !== null) {
    if (m[0].includes('://')) continue
    if (pos >= m.index && pos < m.index + m[0].length) return { text: m[0], index: m.index }
  }
  return null
}

export function findFileLinkAt(text: string, pos: number): string | null {
  return findFileLinkMatchAt(text, pos)?.text ?? null
}

/** Whole-tail candidate for paths whose folder names contain characters the
 *  path regex must exclude — spaces and half-width parens ("看護媒合平台 (1)")
 *  truncate the regex match mid-path. From the FIRST rooted ('/' or '~') path
 *  start at/before `pos`, the entire remaining logical line is offered as one
 *  candidate; fs.stat arbitrates, so a line with trailing prose simply fails
 *  through to the precise regex-match candidates. */
export function rootedTailCandidate(
  text: string,
  pos: number
): { index: number; text: string } | undefined {
  FILE_LINK_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = FILE_LINK_RE.exec(text)) !== null) {
    if (m[0].includes('://')) continue
    // The rooted start may hide inside a CJK-prefixed match
    // ("報告存放在：/Users/…") — shed pieces recover the '/'-anchored piece.
    let root = -1
    if (m[0][0] === '/' || m[0][0] === '~') root = m.index
    else {
      const piece = shedCjkPieces(m[0]).find((p) => p.text[0] === '/' || p.text[0] === '~')
      if (piece) root = m.index + piece.index
    }
    if (root < 0) continue
    if (root > pos) return undefined
    return { index: root, text: text.slice(root).trimEnd() }
  }
  return undefined
}

export interface UrlMatch {
  index: number
  text: string // the visible span (what gets underlined)
  href: string // what openExternal receives — bare domains get https:// prefixed
}

/** Every URL in `text` — scheme URLs plus conservative bare domains —
 *  trailing punctuation trimmed. `breaks` (fullText offsets of heuristic row
 *  joins, see WrappedLineGroup.heuristicBreaks) are hard boundaries a URL
 *  never crosses. Shared by the link provider and the click handler so the
 *  underline range and the click hitbox always agree. */
export function findUrlMatches(text: string, breaks: number[] = []): UrlMatch[] {
  const bounds = [0, ...breaks.filter((b) => b > 0 && b < text.length), text.length]
  const out: UrlMatch[] = []
  // When a scheme URL runs into a heuristic break, the next segment's head is
  // that URL's severed tail ("https://lean" | "koo.com/x") — it must not
  // re-match as a standalone bare domain on a different host.
  let prevSegCapped = false
  for (let i = 0; i < bounds.length - 1; i++) {
    const seg = text.slice(bounds[i], bounds[i + 1])
    const segOut: UrlMatch[] = []
    let capped = false
    let m: RegExpExecArray | null
    URL_LINK_RE.lastIndex = 0
    while ((m = URL_LINK_RE.exec(seg)) !== null) {
      const trimmed = trimUrlTrailing(m[0])
      segOut.push({ index: bounds[i] + m.index, text: trimmed, href: trimmed })
      if (m.index + m[0].length === seg.length) capped = true
    }
    BARE_URL_RE.lastIndex = 0
    while ((m = BARE_URL_RE.exec(seg)) !== null) {
      if (m.index === 0 && prevSegCapped) continue
      const trimmed = trimUrlTrailing(m[0])
      const start = bounds[i] + m.index
      const end = start + trimmed.length
      if (segOut.some((u) => start < u.index + u.text.length && end > u.index)) continue
      segOut.push({ index: start, text: trimmed, href: `https://${trimmed}` })
    }
    segOut.sort((a, b) => a.index - b.index)
    out.push(...segOut)
    prevSegCapped = capped
  }
  return out
}

/** The URL match containing 0-based `pos` in `text` (trailing punctuation
 *  already trimmed), or null. */
export function findUrlLinkMatchAt(text: string, pos: number, breaks: number[] = []): UrlMatch | null {
  if (pos < 0) return null
  return findUrlMatches(text, breaks).find((u) => pos >= u.index && pos < u.index + u.text.length) ?? null
}

/** Split a fullText regex match back into per-path pieces at row boundaries
 *  where the next row starts a fresh absolute path ('/' or '~'). List output
 *  (find, ls) puts one path per row; joining glues adjacent paths into one
 *  regex match, but a wrapped path's continuation fragment essentially never
 *  begins with '/', while a NEW path on the next row does — so those
 *  boundaries are where distinct paths meet. */
export function splitMatchAtRowStarts(
  group: WrappedLineGroup,
  matchIndex: number,
  matchText: string
): Array<{ index: number; text: string }> {
  const end = matchIndex + matchText.length
  const cuts: number[] = []
  let boundary = 0
  for (let i = 0; i < group.lineLengths.length - 1; i++) {
    boundary += group.lineLengths[i] // start offset of row i+1's contribution
    if (boundary <= matchIndex || boundary >= end) continue
    const c = group.fullText[boundary]
    if (c === '/' || c === '~') cuts.push(boundary)
  }
  const pieces: Array<{ index: number; text: string }> = []
  let start = matchIndex
  for (const cut of [...cuts, end]) {
    pieces.push({ index: start, text: group.fullText.slice(start, cut) })
    start = cut
  }
  return pieces
}

function buildFileLinkProvider(
  term: import('@xterm/xterm').Terminal,
  isCmdHeld: () => boolean
): import('@xterm/xterm').ILinkProvider {
  return {
    provideLinks(y, callback) {
      if (!isCmdHeld()) { callback(undefined); return }
      const group = getWrappedLineGroup(term, y - 1)
      const links: import('@xterm/xterm').ILink[] = []

      // groupPosToRowCol yields string columns; xterm ranges are cell columns,
      // and the two diverge after any double-width (CJK) glyph on the row.
      const pushLink = (index: number, text: string): void => {
        const start = groupPosToRowCol(group, index)
        const end = groupPosToRowCol(group, index + text.length - 1)
        links.push({
          range: {
            start: { x: strColToCellCol(term, start.row, start.col) + 1, y: start.row + 1 },
            end: { x: strColToCellCol(term, end.row, end.col) + 1, y: end.row + 1 },
          },
          text,
          decorations: { underline: true, pointerCursor: true },
          activate: () => { /* click handled by _cmdClickHandler */ },
        })
      }

      // URLs first — their path segment would otherwise also match
      // FILE_LINK_RE, so file matches overlapping a URL range are skipped.
      const urls = findUrlMatches(group.fullText, group.heuristicBreaks)
      for (const u of urls) pushLink(u.index, u.text)

      FILE_LINK_RE.lastIndex = 0
      let m: RegExpExecArray | null
      while ((m = FILE_LINK_RE.exec(group.fullText)) !== null) {
        if (m[0].includes('://')) continue
        const s = m.index
        const e = m.index + m[0].length
        if (urls.some((u) => s < u.index + u.text.length && e > u.index)) continue
        for (const piece of splitMatchAtRowStarts(group, m.index, m[0])) {
          // Underline each punctuation-shed span (two paths joined by 、 get
          // two underlines), matching what a click would open; clicks on the
          // shed prose still hit-test the raw match.
          const shed = shedCjkPieces(piece.text)
          if (!shed.length) pushLink(piece.index, piece.text)
          else for (const s of shed) pushLink(piece.index + s.index, s.text)
        }
      }
      callback(links.length ? links : undefined)
    },
  }
}

interface UseTerminalOptions {
  workspacePath?: string
  onClear?: () => void
  onUserResume?: () => void
  /** Getter for the OTHER CLI panes' messaging names (already excluding self).
   *  Feeds the @-mention autocomplete menu. Read lazily at trigger time so the
   *  list stays current as panes come and go. */
  mentionCandidates?: () => string[]
  onFirstOutput?: () => void
}

// Throttle for RESUME spawns' terminal.create across all panes. A session
// restore (App.vue restores panes with Promise.all) or a multi-pane layout can
// fire N resume spawns at once, and each does serial pre-ack work on the
// backend's single event-loop thread: a login-shell PATH refresh, a CLI probe
// (up to 8s), a synchronous PTY fork, an attribution scan. Letting all N hit at
// once stacks that work and pushes later acks past the request deadline
// ("request terminal.create timeout" → pane setup failed). This module-level
// semaphore caps how many resume creates are in flight (rest queue) so the
// backend drains them in small batches; the cap is user-configurable
// (getResumeConcurrency, default 3). Fresh spawns are light and stay
// unthrottled — throttling them too would stall pipeline stages spawned into
// background tabs. Acquired BEFORE send() so queue-wait doesn't count against
// the per-request timeout. Orthogonal to each composable's own `_creating` lock.
// Raised from wsClient's 10s default: the backend's near-8s CLI probe plus PTY
// fork and attribution scan is legitimately heavier than an average request, so
// 10s was too tight even for a single healthy spawn.
let _resumeSpawnActive = 0
const _resumeSpawnWaiters: Array<() => void> = []

async function acquireResumeSpawnSlot(): Promise<void> {
  // Cap read live at acquire time so a Settings change takes effect immediately.
  if (_resumeSpawnActive < getResumeConcurrency()) {
    _resumeSpawnActive++
    return
  }
  // Wait; releaseResumeSpawnSlot hands us the slot (count stays put).
  await new Promise<void>((resolve) => _resumeSpawnWaiters.push(resolve))
}

function releaseResumeSpawnSlot(): void {
  const next = _resumeSpawnWaiters.shift()
  if (next) next()  // pass the baton: our slot goes to the next waiter
  else _resumeSpawnActive--
}

export function useTerminal(paneId: string, backend: ReturnType<typeof useBackend>, opts?: UseTerminalOptions) {
  installTerminalZoomShortcuts()
  installTerminalSelectionGlobal()

  const term = new Terminal({
    // Option+drag forces normal text selection even while a TUI has mouse
    // reporting on (vim/htop/tmux/less). Without it, xterm's macOS branch of
    // shouldForceSelection() is `altKey && macOptionClickForcesSelection`, so
    // it is permanently false and there is NO way to select terminal text once
    // a CLI enables mouse tracking — the Shift+drag escape hatch other
    // platforms get is macOS-excluded. Trade-off: this disables Option+drag
    // column selection on macOS (xterm binds both to the same gesture and
    // makes them mutually exclusive); Navide never surfaced column select.
    macOptionClickForcesSelection: true,
    fontFamily: 'Menlo, Monaco, "Courier New", monospace',
    // Seeded from the shared size so a pane spawned after a zoom matches the rest.
    fontSize: terminalFontSize.value,
    cursorBlink: true,
    convertEol: false,
    scrollback: 10000,
    // Auto-lift any low-contrast text (e.g. a TUI's dimmed/faint prompt that
    // renders as near-background grey) to a readable foreground. We can't
    // recolor a CLI's alt-buffer output directly, but this WCAG-AAA ratio forces
    // xterm to nudge unreadable fg/bg pairs into legibility across all panes.
    minimumContrastRatio: 7,
    theme: readXtermTheme(),
    // Required for `term.unicode` below — the unicode API is still a proposed
    // API in xterm 6; without this flag its getter throws at setup time and
    // the whole pane renders blank.
    allowProposedApi: true
  })
  const fit = new FitAddon()
  term.loadAddon(fit)
  // Unicode 11 width tables (VS Code parity: unicodeVersion defaults to "11").
  // xterm's built-in tables are Unicode 6; agent CLIs measure display width
  // with newer Unicode (string-width), so emoji/symbol widths disagree and
  // mid-line input repaints land at the wrong column (overlapping text).
  term.loadAddon(new Unicode11Addon())
  term.unicode.activeVersion = '11'

  term.onResize(({ cols, rows }) => {
    if (cols > 0 && rows > 0) {
      _lastKnownCols = cols
      _lastKnownRows = rows
      try { localStorage.setItem(LAST_SIZE_KEY, JSON.stringify({ cols, rows })) } catch { /* ignore */ }
    }
  })

  const containerRef = shallowRef<HTMLElement | null>(null)
  const status = ref<TerminalStatus>('idle')
  const sessionId = ref<string>('')
  const error = ref<string>('')
  const lastCommand = ref<string>('')
  const isAltBuffer = ref(false)
  let isDisposed = false
  let activeAgentKey: string | undefined

  // ── "hold ⌥ to select" hint ────────────────────────────────────────────────
  // Once a CLI turns mouse reporting on, a plain drag is forwarded to the
  // process and highlights nothing; the force-selection modifier is the only
  // way out (see macOptionClickForcesSelection above). Nothing on screen says
  // so, so teach it the first time a drag visibly does nothing.
  const optionSelectHint = ref(false)
  let _hintDragX = -1
  let _hintDragY = -1
  let _hintTimer: ReturnType<typeof setTimeout> | null = null

  function maybeShowOptionSelectHint(e: MouseEvent): void {
    if (_hintDragX < 0 || optionSelectHint.value) return
    if (Math.abs(e.clientX - _hintDragX) + Math.abs(e.clientY - _hintDragY) < 12) return
    _hintDragX = -1  // one shot per drag
    if (settingsGet(OPTION_SELECT_HINT_KEY, false)) return
    settingsSet(OPTION_SELECT_HINT_KEY, true)
    optionSelectHint.value = true
    _hintTimer = setTimeout(() => { optionSelectHint.value = false }, 6000)
  }
  let activeCrashKey = ''

  // Rolling ANSI-stripped text accumulator used by the pipeline orchestrator
  // to detect stage sentinels and QUESTION blocks. Capped at ~128KB to keep
  // memory predictable across long-running panes.
  const cleanBuffer = ref<string>('')
  const cleanBytesSeen = ref(0)
  // `lastActivityAt` only updates when CLEANED text changes — i.e. real content.
  // Used for analyzer triggers and sentinel scans.
  const lastActivityAt = ref<number>(0)
  // `lastRawActivityAt` updates on ANY non-empty PTY chunk including TUI
  // spinners / status-bar redraws / animated progress glyphs. Used by the
  // idle-stall safety net so a long-thinking agent that's still visibly
  // alive on screen isn't mistaken for a wedged process.
  const lastRawActivityAt = ref<number>(0)
  // When the user clicks/focuses the pane, Claude TUI redraws its status bar
  // & cursor. After ANSI/noise stripping some clean bytes still arrive, which
  // would flip the idle/running badge back to "running" even though the
  // agent isn't actually working. We suppress lastActivityAt updates for a
  // short window after a focus event so the badge stays honest.
  const lastFocusAt = ref<number>(0)
  const FOCUS_GRACE_MS = 3_000
  // Wheel events forwarded to the PTY (alt buffer + mouse tracking, see the
  // custom wheel handler in mount()) make the TUI repaint a SHIFTED viewport.
  // That repaint is real content lines, so noise-stripping keeps it, and it is
  // reassembled/reflowed (often from history already past the replay tail), so
  // isRedrawReplay can't recognize it either — a sustained scroll used to
  // latch the RUNNING badge. Output landing inside this window after a
  // forwarded wheel event is excluded from burst/latch tracking and the
  // activity clock; each wheel notch re-arms the window.
  const lastScrollAt = ref<number>(0)
  const SCROLL_GRACE_MS = 1_000

  // ── RUNNING vs IDLE ──────────────────────────────────────────────────────────
  // We want RUNNING only when the CLI is genuinely executing — not for brief
  // nudges, TUI redraws, or prompt echoes that last a second or two.
  //
  // The design is deliberately ASYMMETRIC: entering RUNNING is strict, leaving
  // it is slow (hysteresis). Entry still needs a CONTINUOUS burst of clean
  // output lasting MIN_BURST_MS, so short nudge responses never qualify. Exit
  // needs IDLE_CONFIRM_MS of clean silence, because an agent running a tool
  // call goes quiet for many seconds at a time and must not flicker to idle.
  //
  // INVARIANT: BURST_GAP_MS > MIN_BURST_MS. If the gap that splits two bursts
  // were shorter than the time a burst must last, chunky output landing in
  // between would reset the burst start before it could ever reach the
  // threshold — a dead zone where the badge stays idle forever.
  //
  // The PTY stream is the primary source; the only external signal involved is
  // the CLI's own turn_complete (see markTurnComplete), which lets the badge
  // drop to idle early instead of waiting out IDLE_CONFIRM_MS.
  const BURST_GAP_MS      = 3_000    // gap that splits two separate bursts
  const MIN_BURST_MS      = 2_000    // burst must last this long to ENTER running
  const IDLE_CONFIRM_MS   = 10_000   // clean silence required to LEAVE running
  const activityBurstStartAt = ref<number>(0)
  // Clean-content activity clock for the RUNNING badge (see appendClean). Kept
  // separate from lastRawActivityAt so an idle CLI that only repaints its
  // footer/cursor (raw bytes, but empty after noise-stripping) can't keep the
  // badge stuck on RUNNING.
  const lastCleanBurstAt = ref<number>(0)
  // Hysteresis latch: entering RUNNING is strict (a burst must last
  // MIN_BURST_MS), but leaving it is deliberately slow — an agent running a
  // tool call goes quiet for seconds at a time and must not flicker back to
  // idle. Once latched, only IDLE_CONFIRM_MS of clean silence (or an
  // authoritative turn_complete) clears it.
  const runningLatched = ref(false)
  // Authoritative turn end from the CLI's own log (agent.activity
  // turn_complete), fed in by App.vue. Lets claude/copilot drop to idle
  // immediately instead of waiting out IDLE_CONFIRM_MS.
  const turnCompleteAt = ref<number>(0)
  // Tick so displayStatus re-evaluates after output goes quiet.
  const nowTick = ref<number>(Date.now())
  const tickInterval = window.setInterval(() => { nowTick.value = Date.now() }, 1_000)

  // Starts when spawn() enters the raw STARTING state, before any reattach,
  // layout, or resume-semaphore wait. App uses this to unlock recovery at the
  // same deadline as terminal.create itself.
  const startingStartedAt = ref<number | null>(null)
  const startingAgeMs = computed<number | null>(() => (
    status.value === 'starting' && startingStartedAt.value != null
      ? Math.max(0, nowTick.value - startingStartedAt.value)
      : null
  ))

  const isStopped = ref(false)

  const displayStatus = computed<string>(() => {
    if (status.value === 'exited' || status.value === 'error') return status.value
    if (isStopped.value) return 'stopped'
    // A resume parked for a hidden tab hasn't created its PTY yet — a resumed
    // agent comes up idle, so show 'idle' instead of a stuck 'starting' in the
    // agent list until the tab is shown. (Fresh spawns create immediately, so
    // their brief parked window keeps the normal status.)
    if (pendingSpawn.value?.isResume) return 'idle'
    if (status.value !== 'running') return status.value
    // Spawned but not a single byte of output yet — the CLI is still booting
    // (Gemini stays silent ~5s during auth/init). Show "starting", not "idle".
    // Any byte (even a pure TUI repaint) means the CLI is up, so this gates
    // "booting" only.
    if (lastRawActivityAt.value === 0) return 'starting'
    // RUNNING/idle is judged on CLEANED activity, not raw bytes: an idle CLI
    // repainting its footer/cursor emits raw bytes but no clean content, so it
    // goes idle after IDLE_CONFIRM_MS instead of sticking on RUNNING.
    //
    // Authoritative turn end wins — but only while no newer clean output has
    // arrived. A trailing chunk that lands after the event pushes
    // lastCleanBurstAt past it and falls through to the hysteresis path.
    //
    // runningLatched is the ONLY entry into RUNNING. The MIN_BURST_MS test
    // lives entirely in appendClean, which is the only place that knows output
    // is still arriving. Do not re-add a burst-age check here: measured from a
    // computed it just counts wall time since the burst started, so a single
    // clean chunk would light the badge 2 s later and hold it until the
    // IDLE_CONFIRM_MS timeout. The timeout below stays because silence never
    // calls appendClean, so nothing else can drop the latch.
    if (turnCompleteAt.value > lastCleanBurstAt.value) return 'idle'
    if (nowTick.value - lastCleanBurstAt.value > IDLE_CONFIRM_MS) return 'idle'
    return runningLatched.value ? 'running' : 'idle'
  })
  const BUFFER_CAP = 128 * 1024
  const redrawGuard = createRedrawGuard()

  function appendClean(chunk: string): void {
    // ANY byte counts as "process still alive" — spinners included. This feeds
    // liveness/stall detection (App.vue safety net, resize-quiet gate) ONLY. It
    // deliberately does NOT drive the RUNNING badge: an idle CLI that merely
    // repaints its footer/cursor emits raw bytes too, and those must not look
    // like work. The badge burst is built from CLEANED content below.
    if (chunk.length > 0) lastRawActivityAt.value = Date.now()
    const cleaned = dropTuiNoise(stripAnsi(chunk))
    if (!cleaned) return
    // A focus/resize repaint re-emits content already on screen; after noise
    // stripping it looks like fresh output and would flip the badge to RUNNING
    // for a mere click/resize. Drop replays here — the raw-activity clock above
    // already marked the process alive, but a replay must not build a burst or
    // double the buffer. Genuinely new content isn't a replay and falls through.
    if (redrawGuard.isReplay(cleaned)) return
    // Badge burst tracking, driven by CLEANED content only. Output inside the
    // scroll grace window is a shifted-viewport repaint the replay check above
    // can't recognize — it must neither build a burst nor drop/raise the
    // latch. Unlike the focus grace below, this must gate the LATCH, not just
    // the activity clock: the latch update is what flips the badge. Bytes are
    // still kept (buffer/liveness) so genuine output isn't lost; a latched
    // RUNNING simply coasts through the scroll on hysteresis.
    const now = Date.now()
    const inScrollGrace = now - lastScrollAt.value < SCROLL_GRACE_MS
    if (!inScrollGrace) {
      const sinceLastClean = now - lastCleanBurstAt.value
      // Silence past the confirm window ends the run: drop the latch so the next
      // burst has to re-earn RUNNING rather than resuming it on a single byte.
      if (sinceLastClean > IDLE_CONFIRM_MS) runningLatched.value = false
      // A gap > BURST_GAP_MS in clean output starts a new burst.
      if (sinceLastClean > BURST_GAP_MS) activityBurstStartAt.value = now
      lastCleanBurstAt.value = now
      if (!runningLatched.value && now - activityBurstStartAt.value >= MIN_BURST_MS) {
        runningLatched.value = true
      }
    }
    // Monotonic total — unlike cleanBuffer.length, this keeps growing after
    // the buffer hits BUFFER_CAP, so quiet-detection (waitForQuiet etc.) can
    // tell "still streaming" from "quiet" during large session replays.
    cleanBytesSeen.value += cleaned.length
    // Trim lazily. `a + b` is a rope in V8 and costs nothing, but bufferTail's
    // slice flattens it — so trimming on every chunk charged ~30µs per chunk
    // once the buffer sat at cap, however small the chunk was. At 20 chunks per
    // keystroke (macOS splits a PTY read at 1KB) that tax dominated the whole
    // output path. Trimming only at twice the cap amortises it to ~nothing per
    // chunk; the buffer now drifts between BUFFER_CAP and 2x it, which no
    // consumer depends on — App.vue already treats cleanBuffer.length as
    // unreliable past the cap and uses cleanBytesSeen for progress.
    const next = cleanBuffer.value + cleaned
    cleanBuffer.value = next.length > BUFFER_CAP * 2 ? bufferTail(next, BUFFER_CAP) : next
    redrawGuard.accept(cleaned)
    // Skip the activity timestamp if this chunk arrived inside the focus
    // grace window — those bytes are very likely a focus-triggered TUI
    // redraw, not real agent output. Buffer content is still kept so any
    // genuine output isn't lost; only the timestamp is held back.
    const inFocusGrace = now - lastFocusAt.value < FOCUS_GRACE_MS
    if (!inFocusGrace && !inScrollGrace) lastActivityAt.value = now
  }

  /** Authoritative turn end from the CLI's own conversation log. Drops the
   *  hysteresis latch so the badge goes idle now instead of waiting out
   *  IDLE_CONFIRM_MS. Only vendors whose log reader emits turn_complete reach
   *  here: claude/codex/copilot/aider (which also carry the turn text) and kimi
   *  (turn_complete without text). The rest fall back to the silence timeout —
   *  qwen/pi/cursor emit agent_active only, and antigravity/grok/opencode/kilo
   *  emit neither (no parse_activity override). */
  function markTurnComplete(): void {
    turnCompleteAt.value = Date.now()
    runningLatched.value = false
  }

  function markBufferPosition(): number {
    return cleanBuffer.value.length
  }

  /** Retroactively scrub TUI noise from the existing buffer — useful when
   *  the noise-filter rules change (HMR) or a watcher arms on an old pane. */
  function recleanBuffer(): void {
    cleanBuffer.value = dropTuiNoise(cleanBuffer.value)
    redrawGuard.reset(cleanBuffer.value)
  }

  /** Tail of the RENDERED scrollback — the text the user sees on screen. The
   *  right source for sharing a pane's content (context paste / AI-Chat chip):
   *  cleanBuffer's tail is dominated by TUI status-footer repaints. */
  function readRenderedText(maxLines: number): string {
    return serializeRenderedBuffer(term, maxLines)
  }

  /** Cursor-row text up to the cursor column. Used by the pane-drop handler
   *  to detect an "@" typed right before the drop (mention mode: insert just
   *  the source pane's messaging name, not its scrollback). */
  function readLineBeforeCursor(): string {
    return readBufferLineBeforeCursor(term)
  }

  // ── @-mention floating autocomplete ──────────────────────────────────────────
  // Imperative-DOM overlay (mirrors showTerminalFilePicker) listing the OTHER CLI
  // panes' messaging names. It steals DOM focus to its own card AND handles keys
  // at the document capture layer, so ↑/↓/Enter/Esc never reach xterm while open.
  // Picking a name sends `name + ' '` straight to the PTY, completing `@codex-1 `.
  let _mentionMenuCleanup: (() => void) | null = null

  function closeMentionMenu(): void {
    if (_mentionMenuCleanup) {
      const fn = _mentionMenuCleanup
      _mentionMenuCleanup = null
      fn()
    }
  }

  function openMentionMenu(candidates: string[]): void {
    if (_mentionMenuCleanup) return          // one menu at a time
    if (!candidates.length) return           // nothing to offer
    const host = mountedEl
    const screen = host?.querySelector('.xterm-screen') as HTMLElement | null
    if (!screen) return
    const rect = screen.getBoundingClientRect()
    const cellW = (term as any)._core?._renderService?.dimensions?.css?.cell?.width || 0
    const cellH = (term as any)._core?._renderService?.dimensions?.css?.cell?.height || 0
    if (!cellW || !cellH) return
    const buf = term.buffer.active
    // buf.cursorX / buf.cursorY are viewport-relative (cursorY counts rows from
    // the top of the visible area), matching the .xterm-screen rect origin.
    const cellLeft = rect.left + buf.cursorX * cellW
    const cellTop = rect.top + buf.cursorY * cellH
    const cellBottom = cellTop + cellH

    const root = document.createElement('div')
    root.className = 'term-mention-menu-root'
    Object.assign(root.style, {
      position: 'fixed', inset: '0', zIndex: '99999', background: 'transparent',
    })

    const card = document.createElement('div')
    card.tabIndex = 0
    Object.assign(card.style, {
      position: 'fixed', left: `${cellLeft}px`, top: `${cellBottom}px`,
      width: '200px', maxHeight: '240px', overflowY: 'auto',
      background: '#161b22', border: '1px solid #30363d', borderRadius: '6px',
      boxShadow: '0 8px 24px rgba(0,0,0,0.6)', outline: 'none',
      padding: '4px 0', boxSizing: 'border-box',
    })

    let selectedIdx = 0
    const rows: HTMLElement[] = []

    function renderSelection(): void {
      rows.forEach((row, i) => {
        row.style.background = i === selectedIdx ? 'rgba(56,139,253,0.2)' : ''
      })
      rows[selectedIdx]?.scrollIntoView({ block: 'nearest' })
    }

    function pick(idx: number): void {
      const name = candidates[idx]
      closeMentionMenu()
      term.focus()
      if (name) {
        void backend.send('terminal.input', {
          terminal_session_id: sessionId.value,
          data: name + ' ',
        })
      }
    }

    candidates.forEach((name, i) => {
      const row = document.createElement('div')
      row.textContent = name
      Object.assign(row.style, {
        padding: '6px 12px', cursor: 'pointer', color: '#e6edf3', fontSize: '13px',
        whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
      })
      row.addEventListener('mouseenter', () => { selectedIdx = i; renderSelection() })
      row.addEventListener('mousedown', (e) => { e.preventDefault(); pick(i) })
      rows.push(row)
      card.appendChild(row)
    })

    root.appendChild(card)
    document.body.appendChild(root)

    // Clamp to the viewport now that the card has a measured size.
    const cardRect = card.getBoundingClientRect()
    let left = cellLeft
    let top = cellBottom
    if (left + cardRect.width > window.innerWidth) left = window.innerWidth - cardRect.width - 8
    if (left < 4) left = 4
    if (top + cardRect.height > window.innerHeight) top = cellTop - cardRect.height  // flip above
    if (top < 4) top = 4
    card.style.left = `${left}px`
    card.style.top = `${top}px`

    // Document-capture keydown: intercept the menu's keys before xterm's textarea
    // can see them (capture phase + stopPropagation), so the CLI receives nothing
    // while the menu is open. Any other printable key / Backspace dismisses the
    // menu and is re-sent to the PTY so typing continues uninterrupted.
    const onDocKeydown = (e: KeyboardEvent): void => {
      // IME guard, same contract as the xterm handler below: while a
      // composition is live, e.key is a raw pre-edit keystroke ('ㄒ', 'j',
      // Enter to pick a candidate), NOT committed text. Forwarding it to the
      // PTY here both mangled the input and stole the Enter/Backspace the IME
      // needed, so composing in a pane with the mention menu open produced
      // garbage. Let the browser drive the composition; the committed text
      // arrives through term.onData like any other input.
      if (e.isComposing || e.keyCode === 229) return
      if (e.key === 'ArrowDown') {
        e.preventDefault(); e.stopPropagation()
        if (selectedIdx < candidates.length - 1) { selectedIdx++; renderSelection() }
      } else if (e.key === 'ArrowUp') {
        e.preventDefault(); e.stopPropagation()
        if (selectedIdx > 0) { selectedIdx--; renderSelection() }
      } else if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault(); e.stopPropagation()
        pick(selectedIdx)
      } else if (e.key === 'Escape') {
        e.preventDefault(); e.stopPropagation()
        closeMentionMenu(); term.focus()
      } else if (e.metaKey || e.ctrlKey || e.altKey) {
        // A shortcut chord (Cmd+A, etc.) — cancel the menu but let the chord
        // through rather than mangling it into a literal PTY keystroke. Refocus
        // the terminal so the chord (e.g. Cmd+V paste) lands there and typing
        // continues — closing the focused card would otherwise drop focus to
        // <body>, swallowing the chord and every keystroke after it.
        closeMentionMenu(); term.focus()
      } else if (e.key === 'Backspace') {
        e.preventDefault(); e.stopPropagation()
        closeMentionMenu(); term.focus()
        void backend.send('terminal.input', { terminal_session_id: sessionId.value, data: '\x7f' })
      } else if (e.key.length === 1) {
        e.preventDefault(); e.stopPropagation()
        closeMentionMenu(); term.focus()
        void backend.send('terminal.input', { terminal_session_id: sessionId.value, data: e.key })
      }
    }

    root.addEventListener('mousedown', (e) => { if (e.target === root) { closeMentionMenu(); term.focus() } })
    card.addEventListener('blur', () => closeMentionMenu())
    document.addEventListener('keydown', onDocKeydown, true)

    _mentionMenuCleanup = (): void => {
      document.removeEventListener('keydown', onDocKeydown, true)
      root.remove()
    }

    renderSelection()
    card.focus()
  }

  let inputDisposer: { dispose(): void } | null = null
  let outputUnsub: (() => void) | null = null
  let exitUnsub: (() => void) | null = null
  let firstOutputSeen = false
  // Pending terminal output coalescing. The focused pane flushes immediately
  // on arrival — keystroke echo must not wait for a frame (worst for IME
  // input, where the whole commit waits on it). Unfocused panes coalesce
  // writes for _BACKGROUND_COALESCE_MS so a streaming background agent does
  // not starve the pane the user is typing in of main-thread time. (A timer,
  // not rAF: rAF is paused in packaged Electron when the window is occluded,
  // which would leave output stuck in _pendingOutput.)
  const _BACKGROUND_COALESCE_MS = 100
  let _pendingOutput = ''
  let _outputTimer: ReturnType<typeof setTimeout> | null = null

  function _flushPendingOutput(): void {
    if (_outputTimer) { clearTimeout(_outputTimer); _outputTimer = null }
    const chunk = _pendingOutput
    _pendingOutput = ''
    if (!chunk) return
    const onFirstOutput = !firstOutputSeen ? opts?.onFirstOutput : undefined
    firstOutputSeen = true
    term.write(chunk, onFirstOutput)
    appendClean(chunk)
    appendToScrollBuffer(chunk)
  }
  let mounted = false
  let mountedEl: HTMLElement | null = null
  let _mousedownHandler: ((e: MouseEvent) => void) | null = null
  let _cmdKeyDown: ((e: KeyboardEvent) => void) | null = null
  let _cmdKeyUp: ((e: KeyboardEvent) => void) | null = null
  let _cmdClickHandler: ((e: MouseEvent) => void) | null = null
  let _mousePosTracker: ((e: MouseEvent) => void) | null = null
  let _pasteHandler: ((e: ClipboardEvent) => void) | null = null
  // Whether THIS pane's xterm textarea currently holds focus. Used to publish
  // the `terminalFocus` keybinding context (defaults.ts gates editor shortcuts
  // like cmd+f on `!terminalFocus`) and to clear it if the pane is disposed
  // while focused. Focus moving between two panes is safe: blur (old pane,
  // sets false) always fires before focus (new pane, sets true).
  let _ownsTerminalFocus = false
  // Set when the textarea lost focus only because the whole window did (cmd+tab,
  // clicking another app). Chromium fires a textarea blur in that case even
  // though focus never moved to another element in this document. Treating that
  // as "lost focus" would drop this pane's echo into the 100ms coalesced path —
  // and strand it there whenever the window returns without handing focus back
  // to the textarea, so every later keystroke echoes a frame late.
  let _blurredWithWindow = false
  // Every path that concludes "this pane no longer holds focus" goes through
  // here, so Edit > Copy ownership can never outlive the keybinding context —
  // a stale owner would answer Copy with an old selection and suppress main's
  // fallback for good.
  const _releaseTerminalFocus = (): void => {
    _ownsTerminalFocus = false
    if (_focusOwner === term) _focusOwner = null
    setContext('terminalFocus', false)
  }
  const _onTermFocus = (): void => {
    _blurredWithWindow = false
    _ownsTerminalFocus = true
    _focusOwner = term  // answers Edit > Copy for this window
    setContext('terminalFocus', true)
  }
  const _onTermBlur = (): void => {
    // A blur that came with the whole window losing focus is not a focus
    // change — keep owning Edit > Copy, since reaching the menu bar causes it.
    if (!document.hasFocus()) { _blurredWithWindow = true; return }
    _blurredWithWindow = false
    _releaseTerminalFocus()
  }
  // Runs in every mounted pane, but the _blurredWithWindow guard means only the
  // one that actually held focus reacts — panes never fight over it.
  const _onWindowFocus = (): void => {
    if (!_blurredWithWindow) return
    _blurredWithWindow = false
    const active = document.activeElement
    if (!active || active === document.body) {
      // Nothing claimed focus while we were away; take it back so typing lands
      // in the terminal the user left off in. focus() is a no-op on an element
      // that stopped being rendered while the window was away (pane hidden by a
      // layout change), so verify rather than assert focus we never received.
      term.focus()
      if (document.activeElement !== term.textarea) _releaseTerminalFocus()
    } else if (active !== term.textarea) {
      _releaseTerminalFocus()
    }
  }

  // xterm's CompositionHelper latches on compositionstart and only unlatches on
  // compositionend — which macOS does not reliably deliver when the user
  // switches input method mid-composition. While latched, its keydown() returns
  // early for keyCode 229, so every subsequent IME keystroke is swallowed and
  // piles up in the hidden textarea until some non-IME key forces a flush. That
  // is the "typed for seconds, then everything appears at once" symptom.
  //
  // Only reads the helper's public surface (isComposing getter, compositionend
  // method), and is optional-chained so an xterm upgrade that relocates it
  // degrades to today's behaviour rather than breaking input entirely.
  type CompositionHelperLike = { isComposing: boolean, compositionend: () => void }
  function finalizeStaleComposition(): void {
    const helper = (term as unknown as { _core?: { _compositionHelper?: CompositionHelperLike } })
      ._core?._compositionHelper
    if (!helper?.isComposing) return
    // waitForPropagation: the deferred path sends substring(start) — everything
    // to the end of the textarea — so the pending text is committed whole. The
    // immediate path would use a `end` offset that compositionupdate stopped
    // refreshing when the composition went stale, truncating the commit.
    helper.compositionend()
  }

  // Set when a reattached pane is waiting to repaint. We never force_redraw at
  // reattach time: the renderer is mid-reflow then (reload, or a hidden tab
  // being shown), so the width is transient and would repaint the live agent
  // narrow. The reconciler fires the redraw only once container == xterm ==
  // backend, so Claude's TUI clears the transient frame and repaints at the real
  // width instead of stranding a narrow one in scrollback.
  let pendingReattachRedraw = false

  // Declared here (assigned after createWhenMeasurable is defined below) so the
  // reconciler interval and other async closures can reference it safely.
  // eslint-disable-next-line prefer-const
  let resizeCtrl!: ResizeController

  // Self-healing size reconciler. A pane that spawns or resizes while hidden
  // (background tab / spotlight / minimized → display:none) can leave the PTY
  // and xterm at different sizes — the CLI then draws its TUI for one width
  // while xterm renders another, corrupting the layout and cursor position.
  // Every tick: refit if the container disagrees with xterm, re-send if the
  // backend may disagree with xterm. Heals any missed resize within seconds.
  const RECONCILE_MS = 2_000
  const reconcileInterval = window.setInterval(() => {
    if (!mounted) return
    isAltBuffer.value = term.buffer.active.type === 'alternate'
    // A spawn parked while hidden creates as soon as the pane is measurable.
    if (pendingSpawn.value) { void createWhenMeasurable(); return }
    if (!sessionId.value) return
    const el = containerRef.value
    if (!el || el.clientWidth === 0) return  // hidden — nothing to reconcile yet
    const dims = fit.proposeDimensions()
    const sized = !!dims && Number.isFinite(dims.cols) && Number.isFinite(dims.rows)
    if (sized && (dims.cols !== term.cols || dims.rows !== term.rows)) {
      resizeCtrl.applyFit()
      return
    }
    if (term.cols !== resizeCtrl.ackedCols || term.rows !== resizeCtrl.ackedRows) {
      resizeCtrl.sendResizeNow()
      return
    }
    // Fully settled (container == xterm == backend-acked). A reattached pane that
    // has been waiting now repaints at this stable width — a no-op resize won't
    // raise SIGWINCH, so nudge the agent explicitly via force_redraw.
    if (sized && pendingReattachRedraw) {
      pendingReattachRedraw = false
      void backend.send('terminal.reattach', {
        terminal_session_ids: [sessionId.value],
        cols: term.cols,
        rows: term.rows,
      })
    }
  }, RECONCILE_MS)

  function mount(el: HTMLElement): void {
    containerRef.value = el
    term.open(el)

    // xterm 6 ships only the DOM renderer, which rewrites a row of DOM nodes
    // per write. That is the dominant cost of typing latency: a CLI repaints
    // its viewport on every keystroke, and each repaint lands as several
    // writes. WebGL moves the drawing to the GPU. Load AFTER open() — the
    // addon attaches its canvas to the already-created element — and drop back
    // to the DOM renderer on context loss (GPU reset, driver recovery) rather
    // than leaving a dead canvas in place.
    try {
      const webgl = new WebglAddon()
      webgl.onContextLoss(() => { webgl.dispose() })
      term.loadAddon(webgl)
    } catch (err) {
      // No usable WebGL (software rendering, blacklisted driver). The DOM
      // renderer stays active; the pane is slower but fully functional.
      console.warn('[terminal] WebGL renderer unavailable, using DOM renderer', err)
    }

    // Publish terminal focus to the keybinding context (see _onTermFocus doc).
    term.textarea?.addEventListener('focus', _onTermFocus)
    term.textarea?.addEventListener('blur', _onTermBlur)
    window.addEventListener('focus', _onWindowFocus)

    // Anchor for Shift+Arrow keyboard selection
    let selAnchorX = -1
    let selAnchorY = -1

    // Intercept wheel events to scroll xterm's scrollback buffer.
    // Prevents xterm's alternateScroll mode from converting trackpad swipes
    // into arrow-key escape codes that navigate readline history.
    let scrollRemainder = 0
    term.attachCustomWheelEventHandler((e: WheelEvent) => {
      // Alternate buffer = TUI app (Claude Code, Codex, etc.) is active.
      // Only forward wheel events to the PTY when the app actually enabled
      // mouse tracking (vim, htop, ...). Without mouse tracking, xterm's
      // alternateScroll fallback converts each wheel notch into an ↑/↓ arrow
      // escape sequence, which agent CLIs interpret as readline history
      // recall — scrolling up would pull the previous submitted prompt into
      // the input line. Swallow the event instead (scrollLines is a no-op in
      // alt buffer, so there is nothing else useful to do with it).
      if (term.buffer.active.type === 'alternate') {
        const forward = term.modes.mouseTrackingMode !== 'none'
        // A forwarded wheel event triggers a shifted-viewport repaint that
        // must not read as agent work — arm the scroll grace (see appendClean).
        if (forward) lastScrollAt.value = Date.now()
        return forward
      }
      // Main buffer: accumulate pixel-delta for smooth trackpad scrollback.
      // deltaY units depend on deltaMode: LINE → lines, PAGE → pages, PIXEL →
      // pixels. PAGE mode (some mice / accessibility settings) reports ~1 per
      // notch; without this branch it fell through to the pixel /3 path and
      // scrolled ~0.3 line per notch (effectively stuck).
      let delta: number
      if (e.deltaMode === WheelEvent.DOM_DELTA_LINE) delta = e.deltaY
      else if (e.deltaMode === WheelEvent.DOM_DELTA_PAGE) delta = e.deltaY * term.rows
      else delta = e.deltaY / 3
      scrollRemainder += delta
      const lines = Math.trunc(scrollRemainder)
      scrollRemainder -= lines
      if (lines !== 0) term.scrollLines(lines)
      return false
    })

    term.attachCustomKeyEventHandler((e: KeyboardEvent) => {
      if (e.type !== 'keydown') return true
      // A keyCode 229 that the browser does not consider part of a composition,
      // while xterm still believes one is running, is only reachable once the
      // helper has gone stale: a genuine first IME keystroke arrives before
      // compositionstart (xterm still false), and a genuine in-flight one
      // reports composing on both sides. Unlatch before xterm swallows this key.
      if (e.keyCode === 229 && !e.isComposing) finalizeStaleComposition()
      // IME guard: allow the browser to process composition (e.g. Zhuyin/Pinyin)
      if (e.isComposing) return true

      const buf = term.buffer.active
      const curX = buf.cursorX
      const curY = buf.baseY + buf.cursorY

      // ── Shift/Ctrl/Cmd+Enter: newline without submitting ──────────────────
      // Traditional PTYs do not preserve modifiers on Enter, so encode the
      // chord for the active agent's input protocol (CSI-u for Codex, bracketed
      // paste for modern TUIs, Ctrl+V for bash).
      //
      // Cmd+Enter is free everywhere: macOS never delivers it to a PTY. Ctrl+
      // Enter is NOT — a plain shell receives it as a bare Enter and runs the
      // command, so claiming it is limited to agent panes, where the CLI's own
      // prompt is the thing being edited.
      const isAgentPane = !!activeAgentKey && activeAgentKey !== 'terminal'
      const newlineChord =
        (e.shiftKey && !e.metaKey && !e.altKey && !e.ctrlKey) ||
        (isAgentPane && e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey) ||
        (e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey)
      if (newlineChord && e.key === 'Enter') {
        e.preventDefault()
        e.stopPropagation()
        pasteText(encodeShiftEnter(activeAgentKey))
        return false
      }

      // Every branch below that sends bytes itself and returns false MUST also
      // call e.preventDefault(): returning false only stops xterm's handling,
      // not the browser default. Without it the hidden helper-textarea caret
      // moves away from the end of its value, and xterm's CompositionHelper
      // (which anchors compositions at value.length) then commits stale text
      // on the next IME input.

      // ── Shift+←/→: extend selection character by character ────────────────
      if (e.shiftKey && !e.metaKey && !e.altKey && !e.ctrlKey &&
          (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
        e.preventDefault()
        if (selAnchorX < 0) { selAnchorX = curX; selAnchorY = curY }
        const newX = e.key === 'ArrowLeft' ? Math.max(0, curX - 1) : Math.min(term.cols - 1, curX + 1)
        const len = Math.abs(selAnchorX - newX)
        if (len > 0) term.select(Math.min(selAnchorX, newX), selAnchorY, len)
        else term.clearSelection()
        pasteText(e.key === 'ArrowLeft' ? '\x1b[D' : '\x1b[C')
        return false
      }

      // ── Cmd+Shift+←: select to beginning of line ──────────────────────────
      if (e.metaKey && e.shiftKey && e.key === 'ArrowLeft') {
        e.preventDefault()
        if (selAnchorX < 0) { selAnchorX = curX; selAnchorY = curY }
        if (curX > 0) term.select(0, curY, curX)
        else term.clearSelection()
        pasteText('\x01')
        return false
      }

      // ── Cmd+Shift+→: select to end of line ────────────────────────────────
      if (e.metaKey && e.shiftKey && e.key === 'ArrowRight') {
        e.preventDefault()
        if (selAnchorX < 0) { selAnchorX = curX; selAnchorY = curY }
        const line = buf.getLine(curY)
        const lineEnd = line ? line.translateToString(true).length : term.cols
        const endX = Math.max(lineEnd, curX)
        if (endX > curX) term.select(curX, curY, endX - curX)
        else term.clearSelection()
        pasteText('\x05')
        return false
      }

      // ── Delete/Backspace with active selection: delete the selected region ───
      if (selAnchorX >= 0 && (e.key === 'Backspace' || e.key === 'Delete') &&
          !e.metaKey && !e.altKey) {
        e.preventDefault()
        const count = Math.abs(curX - selAnchorX)
        if (count > 0) {
          // cursor right of anchor → backspace; cursor left → forward-delete
          pasteText(curX > selAnchorX ? '\x7f'.repeat(count) : '\x1b[3~'.repeat(count))
        }
        selAnchorX = -1; selAnchorY = -1
        term.clearSelection()
        return false
      }

      // ── Clear selection for all other keys (except copy/select-all/etc) ────
      const keepForCmd = e.metaKey && 'cavz'.includes(e.key.toLowerCase())
      const isModifierOnly = ['Shift', 'Control', 'Alt', 'Meta'].includes(e.key)
      if (!keepForCmd && !isModifierOnly) {
        selAnchorX = -1
        selAnchorY = -1
        term.clearSelection()
      }

      // ── Cmd+C: copy the terminal's selection ──────────────────────────────
      // xterm's own copy handler fires on the DOM `copy` event, which needs a
      // DOM selection — but `.xterm` is `user-select: none` (xterm.css), so a
      // terminal selection never becomes one and Cmd+C silently copied
      // nothing. Write xterm's own selection out instead. With no selection,
      // fall through untouched so Cmd+C keeps its current (no-op) behaviour.
      if (e.metaKey && !e.shiftKey && !e.altKey && !e.ctrlKey && e.key.toLowerCase() === 'c') {
        const selection = term.getSelection()
        if (selection) {
          e.preventDefault()
          void navigator.clipboard.writeText(selection)
          return false
        }
      }

      // Font zoom (⌘+ / ⌘- / ⌘= / ⌘0) is NOT handled here: it applies to every
      // pane at once and must work regardless of which terminal holds focus, so
      // it lives on a window-level listener (see useTerminalFontSize).

      // ── macOS cursor shortcuts (no Shift) ──────────────────────────────────
      if (e.metaKey && !e.shiftKey && e.key === 'Backspace')  { e.preventDefault(); pasteText('\x15'); return false }
      if (e.metaKey && !e.shiftKey && e.key === 'ArrowLeft')  { e.preventDefault(); pasteText('\x01'); return false }
      if (e.metaKey && !e.shiftKey && e.key === 'ArrowRight') { e.preventDefault(); pasteText('\x05'); return false }
      if (e.altKey  && !e.shiftKey && e.key === 'Backspace')  { e.preventDefault(); pasteText('\x17'); return false }

      // App reserves Ctrl+1..9 for CLI quick-select (see keybindings/defaults).
      // The central dispatcher normally consumes them, but if it misses (e.g. an
      // IME reports a non-digit `e.key`) they must never leak into the PTY. Match
      // on the physical key so the guard holds regardless of layout/IME.
      if (e.ctrlKey && !e.metaKey && !e.altKey && /^(Digit|Numpad)[1-9]$/.test(e.code)) {
        e.preventDefault()
        return false
      }
      return true
    })
    // Make the whole pane click-focusable so the user can type immediately.
    el.tabIndex = 0
    el.style.cursor = 'text'
    _mousedownHandler = (e: MouseEvent) => {
      // A drag that starts without the force-selection modifier while the CLI
      // has mouse reporting on will select nothing — arm the hint (fired from
      // the mousemove tracker below, once the drag is unmistakable).
      _hintDragX = !e.altKey && !e.shiftKey && term.modes.mouseTrackingMode !== 'none' ? e.clientX : -1
      _hintDragY = e.clientY
      // Record click moment too — Claude TUI redraws on focus regardless of
      // which path got us there.
      lastFocusAt.value = Date.now()
      try {
        term.focus()
      } catch {
        /* ignore */
      }
    }
    el.addEventListener('mousedown', _mousedownHandler)

    // Intercept ⌘V / right-click Paste before xterm's own textarea handler —
    // see pasteFromClipboard() for why xterm's version truncates multi-line
    // pastes here. Capture phase so the event never reaches the textarea.
    _pasteHandler = (e: ClipboardEvent) => {
      if (e.target !== term.textarea) return
      const text = e.clipboardData?.getData('text/plain')
      if (!text) return
      e.preventDefault()
      e.stopPropagation()
      // xterm's paste path clears the helper textarea; the right-click handler
      // fills it with the selection, so skipping that would leave stale text
      // for CompositionHelper (which anchors IME input at value.length).
      if (term.textarea) term.textarea.value = ''
      pasteFromClipboard(text)
      // pasteFromClipboard drops the visible selection; the keyboard-selection
      // anchor has to go with it. ⌘V is on the keepForCmd list below, so it
      // survives the key handler — and a stale anchor makes the next Backspace
      // take the "delete the selection" branch and emit a burst of deletes.
      selAnchorX = -1
      selAnchorY = -1
    }
    el.addEventListener('paste', _pasteHandler, true)

    // ── Cmd+Click file search overlay ────────────────────────────────────────
    let _isCmdHeld = false
    let _lastMX = 0
    let _lastMY = 0

    _mousePosTracker = (e: MouseEvent) => {
      _lastMX = e.clientX
      _lastMY = e.clientY
      // Disarm as soon as the button is up, so a drag that began outside this
      // element (or ended below the threshold) cannot fire the hint later.
      if (e.buttons === 1) maybeShowOptionSelectHint(e)
      else _hintDragX = -1
    }
    el.addEventListener('mousemove', _mousePosTracker)

    _cmdKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Meta' || _isCmdHeld) return
      _isCmdHeld = true
      el.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: _lastMX, clientY: _lastMY, metaKey: true }))
    }
    _cmdKeyUp = (e: KeyboardEvent) => {
      if (e.key !== 'Meta') return
      _isCmdHeld = false
      el.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: _lastMX, clientY: _lastMY }))
    }
    window.addEventListener('keydown', _cmdKeyDown)
    window.addEventListener('keyup', _cmdKeyUp)

    term.registerLinkProvider(buildFileLinkProvider(term, () => _isCmdHeld))

    function showTerminalFilePicker(
      initialQuery: string,
      lineNum: number | undefined,
      preferredAbsPath?: string,
      displayText?: string
    ): void {
      document.querySelector('.term-file-picker-root')?.remove()
      const wsPath = opts?.workspacePath

      const root = document.createElement('div')
      root.className = 'term-file-picker-root'
      Object.assign(root.style, {
        position: 'fixed', inset: '0', zIndex: '99999',
        display: 'flex', alignItems: 'flex-start', justifyContent: 'center',
        paddingTop: '80px', background: 'rgba(0,0,0,0.35)',
      })

      const card = document.createElement('div')
      Object.assign(card.style, {
        background: '#161b22', border: '1px solid #30363d', borderRadius: '8px',
        width: '560px', maxHeight: '420px', display: 'flex', flexDirection: 'column',
        boxShadow: '0 16px 48px rgba(0,0,0,0.8)', overflow: 'hidden',
      })

      const pickerInput = document.createElement('input')
      // Show the full clicked path in the box for context, but the actual search
      // (see doSearch) still queries by basename — the backend only substring-
      // matches filenames, not full relative paths.
      pickerInput.value = displayText ?? initialQuery
      pickerInput.placeholder = 'Search files...'
      Object.assign(pickerInput.style, {
        background: 'transparent', border: 'none', borderBottom: '1px solid #21262d',
        color: '#e6edf3', fontSize: '14px', padding: '12px 16px', outline: 'none',
        fontFamily: 'inherit', width: '100%', boxSizing: 'border-box',
      })

      const itemList = document.createElement('div')
      Object.assign(itemList.style, { overflowY: 'auto', flex: '1' })

      card.appendChild(pickerInput)
      card.appendChild(itemList)
      root.appendChild(card)
      document.body.appendChild(root)

      let currentItems: PickerItem[] = []
      let selectedIdx = 0
      let debounceTimer: ReturnType<typeof setTimeout>
      // Distinguishes "still looking" from "nothing matched" in the empty
      // state, so the picker is never a silent blank while the backend works.
      let searchPending = true

      function renderList(): void {
        itemList.innerHTML = ''
        if (!currentItems.length) {
          const msg = document.createElement('div')
          msg.textContent = searchPending ? 'Searching…' : 'No files found'
          Object.assign(msg.style, { padding: '10px 16px', color: '#6e7681', fontSize: '12px' })
          itemList.appendChild(msg)
          return
        }
        currentItems.forEach((item, i) => {
          const row = document.createElement('div')
          Object.assign(row.style, {
            padding: '7px 16px', cursor: 'pointer',
            display: 'flex', gap: '10px', alignItems: 'baseline',
            background: i === selectedIdx ? 'rgba(56,139,253,0.2)' : '',
          })
          const nameSpan = document.createElement('span')
          nameSpan.textContent = item.name
          Object.assign(nameSpan.style, { color: '#e6edf3', fontSize: '13px' })
          const dirSpan = document.createElement('span')
          dirSpan.textContent = collapseHomePath(item.dir, _homeDir) || '/'
          Object.assign(dirSpan.style, { color: '#8b949e', fontSize: '11px' })
          row.appendChild(nameSpan)
          row.appendChild(dirSpan)
          row.addEventListener('mouseenter', () => { selectedIdx = i; renderList() })
          row.addEventListener('mousedown', (e) => { e.preventDefault(); close(); openInEditor(item.abs, lineNum, wsPath) })
          itemList.appendChild(row)
        })
      }

      // ESC closes the picker no matter where focus went — a click on the card,
      // or xterm's hidden textarea grabbing focus back, used to leave ESC dead
      // because it was bound to the input alone. Listen at the document capture
      // layer for the picker's lifetime and detach on close.
      const onDocKeydown = (e: KeyboardEvent): void => {
        if (e.key === 'Escape') { e.stopPropagation(); e.preventDefault(); close() }
      }
      function close(): void {
        clearTimeout(debounceTimer)
        document.removeEventListener('keydown', onDocKeydown, true)
        root.remove()
      }

      async function doSearch(q: string): Promise<void> {
        searchPending = true
        // Workspace substring search — only possible when this pane has a
        // workspace and the user typed something. When it can't run, results
        // stay empty but the click-resolved path below still surfaces.
        let items: PickerItem[] = []
        if (q.trim() && wsPath) {
          try {
            const r = await backend.send<{ files: string[] }>('fs.list_files_flat', {
              workspace_path: wsPath, query: q, max_results: 20,
            })
            items = (r.ok && r.payload?.files ? r.payload.files : []).map((rel) => {
              const parts = rel.split('/')
              const name = parts.pop() ?? rel
              return { abs: `${wsPath}/${rel}`, name, dir: parts.join('/') }
            })
          } catch { items = [] }
        }
        // Surface the click-resolved absolute path (pre-selected) even when the
        // search couldn't run (no workspace) or didn't include it (file outside
        // the workspace) — otherwise a verified-existing file shows as missing.
        currentItems = mergePreferredPath(items, preferredAbsPath, q === initialQuery)
        searchPending = false
        selectedIdx = 0
        renderList()
      }

      pickerInput.addEventListener('input', () => {
        clearTimeout(debounceTimer)
        debounceTimer = setTimeout(() => void doSearch(pickerInput.value), 150)
      })

      pickerInput.addEventListener('keydown', (e: KeyboardEvent) => {
        if (e.key === 'ArrowDown') {
          e.preventDefault()
          if (selectedIdx < currentItems.length - 1) { selectedIdx++; renderList() }
        } else if (e.key === 'ArrowUp') {
          e.preventDefault()
          if (selectedIdx > 0) { selectedIdx--; renderList() }
        } else if (e.key === 'Enter') {
          e.preventDefault()
          const item = currentItems[selectedIdx]
          if (item) { close(); openInEditor(item.abs, lineNum, wsPath) }
        }
      })

      root.addEventListener('mousedown', (e) => { if (e.target === root) close() })
      document.addEventListener('keydown', onDocKeydown, true)
      pickerInput.focus()
      pickerInput.select()
      renderList() // show 'Searching…' immediately, never a silent blank list
      void doSearch(initialQuery)
    }

    _cmdClickHandler = (event: MouseEvent) => {
      if (!event.metaKey || event.button !== 0) return
      const xtermScreen = el.querySelector('.xterm-screen')
      if (!xtermScreen) return
      const rect = xtermScreen.getBoundingClientRect()
      const cellW = (term as any)._core?._renderService?.dimensions?.css?.cell?.width || 0
      const cellH = (term as any)._core?._renderService?.dimensions?.css?.cell?.height || 0
      if (!cellW || !cellH) return
      const col = Math.floor((event.clientX - rect.left) / cellW)
      const row = Math.floor((event.clientY - rect.top) / cellH)
      if (col < 0 || row < 0 || col >= term.cols || row >= term.rows) return
      const bufferRow = term.buffer.active.viewportY + row
      const group = getWrappedLineGroup(term, bufferRow)
      // The click lands on a cell; the group's text positions are string
      // offsets, which drift apart after any double-width (CJK) glyph.
      const strCol = cellColToStrCol(term, bufferRow, col)
      const clickPos = groupRowColToPos(group, bufferRow, strCol)

      // A URL under the click routes straight to the default browser — checked
      // before file paths, since a URL's path segment also matches FILE_LINK_RE.
      const urlMatch = findUrlLinkMatchAt(group.fullText, clickPos, group.heuristicBreaks)
      const openExternal = window.agentTeam?.openExternal
      if (urlMatch && openExternal) {
        event.preventDefault()
        event.stopPropagation()
        void openExternal(urlMatch.href)
        return
      }

      const match = findFileLinkMatchAt(group.fullText, clickPos)
      if (!match) return
      event.preventDefault()
      event.stopPropagation()

      // A find/ls block glues every adjacent path into one regex match; the
      // piece under the click (split at rows that start a fresh '/' path) is
      // the most likely reading. Fall back to the whole match (a path that
      // happened to wrap right before a '/') and the clicked row's own token,
      // letting the filesystem pick whichever actually exists.
      const piece = splitMatchAtRowStarts(group, match.index, match.text)
        .find((p) => clickPos >= p.index && clickPos < p.index + p.text.length)
      const pieceRaw = piece?.text ?? match.text
      const pieceStart = piece?.index ?? match.index
      const rowText = term.buffer.active.getLine(bufferRow)?.translateToString(true) ?? ''
      const singleMatch = findFileLinkMatchAt(rowText, strCol)
      const singleRaw = singleMatch?.text
      const wsPath = opts?.workspacePath

      // A plan doc reference routes to its dedicated review window, not the
      // generic file picker. extractPlanDocRelPath sheds any CJK prose the CLI
      // wrapped around the path ("計畫已建立：…（stage:…"). Workspace stays this
      // pane's own (resolve base intentionally unchanged) — a plan path that
      // belongs to a different workspace falls through to the picker as before.
      const planRel = extractPlanDocRelPath(pieceRaw) ?? extractPlanDocRelPath(match.text)
      if (planRel && wsPath) {
        const agentApi = (window as Window & { agentTeam?: _AgentApi }).agentTeam
        if (agentApi?.openPlansWindow) {
          void agentApi.openPlansWindow({ workspace_path: wsPath, rel_path: planRel })
          return
        }
      }

      const statOk = async (abs: string | undefined): Promise<boolean> => {
        if (!abs) return false
        try {
          // Short timeout: a busy/disconnected backend must not stall the
          // picker from opening — unverified just means fuzzy-search fallback.
          const r = await backend.send<{ exists: boolean }>('fs.stat_path', { path: abs }, 1500)
          return !!(r.ok && r.payload?.exists)
        } catch { return false }
      }
      void (async () => {
        const home = await fetchHomeDir()
        const resolveAbs = (fp: string): string | undefined => {
          const expanded = expandHomePath(fp, home)
          return expanded.startsWith('/')
            ? expanded
            : wsPath ? `${wsPath}/${expanded.replace(/^\.\//, '')}` : undefined
        }
        // Raw tokens stat first — a filename that genuinely contains
        // full-width punctuation must beat its punctuation-shed prefix
        // (docs/README（中文）.md vs docs/README). The shed variants that
        // follow are cut around the CLICK POSITION, so of two paths joined
        // by 、 the one under the cursor is the candidate.
        const shedPiece = shedCjkProse(pieceRaw, clickPos - pieceStart)
        // Last resort: the whole tail from the first rooted path start —
        // rescues folder names containing spaces/parens that truncate the
        // regex match ("看護媒合平台 (1)/…"). Precise candidates keep priority.
        const tail = rootedTailCandidate(group.fullText, clickPos)
        const cands = [
          pieceRaw, shedPiece,
          match.text, shedCjkProse(match.text, clickPos - match.index),
          singleRaw, singleMatch ? shedCjkProse(singleMatch.text, strCol - singleMatch.index) : undefined,
          tail?.text, tail ? shedCjkProse(tail.text, clickPos - tail.index) : undefined,
        ].filter((c, i, arr): c is string => !!c && arr.indexOf(c) === i)
        const absList = cands.map((c) => resolveAbs(splitSuffix(c).filepath))
        const stats = await Promise.all(absList.map(statOk))
        const okIdx = stats.findIndex(Boolean)
        // A verified .html inside this workspace opens rendered in the Plan
        // window (same surface as plan docs), not as source in the mini-IDE.
        if (okIdx >= 0) {
          const reportRoute = htmlReportRoute(absList[okIdx]!, wsPath)
          const agentApi = (window as Window & { agentTeam?: _AgentApi }).agentTeam
          if (reportRoute && agentApi?.openPlansWindow) {
            void agentApi.openPlansWindow(reportRoute)
            return
          }
        }
        const chosenRaw = okIdx >= 0 ? cands[okIdx] : (shedPiece ?? pieceRaw)
        const { filepath, line: lineNum } = splitSuffix(chosenRaw)
        if (!filepath) return
        const basename = filepath.split('/').filter(Boolean).pop() ?? filepath
        showTerminalFilePicker(basename, lineNum, okIdx >= 0 ? absList[okIdx] : undefined, filepath)
      })()
    }
    el.addEventListener('mousedown', _cmdClickHandler, { capture: true })

    mountedEl = el
    resizeCtrl.attachObserver(el)
    mounted = true
  }

  function focus(): void {
    // Record focus moment so the next few hundred ms of TUI redraw don't
    // get counted as "agent activity". See FOCUS_GRACE_MS comment above.
    lastFocusAt.value = Date.now()
    try {
      term.focus()
    } catch {
      /* ignore */
    }
  }

  // Persistence key for this pane's backend PTY id (terminal_session_id), stored
  // so we can reattach to the still-running terminal after a reload instead of
  // respawning. Defaults to paneId but is overridden at spawn() time by
  // opts.resumeKey (the stable CLI session id) — the paneId is regenerated on
  // restore and would never match.
  let persistKey = paneId
  // Previous PTY id snapshotted at spawn() time (before tryReattach can clear
  // it) — sent as replaces_terminal_id so the backend reaps the predecessor.
  let replacesPtyId = ''
  function ptyKey(): string { return `terminal-pty:${persistKey}` }
  function rememberSessionId(id: string): void {
    try {
      if (id) localStorage.setItem(ptyKey(), id)
      else localStorage.removeItem(ptyKey())
    } catch { /* ignore */ }
  }
  function persistedSessionId(): string {
    try { return localStorage.getItem(ptyKey()) || '' } catch { return '' }
  }

  // ── Scrollback snapshot ──────────────────────────────────────────────────────
  // Rolling buffer of raw ANSI output, saved to localStorage so the user's
  // terminal history survives a reload or restart. On next spawn of the same
  // resumeKey, the snapshot is replayed into the fresh xterm instance before
  // the new PTY starts writing — giving instant scrollback access to prior work.
  const SCROLL_SNAP_MAX = 256 * 1024  // 256 KB rolling cap
  const SCROLL_SNAP_MIN = 8 * 1024
  let rawScrollBuffer = ''
  function scrollSnapKey(): string { return `terminal-scroll:${persistKey}` }
  function loadScrollSnapshot(): string {
    try { return localStorage.getItem(scrollSnapKey()) ?? '' } catch { return '' }
  }
  // localStorage quota is shared across every pane's snapshot, and snapshots
  // of closed panes linger. On overflow, evict another pane's stale snapshot
  // and retry — dropping old history beats silently losing the newest.
  function evictLargestOtherSnapshot(selfKey: string): boolean {
    let victim = ''
    let victimLen = -1
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i)
        if (!k || k === selfKey || !k.startsWith('terminal-scroll:')) continue
        const len = (localStorage.getItem(k) ?? '').length
        if (len > victimLen) { victim = k; victimLen = len }
      }
      if (!victim) return false
      localStorage.removeItem(victim)
      return true
    } catch { return false }
  }
  function saveScrollSnapshot(): void {
    const key = scrollSnapKey()
    if (!rawScrollBuffer) {
      try { localStorage.removeItem(key) } catch { /* ignore */ }
      return
    }
    // appendToScrollBuffer lets the buffer overshoot the cap to avoid a slice
    // per chunk; cut it back here, where it happens once per pane teardown.
    let payload = rawScrollBuffer.length > SCROLL_SNAP_MAX
      ? rawScrollBuffer.slice(-SCROLL_SNAP_MAX)
      : rawScrollBuffer
    for (;;) {
      try {
        localStorage.setItem(key, payload)
        return
      } catch {
        if (evictLargestOtherSnapshot(key)) continue
        if (payload.length > SCROLL_SNAP_MIN) {
          payload = payload.slice(-Math.floor(payload.length / 2))
          continue
        }
        console.warn(`[terminal] scrollback snapshot dropped for ${persistKey}: localStorage quota exhausted`)
        return
      }
    }
  }
  function appendToScrollBuffer(data: string): void {
    rawScrollBuffer += data
    // Same lazy-trim reasoning as cleanBuffer above: the slice flattens the
    // rope and cost ~50µs on every chunk once the buffer was full. Trimming at
    // twice the cap makes that per-chunk cost vanish; saveScrollSnapshot cuts
    // the overshoot back to SCROLL_SNAP_MAX before persisting.
    if (rawScrollBuffer.length > SCROLL_SNAP_MAX * 2) {
      rawScrollBuffer = rawScrollBuffer.slice(-SCROLL_SNAP_MAX)
    }
  }

  // Strip everything from the last unmatched \x1b[?1049h onward so replaying
  // the snapshot never renders alt-buffer TUI content (cursor-positioning codes
  // written at the old terminal width) into the fresh xterm instance.
  function stripAltBufferSuffix(snap: string): string {
    const ENTER = '\x1b[?1049h'
    const EXIT  = '\x1b[?1049l'
    let depth = 0
    let lastEnterPos = -1
    let i = 0
    while (i < snap.length) {
      if (snap.startsWith(ENTER, i)) {
        if (depth === 0) lastEnterPos = i
        depth++
        i += ENTER.length
      } else if (snap.startsWith(EXIT, i)) {
        if (depth > 0 && --depth === 0) lastEnterPos = -1
        i += EXIT.length
      } else {
        i++
      }
    }
    return depth > 0 && lastEnterPos !== -1 ? snap.slice(0, lastEnterPos) : snap
  }

  // Rolling tail of what the user typed on the current line, used to spot the
  // `/clear` command. Lives out here (rather than inside bindSessionHandlers)
  // because the manual-paste path bypasses term.onData and has to feed it too —
  // otherwise pasting "/clear" and pressing Enter stops triggering onClear.
  let inputBuffer = ''

  /** Input bookkeeping shared by term.onData and the manual-paste path. */
  function noteUserInput(text: string): void {
    if (isStopped.value) { isStopped.value = false; opts?.onUserResume?.() }
    // Only what follows the last CR is still on the current line — without this
    // a pasted "/clear\n" leaves "/clear" behind and the user's NEXT Enter
    // fires onClear again.
    const lastBreak = text.lastIndexOf('\r')
    if (lastBreak >= 0) inputBuffer = ''
    inputBuffer += text.slice(lastBreak + 1).replace(/[\x00-\x1f\x7f]/g, '')
    if (inputBuffer.length > 100) inputBuffer = inputBuffer.slice(-100)
  }

  // Wire input/output/exit handlers for the current sessionId. Shared by a fresh
  // spawn and a reattach so both bind identically.
  function bindSessionHandlers(): void {
    inputBuffer = ''
    inputDisposer = term.onData((data) => {
      if (data === '\r' || data === '\n' || data === '\r\n') {
        if (isStopped.value) { isStopped.value = false; opts?.onUserResume?.() }
        if (inputBuffer.trim() === '/clear' && opts?.onClear) {
          inputBuffer = ''
          opts.onClear()
          return
        }
        inputBuffer = ''
      } else if (data === '\x7f' || data === '\b') {
        inputBuffer = inputBuffer.slice(0, -1)
      } else if (data.length === 1 && data.charCodeAt(0) >= 32) {
        if (isStopped.value) { isStopped.value = false; opts?.onUserResume?.() }
        inputBuffer += data
      } else if (data.length > 1) {
        if (isStopped.value) { isStopped.value = false; opts?.onUserResume?.() }
        inputBuffer += data.replace(/[\x00-\x1f\x7f]/g, '')
      }
      if (inputBuffer.length > 100) inputBuffer = inputBuffer.slice(-100)

      void backend.send('terminal.input', {
        terminal_session_id: sessionId.value,
        data
      })

      // @-mention trigger. Capture the line BEFORE the '@' echoes (onData fires
      // before the PTY round-trips the echo, so readLineBeforeCursor still shows
      // the pre-'@' state). Defer the open one tick so the '@' echoes and the
      // cursor advances first, then position the menu at the new cursor cell.
      if (data === '@' || data === '＠') {
        const candidates = opts?.mentionCandidates?.() ?? []
        if (candidates.length && shouldOpenMentionMenu(data, readLineBeforeCursor())) {
          setTimeout(() => openMentionMenu(candidates), 0)
        }
      }
    })

    outputUnsub = backend.on('terminal.output', (raw) => {
      const payload = raw as { terminal_session_id: string; data: string }
      if (payload.terminal_session_id !== sessionId.value) return
      _pendingOutput += payload.data
      if (_ownsTerminalFocus) {
        // The user is typing in this pane — render the echo now.
        _flushPendingOutput()
      } else if (!_outputTimer) {
        _outputTimer = setTimeout(_flushPendingOutput, _BACKGROUND_COALESCE_MS)
      }
    })

    exitUnsub = backend.on('terminal.exit', (raw) => {
      const payload = raw as TerminalExitDetails & { terminal_session_id: string }
      if (payload.terminal_session_id !== sessionId.value) return
      const crashState = activeCrashKey && activeAgentKey && activeAgentKey !== 'terminal'
        ? recordTerminalExit(activeCrashKey, payload)
        : { count: 0, open: false }
      status.value = crashState.open ? 'error' : 'exited'
      error.value = crashState.open
        ? `${formatTerminalExit(payload)}. Automatic rebuild stopped after ${crashState.count} fast crashes.`
        : ''
      rememberSessionId('')  // the PTY is gone — don't try to reattach to it
      // Session ended cleanly — discard its scrollback snapshot so a future
      // pane with the same key doesn't see stale output from a closed session.
      rawScrollBuffer = ''
      try { localStorage.removeItem(scrollSnapKey()) } catch {}
      const color = crashState.open ? 31 : 33
      term.writeln(`\r\n\x1b[${color}m[session] ${error.value || formatTerminalExit(payload)}\x1b[0m`)
      cleanupSession()
    })
  }

  // Wait until the container width holds steady for two consecutive frames
  // (bounded ~500ms) so a fit measures the FINAL width, not a mid-grid-reflow
  // transient. Shared by spawn and reattach — sizing a PTY to a transient width
  // leaves the CLI painting narrow (empty space on the right).
  async function settleContainerWidth(): Promise<void> {
    const settleEl = containerRef.value
    if (!settleEl || settleEl.clientWidth === 0) return
    let lastW = -1
    const deadline = performance.now() + 500
    while (performance.now() < deadline) {
      // rAF with a timeout fallback — rAF is throttled (or fully paused) for
      // occluded/background windows and must never stall.
      await new Promise<void>((resolve) => {
        const raf = requestAnimationFrame(() => { clearTimeout(timer); resolve() })
        const timer = setTimeout(() => { cancelAnimationFrame(raf); resolve() }, 100)
      })
      const w = settleEl.clientWidth
      if (w === lastW) break
      lastW = w
    }
  }

  // Reattach-to-live-PTY on reload. The backend does NOT kill PTYs on WS
  // disconnect (output is dropped but the process keeps running). A page reload
  // or HMR cycle disconnects the WS briefly; when the renderer reconnects,
  // tryReattach() finds the alive PTY and rebinds — no --resume round-trip, no
  // conversation reprint. The width-narrow regression (original reason this was
  // disabled) is fixed: we send cols/rows 0 and defer the force_redraw to the
  // reconciler, which fires it only after the container width has settled.
  const REATTACH_ON_RELOAD = true as boolean

  // Try to rebind to a PTY that survived a reload. Returns true if the backend
  // confirms the persisted id is still alive (and we've rebound); false if it's
  // gone, in which case the caller spawns a fresh process.
  // `agentKey` matters when the caller reattaches WITHOUT ever calling spawn()
  // (AiCliDock claims a surviving PTY at mount): spawn() is the only other place
  // that records it, and without it every input-protocol decision — Shift+Enter
  // encoding, forced bracketed paste — degrades to the plain-shell branch.
  async function tryReattach(reattachOpts?: { agentKey?: string }): Promise<boolean> {
    if (!REATTACH_ON_RELOAD) return false
    const prev = persistedSessionId()
    if (!prev) return false
    try {
      // Alive-check + claim the output target only (cols/rows 0 → backend skips
      // force_redraw). The repaint is deferred to the reconciler, which fires it
      // once the width has settled — forcing it now would repaint the live agent
      // at the renderer's transient mid-reflow width (narrow).
      const resp = await backend.send<{ alive: string[]; dead: string[] }>('terminal.reattach', {
        terminal_session_ids: [prev],
        cols: 0,
        rows: 0,
      })
      if (!resp.ok || !resp.payload || !resp.payload.alive.includes(prev)) {
        rememberSessionId('')  // stale id — fall through to a fresh spawn
        return false
      }
    } catch {
      return false  // backend unreachable; let the caller decide (it will spawn)
    }
    // PTY is alive — do NOT replay the snapshot here. The snapshot contains
    // cursor-positioning escape codes written at the prior terminal width;
    // replaying them into a fresh xterm (which may differ in width) garbles
    // the TUI layout. The live PTY will repaint cleanly once the reconciler
    // fires terminal.reattach with the settled cols/rows (~2 s). Snapshot
    // replay is reserved for _doCreate (PTY dead, falls back to --resume).
    // Reset mouse tracking modes so no stale xterm mouse state forwards events
    // to the process's stdin before it has a chance to re-enable what it needs.
    term.write('\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?1015l\x1b[?1004l\x1b[?2004l')
    sessionId.value = prev
    status.value = 'running'
    if (reattachOpts?.agentKey) activeAgentKey = reattachOpts.agentKey
    bindSessionHandlers()
    pendingReattachRedraw = true      // reconciler repaints once the width is settled
    resizeCtrl.applyFit()             // start syncing size (no-op while hidden)
    queueMicrotask(() => focus())
    return true
  }

  // Reattach to a PTY that survived a transient network disconnect. Called when
  // the WS reconnects while the pane is already in 'running' state. Uses the
  // same deferred-redraw pattern as tryReattach: cols/rows 0 skips the immediate
  // SIGWINCH; the reconciler fires it once the width has settled.
  async function reattachAfterReconnect(): Promise<void> {
    if (status.value !== 'running' || !sessionId.value) return
    const id = sessionId.value
    try {
      const resp = await backend.send<{ alive: string[]; dead: string[] }>('terminal.reattach', {
        terminal_session_ids: [id],
        cols: 0,
        rows: 0,
      })
      if (!resp.ok || !resp.payload || !resp.payload.alive.includes(id)) {
        // PTY died while disconnected — mark exited so the user sees it
        status.value = 'exited'
        term.writeln('\r\n\x1b[33m[session ended while disconnected]\x1b[0m')
        rememberSessionId('')
        cleanupSession()
        return
      }
    } catch {
      return // WS not ready yet; the next status-change will retry
    }
    // Reset mouse tracking modes on reconnect for the same reason as tryReattach.
    term.write('\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?1015l\x1b[?1004l\x1b[?2004l')
    cleanupSession()
    bindSessionHandlers()
    pendingReattachRedraw = true
    resizeCtrl.applyFit()
  }

  // When the backend WS reconnects while we have a live session, reattach so
  // output resumes and the TUI repaints at the correct width.
  watch(() => backend.status.value, (newStatus, oldStatus) => {
    if (newStatus === 'connected' && oldStatus !== 'connected') {
      void reattachAfterReconnect()
    }
  })

  // A pane may be asked to spawn while its tab is hidden (clientWidth 0), where
  // its width can't be measured. We must NOT create the PTY at a guessed width:
  // the CLI's first paint (especially a `--resume` that reprints the whole
  // conversation) would hard-wrap at that wrong width and stay stuck in
  // scrollback. So the opts are parked here and the PTY is created only once the
  // container is genuinely measurable — i.e. when the tab is shown.
  // A ref so displayStatus can reflect a parked (deferred) spawn as idle.
  const pendingSpawn = shallowRef<SpawnOptions | null>(null)
  let activeCreateGeneration: string | null = null
  let pendingCreateCancel: Promise<boolean> | null = null
  const createCancelRequests = new Map<string, Promise<boolean>>()

  function newCreateGeneration(): string {
    return crypto.randomUUID()
  }

  function requestCreateCancel(generation: string): Promise<boolean> {
    const existing = createCancelRequests.get(generation)
    if (existing) return existing
    const request = backend.send('terminal.create.cancel', {
      pane_id: paneId,
      create_generation: generation,
    }).then((response) => response.ok, () => false)
    createCancelRequests.set(generation, request)
    return request
  }

  async function requireCreateCancel(request: Promise<boolean>): Promise<void> {
    if (!await request) throw new Error('terminal create cancellation failed')
  }

  /** Invalidate the current create locally, then wait for backend rollback. */
  async function cancelPendingCreate(): Promise<void> {
    const generation = activeCreateGeneration
    if (!generation) {
      if (pendingCreateCancel) await requireCreateCancel(pendingCreateCancel)
      return
    }
    activeCreateGeneration = null
    pendingSpawn.value = null
    const request = requestCreateCancel(generation)
    pendingCreateCancel = request
    await requireCreateCancel(request)
    if (pendingCreateCancel === request) pendingCreateCancel = null
  }

  // Create the PTY for a parked spawn, but only when the container has a real,
  // measurable width. Returns silently (leaving it parked) until then; the
  // reconciler / ResizeObserver retry it once the pane is shown.
  function cellWidth(): number {
    return (term as any)._core?._renderService?.dimensions?.css?.cell?.width || 0
  }
  // Guarded entry point: only one create may be in flight. pendingSpawn isn't
  // cleared until after the awaits in _doCreate, so without this the reconciler /
  // ResizeObserver could start a second create for the same pane (two PTYs).
  let _creating = false
  async function createWhenMeasurable(): Promise<void> {
    if (_creating || !pendingSpawn.value) return
    _creating = true
    try { await _doCreate() } finally { _creating = false }
  }
  async function _doCreate(): Promise<void> {
    const opts = pendingSpawn.value
    if (!opts) return
    const createGeneration = activeCreateGeneration
    if (!createGeneration) return
    let el = containerRef.value
    const visible = !!el && el.clientWidth > 0
    // A hidden pane has no measurable width, so the create below would fall back
    // to xterm's 80x24 default and the CLI would draw its first frame that narrow
    // — permanently, since already-printed output never re-wraps wider. Borrow the
    // cached layout size (from a visible terminal, or the previous run) so even a
    // hidden pane starts its PTY at a realistic size; the reconciler still corrects
    // it once the tab is shown.
    if (!visible && _lastKnownCols > 0 && _lastKnownRows > 0) {
      try { term.resize(_lastKnownCols, _lastKnownRows) } catch { /* ignore */ }
    } else if (!visible && opts.isResume) {
      // With no cached size to borrow, a resume must still wait until measurable:
      // it reprints the prior conversation and MUST paint at the real width. A
      // fresh spawn is empty, so it proceeds — deferring it would stall e.g. a
      // pipeline stage spawned into a tab the user isn't currently viewing.
      return
    }
    if (visible && cellWidth() === 0) {
      // xterm hasn't measured its character cell yet (just opened): poke once to
      // force measurement, then AWAIT it (bounded) so a fresh spawn resolves
      // 'running' and the caller's role-injection flow proceeds. Poking per
      // attempt (not once ever) is what makes a re-parked pane measure again
      // after it was hidden and shown a second time.
      try { term.resize(Math.max(term.cols, 2), Math.max(term.rows, 1)) } catch { /* ignore */ }
      const deadline = performance.now() + 500
      while (cellWidth() === 0 && performance.now() < deadline) {
        await new Promise<void>((resolve) => {
          const raf = requestAnimationFrame(() => { clearTimeout(t); resolve() })
          const t = setTimeout(() => { cancelAnimationFrame(raf); resolve() }, 100)
        })
        el = containerRef.value
        if (opts.isResume && (!el || el.clientWidth === 0)) return  // hidden mid-wait
      }
    }
    pendingSpawn.value = null  // claim it so a concurrent retry can't double-create
    if (visible) {
      // Settle the width, then fit, so the create below uses the real size.
      await settleContainerWidth()
      // The tab may have been switched away during the settle. A resume must not
      // create at a hidden/stale width (it would paint narrow) — re-park it.
      el = containerRef.value
      if (opts.isResume && (!el || el.clientWidth === 0 || cellWidth() === 0)) {
        pendingSpawn.value = opts
        return
      }
      try { fit.fit() } catch { /* keep current size */ }
    }
    // Replay stored scrollback into the fresh xterm so prior history is visible
    // before the new PTY starts writing. Only for resume spawns that have a saved
    // snapshot — fresh spawns (no resumeKey) have no snapshot to replay.
    if (opts.resumeKey && opts.restoreMode !== 'fresh') {
      // Strip any trailing alt-buffer content before replaying. The snapshot
      // accumulates raw PTY output including Claude Code's TUI redraws; those
      // cursor-positioning codes were written at the old terminal width and
      // would render garbled in the fresh xterm. Only the main-buffer portion
      // (before the last unmatched \x1b[?1049h) is safe to replay.
      const snap = stripAltBufferSuffix(loadScrollSnapshot())
      if (snap) {
        term.write(snap)
        rawScrollBuffer = snap  // seed the buffer so new output appends correctly
        // Reset any mouse tracking modes the previous session may have enabled.
        term.write('\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?1015l\x1b[?1004l\x1b[?2004l')
        term.write('\r\n\x1b[2m\x1b[38;5;240m─── reconnected ───\x1b[0m\r\n')
      }
    }
    // Only resume spawns are throttled (they are the heavy ones). Acquire before
    // send so the queue-wait is NOT charged against the per-request timeout;
    // released in finally once the ack (or failure) lands.
    const throttled = !!opts.isResume
    if (throttled) await acquireResumeSpawnSlot()
    try {
      // The pane may have been cancelled while waiting for the shared resume
      // semaphore. Never send a create for an invalidated generation.
      if (activeCreateGeneration !== createGeneration || isDisposed) return
      const resp = await backend.send<{
        terminal_session_id: string
        pid: number
        startup_probe?: TerminalStartupProbe | null
      }>('terminal.create', {
        pane_id: paneId,
        create_generation: createGeneration,
        agent_key: opts.agentKey ?? null,
        command: opts.command,
        cwd: opts.cwd,
        env: opts.env ?? null,
        // Visible panes carry the real, measured width (so a resume's reprint
        // isn't hard-wrapped narrow). A fresh hidden pane has no measured size
        // yet → the 80x24 default; the reconciler corrects it once shown.
        cols: term.cols || 80,
        rows: term.rows || 24,
        metadata: opts.metadata ?? null,
        output_log_file: opts.outputLogFile ?? null,
        login_profile_id: opts.loginProfileId ?? null,
        replaces_terminal_id: replacesPtyId || null,
      }, TERMINAL_CREATE_TIMEOUT_MS)
      // A cancellation or replacement can land while the RPC is in flight.
      // The backend cancellation owns rollback; a late result must never bind
      // its PTY or overwrite the newer pane state.
      if (isDisposed || activeCreateGeneration !== createGeneration) {
        void requestCreateCancel(createGeneration)
        return
      }
      if (!resp.ok || !resp.payload) {
        activeCreateGeneration = null
        void requestCreateCancel(createGeneration)
        status.value = 'error'
        error.value = resp.error?.message ?? 'spawn failed'
        term.writeln(`\r\n\x1b[31m[error] ${error.value}\x1b[0m`)
        const binaryPath = String(resp.error?.details?.binary_path ?? '')
        if (binaryPath && !error.value.includes(binaryPath)) {
          term.writeln(`\x1b[31m[binary] ${binaryPath}\x1b[0m`)
        }
        return
      }
      activeCreateGeneration = null
      startingStartedAt.value = null
      sessionId.value = resp.payload.terminal_session_id
      rememberSessionId(sessionId.value)  // enable reattach after a reload
      status.value = 'running'
      const probe = resp.payload.startup_probe
      if (probe?.binary_path) {
        const version = probe.version ? ` v${probe.version}` : ''
        const duration = typeof probe.duration_ms === 'number' ? `, ${probe.duration_ms}ms` : ''
        term.writeln(`\x1b[2m[startup probe] ${probe.binary_path}${version}${duration}\x1b[0m`)
      }
      resizeCtrl.applyFit()  // sync the real size to the backend on first paint
      // The width measured above can still be a mid-layout snapshot (e.g. this
      // spawn's own pane is still settling into a freshly reflowed grid) that
      // differs from the width the container settles at moments later. Any
      // banner/output the CLI already drew at the wrong width won't reflow on
      // its own — request the same gated (width-stable + CLI-quiet + once) SIGWINCH
      // repaint the ResizeObserver path uses, so a stale narrow first frame gets
      // corrected instead of stranded.
      resizeCtrl.requestResizeRedraw()
      // The fit above can still have captured a pre-settle width — re-check
      // after the layout truly settles (see scheduleFreshSpawnRefit).
      scheduleFreshSpawnRefit()
      queueMicrotask(() => focus())
      bindSessionHandlers()
    } catch (err) {
      if (activeCreateGeneration !== createGeneration) return
      activeCreateGeneration = null
      void requestCreateCancel(createGeneration)
      status.value = 'error'
      error.value = String((err as Error).message ?? err)
      term.writeln(`\r\n\x1b[31m[error] ${error.value}\x1b[0m`)
    } finally {
      if (throttled) releaseResumeSpawnSlot()
    }
  }

  // A spawn measures its width once right before terminal.create
  // (settleContainerWidth only waits for 2-frame stability), so a pane spawned
  // into a still-reflowing layout (e.g. a new tab maximizing over the previous
  // multi-pane grid) can pin the PTY, xterm, AND the acked size to the same
  // pre-settle width — every recovery net then sees a consistent (but wrong)
  // size and no-ops. Re-check shortly after the create: if the container now
  // fits to a different size, re-run the normal gated fit + redraw path.
  // Idempotent — when the fitted size already matches xterm, it does nothing.
  let freshSpawnRefitTimer: ReturnType<typeof setTimeout> | null = null
  function scheduleFreshSpawnRefit(): void {
    const attempt = (): void => {
      if (isDisposed || !sessionId.value) return
      const dims = fit.proposeDimensions()
      // Hidden/unmeasurable panes yield no finite dims — the reconciler owns those.
      if (!dims || !Number.isFinite(dims.cols) || !Number.isFinite(dims.rows)) return
      if (dims.cols === term.cols && dims.rows === term.rows) return
      resizeCtrl.applyFit()
      resizeCtrl.requestResizeRedraw()
    }
    // Two frames let the in-flight layout reflow commit; the timer retry covers
    // a slower settle and rAF throttling in occluded/background windows.
    requestAnimationFrame(() => requestAnimationFrame(attempt))
    freshSpawnRefitTimer = setTimeout(() => { freshSpawnRefitTimer = null; attempt() }, 350)
  }

  // Assign here — after createWhenMeasurable is defined — so all callbacks
  // close over the fully-initialized functions. The declaration is hoisted
  // above the reconciler interval so async closures can reference it safely.
  resizeCtrl = createResizeController(
    term,
    fit,
    sessionId,
    containerRef,
    lastRawActivityAt,
    backend.send,
    () => !!pendingSpawn.value,
    () => { void createWhenMeasurable() },
  )

  // Shared zoom → this pane. A new font size means a new cell size, so refit to
  // recompute cols/rows and resync the PTY — that keeps the content filling the pane.
  //
  // Scrollback written before the zoom is NOT re-flowed: agent CLIs hard-wrap their own
  // output (standalone short lines, isWrapped=false), so xterm cannot re-wrap it into
  // the new grid. SIGWINCH redraws the current screen; font-only changes intentionally
  // do not auto-resume the CLI to reprint history.
  watch(terminalFontSize, (size) => {
    term.options.fontSize = size
    resizeCtrl.applyFit()
    // The container's CSS size does not change when only the xterm cell size
    // changes, so ResizeObserver may stay silent. Redraw after settlement.
    resizeCtrl.requestResizeRedraw()
  })

  async function spawn(opts: SpawnOptions): Promise<void> {
    if (status.value === 'starting' || status.value === 'running') {
      throw new Error('terminal already running')
    }
    isStopped.value = false
    runningLatched.value = false
    turnCompleteAt.value = 0
    error.value = ''
    status.value = 'starting'
    startingStartedAt.value = Date.now()
    const createGeneration = newCreateGeneration()
    activeCreateGeneration = createGeneration
    activeAgentKey = opts.agentKey
    activeCrashKey = terminalCrashKey({
      agentKey: opts.agentKey,
      cwd: opts.cwd,
      resumeKey: opts.resumeKey,
      command: opts.command,
    })
    if (opts.isResume && isTerminalCrashLoopOpen(activeCrashKey)) {
      activeCreateGeneration = null
      startingStartedAt.value = null
      status.value = 'error'
      error.value = 'Automatic rebuild stopped after 3 fast crashes. Use Respawn after fixing the CLI.'
      term.writeln(`\r\n\x1b[31m[error] ${error.value}\x1b[0m`)
      return
    }
    lastCommand.value = Array.isArray(opts.command) ? opts.command.join(' ') : opts.command
    // Use the stable CLI session id as the reattach key when provided, so the
    // lookup below survives a reload (paneId does not).
    if (opts.resumeKey) persistKey = opts.resumeKey
    // Snapshot the pane's previous PTY id NOW — tryReattach clears it when the
    // PTY is gone. Passed to terminal.create as replaces_terminal_id so the
    // backend reaps a still-live predecessor this spawn is replacing (resume-id
    // dedup can't: the id rotates on every resume, so it never matches).
    replacesPtyId = persistedSessionId()
    // True persistence: a PTY from before a reload may still be running. Reattach
    // to it (recovering bash/build panes too, with no --resume round-trip) before
    // spawning anew. Falls through to a fresh spawn if the PTY is gone.
    if (!opts.skipReattach && await tryReattach()) {
      if (activeCreateGeneration === createGeneration) activeCreateGeneration = null
      startingStartedAt.value = null
      return
    }
    if (activeCreateGeneration !== createGeneration || isDisposed) return
    // Park the spawn and create the PTY only once the container is measurable, so
    // the CLI paints at the real width. Visible panes create immediately; a
    // hidden-tab pane creates when its tab is first shown (reconciler/observer).
    pendingSpawn.value = opts
    await createWhenMeasurable()
  }

  function pasteText(text: string): void {
    if (!sessionId.value || status.value === 'exited' || status.value === 'error') return
    void backend.send('terminal.input', {
      terminal_session_id: sessionId.value,
      data: text
    })
  }

  /**
   * Send clipboard text the way programmatic injection already does.
   *
   * xterm's built-in paste writes the whole clipboard in one call and decides
   * on bracketing from ITS view of DEC mode 2004. That view is wrong in exactly
   * the case that hurts most: a reattached pane runs a fresh xterm (mode off by
   * default, and tryReattach explicitly resets it) while the CLI on the other
   * end is still in bracketed-paste mode. An unbracketed multi-line paste then
   * reaches the CLI as one Enter per line — the first line submits and the rest
   * spill into the next prompt, which is the "paste gets cut off" report.
   * So bracket by what the AGENT supports, and reuse the 512-byte chunking that
   * App.vue's injectText relies on to keep large pastes off the tty's limits.
   */
  function pasteFromClipboard(text: string): void {
    // xterm drops input while stdin is disabled (CoreService); the pane does
    // that while it is still preparing, and a paste must respect it too.
    if (!text || term.options.disableStdin) return
    // Same gate pasteText applies. Checked up front so a paste into a dead pane
    // cannot clear `isStopped` (and fire onUserResume) while sending nothing.
    if (!sessionId.value || status.value === 'exited' || status.value === 'error') return
    // Same normalization xterm applies: a PTY expects CR, never CRLF/LF.
    const normalized = text.replace(/\r?\n/g, '\r')
    // Bracket when xterm knows the CLI asked for it, and — only for text that
    // actually spans lines — when the agent is known to keep the mode on. That
    // second case is the reattach hole this exists for; restricting it to
    // multi-line text keeps a single-line paste on xterm's own judgement, so a
    // sub-shell that never enabled mode 2004 cannot receive a literal "[200~".
    const bracketed = term.modes.bracketedPasteMode ||
      (normalized.includes('\r') && agentUsesBracketedPaste(activeAgentKey))
    const payload = bracketed ? `\x1b[200~${normalized}\x1b[201~` : normalized
    // The rest of what term.onData would have done for us (CoreService's
    // _onUserInput plus this composable's own input bookkeeping).
    noteUserInput(normalized)
    for (const chunk of chunkForPty(payload, PASTE_CHUNK)) pasteText(chunk)
    term.scrollToBottom()
    term.clearSelection()
  }

  async function interrupt(): Promise<void> {
    if (!sessionId.value) return
    isStopped.value = true
    await backend.send('terminal.interrupt', { terminal_session_id: sessionId.value })
  }

  async function kill(opts?: { force?: boolean }): Promise<void> {
    if (!sessionId.value) return
    rememberSessionId('')  // explicit kill — never reattach to this PTY
    await backend.send('terminal.kill', {
      terminal_session_id: sessionId.value,
      force: opts?.force ?? false
    })
  }

  function fitTerminal(opts?: { redrawAfterSettle?: boolean }): void {
    if (!mounted) return
    resizeCtrl.applyFit()
    // Explicit refit paths (layout-mode switch, tab/minimize toggles, window
    // resize safety net) exist because the ResizeObserver is unreliable while
    // the pane is hidden/occluded — so when a caller opts in, arm the same
    // gated once-per-settle redraw the observer path uses. Default (no flag)
    // keeps spawn/reconciler call sites byte-for-byte unchanged.
    if (opts?.redrawAfterSettle) {
      resizeCtrl.requestResizeRedraw()
    }
  }

  /**
   * WARNING: `redraw()` should ONLY be used for manually triggered "redraw / clear screen"
   * actions by the user. Do NOT hook this into automatic resize/layout pathways (like window
   * resizes or layout mode changes). For automatic resizing, always use `fitTerminal`
   * instead, which correctly handles PTY dimensions and scrollback preservation.
   *
   * Ask the CLI to repaint its current frame by sending a SIGWINCH (via terminal.redraw).
   * We used to send Ctrl+L, but while Claude Code repaints properly, pure shells (bash/zsh)
   * interpret Ctrl+L as "clear screen", which visually wipes the scrollback.
   * We deliberately do NOT call term.clear() here. Letting the CLI repaint via SIGWINCH
   * keeps the scrollback intact and scrollable for both TUI apps and pure shells.
   */
  function redraw(): void {
    if (!sessionId.value) return
    void backend.send('terminal.redraw', {
      terminal_session_id: sessionId.value,
      cols: term.cols,
      rows: term.rows,
    })
  }

  // Hard reset: drop the entire scrollback (including any corrupt frames frozen
  // there from a pre-fix resize, which the CLI can never repaint over), then
  // Ctrl+L so the CLI redraws its current frame into the cleared viewport.
  // Unlike redraw(), this DOES wipe history — it is an explicit, separately
  // labelled action, not the gentle refresh.
  function clearScrollback(): void {
    term.clear()
    pasteText('\x0c')
  }

  function updateXtermTheme(): void {
    term.options.theme = readXtermTheme()
  }

  function cleanupSession(): void {
    inputDisposer?.dispose()
    inputDisposer = null
    outputUnsub?.()
    outputUnsub = null
    exitUnsub?.()
    exitUnsub = null
    // Flush any coalesced output that hadn't been written yet.
    // We only update the visual terminal, not the scroll buffer: the exit handler
    // intentionally clears rawScrollBuffer before calling us, so appending here
    // would re-populate a snapshot that should stay discarded.
    if (_outputTimer) { clearTimeout(_outputTimer); _outputTimer = null }
    if (_pendingOutput) {
      term.write(_pendingOutput)
      _pendingOutput = ''
    }
  }

  onScopeDispose(() => {
    isDisposed = true
    void cancelPendingCreate().catch(() => {})
    saveScrollSnapshot()  // persist scrollback before the pane is torn down
    cleanupSession()
    clearInterval(tickInterval)
    clearInterval(reconcileInterval)
    if (freshSpawnRefitTimer) clearTimeout(freshSpawnRefitTimer)
    if (_hintTimer) clearTimeout(_hintTimer)
    resizeCtrl.dispose()
    if (mountedEl && _mousedownHandler) mountedEl.removeEventListener('mousedown', _mousedownHandler)
    if (_cmdKeyDown) window.removeEventListener('keydown', _cmdKeyDown)
    if (_cmdKeyUp) window.removeEventListener('keyup', _cmdKeyUp)
    if (mountedEl && _mousePosTracker) mountedEl.removeEventListener('mousemove', _mousePosTracker)
    if (mountedEl && _cmdClickHandler) mountedEl.removeEventListener('mousedown', _cmdClickHandler, { capture: true })
    if (mountedEl && _pasteHandler) mountedEl.removeEventListener('paste', _pasteHandler, true)
    if (_focusOwner === term) _focusOwner = null
    document.querySelector('.term-file-picker-root')?.remove()
    closeMentionMenu()  // tear down any open @-mention menu (detaches doc listeners)
    term.textarea?.removeEventListener('focus', _onTermFocus)
    term.textarea?.removeEventListener('blur', _onTermBlur)
    window.removeEventListener('focus', _onWindowFocus)
    // A pane disposed while focused never fires blur — clear the context so
    // `terminalFocus` cannot stay stuck on. Cleared directly rather than through
    // _onTermBlur(), which defers to the window-focus path when the whole window
    // is unfocused — and the listener that would have completed the handoff was
    // just removed above, so the context would stay stuck on for good.
    if (_ownsTerminalFocus) {
      _ownsTerminalFocus = false
      _blurredWithWindow = false
      setContext('terminalFocus', false)
    }
    term.dispose()
    // PTY is intentionally NOT killed here. The backend keeps PTYs running
    // after a WS disconnect so that tryReattach() can rebind after a page
    // reload or HMR cycle. Explicit kills are handled by kill() (user-initiated
    // pane removal). The backend terminates all PTYs when the app quits
    // (backend process exit). The persisted session id is kept so that
    // tryReattach() can locate the alive PTY on the next mount.
  })

  return {
    mount,
    spawn,
    tryReattach,
    interrupt,
    kill,
    focus,
    fitTerminal,
    redraw,
    pasteText,
    status,
    displayStatus,
    startingStartedAt,
    startingAgeMs,
    cancelPendingCreate,
    isStopped,
    sessionId,
    error,
    lastCommand,
    cleanBuffer,
    cleanBytesSeen,
    lastActivityAt,
    lastRawActivityAt,
    markTurnComplete,
    markBufferPosition,
    recleanBuffer,
    readRenderedText,
    readLineBeforeCursor,
    updateXtermTheme,
    isAltBuffer,
    optionSelectHint,
    getSelection: () => term.getSelection(),
    setDisableStdin: (disabled: boolean) => { term.options.disableStdin = disabled },
  }
}
