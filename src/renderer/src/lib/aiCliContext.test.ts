import { describe, it, expect } from 'vitest'
import {
  aiTerminalPaneId,
  bracketedPaste,
  buildPlanCliContext,
  PLAN_DOC_TRUNCATE_AT,
  resolveCliCommand,
  truncateText,
} from './aiCliContext'

describe('aiTerminalPaneId', () => {
  it('is stable for the same surface + workspace', () => {
    expect(aiTerminalPaneId('pm', '/tmp/ws')).toBe(aiTerminalPaneId('pm', '/tmp/ws'))
  })

  it('differs across workspaces (two windows of one surface never share a PTY key)', () => {
    expect(aiTerminalPaneId('plan', '/tmp/ws-a')).not.toBe(aiTerminalPaneId('plan', '/tmp/ws-b'))
  })

  it('differs across surfaces for the same workspace', () => {
    expect(aiTerminalPaneId('pm', '/tmp/ws')).not.toBe(aiTerminalPaneId('git', '/tmp/ws'))
  })

  it('always starts with 8 hex chars (aider paneId.slice(0,8) + backend 8-hex claim)', () => {
    for (const ws of ['/tmp/ws', '', '/Users/x/深度/пуць', '/a'.repeat(200)]) {
      expect(aiTerminalPaneId('plan', ws)).toMatch(/^[0-9a-f]{8}-plan-ai-terminal$/)
    }
  })
})

describe('bracketedPaste', () => {
  it('wraps text in the bracketed-paste envelope', () => {
    expect(bracketedPaste('hello')).toBe('\x1b[200~hello\x1b[201~')
  })
})

describe('truncateText', () => {
  it('returns short text unchanged', () => {
    expect(truncateText('short', 10)).toBe('short')
  })

  it('returns text exactly at the cap unchanged', () => {
    expect(truncateText('x'.repeat(10), 10)).toBe('x'.repeat(10))
  })

  it('truncates long text and marks the cut', () => {
    expect(truncateText('x'.repeat(11), 10)).toBe('x'.repeat(10) + '…[truncated]')
  })
})

describe('resolveCliCommand', () => {
  const base = { paneId: 'aa1de001-pm-ai-terminal', historyRoot: '/tmp/ws' }

  it('defaults YOLO to ON when the setting is unset (null)', () => {
    expect(resolveCliCommand({ ...base, agentKey: 'claude', yoloStored: null }))
      .toBe('claude --dangerously-skip-permissions')
  })

  it('honors an explicit YOLO on (stored "1")', () => {
    expect(resolveCliCommand({ ...base, agentKey: 'claude', yoloStored: '1' }))
      .toBe('claude --dangerously-skip-permissions')
  })

  it('omits the skip-permission flag when YOLO is off (stored "0")', () => {
    expect(resolveCliCommand({ ...base, agentKey: 'claude', yoloStored: '0' }))
      .toBe('claude')
  })

  it('agents without a skipPermissionFlag get the bare default command', () => {
    expect(resolveCliCommand({ ...base, agentKey: 'grok', yoloStored: null })).toBe('grok')
  })

  it('uses the spec default command, not the agent key (no binary override)', () => {
    expect(resolveCliCommand({ ...base, agentKey: 'cursor', yoloStored: '0' }))
      .toBe('cursor-agent')
  })

  it('aider gets its per-pane chat-history file from the hex pane-id prefix', () => {
    const cmd = resolveCliCommand({ ...base, agentKey: 'aider', yoloStored: null })
    expect(cmd).toContain('aider')
    expect(cmd).toContain('--chat-history-file')
    // paneId.slice(0, 8) = 'aa1de001' — a backend-claimable 8-hex token, so
    // this pane does NOT fall back to the shared .aider.chat.history.md.
    expect(cmd).toContain('/tmp/ws/.aider.chat.history.aa1de001.md')
    expect(cmd).toContain('--yes-always')
  })
})

describe('buildPlanCliContext', () => {
  it('open plan doc: includes path, meta summary with todo status counts, and content', () => {
    const text = buildPlanCliContext({
      workspacePath: '/tmp/ws',
      relPath: '.agent-team/plans/refactor.html',
      meta: {
        name: 'Refactor Plan',
        stage: 'in-review',
        todoStatuses: ['done', 'pending', 'pending', 'in-progress'],
      },
      content: '<html>plan body</html>',
    })
    expect(text).toContain("Plan window")
    expect(text).toContain('Workspace: /tmp/ws')
    expect(text).toContain('Currently open document: .agent-team/plans/refactor.html')
    expect(text).toContain('Plan name: Refactor Plan')
    expect(text).toContain('Stage: in-review')
    expect(text).toContain('Todos: 4 total (1 done, 2 pending, 1 in-progress)')
    expect(text).toContain('Document content:')
    expect(text).toContain('<html>plan body</html>')
  })

  it('no document open: says so and stops after the workspace', () => {
    const text = buildPlanCliContext({
      workspacePath: '/tmp/ws',
      relPath: null,
      meta: null,
      content: null,
    })
    expect(text).toContain('No plan document is currently open.')
    expect(text).not.toContain('Currently open document')
    expect(text).not.toContain('Document content')
  })

  it('plain doc without plan meta: path and content but no meta summary', () => {
    const text = buildPlanCliContext({
      workspacePath: '/tmp/ws',
      relPath: '.agent-team/plans/notes.md',
      meta: null,
      content: 'just notes',
    })
    expect(text).toContain('Currently open document: .agent-team/plans/notes.md')
    expect(text).not.toContain('Plan name:')
    expect(text).not.toContain('Todos:')
    expect(text).toContain('just notes')
  })

  it('empty todo list renders a bare total without a breakdown', () => {
    const text = buildPlanCliContext({
      workspacePath: '/tmp/ws',
      relPath: '.agent-team/plans/empty.html',
      meta: { name: 'Empty', stage: 'draft', todoStatuses: [] },
      content: null,
    })
    expect(text).toContain('Todos: 0 total')
    expect(text).not.toContain('0 total (')
  })

  it('truncates long document content and flags the truncation', () => {
    const long = 'y'.repeat(PLAN_DOC_TRUNCATE_AT + 50)
    const text = buildPlanCliContext({
      workspacePath: '/tmp/ws',
      relPath: '.agent-team/plans/long.html',
      meta: null,
      content: long,
    })
    expect(text).toContain('Document content (truncated):')
    expect(text).not.toContain(long)
    expect(text).toContain('y'.repeat(PLAN_DOC_TRUNCATE_AT) + '…[truncated]')
  })
})
