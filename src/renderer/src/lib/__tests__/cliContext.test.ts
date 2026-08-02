import { describe, it, expect } from 'vitest'
import {
  buildCliPaneBufferReply,
  buildExternalPaneContextPaste,
  endsWithMentionTrigger,
  shouldOpenMentionMenu,
  parseCliContextPayload,
  writeCliPaneDragPayload,
  screenToClientPoint,
  resolveCliDropSource,
  buildPaneContextPaste,
  buildCliSessionReference,
  chunkForPty,
  CLI_PASTE_BUFFER_CAP
} from '../cliContext'

describe('screenToClientPoint', () => {
  it('offsets the screen point by the viewport origin', () => {
    expect(screenToClientPoint({ screenX: 900, screenY: 500 }, { screenX: 700, screenY: 300 }))
      .toEqual({ x: 200, y: 200 })
  })

  it('is identity when the viewport sits at the screen origin', () => {
    expect(screenToClientPoint({ screenX: 40, screenY: 60 }, { screenX: 0, screenY: 0 }))
      .toEqual({ x: 40, y: 60 })
  })

  it('yields negative coordinates for a point above/left of the viewport', () => {
    expect(screenToClientPoint({ screenX: 10, screenY: 20 }, { screenX: 100, screenY: 50 }))
      .toEqual({ x: -90, y: -30 })
  })

  it('handles a viewport on a monitor at negative screen coordinates', () => {
    expect(screenToClientPoint({ screenX: -900, screenY: -100 }, { screenX: -1200, screenY: -300 }))
      .toEqual({ x: 300, y: 200 })
  })
})

describe('buildCliPaneBufferReply', () => {
  const pane = {
    id: 'p-1',
    agentLabel: 'Claude',
    agentKey: 'claude',
    pinnedSessionId: 'cli-session-1',
    sessionHomeId: 'home-1',
    workspacePath: '/workspace',
    outputLogFile: '/workspace/.agent-team/manual/claude-p-1.log'
  }

  it('returns not-found when the pane ref is gone (pane closed before drop)', () => {
    expect(buildCliPaneBufferReply(undefined, null)).toEqual({ error: 'not-found' })
    expect(buildCliPaneBufferReply(pane, undefined)).toEqual({
      error: 'not-found'
    })
  })

  it('builds the reply from the pane ref, preferring customName over agentLabel', () => {
    expect(
      buildCliPaneBufferReply(
        { ...pane, customName: 'My Pane' },
        { buffer: 'output' }
      )
    ).toEqual({
      label: 'My Pane',
      agentKey: 'claude',
      sessionId: 'cli-session-1',
      sessionHomeId: 'home-1',
      workspacePath: '/workspace',
      conversationLogPath: '/workspace/.agent-team/manual/claude-p-1.log',
      buffer: 'output'
    })
  })

  it('falls back to agentLabel when customName is empty', () => {
    expect(
      buildCliPaneBufferReply(
        { ...pane, customName: '' },
        { buffer: 'output' }
      )
    ).toMatchObject({ label: 'Claude', sessionId: 'cli-session-1', buffer: 'output' })
  })

  it('normalizes a missing/empty session id to null and a missing buffer to empty', () => {
    expect(buildCliPaneBufferReply({
      id: 'p-2', agentLabel: 'Codex', agentKey: 'codex', workspacePath: '/ws'
    }, {})).toEqual({
      label: 'Codex',
      agentKey: 'codex',
      sessionId: null,
      sessionHomeId: '',
      workspacePath: '/ws',
      conversationLogPath: '',
      buffer: ''
    })
  })

  it('labels an unknown pane record with an empty string rather than failing', () => {
    expect(buildCliPaneBufferReply(undefined, { buffer: 'x' })).toEqual({
      label: '',
      agentKey: '',
      sessionId: null,
      sessionHomeId: '',
      workspacePath: '',
      conversationLogPath: '',
      buffer: 'x'
    })
  })
})

describe('writeCliPaneDragPayload', () => {
  it('writes both the pane id and rich CLI context for every drag surface', () => {
    const written = new Map<string, string>()
    const payload = {
      paneId: 'p-aux',
      agentKey: 'codex',
      label: 'Review',
      sessionId: 'session-1',
      workspacePath: '/workspace'
    }

    writeCliPaneDragPayload({ setData: (type, value) => written.set(type, value) }, payload)

    expect(written.get('application/x-pane-id')).toBe('p-aux')
    expect(JSON.parse(written.get('application/x-cli-context') ?? '')).toEqual(payload)
  })
})

describe('parseCliContextPayload', () => {
  it('parses a valid drag payload', () => {
    const raw = JSON.stringify({ paneId: 'p-1', agentKey: 'claude', label: 'Claude', sessionId: 's-1' })
    expect(parseCliContextPayload(raw)).toEqual({
      paneId: 'p-1',
      agentKey: 'claude',
      label: 'Claude',
      sessionId: 's-1'
    })
  })

  it('returns null for malformed JSON', () => {
    expect(parseCliContextPayload('not json')).toBeNull()
    expect(parseCliContextPayload('')).toBeNull()
  })

  it('returns null when paneId is missing or not a string', () => {
    expect(parseCliContextPayload(JSON.stringify({ agentKey: 'claude' }))).toBeNull()
    expect(parseCliContextPayload(JSON.stringify({ paneId: 42 }))).toBeNull()
    expect(parseCliContextPayload(JSON.stringify({ paneId: '' }))).toBeNull()
    expect(parseCliContextPayload('null')).toBeNull()
    expect(parseCliContextPayload('"string"')).toBeNull()
  })

  it('normalizes empty agentKey/label to undefined and empty sessionId to null', () => {
    expect(parseCliContextPayload(JSON.stringify({ paneId: 'p-1', agentKey: '', label: '', sessionId: null }))).toEqual({
      paneId: 'p-1',
      agentKey: undefined,
      label: undefined,
      sessionId: null
    })
  })
})

describe('resolveCliDropSource', () => {
  const payload = (paneId: string): string => JSON.stringify({ paneId, agentKey: 'claude' })

  it('resolves the source pane id from the CLI-context payload', () => {
    expect(resolveCliDropSource(payload('pane-a'), 'pane-a', 'pane-b')).toBe('pane-a')
  })

  it('resolves the source pane id from the bare pane-id fallback', () => {
    expect(resolveCliDropSource('', 'pane-a', 'pane-b')).toBe('pane-a')
  })

  it('returns null for a self-drop (pane dropped onto its own terminal)', () => {
    expect(resolveCliDropSource(payload('pane-a'), 'pane-a', 'pane-a')).toBeNull()
    expect(resolveCliDropSource('', 'pane-a', 'pane-a')).toBeNull()
  })

  it('returns null for a malformed payload or a drag with no pane identity', () => {
    expect(resolveCliDropSource('{not json', '', 'pane-b')).toBeNull()
    expect(resolveCliDropSource('', '', 'pane-b')).toBeNull()
  })
})

describe('buildPaneContextPaste', () => {
  const context = {
    paneId: 'pane-a',
    label: 'Backend',
    agentKey: 'claude',
    sessionId: 'session-a',
    workspacePath: '/workspace',
    conversationLogPath: '/workspace/.agent-team/manual/claude-pane-a.log'
  }

  it('builds a session reference and includes rendered content even when a log is available', () => {
    const text = buildPaneContextPaste(context, 'line one\nline two') as string
    expect(text).toContain('--- CLI session context: Backend (claude) ---')
    expect(text).toContain('source_pane_id: "pane-a"')
    expect(text).toContain('source_session_id: "session-a"')
    expect(text).toContain('conversation_log: "/workspace/.agent-team/manual/claude-pane-a.log"')
    expect(text).toContain('For the complete conversation, read conversation_log')
    expect(text).toContain('--- recent terminal excerpt ---\nline one\nline two')
  })

  it('omits the agent key from the header when the pane has none', () => {
    const text = buildPaneContextPaste({ paneId: 'p', label: 'Backend' }, 'out')
    expect(text?.split('\n')[0]).toBe('--- CLI session context: Backend ---')
  })

  it("falls back to 'pane' when the source has no display name", () => {
    expect(buildPaneContextPaste({ paneId: 'p' }, 'out')?.split('\n')[0])
      .toBe('--- CLI session context: pane ---')
  })

  it('tail-truncates an oversized buffer and says so in the header', () => {
    const buffer = 'x'.repeat(CLI_PASTE_BUFFER_CAP + 500)
    const { conversationLogPath: _log, ...withoutLog } = context
    const text = buildPaneContextPaste({ ...withoutLog, agentKey: 'codex' }, buffer) as string
    expect(text).toContain(`--- recent terminal excerpt — last ${CLI_PASTE_BUFFER_CAP} chars ---`)
    const body = text.split(`--- recent terminal excerpt — last ${CLI_PASTE_BUFFER_CAP} chars ---\n`)[1]
      .split('\n--- end recent terminal excerpt ---')[0]
    expect(body).toHaveLength(CLI_PASTE_BUFFER_CAP)
  })

  it('does not claim truncation when the whole buffer fits under the cap', () => {
    const { conversationLogPath: _log, ...withoutLog } = context
    const text = buildPaneContextPaste({ ...withoutLog, agentKey: 'codex' }, 'short output') as string
    expect(text).not.toContain('last')
  })

  it('does not end with a newline (the paste must not submit itself)', () => {
    expect(buildPaneContextPaste(context, 'out')?.endsWith('\n')).toBe(false)
  })

  it('returns null for an empty or whitespace-only buffer (nothing to share)', () => {
    expect(buildPaneContextPaste({ paneId: 'p', label: 'Backend', agentKey: 'claude' }, '')).toBeNull()
    expect(buildPaneContextPaste({ paneId: 'p', label: 'Backend', agentKey: 'claude' }, '  \n\t\n ')).toBeNull()
  })

  it('shares the transcript location even before the terminal has rendered output', () => {
    const text = buildPaneContextPaste(context, '') as string
    expect(text).toContain('conversation_log:')
    expect(text).not.toContain('recent terminal excerpt')
  })
})

describe('buildExternalPaneContextPaste', () => {
  const reply = {
    label: 'Backend',
    agentKey: 'claude',
    sessionId: 'session-a',
    sessionHomeId: 'home-a',
    workspacePath: '/other-workspace',
    conversationLogPath: '/other-workspace/.agent-team/manual/claude-pane-a.log',
    buffer: 'line one\nline two'
  }

  it('builds the paste text from the relay reply fields', () => {
    const text = buildExternalPaneContextPaste('pane-a', reply) as string
    expect(text).toContain('--- CLI session context: Backend (claude) ---')
    expect(text).toContain('source_pane_id: "pane-a"')
    expect(text).toContain('source_workspace: "/other-workspace"')
    expect(text).toContain('--- recent terminal excerpt ---\nline one\nline two')
  })

  it('returns null for an error reply (caller surfaces the failure)', () => {
    expect(buildExternalPaneContextPaste('pane-a', { error: 'not-found' })).toBeNull()
    expect(buildExternalPaneContextPaste('pane-a', { ...reply, error: 'timeout' })).toBeNull()
  })

  it('returns null when there is nothing to share (no buffer, log, or session)', () => {
    expect(buildExternalPaneContextPaste('pane-a', { label: 'Backend', buffer: '  \n ' })).toBeNull()
  })

  it('omits empty-string reply fields instead of quoting them', () => {
    const text = buildExternalPaneContextPaste('pane-a', {
      label: '',
      agentKey: '',
      sessionId: null,
      sessionHomeId: '',
      workspacePath: '',
      conversationLogPath: '',
      buffer: 'out'
    }) as string
    expect(text.split('\n')[0]).toBe('--- CLI session context: pane ---')
    expect(text).not.toContain('source_agent')
    expect(text).not.toContain('source_workspace')
  })
})

describe('buildCliSessionReference', () => {
  it('uses one vendor-neutral schema and omits unavailable optional fields', () => {
    expect(buildCliSessionReference({ paneId: 'p', agentKey: 'grok', sessionId: null })).toBe(
      'source_pane_id: "p"\nsource_agent: "grok"'
    )
  })

  it.each(['claude', 'codex', 'antigravity', 'grok'])('uses the same schema for %s', (agentKey) => {
    const text = buildCliSessionReference({ paneId: 'p', agentKey, sessionId: 'session-1' })
    expect(text).toContain(`source_agent: "${agentKey}"`)
    expect(text).toContain('source_session_id: "session-1"')
  })
})

describe('chunkForPty', () => {
  it('splits text into chunks of at most the given size', () => {
    expect(chunkForPty('abcdefg', 3)).toEqual(['abc', 'def', 'g'])
  })

  it('returns a single chunk when the text fits', () => {
    expect(chunkForPty('abc', 8)).toEqual(['abc'])
    expect(chunkForPty('', 8)).toEqual([])
  })

  it('never splits a surrogate pair across chunks (non-BMP chars survive)', () => {
    // '😀' is two UTF-16 code units — a naive slice(0, 3) would cut it in half.
    const text = 'ab😀cd'
    const chunks = chunkForPty(text, 3)
    expect(chunks.join('')).toBe(text)
    for (const chunk of chunks) expect(chunk).not.toMatch(/[\uD800-\uDBFF]$/)
    expect(chunks).toEqual(['ab', '😀c', 'd'])
  })

  it('preserves the original text when re-joined', () => {
    const text = '🚀 done — 完成\nnext'
    expect(chunkForPty(text, 4).join('')).toBe(text)
  })
})

describe('endsWithMentionTrigger', () => {
  it('matches when the cursor sits immediately after an "@"', () => {
    expect(endsWithMentionTrigger('傳給 @')).toBe(true)
    expect(endsWithMentionTrigger('│ > tell @')).toBe(true)
    expect(endsWithMentionTrigger('@')).toBe(true)
  })

  it('matches the full-width "＠" a CJK IME emits', () => {
    expect(endsWithMentionTrigger('傳給 ＠')).toBe(true)
    expect(endsWithMentionTrigger('＠')).toBe(true)
  })

  it('does not match without a trailing "@"', () => {
    expect(endsWithMentionTrigger('')).toBe(false)
    expect(endsWithMentionTrigger('tell someone')).toBe(false)
    expect(endsWithMentionTrigger('a@b')).toBe(false)
  })

  it('opts back out when a space follows the "@"', () => {
    expect(endsWithMentionTrigger('傳給 @ ')).toBe(false)
    expect(endsWithMentionTrigger('傳給 ＠ ')).toBe(false)
  })
})

describe('shouldOpenMentionMenu', () => {
  it('triggers on "@" at the start of the line', () => {
    expect(shouldOpenMentionMenu('@', '')).toBe(true)
  })

  it('triggers on "@" right after whitespace', () => {
    expect(shouldOpenMentionMenu('@', 'tell ')).toBe(true)
    expect(shouldOpenMentionMenu('@', '傳給 ')).toBe(true)
  })

  it('triggers on the full-width "＠" a CJK IME emits', () => {
    expect(shouldOpenMentionMenu('＠', '')).toBe(true)
    expect(shouldOpenMentionMenu('＠', 'tell ')).toBe(true)
  })

  it('does NOT trigger mid-word (a non-space precedes the "@")', () => {
    expect(shouldOpenMentionMenu('@', 'a')).toBe(false)
    expect(shouldOpenMentionMenu('@', 'tell someone')).toBe(false)
    expect(shouldOpenMentionMenu('＠', 'a')).toBe(false)
  })

  it('ignores non-"@" characters', () => {
    expect(shouldOpenMentionMenu('a', '')).toBe(false)
    expect(shouldOpenMentionMenu(' ', 'tell ')).toBe(false)
  })
})
