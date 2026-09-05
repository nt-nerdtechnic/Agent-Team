import { describe, it, expect } from 'vitest'
import {
  buildCliPaneBufferReply,
  buildExternalPaneContextPaste,
  buildPaneStatusReply,
  buildMentionInsert,
  endsWithMentionTrigger,
  shouldMentionOnDrop,
  shouldOpenMentionMenu,
  parseCliContextPayload,
  parsePaneDragBatch,
  writeCliPaneDragPayload,
  screenToClientPoint,
  resolveCliDropSource,
  resolveCliDropSources,
  PANE_BATCH_MIME,
  buildPaneContextPaste,
  buildCliSessionReference,
  chunkForPty,
  injectionChunks,
  stripInputSequences,
  BRACKETED_PASTE_START,
  BRACKETED_PASTE_END,
  CLI_PASTE_BUFFER_CAP,
  filterMentionCandidates,
  clusterMentionCandidates,
  rankMentionCandidates,
  recordMentionRecents,
  buildMentionPickData,
  applyMentionPickToInput,
  MENTION_BROADCAST_ADDRESS,
  type MentionCandidate
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

describe('buildPaneStatusReply', () => {
  it('reports starting with no buffer for a pane with no realized ref', () => {
    expect(buildPaneStatusReply({ outputLogFile: '/ws/.agent-team/manual/x.log' }, null)).toEqual({
      status: 'starting',
      buffer: '',
      logPath: '/ws/.agent-team/manual/x.log'
    })
  })

  it('reports the live status and buffer for a realized pane', () => {
    expect(
      buildPaneStatusReply({ outputLogFile: '/ws/x.log' }, { displayStatus: 'running', buffer: 'hello' })
    ).toEqual({
      status: 'running',
      buffer: 'hello',
      logPath: '/ws/x.log'
    })
  })

  it('carries the kickoff verdict so a caller can tell delivery from a bare prompt', () => {
    // cli_open_agent's ok:true only means the pane exists. This is the field
    // that answers whether the task it was opened with actually arrived.
    const unverified = buildPaneStatusReply(
      { outputLogFile: '/ws/x.log', kickoffStatus: 'unverified' },
      { displayStatus: 'running', buffer: '' }
    )
    expect(unverified.kickoff).toBe('unverified')

    const sent = buildPaneStatusReply(
      { outputLogFile: '/ws/x.log', kickoffStatus: 'sent' },
      { displayStatus: 'running', buffer: '' }
    )
    expect(sent.kickoff).toBe('sent')
  })

  it('omits kickoff for a pane that was never given a task', () => {
    // 'none' is the resting value; reporting it would be noise on every pane
    // the user opened by hand.
    const none = buildPaneStatusReply(
      { outputLogFile: '/ws/x.log', kickoffStatus: 'none' },
      { displayStatus: 'running', buffer: '' }
    )
    expect(none.kickoff).toBeUndefined()
    expect(buildPaneStatusReply({ outputLogFile: '/ws/x.log' }, null).kickoff).toBeUndefined()
  })

  it('carries awaitingKind so a caller can tell the two waits apart', () => {
    // The badge merged them; this reply must not. cli_wait_idle returns from a
    // question and blocks on a permission prompt, and `status` reads
    // 'awaiting' for both.
    const question = buildPaneStatusReply(undefined, {
      displayStatus: 'awaiting',
      awaitingKind: 'question',
      buffer: ''
    })
    expect(question.status).toBe('awaiting')
    expect(question.awaitingKind).toBe('question')

    const permission = buildPaneStatusReply(undefined, {
      displayStatus: 'awaiting',
      awaitingKind: 'permission',
      buffer: ''
    })
    expect(permission.awaitingKind).toBe('permission')
  })

  it('omits awaitingKind entirely when the pane is not parked', () => {
    // null is the normal value for every other status; sending the key with a
    // null value would make the backend's "field absent" check ambiguous.
    const reply = buildPaneStatusReply(undefined, {
      displayStatus: 'running',
      awaitingKind: null,
      buffer: ''
    })
    expect('awaitingKind' in reply).toBe(false)
  })

  it('caps the buffer to CLI_PASTE_BUFFER_CAP chars, keeping only the tail', () => {
    const long = 'a'.repeat(CLI_PASTE_BUFFER_CAP + 500)
    const reply = buildPaneStatusReply(undefined, { displayStatus: 'idle', buffer: long })
    expect(reply.buffer.length).toBe(CLI_PASTE_BUFFER_CAP)
    expect(reply.buffer).toBe(long.slice(-CLI_PASTE_BUFFER_CAP))
  })

  it('omits logPath when the pane record has none, without a pane record at all', () => {
    expect(buildPaneStatusReply(undefined, { displayStatus: 'idle', buffer: '' })).toEqual({
      status: 'idle',
      buffer: '',
      logPath: undefined
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

  it('writes the batch MIME when the drag carries a multi-selection', () => {
    const written = new Map<string, string>()
    writeCliPaneDragPayload(
      { setData: (type, value) => written.set(type, value) },
      { paneId: 'p-1' },
      ['p-1', 'p-2', 'p-3']
    )

    expect(written.get(PANE_BATCH_MIME)).toBe('p-1\np-2\np-3')
    // The grabbed pane still identifies the drag for single-pane consumers.
    expect(written.get('application/x-pane-id')).toBe('p-1')
  })

  it('omits the batch MIME for a one-pane drag', () => {
    const written = new Map<string, string>()
    writeCliPaneDragPayload(
      { setData: (type, value) => written.set(type, value) },
      { paneId: 'p-1' },
      ['p-1']
    )

    expect(written.has(PANE_BATCH_MIME)).toBe(false)
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

describe('parsePaneDragBatch', () => {
  it('splits the newline-separated batch payload', () => {
    expect(parsePaneDragBatch('pane-a\npane-b\npane-c')).toEqual(['pane-a', 'pane-b', 'pane-c'])
  })

  it('is empty for an absent or blank payload (a single-pane drag)', () => {
    expect(parsePaneDragBatch('')).toEqual([])
    expect(parsePaneDragBatch('\n \n')).toEqual([])
  })

  it('trims stray whitespace and drops empty entries', () => {
    expect(parsePaneDragBatch(' pane-a \n\n pane-b')).toEqual(['pane-a', 'pane-b'])
  })
})

describe('resolveCliDropSources', () => {
  const payload = (paneId: string): string => JSON.stringify({ paneId, agentKey: 'claude' })

  it('falls back to the single source when no batch travelled with the drag', () => {
    expect(resolveCliDropSources(payload('pane-a'), 'pane-a', '', 'pane-b')).toEqual(['pane-a'])
    expect(resolveCliDropSources('', 'pane-a', '', 'pane-b')).toEqual(['pane-a'])
  })

  it('returns every pane of a batch drag, in drag order', () => {
    expect(resolveCliDropSources(payload('pane-c'), 'pane-c', 'pane-a\npane-c', 'pane-b'))
      .toEqual(['pane-a', 'pane-c'])
  })

  it('excludes the drop target from the batch — a pane cannot share with itself', () => {
    expect(resolveCliDropSources(payload('pane-a'), 'pane-a', 'pane-a\npane-b', 'pane-b'))
      .toEqual(['pane-a'])
  })

  it('is empty for a self-drop with no batch', () => {
    expect(resolveCliDropSources(payload('pane-a'), 'pane-a', '', 'pane-a')).toEqual([])
  })

  it('is empty for a drag carrying no pane identity at all', () => {
    expect(resolveCliDropSources('', '', '', 'pane-b')).toEqual([])
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

describe('injectionChunks', () => {
  it('sends each bracketed-paste guard as its own whole chunk', () => {
    const chunks = injectionChunks('abcdefg', 3, true)
    expect(chunks[0]).toBe(BRACKETED_PASTE_START)
    expect(chunks[chunks.length - 1]).toBe(BRACKETED_PASTE_END)
    expect(chunks.slice(1, -1)).toEqual(['abc', 'def', 'g'])
  })

  it('never splits a guard across chunks, however small the chunk size', () => {
    // The guards are 6 code units each: a size-based split of the WRAPPED
    // string would cut them, and the CLI would print the remainder as text.
    for (const size of [1, 2, 3, 5, 6, 7]) {
      const chunks = injectionChunks('hello world', size, true)
      expect(chunks).toContain(BRACKETED_PASTE_START)
      expect(chunks).toContain(BRACKETED_PASTE_END)
      expect(chunks.join('')).toBe(`${BRACKETED_PASTE_START}hello world${BRACKETED_PASTE_END}`)
    }
  })

  it('leaves the payload bare for a vendor that does not take bracketed paste', () => {
    expect(injectionChunks('abcdefg', 3, false)).toEqual(['abc', 'def', 'g'])
  })

  it('keeps the body byte-identical, surrogate pairs included', () => {
    const body = 'ship it 🚀 完成'
    const chunks = injectionChunks(body, 4, true)
    expect(chunks.slice(1, -1).join('')).toBe(body)
    for (const chunk of chunks) expect(chunk).not.toMatch(/[\uD800-\uDBFF]$/)
  })

  it('writes nothing at all for an empty body', () => {
    // Guards around no content are two PTY writes where there used to be none,
    // announcing a paste that never arrives.
    expect(injectionChunks('', 512, true)).toEqual([])
    expect(injectionChunks('', 512, false)).toEqual([])
  })

  it('does not let a payload close paste mode and keep typing', () => {
    // The attack this exists for. Bracketed paste says "take the next bytes as
    // text, not as keys" — until the end guard, which is five printable bytes
    // any message can contain. A payload carrying one ends paste early, and
    // everything after it reaches the CLI as keystrokes: CR submits, \x03
    // interrupts. A message from another machine could press keys on this one.
    const evil = `looks harmless${BRACKETED_PASTE_END}\rrm -rf something\x03`
    const wire = injectionChunks(evil, 512, true).join('')

    // Exactly one of each guard, and both at the ends where we put them.
    expect(wire.split(BRACKETED_PASTE_END)).toHaveLength(2)
    expect(wire.startsWith(BRACKETED_PASTE_START)).toBe(true)
    expect(wire.endsWith(BRACKETED_PASTE_END)).toBe(true)
    // Nothing lands outside the guards.
    const inside = wire.slice(BRACKETED_PASTE_START.length, -BRACKETED_PASTE_END.length)
    expect(inside).not.toContain(BRACKETED_PASTE_END)
    expect(inside).not.toContain('\r')
    expect(inside).not.toContain('\x03')
    // The readable part survives: this sanitises, it does not reject.
    expect(inside).toContain('looks harmless')
    expect(inside).toContain('rm -rf something')
  })

  it('sanitises the bare path too, where there are no guards to rely on', () => {
    // `bracketed: false` exists for CLIs that do not implement paste mode, and
    // there every control byte is a keypress by definition.
    const wire = injectionChunks(`a\x03b\x1b[201~c\rd`, 512, false).join('')
    expect(wire).toBe('abcd')
  })

  it('keeps newlines and tabs, which are what multi-line messages are made of', () => {
    // preserveNewlines callers pass real newlines on purpose. Stripping those
    // would break agent messages rather than protect them — CR is the one that
    // goes, because in a PTY it is Enter and the payload does not get to decide
    // when it is finished.
    const body = 'line one\n\tindented\nline three'
    const chunks = injectionChunks(body, 512, true)
    expect(chunks.slice(1, -1).join('')).toBe(body)
  })

  it('writes nothing when a body is empty only after sanitising', () => {
    // Same situation as an empty body, reached a different way: guards around
    // nothing announce a paste that never comes.
    expect(injectionChunks('\x03\x07', 512, true)).toEqual([])
  })
})

describe('stripInputSequences', () => {
  it('keeps the text the user actually typed', () => {
    expect(stripInputSequences('/clear')).toBe('/clear')
    expect(stripInputSequences('完成 🚀')).toBe('完成 🚀')
  })

  it('drops a cursor key whole instead of leaving "[A" behind', () => {
    expect(stripInputSequences('\x1b[A')).toBe('')
    expect(stripInputSequences('\x1b[1;5D')).toBe('')
    expect(stripInputSequences('\x1bOP')).toBe('')
  })

  it('drops mouse and focus reports whole', () => {
    expect(stripInputSequences('\x1b[<0;10;5M')).toBe('')
    expect(stripInputSequences('\x1b[<0;10;5m')).toBe('')
    expect(stripInputSequences('\x1b[I')).toBe('')
  })

  it('unwraps a bracketed paste to its contents', () => {
    expect(stripInputSequences('\x1b[200~hello\x1b[201~')).toBe('hello')
  })

  it('still removes the plain control characters', () => {
    expect(stripInputSequences('a\x00b\x7fc')).toBe('abc')
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

describe('shouldMentionOnDrop', () => {
  // Regression guard. A pane drop has two gestures competing for the same
  // target: insert the source's address, or share its scrollback. The typed
  // "@" is the only thing that separates them — drop this precondition and the
  // mention path answers every drop, silently removing the context share.
  it('selects mention mode only when the prompt ends with a typed "@"', () => {
    expect(shouldMentionOnDrop('傳給 @')).toBe(true)
    expect(shouldMentionOnDrop('傳給 ＠')).toBe(true)
    expect(shouldMentionOnDrop('@')).toBe(true)
  })

  it('leaves a prompt without "@" to the scrollback context share', () => {
    expect(shouldMentionOnDrop('')).toBe(false)
    expect(shouldMentionOnDrop('│ > 幫我看這個')).toBe(false)
    expect(shouldMentionOnDrop('傳給')).toBe(false)
    // "@" followed by a space is ordinary text, not a pending mention.
    expect(shouldMentionOnDrop('傳給 @ ')).toBe(false)
  })

  it('never mentions into a prompt it could not read', () => {
    expect(shouldMentionOnDrop(undefined)).toBe(false)
  })
})

describe('buildMentionInsert', () => {
  it('completes an "@" the user already typed', () => {
    expect(buildMentionInsert('傳給 @', 'codex-1')).toBe('codex-1 ')
    expect(buildMentionInsert('傳給 ＠', 'codex-1')).toBe('codex-1 ')
  })

  it('adds the "@" itself when the prompt has none', () => {
    expect(buildMentionInsert('', 'codex-1')).toBe('@codex-1 ')
    expect(buildMentionInsert('│ > 傳給 ', 'codex-1')).toBe('@codex-1 ')
  })

  it('separates the mention from preceding text', () => {
    expect(buildMentionInsert('傳給', 'codex-1')).toBe(' @codex-1 ')
    expect(buildMentionInsert('傳給 @ ', 'codex-1')).toBe('@codex-1 ')
  })

  it('mentions a cross-workspace address unchanged', () => {
    expect(buildMentionInsert('ask ', 'other-repo/claude-2')).toBe('@other-repo/claude-2 ')
  })

  it('falls back to a bare mention when the prompt could not be read', () => {
    expect(buildMentionInsert(undefined, 'codex-1')).toBe('@codex-1 ')
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


// The @-mention menu grew from a one-shot name list into a searchable picker.
// These are the rules the imperative overlay leans on — kept pure so the
// filtering, ordering and PTY payload stay testable without a terminal.

const cand = (address: string, group?: string, status?: string): MentionCandidate =>
  ({ address, group, status })

describe('filterMentionCandidates', () => {
  const all = [cand('all'), cand('claude-1'), cand('codex-2'), cand('myproj/codex-1')]

  it('returns everything for an empty query', () => {
    expect(filterMentionCandidates(all, '').map((c) => c.address))
      .toEqual(['all', 'claude-1', 'codex-2', 'myproj/codex-1'])
  })

  it('matches anywhere in the address, not just the start', () => {
    // "myproj/codex-1" must answer to "cod" — the folder prefix would otherwise
    // hide every cross-workspace pane from a search for its agent.
    expect(filterMentionCandidates(all, 'cod').map((c) => c.address))
      .toEqual(['codex-2', 'myproj/codex-1'])
  })

  it('matches the workspace prefix too', () => {
    expect(filterMentionCandidates(all, 'myproj').map((c) => c.address))
      .toEqual(['myproj/codex-1'])
  })

  it('ignores case in both directions', () => {
    expect(filterMentionCandidates(all, 'CODEX').map((c) => c.address))
      .toEqual(['codex-2', 'myproj/codex-1'])
    expect(filterMentionCandidates([cand('Claude-1')], 'claude').map((c) => c.address))
      .toEqual(['Claude-1'])
  })

  it('returns nothing when the query matches nothing — the menu closes on this', () => {
    expect(filterMentionCandidates(all, 'zzz')).toEqual([])
  })

  it('folds full-width characters so a CJK input method still finds ASCII names', () => {
    expect(filterMentionCandidates(all, 'ＣＯＤ').map((c) => c.address))
      .toEqual(filterMentionCandidates(all, 'cod').map((c) => c.address))
  })

  it('matches a CJK address by its own characters', () => {
    expect(filterMentionCandidates([cand('測試-1'), cand('codex-1')], '測').map((c) => c.address))
      .toEqual(['測試-1'])
  })

  it('copies rather than aliasing the input array', () => {
    const out = filterMentionCandidates(all, '')
    expect(out).not.toBe(all)
  })
})

describe('clusterMentionCandidates', () => {
  const c = (address: string, group: string): MentionCandidate => ({ address, group })

  it('makes every group contiguous, in first-seen order', () => {
    const out = clusterMentionCandidates([c('a', 'proj'), c('b', 'lib'), c('c', 'proj'), c('d', 'lib')])
    expect(out.map((x) => x.address)).toEqual(['a', 'c', 'b', 'd'])
  })

  it('leads with the sender own workspace even when it is not first', () => {
    const out = clusterMentionCandidates([c('a', 'lib'), c('b', 'proj'), c('c', 'lib')], 'proj')
    expect(out.map((x) => x.address)).toEqual(['b', 'a', 'c'])
  })

  it('keeps candidates that have no group together, without inventing one', () => {
    const out = clusterMentionCandidates([{ address: 'x' }, c('a', 'proj'), { address: 'y' }])
    expect(out.map((x) => x.address)).toEqual(['x', 'y', 'a'])
    expect(out[0].group).toBeUndefined()
  })
})

describe('rankMentionCandidates', () => {
  const all = [cand('all', 'local'), cand('claude-1', 'local'), cand('codex-2', 'local'), cand('proj/x-1', 'remote')]

  it('hoists recents in recents order, newest first', () => {
    const out = rankMentionCandidates(all, ['codex-2', 'proj/x-1'], 'Recent')
    expect(out.map((c) => c.address)).toEqual(['codex-2', 'proj/x-1', 'all', 'claude-1'])
  })

  it('re-groups a hoisted candidate so it sits under the recents header', () => {
    // Without this the row would be lifted to the top while still labelled
    // "this window", landing under whatever header happened to be drawn first.
    const out = rankMentionCandidates(all, ['proj/x-1'], 'Recent')
    expect(out[0]).toMatchObject({ address: 'proj/x-1', group: 'Recent' })
    expect(out.find((c) => c.address === 'claude-1')?.group).toBe('local')
  })

  it('ignores recents that are no longer offered (pane closed)', () => {
    const out = rankMentionCandidates(all, ['gone-9', 'codex-2'], 'Recent')
    expect(out.map((c) => c.address)).toEqual(['codex-2', 'all', 'claude-1', 'proj/x-1'])
  })

  it('never duplicates a candidate listed twice in recents', () => {
    const out = rankMentionCandidates(all, ['codex-2', 'codex-2'], 'Recent')
    expect(out.filter((c) => c.address === 'codex-2')).toHaveLength(1)
  })

  it('is a plain copy when there are no recents', () => {
    expect(rankMentionCandidates(all, [], 'Recent').map((c) => c.address))
      .toEqual(['all', 'claude-1', 'codex-2', 'proj/x-1'])
  })

  it('does not mutate the candidates it was given', () => {
    const input = [cand('a', 'local')]
    rankMentionCandidates(input, ['a'], 'Recent')
    expect(input[0].group).toBe('local')
  })
})

describe('recordMentionRecents', () => {
  it('puts the newest pick first', () => {
    expect(recordMentionRecents(['b'], ['a'], 12)).toEqual(['a', 'b'])
  })

  it('keeps a multi-pick in insertion order, first-picked ending up first', () => {
    // Picking "a b" means a was ticked before b, so a is the more recent
    // intent to preserve at the front of the list.
    expect(recordMentionRecents([], ['a', 'b'], 12)).toEqual(['a', 'b'])
  })

  it('promotes an address that was already in the list rather than duplicating it', () => {
    expect(recordMentionRecents(['a', 'b', 'c'], ['c'], 12)).toEqual(['c', 'a', 'b'])
  })

  it('caps the list', () => {
    expect(recordMentionRecents(['b', 'c', 'd'], ['a'], 2)).toEqual(['a', 'b'])
  })

  it('leaves the list alone when nothing was picked', () => {
    expect(recordMentionRecents(['a', 'b'], [], 12)).toEqual(['a', 'b'])
  })
})

describe('buildMentionPickData', () => {
  it('erases the typed query and inserts the address, in one write', () => {
    // The user typed "@cod"; the three DEL bytes take "cod" back before the
    // full name lands, so the prompt reads "@codex-1 " and never "@codcodex-1".
    expect(buildMentionPickData('cod', ['codex-1'])).toBe('\x7f\x7f\x7fcodex-1 ')
  })

  it('erases one character per code point, not per UTF-16 unit', () => {
    expect(buildMentionPickData('測試', ['codex-1'])).toBe('\x7f\x7fcodex-1 ')
    expect(buildMentionPickData('😀', ['codex-1'])).toBe('\x7fcodex-1 ')
  })

  it('sends just the address when nothing was typed', () => {
    expect(buildMentionPickData('', ['codex-1'])).toBe('codex-1 ')
  })

  it('space-separates a multi-pick and still ends with one space', () => {
    expect(buildMentionPickData('', ['a', 'b'])).toBe('a b ')
  })

  it('writes nothing when there is nothing to insert', () => {
    // Guards the empty-list case: erasing the query without inserting anything
    // would silently eat what the user typed.
    expect(buildMentionPickData('cod', [])).toBe('')
  })
})

describe('applyMentionPickToInput', () => {
  it('replaces the typed query with the address in the draft buffer', () => {
    // This buffer decides whether the pane counts as "being typed at", and the
    // menu writes to the PTY through a path term.onData never sees — so it has
    // to keep the buffer honest itself.
    expect(applyMentionPickToInput('傳給 @cod', 'cod', ['codex-1'])).toBe('傳給 @codex-1 ')
  })

  it('appends when nothing was typed', () => {
    expect(applyMentionPickToInput('傳給 @', '', ['codex-1'])).toBe('傳給 @codex-1 ')
  })

  it('leaves the buffer untouched when nothing was picked', () => {
    expect(applyMentionPickToInput('傳給 @cod', 'cod', [])).toBe('傳給 @cod')
  })

  it('agrees with buildMentionPickData on what lands after the "@"', () => {
    const query = 'cl'
    const picked = ['claude-1', 'codex-2']
    const wire = buildMentionPickData(query, picked)
    const buffer = applyMentionPickToInput(`@${query}`, query, picked)
    // Strip the DELs from the wire form and it must equal what the buffer kept
    // after the "@" — the two spellings drifting apart is the bug this catches.
    expect(buffer).toBe('@' + wire.replace(/\x7f/g, ''))
  })
})

describe('MENTION_BROADCAST_ADDRESS', () => {
  it('is the keyword App.vue offers and the menu treats as exclusive', () => {
    expect(MENTION_BROADCAST_ADDRESS).toBe('all')
  })
})
