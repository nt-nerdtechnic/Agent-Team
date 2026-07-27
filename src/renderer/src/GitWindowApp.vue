<script setup lang="ts">
// GitWindowApp — the standalone Git client surface (SourceTree / Fork layout).
//
// Runs inside the isolated `navide.git` plugin WebContentsView (see
// src/renderer/plugins/git/). It reuses the existing `useGit` composable
// unchanged; the plugin build aliases its `useBackend` to the capability shim,
// so every git.* call is brokered over the host's shared WebSocket.
//
// This is the plugin-groundwork skeleton: a wide three-pane window
// (toolbar → sidebar → history/status + detail/diff) wired to real branches,
// history, status and per-commit diffs. Advanced surfaces (worktrees, config,
// AI commit, conflict resolution, credential askpass) are intentionally left as
// placeholders / follow-up — see the standalone-Git plugin plan.

import { ref, computed, onMounted } from 'vue'
import { useBackend } from './composables/useBackend'
import { useGit, type GitCommitDetail, type DiffBlameHunk } from './composables/useGit'

// The host sets ?workspace_path= when it loads this entry (frontendPluginManager
// gitQuery). A getter is what useGit expects.
const workspacePath = new URLSearchParams(window.location.search).get('workspace_path') ?? ''

const backend = useBackend()
const git = useGit(() => workspacePath, backend)

const {
  gitStatus,
  gitLog,
  gitBranches,
  gitStashes,
  gitRemotes,
  gitTags,
  isLoadingStatus,
  isLoadingLog,
  isFetching,
  isSyncing,
  gitError,
  loadStatus,
  loadLog,
  loadBranches,
  loadStashes,
  loadRemotes,
  loadTags,
  showCommit,
  commitFileDiff,
  diffBlame,
  fetchRemote,
  pullOnly,
  pushOnly,
  sync,
} = git

// ── View state ───────────────────────────────────────────────────────────────
type CenterView = 'history' | 'status'
const view = ref<CenterView>('history')

const selectedHash = ref<string>('')
const commitDetail = ref<GitCommitDetail | null>(null)
const selectedFile = ref<string>('')
const diffHunks = ref<DiffBlameHunk[]>([])
const isLoadingDetail = ref(false)
const isLoadingDiff = ref(false)

// ── External diff target (from the main GitPane) ─────────────────────────────
// The main process forwards a git_diff_* target (see window:openGit) so a file
// clicked in the main-window GitPane shows its diff in *this* window's panel
// rather than the mini-IDE. We read it on load and via nav.onOpenTarget.
interface ExternalDiff {
  name: string
  staged: boolean
  commit: string
  hunks: DiffBlameHunk[]
}
const externalDiff = ref<ExternalDiff | null>(null)
const isLoadingExternalDiff = ref(false)

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
  await Promise.all([loadLog(), loadBranches(), loadRemotes(), loadTags(), loadStashes()])
}

onMounted(() => {
  if (hasWorkspace.value) void refreshAll()
  // Initial diff target from the entry query, then incremental deliveries.
  void showDiffTarget(Object.fromEntries(new URLSearchParams(window.location.search)))
  const nav = (
    window as unknown as {
      nav?: { onOpenTarget?: (cb: (p: Record<string, string>) => void) => () => void }
    }
  ).nav
  nav?.onOpenTarget?.((p) => {
    void showDiffTarget(p)
  })
})

// ── Commit selection → detail → per-file diff ────────────────────────────────
async function selectCommit(hash: string): Promise<void> {
  selectedHash.value = hash
  selectedFile.value = ''
  diffHunks.value = []
  commitDetail.value = null
  isLoadingDetail.value = true
  try {
    commitDetail.value = await showCommit(hash)
  } finally {
    isLoadingDetail.value = false
  }
}

async function selectFile(filepath: string): Promise<void> {
  if (!selectedHash.value) return
  selectedFile.value = filepath
  isLoadingDiff.value = true
  try {
    diffHunks.value = await commitFileDiff(selectedHash.value, filepath)
  } finally {
    isLoadingDiff.value = false
  }
}

async function showDiffTarget(params: Record<string, string>): Promise<void> {
  const filepath = params['git_diff_filepath'] ?? ''
  if (!filepath) return
  const staged = params['git_diff_staged'] === 'true'
  const commit = params['git_diff_commit'] ?? ''
  externalDiff.value = { name: filepath, staged, commit, hunks: [] }
  isLoadingExternalDiff.value = true
  try {
    const hunks = commit
      ? await commitFileDiff(commit, filepath)
      : await diffBlame(filepath, staged)
    // Stale-guard: only apply if the target hasn't changed while awaiting.
    const cur = externalDiff.value
    if (cur && cur.name === filepath && cur.commit === commit) {
      cur.hunks = hunks
    }
  } finally {
    isLoadingExternalDiff.value = false
  }
}

function clearExternalDiff(): void {
  externalDiff.value = null
}

function lineClass(kind: DiffBlameHunk['lines'][number]['kind']): string {
  if (kind === '+') return 'dl-add'
  if (kind === '-') return 'dl-del'
  return 'dl-ctx'
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
      </div>
      <div class="tb-spacer" />
      <div v-if="busy" class="tb-busy">working…</div>
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
        </div>

        <div class="sb-group">
          <div class="sb-head">BRANCHES</div>
          <div v-for="b in localBranches" :key="b.name" class="sb-item static" :class="{ current: b.is_current }">
            <span class="sb-dot" />{{ b.name }}
          </div>
          <div v-if="!localBranches.length" class="sb-empty">—</div>
        </div>

        <div class="sb-group">
          <div class="sb-head">REMOTES</div>
          <div v-for="r in gitRemotes" :key="r.name" class="sb-item static">{{ r.name }}</div>
          <div v-if="!gitRemotes.length" class="sb-empty">—</div>
        </div>

        <div class="sb-group">
          <div class="sb-head">TAGS</div>
          <div v-for="t in gitTags" :key="t.name" class="sb-item static">{{ t.name }}</div>
          <div v-if="!gitTags.length" class="sb-empty">—</div>
        </div>

        <div class="sb-group">
          <div class="sb-head">STASHES</div>
          <div v-for="s in gitStashes" :key="s.ref" class="sb-item static" :title="s.message">
            {{ s.message || s.ref }}
          </div>
          <div v-if="!gitStashes.length" class="sb-empty">—</div>
        </div>

        <div class="sb-group muted">
          <div class="sb-head">REMOTE BRANCHES</div>
          <div v-for="b in remoteBranches" :key="b.name" class="sb-item static">{{ b.name }}</div>
          <div v-if="!remoteBranches.length" class="sb-empty">—</div>
        </div>
      </aside>

      <!-- Center + bottom detail -->
      <section class="center">
        <!-- History table -->
        <div v-if="view === 'history'" class="pane history">
          <div v-if="isLoadingLog && !gitLog.length" class="pane-loading">Loading history…</div>
          <table v-else class="hist-table">
            <thead>
              <tr>
                <th class="c-desc">Description</th>
                <th class="c-hash">Commit</th>
                <th class="c-author">Author</th>
                <th class="c-date">Date</th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="c in gitLog"
                :key="c.hash"
                class="hist-row"
                :class="{ selected: c.hash === selectedHash }"
                @click="selectCommit(c.hash)"
              >
                <td class="c-desc">
                  <span v-for="ref in c.branches" :key="ref" class="ref-pill">{{ ref }}</span>
                  {{ c.message }}
                </td>
                <td class="c-hash mono">{{ c.short_hash }}</td>
                <td class="c-author">{{ c.author }}</td>
                <td class="c-date">{{ shortDate(c.date) }}</td>
              </tr>
            </tbody>
          </table>
        </div>

        <!-- File status -->
        <div v-else class="pane status">
          <div class="status-group">
            <div class="status-head">STAGED ({{ gitStatus.staged.length }})</div>
            <div v-for="f in gitStatus.staged" :key="'s' + f.path" class="status-row">
              <span class="st-badge staged">{{ f.status }}</span>{{ f.path }}
            </div>
          </div>
          <div class="status-group">
            <div class="status-head">CHANGES ({{ gitStatus.unstaged.length + gitStatus.untracked.length }})</div>
            <div v-for="f in gitStatus.unstaged" :key="'u' + f.path" class="status-row">
              <span class="st-badge">{{ f.status }}</span>{{ f.path }}
            </div>
            <div v-for="f in gitStatus.untracked" :key="'n' + f.path" class="status-row">
              <span class="st-badge new">?</span>{{ f.path }}
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
              <div v-if="isLoadingExternalDiff" class="diff-loading">Loading diff…</div>
              <div v-else-if="!externalDiff.hunks.length" class="diff-empty">No changes.</div>
              <div v-else class="diff">
                <div class="diff-file mono">{{ externalDiff.name }}</div>
                <div v-for="(h, hi) in externalDiff.hunks" :key="hi" class="diff-hunk">
                  <div class="hunk-head mono">{{ h.header }}</div>
                  <div v-for="(l, li) in h.lines" :key="li" class="diff-line mono" :class="lineClass(l.kind)">
                    <span class="ln">{{ l.old_no ?? '' }}</span>
                    <span class="ln">{{ l.new_no ?? '' }}</span>
                    <span class="lc">{{ l.kind }}</span>
                    <span class="lt">{{ l.text }}</span>
                  </div>
                </div>
              </div>
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
              <div v-if="isLoadingDiff" class="diff-loading">Loading diff…</div>
              <div v-else-if="!selectedFile" class="diff-empty">Select a file to view its diff.</div>
              <div v-else class="diff">
                <div class="diff-file mono">{{ selectedFile }}</div>
                <div v-for="(h, hi) in diffHunks" :key="hi" class="diff-hunk">
                  <div class="hunk-head mono">{{ h.header }}</div>
                  <div v-for="(l, li) in h.lines" :key="li" class="diff-line mono" :class="lineClass(l.kind)">
                    <span class="ln">{{ l.old_no ?? '' }}</span>
                    <span class="ln">{{ l.new_no ?? '' }}</span>
                    <span class="lc">{{ l.kind }}</span>
                    <span class="lt">{{ l.text }}</span>
                  </div>
                </div>
              </div>
            </div>
          </template>
          <div v-else class="detail-empty">Select a commit to see its changes.</div>
        </div>
      </section>
    </div>
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
.sb-item.static {
  cursor: default;
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
.pane-loading,
.detail-loading,
.diff-loading,
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
}
.status-group {
  padding-bottom: 10px;
}
.status-head {
  padding: 4px 12px;
  font-size: 10.5px;
  letter-spacing: 0.6px;
  color: var(--text-muted);
  font-weight: 600;
}
.status-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 3px 12px;
  font-size: 12.5px;
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
  overflow: auto;
  min-width: 0;
}
.diff-file {
  padding: 8px 12px;
  color: var(--text-secondary);
  border-bottom: 1px solid var(--border-muted);
  position: sticky;
  top: 0;
  background: var(--bg-base);
}
.diff-hunk {
  border-bottom: 1px solid var(--border-muted);
}
.hunk-head {
  padding: 3px 12px;
  color: var(--accent-fg);
  background: var(--bg-subtle);
}
.diff-line {
  display: flex;
  font-size: 12px;
  white-space: pre;
}
.diff-line .ln {
  width: 44px;
  flex-shrink: 0;
  text-align: right;
  padding-right: 8px;
  color: var(--text-disabled);
  user-select: none;
}
.diff-line .lc {
  width: 16px;
  flex-shrink: 0;
  text-align: center;
  color: var(--text-muted);
}
.diff-line .lt {
  flex: 1;
}
.dl-add {
  background: var(--diff-add-bg);
}
.dl-add .lt {
  color: var(--diff-add-fg);
}
.dl-del {
  background: var(--diff-del-bg);
}
.dl-del .lt {
  color: var(--diff-del-fg);
}

.mono {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}
</style>
