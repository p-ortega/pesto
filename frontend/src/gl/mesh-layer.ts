// GPU buffer upload, the value texture, the ramp texture, the absence
// outline pass and the draw call. Cell values live in a texture and each
// vertex carries its cell number, so changing layer, realization or
// statistic later costs one texture upload of n_cells floats rather than a
// geometry rebuild.

import { ramp, type ColormapName } from './colormap'

const VERTEX = `#version 300 es
in vec2 a_pos;
in float a_cell;
uniform mat3 u_matrix;
uniform sampler2D u_values;
uniform vec2 u_texSize;
uniform vec2 u_limits;
flat out float v_norm;
flat out float v_missing;

void main() {
  float cell = a_cell;
  float x = mod(cell, u_texSize.x);
  float y = floor(cell / u_texSize.x);
  float value = texelFetch(u_values, ivec2(int(x), int(y)), 0).r;

  // A cell with no value is uploaded as NaN (setValues), never a finite
  // number -- but "value != value" only ever catches NaN. On some GPU
  // drivers an infinity slips past that test and then clamp() pins it to a
  // ramp end, drawing it as if it were data (WINDOWS.md #6). isnan/isinf
  // are the spec-guaranteed way to reject both.
  v_missing = (isnan(value) || isinf(value)) ? 1.0 : 0.0;
  v_norm = clamp((value - u_limits.x) / max(u_limits.y - u_limits.x, 1e-20), 0.0, 1.0);

  gl_Position = vec4((u_matrix * vec3(a_pos, 1.0)).xy, 0.0, 1.0);
}`

const FRAGMENT = `#version 300 es
precision highp float;
flat in float v_norm;
flat in float v_missing;
uniform sampler2D u_ramp;
out vec4 fragColor;

void main() {
  if (v_missing > 0.5) discard;   // inactive or unparameterised cells
  fragColor = texture(u_ramp, vec2(v_norm, 0.5));
}`

// The outline pass draws only the ring edges belonging to cells marked
// inactive by setInactive -- never a fill. The colour is a uniform the
// caller sets from a resolved token; no colour value is written here.
const OUTLINE_VERTEX = `#version 300 es
in vec2 a_pos;
uniform mat3 u_matrix;

void main() {
  gl_Position = vec4((u_matrix * vec3(a_pos, 1.0)).xy, 0.0, 1.0);
}`

const OUTLINE_FRAGMENT = `#version 300 es
precision highp float;
uniform vec3 u_color;
out vec4 fragColor;

void main() {
  fragColor = vec4(u_color, 1.0);
}`

// D-06's contested mark: a fine diagonal stripe at 22.5 degrees over a
// neutral fill, in screen space so the stripe period stays constant on
// screen whatever the zoom. 22.5 is deliberate -- 45 and 135 are reserved
// for the at-bounds and prior-data-conflict overlays that arrive later, so
// reusing either here would collide with them.
const CONTESTED_VERTEX = `#version 300 es
in vec2 a_pos;
uniform mat3 u_matrix;

void main() {
  gl_Position = vec4((u_matrix * vec3(a_pos, 1.0)).xy, 0.0, 1.0);
}`

const CONTESTED_FRAGMENT = `#version 300 es
precision highp float;
uniform vec3 u_stripeColor;
uniform vec3 u_fillColor;
out vec4 fragColor;

void main() {
  float angle = radians(22.5);
  float period = 6.0;
  float d = gl_FragCoord.x * cos(angle) + gl_FragCoord.y * sin(angle);
  float inStripe = step(mod(d, period), period * 0.35);
  fragColor = vec4(mix(u_fillColor, u_stripeColor, inStripe), 1.0);
}`

export interface MeshData {
  positions: Float32Array
  cellIndex: Float32Array
  indices: Uint32Array
  nCells: number
}

const TEX_WIDTH = 2048

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

// Consecutive vertices sharing the same cell index are exactly one cell's
// polygon ring, in ring order -- `fan_polygons` on the server writes every
// cell's vertices as one unshared, contiguous run (never interleaved
// between cells) precisely so this holds. Returns, per cell, the vertex
// range `[start, count)` that ring occupies.
function ringsByCell(cellIndex: Float32Array, nCells: number): Array<[number, number] | null> {
  const rings: Array<[number, number] | null> = new Array(nCells).fill(null)
  let i = 0
  while (i < cellIndex.length) {
    const cell = cellIndex[i]
    let count = 0
    while (i + count < cellIndex.length && cellIndex[i + count] === cell) {
      count += 1
    }
    if (cell >= 0 && cell < nCells) {
      rings[cell] = [i, count]
    }
    i += count
  }
  return rings
}

export class MeshLayer {
  private gl: WebGL2RenderingContext
  private mesh: MeshData
  private texHeight: number
  private staging: Float32Array<ArrayBuffer>
  private rings: Array<[number, number] | null>

  private program!: WebGLProgram
  private vao!: WebGLVertexArrayObject
  private positionsBuffer!: WebGLBuffer
  private cellBuffer!: WebGLBuffer
  private elementsBuffer!: WebGLBuffer
  private valuesTex!: WebGLTexture
  private rampTex!: WebGLTexture

  private outlineProgram!: WebGLProgram
  private outlineVao!: WebGLVertexArrayObject
  private outlineElements!: WebGLBuffer
  private outlineCount = 0

  private contestedProgram!: WebGLProgram
  private contestedVao!: WebGLVertexArrayObject
  private contestedElements!: WebGLBuffer
  private contestedCount = 0

  private selectionVao!: WebGLVertexArrayObject
  private selectionElements!: WebGLBuffer
  private selectionCount = 0

  private limits: [number, number] = [0, 1]
  private matrix: Float32Array<ArrayBufferLike> = new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1])
  private colormapName: ColormapName = 'viridis'
  private colormapReverse = false
  private lastValues: Float32Array | null = null
  private inactiveMask: Uint8Array | null = null
  private hairlineColor: [number, number, number] = [0, 0, 0]
  private contestedMask: Uint8Array | null = null
  private stripeColor: [number, number, number] = [0, 0, 0]
  private contestedFillColor: [number, number, number] = [0, 0, 0]
  private selectedCell: number | null = null
  private accentColor: [number, number, number] = [0, 0, 0]

  constructor(gl: WebGL2RenderingContext, mesh: MeshData) {
    this.gl = gl
    this.mesh = mesh
    this.texHeight = Math.max(1, Math.ceil(mesh.nCells / TEX_WIDTH))
    this.staging = new Float32Array(TEX_WIDTH * this.texHeight).fill(Number.NaN)
    this.rings = ringsByCell(mesh.cellIndex, mesh.nCells)
    this.build()
  }

  private build(): void {
    const { gl, mesh } = this

    this.program = gl.createProgram()!
    gl.attachShader(this.program, compile(gl, gl.VERTEX_SHADER, VERTEX))
    gl.attachShader(this.program, compile(gl, gl.FRAGMENT_SHADER, FRAGMENT))
    gl.linkProgram(this.program)
    if (!gl.getProgramParameter(this.program, gl.LINK_STATUS)) {
      throw new Error(`program failed to link: ${gl.getProgramInfoLog(this.program)}`)
    }

    this.vao = gl.createVertexArray()!
    gl.bindVertexArray(this.vao)

    this.positionsBuffer = gl.createBuffer()!
    gl.bindBuffer(gl.ARRAY_BUFFER, this.positionsBuffer)
    gl.bufferData(gl.ARRAY_BUFFER, mesh.positions, gl.STATIC_DRAW)
    const posLoc = gl.getAttribLocation(this.program, 'a_pos')
    gl.enableVertexAttribArray(posLoc)
    gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, 0, 0)

    this.cellBuffer = gl.createBuffer()!
    gl.bindBuffer(gl.ARRAY_BUFFER, this.cellBuffer)
    gl.bufferData(gl.ARRAY_BUFFER, mesh.cellIndex, gl.STATIC_DRAW)
    const cellLoc = gl.getAttribLocation(this.program, 'a_cell')
    gl.enableVertexAttribArray(cellLoc)
    gl.vertexAttribPointer(cellLoc, 1, gl.FLOAT, false, 0, 0)

    this.elementsBuffer = gl.createBuffer()!
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.elementsBuffer)
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, mesh.indices, gl.STATIC_DRAW)
    gl.bindVertexArray(null)

    this.outlineProgram = gl.createProgram()!
    gl.attachShader(this.outlineProgram, compile(gl, gl.VERTEX_SHADER, OUTLINE_VERTEX))
    gl.attachShader(this.outlineProgram, compile(gl, gl.FRAGMENT_SHADER, OUTLINE_FRAGMENT))
    gl.linkProgram(this.outlineProgram)
    if (!gl.getProgramParameter(this.outlineProgram, gl.LINK_STATUS)) {
      throw new Error(`outline program failed to link: ${gl.getProgramInfoLog(this.outlineProgram)}`)
    }

    this.outlineVao = gl.createVertexArray()!
    gl.bindVertexArray(this.outlineVao)
    gl.bindBuffer(gl.ARRAY_BUFFER, this.positionsBuffer)
    const outlinePosLoc = gl.getAttribLocation(this.outlineProgram, 'a_pos')
    gl.enableVertexAttribArray(outlinePosLoc)
    gl.vertexAttribPointer(outlinePosLoc, 2, gl.FLOAT, false, 0, 0)
    this.outlineElements = gl.createBuffer()!
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.outlineElements)
    gl.bindVertexArray(null)

    this.contestedProgram = gl.createProgram()!
    gl.attachShader(this.contestedProgram, compile(gl, gl.VERTEX_SHADER, CONTESTED_VERTEX))
    gl.attachShader(this.contestedProgram, compile(gl, gl.FRAGMENT_SHADER, CONTESTED_FRAGMENT))
    gl.linkProgram(this.contestedProgram)
    if (!gl.getProgramParameter(this.contestedProgram, gl.LINK_STATUS)) {
      throw new Error(`contested program failed to link: ${gl.getProgramInfoLog(this.contestedProgram)}`)
    }

    this.contestedVao = gl.createVertexArray()!
    gl.bindVertexArray(this.contestedVao)
    gl.bindBuffer(gl.ARRAY_BUFFER, this.positionsBuffer)
    const contestedPosLoc = gl.getAttribLocation(this.contestedProgram, 'a_pos')
    gl.enableVertexAttribArray(contestedPosLoc)
    gl.vertexAttribPointer(contestedPosLoc, 2, gl.FLOAT, false, 0, 0)
    this.contestedElements = gl.createBuffer()!
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.contestedElements)
    gl.bindVertexArray(null)

    // The ring pass shares the outline program (position in, one flat
    // colour out) with its own VAO and index buffer, so a selection never
    // needs a third shader.
    this.selectionVao = gl.createVertexArray()!
    gl.bindVertexArray(this.selectionVao)
    gl.bindBuffer(gl.ARRAY_BUFFER, this.positionsBuffer)
    const selectionPosLoc = gl.getAttribLocation(this.outlineProgram, 'a_pos')
    gl.enableVertexAttribArray(selectionPosLoc)
    gl.vertexAttribPointer(selectionPosLoc, 2, gl.FLOAT, false, 0, 0)
    this.selectionElements = gl.createBuffer()!
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.selectionElements)
    gl.bindVertexArray(null)

    this.valuesTex = gl.createTexture()!
    gl.bindTexture(gl.TEXTURE_2D, this.valuesTex)
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.R32F, TEX_WIDTH, this.texHeight)
    // Never gl.LINEAR here: WebGL2 does not guarantee linear filtering of
    // 32-bit float textures, and interpolating between two cells' values
    // would invent a value neither of them has.
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)

    this.rampTex = gl.createTexture()!
    this.setColormap(this.colormapName, this.colormapReverse)

    if (this.inactiveMask) this.setInactive(this.inactiveMask)
    if (this.contestedMask) this.setContested(this.contestedMask)
    if (this.selectedCell !== null) this.setSelected(this.selectedCell)
    if (this.lastValues) this.setValues(this.lastValues)
  }

  /** Uploads `values` to the value texture, forcing every contested cell
   *  to NaN regardless of what the caller passed for it -- T-5.1-15: no
   *  drawn colour may ever misattribute one parameter's value to another,
   *  so this invariant is enforced here rather than trusted to every
   *  caller. */
  setValues(values: Float32Array): void {
    this.lastValues = values
    const { gl } = this
    this.staging.fill(Number.NaN)
    const count = Math.min(values.length, this.mesh.nCells)
    for (let i = 0; i < count; i++) {
      this.staging[i] = values[i]
    }
    if (this.contestedMask) {
      for (let c = 0; c < this.contestedMask.length; c++) {
        if (this.contestedMask[c]) this.staging[c] = Number.NaN
      }
    }
    gl.bindTexture(gl.TEXTURE_2D, this.valuesTex)
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, TEX_WIDTH, this.texHeight, gl.RED, gl.FLOAT, this.staging)
  }

  setLimits(limits: [number, number]): void {
    this.limits = limits
  }

  /** `reverse` mirrors the 256-entry table before upload -- MAP-03's
   *  reverse switch, applying to whichever ramp is chosen. */
  setColormap(name: ColormapName, reverse = false): void {
    this.colormapName = name
    this.colormapReverse = reverse
    const { gl } = this
    gl.bindTexture(gl.TEXTURE_2D, this.rampTex)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 256, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, ramp(name, reverse))
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
  }

  setMatrix(matrix: Float32Array): void {
    this.matrix = matrix
  }

  /** `mask[cell]` true means that grid cell is outside the model -- never
   *  placed in any group's map block, at any layer. The view decides this
   *  from the block-order cell array; this layer only draws whatever it is
   *  told. Rebuilds the outline pass's line-list index buffer from the
   *  cell rings computed at construction. */
  setInactive(mask: Uint8Array): void {
    this.inactiveMask = mask
    const { gl } = this
    const edges: number[] = []
    for (let cell = 0; cell < mask.length; cell++) {
      if (!mask[cell]) continue
      const ring = this.rings[cell]
      if (!ring) continue
      const [start, count] = ring
      for (let i = 0; i < count; i++) {
        edges.push(start + i, start + ((i + 1) % count))
      }
    }
    this.outlineCount = edges.length
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.outlineElements)
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint32Array(edges), gl.DYNAMIC_DRAW)
  }

  /** Read the same way the canvas clear colour is read -- from a resolved
   *  token, converted to floats by the caller. No colour value is written
   *  in this file. */
  setHairlineColor(rgb: [number, number, number]): void {
    this.hairlineColor = rgb
  }

  /** `mask[cell]` true means that cell carries two or more block rows of
   *  the drawn group at the drawn layer (D-06) -- the view decides this
   *  from `classifyCells`, this layer only draws whatever it is told.
   *  Rebuilds the contested pass's triangle index buffer from whichever
   *  triangles `mesh.cellIndex` says belong to a contested cell, and
   *  re-applies the NaN-forcing invariant to whatever field is already
   *  uploaded. */
  setContested(mask: Uint8Array): void {
    this.contestedMask = mask
    const { gl, mesh } = this
    const triangles: number[] = []
    for (let t = 0; t < mesh.indices.length; t += 3) {
      const a = mesh.indices[t]
      const cell = mesh.cellIndex[a]
      if (cell >= 0 && cell < mask.length && mask[cell]) {
        triangles.push(mesh.indices[t], mesh.indices[t + 1], mesh.indices[t + 2])
      }
    }
    this.contestedCount = triangles.length
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.contestedElements)
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint32Array(triangles), gl.DYNAMIC_DRAW)
    if (this.lastValues) this.setValues(this.lastValues)
  }

  /** The stripe colour (`--ink-primary`) and the neutral fill it sits
   *  over, both resolved tokens read exactly like the hairline colour. */
  setContestedColors(stripe: [number, number, number], fill: [number, number, number]): void {
    this.stripeColor = stripe
    this.contestedFillColor = fill
  }

  /** Which cell carries the selection ring, over whatever of the four
   *  marks that cell already has -- `null` removes it. Rebuilds the ring
   *  pass's line-list index buffer from that one cell's ring, the same way
   *  `setInactive` builds the hairline's. */
  setSelected(cellId: number | null): void {
    this.selectedCell = cellId
    const { gl } = this
    const edges: number[] = []
    const ring = cellId !== null ? this.rings[cellId] : null
    if (ring) {
      const [start, count] = ring
      for (let i = 0; i < count; i++) {
        edges.push(start + i, start + ((i + 1) % count))
      }
    }
    this.selectionCount = edges.length
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.selectionElements)
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint32Array(edges), gl.DYNAMIC_DRAW)
  }

  /** `--accent`, resolved the same way as the hairline and stripe colours. */
  setAccentColor(rgb: [number, number, number]): void {
    this.accentColor = rgb
  }

  private drawOutline(): void {
    if (this.outlineCount === 0) return
    const { gl } = this
    gl.useProgram(this.outlineProgram)
    gl.bindVertexArray(this.outlineVao)
    gl.uniformMatrix3fv(gl.getUniformLocation(this.outlineProgram, 'u_matrix'), false, this.matrix)
    gl.uniform3f(
      gl.getUniformLocation(this.outlineProgram, 'u_color'),
      this.hairlineColor[0],
      this.hairlineColor[1],
      this.hairlineColor[2],
    )
    gl.drawElements(gl.LINES, this.outlineCount, gl.UNSIGNED_INT, 0)
    gl.bindVertexArray(null)
  }

  private drawFill(): void {
    const { gl } = this
    gl.useProgram(this.program)
    gl.bindVertexArray(this.vao)

    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, this.valuesTex)
    gl.uniform1i(gl.getUniformLocation(this.program, 'u_values'), 0)
    gl.activeTexture(gl.TEXTURE1)
    gl.bindTexture(gl.TEXTURE_2D, this.rampTex)
    gl.uniform1i(gl.getUniformLocation(this.program, 'u_ramp'), 1)

    gl.uniformMatrix3fv(gl.getUniformLocation(this.program, 'u_matrix'), false, this.matrix)
    gl.uniform2f(gl.getUniformLocation(this.program, 'u_texSize'), TEX_WIDTH, this.texHeight)
    gl.uniform2f(gl.getUniformLocation(this.program, 'u_limits'), this.limits[0], this.limits[1])

    gl.drawElements(gl.TRIANGLES, this.mesh.indices.length, gl.UNSIGNED_INT, 0)
    gl.bindVertexArray(null)
  }

  private drawContested(): void {
    if (this.contestedCount === 0) return
    const { gl } = this
    gl.useProgram(this.contestedProgram)
    gl.bindVertexArray(this.contestedVao)
    gl.uniformMatrix3fv(gl.getUniformLocation(this.contestedProgram, 'u_matrix'), false, this.matrix)
    gl.uniform3f(
      gl.getUniformLocation(this.contestedProgram, 'u_stripeColor'),
      this.stripeColor[0],
      this.stripeColor[1],
      this.stripeColor[2],
    )
    gl.uniform3f(
      gl.getUniformLocation(this.contestedProgram, 'u_fillColor'),
      this.contestedFillColor[0],
      this.contestedFillColor[1],
      this.contestedFillColor[2],
    )
    gl.drawElements(gl.TRIANGLES, this.contestedCount, gl.UNSIGNED_INT, 0)
    gl.bindVertexArray(null)
  }

  private drawSelection(): void {
    if (this.selectionCount === 0) return
    const { gl } = this
    gl.useProgram(this.outlineProgram)
    gl.bindVertexArray(this.selectionVao)
    gl.uniformMatrix3fv(gl.getUniformLocation(this.outlineProgram, 'u_matrix'), false, this.matrix)
    gl.uniform3f(
      gl.getUniformLocation(this.outlineProgram, 'u_color'),
      this.accentColor[0],
      this.accentColor[1],
      this.accentColor[2],
    )
    gl.drawElements(gl.LINES, this.selectionCount, gl.UNSIGNED_INT, 0)
    gl.bindVertexArray(null)
  }

  /** Outline, stripe, value, ring -- the contract's own draw order
   *  (D-06/MAP-07). Outline first so a coloured cell never has a stroke
   *  drawn over it; the stripe before the value pass since a contested
   *  cell's value is always NaN and so never overwrites it; the ring last
   *  so it sits over whichever of the first three marks the selected cell
   *  carries. */
  draw(): void {
    this.drawOutline()
    this.drawContested()
    this.drawFill()
    this.drawSelection()
  }

  /** Rebuilds every GL object from the arrays and state this layer already
   *  holds -- what a lost-and-restored WebGL2 context calls (MAP-08/D-16),
   *  so recovery never needs a fresh network fetch of the mesh or field. */
  reupload(): void {
    this.build()
  }

  dispose(): void {
    const { gl } = this
    gl.deleteProgram(this.program)
    gl.deleteProgram(this.outlineProgram)
    gl.deleteProgram(this.contestedProgram)
    gl.deleteVertexArray(this.vao)
    gl.deleteVertexArray(this.outlineVao)
    gl.deleteVertexArray(this.contestedVao)
    gl.deleteVertexArray(this.selectionVao)
    gl.deleteBuffer(this.positionsBuffer)
    gl.deleteBuffer(this.cellBuffer)
    gl.deleteBuffer(this.elementsBuffer)
    gl.deleteBuffer(this.outlineElements)
    gl.deleteBuffer(this.contestedElements)
    gl.deleteBuffer(this.selectionElements)
    gl.deleteTexture(this.valuesTex)
    gl.deleteTexture(this.rampTex)
  }
}
