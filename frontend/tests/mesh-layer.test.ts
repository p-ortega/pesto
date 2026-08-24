// Behaviours 3-5 of plan 05.1-03: scaleLimits' robust percentiles, ramp's
// 256-entry interpolation, and MeshLayer's NEAREST-filtered value upload.
// MeshLayer is exercised against a recording stub standing in for
// WebGL2RenderingContext -- these tests assert the calls made, never
// pixels; the screenshot in tests/visual/mesh.spec.ts is what proves those.

import { describe, expect, it } from 'vitest'
import { ramp, scaleLimits, STOPS, hexToRgb } from '../src/gl/colormap'
import { MeshLayer, type MeshData } from '../src/gl/mesh-layer'
import { createRecordingGl } from './support/recording-gl'

describe('scaleLimits', () => {
  it('returns the 2nd and 98th percentile of the finite values, ignoring NaN', () => {
    const values = new Float32Array(
      Array.from({ length: 100 }, (_, i) => i).concat([Number.NaN, Number.NaN]),
    )
    const [lo, hi] = scaleLimits(values, 'robust')
    expect(lo).toBeCloseTo(1, 5)
    expect(hi).toBeCloseTo(98, 5)
  })

  it('returns a usable range when every value is identical', () => {
    const [lo, hi] = scaleLimits(new Float32Array([5, 5, 5]), 'robust')
    expect(hi).toBeGreaterThanOrEqual(lo)
  })

  it('returns a usable range when everything is missing', () => {
    const [lo, hi] = scaleLimits(new Float32Array([Number.NaN, Number.NaN]), 'robust')
    expect(Number.isFinite(lo)).toBe(true)
    expect(Number.isFinite(hi)).toBe(true)
    expect(hi).toBeGreaterThan(lo)
  })
})

describe('ramp', () => {
  it('has all nine ramp names', () => {
    expect(Object.keys(STOPS).sort()).toEqual(
      ['BrBG', 'RdBu', 'cividis', 'coolwarm', 'greys', 'jet', 'magma', 'turbo', 'viridis'].sort(),
    )
  })

  it('returns 256 RGBA entries whose first and last match the first and last stop', () => {
    const bytes = ramp('viridis')
    expect(bytes.length).toBe(256 * 4)

    const [r0, g0, b0] = hexToRgb(STOPS.viridis.hex[0])
    expect(Array.from(bytes.slice(0, 4))).toEqual([r0, g0, b0, 255])

    const last = STOPS.viridis.hex.length - 1
    const [rN, gN, bN] = hexToRgb(STOPS.viridis.hex[last])
    expect(Array.from(bytes.slice(255 * 4, 256 * 4))).toEqual([rN, gN, bN, 255])
  })
})

// createRecordingGl moved to tests/support/recording-gl.ts so the map
// integration test can share the same stub.

// Three unit quads side by side, matching the reference harness's own
// three-cell layout (docs/superpowers/plans/2026-08-12-pesto-m0.md).
function threeCellMesh(): MeshData {
  const positions = new Float32Array([
    0, 0, 1, 0, 1, 1, 0, 1, 1, 0, 2, 0, 2, 1, 1, 1, 2, 0, 3, 0, 3, 1, 2, 1,
  ])
  const cellIndex = new Float32Array([0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2])
  const indices = new Uint32Array([0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7, 8, 9, 10, 8, 10, 11])
  return { positions, cellIndex, indices, nCells: 3 }
}

describe('MeshLayer', () => {
  // WINDOWS.md #6: a cell with no value must read as absence whether the
  // texel holds NaN or +/-Infinity. `value != value` only ever catches
  // NaN -- an infinity is equal to itself, so that comparison alone lets a
  // non-finite value through to be clamped and drawn as if it were data.
  it('the fill vertex shader treats every non-finite value as missing, not only NaN', () => {
    const { gl, calls } = createRecordingGl()
    new MeshLayer(gl, threeCellMesh())

    const sources = calls.filter((c) => c.method === 'shaderSource').map((c) => c.args[1] as string)
    const vertexSource = sources.find((s) => s.includes('v_missing'))
    expect(vertexSource).toBeDefined()
    expect(vertexSource).toMatch(/isnan\(\s*value\s*\)/)
    expect(vertexSource).toMatch(/isinf\(\s*value\s*\)/)
  })

  it('sets NEAREST filtering on the values texture at construction', () => {
    const { gl, calls } = createRecordingGl()
    new MeshLayer(gl, threeCellMesh())

    const minFilter = calls.find(
      (c) => c.method === 'texParameteri' && c.args[1] === 'TEXTURE_MIN_FILTER',
    )
    const magFilter = calls.find(
      (c) => c.method === 'texParameteri' && c.args[1] === 'TEXTURE_MAG_FILTER' && c.args[2] === 'NEAREST',
    )
    expect(minFilter?.args[2]).toBe('NEAREST')
    expect(magFilter).toBeDefined()
  })

  it('setValues uploads the field with texSubImage2D in RED/FLOAT', () => {
    const { gl, calls } = createRecordingGl()
    const layer = new MeshLayer(gl, threeCellMesh())
    layer.setValues(new Float32Array([0, 0.5, Number.NaN]))

    const upload = calls.find((c) => c.method === 'texSubImage2D')
    expect(upload).toBeDefined()
    expect(upload?.args[6]).toBe('RED')
    expect(upload?.args[7]).toBe('FLOAT')
  })

  it('draw issues exactly one drawElements call for the fill pass', () => {
    const { gl, calls } = createRecordingGl()
    const layer = new MeshLayer(gl, threeCellMesh())
    layer.setValues(new Float32Array([0, 0.5, 1]))
    layer.setLimits([0, 1])
    layer.draw()

    const draws = calls.filter((c) => c.method === 'drawElements')
    expect(draws.length).toBe(1)
    expect(draws[0].args[0]).toBe('TRIANGLES')
  })

  it('setInactive draws a hairline outline for a cell outside the model, and nothing for one merely absent from the field', () => {
    const { gl, calls } = createRecordingGl()
    const layer = new MeshLayer(gl, threeCellMesh())
    // Cell 1 carries no parameter of the drawn group (NaN, no outline);
    // cell 2 is outside the model entirely (inactive, hairline outline).
    layer.setValues(new Float32Array([0, Number.NaN, Number.NaN]))
    layer.setLimits([0, 1])
    layer.setInactive(new Uint8Array([0, 0, 1]))
    layer.setHairlineColor([0.5, 0.5, 0.5])
    layer.draw()

    const lineDraws = calls.filter((c) => c.method === 'drawElements' && c.args[0] === 'LINES')
    expect(lineDraws.length).toBe(1)
    // Cell 2's ring is 4 vertices -> 4 edges -> 8 line-list indices.
    expect(lineDraws[0].args[1]).toBe(8)
  })

  it('draws no outline at all when nothing is marked inactive', () => {
    const { gl, calls } = createRecordingGl()
    const layer = new MeshLayer(gl, threeCellMesh())
    layer.setValues(new Float32Array([0, Number.NaN, 1]))
    layer.setLimits([0, 1])
    layer.setInactive(new Uint8Array([0, 0, 0]))
    layer.draw()

    expect(calls.some((c) => c.method === 'drawElements' && c.args[0] === 'LINES')).toBe(false)
  })

  it('reads the outline colour from whatever was last set, so a theme change can re-read it', () => {
    const { gl, calls } = createRecordingGl()
    const layer = new MeshLayer(gl, threeCellMesh())
    layer.setInactive(new Uint8Array([1, 0, 0]))

    layer.setHairlineColor([0.1, 0.2, 0.3])
    layer.draw()
    const first = calls.filter((c) => c.method === 'uniform3f').at(-1)
    expect(first?.args.slice(1)).toEqual([0.1, 0.2, 0.3])

    layer.setHairlineColor([0.9, 0.8, 0.7])
    layer.draw()
    const second = calls.filter((c) => c.method === 'uniform3f').at(-1)
    expect(second?.args.slice(1)).toEqual([0.9, 0.8, 0.7])
  })

  it('reupload rebuilds every GL object from the arrays and state already held', () => {
    const { gl, calls } = createRecordingGl()
    const layer = new MeshLayer(gl, threeCellMesh())
    layer.setValues(new Float32Array([1, 2, 3]))
    calls.length = 0

    layer.reupload()

    expect(calls.some((c) => c.method === 'createProgram')).toBe(true)
    expect(calls.some((c) => c.method === 'createVertexArray')).toBe(true)
    // The field held before the loss is re-applied without a fresh fetch.
    expect(calls.some((c) => c.method === 'texSubImage2D')).toBe(true)
  })

  it('setContested draws a stripe pass and forces contested cells to NaN in the value pass, even when the caller supplies a value for one', () => {
    const { gl, calls } = createRecordingGl()
    const layer = new MeshLayer(gl, threeCellMesh())
    layer.setContested(new Uint8Array([0, 1, 0]))
    // Cell 1 is contested, but a value is supplied for it anyway -- the
    // layer must still exclude it from the value pass (T-5.1-15).
    layer.setValues(new Float32Array([0, 5, 1]))
    layer.setLimits([0, 1])
    layer.draw()

    const triDraws = calls.filter((c) => c.method === 'drawElements' && c.args[0] === 'TRIANGLES')
    // One for the contested stripe pass, one for the fill pass.
    expect(triDraws.length).toBe(2)
    // Cell 1's ring is a quad -> 2 triangles -> 6 indices.
    expect(triDraws[0].args[1]).toBe(6)

    const upload = calls.filter((c) => c.method === 'texSubImage2D').at(-1)
    const staging = upload?.args[8] as Float32Array
    expect(Number.isNaN(staging[1])).toBe(true)
  })

  it('draws no contested pass at all when nothing is marked contested', () => {
    const { gl, calls } = createRecordingGl()
    const layer = new MeshLayer(gl, threeCellMesh())
    layer.setContested(new Uint8Array([0, 0, 0]))
    layer.setValues(new Float32Array([0, 0.5, 1]))
    layer.setLimits([0, 1])
    layer.draw()

    // Exactly the fill pass's own TRIANGLES draw -- no stripe pass.
    expect(calls.filter((c) => c.method === 'drawElements' && c.args[0] === 'TRIANGLES').length).toBe(1)
  })

  it('setSelected draws an accent ring over whatever mark the cell already has, and setSelected(null) removes it', () => {
    const { gl, calls } = createRecordingGl()
    const layer = new MeshLayer(gl, threeCellMesh())
    layer.setAccentColor([0.2, 0.4, 0.6])
    layer.setSelected(1)
    layer.draw()

    const ringDraws = calls.filter((c) => c.method === 'drawElements' && c.args[0] === 'LINES')
    expect(ringDraws.length).toBe(1)
    // Cell 1's ring is 4 vertices -> 4 edges -> 8 line-list indices.
    expect(ringDraws[0].args[1]).toBe(8)
    const ringColor = calls.filter((c) => c.method === 'uniform3f').at(-1)
    expect(ringColor?.args.slice(1)).toEqual([0.2, 0.4, 0.6])

    calls.length = 0
    layer.setSelected(null)
    layer.draw()
    expect(calls.some((c) => c.method === 'drawElements' && c.args[0] === 'LINES')).toBe(false)
  })

  it('re-reads the stripe and accent colours from whatever was last set, so a theme change can re-read them', () => {
    const { gl, calls } = createRecordingGl()
    const layer = new MeshLayer(gl, threeCellMesh())
    layer.setContested(new Uint8Array([1, 0, 0]))
    layer.setSelected(0)

    layer.setContestedColors([0.1, 0.1, 0.1], [0.9, 0.9, 0.9])
    layer.setAccentColor([0.2, 0.2, 0.2])
    layer.draw()
    const stripeCalls1 = calls.filter((c) => c.method === 'uniform3f')
    expect(stripeCalls1.some((c) => c.args.slice(1).every((v, i) => v === [0.1, 0.1, 0.1][i]))).toBe(true)

    calls.length = 0
    layer.setContestedColors([0.7, 0.7, 0.7], [0.3, 0.3, 0.3])
    layer.setAccentColor([0.8, 0.8, 0.8])
    layer.draw()
    const stripeCalls2 = calls.filter((c) => c.method === 'uniform3f')
    expect(stripeCalls2.some((c) => c.args.slice(1).every((v, i) => v === [0.7, 0.7, 0.7][i]))).toBe(true)
    expect(stripeCalls2.some((c) => c.args.slice(1).every((v, i) => v === [0.8, 0.8, 0.8][i]))).toBe(true)
  })
})
