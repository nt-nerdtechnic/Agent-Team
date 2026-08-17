# Third-party Files Example

This example is intentionally outside Navide's package workspace boundary. It
uses only the public `@navide/plugin-contracts`, `@navide/plugin-sdk`, and
`@navide/plugin-ui` packages.

The manifest declares `fs`, so activation may call `fs.readFile`. It does not
declare `shell`, so the same activation deliberately calls `shell.run` and
records the Host's `CAPABILITY_DENIED` response.

Before the public packages are published to npm, run the external workspace
smoke test from the Navide repository root:

```text
pnpm test:run src/main/plugins/pluginExternalWorkspace.test.ts
```

The smoke test copies this example into a temporary project outside the Navide
workspace, replaces the public package and TypeScript dependencies with local
tarballs, and installs them with `pnpm install --offline`.

After the public packages are published, run the workflow from this directory:

```text
pnpm install
pnpm run typecheck
pnpm run build
pnpm run check
pnpm run package
```
