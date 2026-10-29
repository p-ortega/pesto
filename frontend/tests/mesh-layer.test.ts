// Behaviours 3-5 of plan 05.1-03: scaleLimits' robust percentiles, ramp's
// 256-entry interpolation, and MeshLayer's NEAREST-filtered value upload.
// MeshLayer is exercised against a recording stub standing in for
// WebGL2RenderingContext -- these tests assert the calls made, never
// pixels; the screenshot in tests/visual/mesh.spec.ts is what proves those.

import { describe, expect, it } from 'vitest'
import { classTexelIndices, ramp, scaleLimits, STOPS, hexToRgb } from '../src/gl/colormap'
import { MeshLayer, type MeshData } from '../src/gl/mesh-layer'
import { createRecordingGl } from './support/recording-gl'
import { gridMesh } from './support/grid-mesh'

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
    layer.setHairlineColor([0.5, 0.5, 0.5, 1])
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

    layer.setHairlineColor([0.1, 0.2, 0.3, 1])
    layer.draw()
    const first = calls.filter((c) => c.method === 'uniform4f').at(-1)
    expect(first?.args.slice(1)).toEqual([0.1, 0.2, 0.3, 1])

    layer.setHairlineColor([0.9, 0.8, 0.7, 1])
    layer.draw()
    const second = calls.filter((c) => c.method === 'uniform4f').at(-1)
    expect(second?.args.slice(1)).toEqual([0.9, 0.8, 0.7, 1])
  })

  // WINDOWS.md #12: the hairline's authored alpha (0.1, i.e. 10% opacity)
  // must reach the GPU and actually blend, not just be carried as a number
  // that the shader then ignores -- otherwise the outline still draws at
  // full strength even though parseColorToken now reports the true alpha.
  it('draws the hairline outline with its authored alpha and enables blending scoped to that one pass', () => {
    const { gl, calls } = createRecordingGl()
    const layer = new MeshLayer(gl, threeCellMesh())
    layer.setInactive(new Uint8Array([1, 0, 0]))
    layer.setHairlineColor([1, 1, 1, 26 / 255])
    layer.draw()

    const outlineColorCall = calls.filter((c) => c.method === 'uniform4f').at(0)
    expect(outlineColorCall?.args.slice(1)).toEqual([1, 1, 1, 26 / 255])

    const enableBlendIdx = calls.findIndex((c) => c.method === 'enable' && c.args[0] === 'BLEND')
    const blendFuncIdx = calls.findIndex((c) => c.method === 'blendFunc')
    const drawIdx = calls.findIndex((c) => c.method === 'drawElements' && c.args[0] === 'LINES')
    const disableBlendIdx = calls.findIndex((c) => c.method === 'disable' && c.args[0] === 'BLEND')

    expect(enableBlendIdx).toBeGreaterThanOrEqual(0)
    expect(blendFuncIdx).toBeGreaterThan(enableBlendIdx)
    expect(blendFuncIdx).toBeLessThan(drawIdx)
    // Blend state is restored right after the hairline's own draw call, so
    // the fill/contested/selection passes that follow are never affected.
    expect(disableBlendIdx).toBeGreaterThan(drawIdx)
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

  it('setSelected draws a light halo then an accent band over the cell, and setSelected(null) removes it', () => {
    const { gl, calls } = createRecordingGl()
    const layer = new MeshLayer(gl, threeCellMesh())
    layer.setAccentColor([0.2, 0.4, 0.6], [0.9, 0.9, 0.9])
    layer.setSelected(1)
    calls.length = 0
    layer.draw()

    // The fill pass is one TRIANGLES draw; the ring adds two more.
    const triDraws = calls.filter((c) => c.method === 'drawElements' && c.args[0] === 'TRIANGLES')
    expect(triDraws.length).toBe(3)
    // Cell 1's ring is 4 edges -> 4 quads -> 24 indices.
    expect(triDraws[1].args[1]).toBe(24)
    expect(triDraws[2].args[1]).toBe(24)
    expect(calls.some((c) => c.method === 'drawElements' && c.args[0] === 'LINES')).toBe(false)
    const colors = calls.filter((c) => c.method === 'uniform3f').slice(-2).map((c) => c.args.slice(1))
    expect(colors).toEqual([
      [0.9, 0.9, 0.9],
      [0.2, 0.4, 0.6],
    ])
    const widths = calls.filter((c) => c.method === 'uniform1f').slice(-2).map((c) => c.args[1] as number)
    expect(widths[0]).toBeGreaterThan(widths[1])

    calls.length = 0
    layer.setSelected(null)
    layer.draw()
    expect(calls.filter((c) => c.method === 'drawElements' && c.args[0] === 'TRIANGLES').length).toBe(1)
  })

  it('re-reads the stripe and accent colours from whatever was last set, so a theme change can re-read them', () => {
    const { gl, calls } = createRecordingGl()
    const layer = new MeshLayer(gl, threeCellMesh())
    layer.setContested(new Uint8Array([1, 0, 0]))
    layer.setSelected(0)

    layer.setContestedColors([0.1, 0.1, 0.1], [0.9, 0.9, 0.9])
    layer.setAccentColor([0.2, 0.2, 0.2])
    layer.draw()
    const has3 = (rgb: number[]) =>
      calls.filter((c) => c.method === 'uniform3f').some((c) => c.args.slice(1).every((v, i) => v === rgb[i]))
    expect(has3([0.1, 0.1, 0.1])).toBe(true)
    expect(has3([0.2, 0.2, 0.2])).toBe(true)

    calls.length = 0
    layer.setContestedColors([0.7, 0.7, 0.7], [0.3, 0.3, 0.3])
    layer.setAccentColor([0.8, 0.8, 0.8])
    layer.draw()
    expect(has3([0.7, 0.7, 0.7])).toBe(true)
    expect(has3([0.8, 0.8, 0.8])).toBe(true)
  })
})

describe('MeshLayer points pass', () => {
  const pointDraws = (calls: { method: string; args: unknown[] }[]) =>
    calls.filter((c) => c.method === 'drawArrays' && c.args[0] === 'POINTS')

  it('draws every point in one POINTS call', () => {
    const { gl, calls } = createRecordingGl()
    const layer = new MeshLayer(gl, threeCellMesh())
    layer.setPoints(new Float32Array([0, 0, 1, 1]), new Float32Array([1, 2]))
    layer.draw()
    expect(pointDraws(calls).map((c) => c.args)).toEqual([['POINTS', 0, 2]])
  })

  it('draws no points once they are cleared', () => {
    const { gl, calls } = createRecordingGl()
    const layer = new MeshLayer(gl, threeCellMesh())
    layer.setPoints(new Float32Array([0, 0, 1, 1]), new Float32Array([1, 2]))
    layer.setPoints(new Float32Array(0), new Float32Array(0))
    layer.draw()
    expect(pointDraws(calls)).toHaveLength(0)
  })

  it('refuses positions and values of different lengths, naming both', () => {
    const { gl } = createRecordingGl()
    const layer = new MeshLayer(gl, threeCellMesh())
    expect(() => layer.setPoints(new Float32Array([0, 0, 1, 1]), new Float32Array([1]))).toThrow(
      /4.*1|1.*4/,
    )
  })

  it('rebuilds the point buffers after a context restore', () => {
    const { gl, calls } = createRecordingGl()
    const layer = new MeshLayer(gl, threeCellMesh())
    layer.setPoints(new Float32Array([0, 0, 1, 1]), new Float32Array([1, 2]))
    layer.reupload()
    calls.length = 0
    layer.draw()
    expect(pointDraws(calls).map((c) => c.args)).toEqual([['POINTS', 0, 2]])
  })

  it('draws the selected point once more, larger', () => {
    const { gl, calls } = createRecordingGl()
    const layer = new MeshLayer(gl, threeCellMesh())
    layer.setPoints(new Float32Array([0, 0, 1, 1]), new Float32Array([1, 2]))
    layer.setSelectedPoint(1)
    layer.draw()
    expect(pointDraws(calls).map((c) => c.args)).toEqual([
      ['POINTS', 0, 2],
      ['POINTS', 1, 1],
    ])
    const sizes = calls
      .filter((c, i) => c.method === 'uniform1f' && calls[i - 1]?.args[1] === 'u_size')
      .map((c) => c.args[1])
    expect(sizes).toEqual([7, 9])
  })
})

describe('MeshLayer footprint pass', () => {
  const triDraws = (calls: { method: string; args: unknown[] }[]) =>
    calls.filter((c) => c.method === 'drawElements' && c.args[0] === 'TRIANGLES')

  it('fills the masked cells in the footprint colour before the value fill', () => {
    const { gl, calls } = createRecordingGl()
    const layer = new MeshLayer(gl, threeCellMesh())
    layer.setFootprintColor([0.2, 0.3, 0.4])
    layer.setFootprint(new Uint8Array([1, 0, 1]))
    layer.draw()

    const draws = triDraws(calls)
    // Footprint first (two quads, 12 indices), then the full value fill.
    expect(draws.map((c) => c.args[1])).toEqual([12, 18])
    const colour = calls.filter((c) => c.method === 'uniform4f').map((c) => c.args.slice(1))
    expect(colour).toContainEqual([0.2, 0.3, 0.4, 1])
  })

  it('draws no footprint for null or an all-zero mask', () => {
    for (const mask of [null, new Uint8Array([0, 0, 0])]) {
      const { gl, calls } = createRecordingGl()
      const layer = new MeshLayer(gl, threeCellMesh())
      layer.setFootprint(new Uint8Array([1, 1, 1]))
      layer.setFootprint(mask)
      layer.draw()
      expect(triDraws(calls)).toHaveLength(1)
    }
  })

  it('keeps the footprint after a context restore', () => {
    const { gl, calls } = createRecordingGl()
    const layer = new MeshLayer(gl, threeCellMesh())
    layer.setFootprint(new Uint8Array([0, 1, 0]))
    layer.reupload()
    calls.length = 0
    layer.draw()
    expect(triDraws(calls).map((c) => c.args[1])).toEqual([6, 18])
  })
})

describe('MeshLayer points', () => {
  const xy = new Float32Array([0.5, 0.5, 1.5, 0.5, 2.5, 0.5])
  const styleValues = (calls: Array<{ method: string; args: unknown[] }>): number[] =>
    calls.flatMap((c, i) =>
      c.method === 'uniform1f' && calls[i - 1]?.method === 'getUniformLocation' && calls[i - 1].args[1] === 'u_missingStyle'
        ? [c.args[1] as number]
        : [],
    )
  const layerWithPoints = () => {
    const { gl, calls } = createRecordingGl()
    const layer = new MeshLayer(gl, threeCellMesh())
    layer.setPoints(xy, new Float32Array([0, 0.5, Number.NaN]))
    layer.setLimits([0, 1])
    return { layer, calls }
  }

  it('a new layer draws points with u_missingStyle 0, so a dot with no value is still discarded', () => {
    const { layer, calls } = layerWithPoints()
    layer.draw()
    expect(styleValues(calls)).toEqual([0])
    const fragment = calls
      .filter((c) => c.method === 'shaderSource')
      .map((c) => c.args[1] as string)
      .find((src) => src.includes('u_missingStyle')) as string
    expect(fragment).toMatch(/missing && u_missingStyle < 0\.5\) discard/)
  })

  it('setMissingStyle switches the next draw between ring (1) and discard (0)', () => {
    const { layer, calls } = layerWithPoints()
    layer.setMissingStyle('ring')
    layer.draw()
    layer.setMissingStyle('discard')
    layer.draw()
    expect(styleValues(calls)).toEqual([1, 0])
  })

  it('the fragment shader keeps only the ring band of a missing dot under style 1', () => {
    const { calls } = layerWithPoints()
    const fragment = calls
      .filter((c) => c.method === 'shaderSource')
      .map((c) => c.args[1] as string)
      .find((src) => src.includes('u_missingStyle')) as string
    expect(fragment).toMatch(/missing && r <= 0\.36\) discard/)
  })

  it('setPointValues uploads the value buffer once and never the positions', () => {
    const { layer, calls } = layerWithPoints()
    calls.length = 0
    const next = new Float32Array([1, 0, 0.25])
    layer.setPointValues(next)
    const uploads = calls.filter((c) => c.method === 'bufferData')
    expect(uploads.length).toBe(1)
    expect(uploads[0].args[1]).toBe(next)
    expect(uploads.some((c) => c.args[1] === xy)).toBe(false)
  })

  it('setPointValues refuses a different length with a sentence naming both lengths', () => {
    const { layer } = layerWithPoints()
    expect(() => layer.setPointValues(new Float32Array([1, 2]))).toThrow(/2 values for 3 points/)
  })

  it('reupload restores the values from setPointValues, not the ones setPoints was given', () => {
    const { layer, calls } = layerWithPoints()
    const next = new Float32Array([1, 0, 0.25])
    layer.setPointValues(next)
    calls.length = 0
    layer.reupload()
    const uploads = calls.filter((c) => c.method === 'bufferData')
    expect(uploads.some((c) => c.args[1] === next)).toBe(true)
  })
})

type Call = { method: string; args: unknown[] }
const allDraws = (calls: Call[]) =>
  calls.filter((c) => c.method === 'drawElements' || c.method === 'drawArrays')
// The texture bound most recently before call `i`.
const boundBefore = (calls: Call[], i: number) => {
  for (let j = i - 1; j >= 0; j--) if (calls[j].method === 'bindTexture') return calls[j].args[1]
  return undefined
}
// The arguments (after the location) of every `method` call made right after looking up `name`.
const uniformAfter = (calls: Call[], name: string, method: string) =>
  calls.flatMap((c, i) =>
    c.method === method && calls[i - 1]?.method === 'getUniformLocation' && calls[i - 1].args[1] === name
      ? [c.args.slice(1)]
      : [],
  )

describe('MeshLayer many selected dots and dot flags', () => {
  const sixXy = new Float32Array([0, 0, 1, 0, 2, 0, 0, 1, 1, 1, 2, 1])
  const sixValues = () => new Float32Array([0, 0.2, 0.4, 0.6, 0.8, 1])
  const pointDraws = (calls: Call[]) =>
    calls.filter((c) => c.method === 'drawArrays' && c.args[0] === 'POINTS').map((c) => c.args)
  const withSixDots = () => {
    const { gl, calls } = createRecordingGl()
    const layer = new MeshLayer(gl, threeCellMesh())
    layer.setPoints(sixXy, sixValues())
    return { layer, calls }
  }
  const arrayUploads = (calls: Call[]) =>
    calls.filter((c) => c.method === 'bufferData' && c.args[0] === 'ARRAY_BUFFER').map((c) => c.args[1] as Float32Array)
  const pointsFragment = (calls: Call[]) =>
    calls.filter((c) => c.method === 'shaderSource').map((c) => c.args[1] as string).find((s) => s.includes('u_missingStyle'))!

  it('draws each selected dot once more, larger and with the accent ring, in ascending order', () => {
    const { layer, calls } = withSixDots()
    layer.setAccentColor([0.2, 0.4, 0.6])
    layer.setSelectedPoints([5, 2])
    calls.length = 0
    layer.draw()
    expect(pointDraws(calls)).toEqual([
      ['POINTS', 0, 6],
      ['POINTS', 2, 1],
      ['POINTS', 5, 1],
    ])
    expect(uniformAfter(calls, 'u_size', 'uniform1f').map((a) => a[0])).toEqual([7, 9])
    expect(uniformAfter(calls, 'u_ringColor', 'uniform3f').at(-1)).toEqual([0.2, 0.4, 0.6])
  })

  it('setSelectedPoint(2) draws exactly what setSelectedPoints([2]) draws', () => {
    const one = withSixDots()
    one.layer.setSelectedPoint(2)
    one.calls.length = 0
    one.layer.draw()
    const many = withSixDots()
    many.layer.setSelectedPoints([2])
    many.calls.length = 0
    many.layer.draw()
    expect(pointDraws(many.calls)).toEqual(pointDraws(one.calls))
    one.layer.setSelectedPoint(null)
    one.calls.length = 0
    one.layer.draw()
    expect(pointDraws(one.calls)).toEqual([['POINTS', 0, 6]])
  })

  it('drops indices that are not a drawn dot and counts them', () => {
    const { layer, calls } = withSixDots()
    layer.setSelectedPoints([1, 6, 9, -1, 1.5, 1])
    expect(layer.selectedPointsDropped()).toBe(4)
    calls.length = 0
    layer.draw()
    expect(pointDraws(calls)).toEqual([
      ['POINTS', 0, 6],
      ['POINTS', 1, 1],
    ])
    layer.setSelectedPoints([])
    expect(layer.selectedPointsDropped()).toBe(0)
  })

  it('uploads the flags as a third points attribute, and zeros when there are none', () => {
    const { gl, calls } = createRecordingGl()
    const layer = new MeshLayer(gl, threeCellMesh())
    expect(pointsFragment(calls)).toMatch(/flat in float v_flags/)
    const vertex = calls
      .filter((c) => c.method === 'shaderSource')
      .map((c) => c.args[1] as string)
      .find((s) => s.includes('gl_PointSize'))!
    expect(vertex).toMatch(/in float a_flags/)

    layer.setPoints(sixXy, sixValues())
    const onSet = arrayUploads(calls).slice(-3)
    expect(onSet[0]).toBe(sixXy)
    expect(Array.from(onSet[2])).toEqual([0, 0, 0, 0, 0, 0])

    calls.length = 0
    layer.setPointFlags(new Float32Array([1, 2, 3, 4, 5, 0]))
    expect(arrayUploads(calls).map((a) => Array.from(a))).toEqual([[1, 2, 3, 4, 5, 0]])

    calls.length = 0
    layer.setPointFlags(null)
    expect(arrayUploads(calls).map((a) => Array.from(a))).toEqual([[0, 0, 0, 0, 0, 0]])
  })

  it('refuses a flags array of the wrong length with a sentence naming both lengths', () => {
    const { layer } = withSixDots()
    expect(() => layer.setPointFlags(new Float32Array(2))).toThrow(/2 flags for 6 points/)
  })

  it('setPoints clears the flags and the selected dots, so the caller re-applies them', () => {
    const { layer, calls } = withSixDots()
    layer.setPointFlags(new Float32Array([4, 4, 4, 4, 4, 4]))
    layer.setSelectedPoints([1, 3])
    layer.setPoints(sixXy, sixValues())
    expect(Array.from(arrayUploads(calls).at(-1)!)).toEqual([0, 0, 0, 0, 0, 0])
    calls.length = 0
    layer.draw()
    expect(pointDraws(calls)).toEqual([['POINTS', 0, 6]])
    calls.length = 0
    layer.reupload()
    expect(Array.from(arrayUploads(calls).at(-1)!)).toEqual([0, 0, 0, 0, 0, 0])
  })

  it('sends the dim alpha the caller set and blends the points pass, restoring the blend state after', () => {
    const { layer, calls } = withSixDots()
    layer.setDimAlpha(0.35)
    calls.length = 0
    layer.draw()
    expect(uniformAfter(calls, 'u_dimAlpha', 'uniform1f')).toEqual([[0.35]])
    const pointsDraw = calls.findIndex((c) => c.method === 'drawArrays')
    const enable = calls.findIndex((c) => c.method === 'enable' && c.args[0] === 'BLEND')
    const blend = calls.findIndex((c) => c.method === 'blendFuncSeparate')
    const disable = calls.findIndex((c) => c.method === 'disable' && c.args[0] === 'BLEND')
    expect(enable).toBeLessThan(pointsDraw)
    expect(blend).toBeLessThan(pointsDraw)
    // Colour blends; alpha stays opaque over an opaque canvas.
    expect(calls[blend].args).toEqual(['SRC_ALPHA', 'ONE_MINUS_SRC_ALPHA', 'ONE', 'ONE_MINUS_SRC_ALPHA'])
    expect(disable).toBeGreaterThan(pointsDraw)
  })

  it('the fragment shader dims on bit 4 and draws a 45 and a 135 degree swatch for bits 1 and 2 in the hatch ink', () => {
    const { layer, calls } = withSixDots()
    const fragment = pointsFragment(calls)
    expect(fragment).toMatch(/int\(v_flags \+ 0\.5\)/)
    expect(fragment).toMatch(/\(flags & 1\) != 0/)
    expect(fragment).toMatch(/\(flags & 2\) != 0/)
    expect(fragment).toMatch(/\(flags & 4\) != 0\) color\.a \*= u_dimAlpha/)
    expect(fragment).toMatch(/gl_PointCoord/)
    layer.setHatchColors([0.1, 0.2, 0.3], [1, 1, 1])
    calls.length = 0
    layer.draw()
    expect(uniformAfter(calls, 'u_ink', 'uniform3f')).toEqual([[0.1, 0.2, 0.3]])
  })

  it('uploads the same flags and draws the same selected dots after a context restore', () => {
    const { layer, calls } = withSixDots()
    layer.setPointFlags(new Float32Array([1, 0, 2, 0, 4, 0]))
    layer.setSelectedPoints([0, 4])
    calls.length = 0
    layer.reupload()
    expect(Array.from(arrayUploads(calls).at(-1)!)).toEqual([1, 0, 2, 0, 4, 0])
    calls.length = 0
    layer.draw()
    expect(pointDraws(calls)).toEqual([
      ['POINTS', 0, 6],
      ['POINTS', 0, 1],
      ['POINTS', 4, 1],
    ])
  })
})

describe('MeshLayer many rings', () => {
  // The vertex and index uploads of the last ring build.
  const ringUploads = (calls: Call[]) => {
    const uploads = calls.filter((c) => c.method === 'bufferData')
    const verts = uploads.filter((c) => c.args[0] === 'ARRAY_BUFFER').at(-1)!.args[1] as Float32Array
    const indices = uploads.filter((c) => c.args[0] === 'ELEMENT_ARRAY_BUFFER').at(-1)!.args[1] as Uint32Array
    return { verts: Array.from(verts), indices: Array.from(indices) }
  }

  it('setSelected(3) and setSelectedCells([3]) build the same quads, one per edge of the cell', () => {
    const a = createRecordingGl()
    const layerA = new MeshLayer(a.gl, gridMesh(3, 2))
    a.calls.length = 0
    layerA.setSelected(3)
    const viaOne = ringUploads(a.calls)

    const b = createRecordingGl()
    const layerB = new MeshLayer(b.gl, gridMesh(3, 2))
    b.calls.length = 0
    layerB.setSelectedCells([3])
    const viaMany = ringUploads(b.calls)

    expect(viaMany).toEqual(viaOne)
    // Cell 3 is the square (0,1)-(1,2): 4 edges, 4 corners each, 6 floats a corner.
    expect(viaOne.verts.length).toBe(4 * 4 * 6)
    expect(viaOne.indices.length).toBe(24)
    expect(viaOne.verts.slice(0, 6)).toEqual([0, 1, 1, 1, 0, -1])
  })

  it('rings each of up to 8 cells on its own', () => {
    const { gl, calls } = createRecordingGl()
    const layer = new MeshLayer(gl, gridMesh(3, 3))
    calls.length = 0
    // A plus shape: an outline would drop the 4 edges round the centre.
    layer.setSelectedCells([1, 3, 4, 5, 7])
    expect(ringUploads(calls).indices.length).toBe(5 * 4 * 6)
  })

  it('draws 9 or more cells as the outline of the set only', () => {
    const { gl, calls } = createRecordingGl()
    const layer = new MeshLayer(gl, gridMesh(3, 3))
    calls.length = 0
    layer.setSelectedCells([0, 1, 2, 3, 4, 5, 6, 7, 8])
    expect(ringUploads(calls).indices.length).toBe(12 * 6)

    calls.length = 0
    layer.draw()
    const ringDraws = calls.filter((c) => c.method === 'drawElements' && c.args[1] === 72)
    expect(ringDraws).toHaveLength(2)
  })

  it('outlines only the first 20,000 of 25,000 cells, in the order given', () => {
    const { gl, calls } = createRecordingGl()
    const layer = new MeshLayer(gl, gridMesh(250, 100))
    calls.length = 0
    layer.setSelectedCells(Array.from({ length: 25_000 }, (_, i) => i))
    // The first 20,000 cells are rows 0-79: one 250 x 80 rectangle.
    const { verts, indices } = ringUploads(calls)
    expect(indices.length).toBe(2 * (250 + 80) * 6)
    for (let i = 0; i < verts.length; i += 6) {
      expect(verts[i + 1]).toBeLessThanOrEqual(80)
      expect(verts[i + 3]).toBeLessThanOrEqual(80)
    }
  })

  it('setSelected(null) and an empty list draw no ring', () => {
    for (const clear of [(l: MeshLayer) => l.setSelected(null), (l: MeshLayer) => l.setSelectedCells([])]) {
      const { gl, calls } = createRecordingGl()
      const layer = new MeshLayer(gl, gridMesh(3, 3))
      layer.setSelectedCells([0, 1, 2, 3, 4, 5, 6, 7, 8])
      clear(layer)
      calls.length = 0
      layer.draw()
      expect(calls.filter((c) => c.method === 'drawElements')).toHaveLength(1)
    }
  })

  it('holds a copy, so a caller changing its array later does not move the ring', () => {
    const { gl, calls } = createRecordingGl()
    const layer = new MeshLayer(gl, gridMesh(3, 3))
    const ids = [0, 1, 2, 3, 4, 5, 6, 7, 8]
    layer.setSelectedCells(ids)
    ids.length = 1
    calls.length = 0
    layer.reupload()
    expect(ringUploads(calls).indices.length).toBe(12 * 6)
  })

  it('rebuilds the same ring quads after a context restore', () => {
    const { gl, calls } = createRecordingGl()
    const layer = new MeshLayer(gl, gridMesh(3, 3))
    calls.length = 0
    layer.setSelectedCells([0, 1, 2, 3, 4, 5, 6, 7, 8])
    const before = ringUploads(calls)
    calls.length = 0
    layer.reupload()
    expect(ringUploads(calls)).toEqual(before)
  })
})

describe('MeshLayer hatch pass', () => {
  const draws = allDraws
  const hatchSources = (calls: Call[]) => {
    const sources = calls.filter((c) => c.method === 'shaderSource').map((c) => c.args[1] as string)
    return {
      vertex: sources.find((s) => s.includes('v_mask') && s.includes('gl_Position')),
      fragment: sources.find((s) => s.includes('u_angle0')),
    }
  }

  it('uploads the mask as one float per cell to its own R32F texture, through texSubImage2D in RED/FLOAT', () => {
    const { gl, calls } = createRecordingGl()
    const layer = new MeshLayer(gl, threeCellMesh())
    const storage = calls.filter((c) => c.method === 'texStorage2D')
    // Values, the overlay mask and the texture-mode class mask.
    expect(storage).toHaveLength(3)
    expect(storage[1].args).toEqual(storage[0].args)
    expect(storage[2].args).toEqual(storage[0].args)
    expect(storage[1].args[2]).toBe('R32F')

    layer.setValues(new Float32Array([0, 0.5, 1]))
    const valuesUpload = calls.findIndex((c) => c.method === 'texSubImage2D')
    const valuesTex = boundBefore(calls, valuesUpload)

    calls.length = 0
    layer.setHatch(new Uint8Array([1, 0, 3]))
    const uploads = calls.filter((c) => c.method === 'texSubImage2D')
    expect(uploads).toHaveLength(1)
    expect(uploads[0].args[6]).toBe('RED')
    expect(uploads[0].args[7]).toBe('FLOAT')
    const staging = uploads[0].args[8] as Float32Array
    expect(Array.from(staging.slice(0, 3))).toEqual([1, 0, 3])
    const hatchTex = boundBefore(calls, calls.indexOf(uploads[0]))
    expect(hatchTex).toBeDefined()
    expect(hatchTex).not.toBe(valuesTex)
  })

  it('filters the mask texture NEAREST, never LINEAR', () => {
    const { gl, calls } = createRecordingGl()
    new MeshLayer(gl, threeCellMesh())
    const storageAt = calls.map((c, i) => (c.method === 'texStorage2D' ? i : -1)).filter((i) => i >= 0)
    const afterMask = calls.slice(storageAt[1], storageAt[1] + 3)
    expect(afterMask.filter((c) => c.method === 'texParameteri').map((c) => c.args[2])).toEqual([
      'NEAREST',
      'NEAREST',
    ])
  })

  it('refuses a mask of the wrong length with a sentence naming both lengths', () => {
    const { gl } = createRecordingGl()
    const layer = new MeshLayer(gl, threeCellMesh())
    expect(() => layer.setHatch(new Uint8Array([1, 0]))).toThrow(/2 entries for 3 cells/)
  })

  it('draws the hatch after the fill and before the points', () => {
    const { gl, calls } = createRecordingGl()
    const layer = new MeshLayer(gl, threeCellMesh())
    layer.setValues(new Float32Array([0, 0.5, 1]))
    layer.setPoints(new Float32Array([0, 0, 1, 1]), new Float32Array([1, 2]))
    layer.setHatch(new Uint8Array([1, 2, 0]))
    calls.length = 0
    layer.draw()

    const order = draws(calls)
    expect(order.map((c) => [c.method, c.args[0]])).toEqual([
      ['drawElements', 'TRIANGLES'],
      ['drawElements', 'TRIANGLES'],
      ['drawArrays', 'POINTS'],
    ])
    const fillDraw = calls.indexOf(order[0])
    const hatchDraw = calls.indexOf(order[1])
    const valuesLookup = calls.findIndex((c) => c.method === 'getUniformLocation' && c.args[1] === 'u_values')
    const angleLookup = calls.findIndex((c) => c.method === 'getUniformLocation' && c.args[1] === 'u_angle0')
    expect(valuesLookup).toBeLessThan(fillDraw)
    expect(angleLookup).toBeGreaterThan(fillDraw)
    expect(angleLookup).toBeLessThan(hatchDraw)
    // The hatch runs over every triangle; the shader drops the unmasked cells.
    expect(order[1].args[1]).toBe(18)
  })

  it('draws no hatch for null or an all-zero mask', () => {
    for (const mask of [null, new Uint8Array([0, 0, 0])]) {
      const { gl, calls } = createRecordingGl()
      const layer = new MeshLayer(gl, threeCellMesh())
      layer.setHatch(new Uint8Array([3, 3, 3]))
      layer.setHatch(mask)
      calls.length = 0
      layer.draw()
      expect(draws(calls)).toHaveLength(1)
      expect(calls.some((c) => c.method === 'getUniformLocation' && c.args[1] === 'u_angle0')).toBe(false)
    }
  })

  it('sends the angles in radians, 45 and 135 degrees by default, and whatever setHatchAngles last set', () => {
    const { gl, calls } = createRecordingGl()
    const layer = new MeshLayer(gl, threeCellMesh())
    layer.setHatch(new Uint8Array([1, 0, 0]))
    layer.draw()
    expect(uniformAfter(calls, 'u_angle0', 'uniform1f')[0][0]).toBeCloseTo(Math.PI / 4, 10)
    expect(uniformAfter(calls, 'u_angle1', 'uniform1f')[0][0]).toBeCloseTo((3 * Math.PI) / 4, 10)

    calls.length = 0
    layer.setHatchAngles(30, 60)
    layer.draw()
    expect(uniformAfter(calls, 'u_angle0', 'uniform1f')[0][0]).toBeCloseTo(Math.PI / 6, 10)
    expect(uniformAfter(calls, 'u_angle1', 'uniform1f')[0][0]).toBeCloseTo(Math.PI / 3, 10)

    calls.length = 0
    layer.setHatchAngles()
    layer.draw()
    expect(uniformAfter(calls, 'u_angle0', 'uniform1f')[0][0]).toBeCloseTo(Math.PI / 4, 10)
  })

  it('draws the ink and halo colours setHatchColors last set', () => {
    const { gl, calls } = createRecordingGl()
    const layer = new MeshLayer(gl, threeCellMesh())
    layer.setHatch(new Uint8Array([0, 1, 0]))
    layer.setHatchColors([0.1, 0.2, 0.3], [0.9, 0.8, 0.7])
    layer.draw()
    expect(uniformAfter(calls, 'u_ink', 'uniform3f')).toContainEqual([0.1, 0.2, 0.3])
    expect(uniformAfter(calls, 'u_halo', 'uniform3f')).toEqual([[0.9, 0.8, 0.7]])
  })

  it('leaves the value texture, the colour limits and the colormap alone', () => {
    const { gl, calls } = createRecordingGl()
    const layer = new MeshLayer(gl, threeCellMesh())
    layer.setValues(new Float32Array([0, 0.5, 1]))
    layer.setLimits([2, 7])
    const valuesTex = boundBefore(calls, calls.findIndex((c) => c.method === 'texSubImage2D'))
    layer.setHatch(new Uint8Array([3, 3, 3]))

    calls.length = 0
    layer.draw()
    expect(calls.some((c) => ['texSubImage2D', 'texImage2D', 'texStorage2D'].includes(c.method))).toBe(false)
    expect(uniformAfter(calls, 'u_limits', 'uniform2f')).toEqual([[2, 7]])
    // The fill still samples the value texture on unit 0; the hatch has its own unit.
    const valuesBind = calls.findIndex((c) => c.method === 'bindTexture' && c.args[1] === valuesTex)
    expect(calls[valuesBind - 1]).toEqual({ method: 'activeTexture', args: [0] })
    expect(uniformAfter(calls, 'u_mask', 'uniform1i')).toEqual([[2]])
  })

  it('blends the hatch pass and restores the blend state after it', () => {
    const { gl, calls } = createRecordingGl()
    const layer = new MeshLayer(gl, threeCellMesh())
    layer.setHatch(new Uint8Array([1, 0, 0]))
    calls.length = 0
    layer.draw()
    const hatchDraw = calls.indexOf(draws(calls)[1])
    const enable = calls.findIndex((c) => c.method === 'enable' && c.args[0] === 'BLEND')
    const disable = calls.findIndex((c) => c.method === 'disable' && c.args[0] === 'BLEND')
    expect(enable).toBeGreaterThanOrEqual(0)
    expect(enable).toBeLessThan(hatchDraw)
    expect(disable).toBeGreaterThan(hatchDraw)
  })

  it('decodes the mask as a whole number in the shader and draws lines from gl_FragCoord', () => {
    const { gl, calls } = createRecordingGl()
    new MeshLayer(gl, threeCellMesh())
    const { vertex, fragment } = hatchSources(calls)
    expect(vertex).toMatch(/texelFetch\(u_mask/)
    expect(fragment).toMatch(/int\(v_mask \+ 0\.5\)/)
    expect(fragment).toMatch(/gl_FragCoord/)
    expect(fragment).toMatch(/u_angle1/)
  })

  it('uploads the same mask again after a context restore, before the field', () => {
    const { gl, calls } = createRecordingGl()
    const layer = new MeshLayer(gl, threeCellMesh())
    layer.setValues(new Float32Array([4, 5, 6]))
    layer.setHatch(new Uint8Array([2, 0, 1]))
    calls.length = 0
    layer.reupload()
    const uploads = calls.filter((c) => c.method === 'texSubImage2D').map((c) => c.args[8] as Float32Array)
    expect(uploads).toHaveLength(2)
    expect(Array.from(uploads[0].slice(0, 3))).toEqual([2, 0, 1])
    // The field goes last, so anything reading the latest upload still sees the values.
    expect(Array.from(uploads[1].slice(0, 3))).toEqual([4, 5, 6])

    calls.length = 0
    layer.draw()
    expect(draws(calls)).toHaveLength(2)
  })
})

describe('MeshLayer classes', () => {
  // The value each uniform call receives, with the program it was looked up on.
  function uniformsFor(calls: Call[], name: string): Array<{ program: unknown; method: string; value: unknown }> {
    const out: Array<{ program: unknown; method: string; value: unknown }> = []
    calls.forEach((c, i) => {
      if (c.method !== 'getUniformLocation' || c.args[1] !== name) return
      const next = calls[i + 1]
      out.push({ program: c.args[0], method: next.method, value: next.args[1] })
    })
    return out
  }

  function fillProgram(calls: Call[]): unknown {
    return calls.find((c) => c.method === 'getUniformLocation' && c.args[1] === 'u_values')?.args[0]
  }

  function fillFragmentSource(calls: Call[]): string {
    const sources = calls.filter((c) => c.method === 'shaderSource').map((c) => c.args[1] as string)
    return sources.find((s) => s.includes('out vec4 fragColor') && s.includes('flat in float v_norm') && !s.includes('v_flags'))!
  }

  it('hands the fill program the class count and the texel each class samples', () => {
    const { gl, calls } = createRecordingGl()
    const layer = new MeshLayer(gl, threeCellMesh())
    layer.setValues(new Float32Array([0, 0.5, 1]))
    layer.setStyle({ classes: 9, symmetric: false, texture: false })
    calls.length = 0
    layer.draw()

    const program = fillProgram(calls)
    const classes = uniformsFor(calls, 'u_classes').filter((u) => u.program === program)
    expect(classes).toEqual([{ program, method: 'uniform1f', value: 9 }])
    const texels = uniformsFor(calls, 'u_classTexel').filter((u) => u.program === program)
    expect(texels).toHaveLength(1)
    expect(texels[0].method).toBe('uniform1fv')
    const array = texels[0].value as Float32Array
    expect(array).toHaveLength(11)
    expect(Array.from(array.slice(0, 9))).toEqual(classTexelIndices(9))
    expect(Array.from(array.slice(9))).toEqual([0, 0])
  })

  it('hands the fill program 0 classes when continuous', () => {
    const { gl, calls } = createRecordingGl()
    const layer = new MeshLayer(gl, threeCellMesh())
    layer.setStyle({ classes: 9, symmetric: false, texture: false })
    layer.setStyle({ classes: 0, symmetric: false, texture: false })
    calls.length = 0
    layer.draw()
    const program = fillProgram(calls)
    expect(uniformsFor(calls, 'u_classes').filter((u) => u.program === program).map((u) => u.value)).toEqual([0])
  })

  it('keeps the class count across a context restore', () => {
    const { gl, calls } = createRecordingGl()
    const layer = new MeshLayer(gl, threeCellMesh())
    layer.setStyle({ classes: 7, symmetric: false, texture: false })
    layer.reupload()
    calls.length = 0
    layer.draw()
    const program = fillProgram(calls)
    expect(uniformsFor(calls, 'u_classes').filter((u) => u.program === program).map((u) => u.value)).toEqual([7])
  })

  it('quantises in the fill shader only after a missing cell is discarded', () => {
    const { gl, calls } = createRecordingGl()
    new MeshLayer(gl, threeCellMesh())
    const source = fillFragmentSource(calls)
    expect(source).toContain('uniform float u_classes;')
    expect(source).toContain('uniform float u_classTexel[11];')
    const discardAt = source.indexOf('discard')
    expect(discardAt).toBeGreaterThan(0)
    expect(source.indexOf('u_classes >')).toBeGreaterThan(discardAt)
    expect(source.indexOf('u_classTexel[k]')).toBeGreaterThan(discardAt)
  })

  it('steps the dots the same way, after a missing dot is discarded (D-31)', () => {
    const { gl, calls } = createRecordingGl()
    const layer = new MeshLayer(gl, threeCellMesh())
    const sources = calls.filter((c) => c.method === 'shaderSource').map((c) => c.args[1] as string)
    const points = sources.find((s) => s.includes('v_flags') && s.includes('out vec4 fragColor'))!
    expect(points).toContain('uniform float u_classes;')
    expect(points).toContain('uniform float u_classTexel[11];')
    expect(points.indexOf('u_classTexel[k]')).toBeGreaterThan(points.indexOf('if (missing && u_missingStyle < 0.5) discard;'))

    layer.setPoints(new Float32Array([0, 0, 1, 1]), new Float32Array([1, 2]))
    layer.setStyle({ classes: 11, symmetric: false, texture: false })
    calls.length = 0
    layer.draw()
    const pointsProgram = calls.find((c) => c.method === 'getUniformLocation' && c.args[1] === 'u_size')?.args[0]
    const fill = fillProgram(calls)
    expect(pointsProgram).not.toBe(fill)
    for (const program of [fill, pointsProgram]) {
      expect(uniformsFor(calls, 'u_classes').filter((u) => u.program === program).map((u) => u.value)).toEqual([11])
      const texel = uniformsFor(calls, 'u_classTexel').find((u) => u.program === program)
      expect(Array.from(texel!.value as Float32Array)).toEqual(classTexelIndices(11))
    }
  })

  it('still uploads every missing cell as NaN for the fill to discard, whatever the classes', () => {
    const { gl, calls } = createRecordingGl()
    const layer = new MeshLayer(gl, threeCellMesh())
    layer.setStyle({ classes: 9, symmetric: false, texture: false })
    layer.setValues(new Float32Array([Number.NaN, Number.NaN, Number.NaN]))
    const upload = calls.filter((c) => c.method === 'texSubImage2D').pop()!
    const staging = upload.args[8] as Float32Array
    expect(Array.from(staging.slice(0, 3)).every(Number.isNaN)).toBe(true)
  })
})

// The value, hatch and class textures, read from the texStorage2D calls a fresh layer makes.
function layerTextures(calls: Call[]): { values: unknown; hatch: unknown; cls: unknown } {
  const at = calls.map((c, i) => (c.method === 'texStorage2D' ? i : -1)).filter((i) => i >= 0)
  return { values: boundBefore(calls, at[0]), hatch: boundBefore(calls, at[1]), cls: boundBefore(calls, at[2]) }
}

// The arguments after the location of the call made right after looking up `name` on `program`.
function uniformOn(calls: Call[], program: unknown, name: string): unknown[][] {
  return calls.flatMap((c, i) =>
    c.method === 'getUniformLocation' && c.args[0] === program && c.args[1] === name ? [calls[i + 1].args.slice(1)] : [],
  )
}

const programOf = (calls: Call[], uniform: string) =>
  calls.find((c) => c.method === 'getUniformLocation' && c.args[1] === uniform)?.args[0]

describe('MeshLayer texture fill', () => {
  const textured = { classes: 7, symmetric: false, texture: true }
  const plain = { classes: 7, symmetric: false, texture: false }

  function texturedLayer() {
    const { gl, calls } = createRecordingGl()
    const layer = new MeshLayer(gl, threeCellMesh())
    const tex = layerTextures(calls)
    layer.setStyle(textured)
    layer.setLimits([0, 7])
    layer.setValues(new Float32Array([0.5, Number.NaN, 6.5]))
    layer.setSurfaceColor([0.8, 0.7, 0.6])
    return { gl, calls, layer, tex }
  }

  const uploads = (calls: Call[]) => calls.filter((c) => c.method === 'texSubImage2D')

  it('gives the fill a flat surface switch and the hatch program a mode and a class count', () => {
    const { gl, calls } = createRecordingGl()
    new MeshLayer(gl, threeCellMesh())
    const sources = calls.filter((c) => c.method === 'shaderSource').map((c) => c.args[1] as string)
    const fill = sources.find((s) => s.includes('flat in float v_norm') && !s.includes('v_flags') && s.includes('fragColor'))!
    expect(fill).toContain('uniform float u_flat;')
    expect(fill).toContain('uniform vec3 u_surface;')
    const hatch = sources.find((s) => s.includes('u_angle0'))!
    expect(hatch).toContain('uniform float u_mode;')
    expect(hatch).toContain('uniform float u_classes;')
    // Class k is drawn at k times 180 / N degrees, so the angle grows with magnitude.
    expect(hatch).toMatch(/int\(v_mask \+ 0\.5\) - 1/)
    expect(hatch).toMatch(/float\(k\) \* 3\.14159265 \/ u_classes/)
  })

  it('uploads class + 1 per valued cell to its own texture, 0 for a cell with no value', () => {
    const { calls, layer, tex } = texturedLayer()
    calls.length = 0
    layer.draw()
    const up = uploads(calls)
    expect(up).toHaveLength(1)
    expect(up[0].args[6]).toBe('RED')
    expect(up[0].args[7]).toBe('FLOAT')
    expect(Array.from((up[0].args[8] as Float32Array).slice(0, 3))).toEqual([1, 0, 7])
    expect(boundBefore(calls, calls.indexOf(up[0]))).toBe(tex.cls)
    expect(tex.cls).toBeDefined()
    expect(tex.cls).not.toBe(tex.hatch)
    expect(tex.cls).not.toBe(tex.values)
  })

  it('draws the fill in the flat surface colour and the hatch in class mode with no overlay mask set', () => {
    const { calls, layer, tex } = texturedLayer()
    calls.length = 0
    layer.draw()
    const fill = programOf(calls, 'u_values')
    expect(uniformOn(calls, fill, 'u_flat')).toEqual([[1]])
    expect(uniformOn(calls, fill, 'u_surface')).toEqual([[0.8, 0.7, 0.6]])
    const hatch = programOf(calls, 'u_angle0')
    expect(hatch).toBeDefined()
    expect(uniformOn(calls, hatch, 'u_mode')).toEqual([[1]])
    expect(uniformOn(calls, hatch, 'u_classes')).toEqual([[7]])
    const order = allDraws(calls)
    expect(order).toHaveLength(2)
    const hatchDraw = calls.indexOf(order[1])
    expect(boundBefore(calls, hatchDraw)).toBe(tex.cls)
    let bind = hatchDraw
    while (calls[bind].method !== 'bindTexture') bind -= 1
    expect(calls[bind - 1]).toEqual({ method: 'activeTexture', args: [2] })
  })

  it('gives a contested cell no class, whatever value the caller passed for it', () => {
    const { calls, layer } = texturedLayer()
    layer.setValues(new Float32Array([0.5, 3.5, 6.5]))
    layer.setContested(new Uint8Array([0, 1, 0]))
    calls.length = 0
    layer.draw()
    expect(Array.from((uploads(calls)[0].args[8] as Float32Array).slice(0, 3))).toEqual([1, 0, 7])
  })

  it('rebuilds the class mask once after the limits move, and not on a draw with nothing changed', () => {
    const { calls, layer } = texturedLayer()
    calls.length = 0
    layer.draw()
    layer.draw()
    expect(uploads(calls)).toHaveLength(1)

    calls.length = 0
    layer.setLimits([0, 14])
    layer.draw()
    layer.draw()
    const up = uploads(calls)
    expect(up).toHaveLength(1)
    expect(Array.from((up[0].args[8] as Float32Array).slice(0, 3))).toEqual([1, 0, 4])
  })

  it('keeps the overlay mask aside while texture is on and draws it again when texture goes off', () => {
    const { calls, layer, tex } = texturedLayer()
    calls.length = 0
    layer.setHatch(new Uint8Array([1, 2, 0]))
    const overlayUpload = uploads(calls)
    expect(overlayUpload).toHaveLength(1)
    expect(boundBefore(calls, calls.indexOf(overlayUpload[0]))).toBe(tex.hatch)
    expect(Array.from((overlayUpload[0].args[8] as Float32Array).slice(0, 3))).toEqual([1, 2, 0])

    calls.length = 0
    layer.draw()
    expect(boundBefore(calls, calls.indexOf(allDraws(calls)[1]))).toBe(tex.cls)

    layer.setStyle(plain)
    calls.length = 0
    layer.draw()
    expect(uploads(calls)).toHaveLength(0)
    const hatch = programOf(calls, 'u_angle0')
    expect(uniformOn(calls, hatch, 'u_mode')).toEqual([[0]])
    expect(boundBefore(calls, calls.indexOf(allDraws(calls)[1]))).toBe(tex.hatch)
  })

  it('draws the ramp and no hatch when texture is off and no overlay is set', () => {
    const { calls, layer } = texturedLayer()
    layer.setStyle(plain)
    calls.length = 0
    layer.draw()
    expect(uniformOn(calls, programOf(calls, 'u_values'), 'u_flat')).toEqual([[0]])
    expect(allDraws(calls)).toHaveLength(1)
    expect(programOf(calls, 'u_angle0')).toBeUndefined()
  })

  it('creates the class texture again after a context restore and uploads the mask again', () => {
    const { calls, layer } = texturedLayer()
    layer.draw()
    calls.length = 0
    layer.reupload()
    expect(calls.filter((c) => c.method === 'texStorage2D')).toHaveLength(3)
    const tex = layerTextures(calls)
    calls.length = 0
    layer.draw()
    const up = uploads(calls)
    expect(up).toHaveLength(1)
    expect(boundBefore(calls, calls.indexOf(up[0]))).toBe(tex.cls)
    expect(Array.from((up[0].args[8] as Float32Array).slice(0, 3))).toEqual([1, 0, 7])
  })

  it('deletes the class texture on dispose', () => {
    const { calls, layer, tex } = texturedLayer()
    calls.length = 0
    layer.dispose()
    expect(calls.filter((c) => c.method === 'deleteTexture').map((c) => c.args[0])).toContain(tex.cls)
  })
})

describe('MeshLayer field opacity', () => {
  const blendSeparate = ['SRC_ALPHA', 'ONE_MINUS_SRC_ALPHA', 'ONE', 'ONE_MINUS_SRC_ALPHA']

  function valuedLayer() {
    const { gl, calls } = createRecordingGl()
    const layer = new MeshLayer(gl, threeCellMesh())
    layer.setValues(new Float32Array([0, 0.5, 1]))
    return { calls, layer }
  }

  // The fill's draw call: the first drawElements after the fill program's u_values lookup.
  const fillDrawAt = (calls: Call[]) => {
    const lookup = calls.findIndex((c) => c.method === 'getUniformLocation' && c.args[1] === 'u_values')
    if (lookup < 0) return -1
    return calls.findIndex((c, i) => i > lookup && c.method === 'drawElements')
  }

  it('sends alpha 1 and blends nothing when the opacity was never set', () => {
    const { calls, layer } = valuedLayer()
    const sources = calls.filter((c) => c.method === 'shaderSource').map((c) => c.args[1] as string)
    const fill = sources.find((s) => s.includes('flat in float v_norm') && !s.includes('v_flags') && s.includes('fragColor'))!
    expect(fill).toContain('uniform float u_alpha;')
    calls.length = 0
    layer.draw()
    expect(uniformOn(calls, programOf(calls, 'u_values'), 'u_alpha')).toEqual([[1]])
    expect(calls.some((c) => c.method === 'enable' && c.args[0] === 'BLEND')).toBe(false)
  })

  it('blends the fill below 1 so the canvas alpha stays 1, and restores the blend state', () => {
    const { calls, layer } = valuedLayer()
    layer.setFieldOpacity(0.4)
    calls.length = 0
    layer.draw()
    const fill = programOf(calls, 'u_values')
    expect(uniformOn(calls, fill, 'u_alpha')).toEqual([[0.4]])
    const draw = fillDrawAt(calls)
    const enable = calls.findIndex((c) => c.method === 'enable' && c.args[0] === 'BLEND')
    const separate = calls.findIndex((c) => c.method === 'blendFuncSeparate')
    const disable = calls.findIndex((c) => c.method === 'disable' && c.args[0] === 'BLEND')
    expect(enable).toBeGreaterThanOrEqual(0)
    expect(enable).toBeLessThan(draw)
    expect(calls[separate].args).toEqual(blendSeparate)
    expect(separate).toBeLessThan(draw)
    expect(disable).toBeGreaterThan(draw)
  })

  it('draws the footprint at the same alpha under the same blend', () => {
    const { calls, layer } = valuedLayer()
    layer.setFootprint(new Uint8Array([1, 1, 1]))
    layer.setFootprintColor([0.5, 0.6, 0.7])
    layer.setFieldOpacity(0.4)
    calls.length = 0
    layer.draw()
    const footprintDraw = allDraws(calls)[0]
    const at = calls.indexOf(footprintDraw)
    const colour = calls.slice(0, at).filter((c) => c.method === 'uniform4f').pop()!
    expect(colour.args.slice(1)).toEqual([0.5, 0.6, 0.7, 0.4])
    const before = calls.slice(0, at)
    expect(before.some((c) => c.method === 'enable' && c.args[0] === 'BLEND')).toBe(true)
    expect(before.filter((c) => c.method === 'blendFuncSeparate').pop()!.args).toEqual(blendSeparate)
  })

  it('skips the fill at opacity 0', () => {
    const { calls, layer } = valuedLayer()
    layer.setFieldOpacity(0)
    calls.length = 0
    layer.draw()
    expect(fillDrawAt(calls)).toBe(-1)
    expect(allDraws(calls)).toHaveLength(0)
  })

  it('clamps the opacity to 0 to 1 and refuses a value that is not a number', () => {
    const { calls, layer } = valuedLayer()
    layer.setFieldOpacity(1.5)
    calls.length = 0
    layer.draw()
    expect(uniformOn(calls, programOf(calls, 'u_values'), 'u_alpha')).toEqual([[1]])
    expect(calls.some((c) => c.method === 'enable' && c.args[0] === 'BLEND')).toBe(false)

    layer.setFieldOpacity(-0.2)
    calls.length = 0
    layer.draw()
    expect(allDraws(calls)).toHaveLength(0)

    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => layer.setFieldOpacity(bad)).toThrow('field opacity must be a number from 0 to 1')
    }
  })
})

describe('MeshLayer grid lines', () => {
  // Every side of every ring of threeCellMesh, as LINES index pairs.
  const allEdges = [0, 1, 1, 2, 2, 3, 3, 0, 4, 5, 5, 6, 6, 7, 7, 4, 8, 9, 9, 10, 10, 11, 11, 8]
  const edgeUploads = (calls: Call[]) =>
    calls.filter(
      (c) =>
        c.method === 'bufferData' &&
        c.args[0] === 'ELEMENT_ARRAY_BUFFER' &&
        c.args[1] instanceof Uint32Array &&
        Array.from(c.args[1] as Uint32Array).join() === allEdges.join(),
    )
  const lineDraws = (calls: Call[]) => allDraws(calls).filter((c) => c.args[0] === 'LINES')

  it('builds one edge per ring side of every cell, once', () => {
    const { gl, calls } = createRecordingGl()
    const layer = new MeshLayer(gl, threeCellMesh())
    calls.length = 0
    layer.setGridLines(true)
    expect(edgeUploads(calls)).toHaveLength(1)
    layer.setGridLines(false)
    layer.setGridLines(true)
    layer.draw()
    expect(edgeUploads(calls)).toHaveLength(1)
  })

  it('draws them in the grid line colour, blended, after the fill and before the hatch', () => {
    const { gl, calls } = createRecordingGl()
    const layer = new MeshLayer(gl, threeCellMesh())
    layer.setValues(new Float32Array([0, 0.5, 1]))
    layer.setHatch(new Uint8Array([1, 0, 0]))
    layer.setGridLines(true)
    layer.setGridLineColor([0.1, 0.2, 0.3, 0.5])
    calls.length = 0
    layer.draw()
    const order = allDraws(calls).map((c) => [c.method, c.args[0], c.args[1]])
    expect(order).toEqual([
      ['drawElements', 'TRIANGLES', 18],
      ['drawElements', 'LINES', 24],
      ['drawElements', 'TRIANGLES', 18],
    ])
    const lines = calls.indexOf(lineDraws(calls)[0])
    const colour = calls.slice(0, lines).filter((c) => c.method === 'uniform4f').pop()!
    expect(colour.args.slice(1)).toEqual([0.1, 0.2, 0.3, 0.5])
    const before = calls.slice(0, lines)
    const enable = before.map((c) => c.method === 'enable' && c.args[0] === 'BLEND').lastIndexOf(true)
    const blend = before.map((c) => c.method === 'blendFuncSeparate').lastIndexOf(true)
    expect(enable).toBeGreaterThan(calls.indexOf(allDraws(calls)[0]))
    // Colour blends by alpha; the alpha channel adds like the fill's, so the canvas stays opaque.
    expect(before[blend].args).toEqual(['SRC_ALPHA', 'ONE_MINUS_SRC_ALPHA', 'ONE', 'ONE_MINUS_SRC_ALPHA'])
    expect(before.some((c, i) => i > enable && c.method === 'blendFunc')).toBe(false)
    expect(calls.slice(lines).some((c) => c.method === 'disable' && c.args[0] === 'BLEND')).toBe(true)
  })

  it('draws them even when the field opacity is 0, the outlines-only look', () => {
    const { gl, calls } = createRecordingGl()
    const layer = new MeshLayer(gl, threeCellMesh())
    layer.setGridLines(true)
    layer.setFieldOpacity(0)
    calls.length = 0
    layer.draw()
    expect(allDraws(calls).map((c) => c.args[0])).toEqual(['LINES'])
  })

  it('draws nothing more once turned off', () => {
    const { gl, calls } = createRecordingGl()
    const layer = new MeshLayer(gl, threeCellMesh())
    layer.setGridLines(true)
    layer.setGridLines(false)
    calls.length = 0
    layer.draw()
    expect(lineDraws(calls)).toHaveLength(0)
  })

  it('rebuilds their buffer after a context restore while on', () => {
    const { gl, calls } = createRecordingGl()
    const layer = new MeshLayer(gl, threeCellMesh())
    layer.setGridLines(true)
    calls.length = 0
    layer.reupload()
    expect(edgeUploads(calls)).toHaveLength(1)
    calls.length = 0
    layer.draw()
    expect(lineDraws(calls).map((c) => c.args[1])).toEqual([24])
  })
})

describe('MeshLayer picked-site rings', () => {
  const pointDraws = (calls: Call[]) =>
    calls.filter((c) => c.method === 'drawArrays' && c.args[0] === 'POINTS').map((c) => c.args)
  const ringFragment = (calls: Call[]) =>
    calls.filter((c) => c.method === 'shaderSource').map((c) => c.args[1] as string).find((s) => s.includes('u_inkInner'))!

  it('draws one ring per site after the points, in the hatch ink and halo, and none once cleared', () => {
    const { gl, calls } = createRecordingGl()
    const layer = new MeshLayer(gl, threeCellMesh())
    layer.setPoints(new Float32Array([0, 0, 1, 1]), new Float32Array([1, 2]))
    layer.setSiteRings(new Float32Array([0.5, 0.5, 2.5, 0.5, 1.5, 0.5]))
    layer.setHatchColors([0.1, 0.2, 0.3], [0.9, 0.9, 0.9])
    calls.length = 0
    layer.draw()
    expect(pointDraws(calls)).toEqual([
      ['POINTS', 0, 2],
      ['POINTS', 0, 3],
    ])
    expect(uniformAfter(calls, 'u_ink', 'uniform3f')).toContainEqual([0.1, 0.2, 0.3])
    expect(uniformAfter(calls, 'u_halo', 'uniform3f')).toEqual([[0.9, 0.9, 0.9]])

    layer.setSiteRings(new Float32Array(0))
    calls.length = 0
    layer.draw()
    expect(pointDraws(calls)).toEqual([['POINTS', 0, 2]])
  })

  it('draws a ring with no fill, so the cell value shows inside it', () => {
    const { gl, calls } = createRecordingGl()
    new MeshLayer(gl, threeCellMesh())
    expect(ringFragment(calls)).toMatch(/r < u_inkInner - u_haloWidth \|\| r > u_inkOuter \+ u_haloWidth\) discard/)
  })

  it('keeps the rings after a context restore and refuses an odd coordinate count', () => {
    const { gl, calls } = createRecordingGl()
    const layer = new MeshLayer(gl, threeCellMesh())
    layer.setSiteRings(new Float32Array([0.5, 0.5]))
    layer.reupload()
    calls.length = 0
    layer.draw()
    expect(pointDraws(calls)).toEqual([['POINTS', 0, 1]])
    expect(() => layer.setSiteRings(new Float32Array([1, 2, 3]))).toThrow(/3 coordinates/)
  })
})
