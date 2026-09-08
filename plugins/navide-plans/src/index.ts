import { createApp } from 'vue'
import '@navide/plugin-ui/styles.css'
import './pluginDocument.css'
import PlansApp from './PlansApp.vue'
import { plansViewRuntime, subscribeHostEvent } from './backend'
import { i18n } from '@navide/plugin-ui/foundation'
import { bootstrapPlansI18n, bindPlansLocale } from './plansI18n'
import { plansBuildProvenance } from './provenance'

// Both entrypoints intentionally share the package-local surface model. The
// contribution query is Host-authenticated; PlansApp changes only its layout
// and row-open behavior for the embedded left contribution.
bootstrapPlansI18n(i18n, window.location.search)
bindPlansLocale(i18n, subscribeHostEvent)

const app = createApp(PlansApp)
app.use(i18n)
app.mount('#app')
if (new URLSearchParams(window.location.search).get('plans_diagnostics') === '1') {
  Object.defineProperty(window, '__NAVIDE_PLANS_PROVENANCE__', {
    configurable: true,
    value: plansBuildProvenance,
  })
  console.info('[navide.plans] provenance', plansBuildProvenance)
}
plansViewRuntime.ready()
