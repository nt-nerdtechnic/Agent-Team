export type ConflictChoice = 'ours' | 'theirs' | 'both' | 'base' | 'manual'

export interface ContextSection {
  kind: 'context'
  lines: string[]
}

export interface ConflictSection {
  kind: 'conflict'
  oursLabel: string   // text after <<<<<<<
  theirsLabel: string // text after >>>>>>>
  ours: string[]
  /**
   * Common-ancestor lines, present only when the user's git writes diff3 /
   * zdiff3 style conflicts (a `|||||||` block between ours and theirs).
   * Empty array both when there is no `|||||||` marker and when the marker is
   * there but the base side is empty — use `hasBase` to tell those apart.
   */
  base: string[]
  /** True when the block carries a `|||||||` marker line. */
  hasBase: boolean
  theirs: string[]
}

export type FileSection = ContextSection | ConflictSection

export function parseConflicts(content: string): FileSection[] {
  const lines = content.split('\n')
  // strip the trailing empty string that split produces when content ends with \n
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()

  const sections: FileSection[] = []
  let i = 0

  while (i < lines.length) {
    const line = lines[i]
    if (line.startsWith('<<<<<<<')) {
      const oursLabel = line.slice(7).trim()
      const oursLines: string[] = []
      const baseLines: string[] = []
      const theirsLines: string[] = []
      let theirsLabel = ''
      let hasBase = false
      let phase: 'ours' | 'base' | 'theirs' = 'ours'
      i++
      while (i < lines.length) {
        const cl = lines[i]
        // `|||||||` only opens the diff3 base side while we are still on the
        // ours side; anywhere else it is ordinary content (as before).
        if (phase === 'ours' && cl.startsWith('|||||||')) {
          hasBase = true
          phase = 'base'
        } else if (cl.startsWith('=======')) {
          phase = 'theirs'
        } else if (cl.startsWith('>>>>>>>')) {
          theirsLabel = cl.slice(7).trim()
          i++
          break
        } else if (phase === 'ours') {
          oursLines.push(cl)
        } else if (phase === 'base') {
          baseLines.push(cl)
        } else {
          theirsLines.push(cl)
        }
        i++
      }
      sections.push({
        kind: 'conflict', oursLabel, theirsLabel,
        ours: oursLines, base: baseLines, hasBase, theirs: theirsLines,
      })
    } else {
      // accumulate context lines
      const last = sections[sections.length - 1]
      if (last?.kind === 'context') {
        last.lines.push(line)
      } else {
        sections.push({ kind: 'context', lines: [line] })
      }
      i++
    }
  }

  return sections
}

export function hasConflicts(content: string): boolean {
  return content.includes('<<<<<<<')
}

export function buildResolved(
  sections: FileSection[],
  choices: Map<number, ConflictChoice>,
  manualEdits: Map<number, string>,
): string {
  const parts: string[] = []
  let conflictIdx = 0

  for (const section of sections) {
    if (section.kind === 'context') {
      parts.push(...section.lines)
    } else {
      const choice = choices.get(conflictIdx) ?? 'ours'
      if (choice === 'manual') {
        const edited = manualEdits.get(conflictIdx) ?? section.ours.join('\n')
        parts.push(...edited.split('\n'))
      } else if (choice === 'ours') {
        parts.push(...section.ours)
      } else if (choice === 'theirs') {
        parts.push(...section.theirs)
      } else if (choice === 'base') {
        parts.push(...section.base)
      } else {
        // both: ours first, then theirs
        parts.push(...section.ours)
        parts.push(...section.theirs)
      }
      conflictIdx++
    }
  }

  return parts.join('\n') + '\n'
}

export function countConflicts(sections: FileSection[]): number {
  return sections.filter((s) => s.kind === 'conflict').length
}
