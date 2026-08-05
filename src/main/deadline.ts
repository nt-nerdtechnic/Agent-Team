/**
 * Bounded waits for shutdown steps.
 *
 * Each step gets its OWN deadline. Sharing one timer across several awaits (the
 * shape this replaced) silently rebudgets them: a slow first step consumes the
 * allowance the later ones were sized for — and the step that pays for it here
 * is stopping the backend, which must outlast its own SIGTERM grace or its PTY
 * children are orphaned.
 */

/**
 * Await `work`, giving up after `ms`. Resolves either way — a rejection is a
 * finished step, not a reason to abort the shutdown — and always clears its
 * timer so a pending wait cannot keep the process alive.
 */
export async function withDeadline(work: Promise<unknown>, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      work.then(() => undefined, () => undefined),
      new Promise<void>((resolve) => { timer = setTimeout(resolve, ms) }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}
