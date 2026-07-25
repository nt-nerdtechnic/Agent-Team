import { computed, onScopeDispose, ref, shallowRef, watch } from 'vue'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import '@xterm/xterm/css/xterm.css'
import type { useBackend } from './useBackend'
import { bufferTail, dropTuiNoise, isRedrawReplay, stripAnsi } from '../lib/buffer'
import { createResizeController, type ResizeController } from './useTerminalResize'
import { installTerminalZoomShortcuts, terminalFontSize } from './useTerminalFontSize'
import { getResumeConcurrency } from '../lib/resumeConcurrency'
import { shouldOpenMentionMenu } from '../lib/cliContext'
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

export type TerminalStatus = 'idle' | 'starting' | 'running' | 'exited' | 'error'

// Cached dimensions from any visible terminal. Hidden resumed tabs use these
// to start their PTY immediately at the correct layout size without waiting
// for the user to switch to them.
let _lastKnownCols = 0
let _lastKnownRows = 0

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

function openInEditor(absPath: string, line: number | undefined): void {
  const api = (window as Window & { agentTeam?: _AgentApi }).agentTeam
  if (!api?.openEditorWindow) return
  const slash = absPath.lastIndexOf('/')
  const wsPath = slash > 0 ? absPath.slice(0, slash) : absPath
  const filepath = absPath.slice(slash + 1)
  void api.openEditorWindow({ workspace_path: wsPath, filepath, ...(line !== undefined ? { line } : {}) })
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

export function getWrappedLineGroup(term: import('@xterm/xterm').Terminal, bufferRow: number): WrappedLineGroup {
  const buffer = term.buffer.active
  const lineTextAt = (r: number): string | null => {
    const ln = buffer.getLine(r)
    return ln ? ln.translateToString(true) : null
  }
  const leadingWs = (s: string): number => s.length - s.trimStart().length
  // Whether row `r` could have been broken by the CLI's width limit: no row
  // within the window is measurably longer than it.
  const nearWidthLimit = (r: number): boolean => {
    const len = lineTextAt(r)?.length ?? 0
    for (let i = r - _PREWRAP_WINDOW; i <= r + _PREWRAP_WINDOW; i++) {
      if (i !== r && (lineTextAt(i)?.length ?? 0) > len + _PREWRAP_SLACK) return false
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

// Cell column ↔ translateToString offset for one buffer row. A double-width
// glyph (CJK, full-width punctuation) occupies two cells but one string
// position — translateToString emits nothing for the trailing half-cell — so
// the two coordinate spaces diverge after any wide character. Identity when
// the line surface lacks getCell (unit-test mocks); pure-ASCII rows map 1:1.
export function cellColToStrCol(
  term: import('@xterm/xterm').Terminal,
  bufferRow: number,
  cellCol: number
): number {
  const line = term.buffer.active.getLine(bufferRow)
  if (!line || typeof line.getCell !== 'function') return cellCol
  let str = -1
  for (let x = 0; x <= cellCol && x < line.length; x++) {
    if ((line.getCell(x)?.getWidth() ?? 1) !== 0) str++
  }
  return Math.max(0, str)
}

export function strColToCellCol(
  term: import('@xterm/xterm').Terminal,
  bufferRow: number,
  strCol: number
): number {
  const line = term.buffer.active.getLine(bufferRow)
  if (!line || typeof line.getCell !== 'function') return strCol
  let str = -1
  for (let x = 0; x < line.length; x++) {
    if ((line.getCell(x)?.getWidth() ?? 1) !== 0) {
      str++
      if (str === strCol) return x
    }
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

/** Every URL in `text`, trailing punctuation trimmed. `breaks` (fullText
 *  offsets of heuristic row joins, see WrappedLineGroup.heuristicBreaks) are
 *  hard boundaries a URL never crosses. Shared by the link provider and the
 *  click handler so the underline range and the click hitbox always agree. */
export function findUrlMatches(text: string, breaks: number[] = []): Array<{ index: number; text: string }> {
  const bounds = [0, ...breaks.filter((b) => b > 0 && b < text.length), text.length]
  const out: Array<{ index: number; text: string }> = []
  for (let i = 0; i < bounds.length - 1; i++) {
    const seg = text.slice(bounds[i], bounds[i + 1])
    URL_LINK_RE.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = URL_LINK_RE.exec(seg)) !== null) {
      out.push({ index: bounds[i] + m.index, text: trimUrlTrailing(m[0]) })
    }
  }
  return out
}

/** The URL match containing 0-based `pos` in `text` (trailing punctuation
 *  already trimmed), or null. */
export function findUrlLinkMatchAt(
  text: string,
  pos: number,
  breaks: number[] = []
): { text: string; index: number } | null {
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
          pushLink(piece.index, piece.text)
        }
      }
      callback(links.length ? links : undefined)
    },
  }
}

interface UseTerminalOptions {
  workspacePath?: string
  onClear?: () => void
  /** Getter for the OTHER CLI panes' messaging names (already excluding self).
   *  Feeds the @-mention autocomplete menu. Read lazily at trigger time so the
   *  list stays current as panes come and go. */
  mentionCandidates?: () => string[]
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
const TERMINAL_CREATE_TIMEOUT_MS = 30_000
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

  const term = new Terminal({
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

  // ── RUNNING vs IDLE ──────────────────────────────────────────────────────────
  // We want RUNNING only when the CLI is genuinely executing — not for brief
  // nudges, TUI redraws, or prompt echoes that last a second or two.
  //
  // Strategy: track the start of each CONTINUOUS burst of PTY activity.
  // A gap > BURST_GAP_MS in raw output resets the burst start. Only bursts
  // that have lasted > MIN_BURST_MS are shown as RUNNING. Short nudge
  // responses (1–2 s) never reach the threshold; real work (tool chains,
  // file edits, long responses) easily exceeds it.
  //
  // No external signals (hooks, attribution, focus) are involved — this
  // purely tracks what the PTY itself emits.
  const BURST_GAP_MS   = 1_000   // gap that splits two separate bursts
  const MIN_BURST_MS   = 2_000   // burst must last this long to show RUNNING
  const STALE_MS       = 2_000   // no output for this long → not running
  const activityBurstStartAt = ref<number>(0)
  // Clean-content activity clock for the RUNNING badge (see appendClean). Kept
  // separate from lastRawActivityAt so an idle CLI that only repaints its
  // footer/cursor (raw bytes, but empty after noise-stripping) can't keep the
  // badge stuck on RUNNING.
  const lastCleanBurstAt = ref<number>(0)
  // Tick so displayStatus re-evaluates after output goes quiet.
  const nowTick = ref<number>(Date.now())
  const tickInterval = window.setInterval(() => { nowTick.value = Date.now() }, 1_000)

  const displayStatus = computed<string>(() => {
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
    // goes idle after STALE_MS instead of sticking on RUNNING.
    if (nowTick.value - lastCleanBurstAt.value > STALE_MS) return 'idle'
    return (nowTick.value - activityBurstStartAt.value) >= MIN_BURST_MS ? 'running' : 'idle'
  })
  const BUFFER_CAP = 128 * 1024

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
    if (isRedrawReplay(cleanBuffer.value, cleaned)) return
    // Badge burst tracking, driven by CLEANED content only.
    const now = Date.now()
    // A gap > BURST_GAP_MS in clean output starts a new burst.
    if (now - lastCleanBurstAt.value > BURST_GAP_MS) activityBurstStartAt.value = now
    lastCleanBurstAt.value = now
    // Monotonic total — unlike cleanBuffer.length, this keeps growing after
    // the buffer hits BUFFER_CAP, so quiet-detection (waitForQuiet etc.) can
    // tell "still streaming" from "quiet" during large session replays.
    cleanBytesSeen.value += cleaned.length
    const next = cleanBuffer.value + cleaned
    cleanBuffer.value = bufferTail(next, BUFFER_CAP)
    // Skip the activity timestamp if this chunk arrived inside the focus
    // grace window — those bytes are very likely a focus-triggered TUI
    // redraw, not real agent output. Buffer content is still kept so any
    // genuine output isn't lost; only the timestamp is held back.
    const inFocusGrace = now - lastFocusAt.value < FOCUS_GRACE_MS
    if (!inFocusGrace) lastActivityAt.value = now
  }

  function markBufferPosition(): number {
    return cleanBuffer.value.length
  }

  /** Retroactively scrub TUI noise from the existing buffer — useful when
   *  the noise-filter rules change (HMR) or a watcher arms on an old pane. */
  function recleanBuffer(): void {
    cleanBuffer.value = dropTuiNoise(cleanBuffer.value)
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
    term.write(chunk)
    appendClean(chunk)
    appendToScrollBuffer(chunk)
  }
  let mounted = false
  let mountedEl: HTMLElement | null = null
  let _mousedownHandler: (() => void) | null = null
  let _cmdKeyDown: ((e: KeyboardEvent) => void) | null = null
  let _cmdKeyUp: ((e: KeyboardEvent) => void) | null = null
  let _cmdClickHandler: ((e: MouseEvent) => void) | null = null
  let _mousePosTracker: ((e: MouseEvent) => void) | null = null
  // Whether THIS pane's xterm textarea currently holds focus. Used to publish
  // the `terminalFocus` keybinding context (defaults.ts gates editor shortcuts
  // like cmd+f on `!terminalFocus`) and to clear it if the pane is disposed
  // while focused. Focus moving between two panes is safe: blur (old pane,
  // sets false) always fires before focus (new pane, sets true).
  let _ownsTerminalFocus = false
  const _onTermFocus = (): void => { _ownsTerminalFocus = true; setContext('terminalFocus', true) }
  const _onTermBlur = (): void => { _ownsTerminalFocus = false; setContext('terminalFocus', false) }

  // Set when a reattached pane is waiting to repaint. We never force_redraw at
  // reattach time: the renderer is mid-reflow then (reload, or a hidden tab
  // being shown), so the width is transient and would repaint the live agent
  // narrow. The reconciler fires the redraw only once container == xterm ==
  // backend, so Claude's TUI clears the transient frame and repaints at the real
  // width instead of stranding a narrow one in scrollback.
  let pendingReattachRedraw = false

  // TEMP diagnostic sink: route resize/redraw traces to a file the dev can read
  // directly (/tmp/agent-team-resize.log via the backend), instead of the
  // renderer console. Remove with the call sites once resize is confirmed.
  function dbgLog(line: string): void {
    if (!sessionId.value) return
    void backend.send('debug.log', { line: `${paneId} ${line}` }).catch(() => {})
  }

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

    // Publish terminal focus to the keybinding context (see _onTermFocus doc).
    term.textarea?.addEventListener('focus', _onTermFocus)
    term.textarea?.addEventListener('blur', _onTermBlur)

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
        return term.modes.mouseTrackingMode !== 'none'
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
      // IME guard: allow the browser to process composition (e.g. Zhuyin/Pinyin)
      if (e.isComposing) return true

      const buf = term.buffer.active
      const curX = buf.cursorX
      const curY = buf.baseY + buf.cursorY

      // ── Shift+Enter: newline without submitting ────────────────────────────
      // Traditional PTYs do not preserve the Shift modifier on Enter. Present
      // one shortcut to the user, then encode it for the active agent's input
      // protocol (CSI-u for Codex, bracketed paste for modern TUIs, Ctrl+V for bash).
      if (e.shiftKey && !e.metaKey && !e.altKey && !e.ctrlKey && e.key === 'Enter') {
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
    _mousedownHandler = () => {
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

    // ── Cmd+Click file search overlay ────────────────────────────────────────
    let _isCmdHeld = false
    let _lastMX = 0
    let _lastMY = 0

    _mousePosTracker = (e: MouseEvent) => { _lastMX = e.clientX; _lastMY = e.clientY }
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
          row.addEventListener('mousedown', (e) => { e.preventDefault(); close(); openInEditor(item.abs, lineNum) })
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
          if (item) { close(); openInEditor(item.abs, lineNum) }
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
        void openExternal(urlMatch.text)
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
      const rowText = term.buffer.active.getLine(bufferRow)?.translateToString(true) ?? ''
      const singleRaw = findFileLinkAt(rowText, strCol)
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
        const cands = [pieceRaw, match.text, singleRaw].filter(
          (c, i, arr): c is string => !!c && arr.indexOf(c) === i
        )
        const absList = cands.map((c) => resolveAbs(splitSuffix(c).filepath))
        const stats = await Promise.all(absList.map(statOk))
        const okIdx = stats.findIndex(Boolean)
        const chosenRaw = okIdx >= 0 ? cands[okIdx] : pieceRaw
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
  let rawScrollBuffer = ''
  function scrollSnapKey(): string { return `terminal-scroll:${persistKey}` }
  function loadScrollSnapshot(): string {
    try { return localStorage.getItem(scrollSnapKey()) ?? '' } catch { return '' }
  }
  function saveScrollSnapshot(): void {
    try {
      if (rawScrollBuffer) localStorage.setItem(scrollSnapKey(), rawScrollBuffer)
      else localStorage.removeItem(scrollSnapKey())
    } catch { /* quota exceeded — skip */ }
  }
  function appendToScrollBuffer(data: string): void {
    rawScrollBuffer += data
    if (rawScrollBuffer.length > SCROLL_SNAP_MAX) {
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

  // Wire input/output/exit handlers for the current sessionId. Shared by a fresh
  // spawn and a reattach so both bind identically.
  function bindSessionHandlers(): void {
    let inputBuffer = ''
    inputDisposer = term.onData((data) => {
      if (data === '\r' || data === '\n' || data === '\r\n') {
        if (inputBuffer.trim() === '/clear' && opts?.onClear) {
          inputBuffer = ''
          opts.onClear()
          return
        }
        inputBuffer = ''
      } else if (data === '\x7f' || data === '\b') {
        inputBuffer = inputBuffer.slice(0, -1)
      } else if (data.length === 1 && data.charCodeAt(0) >= 32) {
        inputBuffer += data
      } else if (data.length > 1) {
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
  async function tryReattach(): Promise<boolean> {
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
    let el = containerRef.value
    const visible = !!el && el.clientWidth > 0
    // A resume reprints the prior conversation and MUST paint at the real width,
    // so wait until the pane is measurable. A fresh spawn is empty: create it now
    // even while hidden (the reconciler corrects the width once the tab is shown).
    // Deferring a fresh spawn would stall e.g. a pipeline stage spawned into a
    // tab the user isn't currently viewing.
    if (opts.isResume && !visible) {
      // Hidden resume: if we have a cached layout size from another visible tab,
      // use it to start the PTY immediately. Otherwise wait until shown.
      if (_lastKnownCols > 0 && _lastKnownRows > 0) {
        try { term.resize(_lastKnownCols, _lastKnownRows) } catch { /* ignore */ }
      } else {
        return
      }
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
      const resp = await backend.send<{
        terminal_session_id: string
        pid: number
        startup_probe?: TerminalStartupProbe | null
      }>('terminal.create', {
        pane_id: paneId,
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
      }, TERMINAL_CREATE_TIMEOUT_MS)
      if (isDisposed) {
        // If the composable was torn down while the spawn was in flight,
        // kill the orphaned terminal session immediately so it doesn't leak.
        if (resp.ok && resp.payload?.terminal_session_id) {
          backend.send('terminal.kill', { terminal_session_id: resp.payload.terminal_session_id }).catch(() => {})
        }
        return
      }
      if (!resp.ok || !resp.payload) {
        status.value = 'error'
        error.value = resp.error?.message ?? 'spawn failed'
        term.writeln(`\r\n\x1b[31m[error] ${error.value}\x1b[0m`)
        const binaryPath = String(resp.error?.details?.binary_path ?? '')
        if (binaryPath && !error.value.includes(binaryPath)) {
          term.writeln(`\x1b[31m[binary] ${binaryPath}\x1b[0m`)
        }
        return
      }
      sessionId.value = resp.payload.terminal_session_id
      rememberSessionId(sessionId.value)  // enable reattach after a reload
      status.value = 'running'
      const probe = resp.payload.startup_probe
      if (probe?.binary_path) {
        const version = probe.version ? ` v${probe.version}` : ''
        const duration = typeof probe.duration_ms === 'number' ? `, ${probe.duration_ms}ms` : ''
        term.writeln(`\x1b[2m[startup probe] ${probe.binary_path}${version}${duration}\x1b[0m`)
      }
      // TEMP diagnostic: marks a fresh pane spawn so we can confirm the new code
      // is actually loaded (opening a pane writes a line even without resizing).
      dbgLog(`spawn cols=${term.cols} rows=${term.rows}`)
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
    dbgLog,
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
    error.value = ''
    status.value = 'starting'
    activeAgentKey = opts.agentKey
    activeCrashKey = terminalCrashKey({
      agentKey: opts.agentKey,
      cwd: opts.cwd,
      resumeKey: opts.resumeKey,
      command: opts.command,
    })
    if (opts.isResume && isTerminalCrashLoopOpen(activeCrashKey)) {
      status.value = 'error'
      error.value = 'Automatic rebuild stopped after 3 fast crashes. Use Respawn after fixing the CLI.'
      term.writeln(`\r\n\x1b[31m[error] ${error.value}\x1b[0m`)
      return
    }
    lastCommand.value = Array.isArray(opts.command) ? opts.command.join(' ') : opts.command
    // Use the stable CLI session id as the reattach key when provided, so the
    // lookup below survives a reload (paneId does not).
    if (opts.resumeKey) persistKey = opts.resumeKey
    // True persistence: a PTY from before a reload may still be running. Reattach
    // to it (recovering bash/build panes too, with no --resume round-trip) before
    // spawning anew. Falls through to a fresh spawn if the PTY is gone.
    if (!opts.skipReattach && await tryReattach()) return
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

  async function interrupt(): Promise<void> {
    if (!sessionId.value) return
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
    saveScrollSnapshot()  // persist scrollback before the pane is torn down
    cleanupSession()
    clearInterval(tickInterval)
    clearInterval(reconcileInterval)
    if (freshSpawnRefitTimer) clearTimeout(freshSpawnRefitTimer)
    resizeCtrl.dispose()
    if (mountedEl && _mousedownHandler) mountedEl.removeEventListener('mousedown', _mousedownHandler)
    if (_cmdKeyDown) window.removeEventListener('keydown', _cmdKeyDown)
    if (_cmdKeyUp) window.removeEventListener('keyup', _cmdKeyUp)
    if (mountedEl && _mousePosTracker) mountedEl.removeEventListener('mousemove', _mousePosTracker)
    if (mountedEl && _cmdClickHandler) mountedEl.removeEventListener('mousedown', _cmdClickHandler, { capture: true })
    document.querySelector('.term-file-picker-root')?.remove()
    closeMentionMenu()  // tear down any open @-mention menu (detaches doc listeners)
    term.textarea?.removeEventListener('focus', _onTermFocus)
    term.textarea?.removeEventListener('blur', _onTermBlur)
    // A pane disposed while focused never fires blur — clear the context so
    // `terminalFocus` cannot stay stuck on.
    if (_ownsTerminalFocus) _onTermBlur()
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
    interrupt,
    kill,
    focus,
    fitTerminal,
    redraw,
    pasteText,
    status,
    displayStatus,
    sessionId,
    error,
    lastCommand,
    cleanBuffer,
    cleanBytesSeen,
    lastActivityAt,
    lastRawActivityAt,
    markBufferPosition,
    recleanBuffer,
    readRenderedText,
    readLineBeforeCursor,
    updateXtermTheme,
    isAltBuffer,
    setDisableStdin: (disabled: boolean) => { term.options.disableStdin = disabled },
  }
}
