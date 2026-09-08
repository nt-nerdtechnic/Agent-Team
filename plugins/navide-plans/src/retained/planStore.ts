/**
 * planStore.ts
 *
 * Format-agnostic persistence adapter for plan documents. A `PlanStore` hides
 * whether a plan lives as an HTML `plan-meta` island (`.agent-team/plans/*.html`)
 * or a `.plan.md` YAML-frontmatter file behind one interface, so higher layers
 * can read/mutate a plan without branching on format.
 *
 * The two implementations do not reimplement any parsing/serialization: they
 * compose the existing format helpers (`usePlanHtml` / `usePlanFile`) and mirror
 * the optimistic-lock write flows already proven in `PlanReviewToolbar.writeMeta`
 * (HTML meta writes) and `PlanWindowApp.writePlanBody` (HTML body writes).
 *
 * Stage 1 scope: this module is standalone — nothing outside its test wires it
 * up yet, so existing HTML/markdown plan behavior is unchanged.
 */

import type { PlanMeta } from './planModel'
import type { PlansTransport } from './transport'
import {
  parsePlanMeta,
  writePlanMeta,
  replacePlanSectionBody,
  deleteSection as deleteMarkdownSection,
  parsePlanFile,
} from './usePlanFile'
import {
  parseHtmlPlanMeta,
  replaceHtmlPlanMeta,
  syncStageMarkup,
  syncTodoMarkup,
  replaceSectionBody as replaceHtmlSectionBody,
  deleteSection as deleteHtmlSection,
  type HtmlPlanMeta,
} from './usePlanHtml'
import { extractPlanOutline } from './planRuntime'

type Backend = PlansTransport

export interface ReadResult {
  meta: PlanMeta
  raw: string
  mtime?: number
  warnings: string[]
}

export interface WriteResult {
  ok: boolean
  conflict?: boolean
  error?: string
  /** The final on-disk content on success, or the fresh content on abandon. */
  raw?: string
}

export type SectionBody = { kind: 'markdown'; text: string } | { kind: 'html'; sanitized: string }

export interface PlanCtx {
  backend: Backend
  workspacePath: string
  relPath: string
}

export interface PlanStore {
  readonly format: 'markdown' | 'html'
  canHandle(relPath: string): boolean
  /**
   * Pure, synchronous meta parse of already-read content (no I/O). The review
   * toolbar uses it to refresh its local `meta` state from freshly written
   * bytes without re-branching on format. Returns null when the content is not
   * a valid plan of this store's format.
   */
  parseMeta(raw: string): PlanMeta | null
  readMeta(ctx: PlanCtx): Promise<ReadResult | null>
  writeMeta(
    ctx: PlanCtx,
    mutate: (fresh: PlanMeta) => PlanMeta | null,
    /**
     * Optional structural body-markup sync applied to the already
     * meta+status-synced content, immediately before the write (same read,
     * same expected_mtime). Mirrors the toolbar's original `syncBody` step for
     * todo/note CRUD (insert/remove/retext `<li>`); status-only markup is
     * handled internally, so callers pass this only for structural edits.
     */
    syncBody?: (content: string) => string,
  ): Promise<WriteResult>
  replaceSectionBody(ctx: PlanCtx, anchor: string, body: SectionBody): Promise<WriteResult>
  deleteSection(ctx: PlanCtx, anchor: string): Promise<WriteResult>
  outline(raw: string): string[]
}

interface ReadFileResp {
  ok: boolean
  content?: string
  mtime?: number
  error?: string
}
interface WriteFileResp {
  ok: boolean
  conflict?: boolean
  error?: string
}

/** Read the plan file's fresh content + mtime through the backend. */
function readFile(ctx: PlanCtx) {
  return ctx.backend.send<ReadFileResp>('fs.read_file', {
    workspace_path: ctx.workspacePath,
    rel_path: ctx.relPath,
  })
}

/** Write content back with the optimistic-lock `expected_mtime` (when known). */
function writeFile(ctx: PlanCtx, content: string, expectedMtime?: number) {
  return ctx.backend.send<WriteFileResp>('fs.write_file', {
    workspace_path: ctx.workspacePath,
    rel_path: ctx.relPath,
    content,
    ...(typeof expectedMtime === 'number' ? { expected_mtime: expectedMtime } : {}),
  })
}

/**
 * Shared body-write flow, mirroring `PlanWindowApp.writePlanBody`: re-read fresh
 * content + mtime, apply the byte-surgical `mutate` to the fresh bytes, write
 * with `expected_mtime`, retry once on a conflict. A mutation that leaves the
 * content unchanged (anchor gone / refused region) is a silent no-op success —
 * no write is issued, matching the reference.
 */
async function writeBody(ctx: PlanCtx, mutate: (fresh: string) => string): Promise<WriteResult> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const readResp = await readFile(ctx)
    if (!readResp.payload?.ok || readResp.payload.content === undefined) {
      return { ok: false, error: readResp.payload?.error }
    }
    const fresh = readResp.payload.content
    const expectedMtime = readResp.payload.mtime
    const next = mutate(fresh)
    if (next === fresh) return { ok: true, raw: fresh } // no-op: anchor not found or region refused
    const resp = await writeFile(ctx, next, expectedMtime)
    if (resp.payload?.ok) return { ok: true, raw: next }
    if (resp.payload?.conflict) {
      if (attempt === 0) continue // file changed under us — re-read and retry once
      return { ok: false, conflict: true, error: resp.payload?.error }
    }
    return { ok: false, error: resp.payload?.error }
  }
  return { ok: false } // unreachable: both iterations return
}

/** Strip the memory-only `format` field before serialization; never persisted. */
function toHtmlMeta(meta: PlanMeta): HtmlPlanMeta {
  const { format: _format, ...rest } = meta
  return rest as HtmlPlanMeta
}

// ── HTML plans (`plan-meta` island) ────────────────────────────────────────
class HtmlPlanStore implements PlanStore {
  readonly format = 'html' as const

  canHandle(relPath: string): boolean {
    return relPath.endsWith('.html')
  }

  parseMeta(raw: string): PlanMeta | null {
    const parsed = parseHtmlPlanMeta(raw)
    return parsed ? ({ ...parsed.meta, format: 'html' } as PlanMeta) : null
  }

  async readMeta(ctx: PlanCtx): Promise<ReadResult | null> {
    const readResp = await readFile(ctx)
    if (!readResp.payload?.ok || readResp.payload.content === undefined) return null
    const raw = readResp.payload.content
    const parsed = parseHtmlPlanMeta(raw)
    if (!parsed) return null
    const meta = { ...parsed.meta, format: 'html' } as PlanMeta
    return { meta, raw, mtime: readResp.payload.mtime, warnings: parsed.warnings }
  }

  /**
   * Optimistic-lock meta write, mirroring `PlanReviewToolbar.writeMeta` byte for
   * byte: re-read fresh content + mtime → parseHtmlPlanMeta → mutate → on null,
   * abandon → replaceHtmlPlanMeta → syncStageMarkup → syncTodoMarkup per todo
   * (same timing/order) → optional syncBody → write with expected_mtime →
   * retry once on conflict.
   */
  async writeMeta(
    ctx: PlanCtx,
    mutate: (fresh: PlanMeta) => PlanMeta | null,
    syncBody?: (content: string) => string,
  ): Promise<WriteResult> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const readResp = await readFile(ctx)
      if (!readResp.payload?.ok || readResp.payload.content === undefined) {
        return { ok: false, error: readResp.payload?.error }
      }
      const freshContent = readResp.payload.content
      const expectedMtime = readResp.payload.mtime
      const parsed = parseHtmlPlanMeta(freshContent)
      if (!parsed) return { ok: false, error: 'not a plan file' }
      const next = mutate({ ...parsed.meta, format: 'html' } as PlanMeta)
      if (!next) return { ok: false, raw: freshContent } // mutation abandoned
      const nextHtml = toHtmlMeta(next)
      let content = replaceHtmlPlanMeta(freshContent, nextHtml)
      content = syncStageMarkup(content, nextHtml.stage)
      for (const todo of nextHtml.todos) content = syncTodoMarkup(content, todo.id, todo.status)
      if (syncBody) content = syncBody(content)
      const resp = await writeFile(ctx, content, expectedMtime)
      if (resp.payload?.ok) return { ok: true, raw: content }
      if (resp.payload?.conflict) {
        if (attempt === 0) continue // re-read and retry once
        return { ok: false, conflict: true, error: resp.payload?.error }
      }
      return { ok: false, error: resp.payload?.error }
    }
    return { ok: false } // unreachable: both iterations return
  }

  replaceSectionBody(ctx: PlanCtx, anchor: string, body: SectionBody): Promise<WriteResult> {
    const html = body.kind === 'html' ? body.sanitized : body.text
    return writeBody(ctx, (fresh) => replaceHtmlSectionBody(fresh, anchor, html))
  }

  deleteSection(ctx: PlanCtx, anchor: string): Promise<WriteResult> {
    return writeBody(ctx, (fresh) => deleteHtmlSection(fresh, anchor))
  }

  outline(raw: string): string[] {
    return extractPlanOutline(raw)
  }
}

// ── Markdown plans (`.plan.md` YAML frontmatter) ───────────────────────────
class MarkdownPlanStore implements PlanStore {
  readonly format = 'markdown' as const

  canHandle(relPath: string): boolean {
    return relPath.endsWith('.plan.md') || relPath.endsWith('.md')
  }

  parseMeta(raw: string): PlanMeta | null {
    return parsePlanMeta(raw)
  }

  async readMeta(ctx: PlanCtx): Promise<ReadResult | null> {
    const readResp = await readFile(ctx)
    if (!readResp.payload?.ok || readResp.payload.content === undefined) return null
    const raw = readResp.payload.content
    const meta = parsePlanMeta(raw)
    if (!meta) return null
    return { meta, raw, mtime: readResp.payload.mtime, warnings: [] }
  }

  async writeMeta(
    ctx: PlanCtx,
    mutate: (fresh: PlanMeta) => PlanMeta | null,
    syncBody?: (content: string) => string,
  ): Promise<WriteResult> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const readResp = await readFile(ctx)
      if (!readResp.payload?.ok || readResp.payload.content === undefined) {
        return { ok: false, error: readResp.payload?.error }
      }
      const freshContent = readResp.payload.content
      const expectedMtime = readResp.payload.mtime
      const freshMeta = parsePlanMeta(freshContent)
      if (!freshMeta) return { ok: false, error: 'not a plan file' }
      const next = mutate(freshMeta)
      if (!next) return { ok: false, raw: freshContent } // mutation abandoned
      let content = writePlanMeta(next, freshContent)
      if (syncBody) content = syncBody(content)
      const resp = await writeFile(ctx, content, expectedMtime)
      if (resp.payload?.ok) return { ok: true, raw: content }
      if (resp.payload?.conflict) {
        if (attempt === 0) continue // re-read and retry once
        return { ok: false, conflict: true, error: resp.payload?.error }
      }
      return { ok: false, error: resp.payload?.error }
    }
    return { ok: false } // unreachable: both iterations return
  }

  replaceSectionBody(ctx: PlanCtx, anchor: string, body: SectionBody): Promise<WriteResult> {
    const text = body.kind === 'markdown' ? body.text : body.sanitized
    return writeBody(ctx, (fresh) => replacePlanSectionBody(fresh, anchor, text))
  }

  deleteSection(ctx: PlanCtx, anchor: string): Promise<WriteResult> {
    return writeBody(ctx, (fresh) => deleteMarkdownSection(fresh, anchor))
  }

  outline(raw: string): string[] {
    // Only sections PlanMarkdownBody actually renders (non-empty body); an empty
    // `##` heading has no anchor to scroll to, so listing it dead-ends the nav.
    return parsePlanFile(raw)?.sections.filter((s) => s.body.trim()).map((s) => s.heading) ?? []
  }
}

const htmlPlanStore = new HtmlPlanStore()
const markdownPlanStore = new MarkdownPlanStore()

/** Resolve the store for a plan file by extension: `.html` → HTML, else Markdown. */
export function resolvePlanStore(relPath: string): PlanStore {
  return relPath.endsWith('.html') ? htmlPlanStore : markdownPlanStore
}
