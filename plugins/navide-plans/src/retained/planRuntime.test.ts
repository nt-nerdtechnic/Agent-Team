// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Window } from 'happy-dom'
import { preparePlanDocHtml } from '../planSecurity'
import { buildPlanRuntimeScript, buildTodoStatusRuntime } from './planRuntime'
import { replaceSectionBody } from './usePlanHtml'

const windows: Window[] = []
afterEach(async () => {
  await Promise.all(windows.splice(0).map(window => window.happyDOM.abort()))
})

describe('packaged Plans runtime', () => {
  it('updates and removes note badges only for the authenticated current preview', () => {
    const window = new Window()
    windows.push(window)
    window.document.body.innerHTML = '<section><h2>Scope</h2><p>Details</p></section>'
    window.eval(buildPlanRuntimeScript({
      documentToken: 'current', anchors: {}, scrollY: 0,
      commentLabel: 'Comment', editLabel: 'Edit', deleteLabel: 'Delete', saveLabel: 'Save', cancelLabel: 'Cancel',
    }))
    const update = (anchors: Record<string, number>, token = 'current', source: unknown = window.eval('parent')) => {
      const event = new window.MessageEvent('message', {
        data: { type: 'review-note-anchors-updated', documentToken: token, anchors },
      })
      Object.defineProperty(event, 'source', { value: source })
      window.dispatchEvent(event)
    }
    update({ Scope: 2 }, 'stale')
    update({ Scope: 2 }, 'current', {})
    expect(window.document.querySelector('.plan-rt-badge')).toBeNull()
    update({ Scope: 2 })
    expect(window.document.querySelector('.plan-rt-badge')?.textContent).toBe('2')
    update({ Scope: 1 })
    expect(window.document.querySelector('.plan-rt-badge')?.textContent).toBe('1')
    update({})
    expect(window.document.querySelector('.plan-rt-badge')).toBeNull()
  })

  it.each([false, true])('edits prose without replacing the heading or neighboring content (section=%s)', (section) => {
    const window = new Window()
    windows.push(window)
    const body = '<p>Original risk</p><h3>Mitigation</h3><p>Keep this detail</p>'
    const region = `<h2>Risks</h2>${body}`
    const source = `<html><body><h1>Plan</h1>${section ? `<section>${region}</section>` : region}<h2>Validation</h2><p>Keep validation</p></body></html>`
    window.document.body.innerHTML = source
    const postMessage = vi.spyOn(window, 'postMessage').mockImplementation(() => {})
    window.eval(buildPlanRuntimeScript({
      documentToken: 'test-token', anchors: {}, scrollY: 0,
      commentLabel: 'Comment', editLabel: 'Edit', deleteLabel: 'Delete', saveLabel: 'Save', cancelLabel: 'Cancel',
    }))
    const heading = window.document.querySelector('h2')!
    const regionElement = heading.closest('section') ?? heading.closest('.plan-rt-section') ?? heading
    regionElement.dispatchEvent(new window.MouseEvent('mouseenter'))
    const button = (label: string) => [...window.document.querySelectorAll('.plan-rt-secbar button')].find(node => node.textContent === label)!
    button('Edit').dispatchEvent(new window.MouseEvent('click'))
    const editable = window.document.querySelector('[contenteditable="true"]')!
    expect(editable.textContent).toContain('Original risk')
    editable.querySelector('p')!.textContent = 'Updated risk'
    button('Save').dispatchEvent(new window.MouseEvent('click'))
    const edit = postMessage.mock.calls.map(([message]) => message).find(
      (message): message is { type: 'section-edit'; html: string } => typeof message === 'object' && message !== null
        && 'type' in message && message.type === 'section-edit' && 'html' in message && typeof message.html === 'string',
    )
    expect(edit).toMatchObject({ anchor: 'Risks', html: '<p>Updated risk</p><h3>Mitigation</h3><p>Keep this detail</p>' })
    if (!edit) throw new Error('Runtime did not emit a section edit')
    const result = replaceSectionBody(source, 'Risks', edit.html)
    expect(result).toBe(source.replace(body, `\n${edit.html}\n`))
  })

  it('keeps the enclosing document tags and the next higher heading when replacing a final prose body', () => {
    const source = '<html><body><main><h2>Risks</h2><p>Old</p></main><h1>Appendix</h1></body></html>'
    expect(replaceSectionBody(source, 'Risks', '<p>New</p>')).toBe(
      '<html><body><main><h2>Risks</h2>\n<p>New</p>\n</main><h1>Appendix</h1></body></html>',
    )
  })

  it('embeds todo IDs containing a script close safely while preserving their values', () => {
    const todoIds = ['</script><script>bad()</script>', 'quote"<&']
    const prepared = preparePlanDocHtml('<html><body><h2>Tasks</h2></body></html>', {
      buildTrustedRuntimeScript: ({ documentToken }) => buildTodoStatusRuntime(documentToken, todoIds),
    })
    const document = new DOMParser().parseFromString(prepared.html, 'text/html')
    expect(document.querySelectorAll('script')).toHaveLength(1)
    const runtime = document.querySelector('script')!.textContent!
    expect(runtime).not.toContain('</script')
    expect(JSON.parse(runtime.match(/var validTodoIds = (.*);/)![1])).toEqual(todoIds)
  })
})
