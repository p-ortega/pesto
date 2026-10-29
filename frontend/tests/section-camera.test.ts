// The section camera's vertical exaggeration (D-20, D-21): fitted and said so, or chosen and kept
// through every fit and zoom, and stated from the same number the matrix uses. A higher elevation
// is always drawn higher on screen (D-43).

import { afterEach, describe, expect, it, vi } from 'vitest'
import { MAX_ZOOM_FROM_FIT, MIN_ZOOM_FROM_FIT } from '../src/gl/camera'
import { SectionCamera } from '../src/gl/section-camera'

const BOUNDS: [number, number, number, number] = [0, 3.5, 0, 10]
const PADDING = 0.04

function fitted(): SectionCamera {
  const camera = new SectionCamera(800, 480)
  camera.fit(BOUNDS)
  return camera
}

// The box the bounds take on screen, as [left, right, top, bottom] in pixels.
function boxOnScreen(camera: SectionCamera, bounds = BOUNDS): [number, number, number, number] {
  const [sMin, sMax, zMin, zMax] = bounds
  const [left, top] = camera.worldToScreen(sMin, zMax)
  const [right, bottom] = camera.worldToScreen(sMax, zMin)
  return [left, right, top, bottom]
}

// The scale across, read back from two screen points one pixel apart.
function scaleX(camera: SectionCamera): number {
  return 1 / (camera.screenToWorld(1, 0)[0] - camera.screenToWorld(0, 0)[0])
}

describe('the vertical exaggeration', () => {
  it('fits both spans within the padding and states the fitted exaggeration', () => {
    const camera = fitted()
    const [left, right, top, bottom] = boxOnScreen(camera)
    expect(right - left).toBeCloseTo((1 - PADDING) * 800, 6)
    expect(bottom - top).toBeCloseTo((1 - PADDING) * 480, 6)
    expect(camera.ve()).toBeCloseTo(((1 - PADDING) * 480) / 10 / (((1 - PADDING) * 800) / 3.5), 9)
    expect(camera.veText()).toBe('vertical exaggeration 0.21× (fitted)')
  })

  it('uses a chosen exaggeration as given, keeps the view centre still, and states it without "fitted"', () => {
    const camera = fitted()
    const centre = camera.screenToWorld(400, 240)
    camera.setVe(10)
    expect(camera.ve()).toBe(10)
    const after = camera.screenToWorld(400, 240)
    expect(after[0]).toBeCloseTo(centre[0], 9)
    expect(after[1]).toBeCloseTo(centre[1], 9)
    expect(camera.veText()).toBe('vertical exaggeration 10×')
    camera.setVe(1)
    expect(camera.veText()).toBe('vertical exaggeration 1×')
  })

  it('states the number at every choice, 1× included', () => {
    const camera = fitted()
    for (const ve of [1, 2, 5, 10, 20, 50, 100]) {
      camera.setVe(ve)
      expect(camera.veText()).toBe(`vertical exaggeration ${ve}×`)
    }
  })

  it('keeps a chosen exaggeration through a fit and shows the whole box', () => {
    const camera = new SectionCamera(800, 480)
    camera.setVe(10)
    camera.fit(BOUNDS)
    expect(camera.ve()).toBe(10)
    const [left, right, top, bottom] = boxOnScreen(camera)
    expect(left).toBeGreaterThanOrEqual(-1e-9)
    expect(right).toBeLessThanOrEqual(800 + 1e-9)
    expect(top).toBeGreaterThanOrEqual(-1e-9)
    expect(bottom).toBeLessThanOrEqual(480 + 1e-9)
    // One span fills the box within the padding, the other fits inside it.
    expect(Math.max((right - left) / 800, (bottom - top) / 480)).toBeCloseTo(1 - PADDING, 6)
  })

  it('goes back to the fitted value with "(fitted)" again', () => {
    const camera = fitted()
    const fittedVe = camera.ve()
    camera.setVe(50)
    expect(camera.veText()).not.toContain('fitted')
    camera.setVe('fitted')
    expect(camera.ve()).toBeCloseTo(fittedVe, 12)
    expect(camera.veText()).toBe('vertical exaggeration 0.21× (fitted)')
    expect(camera.veMode()).toBe('fitted')
  })

  it('ignores an exaggeration that is not a positive finite number', () => {
    const camera = fitted()
    const before = camera.ve()
    camera.setVe(0)
    camera.setVe(-5)
    camera.setVe(Number.NaN)
    camera.setVe(Number.POSITIVE_INFINITY)
    expect(camera.ve()).toBe(before)
    expect(camera.veMode()).toBe('fitted')
  })
})

describe('zoom and pan keep the exaggeration', () => {
  it('never changes the exaggeration on a zoom, fitted or chosen', () => {
    const camera = fitted()
    const ve = camera.ve()
    camera.zoomAt(100, 100, 1.5)
    camera.zoomAt(700, 400, 0.3)
    expect(camera.ve()).toBe(ve)
    camera.setVe(20)
    camera.zoomAt(400, 240, 3)
    camera.pan(30, -12)
    expect(camera.ve()).toBe(20)
    expect(camera.veText()).toBe('vertical exaggeration 20×')
  })

  it('holds a run of zooms within 0.1 and 1000 times the fit scale', () => {
    const camera = fitted()
    const fitScale = scaleX(camera)
    for (let i = 0; i < 200; i++) camera.zoomAt(400, 240, 2)
    expect(scaleX(camera) / fitScale).toBeCloseTo(MAX_ZOOM_FROM_FIT, 6)
    for (let i = 0; i < 400; i++) camera.zoomAt(400, 240, 0.5)
    expect(scaleX(camera) / fitScale).toBeCloseTo(MIN_ZOOM_FROM_FIT, 6)
  })
})

describe('higher is higher on screen', () => {
  it('draws elevation 9 above elevation 1 at any zoom, pan and exaggeration', () => {
    const camera = fitted()
    const moves: Array<(c: SectionCamera) => void> = [
      (c) => c.zoomAt(10, 20, 7),
      (c) => c.pan(-300, 500),
      (c) => c.setVe(100),
      (c) => c.zoomAt(790, 470, 0.15),
      (c) => c.setVe(1),
      (c) => c.pan(1000, -1000),
      (c) => c.setVe('fitted'),
      (c) => c.resize(320, 900),
    ]
    for (const s of [-2, 0, 1.75, 3.5, 40]) expect(camera.worldToScreen(s, 9)[1]).toBeLessThan(camera.worldToScreen(s, 1)[1])
    for (const move of moves) {
      move(camera)
      for (const s of [-2, 0, 1.75, 3.5, 40]) expect(camera.worldToScreen(s, 9)[1]).toBeLessThan(camera.worldToScreen(s, 1)[1])
      // The matrix agrees: its vertical scale is positive, so clip y grows with elevation.
      expect(camera.matrix([0, 0])[4]).toBeGreaterThan(0)
    }
  })
})

describe('SectionCamera.fitAnimated', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  function target(mode: 'fitted' | number = 'fitted'): Float32Array {
    const camera = new SectionCamera(800, 480)
    camera.setVe(mode)
    camera.fit(BOUNDS)
    return camera.matrix([1, 2])
  }

  it('jumps to exactly the fit target in one frame when reduced is set', () => {
    const raf = vi.fn()
    vi.stubGlobal('requestAnimationFrame', raf)
    const camera = new SectionCamera(800, 480)
    camera.fit(BOUNDS)
    camera.pan(120, -40)
    camera.zoomAt(200, 200, 4)
    const onFrame = vi.fn()
    camera.fitAnimated(BOUNDS, onFrame, { reduced: true })
    expect(onFrame).toHaveBeenCalledTimes(1)
    expect(raf).not.toHaveBeenCalled()
    expect(Array.from(camera.matrix([1, 2]))).toEqual(Array.from(target()))
  })

  it('eases and ends on exactly the fit target when reduced is not set, at a chosen exaggeration too', () => {
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

    const camera = new SectionCamera(800, 480)
    camera.setVe(5)
    camera.fit(BOUNDS)
    camera.pan(200, 90)
    const onFrame = vi.fn()
    camera.fitAnimated(BOUNDS, onFrame, { reduced: false, duration: 200 })
    expect(onFrame).not.toHaveBeenCalled()

    time = 100
    callbacks.shift()!(time)
    expect(Array.from(camera.matrix([1, 2]))).not.toEqual(Array.from(target(5)))
    expect(camera.ve()).toBe(5)

    time = 200
    callbacks.shift()!(time)
    expect(onFrame).toHaveBeenCalledTimes(2)
    expect(Array.from(camera.matrix([1, 2]))).toEqual(Array.from(target(5)))
    expect(callbacks.length).toBe(0)
  })

  it('stops an ease still running when the user pans', () => {
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
    const camera = new SectionCamera(800, 480)
    camera.fit(BOUNDS)
    camera.pan(300, 0)
    const onFrame = vi.fn()
    camera.fitAnimated(BOUNDS, onFrame, { duration: 200 })
    camera.pan(5, 5)
    const held = Array.from(camera.matrix([0, 0]))
    time = 200
    callbacks.shift()!(time)
    expect(onFrame).not.toHaveBeenCalled()
    expect(Array.from(camera.matrix([0, 0]))).toEqual(held)
  })
})
