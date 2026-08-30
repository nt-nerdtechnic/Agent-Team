import { describe, it, expect } from 'vitest'
import { deriveAutoName } from '../autoName'

describe('deriveAutoName', () => {
  it('returns empty string for empty or whitespace input', () => {
    expect(deriveAutoName('')).toBe('')
    expect(deriveAutoName('   \n\t ')).toBe('')
  })

  it('uses short input verbatim', () => {
    expect(deriveAutoName('Fix the resize bug')).toBe('Fix the resize bug')
  })

  it('strips @mentions and [Context:…] blocks', () => {
    expect(deriveAutoName('@claude fix login [Context: src/auth.ts]')).toBe('fix login')
  })

  it('strips leading markdown markers', () => {
    expect(deriveAutoName('## Summary of changes')).toBe('Summary of changes')
  })

  it('collapses internal whitespace', () => {
    expect(deriveAutoName('fix   the\n\nbug')).toBe('fix the bug')
  })

  it('takes the first clause of long input when clause length fits', () => {
    const material =
      'Refactor the websocket reconnect logic. Then add exponential backoff and jitter so that clients do not stampede the server after a restart.'
    expect(deriveAutoName(material)).toBe('Refactor the websocket reconnect logic')
  })

  it('splits on CJK sentence punctuation', () => {
    const material =
      '修復終端機在拖曳縮放時的重繪問題。之後還要處理 alt-buffer 的 TUI 在切換分頁時沒有跟著重繪的狀況。'
    expect(deriveAutoName(material)).toBe('修復終端機在拖曳縮放時的重繪問題')
  })

  it('strips English filler openers before truncating', () => {
    const material =
      'Can you refactor the entire session persistence layer including the workspace registry, the pane records, and the spawn history mirror'
    const out = deriveAutoName(material)
    expect(out.startsWith('refactor the entire session persistence')).toBe(true)
    expect(out.endsWith('…')).toBe(true)
  })

  it('strips Chinese filler openers before truncating', () => {
    const material =
      '好的，我會先檢查後端的 session 註冊流程再修正編碼不一致的問題並補上對應的回歸測試以及檢查指標輪替，確保跨視窗同步不會再遺失資料'
    const out = deriveAutoName(material)
    // Both '好的，' and '我會' are filler and both come off.
    expect(out.startsWith('先檢查後端的 session 註冊流程')).toBe(true)
    expect(out.includes('好的')).toBe(false)
  })

  it('strips stacked filler openers', () => {
    // Politeness stacks in both languages; one pass would leave the second one.
    expect(deriveAutoName('請幫我修 resize bug')).toBe('修 resize bug')
    expect(deriveAutoName('Can you please fix the resize bug')).toBe('fix the resize bug')
  })

  it('strips filler from short input too', () => {
    expect(deriveAutoName('請看一下 resize bug')).toBe('看一下 resize bug')
    expect(deriveAutoName('Can you fix the resize bug')).toBe('fix the resize bug')
  })

  it('strips filler from the first clause of long input', () => {
    const material =
      'Please refactor the reconnect logic. Then add exponential backoff and jitter so clients do not stampede the server after a restart.'
    expect(deriveAutoName(material)).toBe('refactor the reconnect logic')
  })

  it('keeps the original when stripping filler would empty the title', () => {
    expect(deriveAutoName('請')).toBe('請')
    expect(deriveAutoName('好的，')).toBe('好的，')
  })

  it('caps output at 60 characters', () => {
    const material = 'x'.repeat(300)
    expect(deriveAutoName(material).length).toBeLessThanOrEqual(60)
  })

  it('only reads the first 500 characters of material', () => {
    const material = ' '.repeat(500) + 'late content that should be ignored'
    expect(deriveAutoName(material)).toBe('')
  })
})

describe('a path is not a title', () => {
  // Observed on a real machine: a pane called
  // `/Users/someone/Downloads/查詢醫師背景資料方法.pdf`. Two things wrong with
  // that at once — it reads as noise, and it published someone's home
  // directory and account name to every other machine in the network.
  it('uses the last segment of a bare path', () => {
    expect(deriveAutoName('/Users/nt.neil/Downloads/查詢醫師背景資料方法.pdf')).toBe(
      '查詢醫師背景資料方法.pdf',
    )
    expect(deriveAutoName('~/Desktop/Agent-Team/README.md')).toBe('README.md')
    expect(deriveAutoName('backend/agent_team_backend/app.py')).toBe('app.py')
  })

  it('leaves a sentence that merely mentions a path alone', () => {
    // Only something that is a path and nothing else is treated as one; the
    // slashes in a sentence are made safe by normalizeMessagingName instead.
    const title = deriveAutoName('修 src/main 的 bug')
    expect(title).toContain('bug')
    expect(title).not.toBe('main')
  })
})
