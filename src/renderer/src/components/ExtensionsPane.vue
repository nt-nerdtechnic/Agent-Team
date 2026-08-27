<script setup lang="ts">
// Extensions view (minimal): lists installed plugins with their trust/capability
// badges and lets the user search the marketplace and install. Sensitive
// capabilities and native backend executables trigger the existing confirmation
// dialog after verification but before the package is written.
//
// All privileged work is brokered through the main process via
// `window.agentTeam.plugins`; this component holds no secrets and never touches
// package bytes.
import { computed, ref, onMounted } from 'vue'

const plugins = window.agentTeam?.plugins

const installed = ref<InstalledPluginSummary[]>([])
const factoryPackages = ref<FactoryPluginSummary[]>([])
const nonFactoryInstalled = computed(() =>
  installed.value.filter((plugin) => plugin.provenance !== 'factory-bundled')
)
const results = ref<MarketplaceExtension[]>([])
const query = ref('')
const busy = ref(false)
const error = ref('')
// A prepared, verified install awaiting the existing install-risk confirmation.
const pendingConfirm = ref<{ ext: MarketplaceExtension; prepared: PreparedInstallSummary } | null>(
  null
)
const pendingStep = ref<'publisher' | 'risk' | null>(null)
const publisherConfirmed = ref(false)

async function refreshInstalled(): Promise<void> {
  if (!plugins) return
  ;[installed.value, factoryPackages.value] = await Promise.all([
    plugins.listInstalled(),
    plugins.listFactoryPackages(),
  ])
}

async function search(): Promise<void> {
  if (!plugins) return
  busy.value = true
  error.value = ''
  try {
    const res = await plugins.marketplaceSearch(query.value || undefined)
    results.value = res.items
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
  } finally {
    busy.value = false
  }
}

async function install(ext: MarketplaceExtension): Promise<void> {
  if (!plugins) return
  busy.value = true
  error.value = ''
  try {
    const prepared = await plugins.prepareInstall({ namespace: ext.namespace, name: ext.name })
    const requiresPublisherTrust = prepared.requiresPublisherTrust === true
    const requiresRiskConfirmation =
      prepared.requiresRiskConfirmation ?? prepared.requiresConfirmation
    if (requiresPublisherTrust || requiresRiskConfirmation) {
      // Hold for the trust dialog — nothing is written until the user confirms.
      pendingConfirm.value = { ext, prepared }
      pendingStep.value = requiresPublisherTrust ? 'publisher' : 'risk'
      publisherConfirmed.value = false
      return
    }
    await commit(prepared.id, {})
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
  } finally {
    busy.value = false
  }
}

async function commit(
  id: string,
  approval: { publisherConfirmed?: boolean; riskConfirmed?: boolean }
): Promise<void> {
  if (!plugins) return
  await plugins.commitInstall(id, approval)
  pendingConfirm.value = null
  pendingStep.value = null
  await refreshInstalled()
}

async function confirmPublisher(): Promise<void> {
  if (!pendingConfirm.value) return
  publisherConfirmed.value = true
  if (
    pendingConfirm.value.prepared.requiresRiskConfirmation ??
    pendingConfirm.value.prepared.requiresConfirmation
  ) {
    pendingStep.value = 'risk'
    return
  }
  busy.value = true
  try {
    await commit(pendingConfirm.value.prepared.id, { publisherConfirmed: true })
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
  } finally {
    busy.value = false
  }
}

async function confirmRisk(): Promise<void> {
  if (!pendingConfirm.value) return
  busy.value = true
  try {
    await commit(pendingConfirm.value.prepared.id, {
      publisherConfirmed: publisherConfirmed.value,
      riskConfirmed: true,
    })
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
  } finally {
    busy.value = false
  }
}

function cancelInstall(): void {
  pendingConfirm.value = null
  pendingStep.value = null
  publisherConfirmed.value = false
}

async function remove(id: string): Promise<void> {
  if (!plugins) return
  await plugins.remove(id)
  await refreshInstalled()
}

async function restoreFactoryPackage(id: string): Promise<void> {
  if (!plugins) return
  busy.value = true
  error.value = ''
  try {
    await plugins.restoreFactoryPackage(id)
    await refreshInstalled()
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
  } finally {
    busy.value = false
  }
}

onMounted(refreshInstalled)
</script>

<template>
  <div class="extensions-pane">
    <p v-if="error" class="ext-error" role="alert">{{ error }}</p>

    <section class="ext-section">
      <h3>Bundled</h3>
      <ul class="ext-list">
        <li
          v-for="p in factoryPackages"
          :key="p.id"
          class="ext-installed ext-factory"
          :data-factory-id="p.id"
        >
          <span class="ext-id">{{ p.id === 'navide.git' ? 'Bundled Git' : p.id }}</span>
          <span v-if="p.version" class="ext-requires">{{ p.version }}</span>
          <span class="ext-badge" :class="p.active ? 'ext-active' : 'ext-removed'">
            {{ p.active ? 'Active' : p.optedOut ? 'Removed' : 'Unavailable' }}
          </span>
          <button
            v-if="p.optedOut"
            class="ext-restore"
            :disabled="busy"
            @click="restoreFactoryPackage(p.id)"
          >
            Restore
          </button>
        </li>
      </ul>
    </section>

    <section class="ext-section">
      <h3>Installed</h3>
      <ul class="ext-list">
        <li v-for="p in nonFactoryInstalled" :key="p.id" class="ext-installed" :data-id="p.id">
          <span class="ext-id">{{ p.id }}</span>
          <span v-if="p.sensitive.length" class="ext-badge ext-sensitive">
            sensitive: {{ p.sensitive.join(', ') }}
          </span>
          <span class="ext-requires">{{ p.requires.join(', ') }}</span>
          <span v-if="p.warning" class="ext-badge ext-dev-warning">{{ p.warning }}</span>
          <button class="ext-remove" @click="remove(p.id)">Remove</button>
        </li>
        <li v-if="!nonFactoryInstalled.length" class="ext-empty">No plugins installed.</li>
      </ul>
    </section>

    <section class="ext-section">
      <h3>Marketplace</h3>
      <div class="ext-search">
        <input v-model="query" placeholder="Search extensions" @keyup.enter="search" />
        <button :disabled="busy" @click="search">Search</button>
      </div>
      <ul class="ext-list">
        <li v-for="ext in results" :key="ext.identity" class="ext-result" :data-id="ext.identity">
          <span class="ext-id">{{ ext.display_name || ext.name }}</span>
          <span class="ext-ns">{{ ext.namespace }}.{{ ext.name }}</span>
          <button class="ext-install" :disabled="busy" @click="install(ext)">Install</button>
        </li>
      </ul>
    </section>

    <div v-if="pendingConfirm" class="ext-trust-dialog" role="dialog" aria-modal="true">
      <div class="ext-trust-body">
        <h4 v-if="pendingStep === 'publisher'">Trust publisher</h4>
        <h4 v-else>Confirm plugin permissions</h4>
        <p v-if="pendingStep === 'publisher'" class="ext-publisher-risk">
          Trust publisher <strong>{{ pendingConfirm.prepared.publisherId }}</strong> for
          <strong>{{ pendingConfirm.prepared.id }}</strong>. A valid Registry signature proves
          package integrity, not that you want to run this publisher's code.
        </p>
        <p
          v-if="pendingStep === 'risk' && pendingConfirm.prepared.containsBackendExecutable"
          class="ext-backend-risk"
        >
          <strong>{{ pendingConfirm.ext.namespace }}.{{ pendingConfirm.ext.name }}</strong>
          contains a native backend executable that can run with your user account's
          operating-system permissions.
        </p>
        <p v-if="pendingStep === 'risk' && pendingConfirm.prepared.sensitive.length">
          <strong>{{ pendingConfirm.ext.namespace }}.{{ pendingConfirm.ext.name }}</strong>
          requests sensitive capabilities:
          <strong>{{ pendingConfirm.prepared.sensitive.join(', ') }}</strong>.
        </p>
        <p class="ext-trust-tier">
          <span
            v-if="pendingConfirm.prepared.trustTier === 'signed-verified'"
            class="ext-trust-badge ext-verified"
          >
            Signed &amp; verified
          </span>
          <span v-else class="ext-trust-badge ext-unsigned">
            Unsigned — not cryptographically verified
          </span>
        </p>
        <div class="ext-trust-actions">
          <button v-if="pendingStep === 'publisher'" class="ext-confirm-publisher" @click="confirmPublisher">
            Trust publisher
          </button>
          <button v-else class="ext-confirm-risk" @click="confirmRisk">Confirm and install</button>
          <button class="ext-cancel" @click="cancelInstall">Cancel</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.extensions-pane {
  /* Horizontal gutter matches the settings page gutter so the pane lines up with
     the <h1> the settings modal renders above it; the modal already reserves the
     gap below that title, so no top padding here. */
  padding: 0 22px 12px;
  font-size: 13px;
  flex: 1;
  min-height: 0;
  overflow-y: auto;
}
.ext-section {
  margin-bottom: 20px;
}
.ext-list {
  list-style: none;
  padding: 0;
  margin: 8px 0 0;
}
.ext-installed,
.ext-result {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 0;
  border-bottom: 1px solid var(--border-muted);
}
.ext-id {
  font-weight: 600;
}
.ext-ns,
.ext-requires {
  color: var(--text-muted, #888);
  font-size: 12px;
}
.ext-badge.ext-sensitive {
  color: #c77400;
  font-size: 11px;
}
.ext-badge.ext-dev-warning {
  color: #c77400;
  font-size: 11px;
}
.ext-badge.ext-active {
  color: #1a7f37;
  font-size: 11px;
}
.ext-badge.ext-removed {
  color: #c77400;
  font-size: 11px;
}
.ext-remove,
.ext-install,
.ext-restore {
  margin-left: auto;
}
.ext-search {
  display: flex;
  gap: 8px;
}
.ext-search input {
  flex: 1;
}
.ext-trust-dialog {
  position: fixed;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.4);
}
.ext-trust-body {
  background: var(--bg-color, #1c2028);
  padding: 20px 24px;
  border-radius: 8px;
  max-width: 400px;
}
.ext-trust-tier {
  color: var(--text-muted, #888);
}
.ext-trust-badge {
  display: inline-block;
  font-size: 11px;
  font-weight: 600;
  padding: 2px 6px;
  border-radius: 4px;
}
.ext-trust-badge.ext-verified {
  color: #1a7f37;
  background: rgba(26, 127, 55, 0.12);
}
.ext-trust-badge.ext-unsigned {
  color: #c77400;
  background: rgba(199, 116, 0, 0.12);
}
.ext-trust-actions {
  display: flex;
  gap: 8px;
  margin-top: 12px;
}
</style>
