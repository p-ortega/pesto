// Behaviours 3-5 of plan 05.1-03: scaleLimits' robust percentiles, ramp's
// 256-entry interpolation, and MeshLayer's NEAREST-filtered value upload.
// MeshLayer is exercised against a recording stub standing in for
// WebGL2RenderingContext -- these tests assert the calls made, never
// pixels; the screenshot in tests/visual/mesh.spec.ts is what proves those.

import { describe, expect, it } from 'vitest'
import { ramp, scaleLimits, STOPS, hexToRgb } from '../src/gl/colormap'
import { MeshLayer, type MeshData } from '../src/gl/mesh-layer'

describe('scaleLimits', () => {
  it('returns the 2nd and 98th percentile of the finite values, ignoring NaN', () => {
    const values = new Float32Array(
      Array.from({ length: 100 }, (_, i) => i).concat([Number.NaN, Number.NaN]),
    )
    const [lo, hi] = scaleLimits(values, 0.02)
    expect(lo).toBeCloseTo(1, 5)
    expect(hi).toBeCloseTo(98, 5)
  })

  it('returns a usable range when every value is identical', () => {
    const [lo, hi] = scaleLimits(new Float32Array([5, 5, 5]), 0.02)
    expect(hi).toBeGreaterThan(lo)
  })

  it('returns a usable range when everything is missing', () => {
    const [lo, hi] = scaleLimits(new Float32Array([Number.NaN, Number.NaN]), 0.02)
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

interface RecordedCall {
  method: string
  args: unknown[]
}

// Every method MeshLayer calls, logging its name and arguments and
// returning just enough of a value (a unique tagged object, or true for a
// status check) to keep the class's own logic moving. Nothing here can
// render a pixel.
function createRecordingGl(): { gl: WebGL2RenderingContext; calls: RecordedCall[] } {
  const calls: RecordedCall[] = []
  let nextId = 1
  const tag = (kind: string) => ({ __tag: kind, __id: nextId++ })
  const record =
    (method: string) =>
    (...args: unknown[]) => {
      calls.push({ method, args })
    }

  const CONSTANTS: Record<string, string | number> = {
    TEXTURE_2D: 'TEXTURE_2D',
    ARRAY_BUFFER: 'ARRAY_BUFFER',
    ELEMENT_ARRAY_BUFFER: 'ELEMENT_ARRAY_BUFFER',
    STATIC_DRAW: 'STATIC_DRAW',
    DYNAMIC_DRAW: 'DYNAMIC_DRAW',
    FLOAT: 'FLOAT',
    TRIANGLES: 'TRIANGLES',
    LINES: 'LINES',
    UNSIGNED_INT: 'UNSIGNED_INT',
    R32F: 'R32F',
    RGBA: 'RGBA',
    RED: 'RED',
    UNSIGNED_BYTE: 'UNSIGNED_BYTE',
    NEAREST: 'NEAREST',
    LINEAR: 'LINEAR',
    CLAMP_TO_EDGE: 'CLAMP_TO_EDGE',
    TEXTURE_MIN_FILTER: 'TEXTURE_MIN_FILTER',
    TEXTURE_MAG_FILTER: 'TEXTURE_MAG_FILTER',
    TEXTURE_WRAP_S: 'TEXTURE_WRAP_S',
    COMPILE_STATUS: 'COMPILE_STATUS',
    LINK_STATUS: 'LINK_STATUS',
    VERTEX_SHADER: 'VERTEX_SHADER',
    FRAGMENT_SHADER: 'FRAGMENT_SHADER',
    TEXTURE0: 0,
    TEXTURE1: 1,
    COLOR_BUFFER_BIT: 'COLOR_BUFFER_BIT',
  }

  const gl = {
    ...CONSTANTS,
    createShader: (...a: unknown[]) => {
      record('createShader')(...a)
      return tag('shader')
    },
    shaderSource: record('shaderSource'),
    compileShader: record('compileShader'),
    getShaderParameter: () => true,
    getShaderInfoLog: () => '',
    createProgram: (...a: unknown[]) => {
      record('createProgram')(...a)
      return tag('program')
    },
    attachShader: record('attachShader'),
    linkProgram: record('linkProgram'),
    getProgramParameter: () => true,
    getProgramInfoLog: () => '',
    createVertexArray: (...a: unknown[]) => {
      record('createVertexArray')(...a)
      return tag('vao')
    },
    bindVertexArray: record('bindVertexArray'),
    createBuffer: (...a: unknown[]) => {
      record('createBuffer')(...a)
      return tag('buffer')
    },
    bindBuffer: record('bindBuffer'),
    bufferData: record('bufferData'),
    getAttribLocation: () => nextId++,
    enableVertexAttribArray: record('enableVertexAttribArray'),
    vertexAttribPointer: record('vertexAttribPointer'),
    createTexture: (...a: unknown[]) => {
      record('createTexture')(...a)
      return tag('texture')
    },
    bindTexture: record('bindTexture'),
    texStorage2D: record('texStorage2D'),
    texParameteri: record('texParameteri'),
    texSubImage2D: record('texSubImage2D'),
    texImage2D: record('texImage2D'),
    useProgram: record('useProgram'),
    activeTexture: record('activeTexture'),
    getUniformLocation: (...a: unknown[]) => {
      record('getUniformLocation')(...a)
      return tag('uniform')
    },
    uniform1i: record('uniform1i'),
    uniform2f: record('uniform2f'),
    uniform3f: record('uniform3f'),
    uniformMatrix3fv: record('uniformMatrix3fv'),
    drawElements: record('drawElements'),
    deleteProgram: record('deleteProgram'),
    deleteVertexArray: record('deleteVertexArray'),
    deleteBuffer: record('deleteBuffer'),
    deleteTexture: record('deleteTexture'),
    viewport: record('viewport'),
    clearColor: record('clearColor'),
    clear: record('clear'),
  }

  return { gl: gl as unknown as WebGL2RenderingContext, calls }
}

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
})
