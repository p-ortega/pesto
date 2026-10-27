// The spaghetti line layer, exercised against the recording GL stub. These
// tests assert the index run and the calls made, never pixels.

import { describe, expect, it } from 'vitest'
import { LineLayer, RESTART_INDEX, buildStripIndices, type LineSeries } from '../src/gl/line-layer'
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
