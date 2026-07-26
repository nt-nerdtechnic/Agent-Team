import { describe, expect, it } from 'vitest'
import { CAP_MAP, CAP_EVENTS, resolveWsType, eventNamespace } from './capabilityMap'

// The non-uniform `(ns.method)` → backend WS type remaps, mirrored inline from
// the mini-IDE shim's EXPLICIT map (src/renderer/plugins/mini-ide/
// capabilityBackend.ts). CAP_MAP must be the exact inverse of that shim; the two
// live in separate tsc projects (node here, web there) so they can't import each
// other — this inline list is the sync anchor, matching the pattern the shim's
// own test uses for MINI_IDE_SENT_TYPES.
const EXPECTED_EXPLICIT: Readonly<Record<string, string>> = {
  'terminal.run': 'shell.run',
  'chat.editor_rewrite': 'editor.rewrite',
  'chat.editor_complete': 'editor.complete',
  'chat.enhance_prompt': 'ai.enhance_prompt',
  'chat.web_search': 'ai.web.search',
  'chat.start': 'ai.chat.start',
  'chat.stop': 'ai.chat.stop',
  'chat.settings_get': 'ai.chat.settings.get',
  'chat.settings_set': 'ai.chat.settings.set',
  'chat.test_connection': 'ai.chat.test_connection',
  'chat.accept_edit': 'ai.chat.accept_edit',
  'chat.approve_command': 'ai.chat.approve_command',
  'chat.reject_command': 'ai.chat.reject_command',
  'chat.notes_set': 'ai.chat.notes.set',
  'chat.notes_get': 'ai.chat.notes.get',
  'chat.threads_set': 'ai.chat.threads.set',
  'chat.threads_get': 'ai.chat.threads.get',
  // Branch-Diff AI code review — request side of the chat-gated ai.review.*
  // result events already forwarded via CAP_EVENTS.
  'chat.review_start': 'ai.review.start',
  'chat.review_stop': 'ai.review.stop',
  'chat.analyzer_models': 'analyzer.models',
  'ui.settings_set': 'ui.settings.set',
  // Settings read — used by the Plans plugin shim (src/renderer/plugins/plans/
  // capabilityBackend.ts) for theme sync; not part of the mini-IDE shim surface.
  'ui.settings_get': 'ui.settings.get',
}

describe('resolveWsType', () => {
  it('maps the uniform fs/git/search/issues surface to backend WS types', () => {
    expect(resolveWsType('fs', 'read_file')).toBe('fs.read_file')
    expect(resolveWsType('fs', 'write_file')).toBe('fs.write_file')
    expect(resolveWsType('fs', 'delete')).toBe('fs.delete')
    expect(resolveWsType('git', 'status')).toBe('git.status')
    expect(resolveWsType('git', 'diff_all')).toBe('git.diff_all')
    expect(resolveWsType('git', 'reset')).toBe('git.reset')
    expect(resolveWsType('search', 'find_in_files')).toBe('search.find_in_files')
    expect(resolveWsType('issues', 'provider')).toBe('issues.provider')
    expect(resolveWsType('issues', 'list')).toBe('issues.list')
    expect(resolveWsType('issues', 'set_state')).toBe('issues.set_state')
  })

  it('inverts the shim non-uniform remaps back to their backend WS types', () => {
    expect(resolveWsType('terminal', 'run')).toBe('shell.run')
    expect(resolveWsType('chat', 'editor_complete')).toBe('editor.complete')
    expect(resolveWsType('chat', 'start')).toBe('ai.chat.start')
    expect(resolveWsType('chat', 'settings_get')).toBe('ai.chat.settings.get')
    expect(resolveWsType('chat', 'web_search')).toBe('ai.web.search')
    expect(resolveWsType('ui', 'settings_set')).toBe('ui.settings.set')
    expect(resolveWsType('chat', 'review_start')).toBe('ai.review.start')
    expect(resolveWsType('chat', 'review_stop')).toBe('ai.review.stop')
    expect(resolveWsType('chat', 'analyzer_models')).toBe('analyzer.models')
  })

  it('returns null for an unmapped (ns, method)', () => {
    expect(resolveWsType('ping', 'ping')).toBeNull()
    expect(resolveWsType('issues', 'nope')).toBeNull()
    expect(resolveWsType('fs', 'nope')).toBeNull()
  })

  it('every CAP_MAP entry keys on ns.method', () => {
    for (const key of Object.keys(CAP_MAP)) {
      expect(key.split('.').length).toBeGreaterThanOrEqual(2)
    }
  })

  it('maps every non-uniform (ns.method) back to its backend WS type', () => {
    for (const [addr, wsType] of Object.entries(EXPECTED_EXPLICIT)) {
      expect(CAP_MAP[addr]).toBe(wsType)
    }
  })

  it('keeps uniform-namespace entries an identity map (value === key)', () => {
    for (const [key, value] of Object.entries(CAP_MAP)) {
      const ns = key.slice(0, key.indexOf('.'))
      if (ns === 'fs' || ns === 'git' || ns === 'search' || ns === 'issues') {
        expect(value).toBe(key)
      }
    }
  })

  it('has no CAP_MAP entry outside the fs/git/search/issues uniform + explicit surface', () => {
    for (const key of Object.keys(CAP_MAP)) {
      const ns = key.slice(0, key.indexOf('.'))
      const isUniform = ns === 'fs' || ns === 'git' || ns === 'search' || ns === 'issues'
      expect(isUniform || key in EXPECTED_EXPLICIT).toBe(true)
    }
  })
})

describe('eventNamespace', () => {
  it('gates the git.changed working-tree signal behind the fs namespace', () => {
    // A working-tree-changed notification is what an fs-capable plugin needs;
    // gating it on `git` would starve the fs probe / Explorer sync. See
    // capabilityMap.ts.
    expect(eventNamespace('git.changed')).toBe('fs')
    expect(CAP_EVENTS['git.changed']).toBe('fs')
  })

  it('forwards the settings, chat-stream and review events under their ns', () => {
    expect(eventNamespace('ui.settings_changed')).toBe('ui')
    expect(eventNamespace('ai.chat.chunk')).toBe('chat')
    expect(eventNamespace('ai.chat.done')).toBe('chat')
    expect(eventNamespace('ai.chat.error')).toBe('chat')
    expect(eventNamespace('ai.chat.command_proposal')).toBe('chat')
    expect(eventNamespace('ai.review.result')).toBe('chat')
    expect(eventNamespace('ai.review.error')).toBe('chat')
  })

  it('gates the plans.changed live-refresh signal behind the plans namespace', () => {
    expect(eventNamespace('plans.changed')).toBe('plans')
    expect(CAP_EVENTS['plans.changed']).toBe('plans')
  })

  it('gates every CAP_EVENTS entry on a granted capability namespace', () => {
    const known = new Set(['fs', 'git', 'terminal', 'search', 'chat', 'ui', 'plans'])
    for (const ns of Object.values(CAP_EVENTS)) expect(known.has(ns)).toBe(true)
  })

  it('returns null for an unforwarded event', () => {
    expect(eventNamespace('terminal.data')).toBeNull()
    expect(eventNamespace('agent.activity')).toBeNull()
  })
})
