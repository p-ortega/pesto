// The section answer is read strictly, and the quads, the camera and the pick each follow from
// it: every key by name, every length against n_pieces and nlay, the quad id piece * nlay + layer,
// a float64 reference before the float32 cast, higher elevation drawn higher, and a float64 pick.

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { fetchSection, parseSection, sectionKey } from '../src/data/section'
import { pickSection } from '../src/data/section-pick'
import { SectionCamera, formatVe } from '../src/gl/section-camera'
import { buildSectionMesh } from '../src/gl/section-layer'

const FIXTURE_TEXT = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'section-tracer-answer.json'), 'utf8')

function fixture(): Record<string, unknown> {
  return JSON.parse(FIXTURE_TEXT) as Record<string, unknown>
}

function answerWith(changes: Record<string, unknown>) {
  return parseSection({ ...fixture(), ...changes })
}

const KEYS = [
  'line',
  'nlay',
  'n_pieces',
  'cell',
  's0',
  's1',
  'z',
  'status',
  'status_text',
  'has_idomain',
  'grid_type',
  'length_units',
  'counts',
  'notes',
  'tag',
]

describe('the section client', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('reads the tracer answer', () => {
    const answer = parseSection(fixture())
    expect(answer.nPieces).toBe(3)
    expect(Array.from(answer.cell)).toEqual([0, 1, 2])
    expect(answer.z).toHaveLength(9)
    expect(answer.status).toHaveLength(6)
    expect(answer.statusText.get(1)).toBe('inactive (idomain 0)')
    expect(answer.line).toEqual({ a: [999.5, 2000.5], b: [1003, 2000.5], length: 3.5 })
    expect(answer.lengthUnits).toBeNull()
    expect(answer.counts.candidates).toBe(3)
  })

  it.each(KEYS)('refuses an answer missing %s, naming it', (key) => {
    const raw = fixture()
    delete raw[key]
    expect(() => parseSection(raw)).toThrow(`the section answer is missing ${key}`)
  })

  it('refuses a z of the wrong length, saying how many were expected', () => {
    expect(() => answerWith({ z: [10, 5, 0, 10, 5, 0, 10, 5] })).toThrow('z in the section answer holds 8 values; 9 were expected')
  })

  it('refuses a status code outside 0 to 5', () => {
    expect(() => answerWith({ status: [0, 0, 0, 7, 0, 0] })).toThrow('status in the section answer holds 7, not one of 0 to 5')
  })

  it('refuses a status text that is not text', () => {
    const statusText = { ...(fixture().status_text as Record<string, unknown>), 1: { html: '<b>x</b>' } }
    expect(() => answerWith({ status_text: statusText })).toThrow('status_text 1 in the section answer is not text')
  })

  it('reads a null elevation as NaN', () => {
    const answer = answerWith({ z: [null, 5, 0, 10, 5, 0, 10, 5, 0] })
    expect(Number.isNaN(answer.z[0])).toBe(true)
    expect(answer.z[1]).toBe(5)
  })

  it('sends the end coordinates exactly as String(number) writes them', async () => {
    const urls: string[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string) => {
        urls.push(input)
        return new Response(FIXTURE_TEXT, { status: 200 })
      }),
    )
    const result = await fetchSection([7020000.123456789, 1.5], [7020010.5, -2.25])
    expect(result.ok).toBe(true)
    const query = new URLSearchParams(urls[0].split('?')[1])
    expect(urls[0].split('?')[0]).toBe('/api/run/grid/section')
    expect(query.get('ax')).toBe('7020000.123456789')
    expect(query.get('ay')).toBe('1.5')
    expect(query.get('bx')).toBe('7020010.5')
    expect(query.get('by')).toBe('-2.25')
  })

  it('turns a problem answer into a refusal with its artifact and reason', async () => {
    const detail = 'this cache predates the section view; it is added on the next ingest'
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ type: 'about:blank', title: 'stale cache', status: 409, artifact: 'elev', detail }), { status: 409 })),
    )
    expect(await fetchSection([0, 0], [1, 1])).toEqual({ ok: false, artifact: 'elev', reason: detail })
  })

  it('names the section route as the artifact when a problem names none, and reads the title', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ type: 'about:blank', title: 'the line crosses no model cell', status: 422 }), { status: 422 })),
    )
    expect(await fetchSection([0, 0], [1, 1])).toEqual({ ok: false, artifact: 'grid/section', reason: 'the line crosses no model cell' })
  })

  it('refuses a malformed answer by name instead of drawing it', async () => {
    const raw = fixture()
    delete raw.status
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(raw), { status: 200 })))
    expect(await fetchSection([0, 0], [1, 1])).toEqual({ ok: false, artifact: 'grid/section', reason: 'the section answer is missing status' })
  })

  it('keys a line by its run and all four ends', () => {
    const base = sectionKey('run1', [1, 2], [3, 4])
    expect(sectionKey('run1', [1, 2], [3, 4])).toBe(base)
    expect(sectionKey('run2', [1, 2], [3, 4])).not.toBe(base)
    expect(sectionKey('run1', [1.0000001, 2], [3, 4])).not.toBe(base)
    expect(sectionKey('run1', [1, 2.5], [3, 4])).not.toBe(base)
    expect(sectionKey('run1', [1, 2], [3.5, 4])).not.toBe(base)
    expect(sectionKey('run1', [1, 2], [3, 4.5])).not.toBe(base)
    expect(sectionKey(null, [1, 2], [3, 4])).not.toBe(base)
  })
})

describe('the section quads', () => {
  it('builds one four-vertex quad per piece and layer, numbered piece * nlay + layer', () => {
    const { mesh, ref } = buildSectionMesh(parseSection(fixture()))
    expect(mesh.nCells).toBe(6)
    expect(mesh.positions).toHaveLength(48)
    expect(mesh.cellIndex).toHaveLength(24)
    expect(mesh.indices).toHaveLength(36)
    for (let q = 0; q < 6; q++) {
      expect(Array.from(mesh.cellIndex.slice(q * 4, q * 4 + 4))).toEqual([q, q, q, q])
    }
    expect(ref).toEqual([1.75, 5])
    // Quad 3 is piece 1, layer 1: from distance 1.5 to 2.5, elevation 5 down to 0.
    const corners = Array.from(mesh.positions.slice(24, 32))
    const s = corners.filter((_, i) => i % 2 === 0).map((v) => v + ref[0])
    const z = corners.filter((_, i) => i % 2 === 1).map((v) => v + ref[1])
    expect(s).toEqual([1.5, 2.5, 2.5, 1.5])
    expect(z).toEqual([5, 5, 0, 0])
    expect(Array.from(mesh.indices.slice(18, 24))).toEqual([12, 13, 14, 12, 14, 15])
  })

  it('subtracts the reference in float64 before the cast, so distances near 7.02e6 keep sub-millimetre detail', () => {
    const answer = answerWith({
      line: { a: [0, 0], b: [14040000, 0], length: 14040000 },
      nlay: 1,
      n_pieces: 1,
      cell: [5],
      s0: [7020000.0001],
      s1: [7020000.0009],
      z: [1, 0],
      status: [0],
    })
    const { mesh, ref } = buildSectionMesh(answer)
    expect(ref[0]).toBe(7020000)
    expect(Math.abs(mesh.positions[0] + ref[0] - 7020000.0001)).toBeLessThan(1e-6)
    expect(Math.abs(mesh.positions[2] + ref[0] - 7020000.0009)).toBeLessThan(1e-6)
    // An absolute float32 would have rounded both ends to the same number.
    expect(Math.fround(7020000.0001)).toBe(Math.fround(7020000.0009))
  })

  it('collapses a quad with an elevation that is not finite to a point', () => {
    const { mesh } = buildSectionMesh(answerWith({ z: [10, null, 0, 10, 5, 0, 10, 5, 0] }))
    const quad0 = Array.from(mesh.positions.slice(0, 8))
    const quad1 = Array.from(mesh.positions.slice(8, 16))
    expect(new Set(quad0.filter((_, i) => i % 2 === 0)).size).toBe(1)
    expect(new Set(quad0.filter((_, i) => i % 2 === 1)).size).toBe(1)
    expect(new Set(quad1.filter((_, i) => i % 2 === 0)).size).toBe(1)
    expect(quad0.every(Number.isFinite)).toBe(true)
  })
})

describe('the section camera', () => {
  function fitted(): SectionCamera {
    const camera = new SectionCamera(800, 480)
    camera.fit([0, 3.5, 0, 10])
    return camera
  }

  it('centres the fitted box', () => {
    const [x, y] = fitted().worldToScreen(1.75, 5)
    expect(x).toBeCloseTo(400, 9)
    expect(y).toBeCloseTo(240, 9)
  })

  it('draws a higher elevation higher on screen', () => {
    const camera = fitted()
    expect(camera.worldToScreen(1, 9)[1]).toBeLessThan(camera.worldToScreen(1, 1)[1])
  })

  it('fits both spans with the exaggeration that needs', () => {
    const camera = fitted()
    // 0.96 * 800 / 3.5 across, 0.96 * 480 / 10 up.
    expect(camera.ve()).toBeCloseTo(((0.96 * 480) / 10) / ((0.96 * 800) / 3.5), 12)
    const [left] = camera.worldToScreen(0, 5)
    const [right] = camera.worldToScreen(3.5, 5)
    expect(right - left).toBeCloseTo(0.96 * 800, 9)
    expect(camera.worldToScreen(1, 0)[1] - camera.worldToScreen(1, 10)[1]).toBeCloseTo(0.96 * 480, 9)
  })

  it('zooms with the exaggeration held and the point under the cursor still', () => {
    const camera = fitted()
    const ve = camera.ve()
    const before = camera.screenToWorld(300, 100)
    camera.zoomAt(300, 100, 2)
    expect(camera.ve()).toBe(ve)
    const after = camera.screenToWorld(300, 100)
    expect(after[0]).toBeCloseTo(before[0], 12)
    expect(after[1]).toBeCloseTo(before[1], 12)
  })

  it('round-trips screen and world', () => {
    const camera = fitted()
    camera.pan(13, -7)
    const [s, z] = camera.screenToWorld(123, 321)
    const [x, y] = camera.worldToScreen(s, z)
    expect(x).toBeCloseTo(123, 9)
    expect(y).toBeCloseTo(321, 9)
  })

  it('keeps the centre still on a resize', () => {
    const camera = fitted()
    camera.resize(1000, 600)
    const [x, y] = camera.worldToScreen(1.75, 5)
    expect(x).toBeCloseTo(500, 9)
    expect(y).toBeCloseTo(300, 9)
  })

  it('maps a vertex relative to the reference to the clip point of its absolute position', () => {
    const camera = fitted()
    const ref: [number, number] = [1.75, 5]
    const m = camera.matrix(ref)
    const [vx, vy] = [2.5 - ref[0], 0 - ref[1]]
    const clipX = m[0] * vx + m[3] * vy + m[6]
    const clipY = m[1] * vx + m[4] * vy + m[7]
    const [x, y] = camera.worldToScreen(2.5, 0)
    expect(((clipX + 1) / 2) * 800).toBeCloseTo(x, 3)
    expect(((1 - clipY) / 2) * 480).toBeCloseTo(y, 3)
  })

  it('writes the exaggeration with two significant figures', () => {
    expect(formatVe(23.4)).toBe('23')
    expect(formatVe(0.2096)).toBe('0.21')
    expect(formatVe(1)).toBe('1')
    expect(formatVe(1234)).toBe('1200')
  })
})

describe('the section pick', () => {
  const answer = parseSection(fixture())

  it('picks the piece and layer under the point', () => {
    expect(pickSection(answer, 1.0, 7.5)).toEqual({ piece: 0, layer: 0, cell: 0, status: 0, top: 10, bottom: 5, s: 1.0, z: 7.5 })
    expect(pickSection(answer, 2.0, 2.5)).toMatchObject({ piece: 1, layer: 1, cell: 1, status: 1 })
  })

  it('gives a shared end to the piece nearer A, and an interface to the upper layer', () => {
    expect(pickSection(answer, 1.5, 7.5)?.piece).toBe(0)
    expect(pickSection(answer, 1.0, 5.0)?.layer).toBe(0)
  })

  it('picks nothing in a gap, above the top or below the bottom', () => {
    expect(pickSection(answer, 2.75, 5)).toBeNull()
    expect(pickSection(answer, 1.0, 11)).toBeNull()
    expect(pickSection(answer, 1.0, -1)).toBeNull()
    expect(pickSection(answer, 0.25, 5)).toBeNull()
  })

  it('never picks a quad whose top and bottom are equal', () => {
    const pinched = answerWith({ z: [10, 10, 5, 10, 5, 0, 10, 5, 0] })
    expect(pickSection(pinched, 1.0, 10)).toMatchObject({ piece: 0, layer: 1 })
  })

  it('names the cell by the answer cell value, not by its position', () => {
    const named = answerWith({ cell: [42, 7, 99] })
    expect(pickSection(named, 2.0, 7.5)?.cell).toBe(7)
    expect(pickSection(named, 3.25, 2.5)?.cell).toBe(99)
  })
})
