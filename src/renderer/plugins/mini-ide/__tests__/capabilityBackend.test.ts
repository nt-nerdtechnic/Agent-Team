// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { TYPE_TO_CAP, resolveCapability, useBackend } from '../capabilityBackend'
import type { useBackend as realUseBackend } from '../../../src/composables/useBackend'

// ── Compile-time interface parity ────────────────────────────────────────────
// The plugin build aliases the real `useBackend` to the shim; if their public
// surfaces drift, these assignments stop type-checking (caught by vue-tsc).
type Real = ReturnType<typeof realUseBackend>
type Shim = ReturnType<typeof useBackend>
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const _shimAssignableToReal: Real = undefined as unknown as Shim
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const _realAssignableToShim: Shim = undefined as unknown as Real

// Every WS `type` the mini-IDE actually sends (collected from EditorWindowApp +
// AIChatPane + the panes + useGit/useExplorer). The map MUST resolve all of them.
const MINI_IDE_SENT_TYPES = [
  // fs
  'fs.read_file', 'fs.write_file', 'fs.list_dir', 'fs.list_files_flat', 'fs.glob_files',
  'fs.create_file', 'fs.delete', 'fs.mkdir', 'fs.rename', 'fs.convert_office',
  'fs.list_archive', 'fs.read_image',
  // git (via useGit + DiffPane/BranchDiffPane/ConflictPane/AIChatPane)
  'git.status', 'git.log', 'git.diff_branches', 'git.rebase', 'git.restore_from_branch',
  'git.show_commit', 'git.worktrees', 'git.add_worktree', 'git.remove_worktree',
  'git.prune_worktrees', 'git.lock_worktree', 'git.unlock_worktree', 'git.move_worktree',
  'git.repair_worktrees', 'git.config_set', 'git.config_get', 'git.blame', 'git.tags',
  'git.create_tag', 'git.delete_tag', 'git.cherry_pick', 'git.file_log', 'git.show_file',
  'git.resolve_ours', 'git.resolve_theirs', 'git.remotes', 'git.diff_file', 'git.diff_blame',
  'git.merge', 'git.merge_into', 'git.revert', 'git.add_remote', 'git.remove_remote',
  'git.branches', 'git.stash_list', 'git.fetch', 'git.pull', 'git.push', 'git.create_branch',
  'git.switch_branch', 'git.checkout_remote_branch', 'git.checkout_commit',
  'git.commit_file_diff', 'git.delete_branch', 'git.stash', 'git.stash_pop', 'git.stash_drop',
  'git.amend', 'git.undo_commit', 'git.apply_patch', 'git.clone', 'git.check_ignore',
  'git.abort', 'git.stash_apply', 'git.pull_rebase', 'git.push_force', 'git.push_upstream',
  'git.credential_submit', 'git.credential_cancel', 'git.discover_repositories',
  'git.compare_branches', 'git.clean', 'git.discard', 'git.stage', 'git.unstage',
  'git.stage_all', 'git.commit', 'git.sync', 'git.init', 'git.generate_message',
  'git.check_staged', 'git.connect_to_remote', 'git.ignore', 'git.diff_all', 'git.reset',
  // search
  'search.find_in_files', 'search.replace_in_files',
  // shell
  'shell.run',
  // editor inline AI
  'editor.rewrite', 'editor.complete',
  // ai / ai.chat
  'ai.enhance_prompt', 'ai.web.search', 'ai.chat.start', 'ai.chat.stop',
  'ai.chat.settings.get', 'ai.chat.settings.set', 'ai.chat.test_connection',
  'ai.chat.accept_edit', 'ai.chat.approve_command', 'ai.chat.reject_command',
  'ai.chat.notes.get', 'ai.chat.notes.set', 'ai.chat.threads.get', 'ai.chat.threads.set',
  // ai.review / analyzer (useReview + ReviewPane — Branch-Diff AI code review)
  'ai.review.start', 'ai.review.stop', 'analyzer.models',
  // ui / settings (set + the connect-time reconcile read in lib/settings.ts)
  'ui.settings.set', 'ui.settings.get',
  // issues (GitPane → useIssues, gh/glab CRUD)
  'issues.provider', 'issues.list', 'issues.get', 'issues.create', 'issues.comment',
  'issues.set_state',
] as const

describe('TYPE_TO_CAP coverage', () => {
  it('resolves every WS type the mini-IDE sends to a capability', () => {
    const unmapped = MINI_IDE_SENT_TYPES.filter((t) => resolveCapability(t) === null)
    expect(unmapped).toEqual([])
  })

  it('maps only into the granted capability namespaces', () => {
    const allowed = new Set(['fs', 'git', 'terminal', 'search', 'chat', 'ui', 'issues'])
    for (const ref of Object.values(TYPE_TO_CAP)) {
      expect(allowed.has(ref.ns)).toBe(true)
    }
  })

  it('splits uniform namespaces on the dotted method', () => {
    expect(resolveCapability('fs.read_file')).toEqual({ ns: 'fs', method: 'read_file' })
    expect(resolveCapability('git.status')).toEqual({ ns: 'git', method: 'status' })
    expect(resolveCapability('search.find_in_files')).toEqual({
      ns: 'search',
      method: 'find_in_files',
    })
  })

  it('remaps the non-uniform shell/editor/ai/ui families', () => {
    expect(resolveCapability('shell.run')).toEqual({ ns: 'terminal', method: 'run' })
    expect(resolveCapability('editor.complete')).toEqual({ ns: 'chat', method: 'editor_complete' })
    expect(resolveCapability('ai.chat.start')).toEqual({ ns: 'chat', method: 'start' })
    expect(resolveCapability('ai.chat.settings.get')).toEqual({ ns: 'chat', method: 'settings_get' })
    expect(resolveCapability('ai.web.search')).toEqual({ ns: 'chat', method: 'web_search' })
    expect(resolveCapability('ui.settings.set')).toEqual({ ns: 'ui', method: 'settings_set' })
    // Settings reconcile read — without this the plugin's settings cache stays
    // empty on connect and the theme falls back to the dark default.
    expect(resolveCapability('ui.settings.get')).toEqual({ ns: 'ui', method: 'settings_get' })
    // Branch-Diff AI code review requests ride the chat namespace, matching the
    // chat-gated ai.review.* result events in CAP_EVENTS.
    expect(resolveCapability('ai.review.start')).toEqual({ ns: 'chat', method: 'review_start' })
    expect(resolveCapability('ai.review.stop')).toEqual({ ns: 'chat', method: 'review_stop' })
    expect(resolveCapability('analyzer.models')).toEqual({ ns: 'chat', method: 'analyzer_models' })
  })

  it('splits the uniform issues namespace on the dotted method', () => {
    expect(resolveCapability('issues.list')).toEqual({ ns: 'issues', method: 'list' })
    expect(resolveCapability('issues.set_state')).toEqual({ ns: 'issues', method: 'set_state' })
  })

  it('returns null for unmapped types', () => {
    expect(resolveCapability('issues.nope')).toBeNull()
    expect(resolveCapability('terminal.input')).toBeNull()
    expect(resolveCapability('totally.unknown')).toBeNull()
    expect(resolveCapability('')).toBeNull()
  })
})

describe('useBackend shim send()', () => {
  const callCapability = vi.fn()
  beforeEach(() => {
    callCapability.mockReset()
    ;(window as unknown as { nav: unknown }).nav = {
      callCapability,
      on: vi.fn(() => () => {}),
      ready: vi.fn(),
    }
  })

  it('routes a mapped type through nav.callCapability and adapts the response', async () => {
    callCapability.mockResolvedValue({ reqId: 'r1', ok: true, result: { content: 'hi' } })
    const backend = useBackend()
    const resp = await backend.send('fs.read_file', { workspace_path: '/w', rel_path: 'a.txt' })
    expect(callCapability).toHaveBeenCalledWith('fs', 'read_file', {
      workspace_path: '/w',
      rel_path: 'a.txt',
    })
    expect(resp.ok).toBe(true)
    expect(resp.payload).toEqual({ content: 'hi' })
    expect(resp.error).toBeNull()
    expect(resp.type).toBe('fs.read_file')
  })

  it('adapts a capability error envelope into ok:false', async () => {
    callCapability.mockResolvedValue({
      reqId: 'r2',
      ok: false,
      error: { code: 'CAP_DENIED', message: 'nope' },
    })
    const backend = useBackend()
    const resp = await backend.send('git.status', { workspace_path: '/w' })
    expect(resp.ok).toBe(false)
    expect(resp.payload).toBeNull()
    expect(resp.error).toEqual({ code: 'CAP_DENIED', message: 'nope' })
  })

  it('returns UNMAPPED_CAPABILITY without calling the broker for an unmapped type', async () => {
    const backend = useBackend()
    const resp = await backend.send('terminal.input', {})
    expect(callCapability).not.toHaveBeenCalled()
    expect(resp.ok).toBe(false)
    expect(resp.error?.code).toBe('UNMAPPED_CAPABILITY')
  })

  it('converts a thrown broker call into a BROKER_ERROR envelope', async () => {
    callCapability.mockRejectedValue(new Error('ipc down'))
    const backend = useBackend()
    const resp = await backend.send('fs.list_dir', { workspace_path: '/w' })
    expect(resp.ok).toBe(false)
    expect(resp.error?.code).toBe('BROKER_ERROR')
    expect(resp.error?.message).toBe('ipc down')
  })

  it('resolves httpUrl from the ?http_url= query the host injects', () => {
    window.history.replaceState({}, '', '/?http_url=http%3A%2F%2F127.0.0.1%3A8123')
    const backend = useBackend()
    expect(backend.httpUrl.value).toBe('http://127.0.0.1:8123')
    window.history.replaceState({}, '', '/')
    expect(useBackend().httpUrl.value).toBe('')
  })

  it('reports a connected status and subscribes via nav.on', () => {
    const backend = useBackend()
    expect(backend.status.value).toBe('connected')
    const cb = vi.fn()
    backend.on('git.changed', cb)
    expect(
      (window as unknown as { nav: { on: ReturnType<typeof vi.fn> } }).nav.on
    ).toHaveBeenCalledWith('git.changed', cb)
  })
})
