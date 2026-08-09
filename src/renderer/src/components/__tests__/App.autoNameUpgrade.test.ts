// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

// Mounting App starts backend/terminal/settings lifecycles, so — like the other
// App.*.test.ts files — these assert against the source text. They lock in the
// write ordering that keeps auto-naming a once-per-pane event: the string
// heuristic titles a pane instantly, the model may replace that title once, and
// nothing renames it after that. Without the ordering, every turn_complete
// would re-title the pane.
const appSource = readFileSync(resolve(process.cwd(), 'src/renderer/src/App.vue'), 'utf8')

function functionBody(name: string): string {
  const start = appSource.indexOf(`function ${name}(`)
  expect(start).toBeGreaterThan(-1)
  const end = appSource.indexOf('\n}\n', start)
  expect(end).toBeGreaterThan(start)
  return appSource.slice(start, end)
}

describe('auto-name upgrade ordering', () => {
  it('setPaneAutoName lets an llm name replace a heuristic one, once', () => {
    const body = functionBody('setPaneAutoName')
    // customName is checked on its own — it must block both sources.
    expect(body).toContain('if (pane.customName) return')
    // The single permitted second write.
    expect(body).toContain("if (pane.autoName && !(source === 'llm' && pane.autoNameSource !== 'llm')) return")
    expect(body).toContain('pane.autoNameSource = source')
    // The source has to reach the backend arbiter, or peers can't tell the
    // two kinds of write apart.
    expect(body).toContain('source,')
  })

  it('requestLlmPaneName asks at most once per pane', () => {
    const body = functionBody('requestLlmPaneName')
    expect(body).toContain('llmNameRequested.has(paneId)')
    expect(body).toContain('llmNameRequested.add(paneId)')
    // A pane the model already named, or the user renamed, is never sent.
    expect(body).toContain("if (pane.customName || pane.autoNameSource === 'llm') return")
  })

  it('requestLlmPaneName applies a name only when the backend accepted it', () => {
    const body = functionBody('requestLlmPaneName')
    // The handler answers ok:true with a name even when the store refused the
    // write (pane restored with an llm title, or renamed mid-generation).
    // Applying it on ok alone would show a title the backend never stored.
    expect(body).toContain('resp.payload.changed')
  })

  it('requestLlmPaneName never surfaces a failure', () => {
    const body = functionBody('requestLlmPaneName')
    // The heuristic title is already showing, so a failed upgrade is not an
    // error the user needs to see. A toast/notify here would fire for every
    // pane on a machine with no Ollama.
    expect(body).toContain('catch {')
    expect(body).not.toContain('notify')
    expect(body).not.toContain('toast')
  })

  it('every heuristic naming site also asks the model', () => {
    // deriveAutoName is the heuristic; each call site should be paired with an
    // upgrade request, or that trigger silently keeps the truncated title.
    const heuristicCalls = appSource.split('setPaneAutoName(').length - 1
    const upgradeCalls = appSource.split('requestLlmPaneName(').length - 1
    // setPaneAutoName: 3 trigger sites + the definition + the llm callback.
    // requestLlmPaneName: the same 3 trigger sites + the definition.
    expect(heuristicCalls).toBe(5)
    expect(upgradeCalls).toBe(4)
  })

  it('restored panes carry their name source', () => {
    // Without this a restart would read a model-written title as upgradable
    // and spend a second generation on it.
    expect(appSource).toContain('autoNameSource: autoNameSourceOf(saved.auto_name_source)')
    // And a peer window's broadcast has to carry it for the same reason.
    expect(appSource).toContain('pane.autoNameSource = autoNameSourceOf(d.auto_named_pane.source)')
  })

  it('autoNameSourceOf only trusts the two known sources', () => {
    const body = functionBody('autoNameSourceOf')
    expect(body).toContain("raw === 'llm' || raw === 'heuristic' ? raw : undefined")
  })
})
