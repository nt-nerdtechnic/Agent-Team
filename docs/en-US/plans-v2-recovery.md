# Plans v2 recovery runbook

## Symptoms

Use this runbook when the Plans v2 window cannot bind its package backend, a
packaged Plans child exits, or the v2 package is being investigated as a
possible source of malformed plan documents.

When the Host detects one of those failures it marks the exact descriptor and
activation unavailable, closes the failed v2 view, opens the legacy Plans
adapter for the same workspace, and re-registers `plans_backend_v2: false`.
The MCP adapter then retries the legacy implementation only for explicit
availability errors (`BACKEND_UNAVAILABLE`, `INVALID_RUNTIME`, `NOT_READY`,
`PROTOCOL_ERROR`, `PLUGIN_STOPPING`, `host_timeout`, or `host_unavailable`);
capability denials and workspace-scope failures remain errors.

## Force the legacy adapter

Start Navide with the process environment below, then reproduce the issue:

```sh
NAVIDE_PLANS_RECOVERY=legacy open -a Navide
```

The override is Host-only. It does not change the selected package descriptor,
the capability Grant, or any Plugin Storage snapshot. Unset the variable and
restart Navide to retry v2.

## Preserve and inspect state

Plans storage is under the app user-data directory:

```text
plugin-storage-v2/
  plans-lifecycle.json
  navide.plans/<package-version>/active/
```

`plans-lifecycle.json` is the authoritative selector for the previous active
package identity. Do not edit snapshot directories or point a renderer at a
`previous` tier. Runtime v2 always binds to the current package's `active`
tier. The Host-only recovery seam `runPlansLegacyRecovery` selects the
lifecycle-recorded previous identity, constructs a read-only recovery context,
and binds the named production `retainedPlansLegacyAdapter` before starting the
retained `PlanWindowApp`/`PlansPane` route. The route receives only the fixed
preference projection through a Host IPC port; the renderer cannot provide a
snapshot, tier, package version, or workspace identity. Its preference and
operations are Host-selected; document operations continue through the
existing legacy backend route. The recovery preference port is read-only, and
the adapter cannot promote, convert, or overwrite the current active snapshot.
The lifecycle record retains the displaced active identity after promotion, so
the same recovery path works when a child fails after migration has already
completed. `readPreviousPlansWorkspacePreference` remains the narrow
single-preference helper for diagnostics.

For a first-install or migration report, capture:

1. the selected package version and package directory;
2. the lifecycle record before and after restart;
3. whether the legacy renderer projected the seven approved preference keys;
4. the Host availability transition and the MCP error code.

Do not copy credentials, bearer tokens, or arbitrary renderer storage into the
report.

The integration proof for the recovery seam is the focused Host test:

```sh
pnpm exec vitest run \
  src/main/plugins/plansStorageMigration.test.ts \
  src/renderer/src/editor/__tests__/PlansPane.test.ts
```

The Host test binds the production legacy adapter to the lifecycle-selected
previous snapshot, verifies the previous preference and unchanged current
storage, and asserts that recovery issued storage reads only. The retained-pane
component test then starts the actual `PlansPane` used by `PlanWindowApp`,
applies the Host projection, and verifies that current renderer storage is not
rewritten during recovery.

## Recovery acceptance check

After forcing legacy mode, verify that the existing legacy window opens the
same workspace and that `plan_list`/`plan_read` work. Then unset the override,
restart, and verify that a successful v2 bind re-advertises
`plans_backend_v2: true`. A missing `_template.html` must produce an explicit
backend-unavailable result until Host asset provisioning succeeds; it must not
produce a simplified alternate document format.
