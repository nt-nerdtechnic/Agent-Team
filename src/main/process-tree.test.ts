import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { descendantsFirst, killProcessTree } from './process-tree'

const execFileSync = vi.hoisted(() => vi.fn())
vi.mock('node:child_process', () => ({ execFileSync }))

// The shape the real bug had: Electron's child (4102) is a PyInstaller
// bootloader, the backend that holds the port is 4103, and the PTY children
// hang off that one.
const SNAPSHOT = [
  '    1     0',
  ' 3694     1', // Electron
  ' 4102  3694', // bootloader — the pid Electron's ChildProcess reports
  ' 4103  4102', // the real backend
  ' 4200  4103', // PTY child
  ' 4201  4200', // and its shell
  ' 5000     1' // unrelated process
].join('\n')

describe('descendantsFirst', () => {
  it('returns the whole subtree with children before their parent', () => {
    const order = descendantsFirst(4102, SNAPSHOT)

    expect(new Set(order)).toEqual(new Set([4102, 4103, 4200, 4201]))
    expect(order.indexOf(4201)).toBeLessThan(order.indexOf(4200))
    expect(order.indexOf(4200)).toBeLessThan(order.indexOf(4103))
    expect(order.indexOf(4103)).toBeLessThan(order.indexOf(4102))
  })

  it('leaves processes outside the subtree alone', () => {
    expect(descendantsFirst(4102, SNAPSHOT)).not.toContain(3694)
    expect(descendantsFirst(4102, SNAPSHOT)).not.toContain(5000)
  })

  it('returns just the pid when it has no children', () => {
    expect(descendantsFirst(5000, SNAPSHOT)).toEqual([5000])
  })

  it('ignores unparsable lines instead of dropping the snapshot', () => {
    const noisy = ['ps: some warning', '', ' 4103  4102'].join('\n')
    expect(descendantsFirst(4102, noisy)).toEqual([4103, 4102])
  })

  it('terminates on a snapshot that claims a cycle', () => {
    const cyclic = [' 20  10', ' 10  20'].join('\n')
    expect(descendantsFirst(10, cyclic)).toEqual([20, 10])
  })
})

function spyOnKill() {
  return vi.spyOn(process, 'kill').mockImplementation(() => true)
}

describe('killProcessTree', () => {
  let kill: ReturnType<typeof spyOnKill>

  beforeEach(() => {
    execFileSync.mockReset()
    execFileSync.mockReturnValue(SNAPSHOT)
    kill = spyOnKill()
  })

  afterEach(() => {
    kill.mockRestore()
  })

  it('signals every process in the tree, not just the handle', () => {
    // The whole point: SIGKILL is not forwarded, so 4103 survives a kill aimed
    // at 4102 and keeps holding the port.
    killProcessTree(4102, 'SIGKILL')

    expect(kill.mock.calls.map((c) => c[0])).toEqual([4201, 4200, 4103, 4102])
    expect(kill.mock.calls.every((c) => c[1] === 'SIGKILL')).toBe(true)
  })

  it('carries on when a process died between the snapshot and the signal', () => {
    kill.mockImplementation((pid) => {
      if (pid === 4200) throw new Error('ESRCH')
      return true
    })

    expect(() => killProcessTree(4102, 'SIGKILL')).not.toThrow()
    expect(kill.mock.calls.map((c) => c[0])).toContain(4102)
  })

  it('still kills the pid it was given when no snapshot is available', () => {
    execFileSync.mockImplementation(() => {
      throw new Error('ps timed out')
    })

    killProcessTree(4102, 'SIGKILL')

    expect(kill.mock.calls).toEqual([[4102, 'SIGKILL']])
  })

  it('refuses to signal init or an unspawned child', () => {
    killProcessTree(1, 'SIGKILL')
    killProcessTree(undefined, 'SIGKILL')

    expect(kill).not.toHaveBeenCalled()
    expect(execFileSync).not.toHaveBeenCalled()
  })
})
