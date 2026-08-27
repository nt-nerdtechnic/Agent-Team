import { describe, expect, it } from 'vitest'
import { buildPluginContributionCatalog, type PluginContributionCatalogEntry } from './pluginContributionCatalog'
import type { PluginLaunchDescriptor } from './frontendPluginManager'

const descriptor = (id: string, views: PluginLaunchDescriptor['views']): PluginLaunchDescriptor => ({
  id,
  packageVersion: '1.0.0',
  requires: [],
  devUrl: '',
  entryFile: `/plugins/${id}/index.html`,
  views,
})

describe('plugin contribution catalog', () => {
  it('sorts packages by id and preserves manifest order within each package', () => {
    const entries = buildPluginContributionCatalog([
      descriptor('zeta.plugin', [
        { id: 'second', contributionKey: 'zeta.plugin.second', kind: 'custom', location: 'left', title: 'Second', entryFile: '/zeta/second.html' },
      ]),
      descriptor('acme.plugin', [
        { id: 'main', contributionKey: 'acme.plugin.main', kind: 'custom', location: 'main', title: 'Main', entryFile: '/acme/main.html' },
        { id: 'left', contributionKey: 'acme.plugin.left', kind: 'custom', location: 'left', title: 'Left', entryFile: '/acme/left.html' },
      ]),
    ])

    expect(entries.map(({ contributionKey }) => contributionKey)).toEqual([
      'acme.plugin.main',
      'acme.plugin.left',
      'zeta.plugin.second',
    ])
  })

  it('does not expose a runtime instance id', () => {
    const [entry] = buildPluginContributionCatalog([
      descriptor('acme.plugin', [
        { id: 'left', contributionKey: 'acme.plugin.left', kind: 'custom', location: 'left', title: 'Left', entryFile: '/acme/left.html' },
      ]),
    ])
    expect(entry).toEqual<PluginContributionCatalogEntry>({
      pluginId: 'acme.plugin',
      packageVersion: '1.0.0',
      contributionKey: 'acme.plugin.left',
      title: 'Left',
      iconFile: null,
      kind: 'custom',
      location: 'left',
      manifestOrder: 0,
    })
    expect('instanceId' in entry).toBe(false)
  })

  it('keeps the Host-verified icon identity internal to the catalog', () => {
    const [entry] = buildPluginContributionCatalog([
      descriptor('acme.plugin', [
        {
          id: 'left',
          contributionKey: 'acme.plugin.left',
          kind: 'custom',
          location: 'left',
          title: 'Left',
          iconFile: '/plugins/acme.plugin/assets/icon.png',
          entryFile: '/plugins/acme.plugin/left.html',
        },
      ]),
    ])

    expect(entry.iconFile).toBe('/plugins/acme.plugin/assets/icon.png')
  })

  it('preserves every approved placement for generic Host composition', () => {
    const locations = ['top', 'bottom', 'right', 'left', 'main', 'window'] as const
    const entries = buildPluginContributionCatalog([
      descriptor('acme.placements', locations.map((location) => ({
        id: location,
        contributionKey: `acme.placements.${location}`,
        kind: 'custom',
        location,
        title: location,
        entryFile: `/plugins/acme.placements/${location}.html`,
      }))),
    ])

    expect(entries.map((entry) => entry.location)).toEqual(locations)
    expect(entries.every((entry) => entry.pluginId === 'acme.placements')).toBe(true)
  })
})
