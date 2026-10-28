// Behaviours 3-5 of plan 05.1-03: scaleLimits' robust percentiles, ramp's
// 256-entry interpolation, and MeshLayer's NEAREST-filtered value upload.
// MeshLayer is exercised against a recording stub standing in for
// WebGL2RenderingContext -- these tests assert the calls made, never
// pixels; the screenshot in tests/visual/mesh.spec.ts is what proves those.

import { describe, expect, it } from 'vitest'
import { ramp, scaleLimits, STOPS, hexToRgb } from '../src/gl/colormap'
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
    expect(storage).toHaveLength(2)
    expect(storage[1].args).toEqual(storage[0].args)
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
