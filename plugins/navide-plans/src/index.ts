import { createApp } from 'vue'
import '@navide/plugin-ui/styles.css'
import PlansApp from './PlansApp.vue'
import { plansViewRuntime } from './backend'
import { i18n } from '@navide/plugin-ui/foundation'

// Both entrypoints intentionally share the package-local surface model. The
// contribution query is Host-authenticated; PlansApp changes only its layout
// and row-open behavior for the embedded left contribution.
const app = createApp(PlansApp)
app.use(i18n)
app.mount('#app')
plansViewRuntime.ready()
