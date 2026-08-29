import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * `.git-left-content` must be a column flex container.
 *
 * The pane it wraps fills the box with `flex: 1 1 0%`, and a flex child
 * property does nothing inside a block container: the pane falls back to
 * content height and every section below the first few — History, Draft,
 * Remotes, Tags, Worktrees, Config — is clipped by the `overflow: hidden`
 * on the wrapper. Nothing errors, nothing is missing from the DOM, so the
 * panel simply looks like most of its features were removed.
 *
 * This is asserted against the stylesheet text rather than a rendered
 * component because jsdom performs no layout: mounting the surface and
 * measuring heights would pass no matter what these declarations say. The
 * rule being pinned is a CSS fact with no runtime to observe it, which is
 * what makes a static assertion the only honest check available here.
 */
const surfacePath = resolve(import.meta.dirname, '../GitLeftApp.vue')

function ruleBody(source: string, selector: string): string {
  const start = source.indexOf(`${selector} {`)
  expect(start, `${selector} is missing from GitLeftApp.vue`).toBeGreaterThan(-1)
  const end = source.indexOf('}', start)
  return source.slice(start, end)
}

describe('GitLeftApp layout contract', () => {
  const source = readFileSync(surfacePath, 'utf8')

  it('makes .git-left-content a column flex container so the pane can fill it', () => {
    const body = ruleBody(source, '.git-left-content')
    expect(body).toMatch(/display:\s*flex/)
    expect(body).toMatch(/flex-direction:\s*column/)
  })

  it('keeps .git-left-root a column flex container', () => {
    const body = ruleBody(source, '.git-left-root')
    expect(body).toMatch(/display:\s*flex/)
    expect(body).toMatch(/flex-direction:\s*column/)
  })
})
