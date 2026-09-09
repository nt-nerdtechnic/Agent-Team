// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

// Manager mode skips startStageWatcher for every pane of the stage, so the idle
// check AND the hard cap that back-stop a normal stage do not run anywhere. The
// stage's only completion signal is the Manager printing ---STAGE-DONE--- into
// its own buffer. Lose the Manager pane and the router polls an empty buffer
// forever with no log line and no prompt. The verdict rule is unit-tested in
// lib/__tests__/managerStageWatchdog.test.ts; the wiring has to be asserted
// against the source, because App.vue cannot be mounted in this suite.
const appSource = readFileSync(resolve(process.cwd(), 'src/renderer/src/App.vue'), 'utf8')

function body(startMarker: string, endMarker: string): string {
  const start = appSource.indexOf(startMarker)
  expect(start, `missing: ${startMarker}`).toBeGreaterThan(-1)
  const end = appSource.indexOf(endMarker, start)
  expect(end, `missing: ${endMarker}`).toBeGreaterThan(start)
  return appSource.slice(start, end)
}

describe('the Manager-mode stage has a watchdog', () => {
  const scan = body('async function managerRouterScan(', '\nfunction queueOrRouteWorkerMsg(')

  it('asks the shared rule on every poll', () => {
    expect(appSource).toContain("from './lib/managerStageWatchdog'")
    expect(scan).toContain('evaluateManagerStage({')
  })

  it('judges the Manager pane by a live terminal, not by pane-exists', () => {
    // A cold placeholder is in panes.value with realized === false and has no
    // paneRefs entry — it cannot print the sentinel.
    const helper = body('function managerPaneAlive(', '\nasync function onPipelineNext(')
    expect(helper).toContain('paneRefs[managerPaneId]')
    expect(helper).toContain('p.realized')
    expect(scan).toContain('managerPaneAlive(router.managerPaneId)')
  })

  it('counts a crashed CLI as gone, not as a live Manager', () => {
    // exit 127 (missing binary) leaves the pane record and its terminal ref in
    // place, so the ref's own status is what says the CLI is dead.
    const helper = body('function managerPaneAlive(', '\nasync function onPipelineNext(')
    expect(helper).toContain("status === 'exited'")
    expect(helper).toContain("status === 'error'")
  })

  it('releases the Manager slot when its pane is gone', () => {
    // Otherwise a Manager-only stage keeps a slot in `expected` that nothing
    // can ever report, and the run sits at state='running' with no panes.
    expect(scan).toContain("releaseStageSlot(stageIndex, router.managerPaneId, 'Manager pane is gone')")
    // If that release already ended the run, the stall prompt would be noise.
    const at = scan.indexOf("releaseStageSlot(stageIndex, router.managerPaneId")
    expect(scan.slice(at, at + 400)).toContain("pipeline.state !== 'running'")
  })

  it('gives the stage a cap of its own, since the watcher that held one is skipped', () => {
    expect(scan).toContain('armedAt: router.armedAt')
    expect(scan).toContain('maxDurationMs: STAGE_MAX_DURATION_MS')
    // The clock starts when the router poll starts — that is the stage's arm.
    const poll = body('function startRouterPoll(', '\nfunction disposeStageRouter(')
    expect(poll).toContain('router.armedAt = Date.now()')
  })

  it('routes a non-ok verdict into the existing stall path, and logs it', () => {
    expect(scan).toContain('promptStageStall(stageIndex, router.managerPaneId')
    expect(scan).toContain('pipelineLog(`Stage ${stage.id} ⚠ ${detail}`)')
    // A timeout is the cap; a missing Manager is reported as the idle stall so
    // the existing two-value prompt keeps working.
    expect(scan).toContain("verdict === 'timeout' ? 'cap' : 'idle'")
  })

  it('raises the stall once per stage rather than every 4s poll', () => {
    // The read in the gate is only half the latch. Without the WRITE the gate
    // is true on every tick and the identical prompt is raised every 4s — and
    // asserting the identifier alone matched the read, so the write could go
    // missing with this test still green.
    const gate = scan.indexOf('!router.watchdogFired && !stageStallPrompt.value')
    const set = scan.indexOf('router.watchdogFired = true')
    expect(gate, 'the gate that reads the latch').toBeGreaterThan(-1)
    expect(set, 'the write that takes it').toBeGreaterThan(gate)
    // Taken for EVERY non-ok verdict, not only inside the manager-gone branch.
    expect(scan.indexOf("if (verdict === 'manager-gone') {")).toBeGreaterThan(set)
  })

  it('does not take the latch when the prompt was dropped as a duplicate', () => {
    // promptStageStall drops a second concurrent prompt; latching on a dropped
    // prompt would lose the stall for good.
    expect(scan).toContain('!router.watchdogFired && !stageStallPrompt.value')
  })

  it('"keep waiting" resets the Manager stage clock', () => {
    // Manager mode has no per-pane watcher for startStageWatcher to restart, so
    // the router carries both the arm time and the latch.
    const cont = body('function continueWaitingStall(', '\n/** User clicked "強制推進"')
    expect(cont).toContain('router.armedAt = Date.now()')
  })

  it('"keep waiting" does NOT re-arm the latch for a Manager that is gone', () => {
    // 'manager-gone' is a standing fact: clearing the latch means the next 4s
    // poll re-reads the same verdict and re-raises the same prompt. Under Full
    // auto that is automatic — its multi-slot branch calls continueWaitingStall
    // — so the stall loops every 4-9s on its own, forever. Only the cap, whose
    // armedAt was just restarted above, deserves a fresh latch.
    const cont = body('function continueWaitingStall(', '\n/** User clicked "強制推進"')
    expect(cont).toContain("if (p.managerVerdict !== 'manager-gone') router.watchdogFired = false")
    // …and no OTHER reset slips past that condition: one unconditional line
    // anywhere in the function restores the loop.
    const resets = cont.split('\n').filter((l) => l.includes('router.watchdogFired = false'))
    expect(resets.length).toBeGreaterThan(0)
    for (const line of resets) {
      expect(line, 'unconditional latch reset').toContain("p.managerVerdict !== 'manager-gone'")
    }
  })
})

describe('the Manager-mode stall buttons act on the stage, not on one slot', () => {
  const force = body('function forceAdvanceStall(', '\n/** Cancel the watcher for a single pane.')

  it('marks the prompt as a stage stall only from the Manager watchdog', () => {
    // The discriminator: if a per-pane watcher stall ever carried a verdict,
    // force-advance would skip that whole stage instead of counting the slot.
    const scan = body('async function managerRouterScan(', '\nfunction queueOrRouteWorkerMsg(')
    expect(scan).toContain("verdict === 'timeout' ? 'cap' : 'idle', detail, verdict)")
    const watcher = body('function startStageWatcher(', '\nfunction handleAnalyzerResult(')
    // The watcher's cap stall keeps the four-argument form — no verdict.
    expect(watcher).toContain("promptStageStall(stageIndex, paneId, 'cap', detail)")
    expect(watcher).not.toContain('managerVerdict')
  })

  it('force-advance on a Manager stall takes the ---STAGE-DONE--- exit', () => {
    // Why the slot path cannot work here: 'manager-gone' released the Manager
    // slot moments earlier, so completeSlot answers 'duplicate' and
    // onStageSlotCompleted returns having done nothing — the dialog closed and
    // the pipeline did not move. And Manager mode arms no per-pane watcher, so
    // the remaining worker slots have no signal source to wait for either.
    expect(force).toContain('if (p.managerVerdict) {')
    const branch = force.slice(
      force.indexOf('if (p.managerVerdict) {'),
      force.indexOf("onStageSlotCompleted(p.stageIndex, p.paneId, 'force')")
    )
    expect(branch).toContain('stageCompletions.delete(p.stageIndex)')
    expect(branch).toContain('void onPipelineNext()')
    // Same double-fire latch the router's own STAGE-DONE branch takes: the poll
    // is still running and would otherwise advance a second time.
    expect(branch).toContain('router.finished = true')
    // Stale prompt (the stage already moved on) must not advance anything —
    // onStageSlotCompleted had that guard, this branch bypasses it.
    expect(branch).toContain('p.stageIndex !== pipeline.stageIndex')
  })

  it('Full auto does not park a gone Manager in a wait nothing can end', () => {
    // The trap the one-shot latch opened: Full auto's grace timer calls
    // continueWaitingStall, the latch then stops the watchdog re-judging, and
    // the run sits at state='running' with no prompt and nobody watching. The
    // rule (including "the slot gate is never even asked") is behaviour-tested
    // in lib/__tests__/managerStageWatchdog.test.ts; this pins that the timer
    // asks it and hands it the verdict.
    const prompt = body('function promptStageStall(', '\n/** User clicked "繼續等待"')
    expect(appSource).toContain('fullAutoStallAction')
    const call = prompt.slice(prompt.indexOf('fullAutoStallAction({'))
    expect(prompt).toContain('fullAutoStallAction({')
    expect(call.slice(0, 300)).toContain('managerVerdict: p.managerVerdict')
    expect(call.slice(0, 300)).toContain('multiSlot')
    // Passed as a thunk, so the branch that must not consult it can decline to.
    expect(call.slice(0, 300)).toContain('slotsFinished: () =>')
    // The old inline branch must be gone, or the verdict is bypassed.
    expect(prompt).not.toContain('if (allSlotsFinished(computeStageSlotSignals(p.stageIndex))) {')
    // …and force-advance must be what a 'force-advance' answer does.
    const decide = prompt.slice(prompt.indexOf("if (action === 'force-advance') {"))
    expect(decide).toContain('forceAdvanceStall()')
    expect(decide.indexOf('forceAdvanceStall()')).toBeLessThan(decide.indexOf('continueWaitingStall()'))
  })

  it('tells the user what the two buttons do in Manager mode, where both differ', () => {
    // The dialog is one hard-coded block; the copy said "強制推進 marks this
    // slot done" and "繼續等待 resets the idle timer", and in Manager mode
    // neither is true — it ends the whole stage, and after a gone Manager the
    // wait resets nothing and is the last prompt the stage raises.
    const hint = appSource.slice(
      appSource.indexOf('<p v-if="stageStallPrompt.managerVerdict'),
      appSource.indexOf('class="stall-auto"')
    )
    expect(hint).toContain("stageStallPrompt.managerVerdict === 'manager-gone'")
    expect(hint).toContain('v-else-if="stageStallPrompt.managerVerdict"')
    expect(hint).toContain('<p v-else class="stall-hint">')
    // The gone-Manager branch has to say both things that changed.
    const gone = hint.slice(0, hint.indexOf('v-else-if'))
    expect(gone).toContain('整個 stage')
    expect(gone).toContain('最後一次提示')
    // The Manager cap branch says the stage-level thing too.
    const capBranch = hint.slice(hint.indexOf('v-else-if'), hint.indexOf('<p v-else '))
    expect(capBranch).toContain('整個 stage')
    expect(capBranch).not.toContain('標為完成')
    // …and only the ordinary watcher stall keeps the slot-level wording.
    expect(hint.slice(hint.indexOf('<p v-else '))).toContain('標為完成')
  })

  it('leaves an ordinary worker-slot force advance exactly as it was', () => {
    // Every non-Manager stage still counts one slot and advances at N/N.
    const slotPath = force.indexOf("onStageSlotCompleted(p.stageIndex, p.paneId, 'force')")
    const gate = force.indexOf('if (p.managerVerdict) {')
    expect(slotPath, 'the slot path must still be there').toBeGreaterThan(-1)
    expect(gate).toBeGreaterThan(-1)
    // Reached whenever the prompt carries no verdict: the Manager branch is
    // gated on it and returns rather than falling through.
    expect(slotPath).toBeGreaterThan(gate)
    expect(force.slice(gate, slotPath)).toContain('return')
    // …and nothing was bolted onto the slot path itself.
    expect(force.slice(slotPath)).not.toContain('onPipelineNext')
  })
})
