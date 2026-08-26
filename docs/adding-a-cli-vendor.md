# Adding a CLI vendor

Navide supports one CLI agent per vendor file. Adding a vendor is a
self-contained PR: two new files plus one registration line on each side.
You never need to read or modify the shared orchestration code.

## Backend

1. Copy `backend/agent_team_backend/cli_vendors/_template.py` to
   `cli_vendors/<key>.py` (short lowercase key, e.g. `mycli`) and fill in
   the `SPEC`. Every capability you leave at its default is treated as
   "unsupported" for your vendor — the app degrades gracefully.
2. Register the spec in `cli_vendors/registry.py` (one line, alphabetical).
3. If the CLI writes local conversation logs, implement the log reader in
   your vendor file and set `make_log_reader`.
4. Add `backend/agent_team_backend/log_readers/<key>.py`. Every registered
   vendor needs a module there — a re-export shim when you wrote a reader
   (copy any existing one), an empty placeholder when you did not. If you
   wrote one, also list its class in `log_readers/__init__.py`
   (`_MIGRATED_READERS` and `__all__`).
5. Add `backend/tests/vendors/test_<key>.py` covering what you implemented.
6. Add your key to two hardcoded lists in the tests: `EXPECTED_KEYS` in
   `backend/tests/test_cli_vendors_registry.py`, and the `SNAPSHOT` in
   `backend/tests/vendors/test_install_deps_snapshot.py` (append your entry
   last unless you also added the key to `_AGENT_CLI_ORDER`).

## Frontend

1. Copy `src/renderer/src/platform/plugin-shell/agents/_template.ts` to `agents/<key>.ts` and
   fill in the spec (label, default command, resume syntax, capability
   flags — the template lists every optional field with pointers to the
   full docs in `agents/types.ts`).
2. Register it in `agents/index.ts` (one line, display order).
3. Run `pnpm vitest run src/renderer/src/platform/plugin-shell/agents` — the structural tests there
   check your spec against the rules the template states (key matches the
   filename, the file is registered, `resumeCommandPattern` matches the
   command Navide builds for you, no `/g` on a matcher). They need no edit
   when you add a vendor; they discover your file on their own.

Write the spec as `export const SPEC = { … } as const satisfies AgentSpec`,
never `SPEC: AgentSpec`. The annotation widens `agentKey` to `string`, and
`index.ts` derives the app-wide `AgentKey` union from these literals — one
annotated spec collapses that union everywhere. A compile-time assertion in
`agents/__tests__/specs.test.ts` fails if this regresses.

## Install detection

Set `install_dep=Dep(...)` in your vendor's `SPEC` (see any existing
vendor file) so Navide can detect, install, and update your CLI. The
onboarding wizard aggregates every vendor's entry automatically — no
other file to edit.

## Known exemptions

"No shared module carries per-vendor branches" holds for the orchestration
you go through when adding a vendor. Three places are deliberately outside
that rule — you do not need to touch them, but do not be surprised to find
vendor names there:

- **Credential vault** (`credential_vault.py`, `ws_handlers.py`'s hot-swap
  path). Account switching is per-vendor by nature — where a secret lives,
  whether a login home isolates it, how an identity is read out of it. A new
  vendor gets multi-account support by filling in the credential fields of its
  own `SPEC`; the vault's remaining `claude` branches are its own history.
- **`CODEX_HOME` per-pane isolation** (`ws_handlers.py`, `codex_home.py`).
  `CodexHomeManager` is owned by the app and injected into the spawn path, so
  moving it into `cli_vendors/codex.py` would invert the import direction that
  `cli_vendors/base.py` forbids. It stays put until the spawn path grows a
  hook that can express it.
- **Plugins** (`plugins/builtin/**`). Plugin wiring — MCP server injection,
  per-pane shim homes, skills — still branches on `agent_key` inside each
  plugin. Plugins are not part of the vendor contract: a new vendor works
  without touching them, and gains plugin-specific behaviour only if that
  plugin adds it.

Anything else that makes you edit a shared module to add a vendor is a gap in
the contract. Open an issue rather than adding a branch.

## Verify

```sh
uv --project backend run pytest backend/tests/test_cli_vendors_registry.py
uv --project backend run pytest backend/tests
pnpm test:run && pnpm typecheck
```

The registry test is your checklist: it fails with a message naming exactly
which list you forgot (registry, DEPS, log reader, frontend spec) and
rejects forbidden imports (vendor modules may import only `base`,
`_protocols`, the standard library, and httpx — never another vendor or any
app module).

## Boundaries

- Never add `if agent_key == "<yours>"` branches to shared modules — put
  the behavior in your vendor file; if the contract in
  `cli_vendors/base.py` lacks a hook you need, open an issue first.
- Credential-vault behavior (`credential_vault.py`) is security-sensitive
  and not extensible from vendor files beyond the file-layout fields in
  the spec.
