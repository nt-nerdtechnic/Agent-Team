// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

// A stage advances only at N/N. Every way a slot can stop being able to report
// has to shrink N, or the stage waits forever with no watcher left to notice —
// its pane's watcher was cancelled along with the pane, so not even the 60min
// cap fires. The arithmetic itself is unit-tested in
// lib/__tests__/stageTracker.test.ts; what has to be asserted against the
// source is the wiring, because App.vue cannot be mounted in this suite.
const appSource = readFileSync(resolve(process.cwd(), 'src/renderer/src/App.vue'), 'utf8')

function body(startMarker: string, endMarker: string): string {
  const start = appSource.indexOf(startMarker)
  expect(start, `missing: ${startMarker}`).toBeGreaterThan(-1)
  const end = appSource.indexOf(endMarker, start)
  expect(end, `missing: ${endMarker}`).toBeGreaterThan(start)
  return appSource.slice(start, end)
}

describe('stage slot accounting is the shared tracker, not inline arithmetic', () => {
  it('registers, counts and releases through lib/stageTracker', () => {
    expect(appSource).toContain("from './lib/stageTracker'")
    // No hand-rolled tracker literal left behind — that is how the release path
    // gets bypassed again.
    expect(appSource).not.toContain('done: new Set() })')
    expect(appSource).toContain('registerStage(stageCompletions, index, stage.slots.length)')
    expect(appSource).toContain('completeSlot(stageCompletions, stageIndex, paneId)')
    expect(appSource).toContain('releaseSlot(stageCompletions, stageIndex, slotKey)')
  })

  it('never mutates the done set outside the tracker', () => {
    expect(appSource).not.toContain('tracker.done.add')
  })

  it('a release that empties the stage stops the run instead of advancing blind', () => {
    const fn = body('function releaseStageSlot(', '\nfunction startStageWatcher(')
    // expected === 0 means every slot went away with none finished: advancing
    // would hand the next stage nothing.
    expect(fn).toContain('outcome.expected === 0')
    expect(fn).toContain("pipeline.state = 'aborted'")
    // Whereas a stage whose remaining slots all finished still advances.
    expect(fn).toContain('onPipelineNext()')
    // Only the running stage decides; a pre-spawned future stage just recounts.
    expect(fn).toContain("pipeline.state !== 'running' || stageIndex !== pipeline.stageIndex")
  })
})

describe('closing a pipeline pane releases its slot', () => {
  const fn = body('async function onKill(', '\n/** Recover a render-corrupted pane')

  // The guard that actually wraps the release, not "somewhere in onKill".
  // onKill has an unrelated `pane?.origin === 'pipeline'` check further up (the
  // slot_unspawn write) and an unrelated `if (!keepInList) {` (the list filter),
  // so whole-function toContain() assertions here passed with no release guard
  // at all — they were reading those.
  const releaseGuard = (() => {
    const at = fn.indexOf('releaseStageSlot(stageIndex, paneId')
    expect(at, 'onKill must release the slot').toBeGreaterThan(-1)
    const from = fn.lastIndexOf('if (', at)
    expect(from).toBeGreaterThan(-1)
    return fn.slice(from, at)
  })()

  it('releases the slot when the pane is really gone', () => {
    expect(fn).toContain('releaseStageSlot(stageIndex, paneId')
    // Only for a pane that was a slot in the first place.
    expect(releaseGuard).toContain('stageIndex >= 0')
  })

  it('uses positive origin matching, so an mcp-spawned pane is not treated as a slot', () => {
    // origin has three values (manual / mcp / pipeline), so "not manual" would
    // release a slot for an mcp-spawned pane that never had one.
    expect(releaseGuard).toContain("pane?.origin === 'pipeline'")
    expect(releaseGuard).not.toContain("!== 'manual'")
  })

  it('does not release a rebuild or an idle-reclaim, which keep the seat', () => {
    expect(releaseGuard).toContain('!keepInList')
  })

  it('does not release a cold placeholder, which activateStage re-spawns', () => {
    // placeholder = present in panes.value but realized === false; pane-exists
    // is not enough.
    expect(releaseGuard).toContain('pane.realized')
  })

  it('releases only after the pane has left the list', () => {
    const releaseAt = fn.indexOf('releaseStageSlot(')
    const removeAt = fn.indexOf('panes.value = panes.value.filter((p) => p.id !== paneId)')
    expect(removeAt).toBeGreaterThan(-1)
    expect(releaseAt).toBeGreaterThan(removeAt)
  })
})

describe('closing a run-group tab ends the run it belonged to', () => {
  const fn = body('async function closeRunGroup(', '\nasync function deleteRunGroup(')

  it('aborts a running pipeline before killing its panes', () => {
    expect(fn).toContain("pipeline.state === 'running'")
    expect(fn).toContain("affected.some((p) => p.origin === 'pipeline')")
    expect(fn).toContain('await onPipelineAbort()')
    const abortAt = fn.indexOf('onPipelineAbort()')
    const killAt = fn.indexOf('await onKill(p.id)')
    expect(killAt).toBeGreaterThan(abortAt)
  })
})

describe('closing a workspace ends the run its panes belonged to', () => {
  const fn = body('async function closeWorkspace(', '\n/** Drag one workspace heading onto another')

  it('stops the orchestration before killing its panes', () => {
    // Every onKill below releases that pane's stage slot. A stage whose other
    // slots already finished then reads N/N and advances — activateStage
    // spawning the NEXT stage's panes into the workspace being torn down.
    // closeRunGroup and closeAllSessions both guard; this one did not.
    expect(fn).toContain('tearDownPipelineOrchestration()')
    const abortAt = fn.indexOf('tearDownPipelineOrchestration()')
    const killAt = fn.indexOf('await onKill(pane.id)')
    expect(abortAt).toBeGreaterThan(-1)
    expect(killAt).toBeGreaterThan(abortAt)
  })

  it('asks whether THIS close ends THIS window\'s run, not just "any pipeline pane"', () => {
    // A window holds one run but several workspaces, and abort is a PAUSE that
    // leaves panes alive with origin 'pipeline'. Matching on origin alone tore
    // down a run living in a DIFFERENT workspace. The rule (and the scenario)
    // is behaviour-tested in lib/__tests__/workspaceCloseRun.test.ts; what has
    // to be asserted here is that both paths reach it, normalized — a wiring
    // test cannot reach the guard itself, so it pins the arguments instead.
    expect(fn).toContain('closeEndsTheRun({')
    const call = fn.slice(fn.indexOf('closeEndsTheRun({'), fn.indexOf('tearDownPipelineOrchestration()'))
    expect(call).toContain('state: pipeline.state')
    expect(call).toContain('runWorkspacePath: normWs(pipeline.workspacePath)')
    expect(call).toContain('closingWorkspacePath: normWs(path)')
    expect(call).toContain('doomedOrigins: doomed.map((p) => p.origin)')
    // The identity comparison is the half that was missing, so neither side may
    // be dropped or handed the same expression twice.
    expect(call).not.toContain('runWorkspacePath: normWs(path)')
    expect(appSource).toContain("from './lib/workspaceCloseRun'")
  })

  it('does not take the abort path that would re-adopt the closing workspace', () => {
    // onPipelineAbort ends in onWorkspaceCheck(pipeline.workspacePath), and
    // that sets currentWorkspace to the workspace it inspects — here, the one
    // being closed, moments before it leaves workspaceOrder. closeRunGroup can
    // call it because its workspace stays; this one cannot.
    expect(fn).not.toContain('await onPipelineAbort')
    const abort = body('async function onPipelineAbort(', '\nasync function onPipelineReset(')
    expect(abort).toContain('await onWorkspaceCheck(pipeline.workspacePath)')
    // …and the shared teardown it delegates to is the same one, so the two
    // paths cannot drift apart.
    expect(abort).toContain('tearDownPipelineOrchestration()')
    const teardown = body('function tearDownPipelineOrchestration(', '\nasync function onPipelineAbort(')
    expect(teardown).toContain("pipeline.state = 'aborted'")
    expect(teardown).toContain('cancelAllWatchers()')
    expect(teardown).toContain('stageCompletions.clear()')
    expect(teardown).toContain('disposeStageRouter(k)')
    expect(teardown).toContain('stopGlobalManagerRouter()')
    expect(teardown).not.toContain('onWorkspaceCheck')
  })

  it('the reset path stops the global router too, though it cannot share the helper', () => {
    // onPipelineReset deliberately does not call the shared teardown — that
    // would publish a reactive 'aborted' for the whole of onKillAll before
    // landing on 'idle'. So every line it must keep in step is checked here;
    // the global Manager's 2s interval was the one that had drifted.
    const reset = body('async function onPipelineReset(', '\n// ─────────── Switch / close workspace')
    for (const line of [
      'stopGlobalManagerRouter()',
      'cancelAllWatchers()',
      'stageCompletions.clear()',
      'disposeStageRouter(k)',
    ]) {
      expect(reset, line).toContain(line)
    }
    // …and the slot counts must be gone BEFORE the panes are, or a kill
    // releases a slot, the stage reads N/N and advances on the way out.
    expect(reset.indexOf('await onKillAll(')).toBeGreaterThan(reset.indexOf('stageCompletions.clear()'))
  })

  it('matches origin positively, like the other two teardown paths', () => {
    // "not manual" also catches mcp-spawned panes, which never had a slot.
    expect(fn).not.toContain("!== 'manual'")
  })
})

describe('a pre-spawn that already aborted the run does not then start it', () => {
  it('re-reads the state between pre-spawn and stage 01', () => {
    // When every slot of stage 01 fails to spawn (an agentKey that no longer
    // ships), releaseStageSlot's `expected === 0` branch sets state='aborted'.
    // Falling straight into activateStage(0) re-registered the stage, spawned
    // the same missing agents again, and armed the global router on a dead run.
    const fn = body('async function onPipelineStart(', '\n/** Before firing 🎉')
    const preSpawn = fn.indexOf('preSpawnStage(i)')
    const guard = fn.indexOf("if (pipeline.state !== 'running') return")
    const activate = fn.indexOf('await activateStage(0)')
    expect(preSpawn, 'pre-spawn').toBeGreaterThan(-1)
    expect(activate, 'stage 01 activation').toBeGreaterThan(-1)
    expect(guard, 'state re-check after pre-spawn').toBeGreaterThan(preSpawn)
    expect(activate).toBeGreaterThan(guard)
  })
})

describe('a slot that cannot spawn is dropped from the count', () => {
  it('pre-spawn releases the slot when spawnPane returns no pane', () => {
    const fn = body('async function preSpawnStage(', '\n/** Build cross-stage context')
    expect(fn).toContain('releaseStageSlot(index, `slot:${slot.label}`')
  })

  it('activateStage releases the slot when its fallback spawn returns no pane', () => {
    const fn = body('async function activateStage(', '\nasync function spawnPipelineStage(')
    expect(fn).toContain('releaseStageSlot(index, `slot:${slot.label}`')
  })

  it('every bail-out before startStageWatcher releases the slot first', () => {
    const fn = body('async function activateStage(', '\nasync function spawnPipelineStage(')
    // EACH guard, not "at least one of them somewhere in the function": a
    // whole-function toContain() is satisfied by whichever release happens to
    // come first, so deleting the other two left this green.
    const guard = /if \(!paneAlive\(pane\.id\)\) \{/g
    const blocks: string[] = []
    for (let m = guard.exec(fn); m !== null; m = guard.exec(fn)) {
      blocks.push(fn.slice(m.index, m.index + 200))
    }
    expect(blocks.length).toBeGreaterThanOrEqual(3)
    blocks.forEach((block, i) => {
      expect(block, `paneAlive bail-out #${i + 1}`).toContain('releaseStageSlot(index, pane.id')
    })
    expect(fn).not.toMatch(/if \(!paneAlive\(pane\.id\)\) return/)
    expect(fn).toContain("✕ role '${pane.roleKey}' not found")
    const roleExit = fn.slice(fn.indexOf("✕ role '${pane.roleKey}' not found"))
    expect(roleExit.slice(0, 300)).toContain('releaseStageSlot(index, pane.id')
  })
})

describe('restarting a pipeline clears the previous slot counts', () => {
  it('wipes the tracker before killing the previous attempt', () => {
    const fn = body('async function onPipelineRestart(', '\nasync function onPipelineResume(')
    expect(fn).toContain('stageCompletions.clear()')
    const clearAt = fn.indexOf('stageCompletions.clear()')
    const killAt = fn.indexOf('await onKill(p.id')
    expect(killAt).toBeGreaterThan(clearAt)
  })
})
