// Shared reactive view of the prompt skill list.
//
// Module-level state on purpose: the ∞ picker in every pane and the Prompts
// settings pane must see the same list, and a save in one has to show up in
// the others without prop plumbing through App.vue.
import { readonly, ref } from 'vue'
import { onSettingsChanged } from '../lib/settings'
import { LOOP_PROMPT_SETTING_KEY } from '../lib/loopPrompt'
import {
  PROMPT_SKILLS_SETTING_KEY,
  loadPromptSkills,
  savePromptSkills,
  type PromptSkill,
} from '../lib/promptSkills'

const skills = ref<PromptSkill[]>([])
let started = false

/** Re-read from the settings cache. Safe to call repeatedly. */
export function reloadPromptSkills(): void {
  skills.value = loadPromptSkills()
}

function start(): void {
  if (started) return
  started = true
  reloadPromptSkills()
  // Another window (or the settings pane) writing the key must be reflected
  // here — settings broadcasts land in every renderer.
  //
  // The legacy key matters too: this module is imported before the settings
  // cache has reconciled with the backend, so the first read can only see the
  // builtin default. When the reconcile then delivers the user's own
  // loop-prompt-text, the migration has to run again or an upgrading user
  // silently loses their edited prompt.
  onSettingsChanged((keys) => {
    if (keys.includes(PROMPT_SKILLS_SETTING_KEY) || keys.includes(LOOP_PROMPT_SETTING_KEY)) {
      reloadPromptSkills()
    }
  })
}

export function usePromptSkills(): {
  skills: Readonly<typeof skills>
  save: (next: readonly PromptSkill[]) => void
} {
  start()
  return {
    skills: readonly(skills) as Readonly<typeof skills>,
    save(next: readonly PromptSkill[]) {
      // savePromptSkills normalizes; adopt what it actually stored so the UI
      // never shows a list the store disagrees with.
      skills.value = savePromptSkills(next)
    },
  }
}
