// One WebGL2 line layer for every spaghetti panel. A series holds every
// realization of one iteration of one site, observation-major: the value of
// realization r at the site's t-th time is values[t * nReal + r]. Each
// realization is one run of indices into that array, and every run is drawn
// by a single drawElements(LINE_STRIP) call, with primitive restart
// (0xFFFFFFFF) between runs. Pan and zoom change uniforms only; the series
// is uploaded once and kept in JS so a restored context can upload it again.

export const RESTART_INDEX = 0xffffffff

// Same width as the mesh layer's value texture, so a long array wraps to rows.
const TEX_WIDTH = 2048

export interface LineSeries {
  values: Float32Array
  count: number
  nReal: number
  /** `count` x offsets, already shifted by the caller to the axis origin. */
  x: Float32Array
}

export interface LinePanel {
  /** Device pixels, y from the bottom. */
  viewport: [number, number, number, number]
  xDomain: [number, number]
  yDomain: [number, number]
  strips: Array<{ key: string; rgba: [number, number, number, number] }>
}

const VERTEX = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
in float a_value;
uniform sampler2D u_x;
uniform int u_nReal;
uniform vec2 u_xDomain;
uniform vec2 u_yDomain;

void main() {
  int t = gl_VertexID / u_nReal;
  float x = texelFetch(u_x, ivec2(t % ${TEX_WIDTH}, t / ${TEX_WIDTH}), 0).r;
  vec2 span = max(vec2(u_xDomain.y - u_xDomain.x, u_yDomain.y - u_yDomain.x), vec2(1e-20));
  vec2 ndc = vec2((x - u_xDomain.x) / span.x, (a_value - u_yDomain.x) / span.y) * 2.0 - 1.0;
  gl_Position = vec4(ndc, 0.0, 1.0);
}`

const FRAGMENT = `#version 300 es
precision highp float;
uniform vec4 u_rgba;
out vec4 fragColor;

void main() {
  fragColor = u_rgba;
}`

function compile(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader {
  const shader = gl.createShader(type)
  if (!shader) {
    throw new Error('the graphics context could not create a shader')
  }
  gl.shaderSource(shader, source)
  gl.compileShader(shader)
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    throw new Error(`shader failed to compile: ${gl.getShaderInfoLog(shader)}`)
  }
  return shader
}

/** The index run for one series. A non-finite value is left out and the line
 *  restarts there, so it is never joined across the gap. */
export function buildStripIndices(
  values: Float32Array,
  count: number,
  nReal: number,
): { indices: Uint32Array; nonFinite: number } {
  let size = 0
  let nonFinite = 0
  // First pass sizes the array; a 3.65 M entry run must not go through a JS array.
  for (let r = 0; r < nReal; r++) {
    let open = false
    for (let t = 0; t < count; t++) {
      if (Number.isFinite(values[t * nReal + r])) {
        size++
        open = true
      } else {
        nonFinite++
        if (open) {
          size++
          open = false
        }
      }
    }
    if (open) size++
  }

  const indices = new Uint32Array(size)
  let k = 0
  for (let r = 0; r < nReal; r++) {
    let open = false
    for (let t = 0; t < count; t++) {
      const i = t * nReal + r
      if (Number.isFinite(values[i])) {
        indices[k++] = i
        open = true
      } else if (open) {
        indices[k++] = RESTART_INDEX
        open = false
      }
    }
    if (open) indices[k++] = RESTART_INDEX
  }
  return { indices, nonFinite }
}

interface Held {
  series: LineSeries
  indices: Uint32Array
  nonFinite: number
  vao: WebGLVertexArrayObject | null
  valueBuffer: WebGLBuffer | null
  indexBuffer: WebGLBuffer | null
  xTex: WebGLTexture | null
}

export class LineLayer {
  private gl: WebGL2RenderingContext
  private program: WebGLProgram | null = null
  private held = new Map<string, Held>()

  constructor(gl: WebGL2RenderingContext) {
    this.gl = gl
    this.buildProgram()
  }

  private buildProgram(): void {
    const { gl } = this
    const program = gl.createProgram()!
    gl.attachShader(program, compile(gl, gl.VERTEX_SHADER, VERTEX))
    gl.attachShader(program, compile(gl, gl.FRAGMENT_SHADER, FRAGMENT))
    gl.linkProgram(program)
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      throw new Error(`line program failed to link: ${gl.getProgramInfoLog(program)}`)
    }
    this.program = program
  }

  /** Keeps `series` in JS and uploads it. Returns how many values were left
   *  out of the line because they are not finite. */
  setSeries(key: string, series: LineSeries): { nonFinite: number } {
    if (series.values.length !== series.count * series.nReal) {
      throw new Error(
        `series "${key}" holds ${series.values.length} values, not ${series.count} times x ${series.nReal} realizations`,
      )
    }
    if (series.x.length !== series.count) {
      throw new Error(`series "${key}" has ${series.x.length} x offsets for ${series.count} times`)
    }
    this.removeSeries(key)
    const { indices, nonFinite } = buildStripIndices(series.values, series.count, series.nReal)
    const held: Held = {
      series,
      indices,
      nonFinite,
      vao: null,
      valueBuffer: null,
      indexBuffer: null,
      xTex: null,
    }
    this.held.set(key, held)
    this.upload(held)
    return { nonFinite }
  }

  private upload(held: Held): void {
    const { gl, program } = this
    const { series, indices } = held

    held.vao = gl.createVertexArray()!
    gl.bindVertexArray(held.vao)

    held.valueBuffer = gl.createBuffer()!
    gl.bindBuffer(gl.ARRAY_BUFFER, held.valueBuffer)
    gl.bufferData(gl.ARRAY_BUFFER, series.values, gl.STATIC_DRAW)
    const loc = gl.getAttribLocation(program!, 'a_value')
    gl.enableVertexAttribArray(loc)
    gl.vertexAttribPointer(loc, 1, gl.FLOAT, false, 0, 0)

    held.indexBuffer = gl.createBuffer()!
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, held.indexBuffer)
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indices, gl.STATIC_DRAW)
    gl.bindVertexArray(null)

    const rows = Math.max(1, Math.ceil(series.count / TEX_WIDTH))
    const padded = new Float32Array(TEX_WIDTH * rows)
    padded.set(series.x)
    held.xTex = gl.createTexture()!
    gl.bindTexture(gl.TEXTURE_2D, held.xTex)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32F, TEX_WIDTH, rows, 0, gl.RED, gl.FLOAT, padded)
    // NEAREST: linear filtering of float textures is not guaranteed, and would blend two times.
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
  }

  removeSeries(key: string): void {
    const held = this.held.get(key)
    if (!held) return
    this.free(held)
    this.held.delete(key)
  }

  private free(held: Held): void {
    const { gl } = this
    if (held.vao) gl.deleteVertexArray(held.vao)
    if (held.valueBuffer) gl.deleteBuffer(held.valueBuffer)
    if (held.indexBuffer) gl.deleteBuffer(held.indexBuffer)
    if (held.xTex) gl.deleteTexture(held.xTex)
    held.vao = held.valueBuffer = held.indexBuffer = held.xTex = null
  }

  draw(panels: LinePanel[]): void {
    if (panels.length === 0) return
    const { gl, program } = this
    gl.useProgram(program)
    gl.activeTexture(gl.TEXTURE0)
    gl.uniform1i(gl.getUniformLocation(program!, 'u_x'), 0)

    const wasBlending = gl.isEnabled(gl.BLEND)
    gl.enable(gl.BLEND)
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA)
    gl.enable(gl.SCISSOR_TEST)

    for (const panel of panels) {
      const [vx, vy, vw, vh] = panel.viewport
      gl.viewport(vx, vy, vw, vh)
      gl.scissor(vx, vy, vw, vh)
      gl.uniform2f(gl.getUniformLocation(program!, 'u_xDomain'), panel.xDomain[0], panel.xDomain[1])
      gl.uniform2f(gl.getUniformLocation(program!, 'u_yDomain'), panel.yDomain[0], panel.yDomain[1])
      for (const strip of panel.strips) {
        const held = this.held.get(strip.key)
        if (!held || held.indices.length === 0) continue
        gl.bindVertexArray(held.vao)
        gl.bindTexture(gl.TEXTURE_2D, held.xTex)
        gl.uniform1i(gl.getUniformLocation(program!, 'u_nReal'), held.series.nReal)
        gl.uniform4f(gl.getUniformLocation(program!, 'u_rgba'), ...strip.rgba)
        gl.drawElements(gl.LINE_STRIP, held.indices.length, gl.UNSIGNED_INT, 0)
      }
    }

    gl.bindVertexArray(null)
    gl.disable(gl.SCISSOR_TEST)
    if (!wasBlending) gl.disable(gl.BLEND)
  }

  /** Rebuilds every GL object from the copies kept in JS, for a restored
   *  context. Nothing is fetched again. */
  reupload(): void {
    this.buildProgram()
    for (const held of this.held.values()) {
      // The old objects died with the lost context; recreate, do not delete.
      held.vao = held.valueBuffer = held.indexBuffer = held.xTex = null
      this.upload(held)
    }
  }

  dispose(): void {
    const { gl } = this
    for (const held of this.held.values()) this.free(held)
    this.held.clear()
    if (this.program) gl.deleteProgram(this.program)
    this.program = null
  }
}
