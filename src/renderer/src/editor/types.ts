/**
 * AI Native Editor — shared type contract.
 *
 * All positions are zero-based: `line` indexes into the model's line array,
 * `col` is a UTF-16 code-unit offset within that line (0 = before first char).
 * A Range is half-open at the end like DOM/Monaco selections.
 */

export interface Position {
  line: number
  col: number
}

export interface Range {
  start: Position
  end: Position
}

/** Replace the text covered by `range` with `text` (which may contain "\n"). */
export interface EditOperation {
  range: Range
  text: string
}

/** Result of applying an edit: the inverse edit (for undo) + the new caret. */
export interface AppliedEdit {
  inverse: EditOperation
  /** Where the caret should sit after the edit (end of inserted text). */
  caret: Position
}

// ── Tokenizer ────────────────────────────────────────────────────────────────

export type TokenType =
  | 'keyword'
  | 'string'
  | 'comment'
  | 'number'
  | 'function'
  | 'operator'
  | 'type'
  | 'variable'
  | 'invalid'
  | 'text'

/** A token spans cols [start, end) on a single line. */
export interface Token {
  start: number
  end: number
  type: TokenType
}

/**
 * Opaque carry-over state between lines (e.g. "inside a block comment").
 * `0` is the default/clean state.
 */
export type TokenizerState = number

export interface LineTokens {
  tokens: Token[]
  endState: TokenizerState
}

export interface Tokenizer {
  /** Initial state for the first line. */
  initialState(): TokenizerState
  /** Tokenize one line given the previous line's end state. */
  tokenizeLine(line: string, startState: TokenizerState): LineTokens
}

// ── Decorations ──────────────────────────────────────────────────────────────

export type DecorationType =
  | 'line-add'      // whole-line added (AI diff)
  | 'line-del'      // whole-line removed (AI diff)
  | 'inline-add'    // inline range added
  | 'inline-del'    // inline range removed
  | 'ghost'         // ghost (suggested) text shown inline, not in the model
  | 'highlight'     // generic selection/emphasis background
  | 'conflict-ours'   // merge conflict: the current (HEAD) side
  | 'conflict-base'   // merge conflict: the diff3 common-ancestor side
  | 'conflict-theirs' // merge conflict: the incoming side

export interface Decoration {
  id: string
  range: Range
  type: DecorationType
  /** For 'ghost' decorations: the suggested text rendered after range.start. */
  text?: string
  className?: string
}

// ── AI edit proposals ────────────────────────────────────────────────────────

/** One contiguous proposed change the user can accept or reject. */
export interface AiHunk {
  id: string
  range: Range        // the region in the current document being replaced
  oldText: string     // current text of that region (for the red side)
  newText: string     // proposed replacement (for the green side)
}
