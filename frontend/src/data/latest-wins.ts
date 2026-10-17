// One keyed, abortable fetch slot. Starting a new request aborts the old
// one, and any answer whose key is no longer current comes back stale. The
// key check is the guard; the abort only saves work, and a loader may
// ignore the signal without ever showing a stale answer.

export type LatestResult<T> = { stale: true } | { stale: false; value: T }

export function isAbortError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { name?: unknown }).name === 'AbortError'
}

export class LatestWins<T> {
  private currentKey: string | null = null
  private serial = 0
  private controller: AbortController | null = null

  current(): string | null {
    return this.currentKey
  }

  // Same key twice still counts as a new request: the serial tells them apart.
  async run(key: string, load: (signal: AbortSignal) => Promise<T>): Promise<LatestResult<T>> {
    this.controller?.abort()
    const controller = new AbortController()
    const mine = ++this.serial
    this.controller = controller
    this.currentKey = key
    const isCurrent = () => this.serial === mine && this.currentKey === key
    try {
      const value = await load(controller.signal)
      return isCurrent() ? { stale: false, value } : { stale: true }
    } catch (error) {
      // An aborted or superseded request is not a failure the user should see.
      if (isAbortError(error) || !isCurrent()) return { stale: true }
      throw error
    }
  }

  cancel(): void {
    this.controller?.abort()
    this.controller = null
    this.currentKey = null
    this.serial += 1
  }
}
