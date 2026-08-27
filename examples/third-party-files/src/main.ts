import { definePlugin, PluginError, type PluginContext } from '@navide/plugin-sdk'
import { installPluginContext, NAVIDE_UI_TOKENS, usePluginContext } from '@navide/plugin-ui'
import { createApp, defineComponent, h } from 'vue'

export const lastRun: {
  allowedContent: string | null
  deniedCode: PluginError['code'] | null
} = {
  allowedContent: null,
  deniedCode: null,
}

async function activate(context: PluginContext): Promise<void> {
  lastRun.allowedContent = null
  lastRun.deniedCode = null

  const file = await context.capabilities.invoke('fs.readFile', { path: 'README.md' })
  lastRun.allowedContent = file.content

  try {
    await context.capabilities.invoke('shell.run', { command: 'git status' })
  } catch (error) {
    const code =
      error instanceof PluginError
        ? error.code
        : error &&
            typeof error === 'object' &&
            'code' in error &&
            typeof error.code === 'string'
          ? (error.code as PluginError['code'])
          : null
    if (!code) throw error
    lastRun.deniedCode = code
  }

  if (typeof document === 'undefined') return
  const mount = document.querySelector('#app')
  if (!mount) return
  const app = createApp(
    defineComponent({
      setup() {
        const pluginContext = usePluginContext()
        return () =>
          h('section', { style: { color: NAVIDE_UI_TOKENS.colorText } }, [
            h(
              'button',
              {
                type: 'button',
                onClick: () => pluginContext.lifecycle.reportProgress('Refresh requested'),
              },
              'Refresh file'
            ),
            h('p', `Read ${file.content.length} characters; shell: ${lastRun.deniedCode ?? 'allowed'}`),
          ])
      },
    })
  )
  installPluginContext(app, context)
  app.mount(mount)
}

export const plugin = definePlugin(activate)
