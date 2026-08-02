<script setup lang="ts">
// GitWindowApp — the standalone Git client surface, "Editorial Calm" design.
//
// Runs inside the isolated `navide.git` plugin WebContentsView (see
// src/renderer/plugins/git/). It reuses the existing `useGit` composable
// unchanged; the plugin build aliases its `useBackend` to the capability shim,
// so every git.* call is brokered over the host's shared WebSocket.
//
// Layout: a calm, borderless reading surface. Toolbar (wordmark → repo crumb →
// ghost sync actions + one primary). Minimal sidebar (view nav → branches →
// collapsed drawers for stashes/worktrees/remotes/tags), with row management
// tucked into "⋯" popover menus. Center: the signature interaction — one file
// card where the checkbox IS the stage state (check to stage, uncheck to
// unstage) — plus a floating commit composer card. Bottom: shared DiffPane
// detail. History (GitHistoryModal) and branch comparison (BranchDiffPane)
// keep their own views. "Open in editor" routes through the `ui.open_in_editor`
// host capability to the mini-IDE (OS default app when not installed); the
// worktree/remote shell actions ride the other ui.* host capabilities. All
// colors map to semantic tokens so the five app themes translate the design.

import { ref, computed, onMounted, onUnmounted } from 'vue'
import { useBackend } from './composables/useBackend'
import { useGit, type GitFileEntry, type GitWorktree } from './composables/useGit'
import { useNotify } from './composables/useNotify'
import { useTheme } from './composables/useTheme'
import { initSettingsBackend, settingsGet, onSettingsChanged } from './lib/settings'
import GitHistoryModal from './components/GitHistoryModal.vue'
import GitCredentialModal from './components/GitCredentialModal.vue'
import NotificationHost from './components/NotificationHost.vue'
import DiffPane from './editor/DiffPane.vue'
import BranchDiffPane from './editor/BranchDiffPane.vue'

// The host sets ?workspace_path= when it loads this entry (frontendPluginManager
// gitQuery). A getter is what useGit expects.
const workspacePath = new URLSearchParams(window.location.search).get('workspace_path') ?? ''

const backend = useBackend()
// Hook the settings cache to the brokered ui.settings surface so theme changes
// made in other windows arrive live (ui.settings_changed is ui-gated and the
// manifest requires `ui`), and analyzerModel reconciles for AI commit messages.
initSettingsBackend(backend)
const { loadTheme } = useTheme()
const notify = useNotify()
const git = useGit(() => workspacePath, backend)

const {
  gitStatus,
  gitLog,
  gitBranches,
  gitStashes,
  gitRemotes,
  gitTags,
  logScope,
  logOrder,
  isLoadingStatus,
  isLoadingLog,
  canLoadMoreLog,
  isFetching,
  isSyncing,
  gitError,
  loadStatus,
  loadLog,
  loadBranches,
  loadStashes,
  loadRemotes,
  loadTags,
  setLogScope,
  setLogOrder,
  loadMoreLog,
  logSearch,
  showCommit,
  commitFileDiff,
  fetchRemote,
  pullOnly,
  pushOnly,
  sync,
  cherryPick,
  revertCommit,
  checkoutCommit,
  createBranch,
  createTag,
  mergeBranch,
  resetToCommit,
  // working tree + commit (the checkbox-stage surface)
  stageFile,
  unstageFile,
  stageAll,
  unstageFiles,
  discardFile,
  resolveConflictOurs,
  resolveConflictTheirs,
  abortOperation,
  commit,
  amendCommit,
  generateMessage,
  isCommitting,
  isGenerating,
  // branches / stash / remotes / tags
  rebaseOn,
  switchBranch,
  deleteBranch,
  checkoutRemoteBranch,
  stashPush,
  stashPop,
  stashApply,
  stashDrop,
  addRemote,
  removeRemote,
  deleteTag,
  // worktrees / config
  gitWorktrees,
  loadWorktrees,
  addWorktree,
  removeWorktree,
  pruneWorktrees,
  lockWorktree,
  unlockWorktree,
  moveWorktree,
  repairWorktrees,
  gitConfig,
  gitConfigAllowedKeys,
  loadGitConfig,
  setGitConfig,
  // askpass credential prompt
  credentialPrompt,
  showCredentialPrompt,
  submitCredential,
  cancelCredential
} = git

// ── View state ───────────────────────────────────────────────────────────────
type CenterView = 'history' | 'status' | 'branchdiff'
const view = ref<CenterView>('status')

// ── Diff detail target ───────────────────────────────────────────────────────
// Shown in the bottom detail panel of the Changes view. Fed by (a) file-row
// clicks in the center card, and (b) the main process forwarding a git_diff_*
// target (see window:openGit) when a file is clicked in the main window's
// GitPane. The shared DiffPane fetches the diff itself from these coordinates.
interface ExternalDiff {
  name: string
  staged: boolean
  commit: string
}
const externalDiff = ref<ExternalDiff | null>(null)

// Local busy flags for actions useGit doesn't expose a dedicated ref for.
const isPulling = ref(false)
const isPushing = ref(false)

const localBranches = computed(() => gitBranches.value.filter((b) => !b.is_remote))
const remoteBranches = computed(() => gitBranches.value.filter((b) => b.is_remote))

const hasWorkspace = computed(() => workspacePath.length > 0)
const isRepo = computed(() => gitStatus.value.is_git_repo)
const repoName = computed(() => workspacePath.split('/').filter(Boolean).at(-1) ?? '')

const changeCount = computed(() => {
  const s = gitStatus.value
  return s.staged.length + s.unstaged.length + s.untracked.length
})

// ── Loading ──────────────────────────────────────────────────────────────────
async function refreshAll(): Promise<void> {
  await loadStatus()
  if (!isRepo.value) return
  await Promise.all([
    loadLog(),
    loadBranches(),
    loadRemotes(),
    loadTags(),
    loadStashes(),
    loadWorktrees()
  ])
}

let offThemeSettingsChange: (() => void) | null = null

onMounted(() => {
  if (repoName.value) document.title = `Git · ${repoName.value}`
  loadTheme()
  offThemeSettingsChange = onSettingsChanged((keys) => {
    if (keys.includes('agent-team:theme') || keys.includes('agent-team:theme-custom')) {
      loadTheme()
    }
    if (keys.includes('agentTeam.analyzerModel')) {
      analyzerModel.value = settingsGet('agentTeam.analyzerModel', '')
    }
  })
  if (hasWorkspace.value) void refreshAll()
  // Initial diff target from the entry query, then incremental deliveries.
  showDiffTarget(Object.fromEntries(new URLSearchParams(window.location.search)))
  const nav = (
    window as unknown as {
      nav?: { onOpenTarget?: (cb: (p: Record<string, string>) => void) => () => void }
    }
  ).nav
  nav?.onOpenTarget?.((p) => {
    showDiffTarget(p)
  })
})

onUnmounted(() => {
  offThemeSettingsChange?.()
})

function showDiffTarget(params: Record<string, string>): void {
  const filepath = params['git_diff_filepath'] ?? ''
  if (!filepath) return
  view.value = 'status'
  externalDiff.value = {
    name: filepath,
    staged: params['git_diff_staged'] === 'true',
    commit: params['git_diff_commit'] ?? '',
  }
}

function clearExternalDiff(): void {
  externalDiff.value = null
}

function toastResult(r: { ok: boolean; error?: string }, okMsg?: string): boolean {
  if (!r.ok) notify.toast(r.error || 'Operation failed', { type: 'error' })
  else if (okMsg) notify.toast(okMsg, { type: 'success' })
  return r.ok
}

// ── Popover menus (the "⋯" row menus) ────────────────────────────────────────
interface MenuItem {
  label: string
  danger?: boolean
  action: () => void
}
const menu = ref<{ x: number; y: number; items: MenuItem[] } | null>(null)

function openMenu(e: MouseEvent, items: MenuItem[]): void {
  const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
  menu.value = {
    x: Math.min(r.left, window.innerWidth - 208),
    y: Math.min(r.bottom + 4, window.innerHeight - items.length * 30 - 16),
    items
  }
}
function runMenuItem(item: MenuItem): void {
  menu.value = null
  item.action()
}

// ── Host capabilities (mini-IDE / shell hand-offs) ───────────────────────────
const analyzerModel = ref(settingsGet('agentTeam.analyzerModel', ''))

/** Route a file to the mini-IDE through the `ui.open_in_editor` host
 *  capability; the main process falls back to the OS default application when
 *  the mini-IDE plugin is not installed/available. */
async function openInEditor(filepath: string): Promise<void> {
  if (!filepath) return
  const resp = await backend.send('ui.open_in_editor', {
    workspace_path: workspacePath,
    filepath
  })
  if (!resp.ok) notify.toast(resp.error?.message || 'Could not open the editor', { type: 'error' })
}
async function openExternal(url: string): Promise<void> {
  if (!url) return
  const resp = await backend.send('ui.open_external', { url })
  if (!resp.ok) notify.toast(resp.error?.message || 'Could not open the URL', { type: 'error' })
}
async function revealPath(path: string): Promise<void> {
  const resp = await backend.send('ui.reveal_path', { path })
  if (!resp.ok) notify.toast(resp.error?.message || 'Could not reveal the path', { type: 'error' })
}
async function pickFolder(defaultPath?: string): Promise<string | null> {
  const resp = await backend.send<{ ok: boolean; path: string | null }>('ui.pick_folder', {
    ...(defaultPath ? { default_path: defaultPath } : {})
  })
  return resp.ok ? (resp.payload?.path ?? null) : null
}
async function onOpenWorktree(path: string): Promise<void> {
  const resp = await backend.send('ui.open_workspace', { workspace_path: path })
  if (!resp.ok) notify.toast(resp.error?.message || 'Could not open the workspace', { type: 'error' })
}

// ── The file card: checkbox IS the stage state ───────────────────────────────
function isConflictEntry(f: GitFileEntry): boolean {
  return f.status === 'U'
}
const conflictFiles = computed(() =>
  [...gitStatus.value.staged, ...gitStatus.value.unstaged].filter(isConflictEntry)
)
const stagedFiles = computed(() => gitStatus.value.staged.filter((f) => !isConflictEntry(f)))
const changedFiles = computed(() => gitStatus.value.unstaged.filter((f) => !isConflictEntry(f)))
const untrackedFiles = computed(() => gitStatus.value.untracked)

const opInProgress = computed(() => gitStatus.value.operation_in_progress)

function fileTag(f: GitFileEntry, untracked = false): { label: string; cls: string } {
  if (untracked) return { label: 'new', cls: 'q' }
  const c = f.status[0]
  if (c === 'A') return { label: 'added', cls: 'a' }
  if (c === 'D') return { label: 'deleted', cls: 'd' }
  if (c === 'R') return { label: 'renamed', cls: 'm' }
  if (c === 'U') return { label: 'conflict', cls: 'u' }
  return { label: 'modified', cls: 'm' }
}
function splitPath(path: string): { dir: string; base: string } {
  const i = path.lastIndexOf('/')
  return i < 0 ? { dir: '', base: path } : { dir: path.slice(0, i + 1), base: path.slice(i + 1) }
}

async function toggleStage(f: GitFileEntry, staged: boolean): Promise<void> {
  if (staged) await unstageFile(f.path)
  else await stageFile(f.path)
}
async function onStageAll(): Promise<void> {
  await stageAll()
}
async function onUnstageAll(): Promise<void> {
  const paths = stagedFiles.value.map((f) => f.path)
  if (!paths.length) return
  toastResult(await unstageFiles(paths))
}
async function onDiscard(f: GitFileEntry): Promise<void> {
  const ok = await notify.confirm(`Discard changes in ${f.path}? This cannot be undone.`, {
    title: 'Discard changes',
    confirmText: 'Discard'
  })
  if (!ok) return
  await discardFile(f.path)
}
async function onResolveOurs(path: string): Promise<void> {
  toastResult(await resolveConflictOurs(path))
}
async function onResolveTheirs(path: string): Promise<void> {
  toastResult(await resolveConflictTheirs(path))
}
async function onAbortOperation(): Promise<void> {
  const op = opInProgress.value
  if (!op) return
  const ok = await notify.confirm(`Abort the in-progress ${op}?`, {
    title: 'Abort',
    confirmText: 'Abort'
  })
  if (!ok) return
  toastResult(await abortOperation(op))
}

/** A file row click shows its working-tree/staged diff in the bottom detail. */
function showWorkingDiff(path: string, staged: boolean): void {
  externalDiff.value = { name: path, staged, commit: '' }
}

// ── Commit composer ──────────────────────────────────────────────────────────
const commitMessage = ref('')
const canCommit = computed(
  () =>
    commitMessage.value.trim().length > 0 &&
    (gitStatus.value.staged.length > 0 || opInProgress.value !== '') &&
    !isCommitting.value
)

async function onCommit(): Promise<void> {
  if (!canCommit.value) return
  const r = await commit(commitMessage.value.trim())
  if (toastResult(r, 'Committed')) {
    commitMessage.value = ''
    await refreshAll()
  }
}
async function onAmend(): Promise<void> {
  const ok = await notify.confirm(
    'Amend the last commit with the staged changes' +
      (commitMessage.value.trim() ? ' and the new message?' : ' (keeping its message)?'),
    { title: 'Amend', confirmText: 'Amend' }
  )
  if (!ok) return
  const r = await amendCommit(commitMessage.value.trim())
  if (toastResult(r, 'Amended')) {
    commitMessage.value = ''
    await refreshAll()
  }
}
async function onGenerateMessage(): Promise<void> {
  const model = analyzerModel.value || 'qwen2:latest'
  const r = await generateMessage(model)
  if (r.ok) commitMessage.value = r.message
  else notify.toast(r.error || 'Message generation failed', { type: 'error' })
}

// ── Sidebar: branches ────────────────────────────────────────────────────────
const addingBranch = ref(false)
const newBranchName = ref('')

async function onSwitchBranch(name: string): Promise<void> {
  if (name === gitStatus.value.branch) return
  toastResult(await switchBranch(name), `Switched to ${name}`)
}
async function doCreateBranch(): Promise<void> {
  const name = newBranchName.value.trim()
  if (!name || /\s|\.\./.test(name) || name.startsWith('-')) return
  if (toastResult(await createBranch(name), `Created ${name}`)) {
    newBranchName.value = ''
    addingBranch.value = false
  }
}
function doCompareBranch(name: string): void {
  diffBase.value = name
  diffCompare.value = gitStatus.value.branch
  view.value = 'branchdiff'
}
function branchMenu(name: string): MenuItem[] {
  return [
    { label: 'Switch to this branch', action: () => void onSwitchBranch(name) },
    { label: 'Compare with current', action: () => doCompareBranch(name) },
    { label: 'Merge into current', action: () => void mergeBranch(name).then((r) => toastResult(r, `Merged ${name}`)) },
    { label: 'Rebase current onto this', action: () => void rebaseOn(name).then((r) => toastResult(r, `Rebased onto ${name}`)) },
    {
      label: 'Delete branch…',
      danger: true,
      action: () =>
        void notify
          .confirm(`Delete branch ${name}?`, { title: 'Delete branch', confirmText: 'Delete' })
          .then(async (ok) => {
            if (ok) toastResult(await deleteBranch(name), `Deleted ${name}`)
          })
    }
  ]
}
function remoteBranchMenu(name: string): MenuItem[] {
  return [{ label: 'Check out locally', action: () => void checkoutRemoteBranch(name).then((r) => toastResult(r)) }]
}

// ── Sidebar: drawers (stashes / worktrees / remotes / tags / remote branches) ─
const stashesOpen = ref(false)
const worktreesOpen = ref(false)
const remotesOpen = ref(false)
const tagsOpen = ref(false)
const remoteBranchesOpen = ref(false)

const newRemoteName = ref('')
const newRemoteUrl = ref('')
const newTagName = ref('')
const newTagMessage = ref('')
const newWtPath = ref('')
const newWtBranch = ref('')

async function onStashPush(): Promise<void> {
  const msg = await notify.prompt('Stash message (optional)', { title: 'Stash changes' })
  if (msg === null) return
  toastResult(await stashPush(msg.trim()), 'Stashed')
}
function stashMenu(index: number): MenuItem[] {
  return [
    { label: 'Apply (keep stash)', action: () => void stashApply(index).then((r) => toastResult(r)) },
    { label: 'Pop (apply and remove)', action: () => void stashPop(index).then((r) => toastResult(r)) },
    {
      label: 'Drop…',
      danger: true,
      action: () =>
        void notify
          .confirm('Drop this stash? Its changes are lost.', { title: 'Drop stash', confirmText: 'Drop' })
          .then(async (ok) => {
            if (ok) toastResult(await stashDrop(index))
          })
    }
  ]
}

async function doAddRemote(): Promise<void> {
  const name = newRemoteName.value.trim()
  const url = newRemoteUrl.value.trim()
  if (!name || !url) return
  if (toastResult(await addRemote(name, url), `Added ${name}`)) {
    newRemoteName.value = ''
    newRemoteUrl.value = ''
  }
}
function remoteMenu(name: string, url: string): MenuItem[] {
  return [
    { label: 'Open URL in browser', action: () => void openExternal(url) },
    {
      label: 'Remove remote…',
      danger: true,
      action: () =>
        void notify
          .confirm(`Remove remote ${name}?`, { title: 'Remove remote', confirmText: 'Remove' })
          .then(async (ok) => {
            if (ok) toastResult(await removeRemote(name))
          })
    }
  ]
}

async function doCreateTag(): Promise<void> {
  const name = newTagName.value.trim()
  if (!name) return
  if (toastResult(await createTag(name, newTagMessage.value.trim()), `Tagged ${name}`)) {
    newTagName.value = ''
    newTagMessage.value = ''
  }
}
function tagMenu(name: string): MenuItem[] {
  return [
    {
      label: 'Delete tag…',
      danger: true,
      action: () =>
        void notify
          .confirm(`Delete tag ${name}?`, { title: 'Delete tag', confirmText: 'Delete' })
          .then(async (ok) => {
            if (ok) toastResult(await deleteTag(name))
          })
    }
  ]
}

async function doAddWorktree(): Promise<void> {
  const path = newWtPath.value.trim()
  const branch = newWtBranch.value.trim()
  if (!path || !branch) return
  const existing = gitBranches.value.some((b) => !b.is_remote && b.name === branch)
  if (toastResult(await addWorktree(path, branch, !existing), 'Worktree added')) {
    newWtPath.value = ''
    newWtBranch.value = ''
  }
  await loadWorktrees()
}
async function pickWorktreeDir(): Promise<void> {
  const picked = await pickFolder(newWtPath.value.trim() || undefined)
  if (picked) newWtPath.value = picked
}
function worktreeMenu(wt: GitWorktree): MenuItem[] {
  const items: MenuItem[] = []
  if (!wt.bare && wt.path !== workspacePath) {
    items.push({ label: 'Open in new window', action: () => void onOpenWorktree(wt.path) })
  }
  if (!wt.bare) items.push({ label: 'Reveal in Finder', action: () => void revealPath(wt.path) })
  if (!wt.is_main) {
    items.push({
      label: wt.locked ? 'Unlock' : 'Lock',
      action: () =>
        void (wt.locked ? unlockWorktree(wt.path) : lockWorktree(wt.path)).then(async (r) => {
          toastResult(r)
          await loadWorktrees()
        })
    })
  }
  if (!wt.is_main && !wt.bare) {
    items.push({
      label: 'Move…',
      action: () =>
        void pickFolder(wt.path).then(async (dest) => {
          if (!dest) return
          toastResult(await moveWorktree(wt.path, dest), 'Worktree moved')
          await loadWorktrees()
        })
    })
  }
  if (!wt.is_main) {
    items.push({
      label: 'Remove…',
      danger: true,
      action: () => void onRemoveWorktree(wt.path)
    })
  }
  return items
}
function worktreesHeaderMenu(): MenuItem[] {
  return [
    { label: 'Prune stale worktrees', action: () => void pruneWorktrees().then(async (r) => { toastResult(r, 'Pruned'); await loadWorktrees() }) },
    { label: 'Repair worktree links', action: () => void repairWorktrees().then(async (r) => { toastResult(r, 'Repaired'); await loadWorktrees() }) }
  ]
}
async function onRemoveWorktree(path: string): Promise<void> {
  const ok = await notify.confirm(`Remove worktree at ${path}?`, {
    title: 'Remove worktree',
    confirmText: 'Remove'
  })
  if (!ok) return
  const r = await removeWorktree(path)
  if (!r.ok) {
    // A dirty/locked worktree fails a plain remove — offer --force.
    const forced = await notify.confirm(`${r.error || 'Remove failed'} — force remove?`, {
      title: 'Remove worktree',
      confirmText: 'Force remove'
    })
    if (forced) toastResult(await removeWorktree(path, true))
  }
  await loadWorktrees()
}

// ── Repository settings modal ────────────────────────────────────────────────
const showConfig = ref(false)
const configDraft = ref<Record<string, string>>({})

async function openConfig(): Promise<void> {
  await loadGitConfig()
  configDraft.value = { ...gitConfig.value }
  showConfig.value = true
}
async function saveConfig(): Promise<void> {
  for (const key of gitConfigAllowedKeys.value) {
    const next = (configDraft.value[key] ?? '').trim()
    if (next !== (gitConfig.value[key] ?? '')) {
      const r = await setGitConfig(key, next)
      if (!r.ok) {
        notify.toast(`${key}: ${r.error || 'failed'}`, { type: 'error' })
        return
      }
    }
  }
  await loadGitConfig()
  showConfig.value = false
  notify.toast('Settings saved', { type: 'success' })
}

// ── Branch diff view ─────────────────────────────────────────────────────────
const diffBase = ref('')
const diffCompare = ref('')

function openBranchDiff(): void {
  view.value = 'branchdiff'
  if (!diffCompare.value) diffCompare.value = gitStatus.value.branch
  if (!diffBase.value) {
    const names = localBranches.value.map((b) => b.name)
    diffBase.value =
      names.find((n) => n === 'main' || n === 'master') ??
      names.find((n) => n !== diffCompare.value) ??
      ''
  }
}

// ── Toolbar actions ──────────────────────────────────────────────────────────
async function onFetch(): Promise<void> {
  await fetchRemote()
  await refreshAll()
}
async function onPull(): Promise<void> {
  isPulling.value = true
  try {
    await pullOnly()
    await refreshAll()
  } finally {
    isPulling.value = false
  }
}
async function onPush(): Promise<void> {
  isPushing.value = true
  try {
    await pushOnly()
    await refreshAll()
  } finally {
    isPushing.value = false
  }
}
async function onSync(): Promise<void> {
  await sync()
  await refreshAll()
}

const busy = computed(
  () =>
    isFetching.value ||
    isSyncing.value ||
    isPulling.value ||
    isPushing.value ||
    isLoadingStatus.value ||
    isLoadingLog.value
)
</script>

<template>
  <div class="git-window">
    <!-- ── Toolbar ────────────────────────────────────────────────────── -->
    <header class="toolbar">
      <span class="wm">Navide Git</span>
      <span class="crumb">
        {{ repoName }}<template v-if="gitStatus.branch">
          <span class="crumb-sep">／</span><b class="mono">{{ gitStatus.branch }}</b>
          <span v-if="gitStatus.ahead" class="crumb-cnt">↑{{ gitStatus.ahead }}</span>
          <span v-if="gitStatus.behind" class="crumb-cnt">↓{{ gitStatus.behind }}</span>
        </template>
      </span>
      <span v-if="busy" class="busy-dot" title="Working…" />
      <div class="tb-actions">
        <button class="gbtn" :disabled="busy || !isRepo" @click="onFetch">Fetch</button>
        <button class="gbtn" :disabled="busy || !isRepo" @click="onPull">Pull</button>
        <button class="gbtn" :disabled="busy || !isRepo" @click="onPush">Push</button>
        <button class="pbtn" :disabled="busy || !isRepo" title="Pull then push" @click="onSync">Sync</button>
        <button class="gbtn icon" :disabled="!isRepo" title="Repository settings" @click="openConfig">⚙</button>
      </div>
    </header>

    <div v-if="gitError" class="err-bar">{{ gitError }}</div>

    <div v-if="!hasWorkspace" class="empty">No workspace path provided.</div>
    <div v-else-if="!isRepo && !isLoadingStatus" class="empty">Not a Git repository.</div>

    <div v-else class="body">
      <!-- ── Sidebar ──────────────────────────────────────────────────── -->
      <aside class="sidebar">
        <nav class="navi">
          <button :class="{ on: view === 'status' }" @click="view = 'status'">
            Changes<span v-if="changeCount" class="n">{{ changeCount }}</span>
          </button>
          <button :class="{ on: view === 'history' }" @click="view = 'history'">History</button>
          <button :class="{ on: view === 'branchdiff' }" @click="openBranchDiff">Branch diff</button>
        </nav>
        <div class="divider" />

        <div class="sec-title">
          Branches
          <button class="tinybtn" title="Create a branch" @click="addingBranch = !addingBranch">＋</button>
        </div>
        <div v-if="addingBranch" class="add-row">
          <input
            v-model="newBranchName"
            class="ed-input"
            placeholder="new-branch-name"
            spellcheck="false"
            @keydown.enter="doCreateBranch"
          />
          <button class="tinybtn" :disabled="!newBranchName.trim()" @click="doCreateBranch">Add</button>
        </div>
        <div
          v-for="b in localBranches"
          :key="b.name"
          class="srow"
          :class="{ cur: b.is_current }"
          :title="b.tracking ? `${b.name} → ${b.tracking}` : b.name"
        >
          <span class="bdot" :class="{ cur: b.is_current }" />
          <span class="sname mono">{{ b.name }}</span>
          <button
            v-if="!b.is_current"
            class="dots"
            title="Branch actions"
            @click.stop="openMenu($event, branchMenu(b.name))"
          >⋯</button>
        </div>
        <div v-if="!localBranches.length" class="empty-msg">No branches yet</div>

        <div class="sec-title" style="margin-top: 14px">Collections</div>
        <button class="srow drawer" @click="stashesOpen = !stashesOpen">
          <span class="sname">Stashes</span>
          <span class="count">{{ gitStashes.length || '' }}</span>
          <span class="chev">{{ stashesOpen ? '▾' : '▸' }}</span>
        </button>
        <template v-if="stashesOpen">
          <div class="sub-add"><button class="linkbtn" @click="onStashPush">＋ Stash working changes</button></div>
          <div v-for="s in gitStashes" :key="s.ref" class="srow sub" :title="s.message">
            <span class="sname mono dim">{{ s.ref }}</span>
            <span class="sname">{{ s.message }}</span>
            <button class="dots" title="Stash actions" @click.stop="openMenu($event, stashMenu(s.index))">⋯</button>
          </div>
          <div v-if="!gitStashes.length" class="empty-msg sub">Nothing stashed</div>
        </template>

        <button class="srow drawer" @click="worktreesOpen = !worktreesOpen">
          <span class="sname">Worktrees</span>
          <span class="count">{{ gitWorktrees.length > 1 ? gitWorktrees.length : '' }}</span>
          <span class="chev">{{ worktreesOpen ? '▾' : '▸' }}</span>
        </button>
        <template v-if="worktreesOpen">
          <div class="sub-add">
            <button class="linkbtn" @click.stop="openMenu($event, worktreesHeaderMenu())">Maintenance ⋯</button>
          </div>
          <div v-for="wt in gitWorktrees" :key="wt.path" class="srow sub" :title="wt.path">
            <span class="sname mono">{{ wt.path.split('/').at(-1) }}</span>
            <span v-if="wt.is_main" class="minitag">main</span>
            <span v-if="wt.locked" class="minitag warn" :title="wt.lock_reason">locked</span>
            <span v-if="wt.prunable" class="minitag warn" :title="wt.prune_reason">stale</span>
            <button class="dots" title="Worktree actions" @click.stop="openMenu($event, worktreeMenu(wt))">⋯</button>
          </div>
          <div class="sub-add wt-add">
            <input v-model="newWtPath" class="ed-input" placeholder="/absolute/path" spellcheck="false" />
            <button class="tinybtn" title="Browse for a folder" @click="pickWorktreeDir">…</button>
            <input v-model="newWtBranch" class="ed-input short" placeholder="branch" spellcheck="false" />
            <button class="tinybtn" :disabled="!newWtPath.trim() || !newWtBranch.trim()" @click="doAddWorktree">Add</button>
          </div>
        </template>

        <button class="srow drawer" @click="remotesOpen = !remotesOpen">
          <span class="sname">Remotes</span>
          <span class="count">{{ gitRemotes.length || '' }}</span>
          <span class="chev">{{ remotesOpen ? '▾' : '▸' }}</span>
        </button>
        <template v-if="remotesOpen">
          <div v-for="r in gitRemotes" :key="r.name" class="srow sub" :title="r.fetch_url">
            <span class="sname mono">{{ r.name }}</span>
            <span class="sname dim">{{ r.fetch_url }}</span>
            <button class="dots" title="Remote actions" @click.stop="openMenu($event, remoteMenu(r.name, r.fetch_url))">⋯</button>
          </div>
          <div v-if="!gitRemotes.length" class="empty-msg sub">No remotes</div>
          <div class="sub-add wt-add">
            <input v-model="newRemoteName" class="ed-input short" placeholder="name" spellcheck="false" />
            <input v-model="newRemoteUrl" class="ed-input" placeholder="url" spellcheck="false" @keydown.enter="doAddRemote" />
            <button class="tinybtn" :disabled="!newRemoteName.trim() || !newRemoteUrl.trim()" @click="doAddRemote">Add</button>
          </div>
        </template>

        <button class="srow drawer" @click="tagsOpen = !tagsOpen">
          <span class="sname">Tags</span>
          <span class="count">{{ gitTags.length || '' }}</span>
          <span class="chev">{{ tagsOpen ? '▾' : '▸' }}</span>
        </button>
        <template v-if="tagsOpen">
          <div v-for="t in gitTags" :key="t.name" class="srow sub" :title="t.message">
            <span class="sname mono">{{ t.name }}</span>
            <span class="sname dim mono">{{ t.commit_hash.slice(0, 7) }}</span>
            <button class="dots" title="Tag actions" @click.stop="openMenu($event, tagMenu(t.name))">⋯</button>
          </div>
          <div v-if="!gitTags.length" class="empty-msg sub">No tags</div>
          <div class="sub-add wt-add">
            <input v-model="newTagName" class="ed-input short" placeholder="v1.0.0" spellcheck="false" />
            <input v-model="newTagMessage" class="ed-input" placeholder="message" @keydown.enter="doCreateTag" />
            <button class="tinybtn" :disabled="!newTagName.trim()" @click="doCreateTag">Add</button>
          </div>
        </template>

        <button class="srow drawer" @click="remoteBranchesOpen = !remoteBranchesOpen">
          <span class="sname">Remote branches</span>
          <span class="count">{{ remoteBranches.length || '' }}</span>
          <span class="chev">{{ remoteBranchesOpen ? '▾' : '▸' }}</span>
        </button>
        <template v-if="remoteBranchesOpen">
          <div v-for="b in remoteBranches" :key="b.name" class="srow sub" :title="b.name">
            <span class="sname mono dim">{{ b.name }}</span>
            <span v-if="b.has_local" class="minitag">local ✓</span>
            <button
              v-else
              class="dots"
              title="Remote branch actions"
              @click.stop="openMenu($event, remoteBranchMenu(b.name))"
            >⋯</button>
          </div>
          <div v-if="!remoteBranches.length" class="empty-msg sub">No remote branches</div>
        </template>
      </aside>

      <!-- ── Center ───────────────────────────────────────────────────── -->
      <section class="center">
        <!-- History -->
        <div v-if="view === 'history'" class="pane history-full">
          <GitHistoryModal
            show
            inline
            :backend="backend"
            :workspace-path="workspacePath"
            :git-log="gitLog"
            :log-scope="logScope"
            :log-order="logOrder"
            :is-loading-log="isLoadingLog"
            :can-load-more-log="canLoadMoreLog"
            :set-log-scope="setLogScope"
            :set-log-order="setLogOrder"
            :load-more-log="loadMoreLog"
            :log-search="logSearch"
            :show-commit="showCommit"
            :commit-file-diff="commitFileDiff"
            :cherry-pick="cherryPick"
            :revert-commit="revertCommit"
            :checkout-commit="checkoutCommit"
            :create-branch="createBranch"
            :create-tag="createTag"
            :merge-into-current="mergeBranch"
            :reset-to-commit="resetToCommit"
          />
        </div>

        <!-- Branch comparison -->
        <div v-else-if="view === 'branchdiff'" class="pane branchdiff">
          <div class="bd-pickers">
            <select v-model="diffBase" class="ed-select" title="Base branch">
              <option value="" disabled>base…</option>
              <option v-for="b in gitBranches" :key="'b' + b.name" :value="b.name">{{ b.name }}</option>
            </select>
            <span class="bd-arrow">→</span>
            <select v-model="diffCompare" class="ed-select" title="Compare branch">
              <option value="" disabled>compare…</option>
              <option v-for="b in gitBranches" :key="'c' + b.name" :value="b.name">{{ b.name }}</option>
            </select>
          </div>
          <div class="bd-body">
            <BranchDiffPane
              v-if="diffBase && diffCompare"
              :key="diffBase + '…' + diffCompare"
              :workspace-path="workspacePath"
              :base="diffBase"
              :compare="diffCompare"
              :backend="backend"
              hide-ai-review
            />
            <div v-else class="empty-hint">Pick two branches to compare.</div>
          </div>
        </div>

        <!-- Changes: the checkbox-stage file card + commit composer -->
        <div v-else class="status-wrap">
          <div class="pane changes">
            <div v-if="opInProgress" class="op-banner">
              <span>{{ opInProgress }} in progress<template v-if="conflictFiles.length"> — {{ conflictFiles.length }} conflicted file{{ conflictFiles.length > 1 ? 's' : '' }}</template></span>
              <button class="linkbtn danger" @click="onAbortOperation">Abort {{ opInProgress }}</button>
            </div>

            <div class="list-hdr">
              <div>
                <div class="gtitle">{{ changeCount }} file{{ changeCount === 1 ? '' : 's' }} changed</div>
                <div class="gsub">Check to stage · click a file for its diff</div>
              </div>
              <div class="hdr-actions">
                <button v-if="stagedFiles.length" class="linkbtn" @click="onUnstageAll">Unstage all</button>
                <button v-if="changedFiles.length + untrackedFiles.length" class="linkbtn" @click="onStageAll">Stage all</button>
              </div>
            </div>

            <div v-if="!changeCount && !conflictFiles.length" class="clean-hint">
              Working tree clean — nothing to commit.
            </div>
            <div v-else class="fcard">
              <div v-for="f in conflictFiles" :key="'c' + f.path" class="frow conflict" @click="showWorkingDiff(f.path, false)">
                <span class="conflict-mark">⚠</span>
                <span class="stag u">conflict</span>
                <span class="fpath mono"><i>{{ splitPath(f.path).dir }}</i>{{ splitPath(f.path).base }}</span>
                <span class="rowact">
                  <button class="linkbtn" @click.stop="onResolveOurs(f.path)">ours</button>
                  <button class="linkbtn" @click.stop="onResolveTheirs(f.path)">theirs</button>
                  <button class="linkbtn" @click.stop="openInEditor(f.path)">editor</button>
                </span>
              </div>
              <div v-for="f in stagedFiles" :key="'s' + f.path" class="frow" @click="showWorkingDiff(f.path, true)">
                <button class="chk on" title="Unstage" @click.stop="toggleStage(f, true)" />
                <span class="stag" :class="fileTag(f).cls">{{ fileTag(f).label }}</span>
                <span class="fpath mono"><i>{{ splitPath(f.path).dir }}</i>{{ splitPath(f.path).base }}</span>
                <span class="rowact"><button class="linkbtn" @click.stop="showWorkingDiff(f.path, true)">diff</button></span>
              </div>
              <div v-for="f in changedFiles" :key="'u' + f.path" class="frow" @click="showWorkingDiff(f.path, false)">
                <button class="chk" title="Stage" @click.stop="toggleStage(f, false)" />
                <span class="stag" :class="fileTag(f).cls">{{ fileTag(f).label }}</span>
                <span class="fpath mono"><i>{{ splitPath(f.path).dir }}</i>{{ splitPath(f.path).base }}</span>
                <span class="rowact">
                  <button class="linkbtn" @click.stop="showWorkingDiff(f.path, false)">diff</button>
                  <button class="linkbtn danger" @click.stop="onDiscard(f)">discard</button>
                </span>
              </div>
              <div v-for="f in untrackedFiles" :key="'n' + f.path" class="frow" @click="showWorkingDiff(f.path, false)">
                <button class="chk" title="Stage" @click.stop="toggleStage(f, false)" />
                <span class="stag q">new</span>
                <span class="fpath mono"><i>{{ splitPath(f.path).dir }}</i>{{ splitPath(f.path).base }}</span>
                <span class="rowact"><button class="linkbtn" @click.stop="showWorkingDiff(f.path, false)">diff</button></span>
              </div>
            </div>

            <div class="composer">
              <textarea
                v-model="commitMessage"
                class="cmp-input"
                rows="2"
                placeholder="Describe this change…"
                :disabled="isCommitting"
              />
              <div class="cmp-actions">
                <button class="chipbtn" :disabled="isGenerating || busy" @click="onGenerateMessage">
                  {{ isGenerating ? 'Generating…' : '✨ AI message' }}
                </button>
                <button class="chipbtn" :disabled="isCommitting" @click="onAmend">Amend</button>
                <button class="commitbtn" :disabled="!canCommit" @click="onCommit">
                  {{ isCommitting ? 'Committing…' : `Commit ${gitStatus.staged.length} file${gitStatus.staged.length === 1 ? '' : 's'}` }}
                </button>
              </div>
            </div>
          </div>

          <!-- Bottom: per-file diff detail -->
          <div v-if="externalDiff" class="detail">
            <div class="detail-hdr">
              <span class="dt-name mono">{{ externalDiff.name }}</span>
              <span class="dt-kind">
                {{
                  externalDiff.commit
                    ? 'commit ' + externalDiff.commit.slice(0, 8)
                    : externalDiff.staged
                      ? 'staged'
                      : 'working tree'
                }}
              </span>
              <span class="spacer" />
              <button class="linkbtn" @click="openInEditor(externalDiff.name)">Open in editor</button>
              <button class="linkbtn" @click="clearExternalDiff">Close</button>
            </div>
            <div class="detail-body">
              <DiffPane
                :key="'ext:' + externalDiff.name + ':' + externalDiff.commit + ':' + externalDiff.staged"
                :workspace-path="workspacePath"
                :filepath="externalDiff.name"
                :staged="externalDiff.staged"
                :name="externalDiff.name"
                :backend="backend"
                :commit="externalDiff.commit || undefined"
                @open-file="(p) => openInEditor(p.filepath)"
              />
            </div>
          </div>
        </div>
      </section>
    </div>

    <!-- ⋯ popover menu -->
    <template v-if="menu">
      <div class="menu-backdrop" @click="menu = null" />
      <div class="menu" :style="{ left: menu.x + 'px', top: menu.y + 'px' }">
        <button
          v-for="(item, i) in menu.items"
          :key="i"
          class="menu-item"
          :class="{ danger: item.danger }"
          @click="runMenuItem(item)"
        >{{ item.label }}</button>
      </div>
    </template>

    <!-- Repository settings (allow-listed git config keys) -->
    <template v-if="showConfig">
      <div class="cfg-backdrop" @click="showConfig = false" />
      <div class="cfg-modal" @keydown.esc="showConfig = false">
        <div class="cfg-title">Repository settings</div>
        <div v-if="!gitConfigAllowedKeys.length" class="cfg-empty">No editable keys.</div>
        <div v-for="key in gitConfigAllowedKeys" :key="key" class="cfg-row">
          <label class="cfg-key mono">{{ key }}</label>
          <input v-model="configDraft[key]" class="ed-input" type="text" spellcheck="false" />
        </div>
        <div class="cfg-actions">
          <button class="chipbtn" @click="showConfig = false">Cancel</button>
          <button class="commitbtn" @click="saveConfig">Save</button>
        </div>
      </div>
    </template>

    <!-- Askpass credential prompt for a push/pull/fetch waiting on this window
         (git.credential_request forwarded by the host broker). -->
    <GitCredentialModal
      :show="showCredentialPrompt"
      :prompt="credentialPrompt"
      :workspace-path="workspacePath"
      @submit="submitCredential"
      @cancel="cancelCredential"
    />
    <NotificationHost />
  </div>
</template>

<style scoped>
/* Editorial Calm — generous spacing, hairline borders, soft cards. All colors
 * come from semantic tokens so every app theme translates the design; the
 * light theme reproduces the approved mockup. */
.git-window {
  height: 100vh;
  display: flex;
  flex-direction: column;
  background: var(--bg-base);
  color: var(--text-primary);
  font: 13px/1.55 -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
  overflow: hidden;
}
.mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
.spacer { flex: 1; }

/* ── Toolbar ── */
.toolbar {
  display: flex;
  align-items: center;
  gap: 14px;
  height: 54px;
  padding: 0 18px 0 84px; /* clear the hidden-titlebar traffic lights */
  background: var(--bg-subtle);
  border-bottom: 1px solid var(--border-muted);
  -webkit-app-region: drag;
  flex-shrink: 0;
}
.wm {
  font-weight: 800;
  font-size: 13.5px;
  letter-spacing: 0.02em;
  color: var(--text-bright);
  -webkit-app-region: no-drag;
}
.crumb {
  color: var(--text-secondary);
  font-size: 12.5px;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.crumb b { color: var(--text-bright); font-weight: 650; }
.crumb-sep { margin: 0 4px; color: var(--text-muted); }
.crumb-cnt { margin-left: 6px; color: var(--accent-fg); font-size: 12px; }
.busy-dot {
  width: 8px; height: 8px; border-radius: 50%;
  background: var(--attention-fg);
  animation: busy-pulse 1.2s ease-in-out infinite;
}
@keyframes busy-pulse { 50% { opacity: 0.25; } }
@media (prefers-reduced-motion: reduce) { .busy-dot { animation: none; } }
.tb-actions {
  margin-left: auto;
  display: flex;
  gap: 6px;
  align-items: center;
  -webkit-app-region: no-drag;
}
.gbtn {
  border: none;
  background: none;
  color: var(--text-secondary);
  font-size: 12.5px;
  padding: 7px 11px;
  border-radius: 8px;
  cursor: pointer;
}
.gbtn:hover:not(:disabled) { background: var(--bg-hover); color: var(--text-primary); }
.gbtn:disabled { opacity: 0.4; cursor: default; }
.gbtn.icon { padding: 7px 9px; }
.pbtn {
  border: none;
  background: var(--accent-emphasis);
  color: var(--text-on-emphasis);
  font-size: 12.5px;
  font-weight: 700;
  padding: 8px 16px;
  border-radius: 10px;
  cursor: pointer;
}
.pbtn:hover:not(:disabled) { filter: brightness(1.08); }
.pbtn:disabled { opacity: 0.45; cursor: default; }

.err-bar {
  padding: 6px 18px;
  background: var(--danger-subtle);
  color: var(--danger-bright);
  font-size: 12px;
}
.empty {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-secondary);
}

/* ── Body ── */
.body { flex: 1; display: flex; min-height: 0; }

/* ── Sidebar ── */
.sidebar {
  width: 256px;
  flex-shrink: 0;
  background: var(--bg-subtle);
  border-right: 1px solid var(--border-muted);
  overflow-y: auto;
  padding: 14px 0 20px;
}
.navi { display: flex; flex-direction: column; gap: 2px; padding: 0 12px 12px; }
.navi button {
  display: flex;
  align-items: center;
  text-align: left;
  border: none;
  background: none;
  padding: 7px 12px;
  border-radius: 9px;
  color: var(--text-secondary);
  font-size: 13px;
  cursor: pointer;
}
.navi button:hover { background: var(--bg-hover-faint); }
.navi .on { background: var(--bg-selected); color: var(--accent-bright); font-weight: 700; }
.navi .n { margin-left: auto; font-size: 11.5px; color: var(--text-muted); }
.divider { height: 1px; background: var(--border-muted); margin: 4px 12px 12px; }

.sec-title {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 24px;
  font-size: 10.5px;
  font-weight: 800;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: var(--text-muted);
}
.tinybtn {
  margin-left: auto;
  border: none;
  background: none;
  color: var(--text-muted);
  font-size: 12px;
  cursor: pointer;
  padding: 0 4px;
  border-radius: 5px;
  letter-spacing: 0;
}
.tinybtn:hover:not(:disabled) { color: var(--text-bright); background: var(--bg-hover); }
.tinybtn:disabled { opacity: 0.4; cursor: default; }

.srow {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 4.5px 24px;
  border: none;
  background: none;
  text-align: left;
  font-size: 12.5px;
  color: var(--text-primary);
  cursor: default;
}
.srow:hover { background: var(--bg-hover-faint); }
.srow.drawer { cursor: pointer; color: var(--text-secondary); margin-top: 1px; }
.srow.sub { padding-left: 34px; }
.bdot { width: 7px; height: 7px; border-radius: 50%; background: var(--border-strong); flex: none; }
.bdot.cur { background: var(--accent-bright); }
.srow.cur .sname { color: var(--accent-bright); font-weight: 700; }
.sname { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
.sname.dim { color: var(--text-muted); flex-shrink: 1; }
.count { margin-left: auto; font-size: 11.5px; color: var(--text-muted); flex: none; }
.chev { font-size: 9px; color: var(--text-muted); flex: none; width: 10px; }
.dots {
  margin-left: auto;
  border: none;
  background: none;
  color: var(--text-muted);
  font-size: 13px;
  padding: 0 4px;
  border-radius: 5px;
  cursor: pointer;
  visibility: hidden;
  flex: none;
}
.srow:hover .dots { visibility: visible; }
.dots:hover { color: var(--text-bright); background: var(--bg-hover); }
.minitag {
  font-size: 9.5px;
  color: var(--text-secondary);
  background: var(--bg-active);
  border-radius: 7px;
  padding: 0 6px;
  flex: none;
}
.minitag.warn { color: var(--danger-fg); }
.empty-msg { padding: 3px 24px 6px; color: var(--text-muted); font-size: 11.5px; font-style: italic; }
.empty-msg.sub { padding-left: 34px; }

.add-row, .sub-add { display: flex; gap: 5px; align-items: center; padding: 4px 24px 6px; }
.sub-add { padding-left: 34px; }
.sub-add.wt-add { flex-wrap: wrap; }
.ed-input {
  flex: 1;
  min-width: 60px;
  background: var(--bg-base);
  border: 1px solid var(--border-default);
  border-radius: 7px;
  color: var(--text-primary);
  font-size: 11.5px;
  padding: 4px 8px;
}
.ed-input.short { flex: 0 1 76px; }
.ed-input:focus { outline: none; border-color: var(--accent-focus); }
.linkbtn {
  border: none;
  background: none;
  color: var(--accent-fg);
  font-size: 12px;
  cursor: pointer;
  padding: 2px 4px;
  border-radius: 5px;
}
.linkbtn:hover { background: var(--bg-hover-faint); }
.linkbtn.danger { color: var(--danger-fg); }

/* ── Center ── */
.center { flex: 1; display: flex; flex-direction: column; min-width: 0; }
.pane { flex: 1; overflow: auto; min-height: 0; }
.pane.history-full { overflow: hidden; }
.status-wrap { flex: 1; display: flex; flex-direction: column; min-height: 0; }
.pane.changes { display: flex; flex-direction: column; padding: 20px 26px 18px; overflow-y: auto; }

.op-banner {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 8px 14px;
  border-radius: 10px;
  background: color-mix(in srgb, var(--attention-fg) 12%, transparent);
  color: var(--attention-fg);
  font-size: 12.5px;
  margin-bottom: 14px;
}
.op-banner .linkbtn { margin-left: auto; }

.list-hdr { display: flex; align-items: flex-end; gap: 12px; margin-bottom: 12px; }
.gtitle { font-size: 15px; font-weight: 800; color: var(--text-bright); }
.gsub { font-size: 12px; color: var(--text-muted); margin-top: 1px; }
.hdr-actions { margin-left: auto; display: flex; gap: 10px; }
.clean-hint, .empty-hint { color: var(--text-muted); font-size: 13px; padding: 26px 4px; }

.fcard {
  background: var(--bg-subtle);
  border: 1px solid var(--border-muted);
  border-radius: 14px;
  overflow: hidden;
}
.frow {
  display: flex;
  align-items: center;
  gap: 11px;
  padding: 8.5px 16px;
  border-bottom: 1px solid var(--border-muted);
  font-size: 13px;
  cursor: pointer;
}
.frow:last-child { border-bottom: none; }
.frow:hover { background: var(--bg-hover-faint); }
.frow.conflict { background: color-mix(in srgb, var(--danger-fg) 7%, transparent); }
.conflict-mark { color: var(--danger-fg); flex: none; width: 15px; text-align: center; }
.chk {
  width: 15px;
  height: 15px;
  border-radius: 5px;
  border: 1.5px solid var(--border-strong);
  background: none;
  cursor: pointer;
  flex: none;
  padding: 0;
  position: relative;
}
.chk:hover { border-color: var(--accent-focus); }
.chk.on { background: var(--accent-emphasis); border-color: var(--accent-emphasis); }
.chk.on::after {
  content: '✓';
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-on-emphasis);
  font-size: 10px;
  font-weight: 800;
}
.stag {
  font-size: 10.5px;
  font-weight: 800;
  border-radius: 5px;
  padding: 1px 7px;
  flex: none;
}
.stag.m { background: color-mix(in srgb, var(--attention-fg) 14%, transparent); color: var(--attention-fg); }
.stag.a { background: color-mix(in srgb, var(--success-fg) 14%, transparent); color: var(--success-fg); }
.stag.q { background: color-mix(in srgb, var(--accent-fg) 13%, transparent); color: var(--accent-fg); }
.stag.d, .stag.u { background: color-mix(in srgb, var(--danger-fg) 13%, transparent); color: var(--danger-fg); }
.fpath { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text-primary); font-size: 12.5px; }
.fpath i { color: var(--text-muted); font-style: normal; }
.rowact { display: flex; gap: 6px; flex: none; visibility: hidden; }
.frow:hover .rowact, .frow.conflict .rowact { visibility: visible; }

/* ── Commit composer ── */
.composer {
  margin-top: 16px;
  background: var(--bg-subtle);
  border: 1px solid var(--border-muted);
  border-radius: 16px;
  padding: 12px 14px;
  box-shadow: 0 6px 22px var(--shadow-scrim);
  flex-shrink: 0;
}
.cmp-input {
  width: 100%;
  border: none;
  background: none;
  resize: vertical;
  color: var(--text-primary);
  font: 13px/1.5 -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
  padding: 2px 2px 8px;
}
.cmp-input:focus { outline: none; }
.cmp-input::placeholder { color: var(--text-muted); }
.cmp-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  border-top: 1px solid var(--border-muted);
  padding-top: 10px;
}
.chipbtn {
  border: none;
  background: var(--bg-muted);
  border-radius: 8px;
  color: var(--text-secondary);
  font-size: 12px;
  padding: 6px 12px;
  cursor: pointer;
}
.chipbtn:hover:not(:disabled) { color: var(--text-primary); background: var(--bg-hover-strong); }
.chipbtn:disabled { opacity: 0.45; cursor: default; }
.commitbtn {
  margin-left: auto;
  border: none;
  background: var(--success-emphasis);
  color: var(--text-on-emphasis);
  border-radius: 10px;
  padding: 8px 18px;
  font-weight: 700;
  font-size: 12.5px;
  cursor: pointer;
}
.commitbtn:hover:not(:disabled) { background: var(--success-strong); }
.commitbtn:disabled { opacity: 0.45; cursor: default; }

/* ── ⋯ popover menu ── */
.menu-backdrop { position: fixed; inset: 0; z-index: 9998; }
.menu {
  position: fixed;
  z-index: 9999;
  min-width: 188px;
  background: var(--bg-elevated);
  border: 1px solid var(--border-default);
  border-radius: 10px;
  box-shadow: 0 8px 26px var(--shadow-scrim);
  padding: 4px;
  display: flex;
  flex-direction: column;
}
.menu-item {
  border: none;
  background: none;
  text-align: left;
  color: var(--text-primary);
  font-size: 12.5px;
  padding: 6.5px 11px;
  border-radius: 7px;
  cursor: pointer;
}
.menu-item:hover { background: var(--bg-hover); }
.menu-item.danger { color: var(--danger-fg); }

/* ── Branch diff view ── */
.branchdiff { display: flex; flex-direction: column; overflow: hidden; }
.bd-pickers {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 12px 26px;
}
.ed-select {
  background: var(--bg-subtle);
  color: var(--text-primary);
  border: 1px solid var(--border-default);
  border-radius: 8px;
  font-size: 12.5px;
  padding: 5px 8px;
  max-width: 240px;
}
.bd-arrow { color: var(--text-muted); }
.bd-body { flex: 1; min-height: 0; overflow: hidden; display: flex; flex-direction: column; }
.bd-body > * { flex: 1; min-height: 0; }

/* ── Diff detail ── */
.detail {
  height: 44%;
  min-height: 170px;
  border-top: 1px solid var(--border-muted);
  display: flex;
  flex-direction: column;
  background: var(--bg-subtle);
  flex-shrink: 0;
}
.detail-hdr {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 18px;
  border-bottom: 1px solid var(--border-muted);
  flex-shrink: 0;
}
.dt-name { font-size: 12.5px; font-weight: 650; color: var(--text-bright); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dt-kind { font-size: 11.5px; color: var(--text-muted); flex: none; }
.detail-body { flex: 1; min-height: 0; overflow: hidden; display: flex; flex-direction: column; }
.detail-body > .diff-pane { flex: 1; min-height: 0; }

/* ── Repository settings modal ── */
.cfg-backdrop { position: fixed; inset: 0; z-index: 9998; background: var(--shadow-scrim); }
.cfg-modal {
  position: fixed;
  z-index: 9999;
  top: 16vh;
  left: 50%;
  transform: translateX(-50%);
  width: min(520px, 90vw);
  max-height: 68vh;
  overflow-y: auto;
  background: var(--bg-elevated);
  border: 1px solid var(--border-muted);
  border-radius: 16px;
  padding: 18px 20px;
  display: flex;
  flex-direction: column;
  gap: 10px;
  box-shadow: 0 12px 40px var(--shadow-scrim);
}
.cfg-title { font-weight: 800; font-size: 14px; color: var(--text-bright); margin-bottom: 2px; }
.cfg-empty { color: var(--text-secondary); font-size: 12.5px; }
.cfg-row { display: flex; align-items: center; gap: 10px; }
.cfg-key { width: 170px; flex-shrink: 0; font-size: 12px; color: var(--text-secondary); }
.cfg-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 8px; }
.cfg-actions .commitbtn { margin-left: 0; }
</style>
