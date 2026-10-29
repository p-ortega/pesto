// The one modifier rule every click handler uses, so no view does its own set arithmetic.
// Alt (option on macOS) wins when shift is held too.

import type { SelectMode } from './rules'

export function modeOf(e: { altKey: boolean; shiftKey: boolean }): SelectMode {
  if (e.altKey) return 'remove'
  return e.shiftKey ? 'add' : 'replace'
}

/** The remove key's name on the user's keyboard, for tooltips and hints. */
export function removeKeyName(): 'Option' | 'Alt' {
  if (typeof navigator === 'undefined') return 'Alt'
  // userAgentData is missing from some browsers and from the DOM types, so it is read through a local type.
  const hinted = (navigator as { userAgentData?: { platform?: string } }).userAgentData?.platform ?? ''
  // Case-blind because client hints say macOS and the old platform string says MacIntel.
  return /mac/i.test(hinted) || /mac/i.test(navigator.platform ?? '') ? 'Option' : 'Alt'
}
