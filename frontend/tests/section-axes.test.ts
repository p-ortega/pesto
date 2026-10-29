// @vitest-environment jsdom
//
// The section's frame (D-19, D-21, D-35, D-40): d3 ticks of the visible distance and elevation,
// titles in model units when the grid records no unit, A and B at the line's ends, and a dashed
// outline over the plan's layer in every piece. Painted onto a recording 2D context.

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { scaleLinear } from 'd3-scale'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { parseSection, type SectionAnswer } from '../src/data/section'
import { SectionCamera } from '../src/gl/section-camera'
import {
  AXIS_BOTTOM_CSS_PX,
  AXIS_LEFT_CSS_PX,
  axesInset,
  renderSectionAxes,
  tickCount,
  type SectionAxes2D,
} from '../src/ui/section-axes'
import { createRecording2d, type RecordedCall } from './support/recording-2d'

const RAW = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'section-tracer-answer.json'), 'utf8'),
) as Record<string, unknown>
const W = 800
const H = 480
const LEFT = AXIS_LEFT_CSS_PX
const BASE = H - AXIS_BOTTOM_CSS_PX

function answer(changes: Record<string, unknown> = {}): SectionAnswer {
  return parseSection({ ...RAW, ...changes })
}

function fittedCamera(): SectionCamera {
  const camera = new SectionCamera(W, H)
  camera.setInset(axesInset(1))
  camera.fit([0, 3.5, 0, 10])
  return camera
}

let recording: ReturnType<typeof createRecording2d>
let area: HTMLElement

function mount() {
  return renderSectionAxes({ area, context: () => recording.ctx as SectionAxes2D })
}

const texts = (calls: RecordedCall[]) => calls.filter((c) => c.method === 'fillText')
const textAt = (calls: RecordedCall[], text: string) => texts(calls).find((c) => c.args[0] === text)
const bandRects = (calls: RecordedCall[]) => calls.filter((c) => c.method === 'strokeRect' && c.state.dash.length > 0)

beforeEach(() => {
  recording = createRecording2d()
  area = document.createElement('div')
  document.body.appendChild(area)
})

afterEach(() => {
  document.body.innerHTML = ''
})

describe('the axes', () => {
  it('labels the distance axis with d3 ticks of the visible distance and titles it in model units', () => {
    const camera = fittedCamera()
    mount().paint({ camera, answer: answer(), planLayer: 1, width: W, height: H })

    const domain: [number, number] = [camera.screenToWorld(LEFT, 0)[0], camera.screenToWorld(W, 0)[0]]
    const scale = scaleLinear().domain(domain).range([LEFT, W])
    const count = tickCount(W - LEFT, 1)
    const format = scale.tickFormat(count)
    const expected = scale.ticks(count).map((v) => format(v))
    expect(expected.length).toBeGreaterThan(2)
    for (const [i, label] of expected.entries()) {
      const call = textAt(recording.calls, label)
      expect(call, label).toBeDefined()
      expect(call!.args[1]).toBeCloseTo(scale(scale.ticks(count)[i]), 6)
      // Below the distance axis.
      expect(call!.args[2] as number).toBeGreaterThan(BASE)
    }
    expect(textAt(recording.calls, 'distance from A (model units)')).toBeDefined()
  })

  it('labels the elevation axis with d3 ticks of the visible elevation, higher values higher up', () => {
    const camera = fittedCamera()
    mount().paint({ camera, answer: answer(), planLayer: 0, width: W, height: H })

    const scale = scaleLinear().domain([camera.screenToWorld(0, BASE)[1], camera.screenToWorld(0, 0)[1]]).range([BASE, 0])
    const count = tickCount(BASE, 1)
    const format = scale.tickFormat(count)
    const ticks = scale.ticks(count)
    expect(ticks).toContain(10)
    expect(ticks).toContain(0)
    const ys = ticks.map((v) => {
      const call = textAt(recording.calls, format(v))
      expect(call, format(v)).toBeDefined()
      expect(call!.args[1] as number).toBeLessThan(LEFT)
      return call!.args[2] as number
    })
    for (let i = 1; i < ys.length; i++) expect(ys[i]).toBeLessThan(ys[i - 1])
    expect(textAt(recording.calls, 'elevation (model units)')).toBeDefined()
  })

  it('uses a recorded length unit as given, and never guesses one', () => {
    mount().paint({ camera: fittedCamera(), answer: answer({ length_units: 'metres' }), planLayer: 0, width: W, height: H })
    expect(textAt(recording.calls, 'distance from A (metres)')).toBeDefined()
    expect(textAt(recording.calls, 'elevation (metres)')).toBeDefined()
    expect(texts(recording.calls).some((c) => String(c.args[0]).includes('model units'))).toBe(false)
  })

  it('marks A and B at distances 0 and the line length', () => {
    const camera = fittedCamera()
    mount().paint({ camera, answer: answer(), planLayer: 0, width: W, height: H })
    expect(textAt(recording.calls, 'A')!.args[1]).toBeCloseTo(camera.worldToScreen(0, 0)[0], 6)
    expect(textAt(recording.calls, 'B')!.args[1]).toBeCloseTo(camera.worldToScreen(3.5, 0)[0], 6)
  })

  it('paints from the moved camera after a pan, so A moves with it', () => {
    const camera = fittedCamera()
    const frame = mount()
    frame.paint({ camera, answer: answer(), planLayer: 0, width: W, height: H })
    const before = textAt(recording.calls, 'A')!.args[1] as number
    recording.calls.length = 0
    camera.pan(60, 0)
    frame.paint({ camera, answer: answer(), planLayer: 0, width: W, height: H })
    expect(textAt(recording.calls, 'A')!.args[1]).toBeCloseTo(before + 60, 6)
  })

  it('leaves out an end the view does not reach', () => {
    const camera = fittedCamera()
    camera.pan(-2000, 0)
    mount().paint({ camera, answer: answer(), planLayer: 0, width: W, height: H })
    expect(textAt(recording.calls, 'A')).toBeUndefined()
    expect(textAt(recording.calls, 'B')).toBeUndefined()
  })
})

describe('the layer band', () => {
  it('outlines the plan layer in every piece, dashed', () => {
    const camera = fittedCamera()
    const held = answer()
    mount().paint({ camera, answer: held, planLayer: 1, width: W, height: H })
    const rects = bandRects(recording.calls)
    expect(rects).toHaveLength(3)
    for (let p = 0; p < 3; p++) {
      const [x0, y0] = camera.worldToScreen(held.s0[p], 5)
      const [x1, y1] = camera.worldToScreen(held.s1[p], 0)
      const [x, y, w, h] = rects[p].args as number[]
      expect(x).toBeCloseTo(x0, 6)
      expect(y).toBeCloseTo(y0, 6)
      expect(w).toBeCloseTo(x1 - x0, 6)
      expect(h).toBeCloseTo(y1 - y0, 6)
    }
  })

  it('moves to layer 0 on the next paint', () => {
    const camera = fittedCamera()
    const held = answer()
    const frame = mount()
    frame.paint({ camera, answer: held, planLayer: 1, width: W, height: H })
    recording.calls.length = 0
    frame.paint({ camera, answer: held, planLayer: 0, width: W, height: H })
    const rects = bandRects(recording.calls)
    expect(rects).toHaveLength(3)
    expect(rects[0].args[1]).toBeCloseTo(camera.worldToScreen(0, 10)[1], 6)
    expect((rects[0].args[1] as number) + (rects[0].args[3] as number)).toBeCloseTo(camera.worldToScreen(0, 5)[1], 6)
  })

  it('skips a piece with no finite elevation and draws no band for a layer the answer lacks', () => {
    const camera = fittedCamera()
    const frame = mount()
    frame.paint({ camera, answer: answer({ z: [10, 5, 0, 10, null, 0, 10, 5, 0] }), planLayer: 0, width: W, height: H })
    expect(bandRects(recording.calls)).toHaveLength(2)
    recording.calls.length = 0
    frame.paint({ camera, answer: answer(), planLayer: 2, width: W, height: H })
    expect(bandRects(recording.calls)).toHaveLength(0)
  })
})

describe('the overlay canvas', () => {
  it('is hidden until shown, sized to the map canvas, and removed on dispose', () => {
    const frame = mount()
    const overlay = area.querySelector('canvas.section-axes-overlay') as HTMLCanvasElement
    expect(overlay.hidden).toBe(true)
    frame.setVisible(true)
    expect(overlay.hidden).toBe(false)
    frame.paint({ camera: fittedCamera(), answer: answer(), planLayer: 0, width: W, height: H })
    expect(overlay.width).toBe(W)
    expect(overlay.height).toBe(H)
    frame.setVisible(false)
    expect(overlay.hidden).toBe(true)
    frame.dispose()
    expect(area.querySelector('canvas.section-axes-overlay')).toBeNull()
  })
})
