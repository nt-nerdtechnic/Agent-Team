// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

// Mounting App starts backend, terminal, settings, and onboarding lifecycles;
// keep these checks narrow source-text assertions like the other App tests.
const appSource = readFileSync(
  resolve(process.cwd(), 'src/renderer/src/App.vue'),
  'utf8'
)

describe('App grid layout preset bar', () => {
  it('renders the preset bar only in grid mode with multiple panes', () => {
    const barAt = appSource.indexOf('class="grid-layout-bar"')
    expect(barAt).toBeGreaterThan(-1)
    const start = appSource.lastIndexOf('<div', barAt)
    const end = appSource.indexOf('>', barAt)
    const openingTag = appSource.slice(start, end + 1)
    expect(openingTag).toContain(
      'v-if="effectiveLayoutMode === \'grid\' && tabVisiblePanes.length > 1"'
    )
  })

  it('wires explicit Grid controls through user-change handlers', () => {
    const barAt = appSource.indexOf('class="grid-layout-bar"')
    const sectionEnd = appSource.indexOf('Sidebar/auto mode vertical handle', barAt)
    const section = appSource.slice(barAt, sectionEnd)
    expect(section).toContain('v-for="opt in gridPresetOptions"')
    expect(section).toContain('@click="onUserChangeGridPreset(opt.key)"')
    expect(section).toContain('@click="onUserChangeGridPage(gridPage - 1)"')
    expect(section).toContain('@click="onUserChangeGridPage(gridPage + 1)"')
  })

  it('hides paged-out panes via v-show without unmounting terminals', () => {
    expect(appSource).toContain('v-show="onScreenPaneIds.has(p.id)"')
    const onScreenAt = appSource.indexOf('const onScreenPaneIds = computed')
    const onScreenEnd = appSource.indexOf('\nconst dualFocusHandlePos', onScreenAt)
    const onScreen = appSource.slice(onScreenAt, onScreenEnd)
    expect(onScreen).toContain('gridPagePaneIds.value')
  })

  it('persists the preset under agentTeam.gridPreset', () => {
    expect(appSource).toContain("settingsGet('agentTeam.gridPreset', 'auto')")
    expect(appSource).toContain("settingsSet('agentTeam.gridPreset', v)")
  })
})
