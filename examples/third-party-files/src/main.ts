import { definePlugin, PluginError, type PluginContext } from '@navide/plugin-sdk'
import { createPluginButton } from '@navide/plugin-ui'

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
    if (!(error instanceof PluginError)) throw error
    lastRun.deniedCode = error.code
  }

  if (typeof document === 'undefined') return
  const mount = document.querySelector('#app')
  if (!mount) return
  const status = document.createElement('p')
  status.textContent = `Read ${file.content.length} characters; shell: ${lastRun.deniedCode ?? 'allowed'}`
  mount.append(status)
  mount.prepend(
    createPluginButton({
      label: 'Refresh file',
      onClick: () => context.lifecycle.reportProgress('Refresh requested'),
    })
  )
}

export const plugin = definePlugin(activate)
