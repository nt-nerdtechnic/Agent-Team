<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted, nextTick, reactive } from 'vue'
import { i18n } from '../i18n'
import { settingsGet, settingsSet } from '../lib/settings'
import { parseLegacyThreads } from '../lib/chatLegacy'
import { CLI_CONTEXT_MIME, PANE_ID_MIME, CLI_SOURCE_PREFIX, resolveCliDropPayload, buildCliContextChip, screenToClientPoint, type CliContextPayload } from '../lib/cliContext'
import type { useBackend } from '../composables/useBackend'
import { allDiagnosticsSorted } from '../editor/diagnostics'
import mermaid from 'mermaid'
import katex from 'katex'
import 'katex/dist/katex.min.css'
import hljs from 'highlight.js/lib/core'
import javascript from 'highlight.js/lib/languages/javascript'
import typescript from 'highlight.js/lib/languages/typescript'
import python from 'highlight.js/lib/languages/python'
import bash from 'highlight.js/lib/languages/bash'
import json from 'highlight.js/lib/languages/json'
import css from 'highlight.js/lib/languages/css'
import xml from 'highlight.js/lib/languages/xml'
import rust from 'highlight.js/lib/languages/rust'
import go from 'highlight.js/lib/languages/go'
import java from 'highlight.js/lib/languages/java'
import cpp from 'highlight.js/lib/languages/cpp'
import markdown from 'highlight.js/lib/languages/markdown'
import sql from 'highlight.js/lib/languages/sql'
import yaml from 'highlight.js/lib/languages/yaml'

hljs.registerLanguage('javascript', javascript)
hljs.registerLanguage('js', javascript)
hljs.registerLanguage('jsx', javascript)
hljs.registerLanguage('typescript', typescript)
hljs.registerLanguage('ts', typescript)
hljs.registerLanguage('tsx', typescript)
hljs.registerLanguage('python', python)
hljs.registerLanguage('py', python)
hljs.registerLanguage('bash', bash)
hljs.registerLanguage('sh', bash)
hljs.registerLanguage('shell', bash)
hljs.registerLanguage('zsh', bash)
hljs.registerLanguage('json', json)
hljs.registerLanguage('css', css)
hljs.registerLanguage('xml', xml)
hljs.registerLanguage('html', xml)
hljs.registerLanguage('vue', xml)
hljs.registerLanguage('rust', rust)
hljs.registerLanguage('rs', rust)
hljs.registerLanguage('go', go)
hljs.registerLanguage('java', java)
hljs.registerLanguage('cpp', cpp)
hljs.registerLanguage('c', cpp)
hljs.registerLanguage('markdown', markdown)
hljs.registerLanguage('md', markdown)
hljs.registerLanguage('sql', sql)
hljs.registerLanguage('yaml', yaml)
hljs.registerLanguage('yml', yaml)

const props = defineProps<{
  workspacePath: string
  backend: ReturnType<typeof useBackend>
  embedded?: boolean
  active?: boolean
  getEditorContent?: () => string
  getEditorSelection?: () => string
  getActiveRelPath?: () => string
  getOpenFiles?: () => string[]
  insertTextAtCursor?: (text: string) => void
  openFile?: (relPath: string, line?: number) => void
}>()

// ── Message types ──────────────────────────────────────────────────────────────
interface ToolCallCard {
  kind: 'tool_call'
  tool_id: string
  tool_name: string
  tool_input: unknown
  result?: string
  collapsed: boolean
}

interface ChatMessage {
  role: 'user' | 'assistant'
  content: string
  rawContent?: string | unknown[]  // full content sent to AI (includes @chip file/git content, or multimodal array)
  streaming?: boolean
  thinking?: boolean   // true until first chunk arrives
  model?: string
  timestamp?: number       // ms since epoch
  sendMs?: number          // when user sent this message (to compute TTFT)
  responseStartMs?: number // when first chunk arrived
  ttftMs?: number          // time-to-first-token in ms
  elapsedMs?: number       // total response duration in ms
  inputTokens?: number     // from backend usage data
  outputTokens?: number    // from backend usage data
  isError?: boolean        // true when last chunk was an error
  errorMsg?: string
  cards?: ToolCallCard[]
  bookmarked?: boolean
  feedback?: 'up' | 'down'
  feedbackComment?: string
  commitMsg?: string   // detected conventional-commit message
  followUps?: string[] // suggested follow-up questions (shown below response)
  pendingEdits?: Array<{ relPath: string; code: string }> // detected file edits from Edit mode
  thinkingContent?: string // extended thinking (Claude thinking blocks)
  thinkingExpanded?: boolean
  contextRefs?: string[]   // labels of context chips used when this message was sent (Cursor-style "used references")
  imageData?: string       // pasted image thumbnail for user messages
  truncated?: boolean      // response appears to be cut off (unclosed code block heuristic)
  pinned?: boolean         // message pinned for easy reference
}

// ── Checkpoint (Cursor-style conversation snapshots) ──────────────────────────
interface ChatCheckpoint {
  id: string
  name: string
  timestamp: number
  messagesSnapshot: ChatMessage[]
}

type ShellPayload = { ok: boolean; output?: string; exit_code?: number; error?: string }
type ReadPayload = { ok?: boolean; content?: string; error?: string }
type LegacyApi = { invoke(channel: string, payload?: unknown): Promise<unknown> }

function messageText(msg: ChatMessage): string {
  return typeof msg.rawContent === 'string' ? msg.rawContent : msg.content
}

function legacyInvoke(channel: string, payload?: unknown): Promise<unknown> {
  const api = (window as unknown as { api?: LegacyApi }).api
  if (!api) return Promise.reject(new Error('legacy api unavailable'))
  return api.invoke(channel, payload)
}

// ── State ──────────────────────────────────────────────────────────────────────
const messages = ref<ChatMessage[]>([])
const checkpoints = ref<ChatCheckpoint[]>([])
const showCheckpoints = ref(false)
const inputText = ref('')
const inputHistory: string[] = []
let historyIdx = -1
let historySavedDraft = ''  // input text saved before first ArrowUp
let _navAssistIdx = -1     // index into assistant messages for Alt+Up/Down navigation
const sending = ref(false)
const currentSessionId = ref<string | null>(null)

// ── Voice input (Web Speech API) ───────────────────────────────────────────────
interface _SR { continuous: boolean; interimResults: boolean; lang: string; onresult: ((e: Event) => void) | null; onend: (() => void) | null; onerror: (() => void) | null; start(): void; stop(): void }
const voiceListening = ref(false)
let _speechRecognition: _SR | null = null
const voiceSupported = typeof window !== 'undefined' && ('SpeechRecognition' in window || 'webkitSpeechRecognition' in window)
const speechSynthesisAvailable = typeof window !== 'undefined' && 'speechSynthesis' in window
const enhancingPrompt = ref(false)

function toggleVoiceInput(): void {
  if (!voiceSupported) { showToast('Voice input not supported in this environment'); return }
  if (voiceListening.value) {
    _speechRecognition?.stop()
    voiceListening.value = false
    return
  }
  type SpeechRecognitionCtor = new () => _SR
  const win = window as unknown as Record<string, unknown>
  const SpeechRecognitionCtor = (win['SpeechRecognition'] ?? win['webkitSpeechRecognition']) as SpeechRecognitionCtor
  _speechRecognition = new SpeechRecognitionCtor()
  _speechRecognition.continuous = false
  _speechRecognition.interimResults = true
  _speechRecognition.lang = navigator.language || 'en-US'
  let interimText = ''
  _speechRecognition.onresult = (e: Event) => {
    const se = e as unknown as { resultIndex: number; results: SpeechRecognitionResultList }
    let interim = '', final = ''
    for (let i = se.resultIndex; i < se.results.length; i++) {
      const t = se.results[i][0].transcript
      if (se.results[i].isFinal) final += t
      else interim += t
    }
    if (final) {
      inputText.value = inputText.value.slice(0, inputText.value.length - interimText.length) + final + ' '
      interimText = ''
    } else {
      inputText.value = inputText.value.slice(0, inputText.value.length - interimText.length) + interim
      interimText = interim
    }
  }
  _speechRecognition.onend = () => { voiceListening.value = false; interimText = '' }
  _speechRecognition.onerror = () => { voiceListening.value = false; interimText = '' }
  _speechRecognition.start()
  voiceListening.value = true
  nextTick(() => textareaEl.value?.focus())
}

async function enhancePrompt(): Promise<void> {
  const draft = inputText.value.trim()
  if (!draft || enhancingPrompt.value) return
  enhancingPrompt.value = true
  try {
    const systemMsg = 'You are a prompt-engineering assistant. Rewrite the user\'s draft message to be clearer, more specific, and more likely to get a helpful AI response. Keep the same intent. Output ONLY the improved prompt text, nothing else.'
    const resp = await props.backend.send<{ ok: boolean; content?: string; error?: string }>('ai.enhance_prompt', {
      system: systemMsg,
      prompt: draft,
    })
    if (resp.payload?.ok && resp.payload.content) {
      inputText.value = resp.payload.content
      nextTick(() => textareaEl.value?.focus())
      showToast('Prompt enhanced')
    } else {
      showToast(resp.payload?.error ?? 'Enhancement failed')
    }
  } catch {
    showToast('Enhancement failed')
  } finally {
    enhancingPrompt.value = false
  }
}
const messagesEl = ref<HTMLElement | null>(null)
const textareaEl = ref<HTMLTextAreaElement | null>(null)
const imageFileInputEl = ref<HTMLInputElement | null>(null)
const showSettings = ref(false)
const showShortcuts = ref(false)
const autoScroll = ref(true)
// Per-thread scroll position memory
const threadScrollPositions = new Map<string, number>()
// Thread unread tracking: threadId → timestamp of last visit (reactive so badge updates on switch)
const threadLastVisited = reactive<Record<string, number>>((() => {
  try {
    const raw = settingsGet<string | null>('ai-thread-last-visited', null)
    if (!raw) return {}
    return Object.fromEntries(JSON.parse(raw) as [string, number][])
  } catch { return {} }
})())
function _saveLastVisited(): void {
  settingsSet('ai-thread-last-visited', JSON.stringify(Object.entries(threadLastVisited)))
}
function threadUnreadCount(thread: ChatThread): number {
  const lastSeen = threadLastVisited[thread.id] ?? 0
  return thread.messages.filter((m) => m.role === 'assistant' && (m.timestamp ?? 0) > lastSeen).length
}
const toastMsg = ref('')
let toastTimer: number | null = null
let saveTimer: number | null = null
const streamNow = ref(Date.now())
let streamTickInterval: number | null = null
const nowMinute = ref(Date.now())
let _nowMinuteInterval: number | null = null

// Holds messages to re-append after a /compact summary finishes streaming
const pendingCompactKeep = ref<ChatMessage[]>([])
// Holds ALL pre-compact messages so stopStreaming() can restore them on user abort
const pendingCompactAllMessages = ref<ChatMessage[]>([])

// ── Prompt Templates Library (Cursor "Saved Prompts" parity) ─────────────────
interface PromptTemplate { id: string; name: string; text: string }
const showPromptTemplates = ref(false)
const promptTemplates = ref<PromptTemplate[]>(
  (() => { try { return JSON.parse(settingsGet('ai-chat-prompt-templates', '[]')) } catch { return [] } })()
)

// Built-in starter templates shown when library is empty
const DEFAULT_PROMPT_TEMPLATES: PromptTemplate[] = [
  { id: 'pt-review',   name: 'Code Review',     text: 'Review this code for bugs, security issues, and improvements:\n\n```\n\n```' },
  { id: 'pt-tests',    name: 'Write Tests',      text: 'Write comprehensive unit tests for the following code, covering edge cases:\n\n```\n\n```' },
  { id: 'pt-explain',  name: 'Explain Code',     text: 'Explain this code step by step, as if teaching a junior developer:\n\n```\n\n```' },
  { id: 'pt-refactor', name: 'Refactor',         text: 'Refactor this code for better readability and maintainability, preserving all behavior:\n\n```\n\n```' },
  { id: 'pt-optimize', name: 'Optimize',         text: 'Analyze this code for performance bottlenecks and suggest optimizations with time/space complexity notes:\n\n```\n\n```' },
  { id: 'pt-docs',     name: 'Generate Docs',    text: 'Write clear, concise documentation for this code including parameters, return values, and usage examples:\n\n```\n\n```' },
  { id: 'pt-security', name: 'Security Audit',   text: 'Perform a security audit of this code. Look for OWASP Top 10 vulnerabilities, injection risks, and authentication issues:\n\n```\n\n```' },
]

function savePromptTemplates(): void {
  settingsSet('ai-chat-prompt-templates', JSON.stringify(promptTemplates.value))
}

function addPromptTemplate(): void {
  const name = inputText.value.trim().slice(0, 40) || 'New template'
  const text = inputText.value.trim() || ''
  const tmpl: PromptTemplate = { id: `pt-${Date.now()}`, name, text }
  promptTemplates.value = [tmpl, ...promptTemplates.value]
  savePromptTemplates()
  showToast(`Saved: "${tmpl.name}"`)
}

function usePromptTemplate(t: PromptTemplate): void {
  inputText.value = t.text
  showPromptTemplates.value = false
  nextTick(() => textareaEl.value?.focus())
}

function deletePromptTemplate(id: string): void {
  promptTemplates.value = promptTemplates.value.filter((t) => t.id !== id)
  savePromptTemplates()
}

function renamePromptTemplate(t: PromptTemplate, newName: string): void {
  if (!newName.trim()) return
  t.name = newName.trim()
  savePromptTemplates()
}

const displayedTemplates = computed(() =>
  promptTemplates.value.length > 0 ? promptTemplates.value : DEFAULT_PROMPT_TEMPLATES
)

// ── Memories (Cursor-style persistent facts, injected into every system prompt) ─
const MEMORIES_KEY = 'ai-chat-memories'
const memories = ref<string[]>(
  (() => { try { return JSON.parse(settingsGet(MEMORIES_KEY, '[]')) } catch { return [] } })()
)
watch(memories, (v) => { settingsSet(MEMORIES_KEY, JSON.stringify(v)) }, { deep: true })
function addMemory(fact: string): void { const f = fact.trim(); if (f && !memories.value.includes(f)) { memories.value.push(f) } }
function removeMemory(idx: number): void { memories.value.splice(idx, 1) }

// ── Global Context Pins (Cursor-style always-include files, cross-session) ──────
interface GlobalContextPin { id: string; label: string; relPath: string }
const GLOBAL_CTX_KEY = 'ai-chat-global-context-pins'
const globalContextPins = ref<GlobalContextPin[]>((() => {
  try { return JSON.parse(settingsGet(GLOBAL_CTX_KEY, '[]')) as GlobalContextPin[] }
  catch { return [] }
})())
watch(globalContextPins, (v) => {
  settingsSet(GLOBAL_CTX_KEY, JSON.stringify(v))
}, { deep: true })
function addGlobalPin(relPath: string): void {
  const label = `@${relPath.split('/').pop()}`
  if (!globalContextPins.value.some((p) => p.relPath === relPath)) {
    globalContextPins.value.push({ id: crypto.randomUUID(), label, relPath })
  }
}
function removeGlobalPin(id: string): void {
  globalContextPins.value = globalContextPins.value.filter((p) => p.id !== id)
}

// ── Notepads (persistent context notes, always injected into system prompt) ───
interface Notepad { id: string; name: string; content: string; updatedAt: number; pinned?: boolean }
const showNotes = ref(false)
// Legacy localStorage keys — read only by the one-time per-workspace migration.
const notesKey = computed(() => `ai-chat-notes:${props.workspacePath}`)
const notepadKey = computed(() => `ai-chat-notepads:${props.workspacePath}`)
const notesContent = ref('')
const namedNotepads = ref<Notepad[]>([])
const activeNotepadId = ref<string | null>(null)
// Guards persistNotes until the backend chat-notes.json document has been
// loaded — an early save would overwrite real data with the empty placeholder.
let notesHydrated = false
let notesLoadSeq = 0

async function loadNotes(): Promise<void> {
  const seq = ++notesLoadSeq
  notesHydrated = false
  notesContent.value = ''
  namedNotepads.value = []
  const ws = props.workspacePath
  if (!ws) return
  const legacyNotesKey = notesKey.value
  const legacyPadsKey = notepadKey.value
  try {
    const resp = await props.backend.send<{ notes?: string; notepads?: Notepad[] }>(
      'ai.chat.notes.get', { workspace_path: ws }
    )
    if (seq !== notesLoadSeq || !resp.ok) return
    const notes = typeof resp.payload?.notes === 'string' ? resp.payload.notes : ''
    const pads = Array.isArray(resp.payload?.notepads) ? resp.payload.notepads : []
    notesHydrated = true
    if (notes || pads.length > 0) {
      notesContent.value = notes
      namedNotepads.value = pads
      // Backend already owns the data — clear any leftover legacy copies.
      try { localStorage.removeItem(legacyNotesKey); localStorage.removeItem(legacyPadsKey) } catch { /* ignore */ }
      return
    }
    // Backend document empty → one-time per-workspace localStorage migration.
    let legacyNotes: string | null = null
    let legacyPadsRaw: string | null = null
    try {
      legacyNotes = localStorage.getItem(legacyNotesKey)
      legacyPadsRaw = localStorage.getItem(legacyPadsKey)
    } catch { return }
    if (legacyNotes === null && legacyPadsRaw === null) return
    let legacyPads: Notepad[] = []
    try {
      const parsed = JSON.parse(legacyPadsRaw ?? '[]') as Notepad[]
      if (Array.isArray(parsed)) legacyPads = parsed
    } catch { legacyPads = [] }
    notesContent.value = legacyNotes ?? ''
    namedNotepads.value = legacyPads
    const ack = await props.backend.send<{ ok?: boolean }>('ai.chat.notes.set', {
      workspace_path: ws,
      notes: legacyNotes ?? '',
      notepads: legacyPads,
    })
    // Ack-gated delete: keep the localStorage copies (retried next load) on failure.
    if (ack.ok && ack.payload?.ok === true) {
      try { localStorage.removeItem(legacyNotesKey); localStorage.removeItem(legacyPadsKey) } catch { /* ignore */ }
    }
  } catch { /* backend unavailable — stay unhydrated so saves can't clobber */ }
}
watch(() => props.workspacePath, () => { void loadNotes() }, { immediate: true })

function persistNotes(): void {
  const ws = props.workspacePath
  if (!ws || !notesHydrated) return
  props.backend.send('ai.chat.notes.set', {
    workspace_path: ws,
    notes: notesContent.value,
    notepads: namedNotepads.value,
  }).catch(() => { /* transient; the next save retries */ })
}
function saveNotes(): void { persistNotes() }
function saveNamedNotepads(): void { persistNotes() }
function createNotepad(name: string): Notepad {
  const np: Notepad = { id: crypto.randomUUID(), name: name.trim() || 'Note', content: '', updatedAt: Date.now() }
  namedNotepads.value = [...namedNotepads.value, np]
  saveNamedNotepads()
  activeNotepadId.value = np.id
  return np
}
function deleteNotepad(id: string): void {
  namedNotepads.value = namedNotepads.value.filter((n) => n.id !== id)
  if (activeNotepadId.value === id) activeNotepadId.value = namedNotepads.value[0]?.id ?? null
  saveNamedNotepads()
}
function toggleNotepadPin(id: string): void {
  const np = namedNotepads.value.find((n) => n.id === id)
  if (np) { np.pinned = !np.pinned; saveNamedNotepads(); showToast(np.pinned ? `"${np.name}" always-inject on` : `"${np.name}" always-inject off`) }
}
function updateNotepadContent(id: string, content: string): void {
  const np = namedNotepads.value.find((n) => n.id === id)
  if (np) { np.content = content; np.updatedAt = Date.now(); saveNamedNotepads() }
}
const activeNotepad = computed(() =>
  namedNotepads.value.find((n) => n.id === activeNotepadId.value) ?? namedNotepads.value[0] ?? null
)
const showNewNotepadInput = ref(false)
const newNotepadName = ref('')
// Two-click confirmation map for shell run buttons (avoids window.confirm)
const pendingRunBtn = new Map<HTMLButtonElement, ReturnType<typeof setTimeout>>()
// Generic two-click confirm for named actions (avoids window.confirm)
const pendingConfirm = new Map<string, ReturnType<typeof setTimeout>>()
function twoClick(key: string, action: () => void, label = 'Confirm?', toastMsg?: string): boolean {
  if (!pendingConfirm.has(key)) {
    showToast(toastMsg ?? `${label} — click again to confirm`)
    const t = setTimeout(() => { pendingConfirm.delete(key) }, 2500)
    pendingConfirm.set(key, t)
    return false
  }
  const t = pendingConfirm.get(key)!
  clearTimeout(t)
  pendingConfirm.delete(key)
  action()
  return true
}

// ── Rotating input placeholder (mode-aware) ───────────────────────────────────
const PLACEHOLDER_HINTS_ASK = [
  'Ask anything… (Enter to send, Shift+Enter for new line)',
  'Type @ to add context: @file, @git, @terminal, @symbol…',
  'Try /explain, /fix, /tests, /review, /compact…',
  'Ctrl+L to focus · Ctrl+F to search · Ctrl+N for new chat',
  'Paste an image to include it as context',
  '@file:10-50 to include specific line ranges',
]
const PLACEHOLDER_HINTS_EDIT = [
  'Describe the change — AI will edit the working set files',
  'Add files to the working set, then describe what to change',
  'Try: "Extract this function into a helper" or "Add error handling"',
]
const PLACEHOLDER_HINTS_AGENT = [
  'Describe a task — Agent will use tools to complete it',
  'Try: "Run tests and fix any failures" or "Refactor this module"',
  'Agent can read files, run commands, and apply changes automatically',
]
const placeholderIdx = ref(0)
const inputPlaceholder = computed(() => {
  const hints = chatMode.value === 'edit' ? PLACEHOLDER_HINTS_EDIT
    : chatMode.value === 'agent' ? PLACEHOLDER_HINTS_AGENT
    : PLACEHOLDER_HINTS_ASK
  return hints[placeholderIdx.value % hints.length]
})
let placeholderInterval: number | null = null

// ── Apply-code diff preview modal ────────────────────────────────────────────
interface DiffApplyState {
  code: string
  relPath: string
  oldLines: number
  newLines: number
  oldContent: string
  btn: HTMLButtonElement
}
const diffApplyState = ref<DiffApplyState | null>(null)
const compareStage  = ref<{ code: string } | null>(null)
const compareResult = ref<{ codeA: string; codeB: string } | null>(null)

// Quick inline diff: return first changed lines (added/removed) for preview
function computeSimpleDiffPreview(oldText: string, newText: string, maxLines = 12): Array<{ type: '+' | '-' | ' '; text: string }> {
  const A = oldText.split('\n')
  const B = newText.split('\n')
  // Myers-style O(N) patience diff via LCS matrix (capped at 200 lines to avoid quadratic blowup)
  const capA = A.slice(0, 200), capB = B.slice(0, 200)
  const m = capA.length, n = capB.length
  // Build LCS length table
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0))
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = capA[i - 1] === capB[j - 1] ? dp[i - 1][j - 1] + 1 : Math.max(dp[i - 1][j], dp[i][j - 1])
    }
  }
  // Traceback
  const out: Array<{ type: '+' | '-' | ' '; text: string }> = []
  let i = m, j = n
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && capA[i - 1] === capB[j - 1]) {
      out.unshift({ type: ' ', text: capA[i - 1] }); i--; j--
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      out.unshift({ type: '+', text: capB[j - 1] }); j--
    } else {
      out.unshift({ type: '-', text: capA[i - 1] }); i--
    }
  }
  // Collapse unchanged runs, keeping only context around changes
  const CONTEXT = 2
  const changed = new Set(out.map((l, idx) => l.type !== ' ' ? idx : -1).filter((x) => x >= 0))
  const keep = new Set<number>()
  for (const idx of changed) {
    for (let k = Math.max(0, idx - CONTEXT); k <= Math.min(out.length - 1, idx + CONTEXT); k++) keep.add(k)
  }
  const condensed: Array<{ type: '+' | '-' | ' '; text: string }> = []
  let prev = -2
  for (const idx of Array.from(keep).sort((a, b) => a - b)) {
    if (idx > prev + 1 && condensed.length > 0) condensed.push({ type: ' ', text: '⋯' })
    condensed.push(out[idx])
    prev = idx
  }
  return condensed.slice(0, maxLines)
}

async function confirmApply(): Promise<void> {
  const s = diffApplyState.value
  if (!s) return
  diffApplyState.value = null
  props.backend.send('fs.write_file', {
    workspace_path: props.workspacePath,
    rel_path: s.relPath,
    content: s.code,
  }).then(() => {
    s.btn.textContent = 'Applied ✓'
    s.btn.style.color = 'var(--success-fg, #3fb950)'
    showToast(`Applied to ${s.relPath}`)
    // Open/refresh the file in the editor after apply (VS Code parity)
    if (props.openFile) props.openFile(s.relPath)
    // Add a transient "Revert" button next to the Apply button (Cursor-style undo)
    if (s.oldContent && s.btn.parentElement && !s.btn.parentElement.querySelector('.ai-code-revert-btn')) {
      const revertBtn = document.createElement('button')
      revertBtn.className = 'ai-code-revert-btn'
      revertBtn.title = `Revert ${s.relPath} to original content`
      revertBtn.textContent = 'Revert'
      const originalContent = s.oldContent
      const relPath = s.relPath
      revertBtn.addEventListener('click', () => {
        props.backend.send('fs.write_file', {
          workspace_path: props.workspacePath,
          rel_path: relPath,
          content: originalContent,
        }).then(() => {
          showToast(`Reverted ${relPath}`)
          revertBtn.remove()
          s.btn.textContent = 'Apply'
          s.btn.style.color = ''
        }).catch(() => showToast('Revert failed'))
      })
      s.btn.insertAdjacentElement('afterend', revertBtn)
    } else {
      window.setTimeout(() => { s.btn.textContent = 'Apply'; s.btn.style.color = '' }, 2000)
    }
  }).catch(() => showToast('Apply failed'))
}

async function applyAllEdits(msg: ChatMessage): Promise<void> {
  const edits = msg.pendingEdits
  if (!edits?.length) return
  const files = edits.map((e) => e.relPath).join(', ')
  let proceeded = false
  twoClick(`apply-${msg.timestamp}`, () => { proceeded = true }, 'Apply', `Apply ${edits.length} file(s): ${files} — click again to confirm`)
  if (!proceeded) return
  let ok = 0
  for (const edit of edits) {
    try {
      await props.backend.send('fs.write_file', {
        workspace_path: props.workspacePath,
        rel_path: edit.relPath,
        content: edit.code,
      })
      ok++
    } catch { /* skip */ }
  }
  msg.pendingEdits = undefined
  showToast(`Applied ${ok}/${edits.length} files`)
}

// ── Conversation thread persistence ──────────────────────────────────────────
interface ChatThread { id: string; title: string; messages: ChatMessage[]; updatedAt: number; pinned?: boolean; archived?: boolean; model?: string; checkpoints?: ChatCheckpoint[]; systemPrompt?: string; label?: string; color?: string; pinnedChips?: ContextChip[]; forkedFrom?: string; cliSessionId?: string }
const MAX_THREADS = 20
const MAX_MESSAGES = 500
// Legacy localStorage keys — read only by the one-time per-workspace migration.
const threadsKey = computed(() => `ai-chat-threads:${props.workspacePath}`)
const historyKey = computed(() => `ai-chat-history:${props.workspacePath}`)
const THREAD_LABELS = ['🐛 Bug', '✨ Feature', '❓ Question', '📝 Docs', '🔧 Refactor', '⚡ Perf', '🔒 Security', '🧪 Tests'] as const
type ThreadLabel = typeof THREAD_LABELS[number] | ''

function setThreadLabel(id: string, label: ThreadLabel): void {
  const t = allThreads.value.find((th) => th.id === id)
  if (t) { t.label = label || undefined; saveCurrentThread() }
}

const showThreads = ref(false)
const threadTab = ref<'chats' | 'pinned' | 'archived'>('chats')
const threadSearchQuery = ref('')
const threadBulkMode = ref(false)
// TTS state for "Read aloud" feature
const speakingMsgIdx = ref<number | null>(null)
function readAloud(mi: number, text: string): void {
  if (!window.speechSynthesis) { showToast('Text-to-speech not supported'); return }
  if (speakingMsgIdx.value === mi) {
    window.speechSynthesis.cancel()
    speakingMsgIdx.value = null
    return
  }
  window.speechSynthesis.cancel()
  const plain = text.replace(/```[\s\S]*?```/g, 'code block').replace(/[*_#`~]/g, '').replace(/\n{2,}/g, '. ').trim()
  const utt = new SpeechSynthesisUtterance(plain)
  utt.onend = () => { speakingMsgIdx.value = null }
  utt.onerror = () => { speakingMsgIdx.value = null }
  speakingMsgIdx.value = mi
  window.speechSynthesis.speak(utt)
}
const selectedThreadIds = ref(new Set<string>())
function toggleThreadSelect(id: string): void {
  const s = new Set(selectedThreadIds.value)
  if (s.has(id)) s.delete(id); else s.add(id)
  selectedThreadIds.value = s
}
function bulkDeleteThreads(): void {
  const ids = [...selectedThreadIds.value]
  if (!ids.length) { showToast('No threads selected'); return }
  if (!window.confirm(`Delete ${ids.length} thread(s)?`)) return
  const needSwitch = ids.includes(currentThreadId.value)
  for (const id of ids) {
    const idx = allThreads.value.findIndex((t) => t.id === id)
    if (idx !== -1) allThreads.value.splice(idx, 1)
  }
  if (needSwitch) {
    const next = allThreads.value.find((t) => !t.archived)
    if (next) { switchThread(next.id) } else { newThread() }
  }
  selectedThreadIds.value = new Set()
  threadBulkMode.value = false
  saveCurrentThread()
  showToast(`Deleted ${ids.length} thread(s)`)
}
function bulkArchiveThreads(): void {
  const ids = [...selectedThreadIds.value]
  if (!ids.length) { showToast('No threads selected'); return }
  for (const id of ids) {
    const t = allThreads.value.find((th) => th.id === id)
    if (t) t.archived = true
  }
  selectedThreadIds.value = new Set()
  threadBulkMode.value = false
  saveCurrentThread()
  showToast(`Archived ${ids.length} thread(s)`)
}
function resetThreadBulkSelection(): void {
  selectedThreadIds.value = new Set()
}
function toggleThreadBulkMode(): void {
  threadBulkMode.value = !threadBulkMode.value
  resetThreadBulkSelection()
}
function cancelThreadBulkMode(): void {
  threadBulkMode.value = false
  resetThreadBulkSelection()
}
const threadSortMode = ref<'date' | 'name' | 'model'>(
  settingsGet('ai-chat-thread-sort', 'date') as 'date' | 'name' | 'model'
)
watch(threadSortMode, (v) => settingsSet('ai-chat-thread-sort', v))
const threadPanelHeight = ref<number | null>(
  (() => { const v = settingsGet<string | null>('ai-thread-panel-h', null); return v ? parseInt(v, 10) : null })()
)
let _panelDragStartY = 0
let _panelDragStartH = 0
function onPanelResizeMousedown(e: MouseEvent): void {
  const panel = (e.currentTarget as HTMLElement).parentElement
  if (!panel) return
  _panelDragStartY = e.clientY
  _panelDragStartH = panel.getBoundingClientRect().height
  const onMove = (me: MouseEvent) => {
    const delta = _panelDragStartY - me.clientY
    const newH = Math.min(Math.max(_panelDragStartH + delta, 120), window.innerHeight * 0.85)
    threadPanelHeight.value = Math.round(newH)
  }
  const onUp = () => {
    document.removeEventListener('mousemove', onMove)
    document.removeEventListener('mouseup', onUp)
    if (threadPanelHeight.value) settingsSet('ai-thread-panel-h', String(threadPanelHeight.value))
  }
  document.addEventListener('mousemove', onMove)
  document.addEventListener('mouseup', onUp)
  e.preventDefault()
}

function addSelectionContextChip(): void {
  const sel = props.getEditorSelection?.()?.trim()
  if (!sel) {
    showToast('No selection — select code in the editor first')
    return
  }
  const relPath = props.getActiveRelPath?.()
  const ext = relPath?.split('.').pop() ?? ''
  const label = '@selection'
  contextChips.value = contextChips.value.filter((c) => c.label !== label)
  contextChips.value.push({ id: crypto.randomUUID(), label, content: `\`\`\`${ext}\n${sel.slice(0, 8000)}\n\`\`\`` })
  showToast('Selection added to context')
  nextTick(() => textareaEl.value?.focus())
}

function promptAddMemory(): void {
  const fact = window.prompt('New memory fact (one sentence):')
  if (fact?.trim()) addMemory(fact.trim())
}

function promptAddGlobalPin(): void {
  const path = window.prompt('File path to always include (relative to workspace, e.g. src/types.ts):')
  if (path?.trim()) addGlobalPin(path.trim())
}
const renamingThreadId = ref('')
const renamingTitle = ref('')
// Per-thread draft: save unsent input when switching threads (Cursor-style)
const threadDrafts = new Map<string, string>()
const filteredThreads = computed(() => {
  const q = threadSearchQuery.value.trim().toLowerCase()
  const pool =
    threadTab.value === 'archived' ? allThreads.value.filter((t) => t.archived) :
    threadTab.value === 'pinned'   ? allThreads.value.filter((t) => !t.archived && t.pinned) :
                                     allThreads.value.filter((t) => !t.archived)
  const list = q
    ? pool.filter((t) =>
        t.title.toLowerCase().includes(q) ||
        t.messages.some((m) => m.content.toLowerCase().includes(q)),
      )
    : pool
  const sorted = [...list].sort((a, b) => {
    if (threadSortMode.value === 'name') return a.title.localeCompare(b.title)
    if (threadSortMode.value === 'model') return (a.model ?? '').localeCompare(b.model ?? '')
    return b.updatedAt - a.updatedAt // date (default)
  })
  // Pinned threads always at top
  return [...sorted.filter((t) => t.pinned), ...sorted.filter((t) => !t.pinned)]
})

type GroupedItem = { kind: 'thread'; thread: ChatThread } | { kind: 'label'; label: string }
const groupedThreads = computed<GroupedItem[]>(() => {
  const threads = filteredThreads.value
  const pinned = threads.filter((t) => t.pinned)
  const unpinned = threads.filter((t) => !t.pinned)
  const now = Date.now()
  const today = new Date(); today.setHours(0, 0, 0, 0)
  const yesterday = new Date(today); yesterday.setDate(today.getDate() - 1)
  const lastWeek = new Date(today); lastWeek.setDate(today.getDate() - 7)

  const items: GroupedItem[] = []
  if (pinned.length) {
    items.push({ kind: 'label', label: 'Pinned' })
    for (const t of pinned) items.push({ kind: 'thread', thread: t })
  }

  const groups: { label: string; threads: ChatThread[] }[] = [
    { label: 'Today', threads: [] }, { label: 'Yesterday', threads: [] },
    { label: 'This Week', threads: [] }, { label: 'Older', threads: [] },
  ]
  for (const t of unpinned) {
    const d = new Date(t.updatedAt)
    if (d >= today) groups[0].threads.push(t)
    else if (d >= yesterday) groups[1].threads.push(t)
    else if (d >= lastWeek) groups[2].threads.push(t)
    else groups[3].threads.push(t)
  }
  for (const g of groups) {
    if (!g.threads.length) continue
    items.push({ kind: 'label', label: g.label })
    for (const t of g.threads) items.push({ kind: 'thread', thread: t })
  }
  return items
})

function threadTotalTokens(thread: ChatThread): number {
  let total = 0
  for (const m of thread.messages) {
    if (m.inputTokens != null) total += m.inputTokens
    if (m.outputTokens != null) total += m.outputTokens
  }
  return total
}

function getThreadMatchSnippet(thread: ChatThread, q: string): string {
  if (!q) return ''
  for (const m of thread.messages) {
    const idx = m.content.toLowerCase().indexOf(q.toLowerCase())
    if (idx >= 0) {
      const start = Math.max(0, idx - 20)
      const end = Math.min(m.content.length, idx + q.length + 40)
      return (start > 0 ? '…' : '') + m.content.slice(start, end).replace(/\n/g, ' ') + (end < m.content.length ? '…' : '')
    }
  }
  return ''
}

function togglePinThread(id: string, e: Event): void {
  e.stopPropagation()
  const t = allThreads.value.find((th) => th.id === id)
  if (t) { t.pinned = !t.pinned; saveCurrentThread() }
}
const THREAD_COLORS = ['#ef4444','#f97316','#eab308','#22c55e','#14b8a6','#3b82f6','#8b5cf6','#ec4899']
function cycleThreadColor(id: string, e: Event): void {
  e.stopPropagation()
  const t = allThreads.value.find((th) => th.id === id)
  if (!t) return
  const idx = t.color ? THREAD_COLORS.indexOf(t.color) : -1
  t.color = idx >= 0 && idx < THREAD_COLORS.length - 1 ? THREAD_COLORS[idx + 1] : (idx === THREAD_COLORS.length - 1 ? undefined : THREAD_COLORS[0])
  saveCurrentThread()
}
function toggleArchiveThread(id: string, e: Event): void {
  e.stopPropagation()
  const t = allThreads.value.find((th) => th.id === id)
  if (!t) return
  t.archived = !t.archived
  if (t.archived) t.pinned = false
  // Switch to a non-archived thread if we just archived the current one
  if (t.archived && t.id === currentThreadId.value) {
    const next = allThreads.value.find((th) => !th.archived && th.id !== t.id)
    if (next) switchThread(next.id)
    else newThread()
  }
  saveCurrentThread()
}
const currentThreadId = ref('')
const allThreads = ref<ChatThread[]>([])
const currentThread = computed(() => allThreads.value.find((t) => t.id === currentThreadId.value) ?? null)

function newThreadId(): string { return crypto.randomUUID() }

// Guards persistThreads until the backend chat-threads.json document has been
// loaded — an early save would overwrite real data with the empty placeholder.
let threadsHydrated = false
let threadsLoadSeq = 0

function persistThreads(threads: ChatThread[]): void {
  const ws = props.workspacePath
  if (!ws || !threadsHydrated) return
  props.backend.send('ai.chat.threads.set', { workspace_path: ws, threads })
    .catch(() => { /* transient; the next save retries */ })
}

async function loadThreads(): Promise<void> {
  const seq = ++threadsLoadSeq
  threadsHydrated = false
  const ws = props.workspacePath
  const legacyThreadsKey = threadsKey.value
  const legacyHistoryKey = historyKey.value
  if (ws) {
    try {
      const resp = await props.backend.send<{ threads?: ChatThread[] }>(
        'ai.chat.threads.get', { workspace_path: ws }
      )
      if (seq !== threadsLoadSeq) return
      if (resp.ok) {
        threadsHydrated = true
        const stored = Array.isArray(resp.payload?.threads) ? resp.payload.threads : []
        if (stored.length > 0) {
          allThreads.value = stored.slice(0, MAX_THREADS)
          // Backend already owns the data — clear any leftover legacy copies.
          try { localStorage.removeItem(legacyThreadsKey); localStorage.removeItem(legacyHistoryKey) } catch { /* ignore */ }
        } else {
          // Backend document empty → one-time per-workspace localStorage
          // migration (covers the old ai-chat-history single-key format too).
          let threadsRaw: string | null = null
          let historyRaw: string | null = null
          try {
            threadsRaw = localStorage.getItem(legacyThreadsKey)
            historyRaw = localStorage.getItem(legacyHistoryKey)
          } catch { /* storage unavailable */ }
          const migrated = parseLegacyThreads(threadsRaw, historyRaw, MAX_THREADS) as ChatThread[] | null
          if (migrated && migrated.length > 0) {
            allThreads.value = migrated
            const ack = await props.backend.send<{ ok?: boolean }>('ai.chat.threads.set', {
              workspace_path: ws,
              threads: migrated,
            })
            // Ack-gated delete: keep the copies (retried next launch) on failure.
            if (ack.ok && ack.payload?.ok === true) {
              try { localStorage.removeItem(legacyThreadsKey); localStorage.removeItem(legacyHistoryKey) } catch { /* ignore */ }
            }
          }
        }
      }
    } catch { /* backend unavailable — stay unhydrated so saves can't clobber */ }
    if (seq !== threadsLoadSeq) return
  }

  if (allThreads.value.length === 0) {
    const id = newThreadId()
    allThreads.value = [{ id, title: 'New chat', messages: [], updatedAt: Date.now() }]
  }
  const latest = allThreads.value[0]
  currentThreadId.value = latest.id
  messages.value = latest.messages.map((m) => ({ ...m, streaming: false, thinking: false }))
  // Loading is async now — re-render any mermaid diagrams persisted in the
  // thread history (the mount-time render pass may have run before this).
  void nextTick(renderMermaidBlocks)
}

function _doSave(): void {
  const idx = allThreads.value.findIndex((t) => t.id === currentThreadId.value)
  if (idx === -1) return
  const toSave = messages.value.filter((m) => !m.streaming).slice(-100)
  allThreads.value[idx].messages = toSave
  allThreads.value[idx].updatedAt = Date.now()
  allThreads.value[idx].checkpoints = checkpoints.value
  const firstUser = toSave.find((m) => m.role === 'user')
  if (firstUser && (allThreads.value[idx].title === 'New chat' )) {
    // Truncate at word boundary within 40 chars
    const raw = firstUser.content.replace(/\s+/g, ' ').trim()
    const cut = raw.length <= 40 ? raw : (raw.slice(0, 40).replace(/\s\S*$/, '') || raw.slice(0, 40))
    allThreads.value[idx].title = cut
  }
  persistThreads(allThreads.value.slice(0, MAX_THREADS))
}

function saveCurrentThread(): void {
  if (saveTimer !== null) clearTimeout(saveTimer)
  saveTimer = window.setTimeout(() => { _doSave() }, 1000)
}

function newThread(): void {
  if (sending.value) stopStreaming()
  if (saveTimer !== null) { clearTimeout(saveTimer); saveTimer = null }
  _doSave()
  const id = newThreadId()
  const thread: ChatThread = { id, title: 'New chat', messages: [], updatedAt: Date.now() }
  allThreads.value.unshift(thread)
  currentThreadId.value = id
  messages.value = []
  expandedMsgIdxs.value = new Set(); expandedDiffs.value = new Set()
  showThreads.value = false
}

function switchThread(id: string): void {
  if (id === currentThreadId.value) { showThreads.value = false; return }
  _navAssistIdx = -1  // reset message nav index on thread switch
  feedbackInputMi.value = null; feedbackDraft.value = ''
  // Save unsent draft for current thread before switching (Cursor-style)
  if (inputText.value.trim()) {
    threadDrafts.set(currentThreadId.value, inputText.value)
  } else {
    threadDrafts.delete(currentThreadId.value)
  }
  // Save current thread's scroll position before switching
  if (messagesEl.value) {
    threadScrollPositions.set(currentThreadId.value, messagesEl.value.scrollTop)
  }
  if (sending.value) stopStreaming()
  if (saveTimer !== null) { clearTimeout(saveTimer); saveTimer = null }
  // Record last-visited time for outgoing thread (unread badge)
  if (currentThreadId.value) {
    threadLastVisited[currentThreadId.value] = Date.now()
    _saveLastVisited()
  }
  // Save pinned chips to outgoing thread before switching
  const outThread = allThreads.value.find((t) => t.id === currentThreadId.value)
  if (outThread) outThread.pinnedChips = contextChips.value.filter((c) => c.pinned)
  _doSave()
  const thread = allThreads.value.find((t) => t.id === id)
  if (!thread) return
  currentThreadId.value = id
  // Mark incoming thread as visited immediately (clear unread badge)
  threadLastVisited[id] = Date.now()
  _saveLastVisited()
  messages.value = thread.messages.map((m) => ({ ...m, streaming: false, thinking: false }))
  checkpoints.value = thread.checkpoints ?? []
  expandedMsgIdxs.value = new Set()
  // Clear edit-mode working set on thread switch
  editWorkingSet.value = []
  // Reset auto-compact guard so the new thread can trigger compaction if it's near the limit
  _autoCompactFired = false
  // Restore scroll position; default to bottom for new/short threads
  const savedPos = threadScrollPositions.get(id)
  nextTick(() => {
    if (!messagesEl.value) return
    if (savedPos !== undefined) {
      messagesEl.value.scrollTop = savedPos
      autoScroll.value = false
    } else {
      messagesEl.value.scrollTop = messagesEl.value.scrollHeight
      autoScroll.value = true
    }
    void renderMermaidBlocks()
  })
  // Move selected thread to front
  allThreads.value = [thread, ...allThreads.value.filter((t) => t.id !== id)]
  // Restore saved draft for the destination thread (Cursor-style)
  inputText.value = threadDrafts.get(id) ?? ''
  // Restore pinned context chips from the destination thread
  contextChips.value = thread.pinnedChips ? thread.pinnedChips.map((c) => ({ ...c })) : []
  showThreads.value = false
}

function deleteThread(id: string): void {
  allThreads.value = allThreads.value.filter((t) => t.id !== id)
  if (currentThreadId.value === id) {
    if (allThreads.value.length === 0) newThread()
    else switchThread(allThreads.value[0].id)
  }
  persistThreads(allThreads.value)
}

function duplicateThread(id: string): void {
  const src = allThreads.value.find((t) => t.id === id)
  if (!src) return
  const copy: ChatThread = {
    id: crypto.randomUUID(),
    title: src.title.slice(0, 55) + ' (copy)',
    messages: src.messages.map((m) => ({ ...m })),
    updatedAt: Date.now(),
    pinned: false,
    model: src.model,
    checkpoints: src.checkpoints ? src.checkpoints.map((c) => ({ ...c, messagesSnapshot: c.messagesSnapshot.map((m) => ({ ...m })) })) : undefined,
  }
  const idx = allThreads.value.findIndex((t) => t.id === id)
  allThreads.value.splice(idx + 1, 0, copy)
  persistThreads(allThreads.value)
  switchThread(copy.id)
  showToast('Thread duplicated')
}

function startRenameThread(id: string, title: string, e: Event): void {
  e.stopPropagation()
  renamingThreadId.value = id
  renamingTitle.value = title
  nextTick(() => {
    const el = document.querySelector<HTMLInputElement>('.ai-thread-rename-input')
    el?.focus()
    el?.select()
  })
}
function finishRenameThread(): void {
  const id = renamingThreadId.value
  const title = renamingTitle.value.trim()
  if (id && title) {
    const t = allThreads.value.find((t) => t.id === id)
    if (t) { t.title = title; saveCurrentThread() }
  }
  renamingThreadId.value = ''
  renamingTitle.value = ''
}
function cancelRenameThread(): void {
  renamingThreadId.value = ''
  renamingTitle.value = ''
}

watch(messages, saveCurrentThread)

// ── Settings ───────────────────────────────────────────────────────────────────
type ProviderName = 'anthropic' | 'ollama' | 'openai' | 'groq' | 'deepseek' | 'google' | 'mistral' | 'xai' | 'openai_compatible'
const settingsProvider = ref<ProviderName>('anthropic')
const settingsApiKey = ref('')
// Provider credentials live only in the backend ai_chat_settings.json (0o600);
// the form hydrates from `ai.chat.settings.get` (see fetchSettings).
const settingsOpenAiKey = ref('')
const settingsGroqKey = ref('')
const settingsDeepSeekKey = ref('')
const settingsGoogleKey = ref('')
const settingsMistralKey = ref('')
const settingsXaiKey = ref('')
const settingsOaiCompatUrl = ref('')
const settingsOaiCompatKey = ref('')
const settingsOaiCompatModel = ref('gpt-4o')
const settingsModel = ref('claude-sonnet-4-6')
const settingsOllamaUrl = ref('http://localhost:11434')
const settingsSendMode = ref<'enter' | 'ctrl-enter'>(
  settingsGet('ai-chat-send-mode', 'enter') as 'enter' | 'ctrl-enter'
)
const settingsSystemPrompt = ref('You are a helpful AI coding assistant.')
const testConnStatus = ref<Record<string, 'idle' | 'testing' | 'ok' | 'fail'>>({})
const testConnError = ref<Record<string, string>>({})

const providerHasKey = computed<Record<string, boolean>>(() => ({
  anthropic:        (settingsApiKey.value ?? '').trim().length > 0,
  openai:           (settingsOpenAiKey.value ?? '').trim().length > 0,
  groq:             (settingsGroqKey.value ?? '').trim().length > 0,
  deepseek:         (settingsDeepSeekKey.value ?? '').trim().length > 0,
  google:           (settingsGoogleKey.value ?? '').trim().length > 0,
  mistral:          (settingsMistralKey.value ?? '').trim().length > 0,
  xai:              (settingsXaiKey.value ?? '').trim().length > 0,
  openai_compatible:(settingsOaiCompatUrl.value ?? '').trim().length > 0,
  ollama:           true,  // always available (local)
  auto:             true,
}))

const _SYSTEM_PROFILES: Record<string, string> = {
  coding:   'You are a helpful AI coding assistant. Be concise, use code examples, and always explain your reasoning.',
  concise:  'You are a helpful AI assistant. Be extremely concise. No preamble, no filler words. Answer directly.',
  security: 'You are a senior security engineer. Review all code for vulnerabilities (OWASP Top 10, injection, auth issues, secrets). Always flag security issues first.',
  teacher:  'You are a patient coding teacher. Explain every concept thoroughly with analogies, examples, and step-by-step reasoning. Assume the learner is new to the topic.',
  refactor: 'You are an expert code refactoring specialist. Focus on: clean code principles, SOLID design, reducing complexity, improving readability, and eliminating duplication.',
}

const _PERSONA_LABELS: Record<string, string> = {
  coding: '💻 Coder', concise: '⚡ Concise', security: '🔒 Security',
  teacher: '🎓 Teacher', refactor: '🔧 Refactor',
}
const activePersonaLabel = computed(() => {
  const sp = settingsSystemPrompt.value
  for (const [key, text] of Object.entries(_SYSTEM_PROFILES)) {
    if (sp === text) return _PERSONA_LABELS[key] ?? key
  }
  return null
})
function applySystemPromptProfile(profile: string): void {
  if (!profile || profile === 'custom') return
  const text = _SYSTEM_PROFILES[profile]
  if (text) { settingsSystemPrompt.value = text; showToast(`Profile: ${profile}`) }
}

const settingsAutoAccept = ref(settingsGet<string | null>('ai-chat-auto-accept', null) === 'true')
const settingsSmartContext = ref(settingsGet<string | null>('ai-chat-smart-context', null) !== 'false')
const settingsUserRules = ref(settingsGet('ai-chat-user-rules', ''))

// ── Custom @docs entries (user-defined documentation URLs) ───────────────────
interface CustomDocEntry { key: string; label: string; url: string }
const customDocs = ref<CustomDocEntry[]>((() => {
  try { return JSON.parse(settingsGet('ai-chat-custom-docs', '[]')) as CustomDocEntry[] }
  catch { return [] }
})())
const newDocKey   = ref('')
const newDocLabel = ref('')
const newDocUrl   = ref('')
const allDocsCatalog = computed<Record<string, { label: string; url: string }>>(() => {
  const result: Record<string, { label: string; url: string }> = { ...DOCS_CATALOG }
  for (const d of customDocs.value) {
    if (d.key.trim()) result[d.key.trim()] = { label: d.label || d.key, url: d.url }
  }
  return result
})
function addCustomDoc(): void {
  const key = newDocKey.value.trim().toLowerCase().replace(/\s+/g, '-')
  if (!key || !newDocUrl.value.trim()) { showToast('Key and URL are required'); return }
  if (customDocs.value.some((d) => d.key === key)) { showToast('Key already exists'); return }
  customDocs.value.push({ key, label: newDocLabel.value.trim() || key, url: newDocUrl.value.trim() })
  newDocKey.value = ''; newDocLabel.value = ''; newDocUrl.value = ''
}
function removeCustomDoc(key: string): void {
  customDocs.value = customDocs.value.filter((d) => d.key !== key)
}

// Chat mode — 'ask' = suggestions only, 'edit' = targeted file edits, 'agent' = full autonomous
const chatMode = ref<'ask' | 'edit' | 'agent'>(settingsAutoAccept.value ? 'agent' : 'ask')
watch(chatMode, (mode) => {
  settingsAutoAccept.value = mode === 'agent'
  settingsSet('ai-chat-auto-accept', mode === 'agent' ? 'true' : 'false')
})
// Edit mode working set — files targeted for batch edits (VS Code Copilot Edit parity)
const editWorkingSet = ref<string[]>([])
function addToWorkingSet(relPath: string): void {
  if (!editWorkingSet.value.includes(relPath)) editWorkingSet.value.push(relPath)
}
function removeFromWorkingSet(idx: number): void {
  editWorkingSet.value.splice(idx, 1)
}
const settingsMaxTokens = ref(4096)
const settingsMaxAgentIter = ref(parseInt(settingsGet('ai-chat-max-agent-iter', '10'), 10) || 10)
const settingsTemperature = ref<number | null>(null)  // null = use model default
const settingsThinkingBudget = ref<number | null>(null) // null = disabled; token budget for extended thinking
const settingsReasoningEffort = ref<'low' | 'medium' | 'high' | null>(null)
const THINKING_SUPPORTED_MODELS = new Set(['claude-opus-4-8', 'claude-sonnet-4-6', 'claude-3-7-sonnet-20250219'])
const REASONING_MODEL_PREFIXES = ['o1', 'o3', 'o4']
const thinkingSupported = computed(() => THINKING_SUPPORTED_MODELS.has(settingsModel.value))
const reasoningModelSelected = computed(() => REASONING_MODEL_PREFIXES.some((p) => settingsModel.value.startsWith(p)))
const showModelPicker = ref(false)
const modelPickerSearch = ref('')
watch(showModelPicker, (v) => { if (!v) modelPickerSearch.value = '' })

interface ModelEntry {
  id: string
  provider: 'anthropic' | 'ollama' | 'openai' | 'groq' | 'deepseek' | 'google' | 'mistral' | 'xai' | 'openai_compatible' | 'auto'
  display: string
  note: string   // speed/capability hint
  ctx?: number   // context window in tokens
  caps?: Array<'vision' | 'thinking' | 'code'>  // capability badges
}
const MODEL_CATALOG: ModelEntry[] = [
  { id: 'auto',                        provider: 'auto',      display: 'Auto',                    note: 'Best available' },
  // Anthropic
  { id: 'claude-opus-4-8',            provider: 'anthropic', display: 'Claude Opus 4.8',         note: 'Most capable',      ctx: 200_000, caps: ['vision', 'thinking'] },
  { id: 'claude-sonnet-4-6',          provider: 'anthropic', display: 'Claude Sonnet 4.6',       note: 'Balanced',           ctx: 200_000, caps: ['vision', 'thinking'] },
  { id: 'claude-haiku-4-5-20251001',  provider: 'anthropic', display: 'Claude Haiku 4.5',        note: 'Fast',               ctx: 200_000, caps: ['vision'] },
  { id: 'claude-3-5-sonnet-20241022', provider: 'anthropic', display: 'Claude 3.5 Sonnet',       note: 'Stable',             ctx: 200_000, caps: ['vision'] },
  { id: 'claude-3-5-haiku-20241022',  provider: 'anthropic', display: 'Claude 3.5 Haiku',        note: 'Fast · Stable',      ctx: 200_000, caps: ['vision'] },
  // OpenAI
  { id: 'gpt-4.1',                     provider: 'openai',    display: 'GPT-4.1',                 note: 'OpenAI · 1M ctx',    ctx: 1_000_000, caps: ['vision'] },
  { id: 'gpt-4.1-mini',                provider: 'openai',    display: 'GPT-4.1 Mini',            note: 'OpenAI · Fast · 1M', ctx: 1_000_000, caps: ['vision'] },
  { id: 'gpt-4.1-nano',                provider: 'openai',    display: 'GPT-4.1 Nano',            note: 'OpenAI · Fastest',   ctx: 1_000_000 },
  { id: 'gpt-4o',                      provider: 'openai',    display: 'GPT-4o',                  note: 'OpenAI',             ctx: 128_000, caps: ['vision'] },
  { id: 'gpt-4o-mini',                 provider: 'openai',    display: 'GPT-4o Mini',             note: 'OpenAI · Fast',      ctx: 128_000 },
  { id: 'o3',                          provider: 'openai',    display: 'o3',                      note: 'OpenAI · Reasoning', ctx: 200_000, caps: ['thinking'] },
  { id: 'o3-mini',                     provider: 'openai',    display: 'o3-mini',                 note: 'OpenAI · Reasoning', ctx: 200_000, caps: ['thinking'] },
  { id: 'o4-mini',                     provider: 'openai',    display: 'o4-mini',                 note: 'OpenAI · Reasoning', ctx: 200_000, caps: ['thinking', 'vision'] },
  // Groq
  { id: 'llama-4-scout-17b-16e-instruct',   provider: 'groq', display: 'Llama 4 Scout',          note: 'Groq · Fast',        ctx: 131_072 },
  { id: 'llama-4-maverick-17b-128e-instruct', provider: 'groq', display: 'Llama 4 Maverick',     note: 'Groq · Capable',     ctx: 131_072 },
  { id: 'llama-3.3-70b-versatile',    provider: 'groq',      display: 'Llama 3.3 70B',           note: 'Groq',               ctx: 128_000 },
  { id: 'mixtral-8x7b-32768',          provider: 'groq',      display: 'Mixtral 8x7B',            note: 'Groq',               ctx: 32_000 },
  // DeepSeek
  { id: 'deepseek-chat',              provider: 'deepseek',  display: 'DeepSeek Chat',            note: 'DeepSeek',           ctx: 64_000 },
  { id: 'deepseek-reasoner',          provider: 'deepseek',  display: 'DeepSeek Reasoner',        note: 'DeepSeek · R1',      ctx: 64_000, caps: ['thinking'] },
  // Google Gemini
  { id: 'gemini-2.5-pro',             provider: 'google',    display: 'Gemini 2.5 Pro',           note: 'Google',             ctx: 1_048_576, caps: ['vision', 'thinking'] },
  { id: 'gemini-2.5-flash',           provider: 'google',    display: 'Gemini 2.5 Flash',         note: 'Google · Fast',      ctx: 1_048_576, caps: ['vision'] },
  { id: 'gemini-2.0-flash',           provider: 'google',    display: 'Gemini 2.0 Flash',         note: 'Google · Fast',      ctx: 1_048_576, caps: ['vision'] },
  // Mistral AI
  { id: 'mistral-large-latest',       provider: 'mistral',   display: 'Mistral Large',            note: 'Mistral',            ctx: 131_072 },
  { id: 'mistral-small-latest',       provider: 'mistral',   display: 'Mistral Small',            note: 'Mistral · Fast',     ctx: 131_072 },
  { id: 'codestral-latest',           provider: 'mistral',   display: 'Codestral',                note: 'Mistral · Code',     ctx: 256_000, caps: ['code'] },
  // xAI Grok
  { id: 'grok-3',                     provider: 'xai',       display: 'Grok 3',                   note: 'xAI',                ctx: 131_072, caps: ['vision'] },
  { id: 'grok-3-mini',                provider: 'xai',       display: 'Grok 3 Mini',              note: 'xAI · Fast',         ctx: 131_072 },
  // Ollama (local)
  { id: 'llama3.2',                   provider: 'ollama',    display: 'Llama 3.2',               note: 'Local',              ctx: 128_000 },
  { id: 'llama3.1',                   provider: 'ollama',    display: 'Llama 3.1',               note: 'Local',              ctx: 128_000 },
  { id: 'qwen2.5-coder',              provider: 'ollama',    display: 'Qwen 2.5 Coder',          note: 'Local · Code',       ctx: 128_000, caps: ['code'] },
  { id: 'mistral',                    provider: 'ollama',    display: 'Mistral',                 note: 'Local',              ctx: 32_000  },
  { id: 'codellama',                  provider: 'ollama',    display: 'CodeLlama',               note: 'Local · Code',       ctx: 16_000, caps: ['code'] },
  { id: 'gemma2',                     provider: 'ollama',    display: 'Gemma 2',                 note: 'Local',              ctx: 8_000   },
]
// Token pricing per million tokens [input, output] in USD — used for cost estimation badges
const MODEL_COSTS: Record<string, [number, number]> = {
  'claude-opus-4-8':            [15,    75   ],
  'claude-sonnet-4-6':          [3,     15   ],
  'claude-haiku-4-5-20251001':  [0.8,   4    ],
  'claude-3-5-sonnet-20241022': [3,     15   ],
  'claude-3-5-haiku-20241022':  [0.8,   4    ],
  'gpt-4.1':                    [2,     8    ],
  'gpt-4.1-mini':               [0.4,   1.6  ],
  'gpt-4.1-nano':               [0.1,   0.4  ],
  'gpt-4o':                     [2.5,   10   ],
  'gpt-4o-mini':                [0.15,  0.6  ],
  'o3':                         [2,     8    ],
  'o3-mini':                    [1.1,   4.4  ],
  'o4-mini':                    [1.1,   4.4  ],
  'deepseek-chat':              [0.27,  1.1  ],
  'deepseek-reasoner':          [0.55,  2.19 ],
  'llama-3.3-70b-versatile':    [0.59,  0.79 ],
  'mixtral-8x7b-32768':         [0.24,  0.24 ],
  'gemini-2.5-pro':             [1.25,  10   ],
  'gemini-2.5-flash':           [0.15,  0.6  ],
  'gemini-2.0-flash':           [0.1,   0.4  ],
  'mistral-large-latest':       [2,     6    ],
  'mistral-small-latest':       [0.1,   0.3  ],
  'codestral-latest':           [0.3,   0.9  ],
  'grok-3':                     [3,     15   ],
  'grok-3-mini':                [0.3,   0.5  ],
}

function estimateCost(modelId: string, inputTokens: number, outputTokens: number): string | null {
  const costs = MODEL_COSTS[modelId]
  if (!costs) return null
  const usd = (inputTokens / 1_000_000) * costs[0] + (outputTokens / 1_000_000) * costs[1]
  if (usd < 0.001) return '<$0.001'
  if (usd < 0.01) return `$${usd.toFixed(4)}`
  return `$${usd.toFixed(3)}`
}

// ── Session-level token & cost statistics ─────────────────────────────────────
const sessionStats = computed(() => {
  let totalIn = 0, totalOut = 0, totalCost = 0, modelsUsed = new Set<string>()
  for (const thread of allThreads.value) {
    for (const m of thread.messages) {
      if (m.inputTokens != null)  totalIn  += m.inputTokens
      if (m.outputTokens != null) totalOut += m.outputTokens
      if (m.model) modelsUsed.add(m.model)
      if (m.model && m.inputTokens != null && m.outputTokens != null) {
        const costs = MODEL_COSTS[m.model]
        if (costs) totalCost += (m.inputTokens / 1_000_000) * costs[0] + (m.outputTokens / 1_000_000) * costs[1]
      }
    }
  }
  return { totalIn, totalOut, totalCost, modelsUsed: Array.from(modelsUsed) }
})

const ANTHROPIC_MODELS = MODEL_CATALOG.filter((m) => m.provider === 'anthropic').map((m) => m.id)
const OLLAMA_MODELS     = MODEL_CATALOG.filter((m) => m.provider === 'ollama').map((m) => m.id)
const OPENAI_MODELS     = MODEL_CATALOG.filter((m) => m.provider === 'openai').map((m) => m.id)
const GROQ_MODELS       = MODEL_CATALOG.filter((m) => m.provider === 'groq').map((m) => m.id)
const DEEPSEEK_MODELS   = MODEL_CATALOG.filter((m) => m.provider === 'deepseek').map((m) => m.id)
const GOOGLE_MODELS     = MODEL_CATALOG.filter((m) => m.provider === 'google').map((m) => m.id)
const MISTRAL_MODELS    = MODEL_CATALOG.filter((m) => m.provider === 'mistral').map((m) => m.id)
const XAI_MODELS        = MODEL_CATALOG.filter((m) => m.provider === 'xai').map((m) => m.id)
const currentModelOptions = computed(() => {
  switch (settingsProvider.value) {
    case 'anthropic': return ANTHROPIC_MODELS
    case 'openai':    return OPENAI_MODELS
    case 'groq':      return GROQ_MODELS
    case 'deepseek':  return DEEPSEEK_MODELS
    case 'google':    return GOOGLE_MODELS
    case 'mistral':   return MISTRAL_MODELS
    case 'xai':       return XAI_MODELS
    case 'openai_compatible': return []
    default:          return OLLAMA_MODELS
  }
})
const modelIsCustom = computed(() => !MODEL_CATALOG.some((m) => m.id === settingsModel.value))
const selectedModelKey = computed({
  get: () => (modelIsCustom.value ? 'custom' : settingsModel.value),
  set: (val: string) => { if (val !== 'custom') settingsModel.value = val },
})

// Atomically switch provider + model and persist to backend.
// Saves the chosen model as a per-conversation override so switching threads
// restores each thread's model independently (differentiator vs Cursor/VS Code).
function switchModel(modelId: string): void {
  const entry = MODEL_CATALOG.find((m) => m.id === modelId)
  if (entry && entry.provider !== 'auto') settingsProvider.value = entry.provider
  settingsModel.value = modelId
  // Persist per-conversation model on the current thread
  const ct = allThreads.value.find((t) => t.id === currentThreadId.value)
  if (ct) ct.model = modelId
  _pushSettingsToBackend()
}

// When provider switches, reset model to the first preset for that provider
// (only if current model doesn't belong to the new provider)
watch(settingsProvider, (provider) => {
  const catalog = provider === 'openai_compatible' ? [] : MODEL_CATALOG.filter((m) => m.provider === provider).map((m) => m.id)
  if (catalog.length && !catalog.includes(settingsModel.value)) {
    settingsModel.value = catalog[0]
  }
  // Reset test status when switching providers
  testConnStatus.value = {}
  testConnError.value = {}
})

// Reset test status when API key changes so stale result isn't shown
watch([settingsApiKey, settingsOpenAiKey, settingsGroqKey, settingsDeepSeekKey,
       settingsGoogleKey, settingsMistralKey, settingsXaiKey,
       settingsOaiCompatKey, settingsOaiCompatUrl, settingsOllamaUrl],
  () => { testConnStatus.value = {}; testConnError.value = {} })

// Long message fold — collapse AI messages with > 50 lines (UI-only, ephemeral)
const expandedMsgIdxs = ref(new Set<number>())
const MSG_FOLD_LINE_THRESHOLD = 50
// Right-click context menu state
const msgCtxMenu = ref<{ x: number; y: number; mi: number; role: string } | null>(null)
function isMsgFolded(mi: number, content: string): boolean {
  return content.split('\n').length > MSG_FOLD_LINE_THRESHOLD && !expandedMsgIdxs.value.has(mi)
}
function toggleMsgFold(mi: number): void {
  if (expandedMsgIdxs.value.has(mi)) expandedMsgIdxs.value.delete(mi)
  else expandedMsgIdxs.value.add(mi)
  // Trigger reactivity
  expandedMsgIdxs.value = new Set(expandedMsgIdxs.value)
}

// Inline user-bubble editing (Cursor-style: double-click to edit + resend)
const editingMsgIdx = ref<number | null>(null)
const editingMsgText = ref('')
function startInlineEdit(mi: number): void {
  if (sending.value) return
  const msg = messages.value[mi]
  if (!msg || msg.role !== 'user') return
  editingMsgIdx.value = mi
  editingMsgText.value = msg.content
  nextTick(() => {
    const el = document.getElementById(`ai-inline-edit-${mi}`) as HTMLTextAreaElement | null
    if (el) { el.focus(); el.select() }
  })
}
function cancelInlineEdit(): void { editingMsgIdx.value = null; editingMsgText.value = '' }
function submitInlineEdit(mi: number): void {
  const text = editingMsgText.value.trim()
  if (!text) { cancelInlineEdit(); return }
  messages.value[mi].content = text
  messages.value = messages.value.slice(0, mi + 1)
  cancelInlineEdit()
  saveCurrentThread()
  void regenerate()
}

// Response length preference — prepended to system prompt when sending
const responseLengths = ['normal', 'concise', 'detailed'] as const
type ResponseLength = typeof responseLengths[number]
const responseLength = ref<ResponseLength>('normal')
const RESPONSE_LENGTH_LABELS: Record<ResponseLength, string> = { normal: 'Normal', concise: 'Concise', detailed: 'Detailed' }
const RESPONSE_LENGTH_HINTS: Record<ResponseLength, string> = {
  normal: '',
  concise: 'Be concise. Keep responses short and to the point.',
  detailed: 'Be thorough and detailed. Include examples and explanations.',
}
function cycleResponseLength(): void {
  const idx = responseLengths.indexOf(responseLength.value)
  responseLength.value = responseLengths[(idx + 1) % responseLengths.length]
}

// Input char counter + token estimate (shown when > 200 chars)
const inputCharCount = computed(() => inputText.value.length)
const inputTokenEstimate = computed(() => Math.ceil(inputCharCount.value / 4))

// Context window usage — use model-specific ctx from catalog, fall back to 100k
const currentModelCtx = computed(() => {
  const entry = MODEL_CATALOG.find((m) => m.id === settingsModel.value)
  return entry?.ctx ?? 100_000
})
const conversationTokenEstimate = computed(() =>
  messages.value.reduce((sum, m) => sum + Math.ceil(String(m.rawContent ?? m.content).length / 4), 0)
)
const ctxUsagePct = computed(() => Math.min(100, Math.round((conversationTokenEstimate.value / currentModelCtx.value) * 100)))
const ctxUsageLevel = computed(() => {
  if (ctxUsagePct.value >= 90) return 'danger'
  if (ctxUsagePct.value >= 60) return 'warn'
  return 'ok'
})

// Context window cutoff: index of first message the model can actually see
const ctxCutoffIdx = computed(() => {
  if (ctxUsagePct.value < 40) return 0 // all messages fit
  const reserved = Math.ceil(settingsSystemPrompt.value.length / 4) + chipsTokenTotal.value + 2000
  const available = Math.max(0, currentModelCtx.value - reserved)
  let cumulative = 0
  for (let i = messages.value.length - 1; i >= 0; i--) {
    const m = messages.value[i]
    cumulative += Math.ceil(String(m.rawContent ?? m.content).length / 4)
    if (cumulative > available) return i + 1
  }
  return 0
})
// Auto-compact when context exceeds 90% — trigger once per overflow event
let _autoCompactFired = false
watch(ctxUsagePct, (pct) => {
  if (pct >= 90 && !_autoCompactFired && !sending.value && messages.value.filter((m) => !m.streaming).length >= 6) {
    _autoCompactFired = true
    showToast('Context 90% — auto-compacting conversation history…')
    triggerCompact()
  }
  if (pct < 60) _autoCompactFired = false  // reset when context drops after compact
})

// ── Conversation search ────────────────────────────────────────────────────────
const showSearch = ref(false)
const showHistoryPalette = ref(false)
const historyPaletteQuery = ref('')
const filteredHistory = computed(() =>
  (() => {
    const q = historyPaletteQuery.value.trim().toLowerCase()
    const reversed = [...inputHistory].reverse()
    if (!q) return reversed
    // Fuzzy: items containing all chars of query in order (Ctrl+R shell-style)
    const exact = reversed.filter(h => h.toLowerCase().includes(q))
    if (exact.length) return exact
    const chars = q.split('')
    return reversed.filter(h => {
      let idx = 0
      for (const c of h.toLowerCase()) { if (c === chars[idx]) idx++; if (idx === chars.length) return true }
      return false
    })
  })()
)
function openHistoryPalette(): void {
  showHistoryPalette.value = true
  historyPaletteQuery.value = ''
  nextTick(() => {
    const el = document.querySelector<HTMLInputElement>('.ai-history-palette-input')
    el?.focus()
  })
}
function pickHistory(prompt: string): void {
  inputText.value = prompt
  showHistoryPalette.value = false
  nextTick(() => textareaEl.value?.focus())
}

const searchQuery = ref('')
const searchMatchIdx = ref(0)
const searchInput = ref<HTMLInputElement | null>(null)

const searchMatches = computed<number[]>(() => {
  const q = searchQuery.value.trim().toLowerCase()
  if (!q) return []
  return messages.value.reduce<number[]>((acc, m, i) => {
    if (m.content.toLowerCase().includes(q)) acc.push(i)
    return acc
  }, [])
})

function openSearch(): void {
  showSearch.value = true
  searchQuery.value = ''
  searchMatchIdx.value = 0
  nextTick(() => searchInput.value?.focus())
}

function closeSearch(): void {
  showSearch.value = false
  searchQuery.value = ''
}

function searchNav(delta: number): void {
  const len = searchMatches.value.length
  if (!len) return
  searchMatchIdx.value = (searchMatchIdx.value + delta + len) % len
  const msgIdx = searchMatches.value[searchMatchIdx.value]
  const el = messagesEl.value?.querySelectorAll('.ai-msg')[msgIdx] as HTMLElement | undefined
  el?.scrollIntoView({ block: 'center', behavior: 'smooth' })
}

watch(searchQuery, () => {
  searchMatchIdx.value = 0
  if (searchMatches.value.length) searchNav(0)
})

function isSearchMatch(idx: number): boolean {
  return showSearch.value && searchMatches.value.includes(idx)
}

function isSearchActive(idx: number): boolean {
  return showSearch.value && searchMatches.value[searchMatchIdx.value] === idx
}

function renderWithSearchHighlight(content: string): string {
  const html = renderMarkdownLite(content)
  const q = searchQuery.value.trim()
  if (!showSearch.value || !q) return html
  // Only highlight in text nodes — skip content inside HTML tags
  const escaped = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return html.replace(
    new RegExp(`(?![^<]*>)(${escaped})`, 'gi'),
    '<mark class="ai-search-highlight">$1</mark>',
  )
}

// ── Global cross-thread search (Ctrl+Shift+F) ─────────────────────────────────
interface GlobalSearchResult {
  threadId: string
  threadTitle: string
  msgIdx: number
  role: string
  snippet: string
}

const showGlobalSearch = ref(false)
const globalSearchQuery = ref('')
const globalSearchInput = ref<HTMLInputElement | null>(null)
const globalSearchActiveIdx = ref(-1)

const globalSearchResults = computed<GlobalSearchResult[]>(() => {
  const q = globalSearchQuery.value.trim().toLowerCase()
  if (!q || q.length < 2) return []
  const results: GlobalSearchResult[] = []
  for (const thread of allThreads.value) {
    for (let i = 0; i < thread.messages.length; i++) {
      const m = thread.messages[i]
      const text = typeof m.rawContent === 'string' ? m.rawContent : m.content
      if (text.toLowerCase().includes(q)) {
        const idx = text.toLowerCase().indexOf(q)
        const start = Math.max(0, idx - 40)
        const end = Math.min(text.length, idx + q.length + 60)
        const snippet = (start > 0 ? '…' : '') + text.slice(start, end) + (end < text.length ? '…' : '')
        results.push({ threadId: thread.id, threadTitle: thread.title, msgIdx: i, role: m.role, snippet })
        if (results.length >= 50) return results
      }
    }
  }
  return results
})

function highlightSearchMatch(snippet: string, query: string): string {
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  if (!query || query.length < 2) return esc(snippet)
  const qLow = query.toLowerCase()
  const parts: string[] = []
  let i = 0
  while (i < snippet.length) {
    const pos = snippet.toLowerCase().indexOf(qLow, i)
    if (pos === -1) { parts.push(esc(snippet.slice(i))); break }
    parts.push(esc(snippet.slice(i, pos)))
    parts.push(`<mark class="ai-search-hl">${esc(snippet.slice(pos, pos + qLow.length))}</mark>`)
    i = pos + qLow.length
  }
  return parts.join('')
}

function renderWebChipContent(src: string): string {
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  const truncated = src.slice(0, 1200) + (src.length > 1200 ? '\n…' : '')
  return truncated.split(/(https?:\/\/[^\s<>"]+)/g).map((part, i) =>
    i % 2 === 1
      ? `<a class="ai-chip-url-link" href="#" data-url="${esc(part)}">${esc(part)}</a>`
      : esc(part)
  ).join('')
}
function onChipUrlClick(e: Event): void {
  const a = (e.target as HTMLElement).closest<HTMLAnchorElement>('.ai-chip-url-link')
  if (!a) return
  e.preventDefault()
  const url = a.dataset.url ?? ''
  if (url) void window.agentTeam?.openExternal(url)
}
function openGlobalSearch(): void {
  showGlobalSearch.value = true
  globalSearchQuery.value = ''
  globalSearchActiveIdx.value = -1
  nextTick(() => globalSearchInput.value?.focus())
}

function closeGlobalSearch(): void {
  showGlobalSearch.value = false
  globalSearchQuery.value = ''
  globalSearchActiveIdx.value = -1
}

function onGlobalSearchKeydown(e: KeyboardEvent): void {
  const len = globalSearchResults.value.length
  if (!len) return
  if (e.key === 'ArrowDown') {
    e.preventDefault()
    globalSearchActiveIdx.value = Math.min(globalSearchActiveIdx.value + 1, len - 1)
    nextTick(() => {
      const el = document.querySelector<HTMLElement>(`.ai-global-search-result.gsr-active`)
      el?.scrollIntoView({ block: 'nearest' })
    })
  } else if (e.key === 'ArrowUp') {
    e.preventDefault()
    globalSearchActiveIdx.value = Math.max(globalSearchActiveIdx.value - 1, 0)
    nextTick(() => {
      const el = document.querySelector<HTMLElement>(`.ai-global-search-result.gsr-active`)
      el?.scrollIntoView({ block: 'nearest' })
    })
  } else if (e.key === 'Enter' && globalSearchActiveIdx.value >= 0) {
    e.preventDefault()
    const r = globalSearchResults.value[globalSearchActiveIdx.value]
    if (r) jumpToGlobalResult(r)
  }
}

watch(globalSearchQuery, () => { globalSearchActiveIdx.value = -1 })

function jumpToGlobalResult(r: GlobalSearchResult): void {
  closeGlobalSearch()
  if (r.threadId !== currentThreadId.value) {
    switchThread(r.threadId)
  }
  nextTick(() => {
    const el = messagesEl.value?.querySelectorAll('.ai-msg')[r.msgIdx] as HTMLElement | undefined
    el?.scrollIntoView({ block: 'center', behavior: 'smooth' })
    el?.classList.add('ai-msg-flash')
    setTimeout(() => el?.classList.remove('ai-msg-flash'), 1200)
  })
}

// ── Context chips (@mentions) ──────────────────────────────────────────────────
interface ContextChip {
  id: string
  label: string
  content: string
  imageData?: string // base64 data URL for pasted images (e.g. data:image/png;base64,...)
  pinned?: boolean   // pinned chips survive message sends — always included in context
  sourceId?: string  // original option.id used to create this chip — enables refresh
}
const contextChips = ref<ContextChip[]>([])
const previewChipId = ref<string | null>(null)
const previewChip = computed(() => contextChips.value.find((c) => c.id === previewChipId.value) ?? null)
const showAtMenu = ref(false)
const atMenuFilter = ref('')
const atMenuIdx = ref(0)
const atMenuEl = ref<HTMLElement | null>(null)

interface AtOption { id: string; label: string; group?: string }
const AT_OPTIONS_STATIC: AtOption[] = [
  { id: '@file', label: '@file — current open file', group: 'Files & Editor' },
  { id: '@recent', label: '@recent — recently opened files in this session', group: 'Files & Editor' },
  { id: '@selection', label: '@selection — editor selection', group: 'Files & Editor' },
  { id: '@tabs', label: '@tabs — all currently open editor tabs as context', group: 'Files & Editor' },
  { id: '@folder', label: '@folder — all files in a directory', group: 'Files & Editor' },
  { id: '@glob:', label: '@glob:pattern — add files matching glob (e.g. @glob:src/**/*.ts)', group: 'Files & Editor' },
  { id: '@symbol', label: '@symbol — find a function or class definition', group: 'Files & Editor' },
  { id: '@usages',   label: '@usages — find all call sites of a symbol (e.g. @usages:MyFunc)', group: 'Files & Editor' },
  { id: '@related',    label: '@related — files that import or are imported by the current file', group: 'Files & Editor' },
  { id: '@dependents', label: '@dependents — find all files that import the current open file', group: 'Files & Editor' },
  { id: '@git', label: '@git — current git diff (unstaged)', group: 'Git' },
  { id: '@git:staged', label: '@git:staged — staged changes (git diff --cached)', group: 'Git' },
  { id: '@git:log', label: '@git:log — recent commit history (last 20, or @git:log:50 / @git:log:verbose)', group: 'Git' },
  { id: '@git:branch', label: '@git:branch — current branch & last commit', group: 'Git' },
  { id: '@git:blame',     label: '@git:blame — blame for current open file', group: 'Git' },
  { id: '@git:file-log', label: '@git:file-log — commit history for the current open file', group: 'Git' },
  { id: '@git:recent',   label: '@git:recent — recently committed files (last 5)', group: 'Git' },
  { id: '@git:modified', label: '@git:modified — list all uncommitted changed files', group: 'Git' },
  { id: '@git:conflicts', label: '@git:conflicts — show unresolved merge conflict markers', group: 'Git' },
  { id: '@git:stash',        label: '@git:stash — list all git stashes', group: 'Git' },
  { id: '@git:tag',          label: '@git:tag — list recent git tags', group: 'Git' },
  { id: '@git:contributors', label: '@git:contributors — top contributors (git shortlog)', group: 'Git' },
  { id: '@git:pr',       label: '@git:pr — current branch PR title, body & review status (requires gh CLI)', group: 'Git' },
  { id: '@git:diff',     label: '@git:diff — diff current branch vs another (e.g. @git:diff:main)', group: 'Git' },
  { id: '@git:commit',   label: '@git:commit — show a specific commit by hash (e.g. @git:commit:abc1234)', group: 'Git' },
  { id: '@git:conflict', label: '@git:conflict — files with merge conflicts (<<<<<<< markers)', group: 'Git' },
  { id: '@git:remote',   label: '@git:remote — remote URLs, tracking branches, and push/pull status', group: 'Git' },
  { id: '@git:author',   label: '@git:author — git blame for current file (author + timestamp per line)', group: 'Git' },
  { id: '@diff:',      label: '@diff:path — git diff of a specific file (e.g. @diff:src/App.vue)', group: 'Git' },
  { id: '@codebase', label: '@codebase — search workspace code', group: 'Analysis' },
  { id: '@problems', label: '@problems — TypeScript & lint errors', group: 'Analysis' },
  { id: '@test:results', label: '@test:results — run test suite and attach output (vitest/pytest/jest)', group: 'Analysis' },
  { id: '@lint',       label: '@lint — run ESLint / ruff / mypy and attach errors', group: 'Analysis' },
  { id: '@coverage',   label: '@coverage — test coverage report (vitest/pytest-cov/jest)', group: 'Analysis' },
  { id: '@build',      label: '@build — last build output (npm build / vite build / tsc errors)', group: 'Analysis' },
  { id: '@ci',         label: '@ci — last CI/CD run status (GitHub Actions / .github/workflows)', group: 'Analysis' },
  { id: '@todos',      label: '@todos — grep TODO/FIXME/HACK comments across the workspace', group: 'Analysis' },
  { id: '@workspace', label: '@workspace — full project overview (README + tree + deps + rules)', group: 'Project' },
  { id: '@tree', label: '@tree — workspace file tree structure', group: 'Project' },
  { id: '@package',    label: '@package — package.json scripts & dependencies overview', group: 'Project' },
  { id: '@env',      label: '@env — project env vars from .env.example (no secrets)', group: 'Project' },
  { id: '@rules',      label: '@rules — project AI rules (.cursorrules / AGENTS.md / .cursor/rules/*.mdc)', group: 'Project' },
  { id: '@schema',     label: '@schema — database schema (Prisma, SQL migrations, TypeORM entities)', group: 'Project' },
  { id: '@config',     label: '@config — project config files (tsconfig, eslint, vite, prettier, jest)', group: 'Project' },
  { id: '@readme',     label: '@readme — inject README.md from workspace root as context', group: 'Project' },
  { id: '@changelog',  label: '@changelog — CHANGELOG.md or CHANGES.md from workspace root', group: 'Project' },
  { id: '@lock',       label: '@lock — package lock file summary (key deps & versions)', group: 'Project' },
  { id: '@port',       label: '@port — active dev servers & listening ports in this workspace', group: 'Project' },
  { id: '@tests',      label: '@tests — test files related to the current open file', group: 'Project' },
  { id: '@url', label: '@url — fetch a web page as context', group: 'Web & Docs' },
  { id: '@web',      label: '@web — real-time web search (DuckDuckGo)', group: 'Web & Docs' },
  { id: '@docs',     label: '@docs — fetch official documentation as context', group: 'Web & Docs' },
  { id: '@clipboard', label: '@clipboard — paste clipboard content', group: 'Other' },
  { id: '@notepad',  label: '@notepad — persistent workspace notepad (cross-session)', group: 'Other' },
  { id: '@memories',   label: '@memories — your saved persistent memory facts', group: 'Other' },
  { id: '@model', label: '@model — switch model for next message (e.g. @model:gpt-4o)', group: 'Other' },
  { id: '@terminal',   label: '@terminal — recent terminal output / last command result (Cursor-style)', group: 'Other' },
  { id: '@hotkeys',    label: '@hotkeys — all keyboard shortcuts for the editor and AI chat', group: 'Other' },
  { id: '@snippets',      label: '@snippets — all saved code snippets (via /snippet:save)', group: 'Other' },
  { id: '@thread:summary', label: '@thread:summary — AI-generated summary of the current thread conversation', group: 'Other' },
  { id: '@pinned:msgs',    label: '@pinned:msgs — all pinned messages in the current thread', group: 'Other' },
  { id: '@local:changes', label: '@local:changes — all locally modified files with their full diffs', group: 'Other' },
]
const atDirItems = ref<AtOption[]>([])
const recentAtFiles = ref<string[]>([])
// Recently used static @ options — persisted in the settings store for cross-session memory
const recentAtIds = ref<string[]>(
  (() => { try { return JSON.parse(settingsGet('ai-recent-at', '[]')) as string[] } catch { return [] } })(),
)
watch(recentAtIds, (v) => {
  settingsSet('ai-recent-at', JSON.stringify(v.slice(0, 8)))
})
function trackRecentAt(id: string): void {
  if (!id || id.startsWith('@file') || id.startsWith('@recent-')) return
  recentAtIds.value = [id, ...recentAtIds.value.filter((r) => r !== id)].slice(0, 8)
}

const DOCS_CATALOG: Record<string, { label: string; url: string }> = {
  'vue':        { label: 'Vue 3 Docs',       url: 'https://vuejs.org/guide/introduction.html' },
  'react':      { label: 'React Docs',        url: 'https://react.dev/learn' },
  'typescript': { label: 'TypeScript Handbook', url: 'https://www.typescriptlang.org/docs/handbook/intro.html' },
  'vite':       { label: 'Vite Docs',         url: 'https://vitejs.dev/guide/' },
  'electron':   { label: 'Electron Docs',     url: 'https://www.electronjs.org/docs/latest/api/app' },
  'python':     { label: 'Python Docs',       url: 'https://docs.python.org/3/library/index.html' },
  'fastapi':    { label: 'FastAPI Docs',      url: 'https://fastapi.tiangolo.com/' },
  'nodejs':     { label: 'Node.js Docs',      url: 'https://nodejs.org/en/docs/' },
  'tailwind':   { label: 'Tailwind CSS Docs', url: 'https://tailwindcss.com/docs/installation' },
  'mdn':        { label: 'MDN Web Docs',      url: 'https://developer.mozilla.org/en-US/docs/Web' },
}

const atOptions = ref<AtOption[]>([...AT_OPTIONS_STATIC])

// Flat list with group-header sentinels injected when showing unfiltered static list.
// Each real option also carries _realIdx (= its index in atOptions.value) so
// keyboard nav (atMenuIdx) maps correctly, and _isRecent for a visual badge.
interface AtDisplayItem extends AtOption { _isGroupHeader?: boolean; _realIdx?: number; _isRecent?: boolean }
const atOptionsDisplay = computed<AtDisplayItem[]>(() => {
  const opts = atOptions.value
  // Only inject group headers for the full static list (not dynamic search results)
  if (opts.length === AT_OPTIONS_STATIC.length && opts[0]?.group !== undefined) {
    const recentSet = new Set(recentAtIds.value)
    const result: AtDisplayItem[] = []
    let lastGroup = ''
    let ri = 0
    for (const opt of opts) {
      const g = opt.group ?? ''
      if (g && g !== lastGroup) {
        result.push({ id: `__group__${g}`, label: g, _isGroupHeader: true })
        lastGroup = g
      }
      result.push({ ...opt, _realIdx: ri++, _isRecent: recentSet.has(opt.id) })
    }
    return result
  }
  return opts.map((o, i) => ({ ...o, _realIdx: i }))
})

watch(() => props.getActiveRelPath?.(), (path) => {
  if (path && !recentAtFiles.value.includes(path)) {
    recentAtFiles.value.unshift(path)
    if (recentAtFiles.value.length > 8) recentAtFiles.value.pop()
  }
})

// ── Slash commands ────────────────────────────────────────────────────────────
interface SlashCommand { id: string; label: string; description: string; template: string }
const SLASH_COMMANDS: SlashCommand[] = [
  { id: '/explain', label: '/explain', description: 'Explain code',             template: 'Explain the following code in detail:' },
  { id: '/fix',     label: '/fix',     description: 'Fix issue (add @problems for TS errors)', template: 'Find and fix the issues in the following code:' },
  { id: '/tests',   label: '/tests',   description: 'Generate tests',          template: 'Write comprehensive unit tests for the following code:' },
  { id: '/doc',     label: '/doc',     description: 'Write docs',              template: 'Write clear documentation for the following code:' },
  { id: '/review',   label: '/review',   description: 'Code review',           template: 'Review the following code and point out potential issues and improvements:' },
  { id: '/optimize', label: '/optimize', description: 'Performance optimization', template: 'Analyze performance bottlenecks in the following code and provide optimization suggestions:' },
  { id: '/refactor', label: '/refactor', description: 'Refactor code',         template: 'Refactor the following code to improve readability and maintainability without changing functionality:' },
  { id: '/new',       label: '/new',       description: 'Create new file',     template: 'Create a new file with the following content:' },
  { id: '/debug',     label: '/debug',     description: 'Find bugs',            template: 'Analyze the following code for bugs, edge cases, and potential runtime errors. Be specific about line numbers and root causes:\n\n' },
  { id: '/improve',   label: '/improve',   description: 'Suggest improvements', template: 'Suggest concrete improvements for the following code in terms of readability, maintainability, and best practices:\n\n' },
  { id: '/commit',    label: '/commit',    description: 'AI commit message',   template: 'Generate a concise git commit message (conventional commits format) for the following changes:\n\n' },
  { id: '/summarize', label: '/summarize', description: 'Summarize conversation', template: '' },
  { id: '/run',      label: '/run',      description: 'Run shell command',       template: '' },
  { id: '/clear',    label: '/clear',    description: 'Clear chat',             template: '' },
  { id: '/export',   label: '/export',   description: 'Export chat (default: markdown; /export json; /export html)',  template: '' },
  { id: '/help',     label: '/help',     description: 'Show all commands',       template: '' },
  { id: '/test',     label: '/test',     description: 'Run test suite',          template: '' },
  { id: '/diff',     label: '/diff',     description: 'Explain current diff',    template: '' },
  { id: '/continue', label: '/continue', description: 'Continue last response',  template: '' },
  { id: '/compact',     label: '/compact',     description: 'Summarize & compress history to free context', template: '' },
  { id: '/checkpoint',  label: '/checkpoint',  description: 'Save a conversation checkpoint',              template: '' },
  { id: '/checkpoints', label: '/checkpoints', description: 'View and restore checkpoints',                template: '' },
  { id: '/model',    label: '/model',    description: 'Switch model for this conversation',            template: '' },
  { id: '/rename',   label: '/rename',   description: 'Rename this chat thread',                       template: '' },
  { id: '/pin',      label: '/pin',      description: 'Pin / unpin this chat thread',                  template: '' },
  { id: '/generate', label: '/generate', description: 'Generate a new file from description',          template: '' },
  { id: '/search',       label: '/search',       description: 'Search codebase for a symbol or string',              template: '' },
  { id: '/search:regex', label: '/search:regex', description: 'Search codebase using a regular expression pattern',    template: '' },
  { id: '/fixtests',     label: '/fixtests',     description: 'Run tests, then auto-ask AI to fix failures',       template: '' },
  { id: '/save-summary', label: '/save-summary', description: 'Summarize key decisions & save to Notepad',             template: '' },
  { id: '/translate',    label: '/translate',    description: 'Translate code comments/strings to another language (e.g. /translate Spanish)', template: '' },
  { id: '/spell',        label: '/spell',        description: 'Fix spelling and grammar in the current file or selection', template: '' },
  { id: '/git',          label: '/git',          description: 'Quick git status + recent commits summary',               template: '' },
  { id: '/save-prompt',  label: '/save-prompt',  description: 'Save current input as a reusable prompt template (e.g. /save-prompt Code Review)', template: '' },
  { id: '/prompts',      label: '/prompts',      description: 'Browse and load saved prompt templates',                  template: '' },
  { id: '/import',       label: '/import',       description: 'Import a chat from a JSON file (exported via /export)',   template: '' },
  { id: '/pr',           label: '/pr',           description: 'Generate a pull request title + description from current git changes', template: '' },
  { id: '/changelog',    label: '/changelog',    description: 'Generate a CHANGELOG entry from recent git commits',                   template: '' },
  { id: '/explain:imports', label: '/explain:imports', description: 'Explain what each import/dependency in the current file does and why it is used', template: '' },
  { id: '/perf',         label: '/perf',         description: 'Analyze code for performance bottlenecks and suggest optimizations',   template: 'Analyze the following code for performance bottlenecks. For each issue: identify the problem, estimate its impact, and provide a concrete optimized version with explanation:\n\n' },
  { id: '/security',     label: '/security',     description: 'Audit code for security vulnerabilities (OWASP, injection, etc.)',    template: 'Perform a security audit on the following code. Check for OWASP Top 10 vulnerabilities, injection flaws, authentication issues, data exposure, and any other security risks. For each finding provide: severity (Critical/High/Medium/Low), description, and fix:\n\n' },
  { id: '/types',        label: '/types',        description: 'Generate or improve TypeScript type definitions for the code',        template: 'Generate comprehensive TypeScript type definitions for the following code. Include interfaces, type aliases, and generics where appropriate. Ensure strict typing with no implicit any:\n\n' },
  { id: '/mock',         label: '/mock',         description: 'Generate mocks / stubs for a class, interface, or function',         template: 'Generate complete test mocks and stubs for the following code. Use the project\'s existing test framework (jest/vitest/pytest). Include factory functions, type-safe mock implementations, and example usage in a test:\n\n' },
  { id: '/scaffold',     label: '/scaffold',     description: 'Scaffold a new file, component, or module from description',         template: '' },
  { id: '/diagram',      label: '/diagram',      description: 'Generate a Mermaid diagram (flowchart, sequence, class, ER, etc.)',  template: 'Generate a Mermaid diagram that visualizes the following. Choose the most appropriate diagram type (flowchart, sequenceDiagram, classDiagram, erDiagram, stateDiagram, or gitGraph). Return only the Mermaid code block:\n\n' },
  { id: '/migrate',        label: '/migrate',        description: 'Suggest migration steps between API versions or framework upgrades', template: 'Provide a step-by-step migration plan for the following. For each step: describe the change, show before/after code, and flag any breaking changes or caveats:\n\n' },
  { id: '/review:staged',  label: '/review:staged',  description: 'Code review staged changes (git diff --cached)',                    template: '' },
  { id: '/review:branch',  label: '/review:branch',  description: 'Code review all changes on current branch vs main',                 template: '' },
  { id: '/fix:lint',       label: '/fix:lint',       description: 'Run linter, inject errors, ask AI to fix them',                     template: '' },
  { id: '/coverage',       label: '/coverage',       description: 'Run test coverage and show uncovered lines for current file',        template: '' },
  { id: '/label',          label: '/label',          description: 'Set a label for this thread (🐛 Bug, ✨ Feature, ❓ Question, …)',     template: '' },
  { id: '/recap',          label: '/recap',          description: 'Quick 3-bullet recap of key decisions in this conversation',          template: '' },
  { id: '/instructions',   label: '/instructions',   description: 'Set custom AI instructions for this thread only',                     template: '' },
  { id: '/ask',            label: '/ask',            description: 'Ask a question about the codebase (auto-injects @codebase search)',   template: '' },
  { id: '/commit:amend',   label: '/commit:amend',   description: 'Improve the last git commit message with AI',                        template: '' },
  { id: '/memory',         label: '/memory',         description: 'Add a persistent memory fact (auto-injected into every conversation)',   template: '' },
  { id: '/memory:clear',   label: '/memory:clear',   description: 'Clear all memories',                                                    template: '' },
  { id: '/refactor:extract', label: '/refactor:extract', description: 'Extract selected code into a named function/variable',              template: '' },
  { id: '/init:rules',       label: '/init:rules',       description: 'Analyze codebase & generate .cursorrules / AI instructions file',    template: '' },
  { id: '/explain:commit',   label: '/explain:commit',   description: 'Explain the last N commits in plain English (e.g. /explain:commit 5)', template: '' },
  { id: '/format',           label: '/format',           description: 'Run code formatter (prettier/black) on current file and show changes', template: '' },
  { id: '/docgen',           label: '/docgen',           description: 'Generate JSDoc/docstring documentation for the current file',          template: '' },
  { id: '/optimize:imports', label: '/optimize:imports', description: 'Remove unused imports and sort them in the current file',             template: '' },
  { id: '/test:update',      label: '/test:update',      description: 'Run failing tests and ask AI to update assertions or fix failures',     template: '' },
  { id: '/api',              label: '/api',              description: 'Detect and list all API routes in the project',                         template: '' },
  { id: '/todo',             label: '/todo',             description: 'Find all TODO/FIXME comments and ask AI to resolve them',               template: '' },
  { id: '/size',             label: '/size',             description: 'Analyze file size, complexity, and suggest splits for large files',      template: '' },
  { id: '/stash',            label: '/stash',            description: 'List git stashes, or push/pop — e.g. /stash push "WIP"',                 template: '' },
  { id: '/review:pr',        label: '/review:pr',        description: 'Fetch current PR details + diff and ask AI to review (requires gh CLI)', template: '' },
  { id: '/deps:check',       label: '/deps:check',       description: 'Check for outdated or vulnerable dependencies',                           template: '' },
  { id: '/debug:stack',      label: '/debug:stack',      description: 'Paste a stack trace and ask AI to explain and suggest a fix',            template: '' },
  { id: '/rename:symbol',    label: '/rename:symbol',    description: 'Rename a symbol (function/variable/class) across the codebase with AI',  template: '' },
  { id: '/coverage:add',     label: '/coverage:add',     description: 'Identify uncovered lines in the current file and generate missing tests',  template: '' },
  { id: '/open',             label: '/open',             description: 'Open a file in the editor by name or pattern (e.g. /open App.vue)',         template: '' },
  { id: '/branch',           label: '/branch',           description: 'List, create, or switch git branches (e.g. /branch feat/my-feature)',       template: '' },
  { id: '/env:check',        label: '/env:check',        description: 'Compare .env.example with .env and find missing variables',                  template: '' },
  { id: '/fixall',           label: '/fixall',           description: 'Fix all errors/warnings from the Problems panel in one AI pass',              template: '' },
  { id: '/worktree',         label: '/worktree',         description: 'Manage git worktrees: /worktree list | add <path> <branch> | remove <path>',  template: '' },
  { id: '/accessibility',    label: '/accessibility',    description: 'Audit HTML/JSX/Vue template for WCAG accessibility issues and suggest fixes',  template: '' },
  { id: '/regex',            label: '/regex',            description: 'Build, explain, or test a regex pattern (e.g. /regex email validator)',        template: '' },
  { id: '/pin:file',         label: '/pin:file',         description: 'Pin current open file to Always-Include (injected into every conversation)',     template: '' },
  { id: '/context:clear',    label: '/context:clear',    description: 'Clear all context chips from the input area',                                    template: '' },
  { id: '/gen:component',    label: '/gen:component',    description: 'Generate a Vue/React component from a description (e.g. /gen:component Modal)',  template: '' },
  { id: '/rules:show',       label: '/rules:show',       description: 'Show all active AI rule files (.cursorrules, AGENTS.md, .cursor/rules/*.mdc)',       template: '' },
  { id: '/mode',             label: '/mode',             description: 'Switch chat mode: /mode ask | /mode edit | /mode agent',                               template: '' },
  { id: '/session:stats',    label: '/session:stats',    description: 'Show token usage and estimated cost for this conversation session',                     template: '' },
  { id: '/gen:sql',          label: '/gen:sql',          description: 'Generate SQL query from description (e.g. /gen:sql users who signed up last month)',    template: '' },
  { id: '/typecheck',        label: '/typecheck',        description: 'Run TypeScript (vue-tsc) or Python (mypy) type check and ask AI to fix errors',           template: '' },
  { id: '/arch',             label: '/arch',             description: 'Generate an architecture overview of the codebase (structure, key modules, dependencies)',  template: '' },
  { id: '/diff:explain',     label: '/diff:explain',     description: 'Explain a commit or branch diff in plain English (e.g. /diff:explain abc1234)',            template: '' },
  { id: '/refactor:file',   label: '/refactor:file',   description: 'Refactor the entire current file: rename, restructure, simplify (AI-guided)',                  template: '' },
  { id: '/clone:thread',    label: '/clone:thread',    description: 'Fork current thread into a new one, keeping full conversation history',                         template: '' },
  { id: '/gen:readme',      label: '/gen:readme',      description: 'Generate or update README.md from the current project structure and code',                      template: '' },
  { id: '/explain:selection', label: '/explain:selection', description: 'Explain the currently selected code in the editor in plain English',                        template: '' },
  { id: '/git:cherry-pick', label: '/git:cherry-pick', description: 'Guide through cherry-picking a commit from another branch (e.g. /git:cherry-pick abc1234)',    template: '' },
  { id: '/snippet:save',    label: '/snippet:save',    description: 'Save highlighted code as a named reusable snippet (e.g. /snippet:save error-handler)',          template: '' },
  { id: '/snippet:list',    label: '/snippet:list',    description: 'Browse and insert saved code snippets',                                                          template: '' },
  { id: '/ask:codebase',    label: '/ask:codebase',    description: 'Ask a question about the entire codebase with auto file-tree context (e.g. /ask:codebase where is auth handled?)', template: '' },
  { id: '/gen:types',       label: '/gen:types',       description: 'Generate TypeScript types / Pydantic models from a JSON example or schema description',         template: '' },
  { id: '/perf:profile',    label: '/perf:profile',    description: 'Ask AI to identify the most likely performance hotspots from the current file or selection',     template: '' },
  { id: '/explain:error',  label: '/explain:error',  description: 'Paste a terminal error / stack trace and get an explanation + fix (VS Code "Fix using Copilot")', template: '' },
  { id: '/shortcuts',      label: '/shortcuts',      description: 'Show all keyboard shortcuts available in the editor and AI chat',                                    template: '' },
  { id: '/lint:all',       label: '/lint:all',       description: 'Run ESLint / Ruff on the entire project and summarize all issues',                                   template: '' },
  { id: '/compare:files',  label: '/compare:files',  description: 'Compare two files and explain the differences (e.g. /compare:files a.ts b.ts)',                     template: '' },
  { id: '/context:show',   label: '/context:show',   description: 'Show all active context chips with content sizes and previews',                                      template: '' },
  { id: '/git:log:author', label: '/git:log:author', description: 'Show recent commits by a specific author (e.g. /git:log:author alice)',                              template: '' },
  { id: '/resolve:conflict', label: '/resolve:conflict', description: 'Detect and guide through git merge conflict resolution in the current file',                    template: '' },
  { id: '/revert:edit',    label: '/revert:edit',    description: 'Revert the last AI-applied file change back to original (undo apply)',                               template: '' },
  { id: '/gen:test:e2e',   label: '/gen:test:e2e',   description: 'Generate end-to-end (Playwright/Cypress) tests for the current component or page',                  template: '' },
  { id: '/hotfix',          label: '/hotfix',          description: 'Inject Problems panel + test failures and ask AI to fix all issues in one pass',                       template: '' },
  { id: '/review:all',      label: '/review:all',      description: 'Comprehensive code review: security + performance + style + correctness combined',                     template: '' },
  { id: '/git:rebase',      label: '/git:rebase',      description: 'Interactive rebase guidance — list commits and guide through squash/fixup/reorder',                    template: '' },
  { id: '/test:single',     label: '/test:single',     description: 'Run a specific test file or pattern (e.g. /test:single useGit.test.ts)',                               template: '' },
  { id: '/summarize:code',  label: '/summarize:code',  description: 'Generate a concise TL;DR summary of the current file or selected function',                            template: '' },
  { id: '/agent:task',      label: '/agent:task',      description: 'Break a complex task into steps and guide AI to execute them sequentially (Cursor Composer style)',    template: '' },
  { id: '/coverage:report', label: '/coverage:report', description: 'Run full project test coverage and show a summary table by file',                                      template: '' },
  { id: '/thread:stats',    label: '/thread:stats',    description: 'Show statistics for the current thread: message count, token estimate, duration',                       template: '' },
  { id: '/lint:fix:auto',   label: '/lint:fix:auto',   description: 'Run auto-fixable lint fixes (eslint --fix / ruff --fix) and show what changed',                         template: '' },
  { id: '/note:add',        label: '/note:add',        description: 'Quickly append a note to the active notepad (e.g. /note:add Remember to update the tests)',              template: '' },
  { id: '/gen:table',       label: '/gen:table',       description: 'Generate a markdown table from a description or data (e.g. /gen:table API endpoints with method, path, auth)', template: '' },
  { id: '/format:json',     label: '/format:json',     description: 'Pretty-print / validate JSON in the current selection or file',                                          template: '' },
  { id: '/git:stash:apply', label: '/git:stash:apply', description: 'List git stashes and apply the most recent one (or /git:stash:apply <index>)',                            template: '' },
  { id: '/doc:project',     label: '/doc:project',     description: 'Generate project-level documentation: architecture, modules, and data flow',                              template: '' },
  { id: '/improve:prompt',  label: '/improve:prompt',  description: 'AI rewrites and improves your current draft input for better clarity and results',                        template: '' },
  { id: '/explain:file',    label: '/explain:file',    description: 'Explain what a specific file does (e.g. /explain:file src/App.vue)',                                     template: '' },
  { id: '/git:log:file',    label: '/git:log:file',    description: 'Show git commit history for the current open file (or a specific path)',                                  template: '' },
  { id: '/gen:env',         label: '/gen:env',         description: 'Scan codebase for env var usage and generate a .env.example file',                                        template: '' },
  { id: '/ask:selection',   label: '/ask:selection',   description: 'Ask any question about the currently selected code in the editor',                                        template: '' },
  { id: '/debug:console',   label: '/debug:console',   description: 'Paste console output / log lines and get AI interpretation and fix suggestions',                          template: '' },
  { id: '/convert:types',   label: '/convert:types',   description: 'Convert between type systems: Zod ↔ TypeScript, Pydantic ↔ TypeScript, JSON Schema ↔ types',             template: '' },
  { id: '/fix:types',       label: '/fix:types',       description: 'Run TypeScript type checker and ask AI to fix all type errors',                                             template: '' },
  { id: '/explain:regex',   label: '/explain:regex',   description: 'Explain a regular expression in plain language — paste a regex and get a step-by-step breakdown',         template: '' },
  { id: '/mock:data',       label: '/mock:data',       description: 'Generate realistic mock/test data for a TypeScript interface, Pydantic model, or JSON schema',            template: '' },
  { id: '/find:dead:code',  label: '/find:dead:code',  description: 'Find unused functions, variables, exports, and dead code across the codebase',                            template: '' },
  { id: '/deps:outdated',   label: '/deps:outdated',   description: 'Check for outdated npm/pip packages and get AI-guided update recommendations',                            template: '' },
  { id: '/add:types',       label: '/add:types',       description: 'Add TypeScript type annotations to the current file — no any, explicit return types, full interfaces',         template: '' },
  { id: '/dockerfile',      label: '/dockerfile',      description: 'Generate a production-ready Dockerfile for this project, or explain/fix the existing one',                    template: '' },
  { id: '/ci:help',         label: '/ci:help',         description: 'Review or generate CI/CD pipeline configuration (GitHub Actions, GitLab CI, CircleCI, etc.)',                 template: '' },
]
const showSlashMenu = ref(false)
const slashMenuFilter = ref('')
const slashMenuIdx = ref(0)
const slashMenuEl = ref<HTMLElement | null>(null)
const slashOptions = ref<SlashCommand[]>([...SLASH_COMMANDS])
// Recently used commands — shown at top of slash menu (VS Code parity)
const recentCmds = ref<string[]>(
  (() => { try { return JSON.parse(settingsGet('ai-recent-cmds', '[]')) as string[] } catch { return [] } })(),
)
function trackRecentCmd(id: string): void {
  recentCmds.value = [id, ...recentCmds.value.filter((c) => c !== id)].slice(0, 6)
  settingsSet('ai-recent-cmds', JSON.stringify(recentCmds.value))
}

// ── Code-block copy via event delegation ─────────────────────────────────────
async function onMessagesClick(e: MouseEvent): Promise<void> {
  const target = e.target as Element
  // Copy button
  const copyBtn = target.closest<HTMLButtonElement>('.ai-code-copy-btn')
  if (copyBtn) {
    try {
      const code = decodeURIComponent(escape(atob(copyBtn.dataset.code ?? '')))
      navigator.clipboard.writeText(code).then(() => {
        copyBtn.textContent = 'Copied!'
        window.setTimeout(() => { copyBtn.textContent = 'Copy' }, 1500)
      }).catch(() => {/* ignore */})
    } catch {/* ignore */}
    return
  }
  // Code block word-wrap toggle
  const wrapBtn = target.closest<HTMLButtonElement>('.ai-code-wrap-btn')
  if (wrapBtn) {
    const pre = wrapBtn.closest('.ai-code-wrap')?.querySelector<HTMLElement>('pre.ai-code-block')
    if (!pre) return
    const wrapped = pre.style.whiteSpace === 'pre-wrap'
    pre.style.whiteSpace = wrapped ? '' : 'pre-wrap'
    pre.style.overflowX = wrapped ? '' : 'hidden'
    wrapBtn.classList.toggle('active', !wrapped)
    wrapBtn.title = wrapped ? 'Toggle word wrap' : 'Disable word wrap'
    return
  }
  // Code fold/expand toggle
  const foldBtn = target.closest<HTMLButtonElement>('.ai-code-fold-btn')
  if (foldBtn) {
    const wrap = foldBtn.closest<HTMLElement>('.ai-code-wrap')
    const pre = wrap?.querySelector<HTMLElement>('pre.ai-code-block')
    if (!pre || !wrap) return
    const folded = wrap.dataset.folded === 'true'
    const lines = foldBtn.dataset.lines ?? '?'
    if (folded) {
      pre.style.display = ''
      wrap.dataset.folded = 'false'
      foldBtn.textContent = `▼ Collapse (${lines} lines)`
    } else {
      pre.style.display = 'none'
      wrap.dataset.folded = 'true'
      foldBtn.textContent = `▶ Expand (${lines} lines)`
    }
    return
  }

  // Apply to editor button
  const applyBtn = target.closest<HTMLButtonElement>('.ai-code-apply-btn')
  if (applyBtn) {
    try {
      const code = decodeURIComponent(escape(atob(applyBtn.dataset.code ?? '')))
      // Prefer path inferred from code block first-line comment
      const relPath = (applyBtn.dataset.path || null) ?? props.getActiveRelPath?.()
      if (!relPath) { showToast('No file open'); return }
      const newLines = code.split('\n').length
      // Read current file to compute diff stats
      let oldLines = 0
      let oldContent = ''
      try {
        interface ReadResp extends ReadPayload {}
        const r = await props.backend.send<ReadResp>('fs.read_file', {
          workspace_path: props.workspacePath,
          rel_path: relPath,
        })
        oldContent = r.payload?.content ?? ''
        oldLines = oldContent.split('\n').length
      } catch { /* file may not exist yet */ }
      diffApplyState.value = { code, relPath, oldLines, newLines, oldContent, btn: applyBtn }
    } catch { showToast('Apply failed') }
  }

  // Insert at cursor button
  const insertBtn = target.closest<HTMLButtonElement>('.ai-code-insert-btn')
  if (insertBtn) {
    try {
      const code = decodeURIComponent(escape(atob(insertBtn.dataset.code ?? '')))
      if (!props.insertTextAtCursor) { showToast('No editor active'); return }
      props.insertTextAtCursor(code)
      insertBtn.textContent = 'Inserted ✓'
      insertBtn.style.color = 'var(--success-fg, #3fb950)'
      window.setTimeout(() => { insertBtn.textContent = 'Insert'; insertBtn.style.color = '' }, 2000)
      showToast('Inserted at cursor')
    } catch { showToast('Insert failed') }
  }

  // Run shell code block — two-click confirmation (avoids window.confirm)
  const runCodeBtn = target.closest<HTMLButtonElement>('.ai-code-run-btn')
  if (runCodeBtn) {
    try {
      const code = decodeURIComponent(escape(atob(runCodeBtn.dataset.code ?? '')))
      // First click: arm confirmation state; second click within 2.5s: execute
      if (!pendingRunBtn.has(runCodeBtn)) {
        const prev = runCodeBtn.textContent
        runCodeBtn.textContent = '⚠ Click again to run'
        runCodeBtn.style.color = 'var(--attention-bright)'
        const t = setTimeout(() => {
          pendingRunBtn.delete(runCodeBtn)
          runCodeBtn.textContent = prev ?? '▶ Run'
          runCodeBtn.style.color = ''
        }, 2500)
        pendingRunBtn.set(runCodeBtn, t)
        return
      }
      const pending = pendingRunBtn.get(runCodeBtn)
      if (pending !== undefined) clearTimeout(pending)
      pendingRunBtn.delete(runCodeBtn)
      runCodeBtn.style.color = ''
      runCodeBtn.textContent = '⏳ Running…'
      runCodeBtn.disabled = true
      interface ShellResp { ok: boolean; output?: string; exit_code?: number; error?: string }
      const resp = await props.backend.send<ShellResp>('shell.run', {
        command: code,
        workspace_path: props.workspacePath,
      })
      const r = resp.payload
      const resultText = r?.ok
        ? `\`\`\`\n${r.output ?? '(no output)'}\n\`\`\`\n_Exit code: ${r.exit_code ?? 0}_`
        : `Error: ${r?.error ?? 'unknown'}`
      messages.value.push({ role: 'assistant', content: resultText, timestamp: Date.now() })
      runCodeBtn.textContent = '✓ Done'
      window.setTimeout(() => { runCodeBtn.textContent = '▶ Run'; runCodeBtn.disabled = false }, 2000)
    } catch {
      runCodeBtn.textContent = '▶ Run'
      runCodeBtn.disabled = false
      showToast('Run failed')
    }
    return
  }

  // Save code block to file
  const saveBtn = target.closest<HTMLButtonElement>('.ai-code-save-btn')
  if (saveBtn) {
    try {
      const code = decodeURIComponent(escape(atob(saveBtn.dataset.code ?? '')))
      const ext = saveBtn.dataset.ext ?? 'txt'
      const r = await window.agentTeam?.saveJson({ defaultName: `snippet.${ext}`, content: code, title: 'Save code to file' })
      if (r?.ok) showToast('Saved')
      else if (!r?.canceled) showToast('Save failed')
    } catch { showToast('Save failed') }
    return
  }

  // Open file in editor (code block header ↗ button)
  const openFileBtn = target.closest<HTMLButtonElement>('.ai-code-open-btn')
  if (openFileBtn) {
    const relPath = openFileBtn.dataset.path ?? ''
    if (relPath) {
      if (props.openFile) props.openFile(relPath)
      else showToast(`File: ${relPath}`)
    }
    return
  }

  // Create file from AI suggestion (code block "Create file" button)
  const createFileBtn = target.closest<HTMLButtonElement>('.ai-code-create-btn')
  if (createFileBtn) {
    const relPath = (createFileBtn.dataset.path ?? '').trim()
    if (!relPath || !props.workspacePath) { showToast('Create file: no path'); return }
    const SAFE_PATH = /^[A-Za-z0-9_./ -]+$/
    if (!SAFE_PATH.test(relPath) || relPath.includes('..') || relPath.startsWith('-')) { showToast('Create file: invalid path'); return }
    try {
      const code = decodeURIComponent(escape(atob(createFileBtn.dataset.code ?? '')))
      const confirmed = window.confirm(`Create file "${relPath}"?\n\n${code.slice(0, 200)}${code.length > 200 ? '\n…' : ''}`)
      if (!confirmed) return
      interface WriteResp { ok: boolean; error?: string }
      const r = await props.backend.send<WriteResp>('fs.write_file', { workspace_path: props.workspacePath, rel_path: relPath, content: code })
      if (r.payload?.ok) {
        showToast(`Created: ${relPath}`)
        if (props.openFile) props.openFile(relPath)
      } else {
        showToast(`Create failed: ${r.payload?.error ?? 'unknown error'}`)
      }
    } catch { showToast('Create file: unavailable') }
    return
  }

  // Inline code action buttons (Explain / Refactor)
  const codeActionBtn = target.closest<HTMLButtonElement>('.ai-code-action-btn')
  if (codeActionBtn) {
    try {
      const code = decodeURIComponent(escape(atob(codeActionBtn.dataset.code ?? '')))
      const action = codeActionBtn.dataset.action ?? 'explain'
      if (action === 'explainerr') {
        inputText.value = `Explain this error clearly. What went wrong, what caused it, and how to fix it:\n\n\`\`\`\n${code.slice(0, 3000)}\n\`\`\``
        await nextTick(); void sendMessage()
        return
      }
      if (action === 'compare') {
        if (!compareStage.value) {
          compareStage.value = { code }
          showToast('Code staged — click Compare on another block to diff')
        } else {
          compareResult.value = { codeA: compareStage.value.code, codeB: code }
          compareStage.value = null
        }
        return
      }
      if (action === 'newchat') {
        const wrap = codeActionBtn.closest<HTMLElement>('.ai-code-wrap')
        const lang = (wrap?.querySelector('.ai-code-lang') ?? wrap?.querySelector('.ai-code-lang-sm'))?.textContent ?? ''
        newThread()
        await nextTick()
        const snippet = code.slice(0, 4000)
        inputText.value = `\`\`\`${lang.toLowerCase()}\n${snippet}\n\`\`\`\n\n`
        textareaEl.value?.focus()
        return
      }
      const prompt = action === 'explain'
        ? `Explain this code clearly and concisely:\n\n\`\`\`\n${code.slice(0, 3000)}\n\`\`\``
        : `Refactor this code to improve readability and maintainability. Show the complete refactored version:\n\n\`\`\`\n${code.slice(0, 3000)}\n\`\`\``
      inputText.value = prompt
      await nextTick()
      void sendMessage()
    } catch { /* ignore */ }
    return
  }

  // Code block filepath badge — click to open the file
  const codeFilepath = (e.target as HTMLElement).closest<HTMLElement>('.ai-code-filepath')
  if (codeFilepath) {
    const relPath = codeFilepath.dataset.path ?? ''
    if (relPath && props.openFile) props.openFile(relPath)
    return
  }
  // Clickable file path in inline code (supports :line notation)
  // Ctrl/Cmd+click → add as @file context chip; plain click → open in editor
  const fileRef = target.closest<HTMLElement>('.ai-file-ref')
  if (fileRef) {
    const relPath = fileRef.dataset.path ?? ''
    const line = fileRef.dataset.line ? parseInt(fileRef.dataset.line, 10) : undefined
    if (!relPath) return
    if ((e as MouseEvent).ctrlKey || (e as MouseEvent).metaKey) {
      // Add as @file context chip
      void (async () => {
        try {
          interface FileResp { ok?: boolean; content?: string; payload?: { content?: string } }
          const r = await props.backend.send<FileResp>('fs.read_file', { workspace_path: props.workspacePath, rel_path: relPath })
          const content = (r as { payload?: { content?: string } }).payload?.content ?? ''
          const ext = relPath.split('.').pop() ?? ''
          const chipLabel = `@${relPath}`
          contextChips.value = contextChips.value.filter((c) => c.label !== chipLabel)
          contextChips.value.push({
            id: crypto.randomUUID(),
            label: chipLabel,
            content: `// File: ${relPath}\n\`\`\`${ext}\n${content.slice(0, 80_000)}\n\`\`\``,
          })
          showToast(`Added ${relPath.split('/').pop()} to context`)
        } catch {
          showToast('Could not read file')
        }
      })()
    } else if (props.openFile) {
      props.openFile(relPath, line)
    } else {
      showToast(`File: ${relPath}${line ? `:${line}` : ''}`)
    }
  }
}

// ── Run git commit from AI-detected commit message ────────────────────────────
async function runCommit(msg: ChatMessage): Promise<void> {
  if (!msg.commitMsg) return
  let proceeded = false
  twoClick(`commit-${msg.timestamp}`, () => { proceeded = true }, 'Commit', `git commit: "${msg.commitMsg.slice(0, 60)}" — click again to confirm`)
  if (!proceeded) return
  try {
    interface CommitResp { ok: boolean; error?: string }
    const resp = await props.backend.send<CommitResp>('git.commit', {
      workspace_path: props.workspacePath,
      message: msg.commitMsg,
      all: false,
    })
    if (resp.payload?.ok) {
      showToast('Committed successfully')
      msg.commitMsg = undefined
    } else {
      showToast(`Commit failed: ${resp.payload?.error ?? 'unknown error'}`)
    }
  } catch {
    showToast('Commit failed')
  }
}

// ── Follow-up suggestions ──────────────────────────────────────────────────────
function extractFollowUps(content: string, userContent?: string): string[] {
  // 1. Try to extract questions the AI already asked in its response
  const stripped = content.replace(/```[\s\S]*?```/g, '').replace(/`[^`]+`/g, '')
  const sentences = stripped.match(/[A-Z][^.!?]*\?/g) ?? []
  const QUESTION_WORDS = /^(What|How|Why|When|Where|Which|Who|Can|Could|Should|Would|Is|Are|Does|Do)\b/i
  const fromContent = sentences
    .map((s) => s.trim())
    .filter((s) => s.length >= 15 && s.length <= 120 && QUESTION_WORDS.test(s))
    .slice(0, 3)
  if (fromContent.length >= 2) return fromContent

  // 2. Fallback: generate context-aware suggestions based on response/request type
  const c = content.toLowerCase()
  const u = (userContent ?? '').toLowerCase()
  const hasCode = content.includes('```')
  const isError = c.includes('error') || c.includes('bug') || u.includes('fix') || u.includes('error')
  const isTest  = c.includes('test') || u.includes('test')
  const isExplain = u.includes('explain') || u.includes('what is') || u.includes('how does')
  const isOptimize = c.includes('performance') || c.includes('optimiz') || u.includes('optim')
  if (isError && hasCode) return ['Can you show the full fixed version?', 'Are there other similar issues?', 'How can I prevent this?']
  if (isTest)  return ['Add edge case tests', 'Show integration test example', 'What should I mock here?']
  if (isExplain && hasCode) return ['Give a minimal runnable example', 'What are the common gotchas?', 'How does this compare to alternatives?']
  if (isOptimize) return ['What is the time complexity?', 'Are there memory trade-offs?', 'Show benchmark approach']
  if (hasCode) return ['Add error handling', 'Write tests for this', 'Explain the key parts']
  if (isExplain) return ['Give a concrete example', 'What are the edge cases?', 'What should I learn next?']
  return fromContent  // empty if nothing matched
}

// ── Markdown lite renderer ─────────────────────────────────────────────────────
const _mdCache = new Map<string, string>()
const _MD_CACHE_MAX = 200
function renderMarkdownLite(rawText: string): string {
  const cached = _mdCache.get(rawText)
  if (cached !== undefined) return cached

  // 1. Extract fenced code blocks so they are never touched by inline transforms
  const blocks: string[] = []
  let text = rawText.replace(/```([^\s\n]*)\n?([\s\S]*?)```/g, (_, lang, code) => {
    const LANG_DISPLAY: Record<string, string> = {
      ts: 'TypeScript', tsx: 'TSX', js: 'JavaScript', jsx: 'JSX',
      py: 'Python', python: 'Python', rb: 'Ruby', go: 'Go',
      rs: 'Rust', java: 'Java', kt: 'Kotlin', swift: 'Swift',
      cpp: 'C++', c: 'C', cs: 'C#', php: 'PHP', scala: 'Scala',
      sh: 'Shell', bash: 'Bash', zsh: 'Zsh', fish: 'Fish',
      json: 'JSON', yaml: 'YAML', yml: 'YAML', toml: 'TOML',
      html: 'HTML', css: 'CSS', scss: 'SCSS', sass: 'Sass',
      sql: 'SQL', md: 'Markdown', xml: 'XML', vue: 'Vue',
      svelte: 'Svelte', graphql: 'GraphQL', dockerfile: 'Dockerfile',
      makefile: 'Makefile', r: 'R', lua: 'Lua', dart: 'Dart',
    }
    const langLabelRaw = lang ? (LANG_DISPLAY[lang.toLowerCase()] ?? lang) : 'text'
    const langLabel = langLabelRaw.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
    // Mermaid diagrams — defer rendering to avoid innerHTML XSS
    if (lang?.toLowerCase() === 'mermaid') {
      const i = blocks.length
      blocks.push(`<div class="ai-mermaid-wrap"><div class="ai-mermaid" data-graph="${encodeURIComponent(code.trim())}"><span class="ai-mermaid-loading">${i18n.global.t('label.rendering-diagram')}</span></div></div>`)
      return `\x00B${i}\x00`
    }
    // Diff/patch blocks — render with dedicated diff renderer (green/red line highlighting)
    if (['diff', 'patch'].includes((lang ?? '').toLowerCase())) {
      const i = blocks.length
      const encoded = btoa(unescape(encodeURIComponent(code.trim())))
      blocks.push(
        `<div class="ai-code-wrap">` +
        `<div class="ai-code-header"><span class="ai-code-lang">${i18n.global.t('label.diff')}</span>` +
        `<button class="ai-code-copy-btn" data-code="${encoded}">${i18n.global.t('action.copy')}</button></div>` +
        `<div class="ai-diff-view ai-diff-inline">${renderDiff(code)}</div>` +
        `</div>`,
      )
      return `\x00B${i}\x00`
    }
    // Detect file path from first line comment (e.g. `// src/foo.ts` or `# src/foo.py`)
    const firstLine = code.split('\n')[0].trim()
    const pathMatch = firstLine.match(/^(?:\/\/|#|\/\*|\*|--)\s*((?:\w[\w.-]*\/)+[\w.-]+\.\w+)/)
    const inferredPath = pathMatch?.[1] ?? null
    const encoded = btoa(unescape(encodeURIComponent(code.trim())))
    // Apply syntax highlighting; skip auto-detect for large blocks (> 3000 chars) to avoid slowdown
    let highlighted: string
    try {
      let result
      if (lang && hljs.getLanguage(lang)) {
        result = hljs.highlight(code, { language: lang })
      } else if (!lang && code.length < 3000) {
        result = hljs.highlightAuto(code, ['javascript', 'typescript', 'python', 'bash', 'json', 'css', 'xml', 'sql', 'yaml'])
      }
      highlighted = result ? result.value : code.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    } catch {
      highlighted = code.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    }
    const i = blocks.length
    // Prefer inferred path from code comment; fall back to active file
    const targetPath = inferredPath ?? props.getActiveRelPath?.() ?? null
    const insertBtn = props.insertTextAtCursor
      ? `<button class="ai-code-insert-btn" data-code="${encoded}" title="Insert at cursor position in editor">${i18n.global.t('action.insert')}</button>`
      : ''
    const applyLabel = inferredPath ? `Apply to ${inferredPath.split('/').pop()}` : 'Apply'
    const applyBtn = targetPath
      ? `<button class="ai-code-apply-btn" data-code="${encoded}" data-path="${inferredPath ?? ''}" title="Apply to ${targetPath}">${applyLabel}</button>`
      : ''
    // Open-file button and file path chip (Cursor-style code block header)
    const safeInferredPath = inferredPath ? inferredPath.replace(/"/g, '&quot;').replace(/'/g, '&#39;') : ''
    // "Create file" button — shown when code block has an inferred path (for new files)
    const createBtn = inferredPath && props.workspacePath
      ? `<button class="ai-code-create-btn" data-code="${encoded}" data-path="${safeInferredPath}" title="Create new file: ${safeInferredPath}">${i18n.global.t('action.create')}</button>`
      : ''
    const openBtn = inferredPath && props.openFile
      ? `<button class="ai-code-open-btn" data-path="${safeInferredPath}" title="Open ${safeInferredPath} in editor">↗</button>`
      : ''
    const shortFilename = inferredPath ? inferredPath.split('/').pop()!.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;') : ''
    const fileLabel = inferredPath
      ? `<span class="ai-code-filepath" data-path="${safeInferredPath}" title="Click to open ${safeInferredPath}">${shortFilename}</span><span class="ai-code-lang-sm">${langLabel}</span>`
      : `<span class="ai-code-lang">${langLabel}</span>`
    // Collapse code blocks that exceed 30 lines
    const lineCount = code.split('\n').length
    const isLong = lineCount > 30
    const foldAttr = isLong ? ' data-folded="true"' : ''
    const toggleBtn = isLong
      ? `<button class="ai-code-fold-btn" data-lines="${lineCount}">▶ Expand (${lineCount} lines)</button>`
      : ''
    const isShell = ['sh', 'bash', 'zsh', 'fish', 'shell'].includes((lang ?? '').toLowerCase())
    const runBtn = isShell
      ? `<button class="ai-code-run-btn" data-code="${encoded}" title="Run in workspace">▶ Run</button>`
      : ''
    const LANG_EXT: Record<string, string> = {
      ts: 'ts', tsx: 'tsx', js: 'js', jsx: 'jsx', py: 'py', python: 'py',
      rb: 'rb', go: 'go', rs: 'rs', java: 'java', kt: 'kt', swift: 'swift',
      cpp: 'cpp', c: 'c', cs: 'cs', php: 'php', sh: 'sh', bash: 'sh',
      json: 'json', yaml: 'yaml', yml: 'yaml', toml: 'toml', html: 'html',
      css: 'css', scss: 'scss', sql: 'sql', md: 'md', vue: 'vue',
    }
    const ext = lang ? (LANG_EXT[lang.toLowerCase()] ?? 'txt') : 'txt'
    const saveBtn = window.agentTeam?.saveJson
      ? `<button class="ai-code-save-btn" data-code="${encoded}" data-ext="${ext}" title="Save to file">${i18n.global.t('action.save')}</button>`
      : ''
    // Wrap each line in a span for CSS line-number counters
    const numberedLines = highlighted
      .split('\n')
      .map((line) => `<span class="code-ln">${line}</span>`)
      .join('\n')
    // Inline code actions (explain/refactor) for code-like languages
    const isCodeLang = !isShell && !['json', 'yaml', 'toml', 'sql', 'md', 'markdown', 'text', ''].includes((lang ?? '').toLowerCase())
    const explainBtn = isCodeLang && code.trim().length > 20
      ? `<button class="ai-code-action-btn" data-action="explain" data-code="${encoded}" title="Ask AI to explain this code [Alt+E]">${i18n.global.t('action.explain')}</button>`
      : ''
    const refactorBtn = isCodeLang && code.trim().length > 30
      ? `<button class="ai-code-action-btn" data-action="refactor" data-code="${encoded}" title="Ask AI to refactor this code [Alt+R]">${i18n.global.t('action.refactor')}</button>`
      : ''
    const newChatBtn = isCodeLang && code.trim().length > 20
      ? `<button class="ai-code-action-btn" data-action="newchat" data-code="${encoded}" title="Start new chat with this code as context [Alt+N]">${i18n.global.t('action.new-chat')}</button>`
      : ''
    const compareBtn = isCodeLang && code.trim().length > 20
      ? `<button class="ai-code-action-btn" data-action="compare" data-code="${encoded}" title="Stage / compare with another code block [Alt+C]">${i18n.global.t('action.compare')}</button>`
      : ''
    const isErrorBlock = /(?:Error:|Exception:|Traceback|FAILED|\bfatal\b|\bpanic\b)/i.test(code)
    const explainErrBtn = isErrorBlock
      ? `<button class="ai-code-action-btn ai-code-action-err" data-action="explainerr" data-code="${encoded}" title="Ask AI to explain this error">${i18n.global.t('action.explain-error')}</button>`
      : ''
    blocks.push(
      `<div class="ai-code-wrap"${foldAttr}>` +
      `<div class="ai-code-header">` +
      `${fileLabel}` +
      `${openBtn}` +
      `${runBtn}` +
      `${saveBtn}` +
      `${insertBtn}` +
      `${createBtn}` +
      `${applyBtn}` +
      `<button class="ai-code-copy-btn" data-code="${encoded}">${i18n.global.t('action.copy')}</button>` +
      `<button class="ai-code-wrap-btn" title="Toggle word wrap">↔</button>` +
      `</div>` +
      `${explainBtn || refactorBtn || newChatBtn || compareBtn || explainErrBtn ? `<div class="ai-code-actions">${explainErrBtn}${explainBtn}${refactorBtn}${newChatBtn}${compareBtn}</div>` : ''}` +
      `${toggleBtn}` +
      `<pre class="ai-code-block hljs"${isLong ? ' style="display:none"' : ''}><code class="has-line-numbers">${numberedLines}</code></pre>` +
      `</div>`,
    )
    return `\x00B${i}\x00`
  })
  // Extract LaTeX math blocks before HTML escape so they survive unharmed
  const mathBlocks: string[] = []
  const _escHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  // Display math: $$...$$
  text = text.replace(/\$\$([\s\S]+?)\$\$/g, (_, expr) => {
    try {
      const rendered = katex.renderToString(expr.trim(), { displayMode: true, throwOnError: false })
      mathBlocks.push(rendered)
    } catch {
      mathBlocks.push(`<span class="ai-latex-err">$$${_escHtml(expr)}$$</span>`)
    }
    return `\x00M${mathBlocks.length - 1}\x00`
  })
  // Inline math: $...$  (require non-space at both ends to avoid false positives like "$50 and $30")
  text = text.replace(/\$([^\s$][^$\n]*?[^\s$]|[^\s$])\$/g, (_, expr) => {
    try {
      const rendered = katex.renderToString(expr.trim(), { displayMode: false, throwOnError: false })
      mathBlocks.push(rendered)
    } catch {
      mathBlocks.push(`<span class="ai-latex-err">$${_escHtml(expr)}$</span>`)
    }
    return `\x00M${mathBlocks.length - 1}\x00`
  })

  // HTML-escape non-code-block content to prevent XSS via v-html
  text = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

  // 2. Line-by-line: headings, lists, blockquotes, tables, blank lines
  const lines = text.split('\n')
  const parts: string[] = []
  let inUl = false, inOl = false, inBlockquote = false, inTable = false
  const tableRows: string[][] = []
  let tableHasHeader = false

  const flushList = () => {
    if (inUl) { parts.push('</ul>'); inUl = false }
    if (inOl) { parts.push('</ol>'); inOl = false }
  }
  const flushBlockquote = () => {
    if (inBlockquote) { parts.push('</blockquote>'); inBlockquote = false }
  }
  const flushTable = () => {
    if (!inTable) return
    inTable = false
    if (tableRows.length === 0) { tableRows.length = 0; return }
    let html = '<table class="ai-table"><tbody>'
    tableRows.forEach((cells, ri) => {
      const tag = (ri === 0 && tableHasHeader) ? 'th' : 'td'
      if (ri === 1 && tableHasHeader) return // skip separator row
      html += '<tr>' + cells.map((c) => `<${tag}>${c.trim()}</${tag}>`).join('') + '</tr>'
    })
    html += '</tbody></table>'
    parts.push(html)
    tableRows.length = 0
    tableHasHeader = false
  }
  const flushAll = () => { flushList(); flushBlockquote(); flushTable() }

  const isTableRow = (l: string) => /^\|.+\|/.test(l.trim())
  const isSepRow = (l: string) => /^\|[\s\-:|]+\|/.test(l.trim())
  const splitCells = (l: string) => l.trim().replace(/^\||\|$/g, '').split('|')

  for (let li = 0; li < lines.length; li++) {
    const line = lines[li]
    // Code block placeholder (whole line)
    if (/^\x00B\d+\x00$/.test(line.trim())) {
      flushAll(); parts.push(line.trim()); continue
    }
    // Horizontal rule
    if (/^[-*_]{3,}$/.test(line.trim())) {
      flushAll(); parts.push('<hr class="ai-hr">'); continue
    }
    // Heading: #, ##, ###, ####
    const hm = line.match(/^(#{1,4})\s+(.+)/)
    if (hm) {
      flushAll()
      const lvl = Math.min(hm[1].length + 1, 5)
      parts.push(`<h${lvl} class="ai-h">${hm[2]}</h${lvl}>`)
      continue
    }
    // Table detection: current or next line is a separator row
    if (isTableRow(line)) {
      const nextLine = lines[li + 1] || ''
      if (!inTable) {
        flushList(); flushBlockquote()
        inTable = true
        tableRows.push(splitCells(line))
        if (isSepRow(nextLine)) tableHasHeader = true
      } else if (isSepRow(line)) {
        // separator row — already marked, skip it
        tableRows.push(splitCells(line))
      } else {
        tableRows.push(splitCells(line))
      }
      continue
    }
    if (inTable) { flushTable() }
    // Blockquote
    const bqm = line.match(/^>\s?(.*)/)
    if (bqm) {
      flushList()
      if (!inBlockquote) { parts.push('<blockquote class="ai-blockquote">'); inBlockquote = true }
      parts.push(bqm[1] === '' ? '<br>' : bqm[1] + '<br>')
      continue
    }
    if (inBlockquote && line.trim() === '') { flushBlockquote(); parts.push('<br>'); continue }
    flushBlockquote()
    // Task list items: - [ ] or - [x]
    const taskm = line.match(/^[*\-+]\s+\[([ xX])\]\s+(.+)/)
    if (taskm) {
      const checked = taskm[1].toLowerCase() === 'x'
      if (inOl) { parts.push('</ol>'); inOl = false }
      if (!inUl) { parts.push('<ul class="ai-ul ai-task-list">'); inUl = true }
      parts.push(`<li class="ai-task-item"><input type="checkbox" ${checked ? 'checked' : ''} disabled> ${taskm[2]}</li>`)
      continue
    }
    // Unordered list
    const ulm = line.match(/^[*\-+]\s+(.+)/)
    if (ulm) {
      if (inOl) { parts.push('</ol>'); inOl = false }
      if (!inUl) { parts.push('<ul class="ai-ul">'); inUl = true }
      parts.push(`<li>${ulm[1]}</li>`)
      continue
    }
    // Ordered list
    const olm = line.match(/^\d+[.)]\s+(.+)/)
    if (olm) {
      if (inUl) { parts.push('</ul>'); inUl = false }
      if (!inOl) { parts.push('<ol class="ai-ol">'); inOl = true }
      parts.push(`<li>${olm[1]}</li>`)
      continue
    }
    flushList()
    parts.push(line === '' ? '<br>' : line + '<br>')
  }
  flushAll()

  let html = parts.join('')

  // 3. Inline transforms (safe: never match inside code blocks — those are placeholders now)
  // Bold
  html = html.replace(/\*\*([^*<\n]+)\*\*/g, '<strong>$1</strong>')
  // Italic (only single *, guard against **)
  html = html.replace(/(?<!\*)\*([^*<\n]+)\*(?!\*)/g, '<em>$1</em>')
  // Strikethrough
  html = html.replace(/~~([^~<\n]+)~~/g, '<del>$1</del>')
  // Inline code — file paths (optionally :line) become clickable links
  const FILE_PATH_RE = /^((?:\.{0,2}\/)?[\w.\-/ ]+\.(?:ts|tsx|js|jsx|vue|py|go|rs|rb|java|kt|swift|c|cpp|cs|php|sh|md|json|yaml|yml|toml|html|css|scss|sql))(?::(\d+))?$/
  html = html.replace(/`([^`\n]+)`/g, (_, c) => {
    const escaped = c.replace(/</g, '&lt;').replace(/>/g, '&gt;')
    const m = c.trim().match(FILE_PATH_RE)
    if (m && c.includes('/')) {
      const lineAttr = m[2] ? ` data-line="${m[2]}"` : ''
      const lineLabel = m[2] ? `<span class="ai-file-ref-line">:${m[2]}</span>` : ''
      return `<code class="ai-inline-code ai-file-ref" data-path="${m[1]}"${lineAttr} title="Click to open · Ctrl+click to add to context">${escaped.replace(/:(\d+)$/, '')}${lineLabel}</code>`
    }
    return `<code class="ai-inline-code">${escaped}</code>`
  })
  // Plain-text bare file paths (e.g. "Edit src/App.vue:42 to fix this")
  // Only active when openFile prop is available; guards against HTML attr contexts.
  if (props.openFile) {
    const BARE_PATH_RE = /(?<![='">\w/\\])((?:\.{0,2}\/)?(?:[\w.\-]+\/)+[\w.\-]+\.(?:ts|tsx|js|jsx|vue|py|go|rs|rb|java|kt|swift|c|cpp|cs|php|sh|md|json|yaml|yml|toml|html|css|scss|sql))(?::(\d+))?(?=[^\w/\\]|$)/g
    html = html.replace(BARE_PATH_RE, (_match, path, line) => {
      const lineAttr = line ? ` data-line="${line}"` : ''
      const lineLabel = line ? `<span class="ai-file-ref-line">:${line}</span>` : ''
      const escapedPath = path.replace(/"/g, '&quot;')
      return `<code class="ai-inline-code ai-file-ref ai-file-ref-bare" data-path="${escapedPath}"${lineAttr} title="Click to open · Ctrl+click to add to context">${path}${lineLabel}</code>`
    })
  }
  // Auto-link URLs (not inside existing tags)
  html = html.replace(/(?<![="'])https?:\/\/[^\s<>"')\]]+/g,
    (url) => `<a class="ai-link" href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>`,
  )

  // 4. Restore code blocks
  html = html.replace(/\x00B(\d+)\x00/g, (_, i) => blocks[Number(i)])

  // 5. Restore math blocks
  if (mathBlocks.length) {
    html = html.replace(/\x00M(\d+)\x00/g, (_, i) => mathBlocks[Number(i)])
  }

  // Cache completed renders (evict oldest when limit reached)
  if (_mdCache.size >= _MD_CACHE_MAX) {
    _mdCache.delete(_mdCache.keys().next().value!)
  }
  _mdCache.set(rawText, html)

  return html
}

// ── Diff rendering ─────────────────────────────────────────────────────────────
function renderDiff(diff: string): string {
  return diff
    .split('\n')
    .map((line) => {
      const escaped = line.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      if (line.startsWith('+') && !line.startsWith('+++')) {
        return `<div class="diff-add">${escaped}</div>`
      } else if (line.startsWith('-') && !line.startsWith('---')) {
        return `<div class="diff-del">${escaped}</div>`
      } else if (line.startsWith('@@')) {
        return `<div class="diff-hunk">${escaped}</div>`
      }
      return `<div class="diff-ctx">${escaped}</div>`
    })
    .join('')
}

// ── Compute unified diff from new_content ─────────────────────────────────────
function makeDiff(filePath: string, newContent: string): string {
  // We can't run diff in the renderer; produce a simple "whole file replacement" diff header.
  const lines = newContent.split('\n')
  const added = lines.map((l) => `+${l}`).join('\n')
  return `--- a/${filePath}\n+++ b/${filePath}\n@@ -0,0 +1,${lines.length} @@\n${added}`
}

// ── Scroll to bottom ───────────────────────────────────────────────────────────
async function scrollBottom(force = false): Promise<void> {
  await nextTick()
  if (messagesEl.value && (autoScroll.value || force)) {
    messagesEl.value.scrollTop = messagesEl.value.scrollHeight
  }
  void renderMermaidBlocks()
}

function onMessagesScroll(): void {
  if (!messagesEl.value) return
  const el = messagesEl.value
  const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 60
  autoScroll.value = atBottom
}

// ── Build tree string from flat file paths ────────────────────────────────────
function buildFileTree(files: string[]): string {
  type Node = { [key: string]: Node | null }
  const root: Node = {}
  for (const f of files) {
    const parts = f.split('/')
    let cur = root
    for (const part of parts) {
      if (!cur[part]) cur[part] = {}
      cur = cur[part] as Node
    }
  }
  const lines: string[] = []
  function walk(node: Node, prefix: string): void {
    const keys = Object.keys(node).sort((a, b) => {
      const aDir = Object.keys(node[a] as Node).length > 0
      const bDir = Object.keys(node[b] as Node).length > 0
      if (aDir !== bDir) return aDir ? -1 : 1
      return a.localeCompare(b)
    })
    keys.forEach((key, i) => {
      const isLast = i === keys.length - 1
      lines.push(`${prefix}${isLast ? '└── ' : '├── '}${key}`)
      const child = node[key] as Node
      if (child && Object.keys(child).length > 0) {
        walk(child, prefix + (isLast ? '    ' : '│   '))
      }
    })
  }
  walk(root, '')
  return lines.join('\n')
}

// ── Tool call human-readable summary + icon ──────────────────────────────────
function getToolIcon(name: string): string {
  switch (name) {
    case 'read_file':      return '▤'
    case 'search_files':   return '⌕'
    case 'edit_file':      return '✎'
    case 'run_command':    return '▶'
    case 'list_directory': return '⊞'
    case 'glob_files':     return '✦'
    case 'write_file':     return '✍'
    default:               return '⚙'
  }
}

function getToolSummary(name: string, input: unknown): string {
  if (typeof input !== 'object' || input === null) return name
  const inp = input as Record<string, unknown>
  const str = (v: unknown) => (typeof v === 'string' ? v : '')
  switch (name) {
    case 'read_file':       return `Reading: ${str(inp.file_path)}`
    case 'search_files':    return `Searching: "${str(inp.query)}"${inp.file_pattern ? ` in ${inp.file_pattern}` : ''}`
    case 'edit_file':       return `Editing: ${str(inp.file_path)}`
    case 'run_command':     return `Running: ${str(inp.command)}`
    case 'list_directory':  return `Listing: ${str(inp.path) || '.'}`
    case 'glob_files':      return `Glob: ${str(inp.pattern)}`
    case 'write_file':      return `Write: ${str(inp.file_path)}`
    default:                return name
  }
}

// ── Toast ──────────────────────────────────────────────────────────────────────
function showToast(msg: string): void {
  toastMsg.value = msg
  if (toastTimer !== null) clearTimeout(toastTimer)
  toastTimer = window.setTimeout(() => { toastMsg.value = '' }, 3000)
}

// ── Settings fetch/save ────────────────────────────────────────────────────────
function applyBackendSettings(payload: unknown): void {
  const p = payload as {
    provider?: string; anthropic_api_key?: string; model?: string
    ollama_base_url?: string; system_prompt?: string; max_tokens?: number; temperature?: number
    openai_api_key?: string; groq_api_key?: string; deepseek_api_key?: string
    google_api_key?: string; mistral_api_key?: string; xai_api_key?: string
    openai_compatible_base_url?: string; openai_compatible_api_key?: string; openai_compatible_model?: string
    reasoning_effort?: 'low' | 'medium' | 'high' | null
  }
  const validProviders: ProviderName[] = ['anthropic', 'ollama', 'openai', 'groq', 'deepseek', 'google', 'mistral', 'xai', 'openai_compatible']
  if (p.provider && validProviders.includes(p.provider as ProviderName)) settingsProvider.value = p.provider as ProviderName
  if (p.anthropic_api_key) settingsApiKey.value = p.anthropic_api_key
  if (p.openai_api_key) settingsOpenAiKey.value = p.openai_api_key
  if (p.groq_api_key) settingsGroqKey.value = p.groq_api_key
  if (p.deepseek_api_key) settingsDeepSeekKey.value = p.deepseek_api_key
  if (p.google_api_key) settingsGoogleKey.value = p.google_api_key
  if (p.mistral_api_key) settingsMistralKey.value = p.mistral_api_key
  if (p.xai_api_key) settingsXaiKey.value = p.xai_api_key
  if (p.openai_compatible_base_url) settingsOaiCompatUrl.value = p.openai_compatible_base_url
  if (p.openai_compatible_api_key) settingsOaiCompatKey.value = p.openai_compatible_api_key
  if (p.openai_compatible_model !== undefined) settingsOaiCompatModel.value = p.openai_compatible_model
  if (p.model) settingsModel.value = p.model
  if (p.ollama_base_url) settingsOllamaUrl.value = p.ollama_base_url
  // Use !== undefined so clearing system_prompt to "" is properly reflected in UI
  if (p.system_prompt !== undefined) settingsSystemPrompt.value = p.system_prompt
  if (p.max_tokens) settingsMaxTokens.value = p.max_tokens
  if (p.temperature !== undefined) settingsTemperature.value = p.temperature
  if (p.reasoning_effort !== undefined) settingsReasoningEffort.value = p.reasoning_effort ?? null
  // Re-apply per-conversation model override after backend settings load
  const ct = allThreads.value.find((t) => t.id === currentThreadId.value)
  if (ct?.model) {
    const entry = MODEL_CATALOG.find((m) => m.id === ct.model)
    if (entry) {
      if (entry.provider !== 'auto') settingsProvider.value = entry.provider
      settingsModel.value = ct.model
    }
  }
}

function fetchSettings(): void {
  props.backend.send('ai.chat.settings.get', {})
    .then((r) => { if (r?.ok && r.payload) applyBackendSettings(r.payload) })
    .catch(() => {/* ignore */})
}

// One-time migration of the legacy plaintext localStorage API-key mirrors into
// the backend ai_chat_settings.json (0o600). The localStorage copies are only
// removed after the backend acks the write; on failure they stay in place and
// the next launch retries (idempotent — re-uploading identical values is safe).
const LEGACY_KEY_MIRRORS: ReadonlyArray<readonly [string, string]> = [
  ['ai-chat-openai-key', 'openai_api_key'],
  ['ai-chat-groq-key', 'groq_api_key'],
  ['ai-chat-deepseek-key', 'deepseek_api_key'],
  ['ai-chat-google-key', 'google_api_key'],
  ['ai-chat-mistral-key', 'mistral_api_key'],
  ['ai-chat-xai-key', 'xai_api_key'],
  ['ai-chat-oai-compat-url', 'openai_compatible_base_url'],
  ['ai-chat-oai-compat-key', 'openai_compatible_api_key'],
  ['ai-chat-oai-compat-model', 'openai_compatible_model'],
]

async function migrateLegacyKeyMirrors(): Promise<void> {
  const updates: Record<string, string> = {}
  const present: string[] = []
  for (const [lsKey, field] of LEGACY_KEY_MIRRORS) {
    const v = localStorage.getItem(lsKey)
    if (v === null) continue
    present.push(lsKey)
    // Empty mirrors carry no information — remove them without pushing so a
    // stale blank can never clobber a real key already stored backend-side.
    if (v !== '') updates[field] = v
  }
  if (present.length === 0) return
  try {
    if (Object.keys(updates).length > 0) {
      const r = await props.backend.send('ai.chat.settings.set', updates)
      if (!r?.ok) return
    }
    for (const k of present) localStorage.removeItem(k)
  } catch { /* backend unreachable — keep mirrors, retry next launch */ }
}

// Resolve "auto" model to a real backend model+provider pair
function resolveModel(): { provider: string; model: string } {
  if (settingsProvider.value === 'openai_compatible') {
    return { provider: 'openai_compatible', model: settingsOaiCompatModel.value }
  }
  if (settingsModel.value !== 'auto') {
    return { provider: settingsProvider.value, model: settingsModel.value }
  }
  // Auto: prefer Anthropic if key present, otherwise Ollama
  if ((settingsApiKey.value ?? '').trim().length > 0) return { provider: 'anthropic', model: 'claude-sonnet-4-6' }
  if ((settingsOpenAiKey.value ?? '').trim().length > 0) return { provider: 'openai', model: OPENAI_MODELS[0] ?? 'gpt-4o' }
  if ((settingsGroqKey.value ?? '').trim().length > 0) return { provider: 'groq', model: GROQ_MODELS[0] ?? 'llama-3.3-70b-versatile' }
  if ((settingsDeepSeekKey.value ?? '').trim().length > 0) return { provider: 'deepseek', model: DEEPSEEK_MODELS[0] ?? 'deepseek-chat' }
  if ((settingsGoogleKey.value ?? '').trim().length > 0) return { provider: 'google', model: GOOGLE_MODELS[0] ?? 'gemini-2.5-flash' }
  if ((settingsMistralKey.value ?? '').trim().length > 0) return { provider: 'mistral', model: MISTRAL_MODELS[0] ?? 'mistral-large-latest' }
  if ((settingsXaiKey.value ?? '').trim().length > 0) return { provider: 'xai', model: XAI_MODELS[0] ?? 'grok-3-mini' }
  return { provider: 'ollama', model: OLLAMA_MODELS[0] ?? 'llama3.2' }
}

// Send current settings to backend without UI side-effects (toast, panel close).
// Called by switchModel() and switchThread() to apply per-conversation model silently.
function _pushSettingsToBackend(): void {
  const { provider, model } = resolveModel()
  const payload: Record<string, unknown> = {
    provider,
    anthropic_api_key: settingsApiKey.value,
    openai_api_key: settingsOpenAiKey.value,
    groq_api_key: settingsGroqKey.value,
    deepseek_api_key: settingsDeepSeekKey.value,
    google_api_key: settingsGoogleKey.value,
    mistral_api_key: settingsMistralKey.value,
    xai_api_key: settingsXaiKey.value,
    openai_compatible_base_url: settingsOaiCompatUrl.value,
    openai_compatible_api_key: settingsOaiCompatKey.value,
    openai_compatible_model: settingsOaiCompatModel.value,
    model,
    ollama_base_url: settingsOllamaUrl.value,
    system_prompt: allThreads.value.find((t) => t.id === currentThreadId.value)?.systemPrompt || settingsSystemPrompt.value,
    max_tokens: Math.max(256, Math.min(16000, Number(settingsMaxTokens.value) || 4096)),
    max_agent_iterations: Math.max(1, Math.min(20, settingsMaxAgentIter.value)),
  }
  if (settingsTemperature.value !== null && !reasoningModelSelected.value) {
    payload.temperature = Math.max(0, Math.min(1, settingsTemperature.value))
  }
  if (settingsThinkingBudget.value !== null && thinkingSupported.value) {
    payload.thinking_budget_tokens = Math.max(1024, Math.min(32000, settingsThinkingBudget.value))
  }
  if (settingsReasoningEffort.value !== null && reasoningModelSelected.value) {
    payload.reasoning_effort = settingsReasoningEffort.value
  }
  props.backend.send('ai.chat.settings.set', payload).catch(() => {/* ignore */})
}

function saveSettings(): void {
  _pushSettingsToBackend()
  settingsSet('ai-chat-auto-accept', settingsAutoAccept.value ? 'true' : 'false')
  settingsSet('ai-chat-max-agent-iter', String(settingsMaxAgentIter.value))
  settingsSet('ai-chat-send-mode', settingsSendMode.value)
  settingsSet('ai-chat-user-rules', settingsUserRules.value)
  settingsSet('ai-chat-custom-docs', JSON.stringify(customDocs.value))
  showSettings.value = false
  showToast('Settings saved')
}

async function testConnection(provider: string): Promise<void> {
  testConnStatus.value = { ...testConnStatus.value, [provider]: 'testing' }
  testConnError.value = { ...testConnError.value, [provider]: '' }
  try {
    const keyMap: Record<string, string> = {
      anthropic: settingsApiKey.value,
      openai: settingsOpenAiKey.value,
      groq: settingsGroqKey.value,
      deepseek: settingsDeepSeekKey.value,
      google: settingsGoogleKey.value,
      mistral: settingsMistralKey.value,
      xai: settingsXaiKey.value,
      openai_compatible: settingsOaiCompatKey.value,
    }
    const res = await props.backend.send<{ ok: boolean; error?: string }>('ai.chat.test_connection', {
      provider,
      api_key: keyMap[provider] ?? '',
      base_url: settingsOaiCompatUrl.value,
      ollama_base_url: settingsOllamaUrl.value,
    }, 15_000)
    const ok = res.payload?.ok === true
    testConnStatus.value = { ...testConnStatus.value, [provider]: ok ? 'ok' : 'fail' }
    if (!ok) testConnError.value = { ...testConnError.value, [provider]: res.payload?.error ?? 'Connection failed' }
  } catch (e) {
    testConnStatus.value = { ...testConnStatus.value, [provider]: 'fail' }
    testConnError.value = { ...testConnError.value, [provider]: String(e) }
  }
}

// ── Send message ───────────────────────────────────────────────────────────────
async function sendMessage(): Promise<void> {
  const rawText = inputText.value.trim()
  if (!rawText && contextChips.value.length === 0) return
  if (sending.value) return

  // /help — show all available slash commands and @ contexts
  if (rawText === '/help') {
    inputText.value = ''
    messages.value.push({ role: 'user', content: '/help', timestamp: Date.now() })
    const cmdList = SLASH_COMMANDS.filter((c) => c.id !== '/help')
      .map((c) => `**${c.id}** — ${c.description}`)
      .join('\n')
    const ctxList = AT_OPTIONS_STATIC
      .map((o) => `**${o.id}** — ${o.label.split(' — ')[1] ?? ''}`)
      .join('\n')
    const helpText = `## Slash Commands\n${cmdList}\n\n## Context Providers (@)\n${ctxList}\n\n_Tip: type \`@filename:10-50\` to include specific lines from a file._`
    messages.value.push({ role: 'assistant', content: helpText, timestamp: Date.now() })
    return
  }

  // /continue — ask AI to keep going when response was truncated
  if (rawText === '/continue') {
    if (!messages.value.some((m) => m.role === 'assistant' && m.content.trim())) {
      showToast('No AI response to continue')
      return
    }
    inputText.value = 'Please continue your response from where you left off.'
    void sendMessage()
    return
  }

  // Delegate other slash-only commands to selectSlashCommand so typing them directly works
  const _delegateSlash = [
    '/clear', '/compact', '/diff', '/model', '/pin', '/summarize',
    '/save-summary', '/spell', '/git', '/pr', '/changelog', '/prompts', '/import', '/generate', '/commit',
    '/run', '/search', '/search:regex', '/translate', '/rename', '/save-prompt', '/scaffold',
    '/review:staged', '/review:branch', '/fix:lint', '/coverage',
    '/label', '/recap', '/instructions', '/ask', '/commit:amend',
    '/memory', '/memory:clear', '/refactor:extract',
    '/init:rules', '/explain:commit',
    '/todo', '/size',
    '/format', '/docgen', '/optimize:imports',
    '/test:update', '/api',
    '/stash', '/review:pr', '/deps:check', '/debug:stack',
    '/rename:symbol', '/coverage:add',
    '/branch', '/env:check',
    '/explain:imports',
    '/fixall', '/worktree',
    '/accessibility', '/regex',
    '/pin:file', '/context:clear', '/gen:component',
    '/rules:show', '/mode', '/session:stats', '/gen:sql',
    '/typecheck', '/arch', '/diff:explain',
    '/refactor:file', '/clone:thread', '/gen:readme', '/explain:selection',
    '/git:cherry-pick', '/snippet:save', '/snippet:list', '/ask:codebase',
    '/gen:types', '/perf:profile',
    '/explain:error', '/shortcuts', '/lint:all', '/compare:files',
    '/context:show', '/git:log:author', '/resolve:conflict', '/revert:edit',
    '/gen:test:e2e',
    '/hotfix', '/review:all', '/git:rebase', '/summarize:code',
    '/agent:task', '/coverage:report',
    '/thread:stats', '/lint:fix:auto', '/note:add', '/gen:table',
    '/format:json', '/git:stash:apply', '/doc:project',
    '/improve:prompt', '/gen:env', '/ask:selection', '/debug:console', '/convert:types',
    '/fix:types', '/explain:regex', '/mock:data', '/find:dead:code', '/deps:outdated',
    '/add:types', '/dockerfile', '/ci:help',
  ]
  if (_delegateSlash.includes(rawText)) {
    inputText.value = ''
    const found = SLASH_COMMANDS.find((c) => c.id === rawText)
    if (found) void selectSlashCommand(found)
    return
  }

  // /git:cherry-pick <ref> — with inline ref argument
  if (rawText.startsWith('/git:cherry-pick ')) {
    inputText.value = ''
    const ref = rawText.slice('/git:cherry-pick '.length).trim()
    const SAFE_REF = /^[A-Za-z0-9_./-]+$/
    if (!SAFE_REF.test(ref) || ref.includes('..') || ref.startsWith('-')) { showToast('/git:cherry-pick: invalid ref'); return }
    const syntheticCmd: SlashCommand = { id: `/git:cherry-pick ${ref}`, label: `/git:cherry-pick ${ref}`, description: '', template: '' }
    void selectSlashCommand(syntheticCmd)
    return
  }

  // /snippet:save <name> — with inline name argument
  if (rawText.startsWith('/snippet:save ')) {
    inputText.value = ''
    const nameArg = rawText.slice('/snippet:save '.length).trim()
    const syntheticCmdSS: SlashCommand = { id: `/snippet:save ${nameArg}`, label: `/snippet:save ${nameArg}`, description: '', template: '' }
    void selectSlashCommand(syntheticCmdSS)
    return
  }

  // /ask:codebase <question> — with inline question
  if (rawText.startsWith('/ask:codebase ')) {
    inputText.value = ''
    const question = rawText.slice('/ask:codebase '.length).trim()
    const syntheticCmdAC: SlashCommand = { id: `/ask:codebase ${question}`, label: `/ask:codebase ${question}`, description: '', template: '' }
    void selectSlashCommand(syntheticCmdAC)
    return
  }

  // /compare:files <a> <b> — with inline file arguments
  if (rawText.startsWith('/compare:files ')) {
    inputText.value = ''
    const args = rawText.slice('/compare:files '.length).trim()
    const syntheticCmdCF: SlashCommand = { id: `/compare:files ${args}`, label: `/compare:files ${args}`, description: '', template: '' }
    void selectSlashCommand(syntheticCmdCF)
    return
  }

  // /git:log:author <name> — with inline author
  if (rawText.startsWith('/git:log:author ')) {
    inputText.value = ''
    const author = rawText.slice('/git:log:author '.length).trim()
    const syntheticCmdGLA: SlashCommand = { id: `/git:log:author ${author}`, label: `/git:log:author ${author}`, description: '', template: '' }
    void selectSlashCommand(syntheticCmdGLA)
    return
  }

  // /test:single <pattern> — run a specific test file or pattern
  if (rawText.startsWith('/test:single ')) {
    inputText.value = ''
    const pattern = rawText.slice('/test:single '.length).trim()
    const syntheticCmdTS: SlashCommand = { id: `/test:single ${pattern}`, label: `/test:single ${pattern}`, description: '', template: '' }
    void selectSlashCommand(syntheticCmdTS)
    return
  }

  // /agent:task <description> — multi-step autonomous task
  if (rawText.startsWith('/agent:task ')) {
    inputText.value = ''
    const desc = rawText.slice('/agent:task '.length).trim()
    const syntheticCmdAT: SlashCommand = { id: `/agent:task ${desc}`, label: `/agent:task ${desc}`, description: '', template: '' }
    void selectSlashCommand(syntheticCmdAT)
    return
  }

  // /note:add <text> — quick append to active notepad
  if (rawText.startsWith('/note:add ')) {
    const noteText = rawText.slice('/note:add '.length).trim()
    inputText.value = ''
    const syntheticCmdNA: SlashCommand = { id: `/note:add ${noteText}`, label: `/note:add ${noteText}`, description: '', template: '' }
    void selectSlashCommand(syntheticCmdNA)
    return
  }

  // /gen:table <description> — generate markdown table
  if (rawText.startsWith('/gen:table ')) {
    const tableDesc = rawText.slice('/gen:table '.length).trim()
    inputText.value = ''
    const syntheticCmdGT: SlashCommand = { id: `/gen:table ${tableDesc}`, label: `/gen:table ${tableDesc}`, description: '', template: '' }
    void selectSlashCommand(syntheticCmdGT)
    return
  }

  // /git:stash:apply <index> — apply stash by index
  if (rawText.startsWith('/git:stash:apply ')) {
    const stashIdx = rawText.slice('/git:stash:apply '.length).trim()
    inputText.value = ''
    const syntheticCmdGSA: SlashCommand = { id: `/git:stash:apply ${stashIdx}`, label: `/git:stash:apply ${stashIdx}`, description: '', template: '' }
    void selectSlashCommand(syntheticCmdGSA)
    return
  }

  // /explain:file <path> — with inline path argument
  if (rawText.startsWith('/explain:file ')) {
    inputText.value = ''
    const filePath = rawText.slice('/explain:file '.length).trim()
    const syntheticCmdEF: SlashCommand = { id: `/explain:file ${filePath}`, label: `/explain:file ${filePath}`, description: '', template: '' }
    void selectSlashCommand(syntheticCmdEF)
    return
  }

  // /ask:selection <question> — quick question about selection
  if (rawText.startsWith('/ask:selection ')) {
    inputText.value = ''
    const question = rawText.slice('/ask:selection '.length).trim()
    const syntheticCmdAS: SlashCommand = { id: `/ask:selection ${question}`, label: `/ask:selection ${question}`, description: '', template: '' }
    void selectSlashCommand(syntheticCmdAS)
    return
  }

  // /explain:commit [N] — explain last N commits (supports /explain:commit 10)
  if (rawText === '/explain:commit' || /^\/explain:commit\s+\d+$/.test(rawText)) {
    inputText.value = ''
    if (!props.workspacePath) { showToast('/explain:commit requires an open workspace'); return }
    const nArg = parseInt(rawText.replace('/explain:commit', '').trim() || '5', 10)
    const n = Math.max(1, Math.min(50, nArg))
    try {
      showToast(`Fetching last ${n} commits…`)
      interface ShellRespEC { ok: boolean; output?: string; error?: string }
      const resp = await props.backend.send<ShellRespEC>('shell.run', {
        command: `git log -${n} --format="commit %H%nauthor: %an%ndate: %ad%nsubject: %s%n%nbody:%n%b%n---" --date=short 2>&1`,
        workspace_path: props.workspacePath,
      })
      if (resp.payload?.ok && resp.payload.output?.trim()) {
        contextChips.value = contextChips.value.filter((c) => !c.label.startsWith('@git:log:'))
        contextChips.value.push({ id: crypto.randomUUID(), label: `@git:log:${n}`, content: `// Last ${n} commits:\n${resp.payload.output.slice(0, 8000)}` })
        inputText.value = `Explain these ${n} commits in plain English. For each: what changed, why it likely happened, and any risks or notable patterns.`
      } else {
        inputText.value = 'Explain the recent git commits in plain English. Describe what changed and why.'
      }
    } catch { inputText.value = 'Explain the recent git commits in plain English.' }
    nextTick(() => { textareaEl.value?.focus() })
    return
  }

  // /open <filename> — open a file in the editor by fuzzy name
  if (rawText === '/open' || rawText.startsWith('/open ')) {
    const query = rawText.slice('/open'.length).trim()
    inputText.value = ''
    if (!query) {
      showToast('Usage: /open <filename or pattern>')
      inputText.value = '/open '
      await nextTick(); textareaEl.value?.focus()
      return
    }
    if (!props.workspacePath) { showToast('/open requires an open workspace'); return }
    try {
      interface FlatRespOpen { ok: boolean; files?: string[]; error?: string }
      const resp = await props.backend.send<FlatRespOpen>('fs.list_files_flat', { workspace_path: props.workspacePath, query })
      if (!resp.payload?.ok) { showToast(`/open: ${resp.payload?.error ?? 'backend error'}`); return }
      const files = resp.payload.files ?? []
      const lower = query.toLowerCase()
      const matches = files.filter((f) => f.toLowerCase().includes(lower)).slice(0, 1)
      if (matches.length && props.openFile) {
        props.openFile(matches[0])
        showToast(`Opened: ${matches[0].split('/').pop()}`)
      } else if (matches.length) {
        contextChips.value.push({ id: crypto.randomUUID(), label: `@${query}`, content: `// Matching file: ${matches[0]}` })
        showToast(`Found: ${matches[0]}`)
      } else {
        showToast(`/open: no match for "${query}"`)
      }
    } catch { showToast('/open: unavailable') }
    return
  }

  // /test — run test suite and show output
  if (rawText === '/test' || rawText.startsWith('/test ')) {
    if (!props.workspacePath) { showToast('/test requires an open workspace'); return }
    const extra = rawText.slice('/test'.length).trim()
    const safeExtra = extra.replace(/[;&|`$(){}\\<>]/g, '')
    // Auto-detect test runner: vitest > pytest > npm test
    let testCmd = 'npm test -- --no-coverage 2>&1 | tail -80'
    try {
      // Check for Python test runner first (pytest)
      const hasPytest = await props.backend.send<{ok:boolean}>('fs.read_file', {
        workspace_path: props.workspacePath, rel_path: 'pytest.ini',
      }).catch(() => ({ payload: { ok: false } }))
      const hasPyproject = await props.backend.send<{ok:boolean;content?:string}>('fs.read_file', {
        workspace_path: props.workspacePath, rel_path: 'pyproject.toml',
      }).catch(() => ({ payload: { ok: false, content: '' } }))
      const isPytest = hasPytest.payload?.ok ||
        (hasPyproject.payload?.ok && hasPyproject.payload.content?.includes('[tool.pytest'))
      if (isPytest) {
        testCmd = `python3 -m pytest ${safeExtra} -q --tb=short 2>&1 | tail -100`
      } else {
        const hasPkg = await props.backend.send<{ok:boolean;content?:string}>('fs.read_file', {
          workspace_path: props.workspacePath, rel_path: 'package.json',
        })
        const pkg = JSON.parse(hasPkg.payload?.content ?? '{}') as Record<string, unknown>
        const devDeps = (pkg.devDependencies ?? {}) as Record<string, string>
        const deps = (pkg.dependencies ?? {}) as Record<string, string>
        if ('vitest' in devDeps || 'vitest' in deps) {
          testCmd = `npx vitest run ${safeExtra} 2>&1 | tail -100`
        } else if (safeExtra) {
          testCmd = `npm test -- ${safeExtra} 2>&1 | tail -100`
        }
      }
    } catch { /* keep default */ }
    inputText.value = ''
    messages.value.push({ role: 'user', content: `/test${extra ? ' ' + extra : ''}`, timestamp: Date.now() })
    showToast('Running tests…')
    try {
      interface ShellResp { ok: boolean; output?: string; exit_code?: number; error?: string }
      const resp = await props.backend.send<ShellResp>('shell.run', {
        command: testCmd, workspace_path: props.workspacePath,
      })
      const r = resp.payload
      const exitCode = r?.exit_code ?? 0
      const out = r?.output?.trim() ?? '(no output)'
      const status = exitCode === 0 ? '✓ Tests passed' : `✗ Tests failed (exit ${exitCode})`
      const content = `${status}\n\`\`\`\n${out}\n\`\`\``
      messages.value.push({ role: 'assistant', content, timestamp: Date.now() })
    } catch {
      messages.value.push({ role: 'assistant', content: 'Test command failed', isError: true, timestamp: Date.now() })
    }
    return
  }

  // /fixtests — run test suite and auto-ask AI to fix any failures
  if (rawText === '/fixtests' || rawText.startsWith('/fixtests ')) {
    if (!props.workspacePath) { showToast('/fixtests requires an open workspace'); return }
    const extra = rawText.slice('/fixtests'.length).trim()
    const safeExtra = extra.replace(/[;&|`$(){}\\<>]/g, '')
    let testCmd = 'npm test -- --no-coverage 2>&1 | tail -100'
    try {
      const hasPytest = await props.backend.send<{ok:boolean}>('fs.read_file', {
        workspace_path: props.workspacePath, rel_path: 'pytest.ini',
      }).catch(() => ({ payload: { ok: false } }))
      const hasPyproject = await props.backend.send<{ok:boolean;content?:string}>('fs.read_file', {
        workspace_path: props.workspacePath, rel_path: 'pyproject.toml',
      }).catch(() => ({ payload: { ok: false, content: '' } }))
      const isPytest = hasPytest.payload?.ok ||
        (hasPyproject.payload?.ok && hasPyproject.payload.content?.includes('[tool.pytest'))
      if (isPytest) {
        testCmd = `python3 -m pytest ${safeExtra} -q --tb=short 2>&1 | tail -100`
      } else {
        const hasPkg = await props.backend.send<{ok:boolean;content?:string}>('fs.read_file', {
          workspace_path: props.workspacePath, rel_path: 'package.json',
        }).catch(() => ({ payload: { ok: false, content: '{}' } }))
        const pkg = JSON.parse(hasPkg.payload?.content ?? '{}') as Record<string, unknown>
        const devDeps = (pkg.devDependencies ?? {}) as Record<string, string>
        const deps = (pkg.dependencies ?? {}) as Record<string, string>
        if ('vitest' in devDeps || 'vitest' in deps) {
          testCmd = `npx vitest run ${safeExtra} 2>&1 | tail -100`
        } else if (safeExtra) {
          testCmd = `npm test -- ${safeExtra} 2>&1 | tail -100`
        }
      }
    } catch { /* keep default */ }
    inputText.value = ''
    messages.value.push({ role: 'user', content: `/fixtests${extra ? ' ' + extra : ''}`, timestamp: Date.now() })
    showToast('Running tests…')
    try {
      interface ShellResp { ok: boolean; output?: string; exit_code?: number; error?: string }
      const resp = await props.backend.send<ShellResp>('shell.run', {
        command: testCmd, workspace_path: props.workspacePath,
      })
      const r = resp.payload
      const exitCode = r?.exit_code ?? 0
      const out = r?.output?.trim() ?? '(no output)'
      if (exitCode === 0) {
        messages.value.push({ role: 'assistant', content: '✓ All tests pass — nothing to fix!', timestamp: Date.now() })
        return
      }
      // Tests failed — add failure output as a context chip then ask AI to fix
      const truncated = out.length > 3000 ? '…(truncated)\n' + out.slice(-3000) : out
      contextChips.value.push({
        id: crypto.randomUUID(),
        label: '@test-failures',
        content: `// Test failures (exit ${exitCode}):\n\`\`\`\n${truncated}\n\`\`\``,
      })
      inputText.value = 'Fix the failing tests shown in @test-failures. Identify the root cause and provide the corrected code.'
      void sendMessage()
    } catch {
      messages.value.push({ role: 'assistant', content: 'Test runner failed', isError: true, timestamp: Date.now() })
    }
    return
  }

  // /run <cmd> — execute shell command and add output as message
  if (rawText.startsWith('/run ')) {
    const cmd = rawText.slice('/run '.length).trim()
    if (!cmd) { showToast('Usage: /run <command>'); return }
    if (!props.workspacePath) { showToast('/run requires an open workspace'); return }
    inputText.value = ''
    messages.value.push({ role: 'user', content: `/run ${cmd}`, timestamp: Date.now() })
    try {
      interface ShellResp { ok: boolean; output?: string; exit_code?: number; error?: string }
      const resp = await props.backend.send<ShellResp>('shell.run', {
        command: cmd, workspace_path: props.workspacePath,
      })
      const r = resp.payload
      const exitCode = r?.exit_code ?? 0
      const hasError = !r?.ok || exitCode !== 0
      const out = r?.ok
        ? `\`\`\`\n${r.output ?? '(no output)'}\n\`\`\`\n_Exit code: ${exitCode}_`
        : `Error: ${r?.error ?? 'unknown'}`
      messages.value.push({ role: 'assistant', content: out, timestamp: Date.now() })
      // If command failed, auto-inject output as context chip and offer explain
      if (hasError && r?.output?.trim()) {
        const errOutput = r.output.trim()
        contextChips.value = contextChips.value.filter((c) => c.label !== '@run:error')
        contextChips.value.push({ id: crypto.randomUUID(), label: '@run:error', content: `// Failed command: ${cmd}\n// Exit code: ${exitCode}\n\`\`\`\n${errOutput.slice(0, 3000)}\n\`\`\`` })
        inputText.value = `Explain this error and suggest how to fix it.`
        nextTick(() => { textareaEl.value?.focus() })
      }
    } catch { messages.value.push({ role: 'assistant', content: 'Command failed', isError: true, timestamp: Date.now() }) }
    return
  }

  // /export [markdown|json] — export chat
  if (rawText === '/export' || rawText.startsWith('/export ')) {
    const arg = rawText.slice('/export'.length).trim().toLowerCase()
    inputText.value = ''
    void exportConversation(arg === 'json' ? 'json' : arg === 'html' ? 'html' : 'markdown')
    return
  }

  // /search <query> — search workspace (inline flow: /search → user types → Enter)
  if (rawText.startsWith('/search ')) {
    const query = rawText.slice('/search '.length).trim()
    if (!query) { showToast('Usage: /search <query>'); return }
    inputText.value = ''
    try {
      interface SearchResp2 { ok: boolean; error?: string; results?: Array<{ rel_path: string; matches: Array<{ line: number; text: string }> }> }
      const resp = await props.backend.send<SearchResp2>('search.find_in_files', {
        workspace_path: props.workspacePath,
        query,
        is_regex: false,
        case_sensitive: false,
        max_results: 40,
      })
      const results = resp.payload?.results ?? []
      if (results.length === 0) { showToast(`No results for "${query}"`); return }
      let chipContent = `// Workspace search: "${query}" — ${results.length} files\n`
      for (const r of results.slice(0, 10)) {
        chipContent += `\n// ${r.rel_path}\n`
        for (const m of r.matches.slice(0, 4)) chipContent += `${m.line}: ${m.text}\n`
      }
      contextChips.value = contextChips.value.filter((c) => !c.label.startsWith('@search:'))
      contextChips.value.push({ id: crypto.randomUUID(), label: `@search:${query.slice(0, 20)}`, content: chipContent })
      inputText.value = `How is "${query}" used across the codebase? Explain the key usages found in @search results.`
      showToast(`Found in ${results.length} file(s)`)
    } catch { showToast('/search: unavailable') }
    nextTick(() => { textareaEl.value?.focus() })
    return
  }

  // /search:regex <pattern> — regex search (inline flow)
  if (rawText.startsWith('/search:regex ')) {
    const pattern = rawText.slice('/search:regex '.length).trim()
    if (!pattern) { showToast('Usage: /search:regex <pattern>'); return }
    inputText.value = ''
    try {
      interface SearchResp3 { ok: boolean; error?: string; results?: Array<{ rel_path: string; matches: Array<{ line: number; text: string }> }> }
      const resp = await props.backend.send<SearchResp3>('search.find_in_files', {
        workspace_path: props.workspacePath,
        query: pattern,
        is_regex: true,
        case_sensitive: false,
        max_results: 40,
      })
      const results = resp.payload?.results ?? []
      if (results.length === 0) { showToast(`No regex matches for /${pattern}/`); return }
      let chipContent = `// Regex search: /${pattern}/ — ${results.length} files\n`
      for (const r of results.slice(0, 10)) {
        chipContent += `\n// ${r.rel_path}\n`
        for (const m of r.matches.slice(0, 4)) chipContent += `${m.line}: ${m.text}\n`
      }
      contextChips.value = contextChips.value.filter((c) => !c.label.startsWith('@search:'))
      contextChips.value.push({ id: crypto.randomUUID(), label: `@search:/${pattern.slice(0, 18)}/`, content: chipContent })
      inputText.value = `Explain all matches of /${pattern}/ found in @search results above.`
      showToast(`Regex matched in ${results.length} file(s)`)
    } catch { showToast('/search:regex: unavailable') }
    nextTick(() => { textareaEl.value?.focus() })
    return
  }

  // /translate <lang> — inline flow: user types /translate Spanish → Enter
  if (rawText.startsWith('/translate ')) {
    const targetLang = rawText.slice('/translate '.length).trim()
    if (!targetLang) { showToast('Usage: /translate <language>'); return }
    inputText.value = ''
    const relPath = props.getActiveRelPath?.()
    const fileContent = props.getEditorContent?.()
    if (relPath && fileContent !== undefined && contextChips.value.length === 0) {
      const ext = relPath.split('.').pop() ?? ''
      contextChips.value.push({ id: crypto.randomUUID(), label: `@${relPath.split('/').pop()}`, content: `// File: ${relPath}\n\`\`\`${ext}\n${fileContent.slice(0, 60_000)}\n\`\`\`` })
    }
    inputText.value = contextChips.value.length
      ? `Translate all code comments, string literals, and documentation in the attached file(s) to ${targetLang}. Preserve code logic and formatting exactly. Output the complete translated file.`
      : `Translate the following text to ${targetLang}:`
    nextTick(() => { textareaEl.value?.focus() })
    return
  }

  // /rename <title> — rename current thread
  if (rawText.startsWith('/rename ')) {
    const newTitle = rawText.slice('/rename '.length).trim()
    if (newTitle) {
      const ct = allThreads.value.find((t) => t.id === currentThreadId.value)
      if (ct) { ct.title = newTitle; saveCurrentThread(); showToast('Thread renamed') }
    }
    inputText.value = ''
    return
  }

  // /checkpoint [name] — save current conversation snapshot
  if (rawText === '/checkpoint' || rawText.startsWith('/checkpoint ')) {
    const name = rawText.slice('/checkpoint'.length).trim()
    inputText.value = ''
    saveCheckpoint(name || undefined)
    return
  }

  // /checkpoints — open checkpoint panel
  if (rawText === '/checkpoints') {
    inputText.value = ''
    showCheckpoints.value = true
    return
  }

  // /save-prompt <name> — save named empty template from command line
  if (rawText.startsWith('/save-prompt ')) {
    const nameArg = rawText.slice('/save-prompt '.length).trim()
    inputText.value = ''
    if (nameArg) {
      const tmpl: PromptTemplate = { id: `pt-${Date.now()}`, name: nameArg, text: '' }
      promptTemplates.value = [tmpl, ...promptTemplates.value]
      savePromptTemplates()
      showToast(`Saved template: "${nameArg}" — open Prompt Templates to add content`)
    } else {
      showToast('Usage: /save-prompt <name>')
    }
    return
  }

  if (streamTickInterval !== null) { clearInterval(streamTickInterval); streamTickInterval = null }
  streamTickInterval = window.setInterval(() => { streamNow.value = Date.now() }, 500)

  // Build user content with context chips prepended
  const imageChips = contextChips.value.filter((c) => c.imageData)
  let textContent = ''
  for (const chip of contextChips.value) {
    if (!chip.imageData) textContent += `[Context: ${chip.label}]\n${chip.content}\n\n`
  }
  if (rawText) textContent += `[User]: ${rawText}`
  const displayText = rawText || contextChips.value.map((c) => c.label).join(' ')

  // If images are present, build a multimodal content array for Anthropic
  type ContentBlock = { type: 'text'; text: string } | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } }
  let sentContent: string | ContentBlock[]
  if (imageChips.length > 0) {
    const blocks: ContentBlock[] = []
    for (const ic of imageChips) {
      const dataUrl = ic.imageData!
      const sep = dataUrl.indexOf(',')
      const meta = dataUrl.slice(5, sep)  // e.g. "image/png;base64"
      const mediaType = meta.split(';')[0]
      const b64 = dataUrl.slice(sep + 1)
      blocks.push({ type: 'image', source: { type: 'base64', media_type: mediaType, data: b64 } })
    }
    if (textContent.trim()) blocks.push({ type: 'text', text: textContent })
    sentContent = blocks
  } else {
    sentContent = textContent || displayText
  }

  // Keep the in-memory list bounded so a very long session doesn't exhaust memory.
  if (messages.value.length >= MAX_MESSAGES) messages.value.splice(0, messages.value.length - MAX_MESSAGES + 1)
  const _ctxRefs = contextChips.value.map((c) => c.label)
  messages.value.push({ role: 'user', content: displayText, rawContent: sentContent, timestamp: Date.now(), contextRefs: _ctxRefs.length ? _ctxRefs : undefined, imageData: imageChips.length > 0 ? imageChips[0].imageData : undefined })
  // Auto-name thread from first user message when still "New chat"
  const curThread = allThreads.value.find((t) => t.id === currentThreadId.value)
  if (curThread && curThread.title === 'New chat' && rawText) {
    const stripped = rawText.replace(/^\/\S+\s*/, '').trim()
    const firstLine = (stripped || rawText).split('\n')[0].trim()
    curThread.title = firstLine.slice(0, 50) + (firstLine.length > 50 ? '…' : '')
  }
  // Keep pinned chips across sends; clear the rest
  contextChips.value = contextChips.value.filter((c) => c.pinned)
  if (rawText) {
    inputHistory.push(rawText)
    if (inputHistory.length > 50) inputHistory.shift()
    historyIdx = -1
    historySavedDraft = ''
  }
  inputText.value = ''
  nextTick(() => { if (textareaEl.value) _autoResizeTextarea(textareaEl.value) })
  sending.value = true

  const sessionId = crypto.randomUUID()
  currentSessionId.value = sessionId

  // Build messages history for backend — use rawContent so AI sees actual @chip content
  const history = messages.value.slice(0, -1).map((m) => ({
    role: m.role,
    content: m.rawContent ?? m.content,
  }))
  history.push({ role: 'user', content: sentContent })

  // Push placeholder assistant message for streaming
  messages.value.push({ role: 'assistant', content: '', streaming: true, thinking: true, cards: [], model: settingsModel.value, timestamp: Date.now(), sendMs: Date.now() })
  autoScroll.value = true
  await scrollBottom(true)

  try {
    const lengthHint = RESPONSE_LENGTH_HINTS[responseLength.value]
    const notesSuffix = notesContent.value.trim() ? `\n\n--- Workspace Notes ---\n${notesContent.value.trim()}` : ''
    const pinnedNotepads = namedNotepads.value.filter((n) => n.pinned && n.content.trim())
    const pinnedNotepadsSuffix = pinnedNotepads.length
      ? '\n\n' + pinnedNotepads.map((n) => `--- Pinned Notepad: ${n.name} ---\n${n.content.trim().slice(0, 4000)}`).join('\n\n')
      : ''
    const memoriesSuffix = memories.value.length ? `\n\n--- Memories (Persistent Facts) ---\n${memories.value.map((m, i) => `${i + 1}. ${m}`).join('\n')}` : ''
    // Smart Context: inject active file as ambient context (capped at 200 lines)
    let smartCtxSuffix = ''
    if (settingsSmartContext.value && props.getActiveRelPath && props.getEditorContent) {
      const relPath = props.getActiveRelPath()
      const fileContent = props.getEditorContent()
      const alreadyMentioned = contextChips.value.some((c) => c.label.startsWith('@') && c.label.includes(relPath?.split('/').pop() ?? ''))
      if (relPath && fileContent && !alreadyMentioned) {
        const lines = fileContent.split('\n').slice(0, 200).join('\n')
        smartCtxSuffix = `\n\n--- Current open file: ${relPath} ---\n\`\`\`\n${lines}\n\`\`\``
      }
    }
    // Edit mode: inject working set file contents into context
    let editSetSuffix = ''
    if (chatMode.value === 'edit' && editWorkingSet.value.length > 0) {
      const files: string[] = []
      for (const relPath of editWorkingSet.value) {
        try {
          interface FileResp { ok: boolean; content?: string; payload?: { content?: string } }
          const r = await props.backend.send<FileResp>('fs.read_file', { workspace_path: props.workspacePath, rel_path: relPath })
          const content = (r as { payload?: { content?: string } }).payload?.content ?? ''
          if (content) files.push(`--- ${relPath} ---\n\`\`\`\n${content.slice(0, 6000)}\n\`\`\``)
        } catch { /* skip unreadable files */ }
      }
      if (files.length) {
        editSetSuffix = `\n\n[EDIT MODE: Working set of files for targeted editing. For each file you modify, output the COMPLETE updated file content inside a fenced code block with the file path on the first line (e.g. \`\`\`typescript\n// src/foo.ts\n...\n\`\`\`). The user can then apply individual changes.]\n${files.join('\n\n')}`
      }
    }
    // Workspace rules: inject alwaysApply rules + glob-matched rules based on context files
    const ctxFilePaths: string[] = []
    const activeRelPath = props.getActiveRelPath?.()
    if (activeRelPath) ctxFilePaths.push(activeRelPath)
    for (const chip of contextChips.value) {
      const m = chip.label.match(/^@(?:file|selection):([^:]+)/)
      if (m) ctxFilePaths.push(m[1])
    }
    ctxFilePaths.push(...editWorkingSet.value)
    const matchingGlobBodies = workspaceGlobRules.value
      .filter((rule) =>
        rule.globs.split(/[,\s]+/).filter(Boolean).some((pat) =>
          ctxFilePaths.some((fp) => globToRegex(pat).test(fp))
        )
      )
      .map((rule) => rule.body)
    const allRules = [workspaceRulesContent.value.trim(), ...matchingGlobBodies].filter(Boolean)
    const projectRulesPrefix = allRules.length
      ? `--- Project Rules ---\n${allRules.join('\n\n---\n\n')}\n---\n\n`
      : ''
    const userRulesPrefix = settingsUserRules.value.trim()
      ? `--- User Rules (applies to all projects) ---\n${settingsUserRules.value.trim()}\n---\n\n`
      : ''
    const rulesPrefix = userRulesPrefix + projectRulesPrefix
    // Global context pins: read pinned files and inject into system suffix
    let globalPinsSuffix = ''
    if (globalContextPins.value.length > 0 && props.workspacePath) {
      const pinParts: string[] = []
      for (const pin of globalContextPins.value) {
        try {
          interface PinFileResp { ok: boolean; content?: string; payload?: { content?: string } }
          const pr = await props.backend.send<PinFileResp>('fs.read_file', { workspace_path: props.workspacePath, rel_path: pin.relPath })
          const content = pr.payload?.content ?? pr.payload?.payload?.content ?? ''
          const ext = pin.relPath.split('.').pop() ?? ''
          if (content) pinParts.push(`--- Always-Include: ${pin.relPath} ---\n\`\`\`${ext}\n${content.slice(0, 8000)}\n\`\`\``)
        } catch { /* skip unreadable */ }
      }
      if (pinParts.length) globalPinsSuffix = `\n\n${pinParts.join('\n\n')}`
    }
    settingsSet('ai-chat-smart-context', settingsSmartContext.value ? 'true' : 'false')
    await props.backend.send('ai.chat.start', {
      session_id: sessionId,
      messages: history,
      workspace_path: props.workspacePath,
      ...(rulesPrefix ? { system_prefix: rulesPrefix } : {}),
      ...(lengthHint || notesSuffix || pinnedNotepadsSuffix || memoriesSuffix || globalPinsSuffix || smartCtxSuffix || editSetSuffix ? { system_suffix: (lengthHint ?? '') + notesSuffix + pinnedNotepadsSuffix + memoriesSuffix + globalPinsSuffix + smartCtxSuffix + editSetSuffix } : {}),
    })
  } catch {
    const last = messages.value[messages.value.length - 1]
    if (last?.role === 'assistant') {
      last.streaming = false; last.thinking = false
      last.isError = true; last.errorMsg = 'Unable to connect to backend'
    }
    if (streamTickInterval !== null) { clearInterval(streamTickInterval); streamTickInterval = null }
    sending.value = false
    currentSessionId.value = null
  }
}

function addMsg(msg: ChatMessage): void {
  messages.value.push({ ...msg, timestamp: msg.timestamp ?? Date.now() })
}

function sendToBackend(): Promise<void> {
  return sendMessage()
}

// ── Stop streaming ─────────────────────────────────────────────────────────────
function stopStreaming(): void {
  if (!sending.value) return
  props.backend.send('ai.chat.stop', { session_id: currentSessionId.value ?? '' }).catch(() => {/* ignore */})
  const last = messages.value[messages.value.length - 1]
  if (last?.streaming) { last.streaming = false; last.thinking = false }
  sending.value = false
  currentSessionId.value = null
  if (streamTickInterval !== null) { clearInterval(streamTickInterval); streamTickInterval = null }
  if (pendingCompactAllMessages.value.length > 0) {
    messages.value = pendingCompactAllMessages.value
    pendingCompactAllMessages.value = []
  }
  pendingCompactKeep.value = []
}

// ── Clear conversation (clear current thread) ──────────────────────────────────
function clearConversation(): void {
  if (messages.value.length === 0) return
  if (sending.value) stopStreaming()
  _navAssistIdx = -1
  messages.value = []
  expandedMsgIdxs.value = new Set(); expandedDiffs.value = new Set()
  // Also reset the title so it auto-updates on next message
  const idx = allThreads.value.findIndex((t) => t.id === currentThreadId.value)
  if (idx !== -1) allThreads.value[idx].title = 'New chat'
  saveCurrentThread()
  showToast('Chat cleared')
}

// ── Edit a previous user message (truncate history from that point) ────────────
function editMessage(idx: number): void {
  if (sending.value) stopStreaming()
  const msg = messages.value[idx]
  if (!msg || msg.role !== 'user') return
  // Put original display text back into the input box
  inputText.value = msg.content
  // Remove this message and everything after it
  messages.value.splice(idx)
  saveCurrentThread()
  nextTick(() => textareaEl.value?.focus())
}

// ── Delete a message pair (user + following assistant response) ─────────────
function deleteMessagePair(idx: number): void {
  if (sending.value) return
  const msg = messages.value[idx]
  if (!msg || msg.role !== 'user') return
  const next = messages.value[idx + 1]
  const count = next?.role === 'assistant' ? 2 : 1
  if (!window.confirm(`Delete this ${count === 2 ? 'message exchange' : 'message'}?`)) return
  messages.value.splice(idx, count)
  saveCurrentThread()
}

// ── Add AI response text as a context chip ─────────────────────────────────
function addResponseAsContext(msg: ChatMessage): void {
  const text = messageText(msg).trim().slice(0, 8000)
  if (!text) return
  const label = `@ai:response`
  if (!contextChips.value.some((c) => c.label === label)) {
    contextChips.value.push({ id: crypto.randomUUID(), label, content: `// Previous AI response:\n${text}` })
  } else {
    showToast('@ai:response already in context')
    return
  }
  showToast('AI response added as context chip')
  nextTick(() => textareaEl.value?.focus())
}

// ── Quote-reply a message ──────────────────────────────────────────────────────
function quoteReply(msg: ChatMessage): void {
  const stripped = msg.content.replace(/[#*`_~>]/g, '').trim()
  const excerpt = stripped.slice(0, 120) + (stripped.length > 120 ? '…' : '')
  const prefix = `> ${excerpt}\n\n`
  inputText.value = prefix + inputText.value
  nextTick(() => {
    const el = textareaEl.value
    if (!el) return
    el.focus()
    // Place cursor after the quote block
    el.setSelectionRange(prefix.length, prefix.length)
  })
}

// ── Fork conversation from a message (create a new thread from this point) ────
function forkFromMessage(idx: number): void {
  if (sending.value) return
  const msg = messages.value[idx]
  if (!msg || msg.role !== 'user') return
  // Save a new thread with messages UP TO (not including) this message
  const forkHistory = messages.value.slice(0, idx).filter((m) => !m.streaming)
  const baseTitle = (allThreads.value.find((t) => t.id === currentThreadId.value)?.title ?? 'Chat') + ' (fork)'
  const newThread: ChatThread = {
    id: crypto.randomUUID(),
    title: baseTitle.slice(0, 60),
    messages: forkHistory,
    updatedAt: Date.now(),
    forkedFrom: currentThreadId.value ?? undefined,
  }
  allThreads.value.unshift(newThread)
  saveCurrentThread()
  // Switch to the new thread with the forked message in the input box
  switchThread(newThread.id)
  inputText.value = msg.content
  nextTick(() => textareaEl.value?.focus())
  showToast('Forked to new chat')
}

// ── Copy message ───────────────────────────────────────────────────────────────
// ── Export conversation ────────────────────────────────────────────────────────
async function exportConversation(format: 'markdown' | 'json' | 'html' = 'markdown'): Promise<void> {
  const msgs = messages.value.filter((m) => !m.streaming)
  if (msgs.length === 0) {
    showToast('No messages to export')
    return
  }
  let content: string
  let defaultName: string
  if (format === 'json') {
    const data = msgs.map((m) => ({ role: m.role, content: m.content, model: m.model, timestamp: m.timestamp }))
    content = JSON.stringify({ messages: data, exportedAt: new Date().toISOString() }, null, 2)
    defaultName = 'ai-chat-export.json'
  } else if (format === 'html') {
    const title = currentThread.value?.title ?? 'AI Chat Export'
    const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    let body = ''
    for (const msg of msgs) {
      const role = msg.role === 'user' ? 'user' : 'assistant'
      const label = msg.role === 'user' ? 'User' : `Assistant${msg.model ? ` (${msg.model})` : ''}`
      const ts = new Date(msg.timestamp ?? Date.now()).toLocaleString()
      body += `<div class="msg ${role}"><div class="role">${esc(label)} <span class="ts">${esc(ts)}</span></div><pre class="content">${esc(msg.content)}</pre></div>\n`
    }
    content = `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>${esc(title)}</title><style>
body{font-family:system-ui,-apple-system,sans-serif;max-width:860px;margin:40px auto;padding:0 20px;color:#1f2328;background:#fff}
h1{font-size:1.3em;border-bottom:1px solid #d0d7de;padding-bottom:8px}
.msg{margin:16px 0;border-radius:8px;overflow:hidden;border:1px solid #d0d7de}
.role{padding:6px 14px;font-size:.78em;font-weight:600;background:#f6f8fa;border-bottom:1px solid #d0d7de;color:#656d76}
.ts{font-weight:400;color:#8c959f}
.content{margin:0;padding:12px 14px;white-space:pre-wrap;word-break:break-word;font-family:inherit;font-size:.9em;line-height:1.6}
.user .role{background:#ddf4ff;color:#0969da}
.assistant .role{background:#f0f0ff;color:#6e40c9}
</style></head><body><h1>${esc(title)}</h1>\n${body}</body></html>`
    defaultName = 'ai-chat-export.html'
  } else {
    let md = '# AI Chat Export\n\n'
    for (const msg of msgs) {
      const roleLabel = msg.role === 'user' ? '**User**' : `**Assistant**${msg.model ? ` (${msg.model})` : ''}`
      md += `### ${roleLabel}\n\n${msg.content}\n\n---\n\n`
    }
    content = md
    defaultName = 'ai-chat-export.md'
  }
  try {
    const r = await window.agentTeam?.saveJson({ defaultName, content, title: 'Export chat' })
    if (r && !r.ok && !r.canceled) showToast('Export failed')
    else if (r?.ok) showToast('Chat exported')
  } catch { showToast('Export failed') }
}

function copyThreadAsMarkdown(): void {
  const msgs = messages.value.filter((m) => !m.streaming)
  if (msgs.length === 0) { showToast('No messages to copy'); return }
  let md = `# ${currentThread.value?.title ?? 'AI Chat'}\n\n`
  for (const msg of msgs) {
    const roleLabel = msg.role === 'user' ? '**User**' : `**Assistant**${msg.model ? ` (${msg.model})` : ''}`
    md += `### ${roleLabel}\n\n${msg.content}\n\n---\n\n`
  }
  navigator.clipboard.writeText(md).then(() => showToast('Thread copied as Markdown')).catch(() => showToast('Copy failed'))
}

async function importConversation(): Promise<void> {
  try {
    const r = await window.agentTeam?.openJson({ title: 'Import chat (JSON)' })
    if (!r || r.canceled || !r.ok) return
    const raw = r.content
    if (!raw) { showToast('Import failed: empty file'); return }
    let parsed: { messages?: Array<{ role: string; content: string; model?: string; timestamp?: number }> }
    try { parsed = JSON.parse(raw) } catch { showToast('Import failed: invalid JSON'); return }
    const msgs = parsed?.messages
    if (!Array.isArray(msgs) || msgs.length === 0) { showToast('Import failed: no messages found'); return }
    const imported: ChatMessage[] = msgs
      .filter((m) => (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
      .map((m) => ({
        role: m.role as 'user' | 'assistant',
        content: m.content,
        model: m.model,
        timestamp: m.timestamp ?? Date.now(),
      }))
    if (imported.length === 0) { showToast('Import failed: no valid messages'); return }
    newThread()
    await nextTick()
    messages.value = imported
    saveCurrentThread()
    showToast(`Imported ${imported.length} messages`)
  } catch { showToast('Import failed') }
}

function copyMessage(content: string): void {
  navigator.clipboard.writeText(content).then(() => showToast('Copied')).catch(() => showToast('Copy failed'))
}

function quoteMessage(content: string): void {
  // Use window selection if present, else use first 300 chars of message
  const sel = window.getSelection()?.toString().trim() || ''
  const snippet = sel || content.replace(/```[\s\S]*?```/g, '[code block]').replace(/\n{3,}/g, '\n\n').trim().slice(0, 300)
  const quoted = snippet.split('\n').map((l) => `> ${l}`).join('\n')
  inputText.value = (inputText.value ? inputText.value + '\n\n' : '') + quoted + '\n\n'
  nextTick(() => {
    textareaEl.value?.focus()
    const len = inputText.value.length
    textareaEl.value?.setSelectionRange(len, len)
  })
  showToast('Quoted — add your question below')
}

function saveResponseToNotepad(msg: ChatMessage): void {
  const plain = msg.content.trim()
  if (!plain) return
  const timestamp = new Date().toLocaleString('sv').replace('T', ' ')
  const snippet = plain.slice(0, 60).replace(/\n/g, ' ')
  const entry = `\n---\n_Saved from AI Chat · ${timestamp}_\n\n${plain}\n`
  if (!namedNotepads.value.length) {
    const np = createNotepad('AI Responses')
    updateNotepadContent(np.id, entry)
  } else {
    const target = activeNotepad.value ?? namedNotepads.value[0]
    updateNotepadContent(target.id, (target.content ? target.content : '') + entry)
  }
  showToast(`Saved: "${snippet}…" → Notepad`)
}

// ── Message right-click context menu ──────────────────────────────────────────
function onMsgContextMenu(e: MouseEvent): void {
  const wrap = (e.target as Element).closest<HTMLElement>('.ai-msg-wrap')
  if (!wrap) return
  e.preventDefault()
  const mi = parseInt(wrap.dataset.mi ?? '-1', 10)
  if (mi < 0 || mi >= messages.value.length) return
  const vw = window.innerWidth, vh = window.innerHeight
  msgCtxMenu.value = { x: Math.min(e.clientX, vw - 168), y: Math.min(e.clientY, vh - 200), mi, role: messages.value[mi].role }
}
function closeMsgCtxMenu(): void { msgCtxMenu.value = null }
function ctxMenuCopy(): void {
  if (!msgCtxMenu.value) return
  const content = messages.value[msgCtxMenu.value.mi]?.content ?? ''
  navigator.clipboard.writeText(content).catch(() => {})
  showToast('Copied to clipboard')
  msgCtxMenu.value = null
}
function ctxMenuQuote(): void {
  if (!msgCtxMenu.value) return
  quoteMessage(messages.value[msgCtxMenu.value.mi]?.content ?? '')
  msgCtxMenu.value = null
}
function ctxMenuEdit(): void {
  if (!msgCtxMenu.value) return
  inputText.value = messages.value[msgCtxMenu.value.mi]?.content ?? ''
  msgCtxMenu.value = null
  nextTick(() => textareaEl.value?.focus())
}
function ctxMenuDelete(): void {
  if (!msgCtxMenu.value) return
  messages.value.splice(msgCtxMenu.value.mi, 1)
  saveCurrentThread()
  msgCtxMenu.value = null
}
function ctxMenuRegen(): void {
  msgCtxMenu.value = null
  void regenerate()
}
async function ctxMenuSaveToRules(): Promise<void> {
  if (!msgCtxMenu.value) return
  const content = messages.value[msgCtxMenu.value.mi]?.content ?? ''
  msgCtxMenu.value = null
  if (!props.workspacePath) { showToast('Open a workspace first'); return }
  const sel = window.getSelection()?.toString().trim()
  const rule = sel || content.replace(/```[\s\S]*?```/g, '').trim().slice(0, 500)
  if (!rule) { showToast('No content to save'); return }
  const entry = `\n\n## AI Rule (from chat)\n${rule}`
  // Try to append to AGENTS.md or .cursorrules
  for (const rulePath of ['AGENTS.md', '.cursor/rules', '.cursorrules']) {
    try {
      interface ReadResp extends ReadPayload {}
      const fr = await props.backend.send<ReadResp>('fs.read_file', { workspace_path: props.workspacePath, rel_path: rulePath })
      if (fr.payload?.ok || rulePath === 'AGENTS.md') {
        const existing = fr.payload?.content ?? ''
        interface WriteResp { ok: boolean; error?: string }
        const wr = await props.backend.send<WriteResp>('fs.write_file', { workspace_path: props.workspacePath, rel_path: rulePath, content: existing + entry })
        if (wr.payload?.ok) { showToast(`Saved to ${rulePath}`); return }
      }
    } catch { /* try next */ }
  }
  showToast('Could not save rule — create AGENTS.md first')
}
function ctxMenuSaveToMemory(): void {
  if (!msgCtxMenu.value) return
  const content = messages.value[msgCtxMenu.value.mi]?.content ?? ''
  msgCtxMenu.value = null
  const sel = window.getSelection()?.toString().trim()
  const fact = sel || content.replace(/```[\s\S]*?```/g, '').replace(/\s+/g, ' ').trim().slice(0, 300)
  if (!fact) { showToast('No content to save as memory'); return }
  addMemory(fact)
  showToast(`Memory saved: "${fact.slice(0, 60)}…"`)
}

// ── Context menu — new thread from message, add to context, create snippet ──────
function ctxMenuPinMsg(): void {
  if (!msgCtxMenu.value) return
  const mi = msgCtxMenu.value.mi
  msgCtxMenu.value = null
  const msg = messages.value[mi]
  if (!msg) return
  msg.pinned = !msg.pinned
  saveCurrentThread()
  showToast(msg.pinned ? 'Message pinned ⭐' : 'Message unpinned')
}

function ctxMenuForkThread(): void {
  if (!msgCtxMenu.value) return
  const mi = msgCtxMenu.value.mi
  msgCtxMenu.value = null
  const source = allThreads.value.find((t) => t.id === currentThreadId.value)
  if (!source) return
  const cloned: ChatThread = {
    id: crypto.randomUUID(),
    title: `Fork from: ${source.title}`,
    messages: JSON.parse(JSON.stringify(source.messages.slice(0, mi + 1))) as typeof source.messages,
    updatedAt: Date.now(),
    model: source.model,
    systemPrompt: source.systemPrompt,
  }
  allThreads.value.unshift(cloned)
  _doSave()
  currentThreadId.value = cloned.id
  showToast(`Forked thread at message ${mi + 1}`)
}

function ctxMenuAddToContext(): void {
  if (!msgCtxMenu.value) return
  const content = messages.value[msgCtxMenu.value.mi]?.content ?? ''
  const role = msgCtxMenu.value.role
  msgCtxMenu.value = null
  const preview = content.slice(0, 40).replace(/\n/g, ' ')
  contextChips.value.push({ id: crypto.randomUUID(), label: `@msg:${role}:${preview}…`, content: `// Message context (${role}):\n${content.slice(0, 8000)}` })
  showToast('Message added to context')
}

function ctxMenuCreateSnippet(): void {
  if (!msgCtxMenu.value) return
  const content = messages.value[msgCtxMenu.value.mi]?.content ?? ''
  msgCtxMenu.value = null
  // Extract first code block
  const codeMatch = /```(?:[a-z]*)\n([\s\S]*?)```/.exec(content)
  const code = codeMatch?.[1]?.trim() ?? window.getSelection()?.toString().trim() ?? ''
  if (!code) { showToast('No code block found in message'); return }
  const langMatch = /```([a-z]*)/.exec(content)
  const lang = langMatch?.[1] ?? ''
  const name = window.prompt('Snippet name:', 'snippet') ?? ''
  if (!name.trim()) { showToast('Snippet creation cancelled'); return }
  const SAVED_SNIPPETS_KEY = 'ai-chat-snippets'
  interface Snippet { id: string; name: string; content: string; lang: string; createdAt: number }
  const existing: Snippet[] = (() => { try { return JSON.parse(settingsGet(SAVED_SNIPPETS_KEY, '[]')) as Snippet[] } catch { return [] } })()
  existing.unshift({ id: crypto.randomUUID(), name: name.trim(), content: code, lang, createdAt: Date.now() })
  settingsSet(SAVED_SNIPPETS_KEY, JSON.stringify(existing.slice(0, 200)))
  showToast(`Snippet saved: "${name.trim()}"`)
}

// ── Regenerate last AI response ────────────────────────────────────────────────
function undoLastSend(): void {
  if (sending.value) return
  // Find the last user message and remove it plus any trailing assistant messages
  let lastUserIdx = -1
  for (let i = messages.value.length - 1; i >= 0; i--) {
    if (messages.value[i].role === 'user') { lastUserIdx = i; break }
  }
  if (lastUserIdx === -1) return
  const userMsg = messages.value[lastUserIdx]
  // Restore the user's message text into the input box
  inputText.value = userMsg.content
  messages.value = messages.value.slice(0, lastUserIdx)
  saveCurrentThread()
  nextTick(() => textareaEl.value?.focus())
  showToast('Message removed — edit and resend')
}

// ── Regenerate with a different model ─────────────────────────────────────────
const regenModelOpen = ref(false)

function regenWithModel(modelId: string): void {
  regenModelOpen.value = false
  const prevModel    = settingsModel.value
  const prevProvider = settingsProvider.value
  switchModel(modelId)
  void regenerate().finally(() => {
    // Restore previous provider + model after the stream completes or fails
    if (settingsModel.value === modelId) {
      settingsProvider.value = prevProvider
      settingsModel.value = prevModel
      saveSettings()
    }
  })
}

function regenWithHigherTemp(): void {
  regenModelOpen.value = false
  if (reasoningModelSelected.value) { showToast('Temperature not supported for reasoning models'); return }
  const prev = settingsTemperature.value
  const boosted = Math.min(1.0, (prev ?? 0.7) + 0.3)
  settingsTemperature.value = boosted
  _pushSettingsToBackend()
  void regenerate().finally(() => {
    settingsTemperature.value = prev
    _pushSettingsToBackend()
  })
}

// ── Fix Problems shortcut ──────────────────────────────────────────────────────
async function fixProblems(): Promise<void> {
  if (sending.value || !props.workspacePath) return
  showToast('Running type check…')
  try {
    interface ShellResp { ok: boolean; output?: string; exit_code?: number; error?: string }
    const resp = await props.backend.send<ShellResp>('shell.run', {
      command: 'npx vue-tsc --noEmit 2>&1 | head -120',
      workspace_path: props.workspacePath,
    })
    const out = (resp.payload?.output ?? '').trim()
    if (!out || resp.payload?.exit_code === 0) {
      showToast('No TypeScript errors found ✓')
      return
    }
    const chipContent = `// TypeScript errors in workspace:\n${out}`
    contextChips.value = contextChips.value.filter((c) => c.label !== '@problems')
    contextChips.value.push({ id: crypto.randomUUID(), label: '@problems', content: chipContent })
    inputText.value = 'Fix the TypeScript errors shown in @problems above.'
    nextTick(() => textareaEl.value?.focus())
  } catch {
    showToast('Type check unavailable')
  }
}

// ── Pick & attach image from disk (via hidden <input type="file">) ────────────
function handleImageFileSelect(e: Event): void {
  const input = e.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file) return
  const reader = new FileReader()
  reader.onload = () => {
    const dataUrl = reader.result as string
    const label = `@${file.name}`
    contextChips.value = contextChips.value.filter((c) => c.label !== label)
    contextChips.value.push({ id: crypto.randomUUID(), label, imageData: dataUrl, content: '' })
    showToast(`Image "${file.name}" added to context`)
    nextTick(() => textareaEl.value?.focus())
  }
  reader.readAsDataURL(file)
  input.value = ''
}

// ── Attach File(s) ───────────────────────────────────────────────────────────
async function attachFile(): Promise<void> {
  type AgentApi = Record<string, (...a: unknown[]) => unknown>
  const api = (window as Window & { agentTeam?: AgentApi }).agentTeam
  if (!api) return

  // Prefer multi-file picker; fall back to single-file picker
  interface PickMultiResult { ok: boolean; paths?: string[]; canceled?: boolean }
  interface PickSingleResult { ok: boolean; path?: string; canceled?: boolean }

  let absPaths: string[] = []
  if (api.pickFiles) {
    const result = await (api.pickFiles as (a: Record<string, unknown>) => Promise<PickMultiResult>)({
      title: 'Attach Files to Chat',
      defaultPath: props.workspacePath ?? undefined,
    })
    if (!result.ok || !result.paths?.length) return
    absPaths = result.paths
  } else if (api.pickFile) {
    const result = await (api.pickFile as (a: Record<string, unknown>) => Promise<PickSingleResult>)({
      title: 'Attach File to Chat',
      defaultPath: props.workspacePath ?? undefined,
    })
    if (!result.ok || !result.path) return
    absPaths = [result.path]
  } else {
    return
  }

  for (const absPath of absPaths) {
    const wsRoot = props.workspacePath ? props.workspacePath.replace(/\/$/, '') : ''
    const isInsideWorkspace = wsRoot && (absPath === wsRoot || absPath.startsWith(wsRoot + '/'))
    const relPath = isInsideWorkspace
      ? absPath.slice(wsRoot.length).replace(/^\//, '')
      : absPath
    const ext = relPath.split('.').pop() ?? ''
    const fileName = relPath.split('/').pop() ?? relPath
    try {
      let fileContent = ''
      if (isInsideWorkspace) {
        interface ReadResp extends ReadPayload {}
        const r = await props.backend.send<ReadResp>('fs.read_file', {
          workspace_path: props.workspacePath,
          rel_path: relPath,
        })
        if (!r.payload?.ok) { showToast(`Could not read: ${fileName}`); continue }
        fileContent = r.payload?.content ?? ''
      } else {
        if (!api.readFileFrom) { showToast('Cannot read file outside workspace'); continue }
        interface RfResp { ok: boolean; content: string }
        const r = await (api.readFileFrom as (p: string, b: number) => Promise<RfResp>)(absPath, 0)
        if (!r.ok) { showToast(`Could not read: ${fileName}`); continue }
        fileContent = r.content
      }
      const MAX = 80_000
      const truncated = fileContent.length > MAX ? fileContent.slice(0, MAX) + '\n// … truncated' : fileContent
      const chipLabel = `@${fileName}`
      contextChips.value = contextChips.value.filter((c) => c.label !== chipLabel)
      contextChips.value.push({
        id: crypto.randomUUID(),
        label: chipLabel,
        content: `// File: ${relPath}\n\`\`\`${ext}\n${truncated}\n\`\`\``,
      })
    } catch {
      showToast(`Could not read: ${fileName}`)
    }
  }
  nextTick(() => textareaEl.value?.focus())
}

async function regenerate(): Promise<void> {
  if (sending.value) return
  // Find last user message index
  let lastUserIdx = -1
  for (let i = messages.value.length - 1; i >= 0; i--) {
    if (messages.value[i].role === 'user') { lastUserIdx = i; break }
  }
  if (lastUserIdx === -1) return
  // Keep only up to and including the last user message
  messages.value = messages.value.slice(0, lastUserIdx + 1)
  sending.value = true

  const sessionId = crypto.randomUUID()
  currentSessionId.value = sessionId

  const history = messages.value.map((m) => ({ role: m.role, content: m.rawContent ?? m.content }))
  messages.value.push({ role: 'assistant', content: '', streaming: true, thinking: true, cards: [], model: settingsModel.value, timestamp: Date.now(), sendMs: Date.now() })
  autoScroll.value = true
  await scrollBottom(true)

  try {
    await props.backend.send('ai.chat.start', {
      session_id: sessionId,
      messages: history,
      workspace_path: props.workspacePath,
    })
  } catch {
    const last = messages.value[messages.value.length - 1]
    if (last?.role === 'assistant') {
      last.streaming = false; last.thinking = false
      last.isError = true; last.errorMsg = 'Unable to connect to backend'
    }
    sending.value = false
    currentSessionId.value = null
  }
}

// ── Retry after error ──────────────────────────────────────────────────────────
function retryAfterError(): void {
  // Remove the error assistant message and regenerate
  const last = messages.value[messages.value.length - 1]
  if (last?.role === 'assistant' && last.isError) messages.value.pop()
  void regenerate()
}

const lastAssistantIdx = computed(() => {
  for (let i = messages.value.length - 1; i >= 0; i--) {
    if (messages.value[i].role === 'assistant') return i
  }
  return -1
})

// Active tool being executed during streaming (first pending tool_call card)
const activeToolCard = computed(() => {
  const idx = lastAssistantIdx.value
  if (idx === -1) return null
  const msg = messages.value[idx]
  if (!msg.streaming) return null
  for (let i = (msg.cards ?? []).length - 1; i >= 0; i--) {
    const c = msg.cards![i]
    if (c.kind === 'tool_call' && c.result == null) return c
  }
  return null
})

// Context-aware thinking label — matches what Cursor/VS Code show during streaming
const thinkingLabel = computed(() => {
  if (activeToolCard.value) {
    return getToolSummary(activeToolCard.value.tool_name, activeToolCard.value.tool_input)
  }
  if (chatMode.value === 'agent') return 'Agent thinking…'
  // Detect context from the last user message (chips are cleared on send)
  const lastUser = [...messages.value].reverse().find((m) => m.role === 'user')
  const userText = typeof lastUser?.rawContent === 'string' ? lastUser.rawContent : lastUser?.content ?? ''
  if (userText.includes('[Context: @codebase')) return 'Searching codebase…'
  if (userText.includes('[Context: @git')) return 'Reading git context…'
  if (userText.includes('[Context: @terminal')) return 'Reading terminal output…'
  // Multimodal: rawContent is an array with image blocks
  if (Array.isArray(lastUser?.rawContent) && (lastUser.rawContent as unknown[]).some((b) => (b as { type?: string }).type === 'image')) return 'Analyzing image…'
  if (userText.includes('[Context:')) return 'Processing context…'
  // Show model name to make it feel responsive
  const modelEntry = MODEL_CATALOG.find((m) => m.id === settingsModel.value)
  const modelShort = modelEntry?.display.replace(/^Claude /, '').replace(/ \d+\.\d+$/, '') ?? settingsModel.value
  return `${modelShort} thinking…`
})

// ── Diff expand/collapse ──────────────────────────────────────────────────────
const expandedDiffs = ref(new Set<string>())
function isDiffExpanded(toolId: string): boolean { return expandedDiffs.value.has(toolId) }
function toggleDiff(toolId: string): void {
  if (expandedDiffs.value.has(toolId)) expandedDiffs.value.delete(toolId)
  else expandedDiffs.value.add(toolId)
  expandedDiffs.value = new Set(expandedDiffs.value)
}

const pendingEditsInLastMsg = computed<EditProposalCard[]>(() => {
  const idx = lastAssistantIdx.value
  if (idx === -1) return []
  const msg = messages.value[idx]
  return (msg.cards ?? []).filter((c): c is EditProposalCard =>
    c.kind === 'edit_proposal' && !c.accepted && !c.discarded,
  )
})

// ── Accept edit ────────────────────────────────────────────────────────────────
async function acceptEdit(card: EditProposalCard): Promise<void> {
  try {
    await props.backend.send('ai.chat.accept_edit', {
      workspace_path: props.workspacePath,
      file_path: card.file_path,
      new_content: card.new_content,
    })
    card.accepted = true
    showToast(`Applied: ${card.file_path}`)
  } catch {
    showToast('Apply failed')
  }
}

function discardEdit(card: EditProposalCard): void {
  card.discarded = true
}

async function acceptAllEdits(): Promise<void> {
  for (const card of pendingEditsInLastMsg.value) {
    await acceptEdit(card)
  }
}

function discardAllEdits(): void {
  for (const card of pendingEditsInLastMsg.value) {
    card.discarded = true
  }
}

// ── Command proposal ──────────────────────────────────────────────────────────
async function approveCommand(card: CommandProposalCard): Promise<void> {
  card.status = 'approved'
  await props.backend.send('ai.chat.approve_command', {
    session_id: currentSessionId.value ?? '',
    tool_id: card.tool_id,
  }).catch(() => { card.status = 'pending' })
}

async function rejectCommand(card: CommandProposalCard): Promise<void> {
  card.status = 'rejected'
  await props.backend.send('ai.chat.reject_command', {
    session_id: currentSessionId.value ?? '',
    tool_id: card.tool_id,
  }).catch(() => { card.status = 'pending' })
}

// ── Global keyboard shortcuts ─────────────────────────────────────────────────
// Note: Cmd/Ctrl+L (focus chat input) is deliberately NOT handled here — the
// host window handles it (EditorWindowApp.onAppKeydown), which also opens the
// panel when it is closed. Handling it here too made the shortcut fire twice.
// All shifted comparisons use e.key.toLowerCase(): with Shift held, e.key is
// the UPPERCASE letter, so a lowercase strict compare never matches.
function _onGlobalKeydown(e: KeyboardEvent): void {
  // Ctrl+Shift+S — save checkpoint
  if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === 's') {
    e.preventDefault()
    if (messages.value.length > 0) saveCheckpoint()
    return
  }
  // Ctrl+Shift+N / Cmd+Shift+N — new chat thread (VS Code Copilot parity: Ctrl+Alt+N)
  if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === 'n') {
    e.preventDefault()
    newThread()
    return
  }
  // Ctrl+Shift+T / Cmd+Shift+T — toggle thread panel (VS Code: show chat history)
  if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === 't') {
    e.preventDefault()
    showThreads.value = !showThreads.value
    return
  }
  // Ctrl+R — open prompt history palette (shell-style reverse search)
  if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === 'r') {
    e.preventDefault()
    openHistoryPalette()
    return
  }
  // Ctrl+Shift+H / Cmd+Shift+H — open prompt history palette
  if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === 'h') {
    e.preventDefault()
    openHistoryPalette()
    return
  }
  // Ctrl+Shift+M / Cmd+Shift+M — copy thread as markdown
  if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === 'm') {
    e.preventDefault()
    copyThreadAsMarkdown()
    return
  }
  // Alt+[ / Alt+] — jump to previous / next AI response (Cursor-style message nav)
  if (e.altKey && !e.metaKey && !e.ctrlKey && !e.shiftKey && (e.key === '[' || e.key === ']')) {
    e.preventDefault()
    const aiMsgEls = Array.from(messagesEl.value?.querySelectorAll<HTMLElement>('.ai-msg-wrap.assistant') ?? [])
    if (!aiMsgEls.length) return
    const scrollTop = messagesEl.value?.scrollTop ?? 0
    const containerTop = messagesEl.value?.getBoundingClientRect().top ?? 0
    if (e.key === ']') {
      const next = aiMsgEls.find(el => el.getBoundingClientRect().top > containerTop + 8)
      if (next) next.scrollIntoView({ block: 'start', behavior: 'smooth' })
      else aiMsgEls[aiMsgEls.length - 1]?.scrollIntoView({ block: 'start', behavior: 'smooth' })
    } else {
      const prev = [...aiMsgEls].reverse().find(el => el.getBoundingClientRect().top < containerTop - 8)
      if (prev) prev.scrollIntoView({ block: 'start', behavior: 'smooth' })
      else aiMsgEls[0]?.scrollIntoView({ block: 'start', behavior: 'smooth' })
    }
    return
  }
  // Alt+E/R/N/C — code action on last-hovered code block (Cursor-style keyboard nav)
  if (e.altKey && !e.metaKey && !e.ctrlKey && !e.shiftKey && lastCodeWrap) {
    const actionMap: Record<string, string> = { e: 'explain', r: 'refactor', n: 'newchat', c: 'compare' }
    const action = actionMap[e.key.toLowerCase()]
    if (action) {
      const btn = lastCodeWrap.querySelector<HTMLButtonElement>(`[data-action="${action}"]`)
      if (btn) { btn.click(); e.preventDefault(); return }
    }
  }
  // Escape — close context menu or diff-apply modal
  if (e.key === 'Escape' && msgCtxMenu.value) { msgCtxMenu.value = null; return }
  if (e.key === 'Escape' && diffApplyState.value) {
    diffApplyState.value = null
    return
  }
  if (e.key === 'Escape' && compareResult.value) {
    compareResult.value = null; compareStage.value = null
    return
  }
  // Cmd+Enter / Ctrl+Enter — accept diff-apply modal (VS Code Copilot parity)
  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && diffApplyState.value) {
    e.preventDefault()
    confirmApply()
    return
  }
  // ArrowUp / ArrowDown — navigate thread list when thread panel is open
  if (showThreads.value && !e.metaKey && !e.ctrlKey && !e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
    const visible = filteredThreads.value
    if (!visible.length) return
    const curIdx = visible.findIndex((t) => t.id === currentThreadId.value)
    const nextIdx = e.key === 'ArrowUp'
      ? (curIdx <= 0 ? visible.length - 1 : curIdx - 1)
      : (curIdx >= visible.length - 1 ? 0 : curIdx + 1)
    const next = visible[nextIdx]
    if (next) { e.preventDefault(); switchThread(next.id) }
    return
  }
  // Alt+Up / Alt+Down — navigate between AI assistant messages (Cursor-style)
  if (e.altKey && !e.metaKey && !e.ctrlKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
    const els = [...(messagesEl.value?.querySelectorAll<HTMLElement>('.ai-msg.assistant') ?? [])]
    if (!els.length) return
    e.preventDefault()
    if (e.key === 'ArrowUp') {
      _navAssistIdx = _navAssistIdx <= 0 ? els.length - 1 : _navAssistIdx - 1
    } else {
      _navAssistIdx = _navAssistIdx >= els.length - 1 ? 0 : _navAssistIdx + 1
    }
    const target = els[_navAssistIdx]
    target.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
    target.setAttribute('data-nav-focus', 'true')
    window.setTimeout(() => target.removeAttribute('data-nav-focus'), 1000)
  }
}

// ── Backend event listeners ────────────────────────────────────────────────────
let unsubChunk: (() => void) | null = null
let lastCodeWrap: HTMLElement | null = null
function expandAllCodeBlocks(): void {
  messagesEl.value?.querySelectorAll<HTMLElement>('.ai-code-wrap[data-folded="true"]').forEach(wrap => {
    const pre = wrap.querySelector<HTMLElement>('pre.ai-code-block')
    const btn = wrap.querySelector<HTMLButtonElement>('.ai-code-fold-btn')
    if (pre && btn) { pre.style.display = ''; wrap.dataset.folded = 'false'; btn.textContent = `▼ Collapse (${btn.dataset.lines ?? '?'} lines)` }
  })
}
function collapseAllCodeBlocks(): void {
  messagesEl.value?.querySelectorAll<HTMLElement>('.ai-code-wrap:not([data-folded="true"]) .ai-code-fold-btn').forEach(btn => {
    const wrap = btn.closest<HTMLElement>('.ai-code-wrap')
    const pre = wrap?.querySelector<HTMLElement>('pre.ai-code-block')
    if (wrap && pre) { pre.style.display = 'none'; wrap.dataset.folded = 'true'; btn.textContent = `▶ Expand (${btn.dataset.lines ?? '?'} lines)` }
  })
}
function onMessagesMouseover(e: MouseEvent): void {
  const wrap = (e.target as HTMLElement).closest<HTMLElement>('.ai-code-wrap')
  if (wrap) lastCodeWrap = wrap
}

let unsubToolCall: (() => void) | null = null
let unsubToolResult: (() => void) | null = null
let unsubCommandProposal: (() => void) | null = null
let unsubDone: (() => void) | null = null
let unsubError: (() => void) | null = null

function setupListeners(): void {
  document.addEventListener('keydown', _onGlobalKeydown)
  if (placeholderInterval !== null) { clearInterval(placeholderInterval); placeholderInterval = null }
  placeholderInterval = window.setInterval(() => {
    if (!inputText.value) placeholderIdx.value = (placeholderIdx.value + 1) % PLACEHOLDER_HINTS_ASK.length
  }, 5000)
  unsubChunk = props.backend.on('ai.chat.chunk', (payload) => {
    const p = payload as { session_id: string; text: string }
    if (p.session_id !== currentSessionId.value) return
    const last = messages.value[messages.value.length - 1]
    if (last?.role === 'assistant' && last.streaming) {
      // Extended thinking sentinel — accumulate but don't show in main content
      if (p.text.startsWith('\x00THINKING:')) {
        last.thinkingContent = (last.thinkingContent ?? '') + p.text.slice(10)
        void scrollBottom()
        return
      }
      if (last.thinking) {
        const now = Date.now()
        last.responseStartMs = now
        if (last.sendMs) last.ttftMs = now - last.sendMs
      }
      last.thinking = false
      last.content += p.text
      void scrollBottom()
    }
  })

  unsubToolCall = props.backend.on('ai.chat.tool_call', (payload) => {
    const p = payload as { session_id: string; tool_name: string; tool_input: unknown; tool_id: string }
    if (p.session_id !== currentSessionId.value) return
    const last = messages.value[messages.value.length - 1]
    if (last?.role === 'assistant') {
      last.thinking = false
      if (!last.cards) last.cards = []
      last.cards.push({
        kind: 'tool_call',
        tool_id: p.tool_id,
        tool_name: p.tool_name,
        tool_input: p.tool_input,
        collapsed: false,
      })
      void scrollBottom()
    }
  })

  unsubToolResult = props.backend.on('ai.chat.tool_result', (payload) => {
    const p = payload as { session_id: string; tool_id: string; result: unknown }
    if (p.session_id !== currentSessionId.value) return
    const last = messages.value[messages.value.length - 1]
    if (!last?.cards) return
    for (const card of last.cards) {
      if (card.tool_id === p.tool_id) {
        if (card.kind === 'tool_call') {
          const resultStr = typeof p.result === 'string'
            ? p.result
            : JSON.stringify(p.result)
          // Check if this is an edit_file result (backend returns JSON string)
          let resultObj: Record<string, unknown> | null = null
          if (card.tool_name === 'edit_file') {
            try {
              const parsed = typeof p.result === 'string' ? JSON.parse(p.result) : p.result
              if (parsed && typeof parsed === 'object') resultObj = parsed as Record<string, unknown>
            } catch { /* not JSON, treat as plain result */ }
          }
          if (
            resultObj !== null &&
            typeof resultObj.file_path === 'string' &&
            typeof resultObj.new_content === 'string'
          ) {
            // Replace tool_call card with edit_proposal card
            const idx = last.cards.indexOf(card)
            // Prefer the real unified diff from the backend (difflib); fall back to synthetic
            const diffStr = typeof resultObj.diff === 'string' && resultObj.diff
              ? resultObj.diff
              : makeDiff(resultObj.file_path, resultObj.new_content)
            const editCard: EditProposalCard = {
              kind: 'edit_proposal',
              tool_id: p.tool_id,
              file_path: resultObj.file_path,
              new_content: resultObj.new_content,
              diff: diffStr,
              accepted: false,
              discarded: false,
            }
            last.cards.splice(idx, 1, editCard)
            // Auto-accept mode: apply edit immediately without user confirmation
            if (settingsAutoAccept.value) {
              void acceptEdit(editCard)
            }
          } else {
            card.result = resultStr.slice(0, 200) + (resultStr.length > 200 ? '…' : '')
            card.collapsed = true
          }
          void scrollBottom()
        }
        break
      }
    }
  })

  unsubDone = props.backend.on('ai.chat.done', (payload) => {
    const p = payload as { session_id: string; model?: string; input_tokens?: number; output_tokens?: number }
    if (p.session_id !== currentSessionId.value) return
    const last = messages.value[messages.value.length - 1]
    if (last?.streaming) {
      last.streaming = false; last.thinking = false
      if (last.responseStartMs) last.elapsedMs = Date.now() - last.responseStartMs
      if (p.model) last.model = p.model
      if (p.input_tokens != null) last.inputTokens = p.input_tokens
      if (p.output_tokens != null) last.outputTokens = p.output_tokens
      // Store follow-ups on the message itself (per-message, like VS Code Copilot)
      const lastUser = [...messages.value].reverse().find((m) => m.role === 'user')
      const generated = extractFollowUps(last.content, lastUser?.content ?? '')
      last.followUps = generated
      // Detect truncation: odd ``` count means the response ends in an open code block
      const backtickFences = (last.content.match(/```/g) ?? []).length
      if (backtickFences % 2 !== 0) last.truncated = true
      // Detect conventional commit message in response
      const commitMatch = last.content.match(/^(?:```\w*\n?)?((?:feat|fix|chore|docs|style|refactor|test|perf|build|ci|revert)(?:\([^)]+\))?!?: .+)(?:\n|$)/m)
      if (commitMatch) last.commitMsg = commitMatch[1].trim()
      // Edit mode: detect code blocks with inferred file paths for "Apply All" UX
      if (chatMode.value === 'edit') {
        const edits: Array<{ relPath: string; code: string }> = []
        const codeBlockRe = /```[\w]*\n((?:\/\/|#)\s*((?:\w[\w.-]*\/)+[\w.-]+\.\w+)[^\n]*\n[\s\S]*?)```/g
        let m: RegExpExecArray | null
        while ((m = codeBlockRe.exec(last.content)) !== null) {
          const pathMatch = m[1].match(/^(?:\/\/|#)\s*((?:\w[\w.-]*\/)+[\w.-]+\.\w+)/)
          if (pathMatch) edits.push({ relPath: pathMatch[1], code: m[1].trim() })
        }
        if (edits.length >= 2) last.pendingEdits = edits
      }
    }
    // Auto-generate thread title from first exchange
    const curThread = allThreads.value.find((t) => t.id === currentThreadId.value)
    if (curThread && curThread.title === 'New chat' && messages.value.length === 2) {
      const firstUser = messages.value[0]
      const firstAi = messages.value[1]
      if (firstUser?.role === 'user' && firstUser.content.trim()) {
        const raw = firstUser.content.replace(/@\S+/g, '').replace(/\[Context:[^\]]+\]/g, '').trim()
        const aiText = firstAi?.content ?? ''
        // Try to extract a meaningful title: prefer topic phrase over raw truncation
        let title = ''
        // 1. If the message is short enough, use it as-is
        if (raw.length <= 50) {
          title = raw
        } else {
          // 2. First sentence or clause
          const firstClause = raw.split(/[.!?\n]/)[0].trim()
          if (firstClause.length >= 8 && firstClause.length <= 50) {
            title = firstClause
          } else {
            // 3. Strip common filler words from start and truncate
            title = raw.replace(/^(can you|please|could you|help me|i need|i want)\s+/i, '').slice(0, 47)
            if (raw.length > 47) title += '…'
          }
        }
        // 4. Append a key file or function name from the AI response if short room remains
        if (title.length < 35) {
          const entityMatch = aiText.match(/`((?:[\w.-]+\/)*[\w.-]+\.(?:ts|tsx|js|vue|py|go|rs|md))`/)
          if (entityMatch) {
            const entity = entityMatch[1].split('/').pop() ?? ''
            if (entity && !title.toLowerCase().includes(entity.toLowerCase())) {
              title = `${title} (${entity})`
            }
          }
        }
        curThread.title = title.slice(0, 60) || 'New chat'
      }
    }
    sending.value = false
    currentSessionId.value = null
    if (streamTickInterval !== null) { clearInterval(streamTickInterval); streamTickInterval = null }
    // Auto-checkpoint every 20 messages (background, no toast)
    const msgCount = messages.value.filter((m) => !m.streaming).length
    if (msgCount > 0 && msgCount % 20 === 0) {
      const snap = messages.value.filter((m) => !m.streaming).map((m) => ({ ...m }))
      const label = `Auto (${msgCount} msgs)`
      const cp: ChatCheckpoint = { id: `cp-${Date.now()}`, name: label, timestamp: Date.now(), messagesSnapshot: snap }
      checkpoints.value = [cp, ...checkpoints.value].slice(0, 10)
      saveCurrentThread()
    }
    // /compact: after the summary arrives, replace the placeholder and splice in kept messages
    if (pendingCompactKeep.value.length > 0) {
      const kept = pendingCompactKeep.value
      pendingCompactKeep.value = []
      const summaryMsg = messages.value.find((m) => m.role === 'assistant' && !m.streaming)
      if (summaryMsg) {
        summaryMsg.content = `**[Compacted history summary]**\n\n${summaryMsg.content}`
      }
      const placeholder = messages.value.find((m) => m.content === '[Compacting history…]')
      if (placeholder) placeholder.content = '[History compacted]'
      messages.value.push(...kept)
      pendingCompactAllMessages.value = []
      saveCurrentThread()
      showToast(`History compacted — kept last ${kept.length} messages`)
    } else {
      pendingCompactAllMessages.value = []
    }
  })

  unsubError = props.backend.on('ai.chat.error', (payload) => {
    const p = payload as { session_id: string; message: string }
    if (p.session_id !== currentSessionId.value) return
    const last = messages.value[messages.value.length - 1]
    if (last?.role === 'assistant') {
      last.streaming = false
      last.thinking = false
      last.isError = true
      last.errorMsg = p.message
    }
    sending.value = false
    currentSessionId.value = null
    if (streamTickInterval !== null) { clearInterval(streamTickInterval); streamTickInterval = null }
    // If a compact operation was in progress, restore the full history snapshot
    if (pendingCompactAllMessages.value.length > 0) {
      messages.value = pendingCompactAllMessages.value
    }
    pendingCompactKeep.value = []
    pendingCompactAllMessages.value = []
    void scrollBottom()
  })

  unsubCommandProposal = props.backend.on('ai.chat.command_proposal', (payload) => {
    const p = payload as { session_id: string; tool_id: string; command: string; cwd: string }
    if (p.session_id !== currentSessionId.value) return
    const last = messages.value[messages.value.length - 1]
    if (last?.role === 'assistant') {
      if (!last.cards) last.cards = []
      // Replace the matching tool_call card (if present) with a command_proposal card
      const existingIdx = last.cards.findIndex((c) => c.tool_id === p.tool_id)
      const card: CommandProposalCard = {
        kind: 'command_proposal',
        tool_id: p.tool_id,
        command: p.command,
        cwd: p.cwd,
        status: 'pending',
      }
      if (existingIdx !== -1) last.cards.splice(existingIdx, 1, card)
      else last.cards.push(card)
      void scrollBottom()
    }
  })

}

function teardownListeners(): void {
  document.removeEventListener('keydown', _onGlobalKeydown)
  if (placeholderInterval !== null) { clearInterval(placeholderInterval); placeholderInterval = null }
  unsubChunk?.()
  unsubToolCall?.()
  unsubToolResult?.()
  unsubCommandProposal?.()
  unsubDone?.()
  unsubError?.()
}

const workspaceRulesFile = ref<string | null>(null)
const workspaceRulesContent = ref<string>('')
const workspaceGlobRules = ref<Array<{ globs: string; body: string }>>([])

function parseMdcFrontmatter(raw: string): { alwaysApply?: boolean; globs?: string; description?: string; body: string } {
  if (!raw.startsWith('---')) return { body: raw }
  const end = raw.indexOf('---', 3)
  if (end === -1) return { body: raw }
  const fm = raw.slice(3, end).trim()
  const body = raw.slice(end + 3).trim()
  const alwaysApply = /alwaysApply\s*:\s*true/i.test(fm)
  const globsMatch = fm.match(/globs\s*:\s*["']?([^"'\n]+)["']?/)
  const descMatch = fm.match(/description\s*:\s*(.+)/)
  return {
    alwaysApply,
    globs: globsMatch?.[1]?.trim(),
    description: descMatch?.[1]?.trim(),
    body,
  }
}

function globToRegex(glob: string): RegExp {
  const esc = glob.trim()
    .replace(/\./g, '\\.')
    .replace(/\*\*/g, '')
    .replace(/\*/g, '[^/]*')
    .replace(//g, '.*')
    .replace(/\?/g, '[^/]')
  return new RegExp(`(^|/)${esc}$`, 'i')
}

async function createWorkspaceRulesFile(): Promise<void> {
  if (!props.workspacePath) return
  const template = `# AI Rules for this project

## Coding style
- Use descriptive variable names
- Write self-documenting code; add comments only for non-obvious logic

## Stack
- <!-- Describe your tech stack, e.g.: TypeScript, Vue 3, Python, FastAPI -->

## Preferences
- Prefer minimal changes when fixing bugs
- Always explain the "why" when proposing a refactor
`
  try {
    interface WriteResp { ok: boolean; error?: string }
    const resp = await props.backend.send<WriteResp>('fs.write_file', {
      workspace_path: props.workspacePath,
      rel_path: 'AGENTS.md',
      content: template,
    })
    if (resp.payload?.ok !== false) {
      showToast('Created AGENTS.md — edit it to add project rules')
      props.openFile?.('AGENTS.md')
      await detectWorkspaceRules()
    } else {
      showToast('Failed to create AGENTS.md: ' + (resp.payload?.error ?? 'unknown error'))
    }
  } catch (e) {
    showToast('Failed to create AGENTS.md: ' + String(e))
  }
}

async function detectWorkspaceRules(): Promise<void> {
  interface ReadResp extends ReadPayload {}
  interface ListResp { ok: boolean; entries?: Array<{ name: string; is_dir: boolean }> }

  workspaceGlobRules.value = []

  // 1. Try .cursor/rules/ directory (MDC format — Cursor 2025 standard)
  try {
    const listResp = await props.backend.send<ListResp>('fs.list_dir', {
      workspace_path: props.workspacePath,
      rel_path: '.cursor/rules',
    })
    const entries = listResp.payload?.entries ?? []
    const mdcFiles = entries.filter((e) => !e.is_dir && e.name.endsWith('.mdc'))
    if (mdcFiles.length > 0) {
      const parts: string[] = []
      for (const entry of mdcFiles) {
        try {
          const r = await props.backend.send<ReadResp>('fs.read_file', {
            workspace_path: props.workspacePath,
            rel_path: `.cursor/rules/${entry.name}`,
          })
          if (r.payload?.ok && r.payload.content) {
            const parsed = parseMdcFrontmatter(r.payload.content)
            if (parsed.alwaysApply || !r.payload.content.startsWith('---')) {
              parts.push(parsed.body || r.payload.content)
            } else if (parsed.globs && parsed.body) {
              // Glob-based rule — injected only when matching files are in context
              workspaceGlobRules.value.push({ globs: parsed.globs, body: parsed.body })
            }
          }
        } catch { /* skip unreadable file */ }
      }
      if (parts.length > 0 || workspaceGlobRules.value.length > 0) {
        const alwaysCount = parts.length
        const globCount = workspaceGlobRules.value.length
        const label = [
          alwaysCount ? `${alwaysCount} always` : '',
          globCount ? `${globCount} glob` : '',
        ].filter(Boolean).join(', ')
        workspaceRulesFile.value = `.cursor/rules/ (${label})`
        workspaceRulesContent.value = parts.join('\n\n---\n\n')
        return
      }
    }
  } catch { /* directory not found */ }

  // 2. Fall back to single-file rules
  const RULE_FILES = [
    '.cursor/rules.md', '.cursorrules', 'AGENTS.md',
    '.ai/rules.md', '.ai/instructions.md', '.github/copilot-instructions.md',
  ]
  for (const rf of RULE_FILES) {
    try {
      const resp = await props.backend.send<ReadResp>('fs.read_file', {
        workspace_path: props.workspacePath,
        rel_path: rf,
      })
      if (resp.payload?.ok && resp.payload.content) {
        workspaceRulesFile.value = rf
        workspaceRulesContent.value = resp.payload.content
        return
      }
    } catch { /* file not found */ }
  }
  workspaceRulesFile.value = null
  workspaceRulesContent.value = ''
}

// Mermaid: strict security level strips script/foreignObject from the output SVG
mermaid.initialize({ startOnLoad: false, theme: 'dark', securityLevel: 'strict', fontFamily: 'inherit' })

// Allowed SVG elements and attributes (conservative whitelist to prevent XSS)
const _SVG_ALLOWED_TAGS = new Set([
  'svg','g','path','rect','circle','ellipse','line','polyline','polygon','text',
  'tspan','defs','marker','use','title','desc','style','linearGradient',
  'radialGradient','stop','clipPath','mask','foreignObject',
])
// Only http(s), relative paths, and anchor fragments are safe URL values
const _SAFE_URL = /^(https?:\/\/|\/|\.\.?\/|#)/i

function _sanitizeSvgNode(node: Element): void {
  for (const attr of Array.from(node.attributes)) {
    const name = attr.name.toLowerCase()
    // Strip all event handlers
    if (/^on/.test(name)) { node.removeAttribute(attr.name); continue }
    // Strip href / xlink:href unless value is a safe URL
    if ((name === 'href' || name === 'xlink:href') && !_SAFE_URL.test(attr.value.trim())) {
      node.removeAttribute(attr.name)
    }
  }
  // Recurse but strip non-whitelisted tags
  for (const child of Array.from(node.children)) {
    if (!_SVG_ALLOWED_TAGS.has(child.tagName.toLowerCase())) {
      child.remove()
    } else {
      _sanitizeSvgNode(child)
    }
  }
}

async function renderMermaidBlocks(): Promise<void> {
  const els = messagesEl.value?.querySelectorAll<HTMLElement>('.ai-mermaid[data-graph]:not([data-rendered])')
  if (!els?.length) return
  await Promise.all(Array.from(els).map(async (el) => {
    el.setAttribute('data-rendered', '1') // prevent double-render even on error
    try {
      const code = decodeURIComponent(el.dataset.graph ?? '')
      const id = `mermaid-${Math.random().toString(36).slice(2, 9)}`
      const { svg } = await mermaid.render(id, code)
      // Parse SVG safely via DOMParser (no innerHTML on the visible element)
      const doc = new DOMParser().parseFromString(svg, 'image/svg+xml')
      const svgEl = doc.querySelector('svg')
      if (svgEl) {
        _sanitizeSvgNode(svgEl)
        el.replaceChildren(svgEl)
      }
    } catch (err) {
      const errSpan = document.createElement('span')
      errSpan.className = 'ai-mermaid-err'
      errSpan.textContent = `Diagram error: ${String(err)}`
      el.replaceChildren(errSpan)
    }
  }))
}

function relativeTime(ts: number): string {
  const diff = nowMinute.value - ts
  if (diff < 60_000) return 'just now'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`
  return new Date(ts).toLocaleDateString([], { month: 'short', day: 'numeric' })
}

onMounted(() => {
  setupListeners()
  void migrateLegacyKeyMirrors().then(fetchSettings)
  void loadThreads()
  void detectWorkspaceRules()
  // Render any mermaid diagrams that were persisted in thread history
  void nextTick(renderMermaidBlocks)
  _nowMinuteInterval = window.setInterval(() => { nowMinute.value = Date.now() }, 30_000)
})
watch(() => props.workspacePath, () => { void detectWorkspaceRules() })
watch(() => props.backend.status.value, (s) => {
  if ((s === 'disconnected' || s === 'error') && sending.value) stopStreaming()
  if (s === 'connected') {
    // Late hydration after a mount-time backend outage — only when nothing
    // local would be clobbered by the reload.
    if (!threadsHydrated && messages.value.length === 0) void loadThreads()
    if (!notesHydrated && !notesContent.value && namedNotepads.value.length === 0) void loadNotes()
  }
})

onUnmounted(() => {
  teardownListeners()
  if (_nowMinuteInterval !== null) { clearInterval(_nowMinuteInterval); _nowMinuteInterval = null }
  if (streamTickInterval !== null) { clearInterval(streamTickInterval); streamTickInterval = null }
  if (toastTimer !== null) clearTimeout(toastTimer)
  if (saveTimer !== null) clearTimeout(saveTimer)
  if (_speechRecognition) { _speechRecognition.stop(); _speechRecognition = null }
  if (speakingMsgIdx.value !== null) { window.speechSynthesis?.cancel(); speakingMsgIdx.value = null }
  lastCodeWrap = null
})

// ── @context system ────────────────────────────────────────────────────────────
function _autoResizeTextarea(el: HTMLTextAreaElement): void {
  el.style.height = 'auto'
  el.style.height = Math.min(el.scrollHeight, 200) + 'px'
}
function onTextareaInput(e: Event): void {
  const el = e.target as HTMLTextAreaElement
  _autoResizeTextarea(el)
  const val = el.value
  const cur = el.selectionStart ?? val.length
  const beforeCursor = val.slice(0, cur)

  // ── Slash command menu (/command at start of input) ───────────────────────
  if (val.startsWith('/') && !val.includes(' ')) {
    showAtMenu.value = false
    const fragment = val.slice(1).toLowerCase()
    slashMenuFilter.value = fragment
    slashMenuIdx.value = 0
    // Merge saved prompt templates as custom slash commands (prefix /)
    const templateCmds: SlashCommand[] = displayedTemplates.value.map((t) => ({
      id: `/${t.name.toLowerCase().replace(/\s+/g, '-')}`,
      label: `/${t.name.toLowerCase().replace(/\s+/g, '-')}`,
      description: `My template: ${t.name}`,
      template: t.text,
    }))
    const allCmds = [...SLASH_COMMANDS, ...templateCmds]
    const filtered = allCmds.filter(
      (c) => c.id.slice(1).includes(fragment) || (c.description ?? '').toLowerCase().includes(fragment),
    )
    // Promote recently used commands to the top when there is no filter fragment
    if (!fragment && recentCmds.value.length > 0) {
      const recent = recentCmds.value
        .map((id) => allCmds.find((c) => c.id === id))
        .filter((c): c is SlashCommand => c !== undefined)
      const recentIds = new Set(recent.map((c) => c.id))
      slashOptions.value = [...recent, ...filtered.filter((c) => !recentIds.has(c.id))]
    } else {
      slashOptions.value = filtered
    }
    showSlashMenu.value = slashOptions.value.length > 0
    return
  }
  showSlashMenu.value = false

  // ── @ context menu ────────────────────────────────────────────────────────
  const atIdx = beforeCursor.lastIndexOf('@')
  if (atIdx === -1) { showAtMenu.value = false; return }

  const fragment = beforeCursor.slice(atIdx + 1)
  // Allow spaces inside @codebase <query> and @web:<query>
  const isCodebaseQuery = /^codebase\s+\S/i.test(fragment)
  const isFolderPath = /^folder:/i.test(fragment)
  const isWebQuery = /^web:/i.test(fragment)
  if (fragment.includes(' ') && !isCodebaseQuery && !isWebQuery) { showAtMenu.value = false; return }

  atMenuFilter.value = fragment
  atMenuIdx.value = 0
  showAtMenu.value = true

  if (isCodebaseQuery) {
    const cbQuery = fragment.slice(fragment.indexOf(' ') + 1).trim()
    atOptions.value = [{ id: `@codebase:${cbQuery}`, label: `@codebase search: "${cbQuery}"` }]
    return
  }

  if (isFolderPath) {
    const folderPath = fragment.slice('folder:'.length).trim()
    atOptions.value = [{ id: `@folder:${folderPath}`, label: `@folder: "${folderPath}" (add all files)` }]
    return
  }

  const isUrlFragment = /^url:https?:\/\//i.test(fragment)
  if (isUrlFragment) {
    const urlVal = fragment.slice('url:'.length).trim()
    atOptions.value = [{ id: `@url:${urlVal}`, label: `@url: fetch "${urlVal.slice(0, 60)}"` }]
    return
  }

  // @web:<query> — real-time web search (isWebQuery already set above)
  if (isWebQuery) {
    const webQ = fragment.slice('web:'.length).trim()
    if (webQ.length >= 1) {
      atOptions.value = [{ id: `@web:${webQ}`, label: `@web: search "${webQ}"` }]
    } else {
      atOptions.value = [{ id: '@web', label: '@web — type a search query' }]
    }
    return
  }

  // @docs:<name> — fetch official documentation
  const isDocsQuery = /^docs:/i.test(fragment)
  if (isDocsQuery) {
    const docName = fragment.slice('docs:'.length).trim().toLowerCase()
    const matched = Object.entries(allDocsCatalog.value)
      .filter(([k]) => k.startsWith(docName) || allDocsCatalog.value[k].label.toLowerCase().includes(docName))
      .map(([k, v]) => ({ id: `@docs:${k}`, label: `@docs:${k} — ${v.label}` }))
    atOptions.value = matched.length ? matched : [{ id: '@docs', label: '@docs — type a doc name (vue, react, ts, python…)' }]
    return
  }
  if (/^docs$/i.test(fragment)) {
    atOptions.value = Object.entries(allDocsCatalog.value).map(([k, v]) => ({ id: `@docs:${k}`, label: `@docs:${k} — ${v.label}` }))
    return
  }

  // @git:log:N / @git:log:verbose — show last N commits (custom count or verbose format)
  if (/^git:log$/i.test(fragment)) {
    atOptions.value = [
      { id: '@git:log',         label: '@git:log — last 20 commits (oneline)' },
      { id: '@git:log:5',       label: '@git:log:5 — last 5 commits' },
      { id: '@git:log:10',      label: '@git:log:10 — last 10 commits' },
      { id: '@git:log:50',      label: '@git:log:50 — last 50 commits' },
      { id: '@git:log:verbose', label: '@git:log:verbose — last 10 commits with author & date' },
    ]
    return
  }
  if (/^git:log:\d+$/i.test(fragment)) {
    const n = fragment.slice('git:log:'.length)
    atOptions.value = [{ id: `@git:log:${n}`, label: `@git:log:${n} — last ${n} commits` }]
    return
  }
  if (/^git:log:verbose$/i.test(fragment)) {
    atOptions.value = [{ id: '@git:log:verbose', label: '@git:log:verbose — last 10 commits with author, date & body' }]
    return
  }

  // @git:stash — list all git stashes
  if (/^git:stash$/i.test(fragment)) {
    atOptions.value = [{ id: '@git:stash', label: '@git:stash — list all stash entries' }]
    return
  }

  // @git:tag — list recent tags
  if (/^git:tag$/i.test(fragment)) {
    atOptions.value = [{ id: '@git:tag', label: '@git:tag — recent git tags' }]
    return
  }

  // @git:contributors — top contributors
  if (/^git:contributors?$/i.test(fragment)) {
    atOptions.value = [{ id: '@git:contributors', label: '@git:contributors — top contributors (git shortlog)' }]
    return
  }

  // @git:modified — list uncommitted changed files
  if (/^git:modified$/i.test(fragment)) {
    atOptions.value = [{ id: '@git:modified', label: '@git:modified — all uncommitted changed files' }]
    return
  }

  // @git:diff:<branch> — compare current HEAD vs a specific branch
  if (/^git:diff$/i.test(fragment)) {
    atOptions.value = [
      { id: '@git:diff:main',        label: '@git:diff:main — diff vs main' },
      { id: '@git:diff:master',      label: '@git:diff:master — diff vs master' },
      { id: '@git:diff:origin/main', label: '@git:diff:origin/main — diff vs origin/main' },
    ]
    return
  }
  const isGitDiffQuery = /^git:diff:/i.test(fragment)
  if (isGitDiffQuery) {
    const branchName = fragment.slice('git:diff:'.length)
    atOptions.value = branchName.length >= 1
      ? [{ id: `@git:diff:${branchName}`, label: `@git:diff:${branchName} — diff vs ${branchName}` }]
      : [
          { id: '@git:diff:main',        label: '@git:diff:main — diff vs main' },
          { id: '@git:diff:master',      label: '@git:diff:master — diff vs master' },
          { id: '@git:diff:origin/main', label: '@git:diff:origin/main — diff vs origin/main' },
        ]
    return
  }

  // @git:commit:<hash> — show a specific commit's diff
  if (/^git:commit$/i.test(fragment)) {
    atOptions.value = [{ id: '@git:commit', label: '@git:commit — type a commit hash (e.g. @git:commit:abc1234)' }]
    return
  }
  const isGitCommitQuery = /^git:commit:/i.test(fragment)
  if (isGitCommitQuery) {
    const hashFrag = fragment.slice('git:commit:'.length)
    atOptions.value = hashFrag.length >= 1
      ? [{ id: `@git:commit:${hashFrag}`, label: `@git:commit:${hashFrag} — show this commit` }]
      : [{ id: '@git:commit', label: '@git:commit — type a commit hash' }]
    return
  }

  // @usages:<symbol> — find all call sites / references of a symbol across the codebase
  if (/^usages$/i.test(fragment)) {
    atOptions.value = [{ id: '@usages', label: '@usages — type a symbol name after the colon' }]
    return
  }
  const isUsagesQuery = /^usages:/i.test(fragment)
  if (isUsagesQuery) {
    const symbolName = fragment.slice('usages:'.length).trim()
    if (symbolName.length >= 1) {
      atOptions.value = [{ id: `@usages:${symbolName}`, label: `@usages:${symbolName} — find all usages of "${symbolName}"` }]
    } else {
      atOptions.value = [{ id: '@usages', label: '@usages — type a symbol name (e.g. @usages:MyFunction)' }]
    }
    return
  }

  // @symbol:functionName — find a symbol definition across the codebase
  const isSymbolQuery = /^symbol:/i.test(fragment)
  if (isSymbolQuery) {
    const symbolName = fragment.slice('symbol:'.length).trim()
    if (symbolName.length >= 1) {
      atOptions.value = [{ id: `@symbol:${symbolName}`, label: `@symbol: search for "${symbolName}"` }]
    } else {
      atOptions.value = [{ id: '@symbol', label: '@symbol — type a function or class name' }]
    }
    return
  }

  // @model:id — temporarily switch model for next message
  if (/^model:?$/i.test(fragment)) {
    const topModels = MODEL_CATALOG.filter((m) => m.id !== 'auto' && m.provider !== 'ollama').slice(0, 6)
    atOptions.value = topModels.map((m) => ({ id: `@model:${m.id}`, label: `@model:${m.id} — ${m.display} (${m.note})` }))
    return
  }
  const isModelQuery = /^model:.+/i.test(fragment)
  if (isModelQuery) {
    const modelFrag = fragment.slice('model:'.length).toLowerCase()
    const matched = MODEL_CATALOG.filter(
      (m) => m.id.toLowerCase().includes(modelFrag) || m.display.toLowerCase().includes(modelFrag)
    ).slice(0, 6)
    atOptions.value = matched.length
      ? matched.map((m) => ({ id: `@model:${m.id}`, label: `@model:${m.id} — ${m.display}` }))
      : [{ id: `@model:${fragment.slice('model:'.length)}`, label: `@model:${fragment.slice('model:'.length)} — use this model` }]
    return
  }

  // @glob:pattern — match files by glob pattern (e.g. @glob:src/**/*.ts)
  // @notepad:name — reference a specific named notepad
  if (/^notepad:?$/i.test(fragment)) {
    const opts = namedNotepads.value.length
      ? namedNotepads.value.map((n) => ({ id: `@notepad:${n.name}`, label: `@notepad:${n.name}` }))
      : [{ id: '@notepad', label: '@notepad — workspace notes (open panel to create named notepads)' }]
    atOptions.value = opts
    return
  }
  const isNotepadQuery = /^notepad:.+/i.test(fragment)
  if (isNotepadQuery) {
    const notepadName = fragment.slice('notepad:'.length).toLowerCase()
    const matched = namedNotepads.value.filter((n) => n.name.toLowerCase().includes(notepadName))
    atOptions.value = matched.length
      ? matched.map((n) => ({ id: `@notepad:${n.name}`, label: `@notepad:${n.name}` }))
      : [{ id: `@notepad:${fragment.slice('notepad:'.length)}`, label: `@notepad:${fragment.slice('notepad:'.length)} (new notepad)` }]
    return
  }

  if (/^glob:?$/i.test(fragment)) {
    atOptions.value = [{ id: '@glob:', label: '@glob:pattern — add files matching glob (e.g. @glob:src/**/*.ts)' }]
    return
  }
  const isGlobQuery = /^glob:.+/i.test(fragment)
  if (isGlobQuery) {
    const globPattern = fragment.slice('glob:'.length)
    atOptions.value = [{ id: `@glob:${globPattern}`, label: `@glob:${globPattern} — add matching files` }]
    return
  }

  // @diff:file — e.g., @diff:src/App.vue
  if (/^diff:?$/i.test(fragment)) {
    atOptions.value = [{ id: '@diff:', label: '@diff:path — git diff of a specific file' }]
    return
  }
  if (/^diff:.+/i.test(fragment)) {
    const filePath = fragment.slice('diff:'.length)
    atOptions.value = [{ id: `@diff:${filePath}`, label: `@diff:${filePath} — git diff for this file` }]
    return
  }

  // @file:lineRange — e.g., @App.vue:10-50 or @src/foo.ts:25
  const lineRangeMatch = /^(.+):(\d+)(?:-(\d+))?$/.exec(fragment)
  if (lineRangeMatch) {
    const filePath = lineRangeMatch[1]
    const lineSpec = lineRangeMatch[3] ? `${lineRangeMatch[2]}-${lineRangeMatch[3]}` : lineRangeMatch[2]
    const fileName = filePath.split('/').pop() ?? filePath
    atOptions.value = [{ id: `${filePath}:${lineSpec}`, label: `@${fileName}:${lineSpec} — lines ${lineSpec}` }]
    return
  }

  const lower = fragment.toLowerCase()
  const filtered: AtOption[] = AT_OPTIONS_STATIC.filter(
    (o) => o.label.toLowerCase().includes(lower) || o.id.toLowerCase().includes(lower),
  )
  for (const item of atDirItems.value) {
    if (item.label.toLowerCase().includes(lower)) filtered.push(item)
  }
  // Prepend recent files when no query (or just '@')
  if (!lower || lower === '@') {
    const recent: AtOption[] = recentAtFiles.value
      .filter((f) => !filtered.some((d) => d.id === f))
      .map((f) => ({ id: f, label: `@${f.split('/').pop()} · recent` }))
      .slice(0, 5)
    atOptions.value = [...filtered, ...recent]
  } else {
    if (filtered.length) {
      const rOrder = new Map(recentAtIds.value.map((id, i): [string, number] => [id, i]))
      filtered.sort((a, b) => (rOrder.get(a.id) ?? 999) - (rOrder.get(b.id) ?? 999))
      atOptions.value = filtered
    } else {
      atOptions.value = AT_OPTIONS_STATIC
    }
  }

  if (fragment.length >= 1 && !fragment.startsWith('@')) {
    debouncedSearchFiles(fragment)
  }
}

function triggerCompact(): void {
  const cmd = SLASH_COMMANDS.find((c) => c.id === '/compact')
  if (cmd) selectSlashCommand(cmd)
}

async function selectSlashCommand(cmd: SlashCommand): Promise<void> {
  showSlashMenu.value = false
  trackRecentCmd(cmd.id)
  const extra = cmd.id.replace(/^\/\S+/, '').trim()
  // Bridge: commands that have rawText handlers in sendMessage but need selectSlashCommand routing
  if (cmd.id === '/help') {
    inputText.value = '/help'
    void sendMessage()
    return
  }
  if (cmd.id === '/checkpoint') {
    saveCheckpoint()
    return
  }
  if (cmd.id === '/checkpoints') {
    showCheckpoints.value = true
    return
  }
  if (cmd.id === '/open') {
    inputText.value = '/open '
    showToast('Type a filename or pattern after /open')
    nextTick(() => { textareaEl.value?.focus(); const l = inputText.value.length; textareaEl.value?.setSelectionRange(l, l) })
    return
  }

  if (cmd.id === '/run') {
    // Let user type the command after /run
    inputText.value = '/run '
    nextTick(() => { textareaEl.value?.focus() })
    return
  }
  if (cmd.id === '/summarize') {
    if (messages.value.length < 2) { showToast('Nothing to summarize yet'); return }
    const count = messages.value.length
    inputText.value = `Summarize our conversation so far (${count} messages) into 3-5 bullet points covering the main topics, decisions, and any code changes made. Be concise.`
    void sendMessage()
    return
  }
  if (cmd.id === '/compact') {
    // Keep only the last 4 messages; replace the rest with an AI summary
    const all = messages.value.filter((m) => !m.streaming)
    if (all.length < 6) { showToast('Not enough history to compact (need 6+ messages)'); return }
    inputText.value = ''
    const keepLast = 4
    const toCompress = all.slice(0, all.length - keepLast)
    const keepMessages = all.slice(all.length - keepLast)
    const historyText = toCompress.map((m) => `${m.role}: ${m.content.slice(0, 500)}`).join('\n---\n')
    const summaryPrompt = `Create a dense technical context summary of the following conversation history. Focus on: decisions made, code changes, file names, key findings. Be concise (max 300 words).\n\n${historyText}`
    // Push a placeholder and start compact operation; keep full snapshot for abort
    pendingCompactAllMessages.value = all
    messages.value = [
      { role: 'user', content: '[Compacting history…]', timestamp: Date.now() },
      { role: 'assistant', content: '', streaming: true, thinking: true, cards: [], timestamp: Date.now() },
    ]
    sending.value = true
    const sessionId = crypto.randomUUID()
    currentSessionId.value = sessionId
    try {
      await props.backend.send('ai.chat.start', {
        session_id: sessionId,
        messages: [{ role: 'user', content: summaryPrompt }],
        workspace_path: props.workspacePath,
      })
    } catch {
      messages.value = all
      pendingCompactKeep.value = []
      pendingCompactAllMessages.value = []
      sending.value = false
      showToast('Compact failed')
      return
    }
    // After streaming completes the AI message will have the summary.
    // We'll splice in the kept messages via a watcher on the done event below.
    // Store kept messages for the compaction done handler.
    pendingCompactKeep.value = keepMessages
    return
  }
  if (cmd.id === '/clear') {
    inputText.value = ''
    clearConversation()
    return
  }
  if (cmd.id === '/export') {
    const existing = inputText.value.slice('/export'.length).trim().toLowerCase()
    if (existing === 'json') { inputText.value = ''; void exportConversation('json'); return }
    if (existing === 'html') { inputText.value = ''; void exportConversation('html'); return }
    // Default to markdown (or if user typed '/export markdown')
    if (existing === '' || existing === 'markdown' || existing === 'md') { inputText.value = ''; void exportConversation('markdown'); return }
    // Unknown arg — hint and wait
    inputText.value = '/export '
    showToast('Type: /export markdown  /export json  or  /export html')
    nextTick(() => { textareaEl.value?.focus(); const l = inputText.value.length; textareaEl.value?.setSelectionRange(l, l) })
    return
  }
  // /commit: auto-add @git chip so AI sees the staged diff (falls back to unstaged)
  if (cmd.id === '/commit') {
    inputText.value = cmd.template
    void (async () => {
      try {
        interface DiffResp { ok: boolean; diff?: string }
        // Prefer staged diff (what git commit will actually include); fall back to unstaged
        let resp = await props.backend.send<DiffResp>('git.diff_all', {
          workspace_path: props.workspacePath,
          staged: true,
        })
        let diff = resp.payload?.diff
        let label = '@git(staged)'
        let header = '// git diff --staged'
        if (!diff) {
          resp = await props.backend.send<DiffResp>('git.diff_all', {
            workspace_path: props.workspacePath,
            staged: false,
          })
          diff = resp.payload?.diff
          label = '@git(diff)'
          header = '// git diff (unstaged)'
        }
        if (diff) {
          contextChips.value.push({
            id: crypto.randomUUID(),
            label,
            content: `${header}\n${diff}`,
          })
        }
      } catch {/* ignore */}
      await nextTick()
      textareaEl.value?.focus()
    })()
    return
  }
  // /diff: auto-add @git chip and set prompt
  if (cmd.id === '/diff') {
    inputText.value = 'Explain these changes and their potential impact on the codebase:'
    void (async () => {
      try {
        interface DiffResp { ok: boolean; diff?: string }
        let resp = await props.backend.send<DiffResp>('git.diff_all', {
          workspace_path: props.workspacePath,
          staged: true,
        })
        let diff = resp.payload?.diff
        let label = '@git(staged)'
        let header = '// git diff --staged'
        if (!diff) {
          resp = await props.backend.send<DiffResp>('git.diff_all', {
            workspace_path: props.workspacePath,
            staged: false,
          })
          diff = resp.payload?.diff
          label = '@git(diff)'
          header = '// git diff (unstaged)'
        }
        if (!diff) {
          showToast('No changes found'); return
        }
        contextChips.value.push({ id: crypto.randomUUID(), label, content: `${header}\n${diff}` })
      } catch { showToast('/diff: git unavailable') }
      await nextTick()
      textareaEl.value?.focus()
    })()
    return
  }

  if (cmd.id === '/model') {
    inputText.value = ''
    showModelPicker.value = true
    nextTick(() => textareaEl.value?.focus())
    return
  }

  if (cmd.id === '/rename') {
    const ct = allThreads.value.find((t) => t.id === currentThreadId.value)
    if (!ct) { showToast('No active thread'); return }
    const firstUser = messages.value.find((m) => m.role === 'user')
    const suggested = firstUser
      ? firstUser.content.replace(/@\S+/g, '').replace(/\s+/g, ' ').trim().slice(0, 60)
      : ct.title
    inputText.value = `/rename ${suggested}`
    nextTick(() => { textareaEl.value?.focus(); textareaEl.value?.select() })
    return
  }

  if (cmd.id === '/pin') {
    inputText.value = ''
    const ct = allThreads.value.find((t) => t.id === currentThreadId.value)
    if (ct) { ct.pinned = !ct.pinned; saveCurrentThread(); showToast(ct.pinned ? 'Thread pinned' : 'Thread unpinned') }
    return
  }

  if (cmd.id === '/continue') {
    inputText.value = '/continue'
    void sendMessage()
    return
  }

  if (cmd.id === '/test') {
    inputText.value = '/test'
    void sendMessage()
    return
  }

  if (cmd.id === '/fixtests') {
    inputText.value = '/fixtests'
    void sendMessage()
    return
  }

  if (cmd.id === '/generate') {
    inputText.value = 'Generate a new file: '
    await nextTick(); textareaEl.value?.focus()
    return
  }

  if (cmd.id === '/search') {
    // If user is in raw-text flow (typed "/search query" directly), extract query
    const existing = inputText.value.startsWith('/search') ? inputText.value.slice('/search'.length).trim() : ''
    if (existing) {
      // Do a real codebase search and inject results as a chip
      const query = existing
      inputText.value = ''
      if (!props.workspacePath) { showToast('/search requires an open workspace'); return }
      showToast(`Searching for "${query}"…`)
      try {
        interface SearchMatch { line: number; col: number; text: string }
        interface SearchResp { ok: boolean; error?: string; results?: Array<{ rel_path: string; matches: SearchMatch[] }> }
        const resp = await props.backend.send<SearchResp>('search.find_in_files', {
          workspace_path: props.workspacePath,
          query,
          is_regex: false,
          case_sensitive: false,
          max_results: 30,
        })
        const results = resp.payload?.results ?? []
        if (!results.length) { showToast(`/search: no matches for "${query}"`); return }
        const lines = [`// /search "${query}" — ${results.length} file${results.length === 1 ? '' : 's'}`]
        for (const r of results.slice(0, 8)) {
          lines.push(`
// ${r.rel_path}`)
          r.matches.slice(0, 3).forEach((m) => lines.push(`  ${m.line}: ${m.text.trim()}`))
        }
        contextChips.value.push({ id: crypto.randomUUID(), label: `@search:${query.slice(0, 20)}`, content: lines.join('\n') })
        inputText.value = `Explain the usages of "${query}" shown in @search results above.`
      } catch { showToast('/search: unavailable') }
      nextTick(() => { textareaEl.value?.focus() })
      return
    }
    inputText.value = '/search '
    nextTick(() => { textareaEl.value?.focus(); const l = inputText.value.length; textareaEl.value?.setSelectionRange(l, l) })
    return
  }

  if (cmd.id === '/search:regex') {
    const existing = inputText.value.startsWith('/search:regex') ? inputText.value.slice('/search:regex'.length).trim() : ''
    if (existing) {
      const pattern = existing
      inputText.value = ''
      if (!props.workspacePath) { showToast('/search:regex requires an open workspace'); return }
      showToast(`Searching regex /${pattern}/…`)
      try {
        interface SearchRegexResp { ok: boolean; error?: string; results?: Array<{ rel_path: string; matches: Array<{ line: number; col: number; text: string }> }> }
        const resp = await props.backend.send<SearchRegexResp>('search.find_in_files', {
          workspace_path: props.workspacePath,
          query: pattern,
          is_regex: true,
          case_sensitive: false,
          max_results: 30,
        })
        const results = resp.payload?.results ?? []
        if (!results.length) { showToast(`/search:regex: no matches for /${pattern}/`); return }
        const lines = [`// /search:regex /${pattern}/ — ${results.length} file${results.length === 1 ? '' : 's'}`]
        for (const r of results.slice(0, 8)) {
          lines.push(`\n// ${r.rel_path}`)
          r.matches.slice(0, 3).forEach((m) => lines.push(`  ${m.line}: ${m.text.trim()}`))
        }
        contextChips.value.push({ id: crypto.randomUUID(), label: `@search:/${pattern.slice(0, 18)}/`, content: lines.join('\n') })
        inputText.value = `Explain all matches of /${pattern}/ shown in @search results above.`
      } catch { showToast('/search:regex: unavailable') }
      nextTick(() => { textareaEl.value?.focus() })
      return
    }
    inputText.value = '/search:regex '
    nextTick(() => { textareaEl.value?.focus(); const l = inputText.value.length; textareaEl.value?.setSelectionRange(l, l) })
    return
  }

  if (cmd.id === '/save-summary') {
    inputText.value = ''
    const all = messages.value.filter((m) => !m.streaming && m.content.trim())
    if (all.length < 2) { showToast('Nothing to summarize yet'); return }
    const historyText = all.map((m) => `${m.role === 'user' ? 'You' : 'AI'}: ${m.content.slice(0, 400)}`).join('\n---\n')
    const summaryPrompt = `Summarize this conversation into a concise "session notes" block (max 200 words). Focus on:
- Key decisions made
- Files modified or created
- Technical solutions found
- Open questions or next steps

Format as a brief bullet list. This will be saved to the workspace Notepad for future AI context.

Conversation:
${historyText}`
    // Ask AI to generate the summary, then append to notepad on done
    const sessionId = crypto.randomUUID()
    currentSessionId.value = sessionId
    sending.value = true
    if (streamTickInterval !== null) { clearInterval(streamTickInterval); streamTickInterval = null }
    streamTickInterval = window.setInterval(() => { streamNow.value = Date.now() }, 500)
    messages.value.push({ role: 'user', content: '[Saving session summary to Notepad…]', timestamp: Date.now() })
    messages.value.push({ role: 'assistant', content: '', streaming: true, thinking: true, cards: [], timestamp: Date.now() })
    // One-shot listener: when this session's done event fires, append summary to notepad
    const unsubSave = props.backend.on('ai.chat.done', (payload) => {
      const p = payload as { session_id: string }
      if (p.session_id !== sessionId) return
      unsubSave()
      const last = messages.value[messages.value.length - 1]
      if (!last?.content) return
      const dateStr = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
      const newNote = `\n\n---\n### Session Notes (${dateStr})\n${last.content.trim()}`
      notesContent.value = (notesContent.value || '').trimEnd() + newNote
      saveNotes()
      showToast('Session summary saved to Notepad ✓')
    })
    try {
      await props.backend.send('ai.chat.start', {
        session_id: sessionId,
        messages: [{ role: 'user', content: summaryPrompt }],
        workspace_path: props.workspacePath,
      })
    } catch {
      unsubSave()
      messages.value.splice(-2)
      if (streamTickInterval !== null) { clearInterval(streamTickInterval); streamTickInterval = null }
      sending.value = false
      showToast('Summary generation failed')
    }
    return
  }

  // /translate — add language context and translate code comments/strings
  if (cmd.id === '/translate') {
    const existing = inputText.value.slice('/translate'.length).trim()
    if (existing) {
      void sendMessage()
      return
    }
    inputText.value = '/translate '
    nextTick(() => { textareaEl.value?.focus(); const l = inputText.value.length; textareaEl.value?.setSelectionRange(l, l) })
    return
  }

  // /spell — fix spelling and grammar in the current file or selection
  if (cmd.id === '/spell') {
    inputText.value = ''
    const relPath = props.getActiveRelPath?.()
    const fileContent = props.getEditorContent?.()
    const selection = props.getEditorSelection?.()
    if (selection && selection.trim()) {
      contextChips.value.push({ id: crypto.randomUUID(), label: '@selection', content: `// Selection:\n${selection}` })
      inputText.value = 'Fix all spelling and grammar errors in the selected text above. Return only the corrected text, preserving all formatting and line breaks.'
    } else if (relPath && fileContent !== undefined) {
      const ext = relPath.split('.').pop() ?? ''
      if (!contextChips.value.some((c) => c.label.includes(relPath.split('/').pop() ?? '')))
        contextChips.value.push({ id: crypto.randomUUID(), label: `@${relPath.split('/').pop()}`, content: `// File: ${relPath}\n\`\`\`${ext}\n${fileContent.slice(0, 60_000)}\n\`\`\`` })
      inputText.value = 'Fix all spelling and grammar errors in the code comments, strings, and documentation in the attached file. Return the complete corrected file content.'
    } else {
      inputText.value = 'Fix spelling and grammar: '
    }
    nextTick(() => { textareaEl.value?.focus(); const l = inputText.value.length; textareaEl.value?.setSelectionRange(l, l) })
    return
  }

  // /git — quick git status + recent commits summary
  if (cmd.id === '/save-prompt') {
    const rawText = inputText.value.trim()
    const nameArg = rawText.slice('/save-prompt'.length).trim()
    if (!nameArg) { showToast('/save-prompt: type a name, e.g. /save-prompt Code Review'); return }
    const tmpl: PromptTemplate = { id: `pt-${Date.now()}`, name: nameArg, text: '' }
    promptTemplates.value = [tmpl, ...promptTemplates.value]
    savePromptTemplates()
    inputText.value = ''
    showToast(`Saved: "${nameArg}" — open Prompt Templates to edit`)
    return
  }

  if (cmd.id === '/prompts') {
    inputText.value = ''
    showPromptTemplates.value = true
    return
  }

  if (cmd.id === '/import') {
    inputText.value = ''
    void importConversation()
    return
  }

  if (cmd.id === '/pr') {
    inputText.value = ''
    if (!props.workspacePath) { showToast('/pr requires an open workspace'); return }
    try {
      showToast('Fetching diff…')
      interface ShellResp { ok: boolean; output?: string; error?: string }
      // Prefer diff from main/master, fall back to staged
      const [vsMain, staged] = await Promise.all([
        props.backend.send<ShellResp>('shell.run', { command: 'git log --oneline -20 2>&1', workspace_path: props.workspacePath }),
        props.backend.send<ShellResp>('shell.run', { command: 'git diff --stat HEAD 2>&1 | head -40', workspace_path: props.workspacePath }),
      ])
      if (!vsMain.payload?.ok || !staged.payload?.ok) {
        showToast('/pr: ' + (vsMain.payload?.error ?? staged.payload?.error ?? 'backend error'))
        return
      }
      const commits = (vsMain.payload?.output ?? '').trim()
      const stat = (staged.payload?.output ?? '').trim()
      const chipContent = `// Recent commits (for PR description):\n${commits || '(none)'}\n\n// Changed files:\n${stat || '(none)'}`
      contextChips.value = contextChips.value.filter((c) => !c.label.startsWith('@git'))
      contextChips.value.push({ id: crypto.randomUUID(), label: '@git(pr)', content: chipContent })
      inputText.value = 'Write a concise GitHub pull request title and description for these changes.\n\nFormat:\n**Title:** <title>\n\n**Description:**\n<what changed and why>\n\n**Testing:**\n<how to test>'
    } catch { showToast('/pr: unavailable') }
    nextTick(() => { textareaEl.value?.focus() })
    return
  }

  if (cmd.id === '/changelog') {
    inputText.value = ''
    if (!props.workspacePath) { showToast('/changelog requires an open workspace'); return }
    try {
      showToast('Fetching commits…')
      interface ShellResp { ok: boolean; output?: string; error?: string }
      const resp = await props.backend.send<ShellResp>('shell.run', {
        command: 'git log --oneline -30 --format="%h %s (%an)" 2>&1',
        workspace_path: props.workspacePath,
      })
      if (!resp.payload?.ok) {
        showToast('/changelog: ' + (resp.payload?.error ?? 'backend error'))
        return
      }
      const log = (resp.payload?.output ?? '').trim()
      contextChips.value = contextChips.value.filter((c) => c.label !== '@git:log')
      contextChips.value.push({ id: crypto.randomUUID(), label: '@git:log', content: `// git log (last 30):\n${log || '(none)'}` })
      inputText.value = 'Write a CHANGELOG entry for these recent commits, grouped by category (Added, Changed, Fixed, Removed). Use Keep a Changelog format.'
    } catch { showToast('/changelog: unavailable') }
    nextTick(() => { textareaEl.value?.focus() })
    return
  }

  if (cmd.id === '/review:staged' || cmd.id === '/review:branch') {
    inputText.value = ''
    if (!props.workspacePath) { showToast(`${cmd.id} requires an open workspace`); return }
    try {
      showToast('Fetching diff…')
      interface ShellResp { ok: boolean; output?: string; error?: string }
      const isStaged = cmd.id === '/review:staged'
      const diffCmd = isStaged
        ? 'git diff --cached --stat 2>&1 | head -20 && echo "---" && git diff --cached 2>&1 | head -300'
        : 'git diff $(git merge-base HEAD origin/main 2>/dev/null || git merge-base HEAD main 2>/dev/null || echo HEAD~5) HEAD --stat 2>&1 | head -20 && echo "---" && git diff $(git merge-base HEAD origin/main 2>/dev/null || git merge-base HEAD main 2>/dev/null || echo HEAD~5) HEAD 2>&1 | head -400'
      const resp = await props.backend.send<ShellResp>('shell.run', { command: diffCmd, workspace_path: props.workspacePath })
      if (!resp.payload?.ok) {
        showToast(`${cmd.id}: ${resp.payload?.error ?? 'backend error'}`)
        return
      }
      const diff = (resp.payload.output ?? '').trim()
      if (!diff || diff.startsWith('fatal')) {
        showToast(`${cmd.id}: no diff found`)
        return
      }
      contextChips.value = contextChips.value.filter((c) => !c.label.startsWith('@git:diff'))
      const label = isStaged ? '@git:staged' : '@git:branch-diff'
      contextChips.value.push({ id: crypto.randomUUID(), label, content: `// ${isStaged ? 'Staged changes' : 'Branch diff vs main'}:\n${diff}` })
      inputText.value = `Review the following ${isStaged ? 'staged' : 'branch'} changes for: correctness, potential bugs, security issues, and code quality. Be specific and actionable.`
    } catch { showToast(`${cmd.id}: unavailable`) }
    nextTick(() => { textareaEl.value?.focus() })
    return
  }

  if (cmd.id === '/ask') {
    inputText.value = 'How does '
    showToast('Type your question — use @codebase to search across the project')
    await nextTick()
    textareaEl.value?.focus()
    const l = inputText.value.length
    textareaEl.value?.setSelectionRange(l, l)
    return
  }

  if (cmd.id === '/memory') {
    inputText.value = ''
    const fact = window.prompt('Add a persistent memory fact (one sentence):')
    if (fact?.trim()) { addMemory(fact.trim()); showToast(`Memory saved: "${fact.trim().slice(0, 50)}…"`) }
    return
  }

  if (cmd.id === '/memory:clear') {
    inputText.value = ''
    if (!memories.value.length) { showToast('No memories to clear'); return }
    const ok = window.confirm(`Clear all ${memories.value.length} memories?`)
    if (ok) { memories.value = []; showToast('Memories cleared') }
    return
  }

  if (cmd.id === '/refactor:extract') {
    inputText.value = ''
    const sel = (props.getEditorSelection?.() || window.getSelection()?.toString() || '').trim()
    if (sel) {
      const relPath = props.getActiveRelPath?.()
      const ext = relPath?.split('.').pop() ?? ''
      contextChips.value.push({ id: crypto.randomUUID(), label: '@selection', content: `// Selected code:\n\`\`\`${ext}\n${sel}\n\`\`\`` })
      inputText.value = 'Extract the selected code into a well-named function. Keep the original call site working. Use the same language and style as the surrounding code.'
    } else {
      const relPath = props.getActiveRelPath?.()
      const content = props.getEditorContent?.()
      if (relPath && content !== undefined) {
        const ext = relPath.split('.').pop() ?? ''
        const label = `@${relPath.split('/').pop()}`
        if (!contextChips.value.some((c) => c.label === label)) {
          contextChips.value.push({ id: crypto.randomUUID(), label, content: `// File: ${relPath}\n\`\`\`${ext}\n${content}\n\`\`\`` })
        }
      }
      inputText.value = 'Identify the best candidate for extraction in this file. Extract it into a well-named function or variable, keeping all existing behavior identical.'
    }
    nextTick(() => { textareaEl.value?.focus() })
    return
  }

  if (cmd.id === '/format') {
    inputText.value = ''
    if (!props.workspacePath) { showToast('/format requires an open workspace'); return }
    const relPath = props.getActiveRelPath?.()
    if (!relPath) { showToast('/format: no file open'); return }
    const SAFE_PATH = /^[A-Za-z0-9_./ -]+$/
    const safeRelPath = SAFE_PATH.test(relPath) && !relPath.includes('..') && !relPath.startsWith('-') ? relPath : null
    if (!safeRelPath) { showToast('/format: invalid file path'); return }
    try {
      showToast('Formatting…')
      interface ShellRespFmt { ok: boolean; output?: string; error?: string }
      const sqPath = safeRelPath.replace(/'/g, "'\\''")
      const isPy = safeRelPath.endsWith('.py')
      const isTs = /\.(ts|tsx|js|jsx|vue|css|scss|json|md)$/.test(safeRelPath)
      const fmtCmd = isPy
        ? `python -m black '${sqPath}' --diff 2>&1 | head -60 || python -m autopep8 --diff '${sqPath}' 2>&1 | head -60`
        : isTs
        ? `npx prettier --write '${sqPath}' 2>&1 && git diff HEAD -- '${sqPath}' 2>/dev/null | head -60`
        : `echo "(no formatter available for ${safeRelPath})"`
      const resp = await props.backend.send<ShellRespFmt>('shell.run', { command: fmtCmd, workspace_path: props.workspacePath })
      if (!resp.payload?.ok) { showToast(`/format: ${resp.payload?.error ?? 'backend error'}`); return }
      const out = (resp.payload.output ?? '').trim()
      if (!out) { showToast('/format: no changes or formatter unavailable'); return }
      contextChips.value.push({ id: crypto.randomUUID(), label: '@format:diff', content: `// Format changes for ${safeRelPath}:\n\`\`\`diff\n${out}\n\`\`\`` })
      inputText.value = `Review the format changes above for ${safeRelPath.split('/').pop()}. Were all changes correct?`
    } catch { showToast('/format: unavailable') }
    nextTick(() => { textareaEl.value?.focus() })
    return
  }

  if (cmd.id === '/docgen') {
    inputText.value = ''
    const relPath = props.getActiveRelPath?.()
    const content = props.getEditorContent?.()
    if (!relPath || !content) { showToast('/docgen: no file open'); return }
    const ext = relPath.split('.').pop() ?? ''
    const label = `@${relPath.split('/').pop()}`
    if (!contextChips.value.some((c) => c.label === label)) {
      contextChips.value.push({ id: crypto.randomUUID(), label, content: `// File: ${relPath}\n\`\`\`${ext}\n${content}\n\`\`\`` })
    }
    inputText.value = `Generate complete JSDoc/docstring documentation for every exported function, class, and type in ${relPath.split('/').pop()}. Follow the existing code style. Return the full file with documentation added.`
    nextTick(() => { textareaEl.value?.focus() })
    return
  }

  if (cmd.id === '/optimize:imports') {
    inputText.value = ''
    const relPath = props.getActiveRelPath?.()
    const content = props.getEditorContent?.()
    if (!relPath || !content) { showToast('/optimize:imports: no file open'); return }
    const ext = relPath.split('.').pop() ?? ''
    const label = `@${relPath.split('/').pop()}`
    if (!contextChips.value.some((c) => c.label === label)) {
      contextChips.value.push({ id: crypto.randomUUID(), label, content: `// File: ${relPath}\n\`\`\`${ext}\n${content}\n\`\`\`` })
    }
    inputText.value = `Remove all unused imports from ${relPath.split('/').pop()}, sort the remaining imports (stdlib → third-party → internal), and return the complete updated file. Do not change any other code.`
    nextTick(() => { textareaEl.value?.focus() })
    return
  }

  if (cmd.id === '/test:update') {
    inputText.value = ''
    if (!props.workspacePath) { showToast('/test:update requires an open workspace'); return }
    try {
      showToast('Running tests…')
      interface ShellRespTest { ok: boolean; output?: string; error?: string }
      const resp = await props.backend.send<ShellRespTest>('shell.run', {
        command: 'npx vitest run 2>&1 | tail -80 || npx jest --no-coverage 2>&1 | tail -80 || python -m pytest -x -q 2>&1 | tail -60',
        workspace_path: props.workspacePath,
      })
      if (!resp.payload?.ok) { showToast(`/test:update: ${resp.payload?.error ?? 'backend error'}`); return }
      const out = (resp.payload.output ?? '').trim()
      if (!out) { showToast('/test:update: no test output'); return }
      const hasFailures = /FAIL|failed|error|Error|FAILED/i.test(out)
      if (!hasFailures) { showToast('/test:update: all tests pass — nothing to update'); return }
      contextChips.value.push({ id: crypto.randomUUID(), label: '@test:failures', content: `// Failing tests:\n${out}` })
      inputText.value = 'Analyze the failing test output above. For each failure: identify whether the test expectation is wrong (update the assertion) or the implementation is wrong (fix the code). Propose the minimal change to make all tests pass.'
    } catch { showToast('/test:update: unavailable') }
    nextTick(() => { textareaEl.value?.focus() })
    return
  }

  if (cmd.id === '/api') {
    inputText.value = ''
    if (!props.workspacePath) { showToast('/api requires an open workspace'); return }
    try {
      showToast('Detecting API routes…')
      interface ShellRespApi { ok: boolean; output?: string; error?: string }
      const resp = await props.backend.send<ShellRespApi>('shell.run', {
        command: [
          'grep -rn --include="*.ts" --include="*.js" --include="*.py" --include="*.vue"',
          '-E "router\\.(get|post|put|patch|delete|all)|app\\.(get|post|put|patch|delete)|@(Get|Post|Put|Patch|Delete|Router)|FastAPI|APIRouter|@app\\." .',
          '2>/dev/null | grep -v node_modules | grep -v ".test." | grep -v ".spec." | head -40',
        ].join(' '),
        workspace_path: props.workspacePath,
      })
      if (!resp.payload?.ok) { showToast(`/api: ${resp.payload?.error ?? 'backend error'}`); return }
      const raw = (resp.payload.output ?? '').trim()
      if (!raw) { showToast('/api: no route definitions detected'); return }
      contextChips.value.push({ id: crypto.randomUUID(), label: '@api:routes', content: `// API route definitions:\n${raw}` })
      inputText.value = 'List all API endpoints detected above in a structured format: METHOD /path — description. Group by router/controller.'
    } catch { showToast('/api: unavailable') }
    nextTick(() => { textareaEl.value?.focus() })
    return
  }

  // /stash — list git stashes, or push/pop
  if (cmd.id === '/stash') {
    const rawArgs = inputText.value.trim()
    inputText.value = ''
    if (!props.workspacePath) { showToast('/stash requires an open workspace'); return }
    try {
      let stashCmd: string
      if (rawArgs.startsWith('push')) {
        const msg = rawArgs.slice(4).trim()
        const SAFE_MSG = /^[A-Za-z0-9_./ -]+$/
        if (msg && (!SAFE_MSG.test(msg) || msg.includes('..'))) { showToast('/stash push: invalid message'); return }
        stashCmd = msg ? `git stash push -m '${msg.replace(/'/g, "'\\''")}'` : 'git stash push'
      } else if (rawArgs.startsWith('pop')) {
        stashCmd = 'git stash pop'
      } else {
        stashCmd = 'git stash list'
      }
      showToast('Running git stash…')
      interface ShellRespStash { ok: boolean; output?: string; error?: string }
      const resp = await props.backend.send<ShellRespStash>('shell.run', { command: stashCmd, workspace_path: props.workspacePath })
      if (!resp.payload?.ok) { showToast(`/stash: ${resp.payload?.error ?? 'backend error'}`); return }
      const raw = (resp.payload.output ?? '').trim()
      if (!raw) { showToast('/stash: no stashes found'); return }
      contextChips.value.push({ id: crypto.randomUUID(), label: '@git:stash', content: `// git stash list:\n${raw}` })
      inputText.value = 'Summarize the stash entries above. Which stash is most likely the one I want to restore? Explain each one briefly.'
    } catch { showToast('/stash: unavailable') }
    nextTick(() => { textareaEl.value?.focus() })
    return
  }

  // /review:pr — fetch PR details + diff and ask AI to review
  if (cmd.id === '/review:pr') {
    inputText.value = ''
    if (!props.workspacePath) { showToast('/review:pr requires an open workspace'); return }
    try {
      showToast('Fetching PR…')
      interface ShellRespPr { ok: boolean; output?: string; error?: string }
      const prMeta = await props.backend.send<ShellRespPr>('shell.run', {
        command: 'gh pr view --json number,title,body,url,state,author,headRefName 2>&1',
        workspace_path: props.workspacePath,
      })
      if (!prMeta.payload?.ok || !prMeta.payload.output?.trim()) { showToast('/review:pr: no open PR (gh CLI required)'); return }
      const prDiff = await props.backend.send<ShellRespPr>('shell.run', {
        command: 'gh pr diff 2>&1 | head -500',
        workspace_path: props.workspacePath,
      })
      const meta = (prMeta.payload.output ?? '').trim()
      const diff = (prDiff.payload?.output ?? '').trim()
      contextChips.value.push({ id: crypto.randomUUID(), label: '@pr:meta', content: `// PR info:\n${meta}` })
      if (diff) contextChips.value.push({ id: crypto.randomUUID(), label: '@pr:diff', content: `// PR diff (first 500 lines):\n${diff}` })
      inputText.value = 'Review this pull request. Check for: 1. Correctness and logic errors, 2. Security issues, 3. Performance concerns, 4. Missing tests or edge cases, 5. Code style and readability. Summarize findings with severity (critical/medium/low).'
    } catch { showToast('/review:pr: unavailable') }
    nextTick(() => { textareaEl.value?.focus() })
    return
  }

  // /deps:check — check for outdated or vulnerable dependencies
  if (cmd.id === '/deps:check') {
    inputText.value = ''
    if (!props.workspacePath) { showToast('/deps:check requires an open workspace'); return }
    try {
      showToast('Checking dependencies…')
      interface ShellRespDeps { ok: boolean; output?: string; error?: string }
      const npmCheck = await props.backend.send<ShellRespDeps>('shell.run', {
        command: 'npm outdated 2>&1 | head -30',
        workspace_path: props.workspacePath,
      })
      const pipCheck = await props.backend.send<ShellRespDeps>('shell.run', {
        command: 'pip list --outdated 2>&1 | head -20',
        workspace_path: props.workspacePath,
      })
      const npmOut = (npmCheck.payload?.ok ? npmCheck.payload.output ?? '' : '').trim()
      const pipOut = (pipCheck.payload?.ok ? pipCheck.payload.output ?? '' : '').trim()
      if (!npmCheck.payload?.ok && !pipCheck.payload?.ok) { showToast(`/deps:check: ${npmCheck.payload?.error ?? 'backend error'}`); return }
      if (!npmOut && !pipOut) { showToast('/deps:check: no outdated packages found'); return }
      if (npmOut) contextChips.value.push({ id: crypto.randomUUID(), label: '@deps:npm', content: `// npm outdated:\n${npmOut}` })
      if (pipOut && !pipOut.includes('is not recognized') && !pipOut.includes('command not found')) {
        contextChips.value.push({ id: crypto.randomUUID(), label: '@deps:pip', content: `// pip outdated:\n${pipOut}` })
      }
      inputText.value = 'Review the outdated packages above. For each one: 1. What changed in the newer version (breaking changes?), 2. Risk of upgrading, 3. Whether to upgrade now or defer. Prioritize by severity.'
    } catch { showToast('/deps:check: unavailable') }
    nextTick(() => { textareaEl.value?.focus() })
    return
  }

  // /debug:stack — paste a stack trace and ask AI to explain and suggest a fix
  if (cmd.id === '/debug:stack') {
    inputText.value = ''
    try {
      const trace = window.prompt('Paste the stack trace or error output:')
      if (!trace?.trim()) return
      contextChips.value.push({ id: crypto.randomUUID(), label: '@stack:trace', content: `// Stack trace:\n${trace.trim()}` })
      inputText.value = 'Analyze the stack trace above. Explain: 1. What caused this error, 2. Which line in my code is responsible, 3. How to fix it. Include the exact code change needed.'
    } catch { showToast('/debug:stack: unavailable') }
    nextTick(() => { textareaEl.value?.focus() })
    return
  }

  // /rename:symbol — rename a symbol across the codebase with AI assistance
  if (cmd.id === '/rename:symbol') {
    inputText.value = ''
    const sel = (props.getEditorSelection?.() || '').trim()
    const symbolName = sel || window.prompt('Enter the symbol name to rename:')?.trim()
    if (!symbolName) return
    if (!props.workspacePath) { showToast('/rename:symbol requires an open workspace'); return }
    try {
      showToast(`Searching for "${symbolName}"…`)
      interface ShellRespRename { ok: boolean; output?: string; error?: string }
      const safeSymbol = symbolName.replace(/[^A-Za-z0-9_$]/g, '').slice(0, 80)
      if (!safeSymbol) { showToast('/rename:symbol: invalid symbol name'); return }
      const resp = await props.backend.send<ShellRespRename>('shell.run', {
        command: `grep -rn --include="*.ts" --include="*.tsx" --include="*.js" --include="*.jsx" --include="*.py" --include="*.vue" -w "${safeSymbol}" . 2>/dev/null | grep -v node_modules | grep -v ".test." | grep -v ".spec." | head -30`,
        workspace_path: props.workspacePath,
      })
      if (!resp.payload?.ok) { showToast(`/rename:symbol: ${resp.payload?.error ?? 'backend error'}`); return }
      const usages = (resp.payload.output ?? '').trim()
      if (!usages) {
        contextChips.value.push({ id: crypto.randomUUID(), label: `@symbol:${safeSymbol}`, content: `// Symbol "${safeSymbol}": no usages found in workspace` })
      } else {
        contextChips.value.push({ id: crypto.randomUUID(), label: `@symbol:${safeSymbol}`, content: `// Usages of "${safeSymbol}" (${usages.split('\n').length} occurrences):\n${usages}` })
      }
      const relPath = props.getActiveRelPath?.()
      inputText.value = `I want to rename "${safeSymbol}" to a better name${relPath ? ` (currently in ${relPath.split('/').pop()})` : ''}. Suggest 3 good alternative names with reasoning, then show the rename plan (which files need updating and what the grep-replace command would be).`
    } catch { showToast('/rename:symbol: unavailable') }
    nextTick(() => { textareaEl.value?.focus() })
    return
  }

  // /coverage:add — generate tests for uncovered lines in the current file
  if (cmd.id === '/coverage:add') {
    inputText.value = ''
    if (!props.workspacePath) { showToast('/coverage:add requires an open workspace'); return }
    const relPath = props.getActiveRelPath?.()
    if (!relPath) { showToast('/coverage:add: no file open'); return }
    const content = props.getEditorContent?.()
    if (!content) { showToast('/coverage:add: file is empty'); return }
    const SAFE_PATH_COV = /^[A-Za-z0-9_./ -]+$/
    if (!SAFE_PATH_COV.test(relPath) || relPath.includes('..') || relPath.startsWith('-')) { showToast('/coverage:add: invalid path'); return }
    try {
      showToast('Running coverage…')
      interface ShellRespCov { ok: boolean; output?: string; error?: string }
      const ext = relPath.split('.').pop() ?? ''
      const sqPath = "'" + relPath.replace(/'/g, "'\\''") + "'"
      const escapedPattern = "'" + relPath.replace(/'/g, "'\\''").replace(/\./g, '\\.') + "'"
      const coverCmd = ext === 'py'
        ? `python -m pytest --cov=${sqPath} --cov-report=term-missing -q 2>&1 | tail -30`
        : `npx vitest run --coverage ${sqPath} 2>&1 | tail -40 || npx jest --coverage --testPathPattern=${escapedPattern} 2>&1 | tail -40`
      const resp = await props.backend.send<ShellRespCov>('shell.run', { command: coverCmd, workspace_path: props.workspacePath })
      const coverOut = (resp.payload?.ok ? resp.payload.output ?? '' : '').trim()
      const label = `@${relPath.split('/').pop()}`
      if (!contextChips.value.some((c) => c.label === label)) {
        contextChips.value.push({ id: crypto.randomUUID(), label, content: `// File: ${relPath}\n\`\`\`${ext}\n${content.slice(0, 8000)}\n\`\`\`` })
      }
      if (coverOut) contextChips.value.push({ id: crypto.randomUUID(), label: '@coverage:report', content: `// Coverage report:\n${coverOut}` })
      inputText.value = `Based on the file and coverage report above, identify which functions or branches are NOT covered by tests and write new test cases to cover them. Focus on the most important uncovered paths first.`
    } catch {
      const label = `@${relPath.split('/').pop()}`
      const ext = relPath.split('.').pop() ?? ''
      if (!contextChips.value.some((c) => c.label === label)) {
        contextChips.value.push({ id: crypto.randomUUID(), label, content: `// File: ${relPath}\n\`\`\`${ext}\n${content.slice(0, 8000)}\n\`\`\`` })
      }
      inputText.value = 'Analyze the file above and write test cases for any functions that are missing test coverage. Focus on edge cases and error paths.'
    }
    nextTick(() => { textareaEl.value?.focus() })
    return
  }

  // /branch — list, create, or switch git branches
  if (cmd.id === '/branch') {
    inputText.value = ''
    if (!props.workspacePath) { showToast('/branch requires an open workspace'); return }
    try {
      showToast('Fetching branches…')
      interface ShellRespBranch { ok: boolean; output?: string; error?: string }
      const [branchResp, trackingResp] = await Promise.all([
        props.backend.send<ShellRespBranch>('shell.run', { command: 'git branch -a --color=never 2>&1', workspace_path: props.workspacePath }),
        props.backend.send<ShellRespBranch>('shell.run', { command: 'git status --short --branch 2>&1', workspace_path: props.workspacePath }),
      ])
      if (!branchResp.payload?.ok) { showToast(`/branch: ${branchResp.payload?.error ?? 'backend error'}`); return }
      const branches = (branchResp.payload.output ?? '').trim()
      const status = (trackingResp.payload?.ok ? trackingResp.payload.output ?? '' : '').split('\n')[0].trim()
      const chip = `// Git branches:\n${branches}\n\n// Current branch:\n${status}`
      contextChips.value = contextChips.value.filter((c) => c.label !== '@git:branches')
      contextChips.value.push({ id: crypto.randomUUID(), label: '@git:branches', content: chip })
      inputText.value = 'Show me the list of branches above. What is the current branch and what branches are available to switch to or merge from?'
    } catch { showToast('/branch: unavailable') }
    nextTick(() => { textareaEl.value?.focus() })
    return
  }

  // /env:check — compare .env.example with .env and find missing vars
  if (cmd.id === '/env:check') {
    inputText.value = ''
    if (!props.workspacePath) { showToast('/env:check requires an open workspace'); return }
    try {
      interface ReadRespEnv extends ReadPayload {}
      const [exampleResp, envResp] = await Promise.all([
        props.backend.send<ReadRespEnv>('fs.read_file', { workspace_path: props.workspacePath, rel_path: '.env.example' })
          .catch(() => ({ payload: { ok: false, content: '' } })),
        props.backend.send<ReadRespEnv>('fs.read_file', { workspace_path: props.workspacePath, rel_path: '.env' })
          .catch(() => ({ payload: { ok: false, content: '' } })),
      ])
      const example = (exampleResp.payload?.content ?? '').trim()
      const env = (envResp.payload?.content ?? '').trim()
      if (!example) { showToast('/env:check: no .env.example found'); return }
      const exampleVars = example.split('\n').filter((l: string) => l.includes('=') && !l.startsWith('#')).map((l: string) => l.split('=')[0].trim())
      const envVars = new Set(env.split('\n').filter((l: string) => l.includes('=') && !l.startsWith('#')).map((l: string) => l.split('=')[0].trim()))
      const missing = exampleVars.filter((v: string) => !envVars.has(v))
      const chip = `// .env.example variables: ${exampleVars.join(', ')}\n// Missing in .env: ${missing.length ? missing.join(', ') : '(none — all set)'}`
      contextChips.value.push({ id: crypto.randomUUID(), label: '@env:check', content: chip })
      inputText.value = missing.length
        ? `The .env file is missing ${missing.length} variable(s): ${missing.join(', ')}. For each missing variable, explain what it's likely used for based on its name, and provide example values I can use.`
        : 'All variables from .env.example are present in .env. Review if any values look misconfigured or need updating.'
    } catch { showToast('/env:check: unavailable') }
    nextTick(() => { textareaEl.value?.focus() })
    return
  }

  // /fixall — collect all Problems panel diagnostics and ask AI to fix
  if (cmd.id === '/fixall') {
    inputText.value = ''
    const diags = allDiagnosticsSorted()
    if (!diags.length) { showToast('/fixall: no errors or warnings in Problems panel'); return }
    const errors = diags.filter((d) => d.severity === 'error')
    const warns  = diags.filter((d) => d.severity === 'warning')
    const lines = diags.slice(0, 40).map((d) => `${d.relPath}:${d.line} [${d.severity}] ${d.message}`)
    const chip = `// Problems panel (${errors.length} errors, ${warns.length} warnings):\n${lines.join('\n')}`
    contextChips.value = contextChips.value.filter((c) => c.label !== '@problems')
    contextChips.value.push({ id: crypto.randomUUID(), label: '@problems', content: chip })
    inputText.value = errors.length
      ? `There are ${errors.length} error(s) and ${warns.length} warning(s) shown in @problems above. Starting with the errors, fix each issue. For each fix, show the full corrected code block and explain why the change resolves the problem.`
      : `There are ${warns.length} warning(s) shown in @problems above. Fix each issue, showing the corrected code and explaining the reason.`
    nextTick(() => { textareaEl.value?.focus() })
    return
  }

  // /worktree — git worktree management
  if (cmd.id === '/worktree') {
    inputText.value = ''
    if (!props.workspacePath) { showToast('/worktree requires an open workspace'); return }
    const arg = (extra ?? '').trim()
    const SAFE_WT = /^[A-Za-z0-9_./ -]+$/
    try {
      showToast('Fetching worktrees…')
      interface ShellRespWt { ok: boolean; output?: string; error?: string }
      if (!arg || arg === 'list') {
        const r = await props.backend.send<ShellRespWt>('shell.run', { command: 'git worktree list', workspace_path: props.workspacePath })
        if (!r.payload?.ok) { showToast(`/worktree: ${r.payload?.error ?? 'backend error'}`); return }
        const out = (r.payload.output ?? '').trim() || '(no worktrees)'
        contextChips.value.push({ id: crypto.randomUUID(), label: '@worktree:list', content: `// git worktrees:\n${out}` })
        inputText.value = 'Summarize the current git worktrees shown above and suggest when adding a new worktree would be helpful.'
      } else if (arg.startsWith('add ')) {
        const parts = arg.slice(4).trim().split(/\s+/)
        const wtPath = parts[0] ?? ''
        const branch = parts[1] ?? ''
        if (!wtPath || !SAFE_WT.test(wtPath) || wtPath.includes('..')) { showToast('/worktree add: invalid path'); return }
        if (branch && (!SAFE_WT.test(branch) || branch.includes('..'))) { showToast('/worktree add: invalid branch name'); return }
        const sqPath = "'" + wtPath.replace(/'/g, "'\\''") + "'"
        const sqBranch = branch ? " -b '" + branch.replace(/'/g, "'\\''") + "'" : ''
        const cmd2 = `git worktree add${sqBranch} ${sqPath}`
        const r = await props.backend.send<ShellRespWt>('shell.run', { command: cmd2, workspace_path: props.workspacePath })
        showToast(r.payload?.ok ? `Worktree added at ${wtPath}` : `Error: ${r.payload?.error ?? 'failed'}`)
      } else if (arg.startsWith('remove ')) {
        const wtPath = arg.slice(7).trim()
        if (!wtPath || !SAFE_WT.test(wtPath) || wtPath.includes('..')) { showToast('/worktree remove: invalid path'); return }
        const sqPath = "'" + wtPath.replace(/'/g, "'\\''") + "'"
        const r = await props.backend.send<ShellRespWt>('shell.run', { command: `git worktree remove ${sqPath}`, workspace_path: props.workspacePath })
        showToast(r.payload?.ok ? `Worktree removed: ${wtPath}` : `Error: ${r.payload?.error ?? 'failed'}`)
      } else {
        showToast('/worktree: usage: list | add <path> [branch] | remove <path>')
      }
    } catch { showToast('/worktree: command failed') }
    nextTick(() => { textareaEl.value?.focus() })
    return
  }

  // /accessibility — audit HTML/JSX/Vue template for a11y issues
  if (cmd.id === '/accessibility') {
    inputText.value = ''
    const relPath = props.getActiveRelPath?.()
    const fileContent = props.getEditorContent?.()
    if (!relPath || !fileContent) { showToast('/accessibility: no file open'); return }
    const ext = relPath.split('.').pop()?.toLowerCase() ?? ''
    if (!['vue', 'html', 'jsx', 'tsx', 'svelte'].includes(ext)) { showToast(`/accessibility: ${ext} files not supported (use .vue/.html/.jsx/.tsx)`); return }
    const templateMatch = ext === 'vue' ? fileContent.match(/<template[\s\S]*?>([\s\S]*?)<\/template>/) : null
    const htmlSnippet = templateMatch ? templateMatch[1].trim().slice(0, 6000) : fileContent.slice(0, 6000)
    const fileName = relPath.split('/').pop()
    contextChips.value = contextChips.value.filter((c) => !c.label.startsWith('@accessibility:'))
    contextChips.value.push({ id: crypto.randomUUID(), label: `@accessibility:${fileName}`, content: `// Template/HTML in ${relPath}:
${htmlSnippet}` })
    inputText.value = `Perform a WCAG 2.1 AA accessibility audit on the template shown in @accessibility:${fileName}. For each issue found:
1. Specify the WCAG criterion violated (e.g. 1.1.1 Non-text Content)
2. Quote the problematic element
3. Provide the corrected code

Also flag any missing ARIA roles, poor color contrast indicators, keyboard trap risks, or missing alt/label attributes.`
    nextTick(() => { textareaEl.value?.focus() })
    return
  }

  // /regex — build, explain, or test a regex pattern
  if (cmd.id === '/regex') {
    const desc = (extra ?? '').trim()
    if (!desc) {
      inputText.value = '/regex '
      showToast('Describe what you need: e.g.  /regex email validator  or  /regex explain /^[a-z]+$/i')
      nextTick(() => { textareaEl.value?.focus() })
      return
    }
    const sel = props.getEditorSelection?.()
    if (sel) {
      contextChips.value = contextChips.value.filter((c) => c.label !== '@selection')
      contextChips.value.push({ id: crypto.randomUUID(), label: '@selection', content: sel })
    }
    inputText.value = desc.startsWith('explain ')
      ? `Explain the following regex in plain English. Break down each component, list what it matches and what it rejects, and show 3-5 concrete examples:

\`${desc.slice(8).trim()}\``
      : `Build a regex pattern for: ${desc}.

Respond with:
1. The pattern (wrapped in a code block, specify the language/flags)
2. Plain-English explanation of each part
3. 5 test cases (3 matching, 2 non-matching)
4. Any caveats or edge cases${sel ? '\n\nAlso check if the selection matches.' : ''}`
    nextTick(() => { textareaEl.value?.focus() })
    return
  }

  // /pin:file — quickly pin current open file to Always-Include
  if (cmd.id === '/pin:file') {
    inputText.value = ''
    const relPath = props.getActiveRelPath?.()
    if (!relPath) { showToast('/pin:file: no file open in editor'); return }
    addGlobalPin(relPath)
    showToast(`Pinned to Always-Include: ${relPath}`)
    nextTick(() => { textareaEl.value?.focus() })
    return
  }

  // /context:clear — remove all context chips
  if (cmd.id === '/context:clear') {
    inputText.value = ''
    const count = contextChips.value.length
    if (!count) { showToast('No context chips to clear'); return }
    contextChips.value = []
    showToast(`Cleared ${count} context chip${count !== 1 ? 's' : ''}`)
    nextTick(() => { textareaEl.value?.focus() })
    return
  }

  // /gen:component — generate Vue/React component from description
  if (cmd.id === '/gen:component') {
    const desc = (extra ?? '').trim()
    if (!desc) {
      inputText.value = '/gen:component '
      showToast('Add component description: e.g.  /gen:component Modal with title and close button')
      nextTick(() => { textareaEl.value?.focus() })
      return
    }
    // Detect project type from open file
    const relPath = props.getActiveRelPath?.()
    const ext = relPath?.split('.').pop()?.toLowerCase() ?? ''
    const isVue = ext === 'vue' || relPath?.includes('vue')
    const isReact = ['tsx', 'jsx'].includes(ext)
    const framework = isVue ? 'Vue 3 Composition API (script setup, TypeScript)' : isReact ? 'React with TypeScript and hooks' : 'Vue 3 Composition API (script setup, TypeScript)'
    inputText.value = `Generate a complete, production-ready ${framework} component for: ${desc}.

Requirements:
- Full TypeScript typing (props interface, emits, etc.)
- ${isVue ? 'Use <script setup lang="ts">' : 'Use functional component with typed props'}
- Include all necessary imports
- Handle loading/error states if applicable
- Add accessibility attributes (role, aria-*)
- Style with scoped CSS or Tailwind classes (match project conventions)
- Include example usage in a comment at the top`
    nextTick(() => { textareaEl.value?.focus() })
    return
  }

  // /rules:show — display all active AI rule files
  if (cmd.id === '/rules:show') {
    inputText.value = ''
    if (!props.workspacePath) { showToast('/rules:show requires an open workspace'); return }
    try {
      showToast('Loading rule files…')
      interface ReadRespR extends ReadPayload {}
      const RULE_PATHS = ['AGENTS.md', '.cursorrules', '.cursor/rules/main.mdc', '.cursor/rules/default.mdc', '.github/copilot-instructions.md']
      const results = await Promise.all(
        RULE_PATHS.map((rp) =>
          props.backend.send<ReadRespR>('fs.read_file', { workspace_path: props.workspacePath, rel_path: rp })
            .then((r) => ({ path: rp, content: (r.payload?.content ?? '').trim() }))
            .catch(() => ({ path: rp, content: '' })),
        ),
      )
      const found = results.filter((r) => r.content.length > 0)
      if (!found.length) { showToast('/rules:show: no AI rule files found (AGENTS.md, .cursorrules, etc.)'); return }
      const chip = found.map((r) => {
        const snippet = r.content.length > 2000 ? r.content.slice(0, 2000) + '\n// …truncated' : r.content
        return `--- ${r.path} ---\n${snippet}`
      }).join('\n\n')
      contextChips.value = contextChips.value.filter((c) => c.label !== '@rules:active')
      contextChips.value.push({ id: crypto.randomUUID(), label: '@rules:active', content: chip })
      inputText.value = `Summarize the active AI rules shown in @rules:active — what conventions, constraints, or instructions are currently applied to AI interactions in this project? Flag any conflicting or redundant rules.`
    } catch { showToast('/rules:show: failed to read rule files') }
    nextTick(() => { textareaEl.value?.focus() })
    return
  }

  // /mode — switch chat mode (ask / edit / agent)
  if (cmd.id === '/mode') {
    inputText.value = ''
    const target = (extra ?? '').trim().toLowerCase() as 'ask' | 'edit' | 'agent' | ''
    if (!target || !['ask', 'edit', 'agent'].includes(target)) {
      const next: 'ask' | 'edit' | 'agent' = chatMode.value === 'ask' ? 'edit' : chatMode.value === 'edit' ? 'agent' : 'ask'
      chatMode.value = next
      showToast(`Mode → ${next}`)
    } else {
      chatMode.value = target as 'ask' | 'edit' | 'agent'
      showToast(`Mode → ${target}`)
    }
    nextTick(() => { textareaEl.value?.focus() })
    return
  }

  // /session:stats — show token usage and cost for this session
  if (cmd.id === '/session:stats') {
    inputText.value = ''
    const stats = sessionStats.value
    const models = stats.modelsUsed.length ? stats.modelsUsed.join(', ') : 'unknown'
    const costStr = stats.totalCost > 0 ? `~$${stats.totalCost.toFixed(4)}` : 'free / no pricing data'
    const chip = `// Session Statistics:
// Total input tokens:  ${stats.totalIn.toLocaleString()}
// Total output tokens: ${stats.totalOut.toLocaleString()}
// Total tokens:        ${(stats.totalIn + stats.totalOut).toLocaleString()}
// Estimated cost:      ${costStr}
// Models used:         ${models}
// Threads:             ${allThreads.value.length}`
    contextChips.value = contextChips.value.filter((c) => c.label !== '@session:stats')
    contextChips.value.push({ id: crypto.randomUUID(), label: '@session:stats', content: chip })
    inputText.value = `Based on my session usage shown in @session:stats, am I using AI efficiently? Suggest how I could reduce token usage or cost while maintaining productivity.`
    nextTick(() => { textareaEl.value?.focus() })
    return
  }

  // /gen:sql — generate SQL query from description
  if (cmd.id === '/gen:sql') {
    const desc = (extra ?? '').trim()
    if (!desc) {
      inputText.value = '/gen:sql '
      showToast('Describe the query: e.g. /gen:sql users who signed up last month and have not logged in')
      nextTick(() => { textareaEl.value?.focus() })
      return
    }
    // Inject schema chip if available
    const hasSchema = contextChips.value.some((c) => c.label === '@schema')
    inputText.value = `Generate a production-quality SQL query for: ${desc}.

${hasSchema ? 'Use the schema in @schema above.' : 'Infer reasonable column/table names from the description.'}

Respond with:
1. The SQL query in a \`\`\`sql code block
2. A brief explanation of each clause
3. Performance notes (indexes, potential N+1, etc.)
4. Alternative approaches if relevant`
    nextTick(() => { textareaEl.value?.focus() })
    return
  }

  // /typecheck — run tsc/mypy and ask AI to fix errors
  if (cmd.id === '/typecheck') {
    inputText.value = ''
    if (!props.workspacePath) { showToast('/typecheck requires an open workspace'); return }
    try {
      showToast('Running type check…')
      interface ShellRespTc { ok: boolean; output?: string; error?: string }
      // Detect if Python or TypeScript project
      const relPath = props.getActiveRelPath?.()
      const isPy = relPath?.endsWith('.py') ?? false
      const cmd2 = isPy
        ? 'python -m mypy . --ignore-missing-imports --no-error-summary 2>&1 | head -40'
        : 'npx vue-tsc --noEmit 2>&1 | head -40 || npx tsc --noEmit 2>&1 | head -40'
      const r = await props.backend.send<ShellRespTc>('shell.run', { command: cmd2, workspace_path: props.workspacePath })
      const out = (r.payload?.output ?? '').trim()
      if (!out || out.includes('Found 0 errors') || out.includes('0 errors')) {
        showToast('/typecheck: no errors found ✓'); return
      }
      contextChips.value = contextChips.value.filter((c) => c.label !== '@typecheck')
      contextChips.value.push({ id: crypto.randomUUID(), label: '@typecheck', content: `// Type check errors:
${out}` })
      inputText.value = `The type checker found errors shown in @typecheck above. For each error:
1. Quote the error message
2. Identify the root cause
3. Show the corrected code

Fix all errors, starting with the most critical.`
    } catch { showToast('/typecheck: failed to run type checker') }
    nextTick(() => { textareaEl.value?.focus() })
    return
  }

  // /arch — generate codebase architecture overview
  if (cmd.id === '/arch') {
    inputText.value = ''
    if (!props.workspacePath) { showToast('/arch requires an open workspace'); return }
    try {
      showToast('Analyzing project structure…')
      interface ShellRespArch { ok: boolean; output?: string; error?: string }
      const [treeResp, pkgResp] = await Promise.all([
        props.backend.send<ShellRespArch>('shell.run', {
          command: 'find . -type f ! -path "*/node_modules/*" ! -path "*/.venv/*" ! -path "*/.git/*" ! -path "*/dist/*" ! -path "*/build/*" ! -path "*/__pycache__/*" | head -80 | sort',
          workspace_path: props.workspacePath,
        }),
        props.backend.send<ShellRespArch>('shell.run', {
          command: `cat package.json 2>/dev/null | python3 -c "import sys,json; d=json.load(sys.stdin); print(json.dumps({k:d.get(k,{}) for k in ['name','description','dependencies','devDependencies','scripts']}, indent=2))" 2>/dev/null | head -60 || echo "(no package.json)"`,
          workspace_path: props.workspacePath,
        }),
      ])
      const tree = (treeResp.payload?.output ?? '').trim()
      const pkg = (pkgResp.payload?.output ?? '').trim()
      const chip = `// Project file tree:
${tree}

// package.json summary:
${pkg}`
      contextChips.value = contextChips.value.filter((c) => c.label !== '@arch')
      contextChips.value.push({ id: crypto.randomUUID(), label: '@arch', content: chip.slice(0, 8000) })
      inputText.value = `Based on the project structure in @arch, generate a concise architecture overview:

1. **Project type** (framework, language, runtime)
2. **Key directories** and what they contain
3. **Main data flow** (how a request/event moves through the system)
4. **Core dependencies** and why they are used
5. A **Mermaid diagram** of the high-level architecture

Be concise and developer-focused.`
    } catch { showToast('/arch: failed to analyze project') }
    nextTick(() => { textareaEl.value?.focus() })
    return
  }

  // /diff:explain — explain a commit or branch diff in plain English
  if (cmd.id === '/diff:explain') {
    inputText.value = ''
    if (!props.workspacePath) { showToast('/diff:explain requires an open workspace'); return }
    const ref2 = (extra ?? '').trim()
    const SAFE_REF = /^[A-Za-z0-9_./@^~-]+$/
    if (ref2 && (!SAFE_REF.test(ref2) || ref2.includes('..'))) { showToast('/diff:explain: invalid ref/hash'); return }
    try {
      showToast('Fetching diff…')
      interface ShellRespDe { ok: boolean; output?: string; error?: string }
      const sqRef = ref2 ? "'" + ref2.replace(/'/g, "'\''") + "'" : 'HEAD'
      const diffCmd = ref2
        ? `git show ${sqRef} --stat --unified=3 2>&1 | head -120`
        : `git diff HEAD~1..HEAD --stat --unified=3 2>&1 | head -120`
      const r = await props.backend.send<ShellRespDe>('shell.run', { command: diffCmd, workspace_path: props.workspacePath })
      const out = (r.payload?.output ?? '').trim()
      if (!out) { showToast('/diff:explain: no diff found'); return }
      const label = ref2 ? `@diff:${ref2.slice(0, 10)}` : '@diff:HEAD'
      contextChips.value = contextChips.value.filter((c) => c.label === label)
      contextChips.value.push({ id: crypto.randomUUID(), label, content: `// git diff${ref2 ? ` ${ref2}` : ' HEAD~1..HEAD'}:
${out}` })
      inputText.value = `Explain the changes shown in ${label} in plain English. For each changed file:
1. What was changed and why (infer intent from the code)
2. Risk assessment (could this break anything?)
3. Suggestions for improvement (if any)

End with a one-sentence summary suitable for a CHANGELOG entry.`
    } catch { showToast('/diff:explain: failed to fetch diff') }
    nextTick(() => { textareaEl.value?.focus() })
    return
  }

  // /todo — find TODO/FIXME comments and ask AI to resolve them
  if (cmd.id === '/todo') {
    inputText.value = ''
    if (!props.workspacePath) { showToast('/todo requires an open workspace'); return }
    try {
      showToast('Scanning for TODOs…')
      interface ShellRespTodo { ok: boolean; output?: string; error?: string }
      const relPath = props.getActiveRelPath?.()
      const todoCmd = relPath
        ? `grep -n -E "TODO|FIXME|HACK|XXX|BUG" '${relPath.replace(/'/g, "'\\''")}' 2>/dev/null | head -40`
        : 'grep -rn --include="*.ts" --include="*.tsx" --include="*.js" --include="*.py" --include="*.vue" -E "TODO|FIXME|HACK|XXX|BUG" . 2>/dev/null | grep -v node_modules | head -40'
      const resp = await props.backend.send<ShellRespTodo>('shell.run', { command: todoCmd, workspace_path: props.workspacePath })
      if (!resp.payload?.ok) { showToast(`/todo: ${resp.payload?.error ?? 'backend error'}`); return }
      const raw = (resp.payload.output ?? '').trim()
      if (!raw) { showToast('/todo: no TODO/FIXME comments found'); return }
      contextChips.value = contextChips.value.filter((c) => c.label !== '@todos')
      contextChips.value.push({ id: crypto.randomUUID(), label: '@todos', content: `// TODO/FIXME annotations${relPath ? ` in ${relPath}` : ''}:\n${raw}` })
      if (relPath) {
        const content = props.getEditorContent?.()
        const ext = relPath.split('.').pop() ?? ''
        const label = `@${relPath.split('/').pop()}`
        if (content && !contextChips.value.some((c) => c.label === label)) {
          contextChips.value.push({ id: crypto.randomUUID(), label, content: `// File: ${relPath}\n\`\`\`${ext}\n${content.slice(0, 40_000)}\n\`\`\`` })
        }
        inputText.value = 'Resolve all the TODO/FIXME comments shown above. For each one, implement the actual fix inline. Return the complete updated file with all TODOs resolved.'
      } else {
        inputText.value = 'Analyze all the TODO/FIXME/HACK comments above. For each one: explain what needs to be done and provide a concrete code solution.'
      }
    } catch { showToast('/todo: unavailable') }
    nextTick(() => { textareaEl.value?.focus() })
    return
  }

  // /size — analyze file size and complexity, suggest splits
  if (cmd.id === '/size') {
    inputText.value = ''
    const relPath = props.getActiveRelPath?.()
    const content = props.getEditorContent?.()
    if (!relPath || !content) { showToast('/size: no file open'); return }
    const lineCount = content.split('\n').length
    const charCount = content.length
    const ext = relPath.split('.').pop() ?? ''
    const fileName = relPath.split('/').pop()
    const label = `@${fileName}`
    if (!contextChips.value.some((c) => c.label === label)) {
      contextChips.value.push({ id: crypto.randomUUID(), label, content: `// File: ${relPath}\n\`\`\`${ext}\n${content.slice(0, 40_000)}\n\`\`\`` })
    }
    inputText.value = `Analyze this file: ${fileName} (${lineCount} lines, ${Math.round(charCount/1024)}KB). Is it too large? Identify: 1. The main responsibility areas, 2. Functions/classes that could be extracted to separate files, 3. Suggested file split with new file names. Be specific with line ranges.`
    nextTick(() => { textareaEl.value?.focus() })
    return
  }

  // /init:rules — analyze codebase and generate .cursorrules / AI instructions
  if (cmd.id === '/init:rules') {
    inputText.value = ''
    if (!props.workspacePath) { showToast('/init:rules requires an open workspace'); return }
    try {
      showToast('Analyzing project structure…')
      interface ShellResp2 { ok: boolean; output?: string; error?: string }
      interface ReadResp4 extends ReadPayload {}
      const [treeResp, pkgResp, rulesResp] = await Promise.all([
        props.backend.send<ShellResp2>('shell.run', { command: 'find . -type f -not -path "*/node_modules/*" -not -path "*/.git/*" -not -path "*/__pycache__/*" -not -path "*/.venv/*" | head -80 2>&1', workspace_path: props.workspacePath }),
        props.backend.send<ReadResp4>('fs.read_file', { workspace_path: props.workspacePath, rel_path: 'package.json' }).catch(() => ({ payload: { ok: false } })),
        props.backend.send<ReadResp4>('fs.read_file', { workspace_path: props.workspacePath, rel_path: '.cursorrules' }).catch(() => ({ payload: { ok: false } })),
      ])
      const tree = treeResp.payload?.ok ? (treeResp.payload.output ?? '') : ''
      const existingRules = (rulesResp as { payload?: ReadResp4 }).payload?.content
      const existing = existingRules ? `\n\nExisting .cursorrules:\n${existingRules.slice(0, 2000)}` : ''
      let pkgContext = ''
      const pkgContent = (pkgResp as { payload?: ReadResp4 }).payload?.content
      if (pkgContent) {
        try {
          const p = JSON.parse(pkgContent) as { name?: string; description?: string; dependencies?: Record<string, string>; devDependencies?: Record<string, string> }
          const deps = Object.keys(p.dependencies ?? {}).slice(0, 20).join(', ')
          const dev = Object.keys(p.devDependencies ?? {}).slice(0, 20).join(', ')
          pkgContext = `\nProject: ${p.name ?? ''} — ${p.description ?? ''}\nDeps: ${deps}\nDevDeps: ${dev}`
        } catch { /* ignore */ }
      }
      contextChips.value.push({ id: crypto.randomUUID(), label: '@workspace', content: `// Project file tree:\n${tree}${pkgContext}${existing}` })
      inputText.value = 'Based on the project structure above, generate a comprehensive `.cursorrules` file (also works as `CLAUDE.md` or `AGENTS.md`). Cover: 1. Tech stack overview, 2. Code style & conventions, 3. Key patterns to follow, 4. Common mistakes to avoid, 5. Testing conventions. Return the file content in a code block so I can apply it directly.'
    } catch {
      inputText.value = 'Analyze this project and generate a .cursorrules / CLAUDE.md file covering: tech stack, code conventions, key patterns, mistakes to avoid, and testing conventions.'
    }
    nextTick(() => { textareaEl.value?.focus() })
    return
  }

  // /explain:commit — explain last 5 commits in plain English
  // /explain:imports — extract and explain all imports in the current file
  if (cmd.id === '/explain:imports') {
    inputText.value = ''
    const relPath = props.getActiveRelPath?.()
    const content = props.getEditorContent?.()
    if (!relPath || !content) { showToast('/explain:imports: no file open'); return }
    const ext = relPath.split('.').pop() ?? ''
    // Extract import/require lines based on file type
    const importLines = content.split('\n').filter((line) => {
      const t = line.trim()
      return t.startsWith('import ') || t.startsWith('from ') || /^const .+ = require\(/.test(t) || t.startsWith('use ') || t.startsWith('#include') || t.startsWith('using ')
    })
    if (!importLines.length) { showToast('/explain:imports: no imports found'); return }
    const fileName = relPath.split('/').pop()
    contextChips.value.push({
      id: crypto.randomUUID(),
      label: `@imports:${fileName}`,
      content: `// Imports in ${relPath}:\n${importLines.slice(0, 80).join('\n')}`,
    })
    inputText.value = `For each import shown above (from ${fileName}), explain:\n1. What the imported module/library does\n2. Why it is used in this file\n3. Any notable gotchas or best practices\n\nBe concise — one paragraph per import.`
    nextTick(() => { textareaEl.value?.focus() })
    return
  }

  if (cmd.id === '/explain:commit') {
    inputText.value = ''
    if (!props.workspacePath) { showToast('/explain:commit requires an open workspace'); return }
    try {
      showToast('Fetching recent commits…')
      interface ShellResp3 { ok: boolean; output?: string; error?: string }
      const resp = await props.backend.send<ShellResp3>('shell.run', {
        command: 'git log -5 --format="commit %H%nauthor: %an%ndate: %ad%nsubject: %s%n%nbody:%n%b%n---" --date=short 2>&1',
        workspace_path: props.workspacePath,
      })
      if (resp.payload?.ok && resp.payload.output?.trim()) {
        contextChips.value.push({ id: crypto.randomUUID(), label: '@git:log:5', content: `// Last 5 commits:\n${resp.payload.output.slice(0, 6000)}` })
        inputText.value = 'Explain these 5 commits in plain English. For each: what changed, why it likely happened, and any risks or notable patterns.'
      } else {
        inputText.value = 'Explain the recent git commits in plain English. Describe what changed and why.'
      }
    } catch {
      inputText.value = 'Explain the recent git commits in plain English.'
    }
    nextTick(() => { textareaEl.value?.focus() })
    return
  }

  if (cmd.id === '/commit:amend') {
    inputText.value = ''
    if (!props.workspacePath) { showToast('/commit:amend requires an open workspace'); return }
    try {
      showToast('Fetching last commit…')
      interface ShellResp { ok: boolean; output?: string; error?: string }
      const resp = await props.backend.send<ShellResp>('shell.run', {
        command: 'git log -1 --format="%H%n%s%n%n%b" 2>&1',
        workspace_path: props.workspacePath,
      })
      if (!resp.payload?.ok) { showToast(`/commit:amend: ${resp.payload?.error ?? 'backend error'}`); return }
      const log = (resp.payload.output ?? '').trim()
      if (!log || log.startsWith('fatal')) { showToast('/commit:amend: no commits found'); return }
      const [hash, ...rest] = log.split('\n')
      const msg = rest.join('\n').trim()
      contextChips.value.push({ id: crypto.randomUUID(), label: '@git:last-commit', content: `// Last commit (${hash.slice(0, 7)}):\n${msg}` })
      inputText.value = 'Rewrite this commit message to be clearer and follow conventional commits format (type(scope): description). Keep it concise. Return only the new message, no explanation.'
    } catch { showToast('/commit:amend: unavailable') }
    nextTick(() => { textareaEl.value?.focus() })
    return
  }

  if (cmd.id === '/label') {
    const labelList = THREAD_LABELS.map((l, i) => `${i + 1}. ${l}`).join('  ')
    const existing = allThreads.value.find((t) => t.id === currentThreadId.value)?.label ?? ''
    inputText.value = ''
    const raw = window.prompt(
      `Set thread label:\n${labelList}\n\nType the label text (or clear to remove):\nCurrent: ${existing || '(none)'}`,
      existing,
    )
    if (raw !== null) {
      const choice = raw.trim() as ThreadLabel
      const matched = THREAD_LABELS.find((l) => l === choice) ?? (choice === '' ? '' : null)
      if (matched !== null) {
        setThreadLabel(currentThreadId.value, matched as ThreadLabel)
        showToast(matched ? `Label set: ${matched}` : 'Label removed')
      } else {
        showToast('Invalid label — choose from the list')
      }
    }
    return
  }

  if (cmd.id === '/recap') {
    inputText.value = ''
    if (messages.value.length < 2) { showToast('/recap: no conversation yet'); return }
    const recent = messages.value.filter((m) => !m.streaming && m.content.trim()).slice(-20)
    const historyText = recent.map((m) => `${m.role === 'user' ? 'User' : 'AI'}: ${m.content.slice(0, 300)}`).join('\n---\n')
    contextChips.value.push({ id: crypto.randomUUID(), label: '@history', content: `// Recent conversation:\n${historyText}` })
    inputText.value = 'Give me a quick 3-bullet recap of the key decisions and outcomes from this conversation so far. Be concise — one sentence per bullet.'
    nextTick(() => { textareaEl.value?.focus() })
    return
  }

  if (cmd.id === '/instructions') {
    inputText.value = ''
    const t = allThreads.value.find((th) => th.id === currentThreadId.value)
    const current = t?.systemPrompt ?? ''
    const rawInstr = window.prompt(
      'Set custom AI instructions for this thread only\n(overrides global system prompt while this thread is active):\n\nLeave blank to use global setting.',
      current,
    )
    if (rawInstr !== null && t) {
      const newInstr = rawInstr.trim()
      t.systemPrompt = newInstr || undefined
      saveCurrentThread()
      _pushSettingsToBackend()
      showToast(newInstr ? 'Thread instructions set' : 'Thread instructions cleared')
    }
    return
  }

  if (cmd.id === '/fix:lint') {
    inputText.value = ''
    if (!props.workspacePath) { showToast('/fix:lint requires an open workspace'); return }
    try {
      showToast('Running linter…')
      interface ShellResp { ok: boolean; output?: string; error?: string }
      const rawPath = props.getActiveRelPath?.() ?? ''
      // Validate: only safe path characters, reject .. and leading -
      const SAFE_PATH = /^[A-Za-z0-9_./ -]+$/
      const safeRelPath = SAFE_PATH.test(rawPath) && !rawPath.includes('..') && !rawPath.startsWith('-') ? rawPath : ''
      // Single-quote shell quoting: replace ' with '\''
      const sqPath = safeRelPath.replace(/'/g, "'\\''")
      const eslintCmd = safeRelPath
        ? `npx eslint '${sqPath}' --format compact 2>&1 | head -60 || echo "(eslint not available)"`
        : 'npx eslint . --format compact 2>&1 | head -60 || echo "(eslint not available)"'
      const ruffCmd = safeRelPath && safeRelPath.endsWith('.py')
        ? `python -m ruff check '${sqPath}' 2>&1 | head -40 || echo "(ruff not available)"`
        : 'python -m ruff check . 2>&1 | head -40 || echo "(ruff not available)"'
      const [eslintResp, ruffResp] = await Promise.all([
        props.backend.send<ShellResp>('shell.run', { command: eslintCmd, workspace_path: props.workspacePath }),
        props.backend.send<ShellResp>('shell.run', { command: ruffCmd, workspace_path: props.workspacePath }),
      ])
      const eslint = (eslintResp.payload?.ok ? eslintResp.payload.output ?? '' : '').trim()
      const ruff = (ruffResp.payload?.ok ? ruffResp.payload.output ?? '' : '').trim()
      let lintErrors = ''
      if (eslint && !eslint.includes('not available')) lintErrors += `// ESLint:\n${eslint}\n`
      if (ruff && !ruff.includes('not available') && !ruff.includes('error: ')) lintErrors += `\n// Ruff:\n${ruff}\n`
      if (!lintErrors.trim()) { showToast('/fix:lint: no errors found'); return }
      contextChips.value = contextChips.value.filter((c) => c.label !== '@lint')
      contextChips.value.push({ id: crypto.randomUUID(), label: '@lint', content: lintErrors.trim() })
      inputText.value = 'Fix all the lint errors shown above. For each fix, briefly explain what was wrong and what you changed.'
    } catch { showToast('/fix:lint: unavailable') }
    nextTick(() => { textareaEl.value?.focus() })
    return
  }

  if (cmd.id === '/coverage') {
    inputText.value = ''
    if (!props.workspacePath) { showToast('/coverage requires an open workspace'); return }
    try {
      showToast('Running coverage…')
      interface ShellResp { ok: boolean; output?: string; error?: string }
      const rawPath = props.getActiveRelPath?.() ?? ''
      const SAFE_PATH = /^[A-Za-z0-9_./ -]+$/
      const safeRelPath = SAFE_PATH.test(rawPath) && !rawPath.includes('..') && !rawPath.startsWith('-') ? rawPath : ''
      const sqPath = safeRelPath.replace(/'/g, "'\\''")
      const isPy = safeRelPath.endsWith('.py')
      const covCmd = isPy && safeRelPath
        ? `python -m pytest --cov='${sqPath}' --cov-report=term-missing -q 2>&1 | tail -30`
        : `npx vitest run --reporter=verbose --coverage 2>&1 | grep -A100 "Coverage report" | head -40 || npx jest --coverage --coverageReporters=text 2>&1 | tail -30`
      const resp = await props.backend.send<ShellResp>('shell.run', { command: covCmd, workspace_path: props.workspacePath })
      if (!resp.payload?.ok) { showToast(`/coverage: ${resp.payload?.error ?? 'backend error'}`); return }
      const cov = (resp.payload.output ?? '').trim()
      if (!cov) { showToast('/coverage: no output'); return }
      contextChips.value.push({ id: crypto.randomUUID(), label: '@coverage', content: `// Coverage report:\n${cov}` })
      inputText.value = safeRelPath
        ? `Analyze the coverage report above for ${safeRelPath.split('/').pop()}. Identify the uncovered lines and write tests to cover them.`
        : 'Analyze the coverage report above. Identify the most critical uncovered code and write tests to improve coverage.'
    } catch { showToast('/coverage: unavailable') }
    nextTick(() => { textareaEl.value?.focus() })
    return
  }

  if (cmd.id === '/git') {
    inputText.value = ''
    if (!props.workspacePath) { showToast('/git requires an open workspace'); return }
    try {
      interface ShellResp { ok: boolean; output?: string; error?: string }
      const [statusResp, logResp] = await Promise.all([
        props.backend.send<ShellResp>('shell.run', { command: 'git status --short 2>&1', workspace_path: props.workspacePath }),
        props.backend.send<ShellResp>('shell.run', { command: 'git log --oneline -10 2>&1', workspace_path: props.workspacePath }),
      ])
      if (!statusResp.payload?.ok || !logResp.payload?.ok) {
        showToast('/git: ' + (statusResp.payload?.error ?? logResp.payload?.error ?? 'backend error'))
        return
      }
      const status = (statusResp.payload?.output ?? '').trim()
      const log = (logResp.payload?.output ?? '').trim()
      const chipContent = `// git status:
${status || '(clean)'}

// git log (last 10):
${log || '(no commits)'}`
      contextChips.value = contextChips.value.filter((c) => c.label !== '@git:status')
      contextChips.value.push({ id: crypto.randomUUID(), label: '@git:status', content: chipContent })
      inputText.value = 'Summarize the current git status and recent commits. What changed recently?'
    } catch { showToast('/git: unavailable') }
    nextTick(() => { textareaEl.value?.focus() })
    return
  }

  if (cmd.id === '/scaffold') {
    inputText.value = 'Scaffold a new '
    // Auto-inject tree so AI knows what already exists in the project
    if (props.workspacePath) {
      void (async () => {
        try {
          interface FlatRespScaffold { ok: boolean; files?: string[]; error?: string }
          const r = await props.backend.send<FlatRespScaffold>('fs.list_files_flat', { workspace_path: props.workspacePath, query: '' })
          const files = (r.payload?.files ?? []).slice(0, 100)
          if (files.length && !contextChips.value.some((c) => c.label === '@tree')) {
            contextChips.value.push({ id: crypto.randomUUID(), label: '@tree', content: `// Project file tree:\n${buildFileTree(files)}` })
          }
        } catch { /* ignore */ }
      })()
    }
    await nextTick(); textareaEl.value?.focus()
    const len = inputText.value.length
    textareaEl.value?.setSelectionRange(len, len)
    return
  }

  // /refactor:file — AI-guided full-file refactor
  if (cmd.id === '/refactor:file') {
    inputText.value = ''
    const relPath = props.getActiveRelPath?.()
    const content = props.getEditorContent?.()
    if (!relPath || !content) { showToast('/refactor:file: no file open'); return }
    const ext = relPath.split('.').pop() ?? ''
    const fileName = relPath.split('/').pop()
    contextChips.value = contextChips.value.filter((c) => c.label !== `@${fileName}`)
    contextChips.value.push({ id: crypto.randomUUID(), label: `@${fileName}`, content: `// File: ${relPath}\n\`\`\`${ext}\n${content.slice(0, 30000)}\n\`\`\`` })
    inputText.value = `Refactor the entire ${fileName} file shown above. Goals:\n1. Improve naming clarity (variables, functions, classes)\n2. Simplify complex logic — break large functions into smaller ones\n3. Remove dead code and unnecessary comments\n4. Improve consistency of code style\n5. Preserve all existing behavior exactly\n\nReturn the full refactored file in a single code block.`
    nextTick(() => { textareaEl.value?.focus() })
    return
  }

  // /clone:thread — fork current thread into a new one
  if (cmd.id === '/clone:thread') {
    inputText.value = ''
    const currentId = currentThreadId.value
    const source = allThreads.value.find((t) => t.id === currentId)
    if (!source) { showToast('/clone:thread: no active thread'); return }
    const cloned: ChatThread = {
      id: crypto.randomUUID(),
      title: `${source.title} (clone)`,
      messages: JSON.parse(JSON.stringify(source.messages)) as typeof source.messages,
      updatedAt: Date.now(),
      model: source.model,
      systemPrompt: source.systemPrompt,
    }
    allThreads.value.unshift(cloned)
    _doSave()
    currentThreadId.value = cloned.id
    showToast(`Cloned thread: "${cloned.title}"`)
    return
  }

  // /gen:readme — generate README from project structure
  if (cmd.id === '/gen:readme') {
    inputText.value = ''
    if (!props.workspacePath) { showToast('/gen:readme requires an open workspace'); return }
    try {
      showToast('Reading project structure…')
      interface FlatRespReadme { ok: boolean; files?: string[]; error?: string }
      interface ShellRespReadme { ok: boolean; output?: string; error?: string }
      const [filesResp, pkgResp, existingResp] = await Promise.all([
        props.backend.send<FlatRespReadme>('fs.list_files_flat', { workspace_path: props.workspacePath, query: '' }),
        props.backend.send<ShellRespReadme>('fs.read_file', { workspace_path: props.workspacePath, rel_path: 'package.json' }).catch(() => ({ payload: { ok: false, output: '' } })),
        props.backend.send<ShellRespReadme>('fs.read_file', { workspace_path: props.workspacePath, rel_path: 'README.md' }).catch(() => ({ payload: { ok: false, output: '' } })),
      ])
      const files = (filesResp.payload?.files ?? []).slice(0, 150)
      const tree = buildFileTree(files)
      const pkg = (pkgResp.payload as { ok?: boolean; content?: string })?.content ?? ''
      const existingReadme = (existingResp.payload as { ok?: boolean; content?: string })?.content ?? ''
      let ctx = `// Project file tree:\n${tree}`
      if (pkg) ctx += `\n\n// package.json:\n${pkg.slice(0, 2000)}`
      if (existingReadme) ctx += `\n\n// Existing README.md:\n${existingReadme.slice(0, 3000)}`
      contextChips.value = contextChips.value.filter((c) => c.label !== '@tree')
      contextChips.value.push({ id: crypto.randomUUID(), label: '@tree', content: ctx })
      inputText.value = existingReadme
        ? 'Update the existing README.md based on the current project structure. Keep existing sections that are still accurate, update outdated parts, and add missing sections. Return the full updated README.md.'
        : 'Generate a comprehensive README.md for this project based on the file structure and package.json. Include: project title, description, features, installation, usage, project structure overview, and contributing guidelines. Use markdown formatting.'
    } catch { showToast('/gen:readme: unavailable') }
    nextTick(() => { textareaEl.value?.focus() })
    return
  }

  // /explain:selection — explain the currently selected code
  if (cmd.id === '/explain:selection') {
    inputText.value = ''
    const sel = props.getEditorSelection?.()
    const relPath = props.getActiveRelPath?.()
    const ext = relPath?.split('.').pop() ?? ''
    if (sel?.trim()) {
      contextChips.value = contextChips.value.filter((c) => c.label !== '@selection')
      contextChips.value.push({
        id: crypto.randomUUID(),
        label: '@selection',
        content: relPath
          ? `// Selection from: ${relPath}\n\`\`\`${ext}\n${sel.trim()}\n\`\`\``
          : `// Selected code:\n\`\`\`\n${sel.trim()}\n\`\`\``,
      })
      inputText.value = 'Explain this selected code in plain English. Cover: what it does, how it works step-by-step, any patterns used, and potential edge cases.'
    } else if (relPath) {
      const content = props.getEditorContent?.() ?? ''
      contextChips.value.push({ id: crypto.randomUUID(), label: `@${relPath.split('/').pop()}`, content: `// File: ${relPath}\n\`\`\`${ext}\n${content.slice(0, 15000)}\n\`\`\`` })
      inputText.value = 'Explain what this file does in plain English. Cover: its purpose, main components, key logic, and how it fits into the project.'
    } else {
      showToast('/explain:selection: no selection or open file'); return
    }
    nextTick(() => { textareaEl.value?.focus() })
    return
  }

  // /git:cherry-pick — interactive cherry-pick guidance
  if (cmd.id === '/git:cherry-pick' || cmd.id.startsWith('/git:cherry-pick ')) {
    inputText.value = ''
    if (!props.workspacePath) { showToast('/git:cherry-pick requires an open workspace'); return }
    const rawRef = cmd.id.replace('/git:cherry-pick', '').trim() || ''
    const SAFE_REF = /^[A-Za-z0-9_./-]+$/
    try {
      showToast('Fetching recent commits…')
      interface ShellRespCP { ok: boolean; output?: string; error?: string }
      const logResp = await props.backend.send<ShellRespCP>('shell.run', {
        command: 'git log --oneline -20 2>&1',
        workspace_path: props.workspacePath,
      })
      if (!logResp.payload?.ok) { showToast('/git:cherry-pick: ' + (logResp.payload?.error ?? 'backend error')); return }
      const logOut = (logResp.payload.output ?? '').trim()
      let chipContent = `// Recent commits:\n${logOut}`
      if (rawRef && SAFE_REF.test(rawRef) && !rawRef.includes('..')) {
        const showResp = await props.backend.send<ShellRespCP>('shell.run', {
          command: `git show --stat '${rawRef.replace(/'/g, "'\\''")}' 2>&1 | head -30`,
          workspace_path: props.workspacePath,
        })
        chipContent += `\n\n// Commit ${rawRef}:\n${(showResp.payload?.output ?? '').trim()}`
      }
      contextChips.value.push({ id: crypto.randomUUID(), label: '@git:log', content: chipContent })
      inputText.value = rawRef && SAFE_REF.test(rawRef)
        ? `Guide me through cherry-picking commit \`${rawRef}\` onto the current branch. Show: the exact git command to run, what changes will be applied, potential merge conflict risks, and how to verify the cherry-pick was successful.`
        : 'Guide me through cherry-picking a commit. Look at the recent commits above. Explain: what cherry-pick does, how to select the right commit hash, the exact command to run, how to handle conflicts if they occur, and how to verify success.'
    } catch { showToast('/git:cherry-pick: unavailable') }
    nextTick(() => { textareaEl.value?.focus() })
    return
  }

  // /snippet:save — save selected code as a named snippet
  if (cmd.id === '/snippet:save' || cmd.id.startsWith('/snippet:save ')) {
    inputText.value = ''
    const nameArg = cmd.id.replace('/snippet:save', '').trim()
    const sel = props.getEditorSelection?.() ?? ''
    const relPath = props.getActiveRelPath?.() ?? ''
    if (!sel.trim()) { showToast('/snippet:save: select code first, then run /snippet:save <name>'); return }
    const name = (nameArg || window.prompt('Snippet name:', relPath.split('/').pop()?.replace(/\.[^.]+$/, '') ?? 'snippet')) ?? ''
    if (!name.trim()) { showToast('/snippet:save: cancelled'); return }
    const SAVED_SNIPPETS_KEY = 'ai-chat-snippets'
    interface Snippet { id: string; name: string; content: string; lang: string; createdAt: number }
    const existing: Snippet[] = (() => { try { return JSON.parse(settingsGet(SAVED_SNIPPETS_KEY, '[]')) as Snippet[] } catch { return [] } })()
    const ext = relPath.split('.').pop() ?? ''
    existing.unshift({ id: crypto.randomUUID(), name: name.trim(), content: sel.trim(), lang: ext, createdAt: Date.now() })
    settingsSet(SAVED_SNIPPETS_KEY, JSON.stringify(existing.slice(0, 200)))
    showToast(`Snippet saved: "${name.trim()}"`)
    return
  }

  // /snippet:list — browse and insert saved snippets
  if (cmd.id === '/snippet:list') {
    inputText.value = ''
    const SAVED_SNIPPETS_KEY = 'ai-chat-snippets'
    interface Snippet { id: string; name: string; content: string; lang: string; createdAt: number }
    const existing: Snippet[] = (() => { try { return JSON.parse(settingsGet(SAVED_SNIPPETS_KEY, '[]')) as Snippet[] } catch { return [] } })()
    if (!existing.length) { showToast('/snippet:list: no saved snippets yet — use /snippet:save to save one'); return }
    const list = existing.slice(0, 20).map((s, i) => `${i + 1}. ${s.name} (${s.lang || 'text'}) — ${s.content.slice(0, 50).replace(/\n/g, ' ')}…`)
    contextChips.value.push({ id: crypto.randomUUID(), label: '@snippets', content: `// Saved snippets:\n${list.join('\n')}` })
    inputText.value = 'Here are my saved code snippets. Pick the most relevant one and show how to use it, or help me combine multiple snippets for my current task.'
    nextTick(() => { textareaEl.value?.focus() })
    return
  }

  // /ask:codebase — full codebase Q&A with auto file-tree context
  if (cmd.id === '/ask:codebase' || cmd.id.startsWith('/ask:codebase ')) {
    inputText.value = ''
    const question = cmd.id.replace('/ask:codebase', '').trim()
    if (!props.workspacePath) { showToast('/ask:codebase requires an open workspace'); return }
    try {
      showToast('Reading project structure…')
      interface FlatRespCB { ok: boolean; files?: string[]; error?: string }
      const resp = await props.backend.send<FlatRespCB>('fs.list_files_flat', { workspace_path: props.workspacePath, query: '' })
      const files = (resp.payload?.files ?? []).slice(0, 200)
      const tree = buildFileTree(files)
      if (!contextChips.value.some((c) => c.label === '@tree')) {
        contextChips.value.push({ id: crypto.randomUUID(), label: '@tree', content: `// Project file tree:\n${tree}` })
      }
    } catch { /* inject tree best-effort */ }
    inputText.value = question || 'Ask a question about this codebase: '
    await nextTick()
    textareaEl.value?.focus()
    if (!question) {
      const len = inputText.value.length
      textareaEl.value?.setSelectionRange(len, len)
    }
    return
  }

  // /gen:types — generate TypeScript types or Pydantic models from JSON or description
  if (cmd.id === '/gen:types') {
    inputText.value = ''
    const sel = props.getEditorSelection?.()
    const relPath = props.getActiveRelPath?.()
    const ext = relPath?.split('.').pop() ?? ''
    const isPython = ext === 'py' || relPath?.includes('.py')
    if (sel?.trim()) {
      contextChips.value.push({ id: crypto.randomUUID(), label: '@selection', content: `// JSON / schema:\n\`\`\`\n${sel.trim()}\n\`\`\`` })
      inputText.value = isPython
        ? 'Generate Pydantic v2 models for the JSON/schema shown above. Include: field types, Optional fields, validators where needed, and Config class if relevant.'
        : 'Generate TypeScript interfaces and type aliases for the JSON/schema shown above. Use strict types, no `any`. Add JSDoc comments for non-obvious fields.'
    } else {
      inputText.value = isPython
        ? 'Generate Pydantic v2 models for: '
        : 'Generate TypeScript types for: '
      await nextTick()
      textareaEl.value?.focus()
      const len = inputText.value.length
      textareaEl.value?.setSelectionRange(len, len)
    }
    return
  }

  // /perf:profile — identify performance hotspots in current file or selection
  if (cmd.id === '/perf:profile') {
    inputText.value = ''
    const sel = props.getEditorSelection?.()
    const relPath = props.getActiveRelPath?.()
    const content = props.getEditorContent?.()
    const ext = relPath?.split('.').pop() ?? ''
    const target = sel?.trim() || content?.slice(0, 20000) || ''
    const label = sel?.trim() ? '@selection' : relPath ? `@${relPath.split('/').pop()}` : null
    if (!target || !label) { showToast('/perf:profile: no file open or code selected'); return }
    contextChips.value = contextChips.value.filter((c) => c.label !== label)
    contextChips.value.push({
      id: crypto.randomUUID(),
      label,
      content: sel?.trim()
        ? `// Selection from: ${relPath}\n\`\`\`${ext}\n${sel.trim()}\n\`\`\``
        : `// File: ${relPath}\n\`\`\`${ext}\n${target}\n\`\`\``,
    })
    inputText.value = 'Analyze this code for performance hotspots. For each issue:\n1. Name the problem (e.g. N+1 query, unnecessary re-render, O(n²) loop)\n2. Show the specific lines causing it\n3. Estimate the impact (critical / high / medium / low)\n4. Provide an optimized version with explanation\n\nRank findings by impact.'
    nextTick(() => { textareaEl.value?.focus() })
    return
  }

  // /explain:error — explain pasted terminal error + suggest fix (VS Code "Fix using Copilot")
  if (cmd.id === '/explain:error') {
    inputText.value = ''
    const sel = props.getEditorSelection?.()?.trim()
    if (sel) {
      contextChips.value.push({ id: crypto.randomUUID(), label: '@error', content: `// Error output:\n\`\`\`\n${sel.slice(0, 5000)}\n\`\`\`` })
      inputText.value = 'Explain this error in plain English:\n1. What caused it (root cause)\n2. Why it happens (mechanism)\n3. How to fix it (concrete steps)\n4. How to prevent it in the future'
    } else {
      inputText.value = 'Explain this error and suggest a fix:\n\n```\n[Paste your error or stack trace here]\n```'
      await nextTick()
      textareaEl.value?.focus()
      const start = inputText.value.indexOf('[Paste')
      textareaEl.value?.setSelectionRange(start, start + '[Paste your error or stack trace here]'.length)
    }
    return
  }

  // /shortcuts — show all keyboard shortcuts
  if (cmd.id === '/shortcuts') {
    inputText.value = ''
    const shortcuts = [
      '**Chat**',
      'Enter — Send (default) · Ctrl+Enter in alt mode (toggle in Settings)',
      'Shift+Enter — New line in input',
      'Ctrl+L / Cmd+L — Focus chat input',
      'Ctrl+N / Cmd+N — New thread',
      'Ctrl+/ — Toggle thread sidebar',
      'Ctrl+F / Cmd+F — Search in current chat',
      'Ctrl+Shift+F — Search across all chats',
      'Ctrl+R — Prompt history reverse search (shell-style)',
      'Ctrl+Shift+H — Prompt history palette',
      'Escape — Stop streaming / close panel',
      'Tab — Accept @mention or /command from menu',
      'Up arrow — Edit last user message (inline)',
      '',
      '**Code blocks**',
      'Alt+E — Explain last hovered code block',
      'Alt+R — Refactor last hovered code block',
      'Alt+N — New chat with last hovered code block',
      'Alt+C — Compare last hovered code block',
      'Ctrl+Shift+C — Copy code block',
      '',
      '**Thread**',
      'Alt+[ / Alt+] — Jump to previous / next AI response',
      'Ctrl+Shift+M / Cmd+Shift+M — Copy thread as Markdown',
      'Ctrl+Shift+K — Clear current conversation',
      'Drag top edge of thread panel — Resize panel height',
      '',
      '**Editor**',
      'Ctrl+Shift+L / Cmd+Shift+L — Toggle AI pane',
      'Ctrl+P / Cmd+P — Quick open file',
      '',
      '**Context**',
      '@ — Open context menu (@file, @selection, @git, @web…)',
      '/ — Open command menu',
    ].join('\n')
    messages.value.push({ role: 'assistant', content: `## Keyboard Shortcuts\n\n${shortcuts}`, timestamp: Date.now() })
    return
  }

  // /lint:all — run linter on entire project
  if (cmd.id === '/lint:all') {
    inputText.value = ''
    if (!props.workspacePath) { showToast('/lint:all requires an open workspace'); return }
    try {
      showToast('Running project-wide lint…')
      interface ShellRespLA { ok: boolean; output?: string; error?: string }
      const [eslintResp, ruffResp] = await Promise.all([
        props.backend.send<ShellRespLA>('shell.run', { command: 'npx eslint . --format compact 2>&1 | head -80 || echo "(eslint not found)"', workspace_path: props.workspacePath }),
        props.backend.send<ShellRespLA>('shell.run', { command: 'python -m ruff check . 2>&1 | head -60 || echo "(ruff not found)"', workspace_path: props.workspacePath }),
      ])
      const eslintOut = (eslintResp.payload?.ok ? eslintResp.payload.output ?? '' : '').trim()
      const ruffOut = (ruffResp.payload?.ok ? ruffResp.payload.output ?? '' : '').trim()
      let combined = ''
      if (eslintOut && !eslintOut.includes('not found')) combined += `// ESLint:\n${eslintOut}\n`
      if (ruffOut && !ruffOut.includes('not found') && !ruffOut.includes('error:')) combined += `\n// Ruff:\n${ruffOut}\n`
      if (!combined.trim()) { showToast('/lint:all: no issues found'); return }
      contextChips.value = contextChips.value.filter((c) => c.label !== '@lint:all')
      contextChips.value.push({ id: crypto.randomUUID(), label: '@lint:all', content: combined.trim() })
      inputText.value = 'Analyze all the lint issues above. Group by severity, identify the most impactful problems to fix first, and provide specific fixes for the top 5 issues.'
    } catch { showToast('/lint:all: unavailable') }
    nextTick(() => { textareaEl.value?.focus() })
    return
  }

  // /compare:files <a> [b] — compare two files and explain differences
  if (cmd.id.startsWith('/compare:files')) {
    inputText.value = ''
    const argStr = cmd.id.replace('/compare:files', '').trim()
    const parts = argStr.split(/\s+/).filter(Boolean)
    if (!props.workspacePath) { showToast('/compare:files requires an open workspace'); return }
    const SAFE_PATH_CF = /^[A-Za-z0-9_./ -]+$/
    if (parts.length < 2) {
      const relPath = props.getActiveRelPath?.() ?? ''
      if (relPath) {
        inputText.value = `/compare:files ${relPath} `
      } else {
        inputText.value = '/compare:files '
        showToast('Usage: /compare:files <file-a> <file-b>')
      }
      await nextTick(); textareaEl.value?.focus()
      const len = inputText.value.length; textareaEl.value?.setSelectionRange(len, len)
      return
    }
    const [pathA, pathB] = parts.slice(0, 2)
    if (!SAFE_PATH_CF.test(pathA) || !SAFE_PATH_CF.test(pathB) || pathA.includes('..') || pathB.includes('..')) { showToast('/compare:files: invalid path'); return }
    try {
      interface FileRespCF extends ReadPayload {}
      const [aResp, bResp] = await Promise.all([
        props.backend.send<FileRespCF>('fs.read_file', { workspace_path: props.workspacePath, rel_path: pathA }),
        props.backend.send<FileRespCF>('fs.read_file', { workspace_path: props.workspacePath, rel_path: pathB }),
      ])
      const aContent = (aResp.payload as FileRespCF)?.content ?? ''
      const bContent = (bResp.payload as FileRespCF)?.content ?? ''
      if (!aContent && !bContent) { showToast('/compare:files: could not read files'); return }
      const extA = pathA.split('.').pop() ?? ''
      contextChips.value.push({
        id: crypto.randomUUID(), label: `@compare:${pathA.split('/').pop()}…${pathB.split('/').pop()}`,
        content: `// File A: ${pathA}\n\`\`\`${extA}\n${aContent.slice(0, 10000)}\n\`\`\`\n\n// File B: ${pathB}\n\`\`\`${extA}\n${bContent.slice(0, 10000)}\n\`\`\``,
      })
      inputText.value = `Compare ${pathA.split('/').pop()} and ${pathB.split('/').pop()}. Explain:\n1. Key differences in functionality and approach\n2. What each file is responsible for\n3. Which patterns or logic are duplicated\n4. Suggestions for refactoring if there is unnecessary duplication`
    } catch { showToast('/compare:files: unavailable') }
    nextTick(() => { textareaEl.value?.focus() })
    return
  }

  // /context:show — display all active context chips with sizes
  if (cmd.id === '/context:show') {
    inputText.value = ''
    if (!contextChips.value.length) { showToast('/context:show: no active context chips'); return }
    const lines = contextChips.value.map((c, i) => {
      const bytes = new TextEncoder().encode(c.content).length
      const kb = (bytes / 1024).toFixed(1)
      const preview = c.content.replace(/^\/\/[^\n]*\n/, '').slice(0, 60).replace(/\n/g, ' ')
      return `${i + 1}. **${c.label}** (${kb}KB) — ${preview}…`
    })
    const totalKb = (contextChips.value.reduce((s, c) => s + new TextEncoder().encode(c.content).length, 0) / 1024).toFixed(1)
    messages.value.push({
      role: 'assistant',
      content: `## Active Context (${contextChips.value.length} chips, ~${totalKb}KB total)\n\n${lines.join('\n')}\n\nUse the × on each chip to remove it, or type \`/context:clear\` to remove all.`,
      timestamp: Date.now(),
    })
    return
  }

  // /git:log:author <name> — commits by a specific author
  if (cmd.id.startsWith('/git:log:author')) {
    inputText.value = ''
    if (!props.workspacePath) { showToast('/git:log:author requires an open workspace'); return }
    const author = cmd.id.replace('/git:log:author', '').trim()
    if (!author) {
      inputText.value = '/git:log:author '
      await nextTick(); textareaEl.value?.focus()
      showToast('Usage: /git:log:author <name>')
      return
    }
    const SAFE_AUTHOR = /^[A-Za-z0-9_.@\- ]+$/
    if (!SAFE_AUTHOR.test(author)) { showToast('/git:log:author: invalid author name'); return }
    const sqAuthor = "'" + author.replace(/'/g, "'\\''") + "'"
    try {
      showToast(`Fetching commits by ${author}…`)
      interface ShellRespGLA { ok: boolean; output?: string; error?: string }
      const resp = await props.backend.send<ShellRespGLA>('shell.run', {
        command: `git log --author=${sqAuthor} --oneline -20 2>&1`,
        workspace_path: props.workspacePath,
      })
      if (!resp.payload?.ok) { showToast('/git:log:author: ' + (resp.payload?.error ?? 'backend error')); return }
      const out = (resp.payload.output ?? '').trim()
      if (!out || out.startsWith('fatal')) { showToast(`No commits found for author: ${author}`); return }
      contextChips.value.push({ id: crypto.randomUUID(), label: `@git:author:${author.split(' ')[0]}`, content: `// Commits by ${author}:\n${out}` })
      inputText.value = `Summarize the recent work by ${author} based on these commits. What have they been focused on? Any patterns or notable contributions?`
    } catch { showToast('/git:log:author: unavailable') }
    nextTick(() => { textareaEl.value?.focus() })
    return
  }

  // /resolve:conflict — guide through merge conflict resolution
  if (cmd.id === '/resolve:conflict') {
    inputText.value = ''
    const relPath = props.getActiveRelPath?.()
    const content = props.getEditorContent?.()
    if (!relPath || !content) { showToast('/resolve:conflict: no file open'); return }
    const hasConflict = content.includes('<<<<<<<') && content.includes('=======') && content.includes('>>>>>>>')
    if (!hasConflict) { showToast('/resolve:conflict: no conflict markers found in current file'); return }
    const ext = relPath.split('.').pop() ?? ''
    const fileName = relPath.split('/').pop()
    contextChips.value.push({ id: crypto.randomUUID(), label: `@${fileName}`, content: `// File with conflicts: ${relPath}\n\`\`\`${ext}\n${content.slice(0, 20000)}\n\`\`\`` })
    inputText.value = `Resolve the merge conflicts in ${fileName}. For each conflict section:\n1. Explain what each side (HEAD vs incoming) is trying to do\n2. Recommend which version to keep (or how to merge both)\n3. Show the resolved code\n\nAfter resolving all conflicts, show the complete resolved file.`
    nextTick(() => { textareaEl.value?.focus() })
    return
  }

  // /revert:edit — undo last AI-applied file change
  if (cmd.id === '/revert:edit') {
    inputText.value = ''
    if (!diffApplyState.value) { showToast('/revert:edit: no recent AI edit to revert'); return }
    const { relPath, oldContent } = diffApplyState.value
    if (!relPath || !oldContent || !props.workspacePath) { showToast('/revert:edit: cannot revert (no original content saved)'); return }
    try {
      interface WriteRespRE { ok?: boolean; error?: string }
      const resp = await props.backend.send<WriteRespRE>('fs.write_file', {
        workspace_path: props.workspacePath,
        rel_path: relPath,
        content: oldContent,
      })
      if ((resp.payload as WriteRespRE)?.ok === false) { showToast(`/revert:edit: ${(resp.payload as WriteRespRE).error ?? 'write failed'}`); return }
      diffApplyState.value = null
      showToast(`Reverted: ${relPath.split('/').pop()}`)
      messages.value.push({ role: 'assistant', content: `Reverted \`${relPath}\` to its pre-edit state.`, timestamp: Date.now() })
    } catch { showToast('/revert:edit: unavailable') }
    return
  }

  // /gen:test:e2e — generate Playwright/Cypress E2E tests
  if (cmd.id === '/gen:test:e2e') {
    inputText.value = ''
    const relPath = props.getActiveRelPath?.()
    const content = props.getEditorContent?.()
    const ext = relPath?.split('.').pop() ?? ''
    if (relPath && content) {
      contextChips.value.push({ id: crypto.randomUUID(), label: `@${relPath.split('/').pop()}`, content: `// Component/page: ${relPath}\n\`\`\`${ext}\n${content.slice(0, 15000)}\n\`\`\`` })
      inputText.value = `Generate comprehensive end-to-end (E2E) tests for ${relPath.split('/').pop()} using Playwright. Include:\n1. Happy path tests (main user flows)\n2. Error state tests (validation failures, network errors)\n3. Edge cases (empty states, boundary values)\n4. Accessibility checks (ARIA, keyboard navigation)\n\nUse Playwright's page object pattern. Return complete test file.`
    } else {
      inputText.value = 'Generate Playwright E2E tests for: '
      await nextTick(); textareaEl.value?.focus()
      const len = inputText.value.length; textareaEl.value?.setSelectionRange(len, len)
    }
    nextTick(() => { textareaEl.value?.focus() })
    return
  }

  // /hotfix — inject Problems panel + last test failures and ask AI to fix all at once
  if (cmd.id === '/hotfix') {
    inputText.value = ''
    const relPath = props.getActiveRelPath?.()
    const allDiags = allDiagnosticsSorted()
    const fileDiags = relPath ? allDiags.filter((d) => d.relPath === relPath) : allDiags
    const errors = fileDiags.filter((d) => d.severity === 'error').slice(0, 15)
    const warns = fileDiags.filter((d) => d.severity === 'warning').slice(0, 10)
    const diagContent = [...errors, ...warns].map((d) => `${d.relPath}:${d.line} [${d.severity}] ${d.message}`).join('\n')
    if (diagContent) {
      contextChips.value = contextChips.value.filter((c) => c.label !== '@errors')
      contextChips.value.push({ id: crypto.randomUUID(), label: '@errors', content: `// Diagnostics (${errors.length} errors, ${warns.length} warnings):\n${diagContent}` })
    }
    const fileContent = props.getEditorContent?.()
    const ext = relPath?.split('.').pop() ?? ''
    if (relPath && fileContent) {
      contextChips.value = contextChips.value.filter((c) => c.label !== `@${relPath.split('/').pop()}`)
      contextChips.value.push({ id: crypto.randomUUID(), label: `@${relPath.split('/').pop()}`, content: `// File: ${relPath}\n\`\`\`${ext}\n${fileContent.slice(0, 20000)}\n\`\`\`` })
    }
    if (!diagContent && !fileContent) { showToast('/hotfix: no errors found and no file open'); return }
    inputText.value = diagContent
      ? `Fix ALL the errors and warnings shown in @errors. For each issue:\n1. Quote the exact error\n2. Show the corrected code\n3. One-line explanation\n\nReturn the full corrected file when done.`
      : 'Find and fix all issues in this file. Look for type errors, logic bugs, and edge cases. Return the corrected file.'
    nextTick(() => { textareaEl.value?.focus() })
    return
  }

  // /review:all — comprehensive review: security + performance + style + correctness
  if (cmd.id === '/review:all') {
    inputText.value = ''
    const relPath = props.getActiveRelPath?.()
    const content = props.getEditorContent?.()
    const ext = relPath?.split('.').pop() ?? ''
    if (!relPath || !content) { showToast('/review:all: no file open'); return }
    contextChips.value = contextChips.value.filter((c) => c.label !== `@${relPath.split('/').pop()}`)
    contextChips.value.push({ id: crypto.randomUUID(), label: `@${relPath.split('/').pop()}`, content: `// File: ${relPath}\n\`\`\`${ext}\n${content.slice(0, 25000)}\n\`\`\`` })
    inputText.value = `Perform a comprehensive code review of ${relPath.split('/').pop()}. Review across 4 dimensions:\n\n**1. Correctness** — Logic bugs, off-by-one errors, null/undefined access, race conditions\n**2. Security** — Injection risks, unvalidated input, sensitive data exposure (OWASP Top 10)\n**3. Performance** — N+1 queries, unnecessary re-renders, O(n²) algorithms, memory leaks\n**4. Style & Maintainability** — Naming, complexity, DRY violations, missing error handling\n\nFor each issue: severity (Critical/High/Medium/Low), file:line, description, fix. Sort by severity.`
    nextTick(() => { textareaEl.value?.focus() })
    return
  }

  // /git:rebase — interactive rebase guidance
  if (cmd.id === '/git:rebase') {
    inputText.value = ''
    if (!props.workspacePath) { showToast('/git:rebase requires an open workspace'); return }
    try {
      showToast('Fetching commits…')
      interface ShellRespGR { ok: boolean; output?: string; error?: string }
      const [logResp, branchResp] = await Promise.all([
        props.backend.send<ShellRespGR>('shell.run', { command: 'git log --oneline -20 2>&1', workspace_path: props.workspacePath }),
        props.backend.send<ShellRespGR>('shell.run', { command: 'git branch --show-current 2>&1', workspace_path: props.workspacePath }),
      ])
      if (!logResp.payload?.ok) { showToast('/git:rebase: ' + (logResp.payload?.error ?? 'backend error')); return }
      const log = (logResp.payload.output ?? '').trim()
      const branch = (branchResp.payload?.ok ? branchResp.payload.output ?? '' : '').trim()
      contextChips.value.push({ id: crypto.randomUUID(), label: '@git:log', content: `// Current branch: ${branch}\n// Recent commits:\n${log}` })
      inputText.value = `Guide me through an interactive rebase on branch \'${branch}\'. Looking at these commits:\n1. Which commits could be squashed or fixup'd together?\n2. Are there any commit messages that need improvement?\n3. What is the exact \`git rebase -i HEAD~N\` command I should run?\n4. Walk me through each rebase action (pick, squash, fixup, reword, drop)\n\nExplain each step clearly for a developer who hasn't used interactive rebase before.`
    } catch { showToast('/git:rebase: unavailable') }
    nextTick(() => { textareaEl.value?.focus() })
    return
  }

  // /test:single <pattern> — run a specific test file or pattern
  if (cmd.id.startsWith('/test:single')) {
    inputText.value = ''
    if (!props.workspacePath) { showToast('/test:single requires an open workspace'); return }
    const pattern = cmd.id.replace('/test:single', '').trim()
    if (!pattern) {
      const relPath = props.getActiveRelPath?.() ?? ''
      inputText.value = `/test:single ${relPath || ''}`
      await nextTick(); textareaEl.value?.focus()
      showToast('Usage: /test:single <file or pattern>')
      return
    }
    const SAFE_PAT = /^[A-Za-z0-9_./ *?-]+$/
    if (!SAFE_PAT.test(pattern) || pattern.includes('..') || pattern.startsWith('-')) { showToast('/test:single: invalid pattern'); return }
    const sqPat = "'" + pattern.replace(/'/g, "'\\''") + "'"
    try {
      showToast(`Running test: ${pattern}…`)
      interface ShellRespTSR { ok: boolean; output?: string; exit_code?: number; error?: string }
      const hasPytest = await props.backend.send<ShellRespTSR>('fs.read_file', { workspace_path: props.workspacePath, rel_path: 'pytest.ini' }).catch(() => ({ payload: { ok: false } }))
      const isPy = pattern.endsWith('.py') || (hasPytest.payload as { ok?: boolean })?.ok
      const cmd2 = isPy
        ? `python3 -m pytest ${sqPat} -v --tb=short 2>&1 | tail -60`
        : `npx vitest run ${sqPat} 2>&1 | tail -60`
      const resp = await props.backend.send<ShellRespTSR>('shell.run', { command: cmd2, workspace_path: props.workspacePath })
      if (!resp.payload?.ok) { showToast('/test:single: ' + (resp.payload?.error ?? 'backend error')); return }
      const out = (resp.payload.output ?? '').trim()
      const exitCode = resp.payload?.exit_code ?? 0
      const status = exitCode === 0 ? '✓ Tests passed' : '✗ Tests failed'
      messages.value.push({ role: 'assistant', content: `${status} — \`${pattern}\`\n\`\`\`\n${out}\n\`\`\``, timestamp: Date.now() })
      if (exitCode !== 0) {
        contextChips.value.push({ id: crypto.randomUUID(), label: `@test:${pattern.split('/').pop()}`, content: `// Test failures in ${pattern}:\n${out.slice(0, 4000)}` })
        inputText.value = `Fix the test failures shown above in ${pattern}. For each failure: explain the root cause and show the fix.`
        nextTick(() => { textareaEl.value?.focus() })
      }
    } catch { showToast('/test:single: unavailable') }
    return
  }

  // /summarize:code — concise TL;DR of current file or selection
  if (cmd.id === '/summarize:code') {
    inputText.value = ''
    const sel = props.getEditorSelection?.()?.trim()
    const relPath = props.getActiveRelPath?.()
    const content = props.getEditorContent?.()
    const ext = relPath?.split('.').pop() ?? ''
    const target = sel || content?.slice(0, 20000) || ''
    if (!target) { showToast('/summarize:code: no file open or code selected'); return }
    const label = sel ? '@selection' : relPath ? `@${relPath.split('/').pop()}` : '@code'
    contextChips.value.push({
      id: crypto.randomUUID(), label,
      content: sel
        ? `// Selection from: ${relPath}\n\`\`\`${ext}\n${sel}\n\`\`\``
        : `// File: ${relPath}\n\`\`\`${ext}\n${target}\n\`\`\``,
    })
    inputText.value = sel
      ? 'In 2-3 sentences, summarize what this code does. Then list: inputs, outputs, and any side effects.'
      : `Summarize ${relPath?.split('/').pop() ?? 'this file'} in 3-5 sentences. Cover: purpose, main responsibilities, key dependencies, and any important patterns or caveats.`
    nextTick(() => { textareaEl.value?.focus() })
    return
  }

  // /agent:task — break complex task into steps and execute sequentially
  if (cmd.id.startsWith('/agent:task')) {
    inputText.value = ''
    const taskDesc = cmd.id.replace('/agent:task', '').trim()
    const relPath = props.getActiveRelPath?.()
    if (relPath && props.workspacePath) {
      try {
        interface FlatRespAT { ok: boolean; files?: string[]; error?: string }
        const r = await props.backend.send<FlatRespAT>('fs.list_files_flat', { workspace_path: props.workspacePath, query: '' })
        const files = (r.payload?.files ?? []).slice(0, 100)
        if (files.length && !contextChips.value.some((c) => c.label === '@tree')) {
          contextChips.value.push({ id: crypto.randomUUID(), label: '@tree', content: `// Project file tree:\n${buildFileTree(files)}` })
        }
      } catch { /* best effort */ }
    }
    const taskText = taskDesc || '[describe your task here]'
    inputText.value = `Act as an autonomous agent for the following task:\n\n**Task:** ${taskText}\n\n1. First, analyze the task and break it into 3-7 concrete steps\n2. For each step, describe exactly what code/files need to change\n3. Execute each step in order, showing complete code for each change\n4. After all steps, confirm what was done and what to test\n\nStart with the step breakdown before writing any code.`
    await nextTick(); textareaEl.value?.focus()
    if (!taskDesc) {
      const start = inputText.value.indexOf('[describe your task here]')
      textareaEl.value?.setSelectionRange(start, start + '[describe your task here]'.length)
    }
    return
  }

  // /coverage:report — run full project coverage and show summary table
  if (cmd.id === '/coverage:report') {
    inputText.value = ''
    if (!props.workspacePath) { showToast('/coverage:report requires an open workspace'); return }
    try {
      showToast('Running project coverage…')
      interface ShellRespCR { ok: boolean; output?: string; exit_code?: number; error?: string }
      const hasPyproject = await props.backend.send<ShellRespCR>('fs.read_file', { workspace_path: props.workspacePath, rel_path: 'pyproject.toml' }).catch(() => ({ payload: { ok: false, content: '' } }))
      const isPy = (hasPyproject.payload as { ok?: boolean; content?: string })?.content?.includes('[tool.pytest') ?? false
      const covCmd = isPy
        ? 'python3 -m pytest --cov=. --cov-report=term-missing -q 2>&1 | tail -50'
        : 'npx vitest run --reporter=verbose --coverage 2>&1 | tail -50 || npx jest --coverage 2>&1 | tail -50'
      const resp = await props.backend.send<ShellRespCR>('shell.run', { command: covCmd, workspace_path: props.workspacePath })
      const out = (resp.payload?.output ?? '').trim()
      if (!out) { showToast('/coverage:report: no output'); return }
      contextChips.value.push({ id: crypto.randomUUID(), label: '@coverage', content: `// Coverage report:\n\`\`\`\n${out}\n\`\`\`` })
      inputText.value = 'Analyze this coverage report. Identify: 1) files with < 60% coverage, 2) the most important uncovered code paths, 3) suggest which tests to write first to get the biggest coverage improvement.'
    } catch { showToast('/coverage:report: unavailable') }
    nextTick(() => { textareaEl.value?.focus() })
    return
  }

  // /thread:stats — statistics for current thread
  if (cmd.id === '/thread:stats') {
    inputText.value = ''
    const thread = allThreads.value.find((t) => t.id === currentThreadId.value)
    if (!thread) { showToast('/thread:stats: no active thread'); return }
    const msgs = thread.messages
    const userCount = msgs.filter((m) => m.role === 'user').length
    const assistantCount = msgs.filter((m) => m.role === 'assistant').length
    const totalChars = msgs.reduce((s, m) => s + (m.content?.length ?? 0), 0)
    const estimatedTokens = Math.round(totalChars / 4)
    const oldest = msgs[0]?.timestamp
    const newest = msgs[msgs.length - 1]?.timestamp
    const durationMs = oldest && newest ? newest - oldest : 0
    const durationMin = Math.round(durationMs / 60000)
    const lines = [
      `## Thread Statistics`,
      `**Title:** ${thread.title}`,
      `**Messages:** ${msgs.length} total (${userCount} user, ${assistantCount} AI)`,
      `**Estimated tokens:** ~${estimatedTokens.toLocaleString()} (${Math.round(estimatedTokens / currentModelCtx.value * 100)}% of context)`,
      `**Duration:** ${durationMin > 0 ? `${durationMin} min` : 'less than a minute'}`,
      `**Model:** ${thread.model ?? settingsModel}`,
      `**Context chips:** ${contextChips.value.length}`,
      thread.pinned ? `**Pinned:** yes` : '',
      thread.archived ? `**Archived:** yes` : '',
    ].filter(Boolean)
    messages.value.push({ role: 'assistant', content: lines.join('\n'), timestamp: Date.now() })
    return
  }

  // /lint:fix:auto — run auto-fixable lint fixes
  if (cmd.id === '/lint:fix:auto') {
    inputText.value = ''
    if (!props.workspacePath) { showToast('/lint:fix:auto requires an open workspace'); return }
    try {
      showToast('Running auto-fix…')
      interface ShellRespLFA { ok: boolean; output?: string; error?: string }
      const rawPath = props.getActiveRelPath?.() ?? ''
      const SAFE_PATH = /^[A-Za-z0-9_./ -]+$/
      const safeRelPath = SAFE_PATH.test(rawPath) && !rawPath.includes('..') && !rawPath.startsWith('-') ? rawPath : ''
      const sqPath = safeRelPath.replace(/'/g, "'\\''")
      const eslintFixCmd = safeRelPath
        ? `npx eslint --fix '${sqPath}' 2>&1 | head -30 || echo "(eslint not available)"`
        : `npx eslint --fix . 2>&1 | head -30 || echo "(eslint not available)"`
      const ruffFixCmd = safeRelPath && safeRelPath.endsWith('.py')
        ? `python -m ruff check --fix '${sqPath}' 2>&1 | head -20 || echo "(ruff not available)"`
        : `python -m ruff check --fix . 2>&1 | head -20 || echo "(ruff not available)"`
      const [eslintResp, ruffResp] = await Promise.all([
        props.backend.send<ShellRespLFA>('shell.run', { command: eslintFixCmd, workspace_path: props.workspacePath }),
        props.backend.send<ShellRespLFA>('shell.run', { command: ruffFixCmd, workspace_path: props.workspacePath }),
      ])
      const eslintOut = (eslintResp.payload?.output ?? '').trim()
      const ruffOut = (ruffResp.payload?.output ?? '').trim()
      let combined = ''
      if (eslintOut && !eslintOut.includes('not available')) combined += `ESLint:\n${eslintOut}\n`
      if (ruffOut && !ruffOut.includes('not available') && !ruffOut.includes('error:')) combined += `\nRuff:\n${ruffOut}\n`
      if (!combined.trim()) {
        messages.value.push({ role: 'assistant', content: '✓ No auto-fixable lint issues found.', timestamp: Date.now() })
      } else {
        contextChips.value.push({ id: crypto.randomUUID(), label: '@lint:fixed', content: `// Auto-fix output:\n${combined.trim()}` })
        inputText.value = 'Review what the auto-fix changed. Are there any remaining issues that need manual attention?'
        nextTick(() => { textareaEl.value?.focus() })
      }
    } catch { showToast('/lint:fix:auto: unavailable') }
    return
  }

  // /note:add <text> — quickly append a note to the active notepad
  if (cmd.id.startsWith('/note:add')) {
    inputText.value = ''
    const noteText = cmd.id.replace('/note:add', '').trim()
    if (!noteText) {
      inputText.value = '/note:add '
      await nextTick(); textareaEl.value?.focus()
      showToast('Usage: /note:add <text to save>')
      return
    }
    const activeNotepad = namedNotepads.value[0]
    if (!activeNotepad) {
      // Create a new notepad if none exist
      const newNp = { id: crypto.randomUUID(), name: 'Notes', content: `- ${noteText}`, updatedAt: Date.now() }
      namedNotepads.value.unshift(newNp)
      saveNamedNotepads()
      showToast(`Note added to new notepad "Notes"`)
    } else {
      activeNotepad.content = activeNotepad.content + `\n- ${noteText}`
      activeNotepad.updatedAt = Date.now()
      saveNamedNotepads()
      showToast(`Note added to "${activeNotepad.name}"`)
    }
    return
  }

  // /gen:table <description> — generate markdown table
  if (cmd.id.startsWith('/gen:table')) {
    inputText.value = ''
    const tableDesc = cmd.id.replace('/gen:table', '').trim()
    if (!tableDesc) {
      inputText.value = '/gen:table '
      await nextTick(); textareaEl.value?.focus()
      showToast('Usage: /gen:table <description> (e.g. /gen:table API endpoints with method, path, description)')
      return
    }
    inputText.value = `Generate a well-formatted markdown table for: ${tableDesc}

Requirements:
- Include a header row with clear column names
- Align columns appropriately (use :--- for left, ---: for right, :---: for center)
- Include at least 5 realistic example rows
- Keep cells concise but informative

Return only the markdown table.`
    nextTick(() => { textareaEl.value?.focus() })
    return
  }

  // /format:json — pretty-print / validate JSON in selection or file
  if (cmd.id === '/format:json') {
    inputText.value = ''
    const sel = props.getEditorSelection?.()?.trim()
    const relPath = props.getActiveRelPath?.()
    const content = props.getEditorContent?.()
    const target = sel || content?.slice(0, 50000) || ''
    if (!target) { showToast('/format:json: no selection or file open'); return }
    // Try to parse inline first
    try {
      const parsed = JSON.parse(target)
      const pretty = JSON.stringify(parsed, null, 2)
      const label = sel ? '@selection' : relPath ? `@${relPath.split('/').pop()}` : '@json'
      contextChips.value.push({ id: crypto.randomUUID(), label, content: `// JSON content:\n\`\`\`json\n${target.slice(0, 20000)}\n\`\`\`` })
      inputText.value = `Format and validate this JSON. Return the prettified version in a code block. Also note any structural issues or potential problems.\n\nPretty-printed preview (${pretty.split('\n').length} lines):\n\`\`\`json\n${pretty.slice(0, 500)}…\n\`\`\``
    } catch {
      // Not valid JSON — ask AI to fix it
      const label = sel ? '@selection' : '@json'
      contextChips.value.push({ id: crypto.randomUUID(), label, content: `// JSON to fix:\n\`\`\`json\n${target.slice(0, 20000)}\n\`\`\`` })
      inputText.value = 'This JSON is invalid. Find and fix the syntax errors, then return the corrected prettified JSON in a code block. Explain what was wrong.'
    }
    nextTick(() => { textareaEl.value?.focus() })
    return
  }

  // /git:stash:apply [index] — apply a git stash
  if (cmd.id.startsWith('/git:stash:apply')) {
    inputText.value = ''
    if (!props.workspacePath) { showToast('/git:stash:apply requires an open workspace'); return }
    const idxArg = cmd.id.replace('/git:stash:apply', '').trim()
    try {
      showToast('Fetching stash list…')
      interface ShellRespGSA { ok: boolean; output?: string; exit_code?: number; error?: string }
      const listResp = await props.backend.send<ShellRespGSA>('shell.run', { command: 'git stash list 2>&1', workspace_path: props.workspacePath })
      const stashList = (listResp.payload?.output ?? '').trim()
      if (!stashList) { showToast('/git:stash:apply: no stashes found'); return }
      contextChips.value.push({ id: crypto.randomUUID(), label: '@git:stash', content: `// Git stashes:\n${stashList}` })
      if (idxArg && /^\d+$/.test(idxArg)) {
        const applyResp = await props.backend.send<ShellRespGSA>('shell.run', { command: `git stash apply stash@{${idxArg}} 2>&1`, workspace_path: props.workspacePath })
        const applyOut = (applyResp.payload?.output ?? '').trim()
        const exitCode = applyResp.payload?.exit_code ?? 0
        messages.value.push({ role: 'assistant', content: exitCode === 0 ? `✓ Applied stash@{${idxArg}}\n\`\`\`\n${applyOut}\n\`\`\`` : `✗ Failed to apply stash@{${idxArg}}\n\`\`\`\n${applyOut}\n\`\`\``, timestamp: Date.now() })
      } else {
        inputText.value = `I have these stashes. I want to apply the most recent one (stash@{0}):\n\n\`\`\`\n${stashList}\n\`\`\`\n\nWhat changes will be applied? Are there any potential conflicts with my current working tree?`
        nextTick(() => { textareaEl.value?.focus() })
      }
    } catch { showToast('/git:stash:apply: unavailable') }
    return
  }

  // /doc:project — generate project-level documentation
  if (cmd.id === '/doc:project') {
    inputText.value = ''
    if (!props.workspacePath) { showToast('/doc:project requires an open workspace'); return }
    try {
      showToast('Reading project structure…')
      interface FlatRespDP { ok: boolean; files?: string[]; error?: string }
      const [filesResp, pkgResp, readmeResp] = await Promise.all([
        props.backend.send<FlatRespDP>('fs.list_files_flat', { workspace_path: props.workspacePath, query: '' }),
        props.backend.send<FlatRespDP>('fs.read_file', { workspace_path: props.workspacePath, rel_path: 'package.json' }).catch(() => ({ payload: { ok: false } })),
        props.backend.send<FlatRespDP>('fs.read_file', { workspace_path: props.workspacePath, rel_path: 'README.md' }).catch(() => ({ payload: { ok: false } })),
      ])
      const files = ((filesResp.payload as { files?: string[] })?.files ?? []).slice(0, 200)
      const tree = buildFileTree(files)
      const pkg = (pkgResp.payload as { ok?: boolean; content?: string })?.content ?? ''
      const readme = (readmeResp.payload as { ok?: boolean; content?: string })?.content ?? ''
      let ctx = `// Project file tree:\n${tree}`
      if (pkg) ctx += `\n\n// package.json:\n${pkg.slice(0, 2000)}`
      if (readme) ctx += `\n\n// README.md:\n${readme.slice(0, 3000)}`
      contextChips.value = contextChips.value.filter((c) => c.label !== '@tree')
      contextChips.value.push({ id: crypto.randomUUID(), label: '@tree', content: ctx })
      inputText.value = 'Generate comprehensive project documentation covering:\n1. **Architecture overview** — how the major parts fit together\n2. **Module breakdown** — purpose of each major directory/module\n3. **Data flow** — how data moves through the system\n4. **Key dependencies** — what external libraries are used and why\n5. **Developer setup** — how to run/test/build the project\n\nUse clear headings and include a Mermaid diagram for the architecture.'
    } catch { showToast('/doc:project: unavailable') }
    nextTick(() => { textareaEl.value?.focus() })
    return
  }

  inputText.value = cmd.template + ' '

  // Auto-inject context for code-focused commands when no chip exists yet.
  // Prefer the editor selection (more targeted) over the full file.
  const CODE_CMDS = new Set(['/explain', '/fix', '/tests', '/doc', '/review', '/optimize', '/refactor', '/debug', '/improve', '/perf', '/security', '/types', '/mock', '/diagram', '/migrate'])
  if (CODE_CMDS.has(cmd.id) && contextChips.value.length === 0) {
    const relPath = props.getActiveRelPath?.()
    const ext = relPath?.split('.').pop() ?? ''
    const sel = props.getEditorSelection?.()
    if (sel?.trim()) {
      contextChips.value.push({
        id: crypto.randomUUID(),
        label: '@selection',
        content: relPath
          ? `// Selection from: ${relPath}\n\`\`\`${ext}\n${sel.trim()}\n\`\`\``
          : `// Selected code:\n\`\`\`\n${sel.trim()}\n\`\`\``,
      })
    } else {
      const content = props.getEditorContent?.()
      if (relPath && content !== undefined) {
        const label = `@${relPath.split('/').pop()}`
        if (!contextChips.value.some((c) => c.label === label)) {
          contextChips.value.push({
            id: crypto.randomUUID(),
            label,
            content: `// File: ${relPath}\n\`\`\`${ext}\n${content}\n\`\`\``,
          })
        }
      }
    }
    // For /fix and /debug, also inject diagnostics for the current file (VS Code parity)
    if ((cmd.id === '/fix' || cmd.id === '/debug') && relPath) {
      const fileDiags = allDiagnosticsSorted().filter((d) => d.relPath === relPath)
      if (fileDiags.length > 0) {
        const diagLines = fileDiags.slice(0, 20).map(
          (d) => `${d.line}${d.col ? ':' + d.col : ''} [${d.severity}] ${d.message}${d.source ? ' (' + d.source + ')' : ''}`,
        )
        contextChips.value.push({
          id: crypto.randomUUID(),
          label: '@errors',
          content: `// Diagnostics in ${relPath} (${fileDiags.length} issue${fileDiags.length === 1 ? '' : 's'}):\n${diagLines.join('\n')}`,
        })
        // Overwrite the generic template with a diagnostics-aware prompt
        const errCount = fileDiags.filter((d) => d.severity === 'error').length
        const warnCount = fileDiags.filter((d) => d.severity === 'warning').length
        inputText.value = errCount > 0
          ? `Fix the ${errCount} error${errCount > 1 ? 's' : ''} shown in @errors. For each, show the corrected code and a one-line explanation.`
          : `Fix the ${warnCount} warning${warnCount > 1 ? 's' : ''} shown in @errors.`
      }
    }
  }

  // /improve:prompt — AI rewrites the current draft input
  if (cmd.id === '/improve:prompt') {
    const draft = inputText.value.trim()
    if (!draft) { showToast('Type a draft message first, then use /improve:prompt'); return }
    inputText.value = ''
    addMsg({ role: 'user', content: `[improve:prompt] Rewrite and improve the following AI chat prompt for better clarity and results. Return ONLY the improved prompt text, no explanation:\n\n${draft}` })
    void sendToBackend()
    return
  }

  // /explain:file [path] — explain what a file does
  if (cmd.id === '/explain:file' || cmd.id.startsWith('/explain:file ')) {
    const argPath = cmd.id.startsWith('/explain:file ') ? cmd.id.slice('/explain:file '.length).trim() : ''
    inputText.value = ''
    const targetPath = argPath || props.getActiveRelPath?.() || ''
    if (!targetPath) { showToast('/explain:file: no file open or specified'); return }
    const SAFE_PATH = /^[A-Za-z0-9_./ -]+$/
    if (!SAFE_PATH.test(targetPath) || targetPath.includes('..')) { showToast('Invalid file path'); return }
    ;(async () => {
      try {
        const res = await legacyInvoke('fs.read_file', { path: targetPath })
        const content = typeof res === 'string' ? res : (res as { content?: string })?.content ?? ''
        const preview = content.length > 6000 ? content.slice(0, 6000) + '\n…[truncated]' : content
        addMsg({ role: 'user', content: `Explain what the file \`${targetPath}\` does. Here is its content:
\`\`\`
${preview}
\`\`\`` })
        void sendToBackend()
      } catch { showToast(`Cannot read file: ${targetPath}`) }
    })()
    return
  }

  // /git:log:file [path] — git log for a specific file
  if (cmd.id === '/git:log:file' || cmd.id.startsWith('/git:log:file ')) {
    const argPath = cmd.id.startsWith('/git:log:file ') ? cmd.id.slice('/git:log:file '.length).trim() : ''
    inputText.value = ''
    const targetPath = argPath || props.getActiveRelPath?.() || ''
    if (!targetPath) { showToast('/git:log:file: no file open or specified'); return }
    const SAFE_PATH = /^[A-Za-z0-9_./ -]+$/
    if (!SAFE_PATH.test(targetPath) || targetPath.includes('..')) { showToast('Invalid file path'); return }
    ;(async () => {
      try {
        const safeQ = targetPath.replace(/'/g, "'\''")
        const res = await legacyInvoke('shell.run', { cmd: `git log --oneline --follow -20 -- '${safeQ}'` })
        const log = (res as { stdout?: string })?.stdout?.trim() || '(no commits found)'
        addMsg({ role: 'user', content: `Here is the git log for \`${targetPath}\` (last 20 commits):
\`\`\`
${log}
\`\`\`
Summarise the change history and explain the purpose of recent changes.` })
        void sendToBackend()
      } catch { showToast('git log failed') }
    })()
    return
  }

  // /gen:env — scan codebase for env var usage, generate .env.example
  if (cmd.id === '/gen:env') {
    inputText.value = ''
    ;(async () => {
      try {
        const res = await legacyInvoke('shell.run', { cmd: "grep -rh --include='*.ts' --include='*.tsx' --include='*.vue' --include='*.py' --include='*.js' -o 'process\.env\.[A-Z_][A-Z0-9_]*\|os\.environ\[[^]]*\]\|os\.getenv([^)]*)' . 2>/dev/null | sort -u | head -80" })
        const raw = (res as { stdout?: string })?.stdout?.trim() || ''
        addMsg({ role: 'user', content: `I scanned my codebase for environment variable usage and found:
\`\`\`
${raw || '(none found)'}
\`\`\`
Please generate a well-commented \`.env.example\` file that documents all these variables with placeholder values and helpful comments for each one.` })
        void sendToBackend()
      } catch { showToast('env scan failed') }
    })()
    return
  }

  // /ask:selection [question] — ask about editor selection
  if (cmd.id === '/ask:selection' || cmd.id.startsWith('/ask:selection ')) {
    const question = cmd.id.startsWith('/ask:selection ') ? cmd.id.slice('/ask:selection '.length).trim() : 'Explain this code'
    inputText.value = ''
    ;(async () => {
      try {
        const selRes = await legacyInvoke('editor.get_selection', {})
        const sel = (selRes as { text?: string; file?: string })
        const selText = sel?.text?.trim() || ''
        if (!selText) { showToast('/ask:selection: no text selected in editor'); return }
        const filePart = sel?.file ? ` (from \`${sel.file}\`)` : ''
        addMsg({ role: 'user', content: `${question}

Selected code${filePart}:
\`\`\`
${selText.slice(0, 8000)}
\`\`\`` })
        void sendToBackend()
      } catch {
        showToast('/ask:selection requires editor selection support')
      }
    })()
    return
  }

  // /debug:console — paste console output for AI interpretation
  if (cmd.id === '/debug:console') {
    inputText.value = ''
    const termBuf = settingsGet<string>('ai-chat-terminal-buffer', '') || ''
    const preview = termBuf ? termBuf.slice(-4000) : ''
    if (preview) {
      addMsg({ role: 'user', content: `Here is recent console/terminal output. Please interpret the errors and suggest fixes:
\`\`\`
${preview}
\`\`\`` })
      void sendToBackend()
    } else {
      inputText.value = `[debug:console] Paste console output / log lines here, then press Enter for AI interpretation and fix suggestions:\n\n`
      nextTick(() => { textareaEl.value?.focus() })
    }
    return
  }

  // /convert:types — convert between type systems
  if (cmd.id === '/convert:types') {
    inputText.value = `[convert:types] Paste the type definition to convert (e.g. Zod schema → TypeScript interface, Pydantic model → TypeScript, JSON Schema → types):\n\n`
    nextTick(() => { textareaEl.value?.focus() })
    return
  }

  // Helper: inject current file content as a context chip and return { relPath, ext }
  // Used by many file-aware commands below
  function _injectCurrentFile(): { relPath: string; ext: string } | null {
    const relPath = props.getActiveRelPath?.()
    const content = props.getEditorContent?.()
    if (!relPath || !content) return null
    const ext = relPath.split('.').pop() ?? ''
    const label = `@${relPath.split('/').pop()}`
    if (!contextChips.value.some((c) => c.label === label)) {
      contextChips.value.push({ id: crypto.randomUUID(), label, content: `// File: ${relPath}\n\`\`\`${ext}\n${content.slice(0, 12000)}\n\`\`\`` })
    }
    return { relPath, ext }
  }

  // /diagram — generate a Mermaid diagram
  if (cmd.id === '/diagram') {
    const file = _injectCurrentFile()
    inputText.value = file
      ? `Generate a Mermaid diagram that visualizes the structure of \`${file.relPath.split('/').pop()}\`. Use a flowchart or class diagram depending on what best represents the code. Return only the Mermaid code block.`
      : 'Generate a Mermaid diagram that visualizes the architecture of this project. Use a flowchart or component diagram.'
    nextTick(() => { textareaEl.value?.focus() })
    return
  }

  // /doc — write documentation for current file
  if (cmd.id === '/doc') {
    const file = _injectCurrentFile()
    if (!file) { showToast('/doc: no file open'); return }
    inputText.value = `Write clear, concise documentation for the exported symbols in \`${file.relPath.split('/').pop()}\`. Include: purpose, parameters, return values, and usage examples. Use JSDoc format for TypeScript or docstrings for Python.`
    nextTick(() => { textareaEl.value?.focus() })
    return
  }

  // /explain — explain the current file
  if (cmd.id === '/explain') {
    const file = _injectCurrentFile()
    if (!file) { showToast('/explain: no file open'); return }
    inputText.value = `Explain what \`${file.relPath.split('/').pop()}\` does. Cover: purpose, key functions/components, data flow, and any non-obvious design decisions.`
    void sendMessage()
    return
  }

  // /improve — suggest improvements for current file
  if (cmd.id === '/improve') {
    const file = _injectCurrentFile()
    if (!file) { showToast('/improve: no file open'); return }
    inputText.value = `Suggest concrete improvements for \`${file.relPath.split('/').pop()}\`. Cover: code quality, performance, readability, error handling, and test coverage. Prioritise by impact.`
    void sendMessage()
    return
  }

  // /migrate — suggest migration steps
  if (cmd.id === '/migrate') {
    inputText.value = 'Provide a step-by-step migration plan for: '
    nextTick(() => { textareaEl.value?.focus(); const l = inputText.value.length; textareaEl.value?.setSelectionRange(l, l) })
    return
  }

  // /mock — generate mocks/stubs
  if (cmd.id === '/mock') {
    const file = _injectCurrentFile()
    inputText.value = file
      ? `Generate complete test mocks and stubs for the classes, interfaces, and functions in \`${file.relPath.split('/').pop()}\`. Use the appropriate mock library for the language/framework.`
      : 'Generate complete test mocks and stubs for: '
    nextTick(() => { textareaEl.value?.focus() })
    return
  }

  // /optimize — performance optimization for current file
  if (cmd.id === '/optimize') {
    const file = _injectCurrentFile()
    if (!file) { showToast('/optimize: no file open'); return }
    inputText.value = `Analyze \`${file.relPath.split('/').pop()}\` for performance bottlenecks. Identify the top 3 issues, explain why each is slow, and provide optimized replacement code.`
    void sendMessage()
    return
  }

  // /perf — performance bottleneck analysis
  if (cmd.id === '/perf') {
    const file = _injectCurrentFile()
    if (!file) { showToast('/perf: no file open'); return }
    inputText.value = `Analyze \`${file.relPath.split('/').pop()}\` for performance bottlenecks: memory allocations, unnecessary re-renders, N+1 queries, blocking operations, and algorithmic complexity issues. List each with a severity rating and suggested fix.`
    void sendMessage()
    return
  }

  // /refactor — refactor current file
  if (cmd.id === '/refactor') {
    const file = _injectCurrentFile()
    if (!file) { showToast('/refactor: no file open'); return }
    inputText.value = `Refactor \`${file.relPath.split('/').pop()}\` to improve readability and maintainability without changing functionality. Focus on: naming, function size, single responsibility, and removing duplication.`
    nextTick(() => { textareaEl.value?.focus() })
    return
  }

  // /review — code review for current file
  if (cmd.id === '/review') {
    const file = _injectCurrentFile()
    if (!file) { showToast('/review: no file open'); return }
    inputText.value = `Review \`${file.relPath.split('/').pop()}\` as if in a pull request. Check for: bugs, edge cases, security issues, performance problems, missing error handling, and style violations. Be specific about line numbers.`
    void sendMessage()
    return
  }

  // /security — security audit for current file
  if (cmd.id === '/security') {
    const file = _injectCurrentFile()
    if (!file) { showToast('/security: no file open'); return }
    inputText.value = `Perform a security audit on \`${file.relPath.split('/').pop()}\`. Check for: injection vulnerabilities, authentication/authorization flaws, sensitive data exposure, insecure dependencies, and OWASP Top 10 issues. Rate each finding by severity.`
    void sendMessage()
    return
  }

  // /tests — generate tests for current file
  if (cmd.id === '/tests') {
    const file = _injectCurrentFile()
    if (!file) { showToast('/tests: no file open'); return }
    inputText.value = `Write comprehensive unit tests for \`${file.relPath.split('/').pop()}\`. Cover: happy paths, edge cases, error conditions, and boundary values. Use the existing test framework and follow the project's test patterns.`
    nextTick(() => { textareaEl.value?.focus() })
    return
  }

  // /types — generate/improve TypeScript types for current file
  if (cmd.id === '/types') {
    const file = _injectCurrentFile()
    if (!file) { showToast('/types: no file open'); return }
    inputText.value = `Generate comprehensive TypeScript type definitions for \`${file.relPath.split('/').pop()}\`. Add explicit return types, parameter types, and interface definitions where missing. Avoid \`any\`. Return the full updated file.`
    nextTick(() => { textareaEl.value?.focus() })
    return
  }

  // /new — create a new file
  if (cmd.id === '/new') {
    inputText.value = 'Create a new file: '
    showToast('Describe the file to create (e.g. "Create a new file: src/utils/format.ts that formats dates")')
    nextTick(() => { textareaEl.value?.focus(); const l = inputText.value.length; textareaEl.value?.setSelectionRange(l, l) })
    return
  }

  // /fix:types — run vue-tsc, inject errors, ask AI to fix
  if (cmd.id === '/fix:types') {
    inputText.value = ''
    ;(async () => {
      showToast('Running type checker…')
      try {
        const res = await legacyInvoke('shell.run', { cmd: 'npx vue-tsc --noEmit 2>&1 | head -80' })
        const out = ((res as { stdout?: string })?.stdout ?? '').trim()
        if (!out || out.toLowerCase().includes('found 0 errors')) {
          showToast('No TypeScript errors found!')
          addMsg({ role: 'user', content: 'TypeScript type checker reported no errors. The codebase is type-safe.' })
        } else {
          contextChips.value.push({ id: crypto.randomUUID(), label: '@ts:errors', content: `// vue-tsc --noEmit output:\n${out.slice(0, 6000)}` })
          addMsg({ role: 'user', content: `Fix all TypeScript type errors shown in @ts:errors. For each error, show the corrected code and a one-line explanation of the fix.` })
        }
        void sendToBackend()
      } catch { showToast('/fix:types: type checker unavailable') }
    })()
    return
  }

  // /explain:regex — explain a regular expression
  if (cmd.id === '/explain:regex') {
    const draft = inputText.value.replace('/explain:regex', '').trim()
    if (draft) {
      inputText.value = ''
      addMsg({ role: 'user', content: `Explain this regular expression in plain language, breaking down each part:\n\n\`${draft}\`\n\nInclude: what it matches, what it rejects, and real-world examples.` })
      void sendToBackend()
    } else {
      inputText.value = '/explain:regex '
      showToast('Paste your regex after /explain:regex and press Enter')
      nextTick(() => { textareaEl.value?.focus(); const l = inputText.value.length; textareaEl.value?.setSelectionRange(l, l) })
    }
    return
  }

  // /mock:data — generate mock/test data for a TS type or schema
  if (cmd.id === '/mock:data') {
    const draft = inputText.value.replace('/mock:data', '').trim()
    if (draft) {
      inputText.value = ''
      addMsg({ role: 'user', content: `Generate realistic mock/test data for the following TypeScript type or schema. Return 3–5 varied example instances as a TypeScript array or JSON:\n\n\`\`\`\n${draft}\n\`\`\`` })
      void sendToBackend()
    } else {
      inputText.value = '/mock:data '
      showToast('Paste a TypeScript interface or Pydantic model after /mock:data')
      nextTick(() => { textareaEl.value?.focus(); const l = inputText.value.length; textareaEl.value?.setSelectionRange(l, l) })
    }
    return
  }

  // /find:dead:code — find unused code in codebase
  if (cmd.id === '/find:dead:code') {
    inputText.value = ''
    ;(async () => {
      showToast('Scanning for dead code…')
      try {
        const tsRes = await legacyInvoke('shell.run', { cmd: "npx ts-prune 2>/dev/null | head -60 || grep -rn 'TODO.*remove\\|FIXME.*unused\\|@deprecated' --include='*.ts' --include='*.vue' --include='*.tsx' . 2>/dev/null | head -40" })
        const out = ((tsRes as { stdout?: string })?.stdout ?? '').trim()
        if (out) {
          contextChips.value.push({ id: crypto.randomUUID(), label: '@dead:code', content: `// Potential dead code scan results:\n${out.slice(0, 5000)}` })
          addMsg({ role: 'user', content: 'Review the dead code scan results in @dead:code. Identify which are genuinely unused, explain the risk of removing each, and suggest safe removal order.' })
        } else {
          addMsg({ role: 'user', content: 'Scan this codebase for dead code: unused exports, unreachable functions, orphaned utilities, and variables that are declared but never used. List findings by file with line numbers and explain why each is dead.' })
        }
        void sendToBackend()
      } catch { showToast('/find:dead:code: scan failed') }
    })()
    return
  }

  // /deps:outdated — check for outdated packages
  if (cmd.id === '/deps:outdated') {
    inputText.value = ''
    ;(async () => {
      showToast('Checking outdated packages…')
      try {
        const [npmRes, pipRes] = await Promise.allSettled([
          legacyInvoke('shell.run', { cmd: 'npm outdated --json 2>/dev/null || npm outdated 2>/dev/null | head -40' }),
          legacyInvoke('shell.run', { cmd: 'backend/.venv/bin/pip list --outdated 2>/dev/null | head -30' }),
        ])
        const npmOut = npmRes.status === 'fulfilled' ? ((npmRes.value as { stdout?: string })?.stdout ?? '').trim() : ''
        const pipOut = pipRes.status === 'fulfilled' ? ((pipRes.value as { stdout?: string })?.stdout ?? '').trim() : ''
        const combined = [npmOut && `## npm outdated\n${npmOut}`, pipOut && `## pip outdated\n${pipOut}`].filter(Boolean).join('\n\n')
        if (combined) {
          contextChips.value.push({ id: crypto.randomUUID(), label: '@deps:outdated', content: `// Outdated packages:\n${combined.slice(0, 5000)}` })
          addMsg({ role: 'user', content: 'Review the outdated packages in @deps:outdated. For each, explain: (1) what changed in the new version, (2) any breaking changes, (3) whether to update now, pin, or skip, and (4) the recommended update command.' })
        } else {
          showToast('All packages up to date (or package manager unavailable)')
          addMsg({ role: 'user', content: 'All npm and pip packages appear to be up to date.' })
        }
        void sendToBackend()
      } catch { showToast('/deps:outdated: package check failed') }
    })()
    return
  }

  // /add:types — add TypeScript type annotations to current file
  if (cmd.id === '/add:types') {
    const file = _injectCurrentFile()
    if (!file) { showToast('/add:types: no file open'); return }
    inputText.value = `Add explicit TypeScript type annotations to every function parameter, return type, and variable in \`${file.relPath.split('/').pop()}\`. Remove all \`any\` types. Add interface/type definitions for complex objects. Return the full updated file.`
    nextTick(() => { textareaEl.value?.focus() })
    return
  }

  // /dockerfile — generate or explain Dockerfile
  if (cmd.id === '/dockerfile') {
    inputText.value = ''
    ;(async () => {
      try {
        const dfRes = await legacyInvoke('fs.read_file', { path: 'Dockerfile' })
        const existing = typeof dfRes === 'string' ? dfRes : (dfRes as { content?: string })?.content ?? ''
        if (existing.trim()) {
          contextChips.value.push({ id: crypto.randomUUID(), label: '@Dockerfile', content: `\`\`\`dockerfile\n${existing.slice(0, 4000)}\n\`\`\`` })
          addMsg({ role: 'user', content: 'Review this Dockerfile for best practices: security (non-root user, minimal base image), layer caching, build efficiency, and correctness. Suggest specific improvements.' })
        } else {
          const pkgRes = await legacyInvoke('fs.read_file', { path: 'package.json' }).catch(() => null)
          const pkg = pkgRes ? JSON.parse(typeof pkgRes === 'string' ? pkgRes : (pkgRes as { content?: string })?.content ?? '{}') : {}
          const framework = pkg?.dependencies?.['next'] ? 'Next.js' : pkg?.dependencies?.['vue'] ? 'Vue 3' : pkg?.dependencies?.['react'] ? 'React' : pkg?.scripts?.dev ? 'Node.js' : 'application'
          addMsg({ role: 'user', content: `Generate a production-ready multi-stage Dockerfile for this ${framework} project. Include: minimal base image, non-root user, health check, proper .dockerignore hints, and build optimisation for layer caching.` })
        }
        void sendToBackend()
      } catch { showToast('/dockerfile: could not read project files') }
    })()
    return
  }

  // /ci:help — review or generate CI pipeline config
  if (cmd.id === '/ci:help') {
    inputText.value = ''
    ;(async () => {
      try {
        const ciRes = await legacyInvoke('shell.run', { cmd: "find .github/workflows -name '*.yml' -o -name '*.yaml' 2>/dev/null | head -5 || find . -name '.gitlab-ci.yml' -o -name 'circle.yml' 2>/dev/null | head -3" })
        const files = ((ciRes as { stdout?: string })?.stdout ?? '').trim().split('\n').filter(Boolean)
        if (files.length) {
          const first = files[0]
          const SAFE_PATH = /^[A-Za-z0-9_./ -]+$/
          if (SAFE_PATH.test(first) && !first.includes('..')) {
            const content = await legacyInvoke('fs.read_file', { path: first.trim() })
            const yaml = typeof content === 'string' ? content : (content as { content?: string })?.content ?? ''
            contextChips.value.push({ id: crypto.randomUUID(), label: '@ci:config', content: `// ${first}\n\`\`\`yaml\n${yaml.slice(0, 5000)}\n\`\`\`` })
            addMsg({ role: 'user', content: `Review this CI/CD configuration. Check for: security issues (secret exposure, arbitrary code execution), missing caching, inefficient job ordering, and missing steps like type-checking or security scanning. Suggest specific improvements.` })
          } else {
            addMsg({ role: 'user', content: 'Generate a GitHub Actions CI workflow for this project that includes: install, type-check, lint, test, and build steps. Use caching for node_modules and follow security best practices.' })
          }
        } else {
          addMsg({ role: 'user', content: 'Generate a GitHub Actions CI workflow for this project that includes: install, type-check, lint, test, and build steps. Use caching for node_modules and follow security best practices.' })
        }
        void sendToBackend()
      } catch { showToast('/ci:help: CI config scan failed') }
    })()
    return
  }

  nextTick(() => {
    textareaEl.value?.focus()
    const len = inputText.value.length
    textareaEl.value?.setSelectionRange(len, len)
  })
}

let _searchFilesTimer: ReturnType<typeof setTimeout> | null = null
function debouncedSearchFiles(query: string): void {
  if (_searchFilesTimer !== null) clearTimeout(_searchFilesTimer)
  _searchFilesTimer = setTimeout(() => { _searchFilesTimer = null; void searchFiles(query) }, 180)
}

async function searchFiles(query: string): Promise<void> {
  try {
    interface FlatResp { ok: boolean; files?: string[]; error?: string }
    const lower = query.toLowerCase()
    const resp = await props.backend.send<FlatResp>('fs.list_files_flat', {
      workspace_path: props.workspacePath,
      query,
    })
    const files: string[] = resp.payload?.files ?? []
    const found: AtOption[] = files.map((f) => ({ id: f, label: `@${f}` }))

    atDirItems.value = found.slice(0, 15)
    const filtered: AtOption[] = [
      ...AT_OPTIONS_STATIC.filter((o) => o.label.toLowerCase().includes(lower)),
      ...atDirItems.value,
    ]
    if (filtered.length) {
      const rOrder = new Map(recentAtIds.value.map((id, i): [string, number] => [id, i]))
      filtered.sort((a, b) => (rOrder.get(a.id) ?? 999) - (rOrder.get(b.id) ?? 999))
      atOptions.value = filtered
    } else {
      atOptions.value = AT_OPTIONS_STATIC
    }
  } catch {
    // ignore
  }
}

async function selectAtOption(option: AtOption, refreshTargetId?: string): Promise<void> {
  trackRecentAt(option.id)
  // Remove the @fragment from textarea
  const textarea = textareaEl.value
  if (!textarea && !refreshTargetId) { showAtMenu.value = false; return }
  const el = textarea ?? document.createElement('textarea')
  const val = el.value
  const cur = el.selectionStart ?? val.length
  const beforeCursor = val.slice(0, cur)
  const atIdx = beforeCursor.lastIndexOf('@')

  let chipLabel = ''
  let chipContent = ''

  if (option.id === '@file') {
    const relPath = props.getActiveRelPath?.() ?? ''
    const content = props.getEditorContent?.() ?? ''
    const ext = relPath.split('.').pop() ?? ''
    chipLabel = relPath ? `@${relPath.split('/').pop()}` : '@file'
    chipContent = relPath
      ? `// File: ${relPath}\n\`\`\`${ext}\n${content}\n\`\`\``
      : content
  } else if (option.id === '@recent') {
    // Add all recently-opened files (up to 5) as context
    const paths = recentAtFiles.value.slice(0, 5)
    if (!paths.length) { showToast('@recent: no files opened yet this session'); return }
    chipLabel = '@recent'
    const sections: string[] = []
    for (const p of paths) {
      try {
        interface FileResp { content?: string }
        const r = await props.backend.send<FileResp>('fs.read_file', { workspace_path: props.workspacePath, rel_path: p })
        const fc = (r as { payload?: { content?: string } }).payload?.content ?? ''
        const ext = p.split('.').pop() ?? ''
        sections.push(`// File: ${p}\n\`\`\`${ext}\n${fc.slice(0, 20_000)}\n\`\`\``)
      } catch { /* skip unreadable */ }
    }
    chipContent = sections.length ? sections.join('\n\n') : '// @recent: could not read files'
  } else if (option.id === '@selection') {
    const selected = props.getEditorSelection?.() ?? ''
    const relPath = props.getActiveRelPath?.() ?? ''
    const ext = relPath.split('.').pop() ?? ''
    chipLabel = '@selection'
    if (selected) {
      chipContent = relPath
        ? `// Selection from: ${relPath}\n\`\`\`${ext}\n${selected}\n\`\`\``
        : selected
    } else {
      // Fall back to full file content when nothing is selected
      const content = props.getEditorContent?.() ?? ''
      chipContent = relPath
        ? `// File: ${relPath}\n\`\`\`${ext}\n${content}\n\`\`\``
        : content
    }
  } else if (option.id === '@git') {
    chipLabel = '@git'
    try {
      interface DiffResp { ok: boolean; diff?: string }
      const resp = await props.backend.send<DiffResp>('git.diff_all', {
        workspace_path: props.workspacePath,
        staged: false,
      })
      chipContent = resp.payload?.diff ? `// git diff (unstaged)\n${resp.payload.diff}` : '// git diff: no changes'
    } catch {
      chipContent = '// git diff: unavailable'
    }
  } else if (option.id === '@git:staged') {
    chipLabel = '@git:staged'
    try {
      interface DiffResp { ok: boolean; diff?: string }
      const resp = await props.backend.send<DiffResp>('git.diff_all', {
        workspace_path: props.workspacePath,
        staged: true,
      })
      chipContent = resp.payload?.diff ? `// git diff --cached (staged)\n${resp.payload.diff}` : '// git diff --cached: nothing staged'
    } catch {
      chipContent = '// @git:staged: unavailable'
    }
  } else if (option.id === '@git:log' || option.id.startsWith('@git:log:')) {
    if (option.id === '@git:log:verbose') {
      chipLabel = '@git:log:verbose'
      try {
        interface ShellResp { ok: boolean; output?: string; error?: string }
        const resp = await props.backend.send<ShellResp>('shell.run', {
          command: 'git log --format="%H%n  Author: %an <%ae>%n  Date:   %ar%n  %s%n%b" -10 2>&1',
          workspace_path: props.workspacePath,
        })
        const out = (resp.payload?.output ?? '').trim()
        chipContent = out ? `// git log (last 10 commits, verbose):\n${out}` : '// git log: no commits'
      } catch {
        chipContent = '// @git:log:verbose: unavailable'
      }
    } else {
      const rawN = option.id.startsWith('@git:log:') ? option.id.slice('@git:log:'.length) : '20'
      const n = Math.min(Math.max(parseInt(rawN, 10) || 20, 1), 500)
      chipLabel = `@git:log:${n}`
      try {
        interface ShellResp { ok: boolean; output?: string; error?: string }
        const resp = await props.backend.send<ShellResp>('shell.run', {
          command: `git log --oneline -${n} 2>&1`,
          workspace_path: props.workspacePath,
        })
        const out = (resp.payload?.output ?? '').trim()
        chipContent = out ? `// git log (last ${n} commits):\n${out}` : '// git log: no commits'
      } catch {
        chipContent = '// @git:log: unavailable'
      }
    }
  } else if (option.id === '@git:branch') {
    chipLabel = '@git:branch'
    try {
      interface ShellResp { ok: boolean; output?: string; error?: string }
      const branchResp = await props.backend.send<ShellResp>('shell.run', {
        command: 'git branch --show-current 2>&1 && git log -1 --pretty="%h %s (%ar, %an)" 2>&1 && git status --short 2>&1 | head -20',
        workspace_path: props.workspacePath,
      })
      chipContent = (branchResp.payload?.output ?? '').trim()
        ? `// git branch info:\n${(branchResp.payload?.output ?? '').trim()}`
        : '// git branch: no info'
    } catch {
      chipContent = '// @git:branch: unavailable'
    }
  } else if (option.id === '@git:blame') {
    const relPath = props.getActiveRelPath?.()
    if (!relPath) {
      showToast('@git:blame requires an open file'); return
    }
    // Strict path validation: only safe chars, no .. segments, no leading -
    if (!/^[A-Za-z0-9_./-]+$/.test(relPath) || relPath.split('/').some(s => s === '..' || s === '' || s.startsWith('-'))) {
      showToast('Invalid file path for git blame'); return
    }
    chipLabel = `@git:blame(${relPath.split('/').pop()})`
    try {
      interface ShellResp { ok: boolean; output?: string; error?: string }
      showToast('Running git blame…')
      const blameResp = await props.backend.send<ShellResp>('shell.run', {
        command: `git blame --line-porcelain -- "${relPath}" 2>&1 | grep -E "^(author |summary |[0-9a-f]{40} )" | awk '/^[0-9a-f]{40}/{h=$1} /^author /{a=substr($0,8)} /^summary /{s=substr($0,9); print h" "a": "s}' | sort -u | head -60`,
        workspace_path: props.workspacePath,
      })
      const out = (blameResp.payload?.output ?? '').trim()
      if (!out) {
        // Fallback: simple blame summary
        const fallback = await props.backend.send<ShellResp>('shell.run', {
          command: `git blame --date=short -- "${relPath}" 2>&1 | head -80`,
          workspace_path: props.workspacePath,
        })
        chipContent = (fallback.payload?.output ?? '').trim()
          ? `// git blame: ${relPath}\n${(fallback.payload?.output ?? '').trim()}`
          : `// git blame: ${relPath}: no history`
      } else {
        chipContent = `// git blame summary: ${relPath}\n// (unique commit→author→message)\n${out}`
      }
    } catch {
      chipContent = `// @git:blame: unavailable`
    }
  } else if (option.id === '@git:file-log') {
    chipLabel = '@git:file-log'
    const relPath = props.getActiveRelPath?.()
    if (!relPath) { showToast('@git:file-log: no file open in editor'); return }
    try {
      interface ShellRespFL { ok: boolean; output?: string; error?: string }
      const SAFE_PATH = /^[A-Za-z0-9_./ -]+$/
      const safeRelPath = SAFE_PATH.test(relPath) && !relPath.includes('..') && !relPath.startsWith('-') ? relPath : null
      if (!safeRelPath) { chipContent = '// @git:file-log: invalid file path'; } else {
        const sqPath = safeRelPath.replace(/'/g, "'\\''")
        const resp = await props.backend.send<ShellRespFL>('shell.run', {
          command: `git log --follow --oneline --date=short --format="%h %ad %an — %s" -- '${sqPath}' 2>/dev/null | head -30`,
          workspace_path: props.workspacePath,
        })
        if (!resp.payload?.ok) {
          chipContent = `// @git:file-log: ${resp.payload?.error ?? 'backend error'}`
        } else {
          const log = (resp.payload.output ?? '').trim()
          chipContent = log
            ? `// git log: ${relPath} (last ${log.split('\n').length} commits)\n${log}`
            : `// @git:file-log: no history for ${relPath}`
        }
      }
    } catch { chipContent = '// @git:file-log: unavailable' }
  } else if (option.id === '@git:recent') {
    chipLabel = '@git:recent'
    try {
      interface ShellResp { ok: boolean; output?: string; error?: string }
      const resp = await props.backend.send<ShellResp>('shell.run', {
        command: 'git log --name-only --pretty=format: -5 2>&1 | grep -v "^$" | sort -u | head -20',
        workspace_path: props.workspacePath,
      })
      const out = (resp.payload?.output ?? '').trim()
      chipContent = out ? `// recently committed files (last 5 commits):\n${out}` : '// @git:recent: no recent commits'
    } catch {
      chipContent = '// @git:recent: unavailable'
    }
  } else if (option.id === '@git:conflicts') {
    chipLabel = '@git:conflicts'
    try {
      interface ShellRespConflicts { ok: boolean; output?: string; error?: string }
      const resp = await props.backend.send<ShellRespConflicts>('shell.run', {
        command: 'git status --short 2>/dev/null | grep -E "^[UA][UA] |^AA |^DD " | head -20',
        workspace_path: props.workspacePath,
      })
      const raw = resp.payload?.ok ? (resp.payload.output ?? '').trim() : null
      chipContent = raw === null
        ? `// @git:conflicts: ${resp.payload?.error ?? 'backend error'}`
        : raw ? `// Merge conflicts:\n${raw}` : '// @git:conflicts: no merge conflicts found'
    } catch {
      chipContent = '// @git:conflicts: unavailable'
    }
  } else if (option.id === '@git:stash') {
    chipLabel = '@git:stash'
    try {
      interface StashResp { stashes?: Array<{ index: number; ref: string; message: string }> }
      const resp = await props.backend.send<StashResp>('git.stash_list', { workspace_path: props.workspacePath })
      const stashes = resp.payload?.stashes ?? []
      if (!stashes.length) {
        chipContent = '// @git:stash: no stashes found'
      } else {
        const lines = stashes.map((s) => `  ${s.ref}: ${s.message}`)
        chipContent = `// git stash list (${stashes.length} ${stashes.length === 1 ? 'entry' : 'entries'}):\n${lines.join('\n')}`
      }
    } catch {
      chipContent = '// @git:stash: unavailable'
    }
  } else if (option.id === '@git:tag') {
    chipLabel = '@git:tag'
    try {
      interface ShellResp { ok: boolean; output?: string; error?: string }
      const resp = await props.backend.send<ShellResp>('shell.run', {
        command: 'git tag --sort=-version:refname -l 2>&1 | head -20',
        workspace_path: props.workspacePath,
      })
      if (!resp.payload?.ok) {
        chipContent = `// @git:tag: ${resp.payload?.error ?? 'backend error'}`
      } else {
        const out = (resp.payload?.output ?? '').trim()
        chipContent = out ? `// git tags (most recent first):\n${out}` : '// @git:tag: no tags found'
      }
    } catch {
      chipContent = '// @git:tag: unavailable'
    }
  } else if (option.id === '@git:contributors') {
    chipLabel = '@git:contributors'
    try {
      interface ShellResp { ok: boolean; output?: string; error?: string }
      const resp = await props.backend.send<ShellResp>('shell.run', {
        command: 'git shortlog -sn --no-merges 2>&1 | head -20',
        workspace_path: props.workspacePath,
      })
      if (!resp.payload?.ok) {
        chipContent = `// @git:contributors: ${resp.payload?.error ?? 'backend error'}`
      } else {
        const out = (resp.payload?.output ?? '').trim()
        chipContent = out ? `// top contributors (git shortlog):\n${out}` : '// @git:contributors: no commit history'
      }
    } catch {
      chipContent = '// @git:contributors: unavailable'
    }
  } else if (option.id === '@git:pr') {
    chipLabel = '@git:pr'
    try {
      interface ShellResp { ok: boolean; output?: string; error?: string }
      // Check gh availability, then fetch PR; distinguish "no PR" from "gh missing"
      const ghCheck = await props.backend.send<ShellResp>('shell.run', {
        command: 'command -v gh >/dev/null 2>&1 && echo "__GH_OK__" || echo "__GH_MISSING__"',
        workspace_path: props.workspacePath,
      })
      const ghAvailable = (ghCheck.payload?.output ?? '').trim() === '__GH_OK__'
      const resp = await props.backend.send<ShellResp>('shell.run', {
        command: 'gh pr view --json number,title,body,state,reviewDecision,labels,author,url 2>/dev/null || echo "__NO_PR__"',
        workspace_path: props.workspacePath,
      })
      const raw = (resp.payload?.output ?? '').trim()
      if (!raw || raw === '__NO_PR__' || raw === '__GH_MISSING__') {
        const branchResp = await props.backend.send<ShellResp>('shell.run', {
          command: 'git branch --show-current && git remote get-url origin 2>/dev/null',
          workspace_path: props.workspacePath,
        })
        const branchOut = (branchResp.payload?.output ?? '').trim()
        const reason = ghAvailable ? 'no open PR for this branch' : 'gh CLI not installed'
        chipContent = branchOut
          ? `// @git:pr: ${reason}\n// Branch: ${branchOut}`
          : `// @git:pr: ${reason}`
      } else {
        try {
          interface PrJson { number?: number; title?: string; body?: string; state?: string; reviewDecision?: string; labels?: Array<{name: string}>; author?: {login: string}; url?: string }
          const pr = JSON.parse(raw) as PrJson
          const labels = pr.labels?.map((l) => l.name).join(', ') ?? ''
          chipContent = [
            `// PR #${pr.number ?? '?'}: ${pr.title ?? ''}`,
            `// State: ${pr.state ?? '?'}${pr.reviewDecision ? ' · Review: ' + pr.reviewDecision : ''}`,
            pr.author ? `// Author: @${pr.author.login}` : '',
            labels ? `// Labels: ${labels}` : '',
            pr.url ? `// URL: ${pr.url}` : '',
            '',
            pr.body?.trim() ? `## Description\n${pr.body.trim().slice(0, 3000)}` : '(no description)',
          ].filter((l) => l !== undefined && l !== null).join('\n').trim()
        } catch {
          chipContent = `// @git:pr (raw):\n${raw.slice(0, 2000)}`
        }
      }
    } catch {
      chipContent = '// @git:pr: unavailable'
    }
  } else if (option.id === '@git:modified') {
    chipLabel = '@git:modified'
    try {
      interface ShellResp { ok: boolean; output?: string; error?: string }
      const resp = await props.backend.send<ShellResp>('shell.run', {
        command: 'git status --short 2>&1',
        workspace_path: props.workspacePath,
      })
      const out = (resp.payload?.output ?? '').trim()
      chipContent = out
        ? `// Uncommitted changes (git status --short):
${out}`
        : '// @git:modified: no uncommitted changes'
    } catch {
      chipContent = '// @git:modified: unavailable'
    }
  } else if (option.id === '@git:diff') {
    // Static option — expand to @git:diff: in textarea so user can type the branch name
    const newVal = val.slice(0, atIdx) + '@git:diff:' + val.slice(cur)
    inputText.value = newVal
    showAtMenu.value = false
    await nextTick()
    el.focus()
    const pos = atIdx + '@git:diff:'.length
    el.setSelectionRange(pos, pos)
    return
  } else if (option.id.startsWith('@git:diff:')) {
    const branchName = option.id.slice('@git:diff:'.length).trim()
    chipLabel = `@git:diff:${branchName}`
    if (!/^(?!-)(?!.*\.\.)[A-Za-z0-9_./-]+$/.test(branchName)) {
      chipContent = `// @git:diff:${branchName}: invalid branch name`
    } else {
      try {
        showToast(`Fetching diff vs ${branchName}…`)
        interface DiffBranchResp { ok: boolean; diff?: string; error?: string }
        const resp = await props.backend.send<DiffBranchResp>('git.diff_branches', {
          workspace_path: props.workspacePath,
          base: branchName,
          compare: 'HEAD',
        })
        const diff = resp.payload?.diff
        chipContent = diff
          ? `// git diff ${branchName}...HEAD\n${diff}`
          : `// @git:diff:${branchName}: ${resp.payload?.error ?? 'no diff found'}`
      } catch {
        chipContent = `// @git:diff:${branchName}: unavailable`
      }
    }
  } else if (option.id === '@git:commit') {
    const newVal = val.slice(0, atIdx) + '@git:commit:' + val.slice(cur)
    inputText.value = newVal
    showAtMenu.value = false
    await nextTick()
    el.focus()
    const pos = atIdx + '@git:commit:'.length
    el.setSelectionRange(pos, pos)
    return
  } else if (option.id.startsWith('@git:commit:')) {
    const hash = option.id.slice('@git:commit:'.length).trim()
    chipLabel = `@git:commit:${hash}`
    if (!/^[0-9a-f]{4,40}$/i.test(hash)) {
      chipContent = `// @git:commit:${hash}: invalid hash (must be 4–40 hex chars)`
    } else {
      try {
        showToast(`Fetching commit ${hash.slice(0, 7)}…`)
        interface ShowCommitResp { ok: boolean; hash?: string; short_hash?: string; author_name?: string; date?: string; message?: string; body?: string; files?: string[]; error?: string }
        const resp = await props.backend.send<ShowCommitResp>('git.show_commit', {
          workspace_path: props.workspacePath,
          commit_hash: hash,
        })
        const p = resp.payload
        if (!p?.ok) {
          chipContent = `// @git:commit:${hash}: ${p?.error ?? 'not found'}`
        } else {
          const header = `commit ${p.short_hash} — ${p.message}\nAuthor: ${p.author_name} · ${p.date?.slice(0, 10)}`
          const files = p.files?.length ? `\nFiles changed:\n${p.files.map((f) => `  ${f}`).join('\n')}` : ''
          const body = p.body ? `\n\n${p.body}` : ''
          chipContent = `// @git:commit:${p.short_hash}\n${header}${body}${files}`
        }
      } catch {
        chipContent = `// @git:commit:${hash}: unavailable`
      }
    }
  } else if (option.id === '@git:conflict') {
    chipLabel = '@git:conflict'
    try {
      interface ShellRespConflict { ok: boolean; output?: string; error?: string }
      const resp = await props.backend.send<ShellRespConflict>('shell.run', {
        command: 'git diff --name-only --diff-filter=U 2>/dev/null',
        workspace_path: props.workspacePath,
      })
      if (!resp.payload?.ok) {
        chipContent = `// @git:conflict: ${resp.payload?.error ?? 'backend error'}`
      } else {
        const conflictedFiles = (resp.payload?.output ?? '').trim().split('\n').filter(Boolean)
        if (!conflictedFiles.length) {
          chipContent = '// @git:conflict: no merge conflicts found in working tree'
        } else {
          showToast(`Reading ${conflictedFiles.length} conflict file(s)…`)
          let parts = `// Merge conflicts in ${conflictedFiles.length} file(s):\n`
          for (const relPath of conflictedFiles.slice(0, 5)) {
            try {
              interface FileResp { ok: boolean; content?: string; error?: string }
              const fResp = await props.backend.send<FileResp>('fs.read_file', { workspace_path: props.workspacePath, rel_path: relPath })
              const content = fResp.payload?.ok ? (fResp.payload.content ?? '') : ''
              parts += `\n// ${relPath}\n\`\`\`\n${content.slice(0, 6000)}\n\`\`\`\n`
            } catch { parts += `\n// ${relPath}: could not read\n` }
          }
          chipContent = parts
        }
      }
    } catch {
      chipContent = '// @git:conflict: unavailable'
    }
  } else if (option.id === '@git:remote') {
    chipLabel = '@git:remote'
    try {
      interface ShellRespRemote { ok: boolean; output?: string; error?: string }
      const [remoteResp, statusResp] = await Promise.all([
        props.backend.send<ShellRespRemote>('shell.run', { command: 'git remote -v 2>/dev/null', workspace_path: props.workspacePath }),
        props.backend.send<ShellRespRemote>('shell.run', { command: 'git status -sb 2>/dev/null | head -5', workspace_path: props.workspacePath }),
      ])
      if (!remoteResp.payload?.ok || !statusResp.payload?.ok) {
        const err = remoteResp.payload?.ok === false ? remoteResp.payload?.error : statusResp.payload?.error
        chipContent = `// @git:remote: ${err ?? 'backend error'}`
      } else {
        const remotes = (remoteResp.payload.output ?? '').trim()
        const status = (statusResp.payload.output ?? '').trim()
        chipContent = remotes
          ? `// Git remote info:\n${remotes}\n\n// Branch tracking status:\n${status || '(no status)'}`
          : '// @git:remote: no remotes configured'
      }
    } catch {
      chipContent = '// @git:remote: unavailable'
    }
  } else if (option.id === '@git:author') {
    chipLabel = '@git:author'
    const relPath = props.getActiveRelPath?.()
    if (!relPath) { showToast('@git:author: no file open in editor'); return }
    try {
      interface ShellRespBlame { ok: boolean; output?: string; error?: string }
      const resp = await props.backend.send<ShellRespBlame>('shell.run', {
        command: `git blame --line-porcelain -- '${relPath.replace(/'/g, "'\\''")}' 2>/dev/null | awk '/^author / {a=$0} /^author-time / {t=$2} /^filename / {f=$2} /^\t/ {gsub(/^author /,"",a); printf "%s | %s | %s\\n", strftime("%Y-%m-%d", t+0), a, substr($0,2)}' | head -80`,
        workspace_path: props.workspacePath,
      })
      if (!resp.payload?.ok) {
        chipContent = `// @git:author: ${resp.payload?.error ?? 'backend error'}`
      } else {
        const blame = (resp.payload.output ?? '').trim()
        chipContent = blame
          ? `// git blame: ${relPath}\n// date       | author            | line content\n${blame}`
          : `// @git:author: no blame info for ${relPath}`
      }
    } catch {
      chipContent = '// @git:author: unavailable'
    }
  } else if (option.id === '@codebase') {
    // Static option selected without a query — replace with a prompt hint in input
    const newVal = val.slice(0, atIdx) + '@codebase ' + val.slice(cur)
    inputText.value = newVal
    showAtMenu.value = false
    await nextTick()
    el.focus()
    // Position cursor after '@codebase '
    const pos = atIdx + '@codebase '.length
    el.setSelectionRange(pos, pos)
    return
  } else if (option.id.startsWith('@codebase:')) {
    const query = option.id.slice('@codebase:'.length)
    chipLabel = `@codebase:${query}`
    try {
      interface SearchMatch { line: number; col: number; text: string }
      interface SearchResp { ok: boolean; error?: string; results?: Array<{ rel_path: string; matches: SearchMatch[] }> }
      const resp = await props.backend.send<SearchResp>('search.find_in_files', {
        workspace_path: props.workspacePath,
        query,
        is_regex: false,
        case_sensitive: false,
        max_results: 30,
      })
      const results = resp.payload?.results ?? []
      if (results.length === 0) {
        chipContent = `// @codebase search "${query}": no results`
      } else {
        // Enrich each result with surrounding context lines (±2) by reading the file
        const topFiles = results.slice(0, 6)
        const enriched: string[] = [`// @codebase search "${query}" — ${results.length} files`]
        for (const r of topFiles) {
          let fileLines: string[] = []
          try {
            interface ReadResp extends ReadPayload {}
            const fr = await props.backend.send<ReadResp>('fs.read_file', {
              workspace_path: props.workspacePath, rel_path: r.rel_path,
            })
            if (fr.payload?.ok && fr.payload.content) {
              fileLines = fr.payload.content.split('\n')
            }
          } catch { /* fall back to plain match */ }

          enriched.push(`\n// ${r.rel_path}`)
          const shownLines = new Set<number>()
          for (const m of r.matches.slice(0, 3)) {
            const lo = Math.max(0, m.line - 3)          // 2 lines before
            const hi = Math.min(fileLines.length - 1, m.line + 1)  // 1 line after
            if (fileLines.length > 0) {
              for (let ln = lo; ln <= hi; ln++) {
                if (!shownLines.has(ln)) {
                  shownLines.add(ln)
                  const marker = ln === m.line - 1 ? '▶' : ' '
                  enriched.push(`${marker}${ln + 1}: ${fileLines[ln]}`)
                }
              }
              if (m !== r.matches[Math.min(r.matches.length - 1, 2)]) enriched.push('  …')
            } else {
              enriched.push(`${m.line}: ${m.text}`)
            }
          }
        }
        chipContent = enriched.join('\n')
      }
    } catch {
      chipContent = `// @codebase search "${query}": unavailable`
    }
  } else if (option.id === '@folder') {
    // Prompt user to specify a sub-directory by rewriting textarea
    const newVal = val.slice(0, atIdx) + '@folder:' + val.slice(cur)
    inputText.value = newVal
    showAtMenu.value = false
    await nextTick()
    el.focus()
    const pos = atIdx + '@folder:'.length
    el.setSelectionRange(pos, pos)
    return
  } else if (option.id.startsWith('@folder:')) {
    const folderPath = option.id.slice('@folder:'.length).trim()
    chipLabel = `@folder:${folderPath}`
    try {
      interface FlatResp { ok: boolean; files?: string[]; error?: string }
      const resp = await props.backend.send<FlatResp>('fs.list_files_flat', {
        workspace_path: props.workspacePath,
        query: '',
      })
      const allFiles = resp.payload?.files ?? []
      // Filter to files under the specified folder
      const prefix = folderPath.endsWith('/') ? folderPath : folderPath + '/'
      const matching = allFiles.filter((f) => f.startsWith(prefix) || f.startsWith(folderPath + '/') || f === folderPath)
      if (matching.length === 0) {
        chipContent = `// @folder:${folderPath}: no files found`
      } else {
        const MAX_FILES = 10
        const taken = matching.slice(0, MAX_FILES)
        const results: string[] = []
        for (const filePath of taken) {
          try {
            interface ReadResp extends ReadPayload {}
            const fr = await props.backend.send<ReadResp>('fs.read_file', { workspace_path: props.workspacePath, rel_path: filePath })
            const ext = filePath.split('.').pop() ?? ''
            results.push(`// ${filePath}\n\`\`\`${ext}\n${(fr.payload?.content ?? '').slice(0, 2000)}\n\`\`\``)
          } catch { /* skip unreadable files */ }
        }
        chipContent = `// @folder:${folderPath} (${taken.length} files${matching.length > MAX_FILES ? `, showing ${MAX_FILES}` : ''})\n\n${results.join('\n\n')}`
      }
    } catch {
      chipContent = `// @folder:${folderPath}: unavailable`
    }
  } else if (option.id === '@model' || option.id.startsWith('@model:')) {
    // @model — switch model for the current conversation (Cursor-style inline model switch)
    if (option.id === '@model') {
      // Rewrite to @model: so user can type model name
      const newVal = val.slice(0, atIdx) + '@model:' + val.slice(cur)
      inputText.value = newVal
      showAtMenu.value = false
      await nextTick()
      el.focus()
      const pos = atIdx + '@model:'.length
      el.setSelectionRange(pos, pos)
      return
    }
    const modelId = option.id.slice('@model:'.length).trim()
    const entry = MODEL_CATALOG.find((m) => m.id === modelId)
    if (entry) {
      settingsProvider.value = entry.provider === 'auto' ? settingsProvider.value : entry.provider
      settingsModel.value = entry.id
      showToast(`Model switched to ${entry.display}`)
    } else {
      showToast(`@model: unknown model "${modelId}"`)
    }
    // Remove the @model:xxx from input (don't add a chip)
    inputText.value = val.slice(0, atIdx) + val.slice(cur)
    showAtMenu.value = false
    await nextTick()
    el.focus()
    return
  } else if (option.id === '@tabs') {
    chipLabel = '@tabs'
    const tabPaths = props.getOpenFiles?.() ?? []
    if (tabPaths.length === 0) {
      chipContent = '// @tabs: no files open in the editor'
    } else {
      const MAX_TABS = 8
      const taken = tabPaths.slice(0, MAX_TABS)
      const results: string[] = []
      for (const filePath of taken) {
        try {
          interface ReadResp extends ReadPayload {}
          const fr = await props.backend.send<ReadResp>('fs.read_file', { workspace_path: props.workspacePath, rel_path: filePath })
          if (fr.payload?.ok) {
            const ext = filePath.split('.').pop() ?? ''
            results.push(`// ${filePath}\n\`\`\`${ext}\n${(fr.payload?.content ?? '').slice(0, 2000)}\n\`\`\``)
          }
        } catch { /* skip unreadable files */ }
      }
      const truncNote = tabPaths.length > MAX_TABS ? ` (showing ${taken.length} of ${tabPaths.length})` : ` (${taken.length} file${taken.length !== 1 ? 's' : ''})`
      chipContent = `// @tabs — open editor files${truncNote}\n\n${results.join('\n\n')}`
    }
  } else if (option.id === '@glob:' || option.id.startsWith('@glob:')) {
    // If bare @glob: (no pattern yet), rewrite input to @glob: and wait for user to type pattern
    if (option.id === '@glob:') {
      const newVal = val.slice(0, atIdx) + '@glob:' + val.slice(cur)
      inputText.value = newVal
      showAtMenu.value = false
      await nextTick()
      el.focus()
      const pos = atIdx + '@glob:'.length
      el.setSelectionRange(pos, pos)
      return
    }
    const globPattern = option.id.slice('@glob:'.length).trim()
    chipLabel = `@glob:${globPattern}`
    try {
      interface GlobResp { ok: boolean; files?: string[]; truncated?: boolean; error?: string }
      const resp = await props.backend.send<GlobResp>('fs.glob_files', {
        workspace_path: props.workspacePath,
        pattern: globPattern,
      })
      if (!resp.payload?.ok) {
        chipContent = `// @glob:${globPattern}: ${resp.payload?.error ?? 'backend error'}`
      } else {
        const files = resp.payload?.files ?? []
        if (files.length === 0) {
          chipContent = `// @glob:${globPattern}: no files matched`
        } else {
          const MAX_FILES = 10
          const taken = files.slice(0, MAX_FILES)
          const results: string[] = []
          for (const filePath of taken) {
            try {
              interface ReadResp extends ReadPayload {}
              const fr = await props.backend.send<ReadResp>('fs.read_file', { workspace_path: props.workspacePath, rel_path: filePath })
              const ext = filePath.split('.').pop() ?? ''
              results.push(`// ${filePath}\n\`\`\`${ext}\n${(fr.payload?.content ?? '').slice(0, 2000)}\n\`\`\``)
            } catch { /* skip unreadable files */ }
          }
          const truncNote = resp.payload?.truncated || files.length > MAX_FILES ? ` (showing ${taken.length} of ${files.length}+)` : ` (${taken.length} file${taken.length !== 1 ? 's' : ''})`
          chipContent = `// @glob:${globPattern}${truncNote}\n\n${results.join('\n\n')}`
        }
      }
    } catch {
      chipContent = `// @glob:${globPattern}: unavailable`
    }
  } else if (option.id === '@problems') {
    chipLabel = '@problems'
    if (!props.workspacePath) {
      chipContent = '// @problems: no workspace open'
    } else {
      // First, show instant in-memory diagnostics from the editor
      const liveDiags = allDiagnosticsSorted()
      const liveParts: string[] = []
      if (liveDiags.length > 0) {
        for (const d of liveDiags.slice(0, 60)) {
          const loc = `${d.relPath}:${d.line}${d.col ? ':' + d.col : ''}`
          liveParts.push(`[${d.severity.toUpperCase()}] ${d.message} (${loc})${d.source ? ' — ' + d.source : ''}`)
        }
      }
      try {
        showToast('Running type check…')
        interface ShellResp { ok: boolean; output?: string; exit_code?: number; error?: string }
        const resp = await props.backend.send<ShellResp>('shell.run', {
          command: 'npx vue-tsc --noEmit 2>&1 | head -120',
          workspace_path: props.workspacePath,
        })
        const liveSec = liveParts.length > 0 ? `// Live diagnostics (${liveParts.length}):\n${liveParts.join('\n')}\n\n` : ''
        if (!resp.payload?.ok) {
          chipContent = liveParts.length > 0
            ? `${liveSec}// TypeScript (vue-tsc): unavailable — ${resp.payload?.error ?? 'backend error'}`
            : `// @problems: type check unavailable — ${resp.payload?.error ?? 'backend error'}`
        } else {
          const tsOut = (resp.payload.output ?? '').trim()
          if (!tsOut || resp.payload.exit_code === 0) {
            chipContent = liveParts.length > 0
              ? `${liveSec}// TypeScript (vue-tsc): no errors ✓`
              : '// @problems: no errors detected ✓'
          } else {
            chipContent = `${liveSec}// TypeScript errors (vue-tsc):\n${tsOut}`
          }
        }
      } catch {
        chipContent = liveParts.length > 0
          ? `// Live diagnostics:\n${liveParts.join('\n')}`
          : '// @problems: type check unavailable'
      }
    }
  } else if (option.id === '@url') {
    // Prompt user to type URL by rewriting textarea
    const newVal = val.slice(0, atIdx) + '@url:' + val.slice(cur)
    inputText.value = newVal
    showAtMenu.value = false
    await nextTick()
    el.focus()
    const pos = atIdx + '@url:'.length
    el.setSelectionRange(pos, pos)
    return
  } else if (option.id.startsWith('@url:')) {
    const url = option.id.slice('@url:'.length).trim()
    chipLabel = `@url:${url.replace(/^https?:\/\//, '').slice(0, 40)}`
    // Validate: only allow http/https and reject obviously private/internal hosts
    let parsedUrl: URL
    try { parsedUrl = new URL(url) } catch { chipContent = '// @url: invalid URL'; /* falls through */ parsedUrl = null as unknown as URL }
    if (!parsedUrl) {
      // chipContent already set above
    } else if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
      chipContent = '// @url: only http/https URLs are allowed'
    } else {
      const host = parsedUrl.hostname.toLowerCase()
      const BLOCKED = /^(localhost|127\.|0\.0\.0\.0|::1|10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|169\.254\.|100\.6[4-9]\.|100\.[7-9]\d\.|fc00:|fe80:)/
      if (BLOCKED.test(host)) {
        chipContent = `// @url: private/internal addresses are not allowed (${host})`
      } else {
        try {
          showToast('Fetching URL…')
          // redirect:'error' prevents server redirect bypassing host allowlist
          const resp = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(10_000) })
          if (!resp.ok) {
            chipContent = `// @url: HTTP ${resp.status} from ${url}`
          } else {
          // Stream body with hard 256 KB cap — Content-Length is untrustworthy
          const reader = resp.body?.getReader()
          let bodyText = ''
          if (reader) {
            let total = 0
            const dec = new TextDecoder()
            while (true) {
              const { done, value } = await reader.read()
              if (done) break
              total += value.byteLength
              if (total > 262_144) { await reader.cancel(); bodyText = ''; break }
              bodyText += dec.decode(value, { stream: true })
            }
          }
          if (!bodyText) {
            chipContent = '// @url: response too large or unreadable (limit 256 KB)'
          } else {
            const text = bodyText
            // Use DOMParser for proper HTML-to-text (handles entities, avoids regex bypass)
            const doc = new DOMParser().parseFromString(text.slice(0, 512_000), 'text/html')
            doc.querySelectorAll('script,style,noscript').forEach((el) => el.remove())
            // Normalize invisible/bidi override Unicode that could be used for prompt injection
            const raw = (doc.body?.textContent ?? doc.documentElement.textContent ?? '')
              .replace(/[ ---​-‏‪-‮﻿]/g, '')
              .replace(/\s{2,}/g, ' ')
              .trim()
              .slice(0, 4000)
              // Prevent escaping the untrusted fence tag
              .replace(/<\/?untrusted_web_content[^>]*>/gi, '')
            chipContent = `<untrusted_web_content url="${url}">\n${raw}\n</untrusted_web_content>`
          }
          } // end resp.ok else
        } catch {
          chipContent = `// @url: failed to fetch ${url}`
        }
      }
    }
  } else if (option.id === '@clipboard') {
    chipLabel = '@clipboard'
    try {
      const text = await navigator.clipboard.readText()
      if (!text.trim()) {
        showToast('Clipboard is empty'); return
      }
      const clipped = text.slice(0, 5000)
      if (text.length > 5000) showToast(`Clipboard truncated to 5000 chars (was ${text.length})`)
      chipContent = `// Clipboard content:\n${clipped}`
    } catch {
      chipContent = '// @clipboard: read failed (check browser permissions)'
    }
  } else if (option.id === '@workspace') {
    chipLabel = '@workspace'
    if (!props.workspacePath) { chipContent = '// @workspace: no workspace open' } else {
      try {
        interface FlatResp { ok: boolean; files?: string[]; error?: string }
        interface ReadResp3 extends ReadPayload {}
        interface ShellRespWs { ok: boolean; output?: string; error?: string }
        // Gather: tree, README, package.json or pyproject.toml, rules
        const [treeResp, readmeResp, pkgResp, pyResp] = await Promise.all([
          props.backend.send<FlatResp>('fs.list_files_flat', { workspace_path: props.workspacePath, query: '' }),
          props.backend.send<ReadResp3>('fs.read_file', { workspace_path: props.workspacePath, rel_path: 'README.md' }),
          props.backend.send<ReadResp3>('fs.read_file', { workspace_path: props.workspacePath, rel_path: 'package.json' }),
          props.backend.send<ReadResp3>('fs.read_file', { workspace_path: props.workspacePath, rel_path: 'pyproject.toml' }),
        ])
        const projectName = props.workspacePath.split('/').pop() ?? 'project'
        let out = `// Project: ${projectName}\n// Workspace: ${props.workspacePath}\n\n`
        // File tree (top 150 files)
        const files = (treeResp.payload?.files ?? []).slice(0, 150)
        if (files.length) out += `// File tree (${files.length} files):\n${buildFileTree(files)}\n\n`
        // README
        const readme = (readmeResp.payload?.content ?? '').trim()
        if (readme) out += `// README.md (first 600 chars):\n${readme.slice(0, 600)}${readme.length > 600 ? '\n…' : ''}\n\n`
        // package.json — just deps
        const pkg = (pkgResp.payload?.content ?? '').trim()
        if (pkg) {
          try {
            const p = JSON.parse(pkg) as { name?: string; version?: string; dependencies?: Record<string, string>; devDependencies?: Record<string, string> }
            const deps = Object.keys(p.dependencies ?? {}).slice(0, 20).join(', ')
            const devDeps = Object.keys(p.devDependencies ?? {}).slice(0, 10).join(', ')
            out += `// package.json: ${p.name ?? ''} v${p.version ?? '?'}\n// deps: ${deps || '(none)'}\n// devDeps: ${devDeps || '(none)'}\n\n`
          } catch { /* skip */ }
        }
        // pyproject.toml — short summary
        const py = (pyResp.payload?.content ?? '').trim()
        if (py) out += `// pyproject.toml:\n${py.slice(0, 400)}\n\n`
        // Workspace rules
        if (workspaceRulesContent.value) out += `// Workspace rules (${workspaceRulesFile.value ?? '.cursorrules'}):\n${workspaceRulesContent.value.slice(0, 500)}\n`
        chipContent = out.trim() || '// @workspace: no information available'
      } catch { chipContent = '// @workspace: unavailable' }
    }
  } else if (option.id === '@tree') {
    chipLabel = '@tree'
    if (!props.workspacePath) {
      chipContent = '// @tree: no workspace open'
    } else {
      try {
        interface FlatResp { ok: boolean; files?: string[]; error?: string }
        const resp = await props.backend.send<FlatResp>('fs.list_files_flat', {
          workspace_path: props.workspacePath,
          query: '',
        })
        const files = (resp.payload?.files ?? []).slice(0, 300)
        // Build tree string from flat file list
        const tree = buildFileTree(files)
        chipContent = `// Workspace file tree:\n${tree}`
      } catch {
        chipContent = '// @tree: unavailable'
      }
    }
  } else if (option.id === '@test:results') {
    chipLabel = '@test:results'
    try {
      interface ShellRespTest { ok: boolean; output?: string; error?: string }
      showToast('Running tests…')
      // Auto-detect test runner: vitest, pytest, jest, cargo test, go test
      const resp = await props.backend.send<ShellRespTest>('shell.run', {
        command: [
          '(npx vitest run --reporter=verbose 2>&1 | tail -60)',
          '|| (python -m pytest -q 2>&1 | tail -40)',
          '|| (npx jest --no-coverage 2>&1 | tail -50)',
          '|| echo "(no test runner found: install vitest, pytest, or jest)"',
        ].join(' '),
        workspace_path: props.workspacePath,
        timeout_ms: 60000,
      })
      if (!resp.payload?.ok) {
        chipContent = `// @test:results: ${resp.payload?.error ?? 'backend error'}`
      } else {
        const raw = (resp.payload.output ?? '').trim()
        chipContent = raw
          ? `// Test results:\n\`\`\`\n${raw.slice(-5000)}\n\`\`\``
          : '// @test:results: no output returned'
      }
    } catch {
      chipContent = '// @test:results: unavailable'
    }
  } else if (option.id === '@notepad') {
    chipLabel = '@notepad'
    const noteText = notesContent.value.trim()
    chipContent = noteText
      ? `// Workspace Notepad:\n${noteText}`
      : '// @notepad: empty — open the Notepad panel to add notes'
  } else if (option.id.startsWith('@notepad:')) {
    const notepadName = option.id.slice('@notepad:'.length)
    const np = namedNotepads.value.find((n) => n.name === notepadName)
    chipLabel = `@notepad:${notepadName}`
    if (np && np.content.trim()) {
      chipContent = `// Notepad "${np.name}":\n${np.content.trim()}`
    } else if (np) {
      chipContent = `// Notepad "${np.name}" is empty — open the Notes panel to add content`
    } else {
      // Create a new notepad with that name
      createNotepad(notepadName)
      chipContent = `// Notepad "${notepadName}" created — open Notes panel to add content`
    }
  } else if (option.id === '@docs') {
    const newVal = val.slice(0, atIdx) + '@docs:' + val.slice(cur)
    inputText.value = newVal
    showAtMenu.value = false
    await nextTick()
    el.focus()
    const pos = atIdx + '@docs:'.length
    el.setSelectionRange(pos, pos)
    return
  } else if (option.id.startsWith('@docs:')) {
    const docKey = option.id.slice('@docs:'.length).trim()
    const docEntry = allDocsCatalog.value[docKey]
    chipLabel = `@docs:${docKey}`
    if (!docEntry) {
      chipContent = `// @docs: unknown documentation "${docKey}"`
    } else {
      try {
        showToast(`Fetching ${docEntry.label}…`)
        const resp = await fetch(docEntry.url, { signal: AbortSignal.timeout(12_000) })
        if (!resp.ok) {
          chipContent = `// @docs:${docKey}: HTTP ${resp.status}`
        } else {
        const reader = resp.body?.getReader()
        let bodyText = ''
        if (reader) {
          let total = 0
          const dec = new TextDecoder()
          while (true) {
            const { done, value } = await reader.read()
            if (done) break
            total += value.byteLength
            if (total > 262_144) { await reader.cancel(); bodyText = ''; break }
            bodyText += dec.decode(value, { stream: true })
          }
        }
        if (!bodyText) {
          chipContent = `// @docs:${docKey}: response too large`
        } else {
          const doc = new DOMParser().parseFromString(bodyText.slice(0, 512_000), 'text/html')
          doc.querySelectorAll('script,style,noscript,nav,header,footer').forEach((e) => e.remove())
          const raw = (doc.body?.textContent ?? '').replace(/\s{2,}/g, ' ').trim().slice(0, 5000)
          chipContent = `// ${docEntry.label} (${docEntry.url})\n\n${raw}`
        }
        } // end resp.ok else
      } catch {
        chipContent = `// @docs:${docKey}: failed to fetch documentation`
      }
    }
  } else if (option.id === '@web') {
    // Prompt user to type search query
    const newVal = val.slice(0, atIdx) + '@web:' + val.slice(cur)
    inputText.value = newVal
    showAtMenu.value = false
    await nextTick()
    el.focus()
    const pos = atIdx + '@web:'.length
    el.setSelectionRange(pos, pos)
    return
  } else if (option.id.startsWith('@web:')) {
    const query = option.id.slice('@web:'.length).trim()
    chipLabel = `@web:${query.slice(0, 30)}`
    if (!query) {
      chipContent = '// @web: no query'
    } else {
      try {
        showToast(`Searching web for "${query}"…`)
        interface WebSearchResult { title: string; snippet: string; url: string }
        interface WebSearchResp { query?: string; results?: WebSearchResult[] }
        const resp = await props.backend.send<WebSearchResp>('ai.web.search', { query })
        if (!resp.ok) {
          chipContent = `// @web: search error — ${resp.error?.message ?? 'unknown error'}`
        } else {
          const results = resp.payload?.results ?? []
          if (!results.length) {
            chipContent = `// @web:"${query}" — no results found`
          } else {
            const lines = results.map((r) => `• ${r.title}\n  ${r.snippet.slice(0, 200).replace(/\n/g, ' ')}\n  ${r.url}`)
            chipContent = `// Web search: "${query}"\n\n${lines.join('\n\n')}`
          }
        }
      } catch {
        chipContent = `// @web: search failed for "${query}"`
      }
    }
  } else if (option.id === '@symbol') {
    // Prompt user to type symbol name
    const newVal = val.slice(0, atIdx) + '@symbol:' + val.slice(cur)
    inputText.value = newVal
    showAtMenu.value = false
    await nextTick()
    el.focus()
    const pos = atIdx + '@symbol:'.length
    el.setSelectionRange(pos, pos)
    return
  } else if (option.id.startsWith('@symbol:')) {
    const symbolName = option.id.slice('@symbol:'.length).trim()
    chipLabel = `@symbol:${symbolName}`
    if (!props.workspacePath) {
      chipContent = '// @symbol: no workspace open'
    } else {
      try {
        showToast(`Searching for "${symbolName}"…`)
        interface SearchMatch { line: number; col: number; text: string }
        interface SearchResp { ok: boolean; error?: string; results?: Array<{ rel_path: string; matches: SearchMatch[] }> }
        // Search for function/class/const definitions containing the symbol name
        const resp = await props.backend.send<SearchResp>('search.find_in_files', {
          workspace_path: props.workspacePath,
          query: symbolName,
          is_regex: false,
          case_sensitive: true,
          max_results: 20,
        })
        const results = resp.payload?.results ?? []
        // Filter to definition-looking lines (function/class/const/type/export)
        const DEF_RE = /^\s*(export\s+)?(default\s+)?(function|class|const|let|var|type|interface|def|async\s+function)\s/
        const defs: Array<{ path: string; line: number; text: string }> = []
        for (const r of results) {
          for (const m of r.matches) {
            if (DEF_RE.test(m.text) || m.text.includes(`${symbolName}(`)) {
              defs.push({ path: r.rel_path, line: m.line, text: m.text.trim() })
            }
          }
        }
        if (defs.length === 0) {
          chipContent = `// @symbol:${symbolName}: no definition found\n// (tried: function/class/const patterns)\n// Raw matches: ${results.length} files`
        } else {
          // For each definition, read context (10 lines around it)
          const parts: string[] = []
          for (const d of defs.slice(0, 4)) {
            try {
              interface ReadResp extends ReadPayload {}
              const fr = await props.backend.send<ReadResp>('fs.read_file', {
                workspace_path: props.workspacePath,
                rel_path: d.path,
              })
              const allLines = (fr.payload?.content ?? '').split('\n')
              const start = Math.max(0, d.line - 2)
              const end = Math.min(allLines.length, d.line + 20)
              const ext = d.path.split('.').pop() ?? ''
              parts.push(`// ${d.path}:${d.line}\n\`\`\`${ext}\n${allLines.slice(start, end).join('\n')}\n\`\`\``)
            } catch { parts.push(`// ${d.path}:${d.line}\n${d.text}`) }
          }
          chipContent = `// @symbol:${symbolName} — ${defs.length} definition(s)\n\n${parts.join('\n\n')}`
        }
      } catch {
        chipContent = `// @symbol:${symbolName}: unavailable`
      }
    }
  } else if (option.id === '@usages') {
    // Prompt user to type a symbol name in the textarea
    const newVal = val.slice(0, atIdx) + '@usages:' + val.slice(cur)
    inputText.value = newVal
    showAtMenu.value = false
    await nextTick(); el.focus()
    const pos = atIdx + '@usages:'.length
    el.setSelectionRange(pos, pos)
    return
  } else if (option.id.startsWith('@usages:')) {
    const symbolName = option.id.slice('@usages:'.length).trim()
    chipLabel = `@usages:${symbolName}`
    if (!props.workspacePath) {
      chipContent = '// @usages: no workspace open'
    } else {
      try {
        showToast(`Finding all usages of "${symbolName}"…`)
        interface SearchMatch { line: number; col: number; text: string }
        interface SearchResp { results?: Array<{ rel_path: string; matches: SearchMatch[] }> }
        const resp = await props.backend.send<SearchResp>('search.find_in_files', {
          workspace_path: props.workspacePath,
          query: symbolName,
          is_regex: false,
          case_sensitive: true,
          max_results: 60,
        })
        if (!resp.ok) {
          chipContent = `// @usages:${symbolName}: search error — ${resp.error?.message ?? 'unknown error'}`
        } else {
        const results = resp.payload?.results ?? []
        if (results.length === 0) {
          chipContent = `// @usages:${symbolName}: no usages found`
        } else {
          // Separate definitions from call sites
          const DEF_RE = /^\s*(export\s+)?(default\s+)?(function|class|const|let|var|type|interface|def|async\s+function)\s/
          const callSites: Array<{ path: string; line: number; text: string }> = []
          for (const r of results) {
            for (const m of r.matches) {
              // Include call site (has the symbol name + "(") but skip bare definitions
              const isCallSite = m.text.includes(`${symbolName}(`) || m.text.includes(`${symbolName} (`)
              const isDef = DEF_RE.test(m.text)
              if (isCallSite || !isDef) {
                callSites.push({ path: r.rel_path, line: m.line, text: m.text.trim() })
              }
            }
          }
          const usages = callSites.length ? callSites : results.flatMap((r) => r.matches.map((m) => ({ path: r.rel_path, line: m.line, text: m.text.trim() })))
          const totalFiles = new Set(usages.map((u) => u.path)).size
          chipContent = `// @usages:${symbolName} — ${usages.length} usage(s) in ${totalFiles} file(s)\n`
          // Group by file; show up to 5 files × 5 usages each
          const byFile = new Map<string, typeof usages>()
          for (const u of usages) {
            if (!byFile.has(u.path)) byFile.set(u.path, [])
            byFile.get(u.path)!.push(u)
          }
          for (const [filePath, fileUsages] of Array.from(byFile.entries()).slice(0, 8)) {
            chipContent += `\n// ${filePath}\n`
            for (const u of fileUsages.slice(0, 6)) {
              chipContent += `  ${u.line}: ${u.text}\n`
            }
          }
        }
        }
      } catch {
        chipContent = `// @usages:${symbolName}: unavailable`
      }
    }
  } else if (option.id === '@env') {
    chipLabel = '@env'
    if (!props.workspacePath) {
      chipContent = '// @env: no workspace open'
    } else {
      try {
        interface ReadResp extends ReadPayload {}
        // Try .env.example first, then .env.template, then .env.sample
        const candidates = ['.env.example', '.env.template', '.env.sample', '.env.local.example']
        let found = false
        for (const name of candidates) {
          const resp = await props.backend.send<ReadResp>('fs.read_file', {
            workspace_path: props.workspacePath,
            rel_path: name,
          }).catch(() => ({ payload: { ok: false, content: '' } }))
          if (resp.payload?.ok && resp.payload.content?.trim()) {
            chipContent = `// ${name} (environment variables)\n\`\`\`\n${(resp.payload.content ?? '').slice(0, 6000)}\n\`\`\``
            found = true
            break
          }
        }
        if (!found) {
          // Fallback: read .env but strip values (keep only VAR_NAME= lines)
          const envResp = await props.backend.send<ReadResp>('fs.read_file', {
            workspace_path: props.workspacePath,
            rel_path: '.env',
          }).catch(() => ({ payload: { ok: false, content: '' } }))
          if (envResp.payload?.ok && envResp.payload.content?.trim()) {
            const maskedLines = (envResp.payload.content ?? '').split('\n')
              .map((line) => {
                if (line.startsWith('#') || !line.includes('=')) return line
                const [key] = line.split('=')
                return `${key}=<value hidden>`
              })
              .join('\n')
            chipContent = `// .env variable names (values masked for security)\n\`\`\`\n${maskedLines.slice(0, 4000)}\n\`\`\``
          } else {
            chipContent = '// @env: no .env.example or .env file found'
          }
        }
      } catch {
        chipContent = '// @env: unavailable'
      }
    }
  } else if (option.id === '@package') {
    chipLabel = '@package'
    if (!props.workspacePath) {
      chipContent = '// @package: no workspace open'
    } else {
      try {
        interface ReadResp extends ReadPayload {}
        const resp = await props.backend.send<ReadResp>('fs.read_file', {
          workspace_path: props.workspacePath,
          rel_path: 'package.json',
        })
        if (!resp.payload?.ok || !resp.payload.content) {
          chipContent = '// @package: package.json not found'
        } else {
          const pkg = JSON.parse(resp.payload.content) as Record<string, unknown>
          const summary: Record<string, unknown> = {}
          if (pkg.name) summary.name = pkg.name
          if (pkg.version) summary.version = pkg.version
          if (pkg.scripts) summary.scripts = pkg.scripts
          if (pkg.dependencies) summary.dependencies = Object.keys(pkg.dependencies as object)
          if (pkg.devDependencies) summary.devDependencies = Object.keys(pkg.devDependencies as object)
          if (pkg.engines) summary.engines = pkg.engines
          chipContent = `// package.json overview\n\`\`\`json\n${JSON.stringify(summary, null, 2)}\n\`\`\``
        }
      } catch {
        chipContent = '// @package: unavailable'
      }
    }
  } else if (option.id === '@dependents') {
    chipLabel = '@dependents'
    const activeFile = props.getActiveRelPath?.()
    if (!activeFile) {
      chipContent = '// @dependents: no active file open in editor'
    } else {
      try {
        interface SearchResp3 { ok: boolean; error?: string; results?: Array<{ rel_path: string; matches: Array<{ line: number; text: string }> }> }
        showToast(`Finding dependents of ${activeFile.split('/').pop()}…`)
        const filename = activeFile.split('/').pop()?.replace(/\.\w+$/, '') ?? ''
        const resp = await props.backend.send<SearchResp3>('search.find_in_files', {
          workspace_path: props.workspacePath,
          query: filename,
          is_regex: false,
          case_sensitive: false,
          max_results: 50,
        })
        if (!resp.payload?.ok) {
          chipContent = `// @dependents: ${resp.payload?.error ?? 'backend error'}`
        } else {
          const importers = (resp.payload.results ?? []).filter((r) =>
            r.rel_path !== activeFile &&
            r.matches.some((m) => /import|require|from/.test(m.text) && m.text.includes(filename))
          )
          if (!importers.length) {
            chipContent = `// @dependents: no files found that import '${activeFile}'`
          } else {
            const lines = importers.map((r) => {
              const importLine = r.matches.find((m) => /import|require|from/.test(m.text))
              return `  ${r.rel_path}${importLine ? `  → ${importLine.text.trim().slice(0, 60)}` : ''}`
            })
            chipContent = `// Files that import '${activeFile}' (${importers.length} found):\n${lines.join('\n')}`
          }
        }
      } catch {
        chipContent = '// @dependents: unavailable'
      }
    }
  } else if (option.id === '@lint') {
    chipLabel = '@lint'
    try {
      interface ShellRespLint { ok: boolean; output?: string; error?: string }
      showToast('Running linter…')
      const resp = await props.backend.send<ShellRespLint>('shell.run', {
        command: [
          '(npx eslint . --ext .ts,.tsx,.vue,.js 2>&1 | head -60)',
          '|| (ruff check . 2>&1 | head -60)',
          '|| (python -m mypy . --no-error-summary 2>&1 | head -40)',
          '|| echo "(no linter found: install eslint, ruff, or mypy)"',
        ].join(' '),
        workspace_path: props.workspacePath,
        timeout_ms: 30000,
      })
      if (!resp.payload?.ok) {
        chipContent = `// @lint: ${resp.payload?.error ?? 'backend error'}`
      } else {
        const raw = (resp.payload.output ?? '').trim()
        chipContent = raw
          ? `// Lint output:\n\`\`\`\n${raw.slice(-5000)}\n\`\`\``
          : '// @lint: no output (no errors, or linter not found)'
      }
    } catch {
      chipContent = '// @lint: unavailable'
    }
  } else if (option.id === '@readme') {
    chipLabel = '@readme'
    try {
      interface ReadResp { ok?: boolean; content?: string; payload?: { ok?: boolean; content?: string } }
      // Try README.md, then readme.md, then README.txt
      let found = false
      for (const name of ['README.md', 'readme.md', 'README.txt', 'README']) {
        const r = await props.backend.send<ReadResp>('fs.read_file', { workspace_path: props.workspacePath, rel_path: name })
        const content = (r as { payload?: { content?: string } }).payload?.content ?? ''
        if (content) {
          chipContent = `// ${name}:\n\`\`\`markdown\n${content.slice(0, 8000)}\n\`\`\``
          found = true
          break
        }
      }
      if (!found) chipContent = '// @readme: no README file found in workspace root'
    } catch {
      chipContent = '// @readme: unavailable'
    }
  } else if (option.id === '@ci') {
    chipLabel = '@ci'
    try {
      interface ShellRespCI { ok: boolean; output?: string; error?: string }
      const [workflowsResp, ghResp] = await Promise.all([
        props.backend.send<ShellRespCI>('shell.run', {
          command: 'ls .github/workflows/ 2>/dev/null | head -10',
          workspace_path: props.workspacePath,
        }),
        props.backend.send<ShellRespCI>('shell.run', {
          command: 'gh run list --limit 5 --json status,conclusion,name,headBranch,createdAt 2>/dev/null || echo "(gh CLI not available)"',
          workspace_path: props.workspacePath,
        }),
      ])
      const workflows = (workflowsResp.payload?.output ?? '').trim()
      const runs = (ghResp.payload?.output ?? '').trim()
      if (!workflows && (runs.includes('not available') || !runs)) {
        chipContent = '// @ci: no CI/CD config found and gh CLI unavailable'
      } else {
        let ci = ''
        if (workflows) ci += `// Workflow files:\n${workflows.split('\n').map((f) => `  ${f}`).join('\n')}\n\n`
        if (runs && !runs.includes('not available')) {
          try {
            const parsed = JSON.parse(runs) as Array<{ status: string; conclusion: string; name: string; headBranch: string; createdAt: string }>
            ci += `// Recent CI runs:\n` + parsed.map((r) => `  ${r.conclusion ?? r.status} — ${r.name} (${r.headBranch})`).join('\n')
          } catch { ci += `// CI runs:\n${runs}` }
        }
        chipContent = ci || '// @ci: no CI information available'
      }
    } catch {
      chipContent = '// @ci: unavailable'
    }
  } else if (option.id === '@lock') {
    chipLabel = '@lock'
    try {
      interface ReadResp2 extends ReadPayload {}
      let found2 = false
      for (const name of ['package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'Pipfile.lock', 'poetry.lock']) {
        const r = await props.backend.send<ReadResp2>('fs.read_file', { workspace_path: props.workspacePath, rel_path: name })
        const content = r.payload?.content ?? ''
        if (content) {
          // For JSON lock files, show top-level packages only
          if (name === 'package-lock.json') {
            try {
              const d = JSON.parse(content) as { packages?: Record<string, { version?: string }> }
              const top = Object.entries(d.packages ?? {})
                .filter(([k]) => k && !k.slice('node_modules/'.length).includes('/'))
                .map(([k, v]) => `  ${k.replace('node_modules/', '')}@${v.version ?? '?'}`)
                .slice(0, 30)
              chipContent = `// package-lock.json (${top.length} top-level deps):\n${top.join('\n')}`
            } catch { chipContent = `// ${name}:\n${content.slice(0, 3000)}` }
          } else {
            chipContent = `// ${name}:\n${content.slice(0, 3000)}`
          }
          found2 = true; break
        }
      }
      if (!found2) chipContent = '// @lock: no lock file found (package-lock.json, yarn.lock, etc.)'
    } catch {
      chipContent = '// @lock: unavailable'
    }
  } else if (option.id === '@port') {
    chipLabel = '@port'
    try {
      interface ShellRespPort { ok: boolean; output?: string; error?: string }
      // lsof lists LISTEN ports; grep for workspace-related processes when possible
      const [lsofResp, psResp] = await Promise.all([
        props.backend.send<ShellRespPort>('shell.run', {
          command: 'lsof -iTCP -sTCP:LISTEN -P -n 2>/dev/null | awk \'NR>1 {printf "%s\\t%s\\n", $9, $1}\' | sort -u | head -20 || netstat -tlnp 2>/dev/null | grep LISTEN | head -20',
          workspace_path: props.workspacePath,
        }),
        props.backend.send<ShellRespPort>('shell.run', {
          command: 'ps aux 2>/dev/null | grep -E "node|python|deno|bun|vite|webpack|next|nuxt|fastapi|uvicorn|django|flask|rails|go run" | grep -v grep | awk \'{print $2, $11, $12, $13}\' | head -15',
          workspace_path: props.workspacePath,
        }),
      ])
      if (!lsofResp.payload?.ok && !psResp.payload?.ok) {
        chipContent = `// @port: ${lsofResp.payload?.error ?? 'backend error'}`
      } else {
        const ports = (lsofResp.payload?.ok ? lsofResp.payload.output ?? '' : '').trim()
        const procs = (psResp.payload?.ok ? psResp.payload.output ?? '' : '').trim()
        if (!ports && !procs) {
          chipContent = '// @port: no listening ports detected'
        } else {
          let out = ''
          if (ports) out += `// Listening ports:\n${ports.split('\n').map((l) => `  ${l}`).join('\n')}\n`
          if (procs) out += `\n// Dev processes:\n${procs.split('\n').map((l) => `  ${l}`).join('\n')}`
          chipContent = out.trim()
        }
      }
    } catch {
      chipContent = '// @port: unavailable'
    }
  } else if (option.id === '@coverage') {
    chipLabel = '@coverage'
    try {
      interface ShellRespCov { ok: boolean; output?: string; error?: string }
      // Try vitest coverage first, then jest, then pytest-cov
      const [vitestResp, pytestResp] = await Promise.all([
        props.backend.send<ShellRespCov>('shell.run', {
          command: 'npx vitest run --reporter=verbose --coverage 2>&1 | tail -40 || echo "(vitest not available)"',
          workspace_path: props.workspacePath,
        }),
        props.backend.send<ShellRespCov>('shell.run', {
          command: 'python -m pytest --cov --cov-report=term-missing -q 2>&1 | tail -30 || echo "(pytest-cov not available)"',
          workspace_path: props.workspacePath,
        }),
      ])
      const vitest = (vitestResp.payload?.ok ? vitestResp.payload.output ?? '' : '').trim()
      const pytest = (pytestResp.payload?.ok ? pytestResp.payload.output ?? '' : '').trim()
      let out = ''
      if (vitest && !vitest.includes('not available')) out += `// Vitest coverage:\n${vitest}\n`
      if (pytest && !pytest.includes('not available') && !pytest.includes('ERROR')) out += `\n// pytest coverage:\n${pytest}\n`
      chipContent = out.trim() || '// @coverage: no coverage data available (run tests with --coverage first)'
    } catch {
      chipContent = '// @coverage: unavailable'
    }
  } else if (option.id === '@rules') {
    chipLabel = '@rules'
    if (workspaceRulesContent.value.trim()) {
      chipContent = `// Project rules (${workspaceRulesFile.value ?? '.cursorrules'}):\n${workspaceRulesContent.value.slice(0, 8000)}`
    } else {
      await detectWorkspaceRules()
      chipContent = workspaceRulesContent.value.trim()
        ? `// Project rules (${workspaceRulesFile.value}):\n${workspaceRulesContent.value.slice(0, 8000)}`
        : '// @rules: no rules file found (.cursorrules / AGENTS.md / .cursor/rules/*.mdc)'
    }
  } else if (option.id === '@schema') {
    chipLabel = '@schema'
    try {
      interface ReadRespSchema extends ReadPayload {}
      let schemaFound = false
      for (const p of ['prisma/schema.prisma', 'schema.prisma', 'db/schema.sql', 'database/schema.sql']) {
        const r = await props.backend.send<ReadRespSchema>('fs.read_file', { workspace_path: props.workspacePath, rel_path: p })
        const c = r.payload?.content ?? ''
        if (c) { chipContent = `// DB schema (${p}):\n\`\`\`prisma\n${c.slice(0, 6000)}\n\`\`\``; schemaFound = true; break }
      }
      if (!schemaFound) {
        interface ShellRespSchema { ok: boolean; output?: string; error?: string }
        const resp = await props.backend.send<ShellRespSchema>('shell.run', {
          command: 'find . -name "*.sql" -not -path "*/node_modules/*" 2>/dev/null | head -5',
          workspace_path: props.workspacePath,
        })
        const files = (resp.payload?.ok ? resp.payload.output ?? '' : '').trim()
        chipContent = files ? `// SQL migration files found:\n${files}` : '// @schema: no database schema found (checked prisma/, db/, database/)'
      }
    } catch { chipContent = '// @schema: unavailable' }
  } else if (option.id === '@changelog') {
    chipLabel = '@changelog'
    try {
      interface ReadRespCL extends ReadPayload {}
      let found = false
      for (const name of ['CHANGELOG.md', 'CHANGES.md', 'HISTORY.md', 'CHANGELOG.txt']) {
        const r = await props.backend.send<ReadRespCL>('fs.read_file', { workspace_path: props.workspacePath, rel_path: name })
        const c = r.payload?.content ?? ''
        if (c) { chipContent = `// ${name}:\n${c.slice(0, 6000)}`; found = true; break }
      }
      if (!found) chipContent = '// @changelog: no CHANGELOG file found in workspace root'
    } catch { chipContent = '// @changelog: unavailable' }
  } else if (option.id === '@todos') {
    chipLabel = '@todos'
    try {
      interface ShellRespTodos { ok: boolean; output?: string; error?: string }
      const resp = await props.backend.send<ShellRespTodos>('shell.run', {
        command: 'grep -rn --include="*.ts" --include="*.tsx" --include="*.js" --include="*.py" --include="*.vue" -E "TODO|FIXME|HACK|XXX|BUG" . 2>/dev/null | grep -v "node_modules" | head -40',
        workspace_path: props.workspacePath,
      })
      const raw = resp.payload?.ok ? (resp.payload.output ?? '').trim() : null
      chipContent = raw === null
        ? `// @todos: ${resp.payload?.error ?? 'backend error'}`
        : raw ? `// TODO/FIXME/HACK annotations:\n${raw}` : '// @todos: no TODO/FIXME comments found'
    } catch { chipContent = '// @todos: unavailable' }
  } else if (option.id === '@memories') {
    chipLabel = '@memories'
    chipContent = memories.value.length
      ? `// Saved memories:\n${memories.value.map((m, i) => `${i + 1}. ${m}`).join('\n')}`
      : '// @memories: no memories saved — use /memory or the Notes panel to add facts'
  } else if (option.id === '@config') {
    chipLabel = '@config'
    if (!props.workspacePath) {
      chipContent = '// @config: no workspace open'
    } else {
      try {
        interface ReadRespCfg extends ReadPayload {}
        const CONFIG_FILES = [
          'tsconfig.json', 'tsconfig.base.json',
          '.eslintrc.json', '.eslintrc.js', '.eslintrc.cjs', 'eslint.config.js', 'eslint.config.mjs',
          'vite.config.ts', 'vite.config.js',
          '.prettierrc', '.prettierrc.json', '.prettierrc.js',
          'vitest.config.ts', 'vitest.config.js',
          'jest.config.ts', 'jest.config.js',
          'webpack.config.js', 'rollup.config.js',
        ]
        const results = await Promise.all(
          CONFIG_FILES.map((f) =>
            props.backend.send<ReadRespCfg>('fs.read_file', { workspace_path: props.workspacePath, rel_path: f })
              .then((r) => ({ file: f, content: (r.payload?.content ?? '').trim() }))
              .catch(() => ({ file: f, content: '' })),
          ),
        )
        const found = results.filter((r) => r.content.length > 0)
        if (!found.length) {
          chipContent = '// @config: no common config files found'
        } else {
          chipContent = found.map((r) => {
            const ext = r.file.split('.').pop() ?? ''
            const snippet = r.content.slice(0, 1200) + (r.content.length > 1200 ? '\n// …truncated' : '')
            return `// ${r.file}:\n\`\`\`${ext}\n${snippet}\n\`\`\``
          }).join('\n\n')
        }
      } catch { chipContent = '// @config: unavailable' }
    }
  } else if (option.id === '@tests') {
    chipLabel = '@tests'
    const relPath = props.getActiveRelPath?.()
    if (!relPath || !props.workspacePath) {
      chipContent = '// @tests: no file open'
    } else {
      try {
        const baseName = relPath.split('/').pop()?.replace(/\.(ts|tsx|js|jsx|vue|py)$/, '') ?? ''
        const SAFE_BASE = /^[A-Za-z0-9_.-]+$/
        if (!SAFE_BASE.test(baseName)) { chipContent = '// @tests: could not determine test file pattern'; }
        else {
          interface ShellRespTests { ok: boolean; output?: string; error?: string }
          const r = await props.backend.send<ShellRespTests>('shell.run', {
            command: `find . -type f \( -name "*.test.*" -o -name "*.spec.*" -o -name "*_test.*" \) ! -path "*/node_modules/*" ! -path "*/.venv/*" | grep -i "${baseName}" | head -10`,
            workspace_path: props.workspacePath,
          })
          const found = r.payload?.ok ? (r.payload.output ?? '').trim().split('\n').filter(Boolean) : null
          if (found === null) { chipContent = `// @tests: ${r.payload?.error ?? 'backend error'}` }
          else if (!found.length) { chipContent = `// @tests: no test files found for ${baseName}` }
          else {
            interface ReadRespT extends ReadPayload {}
            const parts: string[] = []
            for (const tf of found.slice(0, 3)) {
              const tr = await props.backend.send<ReadRespT>('fs.read_file', { workspace_path: props.workspacePath, rel_path: tf.replace(/^\.\//, '') })
              if (tr.payload?.content) parts.push(`// ${tf}:\n${tr.payload.content.slice(0, 3000)}`)
            }
            chipContent = parts.join('\n\n') || `// @tests: test files for ${baseName}: ${found.join(', ')}`
          }
        }
      } catch { chipContent = '// @tests: unavailable' }
    }
  } else if (option.id === '@related') {
    chipLabel = '@related'
    const relPath = props.getActiveRelPath?.()
    if (!relPath || !props.workspacePath) {
      chipContent = '// @related: no file open'
    } else {
      try {
        const baseName = relPath.split('/').pop() ?? ''
        const SAFE_B = /^[A-Za-z0-9_.@-]+$/
        const SAFE_PATH_REL = /^[A-Za-z0-9_./ -]+$/
        if (!SAFE_B.test(baseName) || !SAFE_PATH_REL.test(relPath) || relPath.includes('..')) { chipContent = '// @related: invalid filename'; }
        else {
          interface ShellRespRel { ok: boolean; output?: string; error?: string }
          // Files that import the current file (single-quote quoting prevents injection)
          const sqBase = "'" + baseName.replace(/\.[^.]+$/, '').replace(/'/g, "'\\''") + "'"
          const sqRelPath = "'" + relPath.replace(/'/g, "'\\''") + "'"
          const r = await props.backend.send<ShellRespRel>('shell.run', {
            command: `grep -rn --include="*.ts" --include="*.tsx" --include="*.js" --include="*.vue" --include="*.py" --fixed-strings -l ${sqBase} . 2>/dev/null | grep -v node_modules | grep -v ".venv" | grep -Fv ${sqRelPath} | head -15`,
            workspace_path: props.workspacePath,
          })
          const files = r.payload?.ok ? (r.payload.output ?? '').trim().split('\n').filter(Boolean) : null
          chipContent = files === null
            ? `// @related: ${r.payload?.error ?? 'backend error'}`
            : files.length
              ? `// Files that reference ${baseName}:\n${files.join('\n')}`
              : `// @related: no files found that import ${baseName}`
        }
      } catch { chipContent = '// @related: unavailable' }
    }
  } else if (option.id === '@terminal') {
    chipLabel = '@terminal'
    // Try the stored buffer first (written by PTY terminal component if available)
    const TERMINAL_BUF_KEY = 'ai-chat-terminal-buffer'
    const stored = settingsGet<string | null>(TERMINAL_BUF_KEY, null)
    if (stored && stored.trim()) {
      chipContent = `// Terminal output (last session):\n\`\`\`\n${stored.slice(-5000)}\n\`\`\``
    } else if (props.workspacePath) {
      try {
        interface ShellRespTerm { ok: boolean; output?: string; error?: string }
        const [histResp, cmdResp] = await Promise.all([
          props.backend.send<ShellRespTerm>('shell.run', { command: 'history 2>/dev/null | tail -20 || fc -l 2>/dev/null | tail -20 || echo "(history unavailable)"', workspace_path: props.workspacePath }),
          props.backend.send<ShellRespTerm>('shell.run', { command: 'ls -lt 2>/dev/null | head -10', workspace_path: props.workspacePath }),
        ])
        const hist = (histResp.payload?.output ?? '').trim()
        const ls = (cmdResp.payload?.output ?? '').trim()
        chipContent = `// Recent shell activity:\n${hist}\n\n// Recently modified files:\n${ls}`
      } catch { chipContent = '// @terminal: terminal output unavailable — try running a command first' }
    } else {
      chipContent = '// @terminal: no workspace open'
    }
  } else if (option.id === '@build') {
    chipLabel = '@build'
    if (!props.workspacePath) { chipContent = '// @build: no workspace open' }
    else {
      try {
        showToast('Running build check…')
        interface ShellRespBuild { ok: boolean; output?: string; exit_code?: number; error?: string }
        const hasPkg = await props.backend.send<ShellRespBuild>('fs.read_file', { workspace_path: props.workspacePath, rel_path: 'package.json' }).catch(() => ({ payload: { ok: false, content: '' } }))
        const pkg = JSON.parse((hasPkg.payload as { ok?: boolean; content?: string })?.content ?? '{}') as Record<string, unknown>
        const devDeps = (pkg.devDependencies ?? {}) as Record<string, string>
        const deps = (pkg.dependencies ?? {}) as Record<string, string>
        let buildCmd = 'npm run build 2>&1 | tail -60'
        if ('vite' in devDeps || 'vite' in deps) buildCmd = 'npx vite build 2>&1 | tail -60'
        else if ('tsc' in devDeps) buildCmd = 'npx tsc --noEmit 2>&1 | head -60'
        const resp = await props.backend.send<ShellRespBuild>('shell.run', { command: buildCmd, workspace_path: props.workspacePath })
        const out = (resp.payload?.output ?? '').trim()
        const exitCode = resp.payload?.exit_code ?? 0
        chipContent = out
          ? `// Build output (exit ${exitCode}):\n\`\`\`\n${out}\n\`\`\``
          : '// @build: no output'
      } catch { chipContent = '// @build: unavailable' }
    }
  } else if (option.id === '@hotkeys') {
    chipLabel = '@hotkeys'
    chipContent = `// AI Chat & Editor Keyboard Shortcuts:
Ctrl+Enter / Cmd+Enter — Send message
Ctrl+L / Cmd+L — Focus chat input
Ctrl+N / Cmd+N — New thread
Ctrl+/ — Toggle thread sidebar
Ctrl+Shift+L — Toggle AI pane
Escape — Stop streaming / close menu
Tab — Accept @mention or /command suggestion
Up arrow — Edit last user message (inline)
@ — Open context menu
/ — Open command menu`
  } else if (option.id === '@snippets') {
    chipLabel = '@snippets'
    const SAVED_SNIPPETS_KEY = 'ai-chat-snippets'
    interface SnippetItem { id: string; name: string; content: string; lang: string; createdAt: number }
    const savedSnippets: SnippetItem[] = (() => { try { return JSON.parse(settingsGet(SAVED_SNIPPETS_KEY, '[]')) as SnippetItem[] } catch { return [] } })()
    if (!savedSnippets.length) {
      chipContent = '// @snippets: no saved snippets yet — use /snippet:save to save one'
    } else {
      chipContent = '// Saved code snippets:\n' + savedSnippets.slice(0, 20).map((s, i) =>
        `// ${i + 1}. ${s.name} (${s.lang || 'text'}):\n\`\`\`${s.lang}\n${s.content.slice(0, 400)}\n\`\`\``
      ).join('\n\n')
    }
  } else if (option.id === '@local:changes') {
    chipLabel = '@local:changes'
    if (!props.workspacePath) { chipContent = '// @local:changes: no workspace open' }
    else {
      try {
        interface ShellRespLC { ok: boolean; output?: string; error?: string }
        const [statusResp, diffResp] = await Promise.all([
          props.backend.send<ShellRespLC>('shell.run', { command: 'git diff --name-only HEAD 2>&1', workspace_path: props.workspacePath }),
          props.backend.send<ShellRespLC>('shell.run', { command: 'git diff HEAD --stat 2>&1 | head -30', workspace_path: props.workspacePath }),
        ])
        const changedFiles = (statusResp.payload?.output ?? '').trim().split('\n').filter(Boolean)
        const stat = (diffResp.payload?.output ?? '').trim()
        if (!changedFiles.length) { chipContent = '// @local:changes: no local changes' }
        else {
          // Fetch content of up to 3 changed files
          const sections: string[] = [`// Changed files (${changedFiles.length} total):\n${stat}`]
          for (const f of changedFiles.slice(0, 3)) {
            const SAFE_F = /^[A-Za-z0-9_./ -]+$/
            if (!SAFE_F.test(f) || f.includes('..') || f.startsWith('-')) continue
            try {
              interface FileRespLC { payload?: { ok?: boolean; content?: string } }
              const r = await props.backend.send<FileRespLC>('fs.read_file', { workspace_path: props.workspacePath, rel_path: f })
              const fc = (r as FileRespLC).payload?.content ?? ''
              const ext2 = f.split('.').pop() ?? ''
              sections.push(`// File: ${f}\n\`\`\`${ext2}\n${fc.slice(0, 8000)}\n\`\`\``)
            } catch { /* skip */ }
          }
          chipContent = sections.join('\n\n')
        }
      } catch { chipContent = '// @local:changes: unavailable' }
    }
  } else if (option.id === '@pinned:msgs') {
    chipLabel = '@pinned:msgs'
    const pinnedMsgs = messages.value.filter((m) => m.pinned)
    if (!pinnedMsgs.length) {
      chipContent = '// @pinned:msgs: no pinned messages — right-click a message and choose "Pin Message ⭐"'
    } else {
      chipContent = `// Pinned messages (${pinnedMsgs.length}):\n` + pinnedMsgs.map((m, i) => {
        const preview = m.content.slice(0, 400).replace(/```[\s\S]*?```/g, '[code block]')
        return `// --- Pinned ${i + 1} (${m.role}) ---\n${preview}`
      }).join('\n\n')
    }
  } else if (option.id === '@thread:summary') {
    chipLabel = '@thread:summary'
    const recentMsgs = messages.value.filter((m) => !m.streaming && m.content?.trim()).slice(-20)
    if (!recentMsgs.length) {
      chipContent = '// @thread:summary: no messages in this thread yet'
    } else {
      const historyText = recentMsgs.map((m) => `${m.role === 'user' ? 'User' : 'AI'}: ${m.content.slice(0, 200)}`).join('\n---\n')
      chipContent = `// Thread history to summarize (${recentMsgs.length} messages):\n${historyText}`
      // Auto-set input to ask for summary
      if (!refreshTargetId && !inputText.value.trim()) {
        inputText.value = 'Summarize the key decisions, outcomes, and open questions from this conversation in 3-5 bullet points.'
        await nextTick(); textareaEl.value?.focus()
      }
    }
  } else if (option.id === '@diff:') {
    // Bare @diff: — prompt user to type a file path
    const newVal = val.slice(0, atIdx) + '@diff:' + val.slice(cur)
    inputText.value = newVal
    showAtMenu.value = false
    await nextTick()
    el.focus()
    el.setSelectionRange(atIdx + '@diff:'.length, atIdx + '@diff:'.length)
    return
  } else if (option.id.startsWith('@diff:')) {
    const filePath = option.id.slice('@diff:'.length).trim()
    chipLabel = `@diff:${filePath.split('/').pop()}`
    // Validate: only allow safe path chars, reject .. and leading -
    if (!/^[A-Za-z0-9_./ -]+$/.test(filePath) || filePath.includes('..') || filePath.startsWith('-')) {
      chipContent = `// @diff: invalid path "${filePath}" (only alphanumeric, _, ., /, - allowed)`
    } else {
    try {
      interface ShellRespDiff { ok: boolean; output?: string; error?: string }
      // Single-quote the path after escaping any embedded single quotes (none allowed by validation above)
      const safePath = filePath.replace(/'/g, "'\\''")
      const resp = await props.backend.send<ShellRespDiff>('shell.run', {
        command: `git diff HEAD -- '${safePath}' 2>/dev/null`,
        workspace_path: props.workspacePath,
      })
      const raw = resp.payload?.ok ? (resp.payload.output ?? '').trim() : null
      chipContent = raw === null
        ? `// @diff:${filePath}: ${resp.payload?.error ?? 'backend error'}`
        : raw
          ? `// git diff HEAD -- ${filePath}:\n\`\`\`diff\n${raw.slice(0, 8000)}\n\`\`\``
          : `// @diff:${filePath}: no changes (or file not tracked)`
    } catch {
      chipContent = `// @diff:${filePath}: unavailable`
    }
    }
  } else if (/^[^@].+:\d+(?:-\d+)?$/.test(option.id)) {
    // @file:lineRange — e.g., "src/App.vue:10-50"
    const lineMatch = /^(.+):(\d+)(?:-(\d+))?$/.exec(option.id)!
    const filePath = lineMatch[1]
    const startLine = parseInt(lineMatch[2]) - 1
    const endLine = lineMatch[3] ? parseInt(lineMatch[3]) - 1 : startLine
    const lineSpec = lineMatch[3] ? `${lineMatch[2]}-${lineMatch[3]}` : lineMatch[2]
    chipLabel = `@${filePath.split('/').pop()}:${lineSpec}`
    try {
      interface ReadResp extends ReadPayload {}
      const resp = await props.backend.send<ReadResp>('fs.read_file', {
        workspace_path: props.workspacePath,
        rel_path: filePath,
      })
      const allLines = (resp.payload?.content ?? '').split('\n')
      const sliced = allLines.slice(startLine, endLine + 1)
      const ext = filePath.split('.').pop() ?? ''
      chipContent = `// ${filePath} (lines ${lineSpec})\n\`\`\`${ext}\n${sliced.join('\n')}\n\`\`\``
    } catch {
      chipContent = `// ${filePath}:${lineSpec}\n(unable to read)`
    }
  } else {
    // It's a file path
    chipLabel = `@${option.id.split('/').pop()}`
    // Fetch file content
    try {
      interface ReadResp extends ReadPayload {}
      const resp = await props.backend.send<ReadResp>('fs.read_file', {
        workspace_path: props.workspacePath,
        rel_path: option.id,
      })
      chipContent = `// ${option.id}\n${resp.payload?.content ?? ''}`
    } catch {
      chipContent = `// ${option.id}\n(unable to read)`
    }
  }

  // Refresh mode: update existing chip content, skip textarea cleanup
  if (refreshTargetId) {
    const chip = contextChips.value.find((c) => c.id === refreshTargetId)
    if (chip) { chip.content = chipContent; showToast(`↻ ${chipLabel}`) }
    return
  }

  if (contextChips.value.some((c) => c.label === chipLabel)) return
  contextChips.value.push({ id: crypto.randomUUID(), label: chipLabel, content: chipContent, sourceId: option.id })

  // Remove @fragment from textarea
  const newVal = val!.slice(0, atIdx) + val!.slice(cur)
  inputText.value = newVal
  showAtMenu.value = false

  await nextTick()
  el!.focus()
}

function removeChip(id: string): void {
  contextChips.value = contextChips.value.filter((c) => c.id !== id)
}

const refreshingChipId = ref<string | null>(null)

async function refreshChip(id: string): Promise<void> {
  const chip = contextChips.value.find((c) => c.id === id)
  if (!chip?.sourceId || chip.imageData) return
  refreshingChipId.value = id
  try {
    if (chip.sourceId.startsWith(CLI_SOURCE_PREFIX)) {
      // CLI pane chip: re-fetch the pane buffer (selectAtOption would treat
      // the sourceId as a file path). agentKey isn't stored on the chip, so
      // the refreshed header falls back to the label.
      const paneId = chip.sourceId.slice(CLI_SOURCE_PREFIX.length)
      await applyCliPaneChip({ paneId, label: chip.label.replace(/^@cli:/, '') }, id)
    } else {
      await selectAtOption({ id: chip.sourceId, label: chip.label }, id)
    }
  } finally {
    refreshingChipId.value = null
  }
}

function clearNonPinnedChips(): void {
  contextChips.value = contextChips.value.filter((c) => c.pinned)
}

const chipsTokenTotal = computed(() =>
  contextChips.value.reduce((sum, c) => sum + Math.ceil((c.content?.length ?? 0) / 4), 0)
)

function chipIcon(label: string): string {
  if (label.startsWith('@git')) return '⎇'
  if (label.startsWith('@symbol')) return '⟨⟩'
  if (label.startsWith('@web')) return '🌐'
  if (label.startsWith('@url')) return '🔗'
  if (label.startsWith('@docs')) return '📖'
  if (label.startsWith('@test-')) return '✗'
  if (label.startsWith('@usages')) return '↗'
  if (label.startsWith('@env')) return '⚙'
  if (label.startsWith('@package')) return '📦'
  if (label.startsWith('@problems')) return '⚠'
  if (label.startsWith('@clipboard')) return '📋'
  if (label.startsWith('@tree')) return '🌲'
  if (label.startsWith('@codebase')) return '🔍'
  if (label.startsWith('@folder')) return '📁'
  if (label.startsWith('@terminal')) return '>'
  if (label.startsWith('@notepad')) return '📝'
  if (label.startsWith('@selection')) return '✂'
  if (label.startsWith('@file') || label.startsWith('@')) return '◻'
  return ''
}

// ── Chip drag-to-reorder ───────────────────────────────────────────────────────
let _chipDragId: string | null = null

function onChipDragStart(e: DragEvent, id: string): void {
  _chipDragId = id
  e.dataTransfer?.setData('text/plain', id)
  ;(e.currentTarget as HTMLElement).classList.add('ai-chip-dragging')
}

function onChipDragEnd(e: DragEvent): void {
  _chipDragId = null
  ;(e.currentTarget as HTMLElement).classList.remove('ai-chip-dragging')
}

function onChipDragOver(e: DragEvent, targetId: string): void {
  if (!_chipDragId || _chipDragId === targetId) return
  e.preventDefault()
}

function onChipDrop(e: DragEvent, targetId: string): void {
  e.preventDefault()
  if (!_chipDragId || _chipDragId === targetId) return
  const chips = [...contextChips.value]
  const fromIdx = chips.findIndex((c) => c.id === _chipDragId)
  const toIdx = chips.findIndex((c) => c.id === targetId)
  if (fromIdx < 0 || toIdx < 0) return
  const [moved] = chips.splice(fromIdx, 1)
  chips.splice(toIdx, 0, moved)
  contextChips.value = chips
}

// ── Drag & drop file → context chip ──────────────────────────────────────────
const isDraggingOver = ref(false)

function onDragover(e: DragEvent): void {
  const types = e.dataTransfer?.types ?? []
  if (types.includes('Files') || types.includes(CLI_CONTEXT_MIME) || types.includes(PANE_ID_MIME)) {
    e.preventDefault()
    isDraggingOver.value = true
  }
}
function onDragleave(): void { isDraggingOver.value = false }

async function onDrop(e: DragEvent): Promise<void> {
  e.preventDefault()
  isDraggingOver.value = false
  // CLI-pane drops are fully handled here — stop the event from bubbling to
  // the outer onChatDrop, which would process the same payload a second time.
  // Must be synchronous: propagation does not wait for async handlers.
  const types = e.dataTransfer?.types ?? []
  if (types.includes(CLI_CONTEXT_MIME) || types.includes(PANE_ID_MIME)) e.stopPropagation()
  if (await handleCliContextDrop(e)) return
  type AgentApi = Record<string, (...a: unknown[]) => unknown>
  const api = (window as Window & { agentTeam?: AgentApi }).agentTeam
  const files = Array.from(e.dataTransfer?.files ?? [])
  const MAX = 80_000
  for (const file of files.slice(0, 5)) {
    const absPath = api?.getPathForFile?.(file) as string | undefined ?? ''
    if (!absPath) continue
    const wsRoot = props.workspacePath ? props.workspacePath.replace(/\/$/, '') : ''
    const isInsideWorkspace = wsRoot && (absPath === wsRoot || absPath.startsWith(wsRoot + '/'))
    const relPath = isInsideWorkspace ? absPath.slice(wsRoot.length).replace(/^\//, '') : absPath
    const fileName = absPath.split('/').pop() ?? file.name
    const ext = fileName.split('.').pop() ?? ''
    const label = `@${fileName}`
    if (contextChips.value.some((c) => c.label === label)) continue
    try {
      let fileContent = ''
      if (isInsideWorkspace) {
        interface ReadResp extends ReadPayload {}
        const resp = await props.backend.send<ReadResp>('fs.read_file', {
          workspace_path: props.workspacePath,
          rel_path: relPath,
        })
        if (!resp.payload?.ok) { showToast(`Could not read: ${fileName}`); continue }
        fileContent = resp.payload?.content ?? ''
      } else {
        if (!api?.readFileFrom) { showToast('Cannot read file outside workspace'); continue }
        interface RfResp { ok: boolean; content: string }
        const r = await (api.readFileFrom as (p: string, b: number) => Promise<RfResp>)(absPath, 0)
        if (!r.ok) { showToast(`Could not read: ${fileName}`); continue }
        fileContent = r.content
      }
      const truncated = fileContent.length > MAX ? fileContent.slice(0, MAX) + '\n// … truncated' : fileContent
      contextChips.value.push({
        id: crypto.randomUUID(),
        label,
        content: `// File: ${relPath}\n\`\`\`${ext}\n${truncated}\n\`\`\``,
      })
    } catch {
      showToast(`Could not read: ${fileName}`)
    }
  }
}

function _addImageFile(file: File): void {
  const reader = new FileReader()
  reader.onload = () => {
    const dataUrl = reader.result as string
    const chipCount = contextChips.value.filter((c) => c.imageData).length + 1
    contextChips.value.push({
      id: crypto.randomUUID(),
      label: `@image${chipCount > 1 ? chipCount : ''}`,
      content: `[Image: ${file.name || file.type}, ${Math.round(file.size / 1024)}KB]`,
      imageData: dataUrl,
    })
    showToast('Image added as context')
  }
  reader.readAsDataURL(file)
}

function _looksLikeCode(text: string): boolean {
  const lines = text.split('\n')
  if (lines.length < 3) return false
  // Heuristics: indentation, brackets, common code patterns
  const indented = lines.filter((l) => /^\s{2,}/.test(l)).length
  const brackets = (text.match(/[{}()\[\];]/g) ?? []).length
  const keywords = (text.match(/\b(function|const|let|var|if|else|for|while|return|import|export|class|def|async|await|fn|pub|mod|struct|interface|type)\b/g) ?? []).length
  return indented >= 2 || brackets >= 4 || keywords >= 2
}

function _detectCodeLang(text: string): string {
  if (/^\s*(import|export|const|let|function|class|interface|type\s+\w+\s*=)/.test(text)) return 'typescript'
  if (/^\s*(def |class |import |from |print\(|if __name__)/.test(text)) return 'python'
  if (/^\s*(fn |use |pub |mod |let mut |impl )/.test(text)) return 'rust'
  if (/^\s*(package |import ".*"|func |type |struct )/.test(text)) return 'go'
  if (/^\s*(<\?php|namespace |use |class |function )/.test(text)) return 'php'
  if (/^\s*(#include|int main\(|void |printf\(|std::)/.test(text)) return 'cpp'
  if (/^\s*(<[a-zA-Z]|\{%|{{|<!DOCTYPE)/.test(text)) return 'html'
  if (/^\s*([.#]\w|@media|@keyframes|display:|margin:|padding:)/.test(text)) return 'css'
  if (/^\s*(\{|"[^"]+"\s*:)/.test(text)) return 'json'
  if (/^\s*(SELECT|INSERT|UPDATE|DELETE|CREATE|DROP)\b/i.test(text)) return 'sql'
  return ''
}

async function onTextareaPaste(e: ClipboardEvent): Promise<void> {
  const items = Array.from(e.clipboardData?.items ?? [])
  const imageItem = items.find((it) => it.type.startsWith('image/'))
  if (imageItem) {
    e.preventDefault()
    const file = imageItem.getAsFile()
    if (file) _addImageFile(file)
    return
  }
  // Rich paste: auto-wrap multi-line code-like text in code block.
  // Use getData() (synchronous) so e.preventDefault() fires before the default paste.
  const pasted = e.clipboardData?.getData('text/plain') ?? ''
  if (_looksLikeCode(pasted)) {
    const cur = inputText.value
    if (!cur.includes('```')) {
      e.preventDefault()
      const lang = _detectCodeLang(pasted)
      inputText.value = cur + `\`\`\`${lang}\n${pasted.trim()}\n\`\`\``
      showToast('Code detected — wrapped in code block')
      nextTick(() => textareaEl.value?.focus())
    }
  }
}

const dragOverChat = ref(false)
function onChatDragOver(e: DragEvent): void {
  // CLI pane header drag: payload is unreadable during dragover (browser
  // protected mode) — gate on dataTransfer.types only.
  const types = e.dataTransfer?.types ?? []
  const hasCli = types.includes(CLI_CONTEXT_MIME) || types.includes(PANE_ID_MIME)
  const hasFile = Array.from(e.dataTransfer?.items ?? []).some((it) => it.kind === 'file')
  const hasPath = !_chipDragId && types.includes('text/plain')
  if (hasCli || hasFile || hasPath) { e.preventDefault(); dragOverChat.value = true }
}

// ── CLI pane drag → context chip ─────────────────────────────────────────────
// Fetch the dragged pane's live session reference and rendered scrollback over
// the cross-window IPC bridge and attach them as a chip. With refreshTargetId set, update that chip in place
// (↻ button on an existing @cli: chip) instead of creating a new one.
async function applyCliPaneChip(payload: CliContextPayload, refreshTargetId?: string): Promise<void> {
  const getBuf = window.agentTeam?.getCliPaneBuffer
  let reply: {
    label?: string
    agentKey?: string
    sessionId?: string | null
    sessionHomeId?: string
    workspacePath?: string
    conversationLogPath?: string
    buffer?: string
    error?: string
  }
  try {
    reply = getBuf ? await getBuf(payload.paneId) : { error: 'unavailable' }
  } catch {
    reply = { error: 'unavailable' }
  }
  const result = buildCliContextChip(payload, reply)
  if (result.kind === 'error') {
    showToast(result.error === 'not-found' ? 'CLI pane is no longer open' : 'Could not fetch CLI pane output')
    return
  }
  if (result.kind === 'empty') {
    showToast('CLI pane has no output yet')
    return
  }
  if (refreshTargetId) {
    const chip = contextChips.value.find((c) => c.id === refreshTargetId)
    if (chip) { chip.content = result.content; showToast(`↻ ${chip.label}`) }
    return
  }
  // Re-dropping the same pane replaces the snapshot (matches file-drop behavior)
  contextChips.value = contextChips.value.filter((c) => c.label !== result.label)
  contextChips.value.push({
    id: crypto.randomUUID(),
    label: result.label,
    content: result.content,
    sourceId: result.sourceId,
  })
}

/** Handle a drop carrying CLI_CONTEXT_MIME, or a bare PANE_ID_MIME from other
 *  pane drag sources (e.g. ControlPane's agent list). Returns true if it was
 *  one (drop handled). */
async function handleCliContextDrop(e: DragEvent): Promise<boolean> {
  const cliRaw = e.dataTransfer?.getData(CLI_CONTEXT_MIME) ?? ''
  const paneIdRaw = e.dataTransfer?.getData(PANE_ID_MIME) ?? ''
  const payload = resolveCliDropPayload(cliRaw, paneIdRaw)
  if (payload === null) {
    // Diagnostic for "MIME didn't survive the window boundary": in-app pane
    // drags always carry one of the MIMEs above — log what actually arrived.
    const types = Array.from(e.dataTransfer?.types ?? [])
    if (types.length && !types.includes('Files')) console.warn('[cli-drop] types=', types)
    return false
  }
  if (payload === 'malformed') {
    console.warn('[cli-context] malformed drag payload:', cliRaw)
    showToast('Could not fetch CLI pane output')
    return true
  }
  await applyCliPaneChip(payload)
  return true
}

// Cross-window CLI pane drop. A pane dragged from a MAIN window never produces
// a drop event here (HTML5 DnD does not cross BrowserWindow boundaries), so it
// arrives as an IPC message carrying the screen coords where the pointer was
// released. Replay it as a chip only when that point actually lands on this
// chat; anywhere else in the editor window is a silent no-op. The pane id alone
// is enough — applyCliPaneChip's IPC reply fills in the authoritative live
// session reference and rendered excerpt.
const chatRootEl = ref<HTMLElement | null>(null)
let disposeExternalPaneDrop: (() => void) | null = null

onMounted(() => {
  const register = window.agentTeam?.onExternalPaneDrop
  if (!register) return
  disposeExternalPaneDrop = register(({ paneId, screenX, screenY }) => {
    const root = chatRootEl.value
    if (!paneId || !root) return
    const { x, y } = screenToClientPoint(
      { screenX, screenY },
      { screenX: window.screenX, screenY: window.screenY }
    )
    const el = document.elementFromPoint(x, y)
    if (!el || !root.contains(el)) return
    void applyCliPaneChip({ paneId, agentKey: '', label: '', sessionId: null })
  })
})
onUnmounted(() => {
  disposeExternalPaneDrop?.()
  disposeExternalPaneDrop = null
})

function onChatDragLeave(e: DragEvent): void {
  if (!(e.currentTarget as HTMLElement).contains(e.relatedTarget as Node)) {
    dragOverChat.value = false
  }
}
async function onChatDrop(e: DragEvent): Promise<void> {
  dragOverChat.value = false
  e.preventDefault()
  if (await handleCliContextDrop(e)) return
  const getPath = window.agentTeam?.getPathForFile
  const files = Array.from(e.dataTransfer?.files ?? [])
  for (const file of files) {
    if (file.type.startsWith('image/')) {
      _addImageFile(file)
      continue
    }
    const filePath = getPath ? getPath(file) : ''
    const wsRoot = props.workspacePath ? props.workspacePath.replace(/\/$/, '') : ''
    const relPath = filePath && wsRoot && (filePath === wsRoot || filePath.startsWith(wsRoot + '/'))
      ? filePath.slice(wsRoot.length).replace(/^\//, '')
      : file.name
    try {
      const text = await file.text()
      const MAX = 80_000
      const truncated = text.length > MAX ? text.slice(0, MAX) + '\n// … truncated' : text
      const ext = file.name.split('.').pop() ?? ''
      const chipLabel = `@${file.name}`
      contextChips.value = contextChips.value.filter((c) => c.label !== chipLabel)
      contextChips.value.push({
        id: crypto.randomUUID(),
        label: chipLabel,
        content: `// File: ${relPath}\n\`\`\`${ext}\n${truncated}\n\`\`\``,
      })
    } catch {
      showToast(`Could not read: ${file.name}`)
    }
  }
  // Handle in-app text/plain path drags (ExplorerPane, GitPane file rows)
  if (!files.length && !_chipDragId) {
    const text = e.dataTransfer?.getData('text/plain') ?? ''
    const paths = text ? text.split('\n').map((p) => p.trim()).filter(Boolean) : []
    const wsRoot = props.workspacePath ? props.workspacePath.replace(/\/$/, '') : ''
    for (const absPath of paths.slice(0, 5)) {
      const fileName = absPath.split('/').pop() ?? absPath
      const relPath = wsRoot && (absPath === wsRoot || absPath.startsWith(wsRoot + '/'))
        ? absPath.slice(wsRoot.length).replace(/^\//, '')
        : absPath
      const chipLabel = `@${fileName}`
      if (contextChips.value.some((c) => c.label === chipLabel)) continue
      try {
        interface ReadResp { ok: boolean; content?: string }
        const resp = await props.backend.send<ReadResp>('fs.read_file', {
          workspace_path: props.workspacePath,
          rel_path: relPath,
        })
        if (!resp.payload?.ok) { showToast(`Could not read: ${fileName}`); continue }
        const content = resp.payload?.content ?? ''
        const MAX = 80_000
        const truncated = content.length > MAX ? content.slice(0, MAX) + '\n// … truncated' : content
        const ext = fileName.split('.').pop() ?? ''
        contextChips.value.push({
          id: crypto.randomUUID(),
          label: chipLabel,
          content: `// File: ${relPath}\n\`\`\`${ext}\n${truncated}\n\`\`\``,
        })
      } catch {
        showToast(`Could not read: ${fileName}`)
      }
    }
  }
}

function onTextareaKeydown(e: KeyboardEvent): void {
  // IME guard: while composing (e.g. Zhuyin/Pinyin), Enter/arrows/Escape belong
  // to the input method (confirm/select/cancel candidate) — don't hijack them
  // for send, menu navigation, history, or stop-streaming.
  if (e.isComposing || e.keyCode === 229) return
  if (showSlashMenu.value) {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      slashMenuIdx.value = (slashMenuIdx.value + 1) % slashOptions.value.length
      nextTick(() => slashMenuEl.value?.querySelector<HTMLElement>('.active')?.scrollIntoView({ block: 'nearest' }))
      return
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault()
      slashMenuIdx.value = (slashMenuIdx.value - 1 + slashOptions.value.length) % slashOptions.value.length
      nextTick(() => slashMenuEl.value?.querySelector<HTMLElement>('.active')?.scrollIntoView({ block: 'nearest' }))
      return
    }
    if (e.key === 'Enter' || e.key === 'Tab') {
      e.preventDefault()
      const cmd = slashOptions.value[slashMenuIdx.value]
      if (cmd) selectSlashCommand(cmd)
      return
    }
    if (e.key === 'Escape') {
      showSlashMenu.value = false
      return
    }
  }

  if (showAtMenu.value) {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      atMenuIdx.value = (atMenuIdx.value + 1) % atOptions.value.length
      nextTick(() => atMenuEl.value?.querySelector<HTMLElement>('.active')?.scrollIntoView({ block: 'nearest' }))
      return
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault()
      atMenuIdx.value = (atMenuIdx.value - 1 + atOptions.value.length) % atOptions.value.length
      nextTick(() => atMenuEl.value?.querySelector<HTMLElement>('.active')?.scrollIntoView({ block: 'nearest' }))
      return
    }
    if (e.key === 'Enter' || e.key === 'Tab') {
      e.preventDefault()
      const opt = atOptions.value[atMenuIdx.value]
      if (opt) void selectAtOption(opt)
      return
    }
    if (e.key === 'Escape') {
      showAtMenu.value = false
      return
    }
  }

  if (e.key === 'Escape' && previewChipId.value) {
    previewChipId.value = null
    return
  }

  // Escape during streaming — stop generation (Cursor/VS Code parity)
  if (e.key === 'Escape' && sending.value) {
    e.preventDefault()
    stopStreaming()
    return
  }

  if (settingsSendMode.value === 'ctrl-enter') {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !e.shiftKey) {
      e.preventDefault()
      void sendMessage()
    }
  } else {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      void sendMessage()
    }
  }
  // Prompt history: Up/Down arrow when not in menus
  if (e.key === 'ArrowUp' && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) {
    const el = textareaEl.value
    if (el && inputHistory.length > 0 && el.selectionStart === 0) {
      e.preventDefault()
      if (historyIdx === -1) {
        historySavedDraft = inputText.value  // save draft before first navigation
        historyIdx = inputHistory.length - 1
      } else if (historyIdx > 0) historyIdx--
      inputText.value = inputHistory[historyIdx]
      nextTick(() => { if (el) { el.selectionStart = el.selectionEnd = el.value.length } })
    }
  }
  if (e.key === 'ArrowDown' && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey && historyIdx >= 0) {
    e.preventDefault()
    if (historyIdx < inputHistory.length - 1) {
      historyIdx++
      inputText.value = inputHistory[historyIdx]
    } else {
      historyIdx = -1
      inputText.value = historySavedDraft  // restore the draft that was in progress
      historySavedDraft = ''
    }
  }
  if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'f') {
    e.preventDefault()
    openGlobalSearch()
    return
  }
  if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
    e.preventDefault()
    openSearch()
  }
  if ((e.ctrlKey || e.metaKey) && e.key === 'n') {
    e.preventDefault()
    newThread()
  }
  // Ctrl+Shift+K — clear current conversation
  if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'k') {
    e.preventDefault()
    clearConversation()
  }
  // Ctrl+Shift+A — add current file as @file context chip
  if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'a') {
    e.preventDefault()
    const relPath = props.getActiveRelPath?.()
    if (!relPath) { showToast('No file open'); return }
    const content = props.getEditorContent?.() ?? ''
    const fileName = relPath.split('/').pop() ?? relPath
    if (content && !contextChips.value.some((c) => c.label.includes(fileName))) {
      contextChips.value.push({ id: crypto.randomUUID(), label: `@${fileName}`, content: `// File: ${relPath}\n${content}` })
      showToast(`Added @${fileName} to context`)
    }
  }
  // Ctrl+Shift+W — add current file to Edit working set (switches to Edit mode)
  if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'w') {
    e.preventDefault()
    const relPath = props.getActiveRelPath?.()
    if (!relPath) { showToast('No file open'); return }
    if (chatMode.value !== 'edit') chatMode.value = 'edit'
    addToWorkingSet(relPath)
    showToast(`Added ${relPath.split('/').pop()} to working set`)
  }
  // Ctrl+Shift+P — command palette: focus input and open slash menu (VS Code parity)
  if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'p') {
    e.preventDefault()
    textareaEl.value?.focus()
    const hadSlash = inputText.value.startsWith('/')
    if (!hadSlash) inputText.value = '/' + inputText.value
    showSlashMenu.value = true
    slashMenuFilter.value = hadSlash ? inputText.value.slice(1) : ''
    const f2 = slashMenuFilter.value.toLowerCase()
    const base2 = SLASH_COMMANDS.filter((c) => c.id.includes(f2))
    if (!f2 && recentCmds.value.length > 0) {
      const recent2 = recentCmds.value.map((id) => SLASH_COMMANDS.find((c) => c.id === id)).filter((c): c is SlashCommand => c !== undefined)
      const recentIds2 = new Set(recent2.map((c) => c.id))
      slashOptions.value = [...recent2, ...base2.filter((c) => !recentIds2.has(c.id))]
    } else {
      slashOptions.value = base2
    }
  }
  // Ctrl+Enter — regenerate last AI response (when not sending)
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter' && !sending.value && !e.shiftKey) {
    if (inputText.value.trim() === '' && lastAssistantIdx.value >= 0) {
      e.preventDefault()
      void regenerate()
    }
  }
  // Cmd+/ — cycle through models (Cursor-style shortcut)
  if ((e.ctrlKey || e.metaKey) && e.key === '/') {
    e.preventDefault()
    const cycleable = MODEL_CATALOG.filter((m) => m.provider !== 'auto')
    const idx = cycleable.findIndex((m) => m.id === settingsModel.value)
    const next = cycleable[(idx + 1) % cycleable.length]
    if (next) { switchModel(next.id); showToast(`Model: ${next.display}`) }
  }
  // Backspace at start of empty input — remove last context chip (VS Code/Cursor UX)
  if (e.key === 'Backspace' && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey) {
    const el = textareaEl.value
    if (el && el.selectionStart === 0 && el.selectionEnd === 0 && inputText.value === '' && contextChips.value.length > 0) {
      e.preventDefault()
      contextChips.value.pop()
    }
  }
}

// Auto-resize textarea
watch(inputText, async () => {
  await nextTick()
  const el = textareaEl.value
  if (!el) return
  el.style.height = 'auto'
  el.style.height = Math.min(el.scrollHeight, 200) + 'px'
})

// Close @ / slash menus on click outside
function onClickOutside(e: MouseEvent): void {
  if (atMenuEl.value && !atMenuEl.value.contains(e.target as Node)) {
    showAtMenu.value = false
  }
  if (slashMenuEl.value && !slashMenuEl.value.contains(e.target as Node)) {
    showSlashMenu.value = false
  }
  const modelBar = document.querySelector('.ai-model-bar')
  if (modelBar && !modelBar.contains(e.target as Node)) {
    showModelPicker.value = false
  }
  const regenWrap = document.querySelector('.ai-regen-model-wrap')
  if (regenWrap && !regenWrap.contains(e.target as Node)) {
    regenModelOpen.value = false
  }
}

onMounted(() => document.addEventListener('click', onClickOutside))
onUnmounted(() => document.removeEventListener('click', onClickOutside))

defineExpose({
  focusInput: () => { textareaEl.value?.focus() },
  addContextChip: (label: string, content: string) => {
    if (!contextChips.value.some((c) => c.label === label)) {
      contextChips.value.push({ id: crypto.randomUUID(), label, content })
    }
    void nextTick(() => textareaEl.value?.focus())
  },
  injectDraft: (text: string) => {
    inputText.value = text
    void nextTick(() => textareaEl.value?.focus())
  },
})

// ── Copy all messages to clipboard ────────────────────────────────────────────
function copyAllMessages(): void {
  const msgs = messages.value.filter((m) => !m.streaming && m.content)
  if (!msgs.length) { showToast('No messages to copy'); return }
  let md = ''
  for (const m of msgs) {
    const label = m.role === 'user' ? '**You**' : `**AI**${m.model ? ` (${m.model})` : ''}`
    md += `${label}:\n${m.content}\n\n---\n\n`
  }
  navigator.clipboard.writeText(md.trim()).then(() => showToast('Conversation copied')).catch(() => showToast('Copy failed'))
}

// ── Conversation Checkpoints (Cursor-style snapshots) ─────────────────────────
function saveCheckpoint(name?: string): void {
  const snap = messages.value.filter((m) => !m.streaming).map((m) => ({ ...m }))
  if (!snap.length) { showToast('Nothing to checkpoint'); return }
  const label = name?.trim() || `Checkpoint ${checkpoints.value.length + 1} (${snap.length} msgs)`
  const cp: ChatCheckpoint = {
    id: `cp-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    name: label,
    timestamp: Date.now(),
    messagesSnapshot: snap,
  }
  checkpoints.value = [cp, ...checkpoints.value].slice(0, 10)  // keep last 10
  saveCurrentThread()
  showToast(`Checkpoint saved: ${label}`)
}

function restoreCheckpoint(cp: ChatCheckpoint): void {
  let proceeded = false
  twoClick(`restore-${cp.id}`, () => { proceeded = true }, 'Restore', `Restore "${cp.name}"? Will replace ${messages.value.length} messages — click again to confirm`)
  if (!proceeded) return
  messages.value = cp.messagesSnapshot.map((m) => ({ ...m, streaming: false, thinking: false }))
  // Clear any in-flight /compact state so its handler doesn't overwrite the restored messages
  pendingCompactKeep.value = []
  pendingCompactAllMessages.value = []
  saveCurrentThread()
  showCheckpoints.value = false
  showToast(`Restored: ${cp.name}`)
  nextTick(() => void scrollBottom())
}

function deleteCheckpoint(id: string): void {
  checkpoints.value = checkpoints.value.filter((c) => c.id !== id)
  saveCurrentThread()
}

// ── Message bookmarks ─────────────────────────────────────────────────────────
const showBookmarks = ref(false)

function toggleBookmark(mi: number): void {
  const msg = messages.value[mi]
  if (msg) { msg.bookmarked = !msg.bookmarked; saveCurrentThread() }
}

const bookmarkedMessages = computed(() =>
  messages.value.map((m, i) => ({ msg: m, idx: i })).filter(({ msg }) => msg.bookmarked)
)

// Context-aware quick action suggestions for the empty state (mirrors VS Code Copilot smart actions)
const emptySuggestions = computed<Array<{ label: string; action: string }>>(() => {
  const relPath = props.getActiveRelPath?.() ?? ''
  const ext = relPath.split('.').pop()?.toLowerCase() ?? ''
  const isTest = /\.(test|spec)\.(ts|tsx|js|jsx|py)$/.test(relPath) || relPath.includes('__tests__')
  // Diagnostics-first: if the current file has errors, surface /fix prominently
  const fileDiagCount = relPath ? allDiagnosticsSorted().filter((d) => d.relPath === relPath && d.severity === 'error').length : 0
  if (fileDiagCount > 0) {
    return [
      { label: `/fix — ${fileDiagCount} error${fileDiagCount > 1 ? 's' : ''} in this file`, action: '/fix ' },
      { label: '/explain — explain code', action: '/explain ' },
      { label: '/review — code review', action: '/review ' },
      { label: '/tests — generate unit tests', action: '/tests ' },
    ]
  }
  if (isTest) {
    return [
      { label: '/fixtests — run & fix failing tests', action: '/fixtests' },
      { label: '/explain — explain what this test does', action: '/explain ' },
      { label: '/review — review test quality', action: '/review ' },
      { label: '/mock — generate mock helpers', action: '/mock ' },
    ]
  }
  if (ext === 'py') {
    return [
      { label: '/explain — explain Python code', action: '/explain ' },
      { label: '/tests — generate pytest tests', action: '/tests ' },
      { label: '/security — security audit', action: '/security ' },
      { label: '/types — add type hints', action: '/types ' },
    ]
  }
  if (['vue', 'jsx', 'tsx'].includes(ext)) {
    return [
      { label: '/explain — explain component', action: '/explain ' },
      { label: '/tests — generate component tests', action: '/tests ' },
      { label: '/review — component code review', action: '/review ' },
      { label: '/optimize — performance check', action: '/optimize ' },
    ]
  }
  return [
    { label: '/explain — explain code', action: '/explain ' },
    { label: '/fix — find and fix issues', action: '/fix ' },
    { label: '/tests — generate unit tests', action: '/tests ' },
    { label: '/review — code review', action: '/review ' },
  ]
})

function jumpToBookmark(idx: number): void {
  const el = messagesEl.value?.querySelectorAll('.ai-msg')[idx] as HTMLElement | undefined
  el?.scrollIntoView({ block: 'center', behavior: 'smooth' })
  showBookmarks.value = false
}

// ── Message feedback ──────────────────────────────────────────────────────────
const feedbackInputMi = ref<number | null>(null)
const zoomedImageSrc = ref<string | null>(null)
const feedbackDraft = ref('')
function submitFeedbackComment(mi: number): void {
  const msg = messages.value[mi]
  if (!msg) return
  if (feedbackDraft.value.trim()) msg.feedbackComment = feedbackDraft.value.trim()
  feedbackInputMi.value = null
  feedbackDraft.value = ''
  saveCurrentThread()
}
function toggleFeedback(mi: number, type: 'up' | 'down'): void {
  const msg = messages.value[mi]
  if (!msg) return
  const wasSet = msg.feedback === type
  msg.feedback = wasSet ? undefined : type
  if (!wasSet && type === 'down') {
    feedbackInputMi.value = mi
    feedbackDraft.value = msg.feedbackComment ?? ''
  } else if (wasSet) {
    feedbackInputMi.value = null
  }
  saveCurrentThread()
}

// ── Message date separators ────────────────────────────────────────────────────
function showDateSep(mi: number): boolean {
  const ts = messages.value[mi]?.timestamp
  if (!ts) return false
  if (mi === 0) return true
  const prevTs = messages.value[mi - 1]?.timestamp
  if (!prevTs) return true
  return new Date(ts).toDateString() !== new Date(prevTs).toDateString()
}
function getDateLabel(ts: number): string {
  const d = new Date(ts)
  const now = new Date()
  const yesterday = new Date(now)
  yesterday.setDate(yesterday.getDate() - 1)
  if (d.toDateString() === now.toDateString()) return 'Today'
  if (d.toDateString() === yesterday.toDateString()) return 'Yesterday'
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' })
}
function showModelChange(mi: number): string | null {
  const msg = messages.value[mi]
  if (!msg || msg.role !== 'assistant' || !msg.model) return null
  for (let i = mi - 1; i >= 0; i--) {
    const prev = messages.value[i]
    if (prev.role === 'assistant' && prev.model) {
      if (prev.model !== msg.model) {
        return MODEL_CATALOG.find(m => m.id === msg.model)?.display ?? msg.model
      }
      return null
    }
  }
  return null
}
</script>

<template>
  <div
    ref="chatRootEl"
    class="ai-chat"
    :class="{ 'ai-drag-over': dragOverChat }"
    @dragover.prevent="onChatDragOver"
    @dragleave="onChatDragLeave"
    @drop.prevent="onChatDrop"
  >
    <!-- Global cross-thread search overlay (Ctrl+Shift+F) -->
    <div v-if="showGlobalSearch" class="ai-global-search-overlay" @click.self="closeGlobalSearch">
      <div class="ai-global-search-box">
        <div class="ai-global-search-header">
          <input
            ref="globalSearchInput"
            v-model="globalSearchQuery"
            class="ai-global-search-input"
            :placeholder="$t('label.search-all-chats')"
            @keydown.escape="closeGlobalSearch"
            @keydown="onGlobalSearchKeydown"
          />
          <button class="ai-global-search-close" @click="closeGlobalSearch">✕</button>
        </div>
        <div class="ai-global-search-results">
          <div v-if="globalSearchQuery.trim().length >= 2 && globalSearchResults.length === 0" class="ai-global-search-empty">
            No results across {{ allThreads.length }} threads
          </div>
          <button
            v-for="(r, i) in globalSearchResults"
            :key="i"
            class="ai-global-search-result"
            :class="{ 'gsr-active': i === globalSearchActiveIdx }"
            @click="jumpToGlobalResult(r)"
            @mouseenter="globalSearchActiveIdx = i"
          >
            <span class="ai-gsr-thread">{{ r.threadTitle }}</span>
            <span class="ai-gsr-role">{{ r.role === 'user' ? 'You' : 'AI' }}</span>
            <!-- eslint-disable-next-line vue/no-v-html -->
            <span class="ai-gsr-snippet" v-html="highlightSearchMatch(r.snippet, globalSearchQuery.trim())" />
          </button>
        </div>
        <div class="ai-global-search-footer">
          {{ globalSearchResults.length > 0 ? `${globalSearchResults.length} result${globalSearchResults.length > 1 ? 's' : ''} across all threads` : '' }}
        </div>
      </div>
    </div>

    <!-- Backend offline banner -->
    <div v-if="props.backend.status.value === 'disconnected' || props.backend.status.value === 'error'" class="ai-offline-banner">
      <span>⚠ Backend disconnected — messages won't send until reconnected</span>
    </div>
    <!-- Messages list -->
    <!-- No `.prevent` here: onMsgContextMenu calls preventDefault itself once it
         has a message to act on. Blanket-preventing would swallow the default
         menu on every other target and leave right-click dead there. -->
    <div ref="messagesEl" class="ai-messages" @click="onMessagesClick" @contextmenu="onMsgContextMenu" @scroll.passive="onMessagesScroll" @mouseover="onMessagesMouseover">
      <div v-if="messages.length === 0" class="ai-empty">
        <svg width="28" height="28" viewBox="0 0 16 16" fill="currentColor" style="opacity:.3">
          <path d="M8 0L9.5 5.5L15 7L9.5 8.5L8 14L6.5 8.5L1 7L6.5 5.5Z"/>
        </svg>
        <p class="ai-empty-title">AI assistant ready</p>
        <p class="ai-empty-hint">@ to add context &nbsp;·&nbsp; / for commands &nbsp;·&nbsp; Enter to send</p>
        <div class="ai-empty-suggestions">
          <button
            v-for="s in emptySuggestions"
            :key="s.action"
            class="ai-empty-btn"
            @click="inputText = s.action; nextTick(() => textareaEl?.focus())"
          >{{ s.label }}</button>
        </div>
        <!-- Cursor-style: show active file suggestion when one is open -->
        <div v-if="props.getActiveRelPath?.()" class="ai-empty-file-hint">
          <svg width="11" height="11" viewBox="0 0 16 16" fill="currentColor" style="opacity:.5;flex-shrink:0"><path d="M2 1.75C2 .784 2.784 0 3.75 0h6.586c.464 0 .909.184 1.237.513l2.914 2.914c.329.328.513.773.513 1.237v9.586A1.75 1.75 0 0 1 13.25 16h-9.5A1.75 1.75 0 0 1 2 14.25Zm1.75-.25a.25.25 0 0 0-.25.25v12.5c0 .138.112.25.25.25h9.5a.25.25 0 0 0 .25-.25V6h-2.75A1.75 1.75 0 0 1 9 4.25V1.5Zm6.75.062V4.25c0 .138.112.25.25.25h2.688l-.011-.013-2.914-2.914-.013-.011Z"/></svg>
          <span>Active: <code>{{ props.getActiveRelPath?.()?.split('/').pop() }}</code></span>
          <button class="ai-empty-file-btn" @click="inputText = '@file '; nextTick(() => textareaEl?.focus())">Add to context</button>
        </div>
        <!-- Recent threads quick-jump (Cursor-style) — shown when there are prior chats -->
        <div v-if="allThreads.filter(t => t.id !== currentThreadId && t.messages.length > 0).length > 0" class="ai-empty-recents">
          <p class="ai-empty-recents-label">Recent chats</p>
          <div
            v-for="t in allThreads.filter(th => th.id !== currentThreadId && th.messages.length > 0).slice(0, 4)"
            :key="t.id"
            class="ai-empty-recent-item"
            @click="switchThread(t.id)"
          >
            <span class="ai-empty-recent-title">{{ t.title }}</span>
            <span class="ai-empty-recent-meta">{{ t.messages.length }} msgs</span>
          </div>
        </div>
      </div>

      <template v-for="(msg, mi) in messages" :key="mi">
        <!-- Date separator -->
        <div v-if="msg.timestamp && showDateSep(mi)" class="ai-date-sep">
          <span class="ai-date-sep-label">{{ getDateLabel(msg.timestamp) }}</span>
        </div>
        <!-- Model change separator -->
        <div v-if="showModelChange(mi)" class="ai-model-sep">
          <span class="ai-model-sep-label">{{ showModelChange(mi) }}</span>
        </div>
        <!-- Context window cutoff — messages above here are outside the model's context -->
        <div v-if="ctxCutoffIdx > 0 && mi === ctxCutoffIdx" class="ai-ctx-cutoff">
          <span class="ai-ctx-cutoff-label" :title="`Estimated context window limit (${currentModelCtx.toLocaleString()} tokens). Messages above may not be visible to the AI.`">⬆ context window starts here</span>
        </div>
      <div
        class="ai-msg-wrap ai-msg"
        :class="[msg.role, { 'search-match': isSearchMatch(mi), 'search-active': isSearchActive(mi) }]"
        :data-mi="mi"
      >
        <!-- Bubble -->
        <div class="ai-bubble" :class="[msg.role, { 'ai-bubble--pinned': msg.pinned }]" @dblclick="msg.role === 'user' && !msg.streaming ? startInlineEdit(mi) : undefined">
          <span v-if="msg.pinned" class="ai-pin-badge" title="Pinned message">⭐</span>
          <!-- Inline edit mode (Cursor-style: double-click user bubble to edit) -->
          <template v-if="editingMsgIdx === mi">
            <textarea
              :id="`ai-inline-edit-${mi}`"
              v-model="editingMsgText"
              class="ai-inline-edit-ta"
              rows="4"
              @keydown.enter.exact.prevent="submitInlineEdit(mi)"
              @keydown.escape.prevent="cancelInlineEdit"
            />
            <div class="ai-inline-edit-actions">
              <span class="ai-inline-edit-hint">Enter to resend · Esc to cancel</span>
              <button class="ai-cancel-btn" @click="cancelInlineEdit">Cancel</button>
              <button class="ai-send-btn" style="padding:3px 10px;font-size:11px" @click="submitInlineEdit(mi)">Resend</button>
            </div>
          </template>
          <!-- Text content -->
          <!-- eslint-disable-next-line vue/no-v-html -->
          <div
            v-else-if="msg.content"
            class="ai-text"
            :class="{ 'ai-text-folded': isMsgFolded(mi, msg.content) }"
            v-html="renderWithSearchHighlight(msg.content)"
          />
          <button
            v-if="msg.content && !msg.streaming && msg.content.split('\n').length > MSG_FOLD_LINE_THRESHOLD"
            class="ai-fold-btn"
            @click="toggleMsgFold(mi)"
          >{{ isMsgFolded(mi, msg.content) ? `▼ Show more (${msg.content.split('\n').length} lines)` : '▲ Show less' }}</button>

          <!-- Image thumbnail (user messages with pasted image) -->
          <img
            v-if="msg.imageData && msg.role === 'user'"
            :src="msg.imageData"
            class="ai-msg-img-thumb"
            alt="pasted image"
            :title="$t('action.click-to-zoom')"
            @click="zoomedImageSrc = msg.imageData ?? null"
          />
          <!-- Extended thinking block (collapsible) -->
          <details
            v-if="msg.thinkingContent"
            class="ai-thinking-details"
            :open="msg.thinkingExpanded"
            @toggle="msg.thinkingExpanded = ($event.target as HTMLDetailsElement).open"
          >
            <summary class="ai-thinking-summary">
              <span class="ai-thinking-icon">🧠</span> Thinking
              <span class="ai-thinking-tokens">~{{ Math.ceil(msg.thinkingContent.length / 4) }} tokens</span>
            </summary>
            <!-- eslint-disable-next-line vue/no-v-html -->
            <div class="ai-thinking-content" v-html="renderMarkdownLite(msg.thinkingContent)" />
          </details>

          <!-- Cards (tool calls / edit proposals) -->
          <template v-if="msg.cards">
            <template v-for="(card, ci) in msg.cards" :key="ci">
              <!-- Tool call card -->
              <div v-if="card.kind === 'tool_call'" class="ai-tool-card" :class="{ 'ai-tool-pending': card.result == null }">
                <div class="ai-tool-header" @click="card.collapsed = !card.collapsed">
                  <span class="ai-tool-icon">{{ getToolIcon(card.tool_name) }}</span>
                  <span class="ai-tool-name">{{ getToolSummary(card.tool_name, card.tool_input) }}</span>
                  <span v-if="card.result == null" class="ai-tool-spinner" />
                  <span v-else class="ai-tool-done">✓</span>
                  <span class="ai-tool-toggle">{{ card.collapsed ? '▶' : '▼' }}</span>
                </div>
                <div v-if="!card.collapsed" class="ai-tool-body">
                  <!-- Readable input summary based on tool type -->
                  <div v-if="card.tool_name === 'edit_file' && (card.tool_input as Record<string,unknown>).instructions" class="ai-tool-param">
                    <span class="ai-tool-param-label">Instructions: </span>
                    <span class="ai-tool-param-val">{{ (card.tool_input as Record<string,unknown>).instructions }}</span>
                  </div>
                  <div v-else-if="card.tool_name === 'search_files' && (card.tool_input as Record<string,unknown>).query" class="ai-tool-param">
                    <span class="ai-tool-param-label">Query: </span>
                    <code class="ai-tool-code-inline">{{ (card.tool_input as Record<string,unknown>).query }}</code>
                    <span v-if="(card.tool_input as Record<string,unknown>).file_pattern" class="ai-tool-param-val"> in {{ (card.tool_input as Record<string,unknown>).file_pattern }}</span>
                  </div>
                  <div v-else-if="card.tool_name === 'run_command' && (card.tool_input as Record<string,unknown>).command" class="ai-tool-param">
                    <code class="ai-tool-code-inline">$ {{ (card.tool_input as Record<string,unknown>).command }}</code>
                  </div>
                  <div v-else-if="!['read_file','list_directory','glob_files','write_file'].includes(card.tool_name)" class="ai-tool-param">
                    <pre class="ai-tool-pre">{{ JSON.stringify(card.tool_input, null, 2) }}</pre>
                  </div>
                  <!-- Result: code-style pre for file/command output, plain for others -->
                  <template v-if="card.result != null">
                    <pre v-if="['read_file', 'write_file', 'run_command'].includes(card.tool_name)" class="ai-tool-result-pre">{{ String(card.result).slice(0, 2000) }}{{ String(card.result).length > 2000 ? '\n…truncated' : '' }}</pre>
                    <div v-else class="ai-tool-result">
                      <span class="ai-tool-result-label">Result: </span>{{ card.result }}
                    </div>
                  </template>
                </div>
              </div>

              <!-- Command proposal card -->
              <div v-else-if="card.kind === 'command_proposal'" class="ai-cmd-card" :class="card.status">
                <div class="ai-cmd-header">
                  <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path d="M0 2.75C0 1.784.784 1 1.75 1h12.5c.966 0 1.75.784 1.75 1.75v10.5A1.75 1.75 0 0 1 14.25 15H1.75A1.75 1.75 0 0 1 0 13.25Zm1.75-.25a.25.25 0 0 0-.25.25v10.5c0 .138.112.25.25.25h12.5a.25.25 0 0 0 .25-.25V2.75a.25.25 0 0 0-.25-.25ZM7.25 8a.75.75 0 0 1-.22.53l-2.25 2.25a.749.749 0 1 1-1.06-1.06L5.44 8 3.72 6.28a.749.749 0 1 1 1.06-1.06l2.25 2.25c.141.14.22.331.22.53Zm1.5 1.5h3a.75.75 0 0 1 0 1.5h-3a.75.75 0 0 1 0-1.5Z"/></svg>
                  <span class="ai-cmd-label">Run command</span>
                  <span v-if="card.status === 'approved'" class="ai-cmd-status approved">Executed ✓</span>
                  <span v-else-if="card.status === 'rejected'" class="ai-cmd-status rejected">Rejected ✕</span>
                  <div v-else class="ai-cmd-actions">
                    <button class="ai-cmd-btn approve" @click="approveCommand(card)">Run</button>
                    <button class="ai-cmd-btn reject" @click="rejectCommand(card)">Reject</button>
                  </div>
                </div>
                <pre class="ai-cmd-pre">$ {{ card.command }}{{ card.cwd ? `\n# cwd: ${card.cwd}` : '' }}</pre>
              </div>

              <!-- Edit proposal card -->
              <div v-else-if="card.kind === 'edit_proposal' && !card.discarded" class="ai-edit-card">
                <div class="ai-edit-header" @click="toggleDiff(card.tool_id)" style="cursor:pointer">
                  <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path d="M11.013 1.427a1.75 1.75 0 0 1 2.474 0l1.086 1.086a1.75 1.75 0 0 1 0 2.474l-8.61 8.61c-.21.21-.47.364-.756.445l-3.251.93a.75.75 0 0 1-.927-.928l.929-3.25c.081-.286.235-.547.445-.758l8.61-8.61Zm.176 4.823L9.75 4.81l-6.286 6.287a.253.253 0 0 0-.064.108l-.558 1.953 1.953-.558a.253.253 0 0 0 .108-.064Zm1.238-3.763a.25.25 0 0 0-.354 0L10.811 3.75l1.439 1.44 1.263-1.263a.25.25 0 0 0 0-.354Z"/></svg>
                  <span class="ai-edit-path">{{ card.file_path }}</span>
                  <span class="ai-diff-stat">
                    <span class="diff-add-count">+{{ card.diff.split('\n').filter(l => l.startsWith('+') && !l.startsWith('+++')).length }}</span>
                    <span class="diff-del-count"> −{{ card.diff.split('\n').filter(l => l.startsWith('-') && !l.startsWith('---')).length }}</span>
                  </span>
                  <span class="ai-diff-toggle-icon">{{ isDiffExpanded(card.tool_id) ? '▾' : '▸' }}</span>
                  <div v-if="!card.accepted" class="ai-edit-actions" @click.stop>
                    <button class="ai-edit-btn accept" @click="acceptEdit(card)">Accept</button>
                    <button class="ai-edit-btn discard" @click="discardEdit(card)">Discard</button>
                  </div>
                  <span v-else class="ai-edit-accepted">Applied ✓</span>
                </div>
                <div v-if="isDiffExpanded(card.tool_id)" class="ai-diff-view" v-html="renderDiff(card.diff)" />
              </div>
            </template>
          </template>

          <!-- Thinking indicator (before first chunk) -->
          <div v-if="msg.thinking" class="ai-thinking">
            <span class="ai-thinking-dot" />
            <span class="ai-thinking-dot" />
            <span class="ai-thinking-dot" />
            <span class="ai-thinking-label">{{ thinkingLabel }}</span>
          </div>
          <span v-else-if="msg.streaming" class="ai-cursor">▍</span>
          <span v-if="msg.streaming && msg.content.length > 0" class="ai-stream-tokens">
            ~{{ Math.ceil(msg.content.length / 4) }}t
            <template v-if="msg.responseStartMs && streamNow - msg.responseStartMs > 500">
              · {{ Math.round(Math.ceil(msg.content.length / 4) / ((streamNow - msg.responseStartMs) / 1000)) }}t/s
            </template>
          </span>

          <!-- Error card -->
          <div v-if="msg.isError" class="ai-error-card">
            <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" style="flex-shrink:0">
              <path d="M6.457 1.047c.659-1.234 2.427-1.234 3.086 0l6.082 11.378A1.75 1.75 0 0 1 14.082 15H1.918a1.75 1.75 0 0 1-1.543-2.575Zm1.763.707a.25.25 0 0 0-.44 0L1.698 13.132a.25.25 0 0 0 .22.368h12.164a.25.25 0 0 0 .22-.368Zm.53 3.996v2.5a.75.75 0 0 1-1.5 0v-2.5a.75.75 0 0 1 1.5 0ZM9 11a1 1 0 1 1-2 0 1 1 0 0 1 2 0Z"/>
            </svg>
            <span class="ai-error-msg">{{ msg.errorMsg || 'An error occurred' }}</span>
            <button class="ai-error-retry" @click="retryAfterError">Retry</button>
          </div>
        </div>
        <!-- Used references (Cursor-style context indicator under user messages) -->
        <div v-if="msg.role === 'user' && msg.contextRefs?.length" class="ai-used-refs">
          <svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor"><path d="M1.75 1h8.5c.966 0 1.75.784 1.75 1.75v5.5A1.75 1.75 0 0 1 10.25 10H7.061l-2.574 2.573A1.458 1.458 0 0 1 2 11.543V10h-.25A1.75 1.75 0 0 1 0 8.25v-5.5C0 1.784.784 1 1.75 1ZM1.5 2.75v5.5c0 .138.112.25.25.25h1a.75.75 0 0 1 .75.75v2.19l2.72-2.72a.749.749 0 0 1 .53-.22h3.5a.25.25 0 0 0 .25-.25v-5.5a.25.25 0 0 0-.25-.25h-8.5a.25.25 0 0 0-.25.25Z"/></svg>
          <span class="ai-used-refs-count">{{ msg.contextRefs.length }} {{ msg.contextRefs.length === 1 ? 'reference' : 'references' }}</span>
          <span v-for="ref in msg.contextRefs.slice(0, 5)" :key="ref" class="ai-used-ref-chip">{{ ref }}</span>
          <span v-if="msg.contextRefs.length > 5" class="ai-used-refs-more">+{{ msg.contextRefs.length - 5 }} more</span>
        </div>
        <!-- Detected commit message — show "Run Commit" button -->
        <div v-if="msg.role === 'assistant' && msg.commitMsg && !msg.streaming" class="ai-commit-action">
          <span class="ai-commit-msg-preview">{{ msg.commitMsg }}</span>
          <button class="ai-commit-run-btn" title="Run git commit with this message" @click="runCommit(msg)">
            <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path d="M11.75 2.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm-2.25.75a2.25 2.25 0 1 1 3 2.122V6A2.5 2.5 0 0 1 10 8.5H6a1 1 0 0 0-1 1v1.128a2.251 2.251 0 1 1-1.5 0V5.372a2.25 2.25 0 1 1 1.5 0v1.836A2.492 2.492 0 0 1 6 7h4a1 1 0 0 0 1-1v-.628A2.25 2.25 0 0 1 9.5 3.25ZM4.25 12a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5ZM3.5 3.25a.75.75 0 1 1 1.5 0 .75.75 0 0 1-1.5 0Z"/></svg>
            Run git commit
          </button>
        </div>
        <!-- Accept All / Reject All bar for last assistant message -->
        <div
          v-if="msg.role === 'assistant' && mi === lastAssistantIdx && pendingEditsInLastMsg.length >= 2"
          class="ai-bulk-actions"
        >
          <button class="ai-bulk-btn accept" @click="acceptAllEdits">Accept All ({{ pendingEditsInLastMsg.length }})</button>
          <button class="ai-bulk-btn discard" @click="discardAllEdits">Reject All</button>
        </div>
        <!-- Message action bar (copy / regenerate / model badge) -->
        <div class="ai-msg-actions" :class="msg.role">
          <button
            v-if="msg.role === 'user' && !sending"
            class="ai-msg-action-btn"
            title="Edit & resend"
            @click="editMessage(mi)"
          >
            <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path d="M11.013 1.427a1.75 1.75 0 0 1 2.474 0l1.086 1.086a1.75 1.75 0 0 1 0 2.474l-8.61 8.61c-.21.21-.47.364-.756.445l-3.251.93a.75.75 0 0 1-.927-.928l.929-3.25c.081-.286.235-.547.445-.758l8.61-8.61Zm.176 4.823L9.75 4.81l-6.286 6.287a.253.253 0 0 0-.064.108l-.558 1.953 1.953-.558a.253.253 0 0 0 .108-.064Zm1.238-3.763a.25.25 0 0 0-.354 0L10.811 3.75l1.439 1.44 1.263-1.263a.25.25 0 0 0 0-.354Z"/></svg>
          </button>
          <button
            v-if="msg.role === 'user' && !sending && mi > 0"
            class="ai-msg-action-btn"
            title="Fork — continue from here in a new chat"
            @click="forkFromMessage(mi)"
          >
            <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path d="M5 3.25a.75.75 0 1 1-1.5 0 .75.75 0 0 1 1.5 0Zm0 2.122a2.25 2.25 0 1 0-1.5 0v.878A2.25 2.25 0 0 0 5.75 8.5h1.5v2.128a2.251 2.251 0 1 0 1.5 0V8.5h1.5a2.25 2.25 0 0 0 2.25-2.25v-.878a2.25 2.25 0 1 0-1.5 0v.878a.75.75 0 0 1-.75.75h-4.5A.75.75 0 0 1 5 6.25v-.878Zm3.75 7.378a.75.75 0 1 1-1.5 0 .75.75 0 0 1 1.5 0Zm3-8.75a.75.75 0 1 1-1.5 0 .75.75 0 0 1 1.5 0Z"/></svg>
          </button>
          <button
            v-if="msg.role === 'assistant' && !msg.streaming"
            class="ai-msg-action-btn"
            :title="$t('action.quote-reply')"
            @click="quoteReply(msg)"
          >
            <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path d="M2.75 2.5a.25.25 0 0 0-.25.25v7.5c0 .138.112.25.25.25h1a.75.75 0 0 1 .75.75v1.19l1.72-1.72a.749.749 0 0 1 .53-.22h6.5a.25.25 0 0 0 .25-.25v-7.5a.25.25 0 0 0-.25-.25ZM1 2.75C1 1.784 1.784 1 2.75 1h10.5c.966 0 1.75.784 1.75 1.75v7.5A1.75 1.75 0 0 1 13.25 12H7.81l-2.53 2.53a.749.749 0 0 1-1.28-.53V12h-.25A1.75 1.75 0 0 1 2 10.25v-7.5ZM5.5 6.25a.75.75 0 0 1 .75-.75h4.5a.75.75 0 0 1 0 1.5h-4.5a.75.75 0 0 1-.75-.75Zm.75 2.25h2.5a.75.75 0 0 1 0 1.5H6.25a.75.75 0 0 1 0-1.5Z"/></svg>
          </button>
          <button class="ai-msg-action-btn" title="Copy" @click="copyMessage(msg.content)">
            <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path d="M0 6.75C0 5.784.784 5 1.75 5h1.5a.75.75 0 0 1 0 1.5h-1.5a.25.25 0 0 0-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 0 0 .25-.25v-1.5a.75.75 0 0 1 1.5 0v1.5A1.75 1.75 0 0 1 9.25 16h-7.5A1.75 1.75 0 0 1 0 14.25Z"/><path d="M5 1.75C5 .784 5.784 0 6.75 0h7.5C15.216 0 16 .784 16 1.75v7.5A1.75 1.75 0 0 1 14.25 11h-7.5A1.75 1.75 0 0 1 5 9.25Zm1.75-.25a.25.25 0 0 0-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 0 0 .25-.25v-7.5a.25.25 0 0 0-.25-.25Z"/></svg>
          </button>
          <!-- Add AI response as context chip (Cursor-style: use response in next message) -->
          <button
            v-if="msg.role === 'assistant' && !msg.streaming"
            class="ai-msg-action-btn"
            :title="$t('action.add-as-context')"
            @click="addResponseAsContext(msg)"
          >
            <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path d="M1.75 2h12.5c.966 0 1.75.784 1.75 1.75v8.5A1.75 1.75 0 0 1 14.25 14H1.75A1.75 1.75 0 0 1 0 12.25v-8.5C0 2.784.784 2 1.75 2ZM1.5 3.75v.5c.918.553 2.963 1.785 4.78 2.886A1.75 1.75 0 0 0 8 7.5c.641 0 1.245-.332 1.72-.864C11.537 6.035 13.582 4.803 14.5 4.25v-.5a.25.25 0 0 0-.25-.25H1.75a.25.25 0 0 0-.25.25ZM1.5 6.893v5.357c0 .138.112.25.25.25h12.5a.25.25 0 0 0 .25-.25V6.893l-4.064 2.45a3.25 3.25 0 0 1-3.372 0Z"/></svg>
          </button>
          <!-- Delete message pair (user + AI response) -->
          <button
            v-if="msg.role === 'user' && !sending"
            class="ai-msg-action-btn ai-msg-delete-btn"
            :title="$t('action.delete-exchange')"
            @click="deleteMessagePair(mi)"
          >
            <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path d="M11 1.75V3h2.25a.75.75 0 0 1 0 1.5H2.75a.75.75 0 0 1 0-1.5H5V1.75C5 .784 5.784 0 6.75 0h2.5C10.216 0 11 .784 11 1.75ZM4.496 6.675l.66 6.6a.25.25 0 0 0 .249.225h5.19a.25.25 0 0 0 .249-.225l.66-6.6a.75.75 0 0 1 1.492.149l-.66 6.6A1.748 1.748 0 0 1 10.595 15h-5.19a1.75 1.75 0 0 1-1.741-1.575l-.66-6.6a.75.75 0 1 1 1.492-.15ZM6.5 1.75V3h3V1.75a.25.25 0 0 0-.25-.25h-2.5a.25.25 0 0 0-.25.25Z"/></svg>
          </button>
          <button
            v-if="msg.role === 'assistant' && !msg.streaming && workspacePath"
            class="ai-msg-action-btn"
            title="Save response to Notepad"
            @click="saveResponseToNotepad(msg)"
          >
            <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path d="M2 1.75C2 .784 2.784 0 3.75 0h6.586c.464 0 .909.184 1.237.513l2.914 2.914c.329.328.513.773.513 1.237v9.586A1.75 1.75 0 0 1 13.25 16h-9.5A1.75 1.75 0 0 1 2 14.25Zm1.75-.25a.25.25 0 0 0-.25.25v12.5c0 .138.112.25.25.25h9.5a.25.25 0 0 0 .25-.25V6h-2.75A1.75 1.75 0 0 1 8.75 4.25V1.5Zm6.75.56v2.19c0 .138.112.25.25.25h2.19Z"/></svg>
          </button>
          <!-- Read aloud — Web Speech API TTS (VS Code Copilot parity) -->
          <button
            v-if="msg.role === 'assistant' && !msg.streaming && speechSynthesisAvailable"
            class="ai-msg-action-btn"
            :title="speakingMsgIdx === mi ? 'Stop reading' : 'Read aloud'"
            :class="{ 'ai-msg-action-btn--active': speakingMsgIdx === mi }"
            @click="readAloud(mi, msg.content)"
          >
            <svg v-if="speakingMsgIdx !== mi" width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path d="M11.596 8.697l-6.363 3.692c-.54.313-1.233-.066-1.233-.697V4.308c0-.63.692-1.01 1.233-.696l6.363 3.692a.802.802 0 0 1 0 1.393z"/></svg>
            <svg v-else width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path d="M5.5 3.5A1.5 1.5 0 0 1 7 5v6a1.5 1.5 0 0 1-3 0V5a1.5 1.5 0 0 1 1.5-1.5zm5 0A1.5 1.5 0 0 1 12 5v6a1.5 1.5 0 0 1-3 0V5a1.5 1.5 0 0 1 1.5-1.5z"/></svg>
          </button>
          <button
            v-if="msg.role === 'assistant' && mi === lastAssistantIdx && !sending"
            class="ai-msg-action-btn"
            :title="$t('action.regenerate')"
            @click="regenerate"
          >
            <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path d="M1.705 8.005a.75.75 0 0 1 .834.656 5.5 5.5 0 0 0 9.592 2.97l-1.204-1.204a.25.25 0 0 1 .177-.427h3.646a.25.25 0 0 1 .25.25v3.646a.25.25 0 0 1-.427.177l-1.38-1.38A7.002 7.002 0 0 1 1.05 8.84a.75.75 0 0 1 .656-.834ZM8 2.5a5.487 5.487 0 0 0-4.131 1.869l1.204 1.204A.25.25 0 0 1 4.896 6H1.25A.25.25 0 0 1 1 5.75V2.104a.25.25 0 0 1 .427-.177l1.38 1.38A7.002 7.002 0 0 1 14.95 7.16a.75.75 0 0 1-1.49.178A5.5 5.5 0 0 0 8 2.5Z"/></svg>
          </button>
          <!-- Regenerate with a different model — dropdown -->
          <div
            v-if="msg.role === 'assistant' && mi === lastAssistantIdx && !sending"
            class="ai-regen-model-wrap"
          >
            <button
              class="ai-msg-action-btn ai-regen-model-btn"
              :title="$t('action.regenerate-with-model')"
              @click.stop="regenModelOpen = !regenModelOpen"
            >
              <svg width="11" height="11" viewBox="0 0 16 16" fill="currentColor" style="margin-right:2px"><path d="M1.705 8.005a.75.75 0 0 1 .834.656 5.5 5.5 0 0 0 9.592 2.97l-1.204-1.204a.25.25 0 0 1 .177-.427h3.646a.25.25 0 0 1 .25.25v3.646a.25.25 0 0 1-.427.177l-1.38-1.38A7.002 7.002 0 0 1 1.05 8.84a.75.75 0 0 1 .656-.834ZM8 2.5a5.487 5.487 0 0 0-4.131 1.869l1.204 1.204A.25.25 0 0 1 4.896 6H1.25A.25.25 0 0 1 1 5.75V2.104a.25.25 0 0 1 .427-.177l1.38 1.38A7.002 7.002 0 0 1 14.95 7.16a.75.75 0 0 1-1.49.178A5.5 5.5 0 0 0 8 2.5Z"/></svg>▾
            </button>
            <div v-if="regenModelOpen" class="ai-regen-model-menu">
              <div class="ai-model-picker-group" style="font-size:9px;padding:4px 8px 2px">Creativity</div>
              <div
                v-if="!reasoningModelSelected"
                class="ai-regen-model-item"
                title="Regenerate with +0.3 temperature for more diverse output"
                @mousedown.prevent="regenWithHigherTemp()"
              >🎲 More creative (temp +0.3)</div>
              <div class="ai-model-picker-group" style="font-size:9px;padding:4px 8px 2px;margin-top:2px">Model</div>
              <template v-for="grp in [
                { label: 'Anthropic',    filter: 'anthropic' },
                { label: 'OpenAI',       filter: 'openai'    },
                { label: 'Google',       filter: 'google'    },
                { label: 'Mistral',      filter: 'mistral'   },
                { label: 'xAI',         filter: 'xai'       },
                { label: 'Groq',         filter: 'groq'      },
                { label: 'DeepSeek',     filter: 'deepseek'  },
                { label: 'Ollama',       filter: 'ollama'    },
              ]" :key="grp.label">
                <div
                  v-if="MODEL_CATALOG.some(e => e.provider === grp.filter)"
                  class="ai-model-picker-group"
                  style="font-size:9px;padding:4px 8px 2px"
                >{{ grp.label }}</div>
                <div
                  v-for="m in MODEL_CATALOG.filter(e => e.provider === grp.filter)"
                  :key="m.id"
                  class="ai-regen-model-item"
                  :class="{ active: m.id === settingsModel }"
                  @mousedown.prevent="regenWithModel(m.id)"
                >
                  <span>{{ m.display }}</span>
                  <span class="ai-model-picker-note">{{ m.note }}{{ m.ctx ? ` · ${m.ctx >= 1_000_000 ? (m.ctx/1_000_000).toFixed(1)+'M' : m.ctx >= 1000 ? Math.round(m.ctx/1000)+'k' : m.ctx}` : '' }}</span>
                </div>
              </template>
            </div>
          </div>
          <button
            v-if="msg.role === 'assistant' && !msg.streaming"
            class="ai-msg-action-btn"
            title="Quote selected text (or full message) in input"
            @click="quoteMessage(msg.content)"
          >
            <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path d="M12 2a1 1 0 0 1 1 1v1h1a1 1 0 0 1 0 2h-1v6h1a1 1 0 0 1 0 2h-1v1a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-1H2a1 1 0 0 1 0-2h1V6H2a1 1 0 0 1 0-2h1V3a1 1 0 0 1 1-1h8Zm-1 2H5v8h6V4Zm-4 2a.5.5 0 0 1 .5.5v3a.5.5 0 0 1-1 0v-3A.5.5 0 0 1 7 6Zm2 0a.5.5 0 0 1 .5.5v3a.5.5 0 0 1-1 0v-3A.5.5 0 0 1 9 6Z"/></svg>
          </button>
          <template v-if="msg.role === 'assistant' && !msg.streaming">
            <button
              class="ai-msg-action-btn ai-feedback-btn"
              :class="{ 'ai-feedback-up': msg.feedback === 'up' }"
              :title="$t('action.good-response')"
              @click="toggleFeedback(mi, 'up')"
            >👍</button>
            <button
              class="ai-msg-action-btn ai-feedback-btn"
              :class="{ 'ai-feedback-down': msg.feedback === 'down' }"
              :title="$t('action.bad-response')"
              @click="toggleFeedback(mi, 'down')"
            >👎</button>
          </template>
          <button
            class="ai-msg-action-btn"
            :class="{ 'ai-bookmark-active': msg.bookmarked }"
            :title="msg.bookmarked ? 'Remove bookmark' : 'Bookmark'"
            @click="toggleBookmark(mi)"
          >{{ msg.bookmarked ? '★' : '☆' }}</button>
          <span v-if="msg.ttftMs" class="ai-msg-ttft" :title="`Time to first token: ${msg.ttftMs}ms`">{{ msg.ttftMs }}ms</span>
          <span v-if="msg.elapsedMs" class="ai-msg-elapsed">{{ (msg.elapsedMs / 1000).toFixed(1) }}s</span>
          <span
            v-if="msg.role === 'assistant' && msg.outputTokens && msg.elapsedMs && msg.elapsedMs > 0 && !msg.streaming"
            class="ai-msg-tokspeed"
            :title="`${Math.round(msg.outputTokens / (msg.elapsedMs / 1000))} tokens/sec`"
          >{{ Math.round(msg.outputTokens / (msg.elapsedMs / 1000)) }} t/s</span>
          <span v-if="msg.role === 'assistant' && msg.model && !msg.streaming" class="ai-msg-model-badge" :title="msg.model">{{ msg.model.replace(/^claude-/, '').replace(/-\d{8}$/, '') }}</span>
          <span v-if="msg.role === 'assistant' && (msg.inputTokens || msg.outputTokens) && !msg.streaming" class="ai-msg-tokens" :title="`Input: ${(msg.inputTokens ?? 0).toLocaleString()} tokens\nOutput: ${(msg.outputTokens ?? 0).toLocaleString()} tokens`">↑{{ (msg.inputTokens ?? 0).toLocaleString() }} ↓{{ (msg.outputTokens ?? 0).toLocaleString() }}</span>
          <!-- Token arc: visual proportion of context window used by this message -->
          <svg
            v-if="msg.role === 'assistant' && msg.outputTokens && currentModelCtx > 0 && !msg.streaming"
            class="ai-token-arc"
            width="14" height="14" viewBox="0 0 14 14"
            :title="`This response used ~${Math.round(msg.outputTokens / currentModelCtx * 100)}% of the ${(currentModelCtx/1000).toFixed(0)}k context window`"
          >
            <circle cx="7" cy="7" r="5" fill="none" stroke="var(--border-muted,#30363d)" stroke-width="2"/>
            <circle
              cx="7" cy="7" r="5" fill="none"
              :stroke="msg.outputTokens / currentModelCtx > 0.3 ? '#e05252' : msg.outputTokens / currentModelCtx > 0.1 ? '#d29922' : 'var(--accent)'"
              stroke-width="2"
              stroke-linecap="round"
              stroke-dasharray="31.4"
              :stroke-dashoffset="31.4 * (1 - Math.min(1, msg.outputTokens / currentModelCtx))"
              transform="rotate(-90 7 7)"
            />
          </svg>
          <span
            v-if="msg.role === 'assistant' && msg.model && msg.inputTokens != null && msg.outputTokens != null && !msg.streaming && estimateCost(msg.model, msg.inputTokens, msg.outputTokens)"
            class="ai-msg-cost"
            :title="`Estimated API cost for this response (${msg.model})`"
          >{{ estimateCost(msg.model, msg.inputTokens ?? 0, msg.outputTokens ?? 0) }}</span>
          <span
            v-if="msg.timestamp"
            class="ai-msg-time"
            :title="new Date(msg.timestamp).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })"
          >
            {{ relativeTime(msg.timestamp) }}
          </span>
        </div>
        <span v-if="msg.bookmarked" class="ai-bookmark-indicator" title="Bookmarked">★</span>
      </div>
      <!-- Feedback comment input (VS Code Copilot parity: optional text after 👎) -->
      <div v-if="feedbackInputMi === mi" class="ai-feedback-comment-wrap">
        <input
          v-model="feedbackDraft"
          class="ai-feedback-comment-input"
          placeholder="What was wrong? (optional, Enter to save)"
          @keydown.enter.prevent="submitFeedbackComment(mi)"
          @keydown.escape="feedbackInputMi = null; feedbackDraft = ''"
        />
        <button class="ai-feedback-comment-send" @click="submitFeedbackComment(mi)">Save</button>
        <button class="ai-feedback-comment-skip" @click="feedbackInputMi = null; feedbackDraft = ''">Skip</button>
      </div>
      <div v-else-if="msg.feedbackComment && msg.feedback === 'down'" class="ai-feedback-saved-note" :title="msg.feedbackComment">
        <span class="ai-feedback-saved-icon">👎</span> {{ msg.feedbackComment }}
      </div>
      <!-- Edit mode: Apply All files button (when AI proposes ≥2 file changes) -->
      <div v-if="msg.role === 'assistant' && msg.pendingEdits?.length && !msg.streaming" class="ai-apply-all-bar">
        <span class="ai-apply-all-label">{{ msg.pendingEdits.length }} files proposed</span>
        <button class="ai-apply-all-btn" @click="applyAllEdits(msg)">Apply All {{ msg.pendingEdits.length }} files</button>
        <button class="ai-apply-all-dismiss" @click="msg.pendingEdits = undefined" title="Dismiss">✕</button>
      </div>
      <!-- Truncated response indicator (VS Code Copilot Chat parity) -->
      <div
        v-if="msg.role === 'assistant' && msg.truncated && !msg.streaming && mi === lastAssistantIdx"
        class="ai-truncated-bar"
      >
        <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path d="M8 0a8 8 0 1 1 0 16A8 8 0 0 1 8 0ZM1.5 8a6.5 6.5 0 1 0 13 0 6.5 6.5 0 0 0-13 0Zm7-3.25v2.992l2.028.812a.75.75 0 0 1-.557 1.392l-2.5-1A.751.751 0 0 1 7 8.25v-3.5a.75.75 0 0 1 1.5 0Z"/></svg>
        <span class="ai-truncated-label">Response may be incomplete</span>
        <button
          class="ai-truncated-continue-btn"
          @click="inputText = 'Please continue your response from where you left off.'; nextTick(() => void sendMessage())"
        >Continue generating</button>
      </div>
      <!-- Per-message follow-up suggestions (only on last assistant message when not streaming) -->
      <div
        v-if="msg.role === 'assistant' && msg.followUps?.length && !msg.streaming && mi === lastAssistantIdx"
        class="ai-followups ai-followups-inline"
      >
        <button
          v-for="(q, qi) in msg.followUps"
          :key="qi"
          class="ai-followup-btn"
          @click="inputText = q; nextTick(() => void sendMessage())"
        >{{ q }}</button>
      </div>
      </template>
    </div>

    <!-- Expand / Collapse all code blocks -->
    <div
      v-if="messages.some(m => m.role === 'assistant' && m.content.includes('```'))"
      class="ai-code-fold-controls"
    >
      <button class="ai-code-fold-ctrl-btn" title="Expand all code blocks" @click="expandAllCodeBlocks()">⊞</button>
      <button class="ai-code-fold-ctrl-btn" title="Collapse all code blocks" @click="collapseAllCodeBlocks()">⊟</button>
    </div>
    <!-- Scroll-to-bottom button (shown when user has scrolled up during streaming) -->
    <button
      v-if="!autoScroll"
      class="ai-scroll-to-bottom"
      :class="{ 'ai-scroll-to-bottom--live': sending }"
      title="Scroll to bottom (↓)"
      @click="autoScroll = true; scrollBottom(true)"
    >
      ↓<span v-if="sending"> live</span>
    </button>

    <!-- Active tool status banner -->
    <div v-if="activeToolCard" class="ai-active-tool-banner">
      <span class="ai-active-tool-icon">{{ getToolIcon(activeToolCard.tool_name) }}</span>
      <span class="ai-active-tool-text">{{ getToolSummary(activeToolCard.tool_name, activeToolCard.tool_input) }}</span>
      <span class="ai-active-tool-spinner" />
    </div>

    <!-- Search bar -->
    <div v-if="showSearch" class="ai-search-bar">
      <input
        ref="searchInput"
        v-model="searchQuery"
        class="ai-search-input"
        placeholder="Search chat…"
        @keydown.escape="closeSearch"
        @keydown.enter.prevent="searchNav(1)"
      />
      <span class="ai-search-count">
        {{ searchMatches.length ? `${searchMatchIdx + 1}/${searchMatches.length}` : 'No results' }}
      </span>
      <button class="ai-search-nav" title="Previous" @click="searchNav(-1)">↑</button>
      <button class="ai-search-nav" title="Next" @click="searchNav(1)">↓</button>
      <button class="ai-search-close" @click="closeSearch">✕</button>
    </div>

    <!-- Input area -->
    <div
      class="ai-input-area"
      :class="{ 'ai-drop-active': isDraggingOver }"
      @dragover="onDragover"
      @dragleave="onDragleave"
      @drop="onDrop"
    >
      <!-- Context chips -->
      <div v-if="contextChips.length" class="ai-chips">
        <span class="ai-chips-meta">
          <span class="ai-chips-total" :title="`Total context from chips: ~${chipsTokenTotal.toLocaleString()} tokens`">~{{ chipsTokenTotal > 999 ? (chipsTokenTotal / 1000).toFixed(1) + 'k' : chipsTokenTotal }}t</span>
          <span
            v-if="chipsTokenTotal > 30000"
            class="ai-chips-warn"
            :class="{ 'ai-chips-warn-critical': chipsTokenTotal > 60000 }"
            :title="`Context chips are ~${(chipsTokenTotal/1000).toFixed(0)}k tokens — consider /compact to reduce context size`"
          >⚠ large context</span>
          <button
            v-if="contextChips.filter(c => !c.pinned).length > 1"
            class="ai-chips-clear"
            title="Remove all non-pinned context chips"
            @click.stop="clearNonPinnedChips"
          >Clear</button>
        </span>
        <span
          v-for="chip in contextChips"
          :key="chip.id"
          class="ai-chip"
          :class="{ 'ai-chip-active': previewChipId === chip.id, 'ai-chip-image': !!chip.imageData, 'ai-chip-pinned': chip.pinned }"
          draggable="true"
          @click.stop="previewChipId = previewChipId === chip.id ? null : chip.id"
          @dragstart="onChipDragStart($event, chip.id)"
          @dragend="onChipDragEnd($event)"
          @dragover="onChipDragOver($event, chip.id)"
          @drop="onChipDrop($event, chip.id)"
        >
          <img v-if="chip.imageData" :src="chip.imageData" class="ai-chip-thumb" alt="pasted image" />
          <span v-if="!chip.imageData && chipIcon(chip.label)" class="ai-chip-icon">{{ chipIcon(chip.label) }}</span>{{ chip.label }}
          <span v-if="!chip.imageData" class="ai-chip-tokens">~{{ Math.ceil(chip.content.length / 4) > 999 ? (Math.ceil(chip.content.length / 4000)).toFixed(0) + 'k' : Math.ceil(chip.content.length / 4) }}t</span>
          <button class="ai-chip-pin" :title="chip.pinned ? 'Unpin context' : 'Pin — keep in future messages'" @click.stop="chip.pinned = !chip.pinned">{{ chip.pinned ? '📌' : '·' }}</button>
          <button v-if="chip.sourceId && !chip.imageData" class="ai-chip-refresh" :class="{ 'ai-chip-refreshing': refreshingChipId === chip.id }" title="Re-fetch context" @click.stop="refreshChip(chip.id)">↻</button>
          <button class="ai-chip-remove" @click.stop="removeChip(chip.id)">×</button>
        </span>
        <!-- Chip preview popover -->
        <div v-if="previewChip" class="ai-chip-popover" @click.stop>
          <div class="ai-chip-popover-header">
            <span class="ai-chip-popover-label">{{ previewChip.label }}</span>
            <span v-if="!previewChip.imageData" class="ai-chip-popover-tokens">~{{ Math.ceil(previewChip.content.length / 4).toLocaleString() }} tokens</span>
            <button class="ai-chip-popover-close" @click="previewChipId = null">×</button>
          </div>
          <img v-if="previewChip.imageData" :src="previewChip.imageData" class="ai-chip-popover-img" alt="pasted image" />
          <div v-else-if="previewChip.label.startsWith('@web:') || previewChip.label.startsWith('@url:')"
            class="ai-chip-popover-content"
            v-html="renderWebChipContent(previewChip.content)"
            @click.prevent="onChipUrlClick"
          ></div>
          <pre v-else class="ai-chip-popover-content">{{ previewChip.content.slice(0, 1200) }}{{ previewChip.content.length > 1200 ? '\n…' : '' }}</pre>
        </div>
      </div>

      <!-- Slash command menu -->
      <!-- Edit mode: working set — files targeted for batch edits -->
      <div v-if="chatMode === 'edit'" class="ai-working-set">
        <span class="ai-working-set-label">Editing:</span>
        <span
          v-for="(f, fi) in editWorkingSet"
          :key="fi"
          class="ai-working-set-file"
        >{{ f.split('/').pop() }}<button class="ai-working-set-remove" @click.stop="removeFromWorkingSet(fi)">×</button></span>
        <button
          v-if="props.getActiveRelPath?.()"
          class="ai-working-set-add"
          :title="`Add ${props.getActiveRelPath?.()} to working set`"
          @click="addToWorkingSet(props.getActiveRelPath?.() ?? '')"
        >+ current file</button>
        <button
          v-if="editWorkingSet.length > 1"
          class="ai-working-set-clear"
          :title="$t('action.clear-working-set')"
          @click="editWorkingSet = []"
        >Clear</button>
        <span v-if="!editWorkingSet.length" class="ai-working-set-empty">No files — add the current file or use @file</span>
      </div>

      <div v-if="showSlashMenu" ref="slashMenuEl" class="ai-at-menu ai-slash-menu">
        <div
          v-for="(cmd, i) in slashOptions"
          :key="cmd.id"
          class="ai-at-item ai-slash-item"
          :class="{ active: i === slashMenuIdx }"
          @mousedown.prevent="selectSlashCommand(cmd)"
          @mouseover="slashMenuIdx = i"
        >
          <span class="ai-slash-name">{{ cmd.label }}</span>
          <span class="ai-slash-desc">{{ cmd.description }}</span>
          <span v-if="!slashMenuFilter && recentCmds.includes(cmd.id)" class="ai-slash-recent">recent</span>
        </div>
      </div>

      <!-- @ menu -->
      <div v-if="showAtMenu" ref="atMenuEl" class="ai-at-menu">
        <template v-for="opt in atOptionsDisplay" :key="opt.id">
          <!-- Group header separator -->
          <div v-if="opt._isGroupHeader" class="ai-at-group-header">{{ opt.label }}</div>
          <!-- Option item -->
          <div
            v-else
            class="ai-at-item"
            :class="{ active: opt._realIdx === atMenuIdx }"
            @mousedown.prevent="selectAtOption(opt)"
            @mouseover="atMenuIdx = opt._realIdx ?? 0"
          >
            <span class="ai-at-icon">{{ chipIcon(opt.id) || '◻' }}</span>
            <span class="ai-at-label-text">{{ opt.label }}</span>
            <span v-if="opt._isRecent" class="ai-at-recent-badge" title="Recently used">↵</span>
          </div>
        </template>
      </div>

      <!-- Model quick-picker badge -->
      <div class="ai-model-bar">
        <!-- Chat mode toggle: Ask → Edit → Agent cycle -->
        <button
          class="ai-mode-toggle"
          :class="chatMode"
          :title="chatMode === 'ask' ? 'Ask — AI suggests, you approve all edits\nClick to switch to Edit mode' : chatMode === 'edit' ? 'Edit — target specific files, AI proposes diffs\nClick to switch to Agent mode' : 'Agent — AI auto-applies edits & runs commands\nClick to switch to Ask mode'"
          @click="chatMode = chatMode === 'ask' ? 'edit' : chatMode === 'edit' ? 'agent' : 'ask'"
        >{{ chatMode === 'ask' ? 'Ask' : chatMode === 'edit' ? 'Edit' : 'Agent' }}</button>
        <span
          v-if="workspaceRulesFile"
          class="ai-rules-badge"
          :title="`Workspace rules active from ${workspaceRulesFile}`"
          @click="showSettings = true"
        >✦ rules</span>
        <span
          v-if="allThreads.find(t => t.id === currentThreadId)?.systemPrompt"
          class="ai-rules-badge"
          style="background: color-mix(in srgb, var(--accent-fg) 15%, transparent); color: var(--accent-fg);"
          :title="`Thread instructions:\n${allThreads.find(t => t.id === currentThreadId)?.systemPrompt}`"
          @click="selectSlashCommand(SLASH_COMMANDS.find(c => c.id === '/instructions')!)"
        >⚙ instr</span>
        <span
          v-if="allThreads.find(t => t.id === currentThreadId)?.label"
          class="ai-rules-badge"
          style="background: var(--bg-muted); cursor: default;"
        >{{ allThreads.find(t => t.id === currentThreadId)?.label }}</span>
        <span
          v-if="activePersonaLabel"
          class="ai-rules-badge ai-persona-badge"
          :title="`Active persona: ${activePersonaLabel}\nClick to change in Settings`"
          @click="showSettings = true"
        >{{ activePersonaLabel }}</span>
        <button class="ai-model-badge-btn" :title="`Model: ${settingsModel}\nCmd+/ to cycle · click to pick`" @click="showModelPicker = !showModelPicker">
          <span v-if="settingsModel === 'auto'" class="ai-model-badge-provider auto">✦</span>
          <span v-else class="ai-model-badge-provider" :class="settingsProvider">{{ {'anthropic':'A','openai':'GPT','groq':'G','deepseek':'DS','google':'GG','mistral':'M','xai':'X','openai_compatible':'C','ollama':'O'}[settingsProvider] ?? 'O' }}</span>
          <span class="ai-model-badge-name">{{ MODEL_CATALOG.find(m => m.id === settingsModel)?.display ?? settingsModel }}</span>
          <span class="ai-model-badge-caret">{{ showModelPicker ? '▲' : '▼' }}</span>
        </button>
        <div v-if="showModelPicker" class="ai-model-picker-menu">
          <!-- Search filter -->
          <div class="ai-model-picker-search-wrap">
            <input
              v-model="modelPickerSearch"
              class="ai-model-picker-search"
              placeholder="Search models…"
              autocomplete="off"
              @click.stop
              @keydown.escape.prevent="showModelPicker = false"
            />
          </div>
          <!-- Auto tier (hidden when search active) -->
          <template v-if="!modelPickerSearch.trim()">
            <div class="ai-model-picker-group">Smart Routing</div>
            <div
              class="ai-model-picker-item"
              :class="{ active: settingsModel === 'auto' }"
              @click="switchModel('auto'); showModelPicker = false"
            >
              <span class="ai-model-picker-name">✦ Auto</span>
              <span class="ai-model-picker-note">Best available</span>
            </div>
          </template>
          <template v-for="group in [
            { label: 'Anthropic', filter: 'anthropic' },
            { label: 'OpenAI', filter: 'openai' },
            { label: 'Google Gemini', filter: 'google' },
            { label: 'Mistral AI', filter: 'mistral' },
            { label: 'xAI Grok', filter: 'xai' },
            { label: 'Groq', filter: 'groq' },
            { label: 'DeepSeek', filter: 'deepseek' },
            { label: 'Ollama (Local)', filter: 'ollama' },
          ]" :key="group.label">
            <template v-if="MODEL_CATALOG.filter(e => e.provider === group.filter && (!modelPickerSearch.trim() || e.display.toLowerCase().includes(modelPickerSearch.toLowerCase()) || e.note.toLowerCase().includes(modelPickerSearch.toLowerCase()) || e.id.includes(modelPickerSearch.toLowerCase()))).length > 0">
              <div class="ai-model-picker-sep" />
              <div class="ai-model-picker-group">
                {{ group.label }}
                <span v-if="!providerHasKey[group.filter]" class="ai-picker-no-key" title="No API key configured — set in Settings">no key</span>
              </div>
              <div
                v-for="m in MODEL_CATALOG.filter(e => e.provider === group.filter && (!modelPickerSearch.trim() || e.display.toLowerCase().includes(modelPickerSearch.toLowerCase()) || e.note.toLowerCase().includes(modelPickerSearch.toLowerCase()) || e.id.includes(modelPickerSearch.toLowerCase())))"
                :key="m.id"
                class="ai-model-picker-item"
                :class="{ active: m.id === settingsModel }"
                @click="switchModel(m.id); showModelPicker = false"
              >
                <span class="ai-model-picker-name">{{ m.display }}</span>
                <span class="ai-model-picker-meta">
                  <span v-if="m.caps?.includes('vision')" class="ai-model-cap-badge vision" title="Vision — supports image inputs">👁</span>
                  <span v-if="m.caps?.includes('thinking')" class="ai-model-cap-badge thinking" title="Reasoning — extended thinking/chain-of-thought">◎</span>
                  <span v-if="m.caps?.includes('code')" class="ai-model-cap-badge code" title="Code-specialized model">&lt;/&gt;</span>
                  <span v-if="m.ctx" class="ai-model-picker-ctx">{{ m.ctx >= 1000 ? (m.ctx/1000)+'k' : m.ctx }}</span>
                  <span class="ai-model-picker-note">{{ m.note }}</span>
                </span>
              </div>
            </template>
          </template>
          <!-- Custom model input -->
          <div class="ai-model-picker-sep" />
          <div class="ai-model-picker-custom">
            <input
              class="ai-model-picker-custom-input"
              placeholder="Custom model ID…"
              @keydown.enter.prevent="(e) => { const v = (e.target as HTMLInputElement).value.trim(); if (v) { settingsModel = v; saveSettings(); showModelPicker = false } }"
            />
          </div>
        </div>
      </div>

      <!-- Context window usage bar (shown when > 30%) -->
      <div v-if="ctxUsagePct > 30" class="ai-ctx-bar" :class="ctxUsageLevel" :title="`~${conversationTokenEstimate.toLocaleString()} / ${currentModelCtx.toLocaleString()} tokens (${settingsModel})`">
        <div class="ai-ctx-bar-track">
          <div class="ai-ctx-bar-fill" :style="{ width: ctxUsagePct + '%' }" />
        </div>
        <span class="ai-ctx-label">context {{ ctxUsagePct }}%</span>
        <button v-if="ctxUsagePct >= 70 && !sending" class="ai-ctx-new-btn" title="Compress old messages to free context" @click="triggerCompact">Compact</button>
        <button v-if="ctxUsagePct >= 80" class="ai-ctx-new-btn" title="Start new chat to free context" @click="newThread">+ New chat</button>
      </div>

      <div class="ai-input-row">
        <div class="ai-textarea-wrap">
          <textarea
            ref="textareaEl"
            v-model="inputText"
            class="ai-textarea"
            :placeholder="inputPlaceholder"
            :disabled="sending"
            rows="1"
            @input="onTextareaInput"
            @keydown="onTextareaKeydown"
            @paste="onTextareaPaste"
          />
          <span v-if="inputCharCount > 200" class="ai-char-count" :class="{ warn: inputCharCount > 2000 }">
            {{ inputCharCount.toLocaleString() }} chars · ~{{ inputTokenEstimate.toLocaleString() }} tokens
          </span>
        </div>
        <div class="ai-input-btns">
          <!-- Add editor selection as context chip -->
          <button
            v-if="!sending && props.getEditorSelection"
            class="ai-settings-btn"
            :title="$t('action.add-editor-selection')"
            @click="addSelectionContextChip"
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
              <path d="M1.75 1h3.5a.75.75 0 0 1 0 1.5h-3.5a.25.25 0 0 0-.25.25v3.5a.75.75 0 0 1-1.5 0v-3.5C0 1.784.784 1 1.75 1ZM14.25 1h-3.5a.75.75 0 0 0 0 1.5h3.5a.25.25 0 0 1 .25.25v3.5a.75.75 0 0 0 1.5 0v-3.5A1.75 1.75 0 0 0 14.25 1ZM1.5 10.75a.75.75 0 0 0-1.5 0v3.5C0 15.216.784 16 1.75 16h3.5a.75.75 0 0 0 0-1.5h-3.5a.25.25 0 0 1-.25-.25v-3.5Zm13 0a.75.75 0 0 1 1.5 0v3.5A1.75 1.75 0 0 1 14.25 16h-3.5a.75.75 0 0 1 0-1.5h3.5a.25.25 0 0 0 .25-.25v-3.5Z"/>
            </svg>
          </button>
          <!-- Attach file button -->
          <button
            v-if="!sending && workspacePath"
            class="ai-settings-btn"
            :title="$t('action.attach-file')"
            @click="attachFile"
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
              <path d="M13.78 7.22a.75.75 0 0 1 0 1.06l-4.25 4.25a4.75 4.75 0 0 1-6.716-6.716l5.25-5.25a3.25 3.25 0 0 1 4.6 4.6L7.44 9.5a1.75 1.75 0 0 1-2.474-2.474L9.22 2.78a.75.75 0 0 1 1.06 1.06L6.03 8.086a.25.25 0 0 0 .354.354l5.19-5.19a1.75 1.75 0 0 0-2.475-2.475l-5.25 5.25a3.25 3.25 0 0 0 4.6 4.6l4.25-4.25a.75.75 0 0 1 1.06 0z"/>
            </svg>
          </button>
          <!-- Image attach button — picks an image file from disk (VS Code Copilot parity) -->
          <button
            v-if="!sending"
            class="ai-settings-btn"
            :title="$t('action.attach-image')"
            @click="imageFileInputEl?.click()"
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
              <path d="M16 13.25A1.75 1.75 0 0 1 14.25 15H1.75A1.75 1.75 0 0 1 0 13.25V2.75C0 1.784.784 1 1.75 1h12.5c.966 0 1.75.784 1.75 1.75ZM1.75 2.5a.25.25 0 0 0-.25.25v7.655l2.9-2.9a.75.75 0 0 1 1.06 0L7.5 9.464l3.22-3.22a.75.75 0 0 1 1.06 0l2.72 2.72V2.75a.25.25 0 0 0-.25-.25ZM1.5 13.25c0 .138.112.25.25.25h12.5a.25.25 0 0 0 .25-.25v-2.19l-3.25-3.25-3.22 3.22a.75.75 0 0 1-1.06 0L4.97 9.03l-3.47 3.47v.75Zm5.75-7.5a1.25 1.25 0 1 1-2.5 0 1.25 1.25 0 0 1 2.5 0Z"/>
            </svg>
          </button>
          <input
            ref="imageFileInputEl"
            type="file"
            accept="image/png,image/jpeg,image/gif,image/webp,image/bmp"
            style="display:none"
            @change="handleImageFileSelect"
          />
          <!-- Voice input button (Web Speech API) -->
          <button
            v-if="voiceSupported && !sending"
            class="ai-voice-btn"
            :class="{ 'ai-voice-active': voiceListening }"
            :title="voiceListening ? $t('action.voice-stop-listening') : $t('action.voice-input')"
            @click="toggleVoiceInput"
          >
            <svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor">
              <path d="M8 10a3 3 0 0 0 3-3V4a3 3 0 0 0-6 0v3a3 3 0 0 0 3 3Zm5-3a.75.75 0 0 0-1.5 0A3.5 3.5 0 0 1 8 10.5a3.5 3.5 0 0 1-3.5-3.5.75.75 0 0 0-1.5 0A5 5 0 0 0 7.25 11.9V14H6a.75.75 0 0 0 0 1.5h4A.75.75 0 0 0 10 14H8.75v-2.1A5 5 0 0 0 13 7Z"/>
            </svg>
          </button>
          <button
            v-if="!sending && inputText.trim().length > 10"
            class="ai-enhance-btn"
            :disabled="enhancingPrompt"
            :title="enhancingPrompt ? $t('action.enhance-prompt-busy') : $t('action.enhance-prompt')"
            @click="enhancePrompt"
          >{{ enhancingPrompt ? '…' : '✦' }}</button>
          <button
            v-if="!sending"
            class="ai-send-btn"
            :disabled="!inputText.trim() && contextChips.length === 0"
            :title="settingsSendMode === 'ctrl-enter' ? $t('action.send-ctrl-enter') : $t('action.send-enter')"
            @click="sendMessage"
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
              <path d="M.989 8 .064 2.68a1.342 1.342 0 0 1 1.85-1.462l13 5.5a1.343 1.343 0 0 1 0 2.564l-13 5.5a1.342 1.342 0 0 1-1.85-1.463L.989 8Zm.603-5.353L2.38 7.25h4.87a.75.75 0 0 1 0 1.5H2.38l-.788 4.603L13.5 8 1.592 2.647Z"/>
            </svg>
          </button>
          <button
            v-else
            class="ai-stop-btn"
            :title="$t('action.stop-streaming')"
            @click="stopStreaming"
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
              <path d="M4 3a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V4a1 1 0 0 0-1-1H4Z"/>
            </svg>
          </button>
          <button
            class="ai-settings-btn"
            :title="$t('action.new-chat')"
            @click="newThread"
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M7.75 2a.75.75 0 0 1 .75.75V7h4.25a.75.75 0 0 1 0 1.5H8.5v4.25a.75.75 0 0 1-1.5 0V8.5H2.75a.75.75 0 0 1 0-1.5H7V2.75A.75.75 0 0 1 7.75 2Z"/></svg>
          </button>
          <button
            class="ai-settings-btn"
            :title="$t('action.chat-history')"
            :class="{ active: showThreads }"
            @click="showThreads = !showThreads; if (!showThreads) threadSearchQuery = ''"
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M1 2.75A.75.75 0 0 1 1.75 2h12.5a.75.75 0 0 1 0 1.5H1.75A.75.75 0 0 1 1 2.75Zm0 5A.75.75 0 0 1 1.75 7h12.5a.75.75 0 0 1 0 1.5H1.75A.75.75 0 0 1 1 7.75ZM1.75 12h12.5a.75.75 0 0 1 0 1.5H1.75a.75.75 0 0 1 0-1.5Z"/></svg>
          </button>
          <button
            class="ai-settings-btn"
            :title="$t('action.search-chat')"
            :disabled="messages.length === 0"
            @click="openSearch"
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
              <path d="M10.68 11.74a6 6 0 0 1-7.922-8.982 6 6 0 0 1 8.982 7.922l3.04 3.04a.749.749 0 0 1-.326 1.275.749.749 0 0 1-.734-.215ZM11.5 7a4.499 4.499 0 1 0-8.997 0A4.499 4.499 0 0 0 11.5 7Z"/>
            </svg>
          </button>
          <button
            class="ai-settings-btn"
            :title="$t('action.copy-conversation')"
            :disabled="messages.length === 0"
            @click="copyAllMessages"
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M0 6.75C0 5.784.784 5 1.75 5h1.5a.75.75 0 0 1 0 1.5h-1.5a.25.25 0 0 0-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 0 0 .25-.25v-1.5a.75.75 0 0 1 1.5 0v1.5A1.75 1.75 0 0 1 9.25 16h-7.5A1.75 1.75 0 0 1 0 14.25Z"/><path d="M5 1.75C5 .784 5.784 0 6.75 0h7.5C15.216 0 16 .784 16 1.75v7.5A1.75 1.75 0 0 1 14.25 11h-7.5A1.75 1.75 0 0 1 5 9.25Zm1.75-.25a.25.25 0 0 0-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 0 0 .25-.25v-7.5a.25.25 0 0 0-.25-.25Z"/></svg>
          </button>
          <button
            class="ai-settings-btn"
            :title="$t('action.clear-chat')"
            :disabled="messages.length === 0"
            @click="clearConversation"
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
              <path d="M11 1.75V3h2.25a.75.75 0 0 1 0 1.5H2.75a.75.75 0 0 1 0-1.5H5V1.75C5 .784 5.784 0 6.75 0h2.5C10.216 0 11 .784 11 1.75ZM4.496 6.675l.66 6.6a.25.25 0 0 0 .249.225h5.19a.25.25 0 0 0 .249-.225l.66-6.6a.75.75 0 0 1 1.492.149l-.66 6.6A1.748 1.748 0 0 1 10.595 15h-5.19a1.75 1.75 0 0 1-1.741-1.575l-.66-6.6a.75.75 0 1 1 1.492-.15ZM6.5 1.75V3h3V1.75a.25.25 0 0 0-.25-.25h-2.5a.25.25 0 0 0-.25.25Z"/>
            </svg>
          </button>
          <button
            v-if="!sending && workspacePath"
            class="ai-settings-btn"
            :title="$t('action.fix-typescript-errors')"
            @click="fixProblems"
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M4.72.22a.749.749 0 0 1 1.06 0l1.25 1.25a.749.749 0 0 1 0 1.06L5.78 3.78a.749.749 0 0 1-1.06 0L3.47 2.53a.749.749 0 0 1 0-1.06ZM5 5.5a.5.5 0 0 1 .5-.5H8a.5.5 0 0 1 0 1H5.5A.5.5 0 0 1 5 5.5Zm-1.5 5a.5.5 0 0 1 .5-.5h7a.5.5 0 0 1 0 1H4a.5.5 0 0 1-.5-.5Zm1-2.5a.5.5 0 0 1 .5-.5h5a.5.5 0 0 1 0 1H5a.5.5 0 0 1-.5-.5Zm8.25-6.5c.966 0 1.75.784 1.75 1.75v7.5A1.75 1.75 0 0 1 12.75 12H9.06l.72 1.5h1.47a.75.75 0 0 1 0 1.5H4.75a.75.75 0 0 1 0-1.5h1.47L6.94 12H3.25A1.75 1.75 0 0 1 1.5 10.25v-7.5C1.5 1.784 2.284 1 3.25 1ZM3.25 2.5a.25.25 0 0 0-.25.25v7.5c0 .138.112.25.25.25h9.5a.25.25 0 0 0 .25-.25v-7.5a.25.25 0 0 0-.25-.25Z"/></svg>
          </button>
          <button
            v-if="messages.length > 0"
            class="ai-settings-btn"
            :class="{ active: showCheckpoints, 'ai-cp-has': checkpoints.length > 0 }"
            :title="$t('action.checkpoints', { count: checkpoints.length })"
            @click="showCheckpoints = !showCheckpoints"
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M8 0a8 8 0 1 1 0 16A8 8 0 0 1 8 0ZM1.5 8a6.5 6.5 0 1 0 13 0 6.5 6.5 0 0 0-13 0Zm7.25-3.25v4.5a.75.75 0 0 1-1.5 0v-4.5a.75.75 0 0 1 1.5 0ZM8 12a1 1 0 1 1 0-2 1 1 0 0 1 0 2Z"/></svg>
          </button>
          <button
            v-if="messages.length > 0 && !sending"
            class="ai-settings-btn"
            :title="$t('action.undo-last-send')"
            @click="undoLastSend"
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M1.22 6.28a.749.749 0 0 0 0 1.06l5.5 5.5a.749.749 0 1 0 1.06-1.06L3.561 7.75H12.5a3.25 3.25 0 0 1 0 6.5h-1.5a.75.75 0 0 0 0 1.5h1.5a4.75 4.75 0 0 0 0-9.5H3.56l4.22-4.22a.749.749 0 1 0-1.06-1.06Z"/></svg>
          </button>
          <button
            class="ai-response-length-btn"
            :title="$t('action.response-length', { label: RESPONSE_LENGTH_LABELS[responseLength] })"
            @click="cycleResponseLength"
          >{{ RESPONSE_LENGTH_LABELS[responseLength] }}</button>
          <button
            class="ai-settings-btn"
            :class="{ active: showNotes, 'ai-notes-has-content': !!notesContent.trim() }"
            :title="notesContent.trim() ? $t('action.workspace-notes-active') : $t('action.workspace-notes')"
            @click="showNotes = !showNotes"
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M0 3.75C0 2.784.784 2 1.75 2h12.5c.966 0 1.75.784 1.75 1.75v8.5A1.75 1.75 0 0 1 14.25 14H1.75A1.75 1.75 0 0 1 0 12.25Zm1.75-.25a.25.25 0 0 0-.25.25v8.5c0 .138.112.25.25.25h12.5a.25.25 0 0 0 .25-.25v-8.5a.25.25 0 0 0-.25-.25ZM3.5 6.25a.75.75 0 0 1 .75-.75h7a.75.75 0 0 1 0 1.5h-7a.75.75 0 0 1-.75-.75Zm.75 2.25h7a.75.75 0 0 1 0 1.5h-7a.75.75 0 0 1 0-1.5Z"/></svg>
          </button>
          <button
            class="ai-settings-btn"
            :class="{ active: showPromptTemplates }"
            :title="$t('action.prompt-templates')"
            @click="showPromptTemplates = !showPromptTemplates"
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M8 0a8 8 0 1 1 0 16A8 8 0 0 1 8 0ZM1.5 8a6.5 6.5 0 1 0 13 0 6.5 6.5 0 0 0-13 0Zm7-3.25v1.752l1.441 1.44a.75.75 0 0 1-1.06 1.06l-1.5-1.5A.75.75 0 0 1 7 7V4.75a.75.75 0 0 1 1.5 0Z"/></svg>
          </button>
          <button
            v-if="messages.length > 0"
            class="ai-settings-btn"
            :title="$t('action.copy-thread-markdown')"
            @click="copyThreadAsMarkdown"
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M0 6.75C0 5.784.784 5 1.75 5h1.5a.75.75 0 0 1 0 1.5h-1.5a.25.25 0 0 0-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 0 0 .25-.25v-1.5a.75.75 0 0 1 1.5 0v1.5A1.75 1.75 0 0 1 9.25 16h-7.5A1.75 1.75 0 0 1 0 14.25Z"/><path d="M5 1.75C5 .784 5.784 0 6.75 0h7.5C15.216 0 16 .784 16 1.75v7.5A1.75 1.75 0 0 1 14.25 11h-7.5A1.75 1.75 0 0 1 5 9.25Zm1.75-.25a.25.25 0 0 0-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 0 0 .25-.25v-7.5a.25.25 0 0 0-.25-.25Z"/></svg>
          </button>
          <button
            class="ai-settings-btn"
            :class="{ active: showBookmarks }"
            :title="bookmarkedMessages.length ? $t('action.bookmarks-count', { count: bookmarkedMessages.length }) : $t('action.bookmarks')"
            @click="showBookmarks = !showBookmarks"
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M3 2.75C3 1.784 3.784 1 4.75 1h6.5c.966 0 1.75.784 1.75 1.75v11.5a.75.75 0 0 1-1.227.579L8 11.722l-3.773 3.107A.75.75 0 0 1 3 14.25Zm1.75-.25a.25.25 0 0 0-.25.25v9.91l3.023-2.489a.75.75 0 0 1 .954 0L11.5 12.66V2.75a.25.25 0 0 0-.25-.25Z"/></svg>
          </button>
          <button
            class="ai-settings-btn"
            :title="$t('action.keyboard-shortcuts')"
            @click="showShortcuts = !showShortcuts"
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M0 3.75C0 2.784.784 2 1.75 2h12.5c.966 0 1.75.784 1.75 1.75v8.5A1.75 1.75 0 0 1 14.25 14H1.75A1.75 1.75 0 0 1 0 12.25Zm1.75-.25a.25.25 0 0 0-.25.25v8.5c0 .138.112.25.25.25h12.5a.25.25 0 0 0 .25-.25v-8.5a.25.25 0 0 0-.25-.25ZM5 8.5H2.75a.75.75 0 0 1 0-1.5H5a.75.75 0 0 1 0 1.5Zm2.5 2h-4.75a.75.75 0 0 1 0-1.5H7.5a.75.75 0 0 1 0 1.5Zm0-4h-4.75a.75.75 0 0 1 0-1.5H7.5a.75.75 0 0 1 0 1.5Zm5.75 4h-3a.75.75 0 0 1 0-1.5h3a.75.75 0 0 1 0 1.5Zm0-4h-3a.75.75 0 0 1 0-1.5h3a.75.75 0 0 1 0 1.5Z"/></svg>
          </button>
          <button
            class="ai-settings-btn"
            :title="$t('action.settings')"
            @click="showSettings = !showSettings"
          >
            <svg width="15" height="15" viewBox="0 0 16 16" fill="currentColor">
              <path d="M8 0a8.2 8.2 0 0 1 .701.031C9.444.095 9.99.645 9.99 1.409v.526c0 .384.214.706.535.862a6.98 6.98 0 0 1 .606.331c.316.19.693.16.965-.066l.372-.323a1.402 1.402 0 0 1 1.947.162l.739.845c.45.515.433 1.28-.037 1.773l-.365.388c-.224.238-.285.58-.152.892.144.343.27.694.374 1.052.098.339.364.59.706.643l.529.082c.764.119 1.282.823 1.2 1.593l-.116 1.112c-.076.729-.7 1.263-1.437 1.178l-.531-.065c-.345-.042-.668.163-.805.481a6.887 6.887 0 0 1-.376 1.053c-.134.312-.072.654.153.892l.365.388c.469.494.486 1.258.037 1.773l-.74.845a1.402 1.402 0 0 1-1.947.162l-.373-.324c-.272-.225-.648-.255-.963-.065-.198.12-.408.228-.61.331a.993.993 0 0 0-.535.862v.526c0 .764-.546 1.314-1.289 1.378A8.2 8.2 0 0 1 8 16a8.2 8.2 0 0 1-.701-.031C6.556 15.905 6.01 15.355 6.01 14.591v-.526a.993.993 0 0 0-.535-.862 6.942 6.942 0 0 1-.607-.331c-.315-.19-.691-.16-.963.065l-.373.324a1.402 1.402 0 0 1-1.947-.162l-.739-.845c-.45-.515-.433-1.28.037-1.773l.365-.388c.224-.238.285-.58.152-.892a6.933 6.933 0 0 1-.374-1.053c-.098-.339-.364-.59-.706-.643l-.529-.082C.236 9.177-.282 8.473-.2 7.703l.116-1.112C-.008 5.862.616 5.328 1.353 5.413l.531.065c.345.042.668-.163.805-.481A6.887 6.887 0 0 1 3.065 3.944c.134-.312.072-.654-.153-.892L2.547 2.664C2.078 2.17 2.061 1.406 2.51.891l.74-.845A1.402 1.402 0 0 1 5.197.884l.372.323c.272.226.649.256.965.066a6.98 6.98 0 0 1 .606-.331A.993.993 0 0 0 7.675 1.935V1.409C7.675.645 8.221.095 8.964.031 8.977.01 8.988 0 9 0H8ZM6.5 8a1.5 1.5 0 1 0 3 0 1.5 1.5 0 0 0-3 0Z"/>
            </svg>
          </button>
        </div>
      </div>
    </div>

    <!-- Checkpoints panel -->
    <div v-if="showCheckpoints" class="ai-checkpoints-panel">
      <div class="ai-threads-header">
        <span>Checkpoints ({{ checkpoints.length }})</span>
        <button class="ai-settings-close" @click="showCheckpoints = false">✕</button>
      </div>
      <div class="ai-checkpoints-actions">
        <button class="ai-cp-save-btn" @click="saveCheckpoint()">+ Save checkpoint now</button>
        <span class="ai-cp-hint">Ctrl+Shift+S · /checkpoint [name]</span>
      </div>
      <div class="ai-threads-list">
        <div v-if="!checkpoints.length" class="ai-threads-empty">No checkpoints yet.<br>Save one to restore the conversation later.</div>
        <div
          v-for="cp in checkpoints"
          :key="cp.id"
          class="ai-checkpoint-item"
        >
          <div class="ai-cp-info">
            <span class="ai-cp-name">{{ cp.name }}</span>
            <span class="ai-cp-meta">{{ cp.messagesSnapshot.length }} msgs · {{ new Date(cp.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) }}</span>
          </div>
          <div class="ai-cp-btns">
            <button class="ai-cp-restore-btn" title="Restore this checkpoint" @click="restoreCheckpoint(cp)">Restore</button>
            <button class="ai-cp-del-btn" title="Delete checkpoint" @click="deleteCheckpoint(cp.id)">✕</button>
          </div>
        </div>
      </div>
    </div>

    <!-- Image zoom modal -->
    <div v-if="zoomedImageSrc" class="ai-img-zoom-overlay" @click="zoomedImageSrc = null">
      <img :src="zoomedImageSrc" class="ai-img-zoom-img" alt="zoomed image" @click.stop />
      <button class="ai-img-zoom-close" @click="zoomedImageSrc = null">✕</button>
    </div>

    <!-- Thread list panel -->
    <div v-if="showThreads" class="ai-threads-panel" :style="threadPanelHeight ? { height: threadPanelHeight + 'px', maxHeight: 'none' } : {}">
      <div class="ai-panel-resize-handle" @mousedown.prevent="onPanelResizeMousedown" title="Drag to resize" />
      <div class="ai-threads-header">
        <div class="ai-threads-tabs">
          <button class="ai-threads-tab" :class="{ active: threadTab === 'chats' }" @click="threadTab = 'chats'">Chats ({{ allThreads.filter(t => !t.archived).length }})</button>
          <button class="ai-threads-tab" :class="{ active: threadTab === 'pinned' }" @click="threadTab = 'pinned'">Pinned ({{ allThreads.filter(t => !t.archived && t.pinned).length }})</button>
          <button class="ai-threads-tab" :class="{ active: threadTab === 'archived' }" @click="threadTab = 'archived'">Archive ({{ allThreads.filter(t => t.archived).length }})</button>
        </div>
        <div class="ai-thread-sort-wrap">
          <button class="ai-thread-sort-btn" :title="`Sort: ${threadSortMode}`" @click="threadSortMode = threadSortMode === 'date' ? 'name' : threadSortMode === 'name' ? 'model' : 'date'">
            <svg v-if="threadSortMode === 'date'" width="11" height="11" viewBox="0 0 16 16" fill="currentColor"><path d="M3.5 3.75a.25.25 0 0 1 .25-.25h8.5a.25.25 0 0 1 0 .5h-8.5a.25.25 0 0 1-.25-.25Zm0 4a.25.25 0 0 1 .25-.25h5.5a.25.25 0 0 1 0 .5h-5.5a.25.25 0 0 1-.25-.25Zm0 4a.25.25 0 0 1 .25-.25h2.5a.25.25 0 0 1 0 .5h-2.5a.25.25 0 0 1-.25-.25Z"/></svg>
            <svg v-else-if="threadSortMode === 'name'" width="11" height="11" viewBox="0 0 16 16" fill="currentColor"><path d="M3.75 2a.75.75 0 0 1 .75.75v9.5a.75.75 0 0 1-1.5 0v-9.5A.75.75 0 0 1 3.75 2Zm8.854 2.646a.5.5 0 0 1 0 .708L10.707 7.25H15.5a.5.5 0 0 1 0 1h-4.793l1.897 1.896a.5.5 0 1 1-.708.708l-2.75-2.75a.5.5 0 0 1 0-.708l2.75-2.75a.5.5 0 0 1 .708 0Z"/></svg>
            <svg v-else width="11" height="11" viewBox="0 0 16 16" fill="currentColor"><path d="M8 .25a.75.75 0 0 1 .673.418l1.882 3.815 4.21.612a.75.75 0 0 1 .416 1.279l-3.046 2.97.719 4.192a.75.75 0 0 1-1.088.791L8 12.347l-3.766 1.98a.75.75 0 0 1-1.088-.79l.72-4.194L.818 6.374a.75.75 0 0 1 .416-1.28l4.21-.611L7.327.668A.75.75 0 0 1 8 .25Z"/></svg>
            <span style="font-size:9px;margin-left:2px;opacity:.7">{{ threadSortMode }}</span>
          </button>
        </div>
        <button class="ai-settings-close" @click="showThreads = false; threadSearchQuery = ''">✕</button>
      </div>
      <div class="ai-threads-search">
        <input
          v-model="threadSearchQuery"
          class="ai-search-input"
          :placeholder="threadTab === 'archived' ? 'Search archived…' : threadTab === 'pinned' ? 'Search pinned…' : 'Search chats…'"
          @keydown.escape="showThreads = false; threadSearchQuery = ''"
        />
        <button class="ai-thread-bulk-toggle" :class="{ active: threadBulkMode }" title="Select multiple" @click="toggleThreadBulkMode">☑</button>
      </div>
      <div v-if="threadBulkMode && selectedThreadIds.size > 0" class="ai-thread-bulk-bar">
        <span class="ai-thread-bulk-count">{{ selectedThreadIds.size }} selected</span>
        <button class="ai-thread-bulk-btn" @click="bulkArchiveThreads">Archive</button>
        <button class="ai-thread-bulk-btn ai-thread-bulk-del" @click="bulkDeleteThreads">Delete</button>
        <button class="ai-thread-bulk-cancel" @click="cancelThreadBulkMode">Cancel</button>
      </div>
      <div class="ai-threads-list">
        <div v-if="!filteredThreads.length" class="ai-threads-empty">No results</div>
        <template v-for="item in groupedThreads" :key="item.kind === 'label' ? 'label-' + item.label : item.thread.id">
          <div v-if="item.kind === 'label'" class="ai-thread-group-label">{{ item.label }}</div>
          <div
            v-else
            class="ai-thread-item"
            :class="{ active: item.thread.id === currentThreadId, 'bulk-selected': threadBulkMode && selectedThreadIds.has(item.thread.id) }"
            :style="item.thread.color ? `border-left: 3px solid ${item.thread.color}` : ''"
            @click="threadBulkMode ? toggleThreadSelect(item.thread.id) : switchThread(item.thread.id)"
          >
            <input
              v-if="threadBulkMode"
              type="checkbox"
              class="ai-thread-checkbox"
              :checked="selectedThreadIds.has(item.thread.id)"
              @click.stop="toggleThreadSelect(item.thread.id)"
            />
            <div class="ai-thread-main">
              <input
                v-if="renamingThreadId === item.thread.id"
                v-model="renamingTitle"
                class="ai-thread-rename-input"
                @click.stop
                @keydown.enter.prevent="finishRenameThread"
                @keydown.escape.prevent="cancelRenameThread"
                @blur="finishRenameThread"
              />
              <span
                v-else
                class="ai-thread-title"
                :title="$t('action.double-click-rename')"
                @dblclick.stop="startRenameThread(item.thread.id, item.thread.title, $event)"
                v-html="highlightSearchMatch(item.thread.title, threadSearchQuery)"
              ></span>
              <span v-if="threadSearchQuery && !item.thread.title.toLowerCase().includes(threadSearchQuery.toLowerCase())" class="ai-thread-snippet" v-html="highlightSearchMatch(getThreadMatchSnippet(item.thread, threadSearchQuery), threadSearchQuery)"></span>
              <!-- Fork origin badge — click to jump to parent thread -->
              <span
                v-if="item.thread.forkedFrom && allThreads.find(t => t.id === item.thread.forkedFrom)"
                class="ai-thread-fork-badge"
                :title="`Forked from: ${allThreads.find(t => t.id === item.thread.forkedFrom)?.title ?? 'parent thread'}`"
                @click.stop="switchThread(item.thread.forkedFrom!)"
              >⤴ fork</span>
            </div>
            <div class="ai-thread-meta">
              <span v-if="item.thread.label" class="ai-thread-label-badge" :title="`Label: ${item.thread.label}`">{{ item.thread.label }}</span>
              <span v-if="item.thread.model" class="ai-thread-model-badge" :title="`Thread model: ${item.thread.model}`">{{ MODEL_CATALOG.find(m => m.id === item.thread.model)?.display?.split(' ').slice(-1)[0] ?? item.thread.model }}</span>
              <span v-if="item.thread.messages.length" class="ai-thread-count">{{ item.thread.messages.length }}</span>
              <!-- Unread badge: AI messages since last visit -->
              <span
                v-if="item.thread.id !== currentThreadId && threadUnreadCount(item.thread) > 0"
                class="ai-thread-unread"
                :title="`${threadUnreadCount(item.thread)} new AI response${threadUnreadCount(item.thread) > 1 ? 's' : ''} since last visit`"
              >{{ threadUnreadCount(item.thread) > 9 ? '9+' : threadUnreadCount(item.thread) }}</span>
              <span v-if="threadTotalTokens(item.thread) > 0" class="ai-thread-tokens" :title="`~${threadTotalTokens(item.thread).toLocaleString()} total tokens`">{{ threadTotalTokens(item.thread) >= 1000 ? (threadTotalTokens(item.thread) / 1000).toFixed(1) + 'k' : threadTotalTokens(item.thread) }}t</span>
              <span class="ai-thread-time" :title="new Date(item.thread.updatedAt).toLocaleString()">{{ relativeTime(item.thread.updatedAt) }}</span>
              <!-- Color dot — click to cycle colors (Cursor-style thread tagging) -->
              <button
                class="ai-thread-color-btn"
                :style="item.thread.color ? `background:${item.thread.color}` : ''"
                :title="item.thread.color ? `Color: ${item.thread.color} (click to change)` : 'Set thread color'"
                @click.stop="cycleThreadColor(item.thread.id, $event)"
              />
              <button class="ai-thread-pin" :title="item.thread.pinned ? 'Unpin' : 'Pin'" @click.stop="togglePinThread(item.thread.id, $event)">{{ item.thread.pinned ? '📌' : '⊙' }}</button>
              <button class="ai-thread-dup" title="Duplicate thread" @click.stop="duplicateThread(item.thread.id)">⎘</button>
              <button class="ai-thread-archive" :title="item.thread.archived ? 'Unarchive' : 'Archive'" @click.stop="toggleArchiveThread(item.thread.id, $event)">{{ item.thread.archived ? '↩' : '⊡' }}</button>
              <button class="ai-thread-del" title="Delete" @click.stop="deleteThread(item.thread.id)">✕</button>
            </div>
            <div v-if="item.thread.messages.length && renamingThreadId !== item.thread.id" class="ai-thread-preview">
              {{ (item.thread.messages.find(m => m.role === 'user') ?? item.thread.messages[0])?.content.replace(/[#`*_~>]/g, '').replace(/\/\w+\s*/g, '').trim().slice(0, 70) || '…' }}
            </div>
          </div>
        </template>
      </div>
    </div>

    <!-- Notepads panel -->
    <div v-if="showNotes" class="ai-settings">
      <div class="ai-settings-header">
        <span>Workspace Notes <span style="font-weight:400;opacity:.6;font-size:11px">— injected into every message</span></span>
        <button class="ai-settings-close" @click="showNotes = false">✕</button>
      </div>
      <div class="ai-settings-body">
        <p class="ai-settings-hint">Write anything the AI should always know: project conventions, tech stack, coding rules, todo items. Saved per workspace.</p>
        <textarea
          v-model="notesContent"
          class="ai-notes-textarea"
          placeholder="e.g. This is a Vue 3 + TypeScript project using Tailwind CSS. Always use composition API with <script setup>. Prefer const over let."
          rows="6"
          @input="saveNotes"
        />
        <div style="display:flex;justify-content:flex-end;margin-top:8px;gap:8px">
          <span class="ai-settings-hint" style="flex:1">{{ notesContent.trim() ? `~${Math.ceil(notesContent.length/4)} tokens` : 'Empty — nothing injected' }}</span>
          <button class="ai-cancel-btn" @click="notesContent = ''; saveNotes()">Clear</button>
        </div>

        <!-- Named Notepads -->
        <div class="ai-notepad-section">
          <div class="ai-notepad-section-header">
            <span>Named Notepads <span style="opacity:.6;font-size:10.5px">— reference via <code>@notepad:name</code></span></span>
            <button class="ai-notepad-add-btn" title="New notepad" @click="showNewNotepadInput = !showNewNotepadInput">+</button>
          </div>
          <div v-if="showNewNotepadInput" class="ai-notepad-new-row">
            <input
              v-model="newNotepadName"
              class="ai-notepad-new-input"
              placeholder="Notepad name…"
              @keydown.enter.prevent="if (newNotepadName.trim()) { createNotepad(newNotepadName); newNotepadName = ''; showNewNotepadInput = false }"
              @keydown.escape.prevent="showNewNotepadInput = false; newNotepadName = ''"
            />
            <button class="ai-notepad-create-btn" :disabled="!newNotepadName.trim()" @click="if (newNotepadName.trim()) { createNotepad(newNotepadName); newNotepadName = ''; showNewNotepadInput = false }">Create</button>
          </div>
          <div v-if="namedNotepads.length === 0 && !showNewNotepadInput" class="ai-settings-hint" style="padding:6px 0">No named notepads yet — click + to create one.</div>
          <div v-for="np in namedNotepads" :key="np.id" class="ai-notepad-item">
            <div class="ai-notepad-item-header" @click="activeNotepadId = activeNotepadId === np.id ? null : np.id">
              <span class="ai-notepad-item-name" :class="{ active: activeNotepadId === np.id }">{{ np.name }}</span>
              <span class="ai-notepad-item-tokens">{{ np.content.trim() ? `~${Math.ceil(np.content.length/4)} tok` : 'empty' }}</span>
              <button class="ai-notepad-pin-btn" :class="{ active: np.pinned }" :title="np.pinned ? 'Always inject: ON (click to disable)' : 'Pin: always inject into every message'" @click.stop="toggleNotepadPin(np.id)">{{ np.pinned ? '📌' : '⊙' }}</button>
              <button class="ai-notepad-item-del" title="Delete" @click.stop="deleteNotepad(np.id)">✕</button>
            </div>
            <textarea
              v-if="activeNotepadId === np.id"
              :value="np.content"
              class="ai-notes-textarea"
              :placeholder="`Notes for ${np.name}…`"
              rows="5"
              @input="updateNotepadContent(np.id, ($event.target as HTMLTextAreaElement).value)"
            />
          </div>
        </div>

        <!-- Memories — Cursor-style persistent facts injected into every conversation -->
        <div class="ai-notepad-section">
          <div class="ai-notepad-section-header">
            <span>Memories <span style="opacity:.6;font-size:10.5px">— injected into every conversation (cross-session)</span></span>
            <button
              class="ai-notepad-add-btn"
              :title="$t('action.add-memory')"
              @click="promptAddMemory"
            >+</button>
          </div>
          <div v-if="memories.length === 0" class="ai-settings-hint" style="padding:6px 0">No memories yet — click + to add a persistent fact.</div>
          <div v-for="(mem, mi) in memories" :key="mi" class="ai-notepad-item" style="cursor:default">
            <div class="ai-notepad-item-header">
              <span class="ai-notepad-item-name" style="font-weight:400;font-size:12px">{{ mem }}</span>
              <button class="ai-notepad-item-del" title="Remove memory" @click="removeMemory(mi)">✕</button>
            </div>
          </div>
        </div>

        <!-- Global Context Pins — always-include files across all conversations -->
        <div class="ai-notepad-section" style="margin-top:8px">
          <div class="ai-notepad-section-header">
            <span>Always-Include Files <span style="opacity:.6;font-size:10.5px">— file content injected every conversation</span></span>
            <button
              class="ai-notepad-add-btn"
              :title="$t('action.pin-file-path')"
              @click="promptAddGlobalPin"
            >+</button>
          </div>
          <div v-if="globalContextPins.length === 0" class="ai-settings-hint" style="padding:6px 0">No pinned files — click + to always include a file in every conversation.</div>
          <div v-for="pin in globalContextPins" :key="pin.id" class="ai-notepad-item" style="cursor:default">
            <div class="ai-notepad-item-header">
              <span class="ai-notepad-item-name" style="font-weight:400;font-size:12px;color:var(--accent-fg)">{{ pin.label }}</span>
              <span class="ai-settings-hint" style="flex:1;font-size:10.5px;padding:0 4px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">{{ pin.relPath }}</span>
              <button class="ai-notepad-item-del" title="Remove pin" @click="removeGlobalPin(pin.id)">✕</button>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- Prompt Templates Library panel -->
    <div v-if="showPromptTemplates" class="ai-settings">
      <div class="ai-settings-header">
        <span>Prompt Templates <span style="font-weight:400;opacity:.6;font-size:11px">— click to insert into chat</span></span>
        <button class="ai-settings-close" @click="showPromptTemplates = false">✕</button>
      </div>
      <div class="ai-settings-body">
        <div class="ai-pt-actions">
          <button class="ai-pt-save-btn" :disabled="!inputText.trim()" title="Save current input as template" @click="addPromptTemplate">
            + Save current input
          </button>
          <span class="ai-settings-hint">{{ promptTemplates.length > 0 ? `${promptTemplates.length} saved` : 'Showing built-ins' }}</span>
          <button v-if="promptTemplates.length > 0" class="ai-cancel-btn" @click="promptTemplates = []; savePromptTemplates()">Clear all</button>
        </div>
        <div class="ai-pt-list">
          <div v-for="t in displayedTemplates" :key="t.id" class="ai-pt-item">
            <button class="ai-pt-use" @click="usePromptTemplate(t)">
              <span class="ai-pt-name">{{ t.name }}</span>
              <span class="ai-pt-preview">{{ t.text.slice(0, 60).replace(/\n/g, ' ') }}…</span>
            </button>
            <button v-if="promptTemplates.length > 0" class="ai-pt-del" title="Delete" @click="deletePromptTemplate(t.id)">✕</button>
          </div>
        </div>
      </div>
    </div>

    <!-- Bookmarks panel -->
    <div v-if="showBookmarks" class="ai-settings">
      <div class="ai-settings-header">
        <span>Bookmarks <span style="font-weight:400;opacity:.6;font-size:11px">— {{ bookmarkedMessages.length ? `${bookmarkedMessages.length} in this thread` : 'none yet — use ★ on a message' }}</span></span>
        <button class="ai-settings-close" @click="showBookmarks = false">✕</button>
      </div>
      <div class="ai-settings-body">
        <div v-if="bookmarkedMessages.length === 0" class="ai-settings-hint" style="padding:8px 0">
          Bookmark messages with the ★ button to quickly jump back to them.
        </div>
        <div v-for="{ msg, idx } in bookmarkedMessages" :key="idx" class="ai-bm-item" @click="jumpToBookmark(idx)">
          <span class="ai-bm-role">{{ msg.role === 'user' ? 'You' : 'AI' }}</span>
          <span class="ai-bm-snippet">{{ msg.content.replace(/```[\s\S]*?```/g, '[code]').replace(/\n/g, ' ').trim().slice(0, 80) }}</span>
        </div>
      </div>
    </div>

    <!-- Apply-code diff preview modal -->
    <div v-if="diffApplyState" class="ai-modal-overlay" @click.self="diffApplyState = null">
      <div class="ai-modal">
        <div class="ai-modal-header">
          <span>Apply code to <code>{{ diffApplyState.relPath }}</code>?</span>
          <button class="ai-settings-close" @click="diffApplyState = null">✕</button>
        </div>
        <div class="ai-modal-body">
          <div class="ai-diff-stats">
            <span class="ai-diff-old">{{ diffApplyState.oldLines }} lines currently</span>
            <span class="ai-diff-arrow">→</span>
            <span class="ai-diff-new">{{ diffApplyState.newLines }} lines proposed</span>
            <span
              class="ai-diff-delta"
              :class="diffApplyState.newLines > diffApplyState.oldLines ? 'add' : diffApplyState.newLines < diffApplyState.oldLines ? 'del' : 'same'"
            >
              {{ diffApplyState.newLines > diffApplyState.oldLines ? '+' : '' }}{{ diffApplyState.newLines - diffApplyState.oldLines }}
            </span>
          </div>
          <!-- Inline diff preview -->
          <div v-if="diffApplyState.oldContent" class="ai-diff-preview">
            <div
              v-for="(ln, li) in computeSimpleDiffPreview(diffApplyState.oldContent, diffApplyState.code)"
              :key="li"
              class="ai-diff-ln"
              :class="ln.type === '+' ? 'diff-add' : ln.type === '-' ? 'diff-del' : 'diff-ctx'"
            ><span class="ai-diff-sign">{{ ln.type }}</span><span class="ai-diff-text">{{ ln.text }}</span></div>
          </div>
          <p class="ai-modal-warning">This will overwrite the entire file.</p>
        </div>
        <div class="ai-modal-footer">
          <button class="ai-cancel-btn" @click="diffApplyState = null">Cancel <kbd>Esc</kbd></button>
          <button class="ai-apply-confirm-btn" title="Apply changes (⌘↵ / Ctrl+↵)" @click="confirmApply">Apply <kbd>⌘↵</kbd></button>
        </div>
      </div>
    </div>

    <!-- Prompt history palette (Ctrl+Shift+H) -->
    <div v-if="showHistoryPalette" class="ai-modal-overlay" @click.self="showHistoryPalette = false">
      <div class="ai-modal ai-history-palette">
        <div class="ai-modal-header">
          <span>Prompt History <kbd style="font-size:10px;opacity:.6">Ctrl+R</kbd></span>
          <button class="ai-settings-close" @click="showHistoryPalette = false">✕</button>
        </div>
        <input
          v-model="historyPaletteQuery"
          class="ai-history-palette-input"
          placeholder="Search prompt history…"
          @keydown.escape="showHistoryPalette = false"
        />
        <div class="ai-history-palette-list">
          <div v-if="!filteredHistory.length" class="ai-history-palette-empty">No history yet</div>
          <button
            v-for="(h, i) in filteredHistory.slice(0, 50)"
            :key="i"
            class="ai-history-palette-item"
            @click="pickHistory(h)"
          >{{ h.length > 120 ? h.slice(0, 120) + '…' : h }}</button>
        </div>
      </div>
    </div>

    <!-- Code Compare modal -->
    <div v-if="compareResult" class="ai-modal-overlay" @click.self="compareResult = null; compareStage = null">
      <div class="ai-modal ai-compare-modal">
        <div class="ai-modal-header">
          <span>Code Comparison</span>
          <button class="ai-settings-close" @click="compareResult = null; compareStage = null">✕</button>
        </div>
        <div class="ai-compare-diff">
          <div
            v-for="(ln, li) in computeSimpleDiffPreview(compareResult.codeA, compareResult.codeB, 300)"
            :key="li"
            class="ai-diff-ln"
            :class="ln.type === '+' ? 'diff-add' : ln.type === '-' ? 'diff-del' : 'diff-ctx'"
          ><span class="ai-diff-sign">{{ ln.type }}</span><span class="ai-diff-text">{{ ln.text }}</span></div>
        </div>
        <div class="ai-modal-footer">
          <button class="ai-cancel-btn" @click="compareResult = null; compareStage = null">Close <kbd>Esc</kbd></button>
        </div>
      </div>
    </div>

    <!-- Settings panel -->
    <div v-if="showSettings" class="ai-settings">
      <div class="ai-settings-header">
        <span>AI Settings</span>
        <button class="ai-settings-close" @click="showSettings = false">✕</button>
      </div>
      <div class="ai-settings-body">
        <div class="ai-settings-row">
          <label class="ai-settings-label">Provider</label>
          <div class="ai-settings-radios">
            <label><input v-model="settingsProvider" type="radio" value="anthropic" /> Anthropic</label>
            <label><input v-model="settingsProvider" type="radio" value="openai" /> OpenAI</label>
            <label><input v-model="settingsProvider" type="radio" value="groq" /> Groq</label>
            <label><input v-model="settingsProvider" type="radio" value="deepseek" /> DeepSeek</label>
            <label><input v-model="settingsProvider" type="radio" value="google" /> Google</label>
            <label><input v-model="settingsProvider" type="radio" value="mistral" /> Mistral</label>
            <label><input v-model="settingsProvider" type="radio" value="xai" /> xAI</label>
            <label><input v-model="settingsProvider" type="radio" value="ollama" /> Ollama</label>
            <label><input v-model="settingsProvider" type="radio" value="openai_compatible" /> Custom (OpenAI-compat)</label>
          </div>
        </div>
        <div v-if="settingsProvider === 'anthropic'" class="ai-settings-row">
          <label class="ai-settings-label">Anthropic API Key</label>
          <div class="ai-settings-key-row">
            <input v-model="settingsApiKey" type="password" class="ai-settings-input" placeholder="sk-ant-…" />
            <button class="ai-settings-test-btn" :disabled="testConnStatus['anthropic'] === 'testing'" @click="testConnection('anthropic')">{{ testConnStatus['anthropic'] === 'testing' ? '…' : 'Test' }}</button>
            <span v-if="testConnStatus['anthropic'] === 'ok'" class="ai-settings-test-ok" title="Connection OK">✓</span>
            <span v-if="testConnStatus['anthropic'] === 'fail'" class="ai-settings-test-fail" :title="testConnError['anthropic']">✗</span>
          </div>
        </div>
        <div v-if="settingsProvider === 'openai'" class="ai-settings-row">
          <label class="ai-settings-label">OpenAI API Key</label>
          <div class="ai-settings-key-row">
            <input v-model="settingsOpenAiKey" type="password" class="ai-settings-input" placeholder="sk-…" />
            <button class="ai-settings-test-btn" :disabled="testConnStatus['openai'] === 'testing'" @click="testConnection('openai')">{{ testConnStatus['openai'] === 'testing' ? '…' : 'Test' }}</button>
            <span v-if="testConnStatus['openai'] === 'ok'" class="ai-settings-test-ok" title="Connection OK">✓</span>
            <span v-if="testConnStatus['openai'] === 'fail'" class="ai-settings-test-fail" :title="testConnError['openai']">✗</span>
          </div>
        </div>
        <div v-if="settingsProvider === 'groq'" class="ai-settings-row">
          <label class="ai-settings-label">Groq API Key</label>
          <div class="ai-settings-key-row">
            <input v-model="settingsGroqKey" type="password" class="ai-settings-input" placeholder="gsk_…" />
            <button class="ai-settings-test-btn" :disabled="testConnStatus['groq'] === 'testing'" @click="testConnection('groq')">{{ testConnStatus['groq'] === 'testing' ? '…' : 'Test' }}</button>
            <span v-if="testConnStatus['groq'] === 'ok'" class="ai-settings-test-ok" title="Connection OK">✓</span>
            <span v-if="testConnStatus['groq'] === 'fail'" class="ai-settings-test-fail" :title="testConnError['groq']">✗</span>
          </div>
        </div>
        <div v-if="settingsProvider === 'deepseek'" class="ai-settings-row">
          <label class="ai-settings-label">DeepSeek API Key</label>
          <div class="ai-settings-key-row">
            <input v-model="settingsDeepSeekKey" type="password" class="ai-settings-input" placeholder="sk-…" />
            <button class="ai-settings-test-btn" :disabled="testConnStatus['deepseek'] === 'testing'" @click="testConnection('deepseek')">{{ testConnStatus['deepseek'] === 'testing' ? '…' : 'Test' }}</button>
            <span v-if="testConnStatus['deepseek'] === 'ok'" class="ai-settings-test-ok" title="Connection OK">✓</span>
            <span v-if="testConnStatus['deepseek'] === 'fail'" class="ai-settings-test-fail" :title="testConnError['deepseek']">✗</span>
          </div>
        </div>
        <div v-if="settingsProvider === 'google'" class="ai-settings-row">
          <label class="ai-settings-label">Google API Key</label>
          <div class="ai-settings-key-row">
            <input v-model="settingsGoogleKey" type="password" class="ai-settings-input" placeholder="AIza…" />
            <button class="ai-settings-test-btn" :disabled="testConnStatus['google'] === 'testing'" @click="testConnection('google')">{{ testConnStatus['google'] === 'testing' ? '…' : 'Test' }}</button>
            <span v-if="testConnStatus['google'] === 'ok'" class="ai-settings-test-ok" title="Connection OK">✓</span>
            <span v-if="testConnStatus['google'] === 'fail'" class="ai-settings-test-fail" :title="testConnError['google']">✗</span>
          </div>
        </div>
        <div v-if="settingsProvider === 'mistral'" class="ai-settings-row">
          <label class="ai-settings-label">Mistral API Key</label>
          <div class="ai-settings-key-row">
            <input v-model="settingsMistralKey" type="password" class="ai-settings-input" placeholder="…" />
            <button class="ai-settings-test-btn" :disabled="testConnStatus['mistral'] === 'testing'" @click="testConnection('mistral')">{{ testConnStatus['mistral'] === 'testing' ? '…' : 'Test' }}</button>
            <span v-if="testConnStatus['mistral'] === 'ok'" class="ai-settings-test-ok" title="Connection OK">✓</span>
            <span v-if="testConnStatus['mistral'] === 'fail'" class="ai-settings-test-fail" :title="testConnError['mistral']">✗</span>
          </div>
        </div>
        <div v-if="settingsProvider === 'xai'" class="ai-settings-row">
          <label class="ai-settings-label">xAI API Key</label>
          <div class="ai-settings-key-row">
            <input v-model="settingsXaiKey" type="password" class="ai-settings-input" placeholder="xai-…" />
            <button class="ai-settings-test-btn" :disabled="testConnStatus['xai'] === 'testing'" @click="testConnection('xai')">{{ testConnStatus['xai'] === 'testing' ? '…' : 'Test' }}</button>
            <span v-if="testConnStatus['xai'] === 'ok'" class="ai-settings-test-ok" title="Connection OK">✓</span>
            <span v-if="testConnStatus['xai'] === 'fail'" class="ai-settings-test-fail" :title="testConnError['xai']">✗</span>
          </div>
        </div>
        <div v-if="settingsProvider === 'openai_compatible'" class="ai-settings-row">
          <label class="ai-settings-label">Base URL</label>
          <input v-model="settingsOaiCompatUrl" type="text" class="ai-settings-input" placeholder="https://…/v1" />
        </div>
        <div v-if="settingsProvider === 'openai_compatible'" class="ai-settings-row">
          <label class="ai-settings-label">API Key</label>
          <div class="ai-settings-key-row">
            <input v-model="settingsOaiCompatKey" type="password" class="ai-settings-input" placeholder="optional" />
            <button class="ai-settings-test-btn" :disabled="testConnStatus['openai_compatible'] === 'testing'" @click="testConnection('openai_compatible')">{{ testConnStatus['openai_compatible'] === 'testing' ? '…' : 'Test' }}</button>
            <span v-if="testConnStatus['openai_compatible'] === 'ok'" class="ai-settings-test-ok" title="Connection OK">✓</span>
            <span v-if="testConnStatus['openai_compatible'] === 'fail'" class="ai-settings-test-fail" :title="testConnError['openai_compatible']">✗</span>
          </div>
        </div>
        <div v-if="settingsProvider === 'openai_compatible'" class="ai-settings-row">
          <label class="ai-settings-label">Model ID</label>
          <input v-model="settingsOaiCompatModel" type="text" class="ai-settings-input" placeholder="gpt-4o" />
        </div>
        <!-- Test connection error detail -->
        <div v-if="testConnStatus[settingsProvider] === 'fail' && testConnError[settingsProvider]" class="ai-settings-test-error-row">
          <span class="ai-settings-test-fail-icon">✗</span>
          <span class="ai-settings-test-error-msg">{{ testConnError[settingsProvider] }}</span>
        </div>
        <div class="ai-settings-row">
          <label class="ai-settings-label">Model</label>
          <select
            :value="(settingsProvider === 'openai_compatible') ? 'custom' : (modelIsCustom ? 'custom' : settingsModel)"
            class="ai-settings-select"
            @change="(e) => { const v = (e.target as HTMLSelectElement).value; if (v !== 'custom') switchModel(v) }"
          >
            <option value="auto">✦ Auto (best available)</option>
            <optgroup label="Anthropic">
              <option v-for="m in MODEL_CATALOG.filter(e => e.provider === 'anthropic')" :key="m.id" :value="m.id">{{ m.display }} — {{ m.note }}</option>
            </optgroup>
            <optgroup label="OpenAI">
              <option v-for="m in MODEL_CATALOG.filter(e => e.provider === 'openai')" :key="m.id" :value="m.id">{{ m.display }} — {{ m.note }}</option>
            </optgroup>
            <optgroup label="Groq">
              <option v-for="m in MODEL_CATALOG.filter(e => e.provider === 'groq')" :key="m.id" :value="m.id">{{ m.display }} — {{ m.note }}</option>
            </optgroup>
            <optgroup label="DeepSeek">
              <option v-for="m in MODEL_CATALOG.filter(e => e.provider === 'deepseek')" :key="m.id" :value="m.id">{{ m.display }} — {{ m.note }}</option>
            </optgroup>
            <optgroup label="Google Gemini">
              <option v-for="m in MODEL_CATALOG.filter(e => e.provider === 'google')" :key="m.id" :value="m.id">{{ m.display }} — {{ m.note }}</option>
            </optgroup>
            <optgroup label="Mistral AI">
              <option v-for="m in MODEL_CATALOG.filter(e => e.provider === 'mistral')" :key="m.id" :value="m.id">{{ m.display }} — {{ m.note }}</option>
            </optgroup>
            <optgroup label="xAI Grok">
              <option v-for="m in MODEL_CATALOG.filter(e => e.provider === 'xai')" :key="m.id" :value="m.id">{{ m.display }} — {{ m.note }}</option>
            </optgroup>
            <optgroup label="Ollama (Local)">
              <option v-for="m in MODEL_CATALOG.filter(e => e.provider === 'ollama')" :key="m.id" :value="m.id">{{ m.display }} — {{ m.note }}</option>
            </optgroup>
            <option value="custom">Custom…</option>
          </select>
          <input
            v-if="modelIsCustom && settingsProvider !== 'openai_compatible'"
            v-model="settingsModel"
            type="text"
            class="ai-settings-input ai-settings-input--custom"
            placeholder="Enter model ID"
          />
        </div>
        <div v-if="settingsProvider === 'ollama'" class="ai-settings-row">
          <label class="ai-settings-label">Ollama URL</label>
          <div class="ai-settings-key-row">
            <input v-model="settingsOllamaUrl" type="text" class="ai-settings-input" placeholder="http://localhost:11434" />
            <button class="ai-settings-test-btn" :disabled="testConnStatus['ollama'] === 'testing'" @click="testConnection('ollama')">{{ testConnStatus['ollama'] === 'testing' ? '…' : 'Test' }}</button>
            <span v-if="testConnStatus['ollama'] === 'ok'" class="ai-settings-test-ok" title="Ollama reachable">✓</span>
            <span v-if="testConnStatus['ollama'] === 'fail'" class="ai-settings-test-fail" :title="testConnError['ollama']">✗</span>
          </div>
        </div>
        <div class="ai-settings-row ai-settings-row--column">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px">
            <label class="ai-settings-label" style="margin:0">System Prompt</label>
            <select class="ai-profile-select" title="Quick profile" @change="applySystemPromptProfile(($event.target as HTMLSelectElement).value)">
              <option value="">Quick profile…</option>
              <option value="coding">Coding assistant</option>
              <option value="concise">Concise (no fluff)</option>
              <option value="security">Security reviewer</option>
              <option value="teacher">Teacher / explain everything</option>
              <option value="refactor">Refactoring expert</option>
              <option value="custom">Custom (keep current)</option>
            </select>
          </div>
          <textarea
            v-model="settingsSystemPrompt"
            class="ai-settings-textarea"
            rows="4"
            placeholder="You are a helpful AI coding assistant."
          />
        </div>
        <div class="ai-settings-row">
          <label class="ai-settings-label">Chat mode</label>
          <label class="ai-toggle-label">
            <input :checked="chatMode === 'agent'" type="checkbox" @change="chatMode = ($event.target as HTMLInputElement).checked ? 'agent' : 'ask'" />
            Agent mode — auto-accept file edits &amp; commands (also use toolbar toggle: Ask → Edit → Agent)
          </label>
        </div>
        <div class="ai-settings-row">
          <label class="ai-settings-label">Smart Context</label>
          <label class="ai-toggle-label">
            <input v-model="settingsSmartContext" type="checkbox" />
            Auto-inject active file (≤200 lines) if not already in context
          </label>
        </div>
        <div class="ai-settings-row">
          <label class="ai-settings-label">Max response tokens (256–16000)</label>
          <div class="ai-tokens-row">
            <input v-model.number="settingsMaxTokens" type="range" min="256" max="16000" step="256" class="ai-tokens-slider" />
            <span class="ai-tokens-val">{{ settingsMaxTokens.toLocaleString() }}</span>
          </div>
        </div>
        <div class="ai-settings-row">
          <label class="ai-settings-label">Max agent tool calls (1–20)</label>
          <div class="ai-tokens-row">
            <input v-model.number="settingsMaxAgentIter" type="range" min="1" max="20" step="1" class="ai-tokens-slider" />
            <span class="ai-tokens-val">{{ settingsMaxAgentIter }}</span>
          </div>
        </div>
        <!-- Reasoning effort (OpenAI o1/o3/o4 models) -->
        <div v-if="reasoningModelSelected" class="ai-settings-row">
          <label class="ai-settings-label">Reasoning effort</label>
          <div class="ai-tokens-row" style="gap:6px">
            <label v-for="lvl in ['low','medium','high']" :key="lvl" class="ai-toggle-label" style="gap:4px;cursor:pointer">
              <input type="radio" :value="lvl" :checked="(settingsReasoningEffort ?? 'medium') === lvl" @change="settingsReasoningEffort = lvl as 'low'|'medium'|'high'" />
              {{ lvl.charAt(0).toUpperCase() + lvl.slice(1) }}
            </label>
          </div>
        </div>
        <div v-if="!reasoningModelSelected" class="ai-settings-row">
          <label class="ai-settings-label">Temperature (0 = precise, 1 = creative)</label>
          <div class="ai-tokens-row">
            <label class="ai-toggle-label" style="margin-right:8px">
              <input type="checkbox" :checked="settingsTemperature === null" @change="settingsTemperature = settingsTemperature === null ? 0.7 : null" />
              Use default
            </label>
            <template v-if="settingsTemperature !== null">
              <input v-model.number="settingsTemperature" type="range" min="0" max="1" step="0.05" class="ai-tokens-slider" />
              <span class="ai-tokens-val">{{ (settingsTemperature ?? 0).toFixed(2) }}</span>
            </template>
          </div>
        </div>
        <!-- Extended thinking (Cursor parity — Claude only) -->
        <div v-if="thinkingSupported" class="ai-settings-row">
          <label class="ai-settings-label">Extended thinking (Claude only)</label>
          <div class="ai-tokens-row">
            <label class="ai-toggle-label" style="margin-right:8px">
              <input type="checkbox" :checked="settingsThinkingBudget !== null" @change="settingsThinkingBudget = settingsThinkingBudget === null ? 8000 : null" />
              Enable
            </label>
            <template v-if="settingsThinkingBudget !== null">
              <input v-model.number="settingsThinkingBudget" type="range" min="1024" max="32000" step="1024" class="ai-tokens-slider" />
              <span class="ai-tokens-val">{{ (settingsThinkingBudget / 1000).toFixed(1) }}k tokens</span>
            </template>
          </div>
        </div>

        <!-- User-level global AI rules (Cursor parity: applies to all projects) -->
        <div class="ai-settings-row ai-settings-row--column">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px">
            <label class="ai-settings-label" style="margin:0">User Rules <span style="font-size:10px;opacity:.55;font-weight:400">— global, all projects</span></label>
          </div>
          <textarea
            v-model="settingsUserRules"
            class="ai-settings-textarea"
            rows="3"
            placeholder="e.g. Always use TypeScript strict mode. Prefer functional components over classes."
          />
        </div>
        <div v-if="workspaceRulesFile" class="ai-settings-row ai-rules-notice">
          <span class="ai-rules-icon">✦</span>
          <span>Workspace rules auto-applied from <code>{{ workspaceRulesFile }}</code></span>
        </div>
        <div v-else class="ai-settings-row ai-rules-notice ai-rules-missing">
          <span>No workspace rules found.</span>
          <button v-if="workspacePath" class="ai-create-rules-btn" @click="createWorkspaceRulesFile">+ Create AGENTS.md</button>
          <span v-if="!workspacePath" style="opacity:.6;font-size:11px">Create <code>AGENTS.md</code> or <code>.cursor/rules</code></span>
        </div>
        <!-- Custom @docs entries -->
        <div class="ai-settings-row ai-settings-row--column">
          <label class="ai-settings-label" style="margin-bottom:6px">Custom @docs <span style="font-size:10px;opacity:.55;font-weight:400">— add your own documentation sources</span></label>
          <div v-if="customDocs.length === 0" style="font-size:11px;opacity:.5;margin-bottom:4px">No custom docs yet.</div>
          <div v-for="d in customDocs" :key="d.key" class="ai-custom-doc-row">
            <span class="ai-custom-doc-key">@docs:{{ d.key }}</span>
            <span class="ai-custom-doc-label" :title="d.url">{{ d.label }}</span>
            <button class="ai-custom-doc-remove" title="Remove" @click="removeCustomDoc(d.key)">×</button>
          </div>
          <div class="ai-custom-doc-add">
            <input v-model="newDocKey"   type="text" class="ai-settings-input" placeholder="key (e.g. nextjs)" style="flex:1;min-width:0" />
            <input v-model="newDocLabel" type="text" class="ai-settings-input" placeholder="Label"              style="flex:1.5;min-width:0" />
            <input v-model="newDocUrl"   type="url"  class="ai-settings-input" placeholder="https://…"         style="flex:2;min-width:0" />
            <button class="ai-create-rules-btn" title="Add doc" @click="addCustomDoc">+</button>
          </div>
        </div>

        <!-- Send shortcut preference -->
        <div class="ai-settings-row">
          <label class="ai-settings-label">Send shortcut</label>
          <div class="ai-settings-radios">
            <label><input v-model="settingsSendMode" type="radio" value="enter" /> Enter to send (Shift+Enter = newline)</label>
            <label><input v-model="settingsSendMode" type="radio" value="ctrl-enter" /> Ctrl+Enter to send (Enter = newline)</label>
          </div>
        </div>

        <!-- Session usage statistics -->
        <div class="ai-stats-row">
          <span class="ai-stats-title">Session usage</span>
          <span class="ai-stats-item" title="Total input tokens across all threads">↑ {{ (sessionStats.totalIn / 1000).toFixed(1) }}k in</span>
          <span class="ai-stats-item" title="Total output tokens across all threads">↓ {{ (sessionStats.totalOut / 1000).toFixed(1) }}k out</span>
          <span v-if="sessionStats.totalCost > 0" class="ai-stats-item ai-stats-cost" title="Estimated total cost">~${{ sessionStats.totalCost < 0.001 ? '<0.001' : sessionStats.totalCost.toFixed(3) }}</span>
        </div>

        <div class="ai-settings-footer">
          <button class="ai-settings-save" @click="saveSettings">Save</button>
        </div>
      </div>
    </div>

    <!-- Keyboard shortcuts panel -->
    <div v-if="showShortcuts" class="ai-shortcuts-panel">
      <div class="ai-shortcuts-header">
        <span>Keyboard Shortcuts</span>
        <button class="ai-settings-close" @click="showShortcuts = false">✕</button>
      </div>
      <table class="ai-shortcuts-table">
        <tbody>
          <tr><td><kbd>Enter</kbd></td><td>Send message</td></tr>
          <tr><td><kbd>Shift+Enter</kbd></td><td>New line</td></tr>
          <tr><td><kbd>↑ / ↓</kbd></td><td>Browse input history</td></tr>
          <tr><td><kbd>Alt+↑ / Alt+↓</kbd></td><td>Navigate between AI messages</td></tr>
          <tr><td><kbd>Ctrl+L</kbd></td><td>Focus AI chat input</td></tr>
          <tr><td><kbd>Ctrl+N</kbd></td><td>New chat</td></tr>
          <tr><td><kbd>Ctrl+Shift+N</kbd></td><td>New chat thread (from anywhere)</td></tr>
          <tr><td><kbd>Ctrl+Shift+T</kbd></td><td>Toggle chat thread history</td></tr>
          <tr><td><kbd>Ctrl+Shift+K</kbd></td><td>Clear current conversation</td></tr>
          <tr><td><kbd>Ctrl+Shift+A</kbd></td><td>Add current file to context</td></tr>
          <tr><td><kbd>Ctrl+F</kbd></td><td>Search chat</td></tr>
          <tr><td><kbd>Ctrl+Enter</kbd></td><td>Regenerate last response (empty input)</td></tr>
          <tr><td><kbd>Cmd+/</kbd></td><td>Cycle AI model</td></tr>
          <tr><td><kbd>@</kbd></td><td>Insert context (file, selection, git, notepad…)</td></tr>
          <tr><td><kbd>/</kbd></td><td>Slash commands (/explain, /fix, /generate…)</td></tr>
          <tr><td><kbd>Escape</kbd></td><td>Stop generation · close menu · cancel Apply</td></tr>
          <tr><td>Drag file</td><td>Add file to context</td></tr>
          <tr><td>Drag/Paste image</td><td>Add screenshot as context</td></tr>
          <tr><td><kbd>Ctrl+Shift+P</kbd></td><td>Open slash command palette</td></tr>
          <tr><td><kbd>Ctrl+Shift+W</kbd></td><td>Add current file to Edit working set</td></tr>
          <tr><td><kbd>Ctrl+Shift+S</kbd></td><td>Save conversation checkpoint</td></tr>
          <tr><td><kbd>/checkpoint</kbd></td><td>Save named checkpoint</td></tr>
          <tr><td><kbd>/checkpoints</kbd></td><td>View &amp; restore checkpoints</td></tr>
        </tbody>
      </table>
    </div>

    <!-- Message right-click context menu -->
    <div v-if="msgCtxMenu" class="ai-msg-ctx-overlay" @click.self="closeMsgCtxMenu" @contextmenu.prevent>
      <div class="ai-msg-ctx-menu" :style="{ left: msgCtxMenu.x + 'px', top: msgCtxMenu.y + 'px' }">
        <button class="ai-ctx-item" @click="ctxMenuCopy">
          <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path d="M4 2a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V2Zm2-1a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V2a1 1 0 0 0-1-1H6ZM2 5a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1v-1h-1v1H2V6h1V5H2Z"/></svg>
          Copy
        </button>
        <button class="ai-ctx-item" @click="ctxMenuQuote">
          <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path d="M2.5 3a.5.5 0 0 0 0 1h11a.5.5 0 0 0 0-1h-11Zm0 4a.5.5 0 0 0 0 1h6a.5.5 0 0 0 0-1h-6Zm0 3a.5.5 0 0 0 0 1h6a.5.5 0 0 0 0-1h-6Z"/></svg>
          Quote
        </button>
        <button v-if="msgCtxMenu.role === 'user'" class="ai-ctx-item" @click="ctxMenuEdit">
          <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path d="M15.502 1.94a.5.5 0 0 1 0 .706L14.459 3.69l-2-2L13.502.646a.5.5 0 0 1 .707 0l1.293 1.293zm-1.75 2.456-2-2L4.939 9.21a.5.5 0 0 0-.121.196l-.805 2.414a.25.25 0 0 0 .316.316l2.414-.805a.5.5 0 0 0 .196-.12l6.813-6.814z"/></svg>
          Edit &amp; Resend
        </button>
        <button v-if="msgCtxMenu.role === 'assistant'" class="ai-ctx-item" @click="ctxMenuRegen">
          <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path fill-rule="evenodd" d="M8 3a5 5 0 1 0 4.546 2.914.5.5 0 0 1 .908-.417A6 6 0 1 1 8 2v1z"/><path d="M8 4.466V.534a.25.25 0 0 1 .41-.192l2.36 1.966c.12.1.12.284 0 .384L8.41 4.658A.25.25 0 0 1 8 4.466z"/></svg>
          Regenerate
        </button>
        <button v-if="msgCtxMenu.role === 'assistant'" class="ai-ctx-item" @click="ctxMenuSaveToRules">
          <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path d="M2.75 0A1.75 1.75 0 0 0 1 1.75v12.5c0 .966.784 1.75 1.75 1.75h10.5A1.75 1.75 0 0 0 15 14.25V5.06a1.75 1.75 0 0 0-.513-1.237L10.41.514A1.75 1.75 0 0 0 9.172 0H2.75zm0 1.5h6.422c.13 0 .254.051.346.143L13.57 5.66A.25.25 0 0 1 13.5 6.009V14.25a.25.25 0 0 1-.25.25H2.75a.25.25 0 0 1-.25-.25V1.75a.25.25 0 0 1 .25-.25zm5.25 5.5a.75.75 0 0 1 .75.75v1.25h1.25a.75.75 0 0 1 0 1.5H8.75v1.25a.75.75 0 0 1-1.5 0v-1.25H6a.75.75 0 0 1 0-1.5h1.25V7.75A.75.75 0 0 1 8 7z"/></svg>
          Save to AI rules
        </button>
        <button class="ai-ctx-item" @click="ctxMenuSaveToMemory">
          <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path d="M8 0a8 8 0 1 1 0 16A8 8 0 0 1 8 0zM4.5 7.5a.5.5 0 0 0 0 1h5.793l-2.147 2.146a.5.5 0 0 0 .708.708l3-3a.5.5 0 0 0 0-.708l-3-3a.5.5 0 1 0-.708.708L10.293 7.5H4.5z"/></svg>
          Save to Memory
        </button>
        <button class="ai-ctx-item" @click="ctxMenuAddToContext">
          <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path d="M8 2a.5.5 0 0 1 .5.5v5h5a.5.5 0 0 1 0 1h-5v5a.5.5 0 0 1-1 0v-5h-5a.5.5 0 0 1 0-1h5v-5A.5.5 0 0 1 8 2z"/></svg>
          Add to Context
        </button>
        <button class="ai-ctx-item" @click="ctxMenuCreateSnippet">
          <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path d="M5.854 4.854a.5.5 0 1 0-.708-.708l-3.5 3.5a.5.5 0 0 0 0 .708l3.5 3.5a.5.5 0 0 0 .708-.708L2.707 8l3.147-3.146zm4.292 0a.5.5 0 0 1 .708-.708l3.5 3.5a.5.5 0 0 1 0 .708l-3.5 3.5a.5.5 0 0 1-.708-.708L13.293 8l-3.147-3.146z"/></svg>
          Save Code as Snippet
        </button>
        <button class="ai-ctx-item" @click="ctxMenuForkThread">
          <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path fill-rule="evenodd" d="M5 3.25a.75.75 0 1 1-1.5 0 .75.75 0 0 1 1.5 0zm0 2.122a2.25 2.25 0 1 0-1.5 0v.878A2.25 2.25 0 0 0 5.75 8.5h1.5v2.128a2.251 2.251 0 1 0 1.5 0V8.5h1.5a2.25 2.25 0 0 0 2.25-2.25v-.878a2.25 2.25 0 1 0-1.5 0v.878a.75.75 0 0 1-.75.75h-4.5A.75.75 0 0 1 5 6.25v-.878zm3.75 7.378a.75.75 0 1 1-1.5 0 .75.75 0 0 1 1.5 0zm3-8.75a.75.75 0 1 1-1.5 0 .75.75 0 0 1 1.5 0z"/></svg>
          New Thread from Here
        </button>
        <button class="ai-ctx-item" @click="ctxMenuPinMsg">
          <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path d="M9.828.722a.5.5 0 0 1 .354.146l4.95 4.95a.5.5 0 0 1 0 .707c-.48.48-1.072.588-1.503.588-.177 0-.335-.018-.46-.039l-3.134 3.134a5.927 5.927 0 0 1 .16 1.013c.046.702-.032 1.687-.72 2.375a.5.5 0 0 1-.707 0l-2.829-2.828-3.182 3.182c-.195.195-1.219.902-1.414.707-.195-.195.512-1.22.707-1.414l3.182-3.182-2.828-2.829a.5.5 0 0 1 0-.707c.688-.688 1.673-.767 2.375-.72a5.922 5.922 0 0 1 1.013.16l3.134-3.133a2.772 2.772 0 0 1-.04-.461c0-.43.108-1.022.589-1.503a.5.5 0 0 1 .353-.146z"/></svg>
          {{ msgCtxMenu && messages[msgCtxMenu.mi]?.pinned ? 'Unpin Message' : 'Pin Message ⭐' }}
        </button>
        <div class="ai-ctx-sep" />
        <button class="ai-ctx-item ai-ctx-danger" @click="ctxMenuDelete">
          <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path d="M5.5 5.5A.5.5 0 0 1 6 6v6a.5.5 0 0 1-1 0V6a.5.5 0 0 1 .5-.5zm2.5 0a.5.5 0 0 1 .5.5v6a.5.5 0 0 1-1 0V6a.5.5 0 0 1 .5-.5zm3 .5a.5.5 0 0 0-1 0v6a.5.5 0 0 0 1 0V6z"/><path fill-rule="evenodd" d="M14.5 3a1 1 0 0 1-1 1H13v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V4h-.5a1 1 0 0 1-1-1V2a1 1 0 0 1 1-1H6a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1h3.5a1 1 0 0 1 1 1v1zM4.118 4 4 4.059V13a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1V4.059L11.882 4H4.118zM2.5 3V2h11v1h-11z"/></svg>
          Delete
        </button>
      </div>
    </div>

    <!-- Toast -->
    <div v-if="toastMsg" class="ai-toast">{{ toastMsg }}</div>
  </div>
</template>

<style scoped>
.ai-chat {
  display: flex;
  flex-direction: column;
  height: 100%;
  background: var(--bg-base);
  color: var(--text-bright);
  position: relative;
  overflow: hidden;
}

/* ── Messages ─────────────────────────────────────────────────────────────── */
.ai-messages {
  flex: 1;
  overflow-y: auto;
  padding: 12px 12px 8px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  scroll-behavior: smooth;
}
.ai-messages::-webkit-scrollbar { width: 6px; }
.ai-messages::-webkit-scrollbar-track { background: transparent; }
.ai-messages::-webkit-scrollbar-thumb { background: var(--border-muted); border-radius: 3px; }

.ai-empty {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  color: var(--text-muted);
  font-size: 12px;
  text-align: center;
  padding: 24px;
}
.ai-empty p { margin: 0; }
.ai-empty-title { font-size: 14px; font-weight: 600; color: var(--text-bright); }
.ai-empty-hint { font-size: 11px; opacity: 0.7; }
.ai-empty-suggestions {
  display: flex; flex-wrap: wrap; gap: 6px; justify-content: center; margin-top: 8px;
}
.ai-empty-btn {
  padding: 5px 10px; border-radius: 6px; border: 1px solid var(--border-muted);
  background: var(--bg-subtle); color: var(--text-secondary); font-size: 11.5px;
  cursor: pointer; white-space: nowrap;
}
.ai-empty-btn:hover { border-color: var(--accent-emphasis); color: var(--accent-fg); background: var(--bg-inset); }
.ai-empty-file-hint {
  display: flex; align-items: center; gap: 6px; margin-top: 10px;
  padding: 5px 10px; border-radius: 6px;
  background: var(--bg-subtle); border: 1px solid var(--border-muted);
  font-size: 11px; color: var(--text-secondary);
}
.ai-empty-file-hint code { font-size: 11px; color: var(--text-primary); }
.ai-empty-file-btn {
  margin-left: auto; padding: 2px 8px; border-radius: 4px; font-size: 10px;
  cursor: pointer; border: 1px solid var(--border-muted);
  background: transparent; color: var(--text-secondary);
}
.ai-empty-file-btn:hover { background: var(--accent-emphasis); color: var(--text-on-emphasis); border-color: var(--accent-fg); }
.ai-empty-recents { margin-top: 14px; width: 100%; max-width: 280px; }
.ai-empty-recents-label { font-size: 10px; color: var(--text-muted); text-transform: uppercase; letter-spacing: .04em; margin-bottom: 5px; }
.ai-empty-recent-item {
  display: flex; align-items: center; justify-content: space-between; gap: 6px;
  padding: 5px 8px; border-radius: 5px; cursor: pointer;
  border: 1px solid transparent; transition: background .1s, border-color .1s;
}
.ai-empty-recent-item:hover { background: var(--bg-muted); border-color: var(--border-default); }
.ai-empty-recent-title { font-size: 11.5px; color: var(--text-primary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; flex: 1; min-width: 0; }
.ai-empty-recent-meta { font-size: 10px; color: var(--text-muted); flex-shrink: 0; }

.ai-msg-wrap { display: flex; flex-direction: column; position: relative; }
.ai-msg-wrap.user { align-items: flex-end; }
.ai-msg-wrap.assistant { align-items: flex-start; }

/* Message action bar — model badge always visible; buttons hidden until hover */
.ai-msg-actions {
  display: flex;
  align-items: center;
  gap: 2px;
  margin-top: 2px;
  padding: 0 4px;
}
.ai-msg-actions.user { justify-content: flex-end; }
.ai-msg-actions.assistant { justify-content: flex-start; }
.ai-model-badge {
  font-size: 10px;
  color: var(--text-muted);
  opacity: 0.6;
  font-family: ui-monospace, Menlo, monospace;
  padding: 1px 5px;
  border: 1px solid var(--border-muted);
  border-radius: 10px;
  margin-right: 2px;
  white-space: nowrap;
}
.ai-msg-action-btn {
  opacity: 0;
  transition: opacity 0.15s;
  background: none;
  border: none;
  cursor: pointer;
  padding: 3px 5px;
  border-radius: 4px;
  color: var(--text-muted);
  display: flex;
  align-items: center;
}
.ai-msg-wrap:hover .ai-msg-action-btn { opacity: 1; }
.ai-msg-action-btn:hover {
  background: var(--bg-subtle);
  color: var(--text-bright);
}
.ai-msg-delete-btn:hover {
  background: color-mix(in srgb, var(--danger-fg) 12%, transparent);
  color: var(--danger-fg);
}
.ai-msg-time {
  font-size: 10px;
  color: var(--text-muted);
  opacity: 0;
  transition: opacity 0.15s;
  user-select: none;
}
.ai-msg-wrap:hover .ai-msg-time { opacity: 1; }
.ai-msg-elapsed { font-size: 10px; color: var(--text-muted); opacity: 0.55; user-select: none; }
.ai-msg-model-badge {
  font-size: 9.5px; font-weight: 600; letter-spacing: .02em;
  padding: 1px 5px; border-radius: 3px;
  background: var(--accent-subtle); color: var(--accent-fg);
  border: 1px solid var(--accent-muted); user-select: none;
  opacity: 0.75;
}
.ai-msg-tokens { font-size: 10px; color: var(--text-muted); opacity: 0.55; user-select: none; font-variant-numeric: tabular-nums; }
.ai-token-arc { opacity: 0.55; flex-shrink: 0; cursor: help; transition: opacity .15s; }
.ai-msg-actions:hover .ai-token-arc { opacity: 1; }
.ai-msg-tokspeed { font-size: 10px; color: var(--text-muted); opacity: 0.45; user-select: none; font-variant-numeric: tabular-nums; }
.ai-msg-ttft { font-size: 10px; color: var(--text-muted); opacity: 0.4; user-select: none; font-variant-numeric: tabular-nums; }
.ai-msg-cost {
  font-size: 9px; padding: 1px 4px; border-radius: 3px; user-select: none;
  background: color-mix(in srgb, var(--success-fg) 12%, transparent); color: var(--success-fg); font-variant-numeric: tabular-nums;
}

.ai-regen-model-wrap { position: relative; display: inline-flex; }
.ai-regen-model-btn { font-size: 10px; display: flex; align-items: center; }
.ai-regen-model-menu {
  position: absolute; bottom: calc(100% + 4px); right: 0;
  background: var(--bg-overlay); border: 1px solid var(--border-default);
  border-radius: 6px; box-shadow: 0 4px 16px rgba(0,0,0,.28);
  padding: 4px 0; min-width: 200px; z-index: 60; max-height: 280px; overflow-y: auto;
}
.ai-regen-model-item {
  display: flex; align-items: center; justify-content: space-between;
  padding: 5px 12px; font-size: 11.5px; cursor: pointer;
  color: var(--text-primary); gap: 8px;
}
.ai-regen-model-item:hover, .ai-regen-model-item.active { background: var(--accent-muted); color: var(--accent-fg); }

/* Provider badge on model bar button */
.ai-model-badge-provider {
  display: inline-flex; align-items: center; justify-content: center;
  width: 16px; height: 16px; border-radius: 3px; font-size: 9px; font-weight: 700;
  flex-shrink: 0;
}
.ai-model-badge-provider.anthropic        { background: rgba(209,92,255,0.2);  color: #d15cff; }
.ai-model-badge-provider.ollama           { background: rgba(87,171,90,0.2);   color: #57ab5a; }
.ai-model-badge-provider.openai           { background: rgba(16,185,129,0.2);  color: #10b981; font-size: 8px; width: auto; padding: 0 3px; }
.ai-model-badge-provider.groq             { background: rgba(251,146,60,0.2);  color: #fb923c; }
.ai-model-badge-provider.deepseek         { background: rgba(59,130,246,0.2);  color: #3b82f6; font-size: 8px; width: auto; padding: 0 3px; }
.ai-model-badge-provider.google           { background: rgba(234,67,53,0.2);   color: #ea4335; font-size: 8px; width: auto; padding: 0 3px; }
.ai-model-badge-provider.mistral          { background: rgba(255,115,0,0.2);   color: #ff7300; }
.ai-model-badge-provider.xai              { background: rgba(220,220,220,0.15); color: #d0d0d0; }
.ai-model-badge-provider.openai_compatible{ background: rgba(148,163,184,0.2); color: #94a3b8; }

/* Model picker grouped items */
.ai-model-picker-group {
  padding: 5px 10px 2px; font-size: 10px; font-weight: 600; letter-spacing: .04em;
  text-transform: uppercase; color: var(--text-muted); opacity: 0.7; user-select: none;
}
.ai-model-picker-name { flex: 1; font-size: 12px; }
.ai-model-picker-note { font-size: 10px; color: var(--text-muted); opacity: 0.75; white-space: nowrap; }
.ai-model-picker-sep  { height: 1px; background: var(--border-muted); margin: 4px 0; }
.ai-model-picker-custom { padding: 4px 8px 6px; }
.ai-model-picker-custom-input {
  width: 100%; box-sizing: border-box; padding: 4px 8px; font-size: 11px;
  background: var(--bg-muted); border: 1px solid var(--border-muted); border-radius: 4px;
  color: var(--text-primary); outline: none;
}
.ai-model-picker-custom-input:focus { border-color: var(--accent-emphasis); }
.ai-feedback-comment-wrap {
  display: flex; align-items: center; gap: 6px;
  padding: 4px 10px 6px; animation: fadeIn 0.15s ease;
}
.ai-feedback-comment-input {
  flex: 1; font-size: 11px; background: var(--bg-subtle); border: 1px solid var(--border-muted);
  border-radius: 4px; color: var(--text-primary); padding: 3px 7px; outline: none;
}
.ai-feedback-comment-input:focus { border-color: var(--accent-fg); }
.ai-feedback-comment-send, .ai-feedback-comment-skip {
  font-size: 10.5px; background: none; border: 1px solid var(--border-muted);
  border-radius: 3px; color: var(--text-muted); cursor: pointer; padding: 2px 7px;
}
.ai-feedback-comment-send:hover { color: var(--accent-fg); border-color: var(--accent-fg); }
.ai-feedback-comment-skip:hover { color: var(--text-primary); }
.ai-feedback-saved-note {
  font-size: 10px; color: var(--text-muted); padding: 2px 10px 6px; opacity: 0.65;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.ai-feedback-saved-icon { margin-right: 2px; }
.ai-feedback-btn { font-size: 11px; opacity: 0.3; }
.ai-feedback-btn:hover { opacity: 0.9; }
.ai-feedback-up { opacity: 1 !important; filter: none; }
.ai-feedback-down { opacity: 1 !important; filter: none; }
.ai-bookmark-active { color: var(--attention-bright) !important; opacity: 1 !important; }
.ai-bubble--pinned { outline: 1px solid color-mix(in srgb, var(--attention-bright) 35%, transparent); background: color-mix(in srgb, var(--attention-bright) 4%, transparent) !important; }
.ai-pin-badge { position: absolute; top: 4px; right: 6px; font-size: 11px; pointer-events: none; user-select: none; opacity: 0.8; }
.ai-bookmark-indicator {
  position: absolute; top: 2px; right: 4px;
  font-size: 11px; color: var(--attention-bright); pointer-events: none; user-select: none;
}
.ai-followups {
  display: flex;
  flex-direction: column;
  gap: 3px;
  padding: 4px 10px 2px;
  border-top: 1px solid var(--border-muted);
  background: var(--bg-canvas);
}
.ai-followups-inline {
  border-top: none;
  padding: 4px 14px 6px;
  background: transparent;
}
.ai-apply-all-bar {
  display: flex; align-items: center; gap: 8px;
  padding: 5px 14px; background: color-mix(in srgb, var(--accent-emphasis) 8%, transparent);
  border-top: 1px solid color-mix(in srgb, var(--accent-emphasis) 25%, transparent);
}
.ai-apply-all-label { font-size: 11px; color: var(--text-muted); flex: 1; }
.ai-apply-all-btn {
  font-size: 11.5px; padding: 3px 10px; border-radius: 4px;
  background: var(--accent-emphasis); color: var(--text-on-emphasis); border: none; cursor: pointer;
}
.ai-apply-all-btn:hover { filter: brightness(1.1); }
.ai-apply-all-dismiss {
  background: none; border: none; color: var(--text-muted); cursor: pointer; font-size: 12px; opacity: 0.6;
}
.ai-apply-all-dismiss:hover { opacity: 1; }
.ai-followup-btn {
  text-align: left;
  background: none;
  border: 1px solid var(--border-muted);
  border-radius: 5px;
  color: var(--text-secondary);
  cursor: pointer;
  font-size: 11.5px;
  padding: 4px 8px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.ai-followup-btn:hover { border-color: var(--accent-emphasis); color: var(--accent-fg); }
.ai-followup-btn::before { content: '↩ '; opacity: 0.45; font-size: 10px; }

.ai-active-tool-banner {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 12px;
  font-size: 11.5px;
  color: var(--text-secondary);
  background: var(--bg-subtle);
  border-top: 1px solid var(--border-muted);
}
.ai-active-tool-icon { font-size: 13px; }
.ai-active-tool-text { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ai-active-tool-spinner {
  width: 10px; height: 10px;
  border: 1.5px solid var(--border-muted);
  border-top-color: var(--accent-emphasis);
  border-radius: 50%;
  animation: ai-spin 0.7s linear infinite;
  flex-shrink: 0;
}

.ai-code-fold-controls {
  position: absolute; right: 36px; bottom: 8px; display: flex; gap: 2px; z-index: 4;
}
.ai-code-fold-ctrl-btn {
  background: var(--bg-overlay); border: 1px solid var(--border-muted); border-radius: 4px;
  color: var(--text-muted); cursor: pointer; font-size: 12px; padding: 2px 6px; opacity: 0.6;
}
.ai-code-fold-ctrl-btn:hover { opacity: 1; color: var(--text-primary); }
.ai-scroll-to-bottom {
  position: absolute;
  bottom: 130px;
  right: 12px;
  background: var(--bg-elevated);
  color: var(--text-bright);
  border: 1px solid var(--border-muted);
  border-radius: 50%;
  width: 28px;
  height: 28px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 13px;
  cursor: pointer;
  z-index: 10;
  box-shadow: 0 2px 8px rgba(0,0,0,0.15);
  padding: 0;
  gap: 3px;
  transition: opacity 0.15s;
}
.ai-scroll-to-bottom--live {
  border-radius: 12px;
  width: auto;
  padding: 3px 8px;
  font-size: 11px;
  background: var(--accent-emphasis);
  color: var(--text-on-emphasis);
  border-color: transparent;
}
.ai-scroll-to-bottom:hover { opacity: 0.8; }

.ai-bubble {
  max-width: 90%;
  padding: 8px 12px;
  border-radius: 10px;
  font-size: 13px;
  line-height: 1.55;
  word-break: break-word;
}
.ai-bubble.user {
  background: var(--accent-emphasis);
  color: var(--text-on-emphasis);
  border-bottom-right-radius: 3px;
}
.ai-bubble.assistant {
  background: var(--bg-subtle);
  color: var(--text-bright);
  border-bottom-left-radius: 3px;
}

.ai-date-sep {
  display: flex; align-items: center; gap: 8px; margin: 12px 8px 4px;
  color: var(--text-muted); font-size: 10px; text-transform: uppercase; letter-spacing: 0.06em;
}
.ai-date-sep::before, .ai-date-sep::after {
  content: ''; flex: 1; height: 1px; background: var(--border-muted);
}
.ai-date-sep-label { white-space: nowrap; user-select: none; }
.ai-model-sep {
  display: flex; align-items: center; gap: 8px; margin: 8px 8px 4px;
  color: var(--text-muted); font-size: 10px;
}
.ai-model-sep::before, .ai-model-sep::after {
  content: ''; flex: 1; height: 1px; background: var(--border-muted); opacity: 0.5;
}
.ai-model-sep-label { white-space: nowrap; user-select: none; opacity: 0.7; }
.ai-ctx-cutoff {
  display: flex; align-items: center; gap: 8px; margin: 6px 8px 2px;
  color: var(--warning-fg); font-size: 10px;
}
.ai-ctx-cutoff::before, .ai-ctx-cutoff::after {
  content: ''; flex: 1; height: 1px;
  background: var(--warning-fg); opacity: 0.35;
}
.ai-ctx-cutoff-label { white-space: nowrap; user-select: none; cursor: help; opacity: 0.8; }
.ai-history-palette { max-width: 620px; width: 95vw; }
.ai-history-palette-input {
  width: 100%; box-sizing: border-box; font-size: 13px;
  background: var(--bg-subtle); border: 1px solid var(--border-muted); border-radius: 4px;
  color: var(--text-primary); padding: 6px 10px; outline: none; margin: 0 0 4px;
}
.ai-history-palette-input:focus { border-color: var(--accent-fg); }
.ai-history-palette-list { overflow-y: auto; max-height: 55vh; display: flex; flex-direction: column; gap: 2px; }
.ai-history-palette-empty { font-size: 12px; color: var(--text-muted); padding: 12px; text-align: center; }
.ai-history-palette-item {
  text-align: left; font-size: 11.5px; background: none; border: none;
  color: var(--text-secondary); cursor: pointer; padding: 6px 8px; border-radius: 4px;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.ai-history-palette-item:hover { background: var(--bg-subtle); color: var(--text-primary); }
.ai-stream-tokens { font-size: 10px; color: var(--text-muted); opacity: 0.55; margin-left: 4px; user-select: none; }
.ai-text-folded { max-height: 320px; overflow: hidden; position: relative; }
.ai-text-folded::after {
  content: '';
  position: absolute;
  bottom: 0; left: 0; right: 0;
  height: 60px;
  background: linear-gradient(transparent, var(--bg-elevated));
  pointer-events: none;
}
.ai-fold-btn {
  display: block; width: 100%; padding: 4px 0; margin-top: 2px;
  font-size: 11px; color: var(--accent-fg);
  background: none; border: none; cursor: pointer; text-align: center;
}
.ai-fold-btn:hover { text-decoration: underline; }
/* Inline user-bubble editor */
.ai-bubble[class~="user"]:not(.ai-bubble--editing) { cursor: text; }
.ai-inline-edit-ta {
  width: 100%; min-height: 60px; max-height: 240px;
  padding: 6px 8px; border: 1px solid var(--accent-emphasis);
  border-radius: 4px; background: var(--bg-base); color: var(--text-bright);
  font-size: 13px; font-family: inherit; resize: vertical;
  outline: none; box-sizing: border-box;
}
.ai-inline-edit-actions { display: flex; align-items: center; gap: 6px; margin-top: 4px; }
.ai-inline-edit-hint { flex: 1; font-size: 10.5px; color: var(--text-muted); }

.ai-text :deep(.ai-code-wrap) {
  margin: 6px 0;
  border: 1px solid var(--border-muted);
  border-radius: 6px;
  overflow: hidden;
}
.ai-text :deep(.ai-code-header) {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 3px 10px;
  background: var(--bg-muted);
  border-bottom: 1px solid var(--border-muted);
}
.ai-text :deep(.ai-code-filepath) {
  font-family: ui-monospace, Menlo, monospace;
  font-size: 11px;
  color: var(--accent-fg);
  font-weight: 500;
  flex-shrink: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 200px;
  cursor: pointer;
  border-radius: 2px;
}
.ai-text :deep(.ai-code-filepath:hover) {
  text-decoration: underline; opacity: 0.85;
}
.ai-text :deep(.ai-code-lang-sm) {
  font-family: ui-monospace, Menlo, monospace;
  font-size: 10px;
  color: var(--text-muted);
  margin-left: 5px;
  opacity: 0.7;
}
.ai-text :deep(.ai-code-open-btn) {
  background: none;
  border: none;
  cursor: pointer;
  font-size: 11px;
  color: var(--text-muted);
  padding: 2px 5px;
  border-radius: 3px;
  margin-left: 2px;
  opacity: 0.7;
}
.ai-text :deep(.ai-code-open-btn:hover) {
  opacity: 1;
  background: var(--bg-subtle);
  color: var(--accent-fg);
}
.ai-text :deep(.ai-code-lang) {
  font-family: ui-monospace, Menlo, monospace;
  font-size: 10.5px;
  color: var(--text-muted);
  text-transform: lowercase;
}
.ai-text :deep(.ai-code-copy-btn) {
  background: none;
  border: none;
  cursor: pointer;
  font-size: 11px;
  color: var(--text-muted);
  padding: 2px 6px;
  border-radius: 4px;
}
.ai-text :deep(.ai-code-copy-btn:hover) {
  background: var(--bg-subtle);
  color: var(--text-bright);
}
.ai-text :deep(.ai-code-wrap-btn) {
  background: none;
  border: none;
  cursor: pointer;
  font-size: 11px;
  color: var(--text-muted);
  padding: 2px 6px;
  border-radius: 4px;
  font-family: monospace;
}
.ai-text :deep(.ai-code-wrap-btn:hover),
.ai-text :deep(.ai-code-wrap-btn.active) {
  background: var(--bg-subtle);
  color: var(--text-bright);
}
.ai-text :deep(.ai-code-revert-btn) {
  background: none;
  border: 1px solid var(--attention-fg);
  cursor: pointer;
  font-size: 11px;
  color: var(--attention-fg);
  padding: 1px 6px;
  border-radius: 4px;
  margin-left: 4px;
  opacity: 0.85;
}
.ai-text :deep(.ai-code-revert-btn:hover) { opacity: 1; background: color-mix(in srgb, var(--attention-fg) 12%, transparent); }
.ai-text :deep(.ai-code-fold-btn) {
  display: block;
  width: 100%;
  padding: 4px 10px;
  background: var(--bg-muted);
  border: none;
  border-top: 1px solid var(--border-muted);
  color: var(--text-secondary);
  cursor: pointer;
  font-size: 11px;
  text-align: left;
  letter-spacing: 0.02em;
}
.ai-text :deep(.ai-code-fold-btn:hover) { color: var(--text-bright); background: var(--bg-subtle); }
.ai-text :deep(.ai-code-save-btn) {
  background: none; border: 1px solid var(--text-muted);
  border-radius: 4px; color: var(--text-secondary);
  cursor: pointer; font-size: 11px; padding: 2px 7px; margin-left: 2px;
}
.ai-text :deep(.ai-code-save-btn:hover) { border-color: var(--text-bright); color: var(--text-bright); }
.ai-text :deep(.ai-code-run-btn) {
  background: none; border: 1px solid var(--warning-fg);
  border-radius: 4px; color: var(--warning-fg);
  cursor: pointer; font-size: 11px; padding: 2px 7px; margin-left: 2px;
}
.ai-text :deep(.ai-code-run-btn:hover) { background: var(--warning-fg); color: var(--text-on-emphasis); }
.ai-text :deep(.ai-code-run-btn:disabled) { opacity: 0.6; cursor: default; }
.ai-text :deep(.ai-code-actions) {
  display: flex; gap: 4px; padding: 3px 8px;
  background: var(--bg-muted); border-top: 1px solid var(--border-muted);
}
.ai-text :deep(.ai-code-action-btn) {
  background: none; border: none;
  color: var(--text-muted); cursor: pointer; font-size: 10.5px;
  padding: 1px 6px; border-radius: 3px; opacity: 0.65;
}
.ai-text :deep(.ai-code-action-btn:hover) {
  opacity: 1; background: var(--bg-subtle); color: var(--accent-fg);
}
.ai-text :deep(.ai-code-action-err) {
  color: var(--danger-fg) !important; opacity: 0.75 !important;
}
.ai-text :deep(.ai-code-action-err:hover) { opacity: 1 !important; }
.ai-text :deep(.ai-code-action-btn:focus-visible) {
  opacity: 1; outline: 1.5px solid var(--accent-fg); outline-offset: 1px;
}
.ai-text :deep(.ai-code-create-btn) {
  background: none;
  border: 1px solid var(--success-fg);
  border-radius: 4px;
  color: var(--success-fg);
  cursor: pointer;
  font-size: 11px;
  padding: 2px 7px;
  margin-left: 2px;
}
.ai-text :deep(.ai-code-create-btn:hover) {
  background: var(--success-fg);
  color: var(--text-on-emphasis);
}
.ai-text :deep(.ai-code-apply-btn),
.ai-text :deep(.ai-code-insert-btn) {
  background: none;
  border: 1px solid var(--accent-emphasis);
  border-radius: 4px;
  color: var(--accent-fg);
  cursor: pointer;
  font-size: 11px;
  padding: 2px 7px;
  margin-left: 2px;
}
.ai-text :deep(.ai-code-apply-btn:hover) {
  background: var(--accent-emphasis);
  color: var(--text-on-emphasis);
}
.ai-text :deep(.ai-code-insert-btn) {
  border-color: var(--success-fg);
  color: var(--success-fg);
}
.ai-text :deep(.ai-code-insert-btn:hover) {
  background: var(--success-fg);
  color: var(--text-on-emphasis);
}
.ai-text :deep(pre.ai-code-block) {
  background: var(--bg-muted);
  border-radius: 0;
  padding: 8px 10px;
  overflow-x: auto;
  font-size: 11.5px;
  margin: 0;
  font-family: ui-monospace, Menlo, 'Courier New', monospace;
  white-space: pre;
}
.ai-text :deep(code.has-line-numbers) {
  counter-reset: code-line;
}
.ai-text :deep(code.has-line-numbers .code-ln) {
  counter-increment: code-line;
  display: block;
}
.ai-text :deep(code.has-line-numbers .code-ln::before) {
  content: counter(code-line);
  display: inline-block;
  width: 2.5ch;
  margin-right: 12px;
  color: var(--text-muted);
  opacity: 0.4;
  text-align: right;
  user-select: none;
  font-size: 0.9em;
}
.ai-text :deep(code.ai-inline-code) {
  background: var(--bg-muted);
  border-radius: 3px;
  padding: 1px 4px;
  font-family: ui-monospace, Menlo, 'Courier New', monospace;
  font-size: 0.9em;
}
.ai-text :deep(a.ai-link) {
  color: var(--accent-fg);
  text-decoration: underline;
  word-break: break-all;
}
.ai-text :deep(a.ai-link:hover) { opacity: 0.8; }
.ai-text :deep(code.ai-file-ref) {
  cursor: pointer;
  color: var(--accent-fg);
  text-decoration: underline dotted;
  text-underline-offset: 2px;
}
.ai-text :deep(code.ai-file-ref:hover) { background: var(--bg-subtle); }
.ai-text :deep(code.ai-file-ref-bare) { background: transparent; padding: 0 1px; font-size: 0.9em; }
.ai-text :deep(.ai-file-ref-line) { opacity: 0.65; font-size: 0.85em; }
.ai-text :deep(ul.ai-ul),
.ai-text :deep(ol.ai-ol) {
  margin: 4px 0 4px 18px;
  padding: 0;
  line-height: 1.6;
}
.ai-text :deep(ul.ai-ul) { list-style: disc; }
.ai-text :deep(ol.ai-ol) { list-style: decimal; }
.ai-text :deep(h2.ai-h),
.ai-text :deep(h3.ai-h),
.ai-text :deep(h4.ai-h),
.ai-text :deep(h5.ai-h) {
  margin: 8px 0 2px;
  font-weight: 600;
  line-height: 1.3;
}
.ai-text :deep(h2.ai-h) { font-size: 1.1em; }
.ai-text :deep(h3.ai-h) { font-size: 1.0em; }
.ai-text :deep(h4.ai-h),
.ai-text :deep(h5.ai-h) { font-size: 0.95em; color: var(--text-secondary); }
.ai-text :deep(hr.ai-hr) {
  border: none;
  border-top: 1px solid var(--border-muted);
  margin: 8px 0;
}
.ai-text :deep(ul.ai-task-list) { list-style: none; padding-left: 4px; }
.ai-text :deep(li.ai-task-item) { display: flex; align-items: baseline; gap: 6px; }
.ai-text :deep(li.ai-task-item input[type="checkbox"]) { margin: 0; flex-shrink: 0; }
.ai-text :deep(blockquote.ai-blockquote) {
  border-left: 3px solid var(--accent-fg);
  margin: 4px 0;
  padding: 2px 10px;
  color: var(--text-secondary);
  font-style: italic;
}
.ai-text :deep(table.ai-table) {
  border-collapse: collapse;
  font-size: 12px;
  margin: 6px 0;
  max-width: 100%;
  overflow-x: auto;
  display: block;
}
.ai-text :deep(table.ai-table th),
.ai-text :deep(table.ai-table td) {
  border: 1px solid var(--border-muted);
  padding: 4px 8px;
  text-align: left;
  white-space: nowrap;
}
.ai-text :deep(table.ai-table th) {
  background: var(--surface-1);
  font-weight: 600;
}

.ai-cursor {
  display: inline-block;
  width: 2px;
  height: 1em;
  background: var(--accent-fg);
  vertical-align: text-bottom;
  animation: blink 0.9s step-end infinite;
  margin-left: 2px;
}
@keyframes blink { 50% { opacity: 0 } }

/* ── Thinking indicator ───────────────────────────────────────────────────── */
.ai-thinking {
  display: flex;
  gap: 4px;
  padding: 4px 2px;
  align-items: center;
}
.ai-thinking-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--text-muted);
  animation: ai-bounce 1.2s ease-in-out infinite;
}
.ai-thinking-dot:nth-child(2) { animation-delay: 0.2s; }
.ai-thinking-dot:nth-child(3) { animation-delay: 0.4s; }
.ai-thinking-label { font-size: 11px; color: var(--text-muted); font-style: italic; margin-left: 4px; }
@keyframes ai-bounce {
  0%, 80%, 100% { transform: scale(0.7); opacity: 0.4; }
  40% { transform: scale(1); opacity: 1; }
}

/* ── Error card ──────────────────────────────────────────────────────────── */
.ai-error-card {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 8px;
  padding: 7px 10px;
  border-radius: 6px;
  background: color-mix(in srgb, var(--danger-fg) 10%, transparent);
  border: 1px solid color-mix(in srgb, var(--danger-fg) 30%, transparent);
  color: var(--danger-fg);
  font-size: 12.5px;
}
.ai-error-msg { flex: 1; word-break: break-word; }
.ai-error-retry {
  background: var(--danger-fg);
  color: var(--text-on-emphasis);
  border: none;
  border-radius: 4px;
  padding: 3px 10px;
  font-size: 12px;
  cursor: pointer;
  flex-shrink: 0;
}
.ai-error-retry:hover { opacity: 0.85; }

/* ── Detected commit message action bar ──────────────────────────────────── */
.ai-commit-action {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 5px 10px;
  background: color-mix(in srgb, var(--accent-emphasis) 8%, transparent);
  border-top: 1px solid var(--border-muted);
  font-size: 11.5px;
}
.ai-commit-msg-preview {
  flex: 1;
  font-family: ui-monospace, Menlo, monospace;
  color: var(--text-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ai-commit-run-btn {
  display: flex;
  align-items: center;
  gap: 4px;
  background: var(--success-emphasis);
  color: var(--text-on-emphasis);
  border: none;
  border-radius: 4px;
  padding: 3px 9px;
  font-size: 11px;
  cursor: pointer;
  white-space: nowrap;
  flex-shrink: 0;
}
.ai-commit-run-btn:hover { background: var(--success-strong); }

/* ── Accept All / Reject All bar ─────────────────────────────────────────── */
.ai-bulk-actions {
  display: flex;
  gap: 6px;
  margin-top: 4px;
  padding: 0 4px;
}
.ai-bulk-btn {
  font-size: 11px;
  padding: 3px 10px;
  border-radius: 5px;
  border: 1px solid var(--border-muted);
  cursor: pointer;
  background: var(--bg-subtle);
  color: var(--text-bright);
}
.ai-bulk-btn.accept {
  background: var(--success-emphasis);
  color: var(--text-on-emphasis);
  border-color: transparent;
}
.ai-bulk-btn.discard {
  background: var(--danger-emphasis);
  color: var(--text-on-emphasis);
  border-color: transparent;
}

/* ── Tool call card ────────────────────────────────────────────────────────── */
.ai-tool-card {
  margin-top: 6px;
  border-left: 4px solid var(--accent-emphasis);
  background: var(--bg-muted);
  border-radius: 0 5px 5px 0;
  overflow: hidden;
  font-size: 11.5px;
}
.ai-tool-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 5px 9px;
  cursor: pointer;
  user-select: none;
}
.ai-tool-header:hover { background: var(--bg-subtle); }
.ai-tool-icon { font-size: 13px; flex-shrink: 0; opacity: 0.8; }
.ai-tool-name { font-family: ui-monospace, Menlo, monospace; color: var(--accent-fg); font-weight: 600; flex: 1; }
.ai-tool-toggle { color: var(--text-muted); font-size: 10px; }
.ai-tool-done { color: var(--success-strong); font-size: 11px; flex-shrink: 0; }
.ai-tool-pending { border-color: var(--accent-muted); }
@keyframes ai-spin { to { transform: rotate(360deg); } }
.ai-tool-spinner {
  display: inline-block; width: 10px; height: 10px; flex-shrink: 0;
  border: 2px solid var(--accent-muted); border-top-color: var(--accent-fg);
  border-radius: 50%; animation: ai-spin 0.7s linear infinite;
}
.ai-tool-body { padding: 0 9px 8px; }
.ai-tool-pre {
  margin: 4px 0 0;
  white-space: pre-wrap;
  word-break: break-all;
  color: var(--text-secondary);
  font-family: ui-monospace, Menlo, monospace;
  font-size: 11px;
  max-height: 160px;
  overflow-y: auto;
}
.ai-tool-result { margin-top: 6px; color: var(--text-muted); font-size: 11px; }
.ai-tool-result-label { color: var(--accent-fg); font-weight: 600; margin-right: 4px; }
.ai-tool-result-pre {
  margin: 6px 0 0;
  white-space: pre-wrap;
  word-break: break-all;
  background: var(--bg-base);
  color: var(--text-secondary);
  font-family: ui-monospace, Menlo, monospace;
  font-size: 11px;
  padding: 6px 8px;
  border-radius: 4px;
  max-height: 200px;
  overflow-y: auto;
  border: 1px solid var(--border-muted);
}
.ai-tool-param {
  margin: 4px 0 0;
  font-size: 11px;
  color: var(--text-secondary);
  word-break: break-word;
}
.ai-tool-param-label { color: var(--text-muted); margin-right: 4px; }
.ai-tool-param-val { color: var(--text-secondary); }
.ai-tool-code-inline {
  font-family: ui-monospace, Menlo, monospace;
  background: var(--bg-subtle);
  padding: 1px 5px;
  border-radius: 3px;
  font-size: 10.5px;
  color: var(--accent-fg);
}

/* ── Edit proposal card ────────────────────────────────────────────────────── */
.ai-edit-card {
  margin-top: 8px;
  border: 1px solid var(--border-muted);
  border-radius: 6px;
  overflow: hidden;
  font-size: 11.5px;
}
.ai-edit-header {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 10px;
  background: var(--bg-muted);
  border-bottom: 1px solid var(--border-muted);
  flex-wrap: wrap;
}
.ai-edit-path {
  flex: 1;
  font-family: ui-monospace, Menlo, monospace;
  color: var(--accent-fg);
  font-size: 11px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ai-edit-actions { display: flex; gap: 6px; margin-left: auto; }
.ai-edit-btn {
  padding: 3px 10px;
  border-radius: 4px;
  border: none;
  cursor: pointer;
  font-size: 11px;
  font-weight: 500;
}
.ai-edit-btn.accept { background: var(--success-emphasis); color: var(--text-on-emphasis); }
.ai-edit-btn.accept:hover { background: var(--success-strong); }
.ai-edit-btn.discard { background: var(--bg-subtle); color: var(--text-secondary); border: 1px solid var(--border-muted); }
.ai-edit-btn.discard:hover { background: var(--bg-muted); }
.ai-edit-accepted { font-size: 11px; color: var(--success-fg); margin-left: auto; }
.ai-diff-stat { font-size: 10px; margin-left: 4px; }
.diff-add-count { color: var(--success-fg); }
.diff-del-count { color: var(--danger-fg); }
.ai-diff-toggle-icon { font-size: 10px; color: var(--text-muted); margin-left: 2px; }

.ai-diff-view {
  font-family: ui-monospace, Menlo, 'Courier New', monospace;
  font-size: 11px;
  line-height: 1.5;
  overflow-x: auto;
  max-height: 240px;
  overflow-y: auto;
  background: var(--bg-base);
  padding: 6px 0;
}
.ai-diff-view :deep(.diff-add) { background: color-mix(in srgb, var(--success-strong) 15%, transparent); color: var(--success-bright); padding: 0 8px; white-space: pre; }
.ai-diff-view :deep(.diff-del) { background: color-mix(in srgb, var(--danger-fg) 15%, transparent); color: var(--danger-fg); padding: 0 8px; white-space: pre; }
.ai-diff-view :deep(.diff-hunk) { color: var(--accent-fg); background: color-mix(in srgb, var(--accent-fg) 10%, transparent); padding: 0 8px; white-space: pre; }
.ai-diff-view :deep(.diff-ctx) { color: var(--text-muted); padding: 0 8px; white-space: pre; }
.ai-text :deep(.ai-diff-view.ai-diff-inline) { max-height: 400px; border-top: 1px solid var(--border-muted); }

/* ── Command proposal card ─────────────────────────────────────────────────── */
.ai-cmd-card {
  margin-top: 8px;
  border: 1px solid var(--border-muted);
  border-left: 4px solid var(--attention-bright);
  border-radius: 0 6px 6px 0;
  overflow: hidden;
  font-size: 11.5px;
}
.ai-cmd-card.approved { border-left-color: var(--success-fg); }
.ai-cmd-card.rejected { border-left-color: var(--text-muted); opacity: 0.6; }
.ai-cmd-header {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 10px;
  background: var(--bg-muted);
  border-bottom: 1px solid var(--border-muted);
}
.ai-cmd-label { font-weight: 600; color: var(--attention-bright); flex: 1; }
.ai-cmd-card.approved .ai-cmd-label { color: var(--success-fg); }
.ai-cmd-card.rejected .ai-cmd-label { color: var(--text-muted); }
.ai-cmd-actions { display: flex; gap: 6px; }
.ai-cmd-btn {
  padding: 3px 10px;
  border-radius: 4px;
  border: none;
  cursor: pointer;
  font-size: 11px;
  font-weight: 500;
}
.ai-cmd-btn.approve { background: var(--success-emphasis); color: var(--text-on-emphasis); }
.ai-cmd-btn.approve:hover { background: var(--success-strong); }
.ai-cmd-btn.reject { background: var(--bg-subtle); color: var(--text-secondary); border: 1px solid var(--border-muted); }
.ai-cmd-btn.reject:hover { background: var(--bg-muted); }
.ai-cmd-status { font-size: 11px; }
.ai-cmd-status.approved { color: var(--success-fg); }
.ai-cmd-status.rejected { color: var(--text-muted); }
.ai-cmd-pre {
  margin: 0;
  padding: 7px 10px;
  font-family: ui-monospace, Menlo, 'Courier New', monospace;
  font-size: 11px;
  color: var(--text-secondary);
  background: var(--bg-base);
  white-space: pre-wrap;
  word-break: break-all;
}

/* ── Input area ────────────────────────────────────────────────────────────── */
.ai-input-area {
  flex-shrink: 0;
  padding: 8px 10px;
  border-top: 1px solid var(--border-muted);
  background: var(--bg-subtle);
  position: relative;
  transition: box-shadow 0.12s;
}
.ai-input-area.ai-drop-active {
  box-shadow: inset 0 0 0 2px var(--accent-emphasis);
  background: color-mix(in srgb, var(--accent-emphasis) 6%, var(--bg-subtle));
}

.ai-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin-bottom: 6px;
}
.ai-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 8px;
  border-radius: 12px;
  background: var(--accent-emphasis);
  color: var(--text-on-emphasis);
  font-size: 11px;
  font-weight: 500;
}
.ai-chip-remove {
  border: none;
  background: transparent;
  color: inherit;
  cursor: pointer;
  padding: 0;
  font-size: 13px;
  line-height: 1;
  opacity: 0.7;
}
.ai-chip-remove:hover { opacity: 1; }
.ai-chip-tokens { font-size: 9px; opacity: 0.55; margin: 0 3px 0 1px; letter-spacing: 0.02em; }
.ai-chip-icon { font-size: 10px; opacity: 0.7; margin-right: 3px; flex-shrink: 0; }
.ai-chips-meta { display: inline-flex; align-items: center; gap: 4px; margin-right: 4px; flex-shrink: 0; }
.ai-chips-total { font-size: 9px; opacity: 0.5; letter-spacing: 0.02em; color: var(--text-muted); }
.ai-chips-clear { border: 1px solid var(--border-default); background: transparent; color: var(--text-muted); border-radius: 4px; font-size: 10px; padding: 1px 5px; cursor: pointer; line-height: 1.4; }
.ai-chips-clear:hover { color: var(--danger-fg); border-color: var(--danger-fg); }
.ai-chips-warn {
  font-size: 9px; padding: 1px 5px; border-radius: 3px; letter-spacing: 0.03em; cursor: default;
  color: var(--attention-fg); background: color-mix(in srgb, var(--attention-fg) 15%, transparent); border: 1px solid color-mix(in srgb, var(--attention-fg) 30%, transparent);
}
.ai-chips-warn-critical { color: var(--danger-fg); background: color-mix(in srgb, var(--danger-fg) 15%, transparent); border-color: color-mix(in srgb, var(--danger-fg) 30%, transparent); }
.ai-chip { cursor: pointer; }
.ai-chip:hover { filter: brightness(1.15); }
.ai-chip-active { outline: 2px solid var(--overlay-ring); }
.ai-chip-image { padding: 2px 6px 2px 3px; }
.ai-chip-thumb { width: 22px; height: 16px; object-fit: cover; border-radius: 3px; vertical-align: middle; flex-shrink: 0; }
.ai-chip-popover-img { display: block; max-width: 100%; max-height: 300px; object-fit: contain; margin: 8px auto; }
.ai-chip-pinned { outline: 1.5px solid var(--overlay-ring); }
.ai-chip-dragging { opacity: 0.4; cursor: grabbing; }
.ai-chip-pin { border: none; background: transparent; color: inherit; cursor: pointer; padding: 0; font-size: 11px; line-height: 1; opacity: 0.6; }
.ai-chip-pin:hover { opacity: 1; }
.ai-chip-refresh { border: none; background: transparent; color: inherit; cursor: pointer; padding: 0; font-size: 11px; line-height: 1; opacity: 0.6; }
.ai-chip-refresh:hover { opacity: 1; }
@keyframes ai-chip-spin { to { transform: rotate(360deg); } }
.ai-chip-refreshing { display: inline-block; animation: ai-chip-spin 0.6s linear infinite; opacity: 1; }

.ai-chip-popover {
  position: absolute;
  bottom: calc(100% + 8px);
  left: 0;
  right: 0;
  background: var(--bg-subtle);
  border: 1px solid var(--border-muted);
  border-radius: 8px;
  box-shadow: 0 8px 32px rgba(0,0,0,.55);
  z-index: 12;
  overflow: hidden;
}
.ai-chip-popover-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  background: var(--bg-muted);
  border-bottom: 1px solid var(--border-muted);
  font-size: 12px;
}
.ai-chip-popover-label { font-weight: 600; color: var(--text-primary); flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ai-chip-popover-tokens { font-size: 10px; color: var(--text-muted); flex-shrink: 0; }
.ai-chip-popover-close {
  border: none; background: transparent; color: var(--text-muted);
  cursor: pointer; font-size: 16px; line-height: 1; padding: 0 2px; flex-shrink: 0;
}
.ai-chip-popover-close:hover { color: var(--text-primary); }
.ai-chip-url-link { color: var(--accent-fg); text-decoration: none; cursor: pointer; }
.ai-chip-url-link:hover { text-decoration: underline; }
.ai-chip-popover-content {
  margin: 0;
  padding: 8px 10px;
  font-family: ui-monospace, Menlo, 'Courier New', monospace;
  font-size: 11px;
  line-height: 1.5;
  color: var(--text-secondary);
  white-space: pre-wrap;
  word-break: break-all;
  max-height: 240px;
  overflow-y: auto;
}

.ai-at-menu {
  position: absolute;
  bottom: calc(100% + 4px);
  left: 10px;
  right: 10px;
  background: var(--bg-subtle);
  border: 1px solid var(--border-muted);
  border-radius: 6px;
  box-shadow: 0 8px 24px rgba(0,0,0,.45);
  overflow: hidden;
  z-index: 10;
  max-height: 200px;
  overflow-y: auto;
}
.ai-at-item {
  padding: 7px 12px;
  font-size: 12px;
  cursor: pointer;
  color: var(--text-bright);
  display: flex;
  align-items: center;
  gap: 7px;
}
.ai-at-group-header {
  padding: 4px 10px 2px;
  font-size: 9px;
  font-weight: 700;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--text-muted);
  opacity: 0.65;
  user-select: none;
  border-top: 1px solid var(--border-muted);
  margin-top: 2px;
}
.ai-at-recent-badge {
  font-size: 9px;
  color: var(--accent-fg);
  opacity: 0.65;
  margin-left: auto;
  padding-left: 4px;
  user-select: none;
}
.ai-at-group-header:first-child {
  border-top: none;
  margin-top: 0;
}
.ai-at-item:hover, .ai-at-item.active { background: var(--bg-muted); }
.ai-at-icon { font-size: 11px; opacity: 0.65; flex-shrink: 0; width: 14px; text-align: center; }
.ai-at-label-text { flex: 1; }

.ai-slash-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 12px;
}
.ai-slash-name {
  font-family: ui-monospace, Menlo, monospace;
  color: var(--accent-fg);
  font-weight: 600;
  font-size: 12px;
  min-width: 80px;
}
.ai-slash-desc {
  color: var(--text-muted);
  font-size: 11.5px;
  flex: 1;
}
.ai-slash-recent {
  flex-shrink: 0;
  font-size: 9.5px;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--accent-fg);
  opacity: 0.6;
  padding: 1px 5px;
  border: 1px solid currentColor;
  border-radius: 3px;
}

.ai-input-row {
  display: flex;
  align-items: flex-end;
  gap: 6px;
}
.ai-textarea-wrap {
  flex: 1;
  position: relative;
}
.ai-char-count {
  position: absolute;
  bottom: 5px;
  right: 8px;
  font-size: 10px;
  color: var(--text-muted);
  pointer-events: none;
  font-family: ui-monospace, monospace;
}
.ai-char-count.warn { color: var(--danger-fg); }

/* Model picker bar */
.ai-model-bar { position: relative; display: flex; align-items: center; padding: 2px 8px 0; gap: 4px; }
.ai-rules-badge {
  font-size: 10px;
  color: var(--accent-fg);
  opacity: 0.7;
  cursor: pointer;
  padding: 1px 4px;
  border-radius: 3px;
  background: color-mix(in srgb, var(--accent-emphasis) 12%, transparent);
  letter-spacing: 0.02em;
}
.ai-rules-badge:hover { opacity: 1; }
.ai-persona-badge {
  background: color-mix(in srgb, var(--done-fg) 14%, transparent);
  color: var(--done-fg);
}
.ai-model-badge-btn {
  display: flex; align-items: center; gap: 4px;
  background: none; border: 1px solid var(--border-muted); border-radius: 10px;
  padding: 2px 8px; cursor: pointer; color: var(--text-secondary); font-size: 11px;
  transition: border-color 0.15s;
}
.ai-model-badge-btn:hover { border-color: var(--accent-fg); color: var(--text-bright); }
.ai-model-badge-icon { font-size: 10px; opacity: 0.6; }
.ai-model-badge-name { max-width: 160px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ai-model-badge-caret { font-size: 8px; opacity: 0.6; }
.ai-model-picker-menu {
  position: absolute; bottom: calc(100% + 4px); left: 8px;
  background: var(--bg-overlay); border: 1px solid var(--border-muted); border-radius: 6px;
  box-shadow: 0 4px 16px rgba(0,0,0,0.3); z-index: 200; min-width: 220px; overflow: hidden;
  max-height: 380px; overflow-y: auto;
}
.ai-model-picker-search-wrap { padding: 6px 8px; border-bottom: 1px solid var(--border-muted); }
.ai-model-picker-search { width: 100%; box-sizing: border-box; background: var(--bg-muted); border: 1px solid var(--border-muted); border-radius: 4px; color: var(--text-primary); font-size: 11px; padding: 4px 7px; outline: none; }
.ai-model-picker-search:focus { border-color: var(--accent-emphasis); }
.ai-model-picker-item {
  display: flex; align-items: center; justify-content: space-between; gap: 8px;
  padding: 6px 12px; font-size: 12px; cursor: pointer; color: var(--text-secondary);
}
.ai-model-picker-item:hover { background: var(--bg-muted); color: var(--text-bright); }
.ai-model-picker-item.active { color: var(--accent-fg); font-weight: 600; }
.ai-model-badge-provider.auto { background: linear-gradient(135deg, #7c3aed, #2563eb); color: #fff; }
/* Model context size chip */
.ai-model-picker-meta { display: flex; align-items: center; gap: 4px; }
.ai-model-picker-ctx { font-size: 9px; background: var(--bg-muted); border-radius: 3px; padding: 0 4px; color: var(--text-muted); opacity: 0.8; }
.ai-model-cap-badge { font-size: 9px; opacity: 0.65; cursor: default; }
.ai-model-cap-badge.vision { opacity: 0.7; }
.ai-model-cap-badge.thinking { font-size: 10px; color: var(--accent-fg); opacity: 0.7; }
.ai-model-cap-badge.code { font-size: 8.5px; color: var(--accent-fg); opacity: 0.75; font-family: ui-monospace, monospace; }
/* Chat mode toggle (Ask / Agent) */
.ai-mode-toggle {
  padding: 2px 8px; font-size: 10px; font-weight: 600; border-radius: 10px; cursor: pointer;
  background: none; border: 1px solid var(--border-muted); color: var(--text-muted);
  transition: border-color .15s, color .15s, background .15s;
}
.ai-mode-toggle.ask   { border-color: var(--border-muted); color: var(--text-muted); }
.ai-mode-toggle.edit  { border-color: var(--warning-fg); color: var(--warning-fg); background: color-mix(in srgb, var(--warning-fg) 8%, transparent); }
.ai-mode-toggle.agent { border-color: var(--success-fg); color: var(--success-fg); background: color-mix(in srgb, var(--success-fg) 10%, transparent); }
/* Edit mode working set bar */
.ai-working-set {
  display: flex; flex-wrap: wrap; align-items: center; gap: 4px;
  padding: 4px 10px; border-bottom: 1px solid var(--border-muted); background: color-mix(in srgb, var(--warning-fg) 5%, transparent);
}
.ai-working-set-label { font-size: 10px; color: var(--warning-fg); font-weight: 600; opacity: 0.8; }
.ai-working-set-file {
  display: inline-flex; align-items: center; gap: 2px; padding: 1px 6px; font-size: 10px;
  background: color-mix(in srgb, var(--warning-fg) 15%, transparent); border: 1px solid color-mix(in srgb, var(--warning-fg) 30%, transparent); border-radius: 3px; color: var(--text-secondary);
}
.ai-working-set-remove { background: none; border: none; color: inherit; cursor: pointer; font-size: 11px; padding: 0 0 0 2px; opacity: 0.6; }
.ai-working-set-remove:hover { opacity: 1; }
.ai-working-set-add { background: none; border: 1px dashed color-mix(in srgb, var(--warning-fg) 40%, transparent); border-radius: 3px; padding: 1px 6px; font-size: 10px; color: var(--warning-fg); cursor: pointer; opacity: 0.7; }
.ai-working-set-add:hover { opacity: 1; background: color-mix(in srgb, var(--warning-fg) 10%, transparent); }
.ai-working-set-clear { background: none; border: none; font-size: 10px; color: var(--text-muted); cursor: pointer; opacity: 0.5; padding: 1px 4px; }
.ai-working-set-clear:hover { opacity: 1; color: var(--text-secondary); }
.ai-working-set-empty { font-size: 10px; color: var(--text-muted); opacity: 0.6; }

/* Context window bar */
.ai-ctx-bar {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 3px 10px;
}
.ai-ctx-bar-track {
  flex: 1;
  height: 3px;
  border-radius: 2px;
  background: var(--border-muted);
  overflow: hidden;
}
.ai-ctx-bar-fill {
  height: 100%;
  border-radius: 2px;
  background: var(--accent-emphasis);
  transition: width 0.3s ease;
}
.ai-ctx-bar.warn .ai-ctx-bar-fill { background: var(--attention-fg); }
.ai-ctx-bar.danger .ai-ctx-bar-fill { background: var(--danger-fg); }
.ai-ctx-label { font-size: 10px; color: var(--text-muted); white-space: nowrap; }
.ai-ctx-bar.warn .ai-ctx-label { color: var(--attention-fg); }
.ai-ctx-bar.danger .ai-ctx-label { color: var(--danger-fg); }
.ai-ctx-new-btn {
  margin-left: auto; padding: 1px 6px; font-size: 10px;
  background: none; border: 1px solid currentColor; border-radius: 3px;
  color: inherit; cursor: pointer; white-space: nowrap;
}
.ai-ctx-new-btn:hover { background: color-mix(in srgb, currentColor 15%, transparent); }

.ai-textarea {
  width: 100%;
  box-sizing: border-box;
  resize: none;
  min-height: 38px;
  max-height: 200px;
  overflow-y: auto;
  padding: 8px 10px;
  border-radius: 6px;
  border: 1px solid var(--border-muted);
  background: var(--bg-base);
  color: var(--text-bright);
  font-size: 12.5px;
  line-height: 1.5;
  font-family: inherit;
  outline: none;
  overflow-y: auto;
}
.ai-textarea:focus { border-color: var(--accent-emphasis); }
.ai-textarea:disabled { opacity: 0.6; }
.ai-textarea::placeholder { color: var(--text-muted); }

.ai-input-btns {
  display: flex;
  flex-direction: column;
  gap: 4px;
  flex-shrink: 0;
}
.ai-voice-btn {
  background: none;
  border: 1px solid var(--border-subtle);
  border-radius: 6px;
  color: var(--text-muted);
  cursor: pointer;
  padding: 5px 7px;
  display: flex;
  align-items: center;
  transition: background 0.15s, color 0.15s;
}
.ai-voice-btn:hover { background: var(--bg-hover); color: var(--text-bright); }
.ai-voice-active { background: color-mix(in srgb, var(--danger-emphasis) 15%, transparent) !important; color: var(--danger-fg) !important; border-color: var(--danger-fg) !important; animation: ai-voice-pulse 1.2s infinite; }
@keyframes ai-voice-pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.6; } }
.ai-send-btn, .ai-stop-btn, .ai-settings-btn {
  width: 30px;
  height: 30px;
  border-radius: 6px;
  border: none;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
}
.ai-send-btn {
  background: var(--accent-emphasis);
  color: var(--text-on-emphasis);
}
.ai-send-btn:hover:not(:disabled) { opacity: 0.85; }
.ai-send-btn:disabled { opacity: 0.4; cursor: default; }
.ai-enhance-btn {
  width: 28px; height: 28px; border-radius: 6px; border: 1px solid var(--border-muted);
  background: var(--bg-muted); color: var(--accent-fg); cursor: pointer;
  font-size: 13px; display: flex; align-items: center; justify-content: center;
  transition: background 0.12s, opacity 0.12s; flex-shrink: 0;
}
.ai-enhance-btn:hover:not(:disabled) { background: color-mix(in srgb, var(--accent-emphasis) 12%, var(--bg-muted)); }
.ai-enhance-btn:disabled { opacity: 0.5; cursor: default; }
.ai-stop-btn {
  background: var(--danger-emphasis);
  color: var(--text-on-emphasis);
}
.ai-stop-btn:hover { background: var(--danger-emphasis); }
.ai-settings-btn {
  background: var(--bg-muted);
  color: var(--text-secondary);
}
.ai-settings-btn:hover:not(:disabled) { color: var(--text-bright); }
.ai-settings-btn:disabled { opacity: 0.3; cursor: default; }

.ai-response-length-btn {
  background: var(--bg-muted);
  color: var(--text-secondary);
  border: none;
  border-radius: 3px;
  padding: 2px 5px;
  font-size: 10px;
  font-weight: 600;
  cursor: pointer;
  letter-spacing: 0.02em;
  white-space: nowrap;
  height: 22px;
}
.ai-response-length-btn:hover { color: var(--accent-fg); }

/* ── Search bar ─────────────────────────────────────────────────────────────── */
.ai-search-bar {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 5px 10px;
  border-bottom: 1px solid var(--border-muted);
  background: var(--bg-muted);
  flex-shrink: 0;
}
.ai-search-input {
  flex: 1;
  padding: 3px 7px;
  border-radius: 4px;
  border: 1px solid var(--border-muted);
  background: var(--bg-base);
  color: var(--text-bright);
  font-size: 12px;
  outline: none;
}
.ai-search-input:focus { border-color: var(--accent-emphasis); }
.ai-search-count { font-size: 11px; color: var(--text-muted); min-width: 52px; text-align: center; }
.ai-search-nav {
  background: none;
  border: 1px solid var(--border-muted);
  border-radius: 3px;
  color: var(--text-secondary);
  cursor: pointer;
  font-size: 11px;
  padding: 2px 5px;
}
.ai-search-nav:hover { color: var(--text-bright); }
.ai-search-close { background: none; border: none; cursor: pointer; color: var(--text-muted); font-size: 13px; line-height: 1; padding: 2px 4px; }
.ai-search-close:hover { color: var(--text-bright); }
.ai-msg-wrap.search-match .ai-bubble { outline: 1px solid var(--accent-emphasis); opacity: 0.7; }
.ai-msg-wrap.search-active .ai-bubble { outline: 2px solid var(--accent-emphasis); opacity: 1; }
.ai-msg-wrap[data-nav-focus="true"] .ai-bubble { outline: 2px solid var(--accent-fg); box-shadow: 0 0 0 4px color-mix(in srgb, var(--accent-fg) 12%, transparent); transition: outline 0.1s, box-shadow 0.1s; }
.ai-text :deep(mark.ai-search-highlight) {
  background: color-mix(in srgb, var(--attention-bright) 35%, transparent);
  color: inherit;
  border-radius: 2px;
  padding: 0 1px;
}
.ai-msg-wrap.search-active .ai-text :deep(mark.ai-search-highlight) {
  background: color-mix(in srgb, var(--warning-fg) 50%, transparent);
}

/* ── Global cross-thread search overlay ──────────────────────────────────── */
.ai-global-search-overlay {
  position: absolute;
  inset: 0;
  background: rgba(0,0,0,0.55);
  display: flex;
  align-items: flex-start;
  justify-content: center;
  padding-top: 60px;
  z-index: 300;
}
.ai-global-search-box {
  background: var(--bg-elevated);
  border: 1px solid var(--border-subtle);
  border-radius: 8px;
  width: min(540px, 92vw);
  max-height: 70vh;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  box-shadow: 0 8px 32px rgba(0,0,0,0.45);
}
.ai-global-search-header {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 10px 12px;
  border-bottom: 1px solid var(--border-subtle);
}
.ai-global-search-input {
  flex: 1;
  background: transparent;
  border: none;
  outline: none;
  color: var(--text-bright);
  font-size: 14px;
  font-family: inherit;
}
.ai-global-search-close {
  background: none;
  border: none;
  cursor: pointer;
  color: var(--text-muted);
  font-size: 13px;
  padding: 2px 4px;
}
.ai-global-search-close:hover { color: var(--text-bright); }
.ai-global-search-results {
  overflow-y: auto;
  flex: 1;
}
.ai-global-search-empty {
  padding: 20px;
  text-align: center;
  color: var(--text-muted);
  font-size: 13px;
}
.ai-global-search-result {
  display: flex;
  flex-direction: column;
  gap: 2px;
  width: 100%;
  text-align: left;
  background: none;
  border: none;
  border-bottom: 1px solid var(--border-subtle);
  padding: 8px 12px;
  cursor: pointer;
  color: var(--text-normal);
  font-family: inherit;
}
.ai-global-search-result:hover, .ai-global-search-result.gsr-active { background: var(--bg-hover); }
.ai-gsr-thread { font-size: 11px; font-weight: 600; color: var(--accent-emphasis); opacity: 0.85; }
.ai-gsr-role { font-size: 10px; color: var(--text-muted); margin-top: 1px; }
.ai-gsr-snippet { font-size: 12px; color: var(--text-normal); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ai-search-hl { background: var(--accent-emphasis); color: var(--text-on-emphasis); border-radius: 2px; padding: 0 1px; font-weight: 600; }
.ai-global-search-footer {
  padding: 6px 12px;
  font-size: 11px;
  color: var(--text-muted);
  border-top: 1px solid var(--border-subtle);
  min-height: 24px;
}
.ai-msg-flash { animation: ai-flash 0.4s ease 2; }
@keyframes ai-flash { 0%,100% { opacity: 1; } 50% { opacity: 0.35; } }

/* ── Extended thinking block ─────────────────────────────────────────────── */
.ai-thinking-details {
  margin: 4px 0;
  border: 1px solid var(--border-subtle);
  border-radius: 6px;
  overflow: hidden;
}
.ai-thinking-summary {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 5px 10px;
  cursor: pointer;
  font-size: 12px;
  color: var(--text-muted);
  background: var(--bg-subtle);
  list-style: none;
  user-select: none;
}
.ai-thinking-summary::marker, .ai-thinking-summary::-webkit-details-marker { display: none; }
.ai-thinking-details[open] .ai-thinking-summary { border-bottom: 1px solid var(--border-subtle); }
.ai-thinking-icon { font-size: 14px; }
.ai-thinking-tokens { margin-left: auto; font-size: 10px; opacity: 0.6; }
.ai-thinking-content {
  padding: 8px 12px;
  font-size: 12px;
  color: var(--text-muted);
  max-height: 300px;
  overflow-y: auto;
  line-height: 1.5;
}

/* ── Mermaid diagram ─────────────────────────────────────────────────────── */
.ai-mermaid-wrap { margin: 6px 0; }
.ai-mermaid {
  background: var(--bg-base);
  border: 1px solid var(--border-subtle);
  border-radius: 6px;
  padding: 12px;
  overflow-x: auto;
  text-align: center;
}
.ai-mermaid svg { max-width: 100%; height: auto; }
.ai-mermaid-loading { color: var(--text-muted); font-size: 12px; font-style: italic; }
.ai-mermaid-err { color: var(--danger-bright); font-size: 12px; }

/* ── Settings panel ────────────────────────────────────────────────────────── */
.ai-settings {
  position: absolute;
  bottom: 0;
  left: 0;
  right: 0;
  background: var(--bg-subtle);
  backdrop-filter: blur(8px);
  border-top: 1px solid var(--border-muted);
  z-index: 20;
  box-shadow: 0 -8px 24px rgba(0,0,0,.4);
}
.ai-settings-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 14px;
  font-size: 12px;
  font-weight: 600;
  color: var(--text-bright);
  border-bottom: 1px solid var(--border-muted);
}
.ai-settings-close {
  border: none;
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
  font-size: 14px;
}
.ai-settings-close:hover { color: var(--text-bright); }
.ai-settings-body { padding: 10px 14px; display: flex; flex-direction: column; gap: 10px; }
.ai-settings-row { display: flex; flex-direction: column; gap: 4px; }
.ai-settings-label { font-size: 11px; color: var(--text-muted); }
.ai-toggle-label { display: flex; align-items: center; gap: 6px; font-size: 12.5px; color: var(--text-bright); cursor: pointer; }
.ai-settings-radios {
  display: flex;
  gap: 12px;
  font-size: 12.5px;
  color: var(--text-bright);
}
.ai-settings-radios label { display: flex; align-items: center; gap: 5px; cursor: pointer; }
.ai-settings-input {
  padding: 5px 9px;
  border-radius: 5px;
  border: 1px solid var(--border-muted);
  background: var(--bg-base);
  color: var(--text-bright);
  font-size: 12.5px;
  outline: none;
}
.ai-settings-input:focus { border-color: var(--accent-emphasis); }
.ai-settings-select {
  padding: 5px 28px 5px 9px;
  border-radius: 5px;
  border: 1px solid var(--border-muted);
  background: var(--bg-base);
  color: var(--text-bright);
  font-size: 12.5px;
  outline: none;
  appearance: none;
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6' viewBox='0 0 10 6'%3E%3Cpath fill='%236e7681' d='M0 0l5 6 5-6z'/%3E%3C/svg%3E");
  background-repeat: no-repeat;
  background-position: right 9px center;
  cursor: pointer;
  width: 100%;
}
.ai-settings-select:focus { border-color: var(--accent-emphasis); }
.ai-settings-input--custom { margin-top: 5px; }
.ai-settings-row--column { flex-direction: column; }
.ai-settings-key-row { display: flex; align-items: center; gap: 6px; flex: 1; min-width: 0; }
.ai-settings-key-row .ai-settings-input { flex: 1; min-width: 0; }
.ai-settings-test-btn {
  flex-shrink: 0;
  padding: 4px 8px;
  border-radius: 4px;
  border: 1px solid var(--border-muted);
  background: transparent;
  color: var(--text-muted);
  font-size: 11px;
  cursor: pointer;
  white-space: nowrap;
}
.ai-settings-test-btn:hover:not(:disabled) { border-color: var(--accent-emphasis); color: var(--accent-fg); }
.ai-settings-test-btn:disabled { opacity: 0.5; cursor: default; }
.ai-settings-test-ok { font-size: 14px; color: var(--success-fg); flex-shrink: 0; }
.ai-settings-test-fail { font-size: 14px; color: var(--danger-fg); flex-shrink: 0; cursor: help; }
.ai-settings-test-error-row { display: flex; align-items: flex-start; gap: 6px; padding: 4px 0 2px; }
.ai-settings-test-fail-icon { color: var(--danger-fg); font-size: 12px; flex-shrink: 0; margin-top: 1px; }
.ai-settings-test-error-msg { font-size: 11px; color: var(--danger-fg); line-height: 1.4; word-break: break-word; opacity: 0.85; }
.ai-settings-textarea {
  padding: 5px 9px;
  border-radius: 5px;
  border: 1px solid var(--border-muted);
  background: var(--bg-base);
  color: var(--text-bright);
  font-size: 12.5px;
  outline: none;
  resize: vertical;
  font-family: inherit;
  line-height: 1.5;
  width: 100%;
  box-sizing: border-box;
}
.ai-settings-textarea:focus { border-color: var(--accent-emphasis); }
.ai-profile-select {
  background: var(--bg-muted);
  border: 1px solid var(--border-subtle);
  border-radius: 4px;
  color: var(--text-normal);
  font-size: 11px;
  padding: 2px 6px;
  cursor: pointer;
  outline: none;
}
.ai-profile-select:hover { border-color: var(--accent-emphasis); }
.ai-stats-row { display: flex; align-items: center; gap: 10px; padding: 8px 0 4px; border-top: 1px solid var(--border-subtle); margin-top: 6px; flex-wrap: wrap; }
.ai-stats-title { font-size: 11px; font-weight: 600; color: var(--text-muted); flex: 1; }
.ai-stats-item { font-size: 11px; color: var(--text-muted); white-space: nowrap; }
.ai-stats-cost { color: var(--accent-emphasis); }
.ai-settings-footer { display: flex; justify-content: flex-end; }
.ai-tokens-row { display: flex; align-items: center; gap: 8px; }
.ai-tokens-slider { flex: 1; accent-color: var(--accent-emphasis); }
.ai-tokens-val { font-size: 12px; color: var(--text-bright); min-width: 48px; text-align: right; }
.ai-rules-notice {
  font-size: 11px;
  color: var(--text-muted);
  gap: 5px;
  align-items: flex-start;
  flex-wrap: wrap;
}
.ai-rules-notice code { font-size: 10.5px; background: var(--bg-muted); padding: 0 3px; border-radius: 2px; }
.ai-rules-icon { color: var(--accent-fg); flex-shrink: 0; }
.ai-rules-missing { opacity: 0.8; display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.ai-create-rules-btn { flex-shrink: 0; padding: 3px 8px; border-radius: 4px; border: 1px solid var(--accent-emphasis); background: transparent; color: var(--accent-fg); font-size: 11px; cursor: pointer; white-space: nowrap; }
.ai-create-rules-btn:hover { background: var(--accent-emphasis); color: var(--text-on-emphasis); }
.ai-custom-doc-row { display: flex; align-items: center; gap: 6px; font-size: 11px; padding: 3px 0; border-bottom: 1px solid var(--border-muted); }
.ai-custom-doc-key { font-family: monospace; font-size: 10px; opacity: .8; flex-shrink: 0; }
.ai-custom-doc-label { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; opacity: .7; }
.ai-custom-doc-remove { border: none; background: transparent; color: var(--danger-fg); cursor: pointer; font-size: 13px; line-height: 1; padding: 0 2px; opacity: .7; }
.ai-custom-doc-remove:hover { opacity: 1; }
.ai-custom-doc-add { display: flex; gap: 4px; align-items: center; margin-top: 6px; flex-wrap: wrap; }
.ai-settings-save {
  padding: 5px 16px;
  background: var(--accent-emphasis);
  color: var(--text-on-emphasis);
  border: none;
  border-radius: 5px;
  cursor: pointer;
  font-size: 12px;
}
.ai-settings-save:hover { opacity: 0.85; }
.ai-settings-hint { font-size: 11px; color: var(--text-muted); }

/* ── Prompt Templates panel ─────────────────────────────────────────────── */
.ai-pt-actions {
  display: flex; align-items: center; gap: 8px; flex-wrap: wrap; padding-bottom: 6px;
  border-bottom: 1px solid var(--border-muted);
}
.ai-pt-save-btn {
  font-size: 11px; padding: 3px 10px; border-radius: 4px; cursor: pointer;
  background: var(--accent-emphasis); color: var(--text-on-emphasis); border: none; white-space: nowrap;
}
.ai-pt-save-btn:disabled { opacity: 0.4; cursor: default; }
.ai-pt-save-btn:not(:disabled):hover { filter: brightness(1.1); }
.ai-pt-list { display: flex; flex-direction: column; gap: 4px; max-height: 200px; overflow-y: auto; }
.ai-pt-item { display: flex; align-items: stretch; gap: 4px; }
.ai-pt-use {
  flex: 1; display: flex; flex-direction: column; align-items: flex-start; gap: 1px;
  padding: 6px 10px; border-radius: 5px; border: 1px solid var(--border-muted);
  background: var(--bg-muted); cursor: pointer; text-align: left; min-width: 0;
}
.ai-pt-use:hover { border-color: var(--accent-emphasis); background: var(--bg-subtle); }
.ai-pt-name { font-size: 12px; font-weight: 600; color: var(--text-bright); }
.ai-pt-preview { font-size: 11px; color: var(--text-muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 100%; }
.ai-pt-del {
  flex-shrink: 0; padding: 0 8px; border-radius: 5px; border: 1px solid var(--border-muted);
  background: var(--bg-muted); color: var(--text-muted); cursor: pointer; font-size: 12px;
}
.ai-pt-del:hover { border-color: var(--danger-emphasis); color: var(--danger-fg); }
.ai-bm-item {
  display: flex; align-items: baseline; gap: 8px; padding: 7px 10px; border-radius: 5px;
  cursor: pointer; border: 1px solid var(--border-muted); background: var(--bg-muted);
  margin-bottom: 4px;
}
.ai-bm-item:hover { border-color: var(--accent-emphasis); background: var(--bg-subtle); }
.ai-bm-role { font-size: 10px; font-weight: 700; color: var(--accent-fg); flex-shrink: 0; text-transform: uppercase; }
.ai-bm-snippet { font-size: 11px; color: var(--text-muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
.ai-cancel-btn {
  font-size: 11px; padding: 3px 8px; border-radius: 4px; cursor: pointer; margin-left: auto;
  background: var(--bg-muted); color: var(--text-muted); border: 1px solid var(--border-muted);
}
.ai-cancel-btn:hover { color: var(--danger-fg); border-color: var(--danger-emphasis); }

/* ── Toast ─────────────────────────────────────────────────────────────────── */
/* ── Shortcuts panel ─────────────────────────────────────────────────────── */
/* ── Thread list panel ────────────────────────────────────────────────────── */
.ai-panel-resize-handle {
  height: 4px;
  cursor: ns-resize;
  background: transparent;
  flex-shrink: 0;
  user-select: none;
  transition: background 0.15s;
}
.ai-panel-resize-handle:hover { background: var(--accent-emphasis); opacity: 0.5; }
.ai-msg-img-thumb {
  max-width: 200px;
  max-height: 120px;
  border-radius: 4px;
  cursor: zoom-in;
  display: block;
  margin-top: 6px;
  border: 1px solid var(--border-muted);
  object-fit: cover;
}
.ai-msg-img-thumb:hover { opacity: 0.85; }
.ai-img-zoom-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0,0,0,0.85);
  z-index: 9999;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: zoom-out;
}
.ai-img-zoom-img {
  max-width: 90vw;
  max-height: 90vh;
  border-radius: 6px;
  box-shadow: 0 8px 32px rgba(0,0,0,0.6);
  object-fit: contain;
  cursor: default;
}
.ai-img-zoom-close {
  position: absolute;
  top: 16px;
  right: 20px;
  background: var(--overlay-soft);
  border: none;
  color: var(--text-on-emphasis);
  font-size: 18px;
  cursor: pointer;
  padding: 4px 8px;
  border-radius: 4px;
}
.ai-img-zoom-close:hover { background: var(--overlay-medium); }
.ai-threads-panel {
  position: absolute;
  bottom: 0;
  left: 0;
  right: 0;
  max-height: 60%;
  background: var(--bg-subtle);
  border-top: 1px solid var(--border-muted);
  z-index: 20;
  display: flex;
  flex-direction: column;
}
.ai-threads-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 4px 10px 0;
  font-size: 12px;
  font-weight: 600;
  color: var(--text-bright);
  border-bottom: 1px solid var(--border-muted);
  flex-shrink: 0;
}
.ai-threads-tabs { display: flex; gap: 0; }
.ai-threads-tab {
  background: none; border: none; border-bottom: 2px solid transparent;
  color: var(--text-muted); cursor: pointer; font-size: 11.5px; font-weight: 500;
  padding: 6px 10px 5px; transition: color 0.1s, border-color 0.1s;
}
.ai-threads-tab:hover { color: var(--text-bright); }
.ai-threads-tab.active { color: var(--accent-fg); border-bottom-color: var(--accent-fg); }
.ai-thread-sort-wrap { display: flex; align-items: center; margin-left: auto; }
.ai-thread-sort-btn {
  background: none; border: 1px solid transparent; border-radius: 4px; color: var(--text-muted);
  cursor: pointer; display: flex; align-items: center; font-size: 10px; padding: 3px 5px;
  transition: background 0.1s, color 0.1s;
}
.ai-thread-sort-btn:hover { background: var(--bg-subtle); color: var(--text-bright); }
.ai-threads-search { padding: 6px 10px 4px; flex-shrink: 0; }
.ai-threads-empty { padding: 10px 14px; font-size: 12px; color: var(--text-muted); text-align: center; }
.ai-threads-list { overflow-y: auto; flex: 1; }
.ai-thread-item {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 7px 14px;
  cursor: pointer;
  border-bottom: 1px solid var(--border-subtle);
  transition: background 0.1s;
}
.ai-thread-main { display: flex; flex-direction: column; gap: 1px; min-width: 0; }
.ai-thread-snippet { font-size: 10px; color: var(--text-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; opacity: 0.7; }
.ai-thread-meta { display: flex; align-items: center; gap: 4px; }
.ai-thread-item:hover { background: var(--bg-muted); }
.ai-thread-item.active { background: color-mix(in srgb, var(--accent-emphasis) 12%, transparent); }
.ai-thread-title { flex: 1; font-size: 12.5px; color: var(--text-bright); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; cursor: pointer; }
.ai-thread-preview { font-size: 11px; color: var(--text-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; padding-left: 0; }
.ai-thread-group-label {
  padding: 5px 10px 2px;
  font-size: 10px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--text-muted);
  opacity: 0.6;
  user-select: none;
}
.ai-thread-rename-input { flex: 1; font-size: 12.5px; background: var(--bg-inset); border: 1px solid var(--accent-emphasis); border-radius: 3px; color: var(--text-bright); padding: 1px 4px; outline: none; min-width: 0; }
.ai-thread-count { font-size: 10px; color: var(--text-on-emphasis); background: var(--accent-muted); padding: 1px 5px; border-radius: 8px; white-space: nowrap; flex-shrink: 0; }
.ai-thread-unread { font-size: 10px; font-weight: 700; color: #fff; background: #e05252; padding: 1px 5px; border-radius: 8px; white-space: nowrap; flex-shrink: 0; animation: ai-pulse 1.5s ease-in-out infinite; }
@keyframes ai-pulse { 0%,100% { opacity:1 } 50% { opacity:0.65 } }
.ai-thread-tokens { font-size: 9px; color: var(--text-muted); background: var(--bg-muted); padding: 1px 4px; border-radius: 6px; white-space: nowrap; flex-shrink: 0; opacity: 0.7; }
.ai-thread-time { font-size: 10px; color: var(--text-muted); white-space: nowrap; }
.ai-thread-del { background: none; border: none; color: var(--text-muted); cursor: pointer; font-size: 11px; padding: 2px 4px; border-radius: 3px; flex-shrink: 0; }
.ai-thread-del:hover { color: var(--danger-fg); background: color-mix(in srgb, var(--danger-fg) 10%, transparent); }
.ai-thread-dup { background: none; border: none; color: var(--text-muted); cursor: pointer; font-size: 11px; padding: 2px 4px; border-radius: 3px; flex-shrink: 0; opacity: 0; transition: opacity 0.12s; }
.ai-thread-dup:hover { color: var(--text-bright); background: var(--bg-subtle); }
.ai-thread-color-btn {
  width: 9px; height: 9px; border-radius: 50%;
  border: 1px solid var(--border-muted);
  background: var(--bg-muted);
  cursor: pointer; flex-shrink: 0;
  opacity: 0; transition: opacity 0.12s;
  padding: 0;
}
.ai-thread-item:hover .ai-thread-color-btn,
.ai-thread-item.active .ai-thread-color-btn { opacity: 1; }
.ai-thread-color-btn:hover { border-color: var(--text-muted); transform: scale(1.2); }
/* Bulk selection */
.ai-thread-bulk-toggle { background: none; border: none; color: var(--text-muted); cursor: pointer; font-size: 14px; padding: 2px 4px; border-radius: 3px; margin-left: 4px; flex-shrink: 0; }
.ai-thread-bulk-toggle:hover, .ai-thread-bulk-toggle.active { color: var(--accent-fg); }
.ai-thread-bulk-bar { display: flex; align-items: center; gap: 6px; padding: 4px 8px; background: var(--bg-subtle); border-bottom: 1px solid var(--border-muted); font-size: 11px; }
.ai-thread-bulk-count { color: var(--text-secondary); flex: 1; }
.ai-thread-bulk-btn { font-size: 10.5px; padding: 2px 8px; border: 1px solid var(--border-muted); border-radius: 3px; background: transparent; color: var(--text-primary); cursor: pointer; }
.ai-thread-bulk-btn:hover { background: var(--bg-hover); }
.ai-thread-bulk-del { color: var(--danger-fg); border-color: color-mix(in srgb, var(--danger-fg) 40%, transparent); }
.ai-thread-bulk-del:hover { background: color-mix(in srgb, var(--danger-fg) 10%, transparent); }
.ai-thread-bulk-cancel { font-size: 10.5px; padding: 2px 6px; background: none; border: none; color: var(--text-muted); cursor: pointer; }
.ai-thread-bulk-cancel:hover { color: var(--text-primary); }
.ai-thread-checkbox { width: 12px; height: 12px; margin-right: 6px; flex-shrink: 0; cursor: pointer; accent-color: var(--accent-fg); }
.ai-thread-item.bulk-selected { background: var(--bg-subtle); }
.ai-thread-pin { background: none; border: none; color: var(--text-muted); cursor: pointer; font-size: 11px; padding: 2px 4px; border-radius: 3px; flex-shrink: 0; opacity: 0; transition: opacity 0.12s; }
.ai-thread-archive { background: none; border: none; color: var(--text-muted); cursor: pointer; font-size: 11px; padding: 2px 4px; border-radius: 3px; flex-shrink: 0; opacity: 0; transition: opacity 0.12s; }
.ai-thread-archive:hover { color: var(--text-bright); background: var(--bg-subtle); }
.ai-thread-item:hover .ai-thread-pin,
.ai-thread-item:hover .ai-thread-dup,
.ai-thread-item:hover .ai-thread-archive { opacity: 1; }
.ai-thread-pin:hover { color: var(--accent-fg); }
.ai-thread-pin-indicator { font-size: 10px; flex-shrink: 0; }
.ai-thread-label-badge { font-size: 10px; border-radius: 4px; padding: 0 4px; background: var(--bg-muted); flex-shrink: 0; }
.ai-thread-fork-badge { font-size: 9px; color: var(--accent-fg); opacity: 0.75; cursor: pointer; margin-left: 3px; white-space: nowrap; flex-shrink: 0; }
.ai-thread-fork-badge:hover { opacity: 1; text-decoration: underline; }
.ai-msg-action-btn--active { color: var(--accent-fg) !important; opacity: 1 !important; }
.ai-thread-model-badge { font-size: 9px; color: var(--text-muted); background: var(--bg-muted); border-radius: 3px; padding: 0 4px; opacity: 0.7; }
.ai-settings-btn.active { color: var(--accent-fg); }

.ai-shortcuts-panel {
  position: absolute;
  bottom: 0;
  left: 0;
  right: 0;
  background: var(--bg-subtle);
  border-top: 1px solid var(--border-muted);
  z-index: 20;
  padding: 0 0 8px;
}
.ai-shortcuts-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 8px 14px 6px;
  font-size: 12px;
  font-weight: 600;
  color: var(--text-bright);
  border-bottom: 1px solid var(--border-muted);
}
.ai-shortcuts-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 12px;
  color: var(--text-secondary);
}
.ai-shortcuts-table td { padding: 3px 14px; }
.ai-shortcuts-table td:first-child { width: 40%; }
kbd {
  display: inline-block;
  padding: 1px 5px;
  border: 1px solid var(--border-muted);
  border-radius: 3px;
  background: var(--bg-muted);
  color: var(--text-bright);
  font-size: 11px;
  font-family: monospace;
}

.ai-toast {
  position: absolute;
  bottom: 90px;
  left: 50%;
  transform: translateX(-50%);
  background: var(--bg-muted);
  border: 1px solid var(--border-muted);
  color: var(--text-bright);
  padding: 6px 14px;
  border-radius: 6px;
  font-size: 12px;
  white-space: nowrap;
  pointer-events: none;
  z-index: 30;
  box-shadow: 0 4px 16px rgba(0,0,0,.35);
}

/* ── Offline banner ─────────────────────────────────────────────────────────── */
.ai-offline-banner {
  background: color-mix(in srgb, var(--danger-fg) 15%, transparent); border-bottom: 1px solid color-mix(in srgb, var(--danger-fg) 30%, transparent);
  color: var(--danger-fg); font-size: 12px; padding: 6px 12px; text-align: center;
  flex-shrink: 0;
}

/* ── Notes textarea ─────────────────────────────────────────────────────────── */
.ai-notes-textarea {
  width: 100%; box-sizing: border-box;
  background: var(--bg-muted); border: 1px solid var(--border-default);
  border-radius: 4px; color: var(--text-primary); font-size: 12px; padding: 8px;
  resize: vertical; font-family: inherit; line-height: 1.5;
}
.ai-notes-textarea:focus { outline: none; border-color: var(--accent-fg); }
.ai-notes-has-content { color: var(--success-fg) !important; }

/* Named Notepads */
.ai-notepad-section { margin-top: 16px; }
.ai-notepad-section-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 6px; }
.ai-notepad-section-header > span { font-size: 11.5px; font-weight: 600; color: var(--text-primary); }
.ai-notepad-add-btn { background: none; border: 1px solid var(--border-default); border-radius: 4px; color: var(--text-secondary); cursor: pointer; font-size: 14px; width: 22px; height: 22px; display: flex; align-items: center; justify-content: center; }
.ai-notepad-add-btn:hover { color: var(--text-primary); border-color: var(--text-secondary); }
.ai-notepad-new-row { display: flex; gap: 6px; margin-bottom: 8px; }
.ai-notepad-new-input { flex: 1; background: var(--bg-muted); border: 1px solid var(--border-default); border-radius: 4px; color: var(--text-primary); font-size: 12px; padding: 4px 8px; outline: none; }
.ai-notepad-new-input:focus { border-color: var(--accent-fg); }
.ai-notepad-create-btn { background: var(--accent-emphasis); border: none; border-radius: 4px; color: var(--text-on-emphasis); cursor: pointer; font-size: 11.5px; padding: 4px 10px; }
.ai-notepad-create-btn:disabled { opacity: .4; cursor: default; }
.ai-notepad-item { margin-bottom: 6px; }
.ai-notepad-item-header { display: flex; align-items: center; gap: 6px; cursor: pointer; padding: 5px 8px; border-radius: 4px; background: var(--bg-muted); border: 1px solid var(--border-default); }
.ai-notepad-item-header:hover { border-color: var(--text-secondary); }
.ai-notepad-item-name { flex: 1; font-size: 12px; color: var(--text-secondary); }
.ai-notepad-item-name.active { color: var(--text-primary); font-weight: 600; }
.ai-notepad-item-tokens { font-size: 10px; color: var(--text-secondary); opacity: .7; flex-shrink: 0; }
.ai-notepad-item-del { background: none; border: none; color: var(--text-secondary); cursor: pointer; font-size: 10px; padding: 0 2px; flex-shrink: 0; }
.ai-notepad-item-del:hover { color: var(--danger-bright); }
.ai-notepad-pin-btn { background: none; border: none; cursor: pointer; font-size: 10px; padding: 0 2px; flex-shrink: 0; opacity: 0.4; }
.ai-notepad-pin-btn:hover, .ai-notepad-pin-btn.active { opacity: 1; }

/* ── Apply-code diff preview modal ──────────────────────────────────────────── */
.ai-modal-overlay {
  position: absolute; inset: 0; background: rgba(0,0,0,.55);
  display: flex; align-items: center; justify-content: center; z-index: 60;
}
.ai-modal {
  background: var(--bg-base); border: 1px solid var(--border-default);
  border-radius: 8px; min-width: 320px; max-width: 480px; width: 90%;
  box-shadow: 0 8px 32px rgba(0,0,0,.5); display: flex; flex-direction: column;
}
.ai-modal-header {
  display: flex; align-items: center; justify-content: space-between;
  padding: 12px 16px; border-bottom: 1px solid var(--border-default);
  font-size: 13px; font-weight: 600; gap: 8px;
}
.ai-modal-header code { font-size: 12px; opacity: .8; word-break: break-all; }
.ai-modal-body { padding: 16px; }
.ai-diff-stats {
  display: flex; align-items: center; gap: 8px; font-size: 13px; flex-wrap: wrap;
}
.ai-diff-old { opacity: .6; }
.ai-diff-arrow { opacity: .4; }
.ai-diff-new { font-weight: 600; }
.ai-diff-delta { font-weight: 700; padding: 1px 6px; border-radius: 4px; font-size: 12px; }
.ai-diff-delta.add { color: var(--success-fg); background: color-mix(in srgb, var(--success-fg) 15%, transparent); }
.ai-diff-delta.del { color: var(--danger-fg); background: color-mix(in srgb, var(--danger-fg) 15%, transparent); }
.ai-diff-delta.same { opacity: .5; }
.ai-modal-warning { font-size: 12px; opacity: .55; margin: 8px 0 0; }
.ai-diff-preview {
  margin-top: 10px; border: 1px solid var(--border-muted);
  border-radius: 4px; overflow: hidden; max-height: 180px; overflow-y: auto;
  font-family: var(--font-mono, monospace); font-size: 11.5px;
}
.ai-diff-ln { display: flex; gap: 6px; padding: 1px 8px; }
.ai-diff-ln.diff-add { background: color-mix(in srgb, var(--success-fg) 10%, transparent); color: var(--success-fg); }
.ai-diff-ln.diff-del { background: color-mix(in srgb, var(--danger-fg) 10%, transparent); color: var(--danger-fg); }
.ai-diff-ln.diff-ctx { color: var(--text-muted); }
.ai-diff-sign { flex-shrink: 0; width: 10px; font-weight: bold; }
.ai-diff-text { white-space: pre; overflow: hidden; text-overflow: ellipsis; }
.ai-modal-footer {
  display: flex; gap: 8px; justify-content: flex-end;
  padding: 12px 16px; border-top: 1px solid var(--border-default);
}
.ai-cancel-btn {
  padding: 5px 14px; border-radius: 4px; font-size: 12px; cursor: pointer;
  background: transparent; border: 1px solid var(--border-default);
  color: var(--text-primary);
}
.ai-cancel-btn:hover { background: var(--bg-muted); }
.ai-apply-confirm-btn {
  padding: 5px 14px; border-radius: 4px; font-size: 12px; cursor: pointer;
  background: var(--accent-emphasis); border: none; color: var(--text-on-emphasis); font-weight: 600;
}
.ai-apply-confirm-btn:hover { background: var(--accent-emphasis); }
.ai-compare-modal { max-width: 720px; width: 95vw; }
.ai-compare-diff {
  overflow-y: auto; max-height: 60vh; font-family: var(--font-mono, monospace); font-size: 11px;
  background: var(--bg-base); border-radius: 4px; padding: 8px 0;
}
.ai-modal-footer kbd {
  display: inline-block; font-family: inherit; font-size: 9px;
  background: var(--overlay-soft); border-radius: 3px;
  padding: 1px 4px; margin-left: 4px; opacity: 0.75; letter-spacing: 0;
}

/* ── Checkpoints panel ───────────────────────────────────────────── */
.ai-checkpoints-panel {
  position: absolute; top: 0; right: 0; width: 280px; height: 100%;
  background: var(--bg-elevated); border-left: 1px solid var(--border-default);
  display: flex; flex-direction: column; z-index: 20; overflow: hidden;
}
.ai-checkpoints-actions {
  padding: 8px 10px; display: flex; align-items: center; gap: 8px;
  border-bottom: 1px solid var(--border-default); flex-shrink: 0;
}
.ai-cp-save-btn {
  flex: 1; padding: 5px 8px; font-size: 11px; cursor: pointer;
  background: var(--bg-muted); border: 1px solid var(--border-default);
  color: var(--text-primary); border-radius: 4px;
}
.ai-cp-save-btn:hover { background: var(--accent-emphasis); color: var(--text-on-emphasis); border-color: var(--accent-fg); }
.ai-cp-hint { font-size: 9px; color: var(--text-muted); white-space: nowrap; }
.ai-checkpoint-item {
  display: flex; align-items: center; gap: 6px;
  padding: 8px 10px; border-bottom: 1px solid var(--border-default);
  transition: background .1s;
}
.ai-checkpoint-item:hover { background: var(--bg-muted); }
.ai-cp-info { flex: 1; min-width: 0; }
.ai-cp-name { display: block; font-size: 11px; color: var(--text-primary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ai-cp-meta { font-size: 10px; color: var(--text-muted); }
.ai-cp-btns { display: flex; gap: 4px; flex-shrink: 0; }
.ai-cp-restore-btn {
  padding: 2px 6px; font-size: 10px; cursor: pointer; border-radius: 3px;
  background: var(--accent-emphasis); border: none; color: var(--text-on-emphasis);
}
.ai-cp-restore-btn:hover { background: var(--accent-emphasis); }
.ai-cp-del-btn {
  padding: 2px 6px; font-size: 10px; cursor: pointer; border-radius: 3px;
  background: transparent; border: 1px solid var(--border-default); color: var(--text-muted);
}
.ai-cp-del-btn:hover { background: var(--danger-emphasis); color: var(--text-on-emphasis); border-color: transparent; }
.ai-cp-has { position: relative; }
.ai-cp-has::after {
  content: ''; position: absolute; top: 3px; right: 3px;
  width: 5px; height: 5px; border-radius: 50%; background: var(--success-fg);
}
/* ── Drag-over overlay ──────────────────────────────────────────── */
.ai-chat { position: relative; }
.ai-chat.ai-drag-over::after {
  content: 'Drop file to add as context';
  position: absolute; inset: 0; z-index: 50;
  background: color-mix(in srgb, var(--accent-emphasis) 15%, transparent);
  border: 2px dashed var(--accent-fg); border-radius: 6px;
  display: flex; align-items: center; justify-content: center;
  font-size: 14px; color: var(--accent-fg); pointer-events: none;
}

/* ── Message right-click context menu ──────────────────────────────────────── */
.ai-msg-ctx-overlay {
  position: fixed;
  inset: 0;
  z-index: 2000;
}
.ai-msg-ctx-menu {
  position: fixed;
  background: var(--bg-elevated);
  border: 1px solid var(--border-default);
  border-radius: 6px;
  padding: 4px;
  min-width: 154px;
  box-shadow: 0 4px 18px rgba(0,0,0,.55);
  user-select: none;
}
.ai-ctx-item {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 6px 10px;
  background: none;
  border: none;
  border-radius: 4px;
  color: var(--text-bright);
  font-size: 12px;
  text-align: left;
  cursor: pointer;
  white-space: nowrap;
}
.ai-ctx-item:hover { background: var(--bg-hover); }
.ai-ctx-sep { height: 1px; background: var(--bg-muted); margin: 3px 4px; }
.ai-ctx-danger { color: var(--danger-fg); }
.ai-ctx-danger:hover { background: color-mix(in srgb, var(--danger-fg) 14%, transparent); color: var(--danger-fg); }

/* ── Used references (Cursor-style context indicators) ──────────────────────── */
.ai-used-refs {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 4px;
  padding: 3px 10px 5px;
  opacity: 0.65;
}
.ai-used-refs:hover { opacity: 1; }
.ai-used-refs-count {
  font-size: 10px;
  color: var(--text-muted);
  margin-right: 2px;
}
.ai-used-ref-chip {
  font-size: 10px;
  background: var(--bg-base);
  border: 1px solid var(--border-default);
  border-radius: 10px;
  padding: 1px 7px;
  color: var(--text-muted);
  white-space: nowrap;
  max-width: 140px;
  overflow: hidden;
  text-overflow: ellipsis;
}
.ai-used-refs-more {
  font-size: 10px;
  color: var(--text-muted);
}

/* ── Truncated response bar ─────────────────────────────────────────────────── */
.ai-truncated-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 5px 10px;
  font-size: 11px;
  color: var(--text-muted);
  border-top: 1px solid var(--border-default);
}
.ai-truncated-label { flex: 1; }
.ai-truncated-continue-btn {
  padding: 3px 10px;
  background: var(--accent-emphasis);
  color: var(--text-on-emphasis);
  border: none;
  border-radius: 4px;
  font-size: 11px;
  cursor: pointer;
  white-space: nowrap;
}
.ai-truncated-continue-btn:hover { opacity: 0.85; }
</style>

<style>
/* highlight.js GitHub Dark theme — token colours */
.hljs { background: transparent; }
.hljs-comment,.hljs-quote { color: #8b949e; font-style: italic; }
.hljs-keyword,.hljs-selector-tag,.hljs-addition { color: #ff7b72; }
.hljs-number,.hljs-string,.hljs-meta .hljs-meta-string,.hljs-literal,.hljs-doctag,.hljs-regexp { color: #a5d6ff; }
.hljs-title,.hljs-section,.hljs-name,.hljs-selector-id,.hljs-selector-class { color: #d2a8ff; font-weight: 600; }
.hljs-attribute,.hljs-attr,.hljs-variable,.hljs-template-variable,.hljs-class .hljs-title,.hljs-type { color: #ffa657; }
.hljs-symbol,.hljs-bullet,.hljs-subst,.hljs-meta,.hljs-selector-attr,.hljs-selector-pseudo { color: #79c0ff; }
.hljs-built_in,.hljs-deletion { color: #ffa657; }
.hljs-formula { background: #161b22; }
.hljs-strong { font-weight: bold; }
.hljs-emphasis { font-style: italic; }
.hljs-tag { color: #7ee787; }
.hljs-punctuation { color: #8b949e; }
.hljs-string { color: #a5d6ff; }
.hljs-operator,.hljs-params { color: #e6edf3; }
</style>
