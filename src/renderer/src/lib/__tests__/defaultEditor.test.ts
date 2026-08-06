import { describe, it, expect } from 'vitest'
import {
  CUSTOM_COMMAND_PRESETS,
  DEFAULT_EDITOR_ID,
  formatCustomCommand,
  normalizeDefaultEditor,
  parseCustomCommand
} from '../defaultEditor'

describe('normalizeDefaultEditor', () => {
  it('accepts known ids', () => {
    expect(normalizeDefaultEditor('mini-ide')).toBe('mini-ide')
    expect(normalizeDefaultEditor('system')).toBe('system')
    expect(normalizeDefaultEditor('vscode')).toBe('vscode')
    expect(normalizeDefaultEditor('cursor')).toBe('cursor')
  })

  it('trims surrounding whitespace', () => {
    expect(normalizeDefaultEditor('  vscode  ')).toBe('vscode')
  })

  it('falls back for unknown, blank, and non-string values', () => {
    expect(normalizeDefaultEditor('zed')).toBe(DEFAULT_EDITOR_ID)
    expect(normalizeDefaultEditor('')).toBe(DEFAULT_EDITOR_ID)
    expect(normalizeDefaultEditor(undefined)).toBe(DEFAULT_EDITOR_ID)
    expect(normalizeDefaultEditor({ id: 'vscode' })).toBe(DEFAULT_EDITOR_ID)
  })

  it('rejects custom until a command exists', () => {
    expect(normalizeDefaultEditor('custom')).toBe(DEFAULT_EDITOR_ID)
    expect(normalizeDefaultEditor('custom', [])).toBe(DEFAULT_EDITOR_ID)
    expect(normalizeDefaultEditor('custom', ['subl', '{file}'])).toBe('custom')
  })
})

describe('parseCustomCommand', () => {
  it('splits on whitespace', () => {
    expect(parseCustomCommand('code -g {file}:{line}')).toEqual(['code', '-g', '{file}:{line}'])
  })

  it('collapses repeated and surrounding whitespace', () => {
    expect(parseCustomCommand('  code   {file}  ')).toEqual(['code', '{file}'])
  })

  it('groups a quoted argument', () => {
    expect(parseCustomCommand('"/My Apps/code" {file}')).toEqual(['/My Apps/code', '{file}'])
  })

  it('keeps a quoted empty argument', () => {
    expect(parseCustomCommand('code ""')).toEqual(['code', ''])
  })

  it('returns an empty argv for blank input', () => {
    expect(parseCustomCommand('')).toEqual([])
    expect(parseCustomCommand('   ')).toEqual([])
  })
})

describe('formatCustomCommand', () => {
  it('joins plain arguments with spaces', () => {
    expect(formatCustomCommand(['code', '-g', '{file}:{line}'])).toBe('code -g {file}:{line}')
  })

  it('re-quotes arguments containing whitespace', () => {
    expect(formatCustomCommand(['/My Apps/code', '{file}'])).toBe('"/My Apps/code" {file}')
  })

  it('round-trips through parseCustomCommand', () => {
    const argv = ['/My Apps/code', '-g', '{file}:{line}']
    expect(parseCustomCommand(formatCustomCommand(argv))).toEqual(argv)
  })
})

describe('CUSTOM_COMMAND_PRESETS', () => {
  it('every preset parses back to itself', () => {
    for (const preset of CUSTOM_COMMAND_PRESETS) {
      expect(parseCustomCommand(formatCustomCommand(preset.command))).toEqual(preset.command)
    }
  })
})
