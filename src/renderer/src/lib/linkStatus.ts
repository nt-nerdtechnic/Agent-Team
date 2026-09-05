// Two decisions the connection surfaces make about *which sentence to show*.
//
// Both used to live inline in a component, which meant the only thing a test
// could check was that the strings were still in the file — so a classifier
// wired to the wrong branch passed, and the test's own name claimed otherwise.
// Here they are inputs and outputs, and a test can say what each input produces.
//
// Neither reads or writes anything: they map a value the backend already sends
// to an i18n key the caller renders. No field, no behaviour, no request.

/** Keys under `settings.p2p.` that a socket failure can map to. */
export type LinkErrorKey =
  | 'err-timeout'
  | 'err-refused'
  | 'err-dns'
  | 'err-tls'
  | 'err-reset'

/**
 * Which sentence explains this socket error, or `null` to show it verbatim.
 *
 * `ConnectionRefusedError` is precise and answers a question nobody asked:
 * what a person needs is whether to wait, check the address, or sign in again.
 * Matching is done on the text because that text is all the backend sends —
 * deliberately, since only the surface knows what language the window is in.
 *
 * `null` for anything this build has never seen: inventing a friendly sentence
 * for an unknown failure replaces the only clue with a guess.
 */
export function linkErrorKey(raw: string): LinkErrorKey | null {
  const lowered = (raw || '').toLowerCase()
  if (!lowered) return null
  if (lowered.includes('timed out') || lowered.includes('timeout')) return 'err-timeout'
  if (lowered.includes('refused')) return 'err-refused'
  if (
    lowered.includes('getaddrinfo') ||
    lowered.includes('nodename') ||
    lowered.includes('gaierror')
  ) {
    return 'err-dns'
  }
  if (lowered.includes('certificate') || lowered.includes('ssl') || lowered.includes('tls')) {
    return 'err-tls'
  }
  if (lowered.includes('reset') || lowered.includes('broken pipe')) return 'err-reset'
  return null
}

/** Keys under `settings.p2p.` for why a rules control is off. */
export type DisabledReasonKey = 'policy.saving' | 'policy.readonly-short'

/**
 * Why a control on the rules page is disabled, or `null` when it is not.
 *
 * Three different reasons wore one sentence: the link is not up, a save is in
 * flight, or the policy is not ours to edit. Telling all three "not connected"
 * sends two of them to check the network.
 *
 * `linkReason` comes first and is returned as-is, because the caller already
 * has a sentence for it — the link's own state is the one reason with a
 * countdown and a detail attached.
 */
export function disabledReasonKey(state: {
  linkReason: string
  busy: boolean
  editable: boolean
}): string | DisabledReasonKey | null {
  if (state.linkReason) return state.linkReason
  if (state.busy) return 'policy.saving'
  if (!state.editable) return 'policy.readonly-short'
  return null
}
