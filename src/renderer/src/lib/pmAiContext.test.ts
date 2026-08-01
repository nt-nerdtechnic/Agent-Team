import { describe, it, expect } from 'vitest'
import {
  buildPmAiContext,
  bracketedPaste,
  resolvePmAiCommand,
  KICKOFF_TRUNCATE_AT,
} from './pmAiContext'

const roles = [
  { key: 'pm', label: 'Product Manager', oneLine: 'writes specs' },
  { key: 'dev', label: 'Developer', oneLine: '' },
]

describe('buildPmAiContext', () => {
  it('detail view: includes pipeline name and stages JSON, no pipeline list', () => {
    const stages = [
      { id: '01', title: 'Plan', slots: [{ agent_key: 'claude', role_key: 'pm' }] },
    ]
    const text = buildPmAiContext({
      workspacePath: '/tmp/ws',
      pipelineName: 'My Pipeline',
      stages,
      pipelines: [{ name: 'My Pipeline', stageCount: 1, isDefault: true }],
      roles,
    })
    expect(text).toContain('Pipeline Manager window')
    expect(text).toContain('Workspace: /tmp/ws')
    expect(text).toContain('Currently open pipeline: "My Pipeline"')
    expect(text).toContain(JSON.stringify(stages, null, 2))
    // The list-view snapshot is not repeated in detail view.
    expect(text).not.toContain('Pipelines:')
  })

  it('list view: summarizes pipelines with stage counts and default marker', () => {
    const text = buildPmAiContext({
      workspacePath: '/tmp/ws',
      pipelineName: null,
      stages: [],
      pipelines: [
        { name: 'Default', stageCount: 5, isDefault: true },
        { name: 'Solo', stageCount: 1, isDefault: false },
      ],
      roles,
    })
    expect(text).toContain('Pipelines:')
    expect(text).toContain('- Default (5 stages) [default]')
    expect(text).toContain('- Solo (1 stage)')
    expect(text).not.toContain('Currently open pipeline')
  })

  it('roles: lists key/label/one-line, omits empty one-line dash', () => {
    const text = buildPmAiContext({
      workspacePath: '/tmp/ws',
      pipelineName: null,
      stages: [],
      pipelines: [],
      roles,
    })
    expect(text).toContain('- pm: Product Manager — writes specs')
    expect(text).toContain('- dev: Developer')
    expect(text).not.toContain('- dev: Developer —')
    expect(text).toContain('system prompts omitted')
  })

  it('truncates long slot kickoff_body values in the stages JSON', () => {
    const longBody = 'x'.repeat(KICKOFF_TRUNCATE_AT + 100)
    const shortBody = 'do the thing'
    const text = buildPmAiContext({
      workspacePath: '/tmp/ws',
      pipelineName: 'P',
      stages: [
        {
          id: '01',
          slots: [
            { agent_key: 'claude', kickoff_body: longBody },
            { agent_key: 'codex', kickoff_body: shortBody },
          ],
        },
      ],
      pipelines: [],
      roles: [],
    })
    expect(text).not.toContain(longBody)
    expect(text).toContain('x'.repeat(KICKOFF_TRUNCATE_AT) + '…[truncated]')
    expect(text).toContain(shortBody)
  })

  it('empty pipelines and roles render (none) placeholders', () => {
    const text = buildPmAiContext({
      workspacePath: '/tmp/ws',
      pipelineName: null,
      stages: [],
      pipelines: [],
      roles: [],
    })
    expect(text.match(/\(none\)/g)).toHaveLength(2)
  })
})

describe('bracketedPaste', () => {
  it('wraps text in the bracketed-paste envelope', () => {
    expect(bracketedPaste('hello')).toBe('\x1b[200~hello\x1b[201~')
  })
})

describe('resolvePmAiCommand', () => {
  const base = { paneId: 'aa1de001-pm-ai-terminal', historyRoot: '/tmp/ws' }

  it('defaults YOLO to ON when the setting is unset (null)', () => {
    expect(resolvePmAiCommand({ ...base, agentKey: 'claude', yoloStored: null }))
      .toBe('claude --dangerously-skip-permissions')
  })

  it('honors an explicit YOLO on (stored "1")', () => {
    expect(resolvePmAiCommand({ ...base, agentKey: 'claude', yoloStored: '1' }))
      .toBe('claude --dangerously-skip-permissions')
  })

  it('omits the skip-permission flag when YOLO is off (stored "0")', () => {
    expect(resolvePmAiCommand({ ...base, agentKey: 'claude', yoloStored: '0' }))
      .toBe('claude')
  })

  it('agents without a skipPermissionFlag get the bare default command', () => {
    expect(resolvePmAiCommand({ ...base, agentKey: 'grok', yoloStored: null })).toBe('grok')
  })

  it('uses the spec default command, not the agent key (no binary override)', () => {
    expect(resolvePmAiCommand({ ...base, agentKey: 'cursor', yoloStored: '0' }))
      .toBe('cursor-agent')
  })

  it('aider gets its per-pane chat-history file from the hex pane-id prefix', () => {
    const cmd = resolvePmAiCommand({ ...base, agentKey: 'aider', yoloStored: null })
    expect(cmd).toContain('aider')
    expect(cmd).toContain('--chat-history-file')
    // paneId.slice(0, 8) = 'aa1de001' — a backend-claimable 8-hex token, so
    // this pane does NOT fall back to the shared .aider.chat.history.md.
    expect(cmd).toContain('/tmp/ws/.aider.chat.history.aa1de001.md')
    expect(cmd).toContain('--yes-always')
  })
})
