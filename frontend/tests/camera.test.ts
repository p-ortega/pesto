// @vitest-environment jsdom
//
// MAP-11: pointer drag to pan, wheel to zoom, keyboard reach while the
// canvas holds focus, and the eased fit-to-extent. Drives the real map
// screen (mountMap) against a stubbed fetch, with the real Camera class
// (spied on, never mocked) -- only the two GL modules are mocked, exactly
// as tests/redraw.test.ts and tests/main.test.ts already do (jsdom has no
// real WebGL2). The easing contract itself (Test 6) is proven as a direct
// unit test of Camera.fitAnimated, which needs no DOM at all.

import { tableFromArrays, tableToIPC } from 'apache-arrow'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { IngestState } from '../src/data/client'
import type { RunConfig } from '../src/views/map'
import { Camera, MAX_ZOOM_FROM_FIT, MIN_ZOOM_FROM_FIT, wheelZoomFactor } from '../src/gl/camera'

vi.mock('../src/gl/context', () => ({
  createContext: vi.fn(() => ({
    gl: { clearColor: vi.fn(), clear: vi.fn(), viewport: vi.fn(), COLOR_BUFFER_BIT: 0 },
    onLost: vi.fn(),
    onRestored: vi.fn(),
  })),
}))

vi.mock('../src/gl/mesh-layer', () => ({
  MeshLayer: vi.fn().mockImplementation(function MockMeshLayer(this: object) {
    Object.assign(this, {
      setValues: vi.fn(),
      setLimits: vi.fn(),
      setColormap: vi.fn(),
      setMatrix: vi.fn(),
      setInactive: vi.fn(),
      setHairlineColor: vi.fn(),
      setContested: vi.fn(),
      setContestedColors: vi.fn(),
      setSelected: vi.fn(),
      setAccentColor: vi.fn(),
      setPoints: vi.fn(),
      setPointRingColor: vi.fn(),
      setFootprint: vi.fn(),
      setFootprintColor: vi.fn(),
      setSelectedPoint: vi.fn(),
      draw: vi.fn(),
      reupload: vi.fn(),
      dispose: vi.fn(),
    })
  }),
}))

const CONFIG: RunConfig = {
  case: 'test_run',
  n_par: null,
  n_real: null,
  base_realization: null,
  n_iterations: null,
  noptmax: null,
  first_iteration: 0,
  projection: null,
  projection_known: false,
  noise: { has_noise: null, decided_by: '', evidence: [], notes: [] },
}

function baseState(): IngestState {
  return {
    fresh: true,
    artifacts: [],
    capabilities: {
      map: { available: true, blockedBy: [] },
      stats: { available: true, blockedBy: [] },
      chips: { available: true, blockedBy: [] },
    },
    ingestSeconds: null,
    cacheBytes: null,
  }
}

// nlay=2 and two realizations, deliberately: a one-layer/one-realization
// fixture disables both sliders (never hidden, per MAP-03's own rule), and
// the slider-focus test below needs one it can actually give focus to.
const MESH_BODY = { n_vert: 4, n_tri: 2, n_cells: 1, nlay: 2, bounds: [0, 100, 0, 100], crs: 'EPSG:1', tag: 'tag1' }
const POSITIONS = new Float32Array([0, 0, 100, 0, 100, 100, 0, 100])
const CELL_INDEX = new Float32Array([0, 0, 0, 0])
const INDICES = new Uint32Array([0, 1, 2, 0, 2, 3])
const PARMAP = new Int32Array([0])
const CELL_ARRAY = new Int32Array([0])
const LAYER_ARRAY = new Int32Array([0])
const FIELD = new Float32Array([42])

function bytesOf(view: ArrayBufferView): Uint8Array {
  return new Uint8Array(view.buffer, view.byteOffset, view.byteLength)
}

function metaHeader(dtype: string): Record<string, string> {
  return { 'X-Pesto-Meta': JSON.stringify({ dtype }) }
}

const PAR_TABLE = tableToIPC(tableFromArrays({ parnme: ['p0'], pargp: ['G1'], partrans: ['none'] }), 'stream')
const REALS_TABLE = tableToIPC(tableFromArrays({ realization: ['base'] }), 'stream')
const VIEW_STATE_BODY = {
  divider: 0.72,
  colormap: 'viridis',
  reverse: false,
  scale: 'linear',
  limits_mode: 'robust',
  group: null,
  stat: 'value',
}

function stubEnvironment(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL) => {
      const url = typeof input === 'string' ? input : input.toString()
      const [path] = url.split('?')

      const respond = (result: { status: number; bytes?: Uint8Array; body?: unknown; headers?: Record<string, string> }) => {
        const bytes = result.bytes ?? new Uint8Array(0)
        return {
          ok: result.status >= 200 && result.status < 300,
          status: result.status,
          json: async () => result.body ?? {},
          arrayBuffer: async () => bytes.buffer,
          headers: { get: (name: string) => result.headers?.[name] ?? null },
        }
      }

      switch (path) {
        case '/api/run/grid/mesh':
          return respond({ status: 200, body: MESH_BODY })
        case '/api/run/grid/mesh/positions':
          return respond({ status: 200, bytes: bytesOf(POSITIONS), headers: metaHeader('<f4') })
        case '/api/run/grid/mesh/cell_index':
          return respond({ status: 200, bytes: bytesOf(CELL_INDEX), headers: metaHeader('<f4') })
        case '/api/run/grid/mesh/indices':
          return respond({ status: 200, bytes: bytesOf(INDICES), headers: metaHeader('<u4') })
        case '/api/run/grid/parmap':
          return respond({ status: 200, bytes: bytesOf(PARMAP) })
        case '/api/run/meta':
          return respond({ status: 200, bytes: PAR_TABLE })
        case '/api/run/grid/cells/cell':
          return respond({ status: 200, bytes: bytesOf(CELL_ARRAY) })
        case '/api/run/grid/cells/layer':
          return respond({ status: 200, bytes: bytesOf(LAYER_ARRAY) })
        case '/api/run/grid/cells/xy':
          return respond({ status: 404, body: { title: 'no point positions were recorded for that iteration', status: 404 } })
        case '/api/run/reals':
          return respond({ status: 200, bytes: REALS_TABLE })
        case '/api/run/view':
          return respond({ status: 200, body: VIEW_STATE_BODY })
        case '/api/run/grid/values':
          return respond({ status: 200, bytes: bytesOf(FIELD) })
        default:
          throw new Error(`unhandled fetch in test: ${path}`)
      }
    }),
  )
}

function stubMatchMedia(reduced: boolean): void {
  vi.stubGlobal(
    'matchMedia',
    vi.fn().mockImplementation((query: string) => ({
      matches: query.includes('reduced-motion') ? reduced : false,
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  )
}

function mountFreshRoot(): HTMLElement {
  const root = document.createElement('div')
  document.body.appendChild(root)
  return root
}

function stubRect(canvas: HTMLCanvasElement): void {
  Object.defineProperty(canvas, 'getBoundingClientRect', {
    configurable: true,
    value: () => ({ left: 0, top: 0, right: 800, bottom: 480, width: 800, height: 480, x: 0, y: 0, toJSON: () => ({}) }),
  })
}

async function mountReady(reduced = false): Promise<HTMLElement> {
  stubMatchMedia(reduced)
  stubEnvironment()
  const { mountMap } = await import('../src/views/map')
  const root = mountFreshRoot()
  mountMap(root, { config: CONFIG, state: baseState() })
  await vi.waitFor(() => {
    expect(root.querySelector('canvas[data-drawn="true"]')).not.toBeNull()
  })
  const canvas = root.querySelector('canvas') as HTMLCanvasElement
  stubRect(canvas)
  return root
}

describe('the canvas pan, zoom and keyboard reach', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.clearAllMocks()
    // Deliberately no vi.resetModules() here: this file spies on
    // Camera.prototype via a static top-level import, and resetting the
    // module registry would make the next dynamic import of views/map.ts
    // resolve a *different* Camera class instance than the one this file
    // holds a reference to -- the spy would then watch a class map.ts
    // never actually uses. mountMap itself carries no module-level state,
    // so a fresh root element per test is isolation enough.
  })

  it('a pointer drag on the canvas calls pan with the pointer delta and redraws', async () => {
    const root = await mountReady()
    const canvas = root.querySelector('canvas') as HTMLCanvasElement
    const panSpy = vi.spyOn(Camera.prototype, 'pan')

    canvas.dispatchEvent(new PointerEvent('pointerdown', { clientX: 100, clientY: 100, pointerId: 1 }))
    canvas.dispatchEvent(new PointerEvent('pointermove', { clientX: 130, clientY: 80, pointerId: 1 }))

    expect(panSpy).toHaveBeenCalledWith(30, -20)
  })

  it('a wheel event calls zoomAt with the cursor position, holding the point under it fixed', async () => {
    const root = await mountReady()
    const canvas = root.querySelector('canvas') as HTMLCanvasElement
    const zoomSpy = vi.spyOn(Camera.prototype, 'zoomAt')

    canvas.dispatchEvent(new WheelEvent('wheel', { clientX: 200, clientY: 150, deltaY: -100 }))

    expect(zoomSpy).toHaveBeenCalledWith(200, 150, 1.1)
  })

  it('with the canvas focused, arrow keys pan, + and - zoom, and Home fits', async () => {
    const root = await mountReady()
    const canvas = root.querySelector('canvas') as HTMLCanvasElement
    canvas.focus()
    expect(document.activeElement).toBe(canvas)

    const panSpy = vi.spyOn(Camera.prototype, 'pan')
    const zoomSpy = vi.spyOn(Camera.prototype, 'zoomAt')
    const fitSpy = vi.spyOn(Camera.prototype, 'fitAnimated')

    canvas.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight' }))
    expect(panSpy).toHaveBeenCalledTimes(1)

    canvas.dispatchEvent(new KeyboardEvent('keydown', { key: '+' }))
    expect(zoomSpy).toHaveBeenCalledTimes(1)

    canvas.dispatchEvent(new KeyboardEvent('keydown', { key: '-' }))
    expect(zoomSpy).toHaveBeenCalledTimes(2)

    canvas.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home' }))
    expect(fitSpy).toHaveBeenCalledTimes(1)
  })

  it('with a slider focused, an arrow key does not move the camera', async () => {
    const root = await mountReady()
    const layerSlider = root.querySelector('input[aria-label="Layer"]') as HTMLInputElement
    layerSlider.focus()
    expect(document.activeElement).toBe(layerSlider)

    const panSpy = vi.spyOn(Camera.prototype, 'pan')
    const canvas = root.querySelector('canvas') as HTMLCanvasElement
    canvas.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight' }))

    expect(panSpy).not.toHaveBeenCalled()
  })

  it('the Fit to extent button and the Home key call the same fit(bounds)', async () => {
    const root = await mountReady()
    const fitSpy = vi.spyOn(Camera.prototype, 'fitAnimated')

    const button = Array.from(root.querySelectorAll('button')).find((b) => b.textContent === 'Fit to extent')
    expect(button).toBeTruthy()
    button!.click()
    expect(fitSpy).toHaveBeenCalledTimes(1)
    const [boundsFromButton] = fitSpy.mock.calls[0]

    const canvas = root.querySelector('canvas') as HTMLCanvasElement
    canvas.focus()
    canvas.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home' }))
    expect(fitSpy).toHaveBeenCalledTimes(2)
    const [boundsFromHome] = fitSpy.mock.calls[1]
    expect(boundsFromHome).toEqual(boundsFromButton)
  })

  it('no rendered element carries a tabindex above zero, and the canvas carries tabindex 0', async () => {
    const root = await mountReady()
    const canvas = root.querySelector('canvas') as HTMLCanvasElement
    expect(canvas.tabIndex).toBe(0)

    for (const el of Array.from(root.querySelectorAll('[tabindex]'))) {
      expect(Number(el.getAttribute('tabindex'))).toBeLessThanOrEqual(0)
    }
  })
})

describe('the canvas wheel zoom follows the distance scrolled', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.clearAllMocks()
  })

  it('a small wheel step zooms a little: deltaY -1 gives a factor above 1 and below 1.01', async () => {
    const root = await mountReady()
    const canvas = root.querySelector('canvas') as HTMLCanvasElement
    const zoomSpy = vi.spyOn(Camera.prototype, 'zoomAt')

    canvas.dispatchEvent(new WheelEvent('wheel', { clientX: 200, clientY: 150, deltaY: -1 }))

    expect(zoomSpy).toHaveBeenCalledTimes(1)
    const factor = zoomSpy.mock.calls[0][2]
    expect(factor).toBeGreaterThan(1)
    expect(factor).toBeLessThan(1.01)
  })

  it('a sideways swipe (deltaY 0) neither zooms nor is left to scroll or swipe back the page', async () => {
    const root = await mountReady()
    const canvas = root.querySelector('canvas') as HTMLCanvasElement
    const zoomSpy = vi.spyOn(Camera.prototype, 'zoomAt')

    const event = new WheelEvent('wheel', { clientX: 200, clientY: 150, deltaX: 25, deltaY: 0, cancelable: true })
    canvas.dispatchEvent(event)

    expect(zoomSpy).not.toHaveBeenCalled()
    expect(event.defaultPrevented).toBe(true)
  })

  it('a pinch (ctrlKey) of deltaY -10 zooms 1.1x', async () => {
    const root = await mountReady()
    const canvas = root.querySelector('canvas') as HTMLCanvasElement
    const zoomSpy = vi.spyOn(Camera.prototype, 'zoomAt')

    canvas.dispatchEvent(new WheelEvent('wheel', { clientX: 200, clientY: 150, deltaY: -10, ctrlKey: true }))

    expect(zoomSpy).toHaveBeenCalledWith(200, 150, 1.1)
  })
})

describe('wheelZoomFactor', () => {
  const scroll = (deltaY: number, deltaMode = 0, ctrlKey = false) => ({ deltaY, deltaMode, ctrlKey })

  it('one 100 px notch up is 1.1x, a 1 px step is a hundredth of that, a notch down is its inverse', () => {
    expect(wheelZoomFactor(scroll(-100), 800)).toBeCloseTo(1.1, 12)
    expect(wheelZoomFactor(scroll(-1), 800)).toBeCloseTo(1.1 ** 0.01, 12)
    expect(wheelZoomFactor(scroll(100), 800)).toBeCloseTo(1 / 1.1, 12)
  })

  it('gives null for no vertical distance and for a distance that is not a finite number', () => {
    expect(wheelZoomFactor(scroll(0), 800)).toBeNull()
    expect(wheelZoomFactor(scroll(Number.NaN), 800)).toBeNull()
    expect(wheelZoomFactor(scroll(Number.POSITIVE_INFINITY), 800)).toBeNull()
    expect(wheelZoomFactor(scroll(Number.NEGATIVE_INFINITY), 800)).toBeNull()
  })

  it('counts a line as 40 px and a page as the canvas height', () => {
    expect(wheelZoomFactor(scroll(-3, 1), 800)).toBeCloseTo(wheelZoomFactor(scroll(-120, 0), 800)!, 12)
    expect(wheelZoomFactor(scroll(1, 2), 800)).toBeCloseTo(wheelZoomFactor(scroll(800, 0), 800)!, 12)
  })

  it('takes 10 px per 1.1x step for a pinch, ten times the scroll rate', () => {
    expect(wheelZoomFactor(scroll(-10, 0, true), 800)).toBeCloseTo(1.1, 12)
    const pinch = Math.log(wheelZoomFactor(scroll(-1, 0, true), 800)!)
    const plain = Math.log(wheelZoomFactor(scroll(-1, 0, false), 800)!)
    expect(pinch / plain).toBeCloseTo(10, 9)
  })
})

describe('Camera.zoomAt bounds', () => {
  const scaleOf = (camera: Camera, width: number): number => (camera.matrix()[0] * width) / 2

  it('keeps the scale between a tenth and a thousand times the scale of the last fit', () => {
    expect(MIN_ZOOM_FROM_FIT).toBe(0.1)
    expect(MAX_ZOOM_FROM_FIT).toBe(1000)
    const camera = new Camera(800, 480)
    camera.fit([0, 100, 0, 100])
    const fitScale = scaleOf(camera, 800)

    camera.zoomAt(300, 200, 1e9)
    expect(scaleOf(camera, 800) / fitScale).toBeCloseTo(1000, 3)

    camera.zoomAt(300, 200, 1e-18)
    expect(scaleOf(camera, 800) / fitScale).toBeCloseTo(0.1, 6)
  })

  it('keeps the world point under the pointer still at either limit', () => {
    const camera = new Camera(800, 480)
    camera.fit([0, 100, 0, 100])
    const before = camera.screenToWorld(300, 200)

    camera.zoomAt(300, 200, 1e9)
    const atMax = camera.screenToWorld(300, 200)
    expect(atMax[0]).toBeCloseTo(before[0], 6)
    expect(atMax[1]).toBeCloseTo(before[1], 6)

    camera.zoomAt(500, 100, 1e-18)
    const mid = camera.screenToWorld(500, 100)
    camera.zoomAt(500, 100, 1e-9)
    const atMin = camera.screenToWorld(500, 100)
    expect(atMin[0]).toBeCloseTo(mid[0], 6)
    expect(atMin[1]).toBeCloseTo(mid[1], 6)
  })

  it('ignores a factor that is not a positive finite number', () => {
    const camera = new Camera(800, 480)
    camera.fit([0, 100, 0, 100])
    const before = Array.from(camera.matrix())
    for (const factor of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      camera.zoomAt(300, 200, factor)
      expect(Array.from(camera.matrix())).toEqual(before)
    }
  })

  it('fitAnimated sets the same fit reference as fit, from its target, at its start', () => {
    vi.stubGlobal('requestAnimationFrame', vi.fn())
    const fitted = new Camera(800, 480)
    fitted.fit([0, 100, 0, 100])
    const fitScale = scaleOf(fitted, 800)

    const animated = new Camera(800, 480)
    animated.fitAnimated([0, 100, 0, 100], vi.fn(), { reduced: false })
    animated.zoomAt(300, 200, 1e9)
    expect(scaleOf(animated, 800) / fitScale).toBeCloseTo(1000, 3)
    vi.unstubAllGlobals()
  })
})

describe('Camera.fitAnimated', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('jumps to the target in one frame with no easing when reduced is set', () => {
    const raf = vi.fn()
    vi.stubGlobal('requestAnimationFrame', raf)

    const camera = new Camera(800, 480)
    const onFrame = vi.fn()
    camera.fitAnimated([0, 100, 0, 100], onFrame, { reduced: true })

    expect(onFrame).toHaveBeenCalledTimes(1)
    expect(raf).not.toHaveBeenCalled()
    const [x, y] = camera.screenToWorld(400, 240)
    expect(x).toBeCloseTo(50, 5)
    expect(y).toBeCloseTo(50, 5)
  })

  it('eases the camera toward the target over ~200ms when reduced is not set', () => {
    let time = 0
    const callbacks: FrameRequestCallback[] = []
    vi.stubGlobal(
      'requestAnimationFrame',
      vi.fn((cb: FrameRequestCallback) => {
        callbacks.push(cb)
        return callbacks.length
      }),
    )
    vi.stubGlobal('performance', { now: () => time } as unknown as Performance)

    const camera = new Camera(800, 480)
    const onFrame = vi.fn()
    camera.fitAnimated([0, 100, 0, 100], onFrame, { reduced: false, duration: 200 })

    // Scheduled, not yet applied -- reduced-motion off means the first
    // change to the camera happens on the next animation frame, never
    // synchronously.
    expect(onFrame).not.toHaveBeenCalled()
    expect(callbacks.length).toBe(1)

    time = 100
    callbacks.shift()!(time)
    expect(onFrame).toHaveBeenCalledTimes(1)
    const [xHalf, yHalf] = camera.screenToWorld(400, 240)
    // Halfway through a 200ms ease, the camera has not yet reached the
    // fitted centre -- fit(bounds) alone would already put (400, 240) at
    // world (50, 50).
    expect(Math.hypot(xHalf - 50, yHalf - 50)).toBeGreaterThan(1)
    expect(callbacks.length).toBe(1)

    time = 200
    callbacks.shift()!(time)
    expect(onFrame).toHaveBeenCalledTimes(2)
    const [xFinal, yFinal] = camera.screenToWorld(400, 240)
    expect(xFinal).toBeCloseTo(50, 3)
    expect(yFinal).toBeCloseTo(50, 3)
    // Done -- no further frame scheduled once t reaches 1.
    expect(callbacks.length).toBe(0)
  })
})

describe('Camera.resize', () => {
  it('keeps the world point at the centre where it is and does not zoom when the canvas changes size', () => {
    const camera = new Camera(800, 480)
    camera.fit([0, 100, 0, 50])
    const [cx, cy] = camera.screenToWorld(400, 240)
    const [rightX] = camera.screenToWorld(500, 240)

    camera.resize(1600, 960)

    const [nx, ny] = camera.screenToWorld(800, 480)
    expect(nx).toBeCloseTo(cx, 5)
    expect(ny).toBeCloseTo(cy, 5)
    // 100 screen px still covers the same world distance: the new room is
    // added at the edges, nothing is rescaled.
    const [newRightX] = camera.screenToWorld(900, 480)
    expect(newRightX - nx).toBeCloseTo(rightX - cx, 5)
  })
})
