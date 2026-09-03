import { describe, it, expect } from 'vitest'
import {
  htmlPlanAwaitingUser,
  htmlPlanProgress,
  injectPlanMeta,
  parseHtmlPlanMeta,
  replaceHtmlPlanMeta,
  syncStageMarkup,
  syncTodoMarkup,
  addTodoMarkup,
  removeTodoMarkup,
  setTodoContentMarkup,
  setNoteTextMarkup,
  removeNoteMarkup,
  replaceSectionBody,
  deleteSection,
  type HtmlPlanMeta,
} from '../usePlanHtml'

function wrapHtml(metaJson: string): string {
  return `<!doctype html>
<html lang="zh-Hant">
<head>
<meta charset="utf-8">
<title>Sample Plan</title>

<script type="application/json" id="plan-meta">
${metaJson}
</script>

<style>body { color: red; }</style>
</head>
<body>
<h1>Sample Plan<span class="pill in-review">in-review</span></h1>
</body>
</html>
`
}

const VALID_META = {
  schemaVersion: 1,
  name: 'Sample Plan',
  overview: 'A plan used in unit tests.',
  stage: 'in-review',
  approvedAt: null,
  todos: [
    { id: 'phase-a', content: 'First phase', status: 'done' },
    { id: 'phase-b', content: 'Second phase', status: 'pending' },
    { id: 'phase-c', content: 'Third phase', status: 'skipped' },
  ],
  reviewNotes: [{ id: 'n1', author: 'user', text: 'Looks fine.', resolved: false, reply: '' }],
}

const VALID_HTML = wrapHtml(JSON.stringify(VALID_META, null, 2))

describe('parseHtmlPlanMeta', () => {
  it('parses a valid full meta block without warnings', () => {
    const result = parseHtmlPlanMeta(VALID_HTML)
    expect(result).not.toBeNull()
    expect(result!.warnings).toEqual([])
    expect(result!.meta.name).toBe('Sample Plan')
    expect(result!.meta.overview).toBe('A plan used in unit tests.')
    expect(result!.meta.stage).toBe('in-review')
    expect(result!.meta.approvedAt).toBeNull()
    expect(result!.meta.todos).toHaveLength(3)
    expect(result!.meta.todos[2].status).toBe('skipped')
    expect(result!.meta.reviewNotes).toEqual([
      { id: 'n1', author: 'user', text: 'Looks fine.', resolved: false, reply: '', anchor: '' },
    ])
  })

  it('returns null when the name is missing or empty', () => {
    const noName = wrapHtml(JSON.stringify({ ...VALID_META, name: undefined }))
    expect(parseHtmlPlanMeta(noName)).toBeNull()
    const emptyName = wrapHtml(JSON.stringify({ ...VALID_META, name: '  ' }))
    expect(parseHtmlPlanMeta(emptyName)).toBeNull()
  })

  it('returns null for a wrong schemaVersion', () => {
    const wrongVersion = wrapHtml(JSON.stringify({ ...VALID_META, schemaVersion: 2 }))
    expect(parseHtmlPlanMeta(wrongVersion)).toBeNull()
  })

  it('downgrades an invalid stage to draft with a warning', () => {
    const badStage = wrapHtml(JSON.stringify({ ...VALID_META, stage: 'shipping' }))
    const result = parseHtmlPlanMeta(badStage)!
    expect(result.meta.stage).toBe('draft')
    expect(result.warnings).toHaveLength(1)
    expect(result.warnings[0]).toContain('shipping')
  })

  it('downgrades an invalid todo status to pending with a warning', () => {
    const badStatus = wrapHtml(
      JSON.stringify({
        ...VALID_META,
        todos: [{ id: 'phase-a', content: 'First phase', status: 'completed' }],
      })
    )
    const result = parseHtmlPlanMeta(badStatus)!
    expect(result.meta.todos[0].status).toBe('pending')
    expect(result.warnings).toHaveLength(1)
    expect(result.warnings[0]).toContain('completed')
  })

  it('fills defaults for missing reviewNote fields', () => {
    const sparseNotes = wrapHtml(JSON.stringify({ ...VALID_META, reviewNotes: [{ id: 'n1' }] }))
    const result = parseHtmlPlanMeta(sparseNotes)!
    expect(result.meta.reviewNotes[0]).toEqual({
      id: 'n1',
      author: 'user',
      text: '',
      resolved: false,
      reply: '',
      anchor: '',
    })
  })

  it('keeps a string reviewNote anchor and defaults a non-string one to empty', () => {
    const anchored = wrapHtml(
      JSON.stringify({
        ...VALID_META,
        reviewNotes: [
          { id: 'n1', author: 'user', text: 'Anchored', resolved: false, reply: '', anchor: 'Risks' },
          { id: 'n2', author: 'user', text: 'Bad anchor', resolved: false, reply: '', anchor: 42 },
        ],
      })
    )
    const result = parseHtmlPlanMeta(anchored)!
    expect(result.meta.reviewNotes[0].anchor).toBe('Risks')
    expect(result.meta.reviewNotes[1].anchor).toBe('')
  })

  it('round-trips an anchored note through replaceHtmlPlanMeta', () => {
    const result = parseHtmlPlanMeta(VALID_HTML)!
    result.meta.reviewNotes[0].anchor = 'Phase B · Runtime'
    const written = replaceHtmlPlanMeta(VALID_HTML, result.meta)
    expect(parseHtmlPlanMeta(written)!.meta.reviewNotes[0].anchor).toBe('Phase B · Runtime')
  })

  it('returns null when there is no plan-meta block', () => {
    expect(parseHtmlPlanMeta('<!doctype html><html><body>plain page</body></html>')).toBeNull()
  })

  it('returns null when the JSON is malformed', () => {
    expect(parseHtmlPlanMeta(wrapHtml('{ "schemaVersion": 1, broken'))).toBeNull()
  })

  it('accepts single-quoted attributes', () => {
    const html = `<html><head><script type='application/json' id='plan-meta'>
${JSON.stringify(VALID_META)}
</script></head><body></body></html>`
    expect(parseHtmlPlanMeta(html)?.meta.name).toBe('Sample Plan')
  })

  it('accepts an uppercase script tag and attributes', () => {
    const html = `<html><head><SCRIPT TYPE="application/json" ID="plan-meta">
${JSON.stringify(VALID_META)}
</SCRIPT></head><body></body></html>`
    expect(parseHtmlPlanMeta(html)?.meta.name).toBe('Sample Plan')
  })

  it('accepts id before type', () => {
    const html = `<html><head><script id="plan-meta" type="application/json">
${JSON.stringify(VALID_META)}
</script></head><body></body></html>`
    expect(parseHtmlPlanMeta(html)?.meta.name).toBe('Sample Plan')
  })

  it('does not match data-id="plan-meta"', () => {
    const html = `<html><head><script type="application/json" data-id="plan-meta">
${JSON.stringify(VALID_META)}
</script></head><body></body></html>`
    expect(parseHtmlPlanMeta(html)).toBeNull()
  })
})

describe('replaceHtmlPlanMeta', () => {
  it('preserves every byte outside the plan-meta block', () => {
    const updated: HtmlPlanMeta = parseHtmlPlanMeta(VALID_HTML)!.meta
    const written = replaceHtmlPlanMeta(VALID_HTML, { ...updated, stage: 'approved' })

    const blockRe = /<script type="application\/json" id="plan-meta">[\s\S]*?<\/script>/
    expect(written.replace(blockRe, '@BLOCK@')).toBe(VALID_HTML.replace(blockRe, '@BLOCK@'))
  })

  it('round-trips: replaced content parses back to the same meta', () => {
    const meta: HtmlPlanMeta = {
      ...parseHtmlPlanMeta(VALID_HTML)!.meta,
      stage: 'approved',
      approvedAt: '2026-07-18T00:00:00Z',
      todos: [{ id: 'phase-a', content: 'First phase', status: 'in-progress' }],
    }
    const written = replaceHtmlPlanMeta(VALID_HTML, meta)
    const reparsed = parseHtmlPlanMeta(written)!
    expect(reparsed.warnings).toEqual([])
    expect(reparsed.meta).toEqual(meta)
  })

  it('serializes with 2-space indentation', () => {
    const meta = parseHtmlPlanMeta(VALID_HTML)!.meta
    const written = replaceHtmlPlanMeta(VALID_HTML, meta)
    expect(written).toContain('\n  "schemaVersion": 1,')
  })

  it('escapes "<" in serialized JSON so script-closing text cannot break the block', () => {
    const closingTag = '</scr' + 'ipt>'
    const meta: HtmlPlanMeta = {
      ...parseHtmlPlanMeta(VALID_HTML)!.meta,
      reviewNotes: [
        {
          id: 'n1',
          author: 'user',
          text: `Beware ${closingTag} and ${'<!' + '--'} inside notes`,
          resolved: false,
          reply: '',
          anchor: '',
        },
      ],
    }
    const written = replaceHtmlPlanMeta(VALID_HTML, meta)

    // (a) the only closing script tag in the output is the block's own; the
    // JSON island itself contains no raw "<" at all.
    expect(written.split(closingTag).length - 1).toBe(1)
    const block = written.match(
      /<script type="application\/json" id="plan-meta">([\s\S]*?)<\/script>/,
    )!
    expect(block[1]).not.toContain('<')

    // (b) round-trips: JSON.parse natively decodes the unicode escape.
    const reparsed = parseHtmlPlanMeta(written)!
    expect(reparsed.warnings).toEqual([])
    expect(reparsed.meta).toEqual(meta)

    // (c) every byte outside the block is preserved.
    const blockRe = /<script type="application\/json" id="plan-meta">[\s\S]*?<\/script>/
    expect(written.replace(blockRe, '@BLOCK@')).toBe(VALID_HTML.replace(blockRe, '@BLOCK@'))
  })

  it('returns the content unchanged when no block exists', () => {
    const plain = '<!doctype html><html><body>no meta</body></html>'
    expect(replaceHtmlPlanMeta(plain, parseHtmlPlanMeta(VALID_HTML)!.meta)).toBe(plain)
  })
})

describe('archivedAt', () => {
  it('defaults to null when the field is absent (legacy plans)', () => {
    const result = parseHtmlPlanMeta(VALID_HTML)!
    expect(result.meta.archivedAt).toBeNull()
  })

  it('parses an explicit archivedAt string', () => {
    const archived = wrapHtml(JSON.stringify({ ...VALID_META, archivedAt: '2026-07-22T00:00:00Z' }))
    expect(parseHtmlPlanMeta(archived)!.meta.archivedAt).toBe('2026-07-22T00:00:00Z')
  })

  it('round-trips archivedAt through replaceHtmlPlanMeta', () => {
    const meta: HtmlPlanMeta = {
      ...parseHtmlPlanMeta(VALID_HTML)!.meta,
      archivedAt: '2026-07-22T12:34:56Z',
    }
    const reparsed = parseHtmlPlanMeta(replaceHtmlPlanMeta(VALID_HTML, meta))!
    expect(reparsed.meta.archivedAt).toBe('2026-07-22T12:34:56Z')
  })
})

describe('unknown-field preservation and executions', () => {
  const EXTRA_META = {
    ...VALID_META,
    xFuture: { nested: [1, 2] },
    todos: [{ id: 'phase-a', content: 'First phase', status: 'done', xTodoExtra: 'keep-me' }],
    reviewNotes: [
      { id: 'n1', author: 'user', text: 'Note', resolved: false, reply: '', xNoteExtra: 7 },
    ],
    executions: [
      { agent: 'claude', startedAt: '2026-07-19T10:00:00Z', xExecExtra: true },
    ],
  }
  const EXTRA_HTML = wrapHtml(JSON.stringify(EXTRA_META, null, 2))

  it('keeps unknown top-level, todo, note, and execution fields through parse', () => {
    const result = parseHtmlPlanMeta(EXTRA_HTML)!
    expect(result.warnings).toEqual([])
    expect(result.meta.xFuture).toEqual({ nested: [1, 2] })
    expect(result.meta.todos[0].xTodoExtra).toBe('keep-me')
    expect(result.meta.reviewNotes[0].xNoteExtra).toBe(7)
    expect(result.meta.executions).toEqual([
      { agent: 'claude', startedAt: '2026-07-19T10:00:00Z', xExecExtra: true },
    ])
  })

  it('round-trips unknown fields through replaceHtmlPlanMeta', () => {
    const meta = parseHtmlPlanMeta(EXTRA_HTML)!.meta
    const written = replaceHtmlPlanMeta(EXTRA_HTML, { ...meta, stage: 'approved' })
    const reparsed = parseHtmlPlanMeta(written)!
    expect(reparsed.warnings).toEqual([])
    expect(reparsed.meta.xFuture).toEqual({ nested: [1, 2] })
    expect(reparsed.meta.todos[0].xTodoExtra).toBe('keep-me')
    expect(reparsed.meta.reviewNotes[0].xNoteExtra).toBe(7)
    expect(reparsed.meta.executions).toEqual(meta.executions)
  })

  it('round-trips an appended execution record', () => {
    const meta = parseHtmlPlanMeta(VALID_HTML)!.meta
    const next: HtmlPlanMeta = {
      ...meta,
      stage: 'in-progress',
      executions: [{ agent: 'codex', startedAt: '2026-07-19T11:00:00Z' }],
    }
    const written = replaceHtmlPlanMeta(VALID_HTML, next)
    const reparsed = parseHtmlPlanMeta(written)!
    expect(reparsed.meta.stage).toBe('in-progress')
    expect(reparsed.meta.executions).toEqual([
      { agent: 'codex', startedAt: '2026-07-19T11:00:00Z' },
    ])
  })

  it('leaves the executions key absent when the source has none', () => {
    const meta = parseHtmlPlanMeta(VALID_HTML)!.meta
    expect('executions' in meta).toBe(false)
    const written = replaceHtmlPlanMeta(VALID_HTML, meta)
    expect(written).not.toContain('"executions"')
  })

  it('drops a non-array executions value with a warning', () => {
    const bad = wrapHtml(JSON.stringify({ ...VALID_META, executions: 'not-an-array' }))
    const result = parseHtmlPlanMeta(bad)!
    expect(result.meta.executions).toBeUndefined()
    expect('executions' in result.meta).toBe(false)
    expect(result.warnings.some((w) => w.includes('executions'))).toBe(true)
  })

  it('normalizes malformed execution entries', () => {
    const messy = wrapHtml(
      JSON.stringify({
        ...VALID_META,
        executions: [null, 'junk', { agent: 42, startedAt: '2026-07-19T12:00:00Z' }],
      })
    )
    const result = parseHtmlPlanMeta(messy)!
    expect(result.meta.executions).toEqual([{ agent: '', startedAt: '2026-07-19T12:00:00Z' }])
  })
})

describe('htmlPlanProgress', () => {
  it('counts done only; skipped counts toward neither', () => {
    const meta = parseHtmlPlanMeta(VALID_HTML)!.meta
    expect(htmlPlanProgress(meta.todos)).toEqual({ total: 3, done: 1 })
  })
})

describe('htmlPlanAwaitingUser', () => {
  const todo = (id: string, status: string, owner?: string) =>
    ({ id, content: id, status, ...(owner ? { owner } : {}) }) as never

  it('counts unfinished todos the user owns', () => {
    expect(
      htmlPlanAwaitingUser([
        todo('a', 'pending', 'user'),
        todo('b', 'in-progress', 'user'),
        todo('c', 'pending'),
      ]),
    ).toBe(2)
  })

  it('ignores the ones already settled', () => {
    // A verification that happened, or was waived, is no longer waiting.
    expect(
      htmlPlanAwaitingUser([todo('a', 'done', 'user'), todo('b', 'skipped', 'user')]),
    ).toBe(0)
  })

  it('counts zero for documents written before owners existed', () => {
    // owner rides PlanTodo's index signature, so older files simply have none —
    // they must not read as "waiting on you" just because nothing is marked.
    expect(htmlPlanAwaitingUser([todo('a', 'pending'), todo('b', 'pending')])).toBe(0)
  })
})

// Markup fixture mirroring the _template.html conventions: a header stage
// pill plus todo list items with data-status/data-todo-id and an .st pill.
const MARKUP_HTML = `<!doctype html>
<html><head><title>Markup Plan</title></head>
<body>
<h1>Markup Plan<span class="pill in-review">in-review</span></h1>
<ul class="todos">
  <li data-status="pending" data-todo-id="phase-a"><span class="st">pending</span>
    <span>First phase</span></li>
  <li data-todo-id="phase-b" data-status="done"><span class="st">done</span>
    <span>Second phase</span></li>
  <li data-status="pending" data-todo-id="phase-c"><span>no status pill</span></li>
</ul>
</body></html>`

describe('syncTodoMarkup', () => {
  it('updates data-status and the .st pill text for the matching todo', () => {
    const out = syncTodoMarkup(MARKUP_HTML, 'phase-a', 'in-progress')
    expect(out).toContain('<li data-status="in-progress" data-todo-id="phase-a"><span class="st">in-progress</span>')
    // Other todos untouched.
    expect(out).toContain('<li data-todo-id="phase-b" data-status="done"><span class="st">done</span>')
  })

  it('tolerates data-todo-id before data-status', () => {
    const out = syncTodoMarkup(MARKUP_HTML, 'phase-b', 'skipped')
    expect(out).toContain('<li data-todo-id="phase-b" data-status="skipped"><span class="st">skipped</span>')
  })

  it('updates data-status even when the li has no .st pill', () => {
    const out = syncTodoMarkup(MARKUP_HTML, 'phase-c', 'done')
    expect(out).toContain('<li data-status="done" data-todo-id="phase-c"><span>no status pill</span></li>')
  })

  it('returns the content unchanged when the todo id has no markup', () => {
    expect(syncTodoMarkup(MARKUP_HTML, 'phase-zz', 'done')).toBe(MARKUP_HTML)
  })

  it('only touches the matching li — round-trip of all other bytes', () => {
    const out = syncTodoMarkup(MARKUP_HTML, 'phase-a', 'done')
    const strip = (s: string): string => s.replace(/<li[^>]*data-todo-id="phase-a"[^>]*>[\s\S]*?<\/li>/, '@LI@')
    expect(strip(out)).toBe(strip(MARKUP_HTML))
  })
})

describe('syncStageMarkup', () => {
  it('rewrites the pill class and text to the new stage', () => {
    const out = syncStageMarkup(MARKUP_HTML, 'approved')
    expect(out).toContain('<span class="pill approved">approved</span>')
    expect(out).not.toContain('pill in-review')
  })

  it('returns the content unchanged when no pill markup exists', () => {
    const noPill = '<html><body><h1>No pill here</h1></body></html>'
    expect(syncStageMarkup(noPill, 'done')).toBe(noPill)
  })
})

describe('injectPlanMeta', () => {
  const docMeta: HtmlPlanMeta = {
    schemaVersion: 1,
    name: 'Promoted Doc',
    overview: '',
    stage: 'draft',
    approvedAt: null,
    archivedAt: null,
    todos: [],
    reviewNotes: [],
  }

  it('injects before </head> and round-trips through parseHtmlPlanMeta', () => {
    const doc = '<!doctype html>\n<html><head><title>Doc</title></head><body><p>hi</p></body></html>'
    const out = injectPlanMeta(doc, docMeta)
    expect(out.indexOf('id="plan-meta"')).toBeLessThan(out.indexOf('</head>'))
    const reparsed = parseHtmlPlanMeta(out)!
    expect(reparsed.warnings).toEqual([])
    expect(reparsed.meta).toEqual(docMeta)
    // Every original byte preserved around the injected block.
    expect(out).toContain('<title>Doc</title>')
    expect(out).toContain('<p>hi</p>')
  })

  it('injects after the <html> open tag when there is no </head>', () => {
    const doc = '<html lang="en"><body>content</body></html>'
    const out = injectPlanMeta(doc, docMeta)
    expect(out.indexOf('<html lang="en">')).toBeLessThan(out.indexOf('id="plan-meta"'))
    expect(parseHtmlPlanMeta(out)?.meta).toEqual(docMeta)
  })

  it('prepends when there is neither </head> nor <html>', () => {
    const doc = '<body>bare fragment</body>'
    const out = injectPlanMeta(doc, docMeta)
    expect(out.startsWith('<script type="application/json" id="plan-meta">')).toBe(true)
    expect(parseHtmlPlanMeta(out)?.meta).toEqual(docMeta)
  })

  it('returns the content unchanged when an island already exists', () => {
    expect(injectPlanMeta(VALID_HTML, docMeta)).toBe(VALID_HTML)
  })

  it('escapes "<" in the injected JSON', () => {
    const out = injectPlanMeta('<html><head></head><body></body></html>', {
      ...docMeta,
      name: 'Has </scr' + 'ipt> inside',
    })
    const block = out.match(/<script type="application\/json" id="plan-meta">([\s\S]*?)<\/script>/)!
    expect(block[1]).not.toContain('<')
    expect(parseHtmlPlanMeta(out)?.meta.name).toBe('Has </scr' + 'ipt> inside')
  })
})

// A body-realistic plan document (template-shaped) for the structured-content
// and section edit/delete helpers.
const BODY_DOC = [
  '<!doctype html><html><head>',
  '<script type="application/json" id="plan-meta">',
  '{"schemaVersion":1,"name":"P"}',
  '</scr' + 'ipt>',
  '</head><body>',
  '<header><h1>P<span class="pill draft">draft</span></h1></header>',
  '<section>',
  '  <h2>Goals</h2>',
  '  <p>Original goal text.</p>',
  '</section>',
  '<section>',
  '  <h2>Phases</h2>',
  '  <div class="phase">',
  '    <div class="phase-head">Phase A · Alpha</div>',
  '    <div class="phase-body">',
  '      <ul class="todos">',
  '        <li data-status="pending" data-todo-id="phase-a">',
  '          <span class="st">pending</span>',
  '          <span>First phase</span>',
  '        </li>',
  '      </ul>',
  '      <p class="note">Phase detail.</p>',
  '    </div>',
  '  </div>',
  '</section>',
  '<section>',
  '  <h2>Risks</h2>',
  '  <ul><li>risk one</li></ul>',
  '</section>',
  '<section>',
  '  <h2>Review Notes</h2>',
  '  <ul class="notes">',
  '    <li data-note-id="n1" data-resolved="false"><span class="who">user</span>Needs work<div class="reply"><span class="who">ai</span>ok</div></li>',
  '    <li data-note-id="n2" data-resolved="true"><span class="who">user</span>Second note</li>',
  '  </ul>',
  '</section>',
  '</body></html>',
].join('\n')

describe('addTodoMarkup', () => {
  it('inserts a new <li data-todo-id> into the last todos list before its </ul>', () => {
    const { content, warning } = addTodoMarkup(BODY_DOC, {
      id: 'phase-c',
      content: 'Third phase',
      status: 'pending',
    })
    expect(warning).toBeNull()
    expect(content).toContain('data-todo-id="phase-c"')
    // Inserted after the existing todo and before the list close.
    expect(content.indexOf('data-todo-id="phase-a"')).toBeLessThan(content.indexOf('data-todo-id="phase-c"'))
    expect(content.indexOf('data-todo-id="phase-c"')).toBeLessThan(content.indexOf('</ul>'))
  })

  it('HTML-escapes content so it cannot inject markup', () => {
    const { content } = addTodoMarkup(BODY_DOC, {
      id: 'x',
      content: '<script>alert(1)</scr' + 'ipt>',
      status: 'pending',
    })
    expect(content).toContain('&lt;script&gt;')
    expect(content).not.toContain('<script>alert(1)')
  })

  it('warns and leaves content unchanged when there is no todos list', () => {
    const doc = '<html><body><section><h2>Goals</h2><p>x</p></section></body></html>'
    const { content, warning } = addTodoMarkup(doc, { id: 'a', content: 'x', status: 'pending' })
    expect(content).toBe(doc)
    expect(warning).toMatch(/no <ul class="todos">/)
  })
})

describe('removeTodoMarkup', () => {
  it('removes the matching todo <li> and nothing else', () => {
    const out = removeTodoMarkup(BODY_DOC, 'phase-a')
    expect(out).not.toContain('data-todo-id="phase-a"')
    expect(out).not.toContain('First phase')
    expect(out).toContain('Phase detail.')
  })

  it('is a no-op when the id is absent', () => {
    expect(removeTodoMarkup(BODY_DOC, 'nope')).toBe(BODY_DOC)
  })
})

describe('setTodoContentMarkup', () => {
  it('updates the visible content span text, escaped, leaving the status pill', () => {
    const out = setTodoContentMarkup(BODY_DOC, 'phase-a', 'Renamed <b>')
    expect(out).toContain('Renamed &lt;b&gt;')
    expect(out).not.toContain('First phase')
    expect(out).toContain('<span class="st">pending</span>')
  })

  it('is a no-op when the id is absent', () => {
    expect(setTodoContentMarkup(BODY_DOC, 'nope', 'x')).toBe(BODY_DOC)
  })
})

describe('setNoteTextMarkup', () => {
  it('updates a note text before the reply block, keeping the reply', () => {
    const out = setNoteTextMarkup(BODY_DOC, 'n1', 'Updated text')
    expect(out).toContain('<span class="who">user</span>Updated text<div class="reply">')
    expect(out).toContain('<span class="who">ai</span>ok')
    expect(out).not.toContain('Needs work')
  })

  it('updates a note without a reply, up to </li>, escaping the text', () => {
    const out = setNoteTextMarkup(BODY_DOC, 'n2', 'New <i>')
    expect(out).toContain('<span class="who">user</span>New &lt;i&gt;</li>')
    expect(out).not.toContain('Second note')
  })

  it('is a no-op when the id is absent', () => {
    expect(setNoteTextMarkup(BODY_DOC, 'n9', 'x')).toBe(BODY_DOC)
  })
})

describe('removeNoteMarkup', () => {
  it('removes the whole note <li> including its reply', () => {
    const out = removeNoteMarkup(BODY_DOC, 'n1')
    expect(out).not.toContain('data-note-id="n1"')
    expect(out).not.toContain('Needs work')
    expect(out).toContain('data-note-id="n2"')
  })

  it('is a no-op when the id is absent', () => {
    expect(removeNoteMarkup(BODY_DOC, 'n9')).toBe(BODY_DOC)
  })
})

describe('replaceSectionBody', () => {
  it('replaces only the prose body of a section, preserving all other bytes', () => {
    const out = replaceSectionBody(BODY_DOC, 'Goals', '<p>Rewritten goal.</p>')
    expect(out).toContain('<h2>Goals</h2>')
    expect(out).toContain('<p>Rewritten goal.</p>')
    expect(out).not.toContain('Original goal text.')
    // Everything after the Goals section is byte-identical.
    const tail = BODY_DOC.slice(BODY_DOC.indexOf('<section>\n  <h2>Phases'))
    expect(out).toContain(tail)
    // The plan-meta island and header are untouched.
    expect(out).toContain('{"schemaVersion":1,"name":"P"}')
    expect(out).toContain('<h1>P<span class="pill draft">draft</span></h1>')
  })

  it('refuses a section that carries a todo list (Phases)', () => {
    expect(replaceSectionBody(BODY_DOC, 'Phases', '<p>x</p>')).toBe(BODY_DOC)
  })

  it('refuses a phase whose body carries a todo list', () => {
    expect(replaceSectionBody(BODY_DOC, 'Phase A · Alpha', '<p>x</p>')).toBe(BODY_DOC)
  })

  it('never matches the header (h1) or plan-meta, and is a no-op for unknown anchors', () => {
    expect(replaceSectionBody(BODY_DOC, 'P', '<p>x</p>')).toBe(BODY_DOC)
    expect(replaceSectionBody(BODY_DOC, 'Nonexistent', '<p>x</p>')).toBe(BODY_DOC)
  })
})

describe('deleteSection', () => {
  it('removes the whole prose section', () => {
    const out = deleteSection(BODY_DOC, 'Risks')
    expect(out).not.toContain('<h2>Risks</h2>')
    expect(out).not.toContain('risk one')
    expect(out).toContain('<h2>Goals</h2>')
    expect(out).toContain('<h2>Review Notes</h2>')
  })

  it('refuses to delete a todo-bearing region', () => {
    expect(deleteSection(BODY_DOC, 'Phases')).toBe(BODY_DOC)
    expect(deleteSection(BODY_DOC, 'Phase A · Alpha')).toBe(BODY_DOC)
  })

  it('is a no-op for the header and unknown anchors', () => {
    expect(deleteSection(BODY_DOC, 'P')).toBe(BODY_DOC)
    expect(deleteSection(BODY_DOC, 'Nope')).toBe(BODY_DOC)
  })
})
