// The section's camera: distance along the line across, elevation up. One horizontal scale and a
// vertical exaggeration on top of it, so zooming never changes the exaggeration (D-20, D-21).
// Unlike the plan Camera, a higher elevation is drawn higher on screen (D-43).

import { MAX_ZOOM_FROM_FIT, MIN_ZOOM_FROM_FIT } from './camera'

/** The exaggeration as a number with two significant figures: 23.4 is "23", 0.2096 is "0.21". */
export function formatVe(ve: number): string {
  return String(Number(ve.toPrecision(2)))
}

export class SectionCamera {
  // Pixel x = tx + scaleX * s, pixel y = ty - scaleX * exaggeration * z.
  private scaleX = 1
  private exaggeration = 1
  private tx = 0
  private ty = 0
  private fitScale: number | null = null

  constructor(
    private width: number,
    private height: number,
  ) {}

  /** The world point at the centre stays at the centre; the scales are untouched. */
  resize(width: number, height: number): void {
    this.tx += (width - this.width) / 2
    this.ty += (height - this.height) / 2
    this.width = width
    this.height = height
  }

  /** Fills the box with [sMin, sMax] across and [zMin, zMax] up, and takes the exaggeration that needs. */
  fit(bounds: [number, number, number, number], padding = 0.04): void {
    const [sMin, sMax, zMin, zMax] = bounds
    const spanS = Math.max(sMax - sMin, 1e-9)
    const spanZ = Math.max(zMax - zMin, 1e-9)
    const scaleX = ((1 - padding) * this.width) / spanS
    const scaleZ = ((1 - padding) * this.height) / spanZ
    this.scaleX = scaleX
    this.exaggeration = scaleZ / scaleX
    this.fitScale = scaleX
    this.tx = this.width / 2 - (scaleX * (sMin + sMax)) / 2
    this.ty = this.height / 2 + (scaleZ * (zMin + zMax)) / 2
  }

  pan(dx: number, dy: number): void {
    this.tx += dx
    this.ty += dy
  }

  /** Scales both axes together, so the exaggeration holds, keeping the point under the cursor still. */
  zoomAt(x: number, y: number, factor: number): void {
    if (!(factor > 0) || !Number.isFinite(factor)) return
    const [s, z] = this.screenToWorld(x, y)
    let scale = this.scaleX * factor
    if (this.fitScale !== null) {
      scale = Math.min(Math.max(scale, this.fitScale * MIN_ZOOM_FROM_FIT), this.fitScale * MAX_ZOOM_FROM_FIT)
    }
    this.scaleX = scale
    this.tx = x - scale * s
    this.ty = y + scale * this.exaggeration * z
  }

  ve(): number {
    return this.exaggeration
  }

  screenToWorld(x: number, y: number): [number, number] {
    return [(x - this.tx) / this.scaleX, (this.ty - y) / (this.scaleX * this.exaggeration)]
  }

  worldToScreen(s: number, z: number): [number, number] {
    return [this.tx + this.scaleX * s, this.ty - this.scaleX * this.exaggeration * z]
  }

  /** Column-major 3x3 to clip space for vertices already relative to `ref`; ref is folded in here in float64. */
  matrix(ref: readonly [number, number]): Float32Array {
    const scaleZ = this.scaleX * this.exaggeration
    const px0 = this.tx + this.scaleX * ref[0]
    const py0 = this.ty - scaleZ * ref[1]
    return new Float32Array([
      (2 * this.scaleX) / this.width,
      0,
      0,
      0,
      (2 * scaleZ) / this.height,
      0,
      (2 * px0) / this.width - 1,
      1 - (2 * py0) / this.height,
      1,
    ])
  }
}
