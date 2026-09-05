// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

// The App.vue half of "a pane launches on the model it was asked for".
//
// App.vue cannot be mounted by this suite (see App.spawnAdvisories.test.ts),
// so — like the other App.*.test.ts files — these assert the WIRING against
// the source text: which function is called, with what, and in what order.
// They cannot prove the resulting command string; the executable proof of the
// flag itself lives in lib/cliModel.test.ts and lib/resume-command.model.test.ts.
const appSource = readFileSync(resolve(process.cwd(), 'src/renderer/src/App.vue'), 'utf8')

function fn(name: string): string {
  const start = appSource.indexOf(`function ${name}(`)
  expect(start, `function ${name} should exist`).toBeGreaterThan(-1)
  const end = appSource.indexOf('\n}\n', start)
  expect(end).toBeGreaterThan(start)
  return appSource.slice(start, end)
}

function iface(name: string): string {
  const start = appSource.indexOf(`interface ${name} {`)
  expect(start, `interface ${name} should exist`).toBeGreaterThan(-1)
  const end = appSource.indexOf('\n}\n', start)
  expect(end).toBeGreaterThan(start)
  return appSource.slice(start, end)
}

describe('resolveCommand — model/effort on a fresh spawn', () => {
  const body = fn('resolveCommand')

  it('takes the request as a parameter that defaults to "not requested"', () => {
    expect(body).toContain('modelRequest: CliModelRequest = NO_MODEL_REQUEST')
    expect(appSource).toContain("const NO_MODEL_REQUEST: CliModelRequest = { model: '', effort: '' }")
  })

  it('derives the flags from the shared helper, never by inlining a vendor flag', () => {
    // The whole point of cliModel.ts: one branch answers both "may this vendor
    // be told a model?" and "what does that look like?", so a refusal and the
    // argv cannot disagree.
    expect(body).toContain('modelArgsFor({ spec, request: modelRequest })')
  })

  it('appends them after the permission flag, matching buildResumeCommand', () => {
    const skipIdx = body.indexOf('if (skipFlag) parts.push(skipFlag)')
    const modelIdx = body.indexOf('modelArgsFor(')
    expect(skipIdx).toBeGreaterThan(-1)
    expect(modelIdx).toBeGreaterThan(skipIdx)
  })

  it('still returns a user command override verbatim, untouched by any flag', () => {
    // An override is trusted literally; the resume paths rebuild their own
    // flags into the override before it gets here.
    const overrideIdx = body.indexOf('if (trimmed) return commandWithSelectedBinary(agentKey, trimmed)')
    expect(overrideIdx).toBeGreaterThan(-1)
    expect(body.indexOf('modelArgsFor(')).toBeGreaterThan(overrideIdx)
  })

  it('leaves the command on the vendor default when the request is refused, and says so', () => {
    // resolveCommand returns a string and has no error channel, so it can only
    // drop a refused request. The console warning is what keeps that from
    // being silent if the spawn gate or the MCP tool ever lets one through.
    expect(body).toContain('if (chosen.args) parts.push(chosen.args)')
    expect(body).toContain('console.warn(')
    expect(body).toContain('chosen.refusal.kind')
  })
})

describe('spawnPane — the one place argv is assembled', () => {
  it('hands the pane\'s model and effort to resolveCommand', () => {
    const body = fn('spawnPane')
    expect(body).toContain('resolveCommand(opts.agentKey, opts.commandOverride, paneArgCtx, {')
    expect(body).toContain("model: opts.model ?? ''")
    expect(body).toContain("effort: opts.effort ?? ''")
  })

  it('records them on the pane so a later rebuild can reproduce the launch', () => {
    const body = fn('spawnPane')
    expect(body).toContain('model: opts.model || undefined')
    expect(body).toContain('effort: opts.effort || undefined')
  })
})

describe('every buildResumeCommand call site carries the model', () => {
  // A resume command is passed to spawnPane as a commandOverride, and
  // resolveCommand hands an override straight back — so a call site that
  // forgets the request silently reopens the pane on the vendor default.
  // This walks ALL call sites rather than listing today's five, so a new one
  // added later fails here instead of shipping the bug.
  /** Top-level arguments of the call starting at `at` ("buildResumeCommand("). */
  function argsOf(at: number): string[] {
    let i = appSource.indexOf('(', at) + 1
    let depth = 0
    const args: string[] = ['']
    for (; i < appSource.length; i++) {
      const ch = appSource[i]
      if (ch === '(' || ch === '{' || ch === '[') depth++
      else if (ch === ')' && depth === 0) break
      else if (ch === ')' || ch === '}' || ch === ']') depth--
      if (ch === ',' && depth === 0) { args.push(''); continue }
      args[args.length - 1] += ch
    }
    return args.map((a) => a.trim())
  }

  const callSites: number[] = []
  for (let i = appSource.indexOf('buildResumeCommand('); i > -1;
       i = appSource.indexOf('buildResumeCommand(', i + 1)) {
    callSites.push(i)
  }

  it('finds the call sites at all', () => {
    expect(callSites.length).toBeGreaterThanOrEqual(5)
  })

  it.each(callSites.map((at, idx) => [idx, at] as const))(
    'call site %i passes a 5th (model request) argument',
    (_idx, at) => {
      const args = argsOf(at)
      expect(args.length, appSource.slice(at, at + 120)).toBe(5)
      expect(args[4].length).toBeGreaterThan(0)
    },
  )
})

describe('the model/effort contract fields', () => {
  it('ActivePane keeps what the pane is running', () => {
    const body = iface('ActivePane')
    expect(body).toContain('model?: string')
    expect(body).toContain('effort?: string')
  })

  it('SpawnInternal carries the request into a spawn', () => {
    const body = iface('SpawnInternal')
    expect(body).toContain('model?: string')
    expect(body).toContain('effort?: string')
  })

  it('ProjectPane names the persisted fields the backend writes', () => {
    // Field names are the contract with the backend's pane record; renaming
    // either side silently turns every restore into a default-model launch.
    const body = iface('ProjectPane')
    expect(body).toContain('model?: string')
    expect(body).toContain('effort?: string')
  })

  it('restores spawn on the persisted model, not just resume into it', () => {
    const body = fn('spawnRestoredPane')
    expect(body).toContain('model: saved.model || undefined')
    expect(body).toContain('effort: saved.effort || undefined')
  })
})

describe('cli_open_agent — the MCP path from event to persistence', () => {
  // The middle of the chain: the backend sends model/effort on the event and
  // the pane record has columns for them, but every station between re-shapes
  // the object, and a field left out of a re-shaping is dropped for good.

  it('the agent_spawn.request handler reads both fields off the event', () => {
    const start = appSource.indexOf("backend.on('agent_spawn.request'")
    expect(start).toBeGreaterThan(-1)
    const handler = appSource.slice(start, appSource.indexOf('\n})\n', start))
    // Declared on the event shape...
    expect(handler).toContain('model?: string')
    expect(handler).toContain('effort?: string')
    // ...and actually forwarded. The backend omits the keys entirely when the
    // caller asked for nothing, so the default has to be '' not undefined.
    expect(handler).toContain("model: ev.model ?? ''")
    expect(handler).toContain("effort: ev.effort ?? ''")
  })

  it('handleMcpSpawnRequest hands them to the gate, not straight to spawnPane', () => {
    const body = fn('handleMcpSpawnRequest')
    expect(body).toContain('model: string')
    expect(body).toContain('effort: string')
    expect(body).toContain(
      'evaluateSpawnRequest(\n    { agent: ev.agent_key, name: ev.name, task: ev.task, model: ev.model, effort: ev.effort },',
    )
  })

  it('both gate contexts supply the renderer AgentSpec as the capability source', () => {
    // The gate is the authoritative refusal; a context that forgot this would
    // make it check nothing.
    for (const name of ['spawnGateContextFor', 'standaloneSpawnGateContext']) {
      expect(fn(name), name).toContain(
        'modelCapabilityFor: (agentKey: string) => agentSpecs.find((s) => s.agentKey === agentKey)',
      )
    }
  })

  it.each(['createRequestedPane', 'createStandaloneRequestedPane'])(
    '%s launches the pane on the requested model',
    (name) => {
      const body = fn(name)
      expect(body).toContain('model?: string; effort?: string')
      expect(body).toContain('model: req.model,')
      expect(body).toContain('effort: req.effort,')
    },
  )

  it.each(['createRequestedPane', 'createStandaloneRequestedPane'])(
    '%s persists them through manual_pane.spawn — the only write',
    (name) => {
      const body = fn(name)
      const spawnIdx = body.indexOf("'manual_pane.spawn'")
      expect(spawnIdx, name).toBeGreaterThan(-1)
      const payload = body.slice(spawnIdx)
      // Without this the pane record keeps the vendor default and the next app
      // restart silently reopens on the wrong model.
      expect(payload).toContain("model: req.model ?? ''")
      expect(payload).toContain("effort: req.effort ?? ''")
    },
  )
})
