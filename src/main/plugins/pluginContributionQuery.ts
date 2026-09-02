export interface PluginContributionQueryOptions {
  contributionKey: string
  workspacePath: string
  theme: string
  httpUrl?: string
  gitReadOnly?: Record<string, string>
  extraParams?: Record<string, string>
}

export function composePluginContributionQuery(options: PluginContributionQueryOptions): string {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(options.extraParams ?? {})) params.set(key, value)
  params.set('workspace_path', options.workspacePath)
  if (options.httpUrl) params.set('http_url', options.httpUrl)
  else params.delete('http_url')
  params.set('theme', options.theme)
  for (const [key, value] of Object.entries(options.gitReadOnly ?? {})) params.set(key, value)
  params.set('v2', '1')
  const contribution = options.contributionKey.split('.').at(-1)
  if (contribution === 'left' || contribution === 'window') {
    params.set('contribution', contribution)
  }
  return `?${params.toString()}`
}
