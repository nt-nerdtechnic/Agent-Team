// buildResumeCommand × cliModel, exercised against vendor specs that actually
// declare the model/effort hooks.
//
// resume-command.test.ts runs against the real registry, where every spec is a
// moving target: a vendor gaining or losing a flag would silently change what
// those tests exercise. This file mocks the registry instead, so each shape of
// the contract — the flag reaching argv, the order it lands in, and a refusal
// degrading per field rather than costing the pane its model — is pinned to a
// spec that cannot drift.
import { describe, expect, it, vi } from 'vitest'

vi.mock('../agents', () => ({
  AGENT_SPECS: [
    {
      agentKey: 'modelcli',
      label: 'ModelCLI',
      defaultCommand: 'modelcli',
      resumeArgs: (id: string) => `--resume ${id}`,
      modelArgs: (model: string) => `--model ${model}`,
      effortArgs: (effort: string) => `--effort ${effort}`,
      knownEfforts: ['low', 'high'] as const,
    },
    {
      // No modelArgs / effortArgs: this vendor cannot be told which model to run.
      agentKey: 'plaincli',
      label: 'PlainCLI',
      defaultCommand: 'plaincli',
      resumeArgs: (id: string) => `--resume ${id}`,
    },
    {
      // Effort but no model — the combination the type system permits and no
      // shipped vendor uses, which is exactly where per-field degradation has
      // to be proven.
      agentKey: 'effortcli',
      label: 'EffortCLI',
      defaultCommand: 'effortcli',
      resumeArgs: (id: string) => `--resume ${id}`,
      effortArgs: (effort: string) => `--effort ${effort}`,
      knownEfforts: ['low', 'high'] as const,
    },
    {
      // aider's shape: no session ids at all, resume args come from the spec.
      agentKey: 'idlesscli',
      label: 'IdlessCLI',
      defaultCommand: 'idlesscli',
      resumeWithoutId: () => '--restore-chat-history',
      modelArgs: (model: string) => `--model ${model}`,
    },
  ],
  REBUILD_CAPABLE_AGENTS: ['modelcli', 'plaincli', 'effortcli', 'idlesscli'],
  RESTORE_PIN_AGENTS: [],
}))

const { buildResumeCommand } = await import('./resume-command')

describe('buildResumeCommand model/effort flags', () => {
  it('is byte-for-byte unchanged when no model is requested', () => {
    // The regression that matters most: every existing caller passes four
    // arguments and must keep producing exactly what it produced before.
    expect(buildResumeCommand('modelcli', 'abc')).toBe('modelcli --resume abc')
    expect(buildResumeCommand('modelcli', 'abc', '--yolo')).toBe('modelcli --resume abc --yolo')
    expect(buildResumeCommand('modelcli', 'abc', '', '', { model: '', effort: '' }))
      .toBe('modelcli --resume abc')
  })

  it('rebuilds the model flag into the resumed command', () => {
    expect(buildResumeCommand('modelcli', 'abc', '', '', { model: 'opus-9', effort: '' }))
      .toBe('modelcli --resume abc --model opus-9')
  })

  it('puts the permission flag before the model flag', () => {
    // Same order resolveCommand uses for a fresh spawn, so a pane's argv does
    // not reshuffle when it is resumed.
    expect(buildResumeCommand('modelcli', 'abc', '--yolo', '', { model: 'opus-9', effort: '' }))
      .toBe('modelcli --resume abc --yolo --model opus-9')
  })

  it('emits the effort flag, and model before effort', () => {
    expect(buildResumeCommand('modelcli', 'abc', '', '', { model: '', effort: 'high' }))
      .toBe('modelcli --resume abc --effort high')
    expect(buildResumeCommand('modelcli', 'abc', '', '', { model: 'opus-9', effort: 'low' }))
      .toBe('modelcli --resume abc --model opus-9 --effort low')
  })

  it('reopens on the vendor default when the vendor cannot take a model', () => {
    // A refusal must not cost the user the pane: losing the conversation is
    // worse than losing a model preference whose vendor support is gone.
    expect(buildResumeCommand('plaincli', 'abc', '', '', { model: 'opus-9', effort: 'high' }))
      .toBe('plaincli --resume abc')
  })

  it('drops an unacceptable effort but KEEPS the model', () => {
    // Per-field degradation. Resolving both together would make a retired
    // effort level cost the pane its model too, reopening it on the vendor
    // default — a much larger surprise than losing the effort.
    expect(buildResumeCommand('modelcli', 'abc', '', '', { model: 'opus-9', effort: 'ultra' }))
      .toBe('modelcli --resume abc --model opus-9')
  })

  it('drops an unsupported model but KEEPS an acceptable effort', () => {
    expect(buildResumeCommand('effortcli', 'abc', '', '', { model: 'opus-9', effort: 'high' }))
      .toBe('effortcli --resume abc --effort high')
  })

  it('applies the model flag on the id-less resume path too', () => {
    expect(buildResumeCommand('idlesscli', '', '', '', { model: 'opus-9', effort: '' }))
      .toBe('idlesscli --restore-chat-history --model opus-9')
    expect(buildResumeCommand('idlesscli', '', '--yolo', '', { model: 'opus-9', effort: '' }))
      .toBe('idlesscli --restore-chat-history --yolo --model opus-9')
  })

  it('still refuses a resume with no session id, model or not', () => {
    expect(buildResumeCommand('modelcli', '', '', '', { model: 'opus-9', effort: 'high' })).toBe('')
  })
})
