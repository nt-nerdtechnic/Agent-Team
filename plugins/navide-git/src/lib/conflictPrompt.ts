const MAX_FULL_LINES = 2_000
const MAX_FULL_CHARS = 120_000
const EXCERPT_CONTEXT = 20

interface ConflictPromptInput {
  workspacePath: string
  relativePath: string
  absolutePath: string
  content: string
  operation?: string
}

interface LineRange {
  start: number
  end: number
}

function conflictBlockRanges(lines: string[]): LineRange[] {
  const ranges: LineRange[] = []
  let open = -1
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? ''
    if (line.startsWith('<<<<<<<')) open = index
    else if (line.startsWith('>>>>>>>') && open >= 0) {
      ranges.push({ start: open + 1, end: index + 1 })
      open = -1
    }
  }
  return ranges
}

function excerptRanges(blocks: LineRange[], totalLines: number): LineRange[] {
  const merged: LineRange[] = []
  for (const block of blocks) {
    const start = Math.max(1, block.start - EXCERPT_CONTEXT)
    const end = Math.min(totalLines, block.end + EXCERPT_CONTEXT)
    const last = merged[merged.length - 1]
    if (last && start <= last.end + 1) last.end = Math.max(last.end, end)
    else merged.push({ start, end })
  }
  return merged
}

export function buildConflictPrompt(input: ConflictPromptInput): string {
  const lines = input.content.split('\n')
  const blocks = conflictBlockRanges(lines)
  const output = [
    'Resolve a git merge conflict for me.',
    '',
    `Repository: ${input.workspacePath}`,
    `File: ${input.relativePath} (absolute path: ${input.absolutePath})`,
    ...(input.operation ? [`Operation in progress: ${input.operation}`] : []),
    `Conflict blocks in this file: ${blocks.length}`,
    '',
    'What to do:',
    '1. Read both sides of every conflict block: "ours" is between <<<<<<< and =======, "theirs" is between ======= and >>>>>>>.',
    '2. Work out what each side is trying to do, then edit the file in place so the result keeps both intents wherever they are compatible.',
    '3. Remove every conflict marker line (<<<<<<<, |||||||, =======, >>>>>>>).',
    "4. Do not stage and do not commit — I review the result and commit from Navide's Git window.",
    '5. If a block is genuinely ambiguous, stop and explain the options instead of guessing.',
    '',
  ]
  if (lines.length <= MAX_FULL_LINES && input.content.length <= MAX_FULL_CHARS) {
    output.push(`Full content of ${input.relativePath}:`, '', input.content)
    return output.join('\n')
  }
  output.push(
    `The file is large (${lines.length} lines, ${input.content.length} characters), so only the conflict regions are quoted below, with ${EXCERPT_CONTEXT} lines of context around each one. This is an excerpt — read the complete file at ${input.absolutePath} before editing it.`,
    '',
  )
  if (blocks.length === 0) {
    output.push('(No conflict markers found — check whether the file is already resolved.)')
    return output.join('\n')
  }
  for (const range of excerptRanges(blocks, lines.length)) {
    output.push(
      `--- ${input.relativePath} lines ${range.start}-${range.end} ---`,
      ...lines.slice(range.start - 1, range.end),
      '',
    )
  }
  return output.join('\n')
}
