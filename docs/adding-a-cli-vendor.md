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

1. Copy `src/renderer/src/agents/_template.ts` to `agents/<key>.ts` and
   fill in the spec (label, default command, resume syntax, capability
   flags — the template lists every optional field with pointers to the
   full docs in `agents/types.ts`).
2. Register it in `agents/index.ts` (one line, display order).
3. Run `pnpm vitest run src/renderer/src/agents` — the structural tests there
   check your spec against the rules the template states (key matches the
   filename, the file is registered, `resumeCommandPattern` matches the
   command Navide builds for you, no `/g` on a matcher). They need no edit
   when you add a vendor; they discover your file on their own.

Write the spec as `export const SPEC = { … } as const satisfies AgentSpec`,
never `SPEC: AgentSpec`. The annotation widens `agentKey` to `string`, and
`index.ts` derives the app-wide `AgentKey` union from these literals — one
annotated spec collapses that union everywhere. A compile-time assertion in
`agents/__tests__/specs.test.ts` fails if this regresses.

## Where your vendor shows up in the UI

Registering the spec is all the wiring there is — every surface below reads
the assembled list, so none of them needs an edit. What the list is, though,
passes through one filter that is easy to mistake for a bug:

```
agents/<key>.ts  →  agents/index.ts (ORDERED)  →  AGENT_SPECS / CLI_AGENT_SPECS
                                                          │
                        App.vue `enabledAgentSpecs` ──────┘
                        (user's Settings → CLI Agents order + disabled list)
                                     │
                                     ├─ ControlPane `manualAgentSpecs` — the ＋
                                     │  menu on a workspace heading, and
                                     │  "Handle Issue As…" (terminal filtered out)
                                     └─ everything else reads the unfiltered list:
                                        CliAccountsPane, TokenStatsPanel,
                                        DebugModal, PipelineManagerModal,
                                        AgentMessagesPanel, useTerminal
```

Three consequences worth knowing before you go looking for a missing entry:

- **The ＋ menu is a user-filtered subset, not the vendor list.**
  `useCliAgentPrefs` keeps a *disabled* list (a blocklist) and a custom
  *order*. A brand-new vendor appears with no action from the user: it is not
  in anyone's blocklist, and `orderedAgentKeys` appends keys it has never seen
  after the ordered ones. It lands at the END of the menu, which is where to
  look first. Both lists are per-workspace (`project.json` ui_state), with the
  global KV as the fallback — so a vendor can be visible in one workspace and
  hidden in another.
- **Not being installed does not hide a vendor.** The menu shows every enabled
  vendor and marks the missing ones with a badge (`missingClis`, refreshed on
  backend connect and on dropdown focus). So "it is in the menu" says nothing
  about whether the binary exists, and "it is missing from the menu" is never
  explained by a missing binary.
- **The renderer is a build artifact.** A newly registered vendor reaches a
  running app only after that app is rebuilt (packaged build) or its dev
  server restarted — and only if the branch it was added on is the one being
  built. Checking the menu of an installed release for a vendor that lives on
  a feature branch will always come up empty.

## Install detection

Set `install_dep=Dep(...)` in your vendor's `SPEC` (see any existing
vendor file) so Navide can detect, install, and update your CLI. The
onboarding wizard aggregates every vendor's entry automatically — no
other file to edit.

## The marketing site (`navide-web`)

The public site lists the supported CLIs, and it counts them by fetching this
very directory through the GitHub API — so a vendor appears there on its own
once the commit is on `main`, with no copy edit and no redeploy. Two things in
`src/vendors.ts` are still hardcoded and will lag:

- `ICONS` — an unlisted vendor falls back to the generic terminal glyph. Add
  `<key>: "/vendor-icons/<key>.svg"`, drop the official asset in
  `public/vendor-icons/` (downscale raster sources to 84 px; the frame renders
  at 38–42 px), and record where it came from in that directory's `README.md`.
- `LABELS` — an unlisted key is title-cased (`droid` → "Droid"), which is often
  right, but `LABELS` also *is* `FALLBACK`, the roster shown when the API call
  fails. Unauthenticated GitHub allows 60 requests/hour per IP, so that path is
  hit routinely, not rarely — a vendor missing from `LABELS` silently
  disappears from the site whenever the limit is reached.

Neither blocks the vendor from working; both make the site quietly wrong.

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
