import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import * as ts from 'typescript'
import { describe, expect, it } from 'vitest'

const repositoryRoot = resolve(process.cwd())

const privateFeatureRoots = [
  'packages/features/shared',
  'packages/features/ui-foundation',
  'packages/features/terminal',
  'packages/features/plugin-shell',
]

const hostImplementationPaths = [
  'src/renderer/src/agents',
  'src/renderer/src/keybindings',
  'src/renderer/src/components/AiCliDock.vue',
  'src/renderer/src/components/AiCliTerminal.vue',
  'src/renderer/src/composables/useNotify.ts',
  'src/renderer/src/composables/useTerminal.ts',
  'src/renderer/src/composables/useTerminalFontSize.ts',
  'src/renderer/src/composables/useTerminalResize.ts',
  'src/renderer/src/composables/useTheme.ts',
  'src/renderer/src/i18n',
  'src/renderer/src/lib/aiCliContext.ts',
  'src/renderer/src/lib/buffer.ts',
  'src/renderer/src/lib/cliContext.ts',
  'src/renderer/src/lib/clipboardImage.ts',
  'src/renderer/src/lib/diagLog.ts',
  'src/renderer/src/lib/resume-command.ts',
  'src/renderer/src/lib/resumeConcurrency.ts',
  'src/renderer/src/lib/settings.ts',
  'src/renderer/src/lib/shellEscape.ts',
  'src/renderer/src/ports/keybindings.ts',
  'src/renderer/src/ports/response.ts',
  'src/renderer/src/ports/terminalDock.ts',
  'src/renderer/src/ports/value.ts',
  'src/renderer/src/styles/tokens',
]

const pluginShellPresentationPaths = [
  'src/composables/useNotify.ts',
  'src/composables/useTheme.ts',
  'src/i18n',
  'src/styles.css',
  'src/styles',
]

const gitUiImplementationPaths = [
  'agents',
  'components',
  'composables',
  'i18n',
  'keybindings',
  'lib',
  'ports',
  'styles',
]

const expectedRootFiles = [
  'packages/features/shared/src/index.ts',
  'packages/features/ui-foundation/src/index.ts',
  'packages/features/terminal/src/index.ts',
  'packages/features/plugin-shell/src/index.ts',
]

const ownerDependencyAliases: Record<string, string[]> = {
  shared: [],
  'ui-foundation': ['@navide/shared'],
  terminal: ['@navide/shared'],
  'plugin-shell': ['@navide/shared', '@navide/terminal', '@navide/ui-foundation'],
}

const ownerTsconfigPaths: Record<string, string[]> = {
  shared: [],
  'ui-foundation': ['@navide/shared'],
  terminal: ['@navide/shared'],
  'plugin-shell': ['@navide/shared', '@navide/terminal', '@navide/ui-foundation'],
}

const allowedRootExports: Record<string, string[]> = {
  shared: [
    'initSettingsBackend', 'migrateLegacyLocalStorage', 'onSettingsChanged', 'seedSettings',
    'settingsGet', 'settingsReady', 'settingsRemove', 'settingsSet',
    'SETTINGS_FLUSH_DEBOUNCE_MS', 'MIGRATED_LOCALSTORAGE_KEYS', 'PURGED_LOCALSTORAGE_KEYS',
    'PURGED_LOCALSTORAGE_PREFIXES', 'SettingsBackend', 'KeybindingsPort', 'PortError',
    'PortResponse', 'ReactiveValue', 'COMMAND_IDS', 'commandI18nKey', 'describeCommand',
    'CommandInfo', 'executeCommand', 'hasCommand', 'invokeCommand', 'listCommands',
    'registerCommand', 'InvokeCommandResult', 'getContext', 'setContext', 'buildRows',
    'classifyRow', 'conflictsByRow', 'findKeyConflicts', 'parseUserRules', 'resetRow',
    'reviewImportedRules', 'rowId', 'sanitizeUserRules', 'serializeUserRules', 'setRowKeys',
    'PROTECTED_COMMANDS', 'BindingKeyChip', 'BindingRow', 'BindingSource', 'ImportReport',
    'KeyConflict', 'defaults', 'acceleratorToSpec', 'MENU_LITERAL_ACCELERATORS',
    'MENU_OMITTED_ROLES', 'MENU_OWNED_SPECS', 'MENU_ROLE_ACCELERATORS', 'menuOwnedSpecs',
    'NATIVE_MENU_KEYS', 'splitKeyTokens', 'TERMINAL_KEYS', 'ExternalKeyRow', 'KeyToken',
    'formatKeySpec', 'keySpecToTokens', 'segmentToTokens', 'KeyResolver', 'canonicalizeKeySpec',
    'eventToKeyString', 'eventToParsedKey', 'formatParsedKey', 'isMacPlatform', 'matchesEvent',
    'parseKey', 'parseKeySpec', 'parsedKeyEquals', 'validateKeySpec', 'KeySpecError',
    'isRemovalRule', 'removalTarget', 'CommandHandler', 'KeybindingRule', 'ParsedKey',
    'getUserRules', 'initKeybindingsPort', 'isKeyCaptureActive', 'onUserRulesChanged',
    'saveUserRules', 'setKeyCaptureActive', 'setUserRules', 'useKeybindings', 'evaluateWhen',
  ],
  'ui-foundation': [
    'i18n', 'enUSMessages', 'zhTWMessages', 'BUILTIN_THEMES', 'CUSTOMIZABLE_TOKENS',
    'DEFAULT_THEME', 'useTheme', 'ThemeMeta', 'useNotify', 'DialogState', 'Toast', 'ToastType',
  ],
  terminal: [
    'agentUsesBracketedPaste', 'encodeShiftEnter', 'migrateTerminalPtyKey',
    'saveAllScrollSnapshots', 'stripAltScreenEnter', 'useTerminal', 'ClipboardFailureReason',
    'DisplayStatus', 'SpawnOptions', 'TerminalAgentProfile', 'TerminalAgentProfileResolver',
    'TerminalStatus', 'DEFAULT_FONT_SIZE', 'installTerminalZoomShortcuts', 'terminalFontSize',
    'zoomIn', 'zoomOut', 'zoomReset', 'createResizeController', 'ResizeController',
    'findConsecutiveQuestionBlocks', 'findSentinel', 'BRACKETED_PASTE_END', 'BRACKETED_PASTE_START',
    'buildCliPaneBufferReply', 'buildExternalPaneContextPaste', 'buildMentionInsert',
    'buildPaneContextPaste', 'buildPaneStatusReply', 'CLI_CHIP_LINE_CAP', 'CLI_CONTEXT_MIME',
    'CLI_PASTE_LINE_CAP', 'injectionChunks', 'resolveCliDropSources', 'screenToClientPoint',
    'shouldMentionOnDrop', 'writeCliPaneDragPayload', 'PANE_BATCH_MIME', 'PANE_ID_MIME',
    'CliContextPayload', 'CliPaneBufferReply', 'CliSessionContext', 'PaneStatusReply', 'diagLog',
    'DiagnosticPort', 'clampResumeConcurrency', 'DEFAULT_RESUME_CONCURRENCY',
    'MAX_RESUME_CONCURRENCY', 'MIN_RESUME_CONCURRENCY', 'RESUME_CONCURRENCY_SETTING_KEY',
    'formatTerminalExit', 'isTerminalCrashLoopOpen', 'recordTerminalExit', 'resetTerminalCrashLoop',
    'terminalCrashKey', 'TERMINAL_CREATE_TIMEOUT_MS', 'CrashLoopState', 'TerminalExitDetails',
    'TerminalStartupProbe', 'TERMINAL_DOCK_KEY', 'TerminalCreateRequest', 'TerminalCreateResult',
    'TerminalDockPort', 'TerminalExitEvent', 'TerminalFileListResult', 'TerminalOutputEvent',
    'TerminalSpawnOptions', 'TerminalStatusSource',
  ],
  'plugin-shell': [
    'AGENT_SPECS', 'CLI_AGENT_SPECS', 'REBUILD_CAPABLE_AGENTS', 'RESTORE_PIN_AGENTS', 'AgentKey',
    'AgentSpec', 'DirLister', 'PaneArgContext', 'agentProfileFor', 'agentUsesBracketedPaste',
    'encodeShiftEnter', 'AiCliDock', 'AiCliTerminal', 'aiTerminalPaneId', 'bracketedPaste',
    'buildPlanCliContext', 'resolveCliCommand', 'truncateText', 'PLAN_DOC_TRUNCATE_AT',
    'PlanCliContextInput', 'PlanCliMetaSummary', 'acquirePaneRebuildLock', 'buildResumeCommand',
    'cancelStalePendingCreate', 'dedupeRestorablePanes', 'normalizeResumeSessionId',
    'paneBusyForRebuild', 'paneCanRebuild', 'paneRebuildVisible', 'sessionHomeIdFor',
    'shouldPreserveMissingSessionOnRestore', 'shouldWarnMissingResume', 'usesSessionHome',
    'shellEscape',
  ],
}

function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
  if (!ts.canHaveModifiers(node)) return false
  return ts.getModifiers(node)?.some((modifier) => modifier.kind === kind) === true
}

function addBindingNames(name: ts.BindingName, names: Set<string>): void {
  if (ts.isIdentifier(name)) {
    names.add(name.text)
    return
  }
  for (const element of name.elements) {
    if (ts.isBindingElement(element)) addBindingNames(element.name, names)
  }
}

function addNamedDeclarationName(name: ts.DeclarationName | undefined, names: Set<string>): void {
  if (name && ts.isIdentifier(name)) names.add(name.text)
  else names.add('<unnamed>')
}

function rootExportNames(source: string): string[] {
  const names = new Set<string>()
  const file = ts.createSourceFile('index.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)

  for (const statement of file.statements) {
    if (ts.isExportDeclaration(statement)) {
      if (!statement.exportClause) {
        names.add('*')
      } else if (ts.isNamedExports(statement.exportClause)) {
        for (const element of statement.exportClause.elements) names.add(element.name.text)
      } else if (ts.isNamespaceExport(statement.exportClause)) {
        names.add(statement.exportClause.name.text)
      }
      continue
    }

    if (ts.isExportAssignment(statement)) {
      names.add(statement.isExportEquals ? 'export=' : 'default')
      continue
    }

    if (!hasModifier(statement, ts.SyntaxKind.ExportKeyword)) continue
    if (hasModifier(statement, ts.SyntaxKind.DefaultKeyword)) {
      names.add('default')
      continue
    }

    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        addBindingNames(declaration.name, names)
      }
    } else if (
      ts.isFunctionDeclaration(statement)
      || ts.isClassDeclaration(statement)
      || ts.isInterfaceDeclaration(statement)
      || ts.isTypeAliasDeclaration(statement)
      || ts.isEnumDeclaration(statement)
      || ts.isModuleDeclaration(statement)
      || ts.isImportEqualsDeclaration(statement)
    ) {
      addNamedDeclarationName(statement.name, names)
    }
  }
  return [...names].sort()
}

function privateImportPaths(source: string): string[] {
  const ownerNames = Object.keys(ownerDependencyAliases).join('|')
  const importPattern = new RegExp(
    String.raw`(?:\bfrom\s+|\bimport\s*(?:\(\s*)?)['"](@navide\/(?:${ownerNames})(?:\/[^'"]+)?)['"]`,
    'gu',
  )
  return [...source.matchAll(importPattern)].map((match) => match[1])
}

function isTestFile(path: string): boolean {
  return /(?:^|\/)__tests__\//u.test(path) || /\.test\.ts$/u.test(path)
}

function ownerDependencyViolations(owner: string, source: string): string[] {
  const allowed = new Set(ownerDependencyAliases[owner])
  return privateImportPaths(source).filter((imported) => !allowed.has(imported))
}

const allowedConsumerPrivateImports = new Set([
  ...Object.keys(ownerDependencyAliases).map((owner) => `@navide/${owner}`),
  '@navide/ui-foundation/styles.css',
])
const testOnlyPrivateImports = new Set(['@navide/shared/testing', '@navide/terminal/testing'])

function consumerPrivateImportViolations(path: string, source: string): string[] {
  const testFile = isTestFile(path)
  return privateImportPaths(source).filter((imported) => {
    if (testOnlyPrivateImports.has(imported)) return !testFile
    return !allowedConsumerPrivateImports.has(imported)
  })
}

describe('private shared feature boundary scanner', () => {
  it('recognizes direct export declarations in the root export contract', () => {
    expect(rootExportNames(`
      export const accidental = 1
      export function anotherAccidental() {}
      export type AccidentalType = string
    `)).toEqual(['AccidentalType', 'accidental', 'anotherAccidental'])
  })

  it('captures private deep imports and restricts testing seams to test files', () => {
    const deepImport = "import { value } from '@navide/terminal/internal'"
    expect(privateImportPaths(deepImport)).toEqual(['@navide/terminal/internal'])
    expect(ownerDependencyViolations('plugin-shell', deepImport)).toEqual(['@navide/terminal/internal'])
    expect(consumerPrivateImportViolations('/repo/src/consumer.test.ts', deepImport)).toEqual([
      '@navide/terminal/internal',
    ])

    const testingImport = "import '@navide/shared/testing'"
    expect(consumerPrivateImportViolations('/repo/src/consumer.ts', testingImport)).toEqual([
      '@navide/shared/testing',
    ])
    expect(consumerPrivateImportViolations('/repo/src/__tests__/consumer.ts', testingImport)).toEqual([])
  })
})

function sourceFiles(root: string): string[] {
  if (!existsSync(root)) return []
  const files: string[] = []
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = resolve(root, entry.name)
    if (entry.isDirectory()) files.push(...sourceFiles(path))
    else if (/\.(ts|vue)$/.test(entry.name)) files.push(path)
  }
  return files
}

describe('private shared feature ownership boundary', () => {
  it('has one explicit root export for every private feature owner', () => {
    for (const path of expectedRootFiles) expect(existsSync(resolve(repositoryRoot, path)), path).toBe(true)
  })

  it('removes shared implementation from Host-owned source paths', () => {
    for (const path of hostImplementationPaths) {
      expect(existsSync(resolve(repositoryRoot, path)), path).toBe(false)
    }
  })

  it('leaves only the intentional roles/stages aliases in git-ui', () => {
    for (const path of gitUiImplementationPaths) {
      expect(existsSync(resolve(repositoryRoot, 'packages/features/git-ui/src', path)), path).toBe(false)
    }
    expect(existsSync(resolve(repositoryRoot, 'packages/features/git-ui/src/data/roles.ts'))).toBe(true)
    expect(existsSync(resolve(repositoryRoot, 'packages/features/git-ui/src/data/stages.ts'))).toBe(true)
  })

  it('keeps presentation ownership out of plugin-shell', () => {
    for (const path of pluginShellPresentationPaths) {
      expect(existsSync(resolve(repositoryRoot, 'packages/features/plugin-shell', path)), path).toBe(false)
    }
  })

  it('uses explicit root exports without leaking test seams or presentation helpers', () => {
    for (const path of expectedRootFiles) {
      const source = readFileSync(resolve(repositoryRoot, path), 'utf8')
      expect(source, path).not.toMatch(/export\s+\*/u)
      expect(source, path).not.toMatch(/export\s+default\b/u)
      expect(source, path).not.toMatch(/(?:__reset|_reset)[A-Za-z0-9_]*/u)
    }

    const pluginShellIndex = readFileSync(
      resolve(repositoryRoot, 'packages/features/plugin-shell/src/index.ts'),
      'utf8',
    )
    expect(pluginShellIndex).not.toMatch(/useTheme|useNotify|i18n|enUSMessages|zhTWMessages|BUILTIN_THEMES/u)
  })

  it('keeps each private root export surface fixed', () => {
    for (const [owner, allowed] of Object.entries(allowedRootExports)) {
      const indexPath = resolve(repositoryRoot, `packages/features/${owner}/src/index.ts`)
      expect(rootExportNames(readFileSync(indexPath, 'utf8')), owner).toEqual(allowed.slice().sort())
    }
  })

  it('locks the private owner dependency direction', () => {
    for (const owner of Object.keys(ownerDependencyAliases)) {
      const root = resolve(repositoryRoot, `packages/features/${owner}/src`)
      for (const path of sourceFiles(root)) {
        if (isTestFile(path)) continue
        const source = readFileSync(path, 'utf8')
        expect(ownerDependencyViolations(owner, source), relative(repositoryRoot, path)).toEqual([])
      }

      const tsconfigPath = resolve(repositoryRoot, `packages/features/${owner}/tsconfig.json`)
      const tsconfig = JSON.parse(readFileSync(tsconfigPath, 'utf8')) as {
        compilerOptions?: { paths?: Record<string, unknown> }
      }
      expect(Object.keys(tsconfig.compilerOptions?.paths ?? {}).sort(), owner).toEqual(
        ownerTsconfigPaths[owner].slice().sort(),
      )
    }
  })

  it('does not allow consumers to deep-import private feature implementations', () => {
    const consumers = [
      'src/renderer/src',
      'src/renderer/plugins',
      'plugins/navide-git/src',
    ].flatMap((path) => sourceFiles(resolve(repositoryRoot, path)))
    for (const path of consumers) {
      const source = readFileSync(path, 'utf8')
      expect(consumerPrivateImportViolations(path, source), relative(repositoryRoot, path)).toEqual([])
      expect(source, relative(repositoryRoot, path)).not.toContain('@navide/git-shared')
    }
  })

  it('keeps feature packages independent from Host and Git implementations', () => {
    const files = privateFeatureRoots.flatMap((path) => sourceFiles(resolve(repositoryRoot, path)))
    for (const path of files) {
      const source = readFileSync(path, 'utf8')
      expect(source, relative(repositoryRoot, path)).not.toContain('src/renderer/src')
      expect(source, relative(repositoryRoot, path)).not.toContain('@navide/git-feature')
      expect(source, relative(repositoryRoot, path)).not.toContain('plugins/navide-git')
    }
  })
})
