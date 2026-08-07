import { describe, expect, it } from 'vitest'
import {
  aiderChatHistoryFlag,
  aiderHistoryFileName,
  aiderHistoryPath,
  aiderPaneToken,
  resolveAiderHistoryRoot,
  resumeAiderHistoryPath,
} from '../aider-history'
import { AGENT_SPECS } from '../../agents'

const PANE_ID = '4D4A11FE-b08a-46df-9f86-685589531e65'

/** Mirrors App.vue resolveCommand's assembly order for a YOLO spawn. */
function spawnArgv(agentKey: string, historyRoot: string, paneId: string): string {
  const spec = AGENT_SPECS.find((s) => s.agentKey === agentKey)!
  const parts = [spec.defaultCommand]
  if (spec.paneArg) parts.push(spec.paneArg({ paneId, historyRoot }))
  if (spec.skipPermissionFlag) parts.push(spec.skipPermissionFlag)
  return parts.join(' ')
}

describe('aider per-pane history file', () => {
  it('names the file after the first 8 chars of the pane UUID, lowercased', () => {
    expect(aiderPaneToken(PANE_ID)).toBe('4d4a11fe')
    expect(aiderHistoryFileName(PANE_ID)).toBe('.aider.chat.history.4d4a11fe.md')
  })

  it('builds an absolute path at the history root (trailing slash tolerated)', () => {
    expect(aiderHistoryPath('/repo', PANE_ID)).toBe('/repo/.aider.chat.history.4d4a11fe.md')
    expect(aiderHistoryPath('/repo/', PANE_ID)).toBe('/repo/.aider.chat.history.4d4a11fe.md')
  })

  it('shell-quotes the path — workspace paths contain spaces', () => {
    expect(aiderChatHistoryFlag('/Users/me/My Projects/agent team/.aider.chat.history.4d4a11fe.md'))
      .toBe("--chat-history-file '/Users/me/My Projects/agent team/.aider.chat.history.4d4a11fe.md'")
  })

  it("escapes an apostrophe in the path so the zsh -lc command can't break out", () => {
    expect(aiderChatHistoryFlag("/tmp/o'brien/.aider.chat.history.4d4a11fe.md"))
      .toBe("--chat-history-file '/tmp/o'\\''brien/.aider.chat.history.4d4a11fe.md'")
  })
})

// The backend claims only `.aider.chat.history.<8 hex>.md`; any other token
// names a file it never watches or parses, so accounting would silently read
// zero. Degrade to the shared file exactly like the backend does.
describe('a pane id that yields no backend-claimable token', () => {
  const NON_HEX = 'pane-XY12abcd-b08a-46df-9f86-685589531e65'

  it('produces no per-pane token and no per-pane file name', () => {
    expect(aiderPaneToken(NON_HEX)).toBe('')
    expect(aiderHistoryFileName(NON_HEX)).toBe('')
  })

  it('falls back to the legacy shared path (spawn path)', () => {
    expect(aiderHistoryPath('/repo', NON_HEX)).toBe('/repo/.aider.chat.history.md')
    expect(spawnArgv('aider', '/repo', NON_HEX))
      .toBe("aider --chat-history-file '/repo/.aider.chat.history.md' --yes-always")
    expect(spawnArgv('aider', '/repo', NON_HEX)).not.toMatch(/\.aider\.chat\.history\.[^']*XY/)
  })

  it('falls back to the legacy shared path (resume path), whatever the root holds', () => {
    for (const entries of [[], ['.git'], ['.git', '.aider.chat.history.md']]) {
      expect(resumeAiderHistoryPath('/repo', NON_HEX, entries))
        .toBe('/repo/.aider.chat.history.md')
    }
  })

  it('rejects a too-short id and non-hex hex-lookalikes', () => {
    expect(aiderPaneToken('4d4a11f')).toBe('')      // only 7 chars
    expect(aiderPaneToken('4d4a11fg-0000')).toBe('') // 'g' is not hex
    expect(aiderPaneToken('')).toBe('')
  })
})

describe('resolveAiderHistoryRoot', () => {
  /** Fake filesystem: dir → entry names. Unlisted dirs return null. */
  const lister = (tree: Record<string, string[]>) => async (dir: string) => tree[dir] ?? null

  it('returns the cwd itself when it holds the .git entry', async () => {
    expect(await resolveAiderHistoryRoot('/repo', lister({ '/repo': ['.git', 'src'] })))
      .toEqual({ root: '/repo', entries: ['.git', 'src'] })
  })

  it('walks up to the nearest ancestor holding .git and returns THAT dir’s entries', async () => {
    expect(
      await resolveAiderHistoryRoot('/repo/packages/web', lister({
        '/repo/packages/web': ['src'],
        '/repo/packages': ['web'],
        '/repo': ['.git', '.aider.chat.history.md'],
      }))
    ).toEqual({ root: '/repo', entries: ['.git', '.aider.chat.history.md'] })
  })

  it('falls back to the pane cwd (and its entries) when no ancestor has a .git entry', async () => {
    expect(await resolveAiderHistoryRoot('/no/git/here', lister({ '/no/git/here': ['notes.txt'] })))
      .toEqual({ root: '/no/git/here', entries: ['notes.txt'] })
  })

  it('handles a spaced path and a trailing slash', async () => {
    const root = '/Users/me/My Projects/agent team'
    expect(
      await resolveAiderHistoryRoot(`${root}/src/`, lister({ [`${root}/src`]: [], [root]: ['.git'] }))
    ).toEqual({ root, entries: ['.git'] })
  })

  it('survives an unlistable directory', async () => {
    expect(await resolveAiderHistoryRoot('/locked', lister({})))
      .toEqual({ root: '/locked', entries: [] })
  })
})

describe('resumeAiderHistoryPath', () => {
  const own = '.aider.chat.history.4d4a11fe.md'
  const shared = '.aider.chat.history.md'

  it('uses the per-pane file when it exists', () => {
    expect(resumeAiderHistoryPath('/repo', PANE_ID, ['.git', own, shared]))
      .toBe(`/repo/${own}`)
  })

  it('falls back to the legacy shared file for a pre-upgrade pane', () => {
    // No file of its own + a shared file present: all of this pane's history
    // lives in the shared file — pointing it elsewhere would strand it.
    expect(resumeAiderHistoryPath('/repo', PANE_ID, ['.git', shared]))
      .toBe(`/repo/${shared}`)
  })

  it('uses the per-pane file when neither exists (fresh pane, fresh repo)', () => {
    expect(resumeAiderHistoryPath('/repo', PANE_ID, ['.git']))
      .toBe(`/repo/${own}`)
  })

  it('never hands one pane another pane’s per-pane file', () => {
    expect(resumeAiderHistoryPath('/repo', PANE_ID, ['.git', '.aider.chat.history.a1b2c3d4.md']))
      .toBe(`/repo/${own}`)
  })

  it('quotes cleanly through the resume command builder for a spaced root', () => {
    const root = '/Users/me/My Projects/agent team'
    expect(resumeAiderHistoryPath(root, PANE_ID, ['.git', shared])).toBe(`${root}/${shared}`)
  })
})

describe('aider spawn argv', () => {
  it('puts --chat-history-file between the binary and --yes-always', () => {
    expect(spawnArgv('aider', '/repo', PANE_ID)).toBe(
      "aider --chat-history-file '/repo/.aider.chat.history.4d4a11fe.md' --yes-always"
    )
  })

  it('quotes a spaced workspace path', () => {
    expect(spawnArgv('aider', '/Users/me/My Projects/agent team', PANE_ID)).toBe(
      "aider --chat-history-file '/Users/me/My Projects/agent team/.aider.chat.history.4d4a11fe.md'"
      + ' --yes-always'
    )
  })

  it('gives two panes in one repo different history files', () => {
    const a = spawnArgv('aider', '/repo', '4d4a11fe-0000-0000-0000-000000000000')
    const b = spawnArgv('aider', '/repo', 'a1b2c3d4-0000-0000-0000-000000000000')
    expect(a).not.toBe(b)
  })

  it('leaves every other agent spec without a per-pane argument', () => {
    const withPaneArg = AGENT_SPECS.filter((s) => s.paneArg).map((s) => s.agentKey)
    expect(withPaneArg).toEqual(['aider'])
  })
})
