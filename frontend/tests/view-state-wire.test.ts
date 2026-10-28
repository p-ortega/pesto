// readViewState and writeViewState against a stubbed fetch: the field style keys (classes,
// symmetric, texture) read with the same strict rules as the server, and written with defaults.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { readViewState, writeViewState, type ViewState } from '../src/data/client'

function wireBody(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    divider: 0.72,
    colormap: 'viridis',
    reverse: false,
    scale: 'linear',
    limits_mode: 'robust',
    group: null,
    stat: 'value',
    layer: null,
    tab: 'params',
    ...extra,
  }
}

const WIRE_KEYS = [
  'classes',
  'colormap',
  'divider',
  'group',
  'layer',
  'limits_mode',
  'reverse',
  'scale',
  'stat',
  'symmetric',
  'tab',
  'texture',
]

interface Call {
  url: string
  method: string
  body: unknown
}

function stubAnswer(status: number, body: unknown): { calls: Call[] } {
  const seen = { calls: [] as Call[] }
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL, init?: RequestInit) => {
      seen.calls.push({
        url: typeof input === 'string' ? input : input.toString(),
        method: init?.method ?? 'GET',
        body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
      })
      return { ok: status >= 200 && status < 300, status, json: async () => body }
    }),
  )
  return seen
}

function baseState(extra: Partial<ViewState> = {}): ViewState {
  return {
    divider: 0.72,
    colormap: 'viridis',
    reverse: false,
    scale: 'linear',
    limitsMode: 'robust',
    group: null,
    stat: 'value',
    layer: null,
    tab: 'params',
    ...extra,
  }
}

describe('readViewState field style keys', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('reads stored classes, symmetric and texture', async () => {
    const seen = stubAnswer(200, wireBody({ classes: 9, symmetric: true, texture: false }))

    const state = await readViewState()

    expect(seen.calls[0].url).toBe('/api/run/view')
    expect(seen.calls[0].method).toBe('GET')
    expect(state.classes).toBe(9)
    expect(state.symmetric).toBe(true)
    expect(state.texture).toBe(false)
  })

  it.each([0, 7, 9, 11])('keeps the known class count %s', async (good) => {
    stubAnswer(200, wireBody({ classes: good }))
    expect((await readViewState()).classes).toBe(good)
  })

  it.each([5, '9', true, false, 9.5, null, [9]])('reads the class count %j as continuous', async (bad) => {
    stubAnswer(200, wireBody({ classes: bad }))
    expect((await readViewState()).classes).toBe(0)
  })

  it.each(['yes', 1, 'true', null])('reads symmetric and texture %j as off', async (bad) => {
    stubAnswer(200, wireBody({ symmetric: bad, texture: bad }))
    const state = await readViewState()
    expect(state.symmetric).toBe(false)
    expect(state.texture).toBe(false)
  })

  it('reads a body without the three keys as continuous, off and off', async () => {
    stubAnswer(200, wireBody())
    const state = await readViewState()
    expect(state.classes).toBe(0)
    expect(state.symmetric).toBe(false)
    expect(state.texture).toBe(false)
  })
})

describe('writeViewState field style keys', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('sends the defaults when the caller leaves the three keys out', async () => {
    const seen = stubAnswer(200, wireBody({ classes: 0, symmetric: false, texture: false }))

    await writeViewState(baseState())

    const call = seen.calls[0]
    expect(call.url).toBe('/api/run/view')
    expect(call.method).toBe('PUT')
    const body = call.body as Record<string, unknown>
    expect(body.classes).toBe(0)
    expect(body.symmetric).toBe(false)
    expect(body.texture).toBe(false)
  })

  it('sends the caller values and reads the answer back', async () => {
    const seen = stubAnswer(200, wireBody({ classes: 11, symmetric: false, texture: true }))

    const state = await writeViewState(baseState({ classes: 11, texture: true }))

    const body = seen.calls[0].body as Record<string, unknown>
    expect(body.classes).toBe(11)
    expect(body.symmetric).toBe(false)
    expect(body.texture).toBe(true)
    expect(state.classes).toBe(11)
    expect(state.texture).toBe(true)
  })

  it('puts exactly the wire keys and no other', async () => {
    const seen = stubAnswer(200, wireBody())

    await writeViewState(baseState({ classes: 7, symmetric: true }))

    expect(Object.keys(seen.calls[0].body as object).sort()).toEqual(WIRE_KEYS)
  })
})
