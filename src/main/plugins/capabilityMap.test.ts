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
  // PTY create cancellation — the WS type's second dot keeps it out of the
  // uniform terminal split.
  'terminal.create_cancel': 'terminal.create.cancel',
  // Messaging roster read feeding the embedded CLI panel's @-mention menu —
  // rides the terminal namespace, so the WS type differs from the address.
  'terminal.agent_msg_list': 'agent_msg.list',
  'chat.editor_rewrite': 'editor.rewrite',
  'chat.editor_complete': 'editor.complete',
  // Retired AIChatPane surface trimmed to the settings store ReviewPane still
  // reads for its analyzer credentials.
  'chat.settings_get': 'ai.chat.settings.get',
  'chat.settings_set': 'ai.chat.settings.set',
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
    expect(resolveWsType('chat', 'settings_get')).toBe('ai.chat.settings.get')
    expect(resolveWsType('ui', 'settings_set')).toBe('ui.settings.set')
    expect(resolveWsType('chat', 'review_start')).toBe('ai.review.start')
    expect(resolveWsType('chat', 'review_stop')).toBe('ai.review.stop')
    expect(resolveWsType('chat', 'analyzer_models')).toBe('analyzer.models')
  })

  it('no longer maps the retired AIChatPane chat surface (settings excepted)', () => {
    expect(resolveWsType('chat', 'start')).toBeNull()
    expect(resolveWsType('chat', 'stop')).toBeNull()
    expect(resolveWsType('chat', 'notes_get')).toBeNull()
    expect(resolveWsType('chat', 'notes_set')).toBeNull()
    expect(resolveWsType('chat', 'threads_get')).toBeNull()
    expect(resolveWsType('chat', 'threads_set')).toBeNull()
    expect(resolveWsType('chat', 'enhance_prompt')).toBeNull()
    expect(resolveWsType('chat', 'web_search')).toBeNull()
  })

  it('maps the interactive PTY surface (AiCliDock/useTerminal) one-for-one', () => {
    expect(resolveWsType('terminal', 'create')).toBe('terminal.create')
    expect(resolveWsType('terminal', 'input')).toBe('terminal.input')
    expect(resolveWsType('terminal', 'log_sent')).toBe('terminal.log_sent')
    expect(resolveWsType('terminal', 'resize')).toBe('terminal.resize')
    expect(resolveWsType('terminal', 'interrupt')).toBe('terminal.interrupt')
    expect(resolveWsType('terminal', 'kill')).toBe('terminal.kill')
    expect(resolveWsType('terminal', 'reattach')).toBe('terminal.reattach')
    expect(resolveWsType('terminal', 'redraw')).toBe('terminal.redraw')
    // The one non-uniform member: WS type carries a second dot.
    expect(resolveWsType('terminal', 'create_cancel')).toBe('terminal.create.cancel')
  })

  it('maps the three-way conflict surface (must stay in sync with the git shim)', () => {
    // Missing here, the merge editor works in the main window and is rejected
    // by the broker in the plugin window — a plugin-only class of failure.
    expect(resolveWsType('git', 'conflict_stages')).toBe('git.conflict_stages')
    expect(resolveWsType('git', 'list_conflicts')).toBe('git.list_conflicts')
    expect(resolveWsType('git', 'mark_resolved')).toBe('git.mark_resolved')
  })

  it('maps the @-mention stat probe (fs.stat_path)', () => {
    expect(resolveWsType('fs', 'stat_path')).toBe('fs.stat_path')
  })

  it('returns null for an unmapped (ns, method)', () => {
    expect(resolveWsType('ping', 'ping')).toBeNull()
    expect(resolveWsType('issues', 'nope')).toBeNull()
    expect(resolveWsType('fs', 'nope')).toBeNull()
    expect(resolveWsType('terminal', 'nope')).toBeNull()
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
      // terminal is uniform EXCEPT its explicit remaps (run / create_cancel /
      // agent_msg_list).
      if (key in EXPECTED_EXPLICIT) continue
      if (ns === 'fs' || ns === 'git' || ns === 'search' || ns === 'issues' || ns === 'terminal') {
        expect(value).toBe(key)
      }
    }
  })

  it('has no CAP_MAP entry outside the uniform + explicit surface', () => {
    for (const key of Object.keys(CAP_MAP)) {
      const ns = key.slice(0, key.indexOf('.'))
      const isUniform =
        ns === 'fs' || ns === 'git' || ns === 'search' || ns === 'issues' || ns === 'terminal'
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

  it('forwards the settings and review events under their ns', () => {
    expect(eventNamespace('ui.settings_changed')).toBe('ui')
    expect(eventNamespace('ai.review.result')).toBe('chat')
    expect(eventNamespace('ai.review.end')).toBe('chat')
    expect(eventNamespace('ai.review.error')).toBe('chat')
  })

  it('no longer forwards the retired AIChatPane chat-stream events', () => {
    expect(eventNamespace('ai.chat.chunk')).toBeNull()
    expect(eventNamespace('ai.chat.tool_call')).toBeNull()
    expect(eventNamespace('ai.chat.tool_result')).toBeNull()
    expect(eventNamespace('ai.chat.done')).toBeNull()
    expect(eventNamespace('ai.chat.error')).toBeNull()
  })

  it('forwards the git askpass round-trip events under the git namespace', () => {
    // Without these a git-capable plugin (navide.git) never sees the prompt a
    // push/pull is blocked on — the operation hangs with no way to answer it.
    expect(eventNamespace('git.credential_request')).toBe('git')
    expect(eventNamespace('git.credential_cancelled')).toBe('git')
  })

  it('gates the plans.changed live-refresh signal behind the plans namespace', () => {
    expect(eventNamespace('plans.changed')).toBe('plans')
    expect(CAP_EVENTS['plans.changed']).toBe('plans')
  })

  it('forwards the PTY stream + lifecycle events under the terminal namespace', () => {
    // Without these, a plugin-hosted AiCliDock spawns a PTY it can never hear
    // from — output stays on the broker's WS and the pane looks frozen.
    expect(eventNamespace('terminal.output')).toBe('terminal')
    expect(eventNamespace('terminal.exit')).toBe('terminal')
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
