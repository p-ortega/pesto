// WebGL2 context creation, and surviving its loss.
//
// Laptops routinely lose the graphics context when they sleep. Unhandled,
// the page comes back blank and looks like the application has died, so
// loss is handled explicitly here and every consumer re-uploads its own
// buffers on restore (MAP-08).

export interface GlContext {
  gl: WebGL2RenderingContext
  onLost: (fn: () => void) => void
  onRestored: (fn: () => void) => void
}

export function createContext(canvas: HTMLCanvasElement): GlContext {
  const gl = canvas.getContext('webgl2', { antialias: true, preserveDrawingBuffer: false })
  if (!gl) {
    throw new Error(
      'This browser or machine has no WebGL2, which pesto needs to draw the model grid. ' +
        'Try a different browser, or check that hardware acceleration is enabled.',
    )
  }

  const lost: (() => void)[] = []
  const restored: (() => void)[] = []

  canvas.addEventListener('webglcontextlost', (event) => {
    event.preventDefault() // required, or the context never comes back
    lost.forEach((fn) => fn())
  })
  canvas.addEventListener('webglcontextrestored', () => restored.forEach((fn) => fn()))

  return {
    gl,
    onLost: (fn: () => void) => lost.push(fn),
    onRestored: (fn: () => void) => restored.push(fn),
  }
}
