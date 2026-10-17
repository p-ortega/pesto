// The one store every view shares. set() applies a patch right away, so
// get() is always current; subscribers hear about it once per frame.
// A set that changes nothing wakes nobody.

import { applyPatch, sameReals, sameSelection, sameSet, type SharedSelection } from './rules'

export interface SelectionStoreOptions {
  /** The selection the store starts with. */
  initial: SharedSelection
  /** Runs `run` later, once per batch. Default: requestAnimationFrame, else
   *  queueMicrotask. Tests pass a hand-stepped one. */
  schedule?: (run: () => void) => void
}

export interface SelectionStore {
  get(): SharedSelection
  /** Applies the patch now. `origin` names the view that wrote it. */
  set(patch: Partial<SharedSelection>, origin: string): void
  subscribe<T>(
    selector: (s: SharedSelection) => T,
    listener: (next: SharedSelection, prev: SharedSelection, origins: ReadonlySet<string>) => void,
  ): () => void
  /** Delivers the pending batch now instead of waiting for the scheduler. */
  flush(): void
}

function defaultSchedule(run: () => void): void {
  if (typeof requestAnimationFrame === 'function') {
    requestAnimationFrame(() => run())
  } else {
    queueMicrotask(run)
  }
}

interface Subscriber {
  selector: (s: SharedSelection) => unknown
  listener: (next: SharedSelection, prev: SharedSelection, origins: ReadonlySet<string>) => void
}

function isSet(value: unknown): value is ReadonlySet<unknown> {
  return value instanceof Set
}

function sameValue(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true
  if (isSet(a) && isSet(b)) return sameSet(a, b)
  if ((a === 'all' && isSet(b)) || (isSet(a) && b === 'all')) return sameReals(a as 'all', b as ReadonlySet<string>)
  return false
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

// Shallow: primitives by Object.is, plain objects key by key, sets by members.
function sameSlice(a: unknown, b: unknown): boolean {
  if (sameValue(a, b)) return true
  if (!isPlainObject(a) || !isPlainObject(b)) return false
  const keysA = Object.keys(a)
  if (keysA.length !== Object.keys(b).length) return false
  return keysA.every((key) => key in b && sameValue(a[key], b[key]))
}

export function createSelectionStore(opts: SelectionStoreOptions): SelectionStore {
  const schedule = opts.schedule ?? defaultSchedule
  let current = opts.initial
  let batchStart: SharedSelection | null = null
  let origins = new Set<string>()
  let flushScheduled = false
  const subscribers: Subscriber[] = []

  function set(patch: Partial<SharedSelection>, origin: string): void {
    const next = applyPatch(current, patch)
    if (sameSelection(next, current)) return
    if (batchStart === null) batchStart = current
    origins.add(origin)
    current = next
    if (!flushScheduled) {
      flushScheduled = true
      schedule(flush)
    }
  }

  // Echo rule: a view skips a call only when its own tag is the only origin.
  function flush(): void {
    flushScheduled = false
    const prev = batchStart
    const batchOrigins = origins
    // Cleared first, so a set made inside a listener starts a new batch.
    batchStart = null
    origins = new Set<string>()
    if (prev === null) return
    const next = current
    let firstError: unknown
    let failed = false
    for (const subscriber of [...subscribers]) {
      if (!subscribers.includes(subscriber)) continue
      if (sameSlice(subscriber.selector(prev), subscriber.selector(next))) continue
      try {
        subscriber.listener(next, prev, batchOrigins)
      } catch (error) {
        if (!failed) {
          failed = true
          firstError = error
        }
      }
    }
    if (failed) throw firstError
  }

  function subscribe(
    selector: (s: SharedSelection) => unknown,
    listener: Subscriber['listener'],
  ): () => void {
    const subscriber: Subscriber = { selector, listener }
    subscribers.push(subscriber)
    return () => {
      const at = subscribers.indexOf(subscriber)
      if (at >= 0) subscribers.splice(at, 1)
    }
  }

  return { get: () => current, set, subscribe, flush }
}
