// @vitest-environment jsdom
//
// Real jsdom (approved after a package-legitimacy gate, 82a7a98), not the
// hand-rolled stand-in under tests/support/dom.ts -- that stand-in is
// scoped to what Plan 05-08's screen touches and is scheduled for
// deletion, not something this plan should extend.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mountEstimate, mountProgress } from '../src/ui/progress'

function jsonResponse(status: number, body: unknown) {
  return { ok: status >= 200 && status < 300, status, json: async () => body }
}

function scriptedReader(chunks: Uint8Array[]) {
  let index = 0
  return {
    read: async () => {
      if (index < chunks.length) {
        const value = chunks[index]
        index += 1
        return { done: false, value }
      }
      return { done: true, value: undefined }
    },
    releaseLock: () => undefined,
  }
}

const encoder = new TextEncoder()

function progressFrame(overrides: Record<string, unknown> = {}): string {
  const row = {
    artifact: 'grid',
    state: 'ok',
    index: 0,
    total: 1,
    source_bytes: 2048,
    written_bytes: 2048,
    seconds: 1.5,
    reason: null,
    notes: [],
    ...overrides,
  }
  return `data: ${JSON.stringify(row)}\n\n`
}

function doneFrame(): string {
  return 'event: done\ndata: {}\n\n'
}

const defaultEstimate = {
  total: 10 * 1024 * 1024,
  per_artifact: [{ name: 'grid', bytes: 5 * 1024 * 1024 }],
  notes: ['control could not be sized: the .pst file carries no signal about table size'],
  free_bytes: 100 * 1024 * 1024,
  cache_root_exists: true,
}

const availableState = {
  fresh: true,
  artifacts: [],
  capabilities: {
    map: { available: true, blocked_by: [] },
    stats: { available: true, blocked_by: [] },
    chips: { available: true, blocked_by: [] },
  },
  ingest_seconds: 12.4,
  cache_bytes: 42 * 1024 * 1024,
}

const partialState = {
  fresh: false,
  artifacts: [],
  capabilities: {
    map: { available: true, blocked_by: [] },
    stats: {
      available: false,
      blocked_by: [{ artifact: 'par_agg/head', reason: 'the aggregation step crashed reading iteration 3' }],
    },
    chips: { available: true, blocked_by: [] },
  },
  ingest_seconds: 8.1,
  cache_bytes: 20 * 1024 * 1024,
}

interface FetchScript {
  estimate?: unknown
  state?: unknown
  streamText?: string
  streamChunks?: Uint8Array[]
  startStatus?: number
  cancelStatus?: number
}

function buildFetchStub(script: FetchScript) {
  const calls: { pathname: string; method: string; signal?: AbortSignal | null }[] = []
  const stub = vi.fn(async (input: string, init?: RequestInit) => {
    const url = new URL(input, 'http://localhost')
    const method = init?.method ?? 'GET'
    calls.push({ pathname: url.pathname, method, signal: init?.signal })

    if (url.pathname === '/api/run/ingest/estimate') {
      return jsonResponse(200, script.estimate ?? defaultEstimate)
    }
    if (url.pathname === '/api/run/ingest/state') {
      return jsonResponse(200, script.state ?? availableState)
    }
    if (url.pathname === '/api/run/ingest' && method === 'POST') {
      if (script.startStatus && script.startStatus >= 400) {
        return jsonResponse(script.startStatus, { type: 'about:blank', title: 'could not start', status: script.startStatus })
      }
      return jsonResponse(202, { started: true })
    }
    if (url.pathname === '/api/run/ingest/cancel' && method === 'POST') {
      if (script.cancelStatus && script.cancelStatus >= 400) {
        return jsonResponse(script.cancelStatus, { type: 'about:blank', title: 'could not cancel', status: script.cancelStatus })
      }
      return jsonResponse(202, { cancelling: true })
    }
    if (url.pathname === '/api/run/ingest/events') {
      const chunks = script.streamChunks ?? [encoder.encode(script.streamText ?? doneFrame())]
      return { ok: true, status: 200, body: { getReader: () => scriptedReader(chunks) } }
    }
    throw new Error(`unhandled request in test fixture: ${url.pathname}`)
  })
  return { stub, calls }
}

async function settle(): Promise<void> {
  for (let i = 0; i < 6; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
}

function collectAll(el: HTMLElement): HTMLElement[] {
  const result: HTMLElement[] = [el]
  for (const child of Array.from(el.children)) {
    result.push(...collectAll(child as HTMLElement))
  }
  return result
}

function textOf(el: HTMLElement): string {
  return el.textContent ?? ''
}

function findButtons(el: HTMLElement): HTMLButtonElement[] {
  return collectAll(el).filter((node): node is HTMLButtonElement => node.tagName === 'BUTTON')
}

const PATH_PATTERN = /(^|\s)(\/[\w.-]+){2,}/
const WINDOWS_PATH_PATTERN = /[A-Za-z]:\\/

beforeEach(() => {
  vi.stubGlobal('matchMedia', () => ({
    matches: false,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }))
  vi.stubGlobal('localStorage', {
    getItem: () => null,
    setItem: () => undefined,
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
  document.body.textContent = ''
})

describe('mountEstimate', () => {
  it('issues no request to the start route on mount', async () => {
    const { stub, calls } = buildFetchStub({})
    vi.stubGlobal('fetch', stub)
    const root = document.createElement('div')
    await mountEstimate(root, { onAgree: () => undefined, onDecline: () => undefined })

    expect(calls.some((c) => c.pathname === '/api/run/ingest' && c.method === 'POST')).toBe(false)
  })

  it('renders every string in the estimate notes list, verbatim', async () => {
    const notes = ['note about control', 'note about par_agg', 'a third note entirely']
    const { stub } = buildFetchStub({ estimate: { ...defaultEstimate, notes } })
    vi.stubGlobal('fetch', stub)
    const root = document.createElement('div')
    await mountEstimate(root, { onAgree: () => undefined, onDecline: () => undefined })

    for (const note of notes) {
      expect(textOf(root)).toContain(note)
    }
  })

  it('marks the total as a projection, never as a measurement', async () => {
    const { stub } = buildFetchStub({})
    vi.stubGlobal('fetch', stub)
    const root = document.createElement('div')
    await mountEstimate(root, { onAgree: () => undefined, onDecline: () => undefined })

    expect(textOf(root)).toMatch(/projection/i)
  })

  it('says the free space is for a directory not yet created when the cache root does not exist', async () => {
    const { stub } = buildFetchStub({ estimate: { ...defaultEstimate, cache_root_exists: false } })
    vi.stubGlobal('fetch', stub)
    const root = document.createElement('div')
    await mountEstimate(root, { onAgree: () => undefined, onDecline: () => undefined })

    expect(textOf(root)).toMatch(/about to be created/)
  })

  it('warns but leaves agree enabled when free space is below the projected total', async () => {
    const { stub } = buildFetchStub({ estimate: { ...defaultEstimate, total: 200 * 1024 * 1024, free_bytes: 10 * 1024 * 1024 } })
    vi.stubGlobal('fetch', stub)
    const root = document.createElement('div')
    await mountEstimate(root, { onAgree: () => undefined, onDecline: () => undefined })

    expect(textOf(root)).toMatch(/larger than the free space|exceeds/i)
    const agree = findButtons(root).find((b) => b.textContent?.includes('Agree'))!
    expect(agree.disabled).toBe(false)
  })

  it('the agree control is reachable and Enter activates it', async () => {
    const { stub } = buildFetchStub({})
    vi.stubGlobal('fetch', stub)
    const root = document.createElement('div')
    let agreed = false
    await mountEstimate(root, { onAgree: () => (agreed = true), onDecline: () => undefined })

    const agree = findButtons(root).find((b) => b.textContent?.includes('Agree'))!
    expect(agree.tagName).toBe('BUTTON')
    agree.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }))
    expect(agreed).toBe(true)
  })

  it('the decline control is reachable and Enter activates it', async () => {
    const { stub } = buildFetchStub({})
    vi.stubGlobal('fetch', stub)
    const root = document.createElement('div')
    let declined = false
    await mountEstimate(root, { onAgree: () => undefined, onDecline: () => (declined = true) })

    const decline = findButtons(root).find((b) => b.textContent?.includes('Go back'))!
    decline.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }))
    expect(declined).toBe(true)
  })
})

describe('mountProgress', () => {
  let root: HTMLElement

  beforeEach(() => {
    root = document.createElement('div')
    document.body.appendChild(root)
  })

  it('renders a started row with the source size and an em dash for the written size and duration', async () => {
    const text = progressFrame({ artifact: 'grid', state: 'started', source_bytes: 4096, written_bytes: 0, seconds: 0 }) + doneFrame()
    const { stub } = buildFetchStub({ streamText: text })
    vi.stubGlobal('fetch', stub)

    mountProgress(root, { onFinished: () => undefined })
    await settle()

    const rowText = textOf(root)
    expect(rowText).toContain('grid')
    expect(rowText).toMatch(/4(\.0)? KB|4096 B/)
    expect(rowText).toContain('—')
  })

  it('renders an ok row with a genuine zero written size as zero, not a dash', async () => {
    const text = progressFrame({ artifact: 'grid', state: 'ok', source_bytes: 0, written_bytes: 0, seconds: 0.2 }) + doneFrame()
    const { stub } = buildFetchStub({ streamText: text })
    vi.stubGlobal('fetch', stub)

    mountProgress(root, { onFinished: () => undefined })
    await settle()

    expect(textOf(root)).toContain('0 B')
  })

  it('distinguishes a started em dash from an ok genuine zero across two different artifacts', async () => {
    const text =
      progressFrame({ artifact: 'grid', state: 'started', source_bytes: 1024, written_bytes: 0, seconds: 0 }) +
      progressFrame({ artifact: 'config', state: 'ok', source_bytes: 10, written_bytes: 0, seconds: 0.01 }) +
      doneFrame()
    const { stub } = buildFetchStub({ streamText: text })
    vi.stubGlobal('fetch', stub)

    mountProgress(root, { onFinished: () => undefined })
    await settle()

    const items = collectAll(root).filter((el) => el.tagName === 'LI')
    const gridRow = items.find((el) => textOf(el).includes('grid'))!
    const configRow = items.find((el) => textOf(el).includes('config'))!
    expect(textOf(gridRow)).toContain('—')
    expect(textOf(configRow)).not.toContain('—')
    expect(textOf(configRow)).toContain('0 B')
  })

  it('renders per-artifact rows in the order the stream produces them', async () => {
    const text =
      progressFrame({ artifact: 'control', state: 'ok' }) +
      progressFrame({ artifact: 'grid', state: 'ok' }) +
      progressFrame({ artifact: 'par_ens/head', state: 'ok' }) +
      doneFrame()
    const { stub } = buildFetchStub({ streamText: text })
    vi.stubGlobal('fetch', stub)

    mountProgress(root, { onFinished: () => undefined })
    await settle()

    const items = collectAll(root).filter((el) => el.tagName === 'LI')
    const order = items.map((el) => ['control', 'grid', 'par_ens/head'].find((name) => textOf(el).includes(name)))
    expect(order).toEqual(['control', 'grid', 'par_ens/head'])
  })

  it('renders a failed row in the critical status colour with the reason from the stream', async () => {
    const text = progressFrame({ artifact: 'par_agg/head', state: 'failed', reason: 'crashed reading iteration 3' }) + doneFrame()
    const { stub } = buildFetchStub({ streamText: text })
    vi.stubGlobal('fetch', stub)

    mountProgress(root, { onFinished: () => undefined })
    await settle()

    const items = collectAll(root).filter((el) => el.tagName === 'LI')
    const failedRow = items.find((el) => textOf(el).includes('par_agg/head'))!
    expect(failedRow.style.color).toContain('var(--status-critical)')
    expect(textOf(failedRow)).toContain('crashed reading iteration 3')
  })

  it('renders every per-artifact note from the stream', async () => {
    const text =
      progressFrame({
        artifact: 'par_ens/head',
        state: 'ok',
        notes: ['3 NaN values repaired in realization 12', 'group obs2 excluded'],
      }) + doneFrame()
    const { stub } = buildFetchStub({ streamText: text })
    vi.stubGlobal('fetch', stub)

    mountProgress(root, { onFinished: () => undefined })
    await settle()

    const items = collectAll(root).filter((el) => el.tagName === 'LI')
    const row = items.find((el) => textOf(el).includes('par_ens/head'))!
    expect(textOf(row)).toContain('3 NaN values repaired in realization 12')
    expect(textOf(row)).toContain('group obs2 excluded')
  })

  it('renders a skipped row distinctly from an ok row for the same artifact name', async () => {
    const okText = progressFrame({ artifact: 'grid', state: 'ok' }) + doneFrame()
    const { stub: okStub } = buildFetchStub({ streamText: okText })
    vi.stubGlobal('fetch', okStub)
    mountProgress(root, { onFinished: () => undefined })
    await settle()
    const okRowText = textOf(collectAll(root).find((el) => el.tagName === 'LI')!)

    vi.unstubAllGlobals()
    vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener: () => undefined, removeEventListener: () => undefined }))
    vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => undefined })
    const root2 = document.createElement('div')
    document.body.appendChild(root2)
    const skippedText = progressFrame({ artifact: 'grid', state: 'skipped' }) + doneFrame()
    const { stub: skippedStub } = buildFetchStub({ streamText: skippedText })
    vi.stubGlobal('fetch', skippedStub)
    mountProgress(root2, { onFinished: () => undefined })
    await settle()
    const skippedRowText = textOf(collectAll(root2).find((el) => el.tagName === 'LI')!)

    expect(skippedRowText).not.toBe(okRowText)
    expect(skippedRowText).toMatch(/already fresh/i)
  })

  it('activating cancel issues exactly one call to the cancel route, keeps every rendered row, and disables itself', async () => {
    // No done frame here -- the stream stays open so cancel can be tested
    // against a run still in progress.
    const text = progressFrame({ artifact: 'grid', state: 'ok' })
    const { stub, calls } = buildFetchStub({ streamText: text })
    vi.stubGlobal('fetch', stub)

    mountProgress(root, { onFinished: () => undefined })
    await settle()

    const cancelButton = findButtons(root).find((b) => b.textContent === 'Cancel')!
    cancelButton.dispatchEvent(new Event('click'))
    await settle()

    const cancelCalls = calls.filter((c) => c.pathname === '/api/run/ingest/cancel')
    expect(cancelCalls.length).toBe(1)
    expect(cancelButton.disabled).toBe(true)
    expect(textOf(root)).toContain('grid')
  })

  it('on the done frame with a capability blocked, names the blocking artifact and its reason and still calls onFinished', async () => {
    // The stream row is a different artifact ("grid") than the one the
    // blocked capability names ("par_agg/head"), so a notice missing the
    // blocked artifact's own name cannot hide behind text that came from
    // the row list instead.
    const text = progressFrame({ artifact: 'grid', state: 'ok' }) + doneFrame()
    const { stub } = buildFetchStub({ streamText: text, state: partialState })
    vi.stubGlobal('fetch', stub)

    let finished = false
    mountProgress(root, { onFinished: () => (finished = true) })
    await settle()

    const noticeArea = Array.from(root.children)[1] as HTMLElement
    expect(textOf(noticeArea)).toContain('par_agg/head')
    expect(textOf(noticeArea)).toContain('the aggregation step crashed reading iteration 3')
    expect(finished).toBe(true)
  })

  it('on the done frame with everything available, renders the recorded ingest seconds and cache bytes and calls onFinished', async () => {
    const text = progressFrame({ artifact: 'grid', state: 'ok' }) + doneFrame()
    const { stub } = buildFetchStub({ streamText: text, state: availableState })
    vi.stubGlobal('fetch', stub)

    let finished = false
    mountProgress(root, { onFinished: () => (finished = true) })
    await settle()

    expect(textOf(root)).toMatch(/12\.4/)
    expect(textOf(root)).toMatch(/42(\.0)? MB/)
    expect(finished).toBe(true)
  })

  it('tearing down mid-stream aborts the fetch signal and issues no call to the cancel route', async () => {
    const text = progressFrame({ artifact: 'grid', state: 'ok' })
    const { stub, calls } = buildFetchStub({ streamText: text })
    vi.stubGlobal('fetch', stub)

    const teardown = mountProgress(root, { onFinished: () => undefined })
    await settle()
    teardown()
    await settle()

    const eventsCall = calls.find((c) => c.pathname === '/api/run/ingest/events')!
    expect(eventsCall.signal?.aborted).toBe(true)
    expect(calls.some((c) => c.pathname === '/api/run/ingest/cancel')).toBe(false)
  })

  it('the cancel control is reachable and Enter activates it', async () => {
    const text = progressFrame({ artifact: 'grid', state: 'ok' })
    const { stub, calls } = buildFetchStub({ streamText: text })
    vi.stubGlobal('fetch', stub)

    mountProgress(root, { onFinished: () => undefined })
    await settle()

    const cancelButton = findButtons(root).find((b) => b.textContent === 'Cancel')!
    cancelButton.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }))
    await settle()

    expect(calls.some((c) => c.pathname === '/api/run/ingest/cancel')).toBe(true)
  })

  it('a partial ingest is not presented as a failed ingest', async () => {
    // The stream row names a different artifact than the blocked
    // capability, so a check against the notice area alone (never the
    // row list) cannot be satisfied by text that only ever appeared in a
    // row.
    const text = progressFrame({ artifact: 'grid', state: 'ok' }) + doneFrame()
    const { stub } = buildFetchStub({ streamText: text, state: partialState })
    vi.stubGlobal('fetch', stub)

    let finished = false
    mountProgress(root, { onFinished: () => (finished = true) })
    await settle()

    expect(finished).toBe(true)
    const noticeArea = Array.from(root.children)[1] as HTMLElement
    const noticeText = textOf(noticeArea)
    expect(noticeText).toContain('par_agg/head')
    expect(noticeText).toContain('the aggregation step crashed reading iteration 3')
    expect(/ingest failed|the ingest failed/i.test(noticeText)).toBe(false)
  })

  it('no rendered text or attribute value contains a filesystem path', async () => {
    const text =
      progressFrame({ artifact: 'grid', state: 'failed', reason: 'could not read the source' }) + doneFrame()
    const { stub } = buildFetchStub({ streamText: text, state: partialState })
    vi.stubGlobal('fetch', stub)

    mountProgress(root, { onFinished: () => undefined })
    await settle()

    for (const el of collectAll(root)) {
      expect(PATH_PATTERN.test(textOf(el))).toBe(false)
      expect(WINDOWS_PATH_PATTERN.test(textOf(el))).toBe(false)
      for (const attrName of el.getAttributeNames()) {
        const value = el.getAttribute(attrName) ?? ''
        expect(PATH_PATTERN.test(value)).toBe(false)
        expect(WINDOWS_PATH_PATTERN.test(value)).toBe(false)
      }
    }
  })
})
