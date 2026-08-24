/** Pan and zoom in model coordinates. The mesh arrives in whatever units
 *  the grid file uses, projected or not, so the camera works in those
 *  units and never assumes a projection. */
export class Camera {
  private scale = 1
  private tx = 0
  private ty = 0

  constructor(
    private width: number,
    private height: number,
  ) {}

  resize(width: number, height: number): void {
    this.width = width
    this.height = height
  }

  // Shared by fit and fitAnimated -- the instant jump and the eased path
  // both land on exactly this scale/tx/ty, computed without touching the
  // camera's own live state, so fitAnimated can interpolate toward it.
  private targetFor(
    bounds: [number, number, number, number],
    padding: number,
  ): { scale: number; tx: number; ty: number } {
    const [xmin, xmax, ymin, ymax] = bounds
    const spanX = Math.max(xmax - xmin, 1e-9)
    const spanY = Math.max(ymax - ymin, 1e-9)
    const scale = (1 - padding) * Math.min(this.width / spanX, this.height / spanY)
    const tx = this.width / 2 - (scale * (xmin + xmax)) / 2
    const ty = this.height / 2 - (scale * (ymin + ymax)) / 2
    return { scale, tx, ty }
  }

  fit(bounds: [number, number, number, number], padding = 0.04): void {
    const target = this.targetFor(bounds, padding)
    this.scale = target.scale
    this.tx = target.tx
    this.ty = target.ty
  }

  /** Eases to `fit(bounds)` over `duration` ms, calling `onFrame` after
   *  every intermediate step so the caller can redraw -- the one thing in
   *  this phase beyond `chrome.ts`'s own transition that animates
   *  (MAP-11). Jumps to the target in a single frame with no
   *  interpolation when `reduced` is set, honouring
   *  `prefers-reduced-motion`. Direct mouse drag (`pan`) is user motion
   *  and never goes through here. */
  fitAnimated(
    bounds: [number, number, number, number],
    onFrame: () => void,
    opts: { duration?: number; reduced?: boolean; padding?: number } = {},
  ): void {
    const target = this.targetFor(bounds, opts.padding ?? 0.04)
    if (opts.reduced) {
      this.scale = target.scale
      this.tx = target.tx
      this.ty = target.ty
      onFrame()
      return
    }

    const duration = opts.duration ?? 200
    const startScale = this.scale
    const startTx = this.tx
    const startTy = this.ty
    const startTime = performance.now()

    const step = (now: number): void => {
      const t = Math.min(1, (now - startTime) / duration)
      this.scale = startScale + (target.scale - startScale) * t
      this.tx = startTx + (target.tx - startTx) * t
      this.ty = startTy + (target.ty - startTy) * t
      onFrame()
      if (t < 1) requestAnimationFrame(step)
    }
    requestAnimationFrame(step)
  }

  pan(dx: number, dy: number): void {
    this.tx += dx
    this.ty += dy
  }

  zoomAt(x: number, y: number, factor: number): void {
    // Hold the world point under the cursor still.
    const [wx, wy] = this.screenToWorld(x, y)
    this.scale *= factor
    this.tx = x - this.scale * wx
    this.ty = y - this.scale * wy
  }

  screenToWorld(x: number, y: number): [number, number] {
    return [(x - this.tx) / this.scale, (y - this.ty) / this.scale]
  }

  /** Column-major 3x3 taking model coordinates to clip space. Y is
   *  flipped because screen y grows downward and model y grows upward. */
  matrix(): Float32Array {
    const sx = (2 * this.scale) / this.width
    const sy = (2 * this.scale) / this.height
    return new Float32Array([
      sx,
      0,
      0,
      0,
      -sy,
      0,
      (2 * this.tx) / this.width - 1,
      1 - (2 * this.ty) / this.height,
      1,
    ])
  }
}
