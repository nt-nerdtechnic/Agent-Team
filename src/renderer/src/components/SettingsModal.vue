<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import type { useBackend } from '../composables/useBackend'
import type { useRoles } from '../composables/useRoles'
import type { useStages } from '../composables/useStages'
import type { useAnalyzer } from '../composables/useAnalyzer'
import type { usePipelines } from '../composables/usePipelines'
import { stageToBackend, stageDefToFrontend, type Stage, type StageSlot } from '../data/stages'
import { MCP_CATALOG, isMcpInstalled, type McpCatalogEntry } from '../data/mcpCatalog'
import { useTheme } from '../composables/useTheme'
import { useSettings } from '../composables/useSettings'
import { settingsGet, settingsSet } from '../lib/settings'
import {
  USAGE_ENABLED_KEY,
  USAGE_REFRESH_OPTIONS,
  setUsageEnabled,
  setUsageRefreshSec,
  usageRefreshSec,
} from '../composables/useUsage'
import {
  RESUME_BEHAVIOR_SETTING_KEY,
  RESTORE_SCOPE_SETTING_KEY,
  normalizeResumeBehavior,
  normalizeRestoreScope,
  type ResumeBehavior,
  type RestoreScope,
} from '../lib/resumeBehavior'
import {
  RESUME_CONCURRENCY_SETTING_KEY,
  DEFAULT_RESUME_CONCURRENCY,
  MIN_RESUME_CONCURRENCY,
  MAX_RESUME_CONCURRENCY,
  clampResumeConcurrency,
} from '../lib/resumeConcurrency'
import { useCliAgentPrefs } from '../composables/useCliAgentPrefs'
import { CLI_AGENT_SPECS } from '../lib/agentSpecs'
import {
  LOOP_PROMPT_SETTING_KEY,
  DEFAULT_LOOP_PROMPT,
  LOOP_RESUME_SETTING_KEY,
  DEFAULT_LOOP_RESUME,
} from '../lib/loopPrompt'
import { useNotify } from '../composables/useNotify'
import { useUpdater } from '../composables/useUpdater'
import type { UpdateChannel } from '../../../shared/updater'
import { useGitAccounts } from '../composables/useGitAccounts'
import GitAccountsPane from './GitAccountsPane.vue'
import CliAccountsPane from './CliAccountsPane.vue'
import CliManagementPanel from './CliManagementPanel.vue'
import type { useCliProfiles } from '../composables/useCliProfiles'
import KeyboardShortcutsHelp from './KeyboardShortcutsHelp.vue'
import ExtensionsPane from './ExtensionsPane.vue'
import SkillsPane from './SkillsPane.vue'
import SettingsNavItem from './settings/SettingsNavItem.vue'
import SettingsSection from './settings/SettingsSection.vue'
import SettingsCard from './settings/SettingsCard.vue'
import SettingRow from './settings/SettingRow.vue'
import ToggleSwitch from './settings/ToggleSwitch.vue'
import {
  isSecretSettingKey,
  nextRecordKey,
  RevisionedMcpSaveQueue,
  shouldReloadMcpAfterBundleImport,
  switchMcpTransportShape,
  type RevisionedMcpSaveOutcome,
  type McpTransport,
} from '../lib/mcp-settings-editor'

const props = defineProps<{
  backend: ReturnType<typeof useBackend>
  rolesApi: ReturnType<typeof useRoles>
  cliProfilesApi: ReturnType<typeof useCliProfiles>
  /** True when a workspace is open — CLI account sign-in needs one to spawn
   *  the login pane. */
  workspaceOpen?: boolean
  /** Basename of the currently open workspace, shown in the sidebar header.
   *  Falls back to the app name when not provided. */
  workspaceName?: string
  stagesApi: ReturnType<typeof useStages>
  analyzerApi: ReturnType<typeof useAnalyzer>
  pipelinesApi?: ReturnType<typeof usePipelines>
  initialTab?: Tab
  confirmBeforeClose?: boolean
}>()
const emit = defineEmits<{
  (e: 'close'): void
  (e: 'open-pipeline', id: string): void
  (e: 'reopen-onboarding'): void
  (e: 'cli-login', agentKey: string, loginProfileId?: string): void
  (e: 'update:confirmBeforeClose', v: boolean): void
}>()
const confirmBeforeCloseModel = computed({
  get: () => props.confirmBeforeClose ?? true,
  set: (v: boolean) => emit('update:confirmBeforeClose', v),
})

// ── Tab ───────────────────────────────────────────────────────────────────────
type Tab = 'roles' | 'pipelines' | 'mcp' | 'skills' | 'analyzer' | 'cliAgents' | 'general' | 'updates' | 'appearance' | 'accounts' | 'shortcuts' | 'extensions'
const activeTab = ref<Tab>(props.initialTab ?? 'roles')

// Sidebar workspace header label — the open workspace's basename, falling back
// to the app name when no workspace is passed in.
const workspaceLabel = computed(() => props.workspaceName?.trim() || 'Agent-Team')

// ── CLI Agents (enable/disable + reorder for the manual spawn dropdown) ────────
const { order: cliOrder, disabled: cliDisabled } = useCliAgentPrefs()

const cliAgentRows = computed(() => {
  const rank = (k: string) => {
    const i = cliOrder.value.indexOf(k)
    return i < 0 ? Number.MAX_SAFE_INTEGER : i
  }
  return [...CLI_AGENT_SPECS].sort((a, b) => rank(a.agentKey) - rank(b.agentKey))
})
const cliEnabledCount = computed(
  () => CLI_AGENT_SPECS.filter((s) => !cliDisabled.value.includes(s.agentKey)).length
)
function cliAgentEnabled(k: string): boolean {
  return !cliDisabled.value.includes(k)
}
function toggleCliAgent(k: string): void {
  const set = new Set(cliDisabled.value)
  if (set.has(k)) {
    set.delete(k)
  } else {
    if (cliEnabledCount.value <= 1) return // keep at least one enabled — else nothing can spawn
    set.add(k)
  }
  cliDisabled.value = [...set]
}
const cliDragKey = ref('')
const cliDragOverKey = ref('')
function onCliDragStart(e: DragEvent, k: string): void {
  cliDragKey.value = k
  if (e.dataTransfer) {
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData('text/plain', k)
  }
}
function onCliDragOver(e: DragEvent, k: string): void {
  if (!cliDragKey.value || cliDragKey.value === k) return
  e.preventDefault()
  cliDragOverKey.value = k
}
function onCliDragLeave(k: string): void {
  if (cliDragOverKey.value === k) cliDragOverKey.value = ''
}
function onCliDrop(k: string): void {
  const from = cliDragKey.value
  cliDragOverKey.value = ''
  cliDragKey.value = ''
  if (!from || from === k) return
  const keys = cliAgentRows.value.map((s) => s.agentKey)
  const fi = keys.indexOf(from)
  const ti = keys.indexOf(k)
  if (fi < 0 || ti < 0) return
  keys.splice(ti, 0, keys.splice(fi, 1)[0])
  cliOrder.value = keys
}

interface SettingsSearchItem {
  id: string
  tab: Tab
  section: string
  title: string
  group: string
  summary: string
  keywords: string
  mcpView?: MView
}

const settingsSearchQuery = ref('')
const settingsSearchItems = computed<SettingsSearchItem[]>(() => [
  {
    id: 'roles',
    tab: 'roles',
    section: 'roles',
    title: 'Roles / 角色',
    group: 'Roles',
    summary: 'Role keys, labels, one-line summaries, system prompts, JSON import/export.',
    keywords: 'roles role 角色 身分 prompt system prompt 系統提示詞 key label import export json 匯入 匯出',
  },
  {
    id: 'pipelines',
    tab: 'pipelines',
    section: 'pipelines',
    title: 'Pipelines / 流程',
    group: 'Pipelines',
    summary: 'Create, rename, delete, set default, and run pipelines.',
    keywords: 'pipelines pipeline 流程 管線 default rename delete run 預設 重新命名 刪除 執行',
  },
  {
    id: 'stages',
    tab: 'pipelines',
    section: 'pipeline-stages',
    title: 'Stages & Slots / 階段與 Slot',
    group: 'Pipelines',
    summary: 'Stage ID, title, sentinel, questions, Context7 query, slots, roles, agents, manager, kickoff.',
    keywords: 'stage stages slot slots 階段 sentinel questions allow questions context7 kickoff manager commander agent role codex claude antigravity',
  },
  {
    id: 'mcp-installed',
    tab: 'mcp',
    section: 'mcp-installed',
    title: 'Installed MCP Servers / 已安裝 MCP',
    group: 'MCP',
    summary: 'Refresh, open config, enable/disable, remove, inspect tools, edit command, args, and env vars.',
    keywords: 'mcp server servers tools command args env context7 enable disable config refresh 已安裝 工具 環境變數 設定檔',
  },
  {
    id: 'mcp-catalog',
    tab: 'mcp',
    section: 'mcp-catalog',
    title: 'MCP Catalog / MCP 目錄',
    group: 'MCP',
    summary: 'Search and add context-reading MCP servers from the catalog.',
    keywords: 'mcp catalog add install search context reading 新增 安裝 搜尋 目錄',
    mcpView: 'catalog',
  },
  {
    id: 'skills',
    tab: 'skills',
    section: 'skills',
    title: 'Skills / 技能',
    group: 'Integrations',
    summary: 'Create, edit, enable, disable, and inspect app-managed agent skills.',
    keywords: 'skills skill agent instructions markdown enable disable attachments 技能 指令 啟用 停用 附件',
  },
  {
    id: 'analyzer-backend',
    tab: 'analyzer',
    section: 'analyzer-backend',
    title: 'Inference Backend / 推論後端',
    group: 'Analyzer',
    summary: 'Switch Ollama REST or llama.cpp, set base URL, llama-cli path, and GGUF model path.',
    keywords: 'analyzer inference backend 推論 分析器 ollama llama llama.cpp llama-cli gguf url base url health',
  },
  {
    id: 'analyzer-models',
    tab: 'analyzer',
    section: 'analyzer-models',
    title: 'Models & Benchmark / 模型與基準測試',
    group: 'Analyzer',
    summary: 'Download/delete Ollama models and run model benchmark tasks.',
    keywords: 'model models benchmark download delete pull ollama 模型 基準測試 下載 刪除',
  },
  {
    id: 'cloud-keys',
    tab: 'analyzer',
    section: 'cloud-keys',
    title: 'Cloud Provider Keys / 雲端 API 金鑰',
    group: 'Analyzer',
    summary: 'Anthropic, OpenAI, Gemini, Groq, DeepSeek, Mistral, xAI, and OpenAI-compatible endpoint settings.',
    keywords: 'api key keys token cloud provider anthropic openai google gemini groq deepseek mistral xai grok compatible endpoint base url 金鑰 雲端',
  },
  {
    id: 'appearance-theme',
    tab: 'appearance',
    section: 'appearance-theme',
    title: 'Theme & Custom Colors / 主題與自訂顏色',
    group: 'Appearance',
    summary: 'Built-in themes and semantic color overrides.',
    keywords: 'appearance theme custom colors color 外觀 主題 自訂顏色 背景 文字 邊框 accent high contrast',
  },
  {
    id: 'settings-management',
    tab: 'general',
    section: 'settings-management',
    title: 'Settings Management / 設定管理',
    group: 'General',
    summary: 'Export/import the full settings bundle and inspect where settings are stored.',
    keywords: 'settings management export import bundle config path location scope user workspace 設定管理 匯出 匯入 全集 位置 路徑 層級',
  },
  {
    id: 'appearance-language',
    tab: 'appearance',
    section: 'appearance-language',
    title: 'Language / 語言',
    group: 'Appearance',
    summary: 'Switch between Traditional Chinese and English.',
    keywords: 'language locale 語言 繁體中文 english en-us zh-tw',
  },
  {
    id: 'appearance-runtime',
    tab: 'appearance',
    section: 'appearance-runtime',
    title: 'Restore Windows / 還原視窗',
    group: 'Appearance',
    summary: 'Restore editor windows on startup.',
    keywords: 'restore windows 還原視窗 startup 啟動',
  },
  {
    id: 'general-environment',
    tab: 'general',
    section: 'general-environment',
    title: 'Environment / 環境檢測',
    group: 'General',
    summary: 'Rerun the environment check (onboarding).',
    keywords: 'environment onboarding env check rerun 環境檢測 重新檢測',
  },
  {
    id: 'general-backend-timeout',
    tab: 'general',
    section: 'general-backend-timeout',
    title: 'Backend Timeout / 後端啟動逾時',
    group: 'General',
    summary: 'Set the backend startup health-check timeout.',
    keywords: 'backend timeout health check startup 啟動逾時 後端',
  },
  {
    id: 'updates',
    tab: 'updates',
    section: 'updates',
    title: 'Updates / 更新',
    group: 'Updates',
    summary: 'Check for updates, auto-check/auto-download, and release channel.',
    keywords: 'update updates version check auto download channel stable beta release notes 更新 版本 檢查 自動下載 頻道 穩定版 測試版',
  },
  {
    id: 'general-loop-prompt',
    tab: 'general',
    section: 'general-loop-prompt',
    title: 'Loop Prompt / Loop 提示詞',
    group: 'General',
    summary: 'Edit the prompt sent to a CLI pane when its loop button is clicked, and the auto-resume prompt after a session-limit pause.',
    keywords: 'loop prompt 循環 提示詞 迴圈 continuous development 持續開發 pane button resume 續跑 session limit 上限',
  },
  {
    id: 'general-resume-behavior',
    tab: 'general',
    section: 'general-resume-behavior',
    title: 'Resume on Open / 開啟時恢復對話',
    group: 'General',
    summary: 'Whether opening a workspace resumes its previous CLI panes, starts them fresh, or asks each time.',
    keywords: 'resume restore start fresh ask workspace open session conversation 恢復 還原 開新對話 詢問 開啟 工作區 對話 續接',
  },
  {
    id: 'general-usage-badge',
    tab: 'general',
    section: 'general-usage-badge',
    title: 'CLI Quota Badge / CLI 額度徽章',
    group: 'General',
    summary: 'Show remaining CLI quota in pane headers (claude/codex/kimi/grok) and pick the refresh interval.',
    keywords: 'usage quota badge remaining limit rate window reset 額度 剩餘 用量 徽章 刷新 間隔 claude codex kimi grok',
  },
  {
    id: 'accounts',
    tab: 'accounts',
    section: 'accounts',
    title: 'Git Accounts / Git 帳號',
    group: 'Accounts',
    summary: 'Add, edit, and remove encrypted Git host credentials and tokens.',
    keywords: 'git account accounts credential credentials token github safeStorage 帳號 憑證 金鑰 加密',
  },
  {
    id: 'cli-accounts',
    tab: 'accounts',
    section: 'cli-accounts',
    title: 'CLI Accounts / CLI 帳號',
    group: 'Accounts',
    summary: 'Manage per-agent CLI login profiles (claude, codex, kimi, grok).',
    keywords: 'cli account accounts profile profiles login claude codex kimi grok agent 帳號 登入 切換帳號 profile',
  },
  {
    id: 'shortcuts',
    tab: 'shortcuts',
    section: 'shortcuts',
    title: 'Keyboard Shortcuts / 快捷鍵',
    group: 'Shortcuts',
    summary: 'Read-only reference of all keyboard shortcuts across workbench, AI chat, editor, terminal, and native menu.',
    keywords: 'keyboard shortcuts keys keybinding hotkey 快捷鍵 鍵盤 按鍵 workbench editor terminal cli ctrl cmd shift option',
  },
])

const settingsSearchResults = computed(() => {
  const q = settingsSearchQuery.value.trim().toLowerCase()
  if (!q) return []
  const terms = q.split(/\s+/).filter(Boolean)
  return settingsSearchItems.value
    .map((item) => {
      const haystack = `${item.title} ${item.group} ${item.summary} ${item.keywords}`.toLowerCase()
      const score = terms.reduce((acc, term) => acc + (haystack.includes(term) ? 1 : 0), 0)
      return { item, score }
    })
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score || a.item.title.localeCompare(b.item.title))
    .slice(0, 8)
    .map(({ item }) => item)
})

async function openSettingsSearchResult(item: SettingsSearchItem): Promise<void> {
  activeTab.value = item.tab
  if (item.tab === 'mcp' && item.mcpView) mView.value = item.mcpView
  settingsSearchQuery.value = ''
  await nextTick()
  requestAnimationFrame(() => {
    const target = document.querySelector<HTMLElement>(`[data-settings-section="${item.section}"]`)
    target?.scrollIntoView({ block: 'start', behavior: 'smooth' })
  })
}

// Git account manager (safeStorage-backed). Lazy-loaded on tab entry.
const accountsApi = useGitAccounts()

// ── AI provider credentials (shown in Analyzer tab) ──────────────────────────
const aiProviderKeys = ref({
  anthropic_api_key: '',
  openai_api_key: '',
  google_api_key: '',
  groq_api_key: '',
  deepseek_api_key: '',
  mistral_api_key: '',
  xai_api_key: '',
  openai_compatible_base_url: '',
  openai_compatible_api_key: '',
  openai_compatible_model: '',
})
const aiKeysDirty = ref(false)

// Keep old ref alive so template refs added by the subagent don't break
const aiChatApiKey = computed({
  get: () => aiProviderKeys.value.anthropic_api_key,
  set: (v: string) => { aiProviderKeys.value.anthropic_api_key = v; aiKeysDirty.value = true },
})
const aiChatApiKeyDirty = computed(() => aiKeysDirty.value)

function fetchAiChatSettings(): void {
  props.backend.send<Record<string, string>>('ai.chat.settings.get', {})
    .then(r => {
      if (!r?.ok || !r.payload) return
      const p = r.payload
      for (const k of Object.keys(aiProviderKeys.value) as (keyof typeof aiProviderKeys.value)[]) {
        if (p[k] !== undefined) aiProviderKeys.value[k] = p[k] as string
      }
      aiKeysDirty.value = false
    })
    .catch(() => {/* ignore */})
}
function saveAiChatSettings(): void {
  props.backend.send('ai.chat.settings.set', { ...aiProviderKeys.value })
    .catch(() => {/* ignore */})
  aiKeysDirty.value = false
}

// ── Appearance (theme) ────────────────────────────────────────────────────────
const {
  theme: currentTheme,
  customOverrides,
  BUILTIN_THEMES,
  CUSTOMIZABLE_TOKENS,
  setTheme,
  setCustomOverride,
  setCustomOverrides,
  resetCustom,
} = useTheme()

// ── Appearance (language) ─────────────────────────────────────────────────────
const { language: currentLanguage, setLanguage, healthCheckTimeoutSec, setHealthCheckTimeoutSec } = useSettings()

// Auto-restore workspace windows on next launch (main-process setting, stored in
// the window registry). Loaded lazily when the appearance tab is opened.
const autoRestoreWindows = ref(true)
async function loadAutoRestore(): Promise<void> {
  try {
    const v = await window.agentTeam?.restore?.getAutoRestore?.()
    if (typeof v === 'boolean') autoRestoreWindows.value = v
  } catch { /* ignore — keep the default */ }
}
async function onAutoRestoreChange(): Promise<void> {
  try { await window.agentTeam?.restore?.setAutoRestore?.(autoRestoreWindows.value) } catch { /* ignore */ }
}

const SUPPORTED_LANGUAGES = [
  { value: 'zh-TW', label: '繁體中文' },
  { value: 'en-US', label: 'English' },
]

function onHealthTimeoutChange(raw: string): void {
  const n = Number(raw)
  if (Number.isFinite(n)) setHealthCheckTimeoutSec(n)
}

// Loop prompt sent to a CLI pane when its loop button is clicked, and the
// resume prompt auto-sent after a session-limit pause once the quota resets.
const loopPromptText = ref(settingsGet(LOOP_PROMPT_SETTING_KEY, DEFAULT_LOOP_PROMPT))
function onLoopPromptChange(): void {
  settingsSet(LOOP_PROMPT_SETTING_KEY, loopPromptText.value)
}
const loopResumeText = ref(settingsGet(LOOP_RESUME_SETTING_KEY, DEFAULT_LOOP_RESUME))
function onLoopResumeChange(): void {
  settingsSet(LOOP_RESUME_SETTING_KEY, loopResumeText.value)
}

// Per-CLI quota badge (pane headers): on/off + backend poll interval.
const usageEnabledModel = ref(settingsGet<boolean>(USAGE_ENABLED_KEY, true) !== false)
function onUsageEnabledChange(): void {
  setUsageEnabled(usageEnabledModel.value)
}
const usageRefreshModel = ref(usageRefreshSec())
function onUsageRefreshChange(raw: string): void {
  const n = Number(raw)
  if ((USAGE_REFRESH_OPTIONS as readonly number[]).includes(n)) {
    usageRefreshModel.value = n
    setUsageRefreshSec(n)
  }
}

// Whether opening a workspace resumes its previous CLI panes, starts them
// fresh, or asks. Read at restore time in App.vue.
const resumeBehaviorModel = ref<ResumeBehavior>(
  normalizeResumeBehavior(settingsGet(RESUME_BEHAVIOR_SETTING_KEY, 'always'))
)
function onResumeBehaviorChange(value: string): void {
  resumeBehaviorModel.value = normalizeResumeBehavior(value)
  settingsSet(RESUME_BEHAVIOR_SETTING_KEY, resumeBehaviorModel.value)
}
const restoreScopeModel = ref<RestoreScope>(
  normalizeRestoreScope(settingsGet(RESTORE_SCOPE_SETTING_KEY, 'single'))
)
function onRestoreScopeChange(value: string): void {
  restoreScopeModel.value = normalizeRestoreScope(value)
  settingsSet(RESTORE_SCOPE_SETTING_KEY, restoreScopeModel.value)
}

// Max resume spawns that run terminal.create concurrently (the rest queue).
// Read live by useTerminal at spawn time; heavy resume bursts otherwise stack
// on the backend and time out ("request terminal.create timeout").
const resumeConcurrencyModel = ref(
  clampResumeConcurrency(settingsGet(RESUME_CONCURRENCY_SETTING_KEY, DEFAULT_RESUME_CONCURRENCY))
)
function onResumeConcurrencyChange(value: string): void {
  resumeConcurrencyModel.value = clampResumeConcurrency(value)
  settingsSet(RESUME_CONCURRENCY_SETTING_KEY, resumeConcurrencyModel.value)
}

const { confirm: notifyConfirm } = useNotify()

// ── Updates (auto-update UX) ────────────────────────────────────────────────
const {
  state: updateState,
  settings: updSettings,
  isBusy: updIsBusy,
  checkForUpdates,
  startDownload,
  installUpdate,
  updateSettings: updUpdateSettings,
} = useUpdater()

// ── Settings management / metadata ──────────────────────────────────────────
interface SettingsPaths {
  app_data_dir?: string
  roles?: string
  pipelines?: string
  mcp?: string
  skills?: string
  analyzer?: string
  ai_chat?: string
  backend_log?: string
}
const settingsPaths = ref<SettingsPaths>({})
const settingsBundleBusy = ref(false)
const settingsBundleSummary = ref('')
const settingsBundleError = ref('')

const settingsScopeNotes: Record<Tab, { scope: string; storage: keyof SettingsPaths | 'localStorage' | 'mainProcess' | 'safeStorage' }> = {
  roles: { scope: 'User', storage: 'roles' },
  pipelines: { scope: 'User', storage: 'pipelines' },
  mcp: { scope: 'User', storage: 'mcp' },
  skills: { scope: 'User', storage: 'skills' },
  analyzer: { scope: 'User', storage: 'analyzer' },
  cliAgents: { scope: 'User', storage: 'localStorage' },
  general: { scope: 'User', storage: 'localStorage' },
  updates: { scope: 'User', storage: 'mainProcess' },
  appearance: { scope: 'User', storage: 'localStorage' },
  accounts: { scope: 'User / Workspace bindings', storage: 'safeStorage' },
  shortcuts: { scope: 'User', storage: 'localStorage' },
  extensions: { scope: 'User', storage: 'mainProcess' },
}

async function loadSettingsPaths(): Promise<void> {
  try {
    const resp = await props.backend.send<{ paths: SettingsPaths }>('settings.paths', {})
    if (resp.ok && resp.payload?.paths) settingsPaths.value = resp.payload.paths
  } catch { /* non-fatal */ }
}

function pathForTab(tab: Tab): string {
  const storage = settingsScopeNotes[tab].storage
  if (storage === 'localStorage') return 'ui_settings.json (app data) + workspace backup'
  if (storage === 'mainProcess') return 'Electron main process userData'
  if (storage === 'safeStorage') return 'Encrypted local safeStorage registry'
  return settingsPaths.value[storage] ?? ''
}

async function openSettingsPath(path?: string): Promise<void> {
  if (!path) return
  await window.agentTeam?.openPath?.(path)
}

function stampForFile(): string {
  return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
}

async function exportSettingsBundle(): Promise<void> {
  if (!window.agentTeam?.saveJson) return
  settingsBundleBusy.value = true
  settingsBundleError.value = ''
  try {
    const resp = await props.backend.send<{ bundle: Record<string, unknown> }>('settings.bundle.export', {})
    if (!resp.ok || !resp.payload?.bundle) {
      settingsBundleError.value = resp.error?.message ?? 'Export failed'
      return
    }
    const bundle = {
      ...resp.payload.bundle,
      appearance: {
        theme: currentTheme.value,
        theme_custom: customOverrides.value,
        language: currentLanguage.value,
        health_check_timeout_sec: healthCheckTimeoutSec.value,
        auto_restore_windows: autoRestoreWindows.value,
      },
    }
    const result = await window.agentTeam.saveJson({
      title: 'Export settings bundle',
      defaultName: `agent-team-settings-${stampForFile()}.json`,
      content: JSON.stringify(bundle, null, 2),
    })
    if (result.ok) settingsBundleSummary.value = 'Settings bundle exported'
  } catch (err) {
    settingsBundleError.value = err instanceof Error ? err.message : 'Export failed'
  } finally {
    settingsBundleBusy.value = false
  }
}

async function importSettingsBundle(): Promise<void> {
  if (!window.agentTeam?.openJson) return
  settingsBundleBusy.value = true
  settingsBundleError.value = ''
  try {
    const result = await window.agentTeam.openJson({ title: 'Import settings bundle JSON' })
    if (!result.ok || !result.content) return
    const bundle = JSON.parse(result.content) as Record<string, unknown>
    const resp = await props.backend.send<{ applied: string[]; paths: SettingsPaths }>('settings.bundle.import', { bundle })
    if (!resp.ok) {
      settingsBundleError.value = resp.error?.message ?? 'Import failed'
      return
    }
    const appearance = bundle.appearance as Record<string, unknown> | undefined
    if (appearance) {
      if (typeof appearance.theme === 'string') setTheme(appearance.theme)
      if (appearance.theme_custom && typeof appearance.theme_custom === 'object') {
        setCustomOverrides(appearance.theme_custom as Record<string, string>)
      }
      if (typeof appearance.language === 'string') setLanguage(appearance.language)
      if (typeof appearance.health_check_timeout_sec === 'number') setHealthCheckTimeoutSec(appearance.health_check_timeout_sec)
      if (typeof appearance.auto_restore_windows === 'boolean') {
        autoRestoreWindows.value = appearance.auto_restore_windows
        await onAutoRestoreChange()
      }
    }
    if (resp.payload?.paths) settingsPaths.value = resp.payload.paths
    await Promise.all([
      props.rolesApi.refresh(),
      props.stagesApi.refresh(),
      props.pipelinesApi?.refresh() ?? Promise.resolve(),
      props.analyzerApi.refreshSettings(),
    ])
    fetchAiChatSettings()
    const applied = resp.payload?.applied ?? []
    if (shouldReloadMcpAfterBundleImport(applied)) await mLoad(true)
    settingsBundleSummary.value = `Imported: ${applied.join(', ') || 'appearance'}`
  } catch (err) {
    settingsBundleError.value = err instanceof Error ? err.message : 'Import failed'
  } finally {
    settingsBundleBusy.value = false
  }
}

interface ProviderTestState { busy?: boolean; ok?: boolean; message?: string }
const aiProviderTests = ref<Record<string, ProviderTestState>>({})

function aiProviderTestState(provider: string): ProviderTestState {
  return aiProviderTests.value[provider] ?? {}
}

async function testAiProvider(provider: string): Promise<void> {
  aiProviderTests.value = {
    ...aiProviderTests.value,
    [provider]: { busy: true, message: 'Testing…' },
  }
  try {
    const resp = await props.backend.send<{ ok: boolean; message: string }>('ai.chat.provider.test', {
      provider,
      settings: { ...aiProviderKeys.value },
    }, 15_000)
    const payload = resp.payload
    aiProviderTests.value = {
      ...aiProviderTests.value,
      [provider]: {
        busy: false,
        ok: !!(resp.ok && payload?.ok),
        message: payload?.message ?? resp.error?.message ?? 'Test failed',
      },
    }
  } catch (err) {
    aiProviderTests.value = {
      ...aiProviderTests.value,
      [provider]: { busy: false, ok: false, message: err instanceof Error ? err.message : 'Test failed' },
    }
  }
}

// Live value bound to each color picker. Seeded from the override map; when an
// override is absent we fall back to the resolved computed token value so the
// picker shows the current built-in theme's color.
function resolvedTokenValue(token: string): string {
  if (customOverrides.value[token]) return customOverrides.value[token]
  if (typeof document === 'undefined') return '#000000'
  const v = getComputedStyle(document.documentElement).getPropertyValue(token).trim()
  return normalizeHex(v) || '#000000'
}

// <input type="color"> only accepts #rrggbb. Coerce common forms; bail to '' if
// the value can't be represented (e.g. a var() reference or rgba()).
function normalizeHex(v: string): string {
  const s = v.trim()
  if (/^#[0-9a-fA-F]{6}$/.test(s)) return s.toLowerCase()
  if (/^#[0-9a-fA-F]{3}$/.test(s)) {
    return ('#' + s.slice(1).split('').map((c) => c + c).join('')).toLowerCase()
  }
  return ''
}

// Debounced live preview: apply the override 300ms after the last picker input
// so dragging the color wheel doesn't thrash the DOM / localStorage.
let previewTimer: ReturnType<typeof setTimeout> | null = null
function onPickColor(token: string, value: string): void {
  if (previewTimer) clearTimeout(previewTimer)
  const hex = normalizeHex(value)
  previewTimer = setTimeout(() => setCustomOverride(token, hex || null), 300)
}

const hasCustomOverrides = computed(() => Object.keys(customOverrides.value).length > 0)

// Preview-only representative colors per theme [bg, surface, accent, success].
// Used to render the theme cards without having to apply each theme.
const THEME_SWATCHES: Record<string, string[]> = {
  'dark-github': ['#0d1117', '#161b22', '#58a6ff', '#3fb950'],
  'dark-midnight': ['#0a0e14', '#11161f', '#6cb0ff', '#4ad07a'],
  'dark-forest': ['#0c130d', '#121a13', '#6fc28a', '#56d364'],
  light: ['#ffffff', '#f6f8fa', '#0969da', '#1a7f37'],
  'high-contrast': ['#0a0c10', '#14171c', '#71b7ff', '#4ae168'],
}

// Close on ESC
function onKeyDown(e: KeyboardEvent) { if (e.key === 'Escape') emit('close') }
onMounted(() => {
  window.addEventListener('keydown', onKeyDown)
  void loadSettingsPaths()
})
onUnmounted(() => {
  window.removeEventListener('keydown', onKeyDown)
  if (previewTimer) { clearTimeout(previewTimer); previewTimer = null }
})

// ══════════════════════════════════════════════════════════════════════════════
// ROLES TAB
// ══════════════════════════════════════════════════════════════════════════════

interface DraftRole {
  key: string; label: string; one_line: string; system_prompt: string
  isNew: boolean; originalKey: string
}

// ── Analyzer tab local state ──────────────────────────────────────────────────
const azPullName = ref('')
const azRechecking = ref(false)
const azDetecting = ref(false)
async function azDetectCli() {
  azDetecting.value = true
  try {
    const result = await props.analyzerApi.detectLlamaCli()
    if (result.recommended) {
      await props.analyzerApi.saveSettings({ llama_cli: result.recommended })
    }
  } finally {
    azDetecting.value = false
  }
}
async function azPickCli() {
  const result = await window.agentTeam?.pickFile?.({
    title: 'Select llama-cli executable',
    filters: [{ name: 'Executable', extensions: ['*'] }],
    defaultPath: '/opt/homebrew/bin',
  })
  if (result?.ok && result.path) {
    await props.analyzerApi.saveSettings({ llama_cli: result.path })
  }
}
async function azPickGguf() {
  const result = await window.agentTeam?.pickFile?.({
    title: 'Select GGUF model file',
    filters: [{ name: 'GGUF Model', extensions: ['gguf'] }, { name: 'All Files', extensions: ['*'] }],
  })
  if (result?.ok && result.path) {
    await props.analyzerApi.saveSettings({ gguf_path: result.path })
  }
}
async function azRecheck() {
  azRechecking.value = true
  try {
    await Promise.all([
      props.analyzerApi.refreshHealth(),
      props.analyzerApi.refreshOllamaHealth(),
      props.analyzerApi.refreshModels(),
    ])
  } finally {
    azRechecking.value = false
  }
}
async function azDoPull() {
  const name = azPullName.value.trim()
  if (!name) return
  azPullName.value = ''
  await props.analyzerApi.pullModel(name)
}
async function azDoDelete(name: string) {
  await props.analyzerApi.deleteModel(name)
}

const rSelectedKey = ref<string | null>(null)
const rDraft = ref<DraftRole | null>(null)
const rSaving = ref(false)
const rError = ref('')
const rConfirmDelete = ref(false)
const rConfirmReset = ref(false)
const rSummary = ref('')
const rImporting = ref(false)
const rExportBusy = ref(false)

const rSorted = computed(() =>
  [...props.rolesApi.roles.value].sort((a, b) => a.label.localeCompare(b.label))
)

watch(() => props.rolesApi.roles.value, (rs) => {
  if (rs.length > 0 && rSelectedKey.value === null) rSelectKey(rs[0].key)
  else if (rSelectedKey.value && !rs.find(r => r.key === rSelectedKey.value))
    rSelectKey(rs[0]?.key ?? null)
}, { deep: false })

function rFromRole(r: ReturnType<typeof props.rolesApi.find>, isNew: boolean): DraftRole {
  return { key: r!.key, label: r!.label, one_line: r!.one_line, system_prompt: r!.system_prompt, isNew, originalKey: isNew ? '' : r!.key }
}
function rSelectKey(key: string | null) {
  rSelectedKey.value = key; rError.value = ''
  if (!key) { rDraft.value = null; return }
  const r = props.rolesApi.find(key)
  if (r) rDraft.value = rFromRole(r, false)
}
function rStartNew() {
  rSelectedKey.value = null; rError.value = ''
  rDraft.value = { key: '', label: '', one_line: '', system_prompt: '# Role: \nYou are a...\n\n# Guidelines:\n1. ...\n\n# Output Format:\n...', isNew: true, originalKey: '' }
}

const rIsDirty = computed(() => {
  if (!rDraft.value) return false
  if (rDraft.value.isNew) return true
  const r = props.rolesApi.find(rDraft.value.originalKey)
  if (!r) return true
  return r.label !== rDraft.value.label || r.one_line !== rDraft.value.one_line || r.system_prompt !== rDraft.value.system_prompt || r.key !== rDraft.value.key
})
const rCanSave = computed(() => {
  if (!rDraft.value) return false
  if (!rDraft.value.key.trim() || !rDraft.value.label.trim() || !rDraft.value.system_prompt.trim()) return false
  // Block if the target key is already taken by a DIFFERENT role (covers both new and rename).
  const existing = props.rolesApi.find(rDraft.value.key.trim())
  if (existing && existing.key !== rDraft.value.originalKey) return false
  return rIsDirty.value
})

async function rSave() {
  if (!rDraft.value || !rCanSave.value) return
  rSaving.value = true; rError.value = ''
  const payload = { key: rDraft.value.key.trim(), label: rDraft.value.label.trim(), one_line: rDraft.value.one_line.trim(), system_prompt: rDraft.value.system_prompt }
  const wasRename = !rDraft.value.isNew && rDraft.value.originalKey && rDraft.value.originalKey !== payload.key
  try {
    if (wasRename) {
      const role = await props.rolesApi.upsert(payload)
      if (role) { await props.rolesApi.remove(rDraft.value.originalKey); rSelectKey(role.key) }
    } else {
      const role = await props.rolesApi.upsert(payload)
      if (role) rSelectKey(role.key)
    }
    rSummary.value = `Saved "${payload.label}"`
  } catch (err) { rError.value = String((err as Error).message ?? err) }
  finally { rSaving.value = false }
}
async function rDoDelete() {
  if (!rDraft.value || rDraft.value.isNew) { rConfirmDelete.value = false; return }
  const ok = await props.rolesApi.remove(rDraft.value.originalKey || rDraft.value.key)
  rConfirmDelete.value = false
  if (ok) rSelectKey(rSorted.value[0]?.key ?? null)
  else rError.value = props.rolesApi.error.value
}
async function rDoReset() {
  const ok = await props.rolesApi.reset()
  rConfirmReset.value = false
  if (ok) rSelectKey(rSorted.value[0]?.key ?? null)
}
async function rExport() {
  if (!window.agentTeam?.saveJson) return
  rExportBusy.value = true
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const envelope = { format_version: 1, exported_at: new Date().toISOString(), roles: props.rolesApi.roles.value }
  const result = await window.agentTeam.saveJson({ title: 'Export roles', defaultName: `agent-team-roles-${stamp}.json`, content: JSON.stringify(envelope, null, 2) })
  if (result.ok) rSummary.value = `Exported ${envelope.roles.length} role(s)`
  rExportBusy.value = false
}
async function rImport() {
  if (!window.agentTeam?.openJson) return
  rImporting.value = true
  const result = await window.agentTeam.openJson({ title: 'Import roles JSON' })
  if (result.ok && result.content) {
    try {
      const parsed = JSON.parse(result.content)
      const raw: unknown[] = Array.isArray(parsed) ? parsed : (Array.isArray(parsed?.roles) ? parsed.roles : [])
      let ok = 0
      for (const entry of raw) {
        const e = entry as Record<string, unknown>
        if (typeof e?.key === 'string' && e.key && typeof e.system_prompt === 'string')
          if (await props.rolesApi.upsert({ key: e.key as string, label: String(e.label ?? e.key), one_line: String(e.one_line ?? ''), system_prompt: e.system_prompt as string })) ok++
      }
      rSummary.value = `Imported ${ok} role(s)`
    } catch (err) { rError.value = `Invalid JSON: ${(err as Error).message}` }
  }
  rImporting.value = false
}

// ══════════════════════════════════════════════════════════════════════════════
// STAGES TAB
// ══════════════════════════════════════════════════════════════════════════════

const AGENT_OPTIONS = [
  { key: 'claude', label: 'Claude Code' },
  { key: 'codex', label: 'Codex' },
  { key: 'antigravity', label: 'Antigravity CLI' }
]

const sSelectedId = ref<string | null>(null)
const sDraft = ref<Stage | null>(null)
const sIsNew = ref(false)
const sSaving = ref(false)
const sError = ref('')
const sConfirmDelete = ref(false)
const sConfirmReset = ref(false)
const sSummary = ref('')
const sExportBusy = ref(false)
const sImporting = ref(false)
const sAddingSlot = ref(false)
const sSlotDraft = ref<StageSlot>({ agentKey: 'claude', roleKey: '', label: '', kickoffBody: '', isCommander: false })

const sIsDirty = computed(() => {
  if (!sDraft.value) return false
  if (sIsNew.value) return true
  const orig = sActiveStages.value.find(s => s.id === sDraft.value!.id)
  if (!orig) return true
  return JSON.stringify(stageToBackend(sDraft.value)) !== JSON.stringify(stageToBackend(orig))
})
const sCanSave = computed(() => {
  if (!sDraft.value || !sDraft.value.id.trim() || !sDraft.value.title.trim()) return false
  if (!sDraft.value.slots || sDraft.value.slots.length === 0) return false
  if (sIsNew.value && sActiveStages.value.find(s => s.id === sDraft.value!.id.trim())) return false
  return sIsDirty.value
})

// Only auto-select first stage when in the global stages view (not pipeline detail)
watch(() => props.stagesApi.stages.value, (ss) => {
  if (plView.value === 'detail') return
  if (ss.length > 0 && sSelectedId.value === null) sSelectStage(ss[0].id)
  else if (sSelectedId.value && !ss.find(s => s.id === sSelectedId.value)) sSelectStage(ss[0]?.id ?? null)
}, { deep: false })

function sSelectStage(id: string | null) {
  sSelectedId.value = id; sError.value = ''; sAddingSlot.value = false; sEditingSlotIndex.value = null
  if (!id) { sDraft.value = null; return }
  const s = sActiveStages.value.find(s => s.id === id)
  if (s) { sDraft.value = JSON.parse(JSON.stringify(s)); sIsNew.value = false }
}
function sStartNew() {
  sSelectedId.value = null; sError.value = ''; sAddingSlot.value = false; sIsNew.value = true
  sDraft.value = {
    id: '', title: '', shortTitle: '', question: '', description: '',
    recommendedRoles: [], sentinel: '', allowQuestions: false, docQuery: '', slots: [],
  }
}
function sPipelineIdParam() {
  return plView.value === 'detail' ? { pipeline_id: plEditingId.value } : {}
}

async function sSave() {
  if (!sDraft.value || !sCanSave.value) return
  sSaving.value = true; sError.value = ''
  try {
    const payload = stageToBackend({ ...sDraft.value, id: sDraft.value.id.trim() })
    const resp = await props.backend.send<{ stage: Record<string, unknown> }>(
      'stages.upsert', { stage: payload, ...sPipelineIdParam() }
    )
    if (!resp.ok) { sError.value = resp.error?.message ?? 'Save failed'; return }
    sSummary.value = `Saved "${sDraft.value.title}"`
    sSelectedId.value = sDraft.value.id.trim()
    sIsNew.value = false
    if (plView.value === 'detail') await plReloadStages()
  } catch (err) {
    sError.value = err instanceof Error ? err.message : 'Save failed'
  } finally { sSaving.value = false }
}
async function sDoDelete() {
  if (!sDraft.value || sIsNew.value) { sConfirmDelete.value = false; return }
  try {
    const resp = await props.backend.send<{ stages: unknown[] }>(
      'stages.delete', { id: sDraft.value.id, ...sPipelineIdParam() }
    )
    sConfirmDelete.value = false
    if (!resp.ok) { sError.value = resp.error?.message ?? 'Delete failed'; return }
    sSummary.value = `Deleted "${sDraft.value.id}"`
    if (plView.value === 'detail') {
      await plReloadStages()
      sSelectStage(plStages.value[0]?.id ?? null)
    } else {
      sSelectStage(props.stagesApi.stages.value[0]?.id ?? null)
    }
  } catch (err) {
    sConfirmDelete.value = false
    sError.value = err instanceof Error ? err.message : 'Delete failed'
  }
}
async function sDoReset() {
  try {
    const resp = await props.backend.send<{ stages: unknown[] }>(
      'stages.reset', { ...sPipelineIdParam() }
    )
    sConfirmReset.value = false
    if (!resp.ok) { sError.value = resp.error?.message ?? 'Reset failed'; return }
    sSummary.value = 'Reset to factory defaults'
    if (plView.value === 'detail') {
      await plReloadStages()
      sSelectStage(plStages.value[0]?.id ?? null)
    } else {
      sSelectStage(props.stagesApi.stages.value[0]?.id ?? null)
    }
  } catch (err) {
    sConfirmReset.value = false
    sError.value = err instanceof Error ? err.message : 'Reset failed'
  }
}
async function sMoveUp(index: number) {
  if (index <= 0) return
  const ids = sActiveStages.value.map(s => s.id)
  ;[ids[index - 1], ids[index]] = [ids[index], ids[index - 1]]
  try {
    await props.backend.send('stages.reorder', { ids, ...sPipelineIdParam() })
    if (plView.value === 'detail') await plReloadStages()
  } catch { /* ignore transient WS errors for reorder */ }
}
async function sMoveDown(index: number) {
  if (index >= sActiveStages.value.length - 1) return
  const ids = sActiveStages.value.map(s => s.id)
  ;[ids[index], ids[index + 1]] = [ids[index + 1], ids[index]]
  try {
    await props.backend.send('stages.reorder', { ids, ...sPipelineIdParam() })
    if (plView.value === 'detail') await plReloadStages()
  } catch { /* ignore transient WS errors for reorder */ }
}
const sEditingSlotIndex = ref<number | null>(null)

function sStartAddSlot() {
  sAddingSlot.value = true
  sEditingSlotIndex.value = null
  sSlotDraft.value = { agentKey: 'claude', roleKey: '', label: '', kickoffBody: '', isCommander: false }
}
function sCancelAddSlot() { sAddingSlot.value = false; sEditingSlotIndex.value = null }
async function sConfirmAddSlot() {
  if (!sDraft.value || !sSlotDraft.value.label.trim()) return
  if (!sDraft.value.slots) sDraft.value.slots = []
  sDraft.value.slots.push({ ...sSlotDraft.value })
  sAddingSlot.value = false
  await sSave()
}
function sStartEditSlot(index: number) {
  sEditingSlotIndex.value = index
  sAddingSlot.value = false
  sSlotDraft.value = { ...sDraft.value!.slots![index] }
}
async function sSaveEditSlot() {
  if (!sDraft.value?.slots || sEditingSlotIndex.value === null) return
  sDraft.value.slots[sEditingSlotIndex.value] = { ...sSlotDraft.value }
  sEditingSlotIndex.value = null
  await sSave()
}
async function sRemoveSlot(index: number) {
  if (!sDraft.value?.slots || sDraft.value.slots.length <= 1) return  // must keep at least one
  if (sEditingSlotIndex.value === index) sEditingSlotIndex.value = null
  sDraft.value.slots.splice(index, 1)
  await sSave()
}
async function sExport() {
  if (!window.agentTeam?.saveJson) return
  sExportBusy.value = true
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const envelope = { format_version: 1, exported_at: new Date().toISOString(), stages: sActiveStages.value }
  const result = await window.agentTeam.saveJson({ title: 'Export stages', defaultName: `agent-team-stages-${stamp}.json`, content: JSON.stringify(envelope, null, 2) })
  if (result.ok) sSummary.value = `Exported ${envelope.stages.length} stage(s)`
  sExportBusy.value = false
}
async function sImport() {
  if (!window.agentTeam?.openJson) return
  sImporting.value = true
  const result = await window.agentTeam.openJson({ title: 'Import stages JSON' })
  if (result.ok && result.content) {
    try {
      const parsed = JSON.parse(result.content)
      const raw: unknown[] = Array.isArray(parsed) ? parsed : (Array.isArray(parsed?.stages) ? parsed.stages : [])
      let ok = 0, failed = 0
      for (const entry of raw) {
        const s = entry as Record<string, unknown>
        if (!s.id) { failed++; continue }
        const resp = await props.backend.send('stages.upsert', { stage: s, ...sPipelineIdParam() })
        if (resp.ok) ok++; else failed++
      }
      sSummary.value = `Imported ${ok} stage(s)` + (failed ? ` · ${failed} failed` : '')
    } catch (err) { sError.value = `Invalid JSON: ${(err as Error).message}` }
  }
  sImporting.value = false
}

// ══════════════════════════════════════════════════════════════════════════════
// MCP TAB
// ══════════════════════════════════════════════════════════════════════════════

interface McpTool { name: string; description: string }
interface McpServer {
  name: string
  transport: McpTransport
  command?: string
  args?: string[]
  env?: Record<string, string>
  url?: string
  headers?: Record<string, string>
  enabled: boolean
  // Live fields (returned by backend, not saved):
  status?: 'connected' | 'error' | 'disabled' | 'unknown'
  tool_count?: number; tools?: McpTool[]
}
// CatalogEntry type alias (re-exported from mcpCatalog.ts)
type CatalogEntry = McpCatalogEntry

type MView = 'list' | 'catalog' | 'custom'
const mView = ref<MView>('list')
const mSearch = ref('')
const mServers = ref<McpServer[]>([])
const mLoading = ref(false)
const mSaving = ref(false)
const mError = ref('')
const mSummary = ref('')
const mConfigPath = ref('')
const mRevision = ref<string | null>(null)
const mConflict = ref(false)
const mCustomName = ref('')
const mCustomTransport = ref<McpTransport>('stdio')
const mCustomCommand = ref('')
const mCustomUrl = ref('')
const mVisibleSecrets = ref<Set<string>>(new Set())
const mDirty = ref(false)
let mEditVersion = 0
const mExpanded = ref<Set<string>>(new Set())   // servers with tools list open
const mExpandedEnv = ref<Set<string>>(new Set()) // servers with env editor open

const mFilteredCatalog = computed(() => {
  const q = mSearch.value.trim().toLowerCase()
  return q ? MCP_CATALOG.filter(c => c.name.includes(q) || c.label.toLowerCase().includes(q) || c.description.includes(q))
           : MCP_CATALOG
})

function mIsInstalled(name: string) {
  return isMcpInstalled(mServers.value.map(s => s.name), name)
}

function mNormalizeServer(server: Partial<McpServer> & { name: string; enabled: boolean }): McpServer {
  const transport: McpTransport = server.transport === 'http' || server.transport === 'sse'
    ? server.transport
    : 'stdio'
  if (transport === 'stdio') {
    return {
      ...server,
      transport,
      command: server.command ?? '',
      args: Array.isArray(server.args) ? server.args : [],
      env: server.env ?? {},
    }
  }
  return {
    ...server,
    transport,
    url: server.url ?? '',
    headers: server.headers ?? {},
  }
}

function mSerializedServer(server: McpServer): Record<string, unknown> {
  const common = { name: server.name, transport: server.transport, enabled: server.enabled }
  if (server.transport === 'stdio') {
    return {
      ...common,
      command: server.command ?? '',
      args: [...(server.args ?? [])],
      env: { ...(server.env ?? {}) },
    }
  }
  return { ...common, url: server.url ?? '', headers: { ...(server.headers ?? {}) } }
}

function mServerForTransport(name: string, transport: McpTransport, endpoint: string): McpServer {
  return transport === 'stdio'
    ? { name, transport, command: endpoint, args: [], env: {}, enabled: true }
    : { name, transport, url: endpoint, headers: {}, enabled: true }
}

interface McpQueuedDraft {
  servers: Record<string, unknown>[]
  silent: boolean
  editVersion: number
}

function mMarkDirty(): void {
  mDirty.value = true
  mEditVersion += 1
}

async function mLoad(force = false) {
  if (!force && (mDirty.value || mAutosaveQueue.pending > 0)) return
  if (force) mDirty.value = false
  mLoading.value = true; mError.value = ''; mConflict.value = false
  try {
    const resp = await props.backend.send<{ servers: McpServer[]; path?: string; revision: string }>('mcp.list_servers', {})
    if (resp.ok && resp.payload) {
      mServers.value = resp.payload.servers.map(mNormalizeServer)
      mConfigPath.value = resp.payload.path ?? ''
      mRevision.value = resp.payload.revision
    } else { mError.value = resp.error?.message ?? 'Load failed' }
  } catch (err) { mError.value = String((err as Error).message ?? err) }
  finally { mLoading.value = false }
}

async function mRefreshLive(): Promise<void> {
  try {
    const resp = await props.backend.send<{ servers: McpServer[]; path?: string; revision: string }>('mcp.list_servers', {})
    if (!resp.ok || !resp.payload) {
      mError.value = resp.error?.message ?? 'Load failed'
      return
    }
    const liveByName = new Map(resp.payload.servers.map((server) => [server.name, server]))
    for (const server of mServers.value) {
      const live = liveByName.get(server.name)
      server.status = live?.status ?? 'unknown'
      server.tool_count = live?.tool_count
      server.tools = live?.tools
    }
    mConfigPath.value = resp.payload.path ?? mConfigPath.value
    mRevision.value = resp.payload.revision
  } catch (err) {
    mError.value = String((err as Error).message ?? err)
  }
}

const mAutosaveQueue = new RevisionedMcpSaveQueue<McpQueuedDraft>(
  (snapshot, expectedRevision) => mSaveNow(snapshot, expectedRevision),
  async (lastSnapshot) => {
    if (mEditVersion === lastSnapshot.editVersion) mDirty.value = false
    await mRefreshLive()
  }
)

function mSave(silent = false): Promise<boolean> {
  mMarkDirty()
  return mAutosaveQueue.enqueue(
    {
      servers: mServers.value.map(mSerializedServer),
      silent,
      editVersion: mEditVersion,
    },
    mRevision.value
  )
}

async function mSaveNow(
  snapshot: McpQueuedDraft,
  expectedRevision: string | null
): Promise<RevisionedMcpSaveOutcome> {
  mSaving.value = true; mError.value = ''; mSummary.value = ''; mConflict.value = false
  try {
    const resp = await props.backend.send<{ ok?: boolean; revision?: string; conflict?: boolean; error?: string }>(
      'mcp.save_servers',
      { servers: snapshot.servers, expected_revision: expectedRevision }
    )
    if (resp.ok && resp.payload?.ok !== false) {
      mRevision.value = resp.payload?.revision ?? mRevision.value
      if (!snapshot.silent) mSummary.value = 'Saved — MCP Manager restarting…'
      return { ok: true, revision: mRevision.value }
    }
    mConflict.value = resp.payload?.conflict === true || resp.error?.code === 'MCP_SETTINGS_CONFLICT'
    mError.value = resp.payload?.error
      ?? resp.error?.message
      ?? (mConflict.value ? 'The MCP settings changed on disk. Reload before saving.' : 'Save failed')
    return { ok: false }
  } catch (err) { mError.value = String((err as Error).message ?? err) }
  finally { mSaving.value = false }
  return { ok: false }
}

async function mAddFromCatalog(entry: CatalogEntry) {
  if (mIsInstalled(entry.name)) return
  const server: McpServer = { name: entry.name, transport: 'stdio', command: entry.command, args: [...entry.args], env: { ...entry.env }, enabled: true }
  mServers.value.push(server)
  if (await mSave(true)) {
    mView.value = 'list'
    mSummary.value = `Added ${entry.label}`
  } else {
    mServers.value = mServers.value.filter((item) => item !== server)
  }
  // Auto-expand env editor if this server needs env vars filled
  if (entry.requiresEnv?.length) mExpandedEnv.value = new Set([...mExpandedEnv.value, entry.name])
}

async function mCreateCustom() {
  const name = mCustomName.value.trim()
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(name)) {
    mError.value = 'Server name must use lowercase letters, digits, dashes, or underscores.'
    return
  }
  if (mIsInstalled(name)) {
    mError.value = `A server named "${name}" already exists.`
    return
  }
  const endpoint = mCustomTransport.value === 'stdio' ? mCustomCommand.value.trim() : mCustomUrl.value.trim()
  if (!endpoint) {
    mError.value = mCustomTransport.value === 'stdio' ? 'Command is required.' : 'URL is required.'
    return
  }
  const server = mServerForTransport(name, mCustomTransport.value, endpoint)
  mServers.value.push(server)
  if (await mSave(true)) {
    mCustomName.value = ''
    mCustomTransport.value = 'stdio'
    mCustomCommand.value = ''
    mCustomUrl.value = ''
    mExpandedEnv.value = new Set([...mExpandedEnv.value, name])
    mView.value = 'list'
  } else {
    mServers.value = mServers.value.filter((item) => item !== server)
  }
}

async function mRemoveServer(idx: number) {
  const name = mServers.value[idx]?.name
  mServers.value.splice(idx, 1)
  if (name) {
    const s1 = new Set(mExpanded.value); s1.delete(name); mExpanded.value = s1
    const s2 = new Set(mExpandedEnv.value); s2.delete(name); mExpandedEnv.value = s2
  }
  await mSave(true)
}

async function mToggleEnabled(srv: McpServer) {
  srv.enabled = !srv.enabled
  await mSave(true)
}

function mToggleTools(name: string) {
  const s = new Set(mExpanded.value)
  s.has(name) ? s.delete(name) : s.add(name)
  mExpanded.value = s
}

function mToggleEnv(name: string) {
  const s = new Set(mExpandedEnv.value)
  s.has(name) ? s.delete(name) : s.add(name)
  mExpandedEnv.value = s
}

function mChangeTransport(server: McpServer, transport: McpTransport) {
  switchMcpTransportShape(server, transport)
  void mSave(true)
}

function mRecordEntries(record?: Record<string, string>): [string, string][] {
  return Object.entries(record ?? {})
}
function mEnvRecord(server: McpServer): Record<string, string> { return (server.env ??= {}) }
function mHeaderRecord(server: McpServer): Record<string, string> { return (server.headers ??= {}) }
function mSetRecordKey(record: Record<string, string>, oldKey: string, newKey: string) {
  const key = newKey.trim()
  if (!key || (key !== oldKey && key in record)) return
  const val = record[oldKey] ?? ''
  delete record[oldKey]; record[key] = val
}
function mAddRecordEntry(record: Record<string, string>, base: string) {
  record[nextRecordKey(record, base)] = ''
  mMarkDirty()
}
function mDeleteRecordEntry(record: Record<string, string>, key: string) { delete record[key] }
function mAddArg(server: McpServer) { (server.args ??= []).push(''); mMarkDirty() }
function mSetArg(server: McpServer, index: number, value: string) { (server.args ??= [])[index] = value; mMarkDirty() }
function mDeleteArg(server: McpServer, index: number) { server.args?.splice(index, 1) }
function mSetRecordValue(record: Record<string, string>, key: string, value: string) {
  record[key] = value
  mMarkDirty()
}
function mSecretId(server: McpServer, kind: 'env' | 'header', key: string) {
  return `${server.name}\u0000${kind}\u0000${key}`
}
function mSecretVisible(server: McpServer, kind: 'env' | 'header', key: string): boolean {
  return mVisibleSecrets.value.has(mSecretId(server, kind, key))
}
function mToggleSecret(server: McpServer, kind: 'env' | 'header', key: string) {
  const id = mSecretId(server, kind, key)
  const next = new Set(mVisibleSecrets.value)
  next.has(id) ? next.delete(id) : next.add(id)
  mVisibleSecrets.value = next
}

async function mOpenConfig() {
  if (mConfigPath.value) await (window as any).agentTeam.openPath(mConfigPath.value)
}

watch(activeTab, (tab) => {
  if (tab === 'mcp' && mServers.value.length === 0) mLoad()
  if (tab === 'analyzer') fetchAiChatSettings()
  if (tab === 'appearance') void loadAutoRestore()
  if (tab === 'accounts') void accountsApi.refresh()
})

// ══════════════════════════════════════════════════════════════════════════════
// PIPELINES TAB
// ══════════════════════════════════════════════════════════════════════════════

// ── List view ──
const plNewName = ref('')
const plCreating = ref(false)
const plBusy = ref(false)
const plSummary = ref('')

// ── Detail view (pipeline + stage editor) ──
const plView = ref<'list' | 'detail'>('list')
const plEditingId = ref<string>('')
const plStages = ref<Stage[]>([])   // stages for the pipeline being edited
const plStagesLoading = ref(false)
const plRenamingId = ref('')
const plRenameText = ref('')

const plCurrentPipeline = computed(() =>
  props.pipelinesApi?.pipelines.value.find(p => p.id === plEditingId.value) ?? null
)

// Stages to use in the stage editor — plStages when in pipeline detail, global otherwise
const sActiveStages = computed(() =>
  plView.value === 'detail' ? plStages.value : props.stagesApi.stages.value
)

async function plEnterDetail(id: string) {
  plEditingId.value = id
  plView.value = 'detail'
  sSelectedId.value = null
  sDraft.value = null
  sIsNew.value = false
  sError.value = ''
  plStagesLoading.value = true
  try {
    const resp = await props.backend.send<{ stages: Record<string, unknown>[] }>(
      'stages.list', { pipeline_id: id }
    )
    if (resp.ok && resp.payload) {
      plStages.value = resp.payload.stages.map(stageDefToFrontend)
      if (plStages.value.length > 0) sSelectStage(plStages.value[0].id)
    }
  } catch (err) {
    sError.value = err instanceof Error ? err.message : 'Load failed'
  } finally {
    plStagesLoading.value = false
  }
}

function plBackToList() {
  plView.value = 'list'
  plEditingId.value = ''
  plStages.value = []
  sSelectedId.value = null
  sDraft.value = null
}

async function plReloadStages() {
  if (!plEditingId.value) return
  try {
    const resp = await props.backend.send<{ stages: Record<string, unknown>[] }>(
      'stages.list', { pipeline_id: plEditingId.value }
    )
    if (resp.ok && resp.payload) {
      plStages.value = resp.payload.stages.map(stageDefToFrontend)
    }
  } catch { /* ignore transient WS errors */ }
}

async function plCreate() {
  if (!plNewName.value.trim() || plBusy.value) return
  plBusy.value = true
  try {
    const p = await props.pipelinesApi?.createPipeline(plNewName.value.trim())
    if (p) { plNewName.value = ''; plCreating.value = false; plSummary.value = `Created "${p.name}"` }
  } finally {
    plBusy.value = false
  }
}

async function plSetActive(id: string) {
  if (plBusy.value) return
  plBusy.value = true
  try {
    await props.pipelinesApi?.setActivePipeline(id)
    plSummary.value = 'Default pipeline updated'
  } finally {
    plBusy.value = false
  }
}

function plStartRename(id: string, currentName: string) {
  plRenamingId.value = id
  plRenameText.value = currentName
}

async function plConfirmRename() {
  if (!plRenameText.value.trim() || plBusy.value) return
  plBusy.value = true
  try {
    await props.pipelinesApi?.renamePipeline(plRenamingId.value, plRenameText.value.trim())
    plSummary.value = 'Renamed'
    plRenamingId.value = ''
  } finally {
    plBusy.value = false
  }
}

async function plDelete(id: string, name: string) {
  if (!(await notifyConfirm(`Delete "${name}"? This cannot be undone.`, { title: 'Delete Pipeline', confirmText: 'Delete' }))) return
  plBusy.value = true
  try {
    await props.pipelinesApi?.deletePipeline(id)
    plSummary.value = `Deleted "${name}"`
    plBackToList()
  } finally {
    plBusy.value = false
  }
}

</script>

<template>
  <Teleport to="body">
    <!-- Overlay -->
    <div class="s-overlay" @click.self="emit('close')">
      <div class="s-modal">

        <!-- ── Sidebar (workspace header + search + grouped nav) ─────────── -->
        <aside class="s-sidebar">
          <div class="s-ws-header">
            <div class="s-ws-avatar" aria-hidden="true">{{ workspaceLabel.charAt(0) }}</div>
            <div class="s-ws-meta">
              <span class="s-ws-name" :title="workspaceLabel">{{ workspaceLabel }}</span>
              <span class="s-ws-sub">{{ $t('settings.nav.current-workspace') }}</span>
            </div>
          </div>

          <div class="s-search-box">
            <input
              v-model="settingsSearchQuery"
              class="s-search-input"
              type="search"
              :placeholder="$t('settings.search.placeholder')"
              spellcheck="false"
              @keydown.escape="settingsSearchQuery = ''"
            />
            <div v-if="settingsSearchQuery.trim()" class="s-search-results">
              <button
                v-for="item in settingsSearchResults"
                :key="item.id"
                class="s-search-result"
                @click="openSettingsSearchResult(item)"
              >
                <span class="s-search-result-main">
                  <span class="s-search-result-title">{{ item.title }}</span>
                  <span class="s-search-result-group">{{ item.group }}</span>
                </span>
                <span class="s-search-result-summary">{{ item.summary }}</span>
              </button>
              <div v-if="settingsSearchResults.length === 0" class="s-search-empty">
                {{ $t('settings.search.no-results') }}
              </div>
            </div>
          </div>

          <nav class="s-nav" aria-label="Settings sections">
            <div class="s-nav-group">
              <div class="s-nav-group-title">{{ $t('settings.nav.group.general') }}</div>
              <SettingsNavItem :label="$t('settings.nav.general')" :active="activeTab === 'general'" @select="activeTab = 'general'">
                <template #icon>
                  <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="8" r="2.2"/><path d="M8 1.5v1.8M8 12.7v1.8M14.5 8h-1.8M3.3 8H1.5M12.6 3.4l-1.3 1.3M4.7 11.3l-1.3 1.3M12.6 12.6l-1.3-1.3M4.7 4.7 3.4 3.4"/></svg>
                </template>
              </SettingsNavItem>
              <SettingsNavItem :label="$t('settings.nav.appearance')" :active="activeTab === 'appearance'" @select="activeTab = 'appearance'">
                <template #icon>
                  <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M10.5 2.5 13.5 5.5 6.5 12.5 3.5 12.5 3.5 9.5 10.5 2.5Z"/><path d="M9 4l3 3"/></svg>
                </template>
              </SettingsNavItem>
            </div>

            <div class="s-nav-group">
              <div class="s-nav-group-title">{{ $t('settings.nav.group.accountsAgents') }}</div>
              <SettingsNavItem :label="$t('settings.nav.accounts')" :active="activeTab === 'accounts'" @select="activeTab = 'accounts'">
                <template #icon>
                  <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="5.2" r="2.6"/><path d="M3.3 13c0-2.5 2.1-4 4.7-4s4.7 1.5 4.7 4"/></svg>
                </template>
              </SettingsNavItem>
              <SettingsNavItem :label="$t('settings.nav.cliAgents')" :active="activeTab === 'cliAgents'" @select="activeTab = 'cliAgents'">
                <template #icon>
                  <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="3.3" y="5" width="9.4" height="7" rx="1.6"/><path d="M8 2.3V5"/><circle cx="8" cy="2.1" r="0.6"/><path d="M6 8.3v0.01M10 8.3v0.01"/></svg>
                </template>
              </SettingsNavItem>
              <SettingsNavItem :label="$t('settings.nav.roles')" :active="activeTab === 'roles'" @select="activeTab = 'roles'">
                <template #icon>
                  <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M2.8 3.8h10.4v3.4c0 3-2.3 5.5-5.2 5.5S2.8 10.2 2.8 7.2V3.8Z"/><path d="M6 7v0.01M10 7v0.01"/><path d="M6.2 9.8c1.1 0.9 2.5 0.9 3.6 0"/></svg>
                </template>
              </SettingsNavItem>
              <SettingsNavItem :label="$t('settings.nav.pipelines')" :active="activeTab === 'pipelines'" @select="activeTab = 'pipelines'">
                <template #icon>
                  <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="4.5" cy="4" r="1.7"/><circle cx="4.5" cy="12" r="1.7"/><circle cx="11.5" cy="4" r="1.7"/><path d="M4.5 5.7v4.6M4.5 8h4.3c1.6 0 2.7-.8 2.7-2.3"/></svg>
                </template>
              </SettingsNavItem>
            </div>

            <div class="s-nav-group">
              <div class="s-nav-group-title">{{ $t('settings.nav.group.integration') }}</div>
              <SettingsNavItem :label="$t('settings.nav.mcp')" :active="activeTab === 'mcp'" @select="activeTab = 'mcp'">
                <template #icon>
                  <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M5.5 2.3v3M10.5 2.3v3"/><path d="M4 5.3h8v2.2a4 4 0 0 1-8 0V5.3Z"/><path d="M8 11.5v2.2"/></svg>
                </template>
              </SettingsNavItem>
              <SettingsNavItem :label="$t('settings.nav.skills')" :active="activeTab === 'skills'" @select="activeTab = 'skills'">
                <template #icon>
                  <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3.2h4.2v4.2H3zM8.8 3.2H13v4.2H8.8zM3 9H7.2v3.8H3z"/><path d="M10.9 9v3.8M9 10.9h3.8"/></svg>
                </template>
              </SettingsNavItem>
              <SettingsNavItem :label="$t('settings.nav.analyzer')" :active="activeTab === 'analyzer'" @select="activeTab = 'analyzer'">
                <template #icon>
                  <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3.2C6.6 2.2 4.2 2.8 4.2 4.8 2.7 5.1 2.7 7.3 4.2 7.8c0 2 1.9 2.6 3.8 2.1"/><path d="M8 3.2c1.4-1 3.8-.4 3.8 1.6 1.5.3 1.5 2.5 0 3 0 2-1.9 2.6-3.8 2.1"/><path d="M8 3.2v9.6"/></svg>
                </template>
              </SettingsNavItem>
              <SettingsNavItem :label="$t('settings.nav.extensions')" :active="activeTab === 'extensions'" @select="activeTab = 'extensions'">
                <template #icon>
                  <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M6.4 2.6h3.2v1.5a1.3 1.3 0 0 0 2.4 0V2.6h1.4v3.2h-1.5a1.3 1.3 0 0 0 0 2.4h1.5v3.2H6.4v-1.5a1.3 1.3 0 0 0-2.4 0v1.5H2.6V8.2h1.5a1.3 1.3 0 0 0 0-2.4H2.6V2.6h3.8Z"/></svg>
                </template>
              </SettingsNavItem>
            </div>

            <div class="s-nav-group">
              <div class="s-nav-group-title">{{ $t('settings.nav.group.system') }}</div>
              <SettingsNavItem :label="$t('settings.nav.shortcuts')" :active="activeTab === 'shortcuts'" @select="activeTab = 'shortcuts'">
                <template #icon>
                  <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="1.8" y="4.3" width="12.4" height="7.4" rx="1.4"/><path d="M4.4 7v0.01M6.8 7v0.01M9.2 7v0.01M11.6 7v0.01M4.4 9.2v0.01M11.6 9.2v0.01"/><path d="M6.4 9.2h3.2"/></svg>
                </template>
              </SettingsNavItem>
              <SettingsNavItem :label="$t('settings.nav.updates')" :active="activeTab === 'updates'" @select="activeTab = 'updates'">
                <template #icon>
                  <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M8 10.3V2.8M8 2.8 5.3 5.5M8 2.8l2.7 2.7"/><path d="M3.3 10.5v1.6a1.2 1.2 0 0 0 1.2 1.2h7a1.2 1.2 0 0 0 1.2-1.2v-1.6"/></svg>
                </template>
              </SettingsNavItem>
            </div>
          </nav>
        </aside>

        <!-- ── Content (close button + all tab bodies) ───────────────────── -->
        <div class="s-content">
          <button class="s-close" @click="emit('close')" title="Close (ESC)">✕</button>

        <!-- ── ROLES TAB ─────────────────────────────────────────────────── -->
        <div v-show="activeTab === 'roles'" class="s-body roles-body" data-settings-section="roles">
          <h1 class="s-page-title">{{ $t('settings.nav.roles') }}</h1>
          <div class="settings-meta-row">
            <span class="scope-badge">{{ settingsScopeNotes.roles.scope }}</span>
            <span class="settings-path" :title="pathForTab('roles')">{{ pathForTab('roles') }}</span>
            <button class="settings-path-btn" :disabled="!settingsPaths.roles" @click="openSettingsPath(settingsPaths.roles)">{{ $t('action.open') }}</button>
          </div>
          <div class="tab-toolbar">
            <button class="ghost" :disabled="rExportBusy" @click="rExport">{{ rExportBusy ? '…' : $t('settings.roles.export-json') }}</button>
            <button class="ghost" :disabled="rImporting" @click="rImport">{{ rImporting ? '…' : $t('settings.roles.import-json') }}</button>
            <span v-if="rSummary" class="summary-ok">{{ rSummary }}</span>
          </div>
          <div class="split">
            <aside class="split-list">
              <button class="primary new-btn" @click="rStartNew">{{ $t('settings.roles.new-role') }}</button>
              <ul>
                <li v-for="r in rSorted" :key="r.key"
                    :class="{ active: rSelectedKey === r.key && rDraft && !rDraft.isNew }"
                    @click="rSelectKey(r.key)">
                  <div class="row-g"><span class="mono-key">{{ r.key }}</span><span v-if="r.is_default" class="badge">default</span></div>
                  <div class="item-label">{{ r.label }}</div>
                  <div class="item-sub">{{ r.one_line }}</div>
                </li>
              </ul>
            </aside>
            <section v-if="rDraft" class="split-detail">
              <div class="detail-head">
                <h3>{{ rDraft.isNew ? $t('label.new-role') : $t('label.edit-role') }}</h3>
                <div class="row-g gap">
                  <button v-if="!rDraft.isNew" class="danger" @click="rConfirmDelete = true">{{ $t('settings.roles.delete') }}</button>
                  <button class="primary" :disabled="!rCanSave || rSaving" @click="rSave">{{ rSaving ? $t('label.saving') : rDraft.isNew ? $t('action.create') : $t('settings.roles.save') }}</button>
                </div>
              </div>
              <p v-if="rError" class="err-msg">{{ rError }}</p>
              <div class="two-col">
                <div class="field">
                  <label class="lbl">{{ $t('settings.roles.key-label') }}</label>
                  <input v-model="rDraft.key" type="text" placeholder="lowercase_key" spellcheck="false" :disabled="!rDraft.isNew && rDraft.originalKey === 'pm'" />
                  <p v-if="rDraft.isNew && rolesApi.find(rDraft.key.trim())" class="warn-msg">key already exists</p>
                </div>
                <div class="field">
                  <label class="lbl">{{ $t('settings.roles.label-label') }}</label>
                  <input v-model="rDraft.label" type="text" placeholder="e.g. Tech Lead" spellcheck="false" />
                </div>
              </div>
              <div class="field">
                <label class="lbl">{{ $t('settings.roles.one-line-label') }}</label>
                <input v-model="rDraft.one_line" type="text" placeholder="short hint shown in dropdown" spellcheck="false" />
              </div>
              <div class="field">
                <label class="lbl">{{ $t('settings.roles.system-prompt-label') }}</label>
                <textarea v-model="rDraft.system_prompt" rows="14" spellcheck="false"></textarea>
                <p class="hint-msg">{{ rDraft.system_prompt.length }} chars · Changes apply to new spawns only</p>
              </div>
            </section>
            <section v-else class="split-detail empty-detail">
              <div class="empty-glyph">👤</div>
              <p>{{ $t('hint.select-role-create') }}</p>
            </section>
          </div>
        </div>

        <!-- ── STAGES TAB ────────────────────────────────────────────────── -->
        <!-- ── MCP TAB ───────────────────────────────────────────────────── -->
        <div v-show="activeTab === 'mcp'" class="s-body mcp-body">
          <h1 class="s-page-title">{{ $t('settings.nav.mcp') }}</h1>

          <!-- ── LIST VIEW ──────────────────────────────────────────────── -->
          <template v-if="mView === 'list'">
            <div class="mcp-topbar" data-settings-section="mcp-installed">
              <span class="mcp-page-title">{{ $t('label.installed-mcp-servers') }}</span>
              <div class="mcp-topbar-actions">
                <button class="mcp-action-btn" @click="mView = 'catalog'">{{ $t('action.add-mcp') }}</button>
                <button class="mcp-action-btn" @click="mView = 'custom'">{{ $t('settings.mcp.add-custom') }}</button>
                <button class="mcp-action-btn" @click="mLoad()" :disabled="mLoading">{{ $t('action.refresh') }}</button>
                <button class="mcp-action-btn" @click="mOpenConfig" :disabled="!mConfigPath">{{ $t('action.open-mcp-config') }}</button>
              </div>
            </div>
            <div class="settings-meta-row">
              <span class="scope-badge">{{ settingsScopeNotes.mcp.scope }}</span>
              <span class="settings-path" :title="pathForTab('mcp')">{{ pathForTab('mcp') }}</span>
              <button class="settings-path-btn" :disabled="!settingsPaths.mcp" @click="openSettingsPath(settingsPaths.mcp)">{{ $t('action.open') }}</button>
            </div>
            <p v-if="mError" class="err-msg" style="margin:6px 16px 0">{{ mError }}</p>
            <div v-if="mConflict" class="mcp-conflict">
              <span>{{ $t('settings.mcp.conflict') }}</span>
              <button class="mcp-action-btn" @click="mLoad(true)">{{ $t('settings.mcp.reload') }}</button>
            </div>
            <span v-if="mSummary" class="mcp-summary-ok">{{ mSummary }}</span>

            <div class="mcp-server-list">
              <div v-if="mLoading" class="mcp-loading">{{ $t('label.loading') }}</div>

              <div v-for="(srv, idx) in mServers" :key="srv.name" class="mcp-server-card">
                <!-- Main row -->
                <div class="mcp-server-row">
                  <span class="mcp-dot" :class="srv.status ?? 'unknown'"></span>
                  <span class="mcp-server-name">{{ srv.name }}</span>
                  <span class="mcp-transport-badge">{{ srv.transport }}</span>
                  <span class="mcp-spacer"></span>
                  <button class="mcp-delete-btn" @click="mRemoveServer(idx)" title="Remove">🗑</button>
                  <!-- Toggle switch -->
                  <ToggleSwitch
                    :model-value="srv.enabled"
                    :aria-label="srv.enabled ? 'Disable' : 'Enable'"
                    @update:model-value="mToggleEnabled(srv)"
                  />
                </div>

                <!-- Tools row (collapsible) -->
                <div v-if="(srv.tool_count ?? 0) > 0 || srv.status === 'connected'" class="mcp-tools-row" @click="mToggleTools(srv.name)">
                  <span class="mcp-chevron" :class="{ open: mExpanded.has(srv.name) }">›</span>
                  <span class="mcp-tool-count">{{ srv.tool_count ?? 0 }} tools enabled</span>
                </div>
                <div v-else-if="srv.status === 'error'" class="mcp-tools-row mcp-tools-error">
                  <span class="mcp-chevron">!</span>
                  <span>{{ $t('hint.connection-failed') }}</span>
                </div>
                <div v-else-if="srv.status === 'disabled'" class="mcp-tools-row mcp-tools-disabled">
                  <span class="mcp-chevron">–</span>
                  <span>{{ $t('label.disabled') }}</span>
                </div>

                <!-- Tool list (expanded) -->
                <ul v-if="mExpanded.has(srv.name) && srv.tools?.length" class="mcp-tool-list">
                  <li v-for="t in srv.tools" :key="t.name">
                    <span class="mcp-tool-name">{{ t.name }}</span>
                    <span v-if="t.description" class="mcp-tool-desc"> — {{ t.description }}</span>
                  </li>
                </ul>

                <!-- Env / command editor (collapsible) -->
                <div class="mcp-config-toggle" @click="mToggleEnv(srv.name)">
                  <span class="mcp-chevron" :class="{ open: mExpandedEnv.has(srv.name) }">›</span>
                  <span>{{ $t('action.settings') }}</span>
                </div>
                <div v-if="mExpandedEnv.has(srv.name)" class="mcp-config-form">
                  <div class="field mcp-transport-field">
                    <label class="lbl">{{ $t('settings.mcp.transport') }}</label>
                    <select
                      :value="srv.transport"
                      @change="mChangeTransport(srv, ($event.target as HTMLSelectElement).value as McpTransport)"
                    >
                      <option value="stdio">stdio</option>
                      <option value="http">HTTP</option>
                      <option value="sse">SSE</option>
                    </select>
                  </div>

                  <template v-if="srv.transport === 'stdio'">
                    <div class="field">
                      <label class="lbl">{{ $t('label.mcp-command') }}</label>
                      <input v-model="srv.command" type="text" spellcheck="false" placeholder="npx" @input="mMarkDirty" @blur="mSave(true)" />
                    </div>
                    <div class="field">
                      <label class="lbl">
                        {{ $t('settings.mcp.arguments') }}
                        <button class="mcp-add-env-btn" @click.stop="mAddArg(srv)">+ {{ $t('action.add') }}</button>
                      </label>
                      <div v-for="(arg, argIndex) in (srv.args ?? [])" :key="argIndex" class="mcp-env-row">
                        <span class="mcp-arg-index">{{ argIndex + 1 }}</span>
                        <input
                          :value="arg"
                          type="text"
                          class="mcp-env-val"
                          spellcheck="false"
                          @input="mSetArg(srv, argIndex, ($event.target as HTMLInputElement).value)"
                          @blur="mSave(true)"
                        />
                        <button class="mcp-delete-btn small" @click.stop="mDeleteArg(srv, argIndex); mSave(true)">✕</button>
                      </div>
                      <p v-if="!(srv.args?.length)" class="hint-msg">{{ $t('settings.mcp.no-arguments') }}</p>
                    </div>
                    <div class="field">
                      <label class="lbl">
                        {{ $t('settings.mcp.env') }}
                        <button class="mcp-add-env-btn" @click.stop="mAddRecordEntry(mEnvRecord(srv), 'NEW_KEY')">+ {{ $t('action.add') }}</button>
                      </label>
                      <div v-for="[k, v] in mRecordEntries(srv.env)" :key="k" class="mcp-env-row">
                        <input :value="k" @change="mSetRecordKey(mEnvRecord(srv), k, ($event.target as HTMLInputElement).value); mSave(true)" type="text" spellcheck="false" placeholder="KEY" class="mcp-env-key" />
                        <span>=</span>
                        <input
                          :value="v"
                          @input="mSetRecordValue(mEnvRecord(srv), k, ($event.target as HTMLInputElement).value)"
                          :type="isSecretSettingKey(k) && !mSecretVisible(srv, 'env', k) ? 'password' : 'text'"
                          spellcheck="false"
                          placeholder="value"
                          class="mcp-env-val"
                          @blur="mSave(true)"
                        />
                        <button v-if="isSecretSettingKey(k)" class="mcp-reveal-btn" @click.stop="mToggleSecret(srv, 'env', k)">
                          {{ mSecretVisible(srv, 'env', k) ? $t('settings.mcp.hide') : $t('settings.mcp.show') }}
                        </button>
                        <button class="mcp-delete-btn small" @click.stop="mDeleteRecordEntry(mEnvRecord(srv), k); mSave(true)">✕</button>
                      </div>
                      <p v-if="!Object.keys(srv.env ?? {}).length" class="hint-msg">{{ $t('settings.mcp.no-env') }}</p>
                    </div>
                  </template>

                  <template v-else>
                    <div class="field">
                      <label class="lbl">URL</label>
                      <input v-model="srv.url" type="url" spellcheck="false" placeholder="https://example.com/mcp" @input="mMarkDirty" @blur="mSave(true)" />
                    </div>
                    <div class="field">
                      <label class="lbl">
                        {{ $t('settings.mcp.headers') }}
                        <button class="mcp-add-env-btn" @click.stop="mAddRecordEntry(mHeaderRecord(srv), 'Authorization')">+ {{ $t('action.add') }}</button>
                      </label>
                      <div v-for="[k, v] in mRecordEntries(srv.headers)" :key="k" class="mcp-env-row">
                        <input :value="k" @change="mSetRecordKey(mHeaderRecord(srv), k, ($event.target as HTMLInputElement).value); mSave(true)" type="text" spellcheck="false" placeholder="Header" class="mcp-env-key" />
                        <span>:</span>
                        <input
                          :value="v"
                          @input="mSetRecordValue(mHeaderRecord(srv), k, ($event.target as HTMLInputElement).value)"
                          :type="isSecretSettingKey(k) && !mSecretVisible(srv, 'header', k) ? 'password' : 'text'"
                          spellcheck="false"
                          placeholder="value"
                          class="mcp-env-val"
                          @blur="mSave(true)"
                        />
                        <button v-if="isSecretSettingKey(k)" class="mcp-reveal-btn" @click.stop="mToggleSecret(srv, 'header', k)">
                          {{ mSecretVisible(srv, 'header', k) ? $t('settings.mcp.hide') : $t('settings.mcp.show') }}
                        </button>
                        <button class="mcp-delete-btn small" @click.stop="mDeleteRecordEntry(mHeaderRecord(srv), k); mSave(true)">✕</button>
                      </div>
                      <p v-if="!Object.keys(srv.headers ?? {}).length" class="hint-msg">{{ $t('settings.mcp.no-headers') }}</p>
                    </div>
                  </template>
                </div>
              </div>

              <div v-if="!mLoading && mServers.length === 0" class="mcp-empty">
                No MCP servers installed. Click "Add MCP +" to add one from the catalog.
              </div>
            </div>
          </template>

          <!-- ── CATALOG VIEW ────────────────────────────────────────────── -->
          <template v-else-if="mView === 'catalog'">
            <div class="mcp-topbar" data-settings-section="mcp-catalog">
              <button class="mcp-back-btn" @click="mView = 'list'">← Back</button>
              <span class="mcp-page-title">Add MCP Servers</span>
            </div>

            <div class="mcp-search-wrap">
              <input v-model="mSearch" type="text" placeholder="Search MCP servers by name" class="mcp-search" spellcheck="false" />
              <span class="mcp-search-icon">🔍</span>
            </div>

            <div class="mcp-catalog-hint">
              💡 This catalog lists only <strong>"Orchestrator context-reading"</strong> MCPs — tools that read workspace / docs / external service data and inject it into kickoff prompts to ground agent knowledge. Execution actions (tests, browser automation, etc.) are handled by the CLI agents themselves.
            </div>

            <div class="mcp-catalog-list">
              <div v-for="item in mFilteredCatalog" :key="item.name" class="mcp-catalog-card">
                <div class="mcp-catalog-info">
                  <div class="mcp-catalog-name">{{ item.label }}</div>
                  <div class="mcp-catalog-desc">{{ item.description }}</div>
                  <div v-if="item.requiresEnv?.length" class="mcp-catalog-note">
                    ⚠ Requires env vars: {{ item.requiresEnv.join(', ') }}
                  </div>
                </div>
                <button v-if="mIsInstalled(item.name)" class="mcp-installed-badge" disabled>Installed</button>
                <button v-else class="mcp-add-btn" @click="mAddFromCatalog(item)" :disabled="mSaving">+ Add</button>
              </div>
              <div v-if="mFilteredCatalog.length === 0" class="mcp-empty">No matching MCP servers found</div>
            </div>
          </template>

          <template v-else>
            <div class="mcp-topbar" data-settings-section="mcp-custom">
              <button class="mcp-back-btn" @click="mView = 'list'">← {{ $t('action.back') }}</button>
              <span class="mcp-page-title">{{ $t('settings.mcp.custom-title') }}</span>
            </div>
            <form class="mcp-custom-form" @submit.prevent="mCreateCustom">
              <p>{{ $t('settings.mcp.custom-hint') }}</p>
              <div class="field">
                <label class="lbl">{{ $t('settings.mcp.server-name') }}</label>
                <input v-model="mCustomName" required pattern="[a-z0-9][a-z0-9_-]{0,63}" maxlength="64" spellcheck="false" autocomplete="off" placeholder="my-server" />
              </div>
              <div class="field">
                <label class="lbl">{{ $t('settings.mcp.transport') }}</label>
                <select v-model="mCustomTransport">
                  <option value="stdio">stdio</option>
                  <option value="http">HTTP</option>
                  <option value="sse">SSE</option>
                </select>
              </div>
              <div v-if="mCustomTransport === 'stdio'" class="field">
                <label class="lbl">{{ $t('label.mcp-command') }}</label>
                <input v-model="mCustomCommand" required spellcheck="false" placeholder="npx" />
              </div>
              <div v-else class="field">
                <label class="lbl">URL</label>
                <input v-model="mCustomUrl" required type="url" spellcheck="false" placeholder="https://example.com/mcp" />
              </div>
              <div class="mcp-custom-actions">
                <button type="button" class="mcp-action-btn" @click="mView = 'list'">{{ $t('action.cancel') }}</button>
                <button
                  type="submit"
                  class="mcp-add-btn"
                  :disabled="mSaving || !mCustomName.trim() || (mCustomTransport === 'stdio' ? !mCustomCommand.trim() : !mCustomUrl.trim())"
                >{{ $t('settings.mcp.create-server') }}</button>
              </div>
            </form>
          </template>

        </div>

        <!-- ── SKILLS TAB ───────────────────────────────────────────────── -->
        <div v-show="activeTab === 'skills'" class="s-body" data-settings-section="skills">
          <h1 class="s-page-title">{{ $t('settings.nav.skills') }}</h1>
          <div class="settings-meta-row">
            <span class="scope-badge">{{ settingsScopeNotes.skills.scope }}</span>
            <span class="settings-path" :title="pathForTab('skills')">{{ pathForTab('skills') }}</span>
            <button class="settings-path-btn" :disabled="!settingsPaths.skills" @click="openSettingsPath(settingsPaths.skills)">{{ $t('action.open') }}</button>
          </div>
          <SkillsPane :backend="props.backend" />
        </div>

        <!-- ── ANALYZER TAB ─────────────────────────────────────────────── -->
        <div v-show="activeTab === 'analyzer'" class="s-body analyzer-body">
          <h1 class="s-page-title">{{ $t('settings.nav.analyzer') }}</h1>
          <div class="settings-meta-row">
            <span class="scope-badge">{{ settingsScopeNotes.analyzer.scope }}</span>
            <span class="settings-path" :title="settingsPaths.analyzer">{{ settingsPaths.analyzer }}</span>
            <button class="settings-path-btn" :disabled="!settingsPaths.analyzer" @click="openSettingsPath(settingsPaths.analyzer)">{{ $t('action.open') }}</button>
            <span class="settings-path-divider">·</span>
            <span class="settings-path" :title="settingsPaths.ai_chat">AI keys: {{ settingsPaths.ai_chat }}</span>
            <button class="settings-path-btn" :disabled="!settingsPaths.ai_chat" @click="openSettingsPath(settingsPaths.ai_chat)">{{ $t('action.open') }}</button>
          </div>

          <!-- ① Inference backend -->
          <div class="az-section" data-settings-section="analyzer-backend">
            <div class="az-section-title">{{ $t('settings.analyzer.inference-backend') }}</div>
            <div class="az-backend-toggle">
              <button
                :class="['az-backend-btn', { active: props.analyzerApi.analyzerSettings.value.backend === 'ollama' }]"
                @click="props.analyzerApi.saveSettings({ backend: 'ollama' })"
              >Ollama REST</button>
              <button
                :class="['az-backend-btn', { active: props.analyzerApi.analyzerSettings.value.backend === 'llama_cpp' }]"
                @click="props.analyzerApi.saveSettings({ backend: 'llama_cpp' })"
              >llama.cpp</button>
            </div>

            <!-- llama.cpp-specific settings -->
            <template v-if="props.analyzerApi.analyzerSettings.value.backend === 'llama_cpp'">
              <div class="az-subsection">
                <label class="az-label">{{ $t('settings.analyzer.llama-cli-path') }}
                  <span class="az-hint-inline">{{ $t('settings.analyzer.llama-cli-path-hint') }}</span>
                </label>
                <div class="az-url-row">
                  <input
                    class="az-input"
                    type="text"
                    placeholder="e.g. llama-cli or /usr/local/bin/llama-completion"
                    :value="props.analyzerApi.analyzerSettings.value.llama_cli"
                    @change="props.analyzerApi.saveSettings({ llama_cli: ($event.target as HTMLInputElement).value })"
                  />
                  <button
                    class="az-detect-btn"
                    :disabled="azDetecting"
                    @click="azDetectCli"
                    :title="$t('settings.analyzer.auto-detect-title')"
                  >{{ azDetecting ? '…' : $t('settings.analyzer.auto-detect') }}</button>
                  <button class="az-browse-btn" @click="azPickCli" :title="$t('action.browse')">…</button>
                </div>
                <div class="az-status-row">
                  <span class="az-status-dot" :class="props.analyzerApi.health.value?.ok ? 'ok' : 'err'"></span>
                  <span class="az-version" v-if="props.analyzerApi.health.value?.ok">
                    llama-cli {{ props.analyzerApi.health.value?.version }}
                  </span>
                  <span class="az-version offline" v-else>{{ $t('settings.analyzer.llama-not-detected') }}</span>
                </div>
              </div>

              <div class="az-subsection">
                <label class="az-label">{{ $t('settings.analyzer.gguf-path') }}
                  <span class="az-hint-inline">{{ $t('settings.analyzer.gguf-path-hint') }}</span>
                </label>
                <div class="az-url-row">
                  <input
                    class="az-input"
                    type="text"
                    :placeholder="$t('settings.analyzer.gguf-path-placeholder')"
                    :value="props.analyzerApi.analyzerSettings.value.gguf_path"
                    @change="props.analyzerApi.saveSettings({ gguf_path: ($event.target as HTMLInputElement).value })"
                  />
                  <button
                    class="az-recheck-btn"
                    :disabled="azRechecking"
                    @click="azRecheck"
                    :title="$t('action.recheck-file-exists')"
                  >{{ azRechecking ? '…' : '↻' }}</button>
                  <button class="az-browse-btn" @click="azPickGguf" :title="$t('action.browse')">…</button>
                </div>
                <template v-if="props.analyzerApi.analyzerSettings.value.gguf_path">
                  <div class="az-status-row">
                    <span class="az-status-dot" :class="props.analyzerApi.health.value?.gguf_warning ? 'err' : 'ok'"></span>
                    <span class="az-version" v-if="props.analyzerApi.health.value?.ok && !props.analyzerApi.health.value?.gguf_warning">
                      File found · {{ props.analyzerApi.health.value?.gguf_size ? ((props.analyzerApi.health.value.gguf_size as number) / 1e9).toFixed(1) + ' GB' : '' }}
                    </span>
                    <span class="az-version offline" v-else>{{ (props.analyzerApi.health.value as any)?.gguf_warning ?? 'Not yet detected' }}</span>
                  </div>
                </template>
                <div class="az-gguf-hint">
                  Download a <code>.gguf</code> file from <a class="az-link" href="https://huggingface.co/models?library=gguf" target="_blank">HuggingFace</a>
                  and enter the full path here. Leave blank to use the Ollama model selected in the model manager.
                </div>
              </div>
            </template>

            <!-- Ollama REST-specific settings -->
            <template v-if="props.analyzerApi.analyzerSettings.value.backend === 'ollama'">
              <div class="az-subsection">
                <label class="az-label">{{ $t('settings.analyzer.inference-url') }}</label>
                <div class="az-url-row">
                  <input
                    class="az-input"
                    type="text"
                    placeholder="http://localhost:11434"
                    :value="props.analyzerApi.analyzerSettings.value.ollama_base_url"
                    @change="props.analyzerApi.saveSettings({ ollama_base_url: ($event.target as HTMLInputElement).value })"
                  />
                  <button
                    class="az-recheck-btn"
                    :disabled="azRechecking"
                    @click="azRecheck"
                    :title="$t('settings.analyzer.recheck-title')"
                  >{{ azRechecking ? '…' : '↻' }}</button>
                </div>
                <div class="az-status-row">
                  <span class="az-status-dot" :class="props.analyzerApi.health.value?.ok ? 'ok' : 'err'"></span>
                  <span class="az-version" v-if="props.analyzerApi.health.value?.ok">
                    {{ $t('settings.analyzer.ollama-connected', { version: props.analyzerApi.health.value?.version }) }}
                  </span>
                  <span class="az-version offline" v-else>
                    {{ $t('settings.analyzer.not-connected') }} <code class="az-code">ollama serve</code>
                  </span>
                </div>
              </div>
            </template>
          </div>

          <!-- ② Model manager (Ollama mode only) -->
          <div v-if="props.analyzerApi.analyzerSettings.value.backend === 'ollama'" class="az-section az-models-section" data-settings-section="analyzer-models">
            <div class="az-section-header">
              <div class="az-section-title">{{ $t('settings.analyzer.model-manager') }}</div>
              <span class="az-section-note">{{ $t('settings.analyzer.model-manager-note') }}</span>
            </div>

            <!-- Pull a new model -->
            <div class="az-pull-row">
              <input
                class="az-input az-pull-input"
                type="text"
                :placeholder="$t('settings.analyzer.model-placeholder')"
                v-model="azPullName"
                @keydown.enter="azDoPull"
              />
              <button
                class="az-run-btn"
                :disabled="props.analyzerApi.pulling.value || !azPullName.trim()"
                @click="azDoPull"
              >
                {{ props.analyzerApi.pulling.value ? $t('settings.analyzer.downloading') : $t('settings.analyzer.download') }}
              </button>
            </div>

            <!-- Download progress -->
            <div v-if="props.analyzerApi.pulling.value" class="az-progress-wrap">
              <div class="az-progress-label">
                <span class="az-spin">⏳</span>
                <span>{{ props.analyzerApi.pullProgress.value?.status ?? $t('settings.analyzer.connecting') }}</span>
                <template v-if="props.analyzerApi.pullProgress.value?.total">
                  <span class="az-pct">
                    {{ Math.round((props.analyzerApi.pullProgress.value.completed ?? 0) / props.analyzerApi.pullProgress.value.total * 100) }}%
                  </span>
                  <span class="az-size-info">
                    {{ ((props.analyzerApi.pullProgress.value.completed ?? 0) / 1e9).toFixed(1) }}
                    / {{ (props.analyzerApi.pullProgress.value.total / 1e9).toFixed(1) }} GB
                  </span>
                </template>
              </div>
              <div v-if="props.analyzerApi.pullProgress.value?.total" class="az-progress-bar-wrap">
                <div
                  class="az-progress-bar"
                  :style="{ width: Math.round((props.analyzerApi.pullProgress.value.completed ?? 0) / props.analyzerApi.pullProgress.value.total * 100) + '%' }"
                ></div>
              </div>
            </div>
            <div v-if="props.analyzerApi.pullError.value" class="az-pull-error">
              ⚠ {{ props.analyzerApi.pullError.value }}
            </div>

            <!-- Installed models list -->
            <div class="az-model-list">
              <div v-if="props.analyzerApi.models.value.length === 0" class="az-no-models">
                {{ $t('settings.analyzer.no-local-models') }}
              </div>
              <div
                v-for="m in props.analyzerApi.models.value"
                :key="m.name"
                class="az-model-row"
              >
                <div class="az-model-info">
                  <span class="az-model-name">{{ m.name }}</span>
                  <span class="az-model-meta">
                    {{ m.parameter_size || m.family }}
                    <template v-if="m.size > 0"> · {{ (m.size / 1e9).toFixed(1) }} GB</template>
                  </span>
                </div>
                <button class="az-del-btn" @click="azDoDelete(m.name)" :title="$t('settings.analyzer.delete-local-title')">✕</button>
              </div>
            </div>
          </div>

          <!-- ③ Model benchmark -->
          <div class="az-section az-benchmark-section" data-settings-section="analyzer-models">
            <div class="az-section-header">
              <div class="az-section-title">{{ $t('settings.analyzer.model-benchmark') }}</div>
              <button
                class="az-run-btn"
                :disabled="props.analyzerApi.benchmarking.value || !props.analyzerApi.health.value?.ok"
                @click="props.analyzerApi.benchmark()"
              >
                {{ props.analyzerApi.benchmarking.value ? $t('settings.analyzer.running') : $t('settings.analyzer.run-benchmark') }}
              </button>
            </div>

            <div v-if="props.analyzerApi.benchmarking.value" class="az-progress-wrap">
              <div v-if="props.analyzerApi.benchmarkProgress.value" class="az-progress-label">
                <span class="az-spin">⏳</span>
                {{ $t('settings.analyzer.testing') }} <strong>{{ props.analyzerApi.benchmarkProgress.value.model }}</strong>
                · {{ props.analyzerApi.benchmarkProgress.value.task_id }}
              </div>
              <div v-else class="az-progress-label">{{ $t('settings.analyzer.preparing') }}</div>
            </div>

            <div v-if="!props.analyzerApi.benchmarking.value && props.analyzerApi.benchmarkResults.value.length === 0" class="az-hint">
              <p>{{ $t('settings.analyzer.benchmark-hint') }}</p>
              <ul>
                <li><strong>T1</strong> {{ $t('settings.analyzer.task-t1') }} <code>{libraries, doc_query}</code></li>
                <li><strong>T2</strong> {{ $t('settings.analyzer.task-t2') }}</li>
                <li><strong>T3</strong> {{ $t('settings.analyzer.task-t3') }}</li>
                <li><strong>T4</strong> {{ $t('settings.analyzer.task-t4') }}</li>
              </ul>
              <p class="az-pass-rule">{{ $t('settings.analyzer.pass-threshold') }}</p>
            </div>

            <div v-if="props.analyzerApi.benchmarkResults.value.length > 0" class="az-results">
              <div class="az-results-summary">
                {{ $t('settings.analyzer.passed') }}
                <strong>{{ props.analyzerApi.benchmarkResults.value.filter(r => r.passed).length }}</strong>
                /
                {{ props.analyzerApi.benchmarkResults.value.length }}
                {{ $t('settings.analyzer.models') }}
              </div>
              <table class="az-table">
                <thead>
                  <tr>
                    <th class="az-th-model">{{ $t('settings.analyzer.col-model') }}</th>
                    <th v-for="t in ['T1','T2','T3','T4']" :key="t" class="az-th-task">{{ t }}</th>
                    <th class="az-th-score">{{ $t('settings.analyzer.col-score') }}</th>
                    <th class="az-th-verdict">{{ $t('settings.analyzer.col-verdict') }}</th>
                  </tr>
                </thead>
                <tbody>
                  <tr
                    v-for="r in props.analyzerApi.benchmarkResults.value"
                    :key="r.name"
                    :class="{ 'az-row-fail': !r.passed }"
                  >
                    <td class="az-td-model">{{ r.name }}</td>
                    <td v-for="tid in ['T1','T2','T3','T4']" :key="tid" class="az-td-task">
                      <template v-if="r.tasks.find(t => t.task_id === tid)">
                        <span :class="r.tasks.find(t => t.task_id === tid)!.passed ? 'az-pass' : 'az-fail'">
                          {{ r.tasks.find(t => t.task_id === tid)!.passed ? '✅' : '❌' }}
                        </span>
                        <span class="az-elapsed">{{ r.tasks.find(t => t.task_id === tid)!.elapsed_s }}s</span>
                      </template>
                      <span v-else class="az-na">—</span>
                    </td>
                    <td class="az-td-score">{{ r.score }}/{{ r.tasks.length }}</td>
                    <td class="az-td-verdict">
                      <span v-if="r.passed" class="az-badge-pass">{{ $t('settings.analyzer.badge-pass') }}</span>
                      <span v-else class="az-badge-fail">{{ $t('settings.analyzer.badge-excluded') }}</span>
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>

          <!-- ⑤ Cloud Provider API Keys -->
          <div class="az-section" data-settings-section="cloud-keys">
            <div class="az-section-title">{{ $t('settings.analyzer.cloud-keys') }}</div>
            <p class="az-hint">{{ $t('settings.analyzer.cloud-keys-hint') }}</p>

            <table class="az-key-table">
              <tbody>
                <tr>
                  <td class="az-key-label">Anthropic</td>
                  <td><input v-model="aiProviderKeys.anthropic_api_key" type="password" class="az-key-input" placeholder="sk-ant-…" @input="aiKeysDirty = true" /></td>
                  <td class="az-key-test-cell"><button class="ghost tiny" :disabled="aiProviderTestState('anthropic').busy" @click="testAiProvider('anthropic')">Test</button><span class="az-key-test" :class="{ ok: aiProviderTestState('anthropic').ok, err: aiProviderTestState('anthropic').ok === false }">{{ aiProviderTestState('anthropic').message }}</span></td>
                </tr>
                <tr>
                  <td class="az-key-label">OpenAI</td>
                  <td><input v-model="aiProviderKeys.openai_api_key" type="password" class="az-key-input" placeholder="sk-…" @input="aiKeysDirty = true" /></td>
                  <td class="az-key-test-cell"><button class="ghost tiny" :disabled="aiProviderTestState('openai').busy" @click="testAiProvider('openai')">Test</button><span class="az-key-test" :class="{ ok: aiProviderTestState('openai').ok, err: aiProviderTestState('openai').ok === false }">{{ aiProviderTestState('openai').message }}</span></td>
                </tr>
                <tr>
                  <td class="az-key-label">Google Gemini</td>
                  <td><input v-model="aiProviderKeys.google_api_key" type="password" class="az-key-input" placeholder="AIza…" @input="aiKeysDirty = true" /></td>
                  <td class="az-key-test-cell"><button class="ghost tiny" :disabled="aiProviderTestState('google').busy" @click="testAiProvider('google')">Test</button><span class="az-key-test" :class="{ ok: aiProviderTestState('google').ok, err: aiProviderTestState('google').ok === false }">{{ aiProviderTestState('google').message }}</span></td>
                </tr>
                <tr>
                  <td class="az-key-label">Groq</td>
                  <td><input v-model="aiProviderKeys.groq_api_key" type="password" class="az-key-input" placeholder="gsk_…" @input="aiKeysDirty = true" /></td>
                  <td class="az-key-test-cell"><button class="ghost tiny" :disabled="aiProviderTestState('groq').busy" @click="testAiProvider('groq')">Test</button><span class="az-key-test" :class="{ ok: aiProviderTestState('groq').ok, err: aiProviderTestState('groq').ok === false }">{{ aiProviderTestState('groq').message }}</span></td>
                </tr>
                <tr>
                  <td class="az-key-label">DeepSeek</td>
                  <td><input v-model="aiProviderKeys.deepseek_api_key" type="password" class="az-key-input" placeholder="sk-…" @input="aiKeysDirty = true" /></td>
                  <td class="az-key-test-cell"><button class="ghost tiny" :disabled="aiProviderTestState('deepseek').busy" @click="testAiProvider('deepseek')">Test</button><span class="az-key-test" :class="{ ok: aiProviderTestState('deepseek').ok, err: aiProviderTestState('deepseek').ok === false }">{{ aiProviderTestState('deepseek').message }}</span></td>
                </tr>
                <tr>
                  <td class="az-key-label">Mistral AI</td>
                  <td><input v-model="aiProviderKeys.mistral_api_key" type="password" class="az-key-input" placeholder="…" @input="aiKeysDirty = true" /></td>
                  <td class="az-key-test-cell"><button class="ghost tiny" :disabled="aiProviderTestState('mistral').busy" @click="testAiProvider('mistral')">Test</button><span class="az-key-test" :class="{ ok: aiProviderTestState('mistral').ok, err: aiProviderTestState('mistral').ok === false }">{{ aiProviderTestState('mistral').message }}</span></td>
                </tr>
                <tr>
                  <td class="az-key-label">xAI (Grok)</td>
                  <td><input v-model="aiProviderKeys.xai_api_key" type="password" class="az-key-input" placeholder="xai-…" @input="aiKeysDirty = true" /></td>
                  <td class="az-key-test-cell"><button class="ghost tiny" :disabled="aiProviderTestState('xai').busy" @click="testAiProvider('xai')">Test</button><span class="az-key-test" :class="{ ok: aiProviderTestState('xai').ok, err: aiProviderTestState('xai').ok === false }">{{ aiProviderTestState('xai').message }}</span></td>
                </tr>
              </tbody>
            </table>

            <div class="az-section-title" style="margin-top:16px">{{ $t('settings.analyzer.custom-openai') }}</div>
            <p class="az-hint">Point to any server exposing <code>/v1/chat/completions</code> (LM Studio, vLLM, llama.cpp, etc.).</p>
            <table class="az-key-table">
              <tbody>
                <tr>
                  <td class="az-key-label">Base URL</td>
                  <td><input v-model="aiProviderKeys.openai_compatible_base_url" type="text" class="az-key-input" placeholder="http://localhost:1234/v1" @input="aiKeysDirty = true" /></td>
                </tr>
                <tr>
                  <td class="az-key-label">API Key</td>
                  <td><input v-model="aiProviderKeys.openai_compatible_api_key" type="password" class="az-key-input" placeholder="(optional)" @input="aiKeysDirty = true" /></td>
                </tr>
                <tr>
                  <td class="az-key-label">Default Model</td>
                  <td><input v-model="aiProviderKeys.openai_compatible_model" type="text" class="az-key-input" placeholder="e.g. llama-3.3-70b" @input="aiKeysDirty = true" /></td>
                  <td class="az-key-test-cell"><button class="ghost tiny" :disabled="aiProviderTestState('openai_compatible').busy" @click="testAiProvider('openai_compatible')">Test</button><span class="az-key-test" :class="{ ok: aiProviderTestState('openai_compatible').ok, err: aiProviderTestState('openai_compatible').ok === false }">{{ aiProviderTestState('openai_compatible').message }}</span></td>
                </tr>
              </tbody>
            </table>

            <button class="ai-chat-key-save" style="margin-top:10px" :disabled="!aiKeysDirty" @click="saveAiChatSettings">Save Keys</button>
          </div>

        </div>

        <!-- ── PIPELINES TAB ────────────────────────────────────────────── -->
        <div v-show="activeTab === 'pipelines'" class="s-body pipelines-body" data-settings-section="pipelines">
          <h1 class="s-page-title">{{ $t('settings.nav.pipelines') }}</h1>
          <div class="settings-meta-row">
            <span class="scope-badge">{{ settingsScopeNotes.pipelines.scope }}</span>
            <span class="settings-path" :title="pathForTab('pipelines')">{{ pathForTab('pipelines') }}</span>
            <button class="settings-path-btn" :disabled="!settingsPaths.pipelines" @click="openSettingsPath(settingsPaths.pipelines)">{{ $t('action.open') }}</button>
          </div>

          <!-- ── LIST VIEW ──────────────────────────────────────────────── -->
          <template v-if="plView === 'list'">
            <div class="tab-toolbar">
              <button class="ghost" @click="plCreating = !plCreating" :disabled="plBusy">＋ New Pipeline</button>
              <span v-if="plSummary" class="pl-summary">{{ plSummary }}</span>
            </div>
            <div v-if="plCreating" class="pl-create-row">
              <input v-model="plNewName" type="text" placeholder="Pipeline name…" class="pl-input"
                @keyup.enter="plCreate" @keyup.escape="plCreating = false; plNewName = ''" />
              <button class="ghost" :disabled="!plNewName.trim() || plBusy" @click="plCreate">Create</button>
              <button class="ghost" @click="plCreating = false; plNewName = ''">Cancel</button>
            </div>
            <ul v-if="pipelinesApi?.pipelines.value.length" class="pl-list">
              <li v-for="p in pipelinesApi.pipelines.value" :key="p.id"
                  class="pl-item" :class="{ 'pl-active': p.id === pipelinesApi.activePipelineId.value }"
                  @click="plEnterDetail(p.id)" role="button">
                <div class="pl-item-main">
                  <span class="pl-name">{{ p.name }}</span>
                  <span class="pl-meta">{{ p.stage_count }} stage(s)</span>
                  <span v-if="p.id === pipelinesApi.activePipelineId.value" class="pl-badge active">Default</span>
                  <span class="pl-enter">›</span>
                </div>
              </li>
            </ul>
            <p v-else class="hint">No pipelines loaded yet…</p>
          </template>

          <!-- ── DETAIL VIEW: pipeline + stage editor ───────────────────── -->
          <template v-else>
            <!-- Detail header: back + pipeline name (inline rename) + actions -->
            <div class="pl-detail-header" data-settings-section="pipeline-stages">
              <button class="pl-back-btn" @click="plBackToList">← Back</button>
              <!-- Inline rename mode -->
              <template v-if="plRenamingId === plEditingId">
                <input v-model="plRenameText" class="pl-input pl-rename" autofocus
                  @keyup.enter="plConfirmRename" @keyup.escape="plRenamingId = ''" />
                <button class="ghost tiny" :disabled="plBusy" @click="plConfirmRename">✓</button>
                <button class="ghost tiny" @click="plRenamingId = ''">✕</button>
              </template>
              <!-- Display mode: title + pencil icon -->
              <template v-else>
                <h3 class="pl-detail-title">
                  {{ plCurrentPipeline?.name }}
                  <button class="pl-rename-icon" :disabled="plBusy"
                    @click="plStartRename(plEditingId, plCurrentPipeline?.name ?? '')"
                    :title="$t('action.rename')">✎</button>
                </h3>
              </template>
              <div class="pl-detail-actions">
                <button class="pl-delete-icon"
                  :disabled="plBusy || (pipelinesApi?.pipelines.value.length ?? 0) <= 1"
                  :title="(pipelinesApi?.pipelines.value.length ?? 0) <= 1 ? $t('hint.at-least-one-pipeline') : $t('action.delete-pipeline')"
                  @click="plDelete(plEditingId, plCurrentPipeline?.name ?? '')">
                  🗑
                </button>
                <span v-if="plEditingId === pipelinesApi?.activePipelineId.value" class="pl-badge active">Default</span>
                <button v-if="plEditingId !== pipelinesApi?.activePipelineId.value"
                  class="pl-set-default-btn" :disabled="plBusy" @click="plSetActive(plEditingId)">
                  ✓ Set as default
                </button>
                <span v-if="plSummary" class="pl-summary">{{ plSummary }}</span>
                <button class="pl-run-btn"
                  @click="emit('open-pipeline', plEditingId); emit('close')"
                  :title="$t('action.close-settings-run')">
                  ▶ Run
                </button>
              </div>
            </div>

            <!-- Stage editor for this pipeline -->
            <div v-if="plStagesLoading" class="hint">Loading stages…</div>
            <template v-else>
              <div class="tab-toolbar">
                <button class="ghost" :disabled="sExportBusy" @click="sExport">{{ sExportBusy ? '…' : '⬇ Export JSON' }}</button>
                <button class="ghost" :disabled="sImporting" @click="sImport">{{ sImporting ? '…' : '⬆ Import JSON' }}</button>
                <span v-if="sSummary" class="summary-ok">{{ sSummary }}</span>
              </div>
              <div class="split">
                <aside class="split-list">
                  <button class="primary new-btn" @click="sStartNew">+ Add Stage</button>
                  <ul>
                    <li v-for="(s, idx) in sActiveStages" :key="s.id"
                        :class="{ active: sSelectedId === s.id && !sIsNew }"
                        @click="sSelectStage(s.id)">
                      <div class="row-g spread">
                        <span class="mono-key">{{ s.id }}</span>
                        <div class="row-g gap">
                          <button class="icon-btn" @click.stop="sMoveUp(idx)" :disabled="idx === 0">▲</button>
                          <button class="icon-btn" @click.stop="sMoveDown(idx)" :disabled="idx === sActiveStages.length - 1">▼</button>
                        </div>
                      </div>
                      <div class="item-label">
                        {{ s.shortTitle }}
                        <span v-if="s.slots.some(sl => sl.isCommander)" class="manager-badge" :title="`Manager: ${s.slots.find(sl => sl.isCommander)?.label}`">🎯</span>
                      </div>
                      <div class="item-sub">
                        {{ s.slots.length === 1 ? `${s.slots[0].agentKey} · ${s.slots[0].roleKey}` : `${s.slots.length} parallel slots` }}
                      </div>
                    </li>
                  </ul>
                </aside>
                <section v-if="sDraft" class="split-detail">
                  <div class="detail-head">
                    <h3>{{ sIsNew ? $t('label.new-stage') : $t('label.edit-stage') }}</h3>
                    <div class="row-g gap">
                      <button v-if="!sIsNew" class="danger" @click="sConfirmDelete = true">{{ $t('settings.roles.delete') }}</button>
                      <button class="primary" :disabled="!sCanSave || sSaving" @click="sSave">{{ sSaving ? $t('label.saving') : sIsNew ? $t('action.create') : $t('settings.roles.save') }}</button>
                    </div>
                  </div>
                  <p v-if="sError" class="err-msg">{{ sError }}</p>
                  <div class="two-col">
                    <div class="field"><label class="lbl">ID</label><input v-model="sDraft.id" type="text" placeholder="e.g. 04.5" spellcheck="false" :disabled="!sIsNew" /></div>
                    <div class="field"><label class="lbl">Short title</label><input v-model="sDraft.shortTitle" type="text" placeholder="e.g. Review" spellcheck="false" /></div>
                  </div>
                  <div class="field"><label class="lbl">Full title</label><input v-model="sDraft.title" type="text" spellcheck="false" /></div>
                  <div class="two-col">
                    <div class="field"><label class="lbl">Sentinel</label><input v-model="sDraft.sentinel" type="text" placeholder="---DONE---" spellcheck="false" /></div>
                    <div class="field">
                      <label class="lbl">Allow questions</label>
                      <label class="check-row"><input type="checkbox" v-model="sDraft.allowQuestions" /><span>Pause for user answers</span></label>
                    </div>
                  </div>
                  <div class="field"><label class="lbl">Context7 doc query</label><input v-model="sDraft.docQuery" type="text" placeholder="e.g. security best practices, authentication" spellcheck="false" /></div>
                  <div class="slots-section">
                    <div class="row-g spread">
                      <label class="lbl">Slots <span class="slot-required">* at least one required</span></label>
                      <button class="ghost" @click="sStartAddSlot">+ Add slot</button>
                    </div>
                    <p v-if="!sDraft.slots?.length" class="warn-msg">Add at least one slot before saving.</p>
                    <template v-for="(slot, i) in sDraft.slots" :key="i">
                      <div v-if="sEditingSlotIndex !== i" class="slot-item slot-clickable" @click="sStartEditSlot(i)">
                        <div class="row-g spread">
                          <span class="item-label">{{ slot.label }}<span v-if="slot.isCommander" class="manager-badge">🎯 Manager</span></span>
                          <button class="ghost danger-link" @click.stop="sRemoveSlot(i)" :disabled="sDraft.slots.length <= 1" title="Cannot delete the last slot">✕</button>
                        </div>
                        <div class="item-sub">{{ slot.agentKey }} · {{ slot.roleKey }}</div>
                      </div>
                      <div v-else class="slot-form">
                        <div class="two-col">
                          <div class="field"><label class="lbl">Label</label><input v-model="sSlotDraft.label" type="text" /></div>
                          <div class="field"><label class="lbl">Agent</label><select v-model="sSlotDraft.agentKey"><option v-for="a in AGENT_OPTIONS" :key="a.key" :value="a.key">{{ a.label }}</option></select></div>
                        </div>
                        <div class="field"><label class="lbl">Role key</label>
                          <select v-model="sSlotDraft.roleKey">
                            <option value="">(unassigned)</option>
                            <option v-for="r in rolesApi.roles.value" :key="r.key" :value="r.key">{{ r.label }} ({{ r.key }})</option>
                          </select>
                        </div>
                        <label class="check-row manager-toggle">
                          <input type="checkbox" v-model="sSlotDraft.isCommander" />
                          <span><strong>🎯 Designate as global manager</strong> — This slot finishes its own work, prints <code>---MANAGER-READY---</code>, then coordinates across stages. Only one manager per pipeline.</span>
                        </label>
                        <div class="field"><label class="lbl">Kickoff body</label><textarea v-model="sSlotDraft.kickoffBody" rows="4" spellcheck="false"></textarea></div>
                        <div class="row-g gap">
                          <button class="ghost" @click="sCancelAddSlot">Cancel</button>
                          <button class="primary" @click="sSaveEditSlot">Save slot</button>
                        </div>
                      </div>
                    </template>
                    <div v-if="sAddingSlot" class="slot-form">
                      <div class="two-col">
                        <div class="field"><label class="lbl">Label</label><input v-model="sSlotDraft.label" type="text" /></div>
                        <div class="field"><label class="lbl">Agent</label><select v-model="sSlotDraft.agentKey"><option v-for="a in AGENT_OPTIONS" :key="a.key" :value="a.key">{{ a.label }}</option></select></div>
                      </div>
                      <div class="field"><label class="lbl">Role key</label>
                        <select v-model="sSlotDraft.roleKey">
                          <option value="">(unassigned)</option>
                          <option v-for="r in rolesApi.roles.value" :key="r.key" :value="r.key">{{ r.label }} ({{ r.key }})</option>
                        </select>
                      </div>
                      <label class="check-row manager-toggle">
                        <input type="checkbox" v-model="sSlotDraft.isCommander" />
                        <span><strong>🎯 Designate as global manager</strong> — Only one per pipeline.</span>
                      </label>
                      <div class="field"><label class="lbl">Kickoff body</label><textarea v-model="sSlotDraft.kickoffBody" rows="4" spellcheck="false"></textarea></div>
                      <div class="row-g gap">
                        <button class="ghost" @click="sCancelAddSlot">Cancel</button>
                        <button class="primary" @click="sConfirmAddSlot">Add</button>
                      </div>
                    </div>
                  </div>
                </section>
                <section v-else class="split-detail empty-detail"><p>Select a stage or click + Add Stage</p></section>
              </div>
            </template>
          </template>

        </div>

        <!-- ══ CLI AGENTS TAB ══ -->
        <div v-show="activeTab === 'cliAgents'" class="s-body cli-agents-body">
          <h1 class="s-page-title">{{ $t('settings.nav.cliAgents') }}</h1>
          <section class="ap-section" data-settings-section="cli-agents-list">
            <h3 class="ap-title">{{ $t('settings.cliAgents.title') }}</h3>
            <p class="ap-hint">{{ $t('settings.cliAgents.hint') }}</p>
            <ul class="cli-agent-list">
              <li
                v-for="spec in cliAgentRows"
                :key="spec.agentKey"
                class="cli-agent-row"
                :class="{ 'drag-over': cliDragOverKey === spec.agentKey, 'is-disabled': !cliAgentEnabled(spec.agentKey) }"
                draggable="true"
                @dragstart="onCliDragStart($event, spec.agentKey)"
                @dragover="onCliDragOver($event, spec.agentKey)"
                @dragenter="onCliDragOver($event, spec.agentKey)"
                @dragleave="onCliDragLeave(spec.agentKey)"
                @drop.prevent="onCliDrop(spec.agentKey)"
              >
                <span class="cli-agent-grip" :title="$t('settings.cliAgents.drag-hint')">⠿</span>
                <label class="cli-agent-toggle">
                  <input
                    type="checkbox"
                    :checked="cliAgentEnabled(spec.agentKey)"
                    :disabled="cliAgentEnabled(spec.agentKey) && cliEnabledCount <= 1"
                    @change="toggleCliAgent(spec.agentKey)"
                  />
                  <span class="cli-agent-label">{{ spec.label }}</span>
                </label>
                <span v-if="spec.hint" class="cli-agent-hint">{{ spec.hint }}</span>
              </li>
            </ul>
          </section>
          <section class="ap-section" data-settings-section="cli-agents-maintenance">
            <CliManagementPanel v-if="activeTab === 'cliAgents'" :backend="props.backend" />
          </section>
        </div>

        <!-- ══ GENERAL TAB ══ -->
        <div v-show="activeTab === 'general'" class="s-body appearance-body">
          <h1 class="s-page-title">{{ $t('settings.nav.general') }}</h1>

          <SettingsSection :label="$t('settings.section.general-behavior')">
            <SettingsCard>
              <SettingRow
                data-settings-section="general-confirm-close"
                :title="$t('confirm-close.setting-title')"
                :description="$t('confirm-close.setting-hint')"
              >
                <template #control>
                  <ToggleSwitch v-model="confirmBeforeCloseModel" :aria-label="$t('confirm-close.setting-label')" />
                </template>
              </SettingRow>

              <SettingRow
                data-settings-section="general-resume-behavior"
                :title="$t('settings.appearance.resume-behavior')"
                :description="$t('settings.appearance.resume-behavior-hint')"
              >
                <template #control>
                  <select :value="resumeBehaviorModel" @change="onResumeBehaviorChange(($event.target as HTMLSelectElement).value)">
                    <option value="always">{{ $t('settings.appearance.resume-behavior-always') }}</option>
                    <option value="never">{{ $t('settings.appearance.resume-behavior-never') }}</option>
                    <option value="ask">{{ $t('settings.appearance.resume-behavior-ask') }}</option>
                  </select>
                </template>
              </SettingRow>

              <SettingRow
                v-if="resumeBehaviorModel === 'always'"
                data-settings-section="general-restore-scope"
                :title="$t('settings.appearance.restore-scope')"
                :description="$t('settings.appearance.restore-scope-hint')"
              >
                <template #control>
                  <select :value="restoreScopeModel" @change="onRestoreScopeChange(($event.target as HTMLSelectElement).value)">
                    <option value="single">{{ $t('settings.appearance.restore-scope-single') }}</option>
                    <option value="page">{{ $t('settings.appearance.restore-scope-page') }}</option>
                    <option value="tab">{{ $t('settings.appearance.restore-scope-tab') }}</option>
                  </select>
                </template>
              </SettingRow>

              <SettingRow
                data-settings-section="general-resume-concurrency"
                :title="$t('settings.appearance.resume-concurrency')"
                :description="$t('settings.appearance.resume-concurrency-hint')"
              >
                <template #control>
                  <input
                    type="number"
                    :min="MIN_RESUME_CONCURRENCY"
                    :max="MAX_RESUME_CONCURRENCY"
                    :value="resumeConcurrencyModel"
                    @change="onResumeConcurrencyChange(($event.target as HTMLInputElement).value)"
                  />
                </template>
              </SettingRow>

              <SettingRow
                data-settings-section="general-usage-badge"
                :title="$t('usage.settings-title')"
                :description="$t('usage.settings-hint')"
              >
                <template #control>
                  <div class="row-g gap">
                    <ToggleSwitch v-model="usageEnabledModel" @update:modelValue="onUsageEnabledChange" :aria-label="$t('usage.settings-enabled')" />
                    <span class="s-ctrl-label">{{ $t('usage.settings-refresh') }}</span>
                    <select
                      :value="usageRefreshModel"
                      @change="onUsageRefreshChange(($event.target as HTMLSelectElement).value)"
                    >
                      <option v-for="sec in USAGE_REFRESH_OPTIONS" :key="sec" :value="sec">
                        {{ `${sec / 60} min` }}
                      </option>
                    </select>
                  </div>
                </template>
              </SettingRow>

              <SettingRow
                data-settings-section="general-environment"
                :title="$t('settings.appearance.environment')"
                :description="$t('settings.appearance.environment-hint')"
              >
                <template #control>
                  <button class="ap-reset" @click="emit('reopen-onboarding')">{{ $t('settings.appearance.rerun-env-check') }}</button>
                </template>
              </SettingRow>

              <SettingRow
                data-settings-section="general-backend-timeout"
                :title="$t('settings.appearance.backend-timeout')"
                :description="$t('settings.appearance.backend-timeout-hint')"
              >
                <template #control>
                  <input
                    type="number"
                    min="15"
                    max="120"
                    :value="healthCheckTimeoutSec"
                    @change="onHealthTimeoutChange(($event.target as HTMLInputElement).value)"
                  />
                </template>
              </SettingRow>
            </SettingsCard>
          </SettingsSection>

          <SettingsSection :label="$t('settings.appearance.loop-prompt')">
            <SettingsCard>
              <div class="s-fullrow" data-settings-section="general-loop-prompt">
                <p class="ap-hint">{{ $t('settings.appearance.loop-prompt-hint') }}</p>
                <textarea v-model="loopPromptText" rows="4" spellcheck="false" @change="onLoopPromptChange"></textarea>
                <p class="ap-hint">{{ $t('settings.appearance.loop-resume-hint') }}</p>
                <textarea v-model="loopResumeText" rows="2" spellcheck="false" @change="onLoopResumeChange"></textarea>
              </div>
            </SettingsCard>
          </SettingsSection>

          <SettingsSection :label="$t('settings.section.settings-management')">
            <SettingsCard data-settings-section="settings-management">
              <SettingRow
                :title="$t('settings.management.title')"
                :description="$t('settings.management.bundle-hint')"
              >
                <template #control>
                  <div class="row-g gap">
                    <button class="ap-reset" :disabled="settingsBundleBusy" @click="exportSettingsBundle">{{ $t('settings.management.export-bundle') }}</button>
                    <button class="ap-reset" :disabled="settingsBundleBusy" @click="importSettingsBundle">{{ $t('settings.management.import-bundle') }}</button>
                  </div>
                </template>
              </SettingRow>
              <div class="s-fullrow">
                <div class="settings-meta-row inline">
                  <span class="scope-badge">{{ settingsScopeNotes.general.scope }}</span>
                  <span class="settings-path" :title="pathForTab('general')">{{ pathForTab('general') }}</span>
                </div>
                <p v-if="settingsBundleSummary" class="summary-ok">{{ settingsBundleSummary }}</p>
                <p v-if="settingsBundleError" class="err-msg">{{ settingsBundleError }}</p>
              </div>
            </SettingsCard>
          </SettingsSection>
        </div>

        <!-- ══ UPDATES TAB ══ -->
        <div v-show="activeTab === 'updates'" class="s-body updates-body">
          <h1 class="s-page-title">{{ $t('settings.nav.updates') }}</h1>

          <SettingsSection :label="$t('settings.section.updates')">
            <SettingsCard data-settings-section="updates">
              <SettingRow :title="$t('updater.section-title')" :description="$t('updater.section-hint')">
                <template #control>
                  <button class="ap-reset" :disabled="updIsBusy || updateState.status === 'unsupported'" @click="checkForUpdates">{{ $t('updater.check') }}</button>
                </template>
              </SettingRow>
              <div class="s-fullrow">
                <div class="settings-meta-row inline">
                  <span class="scope-badge">{{ $t('updater.current-version') }}</span>
                  <span class="settings-path">v{{ updateState.currentVersion }}</span>
                </div>

                <p v-if="updateState.status === 'checking'" class="ap-hint">{{ $t('updater.checking') }}</p>
                <p v-else-if="updateState.status === 'not-available'" class="summary-ok">{{ $t('updater.up-to-date') }}</p>
                <p v-else-if="updateState.status === 'error'" class="err-msg">{{ $t('updater.error', { message: updateState.message }) }}</p>
                <p v-else-if="updateState.status === 'unsupported'" class="ap-hint">{{ $t('updater.unsupported') }}</p>

                <div v-if="['available', 'downloading', 'downloaded', 'installing'].includes(updateState.status)" class="upd-available">
                  <p class="summary-ok">{{ $t('updater.available', { version: updateState.availableVersion }) }}</p>
                  <p v-if="updateState.status === 'downloading'" class="ap-hint">{{ $t('updater.downloading', { percent: updateState.percent ?? 0 }) }}</p>
                  <p v-else-if="updateState.status === 'downloaded'" class="ap-hint">{{ $t('updater.downloaded') }}</p>
                  <p v-else-if="updateState.status === 'installing'" class="ap-hint">{{ $t('updater.restarting') }}</p>
                  <div v-if="updateState.releaseNotes" class="upd-notes">
                    <div class="ap-hint">{{ $t('updater.release-notes') }}</div>
                    <pre class="upd-notes-body">{{ updateState.releaseNotes }}</pre>
                  </div>
                  <div class="row-g gap">
                    <button v-if="updateState.status === 'available'" class="ap-reset" @click="startDownload">{{ $t('updater.download') }}</button>
                    <button v-else-if="updateState.status === 'downloaded'" class="ap-reset" @click="installUpdate">{{ $t('updater.install') }}</button>
                  </div>
                </div>
              </div>
            </SettingsCard>

            <SettingsCard>
              <SettingRow :title="$t('updater.auto-check')" :description="$t('updater.auto-check-hint')">
                <template #control>
                  <ToggleSwitch
                    :model-value="updSettings.autoCheck"
                    :aria-label="$t('updater.auto-check')"
                    @update:model-value="(v) => updUpdateSettings({ autoCheck: v })"
                  />
                </template>
              </SettingRow>
              <SettingRow :title="$t('updater.auto-download')" :description="$t('updater.auto-download-hint')">
                <template #control>
                  <ToggleSwitch
                    :model-value="updSettings.autoDownload"
                    :aria-label="$t('updater.auto-download')"
                    @update:model-value="(v) => updUpdateSettings({ autoDownload: v })"
                  />
                </template>
              </SettingRow>
              <SettingRow :title="$t('updater.channel')" :description="$t('updater.channel-hint')">
                <template #control>
                  <select :value="updSettings.channel" @change="updUpdateSettings({ channel: ($event.target as HTMLSelectElement).value as UpdateChannel })">
                    <option value="stable">{{ $t('updater.channel-stable') }}</option>
                    <option value="beta">{{ $t('updater.channel-beta') }}</option>
                  </select>
                </template>
              </SettingRow>
              <div v-if="updSettings.channel === 'beta'" class="s-fullrow">
                <p class="ap-hint">{{ $t('updater.beta-warning') }}</p>
              </div>
            </SettingsCard>
          </SettingsSection>
        </div>

        <!-- ══ APPEARANCE TAB ══ -->
        <div v-show="activeTab === 'appearance'" class="s-body appearance-body">
          <h1 class="s-page-title">{{ $t('settings.nav.appearance') }}</h1>

          <SettingsSection :label="$t('settings.section.theme')">
            <div class="ap-section" data-settings-section="appearance-theme">
              <p class="ap-hint">{{ $t('settings.appearance.theme-hint') }}</p>
              <div class="ap-theme-grid">
                <button
                  v-for="t in BUILTIN_THEMES"
                  :key="t.id"
                  :class="['ap-theme-card', { active: currentTheme === t.id }]"
                  @click="setTheme(t.id)"
                >
                  <div class="ap-swatches">
                    <span
                      v-for="(c, i) in (THEME_SWATCHES[t.id] || [])"
                      :key="i"
                      class="ap-swatch"
                      :style="{ background: c }"
                    />
                  </div>
                  <span class="ap-theme-label">{{ t.label }}</span>
                  <span v-if="currentTheme === t.id" class="ap-check">✓</span>
                </button>
              </div>
            </div>

            <div class="ap-section" data-settings-section="appearance-theme">
              <div class="ap-section-head">
                <h3 class="ap-title">{{ $t('settings.appearance.custom-colors') }}</h3>
                <button
                  v-if="hasCustomOverrides"
                  class="ap-reset"
                  @click="resetCustom"
                  title="Reset all custom colors to the built-in theme"
                >
                  {{ $t('settings.appearance.reset-to-defaults') }}
                </button>
              </div>
              <p class="ap-hint">{{ $t('settings.appearance.tweaks-hint') }}</p>
              <div class="ap-color-list">
                <label
                  v-for="tok in CUSTOMIZABLE_TOKENS"
                  :key="tok.id"
                  class="ap-color-row"
                >
                  <input
                    type="color"
                    class="ap-color-input"
                    :value="resolvedTokenValue(tok.id)"
                    @input="onPickColor(tok.id, ($event.target as HTMLInputElement).value)"
                  />
                  <span class="ap-color-name">{{ $t('settings.color.' + tok.id.slice(2)) }}</span>
                  <span class="ap-color-token">{{ tok.id }}</span>
                  <button
                    v-if="customOverrides[tok.id]"
                    class="ap-color-clear"
                    @click.prevent="setCustomOverride(tok.id, null)"
                    :title="$t('action.clear-color-override')"
                  >✕</button>
                </label>
              </div>
            </div>
          </SettingsSection>

          <SettingsSection :label="$t('settings.section.language')">
            <SettingsCard>
              <SettingRow
                data-settings-section="appearance-language"
                :title="$t('settings.appearance.language')"
                :description="$t('settings.appearance.language-hint')"
              >
                <template #control>
                  <div class="ap-lang-row">
                    <button
                      v-for="lang in SUPPORTED_LANGUAGES"
                      :key="lang.value"
                      :class="['ap-lang-btn', { active: currentLanguage === lang.value }]"
                      @click="setLanguage(lang.value)"
                    >
                      {{ lang.label }}
                      <span v-if="currentLanguage === lang.value" class="ap-check">✓</span>
                    </button>
                  </div>
                </template>
              </SettingRow>
            </SettingsCard>
          </SettingsSection>

          <SettingsSection :label="$t('settings.section.other')">
            <SettingsCard>
              <SettingRow
                data-settings-section="appearance-runtime"
                :title="$t('settings.appearance.restore-windows')"
                :description="$t('settings.appearance.restore-windows-hint')"
              >
                <template #control>
                  <ToggleSwitch
                    v-model="autoRestoreWindows"
                    :aria-label="$t('settings.appearance.restore-windows-label')"
                    @update:modelValue="onAutoRestoreChange"
                  />
                </template>
              </SettingRow>
            </SettingsCard>
          </SettingsSection>

        </div>

        <div v-show="activeTab === 'accounts'" class="s-body accounts-body" data-settings-section="accounts">
          <h1 class="s-page-title">{{ $t('settings.nav.accounts') }}</h1>
          <div class="settings-meta-row">
            <span class="scope-badge">{{ settingsScopeNotes.accounts.scope }}</span>
            <span class="settings-path">{{ pathForTab('accounts') }}</span>
          </div>
          <GitAccountsPane :api="accountsApi" />
          <div data-settings-section="cli-accounts" style="margin: 4px 22px 22px; padding-top: 22px; border-top: 1px solid var(--border-default);">
            <CliAccountsPane :api="cliProfilesApi" :workspace-open="workspaceOpen ?? false" @login="(agentKey: string, loginProfileId?: string) => emit('cli-login', agentKey, loginProfileId)" />
          </div>
        </div>

        <!-- ── KEYBOARD SHORTCUTS TAB ────────────────────────────────────── -->
        <div v-show="activeTab === 'shortcuts'" class="s-body shortcuts-body" data-settings-section="shortcuts">
          <h1 class="s-page-title">{{ $t('settings.nav.shortcuts') }}</h1>
          <KeyboardShortcutsHelp />
        </div>

        <!-- ── EXTENSIONS TAB (flag-gated) ───────────────────────────────── -->
        <div v-show="activeTab === 'extensions'" class="s-body" data-settings-section="extensions">
          <h1 class="s-page-title">{{ $t('settings.nav.extensions') }}</h1>
          <ExtensionsPane />
        </div>

        </div>
        <!-- /.s-content -->

      </div>
    </div>

    <!-- Confirm dialogs -->
    <div v-if="rConfirmDelete" class="s-overlay confirm" @click.self="rConfirmDelete = false">
      <div class="confirm-card">
        <h3>{{ $t('settings.roles.delete-confirm-title', { label: rDraft?.label }) }}</h3>
        <p>{{ $t('settings.roles.cannot-undo') }}</p>
        <div class="row-g gap" style="justify-content:flex-end">
          <button class="ghost" @click="rConfirmDelete = false">{{ $t('settings.roles.cancel') }}</button>
          <button class="danger" @click="rDoDelete">{{ $t('action.delete') }}</button>
        </div>
      </div>
    </div>
    <div v-if="rConfirmReset" class="s-overlay confirm" @click.self="rConfirmReset = false">
      <div class="confirm-card">
        <h3>{{ $t('settings.roles.reset-confirm-title') }}</h3>
        <p>{{ $t('settings.roles.reset-confirm-body') }}</p>
        <div class="row-g gap" style="justify-content:flex-end">
          <button class="ghost" @click="rConfirmReset = false">{{ $t('action.cancel') }}</button>
          <button class="danger" @click="rDoReset">{{ $t('action.reset') }}</button>
        </div>
      </div>
    </div>
    <div v-if="sConfirmDelete" class="s-overlay confirm" @click.self="sConfirmDelete = false">
      <div class="confirm-card">
        <h3>Delete stage "{{ sDraft?.id }}"?</h3>
        <p>This action cannot be undone.</p>
        <div class="row-g gap" style="justify-content:flex-end">
          <button class="ghost" @click="sConfirmDelete = false">Cancel</button>
          <button class="danger" @click="sDoDelete">Delete</button>
        </div>
      </div>
    </div>
    <div v-if="false" class="s-overlay confirm">
    </div>
  </Teleport>
</template>

<style scoped>
/* ── Overlay & modal shell ─────────────────────────────────────────────────── */
.s-overlay {
  position: fixed;
  inset: 0;
  background: var(--shadow-overlay);
  z-index: 8000;
  display: flex;
  align-items: center;
  justify-content: center;
  -webkit-app-region: no-drag;
}
.s-overlay.confirm { z-index: 9000; }

.s-modal {
  background: var(--bg-base);
  color: var(--text-bright);
  border: 1px solid var(--border-muted);
  border-radius: 12px;
  width: 92vw;
  max-width: 1100px;
  height: 88vh;
  display: grid;
  grid-template-columns: 232px minmax(0, 1fr);
  overflow: hidden;
  box-shadow: 0 24px 60px rgba(0,0,0,0.7);
}

/* ── Sidebar ─────────────────────────────────────────────────────────────────  */
.s-sidebar {
  display: flex;
  flex-direction: column;
  min-height: 0;
  overflow-y: auto;
  background: var(--bg-inset);
  border-right: 1px solid var(--border-default);
  padding: var(--space-3, 12px) var(--space-2, 8px);
  gap: var(--space-2, 8px);
}
.s-ws-header {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 4px var(--space-row-x);
  min-width: 0;
}
.s-ws-avatar {
  flex-shrink: 0;
  width: 32px;
  height: 32px;
  border-radius: 999px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--bg-selected);
  color: var(--accent-fg);
  font-size: 14px;
  font-weight: 700;
  text-transform: uppercase;
}
.s-ws-meta {
  display: flex;
  flex-direction: column;
  min-width: 0;
  line-height: 1.25;
}
.s-ws-name {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-bright);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.s-ws-sub {
  font-size: 11px;
  color: var(--text-secondary);
}

/* ── Grouped nav ─────────────────────────────────────────────────────────────  */
.s-nav {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-height: 0;
}
.s-nav-group {
  display: flex;
  flex-direction: column;
  gap: 1px;
  padding: 6px 0;
}
.s-nav-group + .s-nav-group {
  border-top: 1px solid var(--border-muted);
}
.s-nav-group-title {
  padding: 4px var(--space-row-x) 6px;
  font-size: 10.5px;
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--text-secondary);
}

/* ── Content pane ────────────────────────────────────────────────────────────  */
.s-content {
  position: relative;
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
}

.s-search-box {
  position: relative;
  width: 100%;
}

/* Narrow viewport: collapse the sidebar to an icon-only rail so the content
   pane keeps its width. Labels stay accessible (visually hidden inside each
   nav item, with a title tooltip); grouping is preserved by the dividers. */
@media (max-width: 720px) {
  .s-modal {
    grid-template-columns: 56px minmax(0, 1fr);
  }
  .s-sidebar {
    padding: var(--space-2, 8px) 4px;
  }
  .s-ws-header {
    justify-content: center;
    padding: 4px 0;
  }
  .s-ws-meta { display: none; }
  .s-search-box { display: none; }
  .s-nav-group-title { display: none; }
}
.s-search-input {
  width: 100%;
  height: 30px;
  background: var(--bg-base);
  border: 1px solid var(--border-default);
  border-radius: 6px;
  color: var(--text-primary);
  font-size: 12px;
  padding: 0 10px;
}
.s-search-input:focus {
  outline: none;
  border-color: var(--accent-emphasis);
  box-shadow: 0 0 0 2px var(--accent-focus);
}
.s-search-results {
  position: absolute;
  top: calc(100% + 8px);
  left: 0;
  z-index: 9100;
  width: min(420px, 78vw);
  max-height: min(420px, 64vh);
  overflow-y: auto;
  background: var(--bg-base);
  border: 1px solid var(--border-default);
  border-radius: 8px;
  box-shadow: 0 16px 36px rgba(0,0,0,0.45);
  padding: 6px;
}
.s-search-result {
  width: 100%;
  border: 0;
  background: transparent;
  color: var(--text-primary);
  text-align: left;
  border-radius: 6px;
  padding: 8px 9px;
  cursor: pointer;
}
.s-search-result:hover,
.s-search-result:focus-visible {
  background: var(--bg-muted);
  outline: none;
}
.s-search-result-main {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  min-width: 0;
}
.s-search-result-title {
  font-size: 12px;
  font-weight: 600;
  color: var(--text-bright);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.s-search-result-group {
  flex-shrink: 0;
  font-size: 10.5px;
  color: var(--text-muted);
}
.s-search-result-summary {
  display: block;
  margin-top: 3px;
  font-size: 11px;
  line-height: 1.35;
  color: var(--text-secondary);
}
.s-search-empty {
  padding: 10px;
  font-size: 11.5px;
  color: var(--text-muted);
}

/* ── Appearance tab ─────────────────────────────────────────────────────────── */
.appearance-body { overflow-y: auto; padding: 18px 22px; }
.ap-section { margin-bottom: 26px; }
.ap-section-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.ap-title { margin: 0 0 4px; font-size: 13px; font-weight: 600; color: var(--text-bright); }
.ap-hint { margin: 0 0 14px; font-size: 11.5px; color: var(--text-secondary); }

/* ── Two-column settings layout (page title / full-width rows / control labels) ── */
.s-page-title {
  margin: 0 0 var(--space-group);
  font-size: var(--font-page-title);
  font-weight: 700;
  color: var(--text-bright);
}
.s-fullrow {
  padding: var(--space-row-y) var(--space-row-x);
}
.s-fullrow > :last-child { margin-bottom: 0; }
.s-ctrl-label { font-size: 11.5px; color: var(--text-secondary); }
/* Controls placed in a SettingRow #control slot: keep them compact and
   right-aligned instead of the full-width default used inside cards/fields. */
.setting-row-control select { width: auto; min-width: 120px; }
.setting-row-control input[type='number'] { width: 96px; }

/* CLI Agents tab — enable/disable + drag-reorder list */
.cli-agent-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
.cli-agent-row {
  display: flex; align-items: center; gap: 10px;
  padding: 8px 12px; border: 1px solid var(--border-default); border-radius: 8px;
  background: var(--bg-elevated);
}
.cli-agent-row.drag-over { box-shadow: inset 0 0 0 2px var(--accent-focus); background: var(--accent-subtle); }
.cli-agent-row.is-disabled { opacity: 0.55; }
.cli-agent-grip { color: var(--text-secondary); cursor: grab; user-select: none; font-size: 14px; }
.cli-agent-toggle { display: flex; align-items: center; gap: 8px; flex: 1; cursor: pointer; margin: 0; }
.cli-agent-label { font-size: 13px; font-weight: 600; }
.cli-agent-hint { font-size: 11px; color: var(--text-secondary); }
.ap-theme-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
  gap: 12px;
}
.ap-theme-card {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 9px;
  padding: 12px;
  border: 1px solid var(--border-default);
  border-radius: 8px;
  background: var(--bg-subtle);
  cursor: pointer;
  transition: border-color 0.12s, background 0.12s;
  text-align: left;
}
.ap-theme-card:hover { border-color: var(--border-strong); background: var(--bg-muted); }
.ap-theme-card.active { border-color: var(--accent-emphasis); box-shadow: 0 0 0 1px var(--accent-emphasis); }
.ap-swatches { display: flex; gap: 4px; }
.ap-swatch { width: 24px; height: 24px; border-radius: 5px; border: 1px solid var(--border-muted); }
.ap-theme-label { font-size: 12px; font-weight: 500; color: var(--text-primary); }
.ap-check { position: absolute; top: 10px; right: 11px; font-size: 12px; color: var(--accent-fg); }
.ap-lang-row { display: flex; gap: 10px; flex-wrap: wrap; }
.ap-toggle-row { display: flex; align-items: center; gap: 8px; cursor: pointer; color: var(--text-primary); font-size: 13px; }
.ap-toggle-row input { cursor: pointer; }
.ap-lang-btn {
  position: relative;
  padding: 8px 20px;
  border: 1px solid var(--border-default);
  border-radius: 8px;
  background: var(--bg-subtle);
  color: var(--text-primary);
  font-size: 13px;
  cursor: pointer;
  transition: border-color 0.12s, background 0.12s;
}
.ap-lang-btn:hover { border-color: var(--border-strong); background: var(--bg-muted); }
.ap-lang-btn.active { border-color: var(--accent-emphasis); box-shadow: 0 0 0 1px var(--accent-emphasis); }
.ap-timeout-field { max-width: 140px; }
.ap-reset {
  font-size: 11px;
  padding: 4px 10px;
  border: 1px solid var(--border-default);
  border-radius: 6px;
  background: transparent;
  color: var(--text-secondary);
  cursor: pointer;
}
.ap-reset:hover { color: var(--danger-fg); border-color: var(--danger-fg); }
.ap-color-list { display: flex; flex-direction: column; gap: 8px; }
.ap-color-row {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 7px 10px;
  border: 1px solid var(--border-muted);
  border-radius: 6px;
  background: var(--bg-subtle);
}
.ap-color-input {
  width: 34px;
  height: 26px;
  padding: 0;
  border: 1px solid var(--border-default);
  border-radius: 5px;
  background: transparent;
  cursor: pointer;
  flex-shrink: 0;
}
.ap-color-name { font-size: 12px; color: var(--text-primary); min-width: 92px; }
.ap-color-token { font-size: 10.5px; color: var(--text-muted); font-family: ui-monospace, monospace; flex: 1; }
.ap-color-clear {
  width: 20px;
  height: 20px;
  border: none;
  border-radius: 4px;
  background: transparent;
  color: var(--text-secondary);
  cursor: pointer;
  font-size: 11px;
}
.ap-color-clear:hover { color: var(--danger-fg); background: var(--bg-muted); }
.s-close {
  position: absolute;
  top: 8px;
  right: 10px;
  z-index: 30;
  border: none;
  background: var(--bg-base);
  color: var(--text-secondary);
  font-size: 16px;
  cursor: pointer;
  padding: 4px 8px;
  border-radius: var(--radius-control);
  line-height: 1;
}
.s-close:hover { background: var(--bg-muted); color: var(--text-bright); }

/* ── Tab body ─────────────────────────────────────────────────────────────── */
.s-body {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-height: 0;
  overflow: hidden;
}
.cli-agents-body { overflow-y: auto; padding: 18px 22px; }
.updates-body { overflow-y: auto; padding: 18px 22px; }
/* Accounts tab stacks two tall blocks (git + CLI accounts); scroll the tab so
   neither squeezes the other to zero height inside the overflow-hidden s-body. */
.accounts-body { display: block; overflow-y: auto; }
.settings-meta-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 16px;
  border-bottom: 1px solid var(--border-muted);
  background: var(--bg-inset);
  color: var(--text-secondary);
  font-size: 11px;
  min-width: 0;
  flex-shrink: 0;
}
.settings-meta-row.inline {
  padding: 7px 9px;
  border: 1px solid var(--border-muted);
  border-radius: 6px;
  margin-top: 10px;
}
.scope-badge {
  flex-shrink: 0;
  border: 1px solid var(--border-default);
  border-radius: 999px;
  padding: 2px 7px;
  color: var(--accent-fg);
  background: var(--bg-muted);
  font-weight: 600;
}
.settings-path {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}
.settings-path-divider { color: var(--text-muted); }
.settings-path-btn {
  flex-shrink: 0;
  border: 1px solid var(--border-default);
  background: transparent;
  color: var(--text-secondary);
  border-radius: 5px;
  padding: 3px 7px;
  font-size: 10.5px;
  cursor: pointer;
}
.settings-path-btn:hover:not(:disabled) {
  color: var(--text-bright);
  background: var(--bg-muted);
}
.settings-path-btn:disabled { opacity: 0.45; cursor: not-allowed; }

/* ── Toolbar inside tab ───────────────────────────────────────────────────── */
.tab-toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 14px;
  border-bottom: 1px solid var(--border-muted);
  flex-shrink: 0;
}
.tab-toolbar button { font-size: 11px; padding: 5px 10px; }
button.tiny {
  padding: 3px 7px;
  font-size: 10.5px;
  line-height: 1.2;
}
.summary-ok { font-size: 11px; color: var(--success-fg); margin-left: 6px; }
.upd-notes-body {
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 160px;
  overflow: auto;
  margin: 4px 0 10px;
  padding: 8px 10px;
  font-size: 11.5px;
  font-family: inherit;
  background: var(--bg-subtle);
  border-radius: 6px;
}

/* ── Split layout (list + detail) ─────────────────────────────────────────── */
.split {
  flex: 1;
  display: grid;
  grid-template-columns: 240px minmax(0, 1fr);
  min-height: 0;
}
.split-list {
  display: flex;
  flex-direction: column;
  border-right: 1px solid var(--border-muted);
  background: var(--bg-inset);
  overflow-y: auto;
  min-height: 0;
}
.split-list .new-btn { margin: 10px 10px 6px; font-size: 12px; }
.split-list ul { list-style: none; margin: 0; padding: 0; }
.split-list li { padding: 9px 12px; border-bottom: 1px solid var(--bg-subtle); cursor: pointer; }
.split-list li:hover { background: var(--bg-subtle); }
.split-list li.active { background: var(--accent-muted); }
.split-detail { padding: 14px 18px; overflow-y: auto; min-height: 0; display: flex; flex-direction: column; gap: 10px; }
.empty-detail { align-items: center; justify-content: center; color: var(--text-muted); }

/* ── Roles tab polish (scoped; pipelines tab keeps base styles) ───────────── */
.roles-body .split-list { padding: 0 8px 8px; }
.roles-body .split-list .new-btn { margin: 10px 2px 8px; border-radius: 6px; }
.roles-body .split-list ul { display: flex; flex-direction: column; gap: 2px; }
.roles-body .split-list li {
  padding: 8px 10px;
  border-bottom: none;
  border-radius: 6px;
  border-left: 2px solid transparent;
}
.roles-body .split-list li.active {
  background: var(--accent-muted);
  border-left-color: var(--accent-emphasis);
}
.roles-body .mono-key { background: var(--bg-muted); padding: 1px 6px; border-radius: 4px; }
.roles-body .badge {
  background: color-mix(in srgb, var(--accent-fg) 12%, transparent);
  color: var(--accent-fg);
  border-radius: 999px;
  padding: 1px 7px;
}
.roles-body .item-sub { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.roles-body .detail-head {
  justify-content: space-between;
  padding-bottom: 10px;
  border-bottom: 1px solid var(--border-muted);
}
.roles-body .detail-head h3 { font-size: 15px; }
.roles-body .split-detail { gap: 12px; }
.roles-body .empty-detail { gap: 10px; }
.roles-body .empty-glyph { font-size: 30px; opacity: 0.3; line-height: 1; }
.roles-body .empty-detail p { margin: 0; font-size: 12px; }

/* ── Fields ───────────────────────────────────────────────────────────────── */
.field { display: flex; flex-direction: column; gap: 4px; }
.lbl { font-size: 10px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.06em; color: var(--text-secondary); }
input[type='text'], input[type='email'], input[type='number'], textarea, select {
  background: var(--bg-subtle);
  border: 1px solid var(--border-default);
  color: var(--text-bright);
  padding: 7px 9px;
  border-radius: 4px;
  font-family: inherit;
  font-size: 12px;
  box-sizing: border-box;
  width: 100%;
}
textarea { font-family: Menlo, Monaco, monospace; resize: vertical; line-height: 1.5; }
input:focus, textarea:focus, select:focus { outline: none; border-color: var(--accent-emphasis); }
input:disabled { opacity: 0.5; cursor: not-allowed; }
.two-col { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 12px; }
.detail-head { display: flex; align-items: center; gap: 8px; margin-bottom: 4px; }
.detail-head h3 { margin: 0; font-size: 14px; }
.check-row { display: flex; align-items: center; gap: 6px; font-size: 12px; cursor: pointer; user-select: none; }
.check-row input[type='checkbox'] { width: 14px; height: 14px; accent-color: var(--accent-fg); }

/* ── List items ───────────────────────────────────────────────────────────── */
.row-g { display: flex; align-items: center; gap: 6px; }
.row-g.gap { gap: 8px; }
.row-g.spread { justify-content: space-between; }
.mono-key { font-family: Menlo, Monaco, monospace; font-size: 10px; color: var(--accent-bright); }
.badge { background: var(--bg-muted); color: var(--text-secondary); font-size: 9px; padding: 1px 5px; border-radius: 3px; }
.item-label { font-weight: 600; font-size: 12px; margin-top: 2px; }
.item-sub { color: var(--text-secondary); font-size: 11px; margin-top: 1px; }
.icon-btn { border: 1px solid var(--border-default); background: var(--bg-muted); color: var(--text-secondary); font-size: 10px; padding: 2px 6px; border-radius: 3px; cursor: pointer; }
.icon-btn:hover:not(:disabled) { background: var(--border-default); color: var(--text-bright); }
.icon-btn:disabled { opacity: 0.35; cursor: not-allowed; }

/* ── Buttons ──────────────────────────────────────────────────────────────── */
button {
  border: 1px solid var(--border-default);
  background: var(--bg-muted);
  color: var(--text-bright);
  font-size: 12px;
  padding: 6px 12px;
  border-radius: 4px;
  cursor: pointer;
}
button:disabled { opacity: 0.45; cursor: not-allowed; }
button.primary { background: var(--success-emphasis); border-color: var(--success-strong); color: var(--text-on-emphasis); font-weight: 600; }
button.primary:not(:disabled):hover { background: var(--success-strong); }
button.danger { background: var(--danger-deep); border-color: var(--danger-muted); color: var(--text-on-emphasis); }
button.danger:hover { background: var(--danger-muted); }
button.ghost { background: transparent; }
button.ghost:hover:not(:disabled) { background: var(--bg-muted); }
.danger-link { color: var(--danger-fg); border-color: transparent; background: transparent; }
.danger-link:hover { background: color-mix(in srgb, var(--danger-fg) 10%, transparent) !important; }

/* ── Messages ─────────────────────────────────────────────────────────────── */
.err-msg { color: var(--danger-fg); font-size: 11px; margin: 0; }
.warn-msg { color: var(--attention-fg); font-size: 11px; margin: 0; }
.hint-msg { color: var(--text-secondary); font-size: 11px; margin: 0; }

/* ── Manager designation (per-slot) ───────────────────────────────────────── */
.manager-toggle { font-size: 11px; line-height: 1.55; padding: 6px 8px; border: 1px solid color-mix(in srgb, var(--manager-fg) 25%, transparent); border-radius: 6px; background: color-mix(in srgb, var(--manager-fg) 4%, transparent); }
.manager-toggle strong { color: var(--manager-fg); }
.manager-toggle code { background: var(--bg-subtle); padding: 1px 4px; border-radius: 3px; font-size: 10px; color: var(--text-bright); }
.manager-badge { font-size: 9px; color: var(--manager-fg); background: color-mix(in srgb, var(--manager-fg) 12%, transparent); border: 1px solid color-mix(in srgb, var(--manager-fg) 30%, transparent); border-radius: 8px; padding: 1px 6px; margin-left: 6px; font-weight: 600; }

/* ── Slots ────────────────────────────────────────────────────────────────── */
.slots-section { border-top: 1px solid var(--border-muted); padding-top: 10px; display: flex; flex-direction: column; gap: 6px; }
.slot-required { color: var(--danger-fg); font-size: 9px; font-weight: 400; text-transform: none; margin-left: 4px; }
.slot-item { background: var(--bg-subtle); border: 1px solid var(--border-muted); border-radius: 6px; padding: 8px 10px; }
.slot-clickable { cursor: pointer; transition: border-color 0.15s; }
.slot-clickable:hover { border-color: var(--accent-focus); }
.slot-form { background: var(--bg-base); border: 1px solid var(--border-default); border-radius: 6px; padding: 12px; display: flex; flex-direction: column; gap: 8px; }

/* ── Appearance tab ─────────────────────────────────────────────────────────── */
.appearance-body { overflow-y: auto; }
.shortcuts-body { overflow-y: auto; padding: 16px 18px; }

/* ── MCP tab ──────────────────────────────────────────────────────────────── */
.mcp-body { overflow-y: auto; display: flex; flex-direction: column; }

/* Top bar */
.mcp-topbar {
  display: flex; align-items: center; gap: 12px; flex-wrap: wrap;
  padding: 12px 16px; border-bottom: 1px solid var(--border-muted);
  flex-shrink: 0; background: var(--bg-inset);
}
.mcp-page-title { font-size: 13px; font-weight: 700; color: var(--text-bright); flex: 1; min-width: 0; }
.mcp-topbar-actions { display: flex; gap: 8px; }
.mcp-action-btn {
  font-size: 11px; padding: 5px 11px; border-radius: 6px;
  background: var(--bg-muted); border: 1px solid var(--border-default); color: var(--text-bright); cursor: pointer;
}
.mcp-action-btn:hover:not(:disabled) { background: var(--border-default); }
.mcp-action-btn:disabled { opacity: 0.4; cursor: not-allowed; }
.mcp-back-btn {
  font-size: 12px; padding: 4px 10px; border-radius: 5px;
  background: transparent; border: 1px solid var(--border-default); color: var(--text-secondary); cursor: pointer;
}
.mcp-back-btn:hover { background: var(--bg-muted); color: var(--text-bright); }
.mcp-summary-ok { font-size: 11px; color: var(--success-fg); padding: 4px 16px; }
.mcp-conflict {
  display: flex; align-items: center; justify-content: space-between; gap: 10px;
  margin: 8px 16px 0; padding: 7px 9px; border-left: 3px solid var(--attention-fg);
  background: color-mix(in srgb, var(--attention-fg) 8%, var(--bg-subtle));
  color: var(--attention-fg); font-size: 11px;
}

/* Server list */
.mcp-server-list { padding: 14px 16px; display: flex; flex-direction: column; gap: 10px; overflow-y: auto; flex: 1; min-height: 0; }
.mcp-loading { color: var(--text-secondary); font-size: 12px; padding: 8px 0; }
.mcp-empty { color: var(--text-muted); font-size: 12px; padding: 24px 0; text-align: center; }

/* Server card */
.mcp-server-card {
  background: var(--bg-subtle); border: 1px solid var(--border-muted); border-radius: 10px;
  display: flex; flex-direction: column; overflow: hidden;
}

/* Main row: dot + name + trash + toggle */
.mcp-server-row {
  display: flex; align-items: center; gap: 10px;
  padding: 12px 14px; min-height: 44px;
}
.mcp-spacer { flex: 1; }
.mcp-server-name { font-weight: 700; font-size: 13px; color: var(--text-bright); min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.mcp-transport-badge {
  padding: 2px 6px; border: 1px solid var(--border-default); border-radius: var(--radius-pill);
  color: var(--text-secondary); background: var(--bg-muted); font-family: Menlo, Monaco, monospace;
  font-size: 9px; text-transform: uppercase;
}

/* Status dot */
.mcp-dot {
  width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0;
}
.mcp-dot.connected { background: var(--success-fg); box-shadow: 0 0 6px color-mix(in srgb, var(--success-fg) 60%, transparent); }
.mcp-dot.error     { background: var(--danger-fg); }
.mcp-dot.disabled  { background: var(--text-disabled); }
.mcp-dot.unknown   { background: var(--text-disabled); }

/* Delete button */
.mcp-delete-btn {
  border: none; background: transparent; color: var(--text-disabled);
  font-size: 14px; cursor: pointer; padding: 2px 4px; border-radius: 4px; line-height: 1;
}
.mcp-delete-btn:hover { color: var(--danger-fg); background: color-mix(in srgb, var(--danger-fg) 10%, transparent); }
.mcp-delete-btn.small { font-size: 10px; color: var(--text-muted); }
.mcp-delete-btn.small:hover { color: var(--danger-fg); }

/* Tools row */
.mcp-tools-row {
  display: flex; align-items: center; gap: 6px;
  padding: 6px 14px; border-top: 1px solid var(--border-muted);
  font-size: 11px; color: var(--text-secondary); cursor: pointer; user-select: none;
}
.mcp-tools-row:hover { background: var(--bg-elevated); }
.mcp-tools-error { color: var(--danger-fg); cursor: default; }
.mcp-tools-disabled { color: var(--text-disabled); cursor: default; }
.mcp-chevron { font-size: 12px; transition: transform 0.15s; display: inline-block; }
.mcp-chevron.open { transform: rotate(90deg); }
.mcp-tool-count { font-size: 11px; }

/* Tool list */
.mcp-tool-list {
  list-style: none; margin: 0; padding: 6px 14px 10px 28px;
  border-top: 1px solid var(--bg-subtle); display: flex; flex-direction: column; gap: 3px;
}
.mcp-tool-list li { font-size: 11px; color: var(--text-secondary); }
.mcp-tool-name { color: var(--accent-bright); font-family: Menlo, Monaco, monospace; }
.mcp-tool-desc { color: var(--text-muted); }

/* Config form toggle */
.mcp-config-toggle {
  display: flex; align-items: center; gap: 6px;
  padding: 5px 14px; border-top: 1px solid var(--border-muted);
  font-size: 11px; color: var(--text-muted); cursor: pointer; user-select: none;
}
.mcp-config-toggle:hover { background: var(--bg-elevated); color: var(--text-secondary); }
.mcp-config-form {
  padding: 10px 14px; border-top: 1px solid var(--border-muted);
  display: flex; flex-direction: column; gap: 8px; background: var(--bg-base);
}
.mcp-config-form select,
.mcp-custom-form select {
  padding: 6px 8px; border: 1px solid var(--border-default); border-radius: 5px;
  background: var(--bg-base); color: var(--text-primary);
}
.mcp-transport-field { max-width: 220px; }

/* Env vars editor */
.mcp-env-row { display: flex; align-items: center; gap: 6px; }
.mcp-env-key { width: 140px; flex-shrink: 0; font-family: Menlo, Monaco, monospace; font-size: 11px; }
.mcp-env-val { flex: 1; min-width: 0; font-family: Menlo, Monaco, monospace; font-size: 11px; }
.mcp-arg-index { width: 18px; color: var(--text-muted); font-family: Menlo, Monaco, monospace; font-size: 10px; text-align: right; }
.mcp-add-env-btn {
  font-size: 10px; padding: 2px 7px; border-radius: 4px;
  background: transparent; border: 1px solid var(--border-default); color: var(--text-secondary); cursor: pointer; margin-left: 6px;
}
.mcp-add-env-btn:hover { background: var(--bg-muted); color: var(--text-bright); }
.mcp-reveal-btn {
  border: 1px solid var(--border-default); border-radius: 4px; background: transparent;
  color: var(--text-secondary); padding: 3px 6px; font-size: 9px; cursor: pointer;
}
.mcp-reveal-btn:hover { color: var(--text-bright); background: var(--bg-muted); }

/* Catalog view */
.mcp-search-wrap {
  position: relative; padding: 12px 16px; border-bottom: 1px solid var(--border-muted); flex-shrink: 0;
}
.mcp-search {
  width: 100%; padding: 8px 36px 8px 12px; border-radius: 8px;
  background: var(--bg-subtle); border: 1px solid var(--border-default); color: var(--text-bright);
  font-size: 12px; box-sizing: border-box;
}
.mcp-search:focus { outline: none; border-color: var(--accent-emphasis); }
.mcp-search-icon {
  position: absolute; right: 28px; top: 50%; transform: translateY(-50%);
  font-size: 13px; color: var(--text-muted); pointer-events: none;
}

.mcp-catalog-hint {
  padding: 8px 16px; font-size: 11px; color: var(--text-secondary); line-height: 1.6;
  background: var(--bg-base); border-bottom: 1px solid var(--border-muted); flex-shrink: 0;
}
.mcp-catalog-hint strong { color: var(--text-bright); }
.mcp-catalog-list {
  padding: 10px 16px; display: flex; flex-direction: column; gap: 1px; overflow-y: auto; flex: 1;
}
.mcp-catalog-card {
  display: flex; align-items: center; gap: 16px;
  padding: 14px 2px; border-bottom: 1px solid var(--border-muted);
}
.mcp-catalog-card:last-child { border-bottom: none; }
.mcp-catalog-info { flex: 1; display: flex; flex-direction: column; gap: 3px; }
.mcp-catalog-name { font-size: 13px; font-weight: 700; color: var(--text-bright); }
.mcp-catalog-desc { font-size: 11px; color: var(--text-secondary); line-height: 1.5; }
.mcp-catalog-note { font-size: 10px; color: var(--attention-fg); margin-top: 2px; }
.mcp-add-btn {
  font-size: 11px; padding: 6px 14px; border-radius: 6px; white-space: nowrap; flex-shrink: 0;
  background: var(--accent-emphasis); border: 1px solid var(--accent-focus); color: var(--text-on-emphasis); font-weight: 600; cursor: pointer;
}
.mcp-add-btn:hover:not(:disabled) { background: var(--accent-focus); }
.mcp-add-btn:disabled { opacity: 0.45; cursor: not-allowed; }
.mcp-installed-badge {
  font-size: 11px; padding: 6px 14px; border-radius: 6px; white-space: nowrap; flex-shrink: 0;
  background: var(--bg-muted); border: 1px solid var(--border-default); color: var(--text-muted); cursor: not-allowed;
}
.mcp-custom-form {
  width: min(520px, calc(100% - 32px)); margin: 16px; padding: 14px;
  display: flex; flex-direction: column; gap: 12px;
  border: 1px solid var(--border-default); border-radius: var(--radius-card); background: var(--bg-subtle);
}
.mcp-custom-form > p { margin: 0; color: var(--text-secondary); font-size: 11px; line-height: 1.5; }
.mcp-custom-actions { display: flex; justify-content: flex-end; gap: 8px; }

/* ── Confirm dialog ───────────────────────────────────────────────────────── */
.confirm-card {
  background: var(--bg-base);
  color: var(--text-bright);
  border: 1px solid var(--border-default);
  border-radius: 8px;
  padding: 20px 24px;
  max-width: 400px;
  width: 90%;
}
.confirm-card h3 { margin: 0 0 8px; font-size: 14px; }
.confirm-card p { font-size: 12px; color: var(--text-primary); margin: 0 0 16px; }

/* ── Analyzer tab ─────────────────────────────────────────────────────────── */
.analyzer-body { display: flex; flex-direction: column; gap: 0; overflow-y: auto; padding: 0; }

.az-section {
  padding: 14px 20px;
  border-bottom: 1px solid var(--border-muted);
  flex-shrink: 0;
}
.az-section-title { font-size: 11px; font-weight: 600; color: var(--text-secondary); text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 10px; }
.az-section-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 10px; }
.az-section-header .az-section-title { margin-bottom: 0; }
.az-section-note { font-size: 10px; color: var(--text-muted); }
.az-subsection { margin-top: 12px; }
.az-status-dot { display: inline-block; width: 7px; height: 7px; border-radius: 50%; margin-right: 5px; }
.az-status-dot.ok { background: var(--success-fg); }
.az-status-dot.err { background: var(--danger-fg); }
.az-pct { font-weight: 600; color: var(--text-bright); margin-left: 6px; }
.az-size-info { color: var(--text-muted); font-size: 11px; margin-left: 4px; }
.az-gguf-hint { font-size: 11px; color: var(--text-muted); margin-top: 6px; line-height: 1.5; }
.az-gguf-hint code { background: var(--bg-subtle); padding: 1px 4px; border-radius: 3px; color: var(--text-bright); }
.az-link { color: var(--accent-fg); text-decoration: none; }
.az-link:hover { text-decoration: underline; }
.az-code { background: var(--bg-subtle); padding: 1px 5px; border-radius: 3px; font-size: 11px; color: var(--text-bright); font-family: monospace; }
.az-url-row { display: flex; gap: 6px; align-items: center; }
.az-url-row .az-input { flex: 1; }
.az-recheck-btn {
  background: var(--bg-muted); border: 1px solid var(--border-default); color: var(--text-secondary);
  font-size: 14px; padding: 6px 10px; border-radius: 6px; cursor: pointer;
  flex-shrink: 0; transition: color 0.15s, background 0.15s;
}
.az-recheck-btn:hover:not(:disabled) { background: var(--border-default); color: var(--text-bright); }
.az-recheck-btn:disabled { opacity: 0.4; cursor: not-allowed; }
.az-detect-btn {
  background: var(--bg-muted); border: 1px solid var(--border-default); color: var(--text-secondary);
  font-size: 11px; font-weight: 500; padding: 6px 10px; border-radius: 6px; cursor: pointer;
  flex-shrink: 0; white-space: nowrap; transition: color 0.15s, background 0.15s;
}
.az-detect-btn:hover:not(:disabled) { background: var(--border-default); color: var(--text-bright); }
.az-detect-btn:disabled { opacity: 0.4; cursor: not-allowed; }
.az-browse-btn {
  background: var(--bg-muted); border: 1px solid var(--border-default); color: var(--text-secondary);
  font-size: 13px; padding: 6px 10px; border-radius: 6px; cursor: pointer;
  flex-shrink: 0; transition: color 0.15s, background 0.15s;
}
.az-browse-btn:hover { background: var(--border-default); color: var(--text-bright); }

.az-backend-toggle { display: flex; gap: 0; border: 1px solid var(--border-default); border-radius: 6px; overflow: hidden; width: fit-content; }
.az-backend-btn {
  background: var(--bg-subtle); border: none; color: var(--text-secondary); font-size: 12px;
  padding: 6px 16px; cursor: pointer; transition: background 0.15s, color 0.15s;
}
.az-backend-btn:hover { background: var(--bg-muted); color: var(--text-bright); }
.az-backend-btn.active { background: var(--accent-emphasis); color: var(--text-on-emphasis); font-weight: 600; }

.az-label { display: block; font-size: 11px; color: var(--text-secondary); margin-bottom: 5px; }
.az-hint-inline { color: var(--text-muted); font-style: italic; }
.az-input {
  width: 100%; box-sizing: border-box;
  background: var(--bg-base); border: 1px solid var(--border-default); color: var(--text-bright);
  font-size: 12px; padding: 7px 10px; border-radius: 6px;
  outline: none; transition: border-color 0.15s;
}
.az-input:focus { border-color: var(--accent-focus); }
.az-status-row { margin-top: 8px; }

.az-pull-row { display: flex; gap: 8px; align-items: center; margin-bottom: 8px; }
.az-pull-input { flex: 1; margin-bottom: 0; }
.az-pull-error { font-size: 11px; color: var(--danger-fg); margin-top: 6px; }

.az-progress-bar-wrap {
  height: 4px; background: var(--bg-muted); border-radius: 2px; margin-top: 6px; overflow: hidden;
}
.az-progress-bar { height: 100%; background: var(--accent-emphasis); border-radius: 2px; transition: width 0.3s; }

.az-model-list { margin-top: 8px; display: flex; flex-direction: column; gap: 4px; max-height: 200px; overflow-y: auto; }
.az-no-models { font-size: 12px; color: var(--text-muted); padding: 8px 0; }
.az-model-row {
  display: flex; align-items: center; justify-content: space-between;
  padding: 7px 10px; background: var(--bg-base); border: 1px solid var(--border-muted); border-radius: 6px;
}
.az-model-info { display: flex; flex-direction: column; gap: 2px; }
.az-model-name { font-size: 12px; color: var(--text-bright); font-family: monospace; }
.az-model-meta { font-size: 10px; color: var(--text-secondary); }
.az-del-btn {
  background: none; border: none; color: var(--text-muted); cursor: pointer; font-size: 12px;
  padding: 2px 6px; border-radius: 4px; transition: color 0.15s, background 0.15s;
}
.az-del-btn:hover { color: var(--danger-fg); background: var(--bg-muted); }

.az-benchmark-section { flex-shrink: 0; display: flex; flex-direction: column; gap: 0; }

.az-version { font-size: 11px; color: var(--text-secondary); }
.az-version.offline { color: var(--danger-fg); }
.az-run-btn {
  background: var(--accent-emphasis);
  border: 1px solid var(--accent-focus);
  color: var(--text-on-emphasis);
  font-size: 12px;
  font-weight: 600;
  padding: 7px 16px;
  border-radius: 6px;
  cursor: pointer;
  transition: background 0.15s;
}
.az-run-btn:hover:not(:disabled) { background: var(--accent-focus); }
.az-run-btn:disabled { opacity: 0.45; cursor: not-allowed; }

.az-progress-wrap {
  padding: 10px 20px;
  border-bottom: 1px solid var(--border-muted);
  background: var(--bg-base);
  flex-shrink: 0;
}
.az-progress-label { font-size: 12px; color: var(--text-secondary); display: flex; align-items: center; gap: 8px; }
.az-spin { animation: spin 1s linear infinite; display: inline-block; }
@keyframes spin { to { transform: rotate(360deg); } }

.az-hint {
  padding: 20px 24px;
  color: var(--text-secondary);
  font-size: 12px;
  line-height: 1.7;
}
.az-hint p { margin: 0 0 10px; }
.az-hint ul { margin: 0 0 10px; padding-left: 18px; }
.az-hint li { margin-bottom: 4px; }
.az-hint code { background: var(--bg-subtle); padding: 1px 5px; border-radius: 3px; font-size: 11px; color: var(--text-bright); }
.az-pass-rule { color: var(--accent-fg); font-size: 11px; }

.az-results { padding: 16px 20px; flex: 1; overflow-y: auto; min-height: 0; }
.az-results-summary {
  font-size: 12px;
  color: var(--text-secondary);
  margin-bottom: 12px;
}
.az-results-summary strong { color: var(--success-fg); }

.az-table { width: 100%; border-collapse: collapse; font-size: 12px; }
.az-table th {
  text-align: left;
  padding: 6px 10px;
  border-bottom: 1px solid var(--border-muted);
  color: var(--text-secondary);
  font-weight: 500;
  white-space: nowrap;
}
.az-th-task, .az-th-score, .az-th-verdict { text-align: center; }
.az-table td { padding: 8px 10px; border-bottom: 1px solid var(--bg-subtle); vertical-align: middle; }
.az-td-model { font-family: monospace; font-size: 11px; color: var(--text-bright); max-width: 220px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.az-td-task { text-align: center; white-space: nowrap; }
.az-td-score { text-align: center; color: var(--text-secondary); }
.az-td-verdict { text-align: center; }
.az-elapsed { font-size: 10px; color: var(--text-secondary); margin-left: 3px; }
.az-na { color: var(--text-disabled); }
.az-row-fail td { color: var(--text-disabled); }
.az-row-fail .az-td-model { color: var(--text-muted); }
.az-badge-pass {
  background: color-mix(in srgb, var(--success-fg) 15%, transparent);
  color: var(--success-fg);
  border: 1px solid color-mix(in srgb, var(--success-fg) 30%, transparent);
  padding: 2px 8px;
  border-radius: 10px;
  font-size: 11px;
  font-weight: 600;
}
.az-badge-fail {
  background: color-mix(in srgb, var(--danger-fg) 10%, transparent);
  color: var(--text-muted);
  border: 1px solid var(--border-muted);
  padding: 2px 8px;
  border-radius: 10px;
  font-size: 11px;
}
/* ── Pipelines tab ─────────────────────────────────────────────────────────── */
.pipelines-body { display: flex; flex-direction: column; gap: 12px; overflow: hidden; }
.pl-create-row { display: flex; gap: 6px; align-items: center; padding: 0 16px; }
.pl-input {
  background: var(--bg-inset); border: 1px solid var(--accent-emphasis); border-radius: 4px;
  color: var(--text-bright); font-size: 12px; padding: 5px 8px; flex: 1;
}
.pl-rename { max-width: 180px; }
.pl-list { list-style: none; margin: 0; padding: 0 16px; display: flex; flex-direction: column; gap: 6px; overflow-y: auto; min-height: 0; }
.pl-item {
  background: var(--bg-subtle); border: 1px solid var(--border-muted); border-radius: 6px;
  padding: 10px 12px; display: flex; flex-direction: column; gap: 6px;
}
.pl-item.pl-active { border-color: var(--accent-emphasis); background: var(--accent-subtle); }
.pl-item-main { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.pl-name { font-size: 13px; font-weight: 600; color: var(--text-bright); flex: 1; }
.pl-active .pl-name { color: var(--accent-bright); }
.pl-meta { font-size: 11px; color: var(--text-muted); }
.pl-badge { font-size: 11px; padding: 3px 10px; border-radius: 20px; font-weight: 600; letter-spacing: 0.02em; }
.pl-badge.active { background: color-mix(in srgb, var(--success-fg) 12%, transparent); color: var(--success-fg); border: 1px solid color-mix(in srgb, var(--success-strong) 45%, transparent); }
.pl-item-actions { display: flex; gap: 6px; flex-wrap: wrap; }
.pl-summary { font-size: 12px; color: var(--success-fg); }
.pl-enter { color: var(--text-muted); font-size: 14px; }
.pl-item:hover .pl-enter { color: var(--text-bright); }
.pl-item { cursor: pointer; }
.pl-back-btn {
  display: inline-flex; align-items: center; gap: 4px;
  background: transparent; border: 1px solid var(--border-default); border-radius: 6px;
  color: var(--text-secondary); font-size: 12px; padding: 4px 10px; cursor: pointer;
  transition: color 0.15s, background 0.15s, border-color 0.15s;
}
.pl-back-btn:hover { color: var(--text-bright); background: var(--bg-muted); border-color: var(--border-strong); }
.pl-set-default-btn {
  display: inline-flex; align-items: center; gap: 3px;
  background: transparent; border: 1px solid var(--border-default); border-radius: 6px;
  color: var(--text-secondary); font-size: 12px; padding: 4px 10px; cursor: pointer;
  transition: color 0.15s, background 0.15s, border-color 0.15s;
}
.pl-set-default-btn:hover:not(:disabled) { color: var(--success-fg); background: color-mix(in srgb, var(--success-fg) 8%, transparent); border-color: color-mix(in srgb, var(--success-fg) 35%, transparent); }
.pl-set-default-btn:disabled { opacity: 0.4; cursor: not-allowed; }
.pl-run-btn {
  display: inline-flex; align-items: center; gap: 5px;
  background: color-mix(in srgb, var(--success-emphasis) 90%, transparent); border: 1px solid var(--success-fg); border-radius: 6px;
  color: var(--text-on-emphasis); font-size: 12px; font-weight: 600; letter-spacing: 0.02em;
  padding: 5px 14px; cursor: pointer;
  transition: background 0.15s, border-color 0.15s, box-shadow 0.15s;
}
.pl-run-btn:hover { background: var(--success-strong); border-color: var(--success-bright); box-shadow: 0 0 0 3px color-mix(in srgb, var(--success-fg) 18%, transparent); }
.pl-delete-icon {
  background: none; border: 1px solid transparent; cursor: pointer;
  color: var(--text-muted); font-size: 14px; padding: 4px 6px; border-radius: 5px;
  opacity: 0.55; transition: opacity 0.15s, color 0.15s, background 0.15s, border-color 0.15s;
}
.pl-delete-icon:hover:not(:disabled) { opacity: 1; color: var(--danger-fg); background: color-mix(in srgb, var(--danger-fg) 8%, transparent); border-color: color-mix(in srgb, var(--danger-fg) 20%, transparent); }
.pl-delete-icon:disabled { opacity: 0.2; cursor: not-allowed; }
.pl-detail-header {
  display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
  padding: 4px 16px 12px; border-bottom: 1px solid var(--border-muted); margin-bottom: 6px; min-height: 36px;
}
.pl-detail-title { font-size: 15px; font-weight: 600; color: var(--accent-bright); margin: 0; flex: 1; display: flex; align-items: center; gap: 6px; }
.pl-rename-icon {
  background: none; border: none; cursor: pointer; color: var(--text-secondary);
  font-size: 13px; padding: 2px 5px; border-radius: 4px; line-height: 1;
  opacity: 0.75; transition: opacity 0.15s, color 0.15s, background 0.15s;
}
.pl-rename-icon:hover { opacity: 1; color: var(--text-bright); background: var(--bg-muted); }
.pl-detail-actions { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin-left: auto; }

.ai-chat-key-row { display: flex; gap: 8px; align-items: center; }
.az-key-table { width: 100%; border-collapse: collapse; }
.az-key-table tr + tr td { padding-top: 6px; }
.az-key-label { width: 130px; font-size: 12px; color: var(--text-muted); padding-right: 10px; white-space: nowrap; vertical-align: middle; }
.az-key-input { width: 100%; box-sizing: border-box; padding: 6px 10px; font-size: 12px; border: 1px solid var(--border-default); border-radius: 5px; background: var(--bg-inset); color: var(--text-bright); font-family: monospace; }
.az-key-input:focus { outline: none; border-color: var(--accent-emphasis); }
.az-key-test-cell {
  width: 260px;
  padding-left: 8px;
  vertical-align: middle;
}
.az-key-test {
  display: inline-block;
  max-width: 190px;
  margin-left: 6px;
  font-size: 10.5px;
  color: var(--text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  vertical-align: middle;
}
.az-key-test.ok { color: var(--success-fg); }
.az-key-test.err { color: var(--danger-fg); }
.ai-chat-key-input {
  flex: 1;
  padding: 7px 10px;
  font-size: 13px;
  border: 1px solid var(--border-default);
  border-radius: 6px;
  background: var(--bg-inset);
  color: var(--text-bright);
  font-family: monospace;
}
.ai-chat-key-input:focus { outline: none; border-color: var(--accent-emphasis); }
.ai-chat-key-save {
  padding: 7px 14px;
  font-size: 12px;
  border: 1px solid var(--accent-emphasis);
  border-radius: 6px;
  background: var(--accent-emphasis);
  color: var(--text-on-emphasis);
  cursor: pointer;
  transition: opacity 0.15s;
}
.ai-chat-key-save:disabled { opacity: 0.4; cursor: not-allowed; }
.ai-chat-key-save:not(:disabled):hover { opacity: 0.85; }
</style>
