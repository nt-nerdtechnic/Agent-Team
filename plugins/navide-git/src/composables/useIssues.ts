import { ref, watch, onScopeDispose } from 'vue'
import type { IssuePort } from '../ports/gitSurface'

// Cloud issues for the current repo. The backend auto-detects the host from the
// origin remote (GitHub via `gh`, GitLab via `glab`) and normalizes both into
// this single provider-agnostic schema, so the frontend never branches on
// provider. Unlike useGit, this composable is LAZY: nothing loads until the
// Issues card is first expanded (loadProvider/loadIssues), to avoid spawning a
// CLI for users who never open it. No background polling.

export type IssueProvider = 'github' | 'gitlab' | 'unknown'

export interface IssueProviderInfo {
  ok: boolean
  provider: IssueProvider
  host: string
  cli_available: boolean
  authenticated: boolean
  error: string
}

export interface IssueComment {
  author: string
  body: string
  created_at: string
}

export interface Issue {
  number: number
  title: string
  state: string // 'open' | 'closed'
  author: string
  labels: string[]
  assignees: string[]
  updated_at: string
  url: string
}

export interface IssueDetail extends Issue {
  body: string
  created_at: string
  comments: IssueComment[]
}

const emptyProvider = (): IssueProviderInfo => ({
  ok: false,
  provider: 'unknown',
  host: '',
  cli_available: false,
  authenticated: false,
  error: '',
})

export function useIssues(
  workspacePath: () => string,
  issuePort: IssuePort,
) {
  const provider = ref<IssueProviderInfo>(emptyProvider())
  const issues = ref<Issue[]>([])
  const selectedIssue = ref<IssueDetail | null>(null)
  const isLoadingProvider = ref(false)
  const isLoadingIssues = ref(false)
  const isLoadingDetail = ref(false)
  const isSubmitting = ref(false)
  const issuesError = ref('')
  const loadedOnce = ref(false)

  function clearIssuesError(): void { issuesError.value = '' }

  // Returns true only when the backend gave a definitive answer for the current
  // workspace. An empty workspace, a transient WS error, or a workspace that
  // changed mid-request all return false so callers can retry instead of
  // treating the initial `unknown` as final.
  async function loadProvider(): Promise<boolean> {
    const ws = workspacePath()
    if (!ws) { provider.value = emptyProvider(); return false }
    isLoadingProvider.value = true
    try {
      const resp = await issuePort.provider(ws)
      if (resp.ok && resp.payload && workspacePath() === ws) {
        provider.value = resp.payload
        return true
      }
      return false
    } catch {
      // transient WS error — caller decides whether to retry
      return false
    } finally {
      if (workspacePath() === ws) isLoadingProvider.value = false
    }
  }

  async function loadIssues(): Promise<void> {
    const ws = workspacePath()
    if (!ws) { issues.value = []; return }
    isLoadingIssues.value = true
    issuesError.value = ''
    try {
      const resp = await issuePort.list(ws, 30)
      if (workspacePath() !== ws) return
      const r = resp.payload
      if (resp.ok && r?.ok) {
        issues.value = r.issues ?? []
      } else {
        issues.value = []
        if (r?.error) issuesError.value = r.error
      }
      loadedOnce.value = true
    } catch (e) {
      issuesError.value = e instanceof Error ? e.message : String(e)
    } finally {
      if (workspacePath() === ws) isLoadingIssues.value = false
    }
  }

  /** Lazy entry point: called when the Issues card is first expanded. */
  async function ensureLoaded(): Promise<void> {
    if (loadedOnce.value) return
    // Don't lock `loadedOnce` on a failed/empty probe, or the card would stay
    // stuck on the initial `unknown` state forever (the caller only re-invokes
    // this on the next expand or workspace switch).
    if (!(await loadProvider())) return
    if (provider.value.provider !== 'unknown' && provider.value.authenticated) {
      await loadIssues()
    } else {
      loadedOnce.value = true
    }
  }

  async function refresh(): Promise<void> {
    await loadProvider()
    if (provider.value.provider !== 'unknown' && provider.value.authenticated) {
      await loadIssues()
    }
  }

  async function openIssue(number: number): Promise<void> {
    const ws = workspacePath()
    if (!ws) return
    isLoadingDetail.value = true
    issuesError.value = ''
    selectedIssue.value = null
    try {
      const resp = await issuePort.get(ws, number)
      if (workspacePath() !== ws) return
      const r = resp.payload
      if (resp.ok && r?.ok) selectedIssue.value = r.issue
      else if (r?.error) issuesError.value = r.error
    } catch (e) {
      issuesError.value = e instanceof Error ? e.message : String(e)
    } finally {
      if (workspacePath() === ws) isLoadingDetail.value = false
    }
  }

  function closeDetail(): void { selectedIssue.value = null }

  async function createIssue(title: string, body: string): Promise<{ ok: boolean; url?: string; error?: string }> {
    const ws = workspacePath()
    if (!ws) return { ok: false, error: 'no workspace' }
    if (!title.trim()) return { ok: false, error: 'title is required' }
    isSubmitting.value = true
    issuesError.value = ''
    try {
      const resp = await issuePort.create(ws, title, body)
      const r = resp.payload ?? { ok: false, error: 'no response' }
      if (r.ok) await loadIssues()
      else issuesError.value = r.error || 'create failed'
      return r
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      issuesError.value = msg
      return { ok: false, error: msg }
    } finally {
      isSubmitting.value = false
    }
  }

  async function addComment(number: number, body: string): Promise<{ ok: boolean; error?: string }> {
    const ws = workspacePath()
    if (!ws) return { ok: false, error: 'no workspace' }
    if (!body.trim()) return { ok: false, error: 'comment is required' }
    isSubmitting.value = true
    issuesError.value = ''
    try {
      const resp = await issuePort.comment(ws, number, body)
      const r = resp.payload ?? { ok: false, error: 'no response' }
      if (r.ok) await openIssue(number)
      else issuesError.value = r.error || 'comment failed'
      return r
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      issuesError.value = msg
      return { ok: false, error: msg }
    } finally {
      isSubmitting.value = false
    }
  }

  async function setState(number: number, state: 'open' | 'closed'): Promise<{ ok: boolean; error?: string }> {
    const ws = workspacePath()
    if (!ws) return { ok: false, error: 'no workspace' }
    isSubmitting.value = true
    issuesError.value = ''
    try {
      const resp = await issuePort.setState(ws, number, state)
      const r = resp.payload ?? { ok: false, error: 'no response' }
      if (r.ok) {
        await loadIssues()
        if (selectedIssue.value?.number === number) await openIssue(number)
      } else {
        issuesError.value = r.error || 'state change failed'
      }
      return r
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      issuesError.value = msg
      return { ok: false, error: msg }
    } finally {
      isSubmitting.value = false
    }
  }

  // Reset (but do NOT auto-load) when the workspace changes — stays lazy.
  const _stop = watch(workspacePath, () => {
    provider.value = emptyProvider()
    issues.value = []
    selectedIssue.value = null
    issuesError.value = ''
    loadedOnce.value = false
  })
  onScopeDispose(_stop)

  return {
    // state
    provider, issues, selectedIssue,
    isLoadingProvider, isLoadingIssues, isLoadingDetail, isSubmitting,
    issuesError, loadedOnce,
    clearIssuesError,
    // actions
    loadProvider, loadIssues, ensureLoaded, refresh,
    openIssue, closeDetail,
    createIssue, addComment, setState,
  }
}

export type IssueHandlerMode = 'guided' | 'auto'

// Build a kickoff prompt for a new dedicated agent pane that will handle the
// issue end-to-end. Pure function — no component dependencies.
// The issue list row has no body, so the agent is instructed to fetch full
// details itself via the provider CLI.
export function buildIssueKickoff(
  issue: Issue,
  provider: IssueProvider,
  mode: IssueHandlerMode,
): string {
  const isGitLab = provider === 'gitlab'
  const viewCmd = isGitLab ? `glab issue view ${issue.number}` : `gh issue view ${issue.number}`
  const closeCmd = isGitLab ? `glab issue close ${issue.number}` : `gh issue close ${issue.number}`

  const steps =
    mode === 'guided'
      ? `1. Run \`${viewCmd}\` to read the full description and comments.
2. Analyze the issue and the relevant code in this repository.
3. Propose a specific fix plan with file paths. **STOP here — do not modify any files until I approve.**
4. After receiving approval, implement the fix and run tests to verify.
5. Once verified, close the issue: \`${closeCmd} --comment "Fixed: <one-line summary>"\``
      : `1. Run \`${viewCmd}\` to read the full description and comments.
2. Analyze the issue and the relevant code in this repository.
3. Implement the fix and run tests to verify.
4. Close the issue: \`${closeCmd} --comment "Fixed: <one-line summary>"\`

Work autonomously end-to-end. No approval checkpoint needed.`

  return `You are an autonomous agent working on Issue #${issue.number}: "${issue.title}".

## Your Task
${steps}`
}

// Format an issue as the task text injected into a running agent pane. Pure so
// it can be unit-tested without a component. No role/protocol preamble — the
// target agent is already running with its own context.
export function formatIssueForDispatch(issue: IssueDetail): string {
  const parts: string[] = [
    'Please work on this issue:',
    '',
    `#${issue.number} ${issue.title}`,
  ]
  if (issue.body.trim()) {
    parts.push('', issue.body.trim())
  }
  if (issue.comments.length) {
    parts.push('', '--- comments ---')
    for (const c of issue.comments) {
      parts.push(`${c.author}: ${c.body}`)
    }
  }
  if (issue.url) {
    parts.push('', `Link: ${issue.url}`)
  }
  return parts.join('\n')
}
