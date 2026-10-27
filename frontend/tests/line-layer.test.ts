// The spaghetti line layer, exercised against the recording GL stub. These
// tests assert the index run and the calls made, never pixels.

import { describe, expect, it } from 'vitest'
import { LineLayer, RESTART_INDEX, buildStripIndices, type LinePanel, type LineSeries } from '../src/gl/line-layer'
import { createRecordingGl } from './support/recording-gl'

const R = RESTART_INDEX
const NaN_ = Number.NaN

// Observation-major: value of realization r at time t is values[t * nReal + r].
function series(count: number, nReal: number, values?: number[]): LineSeries {
  const v = new Float32Array(values ?? Array.from({ length: count * nReal }, (_, i) => i))
  const x = new Float32Array(Array.from({ length: count }, (_, t) => t))
  return { values: v, count, nReal, x }
}

describe('buildStripIndices', () => {
  it('runs each realization through its times with a restart after it', () => {
    const s = series(3, 2)
    const { indices, nonFinite } = buildStripIndices(s.values, 3, 2)
    expect(Array.from(indices)).toEqual([0, 2, 4, R, 1, 3, 5, R])
    expect(nonFinite).toBe(0)
  })

  it('breaks the line at a NaN and points no index at it', () => {
    const s = series(3, 2, [1, 2, NaN_, 4, 5, 6])
    const { indices, nonFinite } = buildStripIndices(s.values, 3, 2)
    expect(Array.from(indices)).toEqual([0, R, 4, R, 1, 3, 5, R])
    expect(indices).not.toContain(2)
    expect(nonFinite).toBe(1)
  })

  it('treats infinity as missing too', () => {
    const s = series(3, 1, [1, Infinity, 3])
    const { indices, nonFinite } = buildStripIndices(s.values, 3, 1)
    expect(Array.from(indices)).toEqual([0, R, 2, R])
    expect(nonFinite).toBe(1)
  })

  it('never emits two restarts in a row', () => {
    const s = series(5, 1, [NaN_, 1, NaN_, NaN_, 2])
    const { indices } = buildStripIndices(s.values, 5, 1)
    expect(Array.from(indices)).toEqual([1, R, 4, R])
    for (let i = 1; i < indices.length; i++) {
      expect(indices[i] === R && indices[i - 1] === R).toBe(false)
    }
  })

  it('adds nothing for a realization with no finite value', () => {
    const s = series(2, 2, [NaN_, 1, NaN_, 3])
    const { indices, nonFinite } = buildStripIndices(s.values, 2, 2)
    expect(Array.from(indices)).toEqual([1, 3, R])
    expect(nonFinite).toBe(2)
  })
})

describe('LineLayer tracer', () => {
  it('uploads values, indices and x offsets once and draws one indexed LINE_STRIP', () => {
    const { gl, calls } = createRecordingGl()
    const layer = new LineLayer(gl)
    const result = layer.setSeries('a', series(3, 2))
    expect(result.nonFinite).toBe(0)

    const uploads = calls.filter((c) => c.method === 'bufferData')
    expect(uploads.map((c) => c.args[0])).toEqual(['ARRAY_BUFFER', 'ELEMENT_ARRAY_BUFFER'])
    const xTex = calls.filter((c) => c.method === 'texImage2D')
    expect(xTex).toHaveLength(1)
    expect(xTex[0].args[2]).toBe('R32F')

    calls.length = 0
    layer.draw([
      {
        viewport: [0, 0, 100, 50],
        xDomain: [0, 2],
        yDomain: [0, 5],
        strips: [{ key: 'a', rgba: [0.1, 0.2, 0.3, 0.15] }],
      },
    ])
    expect(calls.filter((c) => c.method === 'viewport')).toHaveLength(1)
    expect(calls.filter((c) => c.method === 'scissor')).toHaveLength(1)
    const draws = calls.filter((c) => c.method === 'drawElements')
    expect(draws).toHaveLength(1)
    expect(draws[0].args).toEqual(['LINE_STRIP', 8, 'UNSIGNED_INT', 0])
  })

  it('reports how many values it left out', () => {
    const { gl } = createRecordingGl()
    const layer = new LineLayer(gl)
    expect(layer.setSeries('a', series(3, 2, [1, 2, NaN_, 4, 5, 6])).nonFinite).toBe(1)
  })

  it('reads time from gl_VertexID and enables no time attribute', () => {
    const { gl, calls } = createRecordingGl()
    new LineLayer(gl).setSeries('a', series(3, 2))
    const sources = calls.filter((c) => c.method === 'shaderSource').map((c) => String(c.args[1]))
    const vertex = sources.find((s) => s.includes('gl_Position'))!
    expect(vertex).toContain('gl_VertexID / u_nReal')
    expect(vertex).toContain('texelFetch')
    expect(vertex.match(/\bin\s+\w+\s+a_\w+/g)).toEqual(['in float a_value'])
    expect(calls.filter((c) => c.method === 'enableVertexAttribArray')).toHaveLength(1)
  })
})

function panel(keys: string[], x0 = 0): LinePanel {
  return {
    viewport: [0, 0, 100, 50],
    xDomain: [x0, x0 + 2],
    yDomain: [0, 5],
    strips: keys.map((key) => ({ key, rgba: [0.1, 0.2, 0.3, 0.15] as [number, number, number, number] })),
  }
}

describe('LineLayer panels', () => {
  it('sets viewport and scissor once per panel and draws each strip with its own colour', () => {
    const { gl, calls } = createRecordingGl()
    const layer = new LineLayer(gl)
    for (const key of ['a', 'b', 'c', 'd', 'e', 'f']) layer.setSeries(key, series(3, 2))
    calls.length = 0

    const panels: LinePanel[] = [panel(['a', 'b']), panel(['c', 'd']), panel(['e', 'f'])]
    panels[0].strips[1].rgba = [0.9, 0.8, 0.7, 0.5]
    layer.draw(panels)

    expect(calls.filter((c) => c.method === 'viewport')).toHaveLength(3)
    expect(calls.filter((c) => c.method === 'scissor')).toHaveLength(3)
    expect(calls.filter((c) => c.method === 'drawElements')).toHaveLength(6)
    const colours = calls.filter((c) => c.method === 'uniform4f').map((c) => c.args.slice(1))
    expect(colours).toHaveLength(6)
    expect(colours[0]).toEqual([0.1, 0.2, 0.3, 0.15])
    expect(colours[1]).toEqual([0.9, 0.8, 0.7, 0.5])
  })

  it('turns the scissor test on for the call and off after', () => {
    const { gl, calls } = createRecordingGl()
    const layer = new LineLayer(gl)
    layer.setSeries('a', series(3, 2))
    calls.length = 0
    layer.draw([panel(['a'])])
    const states = calls.filter((c) => c.args[0] === 'SCISSOR_TEST').map((c) => c.method)
    expect(states).toEqual(['enable', 'disable'])
  })

  it('uploads nothing when only the domain changes', () => {
    const { gl, calls } = createRecordingGl()
    const layer = new LineLayer(gl)
    layer.setSeries('a', series(3, 2))
    layer.draw([panel(['a'])])
    calls.length = 0
    layer.draw([panel(['a'], 1)])
    expect(calls.some((c) => ['bufferData', 'texImage2D', 'texSubImage2D'].includes(c.method))).toBe(false)
    expect(calls.filter((c) => c.method === 'drawElements')).toHaveLength(1)
  })

  it('draws nothing and clears nothing for an empty panel list', () => {
    const { gl, calls } = createRecordingGl()
    const layer = new LineLayer(gl)
    layer.setSeries('a', series(3, 2))
    calls.length = 0
    layer.draw([])
    expect(calls).toEqual([])
  })

  it('skips a strip whose key is unknown', () => {
    const { gl, calls } = createRecordingGl()
    const layer = new LineLayer(gl)
    layer.setSeries('a', series(3, 2))
    calls.length = 0
    layer.draw([panel(['a', 'missing'])])
    expect(calls.filter((c) => c.method === 'drawElements')).toHaveLength(1)
  })

  it('refuses a series whose value count does not match its shape', () => {
    const { gl } = createRecordingGl()
    const layer = new LineLayer(gl)
    const bad = series(3, 2)
    expect(() => layer.setSeries('a', { ...bad, nReal: 3 })).toThrow(/not 3 times x 3/)
  })
})

describe('LineLayer lifetime', () => {
  it('deletes the buffers and texture of a removed series and then skips it', () => {
    const { gl, calls } = createRecordingGl()
    const layer = new LineLayer(gl)
    layer.setSeries('a', series(3, 2))
    calls.length = 0
    layer.removeSeries('a')
    const count = (m: string) => calls.filter((c) => c.method === m).length
    expect(count('deleteBuffer')).toBe(2)
    expect(count('deleteTexture')).toBe(1)
    expect(count('deleteVertexArray')).toBe(1)
    calls.length = 0
    layer.draw([panel(['a'])])
    expect(calls.filter((c) => c.method === 'drawElements')).toHaveLength(0)
  })

  it('replacing a series frees the old one first', () => {
    const { gl, calls } = createRecordingGl()
    const layer = new LineLayer(gl)
    layer.setSeries('a', series(3, 2))
    calls.length = 0
    layer.setSeries('a', series(3, 2))
    expect(calls.filter((c) => c.method === 'deleteBuffer')).toHaveLength(2)
  })

  it('uploads every kept series again after a restored context, with the same bytes', () => {
    const { gl, calls } = createRecordingGl()
    const layer = new LineLayer(gl)
    layer.setSeries('a', series(3, 2))
    layer.setSeries('b', series(4, 2, [1, 2, NaN_, 4, 5, 6, 7, 8]))
    const firstUploads = calls.filter((c) => c.method === 'bufferData').map((c) => c.args)
    const panels = [panel(['a']), panel(['b'])]
    calls.length = 0
    layer.draw(panels)
    const before = calls.filter((c) => c.method === 'drawElements').map((c) => c.args)

    calls.length = 0
    layer.reupload()
    const secondUploads = calls.filter((c) => c.method === 'bufferData').map((c) => c.args)
    expect(secondUploads).toEqual(firstUploads)
    expect(calls.filter((c) => c.method === 'texImage2D')).toHaveLength(2)

    calls.length = 0
    layer.draw(panels)
    expect(calls.filter((c) => c.method === 'drawElements').map((c) => c.args)).toEqual(before)
  })

  it('frees every object on dispose', () => {
    const { gl, calls } = createRecordingGl()
    const layer = new LineLayer(gl)
    layer.setSeries('a', series(3, 2))
    calls.length = 0
    layer.dispose()
    expect(calls.filter((c) => c.method === 'deleteProgram')).toHaveLength(1)
    expect(calls.filter((c) => c.method === 'deleteBuffer')).toHaveLength(2)
    expect(calls.filter((c) => c.method === 'deleteTexture')).toHaveLength(1)
  })
})
