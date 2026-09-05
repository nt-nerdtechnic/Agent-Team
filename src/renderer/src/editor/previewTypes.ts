// Shared file-preview classification used by the editor window router and
// FilePreviewPane. Extension-based: the router must decide before any file
// content is read. Files outside every list open in the text editor as before
// (EditorPane's own binary branch covers the ones that turn out to be binary).

export type PreviewKind =
  | 'image' | 'video' | 'audio' | 'pdf' | 'html' | 'csv' | 'font' | 'archive'
  | 'notebook' | 'office' | 'binary'

const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp', 'ico', 'svg', 'avif', 'apng'])
const VIDEO_EXTS = new Set(['mp4', 'webm', 'mov', 'm4v', 'mkv', 'ogv'])
const AUDIO_EXTS = new Set(['mp3', 'wav', 'm4a', 'ogg', 'flac', 'aac', 'opus'])
// HTML previews in a sandboxed iframe; opens raw by default like markdown.
const HTML_EXTS = new Set(['html', 'htm'])
// Delimited text: sortable table preview; opens raw with a Preview toggle.
const CSV_EXTS = new Set(['csv', 'tsv'])
// Font specimen via dynamic @font-face (checked before the binary fallback).
const FONT_EXTS = new Set(['ttf', 'otf', 'woff', 'woff2'])
// Archive entry listing via fs.list_archive (checked before the binary
// fallback; .tar.gz is special-cased below since its fileExt is 'gz').
const ARCHIVE_EXTS = new Set(['zip', 'tar', 'tgz'])
// Jupyter notebooks: nbformat JSON rendered cell-by-cell (auto-preview).
const NOTEBOOK_EXTS = new Set(['ipynb'])
// Office documents converted by the backend fs.convert_office handler
// (checked before the binary fallback since docx/xlsx are in BINARY_EXTS).
const OFFICE_EXTS = new Set(['docx', 'xlsx'])
// Known-binary extensions that get the info-card + hex-dump fallback.
const BINARY_EXTS = new Set([
  'zip', 'tar', 'gz', 'tgz', 'bz2', 'xz', '7z', 'rar', 'jar', 'war',
  'exe', 'dll', 'so', 'dylib', 'bin', 'dat', 'o', 'a', 'class', 'pyc', 'wasm',
  'db', 'sqlite', 'sqlite3', 'dmg', 'iso',
  'woff', 'woff2', 'ttf', 'otf', 'eot',
  'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx',
])

export function fileExt(relPath: string): string {
  const name = relPath.split('/').pop() ?? ''
  const idx = name.lastIndexOf('.')
  return idx > 0 ? name.slice(idx + 1).toLowerCase() : ''
}

// Preview kind for files the preview pane can render; null for everything
// else (text files, markdown, unknown extensions). All kinds except 'html'
// and 'csv' auto-open in preview; those open raw with a Preview toggle.
// Font and archive checks run before the binary fallback so their extensions
// win over BINARY_EXTS membership.
export function previewKind(relPath: string): PreviewKind | null {
  const ext = fileExt(relPath)
  if (IMAGE_EXTS.has(ext)) return 'image'
  if (VIDEO_EXTS.has(ext)) return 'video'
  if (AUDIO_EXTS.has(ext)) return 'audio'
  if (ext === 'pdf') return 'pdf'
  if (HTML_EXTS.has(ext)) return 'html'
  if (CSV_EXTS.has(ext)) return 'csv'
  if (FONT_EXTS.has(ext)) return 'font'
  if (ARCHIVE_EXTS.has(ext) || relPath.toLowerCase().endsWith('.tar.gz')) return 'archive'
  if (NOTEBOOK_EXTS.has(ext)) return 'notebook'
  if (OFFICE_EXTS.has(ext)) return 'office'
  if (BINARY_EXTS.has(ext)) return 'binary'
  return null
}

// Plain markdown (not .plan.md — those route to the plan view instead).
export function isMarkdownFile(relPath: string): boolean {
  return relPath.endsWith('.md') && !relPath.endsWith('.plan.md')
}

// The ws token rides on the socket URL the main process hands the renderer
// (`ws://host:port/ws?t=…`). The HTTP file routes share it as their
// credential, so the renderer pulls it back out of that URL rather than
// carrying a second copy.
export function wsTokenFromUrl(wsUrl: string): string {
  const m = /[?&]t=([^&#]*)/.exec(wsUrl || '')
  return m ? decodeURIComponent(m[1]) : ''
}

// URL for the backend's raw-file endpoint (GET /fs/raw, Range-capable).
// `token` is the ws token; /fs/raw refuses without it. This URL is only ever
// used by the trusted renderer (img/video/audio/font src, fetch) — never by
// content inside the sandboxed HTML preview, which is why the token may sit
// in the query here and must not in buildPageUrl.
export function buildRawUrl(httpUrl: string, workspacePath: string, relPath: string, token: string): string {
  const base = httpUrl.replace(/\/+$/, '')
  return (
    `${base}/fs/raw?workspace=${encodeURIComponent(workspacePath)}` +
    `&rel=${encodeURIComponent(relPath)}&t=${encodeURIComponent(token)}`
  )
}

// URL for the backend's path-addressed page endpoint
// (GET /fs/page/{cap}/{ws_b64}/{rel:path}), used by the HTML preview so
// relative subresources (./style.css, images) resolve against the same route.
// `cap` is the per-workspace capability from `fs.page_capability` — not the
// ws token: the previewed document is untrusted and can leak its own URL
// through Referer. `wsB64` is the unpadded URL-safe base64 of the UTF-8
// workspace path — matching Python's base64.urlsafe_b64encode (the backend
// re-pads before decoding); the backend returns it alongside the cap so both
// ends agree byte-for-byte on the scope the cap was computed over. Rel path
// segments are percent-encoded individually so slashes survive.
export function buildPageUrl(httpUrl: string, cap: string, wsB64: string, relPath: string): string {
  const rel = relPath.split('/').map(encodeURIComponent).join('/')
  const base = httpUrl.replace(/\/+$/, '')
  return `${base}/fs/page/${cap}/${wsB64}/${rel}`
}
