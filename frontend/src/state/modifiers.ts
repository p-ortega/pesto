// The one modifier rule every click handler uses, so no view does its own set arithmetic.
// Alt (option on macOS) wins when shift is held too.

import type { SelectMode } from './rules'

export function modeOf(e: { altKey: boolean; shiftKey: boolean }): SelectMode {
  if (e.altKey) return 'remove'
  return e.shiftKey ? 'add' : 'replace'
}
