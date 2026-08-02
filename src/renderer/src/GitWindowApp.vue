<script setup lang="ts">
// GitWindowApp — the standalone Git client surface, "Editorial Calm" design.
//
// Runs inside the isolated `navide.git` plugin WebContentsView (see
// src/renderer/plugins/git/). It reuses the existing `useGit` composable
// unchanged; the plugin build aliases its `useBackend` to the capability shim,
// so every git.* call is brokered over the host's shared WebSocket.
//
// Layout: a calm, borderless reading surface. Toolbar (wordmark → repo crumb →
// ghost sync actions + one primary). Sidebar: view nav on top, then GitPane's
// section cards replicated 1:1 (Branches panel with compare/rebase/merge/
// switch, Stashes, Remotes, Tags, Worktrees, inline-edit Config, and the
// gh/glab Issues card) — same collapse style and controls as the main
// window's Git tab. Center: the signature interaction — one file
// card where the checkbox IS the stage state (check to stage, uncheck to
// unstage) — plus a floating commit composer card. Bottom: shared DiffPane
// detail. History (GitHistoryModal) and branch comparison (BranchDiffPane)
// keep their own views. "Open in editor" routes through the `ui.open_in_editor`
// host capability to the mini-IDE (OS default app when not installed); the
// worktree/remote shell actions ride the other ui.* host capabilities. All
// colors map to semantic tokens so the five app themes translate the design.

import { ref, computed, defineAsyncComponent, onMounted, onUnmounted } from 'vue'
import { useBackend } from './composables/useBackend'
import { useGit, type GitFileEntry } from './composables/useGit'
import { useIssues } from './composables/useIssues'
import { useNotify } from './composables/useNotify'
import { useTheme } from './composables/useTheme'
import { initSettingsBackend, settingsGet, settingsSet, onSettingsChanged } from './lib/settings'
import GitHistoryModal from './components/GitHistoryModal.vue'
import GitCredentialModal from './components/GitCredentialModal.vue'
import NotificationHost from './components/NotificationHost.vue'
import DiffPane from './editor/DiffPane.vue'
import BranchDiffPane from './editor/BranchDiffPane.vue'
// Lazy-loaded: AIChatPane statically pulls mermaid + katex (heavy). The async
// chunk is only fetched when the panel is first opened (v-if below), keeping
// the git window's first paint unaffected. Mirrors PlanWindowApp.
const AIChatPane = defineAsyncComponent(() => import('./components/AIChatPane.vue'))

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

// ── AI Chat panel (right) — mirrors PlanWindowApp ────────────────────────────
const AI_PANEL_W_KEY = 'git-ai-panel-width'
const aiPanelOpen = ref(false)
// Mounted lazily on first open, then kept alive via v-show so the chat state
// (threads, streaming) survives toggling the panel closed.
const aiPanelMounted = ref(false)
const aiPanelWidth = ref(
  Math.max(280, Math.min(600, parseInt(settingsGet(AI_PANEL_W_KEY, '360'), 10)))
)
let aiResizing = false
function toggleAiPanel(): void {
  aiPanelOpen.value = !aiPanelOpen.value
  if (aiPanelOpen.value) aiPanelMounted.value = true
}
function onAiResizeStart(): void {
  aiResizing = true
  document.addEventListener('mousemove', onAiResizeMove)
  document.addEventListener('mouseup', onAiResizeEnd)
}
function onAiResizeMove(e: MouseEvent): void {
  if (!aiResizing) return
  aiPanelWidth.value = Math.max(280, Math.min(600, window.innerWidth - e.clientX))
}
function onAiResizeEnd(): void {
  if (!aiResizing) return
  aiResizing = false
  settingsSet(AI_PANEL_W_KEY, String(aiPanelWidth.value))
  document.removeEventListener('mousemove', onAiResizeMove)
  document.removeEventListener('mouseup', onAiResizeEnd)
}

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
  // branch comparison (inline compare panel, GitPane parity)
  compareBranches,
  // askpass credential prompt
  credentialPrompt,
  showCredentialPrompt,
  submitCredential,
  cancelCredential
} = git

// Cloud issues (GitHub via gh / GitLab via glab) — same wiring as GitPane.
const {
  provider: issueProvider, issues, selectedIssue,
  isLoadingIssues, isLoadingDetail, isSubmitting: isIssueSubmitting,
  issuesError,
  ensureLoaded: ensureIssuesLoaded, refresh: refreshIssues,
  openIssue, closeDetail: closeIssueDetail,
  createIssue, addComment, setState: setIssueState
} = useIssues(() => workspacePath, backend)

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
function absPath(p: string): string {
  return `${workspacePath.replace(/\/+$/, '')}/${p}`
}
/** File rows carry their absolute path as `text/plain`, the payload convention
 *  ExplorerPane and GitPane already use. A terminal in the main window turns
 *  that into a shell-escaped path at the prompt (see lib/drop.ts); Chromium
 *  delivers same-app drops across window boundaries on its own. */
function onFileDragStart(e: DragEvent, path: string): void {
  if (!e.dataTransfer) return
  e.dataTransfer.setData('text/plain', absPath(path))
  e.dataTransfer.effectAllowed = 'copy'
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

// ── Sidebar cards (aligned 1:1 with GitPane's sections) ──────────────────────
// Collapse state per card; branches expanded by default like GitPane's panel.
const branchesExpanded = ref(true)
const stashesExpanded = ref(false)
const remotesExpanded = ref(false)
const tagsExpanded = ref(false)
const worktreesExpanded = ref(false)
const configExpanded = ref(false)
// Remote branches live inside the branch card behind the ⇅ toggle (GitPane).
const showRemoteBranches = ref(false)

// ── Branches (GitPane branch panel) ──────────────────────────────────────────
const newBranchName = ref('')
const branchOpError = ref('')
// Inline compare panel (GitPane's ⇔): stat + files against the current branch.
const comparingBranch = ref('')
const compareResult = ref<{ stat: string; files: string[] } | null>(null)

async function onSwitchBranch(name: string): Promise<void> {
  if (name === gitStatus.value.branch) return
  branchOpError.value = ''
  const r = await switchBranch(name)
  if (!r.ok) branchOpError.value = r.error || 'switch failed'
}
async function doCreateBranch(): Promise<void> {
  const name = newBranchName.value.trim()
  if (!name || /\s|\.\./.test(name) || name.startsWith('-')) return
  branchOpError.value = ''
  const r = await createBranch(name)
  if (r.ok) newBranchName.value = ''
  else branchOpError.value = r.error || 'create failed'
}
async function doCompareBranch(name: string): Promise<void> {
  if (comparingBranch.value === name) {
    comparingBranch.value = ''
    compareResult.value = null
    return
  }
  comparingBranch.value = name
  const r = await compareBranches(name, gitStatus.value.branch)
  compareResult.value = r.ok ? { stat: r.stat, files: r.files } : null
  if (!r.ok) branchOpError.value = r.error || 'compare failed'
}
async function doMergeIntoCurrent(name: string): Promise<void> {
  branchOpError.value = ''
  const r = await mergeBranch(name)
  if (!r.ok) branchOpError.value = r.error || 'merge failed'
}
async function doRebaseOnto(name: string): Promise<void> {
  branchOpError.value = ''
  const r = await rebaseOn(name)
  if (!r.ok) branchOpError.value = r.error || 'rebase failed'
}
// GitPane deletes branches from a right-click context menu — same here.
function openBranchCtxMenu(e: MouseEvent, name: string): void {
  openMenu(e, [
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
  ])
}
async function onCheckoutRemoteBranch(ref: string): Promise<void> {
  branchOpError.value = ''
  const r = await checkoutRemoteBranch(ref)
  if (!r.ok) branchOpError.value = r.error || 'checkout failed'
}

// ── Stashes ──────────────────────────────────────────────────────────────────
async function onStashPush(): Promise<void> {
  const msg = await notify.prompt('Stash message (optional)', { title: 'Stash changes' })
  if (msg === null) return
  toastResult(await stashPush(msg.trim()), 'Stashed')
}
async function onStashApply(index: number): Promise<void> {
  toastResult(await stashApply(index))
}
async function onStashPop(index: number): Promise<void> {
  toastResult(await stashPop(index))
}
async function onStashDrop(index: number): Promise<void> {
  const ok = await notify.confirm('Drop this stash? Its changes are lost.', {
    title: 'Drop stash',
    confirmText: 'Drop'
  })
  if (!ok) return
  toastResult(await stashDrop(index))
}

// ── Remotes ──────────────────────────────────────────────────────────────────
const newRemoteName = ref('')
const newRemoteUrl = ref('')

async function doAddRemote(): Promise<void> {
  const name = newRemoteName.value.trim()
  const url = newRemoteUrl.value.trim()
  if (!name || !url) return
  if (toastResult(await addRemote(name, url), `Added ${name}`)) {
    newRemoteName.value = ''
    newRemoteUrl.value = ''
  }
}
async function onRemoveRemote(name: string): Promise<void> {
  const ok = await notify.confirm(`Remove remote ${name}?`, {
    title: 'Remove remote',
    confirmText: 'Remove'
  })
  if (!ok) return
  toastResult(await removeRemote(name))
}

// ── Tags ─────────────────────────────────────────────────────────────────────
const newTagName = ref('')
const newTagMessage = ref('')

async function doCreateTag(): Promise<void> {
  const name = newTagName.value.trim()
  if (!name) return
  if (toastResult(await createTag(name, newTagMessage.value.trim()), `Tagged ${name}`)) {
    newTagName.value = ''
    newTagMessage.value = ''
  }
}
async function onDeleteTag(name: string): Promise<void> {
  const ok = await notify.confirm(`Delete tag ${name}?`, {
    title: 'Delete tag',
    confirmText: 'Delete'
  })
  if (!ok) return
  toastResult(await deleteTag(name))
}

// ── Worktrees ────────────────────────────────────────────────────────────────
const newWtPath = ref('')
const newWtBranch = ref('')
const newWtIsNew = ref(false)
const worktreeBranchOptions = computed(() =>
  gitBranches.value.filter((b) => !b.is_remote).map((b) => b.name)
)

async function doAddWorktree(): Promise<void> {
  const path = newWtPath.value.trim()
  const branch = newWtBranch.value.trim()
  if (!path || !branch) return
  if (toastResult(await addWorktree(path, branch, newWtIsNew.value), 'Worktree added')) {
    newWtPath.value = ''
    newWtBranch.value = ''
  }
  await loadWorktrees()
}
async function pickWorktreeDir(): Promise<void> {
  const picked = await pickFolder(newWtPath.value.trim() || undefined)
  if (picked) newWtPath.value = picked
}
async function onRemoveWorktree(path: string): Promise<void> {
  const ok = await notify.confirm(`Remove worktree at ${path}?`, {
    title: 'Remove worktree',
    confirmText: 'Remove'
  })
  if (!ok) return
  const r = await removeWorktree(path)
  if (!r.ok) {
    // A dirty/locked worktree fails a plain remove — offer --force (GitPane).
    const forced = await notify.confirm(`${r.error || 'Remove failed'} — force remove?`, {
      title: 'Remove worktree',
      confirmText: 'Force remove'
    })
    if (forced) toastResult(await removeWorktree(path, true))
  }
  await loadWorktrees()
}
async function onToggleWorktreeLock(wt: { path: string; locked: boolean }): Promise<void> {
  toastResult(wt.locked ? await unlockWorktree(wt.path) : await lockWorktree(wt.path))
  await loadWorktrees()
}
async function onMoveWorktree(path: string): Promise<void> {
  const dest = await pickFolder(path)
  if (!dest) return
  toastResult(await moveWorktree(path, dest), 'Worktree moved')
  await loadWorktrees()
}
async function onPruneWorktrees(): Promise<void> {
  toastResult(await pruneWorktrees(), 'Pruned')
  await loadWorktrees()
}
async function onRepairWorktrees(): Promise<void> {
  toastResult(await repairWorktrees(), 'Repaired')
  await loadWorktrees()
}

// ── Config (inline editing, GitPane parity) ──────────────────────────────────
const configDisplayKeys = computed(() =>
  gitConfigAllowedKeys.value.length
    ? gitConfigAllowedKeys.value
    : ['user.name', 'user.email', 'core.autocrlf', 'core.filemode', 'pull.rebase']
)
const CONFIG_OPTIONS: Record<string, string[]> = {
  'core.autocrlf': ['true', 'false', 'input'],
  'core.filemode': ['true', 'false'],
  'pull.rebase': ['true', 'false']
}
const inlineEditKey = ref('')
const inlineEditValue = ref('')
const configError = ref('')

function toggleConfigCard(): void {
  configExpanded.value = !configExpanded.value
  if (configExpanded.value) void loadGitConfig()
}
function startInlineEdit(key: string): void {
  inlineEditKey.value = key
  inlineEditValue.value = gitConfig.value[key] ?? ''
}
function cancelInlineEdit(): void {
  inlineEditKey.value = ''
  inlineEditValue.value = ''
}
async function saveInlineEdit(): Promise<void> {
  configError.value = ''
  const key = inlineEditKey.value
  if (!key) return
  const r = await setGitConfig(key, inlineEditValue.value)
  if (!r.ok) configError.value = r.error || 'failed'
  else cancelInlineEdit()
}

// ── Issues card (GitPane parity; lazy-loads the CLI on first expand) ─────────
const issuesExpanded = ref(false)
const showNewIssue = ref(false)
const newIssueTitle = ref('')
const newIssueBody = ref('')
const newComment = ref('')
const openIssueCount = computed(() => issues.value.filter((i) => i.state === 'open').length)

function toggleIssuesCard(): void {
  issuesExpanded.value = !issuesExpanded.value
  if (issuesExpanded.value) void ensureIssuesLoaded()
}
async function submitNewIssue(): Promise<void> {
  const r = await createIssue(newIssueTitle.value, newIssueBody.value)
  if (r.ok) {
    newIssueTitle.value = ''
    newIssueBody.value = ''
    showNewIssue.value = false
  }
}
async function submitComment(): Promise<void> {
  const n = selectedIssue.value?.number
  if (n == null) return
  const r = await addComment(n, newComment.value)
  if (r.ok) newComment.value = ''
}
async function toggleIssueState(): Promise<void> {
  const issue = selectedIssue.value
  if (!issue) return
  await setIssueState(issue.number, issue.state === 'open' ? 'closed' : 'open')
}
function issueProviderLabel(): string {
  if (issueProvider.value.provider === 'github') return 'GitHub'
  if (issueProvider.value.provider === 'gitlab') return 'GitLab'
  return ''
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

        <!-- ── BRANCHES (GitPane branch panel, verbatim controls) ── -->
        <div class="git-card">
          <div class="card-hdr clickable" @click="branchesExpanded = !branchesExpanded">
            <span class="sec-caret">{{ branchesExpanded ? '▾' : '▸' }}</span>
            <span class="sec-label">Branches</span>
            <span v-if="localBranches.length" class="sec-badge">{{ localBranches.length }}</span>
            <div class="spacer" />
          </div>
          <div v-if="branchesExpanded" class="card-body collapsible-body">
            <div class="input-row">
              <input
                v-model="newBranchName"
                class="git-input"
                placeholder="New branch…"
                spellcheck="false"
                @keydown.enter="doCreateBranch"
              />
              <button
                class="btn-ghost sm"
                :disabled="!newBranchName.trim() || /\s|\.\./.test(newBranchName.trim()) || newBranchName.trim().startsWith('-')"
                @click="doCreateBranch"
              >＋</button>
              <button
                class="btn-ghost sm"
                :class="{ active: showRemoteBranches }"
                :title="showRemoteBranches ? 'Hide remote branches' : 'Show remote branches'"
                @click="showRemoteBranches = !showRemoteBranches"
              >⇅</button>
            </div>
            <p v-if="branchOpError" class="err-text">{{ branchOpError }}</p>
            <div
              v-for="b in localBranches"
              :key="b.name"
              class="branch-row"
              :class="{ current: b.is_current }"
              @contextmenu.prevent="!b.is_current && openBranchCtxMenu($event, b.name)"
            >
              <span class="b-check">{{ b.is_current ? '✓' : '' }}</span>
              <span class="b-name">{{ b.name }}</span>
              <span v-if="b.tracking" class="b-track">→ {{ b.tracking }}</span>
              <div class="spacer" />
              <template v-if="!b.is_current">
                <button class="row-btn always" title="Compare" @click.stop="doCompareBranch(b.name)">⇔</button>
                <button class="row-btn always" title="Rebase current onto" @click.stop="doRebaseOnto(b.name)">⇡</button>
                <button class="row-btn always" title="Merge into current" @click.stop="doMergeIntoCurrent(b.name)">⇣</button>
                <button class="row-btn always" title="Switch" @click.stop="onSwitchBranch(b.name)">↵</button>
              </template>
            </div>
            <div v-if="!localBranches.length" class="empty-msg">No branches</div>
            <template v-if="showRemoteBranches">
              <div class="branch-section-label">Remote branches</div>
              <div v-if="!remoteBranches.length" class="empty-msg">No remote branches</div>
              <div
                v-for="b in remoteBranches"
                :key="b.name"
                class="branch-row remote-branch-row"
                :class="{ 'remote-has-local': b.has_local }"
              >
                <span class="b-check">{{ b.has_local ? '✓' : '' }}</span>
                <span class="b-name remote">{{ b.name }}</span>
                <div class="spacer" />
                <button
                  v-if="!b.has_local"
                  class="row-btn always"
                  title="Checkout locally"
                  @click.stop="onCheckoutRemoteBranch(b.name)"
                >⬇</button>
              </div>
            </template>
            <div v-if="comparingBranch && compareResult" class="compare-panel">
              <div class="compare-title">{{ comparingBranch }} ↔ {{ gitStatus.branch }}</div>
              <div class="compare-stat">{{ compareResult.stat }}</div>
              <div v-for="f in compareResult.files" :key="f" class="compare-file">{{ f }}</div>
            </div>
          </div>
        </div>

        <!-- ── STASHES ── -->
        <div class="git-card">
          <div class="card-hdr clickable" @click="stashesExpanded = !stashesExpanded">
            <span class="sec-caret">{{ stashesExpanded ? '▾' : '▸' }}</span>
            <span class="sec-label">Stashes</span>
            <span v-if="gitStashes.length" class="sec-badge">{{ gitStashes.length }}</span>
            <div class="spacer" />
            <button class="row-btn always" title="Stash working changes" @click.stop="onStashPush">＋</button>
          </div>
          <div v-if="stashesExpanded" class="card-body collapsible-body">
            <div v-if="!gitStashes.length" class="empty-msg">No stashes</div>
            <div v-for="st in gitStashes" :key="st.ref" class="generic-row">
              <span class="stash-ref">{{ st.ref }}</span>
              <span class="stash-msg">{{ st.message }}</span>
              <div class="row-actions always">
                <button class="row-btn always" title="Apply (keep stash)" @click.stop="onStashApply(st.index)">⎘</button>
                <button class="row-btn always" title="Pop (apply &amp; remove)" @click.stop="onStashPop(st.index)">↑</button>
                <button class="row-btn always danger" title="Drop" @click.stop="onStashDrop(st.index)">✕</button>
              </div>
            </div>
          </div>
        </div>

        <!-- ── REMOTES ── -->
        <div class="git-card">
          <div class="card-hdr clickable" @click="remotesExpanded = !remotesExpanded">
            <span class="sec-caret">{{ remotesExpanded ? '▾' : '▸' }}</span>
            <span class="sec-label">Remotes</span>
            <span v-if="gitRemotes.length" class="sec-badge">{{ gitRemotes.length }}</span>
            <div class="spacer" />
          </div>
          <div v-if="remotesExpanded" class="card-body collapsible-body">
            <div v-if="!gitRemotes.length" class="empty-msg">No remotes</div>
            <div v-for="r in gitRemotes" :key="r.name" class="generic-row">
              <span class="remote-name">{{ r.name }}</span>
              <span class="remote-url" :title="r.fetch_url">{{ r.fetch_url }}</span>
              <button class="row-btn always" title="Open remote URL" @click.stop="openExternal(r.fetch_url)">↗</button>
              <button class="row-btn always danger" title="Remove remote" @click.stop="onRemoveRemote(r.name)">✕</button>
            </div>
            <div class="input-row" style="margin-top: 6px">
              <input v-model="newRemoteName" class="git-input" placeholder="Name" style="width: 72px; flex: 0 0 auto" />
              <input v-model="newRemoteUrl" class="git-input" placeholder="URL" @keydown.enter="doAddRemote" />
              <button class="btn-ghost sm" :disabled="!newRemoteName.trim() || !newRemoteUrl.trim()" @click="doAddRemote">＋</button>
            </div>
          </div>
        </div>

        <!-- ── TAGS ── -->
        <div class="git-card">
          <div class="card-hdr clickable" @click="tagsExpanded = !tagsExpanded">
            <span class="sec-caret">{{ tagsExpanded ? '▾' : '▸' }}</span>
            <span class="sec-label">Tags</span>
            <span v-if="gitTags.length" class="sec-badge">{{ gitTags.length }}</span>
            <div class="spacer" />
          </div>
          <div v-if="tagsExpanded" class="card-body collapsible-body">
            <div v-if="!gitTags.length" class="empty-msg">No tags</div>
            <div v-for="t in gitTags" :key="t.name" class="generic-row">
              <span class="b-name">{{ t.name }}</span>
              <code class="chash" style="margin-left: 4px">{{ t.commit_hash }}</code>
              <span v-if="t.message" class="b-track">{{ t.message }}</span>
              <div class="spacer" />
              <button class="row-btn always danger" title="Delete tag" @click.stop="onDeleteTag(t.name)">✕</button>
            </div>
            <div class="input-row" style="margin-top: 6px; flex-wrap: wrap; gap: 4px">
              <input v-model="newTagName" class="git-input" placeholder="v1.0.0" style="flex: 1; min-width: 72px" />
              <input v-model="newTagMessage" class="git-input" placeholder="Message" style="flex: 2; min-width: 80px" />
              <button class="btn-ghost sm" :disabled="!newTagName.trim()" @click="doCreateTag">＋</button>
            </div>
          </div>
        </div>

        <!-- ── WORKTREES ── -->
        <div class="git-card">
          <div class="card-hdr clickable" @click="worktreesExpanded = !worktreesExpanded">
            <span class="sec-caret">{{ worktreesExpanded ? '▾' : '▸' }}</span>
            <span class="sec-label">Worktrees</span>
            <span v-if="gitWorktrees.length > 1" class="sec-badge">{{ gitWorktrees.length }}</span>
            <div class="spacer" />
          </div>
          <div v-if="worktreesExpanded" class="card-body collapsible-body">
            <div class="input-row" style="margin-bottom: 6px">
              <button class="btn-ghost sm" title="Prune stale worktrees" @click="onPruneWorktrees">Prune</button>
              <button class="btn-ghost sm" title="Repair worktree links" @click="onRepairWorktrees">Repair</button>
            </div>
            <div v-for="wt in gitWorktrees" :key="wt.path" class="generic-row">
              <span class="wt-icon">{{ wt.is_main ? '✦' : '○' }}</span>
              <div style="flex: 1; min-width: 0">
                <div class="wt-name-row">
                  <span class="b-name" :title="wt.path">{{ wt.path.split('/').at(-1) }}</span>
                  <span v-if="wt.bare" class="wt-badge">bare</span>
                  <span v-if="wt.detached" class="wt-badge">detached</span>
                  <span v-if="wt.locked" class="wt-badge warn" :title="wt.lock_reason">🔒 locked</span>
                  <span v-if="wt.prunable" class="wt-badge warn" :title="wt.prune_reason">⚠ stale</span>
                </div>
                <div class="b-track">{{ wt.branch || wt.head.slice(0, 8) }}</div>
              </div>
              <button
                v-if="!wt.bare && wt.path !== workspacePath"
                class="row-btn always"
                title="Open in new window"
                @click.stop="onOpenWorktree(wt.path)"
              >⧉</button>
              <button v-if="!wt.bare" class="row-btn always" title="Reveal in Finder" @click.stop="revealPath(wt.path)">◱</button>
              <button
                v-if="!wt.is_main"
                class="row-btn always"
                :title="wt.locked ? 'Unlock' : 'Lock'"
                @click.stop="onToggleWorktreeLock(wt)"
              >{{ wt.locked ? '🔓' : '🔒' }}</button>
              <button
                v-if="!wt.is_main && !wt.bare"
                class="row-btn always"
                title="Move worktree"
                @click.stop="onMoveWorktree(wt.path)"
              >⇄</button>
              <button
                v-if="!wt.is_main"
                class="row-btn always danger"
                title="Remove worktree"
                @click.stop="onRemoveWorktree(wt.path)"
              >✕</button>
            </div>
            <div class="input-row" style="margin-top: 6px">
              <input v-model="newWtPath" class="git-input" placeholder="/absolute/path" style="flex: 2" spellcheck="false" />
              <button class="btn-ghost sm" title="Browse for a folder" @click="pickWorktreeDir">…</button>
              <input v-if="newWtIsNew" v-model="newWtBranch" class="git-input" placeholder="new-branch" style="flex: 1" spellcheck="false" />
              <select v-else v-model="newWtBranch" class="git-input" style="flex: 1">
                <option value="" disabled>branch…</option>
                <option v-for="b in worktreeBranchOptions" :key="b" :value="b">{{ b }}</option>
              </select>
              <button class="btn-ghost sm" :disabled="!newWtPath.trim() || !newWtBranch.trim()" title="Add worktree" @click="doAddWorktree">＋</button>
            </div>
            <label class="check-label"><input v-model="newWtIsNew" type="checkbox" /> Create a new branch</label>
          </div>
        </div>

        <!-- ── CONFIG (inline editing) ── -->
        <div class="git-card">
          <div class="card-hdr clickable" @click="toggleConfigCard">
            <span class="sec-caret">{{ configExpanded ? '▾' : '▸' }}</span>
            <span class="sec-label">Config</span>
            <div class="spacer" />
          </div>
          <div v-if="configExpanded" class="card-body collapsible-body">
            <div v-for="key in configDisplayKeys" :key="key" class="config-row">
              <span class="config-key">{{ key }}</span>
              <template v-if="inlineEditKey === key">
                <select v-if="CONFIG_OPTIONS[key]" v-model="inlineEditValue" class="git-input config-inline-input">
                  <option value="" disabled>—</option>
                  <option v-for="opt in CONFIG_OPTIONS[key]" :key="opt" :value="opt">{{ opt }}</option>
                </select>
                <input
                  v-else
                  v-model="inlineEditValue"
                  class="git-input config-inline-input"
                  @keydown.enter="saveInlineEdit"
                  @keydown.esc="cancelInlineEdit"
                />
                <button class="btn-ghost sm" @click="saveInlineEdit">✓</button>
                <button class="btn-ghost sm" @click="cancelInlineEdit">✕</button>
              </template>
              <span v-else class="config-val clickable" @click="startInlineEdit(key)">{{ gitConfig[key] || '—' }}</span>
            </div>
            <p v-if="configError" class="err-text">{{ configError }}</p>
          </div>
        </div>

        <!-- ── ISSUES (GitHub/GitLab) ── -->
        <div class="git-card">
          <div class="card-hdr clickable" @click="toggleIssuesCard">
            <span class="sec-caret">{{ issuesExpanded ? '▾' : '▸' }}</span>
            <span class="sec-label">Issues</span>
            <span v-if="issuesExpanded && issueProviderLabel()" class="sec-badge">{{ issueProviderLabel() }}</span>
            <span v-if="issuesExpanded && openIssueCount" class="sec-badge">{{ openIssueCount }} open</span>
            <div class="spacer" />
            <button
              v-if="issuesExpanded && issueProvider.authenticated && !selectedIssue"
              class="row-btn always"
              title="New issue"
              @click.stop="showNewIssue = !showNewIssue"
            >＋</button>
            <button v-if="issuesExpanded" class="row-btn always" title="Refresh" @click.stop="refreshIssues">↻</button>
          </div>
          <div v-if="issuesExpanded" class="card-body collapsible-body">
            <div v-if="issueProvider.provider === 'unknown'" class="empty-msg" style="padding: 2px 0">
              No supported issue host detected for this repo (needs a GitHub or GitLab origin remote).
            </div>
            <div v-else-if="!issueProvider.cli_available" class="empty-msg" style="padding: 2px 0">
              {{ issueProvider.provider === 'github' ? 'GitHub CLI (gh)' : 'GitLab CLI (glab)' }} is not installed.
            </div>
            <div v-else-if="!issueProvider.authenticated" class="empty-msg" style="padding: 2px 0">
              Not authenticated. Run
              <code>{{ issueProvider.provider === 'github' ? 'gh auth login' : 'glab auth login' }}</code>
              in a terminal, then refresh.
            </div>

            <!-- detail view -->
            <template v-else-if="selectedIssue">
              <div class="input-row" style="margin-bottom: 6px">
                <button class="btn-ghost sm" @click="closeIssueDetail">← Back</button>
                <div class="spacer" />
                <button class="btn-ghost sm" title="Open in browser" @click="openExternal(selectedIssue.url)">Open ↗</button>
                <button class="btn-ghost sm" :disabled="isIssueSubmitting" @click="toggleIssueState">
                  {{ selectedIssue.state === 'open' ? 'Close' : 'Reopen' }}
                </button>
              </div>
              <div class="issue-detail-title">
                <span class="issue-state-dot" :class="selectedIssue.state" />
                #{{ selectedIssue.number }} · {{ selectedIssue.title }}
              </div>
              <div class="b-track" style="margin-bottom: 6px">{{ selectedIssue.author }} · {{ selectedIssue.created_at }}</div>
              <pre class="issue-body">{{ selectedIssue.body || '(no description)' }}</pre>
              <div v-for="(c, i) in selectedIssue.comments" :key="i" class="issue-comment">
                <div class="b-track">{{ c.author }} · {{ c.created_at }}</div>
                <pre class="issue-body">{{ c.body }}</pre>
              </div>
              <div class="input-row" style="margin-top: 6px; flex-direction: column; gap: 4px">
                <textarea v-model="newComment" class="git-input" rows="2" placeholder="Add a comment…" />
                <button class="btn-ghost sm" :disabled="!newComment.trim() || isIssueSubmitting" @click="submitComment">Comment</button>
              </div>
            </template>

            <!-- list view -->
            <template v-else>
              <div v-if="showNewIssue" class="input-row" style="margin-bottom: 6px; flex-direction: column; gap: 4px">
                <input v-model="newIssueTitle" class="git-input" placeholder="Issue title" />
                <textarea v-model="newIssueBody" class="git-input" rows="3" placeholder="Description (optional)" />
                <div class="input-row">
                  <button class="btn-ghost sm" :disabled="!newIssueTitle.trim() || isIssueSubmitting" @click="submitNewIssue">Create</button>
                  <button class="btn-ghost sm" @click="showNewIssue = false">Cancel</button>
                </div>
              </div>
              <div v-if="isLoadingIssues" class="empty-msg" style="padding: 2px 0">Loading…</div>
              <div v-else-if="!issues.length" class="empty-msg" style="padding: 2px 0">No issues</div>
              <div
                v-for="it in issues"
                :key="it.number"
                class="generic-row clickable"
                :class="{ loading: isLoadingDetail }"
                @click="openIssue(it.number)"
              >
                <span class="issue-state-dot" :class="it.state" />
                <div style="flex: 1; min-width: 0">
                  <div class="b-name" :title="it.title">#{{ it.number }} {{ it.title }}</div>
                  <div class="b-track">
                    {{ it.author }}
                    <span v-for="l in it.labels" :key="l" class="issue-label">{{ l }}</span>
                  </div>
                </div>
              </div>
            </template>
            <p v-if="issuesError" class="err-text">{{ issuesError }}</p>
          </div>
        </div>
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
                <div class="gsub">Check to stage · click for its diff · drag onto a terminal</div>
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
              <div
                v-for="f in conflictFiles"
                :key="'c' + f.path"
                class="frow conflict"
                draggable="true"
                @dragstart="onFileDragStart($event, f.path)"
                @click="showWorkingDiff(f.path, false)"
              >
                <span class="conflict-mark">⚠</span>
                <span class="stag u">conflict</span>
                <span class="fpath mono"><i>{{ splitPath(f.path).dir }}</i>{{ splitPath(f.path).base }}</span>
                <span class="rowact">
                  <button class="linkbtn" @click.stop="onResolveOurs(f.path)">ours</button>
                  <button class="linkbtn" @click.stop="onResolveTheirs(f.path)">theirs</button>
                  <button class="linkbtn" @click.stop="openInEditor(f.path)">editor</button>
                </span>
              </div>
              <div
                v-for="f in stagedFiles"
                :key="'s' + f.path"
                class="frow"
                draggable="true"
                @dragstart="onFileDragStart($event, f.path)"
                @click="showWorkingDiff(f.path, true)"
              >
                <button class="chk on" title="Unstage" @click.stop="toggleStage(f, true)" />
                <span class="stag" :class="fileTag(f).cls">{{ fileTag(f).label }}</span>
                <span class="fpath mono"><i>{{ splitPath(f.path).dir }}</i>{{ splitPath(f.path).base }}</span>
                <span class="rowact"><button class="linkbtn" @click.stop="showWorkingDiff(f.path, true)">diff</button></span>
              </div>
              <div
                v-for="f in changedFiles"
                :key="'u' + f.path"
                class="frow"
                draggable="true"
                @dragstart="onFileDragStart($event, f.path)"
                @click="showWorkingDiff(f.path, false)"
              >
                <button class="chk" title="Stage" @click.stop="toggleStage(f, false)" />
                <span class="stag" :class="fileTag(f).cls">{{ fileTag(f).label }}</span>
                <span class="fpath mono"><i>{{ splitPath(f.path).dir }}</i>{{ splitPath(f.path).base }}</span>
                <span class="rowact">
                  <button class="linkbtn" @click.stop="showWorkingDiff(f.path, false)">diff</button>
                  <button class="linkbtn danger" @click.stop="onDiscard(f)">discard</button>
                </span>
              </div>
              <div
                v-for="f in untrackedFiles"
                :key="'n' + f.path"
                class="frow"
                draggable="true"
                @dragstart="onFileDragStart($event, f.path)"
                @click="showWorkingDiff(f.path, false)"
              >
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

      <!-- Right activity rail (AI Chat toggle) — mirrors PlanWindowApp -->
      <div class="git-right-act">
        <button
          class="git-right-act-btn"
          :class="{ active: aiPanelOpen }"
          title="AI Chat"
          @click="toggleAiPanel"
        >
          <svg width="18" height="18" viewBox="0 0 16 16" fill="currentColor">
            <path d="M8 0L9.5 5.5L15 7L9.5 8.5L8 14L6.5 8.5L1 7L6.5 5.5Z"/>
          </svg>
        </button>
      </div>
      <!-- AI Chat panel (right): embedded chat bound to this window's workspace -->
      <div v-show="aiPanelOpen" class="git-ai-resize-handle" @mousedown.prevent="onAiResizeStart" />
      <div v-show="aiPanelOpen" class="git-ai-panel" :style="{ width: aiPanelWidth + 'px' }">
        <AIChatPane
          v-if="aiPanelMounted"
          :workspace-path="workspacePath"
          :backend="backend"
          embedded
          :active="aiPanelOpen"
        />
      </div>
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

/* ── AI Chat panel (right) — mirrors PlanWindowApp ── */
.git-right-act {
  align-items: center;
  background: var(--bg-subtle);
  border-left: 1px solid var(--border-muted);
  display: flex;
  flex-direction: column;
  flex-shrink: 0;
  padding-top: 8px;
  width: 34px;
}
.git-right-act-btn {
  background: transparent;
  border: none;
  border-radius: 4px;
  color: var(--text-muted);
  cursor: pointer;
  padding: 5px;
}
.git-right-act-btn:hover { color: var(--text-bright); }
.git-right-act-btn.active {
  background: var(--accent-subtle);
  color: var(--accent-bright);
}
.git-ai-resize-handle {
  background: transparent;
  border-left: 1px solid var(--border-muted);
  cursor: col-resize;
  flex-shrink: 0;
  transition: background 0.15s;
  width: 4px;
}
.git-ai-resize-handle:hover { background: var(--accent-emphasis); }
.git-ai-panel {
  border-left: 1px solid var(--border-muted);
  display: flex;
  flex-direction: column;
  flex-shrink: 0;
  max-width: 600px;
  min-width: 280px;
  overflow: hidden;
}

/* ── Sidebar ── */
.sidebar {
  width: 280px;
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

/* ── GitPane-copied card vocabulary (keep in sync with GitPane.vue) ────────── */
.empty-msg { color: var(--text-muted); font-size: 11px; font-style: italic; padding: 3px 8px 6px; }
.err-text { color: var(--danger-fg); font-size: 11px; margin: 0; padding: 2px 4px; }
.chash { font-size: 10px; color: var(--text-muted); font-family: monospace; background: transparent; }

.git-card {
  margin: 6px 10px;
  background: var(--bg-base);
  border: 1px solid var(--border-muted);
  border-radius: 6px;
  overflow: hidden;
}
.card-hdr {
  display: flex; align-items: center; gap: 6px;
  padding: 6px 10px; min-height: 22px;
  background: var(--bg-subtle);
}
.card-hdr.clickable { cursor: pointer; user-select: none; }
.card-hdr.clickable:hover { background: var(--bg-elevated); }
.git-card:has(.card-body) .card-hdr { border-bottom: 1px solid var(--border-muted); }
.card-body { padding: 4px 2px 6px; }
.collapsible-body {
  padding: 4px 12px 8px;
  display: flex; flex-direction: column; gap: 2px;
}
.sec-caret { font-size: 9px; color: var(--text-muted); width: 10px; flex-shrink: 0; }
.sec-label {
  font-size: 11px; font-weight: 600; color: var(--text-secondary);
  letter-spacing: 0.3px;
}
.sec-badge {
  font-size: 10px; color: var(--text-secondary); background: var(--bg-active);
  border-radius: 10px; padding: 0 6px; flex-shrink: 0;
}

.branch-row {
  display: flex; align-items: center; gap: 4px;
  padding: 2px 0; font-size: 11px; border-radius: 3px;
}
.branch-row:hover { background: var(--bg-hover-faint); }
.branch-row.current .b-name { color: var(--accent-bright); font-weight: 600; }
.b-check { width: 14px; color: var(--success-bright); font-size: 10px; text-align: center; flex-shrink: 0; }
.b-name { color: var(--text-primary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; min-width: 0; }
.b-name.remote { color: var(--text-muted); font-style: italic; }
.b-track { color: var(--text-muted); font-size: 10px; flex-shrink: 0; }
.branch-section-label { font-size: 10px; color: var(--text-muted); padding: 4px 0 2px; letter-spacing: 0.04em; text-transform: uppercase; }
.compare-panel {
  margin: 4px 0; background: var(--bg-inset, var(--bg-subtle)); border: 1px solid var(--border-muted);
  border-radius: 4px; padding: 6px 8px; font-size: 11px;
}
.compare-title { color: var(--accent-bright); font-weight: 600; margin-bottom: 3px; }
.compare-stat  { color: var(--success-bright); margin-bottom: 2px; }
.compare-file  { color: var(--text-secondary); font-family: monospace; font-size: 10px; }

.generic-row {
  display: flex; align-items: center; gap: 6px;
  padding: 3px 0; font-size: 11px;
}
.generic-row:hover { background: var(--bg-hover-faint); }
.generic-row.clickable { cursor: pointer; }
.generic-row.loading { opacity: 0.6; }
.row-actions.always { display: flex; }
.row-btn {
  display: flex; align-items: center; justify-content: center;
  min-width: 20px; height: 20px; background: transparent; border: none;
  border-radius: 3px; color: var(--text-secondary); font-size: 11px; cursor: pointer; padding: 0 2px;
}
.row-btn:hover { color: var(--text-primary); background: var(--bg-active); }
.row-btn.danger:hover { color: var(--danger-fg); }
.row-btn.always { opacity: 1; }
.stash-ref { color: var(--text-muted); font-size: 10px; flex-shrink: 0; }
.stash-msg { color: var(--text-primary); flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.remote-name { color: var(--text-muted); font-size: 10px; flex-shrink: 0; min-width: 44px; }
.remote-url  { color: var(--text-primary); flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 11px; }
.wt-icon { color: var(--success-bright); font-size: 11px; flex-shrink: 0; width: 14px; text-align: center; }
.wt-name-row { display: flex; align-items: center; gap: 4px; min-width: 0; }
.wt-name-row .b-name { flex: 0 1 auto; }
.wt-badge {
  font-size: 9px; color: var(--text-secondary); background: var(--bg-active);
  border-radius: 8px; padding: 0 5px; flex-shrink: 0; white-space: nowrap;
}
.wt-badge.warn { color: var(--danger-fg); }

.git-input {
  flex: 1; background: var(--bg-subtle); border: 1px solid var(--border-default); border-radius: 4px;
  color: var(--text-primary); font-size: 11px; padding: 3px 7px;
}
.git-input:focus { outline: none; border-color: var(--accent-focus); }
.input-row { display: flex; gap: 4px; }
.btn-ghost {
  background: transparent; border: 1px solid var(--border-default); border-radius: 4px;
  color: var(--text-secondary); font-size: 12px; padding: 4px 8px; cursor: pointer;
}
.btn-ghost:hover { border-color: var(--border-strong); color: var(--text-primary); }
.btn-ghost:disabled { opacity: 0.4; cursor: not-allowed; }
.btn-ghost.sm { font-size: 11px; padding: 3px 7px; }
.btn-ghost.active { color: var(--accent-bright); }
.check-label { display: flex; align-items: center; gap: 4px; font-size: 11px; color: var(--text-secondary); cursor: pointer; }
.check-label input { accent-color: var(--accent-focus); cursor: pointer; }

.config-row { display: flex; align-items: center; gap: 8px; padding: 2px 0; font-size: 11px; }
.config-key { color: var(--text-muted); min-width: 108px; flex-shrink: 0; font-family: monospace; font-size: 10px; }
.config-val { color: var(--text-primary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.config-val.clickable { cursor: pointer; border-radius: 3px; padding: 1px 4px; margin: -1px -4px; }
.config-val.clickable:hover { background: var(--bg-muted); color: var(--text-on-emphasis); }
.config-inline-input { flex: 1; min-width: 0; }

.issue-state-dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; background: var(--text-muted); }
.issue-state-dot.open { background: var(--success-bright); }
.issue-state-dot.closed { background: var(--accent-purple, #a371f7); }
.issue-label {
  display: inline-block; margin-left: 4px; padding: 0 5px; border-radius: 8px;
  background: var(--bg-muted); color: var(--text-muted); font-size: 9px; line-height: 14px;
}
.issue-detail-title { font-size: 12px; color: var(--text-primary); display: flex; align-items: center; gap: 6px; margin-bottom: 2px; }
.issue-body {
  white-space: pre-wrap; word-break: break-word; font-size: 11px; color: var(--text-primary);
  background: var(--bg-muted); border-radius: 4px; padding: 6px; margin: 0 0 4px; font-family: inherit;
}
.issue-comment { border-top: 1px solid var(--border-muted); padding-top: 4px; margin-top: 4px; }

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

</style>
