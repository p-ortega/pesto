// The section's camera: distance along the line across, elevation up. One horizontal scale and a
// vertical exaggeration on top of it, so zooming never changes the exaggeration (D-20, D-21).
// Unlike the plan Camera, a higher elevation is drawn higher on screen (D-43).

import { MAX_ZOOM_FROM_FIT, MIN_ZOOM_FROM_FIT } from './camera'

/** The exaggeration as a number with two significant figures: 23.4 is "23", 0.2096 is "0.21". */
export function formatVe(ve: number): string {
  return String(Number(ve.toPrecision(2)))
}

/** 'fitted' takes whatever exaggeration fills the box; a number is used as given (D-20). */
export type VeMode = 'fitted' | number

type Bounds = [number, number, number, number]

/** Pixels at each edge a fit leaves clear, so the axes do not sit over the section. */
export interface SectionInset {
  left: number
  right: number
  top: number
  bottom: number
}

const NO_INSET: SectionInset = { left: 0, right: 0, top: 0, bottom: 0 }

interface Target {
  scaleX: number
  exaggeration: number
  tx: number
  ty: number
}

export class SectionCamera {
  // Pixel x = tx + scaleX * s, pixel y = ty - scaleX * exaggeration * z.
  private scaleX = 1
  private exaggeration = 1
  private tx = 0
  private ty = 0
  private fitScale: number | null = null
  private mode: VeMode = 'fitted'
  private lastFit: { bounds: Bounds; padding: number } | null = null
  private inset: SectionInset = NO_INSET
  // Bumped by every move, so an ease still running stops instead of undoing it.
  private motion = 0

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

  /** The edges the next fit leaves clear; pan and zoom ignore it. */
  setInset(inset: SectionInset): void {
    this.inset = { ...inset }
  }

  // Shared by fit and fitAnimated, so the eased path lands exactly where the jump does.
  private targetFor(bounds: Bounds, padding: number): Target {
    const [sMin, sMax, zMin, zMax] = bounds
    const { left, right, top, bottom } = this.inset
    const boxW = Math.max(this.width - left - right, 1)
    const boxH = Math.max(this.height - top - bottom, 1)
    const spanS = Math.max(sMax - sMin, 1e-9)
    const spanZ = Math.max(zMax - zMin, 1e-9)
    const fillS = ((1 - padding) * boxW) / spanS
    const fillZ = ((1 - padding) * boxH) / spanZ
    let scaleX: number
    let exaggeration: number
    if (this.mode === 'fitted') {
      scaleX = fillS
      exaggeration = fillZ / fillS
    } else {
      // The largest scale at which both spans fit at the chosen exaggeration.
      exaggeration = this.mode
      scaleX = Math.min(fillS, fillZ / exaggeration)
    }
    const scaleZ = scaleX * exaggeration
    return {
      scaleX,
      exaggeration,
      tx: left + boxW / 2 - (scaleX * (sMin + sMax)) / 2,
      ty: top + boxH / 2 + (scaleZ * (zMin + zMax)) / 2,
    }
  }

  private apply(target: Target): void {
    this.scaleX = target.scaleX
    this.exaggeration = target.exaggeration
    this.tx = target.tx
    this.ty = target.ty
  }

  /** Fills the box with [sMin, sMax] across and [zMin, zMax] up, at the exaggeration the mode gives. */
  fit(bounds: Bounds, padding = 0.04): void {
    this.motion += 1
    const target = this.targetFor(bounds, padding)
    this.lastFit = { bounds, padding }
    this.fitScale = target.scaleX
    this.apply(target)
  }

  /** Eases to `fit(bounds)`, calling `onFrame` after every step; jumps in one frame when `reduced`. */
  fitAnimated(bounds: Bounds, onFrame: () => void, opts: { duration?: number; reduced?: boolean; padding?: number } = {}): void {
    this.motion += 1
    const token = this.motion
    const padding = opts.padding ?? 0.04
    const target = this.targetFor(bounds, padding)
    this.lastFit = { bounds, padding }
    this.fitScale = target.scaleX
    if (opts.reduced) {
      this.apply(target)
      onFrame()
      return
    }

    const duration = opts.duration ?? 200
    const start: Target = { scaleX: this.scaleX, exaggeration: this.exaggeration, tx: this.tx, ty: this.ty }
    const startTime = performance.now()
    const step = (now: number): void => {
      if (token !== this.motion) return
      const t = Math.min(1, (now - startTime) / duration)
      if (t >= 1) {
        this.apply(target)
      } else {
        this.scaleX = start.scaleX + (target.scaleX - start.scaleX) * t
        this.exaggeration = start.exaggeration + (target.exaggeration - start.exaggeration) * t
        this.tx = start.tx + (target.tx - start.tx) * t
        this.ty = start.ty + (target.ty - start.ty) * t
      }
      onFrame()
      if (t < 1) requestAnimationFrame(step)
    }
    requestAnimationFrame(step)
  }

  /** A number is used as given with the view centre held still; 'fitted' refits to the last bounds. */
  setVe(mode: VeMode): void {
    if (mode !== 'fitted' && !(Number.isFinite(mode) && mode > 0)) return
    this.mode = mode
    if (mode === 'fitted') {
      if (this.lastFit !== null) this.fit(this.lastFit.bounds, this.lastFit.padding)
      return
    }
    this.motion += 1
    const [s, z] = this.screenToWorld(this.width / 2, this.height / 2)
    this.exaggeration = mode
    this.tx = this.width / 2 - this.scaleX * s
    this.ty = this.height / 2 + this.scaleX * mode * z
  }

  veMode(): VeMode {
    return this.mode
  }

  /** The legend line, from the same exaggeration the matrix uses; the number is always given (D-20). */
  veText(): string {
    const number = `vertical exaggeration ${formatVe(this.exaggeration)}×`
    return this.mode === 'fitted' ? `${number} (fitted)` : number
  }

  pan(dx: number, dy: number): void {
    this.motion += 1
    this.tx += dx
    this.ty += dy
  }

  /** Scales both axes together, so the exaggeration holds, keeping the point under the cursor still. */
  zoomAt(x: number, y: number, factor: number): void {
    if (!(factor > 0) || !Number.isFinite(factor)) return
    this.motion += 1
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
