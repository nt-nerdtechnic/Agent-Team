// Single source of truth for what the bundled plugins require.
//
// The same capability list has to appear in three places that are built and
// loaded independently, and nothing used to tie them together:
//
//   1. the packaged manifest    — vite.<plugin>.config.ts emitManifest()
//   2. the dev descriptor       — frontendPluginManager devXPluginDescriptor()
//   3. the plugin's WS-type map — plugins/<plugin>/capabilityBackend TYPE_TO_CAP
//
// Drift between 1 and 2 makes a dev run deny calls the packaged build allows
// (or the reverse), which only shows up when someone runs the other build.
// Drift against 3 is caught by each plugin's capabilityBackend test, which
// asserts the namespaces it maps against the set below.
//
// A plugin may declare MORE than its map uses (navide.plans declares `plans`
// without mapping any plans.* WS type yet) — a superset is safe. The unsafe
// direction is a map reaching a namespace the manifest never granted, which
// the broker would deny at runtime.

/** navide.git — git/fs power the working tree, `ui` the theme sync and the
 *  open-in-editor host capability, `issues` the embedded cloud issues panel.
 *  chat/terminal/search power the embedded AIChatPane (right AI panel): the
 *  chat engine calls plus the shell.run / find_in_files its slash commands and
 *  context gathering send. */
export const GIT_PLUGIN_REQUIRES: readonly string[] = [
  'git',
  'fs',
  'ui',
  'issues',
  'chat',
  'terminal',
  'search',
]

/** navide.mini-ide — the widest surface: editor, terminal, search and chat. */
export const MINI_IDE_PLUGIN_REQUIRES: readonly string[] = [
  'fs',
  'git',
  'terminal',
  'search',
  'chat',
  'ui',
  'issues',
]

/** navide.plans — plan documents on disk plus the theme sync.
 *  chat/terminal/search/git power the embedded AIChatPane (right AI panel):
 *  the chat engine calls plus the shell.run / find_in_files / git context and
 *  commit actions its features send. */
export const PLANS_PLUGIN_REQUIRES: readonly string[] = [
  'fs',
  'ui',
  'plans',
  'chat',
  'terminal',
  'search',
  'git',
]
