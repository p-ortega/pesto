// The section drawn by a second MeshLayer on quad data, so the ramp, classes, texture, hairline
// and footprint are the plan's own code (D-43). Quad q = piece * nlay + layer.

import type { SectionAnswer } from '../data/section'
import { MeshLayer, type MeshData } from './mesh-layer'
import type { SectionCamera } from './section-camera'

export interface SectionMesh {
  mesh: MeshData
  /** Subtracted from every vertex in float64 before the cast, so far-off distances keep their detail. */
  ref: [number, number]
}

export function buildSectionMesh(answer: SectionAnswer): SectionMesh {
  const { nlay, nPieces, s0, s1, z } = answer
  let zMin = Number.POSITIVE_INFINITY
  let zMax = Number.NEGATIVE_INFINITY
  for (let i = 0; i < z.length; i++) {
    if (!Number.isFinite(z[i])) continue
    if (z[i] < zMin) zMin = z[i]
    if (z[i] > zMax) zMax = z[i]
  }
  const ref: [number, number] = [answer.line.length / 2, zMin <= zMax ? (zMin + zMax) / 2 : 0]
  const nCells = nPieces * nlay
  const positions = new Float32Array(nCells * 8)
  const cellIndex = new Float32Array(nCells * 4)
  const indices = new Uint32Array(nCells * 6)
  for (let p = 0; p < nPieces; p++) {
    const a = s0[p] - ref[0]
    const b = s1[p] - ref[0]
    for (let k = 0; k < nlay; k++) {
      const q = p * nlay + k
      const top = z[p * (nlay + 1) + k]
      const bottom = z[p * (nlay + 1) + k + 1]
      const ok = Number.isFinite(top) && Number.isFinite(bottom)
      // A quad with an elevation that is not finite collapses to a point, so it draws nothing.
      const t = ok ? top - ref[1] : 0
      const u = ok ? bottom - ref[1] : 0
      const right = ok ? b : a
      positions.set([a, t, right, t, right, u, a, u], q * 8)
      cellIndex.fill(q, q * 4, q * 4 + 4)
      const v = q * 4
      indices.set([v, v + 1, v + 2, v, v + 2, v + 3], q * 6)
    }
  }
  return { mesh: { positions, cellIndex, indices, nCells }, ref }
}

export class SectionLayer {
  readonly layer: MeshLayer
  readonly ref: [number, number]
  readonly nCells: number

  constructor(gl: WebGL2RenderingContext, answer: SectionAnswer) {
    const { mesh, ref } = buildSectionMesh(answer)
    this.layer = new MeshLayer(gl, mesh)
    this.ref = ref
    this.nCells = mesh.nCells
  }

  setCamera(camera: SectionCamera): void {
    this.layer.setMatrix(camera.matrix(this.ref))
  }

  draw(): void {
    this.layer.draw()
  }

  reupload(): void {
    this.layer.reupload()
  }

  dispose(): void {
    this.layer.dispose()
  }
}
