import { describe, expect, it } from 'vitest'
import { composePluginContributionQuery } from './pluginContributionQuery'

describe('composePluginContributionQuery', () => {
  it('identifies an embedded Git contribution as the v2 left view with validated locale', () => {
    expect(composePluginContributionQuery({
      contributionKey: 'navide.git.left',
      workspacePath: '/workspace',
      theme: 'dark',
      locale: 'zh-TW',
      gitReadOnly: {
        git_yolo: '0',
        git_analyzer_model: 'qwen2:latest',
        git_theme_custom: '{}',
      },
    })).toBe(
      '?workspace_path=%2Fworkspace&theme=dark&locale=zh-TW&git_yolo=0&git_analyzer_model=qwen2%3Alatest&git_theme_custom=%7B%7D&v2=1&contribution=left'
    )
  })

  it('identifies a standalone Git contribution as the v2 window view', () => {
    const query = composePluginContributionQuery({
      contributionKey: 'navide.git.window',
      workspacePath: '/workspace',
      theme: 'dark',
      locale: 'en-US',
      httpUrl: 'http://127.0.0.1:8787',
      gitReadOnly: {
        git_yolo: '1',
        git_analyzer_model: '',
        git_theme_custom: '{\"accent\":\"blue\"}',
      },
      extraParams: {
        git_diff_filepath: 'src/main.ts',
        git_diff_staged: '1',
      },
    })

    expect(Object.fromEntries(new URLSearchParams(query))).toEqual({
      git_diff_filepath: 'src/main.ts',
      git_diff_staged: '1',
      workspace_path: '/workspace',
      http_url: 'http://127.0.0.1:8787',
      theme: 'dark',
      locale: 'en-US',
      git_yolo: '1',
      git_analyzer_model: '',
      git_theme_custom: '{\"accent\":\"blue\"}',
      v2: '1',
      contribution: 'window',
    })
  })

  it('identifies Plans left and window contributions with Host-authoritative validated locale', () => {
    const left = new URLSearchParams(composePluginContributionQuery({
      contributionKey: 'navide.plans.left',
      workspacePath: '/workspace',
      theme: 'dark',
      locale: 'zh-TW',
    }))
    const window = new URLSearchParams(composePluginContributionQuery({
      contributionKey: 'navide.plans.window',
      workspacePath: '/workspace',
      theme: 'dark',
      locale: 'en-US',
      extraParams: { rel_path: '.agent-team/plans/example.html' },
    }))

    expect(left.get('contribution')).toBe('left')
    expect(left.get('locale')).toBe('zh-TW')
    expect(window.get('contribution')).toBe('window')
    expect(window.get('locale')).toBe('en-US')
    expect(window.get('rel_path')).toBe('.agent-team/plans/example.html')
  })

  it('fails closed to zh-TW for invalid or missing Host locale', () => {
    const invalidLocale = new URLSearchParams(composePluginContributionQuery({
      contributionKey: 'navide.plans.window',
      workspacePath: '/workspace',
      theme: 'dark',
      locale: 'fr-FR',
    }))
    const missingLocale = new URLSearchParams(composePluginContributionQuery({
      contributionKey: 'navide.plans.left',
      workspacePath: '/workspace',
      theme: 'dark',
    }))

    expect(invalidLocale.get('locale')).toBe('zh-TW')
    expect(missingLocale.get('locale')).toBe('zh-TW')
  })

  it('keeps Host-owned context authoritative over extra entry parameters including locale', () => {
    const query = composePluginContributionQuery({
      contributionKey: 'navide.git.window',
      workspacePath: '/trusted-workspace',
      theme: 'dark',
      locale: 'en-US',
      httpUrl: 'http://127.0.0.1:8787',
      gitReadOnly: { git_yolo: '0' },
      extraParams: {
        workspace_path: '/untrusted-workspace',
        theme: 'light',
        locale: 'zh-TW',
        http_url: 'https://example.invalid',
        git_yolo: '1',
        v2: '0',
        contribution: 'left',
        git_diff_filepath: 'src/main.ts',
      },
    })

    expect(Object.fromEntries(new URLSearchParams(query))).toEqual({
      git_diff_filepath: 'src/main.ts',
      workspace_path: '/trusted-workspace',
      http_url: 'http://127.0.0.1:8787',
      theme: 'dark',
      locale: 'en-US',
      git_yolo: '0',
      v2: '1',
      contribution: 'window',
    })
  })
})
