<script setup lang="ts">
// GitWindowApp — the standalone Git client surface (SourceTree / Fork layout).
//
// Runs inside the isolated `navide.git` plugin WebContentsView (see
// src/renderer/plugins/git/). It reuses the existing `useGit` composable
// unchanged; the plugin build aliases its `useBackend` to the capability shim,
// so every git.* call is brokered over the host's shared WebSocket.
//
// A wide three-pane window (toolbar → sidebar → history/status/branch-diff +
// detail/diff) wired to the full daily Git workflow: branches, history, status
// with stage/unstage/discard, commit (+amend, AI message), conflict quick
// resolution, stash/remote/tag/worktree management, git config, branch
// comparison, per-commit diffs through the shared editor DiffPane, and the
// askpass credential prompt. The full 3-way conflict editor stays in the
// mini-IDE (Monaco is deliberately kept out of this bundle).

import { ref, computed, onMounted, onUnmounted } from 'vue'
import { useBackend } from './composables/useBackend'
import { useGit, type GitCommitDetail, type GitFileEntry } from './composables/useGit'
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
  credentialPrompt,
  showCredentialPrompt,
  submitCredential,
  cancelCredential,
  // working-tree operations
  stageFile,
  unstageFile,
  stageAll,
  unstageFiles,
  discardFile,
  resolveConflictOurs,
  resolveConflictTheirs,
  abortOperation,
  // commit
  commit,
  amendCommit,
  generateMessage,
  isCommitting,
  isGenerating,
  // branches / stash / remotes / tags
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
  gitConfig,
  gitConfigAllowedKeys,
  loadGitConfig,
  setGitConfig
} = git

// ── View state ───────────────────────────────────────────────────────────────
type CenterView = 'history' | 'status' | 'branchdiff'
const view = ref<CenterView>('history')

const selectedHash = ref<string>('')
const commitDetail = ref<GitCommitDetail | null>(null)
const selectedFile = ref<string>('')
const isLoadingDetail = ref(false)

// ── External diff target (from the main GitPane) ─────────────────────────────
// The main process forwards a git_diff_* target (see window:openGit) so a file
// clicked in the main-window GitPane shows its diff in *this* window's panel
// rather than the mini-IDE. We read it on load and via nav.onOpenTarget; the
// shared DiffPane fetches the diff itself from these coordinates.
interface ExternalDiff {
  name: string
  staged: boolean
  commit: string
}
const externalDiff = ref<ExternalDiff | null>(null)

// Local busy flags for actions useGit doesn't expose a dedicated ref for.
const isPulling = ref(false)
const isPushing = ref(false)

// Only local branches in the sidebar BRANCHES group (remotes have their own).
const localBranches = computed(() => gitBranches.value.filter((b) => !b.is_remote))
const remoteBranches = computed(() => gitBranches.value.filter((b) => b.is_remote))

const hasWorkspace = computed(() => workspacePath.length > 0)
const isRepo = computed(() => gitStatus.value.is_git_repo)

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
  const base = workspacePath.split('/').filter(Boolean).at(-1) ?? workspacePath
  if (base) document.title = `Git · ${base}`
  loadTheme()
  offThemeSettingsChange = onSettingsChanged((keys) => {
    if (keys.includes('agent-team:theme') || keys.includes('agent-team:theme-custom')) {
      loadTheme()
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

// ── Commit selection → detail → per-file diff ────────────────────────────────
async function selectCommit(hash: string): Promise<void> {
  selectedHash.value = hash
  selectedFile.value = ''
  commitDetail.value = null
  isLoadingDetail.value = true
  try {
    commitDetail.value = await showCommit(hash)
  } finally {
    isLoadingDetail.value = false
  }
}

function selectFile(filepath: string): void {
  if (!selectedHash.value) return
  selectedFile.value = filepath
}

function showDiffTarget(params: Record<string, string>): void {
  const filepath = params['git_diff_filepath'] ?? ''
  if (!filepath) return
  externalDiff.value = {
    name: filepath,
    staged: params['git_diff_staged'] === 'true',
    commit: params['git_diff_commit'] ?? '',
  }
}

function clearExternalDiff(): void {
  externalDiff.value = null
}

// ── Working-tree operations (status view) ────────────────────────────────────
function toastResult(r: { ok: boolean; error?: string }, okMsg?: string): boolean {
  if (!r.ok) notify.toast(r.error || 'Operation failed', { type: 'error' })
  else if (okMsg) notify.toast(okMsg, { type: 'success' })
  return r.ok
}

function isConflictEntry(f: GitFileEntry): boolean {
  return f.status === 'U'
}

const opInProgress = computed(() => gitStatus.value.operation_in_progress)
const conflictCount = computed(
  () =>
    [...gitStatus.value.staged, ...gitStatus.value.unstaged].filter(isConflictEntry).length
)

/** Show a working-tree/staged file diff in the bottom detail (reuses the
 *  external-diff DiffPane, which owns stage/unstage-hunk actions). */
function showWorkingDiff(path: string, staged: boolean): void {
  externalDiff.value = { name: path, staged, commit: '' }
}

async function onStage(path: string): Promise<void> {
  await stageFile(path)
}
async function onUnstage(path: string): Promise<void> {
  await unstageFile(path)
}
async function onStageAll(): Promise<void> {
  await stageAll()
}
async function onUnstageAll(): Promise<void> {
  const paths = gitStatus.value.staged.map((f) => f.path)
  if (!paths.length) return
  toastResult(await unstageFiles(paths))
}
async function onDiscard(path: string): Promise<void> {
  const ok = await notify.confirm(`Discard changes in ${path}? This cannot be undone.`, {
    title: 'Discard changes',
    confirmText: 'Discard'
  })
  if (!ok) return
  await discardFile(path)
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

// ── Commit box ───────────────────────────────────────────────────────────────
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
  const model = settingsGet('agentTeam.analyzerModel', '') || 'qwen2:latest'
  const r = await generateMessage(model)
  if (r.ok) commitMessage.value = r.message
  else notify.toast(r.error || 'Message generation failed', { type: 'error' })
}

// ── Sidebar operations ───────────────────────────────────────────────────────
async function onSwitchBranch(name: string): Promise<void> {
  if (name === gitStatus.value.branch) return
  toastResult(await switchBranch(name), `Switched to ${name}`)
}
async function onCreateBranch(): Promise<void> {
  const name = (await notify.prompt('New branch name', { title: 'Create branch' }))?.trim()
  if (!name) return
  toastResult(await createBranch(name), `Created ${name}`)
}
async function onDeleteBranch(name: string): Promise<void> {
  const ok = await notify.confirm(`Delete branch ${name}?`, {
    title: 'Delete branch',
    confirmText: 'Delete'
  })
  if (!ok) return
  toastResult(await deleteBranch(name), `Deleted ${name}`)
}
async function onCheckoutRemoteBranch(ref: string): Promise<void> {
  const ok = await notify.confirm(`Check out ${ref} as a local branch?`, {
    title: 'Checkout remote branch',
    confirmText: 'Checkout'
  })
  if (!ok) return
  toastResult(await checkoutRemoteBranch(ref))
}

async function onStashPush(): Promise<void> {
  const msg = await notify.prompt('Stash message (optional)', { title: 'Stash changes' })
  if (msg === null) return
  toastResult(await stashPush(msg.trim()), 'Stashed')
}
async function onStashPop(index: number): Promise<void> {
  toastResult(await stashPop(index))
}
async function onStashApply(index: number): Promise<void> {
  toastResult(await stashApply(index))
}
async function onStashDrop(index: number): Promise<void> {
  const ok = await notify.confirm('Drop this stash? Its changes are lost.', {
    title: 'Drop stash',
    confirmText: 'Drop'
  })
  if (!ok) return
  toastResult(await stashDrop(index))
}

async function onAddRemote(): Promise<void> {
  const name = (await notify.prompt('Remote name', { title: 'Add remote', defaultValue: 'origin' }))?.trim()
  if (!name) return
  const url = (await notify.prompt('Remote URL', { title: `Add remote ${name}` }))?.trim()
  if (!url) return
  toastResult(await addRemote(name, url), `Added ${name}`)
}
async function onRemoveRemote(name: string): Promise<void> {
  const ok = await notify.confirm(`Remove remote ${name}?`, {
    title: 'Remove remote',
    confirmText: 'Remove'
  })
  if (!ok) return
  toastResult(await removeRemote(name))
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
async function onAddWorktree(): Promise<void> {
  const path = (await notify.prompt('New worktree path (absolute)', { title: 'Add worktree' }))?.trim()
  if (!path) return
  const branch = (await notify.prompt('Branch to check out (created if missing)', {
    title: 'Add worktree'
  }))?.trim()
  if (!branch) return
  const existing = gitBranches.value.some((b) => !b.is_remote && b.name === branch)
  toastResult(await addWorktree(path, branch, !existing), 'Worktree added')
  await loadWorktrees()
}
async function onRemoveWorktree(path: string): Promise<void> {
  const ok = await notify.confirm(`Remove worktree at ${path}?`, {
    title: 'Remove worktree',
    confirmText: 'Remove'
  })
  if (!ok) return
  toastResult(await removeWorktree(path))
  await loadWorktrees()
}
async function onPruneWorktrees(): Promise<void> {
  toastResult(await pruneWorktrees(), 'Pruned')
  await loadWorktrees()
}

// ── Git config modal ─────────────────────────────────────────────────────────
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
  notify.toast('Config saved', { type: 'success' })
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

// Short date for the history table (avoids pulling a date lib into the skeleton).
function shortDate(iso?: string): string {
  if (!iso) return ''
  return iso.length > 10 ? iso.slice(0, 10) : iso
}
</script>

<template>
  <div class="git-window">
    <!-- ── Toolbar ────────────────────────────────────────────────────── -->
    <header class="toolbar">
      <div class="tb-title">
        <span class="tb-branch">{{ gitStatus.branch || 'Git' }}</span>
        <span v-if="gitStatus.ahead || gitStatus.behind" class="tb-track">
          <span v-if="gitStatus.ahead">↑{{ gitStatus.ahead }}</span>
          <span v-if="gitStatus.behind">↓{{ gitStatus.behind }}</span>
        </span>
      </div>
      <div class="tb-actions">
        <button class="tb-btn" :disabled="busy || !isRepo" title="Fetch" @click="onFetch">
          <span class="ic">⇊</span>Fetch
        </button>
        <button class="tb-btn" :disabled="busy || !isRepo" title="Pull" @click="onPull">
          <span class="ic">↓</span>Pull
        </button>
        <button class="tb-btn" :disabled="busy || !isRepo" title="Push" @click="onPush">
          <span class="ic">↑</span>Push
        </button>
        <button class="tb-btn" :disabled="busy || !isRepo" title="Sync (pull + push)" @click="onSync">
          <span class="ic">⇅</span>Sync
        </button>
        <button class="tb-btn" :disabled="busy || !isRepo" title="Stash working changes" @click="onStashPush">
          <span class="ic">☰</span>Stash
        </button>
      </div>
      <div class="tb-spacer" />
      <div v-if="busy" class="tb-busy">working…</div>
      <button class="tb-btn" :disabled="!isRepo" title="Repository settings" @click="openConfig">
        <span class="ic">⚙</span>
      </button>
    </header>

    <div v-if="gitError" class="err-bar">{{ gitError }}</div>

    <!-- ── Body: sidebar | center | detail ───────────────────────────── -->
    <div v-if="!hasWorkspace" class="empty">No workspace path provided.</div>
    <div v-else-if="!isRepo && !isLoadingStatus" class="empty">Not a Git repository.</div>

    <div v-else class="body">
      <!-- Sidebar -->
      <aside class="sidebar">
        <div class="sb-group">
          <div class="sb-head">WORKSPACE</div>
          <button class="sb-item" :class="{ active: view === 'status' }" @click="view = 'status'">
            File status
            <span v-if="changeCount" class="sb-badge">{{ changeCount }}</span>
          </button>
          <button class="sb-item" :class="{ active: view === 'history' }" @click="view = 'history'">
            History
          </button>
          <button class="sb-item" :class="{ active: view === 'branchdiff' }" @click="openBranchDiff">
            Branch diff
          </button>
        </div>

        <div class="sb-group">
          <div class="sb-head">
            BRANCHES
            <button class="sb-head-btn" title="Create branch" @click="onCreateBranch">＋</button>
          </div>
          <div
            v-for="b in localBranches"
            :key="b.name"
            class="sb-item row"
            :class="{ current: b.is_current }"
            :title="b.is_current ? b.name : `Switch to ${b.name}`"
            @click="onSwitchBranch(b.name)"
          >
            <span class="sb-dot" /><span class="sb-label">{{ b.name }}</span>
            <button
              v-if="!b.is_current"
              class="sb-act danger"
              title="Delete branch"
              @click.stop="onDeleteBranch(b.name)"
            >×</button>
          </div>
          <div v-if="!localBranches.length" class="sb-empty">—</div>
        </div>

        <div class="sb-group">
          <div class="sb-head">
            REMOTES
            <button class="sb-head-btn" title="Add remote" @click="onAddRemote">＋</button>
          </div>
          <div v-for="r in gitRemotes" :key="r.name" class="sb-item row" :title="r.fetch_url">
            <span class="sb-label">{{ r.name }}</span>
            <button class="sb-act danger" title="Remove remote" @click.stop="onRemoveRemote(r.name)">×</button>
          </div>
          <div v-if="!gitRemotes.length" class="sb-empty">—</div>
        </div>

        <div class="sb-group">
          <div class="sb-head">TAGS</div>
          <div v-for="t in gitTags" :key="t.name" class="sb-item row" :title="t.message">
            <span class="sb-label">{{ t.name }}</span>
            <button class="sb-act danger" title="Delete tag" @click.stop="onDeleteTag(t.name)">×</button>
          </div>
          <div v-if="!gitTags.length" class="sb-empty">—</div>
        </div>

        <div class="sb-group">
          <div class="sb-head">
            STASHES
            <button class="sb-head-btn" title="Stash working changes" @click="onStashPush">＋</button>
          </div>
          <div v-for="s in gitStashes" :key="s.ref" class="sb-item row" :title="s.message">
            <span class="sb-label">{{ s.message || s.ref }}</span>
            <button class="sb-act" title="Pop (apply + drop)" @click.stop="onStashPop(s.index)">⤒</button>
            <button class="sb-act" title="Apply (keep stash)" @click.stop="onStashApply(s.index)">⎘</button>
            <button class="sb-act danger" title="Drop" @click.stop="onStashDrop(s.index)">×</button>
          </div>
          <div v-if="!gitStashes.length" class="sb-empty">—</div>
        </div>

        <div class="sb-group">
          <div class="sb-head">
            WORKTREES
            <button class="sb-head-btn" title="Add worktree" @click="onAddWorktree">＋</button>
            <button class="sb-head-btn" title="Prune stale worktrees" @click="onPruneWorktrees">⌫</button>
          </div>
          <div
            v-for="w in gitWorktrees"
            :key="w.path"
            class="sb-item row"
            :title="`${w.path}${w.locked ? ` (locked: ${w.lock_reason})` : ''}`"
          >
            <span class="sb-label">{{ w.branch || w.head.slice(0, 8) }}{{ w.is_main ? ' (main)' : '' }}</span>
            <button
              v-if="!w.is_main"
              class="sb-act danger"
              title="Remove worktree"
              @click.stop="onRemoveWorktree(w.path)"
            >×</button>
          </div>
          <div v-if="!gitWorktrees.length" class="sb-empty">—</div>
        </div>

        <div class="sb-group muted">
          <div class="sb-head">REMOTE BRANCHES</div>
          <div
            v-for="b in remoteBranches"
            :key="b.name"
            class="sb-item row"
            :title="`Checkout ${b.name}`"
            @click="onCheckoutRemoteBranch(b.name)"
          >
            <span class="sb-label">{{ b.name }}</span>
          </div>
          <div v-if="!remoteBranches.length" class="sb-empty">—</div>
        </div>
      </aside>

      <!-- Center + bottom detail -->
      <section class="center">
        <!-- History (full rich history with graph, search, context menu, and split detail) -->
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
            <select v-model="diffBase" class="bd-select" title="Base branch">
              <option value="" disabled>base…</option>
              <option v-for="b in gitBranches" :key="'b' + b.name" :value="b.name">{{ b.name }}</option>
            </select>
            <span class="bd-arrow">→</span>
            <select v-model="diffCompare" class="bd-select" title="Compare branch">
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
            <div v-else class="diff-empty">Pick two branches to compare.</div>
          </div>
        </div>

        <!-- File status -->
        <template v-else>
          <div class="pane status">
            <div v-if="opInProgress" class="op-banner">
              <span>
                {{ opInProgress }} in progress<template v-if="conflictCount">
                  — {{ conflictCount }} conflicted file{{ conflictCount > 1 ? 's' : '' }}</template>
              </span>
              <button class="op-abort" @click="onAbortOperation">Abort {{ opInProgress }}</button>
            </div>

            <div class="status-group">
              <div class="status-head">
                STAGED ({{ gitStatus.staged.length }})
                <button
                  v-if="gitStatus.staged.length"
                  class="sg-btn"
                  title="Unstage all"
                  @click="onUnstageAll"
                >Unstage all</button>
              </div>
              <div
                v-for="f in gitStatus.staged"
                :key="'s' + f.path"
                class="status-row"
                :class="{ conflict: isConflictEntry(f) }"
                @click="showWorkingDiff(f.path, true)"
              >
                <span class="st-badge staged">{{ f.status }}</span>
                <span class="st-path">{{ f.path }}</span>
                <span class="row-actions">
                  <button class="row-btn" title="Unstage" @click.stop="onUnstage(f.path)">−</button>
                </span>
              </div>
            </div>

            <div class="status-group">
              <div class="status-head">
                CHANGES ({{ gitStatus.unstaged.length + gitStatus.untracked.length }})
                <button
                  v-if="gitStatus.unstaged.length + gitStatus.untracked.length"
                  class="sg-btn"
                  title="Stage all"
                  @click="onStageAll"
                >Stage all</button>
              </div>
              <div
                v-for="f in gitStatus.unstaged"
                :key="'u' + f.path"
                class="status-row"
                :class="{ conflict: isConflictEntry(f) }"
                @click="showWorkingDiff(f.path, false)"
              >
                <span class="st-badge" :class="{ 'conflict-badge': isConflictEntry(f) }">{{ f.status }}</span>
                <span class="st-path">{{ f.path }}</span>
                <span class="row-actions">
                  <template v-if="isConflictEntry(f)">
                    <button class="row-btn" title="Resolve using ours" @click.stop="onResolveOurs(f.path)">ours</button>
                    <button class="row-btn" title="Resolve using theirs" @click.stop="onResolveTheirs(f.path)">theirs</button>
                  </template>
                  <template v-else>
                    <button class="row-btn" title="Stage" @click.stop="onStage(f.path)">＋</button>
                    <button class="row-btn danger" title="Discard changes" @click.stop="onDiscard(f.path)">↶</button>
                  </template>
                </span>
              </div>
              <div
                v-for="f in gitStatus.untracked"
                :key="'n' + f.path"
                class="status-row"
                @click="showWorkingDiff(f.path, false)"
              >
                <span class="st-badge new">?</span>
                <span class="st-path">{{ f.path }}</span>
                <span class="row-actions">
                  <button class="row-btn" title="Stage" @click.stop="onStage(f.path)">＋</button>
                </span>
              </div>
            </div>

            <!-- Commit box -->
            <div class="commit-box">
              <textarea
                v-model="commitMessage"
                class="cb-input"
                rows="3"
                placeholder="Commit message"
                :disabled="isCommitting"
              />
              <div class="cb-actions">
                <button
                  class="cb-btn"
                  :disabled="isGenerating || busy"
                  :title="'Generate a commit message with AI'"
                  @click="onGenerateMessage"
                >{{ isGenerating ? 'Generating…' : '✨ AI message' }}</button>
                <span class="cb-spacer" />
                <button class="cb-btn" :disabled="isCommitting" title="Amend last commit" @click="onAmend">
                  Amend
                </button>
                <button class="cb-btn primary" :disabled="!canCommit" @click="onCommit">
                  {{ isCommitting ? 'Committing…' : `Commit to ${gitStatus.branch || 'HEAD'}` }}
                </button>
              </div>
            </div>
          </div>

          <!-- Bottom: commit detail + per-file diff -->
          <div class="detail">
            <template v-if="externalDiff">
              <div class="detail-left">
                <div class="dt-meta">
                  <div class="dt-subject mono">{{ externalDiff.name }}</div>
                  <div class="dt-sub">
                    {{
                      externalDiff.commit
                        ? 'commit ' + externalDiff.commit.slice(0, 8)
                        : externalDiff.staged
                          ? 'staged changes'
                          : 'working tree'
                    }}
                  </div>
                  <button class="dt-back" @click="clearExternalDiff">← back to commits</button>
                </div>
              </div>
              <div class="detail-right">
                <DiffPane
                  :key="'ext:' + externalDiff.name + ':' + externalDiff.commit + ':' + externalDiff.staged"
                  :workspace-path="workspacePath"
                  :filepath="externalDiff.name"
                  :staged="externalDiff.staged"
                  :name="externalDiff.name"
                  :backend="backend"
                  :commit="externalDiff.commit || undefined"
                />
              </div>
            </template>
            <div v-else-if="isLoadingDetail" class="detail-loading">Loading commit…</div>
            <template v-else-if="commitDetail">
              <div class="detail-left">
                <div class="dt-meta">
                  <div class="dt-subject">{{ commitDetail.message }}</div>
                  <div class="dt-sub mono">{{ commitDetail.short_hash }}</div>
                  <div class="dt-sub">{{ commitDetail.author_name }} &lt;{{ commitDetail.author_email }}&gt;</div>
                  <div class="dt-sub">{{ commitDetail.date }}</div>
                </div>
                <div class="dt-files">
                  <div
                    v-for="f in commitDetail.files"
                    :key="f"
                    class="dt-file"
                    :class="{ active: f === selectedFile }"
                    @click="selectFile(f)"
                  >
                    {{ f }}
                  </div>
                </div>
              </div>
              <div class="detail-right">
                <div v-if="!selectedFile" class="diff-empty">Select a file to view its diff.</div>
                <DiffPane
                  v-else
                  :key="'commit:' + selectedHash + ':' + selectedFile"
                  :workspace-path="workspacePath"
                  :filepath="selectedFile"
                  :staged="false"
                  :name="selectedFile"
                  :backend="backend"
                  :commit="selectedHash"
                />
              </div>
            </template>
            <div v-else class="detail-empty">Select a commit to see its changes.</div>
          </div>
        </template>
      </section>
    </div>

    <!-- Repository config (allow-listed git config keys) -->
    <template v-if="showConfig">
      <div class="cfg-backdrop" @click="showConfig = false" />
      <div class="cfg-modal" @keydown.esc="showConfig = false">
        <div class="cfg-title">Repository settings</div>
        <div v-if="!gitConfigAllowedKeys.length" class="cfg-empty">No editable keys.</div>
        <div v-for="key in gitConfigAllowedKeys" :key="key" class="cfg-row">
          <label class="cfg-key mono">{{ key }}</label>
          <input v-model="configDraft[key]" class="cfg-input" type="text" spellcheck="false" />
        </div>
        <div class="cfg-actions">
          <button class="cb-btn" @click="showConfig = false">Cancel</button>
          <button class="cb-btn primary" @click="saveConfig">Save</button>
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
    <!-- Renders useNotify toasts/dialogs (DiffPane stage/discard feedback). -->
    <NotificationHost />
  </div>
</template>

<style scoped>
/* Colors follow the app theme via semantic tokens (styles/tokens/semantic.css),
 * so the standalone Git window re-themes with the rest of the app. The default
 * dark-github values reproduce the original hardcoded palette. */
.git-window {
  height: 100vh;
  display: flex;
  flex-direction: column;
  background: var(--bg-base);
  color: var(--text-primary);
  font: 13px/1.5 -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
  overflow: hidden;
}

/* Toolbar */
.toolbar {
  display: flex;
  align-items: center;
  gap: 16px;
  height: 44px;
  padding: 0 14px;
  border-bottom: 1px solid var(--border-muted);
  -webkit-app-region: drag;
  padding-left: 78px; /* clear the hidden-titlebar traffic lights */
}
.tb-title {
  display: flex;
  align-items: center;
  gap: 8px;
  -webkit-app-region: no-drag;
}
.tb-branch {
  font-weight: 600;
  color: var(--text-bright);
}
.tb-track {
  display: flex;
  gap: 6px;
  color: var(--accent-fg);
  font-size: 12px;
}
.tb-actions {
  display: flex;
  gap: 4px;
  -webkit-app-region: no-drag;
}
.tb-btn {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 28px;
  padding: 0 10px;
  background: var(--bg-muted);
  color: var(--text-primary);
  border: 1px solid var(--border-default);
  border-radius: 6px;
  cursor: pointer;
  font-size: 12px;
}
.tb-btn:hover:not(:disabled) {
  background: var(--bg-hover-strong);
}
.tb-btn:disabled {
  opacity: 0.45;
  cursor: default;
}
.tb-btn .ic {
  font-size: 13px;
}
.tb-spacer {
  flex: 1;
}
.tb-busy {
  color: var(--text-secondary);
  font-size: 12px;
  -webkit-app-region: no-drag;
}

.err-bar {
  padding: 6px 14px;
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

/* Body layout */
.body {
  flex: 1;
  display: flex;
  min-height: 0;
}

/* Sidebar */
.sidebar {
  width: 220px;
  flex-shrink: 0;
  border-right: 1px solid var(--border-muted);
  overflow-y: auto;
  padding: 8px 0;
}
.sb-group {
  padding: 4px 0 8px;
}
.sb-group.muted {
  opacity: 0.75;
}
.sb-head {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 4px 12px;
  font-size: 10.5px;
  letter-spacing: 0.6px;
  color: var(--text-muted);
  font-weight: 600;
}
.sb-item {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  padding: 4px 12px;
  background: none;
  border: none;
  color: var(--text-primary);
  font-size: 12.5px;
  text-align: left;
  cursor: pointer;
}
.sb-item.row {
  cursor: pointer;
}
.sb-item.row:hover {
  background: var(--bg-subtle);
}
.sb-label {
  flex: 1;
  min-width: 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.sb-head-btn {
  margin-left: auto;
  background: none;
  border: none;
  color: var(--text-muted);
  font-size: 12px;
  cursor: pointer;
  padding: 0 4px;
  line-height: 1;
}
.sb-head-btn + .sb-head-btn {
  margin-left: 0;
}
.sb-head-btn:hover {
  color: var(--text-bright);
}
.sb-act {
  flex-shrink: 0;
  background: none;
  border: none;
  color: var(--text-muted);
  font-size: 12px;
  cursor: pointer;
  padding: 0 3px;
  line-height: 1;
  visibility: hidden;
}
.sb-item.row:hover .sb-act {
  visibility: visible;
}
.sb-act:hover {
  color: var(--text-bright);
}
.sb-act.danger:hover {
  color: var(--danger-bright);
}
button.sb-item:hover {
  background: var(--bg-subtle);
}
.sb-item.active {
  background: var(--bg-selected);
  color: var(--text-bright);
}
.sb-item.current {
  color: var(--accent-fg);
  font-weight: 600;
}
.sb-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--accent-fg);
  flex-shrink: 0;
}
.sb-badge {
  margin-left: auto;
  background: var(--bg-muted);
  border-radius: 9px;
  padding: 0 6px;
  font-size: 11px;
  color: var(--text-primary);
}
.sb-empty {
  padding: 2px 12px;
  color: var(--text-disabled);
  font-size: 12px;
}

/* Center column */
.center {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-width: 0;
}
.pane {
  flex: 1;
  overflow: auto;
  min-height: 0;
}
.pane.history-full {
  overflow: hidden;
}
.pane-loading,
.detail-loading,
.diff-empty,
.detail-empty {
  padding: 16px;
  color: var(--text-secondary);
}

/* History table */
.hist-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 12.5px;
}
.hist-table thead th {
  position: sticky;
  top: 0;
  background: var(--bg-base);
  text-align: left;
  padding: 6px 10px;
  color: var(--text-muted);
  font-weight: 600;
  border-bottom: 1px solid var(--border-muted);
  font-size: 11px;
}
.hist-row {
  cursor: pointer;
  border-bottom: 1px solid var(--border-muted);
}
.hist-row:hover {
  background: var(--bg-subtle);
}
.hist-row.selected {
  background: var(--bg-selected);
}
.hist-table td {
  padding: 5px 10px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.c-desc {
  max-width: 0;
  width: 100%;
}
.c-hash {
  color: var(--text-secondary);
}
.c-author {
  color: var(--text-secondary);
  max-width: 140px;
}
.c-date {
  color: var(--text-muted);
}
.ref-pill {
  display: inline-block;
  background: var(--accent-emphasis);
  color: var(--text-on-emphasis);
  border-radius: 8px;
  padding: 0 7px;
  font-size: 11px;
  margin-right: 5px;
}

/* Status view */
.status {
  padding: 8px 0;
  display: flex;
  flex-direction: column;
}
.status-group {
  padding-bottom: 10px;
}
.status-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 12px;
  font-size: 10.5px;
  letter-spacing: 0.6px;
  color: var(--text-muted);
  font-weight: 600;
}
.sg-btn {
  margin-left: auto;
  background: none;
  border: 1px solid var(--border-default);
  border-radius: 4px;
  color: var(--text-secondary);
  font-size: 10.5px;
  padding: 0 6px;
  cursor: pointer;
}
.sg-btn:hover {
  color: var(--text-bright);
  border-color: var(--border-strong);
}
.status-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 3px 12px;
  font-size: 12.5px;
  cursor: pointer;
}
.status-row:hover {
  background: var(--bg-subtle);
}
.status-row.conflict {
  background: var(--danger-subtle);
}
.st-path {
  flex: 1;
  min-width: 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.row-actions {
  display: flex;
  gap: 2px;
  flex-shrink: 0;
  visibility: hidden;
}
.status-row:hover .row-actions {
  visibility: visible;
}
.row-btn {
  background: none;
  border: 1px solid var(--border-default);
  border-radius: 4px;
  color: var(--text-secondary);
  font-size: 11px;
  padding: 0 5px;
  cursor: pointer;
  line-height: 1.5;
}
.row-btn:hover {
  color: var(--text-bright);
  border-color: var(--border-strong);
}
.row-btn.danger:hover {
  color: var(--danger-bright);
  border-color: var(--danger-bright);
}
.conflict-badge {
  color: var(--danger-bright);
}

/* Operation-in-progress banner */
.op-banner {
  display: flex;
  align-items: center;
  gap: 10px;
  margin: 0 12px 8px;
  padding: 6px 10px;
  border: 1px solid var(--attention-fg);
  border-radius: 6px;
  color: var(--attention-fg);
  font-size: 12px;
}
.op-abort {
  margin-left: auto;
  background: none;
  border: 1px solid var(--attention-fg);
  border-radius: 4px;
  color: var(--attention-fg);
  font-size: 11px;
  padding: 1px 8px;
  cursor: pointer;
}
.op-abort:hover {
  background: var(--bg-subtle);
}

/* Commit box */
.commit-box {
  margin-top: auto;
  padding: 10px 12px;
  border-top: 1px solid var(--border-muted);
}
.cb-input {
  width: 100%;
  resize: vertical;
  background: var(--bg-muted);
  color: var(--text-primary);
  border: 1px solid var(--border-default);
  border-radius: 6px;
  font: 12.5px/1.5 -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
  padding: 7px 9px;
}
.cb-input:focus {
  outline: none;
  border-color: var(--accent-focus);
}
.cb-actions {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 7px;
}
.cb-spacer {
  flex: 1;
}
.cb-btn {
  background: var(--bg-muted);
  color: var(--text-primary);
  border: 1px solid var(--border-default);
  border-radius: 6px;
  font-size: 12px;
  padding: 4px 10px;
  cursor: pointer;
}
.cb-btn:hover:not(:disabled) {
  background: var(--bg-hover-strong);
}
.cb-btn:disabled {
  opacity: 0.45;
  cursor: default;
}
.cb-btn.primary {
  background: var(--success-emphasis);
  color: var(--text-on-emphasis);
  border-color: var(--success-strong);
}
.cb-btn.primary:hover:not(:disabled) {
  background: var(--success-strong);
}

/* Branch diff view */
.branchdiff {
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.bd-pickers {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  border-bottom: 1px solid var(--border-muted);
}
.bd-select {
  background: var(--bg-muted);
  color: var(--text-primary);
  border: 1px solid var(--border-default);
  border-radius: 6px;
  font-size: 12px;
  padding: 3px 6px;
  max-width: 220px;
}
.bd-arrow {
  color: var(--text-muted);
}
.bd-body {
  flex: 1;
  min-height: 0;
  overflow: hidden;
  display: flex;
  flex-direction: column;
}
.bd-body > * {
  flex: 1;
  min-height: 0;
}

/* Repository config modal */
.cfg-backdrop {
  position: fixed;
  inset: 0;
  z-index: 9998;
  background: var(--shadow-scrim);
}
.cfg-modal {
  position: fixed;
  z-index: 9999;
  top: 16vh;
  left: 50%;
  transform: translateX(-50%);
  width: min(520px, 90vw);
  max-height: 68vh;
  overflow-y: auto;
  background: var(--bg-subtle);
  border: 1px solid var(--border-default);
  border-radius: 8px;
  padding: 14px 16px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.cfg-title {
  font-weight: 600;
  color: var(--text-bright);
  margin-bottom: 4px;
}
.cfg-empty {
  color: var(--text-secondary);
  font-size: 12.5px;
}
.cfg-row {
  display: flex;
  align-items: center;
  gap: 10px;
}
.cfg-key {
  width: 180px;
  flex-shrink: 0;
  font-size: 12px;
  color: var(--text-secondary);
}
.cfg-input {
  flex: 1;
  background: var(--bg-base);
  border: 1px solid var(--border-default);
  border-radius: 4px;
  color: var(--text-primary);
  font-size: 12.5px;
  padding: 5px 8px;
}
.cfg-input:focus {
  outline: none;
  border-color: var(--accent-focus);
}
.cfg-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 6px;
}
.st-badge {
  display: inline-flex;
  width: 16px;
  justify-content: center;
  color: var(--attention-fg);
  font-weight: 600;
}
.st-badge.staged {
  color: var(--success-fg);
}
.st-badge.new {
  color: var(--accent-fg);
}

/* Bottom detail (commit detail + diff) */
.detail {
  height: 44%;
  min-height: 160px;
  border-top: 1px solid var(--border-muted);
  display: flex;
}
.detail-left {
  width: 300px;
  flex-shrink: 0;
  border-right: 1px solid var(--border-muted);
  overflow: auto;
}
.dt-meta {
  padding: 10px 12px;
  border-bottom: 1px solid var(--border-muted);
}
.dt-subject {
  font-weight: 600;
  color: var(--text-bright);
  margin-bottom: 4px;
}
.dt-sub {
  color: var(--text-secondary);
  font-size: 12px;
}
.dt-back {
  margin-top: 8px;
  background: none;
  border: none;
  color: var(--accent-fg);
  font-size: 12px;
  cursor: pointer;
  padding: 0;
}
.dt-back:hover {
  text-decoration: underline;
}
.dt-files {
  padding: 6px 0;
}
.dt-file {
  padding: 3px 12px;
  font-size: 12px;
  cursor: pointer;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.dt-file:hover {
  background: var(--bg-subtle);
}
.dt-file.active {
  background: var(--bg-selected);
  color: var(--text-bright);
}
.detail-right {
  flex: 1;
  overflow: hidden;
  min-width: 0;
  display: flex;
  flex-direction: column;
}
.detail-right > .diff-pane {
  flex: 1;
  min-height: 0;
}

.mono {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}
</style>
