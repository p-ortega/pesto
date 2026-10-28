// One image drawn as a quad under the mesh, placed by four numbers in model
// coordinates and shown in grey unless the caller asks for its colours.

const VERTEX = `#version 300 es
in vec2 a_pos;
in vec2 a_uv;
uniform mat3 u_matrix;
out vec2 v_uv;

void main() {
  v_uv = a_uv;
  gl_Position = vec4((u_matrix * vec3(a_pos, 1.0)).xy, 0.0, 1.0);
}`

const FRAGMENT = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_image;
uniform float u_saturation;
out vec4 fragColor;

void main() {
  vec4 colour = texture(u_image, v_uv);
  float luminance = dot(colour.rgb, vec3(0.2126, 0.7152, 0.0722));
  fragColor = vec4(mix(vec3(luminance), colour.rgb, u_saturation), colour.a);
}`

// Units 0 to 2 belong to the mesh layer's values, ramp and hatch.
const UNIT = 3

// Top-left, top-right, bottom-left, bottom-right: the bitmap's first row is the image's top row.
const UVS = new Float32Array([0, 0, 1, 0, 0, 1, 1, 1])

type Extent = [number, number, number, number]
type Origin = [number, number]

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

function placementProblem(extent: Extent | null, origin: Origin): string | null {
  if (extent === null) return 'the image has no placement'
  if (!extent.every(Number.isFinite)) return 'the image placement is not finite'
  if (!(extent[0] < extent[1]) || !(extent[2] < extent[3])) return 'the image placement has no area'
  if (!origin.every(Number.isFinite)) return 'the mesh origin is not finite'
  return null
}

export class BasemapLayer {
  private readonly gl: WebGL2RenderingContext
  private program!: WebGLProgram
  private vao!: WebGLVertexArrayObject
  private positionsBuffer!: WebGLBuffer
  private uvBuffer!: WebGLBuffer
  private texture!: WebGLTexture

  private bitmap: ImageBitmap | null = null
  private positions: Float32Array | null = null
  private saturation = 0
  private disposed = false
  private matrix: Float32Array<ArrayBufferLike> = new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1])

  constructor(gl: WebGL2RenderingContext) {
    this.gl = gl
    this.build()
  }

  /** The largest width or height a texture may have on this card, or 0 when the card does not say. */
  static maxTextureSize(gl: WebGL2RenderingContext): number {
    const size: unknown = gl.getParameter(gl.MAX_TEXTURE_SIZE)
    return typeof size === 'number' && Number.isFinite(size) && size > 0 ? size : 0
  }

  /** Returns a refusal reason, or null when the image is drawn (or cleared, for a null bitmap).
   *  A refusal also drops any image held before, so nothing stale is drawn. */
  setImage(bitmap: ImageBitmap | null, extent: Extent | null, origin: Origin): string | null {
    this.bitmap = null
    this.positions = null
    if (this.disposed) return 'the basemap layer has been removed'
    if (bitmap === null) return null

    if (!(bitmap.width > 0) || !(bitmap.height > 0)) return 'the image has no pixels'
    const max = BasemapLayer.maxTextureSize(this.gl)
    if (max === 0) return 'the graphics card did not report its largest texture size'
    if (bitmap.width > max || bitmap.height > max) {
      return `the image is ${bitmap.width} × ${bitmap.height} pixels; this graphics card holds at most ${max} pixels per side`
    }
    const problem = placementProblem(extent, origin)
    if (problem !== null) return problem

    const [x0, x1, y0, y1] = extent as Extent
    const [ox, oy] = origin
    // Subtract in float64 first: at northings near 7e6 float32 cannot hold a quarter metre.
    const left = x0 - ox
    const right = x1 - ox
    const bottom = y0 - oy
    const top = y1 - oy
    this.positions = new Float32Array([left, top, right, top, left, bottom, right, bottom])
    this.bitmap = bitmap
    this.upload()
    return null
  }

  setSaturation(s: number): void {
    this.saturation = Number.isFinite(s) ? Math.min(1, Math.max(0, s)) : 0
  }

  setMatrix(matrix: Float32Array): void {
    this.matrix = matrix
  }

  hasImage(): boolean {
    return this.bitmap !== null
  }

  draw(): void {
    if (this.disposed || this.bitmap === null) return
    const { gl, program } = this
    gl.useProgram(program)
    gl.bindVertexArray(this.vao)
    gl.activeTexture(gl.TEXTURE3)
    gl.bindTexture(gl.TEXTURE_2D, this.texture)
    gl.uniform1i(gl.getUniformLocation(program, 'u_image'), UNIT)
    gl.uniform1f(gl.getUniformLocation(program, 'u_saturation'), this.saturation)
    gl.uniformMatrix3fv(gl.getUniformLocation(program, 'u_matrix'), false, this.matrix)
    // Blend colour only; alpha stays 1 so a transparent image never makes the canvas see-through.
    const wasBlending = gl.isEnabled(gl.BLEND)
    gl.enable(gl.BLEND)
    gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA)
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
    if (!wasBlending) gl.disable(gl.BLEND)
    gl.activeTexture(gl.TEXTURE0)
    gl.bindVertexArray(null)
  }

  /** Rebuilds every GL object from the image and state this layer holds, after a lost and restored context. */
  reupload(): void {
    if (this.disposed) return
    this.build()
  }

  dispose(): void {
    if (this.disposed) return
    const { gl } = this
    gl.deleteProgram(this.program)
    gl.deleteVertexArray(this.vao)
    gl.deleteBuffer(this.positionsBuffer)
    gl.deleteBuffer(this.uvBuffer)
    gl.deleteTexture(this.texture)
    this.disposed = true
    this.bitmap = null
    this.positions = null
  }

  private build(): void {
    const { gl } = this

    this.program = gl.createProgram()!
    gl.attachShader(this.program, compile(gl, gl.VERTEX_SHADER, VERTEX))
    gl.attachShader(this.program, compile(gl, gl.FRAGMENT_SHADER, FRAGMENT))
    gl.linkProgram(this.program)
    if (!gl.getProgramParameter(this.program, gl.LINK_STATUS)) {
      throw new Error(`basemap program failed to link: ${gl.getProgramInfoLog(this.program)}`)
    }

    this.vao = gl.createVertexArray()!
    gl.bindVertexArray(this.vao)

    this.positionsBuffer = gl.createBuffer()!
    gl.bindBuffer(gl.ARRAY_BUFFER, this.positionsBuffer)
    const posLoc = gl.getAttribLocation(this.program, 'a_pos')
    gl.enableVertexAttribArray(posLoc)
    gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, 0, 0)

    this.uvBuffer = gl.createBuffer()!
    gl.bindBuffer(gl.ARRAY_BUFFER, this.uvBuffer)
    gl.bufferData(gl.ARRAY_BUFFER, UVS, gl.STATIC_DRAW)
    const uvLoc = gl.getAttribLocation(this.program, 'a_uv')
    gl.enableVertexAttribArray(uvLoc)
    gl.vertexAttribPointer(uvLoc, 2, gl.FLOAT, false, 0, 0)
    gl.bindVertexArray(null)

    this.texture = gl.createTexture()!
    if (this.bitmap !== null) this.upload()
  }

  private upload(): void {
    const { gl, bitmap, positions } = this
    if (bitmap === null || positions === null) return

    gl.bindBuffer(gl.ARRAY_BUFFER, this.positionsBuffer)
    gl.bufferData(gl.ARRAY_BUFFER, positions, gl.STATIC_DRAW)

    gl.activeTexture(gl.TEXTURE3)
    gl.bindTexture(gl.TEXTURE_2D, this.texture)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, bitmap)
    gl.generateMipmap(gl.TEXTURE_2D)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    // The mesh layer binds its value texture without choosing a unit, so leave unit 0 active.
    gl.activeTexture(gl.TEXTURE0)
  }
}
