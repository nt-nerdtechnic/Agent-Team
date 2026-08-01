<script setup lang="ts">
// GitWindowApp — the standalone Git client surface (SourceTree / Fork layout).
//
// Runs inside the isolated `navide.git` plugin WebContentsView (see
// src/renderer/plugins/git/). It reuses the existing `useGit` composable
// unchanged; the plugin build aliases its `useBackend` to the capability shim,
// so every git.* call is brokered over the host's shared WebSocket.
//
// A wide three-pane window (toolbar → sidebar → center + diff detail). The
// center's File-status surface embeds the real GitPane component, so working-
// tree operations (multi-select stage/unstage, commit box with AI message,
// conflict handling, credential prompt) are byte-identical to the main
// window's Git tab and never drift from it. Around it: SourceTree-style
// sidebar (branch/stash/remote/tag/worktree management), rich history, branch
// comparison, git config, and a bottom DiffPane detail. "Open in editor"
// routes through the `ui.open_in_editor` host capability to the mini-IDE
// plugin (OS default app when it is not installed). The full 3-way conflict
// editor stays in the mini-IDE (Monaco is deliberately kept out of this
// bundle).

import { ref, computed, onMounted, onUnmounted } from 'vue'
import { useBackend } from './composables/useBackend'
import { useGit } from './composables/useGit'
import { useNotify } from './composables/useNotify'
import { useTheme } from './composables/useTheme'
import { initSettingsBackend, settingsGet, onSettingsChanged } from './lib/settings'
import GitPane from './components/GitPane.vue'
import GitHistoryModal from './components/GitHistoryModal.vue'
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
  gitConfig,
  gitConfigAllowedKeys,
  loadGitConfig,
  setGitConfig
} = git

// ── View state ───────────────────────────────────────────────────────────────
type CenterView = 'history' | 'status' | 'branchdiff'
const view = ref<CenterView>('history')

// ── Diff detail target ───────────────────────────────────────────────────────
// Shown in the bottom detail panel of the File-status view. Fed by (a) the
// embedded GitPane's open-diff clicks, and (b) the main process forwarding a
// git_diff_* target (see window:openGit) when a file is clicked in the main
// window's GitPane. The shared DiffPane fetches the diff itself from these
// coordinates.
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

// ── Embedded GitPane integration ─────────────────────────────────────────────
// AI commit-message model, live-synced with the main window's setting.
const analyzerModel = ref(settingsGet('agentTeam.analyzerModel', ''))

/** A file clicked in the embedded GitPane shows its diff in the bottom detail. */
function onPaneOpenDiff(p: { filepath: string; staged: boolean; name: string; commit?: string }): void {
  externalDiff.value = { name: p.filepath, staged: p.staged, commit: p.commit ?? '' }
}

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

function onPaneOpenBranchDiff(p: { base: string; compare: string }): void {
  if (p.base) diffBase.value = p.base
  if (p.compare) diffCompare.value = p.compare
  openBranchDiff()
}
// ── Sidebar operations (GitPane-style sections) ──────────────────────────────
// Collapse state per card, mirroring GitPane's collapsible cards.
const branchesExpanded = ref(true)
const stashesExpanded = ref(false)
const remotesExpanded = ref(false)
const tagsExpanded = ref(false)
const worktreesExpanded = ref(false)
// Remote branches live inside the branch card behind the ⇅ toggle (GitPane).
const showRemoteBranches = ref(false)

// Inline-create inputs (GitPane's input-row pattern instead of prompt dialogs).
const newBranchName = ref('')
const newRemoteName = ref('')
const newRemoteUrl = ref('')
const newTagName = ref('')
const newTagMessage = ref('')
const newWtPath = ref('')
const newWtBranch = ref('')

// Switching is an explicit ↵ row button (GitPane doSwitch) — never a row click.
async function onSwitchBranch(name: string): Promise<void> {
  if (name === gitStatus.value.branch) return
  toastResult(await switchBranch(name), `Switched to ${name}`)
}
async function doCreateBranch(): Promise<void> {
  const name = newBranchName.value.trim()
  if (!name) return
  if (toastResult(await createBranch(name), `Created ${name}`)) newBranchName.value = ''
}
function doCompareBranch(name: string): void {
  diffBase.value = name
  diffCompare.value = gitStatus.value.branch
  view.value = 'branchdiff'
}
async function doMergeIntoCurrent(name: string): Promise<void> {
  toastResult(await mergeBranch(name), `Merged ${name}`)
}
async function doRebaseOnto(name: string): Promise<void> {
  toastResult(await rebaseOn(name), `Rebased onto ${name}`)
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

async function onDeleteTag(name: string): Promise<void> {
  const ok = await notify.confirm(`Delete tag ${name}?`, {
    title: 'Delete tag',
    confirmText: 'Delete'
  })
  if (!ok) return
  toastResult(await deleteTag(name))
}
async function doCreateTag(): Promise<void> {
  const name = newTagName.value.trim()
  if (!name) return
  if (toastResult(await createTag(name, newTagMessage.value.trim()), `Tagged ${name}`)) {
    newTagName.value = ''
    newTagMessage.value = ''
  }
}

// ── Worktrees ────────────────────────────────────────────────────────────────
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

        <!-- ── BRANCHES (GitPane branch panel: explicit ↵ switch, never row click) ── -->
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
            <div v-for="b in localBranches" :key="b.name" class="branch-row" :class="{ current: b.is_current }">
              <span class="b-check">{{ b.is_current ? '✓' : '' }}</span>
              <span class="b-name">{{ b.name }}</span>
              <span v-if="b.tracking" class="b-track">→ {{ b.tracking }}</span>
              <div class="spacer" />
              <template v-if="!b.is_current">
                <button class="row-btn always" title="Compare" @click.stop="doCompareBranch(b.name)">⇔</button>
                <button class="row-btn always" title="Rebase current onto" @click.stop="doRebaseOnto(b.name)">⇡</button>
                <button class="row-btn always" title="Merge into current" @click.stop="doMergeIntoCurrent(b.name)">⇣</button>
                <button class="row-btn always" title="Switch" @click.stop="onSwitchBranch(b.name)">↵</button>
                <button class="row-btn always danger" title="Delete branch" @click.stop="onDeleteBranch(b.name)">✕</button>
              </template>
            </div>
            <div v-if="!localBranches.length" class="empty-msg">No branches</div>
            <template v-if="showRemoteBranches">
              <div class="branch-section-label">Remote branches</div>
              <div v-if="!remoteBranches.length" class="empty-msg">No remote branches</div>
              <div
                v-for="b in remoteBranches"
                :key="b.name"
                class="branch-row"
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
          </div>
        </div>

        <!-- ── STASHES ── -->
        <div class="git-card">
          <div class="card-hdr clickable" @click="stashesExpanded = !stashesExpanded">
            <span class="sec-caret">{{ stashesExpanded ? '▾' : '▸' }}</span>
            <span class="sec-label">Stashes</span>
            <span v-if="gitStashes.length" class="sec-badge">{{ gitStashes.length }}</span>
            <div class="spacer" />
            <button class="sec-btn" title="Stash working changes" @click.stop="onStashPush">＋</button>
          </div>
          <div v-if="stashesExpanded" class="card-body collapsible-body">
            <div v-if="!gitStashes.length" class="empty-msg">No stashes</div>
            <div v-for="s in gitStashes" :key="s.ref" class="generic-row">
              <span class="stash-ref">{{ s.ref }}</span>
              <span class="stash-msg">{{ s.message }}</span>
              <div class="row-actions always">
                <button class="row-btn always" title="Apply (keep stash)" @click.stop="onStashApply(s.index)">⎘</button>
                <button class="row-btn always" title="Pop (apply &amp; remove)" @click.stop="onStashPop(s.index)">↑</button>
                <button class="row-btn always danger" title="Drop" @click.stop="onStashDrop(s.index)">✕</button>
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
            </div>
            <div v-for="wt in gitWorktrees" :key="wt.path" class="generic-row">
              <span class="wt-icon">{{ wt.is_main ? '✦' : '○' }}</span>
              <div style="flex: 1; min-width: 0">
                <div class="wt-name-row">
                  <span class="b-name" :title="wt.path">{{ wt.path.split('/').at(-1) }}</span>
                  <span v-if="wt.detached" class="wt-badge">detached</span>
                  <span v-if="wt.locked" class="wt-badge warn" :title="wt.lock_reason">🔒</span>
                  <span v-if="wt.prunable" class="wt-badge warn" :title="wt.prune_reason">⚠</span>
                </div>
                <div class="b-track">{{ wt.branch || wt.head.slice(0, 8) }}</div>
              </div>
              <button
                v-if="!wt.is_main"
                class="row-btn always danger"
                title="Remove worktree"
                @click.stop="onRemoveWorktree(wt.path)"
              >✕</button>
            </div>
            <div class="input-row" style="margin-top: 6px">
              <input v-model="newWtPath" class="git-input" placeholder="/absolute/path" style="flex: 2" />
              <input v-model="newWtBranch" class="git-input" placeholder="branch" style="flex: 1" />
              <button class="btn-ghost sm" :disabled="!newWtPath.trim() || !newWtBranch.trim()" @click="doAddWorktree">＋</button>
            </div>
          </div>
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

        <!-- File status: the real GitPane, identical to the main window's Git
             tab. v-show (not v-if) keeps it mounted across view switches so
             its state and credential modal stay alive. -->
        <div v-show="view === 'status'" class="status-wrap">
          <div class="pane gitpane-host">
            <GitPane
              :workspace-path="workspacePath"
              :backend="backend"
              :analyzer-model="analyzerModel"
              embedded
              @open-file="(p) => openInEditor(p.filepath)"
              @open-conflict="(p) => openInEditor(p.filepath)"
              @open-diff="onPaneOpenDiff"
              @open-branch-diff="onPaneOpenBranchDiff"
            />
          </div>

          <!-- Bottom: per-file diff detail -->
          <div v-if="externalDiff" class="detail">
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
                <button class="dt-back" @click="openInEditor(externalDiff.name)">Open in editor</button>
                <button class="dt-back" @click="clearExternalDiff">✕ close diff</button>
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
                @open-file="(p) => openInEditor(p.filepath)"
              />
            </div>
          </div>
        </div>
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

    <!-- The askpass credential modal lives inside the embedded GitPane (always
         mounted via v-show), so a toolbar push/pull waiting on credentials is
         answered there. -->
    <!-- Renders useNotify toasts/dialogs (GitPane/DiffPane feedback). -->
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
  width: 270px;
  flex-shrink: 0;
  border-right: 1px solid var(--border-muted);
  overflow-y: auto;
  padding: 8px 0;
}
.sb-group {
  padding: 4px 0 8px;
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
/* ── GitPane-copied section vocabulary (keep in sync with GitPane.vue) ─────── */
.spacer { flex: 1; }
.empty-msg { color: var(--text-muted); font-size: 11px; font-style: italic; padding: 3px 8px 6px; }
.chash { font-size: 10px; color: var(--text-muted); font-family: monospace; background: transparent; }

.git-card {
  margin: 6px 8px;
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
.sec-btn {
  display: flex; align-items: center; justify-content: center;
  width: 20px; height: 20px; background: transparent; border: none;
  border-radius: 3px; color: var(--text-muted); cursor: pointer; font-size: 12px; padding: 0;
}
.sec-btn:hover { color: var(--text-primary); background: var(--bg-hover); }

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

.generic-row {
  display: flex; align-items: center; gap: 6px;
  padding: 3px 0; font-size: 11px;
}
.generic-row:hover { background: var(--bg-hover-faint); }
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

button.sb-item:hover {
  background: var(--bg-subtle);
}
.sb-item.active {
  background: var(--bg-selected);
  color: var(--text-bright);
}
.sb-badge {
  margin-left: auto;
  background: var(--bg-muted);
  border-radius: 9px;
  padding: 0 6px;
  font-size: 11px;
  color: var(--text-primary);
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
.diff-empty {
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

/* File-status wrapper: embedded GitPane on top, diff detail below */
.status-wrap {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-height: 0;
}
.gitpane-host {
  flex: 1;
  min-height: 0;
  overflow: hidden;
  display: flex;
  flex-direction: column;
}
.gitpane-host > * {
  flex: 1;
  min-height: 0;
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
