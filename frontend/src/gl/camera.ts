/** Pan and zoom in model coordinates. The mesh arrives in whatever units
 *  the grid file uses, projected or not, so the camera works in those
 *  units and never assumes a projection. `pan` and `zoomAt` are wired to
 *  input in a later plan; this plan only calls `fit` and `matrix`. */
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

  fit(bounds: [number, number, number, number], padding = 0.04): void {
    const [xmin, xmax, ymin, ymax] = bounds
    const spanX = Math.max(xmax - xmin, 1e-9)
    const spanY = Math.max(ymax - ymin, 1e-9)
    this.scale = (1 - padding) * Math.min(this.width / spanX, this.height / spanY)
    this.tx = this.width / 2 - (this.scale * (xmin + xmax)) / 2
    this.ty = this.height / 2 - (this.scale * (ymin + ymax)) / 2
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
