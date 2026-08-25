// Git plugin composition root.
//
// The isolated plugin view receives one already-authenticated capability
// closure from the SDK shim. All feature ports are built here and injected into
// the shared Git surface; GitWindowApp and its domain components never see the
// capability backend, IPC/WebSocket details, or Host routes.

import { createApp } from 'vue'
import { i18n } from '@navide/git-shared/i18n'
import { useBackend } from './capabilityBackend'
import { createPluginGitTransport, type PluginGitSdk } from './sdkGitTransport'
import {
  createPluginCapabilitySdk,
  createPluginKeybindingsPort,
  createPluginGitSurfacePorts,
  createPluginGitContributionHostPort,
  createPluginGitSettingsPort,
  createPluginTerminalDockPort,
} from './pluginSurfacePorts'
import {
  GIT_ACCOUNTS_KEY,
  GIT_BRANCH_DIFF_KEY,
  GIT_FILE_ACCESS_KEY,
  GIT_ISSUES_KEY,
  GIT_TRANSPORT_KEY,
  GIT_UI_KEY,
} from './ports/gitSurface'
import { TERMINAL_DOCK_KEY } from '@navide/git-shared/ports/terminalDock'
import { initSettingsBackend, seedSettings } from '@navide/git-shared/lib/settings'
import { initKeybindingsPort } from '@navide/git-shared/keybindings/useKeybindings'

// Theme token layers — order matters: primitives → semantic roles → themes.
import '@navide/git-shared/styles/tokens/base.css'
import '@navide/git-shared/styles/tokens/semantic.css'
import '@navide/git-shared/styles/tokens/themes/dark-midnight.css'
import '@navide/git-shared/styles/tokens/themes/dark-forest.css'
import '@navide/git-shared/styles/tokens/themes/light.css'
import '@navide/git-shared/styles/tokens/themes/high-contrast.css'

import GitWindowApp from './GitWindowApp.vue'
import GitLeftApp from './GitLeftApp.vue'

// Zero-flash initial theme: the host passes the current app theme as `?theme=`
// (the plugin origin has no `window.agentTeam.getBootstrapSettings`, so the
// settings cache seeds empty here). Stamp `data-theme` before mount and seed
// the cache with the store's JSON-string encoding so useTheme.loadTheme()
// keeps it; the connect-time `ui.settings.get` reconcile then takes over.
// Mirrors plugins/plans/mount.ts.
const initialTheme = new URLSearchParams(window.location.search).get('theme')
if (initialTheme) {
  document.documentElement.setAttribute('data-theme', initialTheme)
  seedSettings({ 'agent-team:theme': JSON.stringify(initialTheme) })
}

const backend = useBackend()
const capabilitySdk = createPluginCapabilitySdk(backend)
const gitSdk: PluginGitSdk = {
  status: capabilitySdk.status,
  request: capabilitySdk.request,
  subscribe: capabilitySdk.subscribe,
}
const gitTransport = createPluginGitTransport(gitSdk)
const surfacePorts = createPluginGitSurfacePorts(capabilitySdk, gitTransport)
const contributionHostPort = createPluginGitContributionHostPort(capabilitySdk)
const settingsPort = createPluginGitSettingsPort(capabilitySdk)
const terminalPort = createPluginTerminalDockPort(capabilitySdk)

// Hook shared settings to the same authenticated ui capability closure before
// the app reads any cached setting.
initSettingsBackend(settingsPort)
initKeybindingsPort(createPluginKeybindingsPort())

const isLeftContribution = new URLSearchParams(window.location.search).get('contribution') === 'left'
const app = isLeftContribution
  ? createApp(GitLeftApp, { surfacePorts, hostPort: contributionHostPort })
  : createApp(GitWindowApp)
app.use(i18n)
app.provide(GIT_TRANSPORT_KEY, surfacePorts.gitTransport)
app.provide(GIT_FILE_ACCESS_KEY, surfacePorts.fileAccess)
app.provide(GIT_UI_KEY, surfacePorts.ui)
app.provide(GIT_BRANCH_DIFF_KEY, surfacePorts.branchDiff)
app.provide(GIT_ACCOUNTS_KEY, surfacePorts.accounts)
app.provide(GIT_ISSUES_KEY, surfacePorts.issues)
app.provide(TERMINAL_DOCK_KEY, terminalPort)
app.mount('#app')

// Announce readiness only after the app has mounted and installed every port.
;(window as unknown as { nav?: { ready?: () => void } }).nav?.ready?.()
