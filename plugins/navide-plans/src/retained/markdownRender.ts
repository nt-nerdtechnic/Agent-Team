// Shared line-based markdown rendering used by PlanMarkdownBody (section bodies
// + plain-markdown fallback). Deliberately line-oriented — no marked/markdown-it
// dependency.
import { defineComponent, h } from 'vue'
import { callCapability } from '../backend'

export type RenderLine =
  | { kind: 'blank'; text: string }
  | { kind: 'bullet'; text: string }
  | { kind: 'ordered'; marker: string; text: string }
  | { kind: 'heading'; level: number; text: string }
  | { kind: 'quote'; text: string }
  | { kind: 'paragraph'; text: string }
  | { kind: 'codeblock'; lang: string; text: string }

export function renderLines(body: string): RenderLine[] {
  const lines: RenderLine[] = []
  let codeBlock: { kind: 'codeblock'; lang: string; text: string } | null = null
  for (const raw of body.split('\n')) {
    const line = raw.trimEnd()
    const fence = line.trim().match(/^```(\S*)/)
    if (fence) {
      if (codeBlock) {
        lines.push(codeBlock)
        codeBlock = null
      } else {
        codeBlock = { kind: 'codeblock', lang: fence[1].toLowerCase(), text: '' }
      }
      continue
    }
    if (codeBlock) {
      codeBlock.text += codeBlock.text ? '\n' + line : line
    } else if (!line.trim()) {
      lines.push({ kind: 'blank', text: '' })
    } else if (/^#{1,4}\s+/.test(line.trim())) {
      const m = line.trim().match(/^(#{1,4})\s+(.*)/)!
      lines.push({ kind: 'heading', level: m[1].length, text: m[2] })
    } else if (/^\s*>\s?/.test(line)) {
      lines.push({ kind: 'quote', text: line.replace(/^\s*>\s?/, '') })
    } else if (/^\s*[-*]\s+/.test(line)) {
      lines.push({ kind: 'bullet', text: line.replace(/^\s*[-*]\s+/, '') })
    } else if (/^\s*\d+[.)]\s+/.test(line)) {
      const m = line.match(/^\s*(\d+)[.)]\s+(.+)/)!
      lines.push({ kind: 'ordered', marker: `${m[1]}.`, text: m[2] })
    } else {
      lines.push({ kind: 'paragraph', text: line.trim() })
    }
  }
  if (codeBlock) lines.push(codeBlock)
  return lines
}

// Render inline `code`, **bold** and [text](url) spans inside a markdown line.
export type InlineSegment =
  | { kind: 'text' | 'code' | 'bold'; text: string }
  | { kind: 'link'; text: string; href: string }

export function inlineSegments(text: string): InlineSegment[] {
  const segments: InlineSegment[] = []
  const re = /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)|`([^`]+)`|\*\*([^*]+)\*\*/g
  let last = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(text))) {
    if (m.index > last) segments.push({ kind: 'text', text: text.slice(last, m.index) })
    if (m[1] !== undefined) segments.push({ kind: 'link', text: m[1], href: m[2] })
    else if (m[3] !== undefined) segments.push({ kind: 'code', text: m[3] })
    else segments.push({ kind: 'bold', text: m[4] })
    last = m.index + m[0].length
  }
  if (last < text.length) segments.push({ kind: 'text', text: text.slice(last) })
  return segments
}

export const InlineText = defineComponent({
  props: { text: { type: String, default: '' } },
  setup(props) {
    return () =>
      inlineSegments(props.text).map((seg) => {
        if (seg.kind === 'code') return h('code', seg.text)
        if (seg.kind === 'bold') return h('strong', seg.text)
        if (seg.kind === 'link') {
          return h(
            'a',
            {
              class: 'pfv-link',
              href: seg.href,
              title: seg.href,
              onClick: (e: Event) => {
                e.preventDefault()
                // The package has no Host global; external links go through
                // the declared `ui` capability.
                void callCapability('ui', 'openExternal', { url: seg.href })
              },
            },
            seg.text,
          )
        }
        return seg.text
      })
  },
})
