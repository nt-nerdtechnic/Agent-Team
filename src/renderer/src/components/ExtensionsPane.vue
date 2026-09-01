<script setup lang="ts">
// Extensions view (minimal): lists installed plugins with their trust/capability
// badges and lets the user search the marketplace and install. Sensitive
// capabilities and native backend executables trigger the existing confirmation
// dialog after verification but before the package is written.
//
// All privileged work is brokered through the main process via
// `window.agentTeam.plugins`; this component holds no secrets and never touches
// package bytes.
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import type {
  ExecutionPolicySettingsSnapshot,
  ExecutionPolicySource,
  ManifestPermissionsSummary,
  PackageVersionGrantSummary,
} from '../../../shared/executionPolicy'

const props = defineProps<{
  workspacePath?: string
}>()

const { t } = useI18n()

function pluginsApi() {
  return window.agentTeam?.plugins
}

function policyApi() {
  return window.agentTeam?.executionPolicy
}

const installed = ref<InstalledPluginSummary[]>([])
const factoryPackages = ref<FactoryPluginSummary[]>([])
const factoryRows = computed(() => factoryPackages.value.map((factoryPackage) => ({
  ...factoryPackage,
  installed: installed.value.find((plugin) => plugin.id === factoryPackage.id) ?? null,
})))
const nonFactoryInstalled = computed(() =>
  installed.value.filter((plugin) => plugin.provenance !== 'factory-bundled')
)
const results = ref<MarketplaceExtension[]>([])
const query = ref('')
const busy = ref(false)
const error = ref('')
const policySnapshot = ref<ExecutionPolicySettingsSnapshot | null>(null)
const policyError = ref('')
let stopPolicyChanged: (() => void) | undefined
// A prepared, verified install awaiting the existing install-risk confirmation.
const pendingConfirm = ref<{ ext: MarketplaceExtension; prepared: PreparedInstallSummary } | null>(
  null
)
const pendingStep = ref<'publisher' | 'risk' | null>(null)
const publisherConfirmed = ref(false)

async function refreshInstalled(): Promise<void> {
  const api = pluginsApi()
  if (!api) return
  ;[installed.value, factoryPackages.value] = await Promise.all([
    api.listInstalled(),
    api.listFactoryPackages(),
  ])
}

async function refreshPolicy(): Promise<void> {
  const api = policyApi()
  if (!api) return
  policyError.value = ''
  try {
    policySnapshot.value = await api.inspect(props.workspacePath)
  } catch (err) {
    policyError.value = err instanceof Error ? err.message : String(err)
  }
}

const selectedPolicy = computed(() => {
  const current = policySnapshot.value
  return current?.workspace?.policy ?? current?.global.policy ?? null
})
const selectedPolicySource = computed<ExecutionPolicySource | null>(() => {
  const current = policySnapshot.value
  if (!current) return null
  if (current.workspace) return current.workspace.activeSource
  return current.global.state === 'user'
    ? 'user'
    : current.global.state === 'default'
      ? 'default'
      : null
})
const selectedPolicyStatus = computed(() => {
  const current = policySnapshot.value
  return current?.workspace?.status ?? (current?.global.state === 'corrupt' ? 'corrupt' : 'active')
})

function formatPolicySource(source: ExecutionPolicySource | null): string {
  return t(`settings.extensionsPolicy.source.${source ?? 'unavailable'}`)
}

function formatList(values: readonly string[]): string {
  return values.length > 0 ? values.join(', ') : t('settings.extensionsPolicy.none')
}

function formatManifestPermissions(permissions: ManifestPermissionsSummary): string {
  const parts = [`${t('settings.extensionsPolicy.system')}: ${formatList(permissions.system)}`]
  if (permissions.shell) parts.push(`${t('settings.extensionsPolicy.shell')}: ${permissions.shell}`)
  return parts.join('; ')
}

function formatPackageGrant(grant: PackageVersionGrantSummary | null | undefined): string {
  if (!grant) return t('settings.extensionsPolicy.noMatchingGrant')
  const parts = [
    `${t('settings.extensionsPolicy.version')} ${grant.packageVersion}`,
    `${t('settings.extensionsPolicy.system')}: ${formatList(grant.system)}`,
  ]
  if (grant.shell) parts.push(`${t('settings.extensionsPolicy.shell')}: ${grant.shell}`)
  if (grant.highRiskShellConfirmed !== undefined) {
    parts.push(`${t('settings.extensionsPolicy.highRiskShellConfirmed')}: ${grant.highRiskShellConfirmed ? t('settings.extensionsPolicy.yes') : t('settings.extensionsPolicy.no')}`)
  }
  if (grant.storage !== undefined) {
    parts.push(`${t('settings.extensionsPolicy.storage')}: ${grant.storage ? t('settings.extensionsPolicy.yes') : t('settings.extensionsPolicy.no')}`)
  }
  return parts.join('; ')
}

async function search(): Promise<void> {
  const api = pluginsApi()
  if (!api) return
  busy.value = true
  error.value = ''
  try {
    const res = await api.marketplaceSearch(query.value || undefined)
    results.value = res.items
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
  } finally {
    busy.value = false
  }
}

async function install(ext: MarketplaceExtension): Promise<void> {
  const api = pluginsApi()
  if (!api) return
  busy.value = true
  error.value = ''
  try {
    const prepared = await api.prepareInstall({ namespace: ext.namespace, name: ext.name })
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
  const api = pluginsApi()
  if (!api) return
  await api.commitInstall(id, approval)
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
  const api = pluginsApi()
  if (!api) return
  await api.remove(id)
  await refreshInstalled()
}

async function restoreFactoryPackage(id: string): Promise<void> {
  const api = pluginsApi()
  if (!api) return
  busy.value = true
  error.value = ''
  try {
    await api.restoreFactoryPackage(id)
    await refreshInstalled()
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
  } finally {
    busy.value = false
  }
}

onMounted(() => {
  void refreshInstalled()
  void refreshPolicy()
  stopPolicyChanged = policyApi()?.onChanged(() => { void refreshPolicy() })
})

onUnmounted(() => stopPolicyChanged?.())
watch(() => props.workspacePath, () => { void refreshPolicy() })
</script>

<template>
  <div class="extensions-pane">
    <p v-if="error" class="ext-error" role="alert">{{ error }}</p>

    <section class="ext-section ext-policy-section" data-section="agent-execution-policy">
      <h3>{{ $t('settings.extensionsPolicy.title') }}</h3>
      <p class="ext-policy-separation">
        {{ $t('settings.extensionsPolicy.separation') }}
      </p>
      <div v-if="selectedPolicy" class="ext-policy-card">
        <span><strong>{{ $t('settings.extensionsPolicy.effectiveSource') }}:</strong> {{ formatPolicySource(selectedPolicySource) }}</span>
        <span><strong>{{ $t('settings.extensionsPolicy.mode') }}:</strong> {{ $t(`settings.executionPolicy.mode.${selectedPolicy.mode}`) }}</span>
        <span><strong>{{ $t('settings.extensionsPolicy.systemNamespaces') }}:</strong> {{ formatList(selectedPolicy.system) }}</span>
        <span><strong>{{ $t('settings.extensionsPolicy.shellExecutables') }}:</strong> {{ formatList(selectedPolicy.shell) }}</span>
        <span><strong>{{ $t('settings.extensionsPolicy.status') }}:</strong> {{ $t(`settings.executionPolicy.status.${selectedPolicyStatus}`) }}</span>
      </div>
      <p v-else-if="policyError" class="ext-error" role="alert">{{ policyError }}</p>
      <p v-else class="ext-policy-muted">{{ $t('settings.extensionsPolicy.unavailable') }}</p>
    </section>

    <section class="ext-section">
      <h3>Bundled</h3>
      <ul class="ext-list">
        <li
          v-for="p in factoryRows"
          :key="p.id"
          class="ext-installed ext-factory"
          :data-factory-id="p.id"
        >
          <span class="ext-id">{{ p.id === 'navide.git' ? 'Bundled Git' : p.id }}</span>
          <span v-if="p.installed?.packageVersion ?? p.version" class="ext-requires">
            {{ p.installed?.packageVersion ?? p.version }}
          </span>
          <span class="ext-badge" :class="p.active ? 'ext-active' : 'ext-removed'">
            {{ p.active ? 'Active' : p.optedOut ? 'Removed' : 'Unavailable' }}
          </span>
          <div v-if="p.installed?.manifestPermissions || p.installed?.packageVersion" class="ext-permission-details">
            <span v-if="p.installed?.manifestPermissions" class="ext-manifest-permissions">
              {{ $t('settings.extensionsPolicy.manifestPermissions') }}: {{ formatManifestPermissions(p.installed.manifestPermissions) }}
            </span>
            <span v-if="p.installed?.packageVersion" class="ext-package-grant">
              {{ $t('settings.extensionsPolicy.packageVersionGrant') }}: {{ formatPackageGrant(p.installed.packageVersionGrant) }}
            </span>
          </div>
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
          <span v-if="p.packageVersion" class="ext-requires">{{ $t('settings.extensionsPolicy.version') }} {{ p.packageVersion }}</span>
          <span v-if="p.sensitive.length" class="ext-badge ext-sensitive">
            sensitive: {{ p.sensitive.join(', ') }}
          </span>
          <span class="ext-requires">{{ p.requires.join(', ') }}</span>
          <span v-if="p.warning" class="ext-badge ext-dev-warning">{{ p.warning }}</span>
          <div v-if="p.manifestPermissions || p.packageVersion" class="ext-permission-details">
            <span v-if="p.manifestPermissions" class="ext-manifest-permissions">
              {{ $t('settings.extensionsPolicy.manifestPermissions') }}: {{ formatManifestPermissions(p.manifestPermissions) }}
            </span>
            <span v-if="p.packageVersion" class="ext-package-grant">
              {{ $t('settings.extensionsPolicy.packageVersionGrant') }}: {{ formatPackageGrant(p.packageVersionGrant) }}
            </span>
          </div>
          <button class="ext-remove" @click="remove(p.id)">Remove</button>
        </li>
        <li v-if="!nonFactoryInstalled.length" class="ext-empty nv-empty">No plugins installed.</li>
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
  font-size: var(--font-sm);
  flex: 1;
  min-height: 0;
  overflow-y: auto;
}
.ext-section {
  margin-bottom: 20px;
}
.ext-policy-separation,
.ext-policy-muted {
  color: var(--text-secondary, #888);
  line-height: 1.45;
}
.ext-policy-card {
  display: grid;
  gap: 4px;
  padding: 10px 12px;
  border: 1px solid var(--border-default);
  border-radius: var(--radius-card);
  background: var(--bg-subtle);
  line-height: 1.5;
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
.ext-installed {
  flex-wrap: wrap;
}
.ext-id {
  font-weight: 600;
}
.ext-ns,
.ext-requires {
  color: var(--text-muted, #888);
  font-size: var(--font-xs);
}
.ext-permission-details {
  flex: 1 1 100%;
  display: grid;
  gap: 2px;
  margin: 2px 0 2px 4px;
  color: var(--text-secondary, #888);
  font-size: var(--font-2xs);
  line-height: 1.4;
}
.ext-badge.ext-sensitive {
  color: #c77400;
  font-size: var(--font-2xs);
}
.ext-badge.ext-dev-warning {
  color: #c77400;
  font-size: var(--font-2xs);
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
  font-size: var(--font-2xs);
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
/* These six buttons declare nothing of their own — they are native browser
 * buttons. Hover therefore darkens what the platform already painted instead
 * of replacing the fill: an overlay colour here would flip a light native
 * button to a dark one on hover, which is a bigger change than the missing
 * feedback it fixes. The search button is reached structurally because it has
 * no class of its own. */
.ext-remove,
.ext-install,
.ext-search button,
.ext-confirm-publisher,
.ext-confirm-risk,
.ext-cancel {
  transition: filter var(--motion-fast) var(--ease-out);
}
.ext-remove:hover:not(:disabled),
.ext-install:hover:not(:disabled),
.ext-search button:hover:not(:disabled),
.ext-confirm-publisher:hover:not(:disabled),
.ext-confirm-risk:hover:not(:disabled),
.ext-cancel:hover:not(:disabled) {
  filter: brightness(0.93);
}
</style>
