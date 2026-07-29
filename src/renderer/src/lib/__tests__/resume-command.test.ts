import { describe, expect, it, vi } from 'vitest'
import {
  acquirePaneRebuildLock,
  buildResumeCommand,
  cancelStalePendingCreate,
  dedupeRestorablePanes,
  normalizeResumeSessionId,
  paneBusyForRebuild,
  paneCanRebuild,
  paneRebuildVisible,
  TERMINAL_CREATE_TIMEOUT_MS,
  shouldPreserveMissingSessionOnRestore,
  shouldWarnMissingResume,
} from '../resume-command'

describe('normalizeResumeSessionId', () => {
  const uuid = '019f6155-a2ae-72a2-a455-bf454b8f9f90'

  it('keeps an existing Codex UUID unchanged', () => {
    expect(normalizeResumeSessionId('codex', uuid)).toBe(uuid)
  })

  it('repairs a legacy Codex rollout filename', () => {
    expect(normalizeResumeSessionId(
      'codex',
      `rollout-2026-07-14T23-53-50-${uuid}`
    )).toBe(uuid)
  })

  it('repairs a full Codex rollout path with a jsonl suffix', () => {
    expect(normalizeResumeSessionId(
      'codex',
      `/tmp/sessions/rollout-2026-07-14T23-53-50-${uuid}.jsonl`
    )).toBe(uuid)
  })

  it('does not rewrite arbitrary Codex strings or another vendor id', () => {
    expect(normalizeResumeSessionId('codex', 'test-session')).toBe('test-session')
    expect(normalizeResumeSessionId('claude', `rollout-prefix-${uuid}`)).toBe(`rollout-prefix-${uuid}`)
  })
})

describe('shouldPreserveMissingSessionOnRestore', () => {
  it('protects a saved Codex session when its transcript is unavailable', () => {
    expect(shouldPreserveMissingSessionOnRestore('codex', 'saved-id', false)).toBe(true)
  })

  it('keeps a confirmed Codex session and other agents restorable', () => {
    expect(shouldPreserveMissingSessionOnRestore('codex', 'saved-id', true)).toBe(false)
    expect(shouldPreserveMissingSessionOnRestore('claude', 'saved-id', false)).toBe(false)
  })

  it('does not block a genuinely fresh Codex pane', () => {
    expect(shouldPreserveMissingSessionOnRestore('codex', '   ', false)).toBe(false)
  })
})

describe('shouldWarnMissingResume', () => {
  it('warns only for a confirmed-missing prior resume', () => {
    expect(shouldWarnMissingResume('claude', 'saved-id', false, true)).toBe(true)
  })

  it('keeps unknown and healthy transcripts on the resume route', () => {
    expect(shouldWarnMissingResume('claude', 'saved-id', null, true)).toBe(false)
    expect(shouldWarnMissingResume('claude', 'saved-id', true, true)).toBe(false)
  })

  it('excludes fresh launches and Codex preservation', () => {
    expect(shouldWarnMissingResume('claude', 'saved-id', false, false)).toBe(false)
    expect(shouldWarnMissingResume('codex', 'saved-id', false, true)).toBe(false)
  })
})

describe('dedupeRestorablePanes', () => {
  const uuid = '019f6155-a2ae-72a2-a455-bf454b8f9f90'

  it('keeps only the first record per (agent, session_id)', () => {
    const panes = [
      { agent: 'claude', session_id: 's1', pane_id: 'a' },
      { agent: 'claude', session_id: 's1', pane_id: 'b' },
      { agent: 'claude', session_id: 's1', pane_id: 'c' },
    ]
    expect(dedupeRestorablePanes(panes).map((p) => p.pane_id)).toEqual(['a'])
  })

  it('does not merge the same id across different agents', () => {
    const panes = [
      { agent: 'claude', session_id: 's1', pane_id: 'a' },
      { agent: 'grok', session_id: 's1', pane_id: 'b' },
    ]
    expect(dedupeRestorablePanes(panes).map((p) => p.pane_id)).toEqual(['a', 'b'])
  })

  it('always keeps panes without a session id (fresh, independent)', () => {
    const panes = [
      { agent: 'claude', session_id: '', pane_id: 'a' },
      { agent: 'claude', session_id: '', pane_id: 'b' },
      { agent: 'claude', pane_id: 'c' },
    ]
    expect(dedupeRestorablePanes(panes).map((p) => p.pane_id)).toEqual(['a', 'b', 'c'])
  })

  it('dedupes codex records that normalize to the same rollout id', () => {
    const panes = [
      { agent: 'codex', session_id: uuid, pane_id: 'a' },
      { agent: 'codex', session_id: `rollout-2026-07-14T23-53-50-${uuid}.jsonl`, pane_id: 'b' },
    ]
    expect(dedupeRestorablePanes(panes).map((p) => p.pane_id)).toEqual(['a'])
  })

  it('preserves order and mixes deduped + fresh correctly', () => {
    const panes = [
      { agent: 'claude', session_id: 's1', pane_id: 'a' },
      { agent: 'claude', session_id: '', pane_id: 'b' },
      { agent: 'claude', session_id: 's1', pane_id: 'c' }, // dup of a
      { agent: 'claude', session_id: 's2', pane_id: 'd' },
    ]
    expect(dedupeRestorablePanes(panes).map((p) => p.pane_id)).toEqual(['a', 'b', 'd'])
  })
})

describe('paneRebuildVisible', () => {
  it('renders the button for every resume-capable CLI, regardless of session state', () => {
    for (const agentKey of ['claude', 'codex', 'antigravity', 'grok', 'kimi', 'opencode']) {
      expect(paneRebuildVisible({ agentKey })).toBe(true)
    }
  })

  it('shows a fresh codex pane the button (visible) even though it is not yet rebuildable', () => {
    const pane = { agentKey: 'codex' }
    expect(paneRebuildVisible(pane)).toBe(true)
    expect(paneCanRebuild(pane)).toBe(false)
  })

  it('never renders the button for a non-resumable agent (plain terminal)', () => {
    expect(paneRebuildVisible({ agentKey: 'terminal' })).toBe(false)
  })
})

describe('paneCanRebuild', () => {
  it('hides rebuild for a fresh claude pane (pinned id, no transcript yet)', () => {
    expect(paneCanRebuild({ agentKey: 'claude', pinnedSessionId: 's1' })).toBe(false)
  })

  it('unlocks a claude pane once its transcript exists (turn event / resume spawn)', () => {
    expect(paneCanRebuild({ agentKey: 'claude', pinnedSessionId: 's1', sessionOnDisk: true })).toBe(true)
  })

  it('never rebuilds without a pinned session id, even with the flag', () => {
    expect(paneCanRebuild({ agentKey: 'claude', sessionOnDisk: true })).toBe(false)
  })

  it('unlocks other CLIs only when both the pinned id and the flag are present', () => {
    for (const agentKey of ['codex', 'antigravity', 'grok', 'kimi', 'opencode']) {
      expect(paneCanRebuild({ agentKey, pinnedSessionId: 's1', sessionOnDisk: true })).toBe(true)
    }
  })

  it('hides rebuild for a codex pane with a pinned id but no flag', () => {
    expect(paneCanRebuild({ agentKey: 'codex', pinnedSessionId: 's1' })).toBe(false)
  })

  it('excludes non-resumable agents (plain terminal)', () => {
    expect(paneCanRebuild({ agentKey: 'terminal', pinnedSessionId: 's1', sessionOnDisk: true })).toBe(false)
  })
})

describe('paneBusyForRebuild', () => {
  it.each([
    { displayStatus: 'running', terminalStatus: 'running', age: 99_000, expected: true },
    { displayStatus: 'starting', terminalStatus: 'starting', age: null, expected: true },
    { displayStatus: 'starting', terminalStatus: 'starting', age: TERMINAL_CREATE_TIMEOUT_MS - 1, expected: true },
    { displayStatus: 'starting', terminalStatus: 'starting', age: TERMINAL_CREATE_TIMEOUT_MS, expected: false },
    { displayStatus: 'starting', terminalStatus: 'running', age: 0, expected: false },
    { displayStatus: 'idle', terminalStatus: 'running', age: 0, expected: false },
  ])(
    'returns $expected for display=$displayStatus terminal=$terminalStatus age=$age',
    ({ displayStatus, terminalStatus, age, expected }) => {
      expect(paneBusyForRebuild(displayStatus, terminalStatus, age)).toBe(expected)
    }
  )
})

describe('stale create rebuild coordination', () => {
  it('holds both pane and session locks synchronously against a double-click', () => {
    const locks = new Set<string>()
    const release = acquirePaneRebuildLock(locks, ['pane-1', 'session-1'])
    expect(release).toBeTypeOf('function')
    expect(acquirePaneRebuildLock(locks, ['pane-1', 'session-1'])).toBeNull()
    release!()
    expect(acquirePaneRebuildLock(locks, ['pane-1', 'session-1'])).toBeTypeOf('function')
  })

  it('waits for stale create rollback before allowing rebuild work to continue', async () => {
    let finishCancel!: () => void
    const cancel = vi.fn(() => new Promise<void>((resolve) => { finishCancel = resolve }))
    let continued = false
    const recovery = cancelStalePendingCreate(
      'starting',
      TERMINAL_CREATE_TIMEOUT_MS,
      cancel,
    ).then(() => { continued = true })

    await Promise.resolve()
    expect(cancel).toHaveBeenCalledOnce()
    expect(continued).toBe(false)
    finishCancel()
    await recovery
    expect(continued).toBe(true)
  })
})

describe('buildResumeCommand', () => {
  it('uses --resume for claude', () => {
    expect(buildResumeCommand('claude', 'abc')).toBe('claude --resume abc')
  })

  it('uses the resume subcommand (no --) for codex', () => {
    expect(buildResumeCommand('codex', 'abc')).toBe('codex resume abc')
  })

  it('uses agy --conversation for antigravity', () => {
    expect(buildResumeCommand('antigravity', 'abc')).toBe('agy --conversation abc')
  })

  it('uses grok -s for grok', () => {
    expect(buildResumeCommand('grok', '1f9e02aabb3c')).toBe('grok -s 1f9e02aabb3c')
  })

  it('grok resume with a blank id falls back to "" like other vendors', () => {
    expect(buildResumeCommand('grok', '  ')).toBe('')
  })

  it('uses kimi --session for kimi (id keeps its session_ prefix)', () => {
    expect(buildResumeCommand('kimi', 'session_4d4a11fe-b08a-46df-9f86-685589531e65')).toBe(
      'kimi --session session_4d4a11fe-b08a-46df-9f86-685589531e65'
    )
  })

  it('uses opencode --session for opencode (id keeps its ses_ prefix)', () => {
    expect(buildResumeCommand('opencode', 'ses_18d0acbcaffe3eXy2s3zezEmix')).toBe(
      'opencode --session ses_18d0acbcaffe3eXy2s3zezEmix'
    )
  })

  it('uses the default --resume branch for qwen (UUID id)', () => {
    expect(buildResumeCommand('qwen', '4d4a11fe-b08a-46df-9f86-685589531e65')).toBe(
      'qwen --resume 4d4a11fe-b08a-46df-9f86-685589531e65'
    )
  })

  it('uses kilo --session for kilo (id keeps its ses_ prefix)', () => {
    expect(buildResumeCommand('kilo', 'ses_18d0acbcaffe3eXy2s3zezEmix')).toBe(
      'kilo --session ses_18d0acbcaffe3eXy2s3zezEmix'
    )
  })

  it('uses pi --session-id for pi (UUID id)', () => {
    expect(buildResumeCommand('pi', '4d4a11fe-b08a-46df-9f86-685589531e65')).toBe(
      'pi --session-id 4d4a11fe-b08a-46df-9f86-685589531e65'
    )
  })

  it('uses copilot --resume=<id> for copilot (UUID id, `=` form)', () => {
    expect(buildResumeCommand('copilot', '4d4a11fe-b08a-46df-9f86-685589531e65')).toBe(
      'copilot --resume=4d4a11fe-b08a-46df-9f86-685589531e65'
    )
  })

  it('uses cursor-agent --resume=<id> for cursor (UUID id, `=` form)', () => {
    expect(buildResumeCommand('cursor', '4d4a11fe-b08a-46df-9f86-685589531e65')).toBe(
      'cursor-agent --resume=4d4a11fe-b08a-46df-9f86-685589531e65'
    )
  })

  it('uses the id-less --restore-chat-history for aider (no session ids)', () => {
    const id = '4d4a11fe-b08a-46df-9f86-685589531e65'
    expect(buildResumeCommand('aider', id)).toBe('aider --restore-chat-history')
    expect(buildResumeCommand('aider', id)).not.toContain(id)
    // aider ignores the id entirely — an empty id still yields the command
    expect(buildResumeCommand('aider', '')).toBe('aider --restore-chat-history')
    expect(buildResumeCommand('aider', '', '--yes-always')).toBe(
      'aider --restore-chat-history --yes-always'
    )
  })

  it('restores aider from the pane-private chat-history file when given one', () => {
    expect(
      buildResumeCommand('aider', '', '--yes-always', '/repo/.aider.chat.history.4d4a11fe.md')
    ).toBe(
      "aider --chat-history-file '/repo/.aider.chat.history.4d4a11fe.md' --restore-chat-history --yes-always"
    )
    // YOLO off → no trailing permission flag
    expect(
      buildResumeCommand('aider', '', '', '/repo/.aider.chat.history.4d4a11fe.md')
    ).toBe(
      "aider --chat-history-file '/repo/.aider.chat.history.4d4a11fe.md' --restore-chat-history"
    )
  })

  it('quotes a spaced workspace path in the aider resume command', () => {
    expect(
      buildResumeCommand(
        'aider', '', '--yes-always',
        '/Users/me/My Projects/agent team/.aider.chat.history.4d4a11fe.md'
      )
    ).toBe(
      "aider --chat-history-file '/Users/me/My Projects/agent team/.aider.chat.history.4d4a11fe.md'"
      + ' --restore-chat-history --yes-always'
    )
  })

  it('appends the permission-bypass flag when given', () => {
    expect(buildResumeCommand('claude', 'abc', '--dangerously-skip-permissions')).toBe(
      'claude --resume abc --dangerously-skip-permissions'
    )
    expect(buildResumeCommand('codex', 'abc', '--dangerously-bypass-approvals-and-sandbox')).toBe(
      'codex resume abc --dangerously-bypass-approvals-and-sandbox'
    )
    expect(buildResumeCommand('antigravity', 'abc', '--dangerously-skip-permissions')).toBe(
      'agy --conversation abc --dangerously-skip-permissions'
    )
  })

  it('returns "" for an empty/blank session id so the caller falls back to a fresh spawn', () => {
    expect(buildResumeCommand('claude', '')).toBe('')
    expect(buildResumeCommand('codex', '   ')).toBe('')
  })

  it('trims the session id', () => {
    expect(buildResumeCommand('antigravity', '  abc  ')).toBe('agy --conversation abc')
  })
})
