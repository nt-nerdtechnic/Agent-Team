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

/** One CLI pane, as Navide-Server's session directory describes it. */
interface NetworkPane {
  sessionId: string
  paneId: string
  agentKey: string
  title: string
  workspace: string
  workspacePath: string
  /** running | waiting | exited | disconnected | not-opened — or anything a newer server invents. */
  status: string
  hostOnline: boolean
}

interface NetworkDevice {
  deviceId: string
  deviceName: string
  isLocal: boolean
  online: boolean
  paneCount: number
  panes: NetworkPane[]
}

/** A device that tried to reach a pane here and was refused. */
interface AccessRequest {
  key: string
  memberId: string
  deviceId: string
  deviceName: string
  workspace: string
  paneName: string
  attempts: number
}

/** A device or member refused ahead of every rule. */
interface BlockedEntry {
  deviceId: string
  memberId: string
  deviceName: string
  reason: string
}

interface NetworkSnapshot {
  state: LinkStatus['state']
  deviceId: string
  devices: NetworkDevice[]
  /** Absent on a backend that predates the trust surface. */
  accessRequests?: AccessRequest[]
  blocked?: BlockedEntry[]
}

/** The four the server defines; anything else is shown as the server spelled it. */
// 'not-opened' is not one of the server's four: the backend substitutes it
// into this device's own rows for a pane that was restored but never opened,
// because only this machine can know that. Anything else unknown still falls
// through to the raw value below.
const KNOWN_STATUSES = ['running', 'waiting', 'exited', 'disconnected', 'not-opened']

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

/**
 * The team space as the server last described it: devices, and the CLI panes
 * on each. Null until the first answer, which is why the section reserves its
 * height rather than growing when the data lands.
 */
const network = ref<NetworkSnapshot | null>(null)
/** Set only when the machine has no server at all — a link that is merely down
 *  still answers, with the last picture the server sent. */
const networkUnavailable = ref(false)

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

/**
 * Refresh the network view.
 *
 * The backend keeps its own copy current from the server's `sessions.changed`
 * and `presence.changed` pushes — a device going offline touches no session
 * row, so both are needed and both are already subscribed to — which makes this
 * a read of a cache rather than a request to the server. So it rides the status
 * poll that is already running instead of adding a timer of its own.
 */
async function loadNetwork(): Promise<void> {
  try {
    const resp = await props.backend.send<NetworkSnapshot>('p2p.network.snapshot', {})
    if (resp.ok && resp.payload) {
      network.value = resp.payload
      networkUnavailable.value = false
    } else if (resp.error?.code === 'P2P_NOT_CONFIGURED') {
      network.value = null
      networkUnavailable.value = true
    }
  } catch {
    /* non-fatal: the section keeps the last network it was shown */
  }
}

/** Both halves of what the modal shows, on one tick of the one timer. */
async function refresh(): Promise<void> {
  await Promise.all([loadStatus(), loadNetwork()])
}

/** How a person would name the machine; the id is always there, the name is not. */
function deviceLabel(device: NetworkDevice): string {
  if (device.deviceName) return device.deviceName
  return device.deviceId.length > 12 ? `${device.deviceId.slice(0, 12)}…` : device.deviceId
}

function statusLabel(value: string): string {
  return KNOWN_STATUSES.includes(value) ? t(`settings.p2p.network.status-${value}`) : value
}

function paneCountLabel(count: number): string {
  if (count === 0) return t('settings.p2p.network.panes-none')
  if (count === 1) return t('settings.p2p.network.panes-one')
  return t('settings.p2p.network.panes', { count })
}

const devices = computed<NetworkDevice[]>(() => network.value?.devices ?? [])
const accessRequests = computed<AccessRequest[]>(() => network.value?.accessRequests ?? [])
const blocked = computed<BlockedEntry[]>(() => network.value?.blocked ?? [])

/** Which knock is mid-decision, so a double click cannot act twice. */
const deciding = ref('')

/**
 * Act on one knock, then re-read.
 *
 * Every one of these writes the policy document, and the snapshot is what the
 * section is drawn from — so the refresh is not a nicety, it is how the row
 * leaves the screen. Failures keep the row: a rule that was not written must
 * not look like one that was.
 */
async function decide(key: string, type: string, args: Record<string, unknown>): Promise<void> {
  if (deciding.value) return
  deciding.value = key
  try {
    await props.backend.send(type, args)
    await loadNetwork()
  } catch {
    /* the row stays, and the next poll shows whatever is really true */
  } finally {
    deciding.value = ''
  }
}

function approveRequest(req: AccessRequest): void {
  void decide(req.key, 'p2p.access_requests.approve', { key: req.key })
}

function dismissRequest(req: AccessRequest): void {
  void decide(req.key, 'p2p.access_requests.dismiss', { key: req.key })
}

function blockRequest(req: AccessRequest): void {
  void decide(req.key, 'p2p.trust.block', {
    deviceId: req.deviceId,
    deviceName: req.deviceName,
  })
}

function unblock(entry: BlockedEntry): void {
  void decide(entry.deviceId || entry.memberId, 'p2p.trust.unblock', {
    deviceId: entry.deviceId,
    memberId: entry.memberId,
  })
}

/** How a person recognises a blocked row: the name if the directory ever knew
 *  one, else whichever id the block was written against. */
function blockedLabel(entry: BlockedEntry): string {
  return entry.deviceName || entry.deviceId || entry.memberId
}
/** The common case for a new account, and the one a blank box would fail. */
const soloDevice = computed(() => devices.value.length === 1 && devices.value[0].isLocal)
/** The link is down, so what is on screen is the last thing the server said. */
const networkStale = computed(
  () => network.value !== null && network.value.state !== 'connected'
)

/** Turn a server error code into something a person can act on. */
/**
 * Turn a server error into something a person can act on.
 *
 * `where` matters for one code only: RATE_LIMITED now comes from two very
 * different places. Asking for another verification mail too soon is "a link
 * was just sent"; being throttled after repeated sign-in attempts is not, and
 * showing the mail sentence there would send the user looking through an inbox
 * for something nobody sent.
 */
function explain(
  error: { code?: string; message?: string; details?: Record<string, unknown> } | null | undefined,
  fallback: string,
  where: 'auth' | 'resend' = 'auth',
): string {
  const code = error?.code
  // The deployed server may predate account support, in which case it answers
  // UNKNOWN_TYPE. Showing that raw reads as "this dialog is broken".
  if (code === 'UNKNOWN_TYPE') return t('account.err-unsupported')
  if (code === 'EMAIL_TAKEN') return t('account.err-email-taken')
  if (code === 'AUTH_REJECTED') return t('account.err-rejected')
  if (code === 'LINK_OFFLINE') return t('account.err-offline')
  // The server owns the cooldown and the gate; both are answers to show, not
  // failures to retry.
  if (code === 'RATE_LIMITED') {
    if (where === 'resend') return t('settings.p2p.account.verify-rate-limited')
    // The server says how long it will keep refusing; "try again later" without
    // a number is the kind of message people retry against pointlessly.
    const seconds = Math.ceil(Number(error?.details?.retryAfterMs ?? 0) / 1000)
    return seconds > 0
      ? t('account.err-rate-limited', { seconds })
      : t('account.err-rate-limited-soon')
  }
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
      error.value = explain(resp.error, resp.error?.message ?? t('account.err-generic'))
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
    // The network belonged to the account that just left; showing its last
    // picture to whoever signs in next would be showing them someone else's
    // machines.
    network.value = null
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
      error.value = explain(resp.error, resp.error?.message ?? t('account.err-generic'), 'resend')
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
  void refresh()
  timer = setInterval(() => void refresh(), 3000)
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

        <!-- Someone knocked and was refused. Above the network on purpose:
             it is the only part of this panel that is waiting on a decision,
             and it appears only when there is one to make. -->
        <section v-if="signedIn && accessRequests.length" class="net">
          <h2 class="net-title">{{ t('settings.p2p.trust.requests-title') }}</h2>
          <div class="card net-card">
            <div v-for="req in accessRequests" :key="req.key" class="req">
              <div class="req-head">
                <span class="dev-name">{{ req.deviceName || req.deviceId }}</span>
                <span v-if="req.attempts > 1" class="dev-count">
                  {{ t('settings.p2p.trust.attempts', { count: req.attempts }) }}
                </span>
              </div>
              <p class="req-what">
                {{ t('settings.p2p.trust.wants', { workspace: req.workspace, pane: req.paneName }) }}
              </p>
              <div class="req-acts">
                <button class="btn small" :disabled="!!deciding" @click="approveRequest(req)">
                  {{ t('settings.p2p.trust.approve') }}
                </button>
                <button class="btn ghost small" :disabled="!!deciding" @click="dismissRequest(req)">
                  {{ t('settings.p2p.trust.dismiss') }}
                </button>
                <button class="btn ghost small danger" :disabled="!!deciding" @click="blockRequest(req)">
                  {{ t('settings.p2p.trust.block') }}
                </button>
              </div>
            </div>
          </div>
          <p class="hint">{{ t('settings.p2p.trust.requests-hint') }}</p>
        </section>

        <!-- Your network: the same card/kv/hint language as the account block
             above, one more section of the same panel. The box keeps its height
             whether it is waiting, empty or full, so the modal does not jump
             under the pointer when the first snapshot lands. -->
        <section v-if="signedIn" class="net">
          <h2 class="net-title">{{ t('settings.p2p.network.title') }}</h2>
          <div class="card net-card">
            <p v-if="networkUnavailable" class="hint net-note">
              {{ t('settings.p2p.network.unavailable') }}
            </p>
            <p v-else-if="!network" class="hint net-note">
              {{ t('settings.p2p.network.loading') }}
            </p>
            <template v-else>
              <div v-for="device in devices" :key="device.deviceId" class="dev">
                <div class="dev-head">
                  <span
                    class="dot"
                    :class="device.online ? 'ok' : 'idle'"
                    :title="t(device.online ? 'settings.p2p.network.device-online' : 'settings.p2p.network.device-offline')"
                  ></span>
                  <span class="dev-name">{{ deviceLabel(device) }}</span>
                  <span v-if="device.isLocal" class="dev-tag">
                    {{ t('settings.p2p.network.this-device') }}
                  </span>
                  <span class="dev-count">{{ paneCountLabel(device.paneCount) }}</span>
                </div>
                <ul v-if="device.panes.length" class="panes">
                  <li v-for="pane in device.panes" :key="pane.sessionId" class="pane">
                    <span class="pane-agent">{{ pane.agentKey || '—' }}</span>
                    <span class="pane-name">{{ pane.title }}</span>
                    <span class="pane-ws">{{ pane.workspace }}</span>
                    <span class="pane-pill" :class="'st-' + pane.status">
                      {{ statusLabel(pane.status) }}
                    </span>
                  </li>
                </ul>
                <p v-else class="hint net-note">{{ t('settings.p2p.network.no-panes') }}</p>
              </div>
            </template>
          </div>
          <!-- One machine is not an error state, and it is what every new
               account looks like — so it gets the way forward, not a blank box. -->
          <p v-if="soloDevice" class="hint">{{ t('settings.p2p.network.solo') }}</p>
          <p v-if="networkStale" class="hint">{{ t('settings.p2p.network.link-offline') }}</p>
        </section>

        <!-- Only when something is blocked: an empty list here would read as a
             feature the user has to configure, and it is the opposite — the
             absence of a block is the normal state. -->
        <section v-if="signedIn && blocked.length" class="net">
          <h2 class="net-title">{{ t('settings.p2p.trust.blocked-title') }}</h2>
          <div class="card net-card">
            <div v-for="entry in blocked" :key="entry.deviceId || entry.memberId" class="req">
              <div class="req-head">
                <span class="dev-name">{{ blockedLabel(entry) }}</span>
                <span v-if="entry.reason" class="dev-count">{{ entry.reason }}</span>
              </div>
              <div class="req-acts">
                <button class="btn ghost small" :disabled="!!deciding" @click="unblock(entry)">
                  {{ t('settings.p2p.trust.unblock') }}
                </button>
              </div>
            </div>
          </div>
          <p class="hint">{{ t('settings.p2p.trust.blocked-hint') }}</p>
        </section>

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
/* Your network. Same card, same hint, same dot as the account block above —
   only the rows inside are new. */
.net { margin-top: 18px; }
.net-title { margin: 0; font-size: 11.5px; font-weight: 500; color: var(--text-secondary); }
/* Reserved height: the section is filled by a poll, and a box that grows from
   nothing moves the sign-out button out from under the pointer. */
.net-card { min-height: 62px; padding: 10px 14px; }
.net-note { margin: 0; }
.dev + .dev { margin-top: 10px; padding-top: 10px; border-top: 1px solid var(--border-muted); }
.dev-head { display: flex; align-items: center; gap: 6px; font-size: 12px; }
/* The shared .dot carries a margin for the footer status line; here the flex gap does that job. */
.dev-head .dot { margin-right: 0; }
.dev-name { color: var(--text-bright); font-weight: 500; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dev-tag {
  padding: 1px 5px; border-radius: var(--radius-xs); font-size: var(--font-3xs);
  background: var(--bg-default); color: var(--text-secondary); flex-shrink: 0;
}
.dev-count { margin-left: auto; font-size: 11px; color: var(--text-secondary); flex-shrink: 0; }
.panes { list-style: none; margin: 6px 0 0; padding: 0; }
.pane {
  display: flex; align-items: center; gap: 8px; padding: 3px 0 3px 14px; font-size: 11.5px;
}
.pane-agent { color: var(--text-secondary); flex-shrink: 0; }
.pane-name { color: var(--text-bright); min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pane-ws {
  color: var(--text-secondary); font-size: 11px; margin-left: auto; min-width: 0;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.pane-pill {
  flex-shrink: 0; padding: 1px 6px; border-radius: var(--radius-xs); font-size: var(--font-3xs);
  border: 1px solid transparent; background: var(--bg-default); color: var(--text-secondary);
}
.pane-pill.st-running { background: var(--success-fg); color: #fff; }
.pane-pill.st-waiting { background: var(--attention-fg); color: #fff; }
.pane-pill.st-disconnected { background: none; border-color: var(--border-default); }
/* A knock is a row that owes an answer, so it gets a little more room than a
   pane line and its own separator — the same card, one step louder. */
.req { padding: 8px 0; border-bottom: 1px solid var(--border-muted); }
.req:last-child { border-bottom: none; }
.req:first-child { padding-top: 0; }
.req-head { display: flex; align-items: baseline; gap: 8px; }
.req-what { margin: 3px 0 7px; font-size: 12px; color: var(--fg-muted); }
.req-acts { display: flex; gap: 6px; }
.btn.small { padding: 2px 10px; font-size: 12px; }
.btn.ghost.small.danger { color: var(--danger-fg); }
/* Same hollow treatment as disconnected: neither pane is doing anything, and
   the eye should skip both to find the ones that are. */
.pane-pill.st-not-opened { background: none; border-color: var(--border-default); }
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
