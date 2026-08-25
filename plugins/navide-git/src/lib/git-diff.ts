// Pure helpers for hunk- and line-level staging.
//
// We parse a single-file unified diff into hunks, then rebuild a minimal patch
// for a chosen hunk (or a subset of its +/- lines) so it can be fed to
// `git apply --cached`. Kept dependency-free and side-effect-free so it can be
// unit-tested in isolation.

export type DiffLineKind = ' ' | '+' | '-' | '\\'

export interface HunkLine {
  kind: DiffLineKind
  text: string // raw line WITHOUT the trailing newline (prefix char included)
}

export interface Hunk {
  header: string // the raw '@@ -a,b +c,d @@ ...' line
  oldStart: number
  oldCount: number
  newStart: number
  newCount: number
  lines: HunkLine[]
}

export interface ParsedDiff {
  fileHeader: string // everything before the first '@@' (diff --git / index / --- / +++)
  hunks: Hunk[]
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/

function kindOf(line: string): DiffLineKind | null {
  if (line.startsWith('+')) return '+'
  if (line.startsWith('-')) return '-'
  if (line.startsWith(' ')) return ' '
  if (line.startsWith('\\')) return '\\' // "\ No newline at end of file"
  return null
}

/** Split a single-file unified diff into its file header and hunks. */
const _MAX_HUNKS = 500
const _MAX_HUNK_LINES = 10_000

export function parseHunks(raw: string): ParsedDiff {
  const lines = raw.split('\n')
  const headerLines: string[] = []
  const hunks: Hunk[] = []
  let i = 0

  // Collect file header until the first hunk.
  while (i < lines.length && !lines[i].startsWith('@@')) {
    headerLines.push(lines[i])
    i++
  }
  // Drop a trailing empty element produced by a final newline.
  while (headerLines.length && headerLines[headerLines.length - 1] === '') headerLines.pop()

  while (i < lines.length) {
    if (hunks.length >= _MAX_HUNKS) break  // guard: very large diffs would freeze the renderer
    const m = HUNK_RE.exec(lines[i])
    if (!m) {
      i++
      continue
    }
    const hunk: Hunk = {
      header: lines[i],
      oldStart: Number(m[1]),
      oldCount: m[2] === undefined ? 1 : Number(m[2]),
      newStart: Number(m[3]),
      newCount: m[4] === undefined ? 1 : Number(m[4]),
      lines: [],
    }
    i++
    while (i < lines.length && !lines[i].startsWith('@@')) {
      if (hunk.lines.length >= _MAX_HUNK_LINES) { i++; continue }
      const k = kindOf(lines[i])
      if (k === null) {
        // Blank final line from split; stop this hunk.
        if (lines[i] === '' && i === lines.length - 1) break
        i++
        continue
      }
      hunk.lines.push({ kind: k, text: lines[i] })
      i++
    }
    hunks.push(hunk)
  }

  return { fileHeader: headerLines.join('\n'), hunks }
}

/**
 * Build a minimal patch for one hunk to feed `git apply`.
 *
 * - Whole hunk (no `selected`): emit the hunk verbatim.
 * - Partial (`selected` = set of indexes into `hunk.lines`): keep selected +/-
 *   lines; drop unselected `+` lines; turn unselected `-` lines into context.
 *
 * `newStart` is pinned to `oldStart` because each hunk is applied in isolation
 * against HEAD/index (no preceding hunk shifts the line numbers). Counts are
 * recomputed; the backend also passes `--recount` as a safety net.
 */
export function buildPatch(
  parsed: ParsedDiff,
  hunk: Hunk,
  selected?: Set<number>,
): string {
  const body: string[] = []
  let oldCount = 0
  let newCount = 0

  hunk.lines.forEach((ln, idx) => {
    if (ln.kind === '\\') {
      body.push(ln.text)
      return
    }
    if (ln.kind === ' ') {
      body.push(ln.text)
      oldCount++
      newCount++
      return
    }
    const isSelected = !selected || selected.has(idx)
    if (ln.kind === '+') {
      if (isSelected) {
        body.push(ln.text)
        newCount++
      }
      // unselected addition -> omit entirely
      return
    }
    // kind === '-'
    if (isSelected) {
      body.push(ln.text)
      oldCount++
    } else {
      // keep the line in the index: convert removal into context
      body.push(' ' + ln.text.slice(1))
      oldCount++
      newCount++
    }
  })

  const header = `@@ -${hunk.oldStart},${oldCount} +${hunk.oldStart},${newCount} @@`
  const parts = parsed.fileHeader ? [parsed.fileHeader, header, ...body] : [header, ...body]
  return parts.join('\n') + '\n'
}

/** True if the hunk has at least one add/remove line (i.e. is stageable). */
export function hunkHasChanges(hunk: Hunk): boolean {
  return hunk.lines.some((l) => l.kind === '+' || l.kind === '-')
}

// ── side-by-side layout ───────────────────────────────────────────────────────

export interface SideCell {
  lineNo: number
  text: string // content WITHOUT the +/-/space prefix
  kind: ' ' | '+' | '-'
  idx: number // index into hunk.lines, for staging selection
}

export interface SideRow {
  left: SideCell | null
  right: SideCell | null
}

/**
 * Turn a hunk into aligned left/right rows for a side-by-side view.
 *
 * Context lines appear on both sides at the same row. A run of removals and
 * additions is paired index-by-index (del[i] | add[i]); the shorter side is
 * padded with `null`. Each cell carries its `hunk.lines` index so the viewer
 * can drive line-level staging through `buildPatch`.
 */
export function toSideBySide(hunk: Hunk): SideRow[] {
  const rows: SideRow[] = []
  let leftNo = hunk.oldStart
  let rightNo = hunk.newStart
  let dels: SideCell[] = []
  let adds: SideCell[] = []

  const flush = (): void => {
    const n = Math.max(dels.length, adds.length)
    for (let i = 0; i < n; i++) rows.push({ left: dels[i] ?? null, right: adds[i] ?? null })
    dels = []
    adds = []
  }

  hunk.lines.forEach((ln, idx) => {
    const content = ln.text.slice(1)
    if (ln.kind === ' ') {
      flush()
      rows.push({
        left: { lineNo: leftNo, text: content, kind: ' ', idx },
        right: { lineNo: rightNo, text: content, kind: ' ', idx },
      })
      leftNo++
      rightNo++
    } else if (ln.kind === '-') {
      dels.push({ lineNo: leftNo, text: content, kind: '-', idx })
      leftNo++
    } else if (ln.kind === '+') {
      adds.push({ lineNo: rightNo, text: content, kind: '+', idx })
      rightNo++
    }
    // '\\' (No newline at end of file) markers are ignored for display.
  })
  flush()
  return rows
}
