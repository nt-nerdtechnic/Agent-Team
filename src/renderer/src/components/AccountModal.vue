<script setup lang="ts">
// Navide account modal: sign in, create an account, or paste a token.
//
// Opened from the titlebar "Sign in" button, so it is the first thing a new
// user can find without knowing Settings exists. It is an in-app overlay like
// SettingsModal rather than its own OS window: the account is app-wide, and a
// modal cannot be left behind another window or opened twice.
//
// The server address is not shown or editable: it is built into the app
// (server_link.DEFAULT_SERVER_URL). A typo'd address used to produce a link
// that silently never dialled, and there was no correct value a user could
// have discovered on their own.
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import type { useBackend } from '../composables/useBackend'

const props = defineProps<{
  open: boolean
  backend: ReturnType<typeof useBackend>
}>()
const emit = defineEmits<{
  (e: 'close'): void
  /** The stored credential changed (sign-in, sign-out, token). */
  (e: 'changed'): void
}>()

const { t } = useI18n()

interface LinkStatus {
  state: 'unconfigured' | 'connecting' | 'connected' | 'unreachable' | 'unauthorized'
  serverUrl: string
  hasToken: boolean
  detail: string
  deviceId: string
  accountEmail?: string
  tenantId?: string
  displayName?: string
  role?: string
  /** Soft gate: an unverified account works normally, it is only flagged. */
  emailVerified?: boolean
}

type Mode = 'login' | 'register' | 'token'

const mode = ref<Mode>('login')
const email = ref('')
const password = ref('')
/** Write-only: the backend never sends a stored token back. */
const token = ref('')
const busy = ref(false)
const error = ref('')
const status = ref<LinkStatus | null>(null)
/** Resend runs on its own flag so it cannot grey out sign-out beside it. */
const resending = ref(false)
const resent = ref(false)
/**
 * Whether this account still owes us a confirmed e-mail address.
 *
 * Seeded from the register/login reply so the notice is up the instant the
 * account exists, then confirmed by the status poll — but only while the link
 * is connected, because a reconnecting link reports no flag and a verified user
 * must not be told to check their mail every time the socket blinks.
 *
 * The confirming click happens in a browser this app never sees, so this only
 * clears on a reconnect or on a resend that comes back already verified.
 */
const verifyPending = ref(false)

const signedIn = computed(() => Boolean(status.value?.accountEmail))
/** Only a positive answer earns the tick; "unknown" is not "confirmed". */
const verified = computed(() => status.value?.emailVerified === true)
const state = computed(() => status.value?.state ?? 'unconfigured')
const dotClass = computed(() => {
  if (state.value === 'connected') return 'ok'
  if (state.value === 'unauthorized') return 'err'
  if (state.value === 'unreachable') return 'warn'
  return 'idle'
})

/** "Connecting" resolves on its own, so the modal keeps asking while open. */
let timer: ReturnType<typeof setInterval> | null = null

async function loadStatus(): Promise<void> {
  try {
    const resp = await props.backend.send<{ status: LinkStatus }>('p2p.link.status', {})
    if (resp.ok && resp.payload?.status) {
      status.value = resp.payload.status
      if (resp.payload.status.state === 'connected') {
        verifyPending.value = resp.payload.status.emailVerified === false
      }
    }
  } catch {
    /* non-fatal: the status line keeps its last value */
  }
}

/** Turn a server error code into something a person can act on. */
function explain(code: string | undefined, fallback: string): string {
  // The deployed server may predate account support, in which case it answers
  // UNKNOWN_TYPE. Showing that raw reads as "this dialog is broken".
  if (code === 'UNKNOWN_TYPE') return t('account.err-unsupported')
  if (code === 'EMAIL_TAKEN') return t('account.err-email-taken')
  if (code === 'AUTH_REJECTED') return t('account.err-rejected')
  if (code === 'LINK_OFFLINE') return t('account.err-offline')
  // The server owns the cooldown and the gate; both are answers to show, not
  // failures to retry.
  if (code === 'RATE_LIMITED') return t('settings.p2p.account.verify-rate-limited')
  if (code === 'EMAIL_UNVERIFIED') return t('settings.p2p.account.verify-required')
  return fallback
}

async function submit(): Promise<void> {
  if (busy.value || !canSubmit.value) return
  busy.value = true
  error.value = ''
  try {
    let resp
    if (mode.value === 'token') {
      resp = await props.backend.send<{ status: LinkStatus }>('p2p.link.configure', { token: token.value })
    } else {
      const payload: Record<string, unknown> = { email: email.value, password: password.value }
      if (mode.value === 'register') {
      }
      resp = await props.backend.send<{ status: LinkStatus; account?: { emailVerified?: boolean } }>(
        `p2p.account.${mode.value}`,
        payload
      )
    }
    if (!resp.ok) {
      error.value = explain(resp.error?.code, resp.error?.message ?? t('account.err-generic'))
      return
    }
    // The password has served its purpose the moment a token comes back.
    password.value = ''
    token.value = ''
    if (resp.payload?.status) status.value = resp.payload.status
    // A brand new account is never verified, and the mail has just gone out —
    // say so here rather than after the link has finished reconnecting.
    const account = (resp.payload as { account?: { emailVerified?: boolean } } | undefined)?.account
    if (account) { verifyPending.value = account.emailVerified !== true; resent.value = false }
    emit('changed')
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
  } finally {
    busy.value = false
  }
}

async function signOut(): Promise<void> {
  if (busy.value) return
  busy.value = true
  error.value = ''
  try {
    // A pasted token has no account to log out of; clearing it is the same act.
    const resp = signedIn.value
      ? await props.backend.send<{ status: LinkStatus }>('p2p.account.logout', {})
      : await props.backend.send<{ status: LinkStatus }>('p2p.link.configure', { token: '' })
    if (!resp.ok) {
      error.value = resp.error?.message ?? t('account.err-generic')
      return
    }
    mode.value = 'login'
    verifyPending.value = false
    resent.value = false
    if (resp.payload?.status) status.value = resp.payload.status
    emit('changed')
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
  } finally {
    busy.value = false
  }
}

async function resendVerification(): Promise<void> {
  if (resending.value) return
  resending.value = true
  error.value = ''
  resent.value = false
  try {
    const resp = await props.backend.send<{ emailVerified: boolean; status?: LinkStatus }>(
      'p2p.account.resend_verification',
      {}
    )
    if (!resp.ok) {
      error.value = explain(resp.error?.code, resp.error?.message ?? t('account.err-generic'))
      return
    }
    if (resp.payload?.status) status.value = resp.payload.status
    // Already confirmed in a browser since this link signed in: no mail was
    // sent and there is nothing left to nag about.
    if (resp.payload?.emailVerified) verifyPending.value = false
    else resent.value = true
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
  } finally {
    resending.value = false
  }
}

const canSubmit = computed(() => {
  if (busy.value) return false
  if (mode.value === 'token') return token.value.trim() !== ''
  return email.value.trim() !== '' && password.value !== ''
})

/** Holding a hand-pasted token: linked, but with no account to show. */
const tokenOnly = computed(() => !signedIn.value && Boolean(status.value?.hasToken))

function onKeyDown(e: KeyboardEvent): void {
  if (e.key === 'Escape' && props.open) emit('close')
}

function startPolling(): void {
  stopPolling()
  void loadStatus()
  timer = setInterval(() => void loadStatus(), 3000)
}
function stopPolling(): void {
  if (timer) { clearInterval(timer); timer = null }
}

watch(() => props.open, (open) => {
  if (open) { error.value = ''; resent.value = false; startPolling() } else stopPolling()
})

onMounted(() => {
  window.addEventListener('keydown', onKeyDown)
  if (props.open) startPolling()
})
onUnmounted(() => {
  window.removeEventListener('keydown', onKeyDown)
  stopPolling()
})
</script>

<template>
  <div v-if="open" class="s-overlay nv-modal-overlay acct-overlay" @click.self="emit('close')">
    <div class="acct-modal nv-modal-shell" role="dialog" aria-modal="true" :aria-label="t('account.title')">
      <button class="s-close" @click="emit('close')" title="Close (ESC)">✕</button>

      <header class="acct-head">
        <h1 class="acct-title">{{ t('account.title') }}</h1>
        <p class="tagline">{{ t('account.tagline') }}</p>
      </header>

      <!-- Signed in: the credential belongs to the server, so this side only
           shows which account it is and offers to let go of it. -->
      <section v-if="signedIn || tokenOnly" class="body">
        <div class="card">
          <template v-if="signedIn">
            <div class="kv">
              <span>{{ t('settings.p2p.account.email') }}</span>
              <span>
                {{ status?.accountEmail }}
                <span v-if="verified" class="tick" :title="t('settings.p2p.account.verified')">✓</span>
              </span>
            </div>
            <div v-if="status?.displayName" class="kv">
              <span>{{ t('settings.p2p.account.display-name') }}</span><span>{{ status.displayName }}</span>
            </div>
            <div v-if="status?.role" class="kv">
              <span>{{ t('settings.p2p.account.role') }}</span><span>{{ status.role }}</span>
            </div>
            <div v-if="status?.tenantId" class="kv">
              <span>{{ t('settings.p2p.account.tenant') }}</span><span class="mono">{{ status.tenantId }}</span>
            </div>
          </template>
          <div v-else class="kv">
            <span>{{ t('settings.p2p.token') }}</span><span>{{ t('account.token-stored') }}</span>
          </div>
          <div v-if="status?.deviceId" class="kv">
            <span>{{ t('settings.p2p.device-id') }}</span><span class="mono">{{ status.deviceId }}</span>
          </div>
        </div>
        <!-- Soft gate: nothing here is blocked while unverified, so this is a
             notice with a way to act on it, not a wall. -->
        <div v-if="signedIn && verifyPending" class="verify">
          <p class="hint">{{ t('settings.p2p.account.verify-sent', { email: status?.accountEmail }) }}</p>
          <button class="btn ghost small" :disabled="resending" @click="resendVerification">
            {{ t('settings.p2p.account.verify-resend') }}
          </button>
        </div>
        <p v-if="resent" class="hint">{{ t('settings.p2p.account.verify-resent') }}</p>
        <button class="btn ghost wide" :disabled="busy" @click="signOut">
          {{ t('settings.p2p.account.sign-out') }}
        </button>
      </section>

      <section v-else class="body">
        <div class="tabs" role="tablist">
          <button
            v-for="m in (['login', 'register', 'token'] as const)"
            :key="m"
            type="button"
            role="tab"
            class="tab"
            :class="{ on: mode === m }"
            :aria-selected="mode === m"
            :disabled="busy"
            @click="mode = m; error = ''"
          >
            {{ t('settings.p2p.account.tab-' + m) }}
          </button>
        </div>

        <template v-if="mode === 'token'">
          <!-- Pasting a token directly: kept for machines that have no
               account to sign in with (CI, servers). -->
          <label class="lbl" for="acct-token">{{ t('settings.p2p.token') }}</label>
          <input
            id="acct-token"
            v-model="token"
            type="password"
            spellcheck="false"
            autocomplete="off"
            :disabled="busy"
            :placeholder="t('settings.p2p.token-placeholder')"
            @keyup.enter="submit"
          />
          <p class="hint">{{ t('settings.p2p.token-hint') }}</p>
        </template>

        <template v-else>
          <label class="lbl" for="acct-email">{{ t('settings.p2p.account.email') }}</label>
          <input
            id="acct-email"
            v-model="email"
            type="email"
            autocomplete="username"
            spellcheck="false"
            :disabled="busy"
            placeholder="you@example.com"
          />

          <label class="lbl" for="acct-password">{{ t('settings.p2p.account.password') }}</label>
          <input
            id="acct-password"
            v-model="password"
            type="password"
            :autocomplete="mode === 'register' ? 'new-password' : 'current-password'"
            spellcheck="false"
            :disabled="busy"
            :placeholder="t('settings.p2p.account.password-placeholder')"
            @keyup.enter="submit"
          />

          <!-- Display name and network name are not asked for: the server derives
               both from the email (see accounts.ts), and nothing about them can be
               changed later anyway, so a field here would only be a decision the
               user cannot revisit. -->
          <p v-if="mode === 'register'" class="hint">{{ t('settings.p2p.account.tenant-hint') }}</p>
        </template>

        <button class="btn wide" :disabled="!canSubmit" @click="submit">
          {{ t('settings.p2p.account.submit-' + mode) }}
        </button>
        <p v-if="mode === 'register'" class="hint">{{ t('account.no-recovery') }}</p>
      </section>

      <footer class="acct-foot">
        <p class="status"><span class="dot" :class="dotClass"></span>{{ t('settings.p2p.state-' + state) }}</p>
        <p v-if="status?.detail" class="detail">{{ status.detail }}</p>
        <p v-if="error" class="err">{{ error }}</p>
      </footer>
    </div>
  </div>
</template>

<style scoped>
/* Overlay and shell mirror SettingsModal's .s-overlay / .s-modal so the two
   dialogs read as one family; only the panel is narrower. */
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
.acct-modal {
  position: relative;
  background: var(--bg-base);
  color: var(--text-bright);
  border: 1px solid var(--border-muted);
  border-radius: var(--radius-lg);
  width: min(440px, 92vw);
  max-height: 88vh;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  box-shadow: var(--shadow-modal);
  font-size: 13px;
  line-height: 1.6;
}
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
.acct-head { padding: 22px 28px 10px; }
.acct-title { margin: 0; font-size: 17px; font-weight: 600; color: var(--text-bright); }
.tagline { margin: 4px 0 0; font-size: 12px; color: var(--text-secondary); }
.body { padding: 4px 28px 0; overflow-y: auto; }
.tabs { display: flex; gap: 2px; margin: 0 0 12px; border-bottom: 1px solid var(--border-default); }
.tab {
  appearance: none; background: none; border: 0; border-bottom: 2px solid transparent;
  padding: 7px 12px; font-size: 12.5px; color: var(--text-secondary); cursor: pointer;
}
.tab.on { color: var(--text-bright); border-bottom-color: var(--accent-emphasis); font-weight: 500; }
.tab:disabled { opacity: 0.5; cursor: default; }
.lbl { display: block; font-size: 11.5px; color: var(--text-secondary); margin: 12px 0 5px; }
input {
  width: 100%; box-sizing: border-box;
  background: var(--bg-inset); border: 1px solid var(--border-default);
  border-radius: 6px; padding: 8px 10px; color: inherit; font: inherit; font-size: 12.5px;
}
input:focus {
  outline: none; border-color: var(--accent-emphasis);
  box-shadow: 0 0 0 2px var(--accent-focus, rgba(31, 111, 235, 0.3));
}
.btn {
  appearance: none; border-radius: 6px; padding: 9px 16px; font: inherit; font-size: 12.5px;
  font-weight: 500; cursor: pointer;
  background: var(--accent-emphasis); border: 1px solid var(--accent-emphasis); color: #fff;
}
.btn.ghost { background: transparent; border-color: var(--border-default); color: inherit; }
.btn.wide { display: block; width: 100%; margin-top: 18px; }
.btn:disabled { opacity: 0.5; cursor: default; }
.card {
  border: 1px solid var(--border-default); border-radius: 8px; padding: 4px 14px; margin-top: 8px;
}
.kv {
  display: flex; justify-content: space-between; gap: 12px; font-size: 12px;
  padding: 7px 0; border-bottom: 1px solid var(--border-muted);
}
.kv:last-child { border-bottom: 0; }
.kv span:first-child { color: var(--text-secondary); flex-shrink: 0; }
.mono { font-family: ui-monospace, Menlo, monospace; font-size: 11px; word-break: break-all; }
.hint { margin: 8px 0 0; font-size: 11.5px; color: var(--text-secondary); }
.verify { display: flex; align-items: center; gap: 10px; margin-top: 10px; }
.verify .hint { margin: 0; flex: 1; }
.btn.small { padding: 5px 11px; font-size: 11.5px; flex-shrink: 0; }
.tick { color: var(--success-fg); margin-left: 5px; }
.acct-foot { padding: 14px 28px 18px; margin-top: 14px; border-top: 1px solid var(--border-muted); }
.status { display: flex; align-items: center; margin: 0; font-size: 11.5px; color: var(--text-secondary); }
.dot { display: inline-block; width: 7px; height: 7px; border-radius: 50%; margin-right: 7px; flex-shrink: 0; }
.dot.ok { background: var(--success-fg); }
.dot.err { background: var(--danger-fg); }
.dot.warn { background: var(--attention-fg); }
.dot.idle { background: var(--text-secondary); }
.detail { margin: 4px 0 0; font-size: var(--font-2xs); color: var(--text-secondary); word-break: break-all; }
.err { margin: 8px 0 0; font-size: 11.5px; color: var(--danger-fg); }
</style>
