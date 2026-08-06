<script setup lang="ts">
// Read-only keyboard shortcuts reference shown inside Settings.
// Static mirror of the keybinding system; may drift from code over time.

type CtxId = 'editorText' | 'editorOpen' | 'findOpen' | 'terminal' | 'modal' | 'global' | 'native'

interface Row {
  keys: string // space-separated tokens; "/" "→" "–" are separators
  desc: string
  ctx?: CtxId[]
}

interface Block {
  titleKey: string
  noteKey?: string
  rows: Row[]
}

const ctxIds: CtxId[] = ['editorText', 'editorOpen', 'findOpen', 'terminal', 'modal', 'global', 'native']

// Workflow callout keys (rendered separately, above the blocks).
const workflow = {
  pick: '⌃ 1 – 5',
  spawn: '⌘ ⇧ U',
}

const blocks: Block[] = [
  {
    titleKey: 'settings.shortcuts.section.workbench',
    noteKey: 'settings.shortcuts.note.workbench',
    rows: [
      { keys: '⌘ ⇧ P / F1', desc: '命令面板', ctx: ['global'] },
      { keys: '⌘ P', desc: '快速開啟檔案', ctx: ['global'] },
      { keys: '⌘ ,', desc: '開啟設定', ctx: ['global'] },
      { keys: '⌘ B', desc: '開關側邊欄', ctx: ['global'] },
      { keys: '⌘ ⇧ E', desc: '聚焦 Explorer 側欄', ctx: ['global'] },
      { keys: '⌘ ⇧ Y', desc: '聚焦 Pipeline 側欄', ctx: ['global'] },
      { keys: '⌘ ⇧ G', desc: '聚焦原始碼控制', ctx: ['global'] },
      { keys: '⌘ ⇧ I', desc: '開啟 Mini-IDE', ctx: ['global'] },
      { keys: '⌘ ⇧ D', desc: '開啟 Plans 計畫', ctx: ['global'] },
      { keys: '⌃ 1 – 5', desc: '切換 CLI 種類（下次要開的類型）', ctx: ['global'] },
      { keys: '⌘ ⇧ U', desc: '用選定類型開新 agent（spawn）', ctx: ['global'] },
      { keys: '⌘ ⇧ R / ⌘ ⇧ B', desc: '重建目前 focus 的 pane（resume）', ctx: ['global'] },
      { keys: '⌘ ⇧ N', desc: '開新視窗', ctx: ['global'] },
      { keys: '⌘ ⇧ F', desc: '跨檔搜尋', ctx: ['global'] },
      { keys: '⌘ ⇧ M', desc: '聚焦 Problems 面板', ctx: ['global'] },
      { keys: '⌘ K → ⌘ S', desc: '開啟鍵盤快捷鍵設定', ctx: ['global'] },
      { keys: '⌘ K → ⌘ T', desc: '選擇佈景主題', ctx: ['global'] },
      { keys: 'Esc', desc: '關閉對話框 / overlay', ctx: ['modal'] },
    ],
  },
  {
    titleKey: 'settings.shortcuts.section.editorFind',
    noteKey: 'settings.shortcuts.note.editor',
    rows: [
      { keys: '⌘ S', desc: '存檔', ctx: ['editorOpen'] },
      { keys: '⌘ F', desc: '尋找', ctx: ['editorOpen'] },
      { keys: '⌘ ⌥ F', desc: '取代（刻意避開 ⌘H）', ctx: ['editorOpen'] },
      { keys: '⌘ G / ⌘ ⇧ G', desc: '下一個 / 上一個符合', ctx: ['findOpen'] },
      { keys: '⌘ ⇧ H', desc: '跨檔取代', ctx: ['global'] },
      { keys: '⌘ L', desc: '跳到行', ctx: ['editorOpen'] },
    ],
  },
  {
    titleKey: 'settings.shortcuts.section.editorAi',
    rows: [
      { keys: '⌘ K → ⌘ K / ⌃ ⇧ I', desc: 'Inline rewrite（AI 改寫）', ctx: ['editorText'] },
      { keys: '⌘ I / ⌃ Space', desc: '觸發 Ghost 建議', ctx: ['editorText'] },
      { keys: '⌘ J / ⌘ ⇧ A / ⌃ `', desc: '開關 AI 終端機面板', ctx: ['editorOpen'] },
      { keys: '⌘ ⇧ L', desc: '加選取到 AI 終端機（文字焦點時＝選取相同項）', ctx: ['editorOpen'] },
    ],
  },
  {
    titleKey: 'settings.shortcuts.section.editorEdit',
    rows: [
      { keys: '⌘ Z / ⌘ ⇧ Z', desc: '復原 / 重做', ctx: ['editorText'] },
      { keys: '⌘ / / ⌘ ⌥ /', desc: '行註解 / 區塊註解', ctx: ['editorText'] },
      { keys: '⌘ D', desc: '加選下一個相同字', ctx: ['editorText'] },
      { keys: '⌥ ↑ / ⌥ ↓', desc: '上 / 下移行', ctx: ['editorText'] },
      { keys: '⇧ ⌥ ↓ / ⇧ ⌥ ↑', desc: '向下 / 向上複製行', ctx: ['editorText'] },
      { keys: '⌘ ⌥ ↑ / ⌘ ⌥ ↓', desc: '上 / 下加游標（多游標）', ctx: ['editorText'] },
      { keys: '⇧ ⌥ F', desc: '格式化文件', ctx: ['editorText'] },
      { keys: '⌘ ⌥ [ / ⌘ ⌥ ]', desc: '折疊 / 展開', ctx: ['editorText'] },
      { keys: '⌘ .', desc: 'Quick Fix', ctx: ['editorText'] },
      { keys: 'F12 / ⇧ F12 / F2', desc: '跳到定義 / 找引用 / 重新命名符號', ctx: ['editorText'] },
    ],
  },
  {
    titleKey: 'settings.shortcuts.section.editorTabs',
    rows: [
      { keys: '⌃ Tab / ⌃ ⇧ Tab', desc: '下 / 上一個編輯器', ctx: ['editorOpen'] },
      { keys: '⌘ 1 – 9', desc: '開第 N 個編輯器分頁', ctx: ['editorOpen'] },
      { keys: '⌘ \\', desc: '分割編輯器', ctx: ['editorOpen'] },
      { keys: '⌃ - / ⌃ ⇧ -', desc: '上一個 / 下一個位置', ctx: ['editorOpen'] },
      { keys: '⌘ = / ⌘ - / ⌘ 0', desc: 'Monaco 字級放大 / 縮小 / 重設', ctx: ['editorOpen'] },
    ],
  },
  {
    titleKey: 'settings.shortcuts.section.terminal',
    noteKey: 'settings.shortcuts.note.terminal',
    rows: [
      { keys: '⇧ Enter', desc: '換行不送出（依 agent 協定）', ctx: ['terminal'] },
      { keys: '⇧ ← / ⇧ →', desc: '逐字元延伸選取', ctx: ['terminal'] },
      { keys: '⌘ ⇧ ← / ⌘ ⇧ →', desc: '選到行首 / 行尾', ctx: ['terminal'] },
      { keys: '⌘ ← / ⌘ → / ⌘ Backspace', desc: '游標行首 / 行尾 / 清行', ctx: ['terminal'] },
      { keys: '⌥ Backspace', desc: '刪除前一個詞', ctx: ['terminal'] },
      { keys: '⌘ = / ⌘ - / ⌘ 0', desc: '終端字級放大 / 縮小 / 重設（全域套用所有終端）', ctx: ['terminal'] },
      { keys: '⌘', desc: '按住 ⌘ 顯示 Cmd+Click 檔案連結 hover', ctx: ['terminal'] },
    ],
  },
  {
    titleKey: 'settings.shortcuts.section.native',
    noteKey: 'settings.shortcuts.note.native',
    rows: [
      { keys: '⌘ R', desc: '重新載入（會搶走 app 的 ⌘R；強制重載已移除，⌘⇧R 留給重建 pane）', ctx: ['native'] },
      { keys: '⌥ ⌘ I', desc: '開發者工具', ctx: ['native'] },
      { keys: '⌃ ⌘ F', desc: '全螢幕', ctx: ['native'] },
      { keys: '⌘ C / V / X / Z / A', desc: '複製 / 貼上 / 剪下 / 復原 / 全選', ctx: ['native'] },
      { keys: '⌘ W / ⌘ Q / ⌘ M', desc: '關閉 / 結束 / 最小化', ctx: ['native'] },
      { keys: '⌘ H / ⌥ ⌘ H', desc: '隱藏 / 隱藏其他', ctx: ['native'] },
    ],
  },
]

const separators = new Set(['/', '→', '–'])

interface KeyPart {
  type: 'key' | 'sep'
  value: string
  plus?: boolean
}

function parseKeys(str: string): KeyPart[] {
  const tokens = str.split(/\s+/).filter(Boolean)
  const parts: KeyPart[] = []
  for (const tok of tokens) {
    if (separators.has(tok)) {
      parts.push({ type: 'sep', value: tok })
    } else {
      const prev = parts[parts.length - 1]
      parts.push({ type: 'key', value: tok, plus: prev?.type === 'key' })
    }
  }
  return parts
}
</script>

<template>
  <div class="ks">
    <p class="ks-intro">{{ $t('settings.shortcuts.intro') }}</p>

    <!-- Workflow callout -->
    <div class="ks-callout">
      <div class="ks-callout-title">{{ $t('settings.shortcuts.callout.title') }}</div>
      <div class="ks-callout-row">
        <span class="ks-keys">
          <template v-for="(p, i) in parseKeys(workflow.pick)" :key="i">
            <span v-if="p.type === 'sep'" class="ks-sep">{{ p.value }}</span>
            <template v-else>
              <span v-if="p.plus" class="ks-plus">+</span><kbd>{{ p.value }}</kbd>
            </template>
          </template>
        </span>
        <span class="ks-callout-text">{{ $t('settings.shortcuts.callout.pick') }}</span>
      </div>
      <div class="ks-callout-row">
        <span class="ks-keys">
          <template v-for="(p, i) in parseKeys(workflow.spawn)" :key="i">
            <span v-if="p.type === 'sep'" class="ks-sep">{{ p.value }}</span>
            <template v-else>
              <span v-if="p.plus" class="ks-plus">+</span><kbd>{{ p.value }}</kbd>
            </template>
          </template>
        </span>
        <span class="ks-callout-text">{{ $t('settings.shortcuts.callout.spawn') }}</span>
      </div>
    </div>

    <!-- Context legend -->
    <div class="ks-legend">
      <span v-for="id in ctxIds" :key="id" class="ks-legend-item">
        <span class="ks-badge">{{ id }}</span>
        <span class="ks-legend-label">{{ $t('settings.shortcuts.ctx.' + id) }}</span>
      </span>
    </div>

    <!-- Shortcut blocks -->
    <section v-for="block in blocks" :key="block.titleKey" class="ks-block">
      <h3 class="ks-block-title">{{ $t(block.titleKey) }}</h3>
      <p v-if="block.noteKey" class="ks-block-note">{{ $t(block.noteKey) }}</p>
      <div class="ks-table-scroll">
        <table class="ks-table">
          <thead>
            <tr>
              <th class="ks-th-keys">{{ $t('settings.shortcuts.col.keys') }}</th>
              <th>{{ $t('settings.shortcuts.col.desc') }}</th>
              <th class="ks-th-ctx">{{ $t('settings.shortcuts.col.context') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="(row, i) in block.rows" :key="i">
              <td class="ks-td-keys">
                <span class="ks-keys">
                  <template v-for="(p, j) in parseKeys(row.keys)" :key="j">
                    <span v-if="p.type === 'sep'" class="ks-sep">{{ p.value }}</span>
                    <template v-else>
                      <span v-if="p.plus" class="ks-plus">+</span><kbd>{{ p.value }}</kbd>
                    </template>
                  </template>
                </span>
              </td>
              <td class="ks-td-desc">{{ row.desc }}</td>
              <td class="ks-td-ctx">
                <span v-for="c in row.ctx" :key="c" class="ks-badge">{{ c }}</span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>
  </div>
</template>

<style scoped>
.ks {
  display: flex;
  flex-direction: column;
  gap: 18px;
  color: var(--text-primary);
}

.ks-intro {
  margin: 0;
  font-size: 13px;
  color: var(--text-secondary);
  max-width: 70ch;
  line-height: 1.55;
}

/* ── workflow callout ── */
.ks-callout {
  border: 1px solid var(--accent-muted);
  background: var(--accent-subtle);
  border-radius: 8px;
  padding: 14px 16px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.ks-callout-title {
  font-size: 12px;
  font-weight: 600;
  color: var(--accent-fg);
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
.ks-callout-row {
  display: flex;
  gap: 10px;
  align-items: baseline;
  flex-wrap: wrap;
}
.ks-callout-text {
  font-size: 13px;
  color: var(--text-primary);
}

/* ── context legend ── */
.ks-legend {
  display: flex;
  flex-wrap: wrap;
  gap: 6px 14px;
  padding: 12px 14px;
  background: var(--bg-inset);
  border: 1px solid var(--border-muted);
  border-radius: 8px;
}
.ks-legend-item {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--text-secondary);
}

/* ── blocks ── */
.ks-block {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.ks-block-title {
  margin: 0;
  font-size: 12px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--text-muted);
}
.ks-block-note {
  margin: 0 0 2px;
  font-size: 12px;
  color: var(--text-secondary);
  line-height: 1.5;
  max-width: 72ch;
}

/* ── table ── */
.ks-table-scroll {
  overflow-x: auto;
  border: 1px solid var(--border-muted);
  border-radius: 8px;
  background: var(--bg-subtle);
}
.ks-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
}
.ks-table th {
  text-align: left;
  font-size: 10px;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--text-muted);
  font-weight: 600;
  padding: 8px 12px;
  border-bottom: 1px solid var(--border-default);
  white-space: nowrap;
}
.ks-table td {
  padding: 8px 12px;
  border-bottom: 1px solid var(--border-muted);
  vertical-align: top;
}
.ks-table tr:last-child td {
  border-bottom: none;
}
.ks-td-keys {
  white-space: nowrap;
}
.ks-td-desc {
  color: var(--text-secondary);
  min-width: 220px;
}
.ks-th-ctx {
  width: 1%;
}

/* ── key caps ── */
.ks-keys {
  display: inline-flex;
  gap: 3px;
  flex-wrap: wrap;
  align-items: center;
}
.ks-keys kbd {
  display: inline-block;
  padding: 1px 6px;
  border: 1px solid var(--border-default);
  border-bottom-width: 2px;
  border-radius: 5px;
  background: var(--bg-muted);
  color: var(--text-bright);
  font-size: 11.5px;
  font-weight: 600;
  font-family: monospace;
  line-height: 1.4;
  white-space: nowrap;
}
.ks-plus,
.ks-sep {
  color: var(--text-muted);
  font-size: 11px;
}
.ks-sep {
  padding: 0 2px;
}

/* ── context badge ── */
.ks-badge {
  display: inline-block;
  font-family: monospace;
  font-size: 10px;
  font-weight: 600;
  padding: 1px 6px;
  margin: 1px 2px 1px 0;
  border-radius: 999px;
  background: var(--bg-inset);
  border: 1px solid var(--border-muted);
  color: var(--text-secondary);
  white-space: nowrap;
}
.ks-legend-label {
  color: var(--text-secondary);
}
</style>
