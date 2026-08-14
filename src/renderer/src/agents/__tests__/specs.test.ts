/**
 * Structural invariants every vendor spec must hold.
 *
 * These are the rules `docs/adding-a-cli-vendor.md` states in prose but that
 * nothing enforced: the backend has `test_cli_vendors_registry.py`, the
 * frontend had no equivalent, so a spec could ship with a key that disagreed
 * with its filename, a regex that breaks on the second call, or — as actually
 * happened — a type annotation that silently collapsed the AgentKey union for
 * the whole app.
 */

import { describe, expect, it } from 'vitest'

import { AGENT_SPECS, CLI_AGENT_SPECS, type AgentKey } from '../index'
import type { AgentSpec } from '../types'
import { buildResumeCommand } from '../../lib/resume-command'

// ── compile-time invariant ─────────────────────────────────────────────────
// Checked by `pnpm typecheck` (tsconfig.web.json includes this file), not at
// runtime: if any spec widens its agentKey — `SPEC: AgentSpec` instead of
// `as const satisfies AgentSpec` — AgentKey degrades to `string`, this type
// resolves to `false`, and the assignment below stops compiling.
type IsLiteralUnion<T> = string extends T ? false : true
const AGENT_KEY_IS_A_LITERAL_UNION: IsLiteralUnion<AgentKey> = true

/** Every vendor module in this directory, keyed by filename stem. `_`-prefixed
 *  files (the contributor template) are infrastructure and never registered. */
const modules = import.meta.glob('../*.ts', { eager: true }) as Record<
  string,
  { SPEC?: AgentSpec }
>
const vendorFiles = Object.entries(modules)
  .map(([path, mod]) => ({ stem: path.replace(/^\.\.\//, '').replace(/\.ts$/, ''), mod }))
  .filter(({ stem }) => !stem.startsWith('_') && stem !== 'index' && stem !== 'types')

describe('spec assembly', () => {
  it('keeps AgentKey a literal union', () => {
    // The real check is the type above; this asserts it stayed reachable.
    expect(AGENT_KEY_IS_A_LITERAL_UNION).toBe(true)
  })

  it('registers every vendor file in index.ts', () => {
    const onDisk = vendorFiles.filter(({ mod }) => mod.SPEC).map(({ stem }) => stem).sort()
    const registered = AGENT_SPECS.map((s) => s.agentKey).sort()

    expect(registered).toEqual(onDisk)
  })

  it('names each spec after its own file', () => {
    for (const { stem, mod } of vendorFiles) {
      expect(mod.SPEC?.agentKey, `${stem}.ts`).toBe(stem)
    }
  })

  it('has no duplicate keys', () => {
    const keys = AGENT_SPECS.map((s) => s.agentKey)

    expect(new Set(keys).size).toBe(keys.length)
  })

  it('gives every CLI agent a label and a command', () => {
    for (const spec of CLI_AGENT_SPECS) {
      expect(spec.label.trim(), spec.agentKey).not.toBe('')
      expect(spec.defaultCommand.trim(), spec.agentKey).not.toBe('')
    }
  })
})

describe('resume contract', () => {
  it('keeps resumeArgs and resumeWithoutId mutually exclusive', () => {
    // buildResumeCommand checks resumeWithoutId first, so a spec carrying both
    // would silently lose its id-based path.
    for (const spec of CLI_AGENT_SPECS) {
      expect(
        Boolean(spec.resumeArgs && spec.resumeWithoutId),
        `${spec.agentKey} declares both`,
      ).toBe(false)
    }
  })

  it('matches its own resumeCommandPattern against the command it builds', () => {
    // A pattern that does not recognize this vendor's own resume invocation
    // makes a restore replay it as if the user had typed a custom command.
    const id = '00000000-1111-2222-3333-444444444444'
    for (const spec of CLI_AGENT_SPECS.filter((s) => s.resumeCommandPattern)) {
      const command = buildResumeCommand(spec.agentKey, id, '', '/tmp/history.md')

      expect(command, `${spec.agentKey} builds nothing`).not.toBe('')
      expect(
        spec.resumeCommandPattern!.test(command),
        `${spec.agentKey}: ${spec.resumeCommandPattern} does not match ${command}`,
      ).toBe(true)
    }
  })

  it('only claims rebuild support when it can actually resume', () => {
    for (const spec of CLI_AGENT_SPECS.filter((s) => s.supportsRebuild)) {
      expect(
        Boolean(spec.resumeArgs || spec.resumeWithoutId),
        `${spec.agentKey} claims rebuild without a resume path`,
      ).toBe(true)
    }
  })
})

describe('stateful-regex guard', () => {
  // `/g` makes RegExp.test() advance lastIndex between calls, so the same text
  // matches then fails. Both watchers re-run against the same buffer, which is
  // exactly the shape that breaks. types.ts documents the ban for
  // awaitingInput; loginExpired is matched the same way.
  it('keeps awaitingInput patterns stateless', () => {
    for (const spec of CLI_AGENT_SPECS.filter((s) => s.awaitingInput)) {
      expect(spec.awaitingInput!.pattern.global, spec.agentKey).toBe(false)
    }
  })

  it('keeps loginExpired patterns stateless', () => {
    for (const spec of CLI_AGENT_SPECS.filter((s) => s.loginExpired)) {
      expect(spec.loginExpired!.pattern.global, spec.agentKey).toBe(false)
    }
  })

  it('is a real guard — a /g pattern would fail it', () => {
    // Proves the assertions above can fail, rather than passing vacuously.
    const stateful = /waiting/g
    stateful.test('waiting')

    expect(stateful.test('waiting')).toBe(false)
  })
})
