import { afterEach, describe, expect, it, vi } from 'vitest'
import { parseFrames, readEvents, type SseEvent } from '../src/data/sse'

describe('parseFrames', () => {
  it('splits two complete frames arriving in one buffer into two events, in order', () => {
    const { events, rest } = parseFrames('data: {"a":1}\n\ndata: {"a":2}\n\n')
    expect(events).toEqual([
      { event: null, data: '{"a":1}' },
      { event: null, data: '{"a":2}' },
    ])
    expect(rest).toBe('')
  })

  it('leaves a payload split across two calls as the remainder, then emits one event once complete', () => {
    const first = parseFrames('data: {"a":')
    expect(first.events).toEqual([])
    expect(first.rest).toBe('data: {"a":')

    const second = parseFrames(first.rest + '1}\n\n')
    expect(second.events).toEqual([{ event: null, data: '{"a":1}' }])
    expect(second.rest).toBe('')
  })

  it('reports the event name alongside its data when a frame carries one', () => {
    const { events } = parseFrames('event: progress\ndata: {"a":1}\n\n')
    expect(events).toEqual([{ event: 'progress', data: '{"a":1}' }])
  })

  it('skips a frame with no data: line without discarding the rest of the buffer', () => {
    const { events, rest } = parseFrames('event: done\n\ndata: {"a":1}\n\n')
    expect(events).toEqual([{ event: null, data: '{"a":1}' }])
    expect(rest).toBe('')
  })

  it('a frame consisting only of an event: done line yields no event and consumes the segment', () => {
    const { events, rest } = parseFrames('event: done\n\n')
    expect(events).toEqual([])
    expect(rest).toBe('')
  })

  it('a payload whose JSON string value contains a colon and a brace round-trips unchanged', () => {
    const payload = '{"reason":"failed at offset 12: {bad byte}"}'
    const { events } = parseFrames(`data: ${payload}\n\n`)
    expect(events).toEqual([{ event: null, data: payload }])
  })

  it('concatenates several data: lines in one frame with a newline between them', () => {
    const { events } = parseFrames('data: line one\ndata: line two\n\n')
    expect(events).toEqual([{ event: null, data: 'line one\nline two' }])
  })
})

// A scripted reader lets a test choose exactly where a network chunk ends,
// instead of trusting whatever boundary an actual socket would produce.
function scriptedReader(chunks: Uint8Array[], failAfter?: { error: unknown }) {
  let index = 0
  return {
    read: async () => {
      if (index < chunks.length) {
        const value = chunks[index]
        index += 1
        return { done: false, value }
      }
      if (failAfter) {
        throw failAfter.error
      }
      return { done: true, value: undefined }
    },
    releaseLock: vi.fn(),
  }
}

function streamResponse(reader: ReturnType<typeof scriptedReader>) {
  return { ok: true, status: 200, body: { getReader: () => reader } }
}

function jsonResponse(status: number, body: unknown) {
  return { ok: status >= 200 && status < 300, status, json: async () => body }
}

const encoder = new TextEncoder()

describe('readEvents', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('issues one fetch carrying the session header', async () => {
    const reader = scriptedReader([])
    const fetchStub = vi.fn(async (_url: string, _init?: RequestInit) => streamResponse(reader))
    vi.stubGlobal('fetch', fetchStub)

    await readEvents('/api/run/ingest/events', () => undefined)

    expect(fetchStub).toHaveBeenCalledTimes(1)
    const init = fetchStub.mock.calls[0][1] as RequestInit
    expect((init.headers as Record<string, string>)['X-Pesto-Token']).toBeDefined()
  })

  it('parses a chunk boundary in the middle of a data: payload as one event', async () => {
    const reader = scriptedReader([encoder.encode('data: {"a":'), encoder.encode('1}\n\n')])
    vi.stubGlobal('fetch', vi.fn(async () => streamResponse(reader)))

    const events: SseEvent[] = []
    await readEvents('/x', (e) => events.push(e))

    expect(events).toEqual([{ event: null, data: '{"a":1}' }])
  })

  it('parses two frames delivered in one chunk as two events', async () => {
    const reader = scriptedReader([encoder.encode('data: {"a":1}\n\ndata: {"a":2}\n\n')])
    vi.stubGlobal('fetch', vi.fn(async () => streamResponse(reader)))

    const events: SseEvent[] = []
    await readEvents('/x', (e) => events.push(e))

    expect(events).toEqual([
      { event: null, data: '{"a":1}' },
      { event: null, data: '{"a":2}' },
    ])
  })

  it('skips a frame with no data: line', async () => {
    const reader = scriptedReader([encoder.encode('event: done\n\ndata: {"a":1}\n\n')])
    vi.stubGlobal('fetch', vi.fn(async () => streamResponse(reader)))

    const events: SseEvent[] = []
    await readEvents('/x', (e) => events.push(e))

    expect(events).toEqual([{ event: null, data: '{"a":1}' }])
  })

  it('a payload whose JSON string value contains a colon and a brace survives intact', async () => {
    const payload = '{"reason":"stopped at 3: {truncated}"}'
    const reader = scriptedReader([encoder.encode(`data: ${payload}\n\n`)])
    vi.stubGlobal('fetch', vi.fn(async () => streamResponse(reader)))

    const events: SseEvent[] = []
    await readEvents('/x', (e) => events.push(e))

    expect(events).toEqual([{ event: null, data: payload }])
  })

  it('decodes a multi-byte UTF-8 character split across a chunk boundary correctly', async () => {
    const full = encoder.encode('data: {"name":"café"}\n\n')
    // Split inside the two-byte UTF-8 encoding of "é" (0xC3 0xA9).
    const splitAt = full.indexOf(0xa9)
    const reader = scriptedReader([full.slice(0, splitAt), full.slice(splitAt)])
    vi.stubGlobal('fetch', vi.fn(async () => streamResponse(reader)))

    const events: SseEvent[] = []
    await readEvents('/x', (e) => events.push(e))

    expect(events).toEqual([{ event: null, data: '{"name":"café"}' }])
  })

  it('resolves rather than rejecting when the signal is aborted mid-stream, having called onEvent once', async () => {
    const abortError = Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' })
    const reader = scriptedReader([encoder.encode('data: {"a":1}\n\n')], { error: abortError })
    const controller = new AbortController()
    vi.stubGlobal('fetch', vi.fn(async () => streamResponse(reader)))

    const events: SseEvent[] = []
    await expect(readEvents('/x', (e) => events.push(e), controller.signal)).resolves.toBeUndefined()

    expect(events.length).toBe(1)
  })

  it('rejects with the status and title from a non-ok problem response, calling onEvent never', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse(409, { type: 'about:blank', title: 'an ingest is already running for this run', status: 409 }),
      ),
    )

    const onEvent = vi.fn()
    await expect(readEvents('/x', onEvent)).rejects.toMatchObject({
      problem: { status: 409, title: 'an ingest is already running for this run' },
    })
    expect(onEvent).not.toHaveBeenCalled()
  })

  it('releases the reader lock once the stream ends', async () => {
    const reader = scriptedReader([encoder.encode('data: {"a":1}\n\n')])
    vi.stubGlobal('fetch', vi.fn(async () => streamResponse(reader)))

    await readEvents('/x', () => undefined)

    expect(reader.releaseLock).toHaveBeenCalledTimes(1)
  })
})
