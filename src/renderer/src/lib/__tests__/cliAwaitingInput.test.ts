import { describe, it, expect } from 'vitest'
import {
  notificationMeansAwaiting,
  notificationEndsAwaiting,
  hasAwaitingPattern,
  matchAwaitingInput,
  textEndsOnQuestion,
  questionActionFor,
  QUESTION_DETAIL,
} from '../cliAwaitingInput'

// AWAITING means "the CLI stopped and cannot continue until the user answers".
// Getting that wrong in either direction is costly: a missed prompt looks
// exactly like a finished turn, and a false one parks a free pane out of
// inter-CLI messaging and MCP dispatch.

describe('notificationMeansAwaiting — Claude hook types', () => {
  it('is true only for the types that block the turn', () => {
    expect(notificationMeansAwaiting('permission_prompt')).toBe(true)
    expect(notificationMeansAwaiting('elicitation_dialog')).toBe(true)
    expect(notificationMeansAwaiting('agent_needs_input')).toBe(true)
  })

  it('is false for idle_prompt', () => {
    // Regression: idle_prompt fires every time a turn ends and Claude waits for
    // the next instruction — the pane is genuinely idle. Accepting it would
    // light AWAITING after every single turn.
    expect(notificationMeansAwaiting('idle_prompt')).toBe(false)
  })

  it('is false for the informational types', () => {
    // These all report something that already finished.
    expect(notificationMeansAwaiting('auth_success')).toBe(false)
    expect(notificationMeansAwaiting('elicitation_complete')).toBe(false)
    expect(notificationMeansAwaiting('elicitation_response')).toBe(false)
    expect(notificationMeansAwaiting('agent_completed')).toBe(false)
  })

  it('is false when the field is missing or unrecognized', () => {
    // Fail-closed: the field is absent on Claude builds that predate it, and a
    // permissive default would treat every idle_prompt as awaiting.
    expect(notificationMeansAwaiting(undefined)).toBe(false)
    expect(notificationMeansAwaiting('')).toBe(false)
    expect(notificationMeansAwaiting('some_future_type')).toBe(false)
  })
})

describe('notificationEndsAwaiting — releasing a hook-set wait', () => {
  // A hook fires once and cannot re-check itself, so without an explicit
  // release the waits that end with no CLI output — an MCP form submitted, a
  // background session finishing, a turn ending on an unanswered prompt —
  // would hold AWAITING forever and keep the pane out of dispatch.
  it('is true for the types that mean the wait is over', () => {
    expect(notificationEndsAwaiting('idle_prompt')).toBe(true)
    expect(notificationEndsAwaiting('agent_idle')).toBe(true)
    expect(notificationEndsAwaiting('elicitation_complete')).toBe(true)
    expect(notificationEndsAwaiting('elicitation_response')).toBe(true)
    expect(notificationEndsAwaiting('agent_completed')).toBe(true)
  })

  it('is false for the types that START a wait', () => {
    expect(notificationEndsAwaiting('permission_prompt')).toBe(false)
    expect(notificationEndsAwaiting('elicitation_dialog')).toBe(false)
    expect(notificationEndsAwaiting('agent_needs_input')).toBe(false)
  })

  it('is false for unknown or missing types', () => {
    // Whitelist, not the negation of the awaiting set: clearing on unknown
    // values would let a future notification type silently cancel a real
    // permission prompt.
    expect(notificationEndsAwaiting(undefined)).toBe(false)
    expect(notificationEndsAwaiting('')).toBe(false)
    expect(notificationEndsAwaiting('some_future_type')).toBe(false)
  })

  it('never claims a type both starts and ends a wait', () => {
    for (const t of [
      'permission_prompt', 'elicitation_dialog', 'agent_needs_input',
      'idle_prompt', 'agent_idle', 'elicitation_complete',
      'elicitation_response', 'agent_completed', 'auth_success',
    ]) {
      expect(notificationMeansAwaiting(t) && notificationEndsAwaiting(t)).toBe(false)
    }
  })
})

// The strings below are verbatim captures from each CLI, not paraphrases —
// they are what the pattern has to survive.

describe('matchAwaitingInput — aider (line-mode prompts)', () => {
  it('matches every confirmation shape aider asks', () => {
    const prompts = [
      "Add file to the chat? (Y)es/(N)o/(A)ll/(S)kip all/(D)on't ask again [Yes]:",
      "Run shell command? (Y)es/(N)o/(S)kip all/(D)on't ask again [Yes]:",
      'Allow edits to file that has not been added to the chat? (Y)es/(N)o [Yes]:',
      'Create new file? (Y)es/(N)o [Yes]:',
    ]
    for (const prompt of prompts) {
      expect(matchAwaitingInput('aider', `some earlier output\n${prompt}`)).toBe(true)
    }
  })

  it('stops matching once the answer scrolls the prompt off the tail', () => {
    // Aider is line-mode: the answered question stays in the scrollback. What
    // ends AWAITING is the prompt no longer being the last thing on screen.
    const answered =
      "Add file to the chat? (Y)es/(N)o/(A)ll/(S)kip all/(D)on't ask again [Yes]: y\n" +
      'Added main.py to the chat.'
    expect(matchAwaitingInput('aider', answered)).toBe(false)
  })

  it('does not match aider merely mentioning the choices mid-output', () => {
    expect(
      matchAwaitingInput('aider', 'I will ask (Y)es/(N)o [Yes]: before editing anything.'),
    ).toBe(false)
  })
})

describe('matchAwaitingInput — codex (full-screen dialog)', () => {
  it('matches all three approval dialogs', () => {
    const dialogs = [
      'Would you like to run the following command?',
      'Would you like to make the following edits?',
      'Would you like to grant these permissions?',
    ]
    for (const dialog of dialogs) {
      expect(matchAwaitingInput('codex', dialog)).toBe(true)
    }
  })

  it('matches on the option list alone, which every dialog shares', () => {
    // The question can scroll out of the 25 rendered lines when the dialog
    // carries a long diff; the options sit at the bottom and never do.
    const optionsOnly = [
      '  1. Yes, just this once',
      "  2. Yes, and don't ask again for this command in this session",
      '  3. No, and tell Codex what to do differently',
    ].join('\n')
    expect(matchAwaitingInput('codex', optionsOnly)).toBe(true)
  })

  it('survives the dialog being hard-wrapped by a narrow pane', () => {
    // The rendered text keeps the wrap; matching is whitespace-collapsed so a
    // phrase broken across two rows still matches.
    expect(matchAwaitingInput('codex', 'Would you like to\nrun the following\ncommand?')).toBe(true)
  })

  it('does not match ordinary codex output', () => {
    expect(matchAwaitingInput('codex', 'Running the following command: ls -la')).toBe(false)
  })
})

describe('matchAwaitingInput — vendors without a spec', () => {
  it('never matches for claude (it uses the hook instead)', () => {
    // claude must have no pattern: the poll watcher clears what it does not
    // match, so giving claude one would wipe the AWAITING its hook just set.
    expect(hasAwaitingPattern('claude')).toBe(false)
    expect(matchAwaitingInput('claude', 'Do you want to proceed? 1. Yes')).toBe(false)
  })

  it('never matches for an unknown agent key', () => {
    expect(hasAwaitingPattern('not-a-real-cli')).toBe(false)
    expect(matchAwaitingInput('not-a-real-cli', 'anything at all')).toBe(false)
  })
})

// QUESTION's text half. A turn that ends on "shall I go ahead?" is not idle,
// but nothing in the log says so — only the prose does.
describe('textEndsOnQuestion', () => {
  it('is true when the closing line ends on a question mark', () => {
    expect(textEndsOnQuestion('Done. Want me to commit this?')).toBe(true)
    expect(textEndsOnQuestion('全部修好了。要我接著發版嗎？')).toBe(true)
  })

  it('accepts the full-width question mark on its own', () => {
    expect(textEndsOnQuestion('要選哪一個？')).toBe(true)
  })

  it('is false for a statement', () => {
    expect(textEndsOnQuestion('All 3937 tests pass.')).toBe(false)
    expect(textEndsOnQuestion('已經全部修好了。')).toBe(false)
  })

  it('judges the LAST line, not the whole turn', () => {
    // The event carries the entire assistant message. A rhetorical "?" in the
    // body must not light the badge on a turn that asks nothing at the end.
    expect(textEndsOnQuestion('So why did it fail?\nBecause the lock was held.')).toBe(false)
    // ...and a question at the end still counts however long the body is.
    expect(textEndsOnQuestion('Line one.\nLine two.\nShould I proceed?')).toBe(true)
  })

  it('sees through trailing blank lines', () => {
    expect(textEndsOnQuestion('Ready to go?\n\n  \n')).toBe(true)
  })

  it('sees through markdown emphasis and closing brackets', () => {
    expect(textEndsOnQuestion('**Which one do you want?**')).toBe(true)
    expect(textEndsOnQuestion('- Ship it now?')).toBe(true)
    expect(textEndsOnQuestion('He asked "are we done?"')).toBe(true)
  })

  it('is false for empty text', () => {
    // Stop-hook / thinking-only turn_complete events carry no text at all.
    expect(textEndsOnQuestion('')).toBe(false)
    expect(textEndsOnQuestion('   \n\n')).toBe(false)
  })
})

// The seam where both halves of QUESTION meet. App.vue's agent.activity handler
// is a closure inside an SFC the suite cannot mount, so the rules live here and
// the handler is a two-line adapter over them — this describe block is what
// actually exercises the wiring rather than reading it.
describe('questionActionFor — activity event → QUESTION badge', () => {
  it('raises on the AskUserQuestion box (which never produces a turn_complete)', () => {
    expect(questionActionFor({ event_type: 'agent_active', detail: QUESTION_DETAIL })).toBe('raise')
  })

  it('raises on the named signal whichever event type a vendor attaches it to', () => {
    // Regression: the two vendors that emit assistant:question disagree about
    // the type. Claude's AskUserQuestion pauses a turn that continues, so its
    // reader calls it agent_active (cli_vendors/claude.py); antigravity treats
    // an ask_question step as the end of the turn and reports turn_complete
    // (cli_vendors/antigravity.py, pinned by test_antigravity_activity.py).
    // Reading the type first meant antigravity's event — which carries no text
    // — scored as "did not end on a question" and CLEARED the badge, so its one
    // reliable signal actively extinguished the state it should have raised.
    expect(
      questionActionFor({ event_type: 'turn_complete', detail: QUESTION_DETAIL, text: '' })
    ).toBe('raise')
  })

  it('lets the named signal beat the text of the same event', () => {
    // Should a vendor ever send both, the structured claim is the reliable one.
    expect(
      questionActionFor({
        event_type: 'turn_complete',
        detail: QUESTION_DETAIL,
        text: 'All done, nothing left.',
      })
    ).toBe('raise')
  })

  it('raises on a turn that ended on a question', () => {
    expect(
      questionActionFor({ event_type: 'turn_complete', text: 'Done. Want me to commit?' })
    ).toBe('raise')
  })

  it('clears on a turn that ended on anything else', () => {
    expect(questionActionFor({ event_type: 'turn_complete', text: 'All done.' })).toBe('clear')
  })

  it('clears on an empty-text turn_complete rather than inheriting a verdict', () => {
    // Stop-hook and thinking-only turns carry no text. Treating "no text" as a
    // question would strand the badge; carrying the last turn's answer forward
    // would report a question that was already answered.
    expect(questionActionFor({ event_type: 'turn_complete' })).toBe('clear')
    expect(questionActionFor({ event_type: 'turn_complete', text: '' })).toBe('clear')
  })

  it("clears on the answer coming back, in every vendor's spelling", () => {
    for (const detail of ['user', 'prompt', 'user_message']) {
      expect(questionActionFor({ event_type: 'agent_active', detail })).toBe('clear')
    }
  })

  it('leaves the badge alone for ordinary activity', () => {
    // The common case by far: tool calls and assistant chatter. Clearing here
    // would drop the badge the moment anything else happened in the pane —
    // and an AskUserQuestion box emits a plain `assistant` event alongside the
    // question one, so "clear on unknown" would cancel it immediately.
    expect(questionActionFor({ event_type: 'agent_active', detail: 'assistant' })).toBeNull()
    expect(questionActionFor({ event_type: 'agent_active', detail: 'tool_use' })).toBeNull()
    expect(questionActionFor({ event_type: 'agent_active', detail: 'hook:pre_tool_use' })).toBeNull()
    expect(questionActionFor({ event_type: 'agent_active' })).toBeNull()
  })

  it('ignores event types it has no opinion about', () => {
    expect(questionActionFor({ event_type: 'something_new' })).toBeNull()
    expect(questionActionFor({ event_type: 'something_new', detail: 'assistant' })).toBeNull()
    expect(questionActionFor({})).toBeNull()
  })

  it('still honours the named signal on an event type it does not recognise', () => {
    // Deliberately NOT fail-closed, and the assertion here used to say the
    // opposite. Being strict about the event type is exactly what silenced
    // antigravity: a vendor that names the situation has told us more than the
    // envelope it arrived in, and the next vendor to add this signal should not
    // have to also match a type this function happens to know about.
    expect(questionActionFor({ event_type: 'something_new', detail: QUESTION_DETAIL })).toBe(
      'raise'
    )
  })

  it('matches the detail string the claude reader actually emits', () => {
    // Cross-end contract: backend/agent_team_backend/cli_vendors/claude.py
    // writes this literal, and backend/tests/vendors/test_claude.py asserts it.
    expect(QUESTION_DETAIL).toBe('assistant:question')
  })
})
