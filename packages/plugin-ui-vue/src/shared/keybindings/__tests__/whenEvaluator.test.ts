import { describe, it, expect } from 'vitest'
import { evaluateWhen } from '../whenEvaluator'

describe('evaluateWhen', () => {
  const ctx = { editorTextFocus: true, modalOpen: false, terminalFocus: false }

  it('single truthy identifier', () => {
    expect(evaluateWhen('editorTextFocus', ctx)).toBe(true)
  })

  it('single falsy identifier', () => {
    expect(evaluateWhen('modalOpen', ctx)).toBe(false)
  })

  it('negation of falsy is true', () => {
    expect(evaluateWhen('!modalOpen', ctx)).toBe(true)
  })

  it('negation of truthy is false', () => {
    expect(evaluateWhen('!editorTextFocus', ctx)).toBe(false)
  })

  it('conjunction: both true', () => {
    expect(evaluateWhen('editorTextFocus && !modalOpen', ctx)).toBe(true)
  })

  it('conjunction: one false', () => {
    expect(evaluateWhen('editorTextFocus && modalOpen', ctx)).toBe(false)
  })

  it('three terms all pass', () => {
    expect(evaluateWhen('editorTextFocus && !modalOpen && !terminalFocus', ctx)).toBe(true)
  })

  it('unknown key resolves to false', () => {
    expect(evaluateWhen('unknownContext', ctx)).toBe(false)
  })

  it('empty string returns true', () => {
    expect(evaluateWhen('', ctx)).toBe(true)
  })

  it('disjunction: first branch true', () => {
    expect(evaluateWhen('editorTextFocus || modalOpen', ctx)).toBe(true)
  })

  it('disjunction: second branch true', () => {
    expect(evaluateWhen('modalOpen || editorTextFocus', ctx)).toBe(true)
  })

  it('disjunction: both false gives false', () => {
    expect(evaluateWhen('modalOpen || terminalFocus', ctx)).toBe(false)
  })

  it('disjunction with negation', () => {
    expect(evaluateWhen('!editorTextFocus || !terminalFocus', ctx)).toBe(true)
  })

  it('mixed || and &&: && has higher precedence', () => {
    // (editorTextFocus && !modalOpen) || terminalFocus → true || false → true
    expect(evaluateWhen('editorTextFocus && !modalOpen || terminalFocus', ctx)).toBe(true)
    // (modalOpen && editorTextFocus) || !terminalFocus → false || true → true
    expect(evaluateWhen('modalOpen && editorTextFocus || !terminalFocus', ctx)).toBe(true)
  })
})
