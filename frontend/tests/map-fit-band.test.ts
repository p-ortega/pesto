// @vitest-environment jsdom
//
// LD-4: the plan and the section fit into the part of the map the left cards leave free, on first
// draw, on Fit to extent and on Home only, and folding or opening a card never moves either. The
// real map screen against a stubbed fetch, with the GL context and MeshLayer mocked and the layout
// stubbed by hand.

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tableFromArrays, tableToIPC } from 'apache-arrow'
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import type { IngestState } from '../src/data/client'
import { Camera } from '../src/gl/camera'
import { SectionCamera, type SectionInset } from '../src/gl/section-camera'
import type { RunConfig } from '../src/views/map'
import { createRecording2d } from './support/recording-2d'

vi.mock('../src/gl/context', () => ({
  createContext: vi.fn(() => ({
    gl: { clearColor: vi.fn(), clear: vi.fn(), viewport: vi.fn(), finish: vi.fn(), COLOR_BUFFER_BIT: 0 },
    onLost: vi.fn(),
    onRestored: vi.fn(),
  })),
}))

vi.mock('../src/gl/mesh-layer', async (importOriginal) =>
  (await import('./support/mesh-layer-mock')).meshLayerMockModule(await importOriginal()),
)

// The real settleStack, with a hook so a test can change the layout the moment the stack settles.
const settleHooks: { before: (() => void) | null; calls: number } = { before: null, calls: 0 }
vi.mock('../src/ui/fold', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/ui/fold')>()
  return {
    ...actual,
    settleStack: vi.fn((...args: Parameters<typeof actual.settleStack>) => {
      settleHooks.calls += 1
      settleHooks.before?.()
      return actual.settleStack(...args)
    }),
  }
})

// The real section frame, with the band of every paint kept so a test can read where the axis went.
const framePaints = vi.hoisted(() => [] as Array<number | undefined>)
vi.mock('../src/ui/section-axes', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/ui/section-axes')>()
  return {
    ...actual,
    renderSectionAxes: (opts: Parameters<typeof actual.renderSectionAxes>[0]) => {
      const handle = actual.renderSectionAxes(opts)
      const paint = handle.paint.bind(handle)
      handle.paint = (input) => {
        framePaints.push(input.bandCss)
        paint(input)
      }
      return handle
    },
  }
})

const SECTION_ANSWER = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'section-tracer-answer.json'), 'utf8'),
) as Record<string, unknown>

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
      section: { available: true, blockedBy: [] },
    },
    ingestSeconds: null,
    cacheBytes: null,
  }
}

// One wide cell, so the fit is set by the width and the band shows in where it lands.
const BOUNDS: [number, number, number, number] = [0, 10, 0, 1]
const MESH_BODY = { n_vert: 4, n_tri: 2, n_cells: 1, nlay: 1, bounds: BOUNDS, crs: null, tag: 'band' }
const POSITIONS = new Float32Array([0, 0, 10, 0, 10, 1, 0, 1])
const CELL_INDEX = new Float32Array([0, 0, 0, 0])
const INDICES = new Uint32Array([0, 1, 2, 0, 2, 3])
const PAR_TABLE = tableToIPC(tableFromArrays({ parnme: ['p0'], pargp: ['G1'], partrans: ['none'] }), 'stream')
const REALS_TABLE = tableToIPC(tableFromArrays({ realization: ['base'] }), 'stream')

function bytesOf(view: ArrayBufferView): Uint8Array {
  return new Uint8Array(view.buffer, view.byteOffset, view.byteLength)
}

function metaHeader(dtype: string): Record<string, string> {
  return { 'X-Pesto-Meta': JSON.stringify({ dtype }) }
}

let onValues: (() => void) | null = null

function stubFetch(): void {
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
          arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
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
          return respond({ status: 200, bytes: bytesOf(new Int32Array([0])) })
        case '/api/run/meta':
          return respond({ status: 200, bytes: PAR_TABLE })
        case '/api/run/grid/cells/cell':
          return respond({ status: 200, bytes: bytesOf(new Int32Array([0])) })
        case '/api/run/grid/cells/layer':
          return respond({ status: 200, bytes: bytesOf(new Int32Array([0])) })
        case '/api/run/grid/cells/xy':
          return respond({ status: 404, body: { title: 'no point positions were recorded for that iteration', status: 404 } })
        case '/api/run/reals':
          return respond({ status: 200, bytes: REALS_TABLE })
        case '/api/run/grid/values':
          // The first field fetch has started, so the first band fit has already run.
          onValues?.()
          onValues = null
          return respond({ status: 200, bytes: bytesOf(new Float32Array([10])) })
        case '/api/run/grid/section':
          return respond({ status: 200, body: SECTION_ANSWER })
        case '/api/run/grid/pp':
          return respond({ status: 200, body: { groups: [], not_interpolable: [], notes: [] } })
        default:
          throw new Error(`unhandled fetch in test: GET ${path}`)
      }
    }),
  )
}

// jsdom lays nothing out: the map area, the left stack and the legend report these rects, in CSS px.
const layout = { area: { width: 1000, height: 800 }, stack: { left: 16, width: 256 }, legend: { left: 16, width: 200 } }

function rect(left: number, width: number, height: number): DOMRect {
  return { x: left, y: 0, left, top: 0, right: left + width, bottom: height, width, height, toJSON: () => ({}) } as DOMRect
}

function stubLayout(): void {
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    if (this.classList.contains('map-area')) return rect(0, layout.area.width, layout.area.height)
    if (this.classList.contains('floating-top-left')) return rect(layout.stack.left, layout.stack.width, 300)
    if (this.classList.contains('floating-bottom-left')) return rect(layout.legend.left, layout.legend.width, 100)
    return rect(0, 0, 0)
  })
}

let fitSpy: MockInstance<Camera['fit']>

function camera(): Camera {
  const ctx = fitSpy.mock.contexts.at(-1)
  if (!ctx) throw new Error('the map made no camera')
  return ctx as Camera
}

// Where model x lands on the canvas, in canvas px, under the camera's own matrix.
function canvasX(cam: Camera, canvas: HTMLCanvasElement, wx: number): number {
  const m = cam.matrix()
  return ((m[0] * wx + m[6] + 1) / 2) * canvas.width
}

async function mountAndDraw(): Promise<{ root: HTMLElement; canvas: HTMLCanvasElement }> {
  const { mountMap } = await import('../src/views/map')
  const root = document.createElement('div')
  document.body.appendChild(root)
  mountMap(root, { config: CONFIG, state: baseState() })
  await vi.waitFor(() => {
    expect(root.querySelector('canvas[data-drawn="true"]')).not.toBeNull()
    expect(root.querySelector('.floating-top-left > [data-fold="basemap"]')).not.toBeNull()
    expect(settleHooks.calls).toBe(1)
  })
  return { root, canvas: root.querySelector('canvas') as HTMLCanvasElement }
}

function bandFits(): unknown[][] {
  return fitSpy.mock.calls.filter((call) => call.length >= 3)
}

function foldButton(root: HTMLElement, key: string): HTMLButtonElement {
  const button = root.querySelector(`button[aria-controls="fold-body-${key}"]`)
  if (!button) throw new Error(`no fold button for ${key}`)
  return button as HTMLButtonElement
}

function fitButton(root: HTMLElement): HTMLButtonElement {
  const found = Array.from(root.querySelectorAll('button')).find((b) => b.textContent === 'Fit to extent')
  if (!found) throw new Error('no Fit to extent button')
  return found as HTMLButtonElement
}

describe('the plan fits into the area the left cards leave free (LD-4)', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
    settleHooks.before = null
    settleHooks.calls = 0
    onValues = null
    layout.area = { width: 1000, height: 800 }
    layout.stack = { left: 16, width: 256 }
    layout.legend = { left: 16, width: 200 }
    Object.defineProperty(window, 'devicePixelRatio', { value: 2, configurable: true })
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe(): void {}
        unobserve(): void {}
        disconnect(): void {}
      },
    )
    stubFetch()
    stubLayout()
    fitSpy = vi.spyOn(Camera.prototype, 'fit')
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('puts the mesh right of the wider card plus 16px after the first draw', async () => {
    const { canvas } = await mountAndDraw()
    // Stack right edge 272, plus 16, at a device ratio of 2.
    expect(canvasX(camera(), canvas, BOUNDS[0])).toBeGreaterThanOrEqual((16 + 256 + 16) * 2)
    // Centred in the box left free, 576 to 2000.
    expect((canvasX(camera(), canvas, BOUNDS[0]) + canvasX(camera(), canvas, BOUNDS[1])) / 2).toBeCloseTo((576 + 2000) / 2, 2)
  })

  it('keeps the first fit when the band is the same after the Basemap card mounts and the stack settles', async () => {
    let atSettle: number[] | null = null
    settleHooks.before = () => {
      atSettle = Array.from(camera().matrix())
    }
    await mountAndDraw()

    expect(bandFits()).toHaveLength(1)
    expect(atSettle).not.toBeNull()
    expect(Array.from(camera().matrix())).toEqual(atSettle)
  })

  it('fits once more to the settled band when the cards settle wider than the first fit saw', async () => {
    layout.stack = { left: 16, width: 200 }
    layout.legend = { left: 16, width: 0 }
    onValues = () => {
      layout.legend = { left: 16, width: 256 }
    }
    const { root, canvas } = await mountAndDraw()

    expect(bandFits()).toHaveLength(2)
    expect((bandFits()[0][2] as { left: number }).left).toBe((16 + 200 + 16) * 2)
    expect((bandFits()[1][2] as { left: number }).left).toBe((16 + 256 + 16) * 2)
    expect(canvasX(camera(), canvas, BOUNDS[0])).toBeGreaterThanOrEqual((16 + 256 + 16) * 2)

    const before = Array.from(camera().matrix())
    foldButton(root, 'data').click()
    expect(Array.from(camera().matrix())).toEqual(before)
  })

  it('keeps a pan the user made while the first field loaded, even when the cards settle wider', async () => {
    layout.stack = { left: 16, width: 200 }
    layout.legend = { left: 16, width: 0 }
    let afterPan: number[] | null = null
    onValues = () => {
      layout.legend = { left: 16, width: 256 }
      const canvas = document.querySelector('canvas') as HTMLCanvasElement
      canvas.focus()
      canvas.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true, cancelable: true }))
      afterPan = Array.from(camera().matrix())
    }
    await mountAndDraw()

    expect(afterPan).not.toBeNull()
    expect(bandFits()).toHaveLength(1)
    expect(Array.from(camera().matrix())).toEqual(afterPan)
  })

  it('fits again to the band measured at that moment on Fit to extent and on Home', async () => {
    const fitAnimated = vi.spyOn(Camera.prototype, 'fitAnimated')
    const { root, canvas } = await mountAndDraw()

    layout.stack = { left: 16, width: 400 }
    fitButton(root).click()
    expect(fitAnimated).toHaveBeenCalledTimes(1)
    expect(fitAnimated.mock.calls[0][2]?.inset?.left).toBe((16 + 400 + 16) * 2)
    expect(canvasX(camera(), canvas, BOUNDS[0])).toBeGreaterThanOrEqual((16 + 400 + 16) * 2)

    layout.stack = { left: 16, width: 120 }
    canvas.focus()
    canvas.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true, cancelable: true }))
    expect(fitAnimated).toHaveBeenCalledTimes(2)
    // The legend, 200px, is now the wider card.
    expect(fitAnimated.mock.calls[1][2]?.inset?.left).toBe((16 + 200 + 16) * 2)
  })

  it('does not move the map when Data folds or Colours opens after the first draw', async () => {
    const fitAnimated = vi.spyOn(Camera.prototype, 'fitAnimated')
    const { root } = await mountAndDraw()
    const fitsBefore = fitSpy.mock.calls.length
    const before = Array.from(camera().matrix())

    layout.stack = { left: 16, width: 120 }
    foldButton(root, 'data').click()
    expect(Array.from(camera().matrix())).toEqual(before)
    layout.stack = { left: 16, width: 256 }
    foldButton(root, 'colours').click()
    expect(Array.from(camera().matrix())).toEqual(before)

    expect(fitSpy.mock.calls.length).toBe(fitsBefore)
    expect(fitAnimated).not.toHaveBeenCalled()
  })

  it('fits exactly as before when no left card has any width', async () => {
    layout.stack = { left: 16, width: 0 }
    layout.legend = { left: 16, width: 0 }
    const { canvas } = await mountAndDraw()
    const drawn = Array.from(camera().matrix())
    expect((bandFits()[0][2] as { left: number }).left).toBe(0)

    const old = new Camera(canvas.width, canvas.height)
    old.fit(BOUNDS)
    expect(drawn).toEqual(Array.from(old.matrix()))
  })
})

const recording2d = createRecording2d()

// Where model (x, y) lands on the canvas, in canvas px; the canvas reports its own size as its box.
function canvasPoint(cam: Camera, canvas: HTMLCanvasElement, wx: number, wy: number): [number, number] {
  const m = cam.matrix()
  return [((m[0] * wx + m[6] + 1) / 2) * canvas.width, ((1 - (m[4] * wy + m[7])) / 2) * canvas.height]
}

function clickAt(canvas: HTMLCanvasElement, [x, y]: [number, number]): void {
  const init = { clientX: x, clientY: y, pointerId: 1, button: 0, bubbles: true, cancelable: true }
  canvas.dispatchEvent(new PointerEvent('pointerdown', init))
  canvas.dispatchEvent(new PointerEvent('pointerup', init))
  canvas.dispatchEvent(new MouseEvent('click', { clientX: x, clientY: y, bubbles: true }))
}

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0))
}

describe('the section fits right of the same band (LD-4)', () => {
  let setInset: MockInstance<SectionCamera['setInset']>
  let sectionFit: MockInstance<SectionCamera['fit']>

  beforeEach(() => {
    document.body.innerHTML = ''
    settleHooks.before = null
    settleHooks.calls = 0
    onValues = null
    framePaints.length = 0
    recording2d.calls.length = 0
    layout.area = { width: 1000, height: 800 }
    layout.stack = { left: 16, width: 256 }
    layout.legend = { left: 16, width: 200 }
    Object.defineProperty(window, 'devicePixelRatio', { value: 2, configurable: true })
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe(): void {}
        unobserve(): void {}
        disconnect(): void {}
      },
    )
    vi.stubGlobal(
      'requestAnimationFrame',
      vi.fn((cb: FrameRequestCallback) => {
        cb(0)
        return 1
      }),
    )
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(((type: string) =>
      type === '2d' ? recording2d.ctx : null) as typeof HTMLCanvasElement.prototype.getContext)
    stubFetch()
    stubLayout()
    fitSpy = vi.spyOn(Camera.prototype, 'fit')
    setInset = vi.spyOn(SectionCamera.prototype, 'setInset')
    sectionFit = vi.spyOn(SectionCamera.prototype, 'fit')
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  async function shownSection(): Promise<{ root: HTMLElement; canvas: HTMLCanvasElement }> {
    const { root, canvas } = await mountAndDraw()
    canvas.getBoundingClientRect = () => rect(0, canvas.width, canvas.height)
    ;(root.querySelector('button[aria-label="Draw section line"]') as HTMLButtonElement).click()
    clickAt(canvas, canvasPoint(camera(), canvas, 1, 0.5))
    clickAt(canvas, canvasPoint(camera(), canvas, 9, 0.5))
    const toggle = Array.from(root.querySelectorAll('button')).find((b) => b.textContent === 'Section view') as HTMLButtonElement
    toggle.click()
    await vi.waitFor(() => expect(toggle.getAttribute('aria-pressed')).toBe('true'))
    await settle()
    expect(sectionFit).toHaveBeenCalled()
    return { root, canvas }
  }

  const lastInset = (): SectionInset => setInset.mock.calls.at(-1)![0]

  it('fits the section on first show with the band plus the axis strip as its left inset, and paints the frame there', async () => {
    await shownSection()
    expect(lastInset()).toEqual({ left: (288 + 64) * 2, right: 0, top: 0, bottom: 44 * 2 })
    expect(framePaints.length).toBeGreaterThan(0)
    expect(framePaints.at(-1)).toBe(288)
  })

  it('moves neither the section nor its axis when a card folds, and fits to the band of the moment on Fit to extent', async () => {
    const { root, canvas } = await shownSection()
    const cam = sectionFit.mock.contexts.at(-1) as SectionCamera
    const before = [cam.screenToWorld(0, 0), cam.screenToWorld(500, 300)]
    const insets = setInset.mock.calls.length

    layout.stack = { left: 16, width: 120 }
    foldButton(root, 'data').click()
    expect([cam.screenToWorld(0, 0), cam.screenToWorld(500, 300)]).toEqual(before)
    expect(setInset.mock.calls.length).toBe(insets)
    // A pan repaints the frame; the axis stays at the band the last fit used.
    canvas.focus()
    canvas.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }))
    expect(framePaints.at(-1)).toBe(288)

    layout.stack = { left: 16, width: 400 }
    fitButton(root).click()
    expect(lastInset().left).toBe((16 + 400 + 16 + 64) * 2)
    expect(framePaints.at(-1)).toBe(16 + 400 + 16)
  })
})
