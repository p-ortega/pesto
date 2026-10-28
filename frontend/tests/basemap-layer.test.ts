// BasemapLayer against the recording GL stub: where the quad lands, which
// texture unit and filters it uses, the desaturated draw, and the refusal of
// an image too large for the graphics card. Calls are asserted, never pixels.

import { describe, expect, it } from 'vitest'
import { BasemapLayer } from '../src/gl/basemap-layer'
import { createRecordingGl, type RecordedCall } from './support/recording-gl'

type Extent = [number, number, number, number]

function fakeBitmap(width: number, height: number): ImageBitmap {
  return { width, height } as unknown as ImageBitmap
}

function since(calls: RecordedCall[], from: number): RecordedCall[] {
  return calls.slice(from)
}

function bufferUploads(calls: RecordedCall[]): number[][] {
  return calls
    .filter((c) => c.method === 'bufferData' && c.args[1] instanceof Float32Array)
    .map((c) => Array.from(c.args[1] as Float32Array))
}

// The value a uniform was last set to, found through the getUniformLocation call just before it.
function uniformValues(calls: RecordedCall[], method: string, name: string): unknown[] {
  const out: unknown[] = []
  calls.forEach((c, i) => {
    if (c.method === method && calls[i - 1]?.method === 'getUniformLocation' && calls[i - 1].args[1] === name) {
      out.push(method === 'uniformMatrix3fv' ? c.args[2] : c.args[1])
    }
  })
  return out
}

function drawCalls(calls: RecordedCall[]): RecordedCall[] {
  return calls.filter((c) => c.method === 'drawArrays' || c.method === 'drawElements')
}

describe('BasemapLayer placement', () => {
  it('uploads the corners with the origin subtracted, top-left first, and the matching texture coordinates', () => {
    const { gl, calls } = createRecordingGl()
    const layer = new BasemapLayer(gl)
    const reason = layer.setImage(fakeBitmap(4, 2), [999, 1199, 1901, 2001], [1000, 2000])

    expect(reason).toBeNull()
    expect(layer.hasImage()).toBe(true)
    const uploads = bufferUploads(calls)
    expect(uploads).toContainEqual([-1, 1, 199, 1, -1, -99, 199, -99])
    expect(uploads).toContainEqual([0, 0, 1, 0, 0, 1, 1, 1])
  })

  it('subtracts the origin before rounding to float32, so northings near 7.02e6 land exactly', () => {
    // 7020000.25 and 7020050.75 are not float32 numbers; rounding first would shift the quad.
    expect(Math.fround(7020000.25)).not.toBe(7020000.25)
    expect(Math.fround(7020050.75)).not.toBe(7020050.75)

    const { gl, calls } = createRecordingGl()
    const layer = new BasemapLayer(gl)
    const extent: Extent = [500000.25, 500100.75, 7020000.25, 7020050.75]
    layer.setImage(fakeBitmap(10, 5), extent, [500050, 7020025.5])

    const positions = bufferUploads(calls).find((u) => u.length === 8 && u[0] !== 0)
    expect(positions).toEqual([-49.75, 25.25, 50.75, 25.25, -49.75, -25.25, 50.75, -25.25])
  })
})

describe('BasemapLayer texture', () => {
  it('uploads the bitmap on unit 3 with mipmaps, linear filters and clamped edges', () => {
    const { gl, calls } = createRecordingGl()
    const layer = new BasemapLayer(gl)
    const bitmap = fakeBitmap(4, 2)
    const from = calls.length
    layer.setImage(bitmap, [0, 4, 0, 2], [0, 0])
    const after = since(calls, from)

    expect(after).toContainEqual({ method: 'activeTexture', args: [3] })
    const upload = after.find((c) => c.method === 'texImage2D')
    expect(upload?.args).toEqual(['TEXTURE_2D', 0, 'RGBA', 'RGBA', 'UNSIGNED_BYTE', bitmap])
    expect(after).toContainEqual({ method: 'generateMipmap', args: ['TEXTURE_2D'] })
    const params = after.filter((c) => c.method === 'texParameteri').map((c) => c.args.slice(1))
    expect(params).toContainEqual(['TEXTURE_MIN_FILTER', 'LINEAR_MIPMAP_LINEAR'])
    expect(params).toContainEqual(['TEXTURE_MAG_FILTER', 'LINEAR'])
    expect(params).toContainEqual(['TEXTURE_WRAP_S', 'CLAMP_TO_EDGE'])
    expect(params).toContainEqual(['TEXTURE_WRAP_T', 'CLAMP_TO_EDGE'])
  })

  it('leaves unit 0 active after an upload, because the mesh layer binds its value texture without choosing a unit', () => {
    const { gl, calls } = createRecordingGl()
    const layer = new BasemapLayer(gl)
    layer.setImage(fakeBitmap(4, 2), [0, 4, 0, 2], [0, 0])
    const units = calls.filter((c) => c.method === 'activeTexture')
    expect(units.at(-1)?.args).toEqual([0])
  })
})

describe('BasemapLayer draw', () => {
  it('makes no draw call when there is no image', () => {
    const { gl, calls } = createRecordingGl()
    const layer = new BasemapLayer(gl)
    const from = calls.length
    layer.draw()
    expect(drawCalls(since(calls, from))).toEqual([])
  })

  it('draws the quad desaturated on unit 3 with the camera matrix, blending colour only and restoring the blend state', () => {
    const { gl, calls } = createRecordingGl()
    const layer = new BasemapLayer(gl)
    layer.setImage(fakeBitmap(4, 2), [0, 4, 0, 2], [0, 0])
    const matrix = new Float32Array([2, 0, 0, 0, 2, 0, 0, 0, 1])
    layer.setMatrix(matrix)
    const from = calls.length
    layer.draw()
    const after = since(calls, from)

    expect(after[0].method).toBe('useProgram')
    expect(after).toContainEqual({ method: 'activeTexture', args: [3] })
    expect(uniformValues(after, 'uniform1i', 'u_image')).toEqual([3])
    expect(uniformValues(after, 'uniform1f', 'u_saturation')).toEqual([0])
    expect(uniformValues(after, 'uniformMatrix3fv', 'u_matrix')).toEqual([matrix])
    expect(after).toContainEqual({
      method: 'blendFuncSeparate',
      args: ['SRC_ALPHA', 'ONE_MINUS_SRC_ALPHA', 'ONE', 'ONE_MINUS_SRC_ALPHA'],
    })
    expect(drawCalls(after)).toEqual([{ method: 'drawArrays', args: ['TRIANGLE_STRIP', 0, 4] }])
    // The stub reports blending off, so the layer must switch it off again.
    expect(after.filter((c) => c.method === 'disable').map((c) => c.args[0])).toContain('BLEND')
  })

  it('shows colours at saturation 1 and clamps saturation to 0..1', () => {
    const { gl, calls } = createRecordingGl()
    const layer = new BasemapLayer(gl)
    layer.setImage(fakeBitmap(4, 2), [0, 4, 0, 2], [0, 0])
    const seen: unknown[] = []
    for (const s of [1, 2, -1, 0.5]) {
      layer.setSaturation(s)
      const from = calls.length
      layer.draw()
      seen.push(...uniformValues(since(calls, from), 'uniform1f', 'u_saturation'))
    }
    expect(seen).toEqual([1, 1, 0, 0.5])
  })

  it('clears the image on a null bitmap, so the next draw makes no draw call', () => {
    const { gl, calls } = createRecordingGl()
    const layer = new BasemapLayer(gl)
    layer.setImage(fakeBitmap(4, 2), [0, 4, 0, 2], [0, 0])
    expect(layer.setImage(null, null, [0, 0])).toBeNull()
    expect(layer.hasImage()).toBe(false)
    const from = calls.length
    layer.draw()
    expect(drawCalls(since(calls, from))).toEqual([])
  })
})

describe('BasemapLayer refusals', () => {
  it('reports the largest texture the graphics card holds', () => {
    const { gl } = createRecordingGl()
    expect(BasemapLayer.maxTextureSize(gl)).toBe(16384)
  })

  it('refuses a bitmap wider than the graphics card holds, naming both numbers, and uploads nothing', () => {
    const { gl, calls } = createRecordingGl()
    const layer = new BasemapLayer(gl)
    const from = calls.length
    const reason = layer.setImage(fakeBitmap(20000, 10), [0, 4, 0, 2], [0, 0])

    expect(reason).toBe('the image is 20000 × 10 pixels; this graphics card holds at most 16384 pixels per side')
    expect(layer.hasImage()).toBe(false)
    const after = since(calls, from)
    expect(after.some((c) => c.method === 'texImage2D' || c.method === 'bufferData')).toBe(false)
    const drawFrom = calls.length
    layer.draw()
    expect(drawCalls(since(calls, drawFrom))).toEqual([])
  })

  it('refuses a bitmap taller than the graphics card holds', () => {
    const { gl } = createRecordingGl()
    const layer = new BasemapLayer(gl)
    expect(layer.setImage(fakeBitmap(10, 16385), [0, 4, 0, 2], [0, 0])).toBe(
      'the image is 10 × 16385 pixels; this graphics card holds at most 16384 pixels per side',
    )
  })

  it('a refusal drops the image it replaced, so the old picture is not left under the new placement', () => {
    const { gl } = createRecordingGl()
    const layer = new BasemapLayer(gl)
    layer.setImage(fakeBitmap(4, 2), [0, 4, 0, 2], [0, 0])
    layer.setImage(fakeBitmap(20000, 10), [0, 4, 0, 2], [0, 0])
    expect(layer.hasImage()).toBe(false)
  })

  it('refuses a placement that is missing, not finite or has no area', () => {
    const { gl, calls } = createRecordingGl()
    const layer = new BasemapLayer(gl)
    const from = calls.length
    expect(layer.setImage(fakeBitmap(4, 2), null, [0, 0])).toMatch(/no placement/)
    expect(layer.setImage(fakeBitmap(4, 2), [0, Number.NaN, 0, 2], [0, 0])).toMatch(/not finite/)
    expect(layer.setImage(fakeBitmap(4, 2), [4, 4, 0, 2], [0, 0])).toMatch(/no area/)
    expect(layer.setImage(fakeBitmap(4, 2), [0, 4, 2, 0], [0, 0])).toMatch(/no area/)
    expect(layer.setImage(fakeBitmap(4, 2), [0, 4, 0, 2], [Number.NaN, 0])).toMatch(/origin/)
    expect(layer.setImage(fakeBitmap(0, 2), [0, 4, 0, 2], [0, 0])).toMatch(/no pixels/)
    expect(layer.hasImage()).toBe(false)
    expect(since(calls, from).some((c) => c.method === 'texImage2D')).toBe(false)
  })

  it('refuses every image when the graphics card does not report its largest texture size', () => {
    const { gl } = createRecordingGl()
    ;(gl as unknown as { getParameter: () => unknown }).getParameter = () => null
    const layer = new BasemapLayer(gl)
    expect(layer.setImage(fakeBitmap(4, 2), [0, 4, 0, 2], [0, 0])).toMatch(/largest texture/)
    expect(layer.hasImage()).toBe(false)
  })
})
