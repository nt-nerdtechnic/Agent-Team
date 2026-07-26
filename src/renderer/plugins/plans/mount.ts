// Plans plugin entry.
//
// Mounts the UNMODIFIED PlanWindowApp.vue inside the isolated plugin
// WebContentsView. It boots exactly like the core plan window
// (src/renderer/src/main.ts, `?window=plans`): the same theme-token CSS layers
// and i18n, then `createApp(PlanWindowApp).mount('#app')`.
//
// The one difference is invisible to the app source: the plugin build aliases
// `composables/useBackend` to `./capabilityBackend`, so every `send`/`on` inside
// PlanWindowApp, PlansPane, PlanReviewToolbar, … is routed through `window.nav`
// (the host capability broker) instead of a direct WebSocket. PlanWindowApp
// still reads its `workspace_path` / `rel_path` from `window.location.search`,
// which the host sets when it loads this entry — no injection needed here.

import { createApp } from 'vue'
import { i18n } from '../../src/i18n'

// Theme token layers — order matters: primitives → semantic roles → themes.
import '../../src/styles/tokens/base.css'
import '../../src/styles/tokens/semantic.css'
import '../../src/styles/tokens/themes/dark-midnight.css'
import '../../src/styles/tokens/themes/dark-forest.css'
import '../../src/styles/tokens/themes/light.css'
import '../../src/styles/tokens/themes/high-contrast.css'

import PlanWindowApp from '../../src/PlanWindowApp.vue'

// Announce readiness to the host broker (mirrors the noop/mini-ide plugins).
// Local cast instead of relying on the `Window.nav` global augmentation — see
// the note in ./capabilityBackend.ts.
;(window as unknown as { nav?: { ready?: () => void } }).nav?.ready?.()

const app = createApp(PlanWindowApp)
app.use(i18n)
app.mount('#app')
