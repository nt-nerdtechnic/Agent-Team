// Shared contract for everything the right-rail preview panel can show.
//
// The union deliberately splits on "is there a real file behind this" rather
// than on render kind: file-backed targets defer to previewKind() in
// editor/previewTypes.ts, so adding a new file type there needs no change
// here. Only the file-less kinds (agent-pushed snippets) are enumerated.

export type PreviewSource = 'user' | 'agent' | 'plugin'

interface PreviewCommon {
  // Who asked for this preview. Drives the footer attribution; defaults to
  // 'user' when a caller omits it.
  source?: PreviewSource
  // Display name of the agent or plugin when source is not 'user'.
  origin?: string
}

export type PreviewTarget = PreviewCommon &
  (
    | { kind: 'file'; workspacePath: string; relPath: string }
    | {
        kind: 'diff'
        workspacePath: string
        relPath: string
        staged?: boolean
        commit?: string
      }
    | { kind: 'snippet'; content: string; lang?: string; title?: string }
    | { kind: 'html'; content: string; title?: string }
    | { kind: 'markdown'; content: string; title?: string }
  )

// Upper bound on agent-pushed inline content. Large payloads belong in
// a file the panel can stream instead of being held in renderer memory.
export const MAX_INLINE_CONTENT = 512 * 1024

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null
}

function source(v: unknown): PreviewSource | undefined {
  return v === 'user' || v === 'agent' || v === 'plugin' ? v : undefined
}

// Validates untrusted input into a PreviewTarget. Today the only external
// caller is the MCP ui.preview.show command; plugins cannot reach it, since
// their ui.* calls go through the main process capability broker whose
// host-action table does not list preview. Returns null rather than throwing
// so callers can report a normal error to the sender.
export function normalizePreviewTarget(input: unknown): PreviewTarget | null {
  if (!isRecord(input)) return null
  const common: PreviewCommon = {
    source: source(input.source),
    origin: str(input.origin) ?? undefined,
  }

  switch (input.kind) {
    case 'file': {
      const workspacePath = str(input.workspacePath)
      const relPath = str(input.relPath)
      if (!workspacePath || !relPath) return null
      return { ...common, kind: 'file', workspacePath, relPath }
    }
    case 'diff': {
      const workspacePath = str(input.workspacePath)
      const relPath = str(input.relPath)
      if (!workspacePath || !relPath) return null
      return {
        ...common,
        kind: 'diff',
        workspacePath,
        relPath,
        staged: input.staged === true,
        commit: str(input.commit) ?? undefined,
      }
    }
    case 'snippet':
    case 'html':
    case 'markdown': {
      const content = typeof input.content === 'string' ? input.content : null
      if (content === null || content.length > MAX_INLINE_CONTENT) return null
      const base = { ...common, content, title: str(input.title) ?? undefined }
      return input.kind === 'snippet'
        ? { ...base, kind: 'snippet', lang: str(input.lang) ?? undefined }
        : { ...base, kind: input.kind }
    }
    default:
      return null
  }
}

// Attribution for anything arriving on the external command bus, applied at
// the boundary rather than trusted from the payload: a caller must not be able
// to omit `source` and have its content read as something the user opened.
// Lives here rather than inline in the command handler so it can be tested
// without mounting the whole app shell.
export function asAgentPush(t: PreviewTarget): PreviewTarget {
  return { ...t, source: 'agent', origin: t.origin ?? 'MCP' }
}

// Short label shown in the panel header. File-backed targets use the basename;
// inline targets use their title or fall back to the kind.
export function previewTitle(t: PreviewTarget): string {
  if (t.kind === 'file' || t.kind === 'diff') {
    return t.relPath.split('/').pop() || t.relPath
  }
  return t.title ?? t.kind
}

// Full path or origin line shown under the title.
export function previewSubtitle(t: PreviewTarget): string {
  if (t.kind === 'file') return t.relPath
  if (t.kind === 'diff') {
    if (t.commit) return `${t.relPath} · ${t.commit.slice(0, 7)}`
    return `${t.relPath} · ${t.staged ? 'staged' : 'working tree'}`
  }
  return t.kind === 'snippet' ? (t.lang ?? '') : ''
}
