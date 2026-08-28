<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import type { useBackend } from '../composables/useBackend'
import type { useRoles } from '../composables/useRoles'
import type { useStages } from '../composables/useStages'
import type { useAnalyzer } from '../composables/useAnalyzer'
import type { usePipelines } from '../composables/usePipelines'
import { MCP_CATALOG, isMcpInstalled, type McpCatalogEntry } from '../data/mcpCatalog'
import { useTheme } from '@navide/plugin-ui/foundation'
import { useSettings } from '../composables/useSettings'
import { settingsGet, settingsSet } from '@navide/plugin-ui/shared'
import {
  cliPermissionKey,
  parseCliPermissionMode,
  type CliPermissionMode
} from '@navide/plugin-shell'
import {
  USAGE_ENABLED_KEY,
  USAGE_REFRESH_OPTIONS,
  setUsageEnabled,
  setUsageRefreshSec,
  usageRefreshSec,
} from '../composables/useUsage'
import {
  AUTO_RESUME_ON_RECONNECT_SETTING_KEY,
  RESUME_BEHAVIOR_SETTING_KEY,
  RESTORE_SCOPE_SETTING_KEY,
  normalizeAutoResumeOnReconnect,
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
} from '@navide/terminal'
import {
  DEFAULT_EDITOR_SETTING_KEY,
  DEFAULT_EDITOR_COMMAND_KEY,
  DEFAULT_EDITOR_ID,
  DETECTABLE_EDITOR_IDS,
  CUSTOM_COMMAND_PRESETS,
  normalizeDefaultEditor,
  parseCustomCommand,
  formatCustomCommand,
  type DetectedEditor,
} from '../lib/defaultEditor'
import { useCliAgentPrefs } from '../composables/useCliAgentPrefs'
import {
  ANY as POLICY_ANY,
  addRule as addPolicyRuleTo,
  allowsOwnDevices,
  makeRule as makePolicyRule,
  readPolicy,
  removeRuleAt as removePolicyRuleAt,
  withOwnDevices,
  type PolicyDocument,
} from '../lib/panePolicy'
import { CLI_AGENT_SPECS } from '@navide/plugin-shell'
import {
  LOOP_PROMPT_SETTING_KEY,
  DEFAULT_LOOP_PROMPT,
  LOOP_RESUME_SETTING_KEY,
  DEFAULT_LOOP_RESUME,
} from '../lib/loopPrompt'
import { useUpdater } from '../composables/useUpdater'
import { updateStages } from '../lib/updaterStages'
import type { UpdateChannel } from '../../../shared/updater'
import {
  CHECK_FAILURE_THRESHOLD_RANGE,
  DOWNLOAD_RETRY_COUNT_RANGE,
  INSTALL_TIMEOUT_SECONDS_RANGE,
} from '../../../shared/updater'
import { useGitAccounts } from '../composables/useGitAccounts'
import GitAccountsPane from './GitAccountsPane.vue'
import CliAccountsPane from './CliAccountsPane.vue'
import CliManagementPanel from './CliManagementPanel.vue'
import type { useCliProfiles } from '../composables/useCliProfiles'
import KeyboardShortcutsEditor from './KeyboardShortcutsEditor.vue'
import CliMessagingHelp from './CliMessagingHelp.vue'
import McpHelp from './McpHelp.vue'
import ExtensionsPane from './ExtensionsPane.vue'
import StorageUsagePane from './StorageUsagePane.vue'
import LayoutSettingsPane from '../layout/LayoutSettingsPane.vue'
import McpPane from './McpPane.vue'
import SkillsPane from './SkillsPane.vue'
import PromptSkillsPane from './PromptSkillsPane.vue'
import MemoryPane from './MemoryPane.vue'
import SettingsNavItem from './settings/SettingsNavItem.vue'
import SettingsSection from './settings/SettingsSection.vue'
import SettingsCard from './settings/SettingsCard.vue'
import SettingRow from './settings/SettingRow.vue'
import ToggleSwitch from './settings/ToggleSwitch.vue'
import { formatBytes } from '../lib/formatBytes'
import {
  RevisionedMcpSaveQueue,
  shouldReloadMcpAfterBundleImport,
  type McpAgent,
  type McpTransport,
  type NativeMcpServer,
  type RevisionedMcpSaveOutcome,
} from '../lib/mcp-settings-editor'

const props = defineProps<{
  backend: ReturnType<typeof useBackend>
  rolesApi: ReturnType<typeof useRoles>
  cliProfilesApi: ReturnType<typeof useCliProfiles>
  /** True when a workspace is open — CLI account sign-in needs one to spawn
   *  the login pane. */
  workspaceOpen?: boolean
  /** Workspaces the app knows about — the Storage tab scans them for
   *  reclaimable build output and logs. */
  workspacePaths?: string[]
  /** The workspace currently open, empty when none is. The Memory tab edits
   *  this project's instruction files, so it needs the open one by name
   *  rather than the first of ``workspacePaths``. */
  workspacePath?: string
  stagesApi: ReturnType<typeof useStages>
  analyzerApi: ReturnType<typeof useAnalyzer>
  pipelinesApi?: ReturnType<typeof usePipelines>
  initialTab?: Tab
  /** Bumped by the caller to re-assert initialTab even when its value is unchanged. */
  tabRequest?: number
  confirmBeforeClose?: boolean
  confirmBeforeClosePane?: boolean
  /** Global permission-bypass toggle. Owned by App.vue; ControlPane edits the
   *  same ref, so this page mirrors it rather than owning a second copy. */
  yoloEnabled?: boolean
  idleReclaimEnabled?: boolean
  idleReclaimMinutes?: string
  /** Panes that could be reclaimed right now, ignoring the idle threshold. */
  reclaimableNowCount?: number
  /** Rough bytes those panes are holding. Estimated, not measured. */
  reclaimableNowBytes?: number
}>()
const emit = defineEmits<{
  (e: 'close'): void
  (e: 'reopen-onboarding'): void
  (e: 'cli-login', agentKey: string, loginProfileId?: string): void
  (e: 'update:confirmBeforeClose', v: boolean): void
  (e: 'update:yoloEnabled', v: boolean): void
  (e: 'update:confirmBeforeClosePane', v: boolean): void
  (e: 'update:idleReclaimEnabled', v: boolean): void
  (e: 'update:idleReclaimMinutes', v: string): void
  (e: 'reclaim-now'): void
}>()
const confirmBeforeCloseModel = computed({
  get: () => props.confirmBeforeClose ?? true,
  set: (v: boolean) => emit('update:confirmBeforeClose', v),
})
// The same toggle the ⌘W dialog's "don't show again" flips — this row is how a
// user who ticked it gets the prompt back.
const confirmBeforeClosePaneModel = computed({
  get: () => props.confirmBeforeClosePane ?? true,
  set: (v: boolean) => emit('update:confirmBeforeClosePane', v),
})
// Reclaiming an idle CLI frees the memory it is sitting on and leaves the
// click-to-resume placeholder behind, so the row reads as a memory setting
// rather than as a way of closing panes.
const idleReclaimEnabledModel = computed({
  get: () => props.idleReclaimEnabled ?? true,
  set: (v: boolean) => emit('update:idleReclaimEnabled', v),
})
const idleReclaimMinutesModel = computed(() => props.idleReclaimMinutes ?? '30')
function onIdleReclaimMinutesChange(v: string): void {
  emit('update:idleReclaimMinutes', v)
}
// The button says what it is about to do — a count and a size — because
// "reclaim" alone does not tell you whether pressing it costs you one pane or
// a dozen. Zero disables it and the row says so rather than hiding, so the
// control does not appear and disappear as panes go idle.
const reclaimNowCount = computed(() => props.reclaimableNowCount ?? 0)
const reclaimNowSize = computed(() => formatBytes(props.reclaimableNowBytes ?? 0))

// ── Tab ───────────────────────────────────────────────────────────────────────
type Tab = 'mcp' | 'skills' | 'prompts' | 'memory' | 'analyzer' | 'cliAgents' | 'general' | 'updates' | 'appearance' | 'layout' | 'accounts' | 'extensions' | 'storage' | 'keybindings' | 'help'

/** Topics inside the Help tab — read-only reference material, no settings. */
type HelpTopic = 'messaging' | 'mcp'
const helpTopic = ref<HelpTopic>('messaging')
const activeTab = ref<Tab>(props.initialTab ?? 'general')
// initialTab is only read once at mount by the ref initializer above; when the
// modal is already open and a new tab is requested (e.g. the ui.settings.open
// action), react to the prop changing too.
watch(() => props.initialTab, (tab) => {
  if (tab) activeTab.value = tab
})
// A repeated request for the tab already named in initialTab does not change
// the prop, so watch the counter too — otherwise pressing Cmd+K Cmd+S while
// Settings sits on another tab does nothing at all.
watch(() => props.tabRequest, () => {
  if (props.initialTab) activeTab.value = props.initialTab
})
// Watching the prop is not enough on its own: re-issuing the same request (⌘K ⌘S
// twice, with a manual tab switch in between) leaves initialTab unchanged, so the
// watcher never fires and the shortcut looks dead. Callers that need to switch an
// already-open modal go through here instead.
defineExpose({
  setTab: (tab: Tab): void => {
    activeTab.value = tab
  },
})

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
// ── Push channels (which CLIs may be handed a message without typing) ────────
// A negative list, like cliDisabled above: every declared channel is on until
// the user says otherwise, so a vendor that gains one later needs no migration.
// The backend reads the same key and is the only place the switch is applied.
const PUSH_DISABLED_KEY = 'pushChannelsDisabled'
const pushDisabled = ref<string[]>(settingsGet<string[]>(PUSH_DISABLED_KEY, []))
const pushChannelRows = computed(() =>
  CLI_AGENT_SPECS.filter((s) => s.pushChannel)
)
function pushChannelEnabled(k: string): boolean {
  return !pushDisabled.value.includes(k)
}
function togglePushChannel(k: string): void {
  const set = new Set(pushDisabled.value)
  // No "keep at least one" rule here, unlike the CLI list: turning every
  // channel off is a valid choice — messages are simply typed in, which is
  // what every pane did before channels existed.
  if (set.has(k)) set.delete(k)
  else set.add(k)
  pushDisabled.value = [...set]
  settingsSet(PUSH_DISABLED_KEY, pushDisabled.value)
}

// ── Permission bypass (global toggle + per-vendor override) ──────────────────
// The global flag is owned by App.vue (ControlPane edits the same ref), so it
// travels as a model prop rather than being written here — two writers on one
// settings key would leave App's ref stale until reload.
const yoloModel = computed({
  get: () => props.yoloEnabled ?? true,
  set: (v: boolean) => emit('update:yoloEnabled', v),
})
/** CLIs that declare a bypass flag. The rest (grok / opencode / pi) have no
 *  permission gate to skip, so an override row for them would be a no-op. */
const permissionRows = computed(() => CLI_AGENT_SPECS.filter((s) => s.skipPermissionFlag))
const permissionModes = ref<Record<string, CliPermissionMode>>(
  Object.fromEntries(
    CLI_AGENT_SPECS.filter((s) => s.skipPermissionFlag).map((s) => [
      s.agentKey,
      parseCliPermissionMode(settingsGet<string | null>(cliPermissionKey(s.agentKey), null)),
    ])
  )
)
function cliPermissionMode(k: string): CliPermissionMode {
  return permissionModes.value[k] ?? 'inherit'
}
function setCliPermissionMode(k: string, mode: CliPermissionMode): void {
  permissionModes.value = { ...permissionModes.value, [k]: mode }
  // 'inherit' is the absence of an override, so it clears the key instead of
  // storing a value the resolver would read the same way anyway.
  settingsSet(cliPermissionKey(k), mode === 'inherit' ? null : mode)
}
function onPermissionSelect(k: string, e: Event): void {
  setCliPermissionMode(k, parseCliPermissionMode((e.target as HTMLSelectElement).value))
}
/** Named in the footnote so the list's absences are explained rather than
 *  looking like an oversight. */
const flaglessVendors = computed(() =>
  CLI_AGENT_SPECS.filter((s) => !s.skipPermissionFlag)
    .map((s) => s.label)
    .join(' / ')
)

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
  helpTopic?: HelpTopic
}

const settingsSearchQuery = ref('')
const settingsSearchItems = computed<SettingsSearchItem[]>(() => [
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
    id: 'mcp-agents',
    tab: 'mcp',
    section: 'mcp-agents',
    mcpView: 'list',
    title: "Every CLI's MCP / 各 CLI 的 MCP",
    group: 'MCP',
    summary: "Read-only view of the MCP servers each CLI keeps in its own config, and where each server is set up.",
    keywords: 'mcp native cli claude codex copilot cursor kimi grok reflect compare matrix 原生 對照 各家 設定檔 唯讀',
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
    id: 'prompts',
    tab: 'prompts',
    section: 'prompts',
    title: 'Prompt Skills / Prompt 技能',
    group: 'Integrations',
    summary: 'Create and edit the prompt skills a CLI pane can cast from its loop button.',
    keywords: 'prompt skills loop 技能 提示詞 迴圈 循環 按鈕 預設 preset resume 續跑 輪次 max turns',
  },
  {
    id: 'memory',
    tab: 'memory',
    section: 'memory',
    title: 'Memory / 記憶',
    group: 'Integrations',
    summary: "View and edit the instruction files each CLI reads: CLAUDE.md, AGENTS.md, QWEN.md, .cursor rules.",
    keywords: 'memory instructions claude.md agents.md qwen.md cursor rules mdc context 指示檔 記憶 規則 說明檔',
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
    id: 'appearance-theme',
    tab: 'appearance',
    section: 'appearance-theme',
    title: 'Theme & Custom Colors / 主題與自訂顏色',
    group: 'Appearance',
    summary: 'Built-in themes and semantic color overrides.',
    keywords: 'appearance theme custom colors color 外觀 主題 自訂顏色 背景 文字 邊框 accent high contrast',
  },
  {
    id: 'general-default-editor',
    tab: 'general',
    section: 'general-default-editor',
    title: 'Default Editor / 預設編輯器',
    group: 'General',
    summary: 'Choose where files and folders open: Mini-IDE, the system default app, VS Code, Cursor, or a custom command.',
    keywords: 'default editor open with mini-ide system vscode visual studio code cursor sublime custom command placeholder 預設編輯器 開啟 外部編輯器 自訂命令 偵測',
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
    id: 'general-p2p',
    tab: 'general',
    section: 'general-p2p',
    title: 'Cross-device Messaging / 跨裝置傳訊',
    group: 'General',
    summary: 'Link this machine to a Navide-Server so agents can message agents on your other devices.',
    keywords: 'p2p cross device remote server url access token navide-server connect link relay 跨裝置 遠端 伺服器 網址 權杖 連線 傳訊',
  },
  {
    id: 'general-p2p-policy',
    tab: 'general',
    section: 'general-p2p-policy',
    title: 'Cross-device Authorization / 跨裝置授權',
    group: 'General',
    summary: 'Choose which remote devices may send instructions to panes on this machine. Everything is refused until a rule allows it.',
    keywords: 'policy permission authorization allow rule deny default pane cross device remote rejected 政策 權限 授權 允許 規則 拒絕 跨裝置 被擋',
  },
  {
    id: 'general-p2p-members',
    tab: 'general',
    section: 'general-p2p-members',
    title: 'Team Members / 團隊成員',
    group: 'General',
    summary: 'See who belongs to this team space; admins can invite people, change roles and disable access.',
    keywords: 'team member membership invite token role admin observer revoke disable account seat 團隊 成員 邀請 權杖 角色 管理員 觀察者 停用 撤銷',
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
    tab: 'keybindings',
    section: 'keybindings',
    title: 'Keyboard Shortcuts Reference / 快捷鍵對照',
    group: 'System',
    summary: 'Every shortcut in one place: the editable rule table, plus read-only sections for terminal and native-menu keys.',
    keywords: 'keyboard shortcuts keys keybinding hotkey 快捷鍵 鍵盤 按鍵 workbench editor terminal cli ctrl cmd shift option',
  },
  {
    id: 'keybindings',
    tab: 'keybindings',
    section: 'keybindings',
    title: 'Customize Shortcuts / 自訂快捷鍵',
    group: 'System',
    summary: 'Rebind, add or remove keyboard shortcuts. Records the keys you press, flags conflicts, and resets to defaults per row.',
    keywords: 'keybinding keybindings customize rebind remap shortcut shortcuts hotkey chord conflict reset 自訂 快捷鍵 改鍵 重新綁定 衝突 還原 keybindings.json',
  },
  {
    id: 'storage',
    tab: 'storage',
    section: 'storage',
    title: 'Storage / 儲存空間',
    group: 'System',
    summary: 'Scan disk usage across app data, Electron caches, CLI homes and workspaces, then clean up reclaimable space.',
    keywords: 'storage disk space usage cache caches cleanup clean logs node_modules stale free 儲存 空間 磁碟 快取 清理 清除 日誌 佔用 釋出',
  },
  {
    id: 'help-mcp',
    tab: 'help',
    section: 'help',
    helpTopic: 'mcp',
    title: 'MCP 說明 / How Navide uses MCP',
    group: 'Help',
    summary: 'The two directions MCP is used in: tools Navide offers CLI agents, and external servers Navide reads docs from.',
    keywords: 'mcp model context protocol tool tools plan cli agent server client context7 github filesystem 說明 介紹 工具 計畫 外部 文件 注入 怎麼用 為什麼用不到',
  },
  {
    id: 'help-cli-messaging',
    tab: 'help',
    section: 'help',
    helpTopic: 'messaging',
    title: 'CLI 互傳訊息 / Inter-CLI Messaging',
    group: 'Help',
    summary: 'How one CLI agent sends an instruction to another — addressing, delivery timing, guard rails, and troubleshooting.',
    keywords: 'help guide messaging message send cli agent pane cross workspace address broadcast queue rate limit troubleshooting 說明 教學 訊息 傳訊 互傳 傳送 指令 位址 跨工作區 廣播 佇列 頻率 疑難排解 怎麼用',
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
  if (item.tab === 'help' && item.helpTopic) helpTopic.value = item.helpTopic
  settingsSearchQuery.value = ''
  await nextTick()
  requestAnimationFrame(() => {
    const target = document.querySelector<HTMLElement>(`[data-settings-section="${item.section}"]`)
    target?.scrollIntoView({ block: 'start', behavior: 'smooth' })
  })
}

// Git account manager (safeStorage-backed). Lazy-loaded on tab entry.
const accountsApi = useGitAccounts()

// ── Antigravity credential provisioning (dev/maintainer only) ────────────────
// Writes ~/navide-signing/usage_secrets.py so the next release build bundles
// Antigravity's public installed-app OAuth constants. Gated to dev builds via
// import.meta.env.DEV, so packaged end-user builds never show it.
const isDev = import.meta.env.DEV
const signingClientId = ref('')
const signingClientSecret = ref('')
const signingSaveStatus = ref<'idle' | 'saving' | 'saved' | 'error'>('idle')
function saveSigningSecrets(): void {
  if (!signingClientId.value.trim() || !signingClientSecret.value.trim()) {
    signingSaveStatus.value = 'error'
    return
  }
  signingSaveStatus.value = 'saving'
  props.backend.send<{ ok: boolean }>('usage.secrets.write', {
    client_id: signingClientId.value.trim(),
    client_secret: signingClientSecret.value.trim(),
  })
    .then(r => { signingSaveStatus.value = r?.ok ? 'saved' : 'error' })
    .catch(() => { signingSaveStatus.value = 'error' })
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

// Whether a pane whose PTY died with the backend is resumed automatically once
// the backend is back. Separate from resumeBehavior above: that one is about
// opening a workspace, this one about a crash interrupting work in progress.
const autoResumeOnReconnectModel = ref(
  normalizeAutoResumeOnReconnect(settingsGet(AUTO_RESUME_ON_RECONNECT_SETTING_KEY, true))
)
function onAutoResumeOnReconnectChange(): void {
  settingsSet(AUTO_RESUME_ON_RECONNECT_SETTING_KEY, autoResumeOnReconnectModel.value)
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

// ── Default editor ──────────────────────────────────────────────────────────
// Which editor file/folder opens are routed to. The detected list (absolute
// paths + availability) comes from the main process, which owns the lookup.
const customEditorCommand = ref<string[]>(
  settingsGet<string[]>(DEFAULT_EDITOR_COMMAND_KEY, [])
)
const customEditorCommandText = ref(formatCustomCommand(customEditorCommand.value))
const defaultEditorModel = ref(
  normalizeDefaultEditor(
    settingsGet(DEFAULT_EDITOR_SETTING_KEY, DEFAULT_EDITOR_ID),
    customEditorCommand.value
  )
)
const detectedEditors = ref<DetectedEditor[]>([])
const detectingEditors = ref(false)

async function loadDetectedEditors(refresh = false): Promise<void> {
  detectingEditors.value = true
  try {
    detectedEditors.value = (await window.agentTeam?.listEditors?.(refresh)) ?? []
  } catch {
    detectedEditors.value = []
  } finally {
    detectingEditors.value = false
  }
}

function isEditorAvailable(id: string): boolean {
  return detectedEditors.value.some((editor) => editor.id === id && editor.available)
}

/** Absolute path the selected editor resolved to, when there is one to show. */
const selectedEditorCommand = computed(() => {
  const hit = detectedEditors.value.find((editor) => editor.id === defaultEditorModel.value)
  return hit?.available ? hit.command : ''
})

function onDefaultEditorChange(value: string): void {
  // Not normalized here: picking `custom` before typing a command must stick so
  // the command field can appear. Main normalizes again when it reads.
  defaultEditorModel.value = value
  settingsSet(DEFAULT_EDITOR_SETTING_KEY, value)
}

function onCustomEditorCommandChange(text: string): void {
  customEditorCommandText.value = text
  customEditorCommand.value = parseCustomCommand(text)
  settingsSet(DEFAULT_EDITOR_COMMAND_KEY, customEditorCommand.value)
}

function onCustomEditorPresetChange(select: HTMLSelectElement): void {
  const preset = CUSTOM_COMMAND_PRESETS.find((entry) => entry.id === select.value)
  // Snap back to the placeholder so the same preset can be picked again.
  select.value = ''
  if (!preset) return
  onCustomEditorCommandChange(formatCustomCommand(preset.command))
}

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
// checkedAt only moves when a check succeeds, so it reads as "last known good"
// next to a run of failures.
const updLastSuccessfulCheck = computed(() =>
  updateState.value.checkedAt ? new Date(updateState.value.checkedAt).toLocaleString() : ''
)
// check → download → install, so the panel shows where the update actually is
// rather than leaving the user to infer it from one status line.
const updStages = computed(() => updateStages(updateState.value))

// ── Settings management / metadata ──────────────────────────────────────────
interface SettingsPaths {
  app_data_dir?: string
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

/** Tabs that actually hold settings. `help` is read-only reference material, so
 *  it has no scope badge and no settings file to reveal. */
type SettingsTab = Exclude<Tab, 'help'>

const settingsScopeNotes: Record<SettingsTab, { scope: string; storage: keyof SettingsPaths | 'localStorage' | 'mainProcess' | 'safeStorage' | 'cliFiles' }> = {
  mcp: { scope: 'User', storage: 'mcp' },
  skills: { scope: 'User', storage: 'skills' },
  prompts: { scope: 'User', storage: 'localStorage' },
  // The CLIs' own instruction files: each one lives where its CLI looks for
  // it, so the pane shows per-file paths and this tab has none of its own.
  memory: { scope: 'User / Workspace', storage: 'cliFiles' },
  analyzer: { scope: 'User', storage: 'analyzer' },
  cliAgents: { scope: 'User', storage: 'localStorage' },
  general: { scope: 'User', storage: 'localStorage' },
  updates: { scope: 'User', storage: 'mainProcess' },
  appearance: { scope: 'User', storage: 'localStorage' },
  // One arrangement for every workspace, shared live across windows.
  layout: { scope: 'User', storage: 'localStorage' },
  accounts: { scope: 'User / Workspace bindings', storage: 'safeStorage' },
  extensions: { scope: 'User', storage: 'mainProcess' },
  storage: { scope: 'User', storage: 'app_data_dir' },
  keybindings: { scope: 'User', storage: 'mainProcess' },
}

async function loadSettingsPaths(): Promise<void> {
  try {
    const resp = await props.backend.send<{ paths: SettingsPaths }>('settings.paths', {})
    if (resp.ok && resp.payload?.paths) settingsPaths.value = resp.payload.paths
  } catch { /* non-fatal */ }
}

function pathForTab(tab: SettingsTab): string {
  const storage = settingsScopeNotes[tab].storage
  if (storage === 'localStorage') return 'ui_settings.json (app data) + workspace backup'
  if (storage === 'mainProcess') return 'Electron main process userData'
  if (storage === 'safeStorage') return 'Encrypted local safeStorage registry'
  if (storage === 'cliFiles') return "Each CLI's own instruction files"
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
    const applied = resp.payload?.applied ?? []
    if (shouldReloadMcpAfterBundleImport(applied)) await mLoad(true)
    settingsBundleSummary.value = `Imported: ${applied.join(', ') || 'appearance'}`
  } catch (err) {
    settingsBundleError.value = err instanceof Error ? err.message : 'Import failed'
  } finally {
    settingsBundleBusy.value = false
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

// ── Cross-device link (Navide-Server) ─────────────────────────────────────────
// The server URL lives in ui_settings and the access token in the credential
// vault, but both go out through one backend call so the link reconnects once,
// with the final pair, instead of dialling on a half-edited configuration.
interface P2pLinkStatus {
  state: 'unconfigured' | 'connecting' | 'connected' | 'unreachable' | 'unauthorized'
  serverUrl: string
  hasToken: boolean
  detail: string
  deviceId: string
  memberId: string
  /** Which account this machine is signed in as. Empty when the credential was
   *  pasted in by hand rather than obtained by signing in — both are valid, so
   *  this decides which face the card shows, not whether it works. */
  accountEmail?: string
  tenantId?: string
  displayName?: string
  role?: string
}
/** "Connecting" has to resolve on its own, so the section re-asks while it is
 *  on screen rather than freezing on whatever the save call answered. */
const P2P_POLL_MS = 3000
const p2pServerUrl = ref('')
/** Write-only. The backend never sends a stored token back, so an empty box
 *  means "keep what is stored", not "there is none". */
const p2pTokenInput = ref('')
const p2pStatus = ref<P2pLinkStatus | null>(null)
const p2pBusy = ref(false)
const p2pError = ref('')

// Sign-in. Registering creates this user's own tenant (a private network of
// their machines) plus its first admin; signing in exchanges the password for
// the long-lived device token. The password is sent once and never stored:
// what lands in the vault is the token, which is exactly what a hand-pasted
// credential already was — so the "token" tab stays as a peer, not a fallback,
// for machines with no account (CI, servers) and for everyone already using one.
type P2pMode = 'login' | 'register' | 'token'
const p2pMode = ref<P2pMode>('login')
const p2pEmail = ref('')
const p2pPassword = ref('')
const p2pDisplayName = ref('')
const p2pTenantName = ref('')

/** Signed in *as an account*, as opposed to holding a hand-pasted token. */
const p2pSignedIn = computed(() => Boolean(p2pStatus.value?.accountEmail))

function resetP2pAccountForm(): void {
  p2pPassword.value = ''
  p2pDisplayName.value = ''
  p2pTenantName.value = ''
}

async function submitP2pAccount(verb: 'login' | 'register'): Promise<void> {
  p2pBusy.value = true
  p2pError.value = ''
  try {
    const payload: Record<string, unknown> = {
      serverUrl: p2pServerUrl.value,
      email: p2pEmail.value,
      password: p2pPassword.value,
    }
    if (verb === 'register') {
      if (p2pDisplayName.value.trim()) payload.displayName = p2pDisplayName.value
      if (p2pTenantName.value.trim()) payload.tenantName = p2pTenantName.value
    }
    const resp = await props.backend.send<{ status: P2pLinkStatus }>(`p2p.account.${verb}`, payload)
    if (!resp.ok) {
      p2pError.value = resp.error?.message ?? 'Sign-in failed'
      return
    }
    // The password has served its purpose the moment a token comes back.
    resetP2pAccountForm()
    if (resp.payload?.status) p2pStatus.value = resp.payload.status
  } catch (err) {
    p2pError.value = err instanceof Error ? err.message : String(err)
  } finally {
    p2pBusy.value = false
  }
}

async function p2pLogout(): Promise<void> {
  p2pBusy.value = true
  p2pError.value = ''
  try {
    const resp = await props.backend.send<{ status: P2pLinkStatus }>('p2p.account.logout', {})
    if (!resp.ok) {
      p2pError.value = resp.error?.message ?? 'Sign-out failed'
      return
    }
    resetP2pAccountForm()
    p2pMode.value = 'login'
    if (resp.payload?.status) p2pStatus.value = resp.payload.status
  } catch (err) {
    p2pError.value = err instanceof Error ? err.message : String(err)
  } finally {
    p2pBusy.value = false
  }
}
let p2pUrlSeeded = false
let p2pTimer: ReturnType<typeof setInterval> | null = null

async function loadP2pStatus(): Promise<void> {
  try {
    const resp = await props.backend.send<{ status: P2pLinkStatus }>('p2p.link.status', {})
    if (!resp.ok || !resp.payload?.status) return
    p2pStatus.value = resp.payload.status
    // Seeded once: the poll must not overwrite a URL the user is halfway
    // through typing.
    if (!p2pUrlSeeded) {
      p2pServerUrl.value = resp.payload.status.serverUrl
      p2pUrlSeeded = true
    }
  } catch { /* non-fatal — the status line keeps its last value */ }
}

async function applyP2pLink(payload: Record<string, unknown>): Promise<void> {
  p2pBusy.value = true
  p2pError.value = ''
  try {
    const resp = await props.backend.send<{ status: P2pLinkStatus }>('p2p.link.configure', payload)
    if (!resp.ok) {
      p2pError.value = resp.error?.message ?? 'Failed to apply the cross-device settings'
      return
    }
    p2pTokenInput.value = ''
    if (resp.payload?.status) p2pStatus.value = resp.payload.status
  } catch (err) {
    p2pError.value = err instanceof Error ? err.message : String(err)
  } finally {
    p2pBusy.value = false
  }
}

async function saveP2pLink(): Promise<void> {
  const payload: Record<string, unknown> = { serverUrl: p2pServerUrl.value }
  if (p2pTokenInput.value) payload.token = p2pTokenInput.value
  await applyP2pLink(payload)
}

async function clearP2pLink(): Promise<void> {
  p2pServerUrl.value = ''
  p2pTokenInput.value = ''
  await applyP2pLink({ serverUrl: '', token: '' })
}

const p2pState = computed(() => p2pStatus.value?.state ?? 'unconfigured')
const p2pDotClass = computed(() => {
  if (p2pState.value === 'connected') return 'ok'
  if (p2pState.value === 'unauthorized') return 'err'
  if (p2pState.value === 'unreachable') return 'warn'
  return 'idle'
})

// ── Cross-device authorization (receiver-side pane policy) ───────────────────
// Who, on another device, may drive a pane on *this* machine. Deny by default
// with allow-only rules, stored on the server and cached here — so the list is
// readable while the link is down and writable only while it is up. Panes on
// one machine never consult it, which is why the whole block only appears once
// a server is configured.
const { t } = useI18n()
interface P2pPolicyDevice { deviceId: string; deviceName: string; paneCount: number }
interface P2pPolicyState {
  state: string
  editable: boolean
  policy: unknown
  revision: number | null
  deviceId: string
  memberId: string
  devices: P2pPolicyDevice[]
}
const p2pPolicy = ref<P2pPolicyState | null>(null)
const p2pPolicyBusy = ref(false)
const p2pPolicyError = ref('')
const newRuleMemberScope = ref<'mine' | 'any'>('mine')
const newRuleDeviceId = ref('')
const newRuleWorkspace = ref('')
const newRulePaneName = ref('')

const policyDoc = computed<PolicyDocument>(() => readPolicy(p2pPolicy.value?.policy))
const policyMemberId = computed(() => p2pPolicy.value?.memberId ?? '')
const policyDevices = computed<P2pPolicyDevice[]>(() => p2pPolicy.value?.devices ?? [])
const policyEditable = computed(() => p2pPolicy.value?.editable === true && !p2pPolicyBusy.value)
const policyAllowsOwnDevices = computed(() =>
  allowsOwnDevices(policyDoc.value, policyMemberId.value)
)

async function loadP2pPolicy(): Promise<void> {
  // A save owns the state while it is in flight; a poll landing after it would
  // put the pre-save rules back on screen for one tick.
  if (p2pPolicyBusy.value) return
  try {
    const resp = await props.backend.send<P2pPolicyState>('p2p.policy.get', {})
    if (!resp.ok || !resp.payload) return
    p2pPolicy.value = resp.payload
  } catch { /* non-fatal — the list keeps its last value */ }
}

async function saveP2pPolicy(next: PolicyDocument): Promise<boolean> {
  p2pPolicyBusy.value = true
  p2pPolicyError.value = ''
  try {
    const resp = await props.backend.send<P2pPolicyState>('p2p.policy.set', { policy: next })
    if (!resp.ok) {
      p2pPolicyError.value = resp.error?.message ?? 'Failed to save the authorization rules'
      return false
    }
    if (resp.payload) p2pPolicy.value = resp.payload
    return true
  } catch (err) {
    p2pPolicyError.value = err instanceof Error ? err.message : String(err)
    return false
  } finally {
    p2pPolicyBusy.value = false
  }
}

async function toggleOwnDevices(input: HTMLInputElement): Promise<void> {
  if (!policyMemberId.value) return
  await saveP2pPolicy(withOwnDevices(policyDoc.value, policyMemberId.value, input.checked))
  // A refused save leaves the computed exactly as it was, and an unchanged
  // binding re-renders nothing — so the box would keep the click and show a
  // permission that was never granted.
  input.checked = policyAllowsOwnDevices.value
}

async function addP2pPolicyRule(): Promise<void> {
  const rule = makePolicyRule({
    memberId: newRuleMemberScope.value === 'mine' ? policyMemberId.value : POLICY_ANY,
    deviceId: newRuleDeviceId.value || POLICY_ANY,
    workspace: newRuleWorkspace.value,
    paneName: newRulePaneName.value,
  })
  if (await saveP2pPolicy(addPolicyRuleTo(policyDoc.value, rule))) {
    newRuleDeviceId.value = ''
    newRuleWorkspace.value = ''
    newRulePaneName.value = ''
  }
}

async function removeP2pPolicyRule(index: number): Promise<void> {
  await saveP2pPolicy(removePolicyRuleAt(policyDoc.value, index))
}

/** Rule fields as the list renders them: `*` becomes the localized "any". */
function policyFieldLabel(value: string): string {
  return value === POLICY_ANY ? t('settings.p2p.policy.any') : value
}

function policyMemberLabel(memberId: string): string {
  if (memberId === POLICY_ANY) return t('settings.p2p.policy.any-member')
  if (memberId === policyMemberId.value) return t('settings.p2p.policy.my-account')
  return memberId
}

function policyDeviceLabel(deviceId: string): string {
  if (deviceId === POLICY_ANY) return t('settings.p2p.policy.any-device')
  const known = policyDevices.value.find((device) => device.deviceId === deviceId)
  return known?.deviceName || deviceId
}

// ── Team members ─────────────────────────────────────────────────────────────
// Who belongs to this team space. The roster and the role both come from the
// server — `canManage` is the backend's answer, never derived here, because a
// pane that guessed would offer buttons every request is going to refuse.
// Invite is deliberately the whole flow: the server mints a one-time token and
// the admin hands it over out of band, which is why it is shown once, loudly.
const MEMBER_ROLES = ['admin', 'member', 'observer'] as const
type MemberRole = (typeof MEMBER_ROLES)[number]
interface TeamMember {
  memberId: string
  displayName?: string
  email?: string
  role: MemberRole
  disabled?: boolean
}
interface P2pMembersState {
  state: string
  role: string
  memberId: string
  canManage: boolean
  members: TeamMember[]
}
interface InviteResult {
  memberId: string
  displayName?: string
  email?: string
  role?: string
  token: string
}
const p2pMembers = ref<P2pMembersState | null>(null)
const membersBusy = ref(false)
const membersError = ref('')
const membersNotice = ref('')
/** The one-time invite token, held on screen until the admin says they have it.
 *  Nothing can bring it back once this is cleared. */
const memberInvite = ref<InviteResult | null>(null)
const memberInviteCopied = ref(false)
const inviteName = ref('')
const inviteEmail = ref('')
const inviteRole = ref<MemberRole>('member')
/** memberId whose disable is waiting for confirmation. */
const memberRevoking = ref('')

const membersList = computed<TeamMember[]>(() => p2pMembers.value?.members ?? [])
const membersCanManage = computed(() => p2pMembers.value?.canManage === true && !membersBusy.value)
const myMemberId = computed(() => p2pMembers.value?.memberId ?? '')
/** Connected, but signed in as a member or observer: the roster is readable and
 *  nothing on it is actionable. Distinct from being offline. */
const membersReadonlyByRole = computed(
  () => p2pMembers.value?.state === 'connected' && p2pMembers.value?.canManage === false
)

async function loadP2pMembers(): Promise<void> {
  // Same reason as the policy poll: a write owns the state while it is in
  // flight, and a poll landing after it would flash the pre-write roster.
  if (membersBusy.value) return
  try {
    const resp = await props.backend.send<P2pMembersState>('p2p.members.list', {})
    if (!resp.ok || !resp.payload) return
    p2pMembers.value = resp.payload
  } catch { /* non-fatal — the roster keeps its last value */ }
}

async function membersWrite(
  type: string,
  payload: Record<string, unknown>
): Promise<{ result: Record<string, unknown>; state: P2pMembersState } | null> {
  membersBusy.value = true
  membersError.value = ''
  try {
    const resp = await props.backend.send<{ result: Record<string, unknown>; state: P2pMembersState }>(type, payload)
    if (!resp.ok || !resp.payload) {
      membersError.value = resp.error?.message ?? 'The server refused the change'
      return null
    }
    p2pMembers.value = resp.payload.state
    return resp.payload
  } catch (err) {
    membersError.value = err instanceof Error ? err.message : String(err)
    return null
  } finally {
    membersBusy.value = false
  }
}

async function inviteMember(): Promise<void> {
  membersNotice.value = ''
  const written = await membersWrite('p2p.members.invite', {
    displayName: inviteName.value,
    email: inviteEmail.value,
    role: inviteRole.value,
  })
  if (!written) return
  inviteName.value = ''
  inviteEmail.value = ''
  inviteRole.value = 'member'
  memberInviteCopied.value = false
  memberInvite.value = written.result as unknown as InviteResult
}

async function copyInviteToken(): Promise<void> {
  const token = memberInvite.value?.token
  if (!token) return
  try {
    await navigator.clipboard.writeText(token)
    memberInviteCopied.value = true
  } catch { /* clipboard unavailable — the token is selectable on screen */ }
}

async function changeMemberRole(member: TeamMember, select: HTMLSelectElement): Promise<void> {
  const role = select.value as MemberRole
  membersNotice.value = ''
  const written = await membersWrite('p2p.members.set_role', {
    memberId: member.memberId,
    role,
  })
  // A refused change leaves the roster as it was, and the select would keep the
  // role it was never granted.
  if (!written) select.value = member.role
}

async function revokeMember(member: TeamMember): Promise<void> {
  memberRevoking.value = ''
  membersNotice.value = ''
  const written = await membersWrite('p2p.members.revoke', { memberId: member.memberId })
  if (!written) return
  const dropped = Number(written.result.droppedConnections ?? 0)
  membersNotice.value = t('settings.p2p.members.revoked', {
    name: memberLabel(member),
    count: Number.isFinite(dropped) ? dropped : 0,
  })
}

function memberLabel(member: TeamMember): string {
  return member.displayName || member.email || member.memberId
}

/** Whether this row's role select may be touched.
 *
 *  The server refuses an admin demoting themselves, so the row is locked here
 *  too rather than sending a request that is guaranteed to come back an error.
 *  It is only the last admin's own row: another admin can still change it. */
function memberRoleLocked(member: TeamMember): boolean {
  return member.memberId === myMemberId.value
}

watch(activeTab, (tab) => {
  if (p2pTimer) { clearInterval(p2pTimer); p2pTimer = null }
  if (tab !== 'general') return
  void loadP2pStatus()
  void loadP2pPolicy()
  void loadP2pMembers()
  p2pTimer = setInterval(() => {
    void loadP2pStatus()
    void loadP2pPolicy()
    void loadP2pMembers()
  }, P2P_POLL_MS)
}, { immediate: true })

// Close on ESC — except while a one-time invite token is on screen. That token
// cannot be fetched again, so ESC must not take it away by closing the pane
// underneath it; the panel has its own dismiss button.
function onKeyDown(e: KeyboardEvent) {
  if (e.key !== 'Escape') return
  if (memberInvite.value) return
  emit('close')
}
onMounted(() => {
  window.addEventListener('keydown', onKeyDown)
  void loadSettingsPaths()
  void loadDetectedEditors()
})
onUnmounted(() => {
  window.removeEventListener('keydown', onKeyDown)
  if (previewTimer) { clearTimeout(previewTimer); previewTimer = null }
  if (p2pTimer) { clearInterval(p2pTimer); p2pTimer = null }
})

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
const mDirty = ref(false)
let mEditVersion = 0

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

interface McpListResponse {
  servers: McpServer[]
  path?: string
  revision: string
  /** Reflection of every CLI's own config; read-only, added alongside. */
  native?: NativeMcpServer[]
  agents?: McpAgent[]
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

/** Read-only reflection of what each CLI configures for itself, and what
 *  Navide can do with each vendor's MCP. Loaded by the same call that loads
 *  Navide's own servers, so the pane below never issues a second request. */
const mNative = ref<NativeMcpServer[]>([])
const mAgents = ref<McpAgent[]>([])
/** A just-added server the pane should open its editor on. */
const mSelectName = ref('')

async function mLoad(force = false) {
  if (!force && (mDirty.value || mAutosaveQueue.pending > 0)) return
  if (force) mDirty.value = false
  mLoading.value = true; mError.value = ''; mConflict.value = false
  try {
    const resp = await props.backend.send<McpListResponse>('mcp.list_servers', {})
    if (resp.ok && resp.payload) {
      mServers.value = resp.payload.servers.map(mNormalizeServer)
      mConfigPath.value = resp.payload.path ?? ''
      mRevision.value = resp.payload.revision
      mNative.value = Array.isArray(resp.payload.native) ? resp.payload.native : []
      mAgents.value = Array.isArray(resp.payload.agents) ? resp.payload.agents : []
    } else { mError.value = resp.error?.message ?? 'Load failed' }
  } catch (err) { mError.value = String((err as Error).message ?? err) }
  finally { mLoading.value = false }
}

async function mRefreshLive(): Promise<void> {
  try {
    const resp = await props.backend.send<McpListResponse>('mcp.list_servers', {})
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
  // An entry that needs credentials opens straight into the pane's editor.
  if (entry.requiresEnv?.length) mSelectName.value = entry.name
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
    mSelectName.value = name
    mView.value = 'list'
  } else {
    mServers.value = mServers.value.filter((item) => item !== server)
  }
}

/** Apply an edited copy from the pane, then hand it to the same save queue
 *  the catalog and custom views use — one writer, one revision. */
async function mReplaceServer(next: McpServer) {
  const idx = mServers.value.findIndex((server) => server.name === next.name)
  if (idx === -1) return
  mServers.value[idx] = mNormalizeServer(next)
  await mSave(true)
}

async function mRemoveByName(name: string) {
  const idx = mServers.value.findIndex((server) => server.name === name)
  if (idx >= 0) await mRemoveServer(idx)
}

async function mRemoveServer(idx: number) {
  if (mServers.value[idx]?.name === mSelectName.value) mSelectName.value = ''
  mServers.value.splice(idx, 1)
  await mSave(true)
}


async function mOpenConfig() {
  if (mConfigPath.value) await (window as any).agentTeam.openPath(mConfigPath.value)
}

// ══════════════════════════════════════════════════════════════════════════════
// EXTERNAL ACCESS (MCP tab): external MCP client access + CDP debug toggle.
// ══════════════════════════════════════════════════════════════════════════════

interface ExternalAccessState { enabled: boolean; token: string; port: number }
const eaEnabled = ref(false)
const eaToken = ref('')
const eaPort = ref(0)
const eaLoading = ref(false)
const eaError = ref('')
const eaCopied = ref(false)

const eaUrl = computed(() => (
  eaEnabled.value && eaPort.value
    ? `http://127.0.0.1:${eaPort.value}/plan-mcp?client=external&t=${eaToken.value}`
    : ''
))

async function eaLoad(): Promise<void> {
  eaLoading.value = true; eaError.value = ''
  try {
    const resp = await props.backend.send<ExternalAccessState>('external_access.get', {})
    if (resp.ok && resp.payload) {
      eaEnabled.value = resp.payload.enabled
      eaToken.value = resp.payload.token
      eaPort.value = resp.payload.port
    } else {
      eaError.value = resp.error?.message ?? 'Load failed'
    }
  } catch (err) { eaError.value = String((err as Error).message ?? err) }
  finally { eaLoading.value = false }
}

async function eaSetEnabled(enabled: boolean): Promise<void> {
  const prev = eaEnabled.value
  eaEnabled.value = enabled
  eaError.value = ''
  try {
    const resp = await props.backend.send<ExternalAccessState>('external_access.set', { enabled })
    if (resp.ok && resp.payload) {
      eaEnabled.value = resp.payload.enabled
      eaToken.value = resp.payload.token
      eaPort.value = resp.payload.port
    } else {
      eaEnabled.value = prev
      eaError.value = resp.error?.message ?? 'Save failed'
    }
  } catch (err) {
    eaEnabled.value = prev
    eaError.value = String((err as Error).message ?? err)
  }
}

async function eaRegenerateToken(): Promise<void> {
  eaError.value = ''
  try {
    const resp = await props.backend.send<ExternalAccessState>('external_access.regenerate', {})
    if (resp.ok && resp.payload) {
      eaToken.value = resp.payload.token
    } else {
      eaError.value = resp.error?.message ?? 'Regenerate failed'
    }
  } catch (err) { eaError.value = String((err as Error).message ?? err) }
}

async function eaCopyUrl(): Promise<void> {
  if (!eaUrl.value) return
  try {
    await navigator.clipboard.writeText(eaUrl.value)
    eaCopied.value = true
    setTimeout(() => { eaCopied.value = false }, 1500)
  } catch { /* clipboard unavailable — no-op */ }
}

// CDP (Chrome DevTools Protocol) debug toggle. Takes effect on next app
// restart — the switch is applied at pre-ready startup in main (cdp-debug.ts).
const cdpEnabled = ref(false)
const cdpPort = ref(9223)
const cdpSaving = ref(false)

async function cdpLoad(): Promise<void> {
  const resp = await window.agentTeam?.readCdpDebugConfig?.()
  if (resp?.ok && resp.config) {
    cdpEnabled.value = resp.config.enabled
    cdpPort.value = resp.config.port
  }
}

async function cdpSetEnabled(enabled: boolean): Promise<void> {
  cdpEnabled.value = enabled
  cdpSaving.value = true
  try {
    await window.agentTeam?.writeCdpDebugConfig?.({ enabled, port: cdpPort.value })
  } finally { cdpSaving.value = false }
}

watch(activeTab, (tab) => {
  if (tab === 'mcp' && mServers.value.length === 0) mLoad()
  if (tab === 'mcp') { void eaLoad(); void cdpLoad() }
  if (tab === 'appearance') void loadAutoRestore()
  if (tab === 'accounts') void accountsApi.refresh()
})

</script>

<template>
  <Teleport to="body">
    <!-- Overlay -->
    <div class="s-overlay nv-modal-overlay" @click.self="emit('close')">
      <div class="s-modal nv-modal-shell nv-modal-shell--wide">

        <!-- ── Sidebar (title + search + grouped nav) ────────────────────── -->
        <aside class="s-sidebar">
          <div class="s-ws-header">
            <div class="s-ws-avatar" aria-hidden="true">
              <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="8" r="2.2"/><path d="M8 1.5v1.8M8 12.7v1.8M14.5 8h-1.8M3.3 8H1.5M12.6 3.4l-1.3 1.3M4.7 11.3l-1.3 1.3M12.6 12.6l-1.3-1.3M4.7 4.7 3.4 3.4"/></svg>
            </div>
            <div class="s-ws-meta">
              <span class="s-ws-name">{{ $t('settings.nav.title') }}</span>
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
              <SettingsNavItem :label="$t('settings.nav.layout')" :active="activeTab === 'layout'" @select="activeTab = 'layout'">
                <template #icon>
                  <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="1.5" y="2.5" width="13" height="11" rx="1.5"/><path d="M5.5 2.5v11M14.5 6h-9"/></svg>
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
              <SettingsNavItem :label="$t('settings.nav.analyzer')" :active="activeTab === 'analyzer'" @select="activeTab = 'analyzer'">
                <template #icon>
                  <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3.2C6.6 2.2 4.2 2.8 4.2 4.8 2.7 5.1 2.7 7.3 4.2 7.8c0 2 1.9 2.6 3.8 2.1"/><path d="M8 3.2c1.4-1 3.8-.4 3.8 1.6 1.5.3 1.5 2.5 0 3 0 2-1.9 2.6-3.8 2.1"/><path d="M8 3.2v9.6"/></svg>
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
              <SettingsNavItem :label="$t('settings.nav.prompts')" :active="activeTab === 'prompts'" @select="activeTab = 'prompts'">
                <template #icon>
                  <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="1.6" y="2.6" width="12.8" height="10.8" rx="1.6"/><path d="M4.6 6.2 6.8 8.2l-2.2 2"/><path d="M8.6 10.4h3"/></svg>
                </template>
              </SettingsNavItem>
              <SettingsNavItem :label="$t('settings.nav.memory')" :active="activeTab === 'memory'" @select="activeTab = 'memory'">
                <template #icon>
                  <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3.2 2.6h6.1l3.5 3.5v7.3H3.2Z"/><path d="M9.1 2.7v3.5h3.5"/><path d="M5.4 8.4h5.2M5.4 10.7h3.4"/></svg>
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
              <SettingsNavItem :label="$t('settings.nav.storage')" :active="activeTab === 'storage'" @select="activeTab = 'storage'">
                <template #icon>
                  <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><ellipse cx="8" cy="3.8" rx="5.2" ry="2"/><path d="M2.8 3.8v4.4c0 1.1 2.3 2 5.2 2s5.2-.9 5.2-2V3.8"/><path d="M2.8 8.2v4c0 1.1 2.3 2 5.2 2s5.2-.9 5.2-2v-4"/></svg>
                </template>
              </SettingsNavItem>
              <SettingsNavItem :label="$t('settings.nav.keybindings')" :active="activeTab === 'keybindings'" @select="activeTab = 'keybindings'">
                <template #icon>
                  <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="1.3" y="3.8" width="13.4" height="8.4" rx="1.4"/><path d="M4 6.4h0.01M6.4 6.4h0.01M8.8 6.4h0.01M11.2 6.4h0.01M4 8.8h0.01M11.2 8.8h0.01M6 10.6h4"/></svg>
                </template>
              </SettingsNavItem>
              <SettingsNavItem :label="$t('settings.nav.updates')" :active="activeTab === 'updates'" @select="activeTab = 'updates'">
                <template #icon>
                  <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M8 10.3V2.8M8 2.8 5.3 5.5M8 2.8l2.7 2.7"/><path d="M3.3 10.5v1.6a1.2 1.2 0 0 0 1.2 1.2h7a1.2 1.2 0 0 0 1.2-1.2v-1.6"/></svg>
                </template>
              </SettingsNavItem>
              <SettingsNavItem :label="$t('settings.nav.help')" :active="activeTab === 'help'" @select="activeTab = 'help'">
                <template #icon>
                  <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="8" r="6.2"/><path d="M6.2 6.2a1.85 1.85 0 1 1 2.6 1.7c-.5.25-.8.7-.8 1.25v.3"/><path d="M8 11.9v0.01"/></svg>
                </template>
              </SettingsNavItem>
            </div>
          </nav>
        </aside>

        <!-- ── Content (close button + all tab bodies) ───────────────────── -->
        <div class="s-content">
          <button class="s-close" @click="emit('close')" title="Close (ESC)">✕</button>

        <!-- ── MCP TAB ───────────────────────────────────────────────────── -->
        <div v-show="activeTab === 'mcp'" class="s-body s-body--bleed mcp-body">
          <h1 class="s-page-title">{{ $t('settings.nav.mcp') }}</h1>

          <!-- ── LIST VIEW ──────────────────────────────────────────────── -->
          <template v-if="mView === 'list'">
            <div class="mcp-topbar" data-settings-section="mcp-installed">
              <span class="mcp-page-title">{{ $t('settings.mcp.all-title') }}</span>
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
            <p v-if="mError" class="err-msg" style="margin:6px 22px 0">{{ mError }}</p>
            <div v-if="mConflict" class="mcp-conflict">
              <span>{{ $t('settings.mcp.conflict') }}</span>
              <button class="mcp-action-btn" @click="mLoad(true)">{{ $t('settings.mcp.reload') }}</button>
            </div>
            <span v-if="mSummary" class="mcp-summary-ok">{{ mSummary }}</span>

            <McpPane
              class="mcp-agent-pane"
              data-settings-section="mcp-agents"
              :servers="mServers"
              :native="mNative"
              :agents="mAgents"
              :loading="mLoading"
              :select-name="mSelectName"
              @save="mReplaceServer"
              @remove="mRemoveByName"
              @refresh="mLoad(true)"
              @select-consumed="mSelectName = ''"
            />

            <!-- ── EXTERNAL ACCESS ──────────────────────────────────────── -->
            <div class="ea-section-wrap">
            <SettingsSection :label="$t('settings.mcp.external-access-title')" data-settings-section="mcp-external-access">
              <SettingsCard>
                <SettingRow
                  :title="$t('settings.mcp.allow-external')"
                  :description="$t('settings.mcp.external-access-hint')"
                >
                  <template #control>
                    <ToggleSwitch
                      :model-value="eaEnabled"
                      :disabled="eaLoading"
                      :aria-label="$t('settings.mcp.allow-external')"
                      @update:model-value="eaSetEnabled"
                    />
                  </template>
                </SettingRow>
                <p class="ea-warning">{{ $t('settings.mcp.allow-external-warning') }}</p>
                <p v-if="eaError" class="err-msg">{{ eaError }}</p>
                <div v-if="eaEnabled" class="ea-connection">
                  <div class="field">
                    <label class="lbl">{{ $t('settings.mcp.connection-url') }}</label>
                    <div class="row-g gap">
                      <input :value="eaUrl" type="text" readonly spellcheck="false" />
                      <button class="mcp-action-btn" @click="eaCopyUrl">
                        {{ eaCopied ? $t('settings.mcp.token-copied') : $t('action.copy') }}
                      </button>
                      <button class="mcp-action-btn" @click="eaRegenerateToken">{{ $t('settings.mcp.regenerate-token') }}</button>
                    </div>
                  </div>
                </div>

                <SettingRow
                  :title="$t('settings.mcp.cdp-title')"
                  :description="$t('settings.mcp.cdp-hint')"
                >
                  <template #control>
                    <ToggleSwitch
                      :model-value="cdpEnabled"
                      :disabled="cdpSaving"
                      :aria-label="$t('settings.mcp.cdp-title')"
                      @update:model-value="cdpSetEnabled"
                    />
                  </template>
                </SettingRow>
                <p class="ea-warning">{{ $t('settings.mcp.cdp-warning') }}</p>
              </SettingsCard>
            </SettingsSection>
            </div>
          </template>

          <!-- ── CATALOG VIEW ────────────────────────────────────────────── -->
          <template v-else-if="mView === 'catalog'">
            <div class="mcp-topbar" data-settings-section="mcp-catalog">
              <button class="mcp-back-btn nv-btn" @click="mView = 'list'">← Back</button>
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
                <button v-else class="mcp-add-btn nv-btn nv-btn--primary" @click="mAddFromCatalog(item)" :disabled="mSaving">+ Add</button>
              </div>
              <div v-if="mFilteredCatalog.length === 0" class="mcp-empty">No matching MCP servers found</div>
            </div>
          </template>

          <template v-else>
            <div class="mcp-topbar" data-settings-section="mcp-custom">
              <button class="mcp-back-btn nv-btn" @click="mView = 'list'">← {{ $t('action.back') }}</button>
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
                  class="mcp-add-btn nv-btn nv-btn--primary"
                  :disabled="mSaving || !mCustomName.trim() || (mCustomTransport === 'stdio' ? !mCustomCommand.trim() : !mCustomUrl.trim())"
                >{{ $t('settings.mcp.create-server') }}</button>
              </div>
            </form>
          </template>

        </div>

        <!-- ── SKILLS TAB ───────────────────────────────────────────────── -->
        <div v-show="activeTab === 'skills'" class="s-body s-body--bleed" data-settings-section="skills">
          <h1 class="s-page-title">{{ $t('settings.nav.skills') }}</h1>
          <div class="settings-meta-row">
            <span class="scope-badge">{{ settingsScopeNotes.skills.scope }}</span>
            <span class="settings-path" :title="pathForTab('skills')">{{ pathForTab('skills') }}</span>
            <button class="settings-path-btn" :disabled="!settingsPaths.skills" @click="openSettingsPath(settingsPaths.skills)">{{ $t('action.open') }}</button>
          </div>
          <SkillsPane :backend="props.backend" />
        </div>

        <!-- ── PROMPTS TAB ──────────────────────────────────────────────── -->
        <div v-show="activeTab === 'prompts'" class="s-body s-body--bleed" data-settings-section="prompts">
          <h1 class="s-page-title">{{ $t('settings.nav.prompts') }}</h1>
          <div class="settings-meta-row">
            <span class="scope-badge">{{ settingsScopeNotes.prompts.scope }}</span>
          </div>
          <PromptSkillsPane />
        </div>

        <!-- ── MEMORY TAB ───────────────────────────────────────────────── -->
        <div v-show="activeTab === 'memory'" class="s-body s-body--bleed" data-settings-section="memory">
          <h1 class="s-page-title">{{ $t('settings.nav.memory') }}</h1>
          <div class="settings-meta-row">
            <span class="scope-badge">{{ settingsScopeNotes.memory.scope }}</span>
          </div>
          <!-- Project files belong to the folder that is actually open; the
               first known workspace is the current one whenever there is one. -->
          <MemoryPane
            :backend="props.backend"
            :workspace-path="props.workspacePath ?? ''"
          />
        </div>

        <!-- ── ANALYZER TAB ─────────────────────────────────────────────── -->
        <div v-show="activeTab === 'analyzer'" class="s-body s-body--bleed analyzer-body">
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
                    class="az-recheck-btn nv-btn"
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
                    class="az-recheck-btn nv-btn"
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
                class="az-run-btn nv-btn nv-btn--primary"
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
                <button class="az-del-btn nv-btn nv-btn--danger" @click="azDoDelete(m.name)" :title="$t('settings.analyzer.delete-local-title')">✕</button>
              </div>
            </div>
          </div>

          <!-- ③ Model benchmark -->
          <div class="az-section az-benchmark-section" data-settings-section="analyzer-models">
            <div class="az-section-header">
              <div class="az-section-title">{{ $t('settings.analyzer.model-benchmark') }}</div>
              <button
                class="az-run-btn nv-btn nv-btn--primary"
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
          <section class="ap-section" data-settings-section="cli-agents-permissions">
            <h3 class="ap-title">{{ $t('settings.cliPermission.title') }}</h3>
            <p class="ap-hint">{{ $t('settings.cliPermission.hint') }}</p>
            <label class="cli-agent-toggle perm-global">
              <input type="checkbox" v-model="yoloModel" />
              <span class="cli-agent-label">{{ $t('settings.cliPermission.global-label') }}</span>
            </label>
            <ul class="cli-agent-list">
              <li
                v-for="spec in permissionRows"
                :key="spec.agentKey"
                class="cli-agent-row perm-row"
                :class="{ 'perm-overridden': cliPermissionMode(spec.agentKey) !== 'inherit' }"
              >
                <span class="cli-agent-label perm-name">{{ spec.label }}</span>
                <code class="perm-flag">{{ spec.skipPermissionFlag }}</code>
                <select
                  class="perm-select"
                  :value="cliPermissionMode(spec.agentKey)"
                  :aria-label="spec.label"
                  @change="onPermissionSelect(spec.agentKey, $event)"
                >
                  <option value="inherit">{{ $t('settings.cliPermission.mode-inherit') }}</option>
                  <option value="force-on">{{ $t('settings.cliPermission.mode-force-on') }}</option>
                  <option value="force-off">{{ $t('settings.cliPermission.mode-force-off') }}</option>
                </select>
              </li>
            </ul>
            <p class="ap-hint">{{ $t('settings.cliPermission.flagless-note', { list: flaglessVendors }) }}</p>
            <p class="ap-hint">{{ $t('settings.cliPermission.restart-note') }}</p>
          </section>
          <section class="ap-section" data-settings-section="cli-agents-push">
            <h3 class="ap-title">{{ $t('settings.pushChannels.title') }}</h3>
            <p class="ap-hint">{{ $t('settings.pushChannels.hint') }}</p>
            <ul class="cli-agent-list">
              <li v-for="spec in pushChannelRows" :key="spec.agentKey" class="cli-agent-row">
                <label class="cli-agent-toggle">
                  <input
                    type="checkbox"
                    :checked="pushChannelEnabled(spec.agentKey)"
                    @change="togglePushChannel(spec.agentKey)"
                  />
                  <span class="cli-agent-label">{{ spec.label }}</span>
                </label>
                <span class="cli-agent-hint">{{ $t(`settings.pushChannels.cost-${spec.agentKey}`) }}</span>
              </li>
            </ul>
            <p class="ap-hint">{{ $t('settings.pushChannels.restart-note') }}</p>
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
                data-settings-section="general-confirm-close-pane"
                :title="$t('settings.general.confirm-close-pane')"
                :description="$t('settings.general.confirm-close-pane-hint')"
              >
                <template #control>
                  <ToggleSwitch
                    v-model="confirmBeforeClosePaneModel"
                    :aria-label="$t('settings.general.confirm-close-pane')"
                  />
                </template>
              </SettingRow>

              <SettingRow
                data-settings-section="general-idle-reclaim"
                :title="$t('settings.general.idle-reclaim')"
                :description="$t('settings.general.idle-reclaim-hint')"
              >
                <template #control>
                  <ToggleSwitch
                    v-model="idleReclaimEnabledModel"
                    :aria-label="$t('settings.general.idle-reclaim')"
                  />
                </template>
              </SettingRow>

              <SettingRow
                v-if="idleReclaimEnabledModel"
                data-settings-section="general-idle-reclaim-after"
                :title="$t('settings.general.idle-reclaim-after')"
                :description="$t('settings.general.idle-reclaim-after-hint')"
              >
                <template #control>
                  <select
                    :value="idleReclaimMinutesModel"
                    @change="onIdleReclaimMinutesChange(($event.target as HTMLSelectElement).value)"
                  >
                    <option value="15">{{ $t('settings.general.idle-reclaim-15m') }}</option>
                    <option value="30">{{ $t('settings.general.idle-reclaim-30m') }}</option>
                    <option value="60">{{ $t('settings.general.idle-reclaim-1h') }}</option>
                    <option value="180">{{ $t('settings.general.idle-reclaim-3h') }}</option>
                    <option value="480">{{ $t('settings.general.idle-reclaim-8h') }}</option>
                  </select>
                </template>
              </SettingRow>

              <SettingRow
                v-if="idleReclaimEnabledModel"
                data-settings-section="general-idle-reclaim-now"
                :title="$t('settings.general.idle-reclaim-now')"
                :description="reclaimNowCount > 0
                  ? $t('settings.general.idle-reclaim-now-hint', { count: reclaimNowCount, size: reclaimNowSize })
                  : $t('settings.general.idle-reclaim-now-empty')"
              >
                <template #control>
                  <button
                    class="reclaim-now-btn"
                    :disabled="reclaimNowCount === 0"
                    @click="emit('reclaim-now')"
                  >
                    {{ reclaimNowCount > 0
                      ? $t('settings.general.idle-reclaim-now-action', { count: reclaimNowCount })
                      : $t('settings.general.idle-reclaim-now-action-empty') }}
                  </button>
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
                    <option value="all">{{ $t('settings.appearance.restore-scope-all') }}</option>
                  </select>
                </template>
              </SettingRow>

              <SettingRow
                data-settings-section="general-auto-resume-reconnect"
                :title="$t('settings.general.auto-resume-reconnect')"
                :description="$t('settings.general.auto-resume-reconnect-hint')"
              >
                <template #control>
                  <ToggleSwitch
                    v-model="autoResumeOnReconnectModel"
                    :aria-label="$t('settings.general.auto-resume-reconnect')"
                    @update:modelValue="onAutoResumeOnReconnectChange"
                  />
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
                data-settings-section="general-default-editor"
                :title="$t('settings.general.default-editor')"
                :description="$t('settings.general.default-editor-hint')"
              >
                <template #control>
                  <div class="row-g gap">
                    <span v-if="selectedEditorCommand" class="s-ctrl-label">{{ selectedEditorCommand }}</span>
                    <select :value="defaultEditorModel" @change="onDefaultEditorChange(($event.target as HTMLSelectElement).value)">
                      <option value="mini-ide">{{ $t('label.editor-mini-ide') }}</option>
                      <option value="system">{{ $t('label.editor-system') }}</option>
                      <option
                        v-for="id in DETECTABLE_EDITOR_IDS"
                        :key="id"
                        :value="id"
                        :disabled="!isEditorAvailable(id)"
                      >
                        {{ $t('label.editor-' + id) + (isEditorAvailable(id) ? '' : '（' + $t('settings.general.default-editor-not-installed') + '）') }}
                      </option>
                      <option value="custom">{{ $t('label.editor-custom') }}</option>
                    </select>
                    <button class="ap-reset" :disabled="detectingEditors" @click="loadDetectedEditors(true)">
                      {{ $t('settings.general.default-editor-redetect') }}
                    </button>
                  </div>
                </template>
              </SettingRow>

              <div v-if="defaultEditorModel === 'custom'" class="s-fullrow">
                <div class="row-g gap">
                  <span class="s-ctrl-label">{{ $t('settings.general.default-editor-custom-command') }}</span>
                  <input
                    type="text"
                    spellcheck="false"
                    :value="customEditorCommandText"
                    @change="onCustomEditorCommandChange(($event.target as HTMLInputElement).value)"
                  />
                  <select @change="onCustomEditorPresetChange($event.target as HTMLSelectElement)">
                    <option value="">{{ $t('settings.general.default-editor-preset') }}</option>
                    <option v-for="preset in CUSTOM_COMMAND_PRESETS" :key="preset.id" :value="preset.id">
                      {{ formatCustomCommand(preset.command) }}
                    </option>
                  </select>
                </div>
                <p class="ap-hint">{{ $t('settings.general.default-editor-custom-command-hint') }}</p>
                <!-- An empty template resolves back to the Mini-IDE at open
                     time, which would otherwise look like the setting was
                     ignored. -->
                <p v-if="customEditorCommand.length === 0" class="ap-hint ap-hint-warn">
                  {{ $t('settings.general.default-editor-custom-command-empty') }}
                </p>
              </div>

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
                v-if="isDev"
                data-settings-section="general-antigravity-secrets"
                :title="$t('usage.settings-signing-title')"
                :description="$t('usage.settings-signing-hint')"
              >
                <template #control>
                  <div class="row-g gap">
                    <input
                      v-model="signingClientId"
                      type="text"
                      :placeholder="$t('usage.settings-signing-id')"
                      spellcheck="false"
                    />
                    <input
                      v-model="signingClientSecret"
                      type="password"
                      :placeholder="$t('usage.settings-signing-secret')"
                      spellcheck="false"
                    />
                    <button class="ap-reset" @click="saveSigningSecrets">
                      {{ $t('usage.settings-signing-save') }}
                    </button>
                    <span v-if="signingSaveStatus === 'saved'" class="s-ctrl-label">
                      {{ $t('usage.settings-signing-saved') }}
                    </span>
                    <span v-else-if="signingSaveStatus === 'error'" class="s-ctrl-label">
                      {{ $t('usage.settings-signing-error') }}
                    </span>
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

          <SettingsSection :label="$t('settings.p2p.title')">
            <SettingsCard>
              <div class="s-fullrow" data-settings-section="general-p2p">
                <p class="ap-hint">{{ $t('settings.p2p.hint') }}</p>
                <div class="field">
                  <label class="lbl" for="p2p-server-url">{{ $t('settings.p2p.server-url') }}</label>
                  <input
                    id="p2p-server-url"
                    v-model="p2pServerUrl"
                    type="text"
                    spellcheck="false"
                    autocomplete="off"
                    :disabled="p2pBusy || p2pSignedIn"
                    :placeholder="$t('settings.p2p.server-url-placeholder')"
                  />
                </div>

                <!-- Signed in as an account: the credential is the server's to
                     revoke, so this side only shows who it belongs to. -->
                <div v-if="p2pSignedIn" class="p2p-account">
                  <div class="p2p-account-row">
                    <span class="lbl">{{ $t('settings.p2p.account.email') }}</span>
                    <span>{{ p2pStatus?.accountEmail }}</span>
                  </div>
                  <div v-if="p2pStatus?.displayName" class="p2p-account-row">
                    <span class="lbl">{{ $t('settings.p2p.account.display-name') }}</span>
                    <span>{{ p2pStatus.displayName }}</span>
                  </div>
                  <div v-if="p2pStatus?.role" class="p2p-account-row">
                    <span class="lbl">{{ $t('settings.p2p.account.role') }}</span>
                    <span>{{ p2pStatus.role }}</span>
                  </div>
                  <div class="row-g gap p2p-actions">
                    <button class="ap-reset" :disabled="p2pBusy" @click="p2pLogout">
                      {{ $t('settings.p2p.account.sign-out') }}
                    </button>
                  </div>
                </div>

                <template v-else>
                  <div class="p2p-tabs" role="tablist">
                    <button
                      v-for="mode in (['login', 'register', 'token'] as const)"
                      :key="mode"
                      type="button"
                      role="tab"
                      class="p2p-tab"
                      :class="{ on: p2pMode === mode }"
                      :aria-selected="p2pMode === mode"
                      :disabled="p2pBusy"
                      @click="p2pMode = mode"
                    >
                      {{ $t('settings.p2p.account.tab-' + mode) }}
                    </button>
                  </div>

                  <!-- Sign in / register. Both take the same two fields; only
                       registering asks for the names it will label the new
                       tenant with. -->
                  <template v-if="p2pMode !== 'token'">
                    <div class="field">
                      <label class="lbl" for="p2p-email">{{ $t('settings.p2p.account.email') }}</label>
                      <input
                        id="p2p-email"
                        v-model="p2pEmail"
                        type="email"
                        spellcheck="false"
                        autocomplete="username"
                        :disabled="p2pBusy"
                        placeholder="you@example.com"
                      />
                    </div>
                    <div class="field">
                      <label class="lbl" for="p2p-password">{{ $t('settings.p2p.account.password') }}</label>
                      <input
                        id="p2p-password"
                        v-model="p2pPassword"
                        type="password"
                        spellcheck="false"
                        :autocomplete="p2pMode === 'register' ? 'new-password' : 'current-password'"
                        :disabled="p2pBusy"
                        :placeholder="$t('settings.p2p.account.password-placeholder')"
                        @keyup.enter="submitP2pAccount(p2pMode === 'register' ? 'register' : 'login')"
                      />
                    </div>
                    <template v-if="p2pMode === 'register'">
                      <div class="field">
                        <label class="lbl" for="p2p-display-name">
                          {{ $t('settings.p2p.account.display-name') }}
                        </label>
                        <input
                          id="p2p-display-name"
                          v-model="p2pDisplayName"
                          type="text"
                          autocomplete="off"
                          :disabled="p2pBusy"
                          :placeholder="$t('settings.p2p.account.optional')"
                        />
                      </div>
                      <div class="field">
                        <label class="lbl" for="p2p-tenant-name">
                          {{ $t('settings.p2p.account.tenant-name') }}
                        </label>
                        <input
                          id="p2p-tenant-name"
                          v-model="p2pTenantName"
                          type="text"
                          autocomplete="off"
                          :disabled="p2pBusy"
                          :placeholder="$t('settings.p2p.account.optional')"
                        />
                        <p class="ap-hint">{{ $t('settings.p2p.account.tenant-hint') }}</p>
                      </div>
                    </template>
                    <div class="row-g gap p2p-actions">
                      <button
                        class="ap-reset"
                        :disabled="p2pBusy"
                        @click="submitP2pAccount(p2pMode === 'register' ? 'register' : 'login')"
                      >
                        {{ $t('settings.p2p.account.' + (p2pMode === 'register' ? 'submit-register' : 'submit-login')) }}
                      </button>
                    </div>
                  </template>

                  <!-- Pasting a token directly: unchanged, and deliberately kept
                       for machines that have no account to sign in with. -->
                  <template v-else>
                    <div class="field p2p-field">
                      <label class="lbl" for="p2p-token">{{ $t('settings.p2p.token') }}</label>
                      <input
                        id="p2p-token"
                        v-model="p2pTokenInput"
                        type="password"
                        spellcheck="false"
                        autocomplete="off"
                        :disabled="p2pBusy"
                        :placeholder="p2pStatus?.hasToken ? $t('settings.p2p.token-stored') : $t('settings.p2p.token-placeholder')"
                      />
                      <p class="ap-hint">{{ $t('settings.p2p.token-hint') }}</p>
                    </div>
                    <div class="row-g gap p2p-actions">
                      <button class="ap-reset" :disabled="p2pBusy" @click="saveP2pLink">{{ $t('settings.p2p.save') }}</button>
                      <button class="ap-reset" :disabled="p2pBusy" @click="clearP2pLink">{{ $t('settings.p2p.clear') }}</button>
                    </div>
                  </template>
                </template>

                <p class="p2p-status">
                  <span class="p2p-dot" :class="p2pDotClass"></span>
                  <span>{{ $t('settings.p2p.state-' + p2pState) }}</span>
                </p>
                <p v-if="p2pStatus?.detail" class="p2p-detail">{{ p2pStatus.detail }}</p>
                <p v-if="p2pStatus?.deviceId" class="p2p-detail">{{ $t('settings.p2p.device-id') }}: {{ p2pStatus.deviceId }}</p>
                <p v-if="p2pError" class="err-msg">{{ p2pError }}</p>
              </div>
            </SettingsCard>

            <!-- Only meaningful once a server is configured: with no server no
                 message can arrive from another device, and messages between
                 panes on this machine never consult this policy. -->
            <SettingsCard v-if="p2pState !== 'unconfigured'">
              <div class="s-fullrow" data-settings-section="general-p2p-policy">
                <h3 class="policy-title">{{ $t('settings.p2p.policy.title') }}</h3>
                <p class="ap-hint">{{ $t('settings.p2p.policy.hint') }}</p>
                <p class="policy-deny">{{ $t('settings.p2p.policy.default-deny') }}</p>
                <p v-if="!p2pPolicy?.editable" class="policy-readonly">{{ $t('settings.p2p.policy.readonly') }}</p>

                <label class="policy-switch">
                  <input
                    type="checkbox"
                    :checked="policyAllowsOwnDevices"
                    :disabled="!policyEditable || !policyMemberId"
                    @change="toggleOwnDevices($event.target as HTMLInputElement)"
                  />
                  <span>
                    <span class="policy-switch-label">{{ $t('settings.p2p.policy.own-devices') }}</span>
                    <span class="ap-hint">{{ $t('settings.p2p.policy.own-devices-hint') }}</span>
                  </span>
                </label>

                <p class="policy-section-label">{{ $t('settings.p2p.policy.rules') }}</p>
                <p v-if="!policyDoc.rules.length" class="policy-empty">{{ $t('settings.p2p.policy.empty') }}</p>
                <ul v-else class="policy-rules">
                  <li v-for="(rule, index) in policyDoc.rules" :key="index" class="policy-rule">
                    <span class="policy-rule-text">
                      {{ policyMemberLabel(rule.from.memberId) }} · {{ policyDeviceLabel(rule.from.deviceId) }}
                      →
                      {{ policyFieldLabel(rule.to.workspace) }} / {{ policyFieldLabel(rule.to.paneName) }}
                    </span>
                    <button class="ap-reset" :disabled="!policyEditable" @click="removeP2pPolicyRule(index)">
                      {{ $t('settings.p2p.policy.remove') }}
                    </button>
                  </li>
                </ul>

                <p class="policy-section-label">{{ $t('settings.p2p.policy.add-title') }}</p>
                <div class="policy-add">
                  <div class="field">
                    <label class="lbl" for="policy-member">{{ $t('settings.p2p.policy.source-member') }}</label>
                    <select id="policy-member" v-model="newRuleMemberScope" :disabled="!policyEditable || !policyMemberId">
                      <option value="mine">{{ $t('settings.p2p.policy.my-account') }}</option>
                      <option value="any">{{ $t('settings.p2p.policy.any-member') }}</option>
                    </select>
                  </div>
                  <div class="field">
                    <label class="lbl" for="policy-device">{{ $t('settings.p2p.policy.source-device') }}</label>
                    <select id="policy-device" v-model="newRuleDeviceId" :disabled="!policyEditable">
                      <option value="">{{ $t('settings.p2p.policy.any-device') }}</option>
                      <option v-for="device in policyDevices" :key="device.deviceId" :value="device.deviceId">
                        {{ device.deviceName || device.deviceId }}
                      </option>
                    </select>
                  </div>
                  <div class="field">
                    <label class="lbl" for="policy-workspace">{{ $t('settings.p2p.policy.target-workspace') }}</label>
                    <input
                      id="policy-workspace"
                      v-model="newRuleWorkspace"
                      type="text"
                      spellcheck="false"
                      autocomplete="off"
                      :disabled="!policyEditable"
                      :placeholder="$t('settings.p2p.policy.blank-is-any')"
                    />
                  </div>
                  <div class="field">
                    <label class="lbl" for="policy-pane">{{ $t('settings.p2p.policy.target-pane') }}</label>
                    <input
                      id="policy-pane"
                      v-model="newRulePaneName"
                      type="text"
                      spellcheck="false"
                      autocomplete="off"
                      :disabled="!policyEditable"
                      :placeholder="$t('settings.p2p.policy.blank-is-any')"
                    />
                  </div>
                </div>
                <div class="row-g gap p2p-actions">
                  <button class="ap-reset" :disabled="!policyEditable" @click="addP2pPolicyRule">
                    {{ $t('settings.p2p.policy.add') }}
                  </button>
                </div>
                <p v-if="p2pPolicyError" class="err-msg">{{ p2pPolicyError }}</p>
              </div>
            </SettingsCard>

            <!-- Who belongs to the team space. Hidden for the same reason the
                 policy card is: a machine with no server has no team, and the
                 on-machine path has never had a concept of one. -->
            <SettingsCard v-if="p2pState !== 'unconfigured'">
              <div class="s-fullrow" data-settings-section="general-p2p-members">
                <h3 class="policy-title">{{ $t('settings.p2p.members.title') }}</h3>
                <p class="ap-hint">{{ $t('settings.p2p.members.hint') }}</p>
                <p v-if="membersReadonlyByRole" class="policy-readonly">{{ $t('settings.p2p.members.readonly-role') }}</p>
                <p v-else-if="!p2pMembers?.canManage" class="policy-readonly">{{ $t('settings.p2p.members.readonly-offline') }}</p>

                <p class="policy-section-label">{{ $t('settings.p2p.members.roster') }}</p>
                <p v-if="!membersList.length" class="policy-empty">{{ $t('settings.p2p.members.empty') }}</p>
                <ul v-else class="policy-rules">
                  <li v-for="member in membersList" :key="member.memberId" class="policy-rule member-row">
                    <div class="member-main">
                      <span class="policy-rule-text">
                        {{ memberLabel(member) }}
                        <span v-if="member.memberId === myMemberId" class="member-tag">{{ $t('settings.p2p.members.you') }}</span>
                        <span v-if="member.disabled" class="member-tag off">{{ $t('settings.p2p.members.disabled') }}</span>
                      </span>
                      <!-- Non-admins see the role as text: the server refuses
                           every write they could make from a control. -->
                      <span v-if="!p2pMembers?.canManage" class="member-role-static">
                        {{ $t('settings.p2p.members.role-' + member.role) }}
                      </span>
                      <template v-else>
                        <select
                          class="member-role"
                          :value="member.role"
                          :aria-label="$t('settings.p2p.members.role')"
                          :disabled="!membersCanManage || memberRoleLocked(member)"
                          :title="memberRoleLocked(member) ? $t('settings.p2p.members.self-locked') : ''"
                          @change="changeMemberRole(member, $event.target as HTMLSelectElement)"
                        >
                          <option v-for="role in MEMBER_ROLES" :key="role" :value="role">
                            {{ $t('settings.p2p.members.role-' + role) }}
                          </option>
                        </select>
                        <button
                          v-if="!member.disabled"
                          class="ap-reset"
                          :disabled="!membersCanManage"
                          @click="memberRevoking = member.memberId"
                        >
                          {{ $t('settings.p2p.members.revoke') }}
                        </button>
                      </template>
                    </div>
                    <!-- Disabling drops live connections, so it says so before
                         it happens rather than after. -->
                    <div v-if="memberRevoking === member.memberId" class="member-confirm">
                      <p class="member-confirm-text">
                        {{ $t('settings.p2p.members.revoke-confirm', { name: memberLabel(member) }) }}
                      </p>
                      <div class="row-g gap">
                        <button class="ap-reset danger" :disabled="!membersCanManage" @click="revokeMember(member)">
                          {{ $t('settings.p2p.members.revoke-do') }}
                        </button>
                        <button class="ap-reset" @click="memberRevoking = ''">
                          {{ $t('settings.p2p.members.revoke-cancel') }}
                        </button>
                      </div>
                    </div>
                  </li>
                </ul>

                <template v-if="p2pMembers?.canManage">
                  <p class="policy-section-label">{{ $t('settings.p2p.members.invite-title') }}</p>
                  <div class="policy-add">
                    <div class="field">
                      <label class="lbl" for="member-name">{{ $t('settings.p2p.members.invite-name') }}</label>
                      <input
                        id="member-name"
                        v-model="inviteName"
                        type="text"
                        spellcheck="false"
                        autocomplete="off"
                        :disabled="!membersCanManage"
                        :placeholder="$t('settings.p2p.members.invite-optional')"
                      />
                    </div>
                    <div class="field">
                      <label class="lbl" for="member-email">{{ $t('settings.p2p.members.invite-email') }}</label>
                      <input
                        id="member-email"
                        v-model="inviteEmail"
                        type="text"
                        spellcheck="false"
                        autocomplete="off"
                        :disabled="!membersCanManage"
                        :placeholder="$t('settings.p2p.members.invite-optional')"
                      />
                    </div>
                    <div class="field">
                      <label class="lbl" for="member-role">{{ $t('settings.p2p.members.role') }}</label>
                      <select id="member-role" v-model="inviteRole" :disabled="!membersCanManage">
                        <option v-for="role in MEMBER_ROLES" :key="role" :value="role">
                          {{ $t('settings.p2p.members.role-' + role) }}
                        </option>
                      </select>
                    </div>
                  </div>
                  <div class="row-g gap p2p-actions">
                    <button class="ap-reset" :disabled="!membersCanManage" @click="inviteMember">
                      {{ $t('settings.p2p.members.invite') }}
                    </button>
                  </div>
                </template>

                <!-- The one-time token. The server never sends it again, so it
                     stays on screen until the admin says they have it, and ESC
                     is ignored while it is up. -->
                <div v-if="memberInvite" class="member-token">
                  <p class="member-token-title">
                    {{ $t('settings.p2p.members.token-title', { name: memberInvite.displayName || memberInvite.email || memberInvite.memberId }) }}
                  </p>
                  <p class="member-token-warn">{{ $t('settings.p2p.members.token-once') }}</p>
                  <code class="member-token-value">{{ memberInvite.token }}</code>
                  <div class="row-g gap">
                    <button class="ap-reset" @click="copyInviteToken">
                      {{ memberInviteCopied ? $t('settings.p2p.members.token-copied') : $t('settings.p2p.members.token-copy') }}
                    </button>
                    <button class="ap-reset" @click="memberInvite = null">
                      {{ $t('settings.p2p.members.token-done') }}
                    </button>
                  </div>
                </div>

                <p v-if="membersNotice" class="summary-ok">{{ membersNotice }}</p>
                <p v-if="membersError" class="err-msg">{{ membersError }}</p>
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

                <!-- Where the update actually is. Each stage below owns the
                     settings group of the same name. -->
                <ol v-if="updStages.length" class="upd-rail">
                  <li
                    v-for="(stage, stageIndex) in updStages"
                    :key="stage.id"
                    :class="['upd-stage', stage.state]"
                  >
                    <span class="upd-stage-mark" aria-hidden="true">
                      {{ stage.state === 'done' ? '✓' : stage.state === 'failed' ? '!' : stageIndex + 1 }}
                    </span>
                    <span class="upd-stage-label">{{ $t(`updater.stage.${stage.id}`) }}</span>
                    <span v-if="stage.percent !== undefined" class="upd-stage-pct">{{ stage.percent }}%</span>
                  </li>
                </ol>

                <p v-if="updateState.status === 'checking'" class="ap-hint">{{ $t('updater.checking') }}</p>
                <p v-else-if="updateState.status === 'not-available'" class="summary-ok">{{ $t('updater.up-to-date') }}</p>
                <p v-else-if="updateState.status === 'error'" class="err-msg">{{ $t('updater.error', { message: updateState.message }) }}</p>
                <p v-else-if="updateState.status === 'unsupported'" class="ap-hint">{{ $t('updater.unsupported') }}</p>

                <!-- Diagnostics: a run of failed background checks always shows
                     here. notifyOnCheckFailure only gates the status bar. -->
                <p v-if="updateState.lastCheckFailure" class="err-msg">
                  {{ $t('updater.check-failure', {
                    count: updateState.lastCheckFailure.count,
                    message: updateState.lastCheckFailure.message,
                  }) }}
                  {{ updateState.checkedAt
                    ? $t('updater.last-successful-check', { at: updLastSuccessfulCheck })
                    : $t('updater.last-successful-check-never') }}
                </p>

                <div v-if="['available', 'downloading', 'downloaded', 'installing'].includes(updateState.status)" class="upd-available">
                  <p class="summary-ok">{{ $t('updater.available', { version: updateState.availableVersion }) }}</p>
                  <p v-if="updateState.status === 'downloading'" class="ap-hint">{{ $t('updater.downloading', { percent: updateState.percent ?? 0 }) }}</p>
                  <p v-else-if="updateState.status === 'downloaded'" class="ap-hint">
                    {{ updateState.quitInstallArmed ? $t('updater.downloaded-on-quit') : $t('updater.downloaded') }}
                  </p>
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
          </SettingsSection>

          <!-- One group per stage of the rail above: every setting sits under
               the step of the update it actually governs, instead of nine
               switches in one undifferentiated list. -->
          <SettingsSection :label="$t('updater.group.check')">
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
              <SettingRow :title="$t('updater.channel')" :description="$t('updater.channel-hint')">
                <template #control>
                  <select :value="updSettings.channel" @change="updUpdateSettings({ channel: ($event.target as HTMLSelectElement).value as UpdateChannel })">
                    <option value="stable">{{ $t('updater.channel-stable') }}</option>
                    <option value="beta" disabled>{{ $t('updater.channel-beta') }} — {{ $t('updater.channel-beta-unavailable') }}</option>
                  </select>
                </template>
              </SettingRow>
              <div v-if="updSettings.channel === 'beta'" class="s-fullrow">
                <p class="ap-hint">{{ $t('updater.beta-warning') }}</p>
              </div>
              <SettingRow
                :title="$t('updater.notify-check-failure')"
                :description="$t('updater.notify-check-failure-hint')"
              >
                <template #control>
                  <ToggleSwitch
                    :model-value="updSettings.notifyOnCheckFailure"
                    :aria-label="$t('updater.notify-check-failure')"
                    @update:model-value="(v) => updUpdateSettings({ notifyOnCheckFailure: v })"
                  />
                </template>
              </SettingRow>
              <SettingRow
                v-if="updSettings.notifyOnCheckFailure"
                :title="$t('updater.check-failure-threshold')"
                :description="$t('updater.check-failure-threshold-hint')"
              >
                <template #control>
                  <input
                    type="number"
                    :min="CHECK_FAILURE_THRESHOLD_RANGE.min"
                    :max="CHECK_FAILURE_THRESHOLD_RANGE.max"
                    :value="updSettings.checkFailureThreshold"
                    :aria-label="$t('updater.check-failure-threshold')"
                    @change="updUpdateSettings({ checkFailureThreshold: Number(($event.target as HTMLInputElement).value) })"
                  />
                </template>
              </SettingRow>
            </SettingsCard>
          </SettingsSection>

          <SettingsSection :label="$t('updater.group.download')">
            <SettingsCard>
              <SettingRow :title="$t('updater.auto-download')" :description="$t('updater.auto-download-hint')">
                <template #control>
                  <ToggleSwitch
                    :model-value="updSettings.autoDownload"
                    :aria-label="$t('updater.auto-download')"
                    @update:model-value="(v) => updUpdateSettings({ autoDownload: v })"
                  />
                </template>
              </SettingRow>
              <SettingRow
                :title="$t('updater.retry-download')"
                :description="$t('updater.retry-download-hint')"
              >
                <template #control>
                  <ToggleSwitch
                    :model-value="updSettings.retryDownload"
                    :aria-label="$t('updater.retry-download')"
                    @update:model-value="(v) => updUpdateSettings({ retryDownload: v })"
                  />
                </template>
              </SettingRow>
              <SettingRow
                v-if="updSettings.retryDownload"
                :title="$t('updater.download-retry-count')"
                :description="$t('updater.download-retry-count-hint')"
              >
                <template #control>
                  <input
                    type="number"
                    :min="DOWNLOAD_RETRY_COUNT_RANGE.min"
                    :max="DOWNLOAD_RETRY_COUNT_RANGE.max"
                    :value="updSettings.downloadRetryCount"
                    :aria-label="$t('updater.download-retry-count')"
                    @change="updUpdateSettings({ downloadRetryCount: Number(($event.target as HTMLInputElement).value) })"
                  />
                </template>
              </SettingRow>
            </SettingsCard>
          </SettingsSection>

          <SettingsSection :label="$t('updater.group.install')">
            <SettingsCard>
              <SettingRow
                :title="$t('updater.auto-install')"
                :description="$t('updater.auto-install-hint')"
              >
                <template #control>
                  <ToggleSwitch
                    :model-value="updSettings.autoInstallOnQuit"
                    :aria-label="$t('updater.auto-install')"
                    @update:model-value="(v) => updUpdateSettings({ autoInstallOnQuit: v })"
                  />
                </template>
              </SettingRow>
              <!-- Switching off cannot un-stage a payload the OS updater already
                   took, so say so rather than implying it was cancelled. -->
              <div v-if="!updSettings.autoInstallOnQuit && updateState.quitInstallArmed" class="s-fullrow">
                <p class="ap-hint">{{ $t('updater.auto-install-already-armed') }}</p>
              </div>
              <SettingRow
                :title="$t('updater.install-timeout')"
                :description="$t('updater.install-timeout-hint')"
              >
                <template #control>
                  <input
                    type="number"
                    :min="INSTALL_TIMEOUT_SECONDS_RANGE.min"
                    :max="INSTALL_TIMEOUT_SECONDS_RANGE.max"
                    :value="updSettings.installTimeoutSeconds"
                    :aria-label="$t('updater.install-timeout')"
                    @change="updUpdateSettings({ installTimeoutSeconds: Number(($event.target as HTMLInputElement).value) })"
                  />
                </template>
              </SettingRow>
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

        <div v-show="activeTab === 'accounts'" class="s-body s-body--bleed accounts-body" data-settings-section="accounts">
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
        <!-- ── HELP TAB (read-only reference: messaging + shortcuts) ─────── -->
        <!-- ── KEYBINDINGS TAB (editable; the Help tab keeps the read-only
             reference, which also covers xterm and native-menu keys that the
             central rule table does not own) ─────────────────────────────── -->
        <div v-show="activeTab === 'keybindings'" class="s-body keybindings-body" data-settings-section="keybindings">
          <h1 class="s-page-title">{{ $t('settings.nav.keybindings') }}</h1>
          <KeyboardShortcutsEditor v-if="activeTab === 'keybindings'" />
        </div>

        <div v-show="activeTab === 'help'" class="s-body help-body" data-settings-section="help">
          <h1 class="s-page-title">{{ $t('settings.nav.help') }}</h1>
          <div class="help-topics" role="tablist">
            <button
              class="help-topic"
              :class="{ active: helpTopic === 'messaging' }"
              role="tab"
              :aria-selected="helpTopic === 'messaging'"
              @click="helpTopic = 'messaging'"
            >{{ $t('settings.help.topic.messaging') }}</button>
            <button
              class="help-topic"
              :class="{ active: helpTopic === 'mcp' }"
              role="tab"
              :aria-selected="helpTopic === 'mcp'"
              @click="helpTopic = 'mcp'"
            >{{ $t('settings.help.topic.mcp') }}</button>
          </div>
          <CliMessagingHelp v-if="activeTab === 'help' && helpTopic === 'messaging'" />
          <McpHelp v-else-if="activeTab === 'help'" />
        </div>

        <!-- ── EXTENSIONS TAB (flag-gated) ───────────────────────────────── -->
        <div v-show="activeTab === 'extensions'" class="s-body s-body--bleed" data-settings-section="extensions">
          <h1 class="s-page-title">{{ $t('settings.nav.extensions') }}</h1>
          <ExtensionsPane />
        </div>

        <!-- ── LAYOUT TAB ────────────────────────────────────────────────── -->
        <div v-show="activeTab === 'layout'" class="s-body layout-body" data-settings-section="layout">
          <h1 class="s-page-title">{{ $t('settings.nav.layout') }}</h1>
          <LayoutSettingsPane />
        </div>

        <!-- ── STORAGE TAB ───────────────────────────────────────────────── -->
        <div v-show="activeTab === 'storage'" class="s-body storage-body" data-settings-section="storage">
          <h1 class="s-page-title">{{ $t('settings.nav.storage') }}</h1>
          <!-- Lazy-mounted: the scan is expensive, so it only runs once the
               user actually opens this tab. -->
          <StorageUsagePane
            v-if="activeTab === 'storage'"
            :backend="props.backend"
            :workspace-paths="props.workspacePaths"
          />
        </div>

        </div>
        <!-- /.s-content -->

      </div>
    </div>

    <!-- Confirm dialogs -->
    <div v-if="false" class="s-overlay confirm">
    </div>
  </Teleport>
</template>

<style scoped>
/* ── Overlay & modal shell ─────────────────────────────────────────────────── */
.s-overlay {
  position: fixed;
  inset: 0;
  background: var(--modal-backdrop);
  backdrop-filter: blur(var(--modal-backdrop-blur));
  -webkit-backdrop-filter: blur(var(--modal-backdrop-blur));
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
  border-radius: var(--radius-lg);
  width: min(var(--modal-w-wide), 92vw);
  max-width: 1100px;
  height: 88vh;
  display: grid;
  grid-template-columns: 232px minmax(0, 1fr);
  overflow: hidden;
  box-shadow: var(--shadow-modal);
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
}
.s-ws-meta {
  display: flex;
  flex-direction: column;
  min-width: 0;
  line-height: 1.25;
}
.s-ws-name {
  font-size: var(--font-sm);
  font-weight: 600;
  color: var(--text-bright);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
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
  border-radius: var(--radius-sm);
  color: var(--text-primary);
  font-size: var(--font-xs);
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
  border-radius: var(--radius-md);
  box-shadow: 0 16px 36px rgba(0,0,0,0.45);
  padding: 6px;
}
.s-search-result {
  width: 100%;
  border: 0;
  background: transparent;
  color: var(--text-primary);
  text-align: left;
  border-radius: var(--radius-sm);
  padding: 8px 9px;
  cursor: pointer;
}
.s-search-result:hover,
.s-search-result:focus-visible {
  background: var(--bg-muted);
  outline: none;
}
/* The background above is the same one hover paints, so keyboard focus was
   indistinguishable from a mouse-over. Inset so the list's overflow cannot
   clip it. */
.s-search-result:focus-visible {
  box-shadow: inset 0 0 0 2px var(--accent-focus);
}
.s-search-result-main {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  min-width: 0;
}
.s-search-result-title {
  font-size: var(--font-xs);
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
  font-size: var(--font-2xs);
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
.ap-title { margin: 0 0 4px; font-size: var(--font-sm); font-weight: 600; color: var(--text-bright); }
.ap-hint { margin: 0 0 14px; font-size: 11.5px; color: var(--text-secondary); }
.ap-hint-warn { color: var(--danger-fg); }

/* ── Two-column settings layout (page title / full-width rows / control labels) ── */
.s-page-title {
  margin: 0 0 var(--space-group);
  font-size: var(--font-page-title);
  font-weight: 700;
  color: var(--text-bright);
}
/* The title already reserves --space-group below it; the section's own top
   margin would double the gap on the tabs that open with a SettingsSection. */
.s-page-title + .settings-section { margin-top: 0; }
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
  padding: 8px 12px; border: 1px solid var(--border-default); border-radius: var(--radius-md);
  background: var(--bg-elevated);
}
.cli-agent-row.drag-over { box-shadow: inset 0 0 0 2px var(--accent-focus); background: var(--accent-subtle); }
.cli-agent-row.is-disabled { opacity: 0.55; }
.cli-agent-grip { color: var(--text-secondary); cursor: grab; user-select: none; font-size: var(--font-md); }
.cli-agent-toggle { display: flex; align-items: center; gap: 8px; flex: 1; cursor: pointer; margin: 0; }
.cli-agent-label { font-size: var(--font-sm); font-weight: 600; }
.cli-agent-hint { font-size: var(--font-2xs); color: var(--text-secondary); }
/* Permission overrides: name | flag | mode picker, the flag column taking the
   slack so the pickers line up down the list. */
.perm-global { margin: 4px 0 10px; }
.perm-row { gap: 10px; }
.perm-name { flex: 0 0 96px; }
.perm-flag { flex: 1; min-width: 0; font-size: var(--font-2xs); color: var(--text-secondary); overflow-x: auto; white-space: nowrap; }
.perm-select { flex: 0 0 auto; font-size: var(--font-2xs); }
.perm-row.perm-overridden { border-color: var(--accent-focus); }
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
  border-radius: var(--radius-md);
  background: var(--bg-subtle);
  cursor: pointer;
  transition: border-color var(--motion-fast) var(--ease-out), background var(--motion-fast) var(--ease-out);
  text-align: left;
}
.ap-theme-card:hover { border-color: var(--border-strong); background: var(--bg-muted); }
.ap-theme-card.active { border-color: var(--accent-emphasis); box-shadow: 0 0 0 1px var(--accent-emphasis); }
.ap-swatches { display: flex; gap: 4px; }
.ap-swatch { width: 24px; height: 24px; border-radius: var(--radius-sm); border: 1px solid var(--border-muted); }
.ap-theme-label { font-size: var(--font-xs); font-weight: 500; color: var(--text-primary); }
.ap-check { position: absolute; top: 10px; right: 11px; font-size: var(--font-xs); color: var(--accent-fg); }
.ap-lang-row { display: flex; gap: 10px; flex-wrap: wrap; }
.ap-toggle-row { display: flex; align-items: center; gap: 8px; cursor: pointer; color: var(--text-primary); font-size: var(--font-sm); }
.ap-toggle-row input { cursor: pointer; }
.ap-lang-btn {
  position: relative;
  padding: 8px 20px;
  border: 1px solid var(--border-default);
  border-radius: var(--radius-md);
  background: var(--bg-subtle);
  color: var(--text-primary);
  font-size: var(--font-sm);
  cursor: pointer;
  transition: border-color var(--motion-fast) var(--ease-out), background var(--motion-fast) var(--ease-out);
}
.ap-lang-btn:hover { border-color: var(--border-strong); background: var(--bg-muted); }
.ap-lang-btn.active { border-color: var(--accent-emphasis); box-shadow: 0 0 0 1px var(--accent-emphasis); }
.ap-timeout-field { max-width: 140px; }
.ap-reset {
  font-size: var(--font-2xs);
  padding: 4px 10px;
  border: 1px solid var(--border-default);
  border-radius: var(--radius-sm);
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
  border-radius: var(--radius-sm);
  background: var(--bg-subtle);
}
.ap-color-input {
  width: 34px;
  height: 26px;
  padding: 0;
  border: 1px solid var(--border-default);
  border-radius: var(--radius-sm);
  background: transparent;
  cursor: pointer;
  flex-shrink: 0;
}
.ap-color-name { font-size: var(--font-xs); color: var(--text-primary); min-width: 92px; }
.ap-color-token { font-size: 10.5px; color: var(--text-muted); font-family: var(--font-mono); flex: 1; }
.ap-color-clear {
  width: 20px;
  height: 20px;
  border: none;
  border-radius: var(--radius-xs);
  background: transparent;
  color: var(--text-secondary);
  cursor: pointer;
  font-size: var(--font-2xs);
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
  font-size: var(--font-lg);
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
/* Storage tab is a two-column settings page like appearance/general: the bare
   .s-body clips instead of scrolling, so it needs its own scroll + padding. */
.storage-body { overflow-y: auto; padding: 18px 22px; }
/* Same reason as storage: a stack of region cards needs the gutter and its own
   scroll, which the bare .s-body (overflow:hidden, no padding) does not give. */
.layout-body { overflow-y: auto; padding: 18px 22px; }
/* Same as the other padded tabs: without a modifier the bare .s-body is
   overflow:hidden with no gutter, which clips the shortcut list instead of
   scrolling it. */
.keybindings-body { overflow-y: auto; padding: 18px 22px; }
/* Full-bleed tabs (roles/pipelines/mcp/skills/analyzer/accounts/extensions) keep
   edge-to-edge bars and split panes, so their body cannot carry the page gutter.
   The page title carries it instead, matching the 18px/22px inset the padded tab
   bodies above apply to their whole content. */
.s-body--bleed > .s-page-title { padding: 18px 22px 0; flex-shrink: 0; }
.settings-meta-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 22px;
  border-bottom: 1px solid var(--border-muted);
  background: var(--bg-inset);
  color: var(--text-secondary);
  font-size: var(--font-2xs);
  min-width: 0;
  flex-shrink: 0;
}
.settings-meta-row.inline {
  padding: 7px 9px;
  border: 1px solid var(--border-muted);
  border-radius: var(--radius-sm);
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
  font-family: var(--font-mono);
}
.settings-path-divider { color: var(--text-muted); }
.settings-path-btn {
  flex-shrink: 0;
  border: 1px solid var(--border-default);
  background: transparent;
  color: var(--text-secondary);
  border-radius: var(--radius-sm);
  padding: 3px 7px;
  font-size: 10.5px;
  cursor: pointer;
}
.settings-path-btn:hover:not(:disabled) {
  color: var(--text-bright);
  background: var(--bg-muted);
}
.settings-path-btn:disabled { opacity: 0.45; cursor: not-allowed; }

button.tiny {
  padding: 3px 7px;
  font-size: 10.5px;
  line-height: 1.2;
}
.summary-ok { font-size: var(--font-2xs); color: var(--success-fg); margin-left: 6px; }

/* Update pipeline rail: check → download → install. The connector is drawn on
   each step except the first, so the row stays a plain flex list. */
.upd-rail {
  display: flex;
  align-items: center;
  gap: 0;
  list-style: none;
  margin: 12px 0 10px;
  padding: 0;
  flex-wrap: wrap;
}
.upd-stage {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11.5px;
  color: var(--text-muted);
}
.upd-stage + .upd-stage::before {
  content: "";
  width: 26px;
  height: 1px;
  margin: 0 10px;
  background: var(--border-default);
}
.upd-stage-mark {
  display: grid;
  place-items: center;
  width: 18px;
  height: 18px;
  border: 1px solid var(--border-default);
  border-radius: 50%;
  font-size: var(--font-3xs);
  line-height: 1;
}
.upd-stage.active { color: var(--text-bright); }
.upd-stage.active .upd-stage-mark { border-color: var(--accent-emphasis); color: var(--accent-bright); }
.upd-stage.done .upd-stage-mark {
  border-color: var(--success-emphasis);
  background: var(--success-emphasis);
  color: var(--text-on-emphasis);
}
.upd-stage.failed { color: var(--danger-fg); }
.upd-stage.failed .upd-stage-mark { border-color: var(--danger-fg); color: var(--danger-fg); }
.upd-stage-pct { color: var(--text-bright); font-variant-numeric: tabular-nums; }

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
  border-radius: var(--radius-sm);
}

/* ── Fields ───────────────────────────────────────────────────────────────── */
.field { display: flex; flex-direction: column; gap: 4px; }
.lbl { font-size: var(--font-3xs); font-weight: 600; text-transform: uppercase; letter-spacing: 0.06em; color: var(--text-secondary); }
input[type='text'], input[type='email'], input[type='number'], input[type='password'], textarea, select {
  background: var(--bg-subtle);
  border: 1px solid var(--border-default);
  color: var(--text-bright);
  padding: 7px 9px;
  border-radius: var(--radius-xs);
  font-family: inherit;
  font-size: var(--font-xs);
  box-sizing: border-box;
  width: 100%;
}
textarea { font-family: var(--font-mono); resize: vertical; line-height: var(--lh-base); }
input:focus, textarea:focus, select:focus { outline: none; border-color: var(--accent-emphasis); }
input:disabled { opacity: 0.5; cursor: not-allowed; }

/* ── List items ───────────────────────────────────────────────────────────── */
.row-g { display: flex; align-items: center; gap: 6px; }
.row-g.gap { gap: 8px; }
.badge { background: var(--bg-muted); color: var(--text-secondary); font-size: 9px; padding: 1px 5px; border-radius: var(--radius-xs); }

/* ── Buttons ──────────────────────────────────────────────────────────────── */
button {
  border: 1px solid var(--border-default);
  background: var(--bg-muted);
  color: var(--text-bright);
  font-size: var(--font-xs);
  padding: 6px 12px;
  border-radius: var(--radius-xs);
  cursor: pointer;
  transition:
    background var(--motion-fast) var(--ease-out),
    border-color var(--motion-fast) var(--ease-out),
    color var(--motion-fast) var(--ease-out),
    opacity var(--motion-fast) var(--ease-out);
}
button:disabled { opacity: 0.45; cursor: not-allowed; }
button.primary { background: var(--success-emphasis); border-color: var(--success-strong); color: var(--text-on-emphasis); font-weight: 600; }
button.primary:not(:disabled):hover { background: var(--success-strong); }
button.danger { background: var(--danger-deep); border-color: var(--danger-muted); color: var(--text-on-emphasis); }
button.danger:hover { background: var(--danger-muted); }
button.ghost { background: transparent; }
button.ghost:hover:not(:disabled) { background: var(--bg-muted); }
/* The label carries a count, which must not wrap inside the row's control slot. */
.reclaim-now-btn { white-space: nowrap; }
/* The only button in this panel with no feedback of its own: the base rule
   above supplies its box, this supplies hover and press. */
.reclaim-now-btn:hover:not(:disabled) {
  background: var(--bg-hover-strong);
  border-color: var(--border-strong);
}
.reclaim-now-btn:focus-visible {
  outline: none;
  box-shadow: inset 0 0 0 2px var(--accent-focus);
}

/* ── Messages ─────────────────────────────────────────────────────────────── */
.err-msg { color: var(--danger-fg); font-size: var(--font-2xs); margin: 0; }

/* Cross-device link */
/* Sign-in tabs. No width/box-sizing here on purpose: these panels have no
   border-box, so a width:100% would push the card past its grid track. */
.p2p-tabs { display: flex; gap: 2px; margin: 14px 0 4px; border-bottom: 1px solid var(--border-default); }
.p2p-tab {
  appearance: none; background: none; border: 0; border-bottom: 2px solid transparent;
  padding: 6px 12px; font-size: var(--font-xs); color: var(--text-secondary); cursor: pointer;
}
.p2p-tab:hover:not(:disabled) { color: var(--text-bright); }
.p2p-tab.on { color: var(--text-bright); border-bottom-color: var(--accent-focus); font-weight: 500; }
.p2p-tab:disabled { opacity: 0.5; cursor: default; }
.p2p-account { margin-top: 12px; }
.p2p-account-row {
  display: flex; justify-content: space-between; gap: 12px;
  padding: 5px 0; font-size: var(--font-xs); border-bottom: 1px solid var(--border-muted);
}
.p2p-account-row:last-of-type { border-bottom: 0; }
.p2p-account-row .lbl { color: var(--text-secondary); }
.p2p-field { margin-top: 10px; }
.p2p-field .ap-hint { margin: 4px 0 0; }
.p2p-actions { margin-top: 12px; }
.p2p-status { display: flex; align-items: center; margin: 12px 0 0; font-size: 11.5px; color: var(--text-bright); }
.p2p-dot { display: inline-block; width: 7px; height: 7px; border-radius: 50%; margin-right: 6px; flex-shrink: 0; }
.p2p-dot.ok { background: var(--success-fg); }
.p2p-dot.err { background: var(--danger-fg); }
.p2p-dot.warn { background: var(--attention-fg); }
.p2p-dot.idle { background: var(--text-secondary); }
.p2p-detail { margin: 4px 0 0; font-size: var(--font-2xs); color: var(--text-secondary); word-break: break-all; }

/* Cross-device authorization (pane policy) */
.policy-title { margin: 0 0 6px; font-size: 12.5px; color: var(--text-bright); }
.policy-deny { margin: 8px 0 0; font-size: var(--font-2xs); color: var(--attention-fg); }
.policy-readonly { margin: 6px 0 0; font-size: var(--font-2xs); color: var(--text-secondary); }
.policy-switch { display: flex; align-items: flex-start; gap: 8px; margin: 12px 0 0; cursor: pointer; }
.policy-switch input { margin-top: 2px; flex-shrink: 0; }
.policy-switch-label { display: block; font-size: var(--font-xs); color: var(--text-bright); }
.policy-switch .ap-hint { margin: 2px 0 0; }
.policy-section-label { margin: 14px 0 6px; font-size: var(--font-2xs); text-transform: uppercase; letter-spacing: 0.04em; color: var(--text-secondary); }
.policy-empty { margin: 0; font-size: 11.5px; color: var(--text-secondary); }
.policy-rules { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 4px; }
.policy-rule { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 6px 8px; border: 1px solid var(--border-default); border-radius: var(--radius-sm); background: var(--bg-muted); }
.policy-rule-text { font-size: 11.5px; color: var(--text-bright); word-break: break-all; }
.policy-add { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; }
.member-row { flex-direction: column; align-items: stretch; gap: 6px; }
.member-main { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
.member-main .policy-rule-text { flex: 1; min-width: 0; }
.member-tag { margin-left: 6px; padding: 1px 5px; border-radius: var(--radius-xs); font-size: var(--font-3xs); background: var(--bg-default); color: var(--text-secondary); }
.member-tag.off { color: var(--attention-fg); }
.member-role-static { font-size: 11.5px; color: var(--text-secondary); flex-shrink: 0; }
.member-role { flex-shrink: 0; }
.member-confirm { border-top: 1px solid var(--border-default); padding-top: 6px; display: flex; flex-direction: column; gap: 6px; }
.member-confirm-text { margin: 0; font-size: 11.5px; color: var(--attention-fg); }
.member-token { margin: 12px 0 0; padding: 10px; border: 1px solid var(--attention-fg); border-radius: var(--radius-sm); background: var(--bg-muted); display: flex; flex-direction: column; gap: 8px; }
.member-token-title { margin: 0; font-size: 12.5px; color: var(--text-bright); }
.member-token-warn { margin: 0; font-size: 11.5px; color: var(--attention-fg); }
.member-token-value { display: block; padding: 8px; border-radius: var(--radius-xs); background: var(--bg-default); font-size: var(--font-xs); color: var(--text-bright); word-break: break-all; user-select: all; }
.hint-msg { color: var(--text-secondary); font-size: var(--font-2xs); margin: 0; }

/* ── Appearance tab ─────────────────────────────────────────────────────────── */
.appearance-body { overflow-y: auto; }
.help-body { overflow-y: auto; padding: 18px 22px; }
.help-topics {
  display: flex;
  gap: 4px;
  margin-bottom: 18px;
  padding: 3px;
  border: 1px solid var(--border-muted);
  border-radius: var(--radius-md);
  background: var(--bg-inset);
  align-self: flex-start;
}
.help-topic {
  border: none;
  background: transparent;
  color: var(--text-secondary);
  font-size: 12.5px;
  font-weight: 600;
  padding: 5px 14px;
  border-radius: var(--radius-sm);
  cursor: pointer;
}
.help-topic:hover { color: var(--text-primary); }
.help-topic.active {
  background: var(--bg-base);
  color: var(--text-bright);
  box-shadow: 0 1px 2px var(--shadow-overlay);
}

/* ── MCP tab ──────────────────────────────────────────────────────────────── */
/* Sits between the server list and External access inside the scrolling
   column, so it must not be squeezed the way a flexible item would be. The
   gutter lines it up with the <h1> and the scope band above it. */
.mcp-agent-pane { flex-shrink: 0; padding: 18px 22px 4px; }
.mcp-body { overflow-y: auto; display: flex; flex-direction: column; }

/* Top bar */
.mcp-topbar {
  display: flex; align-items: center; gap: 12px; flex-wrap: wrap;
  padding: 12px 22px; border-bottom: 1px solid var(--border-muted);
  flex-shrink: 0; background: var(--bg-inset);
}
.mcp-page-title { font-size: var(--font-sm); font-weight: 700; color: var(--text-bright); flex: 1; min-width: 0; }
.mcp-topbar-actions { display: flex; gap: 8px; }
.mcp-action-btn {
  font-size: var(--font-2xs); padding: 5px 11px; border-radius: var(--radius-sm);
  background: var(--bg-muted); border: 1px solid var(--border-default); color: var(--text-bright); cursor: pointer;
}
.mcp-action-btn:hover:not(:disabled) { background: var(--border-default); }
.mcp-action-btn:disabled { opacity: 0.4; cursor: not-allowed; }
.mcp-back-btn {
  font-size: var(--font-xs); padding: 4px 10px; border-radius: var(--radius-sm);
  background: transparent; border: 1px solid var(--border-default); color: var(--text-secondary); cursor: pointer;
}
.mcp-back-btn:hover { background: var(--bg-muted); color: var(--text-bright); }
.mcp-summary-ok { font-size: var(--font-2xs); color: var(--success-fg); padding: 4px 22px; }
.mcp-conflict {
  display: flex; align-items: center; justify-content: space-between; gap: 10px;
  margin: 8px 22px 0; padding: 7px 9px; border-left: 3px solid var(--attention-fg);
  background: color-mix(in srgb, var(--attention-fg) 8%, var(--bg-subtle));
  color: var(--attention-fg); font-size: var(--font-2xs);
}

.mcp-empty { color: var(--text-muted); font-size: var(--font-xs); padding: 24px 0; text-align: center; }

/* Server card */

/* Main row: dot + name + trash + toggle */

/* Status dot */

/* Delete button */

/* Tools row */

/* Tool list */

.mcp-custom-form select {
  padding: 6px 8px; border: 1px solid var(--border-default); border-radius: var(--radius-sm);
  background: var(--bg-base); color: var(--text-primary);
}

/* Env vars editor */

/* Catalog view */
.mcp-search-wrap {
  position: relative; padding: 12px 16px; border-bottom: 1px solid var(--border-muted); flex-shrink: 0;
}
.mcp-search {
  width: 100%; padding: 8px 36px 8px 12px; border-radius: var(--radius-md);
  background: var(--bg-subtle); border: 1px solid var(--border-default); color: var(--text-bright);
  font-size: var(--font-xs); box-sizing: border-box;
}
.mcp-search:focus { outline: none; border-color: var(--accent-emphasis); }
.mcp-search-icon {
  position: absolute; right: 28px; top: 50%; transform: translateY(-50%);
  font-size: var(--font-sm); color: var(--text-muted); pointer-events: none;
}

.mcp-catalog-hint {
  padding: 8px 16px; font-size: var(--font-2xs); color: var(--text-secondary); line-height: 1.6;
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
.mcp-catalog-name { font-size: var(--font-sm); font-weight: 700; color: var(--text-bright); }
.mcp-catalog-desc { font-size: var(--font-2xs); color: var(--text-secondary); line-height: var(--lh-base); }
.mcp-catalog-note { font-size: var(--font-3xs); color: var(--attention-fg); margin-top: 2px; }
.mcp-add-btn {
  font-size: var(--font-2xs); padding: 6px 14px; border-radius: var(--radius-sm); white-space: nowrap; flex-shrink: 0;
  background: var(--accent-emphasis); border: 1px solid var(--accent-focus); color: var(--text-on-emphasis); font-weight: 600; cursor: pointer;
}
.mcp-add-btn:hover:not(:disabled) { background: var(--accent-focus); }
.mcp-add-btn:disabled { opacity: 0.45; cursor: not-allowed; }
.mcp-installed-badge {
  font-size: var(--font-2xs); padding: 6px 14px; border-radius: var(--radius-sm); white-space: nowrap; flex-shrink: 0;
  background: var(--bg-muted); border: 1px solid var(--border-default); color: var(--text-muted); cursor: not-allowed;
}
.mcp-custom-form {
  width: min(520px, calc(100% - 32px)); margin: 16px; padding: 14px;
  display: flex; flex-direction: column; gap: 12px;
  border: 1px solid var(--border-default); border-radius: var(--radius-card); background: var(--bg-subtle);
}
.mcp-custom-form > p { margin: 0; color: var(--text-secondary); font-size: var(--font-2xs); line-height: var(--lh-base); }
.mcp-custom-actions { display: flex; justify-content: flex-end; gap: 8px; }

/* External access / CDP debug section */
.ea-section-wrap { flex-shrink: 0; padding: 0 22px 18px; }
.ea-warning { margin: 0; padding: 0 var(--space-row-x) 10px; font-size: var(--font-2xs); color: var(--attention-fg); }
.ea-section-wrap .err-msg { padding: 0 var(--space-row-x) 10px; }
.ea-connection { padding: 0 var(--space-row-x) 12px; }
.ea-connection input[readonly] { width: 100%; font-size: var(--font-2xs); }

/* ── Analyzer tab ─────────────────────────────────────────────────────────── */
.analyzer-body { display: flex; flex-direction: column; gap: 0; overflow-y: auto; padding: 0; }

.az-section {
  padding: 14px 22px;
  border-bottom: 1px solid var(--border-muted);
  flex-shrink: 0;
}
.az-section-title { font-size: var(--font-2xs); font-weight: 600; color: var(--text-secondary); text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 10px; }
.az-section-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 10px; }
.az-section-header .az-section-title { margin-bottom: 0; }
.az-section-note { font-size: var(--font-3xs); color: var(--text-muted); }
.az-subsection { margin-top: 12px; }
.az-status-dot { display: inline-block; width: 7px; height: 7px; border-radius: 50%; margin-right: 5px; }
.az-status-dot.ok { background: var(--success-fg); }
.az-status-dot.err { background: var(--danger-fg); }
.az-pct { font-weight: 600; color: var(--text-bright); margin-left: 6px; }
.az-size-info { color: var(--text-muted); font-size: var(--font-2xs); margin-left: 4px; }
.az-gguf-hint { font-size: var(--font-2xs); color: var(--text-muted); margin-top: 6px; line-height: var(--lh-base); }
.az-gguf-hint code { background: var(--bg-subtle); padding: 1px 4px; border-radius: var(--radius-xs); color: var(--text-bright); }
.az-link { color: var(--accent-fg); text-decoration: none; }
.az-link:hover { text-decoration: underline; }
.az-code { background: var(--bg-subtle); padding: 1px 5px; border-radius: var(--radius-xs); font-size: var(--font-2xs); color: var(--text-bright); font-family: var(--font-mono); }
.az-url-row { display: flex; gap: 6px; align-items: center; }
.az-url-row .az-input { flex: 1; }
.az-recheck-btn {
  background: var(--bg-muted); border: 1px solid var(--border-default); color: var(--text-secondary);
  font-size: var(--font-md); padding: 6px 10px; border-radius: var(--radius-sm); cursor: pointer;
  flex-shrink: 0; transition: color var(--motion-fast) var(--ease-out), background var(--motion-fast) var(--ease-out);
}
.az-recheck-btn:hover:not(:disabled) { background: var(--border-default); color: var(--text-bright); }
.az-recheck-btn:disabled { opacity: 0.4; cursor: not-allowed; }
.az-detect-btn {
  background: var(--bg-muted); border: 1px solid var(--border-default); color: var(--text-secondary);
  font-size: var(--font-2xs); font-weight: 500; padding: 6px 10px; border-radius: var(--radius-sm); cursor: pointer;
  flex-shrink: 0; white-space: nowrap; transition: color var(--motion-fast) var(--ease-out), background var(--motion-fast) var(--ease-out);
}
.az-detect-btn:hover:not(:disabled) { background: var(--border-default); color: var(--text-bright); }
.az-detect-btn:disabled { opacity: 0.4; cursor: not-allowed; }
.az-browse-btn {
  background: var(--bg-muted); border: 1px solid var(--border-default); color: var(--text-secondary);
  font-size: var(--font-sm); padding: 6px 10px; border-radius: var(--radius-sm); cursor: pointer;
  flex-shrink: 0; transition: color var(--motion-fast) var(--ease-out), background var(--motion-fast) var(--ease-out);
}
.az-browse-btn:hover { background: var(--border-default); color: var(--text-bright); }

.az-backend-toggle { display: flex; gap: 0; border: 1px solid var(--border-default); border-radius: var(--radius-sm); overflow: hidden; width: fit-content; }
.az-backend-btn {
  background: var(--bg-subtle); border: none; color: var(--text-secondary); font-size: var(--font-xs);
  padding: 6px 16px; cursor: pointer; transition: background var(--motion-fast) var(--ease-out), color var(--motion-fast) var(--ease-out);
}
.az-backend-btn:hover { background: var(--bg-muted); color: var(--text-bright); }
.az-backend-btn.active { background: var(--accent-emphasis); color: var(--text-on-emphasis); font-weight: 600; }

.az-label { display: block; font-size: var(--font-2xs); color: var(--text-secondary); margin-bottom: 5px; }
.az-hint-inline { color: var(--text-muted); font-style: italic; }
.az-input {
  width: 100%; box-sizing: border-box;
  background: var(--bg-base); border: 1px solid var(--border-default); color: var(--text-bright);
  font-size: var(--font-xs); padding: 7px 10px; border-radius: var(--radius-sm);
  outline: none; transition: border-color var(--motion-fast) var(--ease-out);
}
.az-input:focus { border-color: var(--accent-focus); }
.az-status-row { margin-top: 8px; }

.az-pull-row { display: flex; gap: 8px; align-items: center; margin-bottom: 8px; }
.az-pull-input { flex: 1; margin-bottom: 0; }
.az-pull-error { font-size: var(--font-2xs); color: var(--danger-fg); margin-top: 6px; }

.az-progress-bar-wrap {
  height: 4px; background: var(--bg-muted); border-radius: var(--radius-xs); margin-top: 6px; overflow: hidden;
}
.az-progress-bar { height: 100%; background: var(--accent-emphasis); border-radius: var(--radius-xs); transition: width var(--motion-base) var(--ease-out); }

.az-model-list { margin-top: 8px; display: flex; flex-direction: column; gap: 4px; max-height: 200px; overflow-y: auto; }
.az-no-models { font-size: var(--font-xs); color: var(--text-muted); padding: 8px 0; }
.az-model-row {
  display: flex; align-items: center; justify-content: space-between;
  padding: 7px 10px; background: var(--bg-base); border: 1px solid var(--border-muted); border-radius: var(--radius-sm);
}
.az-model-info { display: flex; flex-direction: column; gap: 2px; }
.az-model-name { font-size: var(--font-xs); color: var(--text-bright); font-family: var(--font-mono); }
.az-model-meta { font-size: var(--font-3xs); color: var(--text-secondary); }
.az-del-btn {
  background: none; border: none; color: var(--text-muted); cursor: pointer; font-size: var(--font-xs);
  padding: 2px 6px; border-radius: var(--radius-xs); transition: color var(--motion-fast) var(--ease-out), background var(--motion-fast) var(--ease-out);
}
.az-del-btn:hover { color: var(--danger-fg); background: var(--bg-muted); }

.az-benchmark-section { flex-shrink: 0; display: flex; flex-direction: column; gap: 0; }

.az-version { font-size: var(--font-2xs); color: var(--text-secondary); }
.az-version.offline { color: var(--danger-fg); }
.az-run-btn {
  background: var(--accent-emphasis);
  border: 1px solid var(--accent-focus);
  color: var(--text-on-emphasis);
  font-size: var(--font-xs);
  font-weight: 600;
  padding: 7px 16px;
  border-radius: var(--radius-sm);
  cursor: pointer;
  transition: background var(--motion-fast) var(--ease-out);
}
.az-run-btn:hover:not(:disabled) { background: var(--accent-focus); }
.az-run-btn:disabled { opacity: 0.45; cursor: not-allowed; }

.az-progress-wrap {
  padding: 10px 20px;
  border-bottom: 1px solid var(--border-muted);
  background: var(--bg-base);
  flex-shrink: 0;
}
.az-progress-label { font-size: var(--font-xs); color: var(--text-secondary); display: flex; align-items: center; gap: 8px; }
.az-spin { animation: spin 1s linear infinite; display: inline-block; }
@keyframes spin { to { transform: rotate(360deg); } }

.az-hint {
  padding: 20px 24px;
  color: var(--text-secondary);
  font-size: var(--font-xs);
  line-height: 1.7;
}
.az-hint p { margin: 0 0 10px; }
.az-hint ul { margin: 0 0 10px; padding-left: 18px; }
.az-hint li { margin-bottom: 4px; }
.az-hint code { background: var(--bg-subtle); padding: 1px 5px; border-radius: var(--radius-xs); font-size: var(--font-2xs); color: var(--text-bright); }
.az-pass-rule { color: var(--accent-fg); font-size: var(--font-2xs); }

.az-results { padding: 16px 20px; flex: 1; overflow-y: auto; min-height: 0; }
.az-results-summary {
  font-size: var(--font-xs);
  color: var(--text-secondary);
  margin-bottom: 12px;
}
.az-results-summary strong { color: var(--success-fg); }

.az-table { width: 100%; border-collapse: collapse; font-size: var(--font-xs); }
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
.az-td-model { font-family: var(--font-mono); font-size: var(--font-2xs); color: var(--text-bright); max-width: 220px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.az-td-task { text-align: center; white-space: nowrap; }
.az-td-score { text-align: center; color: var(--text-secondary); }
.az-td-verdict { text-align: center; }
.az-elapsed { font-size: var(--font-3xs); color: var(--text-secondary); margin-left: 3px; }
.az-na { color: var(--text-disabled); }
.az-row-fail td { color: var(--text-disabled); }
.az-row-fail .az-td-model { color: var(--text-muted); }
.az-badge-pass {
  background: color-mix(in srgb, var(--success-fg) 15%, transparent);
  color: var(--success-fg);
  border: 1px solid color-mix(in srgb, var(--success-fg) 30%, transparent);
  padding: 2px 8px;
  border-radius: var(--radius-md);
  font-size: var(--font-2xs);
  font-weight: 600;
}
.az-badge-fail {
  background: color-mix(in srgb, var(--danger-fg) 10%, transparent);
  color: var(--text-muted);
  border: 1px solid var(--border-muted);
  padding: 2px 8px;
  border-radius: var(--radius-md);
  font-size: var(--font-2xs);
}

/* ── Convergence layer ──────────────────────────────────────────────────────
   Appended last on purpose: these rules carry the same specificity as the
   individual declarations above, so source order decides the tie in their
   favour. Only colour / type / border are unified here — every rule above
   keeps its own margins, padding and layout. */

/* Helper text under a control: one spec, many legacy names. */
.ap-hint,
.az-hint,
.az-hint-inline,
.az-gguf-hint,
.az-section-note,
.cli-agent-hint,
.help-topic,
.hint-msg,
.mcp-catalog-desc,
.mcp-catalog-hint,
.mcp-catalog-note,
.upd-notes {
  color: var(--text-secondary);
  font-size: var(--font-xs);
  line-height: var(--lh-base);
}

/* Native form controls inside the settings body get the house skin. Scoped to
   .s-body so the sidebar search field and anything outside the tab bodies is
   untouched; more specific existing rules still win on width/padding. */
.s-body input[type='text'],
.s-body input[type='number'],
.s-body input[type='password'],
.s-body input[type='search'],
.s-body select {
  border: 1px solid var(--border-default);
  border-radius: var(--radius-sm);
  background: var(--bg-base);
  color: var(--text-primary);
  font-family: var(--font-ui);
  font-size: var(--font-sm);
  line-height: var(--lh-base);
  padding: 5px 8px;
  transition: border-color var(--motion-fast) var(--ease-out);
}
.s-body input[type='text']:hover:not(:disabled),
.s-body input[type='number']:hover:not(:disabled),
.s-body input[type='password']:hover:not(:disabled),
.s-body input[type='search']:hover:not(:disabled),
.s-body select:hover:not(:disabled) {
  border-color: var(--border-strong);
}
.s-body input[type='text']:focus,
.s-body input[type='number']:focus,
.s-body input[type='password']:focus,
.s-body input[type='search']:focus,
.s-body select:focus {
  outline: none;
  border-color: var(--accent-focus);
}
.s-body input[type='text']:disabled,
.s-body input[type='number']:disabled,
.s-body input[type='password']:disabled,
.s-body input[type='search']:disabled,
.s-body select:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}
.s-body select {
  cursor: pointer;
}
</style>
