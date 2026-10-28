// The basemap client against a stubbed fetch and a stubbed createImageBitmap.

import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  basemapStart,
  inspectBasemap,
  listImages,
  loadBasemapImage,
  readBasemapState,
  registerBasemap,
  removeBasemap,
  type ReadyState,
} from '../src/data/basemap'
import { TOKEN_HEADER } from '../src/auth/token'

interface Seen {
  urls: string[]
  inits: RequestInit[]
}

function jsonReply(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    headers: { get: () => null },
  }
}

function stubJson(status: number, body: unknown): Seen {
  const seen: Seen = { urls: [], inits: [] }
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string, init: RequestInit) => {
      seen.urls.push(input)
      seen.inits.push(init)
      return jsonReply(status, body)
    }),
  )
  return seen
}

function stubImage(meta: Record<string, unknown> | null, bytes = new Uint8Array([1, 2, 3])): Seen {
  const seen: Seen = { urls: [], inits: [] }
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string, init: RequestInit) => {
      seen.urls.push(input)
      seen.inits.push(init)
      return {
        ok: true,
        status: 200,
        arrayBuffer: async () => bytes.buffer,
        headers: { get: (name: string) => (name === 'X-Pesto-Meta' && meta ? JSON.stringify(meta) : null) },
      }
    }),
  )
  return seen
}

interface FakeBitmap {
  width: number
  height: number
  close: ReturnType<typeof vi.fn>
}

function stubDecoder(width: number, height: number) {
  const bitmap: FakeBitmap = { width, height, close: vi.fn() }
  const decode = vi.fn(async (_blob: Blob, _options?: ImageBitmapOptions) => bitmap)
  vi.stubGlobal('createImageBitmap', decode)
  return { decode, bitmap }
}

function inspectBody(): Record<string, unknown> {
  return {
    file_id: 'f1',
    name: 'map.png',
    format: 'png',
    width: 100,
    height: 50,
    stamp: 's1',
    notes: ['rotation flag in the file ignored; placed as stored'],
    model_extent: [0, 1000, 0, 500],
    placement: { by: 'world_file', world_file: 'map.pgw', extent: [999, 1199, 1901, 2001] },
  }
}

function readyBody(): Record<string, unknown> {
  return {
    status: 'ready',
    name: 'map.png',
    format: 'png',
    width: 100,
    height: 50,
    extent: [999, 1199, 1901, 2001],
    placed_by: 'world_file',
    world_file: 'map.pgw',
    notes: [],
    tag: 't1',
  }
}

const READY: ReadyState = {
  status: 'ready',
  name: 'map.png',
  format: 'png',
  width: 100,
  height: 50,
  extent: [999, 1199, 1901, 2001],
  placedBy: 'world_file',
  worldFile: 'map.pgw',
  notes: [],
  tag: 't1',
}

function imageMeta(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    format: 'png',
    width: 100,
    height: 50,
    served_width: 100,
    served_height: 50,
    resize_to: null,
    notes: ['a note from the server'],
    tag: 't1',
    ...overrides,
  }
}

function headerOf(init: RequestInit, name: string): string | undefined {
  return (init.headers as Record<string, string>)[name]
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('basemapStart and listImages', () => {
  it('reads the run folder as an id and a name', async () => {
    const seen = stubJson(200, { id: 'r1', name: 'my-run' })
    const result = await basemapStart()
    expect(seen.urls[0]).toBe('/api/run/basemap/start')
    expect(result).toEqual({ ok: true, folder: { id: 'r1', name: 'my-run' } })
  })

  it('asks for one folder by id, escaped, and reads entries and skipped counts into camelCase', async () => {
    const seen = stubJson(200, {
      entries: [
        { id: 'd1', name: 'maps', kind: 'folder', note: null, reason: null },
        { id: 'f1', name: 'a.png', kind: 'png', note: 'the extension says jpg', reason: null },
        { id: 'f2', name: 'b.tif', kind: 'tiff', note: null, reason: 'TIFF and GeoTIFF basemaps are not supported yet (planned for M2)' },
      ],
      skipped: { other_files: 3, not_checked: 12, unreadable: 2 },
    })
    const result = await listImages('a b/&c')
    expect(seen.urls[0]).toBe('/api/fs/images?id=a%20b%2F%26c')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.listing.entries[1]).toEqual({ id: 'f1', name: 'a.png', kind: 'png', note: 'the extension says jpg', reason: null })
    expect(result.listing.entries[2].kind).toBe('tiff')
    expect(result.listing.skipped).toEqual({ otherFiles: 3, notChecked: 12, unreadable: 2 })
  })

  it('refuses a listing missing skipped.not_checked and names it', async () => {
    stubJson(200, { entries: [], skipped: { other_files: 0, unreadable: 0 } })
    const result = await listImages('d1')
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toContain('not_checked')
    expect(result.code).toBeNull()
  })

  it('refuses an entry of an unknown kind instead of coercing it', async () => {
    stubJson(200, {
      entries: [{ id: 'f1', name: 'a.gif', kind: 'gif', note: null, reason: null }],
      skipped: { other_files: 0, not_checked: 0, unreadable: 0 },
    })
    const result = await listImages('d1')
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toContain('kind')
    expect(result.reason).toContain('gif')
  })

  it('passes an abort signal through to fetch', async () => {
    const seen = stubJson(200, { entries: [], skipped: { other_files: 0, not_checked: 0, unreadable: 0 } })
    const controller = new AbortController()
    await listImages('d1', { signal: controller.signal })
    expect(seen.inits[0].signal).toBe(controller.signal)
  })

  it('throws an aborted request instead of reporting it as a refusal', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new DOMException('aborted', 'AbortError')
      }),
    )
    await expect(listImages('d1')).rejects.toMatchObject({ name: 'AbortError' })
  })
})

describe('inspectBasemap', () => {
  it('posts the id and reads a world-file placement', async () => {
    const seen = stubJson(200, inspectBody())
    const result = await inspectBasemap('f1')
    expect(seen.urls[0]).toBe('/api/run/basemap/inspect')
    expect(seen.inits[0].method).toBe('POST')
    expect(JSON.parse(String(seen.inits[0].body))).toEqual({ id: 'f1' })
    expect(result).toEqual({
      ok: true,
      answer: {
        fileId: 'f1',
        name: 'map.png',
        format: 'png',
        width: 100,
        height: 50,
        stamp: 's1',
        notes: ['rotation flag in the file ignored; placed as stored'],
        modelExtent: [0, 1000, 0, 500],
        placement: { by: 'world_file', worldFile: 'map.pgw', extent: [999, 1199, 1901, 2001] },
      },
    })
  })

  it('reads a numbers placement with its reason and the world files found', async () => {
    const body = inspectBody()
    body.placement = { by: 'numbers', reason: 'two world files match', world_files: ['map.pgw', 'map.wld'] }
    stubJson(200, body)
    const result = await inspectBasemap('f1')
    expect(result.ok && result.answer.placement).toEqual({ by: 'numbers', reason: 'two world files match', worldFiles: ['map.pgw', 'map.wld'] })
  })

  it('refuses a placement missing its extent and names it', async () => {
    const body = inspectBody()
    body.placement = { by: 'world_file', world_file: 'map.pgw' }
    stubJson(200, body)
    const result = await inspectBasemap('f1')
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toContain('extent')
  })

  it('turns a problem answer into its title and machine code', async () => {
    stubJson(422, { type: 'about:blank', status: 422, title: 'TIFF and GeoTIFF basemaps are not supported yet (planned for M2)', code: 'tiff' })
    const result = await inspectBasemap('f1')
    expect(result).toEqual({ ok: false, reason: 'TIFF and GeoTIFF basemaps are not supported yet (planned for M2)', code: 'tiff' })
  })

  it('turns a thrown fetch into its message with no code', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch')
      }),
    )
    expect(await inspectBasemap('f1')).toEqual({ ok: false, reason: 'Failed to fetch', code: null })
  })
})

describe('registerBasemap, readBasemapState and removeBasemap', () => {
  it('registers by world file with the id and stamp only', async () => {
    const seen = stubJson(200, readyBody())
    const result = await registerBasemap({ id: 'f1', stamp: 's1', by: 'world_file' })
    expect(seen.urls[0]).toBe('/api/run/basemap')
    expect(seen.inits[0].method).toBe('POST')
    expect(JSON.parse(String(seen.inits[0].body))).toEqual({ id: 'f1', stamp: 's1', by: 'world_file' })
    expect(result.ok && result.state).toEqual(READY)
  })

  it('registers by four numbers with the extent', async () => {
    const seen = stubJson(200, { ...readyBody(), placed_by: 'numbers', world_file: null })
    await registerBasemap({ id: 'f1', stamp: 's1', by: 'numbers', extent: [0, 1000, 0, 500] })
    expect(JSON.parse(String(seen.inits[0].body))).toEqual({ id: 'f1', stamp: 's1', by: 'numbers', extent: [0, 1000, 0, 500] })
  })

  it('reads none, ready and unavailable states', async () => {
    stubJson(200, { status: 'none' })
    expect(await readBasemapState()).toEqual({ ok: true, state: { status: 'none' } })

    stubJson(200, readyBody())
    expect(await readBasemapState()).toEqual({ ok: true, state: READY })

    stubJson(200, { status: 'unavailable', reason: 'the image changed since it was placed', name: 'map.png', placed_by: 'numbers', extent: null })
    expect(await readBasemapState()).toEqual({
      ok: true,
      state: { status: 'unavailable', reason: 'the image changed since it was placed', name: 'map.png', placedBy: 'numbers', extent: null },
    })
  })

  it('refuses a ready state missing its tag and names it', async () => {
    const body = readyBody()
    delete body.tag
    stubJson(200, body)
    const result = await readBasemapState()
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toContain('tag')
  })

  it('refuses an unknown status instead of coercing it', async () => {
    stubJson(200, { status: 'maybe' })
    const result = await readBasemapState()
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toContain('maybe')
  })

  it('removes with a POST to the remove route', async () => {
    const seen = stubJson(200, { status: 'none' })
    const result = await removeBasemap()
    expect(seen.urls[0]).toBe('/api/run/basemap/remove')
    expect(seen.inits[0].method).toBe('POST')
    expect(result).toEqual({ ok: true, state: { status: 'none' } })
  })
})

describe('loadBasemapImage', () => {
  it('asks for the image with the texture size and the token header, and decodes it as stored', async () => {
    const seen = stubImage(imageMeta())
    const { decode, bitmap } = stubDecoder(100, 50)

    const result = await loadBasemapImage(READY, 4096)

    expect(seen.urls[0]).toBe('/api/run/basemap/image?max=4096')
    expect(headerOf(seen.inits[0], TOKEN_HEADER)).toBeDefined()
    const [blob, options] = decode.mock.calls[0]
    expect(blob.type).toBe('image/png')
    expect(blob.size).toBe(3)
    expect(options).toEqual({ imageOrientation: 'none' })
    expect(result).toEqual({ ok: true, bitmap, notes: ['a note from the server'] })
    expect(bitmap.close).not.toHaveBeenCalled()
  })

  it('sends the same auth headers the other routes send', async () => {
    const json = stubJson(200, { status: 'none' })
    await readBasemapState()
    const image = stubImage(imageMeta())
    stubDecoder(100, 50)
    await loadBasemapImage(READY, 4096)
    expect(image.inits[0].headers).toEqual(json.inits[0].headers)
    expect(headerOf(image.inits[0], 'Content-Type')).toBeUndefined()
  })

  it('types a JPEG as image/jpeg', async () => {
    stubImage(imageMeta({ format: 'jpeg' }))
    const { decode } = stubDecoder(100, 50)
    await loadBasemapImage({ ...READY, format: 'jpeg' }, 4096)
    expect(decode.mock.calls[0][0].type).toBe('image/jpeg')
  })

  it('shrinks the image in the browser when the server gives a resize size', async () => {
    stubImage(imageMeta({ served_width: 20000, served_height: 117, resize_to: [512, 3] }))
    const { decode } = stubDecoder(512, 3)
    const result = await loadBasemapImage(READY, 512)
    expect(decode.mock.calls[0][1]).toEqual({ imageOrientation: 'none', resizeWidth: 512, resizeHeight: 3, resizeQuality: 'high' })
    expect(result.ok).toBe(true)
  })

  it('refuses a decode one pixel narrower than the file, names both sizes, and closes the bitmap', async () => {
    stubImage(imageMeta())
    const { bitmap } = stubDecoder(99, 50)
    const result = await loadBasemapImage(READY, 4096)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toContain('99 x 50')
    expect(result.reason).toContain('100 x 50')
    expect(bitmap.close).toHaveBeenCalledTimes(1)
  })

  it('refuses a decode that missed the resize size', async () => {
    stubImage(imageMeta({ served_width: 20000, served_height: 117, resize_to: [512, 3] }))
    const { bitmap } = stubDecoder(20000, 117)
    const result = await loadBasemapImage(READY, 512)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toContain('512 x 3')
    expect(bitmap.close).toHaveBeenCalledTimes(1)
  })

  it.each(['format', 'served_width', 'served_height', 'resize_to', 'notes'])('refuses an image header missing %s', async (name) => {
    const meta = imageMeta()
    delete meta[name]
    stubImage(meta)
    const { decode } = stubDecoder(100, 50)
    const result = await loadBasemapImage(READY, 4096)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toContain(name)
    expect(decode).not.toHaveBeenCalled()
  })

  it('refuses an image that is not the registered one', async () => {
    stubImage(imageMeta({ tag: 't2' }))
    const { decode } = stubDecoder(100, 50)
    const result = await loadBasemapImage(READY, 4096)
    expect(result.ok).toBe(false)
    expect(decode).not.toHaveBeenCalled()
  })

  it('refuses when the browser has no createImageBitmap', async () => {
    const seen = stubImage(imageMeta())
    vi.stubGlobal('createImageBitmap', undefined)
    const result = await loadBasemapImage(READY, 4096)
    expect(result).toEqual({ ok: false, reason: 'this browser cannot decode images for the map (no createImageBitmap)', code: null })
    expect(seen.urls).toEqual([])
  })

  it('turns a decode failure into a reason', async () => {
    stubImage(imageMeta())
    vi.stubGlobal(
      'createImageBitmap',
      vi.fn(async () => {
        throw new DOMException('The source image could not be decoded.', 'InvalidStateError')
      }),
    )
    const result = await loadBasemapImage(READY, 4096)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toContain('could not be decoded')
  })

  it('passes the abort signal to fetch', async () => {
    const seen = stubImage(imageMeta())
    stubDecoder(100, 50)
    const controller = new AbortController()
    await loadBasemapImage(READY, 4096, { signal: controller.signal })
    expect(seen.inits[0].signal).toBe(controller.signal)
  })

  it('closes and throws a bitmap that lands after the signal was aborted', async () => {
    stubImage(imageMeta())
    const controller = new AbortController()
    const bitmap = { width: 100, height: 50, close: vi.fn() }
    vi.stubGlobal(
      'createImageBitmap',
      vi.fn(async () => {
        controller.abort()
        return bitmap
      }),
    )
    await expect(loadBasemapImage(READY, 4096, { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' })
    expect(bitmap.close).toHaveBeenCalledTimes(1)
  })
})
