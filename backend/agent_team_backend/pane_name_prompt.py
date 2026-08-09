"""Pane auto-name prompt assembly.

Mirrors the structure of :mod:`commit_message_prompt` (fenced ```text output,
parsed back out with the same regex shape) because both talk to the same local
Ollama endpoint and the smaller models answer far more reliably when every
prompt in the app asks for output the same way.

The task is different, though: a commit message summarises a diff, while this
summarises the *intent* of a developer's first instruction to a CLI agent, and
its output has to survive in a narrow tab label. Hence the hard length rule and
the "no trailing punctuation" rule.
"""

from __future__ import annotations

import re

# Keep in sync with MAX_TITLE in src/renderer/src/lib/autoName.ts — the
# heuristic and the LLM feed the same field, and a title that fits one but not
# the other would make the upgrade visibly reflow the tab.
MAX_TITLE_CHARS = 60

# Upper bound on the material handed to the model. The renderer already caps
# what it sends, so this only guards a malformed or hand-crafted request.
MAX_MATERIAL_CHARS = 2000

SYSTEM_PROMPT = (
    "You name work sessions. Given a developer's first instruction to a coding "
    "agent, you produce a short title for the tab that session runs in.\n\n"
    "# Think step-by-step:\n"
    "1. Read the INSTRUCTION and identify the concrete task it asks for.\n"
    "2. Identify what the task acts on — the feature, file, component, or bug.\n"
    "3. Ignore politeness, greetings, meta-instructions about how to answer, "
    "and any pasted logs or code; they are context, not the task.\n"
    "4. Write a title naming the task and its target, starting with a verb "
    "where that reads naturally.\n\n"
    "# Rules:\n"
    "- LANGUAGE: write the title in the SAME language as the INSTRUCTION. If "
    "the instruction is in Chinese, the title must be in Chinese. If it is in "
    "Japanese, the title must be in Japanese. Never translate it to English.\n"
    "- SCRIPT: match the instruction's writing system exactly. Traditional "
    "Chinese input gets a Traditional Chinese title (修復, 連線, 錯誤) — never "
    "Simplified (修复, 连线, 错误), and never the reverse.\n"
    "- At most 6 words and at most 50 characters.\n"
    "- No trailing period. No quotes around the title. No markdown.\n"
    "- Never answer the instruction, ask a question, or explain yourself.\n"
    "- If the instruction is too vague to name, output the single word UNCLEAR.\n"
    "- Output ONLY the title inside a single ```text code block.\n\n"
    "# Examples:\n"
    "INSTRUCTION: 請幫我修登入頁面一直跳轉的問題\n"
    "```text\n"
    "修復登入頁面跳轉\n"
    "```\n\n"
    "INSTRUCTION: Can you please add a dark mode toggle to the settings page\n"
    "```text\n"
    "Add dark mode toggle\n"
    "```"
)

_TEXT_BLOCK_RE = re.compile(r"```(?:text)?\s*\n?([\s\S]+?)\n?```")

# The model was told to answer UNCLEAR when it cannot name the material; treat
# that as "no answer" so the caller keeps the heuristic title.
_REFUSAL = "unclear"


def build_user_prompt(material: str) -> str:
    """Wrap the developer's instruction in the section the system prompt names."""
    return "# INSTRUCTION:\n" + material[:MAX_MATERIAL_CHARS].strip()


def parse_title(raw: str) -> str:
    """Pull the title out of a model response, or '' when there isn't one.

    Small local models leak prose around the fence, answer with the fence
    missing entirely, or wrap the title in quotes — all three are recovered
    here, because the alternative is silently falling back to the heuristic
    over a formatting slip.
    """
    match = _TEXT_BLOCK_RE.search(raw)
    text = (match.group(1) if match else raw).strip()
    if not text:
        return ""
    # A leaked explanation follows the title on later lines; the title is the
    # first non-empty one.
    title = next((ln.strip() for ln in text.splitlines() if ln.strip()), "")
    title = title.strip("\"'`").strip()
    title = title.rstrip(".。!！")
    if not title or title.lower() == _REFUSAL:
        return ""
    return title[:MAX_TITLE_CHARS]
