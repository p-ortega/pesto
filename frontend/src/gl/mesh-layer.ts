// GPU buffer upload, the value texture, the ramp texture, the absence
// outline pass and the draw call. Cell values live in a texture and each
// vertex carries its cell number, so changing layer, realization or
// statistic later costs one texture upload of n_cells floats rather than a
// geometry rebuild.

import { classOf, classTexelIndices, ramp, type ColormapName } from './colormap'
import { CONTINUOUS, type EffectiveStyle } from './field-style'
import { OUTLINE_MAX_CELLS, RING_EACH_MAX, outlineEdges } from './outline'

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
uniform float u_classes;          // 0 draws the smooth ramp
uniform float u_classTexel[11];   // the ramp entry of each class, from classTexelIndices
uniform float u_flat;             // 1 in texture mode: the hatch pass carries the classes
uniform vec3 u_surface;
uniform float u_alpha;            // the field opacity (D-25); 1 draws opaque with no blend
out vec4 fragColor;

void main() {
  if (v_missing > 0.5) discard;   // inactive or unparameterised cells
  if (u_flat > 0.5) {
    fragColor = vec4(u_surface, u_alpha);
    return;
  }
  float t = v_norm;
  if (u_classes > 0.5) {
    int k = int(min(floor(v_norm * u_classes), u_classes - 1.0));
    // The texel centre, so the LINEAR ramp gives exactly the entry the legend reads.
    t = (u_classTexel[k] + 0.5) / 256.0;
  }
  fragColor = vec4(texture(u_ramp, vec2(t, 0.5)).rgb, u_alpha);
}`

// The outline pass draws only the ring edges belonging to cells marked
// inactive by setInactive -- never a fill. The colour is a uniform the
// caller sets from a resolved token; no colour value is written here.
// u_color carries alpha because --hairline is authored at 10% opacity
// (WINDOWS.md #12).
const OUTLINE_VERTEX = `#version 300 es
in vec2 a_pos;
uniform mat3 u_matrix;

void main() {
  gl_Position = vec4((u_matrix * vec3(a_pos, 1.0)).xy, 0.0, 1.0);
}`

const OUTLINE_FRAGMENT = `#version 300 es
precision highp float;
uniform vec4 u_color;
out vec4 fragColor;

void main() {
  fragColor = u_color;
}`

// The selection ring is drawn as screen-space quads, one per cell edge,
// because WebGL2 only promises 1px lines. Each quad runs past both ends of
// its edge by the half width so corners close without a notch.
const RING_VERTEX = `#version 300 es
in vec2 a_a;
in vec2 a_b;
in vec2 a_corner;   // x: 0 at a, 1 at b; y: -1 or 1 across the edge
uniform mat3 u_matrix;
uniform vec2 u_viewport;
uniform float u_halfWidth;

void main() {
  vec2 pa = (u_matrix * vec3(a_a, 1.0)).xy * 0.5 * u_viewport;
  vec2 pb = (u_matrix * vec3(a_b, 1.0)).xy * 0.5 * u_viewport;
  vec2 d = pb - pa;
  d = length(d) > 0.0 ? normalize(d) : vec2(1.0, 0.0);
  vec2 n = vec2(-d.y, d.x);
  vec2 p = mix(pa, pb, a_corner.x) + (a_corner.x * 2.0 - 1.0) * d * u_halfWidth + n * a_corner.y * u_halfWidth;
  gl_Position = vec4(p / (0.5 * u_viewport), 0.0, 1.0);
}`

const RING_FRAGMENT = `#version 300 es
precision highp float;
uniform vec3 u_color;
out vec4 fragColor;

void main() {
  fragColor = vec4(u_color, 1.0);
}`

// D-06's contested mark: a fine diagonal stripe at 22.5 degrees over a
// neutral fill, in screen space so the stripe period stays constant on
// screen whatever the zoom. 22.5 is deliberate -- the hatch pass below
// draws the at-bounds and prior-data-conflict overlays at 45 and 135, so
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

// The hatch pass (D-21): one per-cell mask, bit 0 at bounds and bit 1
// prior-data conflict, each drawn as a family of screen-space lines over the
// fill. It reads its own texture, so the field's values and limits are never
// touched. The mask is stored as floats 0-3, the same proven R32F path as the
// value texture. In texture mode (D-12) the same pass reads the class mask
// instead, class + 1 per cell, and draws one line family per class.
const HATCH_VERTEX = `#version 300 es
in vec2 a_pos;
in float a_cell;
uniform mat3 u_matrix;
uniform sampler2D u_mask;
uniform vec2 u_texSize;
flat out float v_mask;

void main() {
  float x = mod(a_cell, u_texSize.x);
  float y = floor(a_cell / u_texSize.x);
  v_mask = texelFetch(u_mask, ivec2(int(x), int(y)), 0).r;
  gl_Position = vec4((u_matrix * vec3(a_pos, 1.0)).xy, 0.0, 1.0);
}`

// Each line is an ink band with a halo band either side, so it reads over
// the dark and the light end of every ramp. Widths are in device pixels.
const HATCH_FRAGMENT = `#version 300 es
precision highp float;
flat in float v_mask;
uniform float u_angle0;
uniform float u_angle1;
uniform float u_period;
uniform float u_inkHalf;
uniform float u_haloWidth;
uniform vec3 u_ink;
uniform vec3 u_halo;
uniform float u_mode;      // 0 the overlay bits, 1 the texture classes
uniform float u_classes;
out vec4 fragColor;

// Distance from this fragment to the nearest line running at angle a.
float lineDistance(float a) {
  float d = -gl_FragCoord.x * sin(a) + gl_FragCoord.y * cos(a);
  float m = mod(d, u_period);
  return min(m, u_period - m);
}

void main() {
  float dist = 1e9;
  if (u_mode > 0.5) {
    // Class 0 is the lowest, so the angle grows with magnitude over 0 to 180 degrees.
    int k = int(v_mask + 0.5) - 1;
    if (k < 0) discard;
    dist = lineDistance(float(k) * 3.14159265 / u_classes);
  } else {
    int bits = int(v_mask + 0.5);
    if (bits == 0) discard;
    if ((bits & 1) != 0) dist = min(dist, lineDistance(u_angle0));
    if ((bits & 2) != 0) dist = min(dist, lineDistance(u_angle1));
  }
  if (dist <= u_inkHalf) {
    fragColor = vec4(u_ink, 1.0);
  } else if (dist <= u_inkHalf + u_haloWidth) {
    fragColor = vec4(u_halo, 1.0);
  } else {
    discard;
  }
}`

// The points pass draws an x/y group as fixed-size dots, sized in device
// pixels so they stay the same on screen at any zoom. The ring keeps a dot
// readable on any fill. A NaN value is discarded, never drawn at a ramp end,
// unless u_missingStyle is 1: then it draws as a ring with no fill (absence).
// Each dot also carries a flag bit set: a hatch swatch inside the dot so an
// overlay still reads under it (D-25, D-29), and dimming (D-02).
const POINTS_VERTEX = `#version 300 es
in vec2 a_pos;
in float a_value;
in float a_flags;
uniform mat3 u_matrix;
uniform vec2 u_limits;
uniform float u_size;
flat out float v_norm;
flat out float v_missing;
flat out float v_flags;

void main() {
  v_flags = a_flags;
  v_missing = (isnan(a_value) || isinf(a_value)) ? 1.0 : 0.0;
  v_norm = clamp((a_value - u_limits.x) / max(u_limits.y - u_limits.x, 1e-20), 0.0, 1.0);
  gl_Position = vec4((u_matrix * vec3(a_pos, 1.0)).xy, 0.0, 1.0);
  gl_PointSize = u_size;
}`

const POINTS_FRAGMENT = `#version 300 es
precision highp float;
flat in float v_norm;
flat in float v_missing;
flat in float v_flags;
uniform sampler2D u_ramp;
uniform vec3 u_ringColor;
uniform float u_missingStyle;
uniform vec3 u_ink;
uniform float u_dimAlpha;
uniform float u_classes;          // the same steps as the fill (D-31)
uniform float u_classTexel[11];
out vec4 fragColor;

// One swatch line family across the dot; d is in point-coordinate units.
float swatch(float d) {
  float m = mod(d, 0.5);
  return step(min(m, 0.5 - m), 0.09);
}

void main() {
  bool missing = v_missing > 0.5;
  if (missing && u_missingStyle < 0.5) discard;
  vec2 d = gl_PointCoord - vec2(0.5);
  float r = length(d);
  if (r > 0.5) discard;
  if (missing && r <= 0.36) discard;
  float t = v_norm;
  if (u_classes > 0.5) {
    int k = int(min(floor(v_norm * u_classes), u_classes - 1.0));
    t = (u_classTexel[k] + 0.5) / 256.0;
  }
  vec4 color = r > 0.36 ? vec4(u_ringColor, 1.0) : texture(u_ramp, vec2(t, 0.5));
  // Bits as named in data/hatch-mask.ts: 1 at-bounds swatch, 2 conflict swatch, 4 dim.
  int flags = int(v_flags + 0.5);
  if (r <= 0.36) {
    // gl_PointCoord runs downward, so x + y is constant along a 45-degree line.
    float s = 0.0;
    if ((flags & 1) != 0) s = max(s, swatch(gl_PointCoord.x + gl_PointCoord.y));
    if ((flags & 2) != 0) s = max(s, swatch(gl_PointCoord.x - gl_PointCoord.y));
    if (s > 0.5) color = vec4(u_ink, 1.0);
  }
  if ((flags & 4) != 0) color.a *= u_dimAlpha;
  fragColor = color;
}`

// Picked sites over a parameter field: a ring with no fill, so the cell value shows inside it, and
// an ink band with a halo either side, as the hatch has, so it reads over every ramp in both themes.
const SITE_RING_VERTEX = `#version 300 es
in vec2 a_pos;
uniform mat3 u_matrix;
uniform float u_size;

void main() {
  gl_Position = vec4((u_matrix * vec3(a_pos, 1.0)).xy, 0.0, 1.0);
  gl_PointSize = u_size;
}`

const SITE_RING_FRAGMENT = `#version 300 es
precision highp float;
uniform float u_size;
uniform float u_inkInner;
uniform float u_inkOuter;
uniform float u_haloWidth;
uniform vec3 u_ink;
uniform vec3 u_halo;
out vec4 fragColor;

void main() {
  float r = length(gl_PointCoord - vec2(0.5)) * u_size;
  if (r < u_inkInner - u_haloWidth || r > u_inkOuter + u_haloWidth) discard;
  fragColor = r >= u_inkInner && r <= u_inkOuter ? vec4(u_ink, 1.0) : vec4(u_halo, 1.0);
}`

export interface MeshData {
  positions: Float32Array
  cellIndex: Float32Array
  indices: Uint32Array
  nCells: number
}

const TEX_WIDTH = 2048
// The length of u_classTexel in both shaders; 11 is the most classes offered.
const MAX_CLASSES = 11

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

  private footprintVao!: WebGLVertexArrayObject
  private footprintElements!: WebGLBuffer
  private footprintCount = 0
  private footprintMask: Uint8Array | null = null
  private footprintColor: [number, number, number] = [0, 0, 0]

  private gridVao!: WebGLVertexArrayObject
  private gridElements!: WebGLBuffer
  private gridCount = 0
  private gridBuilt = false
  private gridLines = false
  private gridLineColor: [number, number, number, number] = [0, 0, 0, 1]
  private fieldOpacity = 1

  private hatchProgram!: WebGLProgram
  private hatchVao!: WebGLVertexArrayObject
  private hatchTex!: WebGLTexture
  private hatchStaging: Float32Array<ArrayBuffer>
  private lastHatch: Uint8Array | null = null
  private hatchAny = false
  private hatchInk: [number, number, number] = [0, 0, 0]
  private hatchHalo: [number, number, number] = [1, 1, 1]
  private hatchAngles: [number, number] = [45, 135]

  private classTex!: WebGLTexture
  private classStaging: Float32Array<ArrayBuffer>
  private classMaskDirty = true
  private surfaceColor: [number, number, number] = [1, 1, 1]

  private ringProgram!: WebGLProgram
  private selectionVao!: WebGLVertexArrayObject
  private selectionVerts!: WebGLBuffer
  private selectionElements!: WebGLBuffer
  private selectionCount = 0

  private pointsProgram!: WebGLProgram
  private pointsVao!: WebGLVertexArrayObject
  private pointsPosBuffer!: WebGLBuffer
  private pointsValueBuffer!: WebGLBuffer
  private pointsFlagBuffer!: WebGLBuffer
  private pointCount = 0
  private lastPointXy: Float32Array | null = null
  private lastPointValues: Float32Array | null = null
  private lastPointFlags: Float32Array | null = null
  private pointRingColor: [number, number, number] = [0, 0, 0]
  private selectedPoints: number[] = []
  private droppedPoints = 0
  private dimAlpha = 0.35
  private missingStyle: 'discard' | 'ring' = 'discard'

  private siteRingProgram!: WebGLProgram
  private siteRingVao!: WebGLVertexArrayObject
  private siteRingBuffer!: WebGLBuffer
  private siteRingXy: Float32Array = new Float32Array(0)

  private limits: [number, number] = [0, 1]
  private matrix: Float32Array<ArrayBufferLike> = new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1])
  private colormapName: ColormapName = 'viridis'
  private colormapReverse = false
  private style: EffectiveStyle = CONTINUOUS
  private classTexel = new Float32Array(MAX_CLASSES)
  private lastValues: Float32Array | null = null
  private inactiveMask: Uint8Array | null = null
  private hairlineColor: [number, number, number, number] = [0, 0, 0, 1]
  private contestedMask: Uint8Array | null = null
  private stripeColor: [number, number, number] = [0, 0, 0]
  private contestedFillColor: [number, number, number] = [0, 0, 0]
  private selectedCells: number[] = []
  private accentColor: [number, number, number] = [0, 0, 0]
  private haloColor: [number, number, number] = [1, 1, 1]

  constructor(gl: WebGL2RenderingContext, mesh: MeshData) {
    this.gl = gl
    this.mesh = mesh
    this.texHeight = Math.max(1, Math.ceil(mesh.nCells / TEX_WIDTH))
    this.staging = new Float32Array(TEX_WIDTH * this.texHeight).fill(Number.NaN)
    this.hatchStaging = new Float32Array(TEX_WIDTH * this.texHeight)
    this.classStaging = new Float32Array(TEX_WIDTH * this.texHeight)
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

    // The footprint is one flat colour, so it shares the outline program too.
    this.footprintVao = gl.createVertexArray()!
    gl.bindVertexArray(this.footprintVao)
    gl.bindBuffer(gl.ARRAY_BUFFER, this.positionsBuffer)
    const footprintPosLoc = gl.getAttribLocation(this.outlineProgram, 'a_pos')
    gl.enableVertexAttribArray(footprintPosLoc)
    gl.vertexAttribPointer(footprintPosLoc, 2, gl.FLOAT, false, 0, 0)
    this.footprintElements = gl.createBuffer()!
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.footprintElements)
    gl.bindVertexArray(null)

    // Every cell's outline, for the outlines-only look; also drawn by the outline program.
    this.gridVao = gl.createVertexArray()!
    gl.bindVertexArray(this.gridVao)
    gl.bindBuffer(gl.ARRAY_BUFFER, this.positionsBuffer)
    const gridPosLoc = gl.getAttribLocation(this.outlineProgram, 'a_pos')
    gl.enableVertexAttribArray(gridPosLoc)
    gl.vertexAttribPointer(gridPosLoc, 2, gl.FLOAT, false, 0, 0)
    this.gridElements = gl.createBuffer()!
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.gridElements)
    gl.bindVertexArray(null)
    this.gridBuilt = false

    this.hatchProgram = gl.createProgram()!
    gl.attachShader(this.hatchProgram, compile(gl, gl.VERTEX_SHADER, HATCH_VERTEX))
    gl.attachShader(this.hatchProgram, compile(gl, gl.FRAGMENT_SHADER, HATCH_FRAGMENT))
    gl.linkProgram(this.hatchProgram)
    if (!gl.getProgramParameter(this.hatchProgram, gl.LINK_STATUS)) {
      throw new Error(`hatch program failed to link: ${gl.getProgramInfoLog(this.hatchProgram)}`)
    }

    // Same geometry as the fill: every triangle, with the mask deciding per cell.
    this.hatchVao = gl.createVertexArray()!
    gl.bindVertexArray(this.hatchVao)
    gl.bindBuffer(gl.ARRAY_BUFFER, this.positionsBuffer)
    const hatchPosLoc = gl.getAttribLocation(this.hatchProgram, 'a_pos')
    gl.enableVertexAttribArray(hatchPosLoc)
    gl.vertexAttribPointer(hatchPosLoc, 2, gl.FLOAT, false, 0, 0)
    gl.bindBuffer(gl.ARRAY_BUFFER, this.cellBuffer)
    const hatchCellLoc = gl.getAttribLocation(this.hatchProgram, 'a_cell')
    gl.enableVertexAttribArray(hatchCellLoc)
    gl.vertexAttribPointer(hatchCellLoc, 1, gl.FLOAT, false, 0, 0)
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.elementsBuffer)
    gl.bindVertexArray(null)

    this.ringProgram = gl.createProgram()!
    gl.attachShader(this.ringProgram, compile(gl, gl.VERTEX_SHADER, RING_VERTEX))
    gl.attachShader(this.ringProgram, compile(gl, gl.FRAGMENT_SHADER, RING_FRAGMENT))
    gl.linkProgram(this.ringProgram)
    if (!gl.getProgramParameter(this.ringProgram, gl.LINK_STATUS)) {
      throw new Error(`ring program failed to link: ${gl.getProgramInfoLog(this.ringProgram)}`)
    }

    // Six floats per vertex: the edge's two ends, then the corner.
    this.selectionVao = gl.createVertexArray()!
    gl.bindVertexArray(this.selectionVao)
    this.selectionVerts = gl.createBuffer()!
    gl.bindBuffer(gl.ARRAY_BUFFER, this.selectionVerts)
    for (const [name, offset] of [['a_a', 0], ['a_b', 2], ['a_corner', 4]] as const) {
      const loc = gl.getAttribLocation(this.ringProgram, name)
      gl.enableVertexAttribArray(loc)
      gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 24, offset * 4)
    }
    this.selectionElements = gl.createBuffer()!
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.selectionElements)
    gl.bindVertexArray(null)

    this.pointsProgram = gl.createProgram()!
    gl.attachShader(this.pointsProgram, compile(gl, gl.VERTEX_SHADER, POINTS_VERTEX))
    gl.attachShader(this.pointsProgram, compile(gl, gl.FRAGMENT_SHADER, POINTS_FRAGMENT))
    gl.linkProgram(this.pointsProgram)
    if (!gl.getProgramParameter(this.pointsProgram, gl.LINK_STATUS)) {
      throw new Error(`points program failed to link: ${gl.getProgramInfoLog(this.pointsProgram)}`)
    }

    this.pointsVao = gl.createVertexArray()!
    gl.bindVertexArray(this.pointsVao)
    this.pointsPosBuffer = gl.createBuffer()!
    gl.bindBuffer(gl.ARRAY_BUFFER, this.pointsPosBuffer)
    const pointsPosLoc = gl.getAttribLocation(this.pointsProgram, 'a_pos')
    gl.enableVertexAttribArray(pointsPosLoc)
    gl.vertexAttribPointer(pointsPosLoc, 2, gl.FLOAT, false, 0, 0)
    this.pointsValueBuffer = gl.createBuffer()!
    gl.bindBuffer(gl.ARRAY_BUFFER, this.pointsValueBuffer)
    const pointsValueLoc = gl.getAttribLocation(this.pointsProgram, 'a_value')
    gl.enableVertexAttribArray(pointsValueLoc)
    gl.vertexAttribPointer(pointsValueLoc, 1, gl.FLOAT, false, 0, 0)
    this.pointsFlagBuffer = gl.createBuffer()!
    gl.bindBuffer(gl.ARRAY_BUFFER, this.pointsFlagBuffer)
    const pointsFlagLoc = gl.getAttribLocation(this.pointsProgram, 'a_flags')
    gl.enableVertexAttribArray(pointsFlagLoc)
    gl.vertexAttribPointer(pointsFlagLoc, 1, gl.FLOAT, false, 0, 0)
    gl.bindVertexArray(null)

    this.siteRingProgram = gl.createProgram()!
    gl.attachShader(this.siteRingProgram, compile(gl, gl.VERTEX_SHADER, SITE_RING_VERTEX))
    gl.attachShader(this.siteRingProgram, compile(gl, gl.FRAGMENT_SHADER, SITE_RING_FRAGMENT))
    gl.linkProgram(this.siteRingProgram)
    if (!gl.getProgramParameter(this.siteRingProgram, gl.LINK_STATUS)) {
      throw new Error(`site ring program failed to link: ${gl.getProgramInfoLog(this.siteRingProgram)}`)
    }
    this.siteRingVao = gl.createVertexArray()!
    gl.bindVertexArray(this.siteRingVao)
    this.siteRingBuffer = gl.createBuffer()!
    gl.bindBuffer(gl.ARRAY_BUFFER, this.siteRingBuffer)
    const siteRingLoc = gl.getAttribLocation(this.siteRingProgram, 'a_pos')
    gl.enableVertexAttribArray(siteRingLoc)
    gl.vertexAttribPointer(siteRingLoc, 2, gl.FLOAT, false, 0, 0)
    gl.bufferData(gl.ARRAY_BUFFER, this.siteRingXy, gl.DYNAMIC_DRAW)
    gl.bindVertexArray(null)

    this.valuesTex = gl.createTexture()!
    gl.bindTexture(gl.TEXTURE_2D, this.valuesTex)
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.R32F, TEX_WIDTH, this.texHeight)
    // Never gl.LINEAR here: WebGL2 does not guarantee linear filtering of
    // 32-bit float textures, and interpolating between two cells' values
    // would invent a value neither of them has.
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)

    // The hatch mask, laid out exactly like the value texture and NEAREST for
    // the same reason: a blend of two cells' bits would be a bit set neither has.
    this.hatchTex = gl.createTexture()!
    gl.bindTexture(gl.TEXTURE_2D, this.hatchTex)
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.R32F, TEX_WIDTH, this.texHeight)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)

    // Its own texture, so the overlay mask survives texture mode untouched (D-14).
    this.classTex = gl.createTexture()!
    gl.bindTexture(gl.TEXTURE_2D, this.classTex)
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.R32F, TEX_WIDTH, this.texHeight)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
    this.classMaskDirty = true

    this.rampTex = gl.createTexture()!
    this.setColormap(this.colormapName, this.colormapReverse)

    if (this.inactiveMask) this.setInactive(this.inactiveMask)
    if (this.contestedMask) this.setContested(this.contestedMask)
    if (this.footprintMask) this.setFootprint(this.footprintMask)
    if (this.gridLines) this.buildGridLines()
    if (this.selectedCells.length > 0) this.setSelectedCells(this.selectedCells)
    // The mask goes up before the field, so the field stays the latest upload.
    if (this.lastHatch) this.setHatch(this.lastHatch)
    if (this.lastValues) this.setValues(this.lastValues)
    // Not setPoints: that would clear the flags and selected dots being restored.
    if (this.lastPointXy && this.lastPointValues) this.uploadPoints()
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
    this.classMaskDirty = true
  }

  setLimits(limits: [number, number]): void {
    this.limits = limits
    this.classMaskDirty = true
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

  /** The effective style resolveStyle gave; read at draw time, so a context restore keeps it. */
  setStyle(style: EffectiveStyle): void {
    this.style = style
    this.classTexel = new Float32Array(MAX_CLASSES)
    if (style.classes > 0) this.classTexel.set(classTexelIndices(Math.min(style.classes, MAX_CLASSES)))
    this.classMaskDirty = true
  }

  private textured(): boolean {
    return this.style.texture && this.style.classes > 0
  }

  /** The flat colour every valued cell is filled with in texture mode. */
  setSurfaceColor(rgb: [number, number, number]): void {
    this.surfaceColor = rgb
  }

  // Built from the uploaded values, contested cells already NaN, so the lines match the legend (D-15).
  private uploadClassMask(): void {
    const n = Math.min(this.style.classes, MAX_CLASSES)
    for (let i = 0; i < this.mesh.nCells; i++) {
      this.classStaging[i] = classOf(this.staging[i], this.limits, n) + 1
    }
    const { gl } = this
    gl.bindTexture(gl.TEXTURE_2D, this.classTex)
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, TEX_WIDTH, this.texHeight, gl.RED, gl.FLOAT, this.classStaging)
    this.classMaskDirty = false
  }

  private setClassUniforms(program: WebGLProgram): void {
    const { gl } = this
    gl.uniform1f(gl.getUniformLocation(program, 'u_classes'), Math.min(this.style.classes, MAX_CLASSES))
    gl.uniform1fv(gl.getUniformLocation(program, 'u_classTexel'), this.classTexel)
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
   *  in this file. Carries alpha (WINDOWS.md #12): --hairline is authored
   *  at 10% opacity, and drawOutline blends it in rather than drawing it
   *  opaque. */
  setHairlineColor(rgba: [number, number, number, number]): void {
    this.hairlineColor = rgba
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
    this.classMaskDirty = true
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

  /** `mask[cell]` true means that cell is in the model and gets the quiet
   *  footprint fill under a dot group. `null` or an all-zero mask draws
   *  nothing. */
  setFootprint(mask: Uint8Array | null): void {
    this.footprintMask = mask
    const { gl, mesh } = this
    const triangles: number[] = []
    if (mask) {
      for (let t = 0; t < mesh.indices.length; t += 3) {
        const cell = mesh.cellIndex[mesh.indices[t]]
        if (cell >= 0 && cell < mask.length && mask[cell]) {
          triangles.push(mesh.indices[t], mesh.indices[t + 1], mesh.indices[t + 2])
        }
      }
    }
    this.footprintCount = triangles.length
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.footprintElements)
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint32Array(triangles), gl.DYNAMIC_DRAW)
  }

  setFootprintColor(rgb: [number, number, number]): void {
    this.footprintColor = rgb
  }

  /** How opaque the field fill and the footprint draw, 0 to 1 (D-25). 0 skips the fill. */
  setFieldOpacity(alpha: number): void {
    if (!Number.isFinite(alpha)) throw new Error('field opacity must be a number from 0 to 1')
    this.fieldOpacity = Math.min(Math.max(alpha, 0), 1)
  }

  /** An outline round every cell, for the outlines-only look; the edge list is built on first use and kept. */
  setGridLines(on: boolean): void {
    this.gridLines = on
    if (on && !this.gridBuilt) this.buildGridLines()
  }

  /** Carries alpha, so the caller can draw the grid at a moderate ink rather than the 10% hairline. */
  setGridLineColor(rgba: [number, number, number, number]): void {
    this.gridLineColor = rgba
  }

  private buildGridLines(): void {
    const edges: number[] = []
    for (const ring of this.rings) {
      if (!ring) continue
      const [start, count] = ring
      for (let i = 0; i < count; i++) edges.push(start + i, start + ((i + 1) % count))
    }
    this.gridCount = edges.length
    const { gl } = this
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.gridElements)
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint32Array(edges), gl.STATIC_DRAW)
    this.gridBuilt = true
  }

  /** The stripe colour (`--ink-primary`) and the neutral fill it sits
   *  over, both resolved tokens read exactly like the hairline colour. */
  setContestedColors(stripe: [number, number, number], fill: [number, number, number]): void {
    this.stripeColor = stripe
    this.contestedFillColor = fill
  }

  /** One entry per cell: bit 0 hatches at `angle0` (at bounds), bit 1 at
   *  `angle1` (prior-data conflict), both cross-hatch. `null` clears it.
   *  A mask of any other length than the cell count is refused, never
   *  padded or cut. */
  setHatch(mask: Uint8Array | null): void {
    if (mask === null) {
      this.lastHatch = null
      this.hatchAny = false
      return
    }
    if (mask.length !== this.mesh.nCells) {
      throw new Error(
        `the hatch mask needs one entry per cell, got ${mask.length} entries for ${this.mesh.nCells} cells`,
      )
    }
    this.lastHatch = mask.slice()
    let any = false
    for (let i = 0; i < mask.length; i++) {
      this.hatchStaging[i] = mask[i] & 3
      if (mask[i] & 3) any = true
    }
    this.hatchAny = any
    const { gl } = this
    gl.bindTexture(gl.TEXTURE_2D, this.hatchTex)
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, TEX_WIDTH, this.texHeight, gl.RED, gl.FLOAT, this.hatchStaging)
  }

  /** `--ink-primary` and `--page-plane`, resolved by the caller like the other colours. */
  setHatchColors(ink: [number, number, number], halo: [number, number, number]): void {
    this.hatchInk = ink
    this.hatchHalo = halo
  }

  /** The line angle in degrees for bit 0 and for bit 1. */
  setHatchAngles(angle0Deg = 45, angle1Deg = 135): void {
    this.hatchAngles = [angle0Deg, angle1Deg]
  }

  /** Which cell carries the selection ring, over whatever of the four
   *  marks that cell already has -- `null` removes it. */
  setSelected(cellId: number | null): void {
    this.setSelectedCells(cellId === null ? [] : [cellId])
  }

  /** Rings each cell on its own for up to RING_EACH_MAX cells, and the outer
   *  outline of the set beyond that. Only the first OUTLINE_MAX_CELLS ids are
   *  drawn; the caller counts the rest from that constant. Builds one quad
   *  per ring edge. */
  setSelectedCells(ids: readonly number[]): void {
    this.selectedCells = ids.slice(0, OUTLINE_MAX_CELLS)
    const cells = this.selectedCells
    let edges: ArrayLike<number>
    if (cells.length <= RING_EACH_MAX) {
      const own: number[] = []
      for (const cell of cells) {
        const ring = this.rings[cell]
        if (!ring) continue
        const [start, count] = ring
        for (let i = 0; i < count; i++) own.push(start + i, start + ((i + 1) % count))
      }
      edges = own
    } else {
      edges = outlineEdges(this.rings, this.mesh.positions, cells).edges
    }

    const { gl } = this
    const pos = this.mesh.positions
    const nEdges = edges.length / 2
    const verts = new Float32Array(nEdges * 4 * 6)
    const indices = new Uint32Array(nEdges * 6)
    const corners = [[0, -1], [0, 1], [1, -1], [1, 1]] as const
    for (let e = 0; e < nEdges; e++) {
      const a = edges[2 * e]
      const b = edges[2 * e + 1]
      const base = e * 4
      for (let k = 0; k < 4; k++) {
        const o = (base + k) * 6
        verts[o] = pos[2 * a]
        verts[o + 1] = pos[2 * a + 1]
        verts[o + 2] = pos[2 * b]
        verts[o + 3] = pos[2 * b + 1]
        verts[o + 4] = corners[k][0]
        verts[o + 5] = corners[k][1]
      }
      indices.set([base, base + 1, base + 2, base + 1, base + 3, base + 2], e * 6)
    }
    this.selectionCount = indices.length
    gl.bindVertexArray(this.selectionVao)
    gl.bindBuffer(gl.ARRAY_BUFFER, this.selectionVerts)
    gl.bufferData(gl.ARRAY_BUFFER, verts, gl.DYNAMIC_DRAW)
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.selectionElements)
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indices, gl.DYNAMIC_DRAW)
    gl.bindVertexArray(null)
  }

  /** `--accent`, resolved the same way as the hairline and stripe colours,
   *  and the light halo drawn under the selection ring so it reads on dark
   *  cells as well as light ones. */
  setAccentColor(rgb: [number, number, number], halo: [number, number, number] = [1, 1, 1]): void {
    this.accentColor = rgb
    this.haloColor = halo
  }

  /** `xy` is x, y pairs in the same coordinates as the mesh; `values` is
   *  one already-scaled value per point. An empty `xy` clears the points.
   *  New dots clear the flags and the selected dots: both name dots by
   *  index, so the caller re-applies them for the new set. */
  setPoints(xy: Float32Array, values: Float32Array): void {
    if (values.length * 2 !== xy.length) {
      throw new Error(
        `points need one value per x/y pair, got ${xy.length} coordinates and ${values.length} values`,
      )
    }
    this.lastPointXy = xy
    this.lastPointValues = values
    this.lastPointFlags = null
    this.selectedPoints = []
    this.droppedPoints = 0
    this.uploadPoints()
  }

  private uploadPoints(): void {
    const xy = this.lastPointXy ?? new Float32Array(0)
    const values = this.lastPointValues ?? new Float32Array(0)
    this.pointCount = values.length
    const { gl } = this
    gl.bindBuffer(gl.ARRAY_BUFFER, this.pointsPosBuffer)
    gl.bufferData(gl.ARRAY_BUFFER, xy, gl.DYNAMIC_DRAW)
    gl.bindBuffer(gl.ARRAY_BUFFER, this.pointsValueBuffer)
    gl.bufferData(gl.ARRAY_BUFFER, values, gl.DYNAMIC_DRAW)
    this.uploadPointFlags()
  }

  // With no flags set the attribute still gets zeros, so it always has data.
  private uploadPointFlags(): void {
    const { gl } = this
    gl.bindBuffer(gl.ARRAY_BUFFER, this.pointsFlagBuffer)
    gl.bufferData(gl.ARRAY_BUFFER, this.lastPointFlags ?? new Float32Array(this.pointCount), gl.DYNAMIC_DRAW)
  }

  /** One flag bit set per dot: 1 draws a 45-degree swatch, 2 a 135-degree
   *  swatch, 4 dims the dot to the dim alpha. `null` clears every flag. A
   *  flags array of another length than the point count is refused. */
  setPointFlags(flags: Float32Array | null): void {
    if (flags !== null && flags.length !== this.pointCount) {
      throw new Error(
        `point flags need one entry per point, got ${flags.length} flags for ${this.pointCount} points`,
      )
    }
    this.lastPointFlags = flags === null ? null : flags.slice()
    this.uploadPointFlags()
  }

  /** The alpha a dot flagged dim (bit 4) draws at, read by the caller from the theme. */
  setDimAlpha(alpha: number): void {
    this.dimAlpha = alpha
  }

  /** Replaces the point values only; the dots do not move. The length must match the point count. */
  setPointValues(values: Float32Array): void {
    if (values.length !== this.pointCount) {
      throw new Error(
        `point values need one value per point, got ${values.length} values for ${this.pointCount} points`,
      )
    }
    this.lastPointValues = values
    const { gl } = this
    gl.bindBuffer(gl.ARRAY_BUFFER, this.pointsValueBuffer)
    gl.bufferData(gl.ARRAY_BUFFER, values, gl.DYNAMIC_DRAW)
  }

  /** How a point with no value draws: gone (parameter dots) or a ring with no fill (observation sites). */
  setMissingStyle(style: 'discard' | 'ring'): void {
    this.missingStyle = style
  }

  setPointRingColor(rgb: [number, number, number]): void {
    this.pointRingColor = rgb
  }

  /** x, y pairs in mesh coordinates, one ring each; empty clears them. Apart
   *  from the points, so a parameter group's own dots stay as they are. */
  setSiteRings(xy: Float32Array): void {
    if (xy.length % 2 !== 0) throw new Error(`site rings need x, y pairs, got ${xy.length} coordinates`)
    this.siteRingXy = xy.slice()
    const { gl } = this
    gl.bindBuffer(gl.ARRAY_BUFFER, this.siteRingBuffer)
    gl.bufferData(gl.ARRAY_BUFFER, this.siteRingXy, gl.DYNAMIC_DRAW)
  }

  private drawSiteRings(): void {
    const count = this.siteRingXy.length / 2
    if (count === 0) return
    const { gl } = this
    const dpr = globalThis.devicePixelRatio || 1
    const program = this.siteRingProgram
    gl.useProgram(program)
    gl.bindVertexArray(this.siteRingVao)
    gl.uniformMatrix3fv(gl.getUniformLocation(program, 'u_matrix'), false, this.matrix)
    // CSS px times dpr: ink at radius 8 to 9.5 with a 1 halo each side, so the inner edge at 7 clears a 14 px selected dot.
    gl.uniform1f(gl.getUniformLocation(program, 'u_size'), 22 * dpr)
    gl.uniform1f(gl.getUniformLocation(program, 'u_inkInner'), 8 * dpr)
    gl.uniform1f(gl.getUniformLocation(program, 'u_inkOuter'), 9.5 * dpr)
    gl.uniform1f(gl.getUniformLocation(program, 'u_haloWidth'), 1 * dpr)
    const ink = this.hatchInk
    const halo = this.hatchHalo
    gl.uniform3f(gl.getUniformLocation(program, 'u_ink'), ink[0], ink[1], ink[2])
    gl.uniform3f(gl.getUniformLocation(program, 'u_halo'), halo[0], halo[1], halo[2])
    gl.drawArrays(gl.POINTS, 0, count)
    gl.bindVertexArray(null)
  }

  /** The point drawn larger with an accent ring; `null` removes it. */
  setSelectedPoint(index: number | null): void {
    this.setSelectedPoints(index === null ? [] : [index])
  }

  /** The dots drawn larger with an accent ring. An index that is not a
   *  drawn dot is dropped and counted in selectedPointsDropped(). */
  setSelectedPoints(indices: readonly number[]): void {
    const kept = new Set<number>()
    let dropped = 0
    for (const i of indices) {
      if (Number.isInteger(i) && i >= 0 && i < this.pointCount) kept.add(i)
      else dropped += 1
    }
    this.selectedPoints = [...kept].sort((a, b) => a - b)
    this.droppedPoints = dropped
  }

  /** How many indices the last setSelectedPoints call dropped. */
  selectedPointsDropped(): number {
    return this.droppedPoints
  }

  private drawPoints(): void {
    if (this.pointCount === 0) return
    const { gl } = this
    const dpr = globalThis.devicePixelRatio || 1
    const program = this.pointsProgram
    gl.useProgram(program)
    gl.bindVertexArray(this.pointsVao)
    gl.activeTexture(gl.TEXTURE1)
    gl.bindTexture(gl.TEXTURE_2D, this.rampTex)
    gl.uniform1i(gl.getUniformLocation(program, 'u_ramp'), 1)
    gl.uniformMatrix3fv(gl.getUniformLocation(program, 'u_matrix'), false, this.matrix)
    gl.uniform2f(gl.getUniformLocation(program, 'u_limits'), this.limits[0], this.limits[1])
    gl.uniform1f(gl.getUniformLocation(program, 'u_size'), 10 * dpr)
    const ring = this.pointRingColor
    gl.uniform3f(gl.getUniformLocation(program, 'u_ringColor'), ring[0], ring[1], ring[2])
    gl.uniform1f(gl.getUniformLocation(program, 'u_missingStyle'), this.missingStyle === 'ring' ? 1 : 0)
    const ink = this.hatchInk
    gl.uniform3f(gl.getUniformLocation(program, 'u_ink'), ink[0], ink[1], ink[2])
    gl.uniform1f(gl.getUniformLocation(program, 'u_dimAlpha'), this.dimAlpha)
    this.setClassUniforms(program)
    // Blend colour only; alpha stays 1 so a dimmed dot never makes the canvas see-through.
    const wasBlending = gl.isEnabled(gl.BLEND)
    gl.enable(gl.BLEND)
    gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA)
    gl.drawArrays(gl.POINTS, 0, this.pointCount)

    if (this.selectedPoints.length > 0) {
      const accent = this.accentColor
      gl.uniform1f(gl.getUniformLocation(program, 'u_size'), 14 * dpr)
      gl.uniform3f(gl.getUniformLocation(program, 'u_ringColor'), accent[0], accent[1], accent[2])
      for (const index of this.selectedPoints) {
        if (index < this.pointCount) gl.drawArrays(gl.POINTS, index, 1)
      }
    }
    if (!wasBlending) gl.disable(gl.BLEND)
    gl.bindVertexArray(null)
  }

  private drawOutline(): void {
    if (this.outlineCount === 0) return
    const { gl } = this
    gl.useProgram(this.outlineProgram)
    gl.bindVertexArray(this.outlineVao)
    gl.uniformMatrix3fv(gl.getUniformLocation(this.outlineProgram, 'u_matrix'), false, this.matrix)
    gl.uniform4f(
      gl.getUniformLocation(this.outlineProgram, 'u_color'),
      this.hairlineColor[0],
      this.hairlineColor[1],
      this.hairlineColor[2],
      this.hairlineColor[3],
    )
    // --hairline is authored at 10% opacity (WINDOWS.md #12) -- blend it in,
    // then restore whatever blend state this call found, so the opaque
    // fill/contested/selection passes that draw after this one are
    // unaffected.
    const wasBlending = gl.isEnabled(gl.BLEND)
    gl.enable(gl.BLEND)
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA)
    gl.drawElements(gl.LINES, this.outlineCount, gl.UNSIGNED_INT, 0)
    if (!wasBlending) gl.disable(gl.BLEND)
    gl.bindVertexArray(null)
  }

  private drawFootprint(): void {
    if (this.footprintCount === 0 || this.fieldOpacity === 0) return
    const { gl } = this
    gl.useProgram(this.outlineProgram)
    gl.bindVertexArray(this.footprintVao)
    gl.uniformMatrix3fv(gl.getUniformLocation(this.outlineProgram, 'u_matrix'), false, this.matrix)
    const c = this.footprintColor
    gl.uniform4f(gl.getUniformLocation(this.outlineProgram, 'u_color'), c[0], c[1], c[2], this.fieldOpacity)
    this.blendedBelowOne(() => gl.drawElements(gl.TRIANGLES, this.footprintCount, gl.UNSIGNED_INT, 0))
    gl.bindVertexArray(null)
  }

  // Below full opacity, blend colour only, so the canvas alpha stays 1 over a basemap.
  private blendedBelowOne(drawCall: () => void): void {
    if (this.fieldOpacity >= 1) {
      drawCall()
      return
    }
    const { gl } = this
    const wasBlending = gl.isEnabled(gl.BLEND)
    gl.enable(gl.BLEND)
    gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA)
    drawCall()
    if (!wasBlending) gl.disable(gl.BLEND)
  }

  private drawGridLines(): void {
    if (!this.gridLines || this.gridCount === 0) return
    const { gl } = this
    gl.useProgram(this.outlineProgram)
    gl.bindVertexArray(this.gridVao)
    gl.uniformMatrix3fv(gl.getUniformLocation(this.outlineProgram, 'u_matrix'), false, this.matrix)
    const c = this.gridLineColor
    gl.uniform4f(gl.getUniformLocation(this.outlineProgram, 'u_color'), c[0], c[1], c[2], c[3])
    const wasBlending = gl.isEnabled(gl.BLEND)
    gl.enable(gl.BLEND)
    // Separate alpha keeps the canvas opaque under the lines, as the fill and basemap do.
    gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA)
    gl.drawElements(gl.LINES, this.gridCount, gl.UNSIGNED_INT, 0)
    if (!wasBlending) gl.disable(gl.BLEND)
    gl.bindVertexArray(null)
  }

  private drawFill(): void {
    if (this.fieldOpacity === 0) return
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
    this.setClassUniforms(this.program)
    gl.uniform1f(gl.getUniformLocation(this.program, 'u_flat'), this.textured() ? 1 : 0)
    const s = this.surfaceColor
    gl.uniform3f(gl.getUniformLocation(this.program, 'u_surface'), s[0], s[1], s[2])
    gl.uniform1f(gl.getUniformLocation(this.program, 'u_alpha'), this.fieldOpacity)

    this.blendedBelowOne(() => gl.drawElements(gl.TRIANGLES, this.mesh.indices.length, gl.UNSIGNED_INT, 0))
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

  private drawHatch(): void {
    const textured = this.textured()
    if (!textured && !this.hatchAny) return
    const { gl } = this
    const program = this.hatchProgram
    const dpr = globalThis.devicePixelRatio || 1
    gl.useProgram(program)
    gl.bindVertexArray(this.hatchVao)
    // Unit 2: unit 0 holds the values and unit 1 the ramp.
    gl.activeTexture(gl.TEXTURE2)
    gl.bindTexture(gl.TEXTURE_2D, textured ? this.classTex : this.hatchTex)
    gl.uniform1i(gl.getUniformLocation(program, 'u_mask'), 2)
    gl.uniform1f(gl.getUniformLocation(program, 'u_mode'), textured ? 1 : 0)
    gl.uniform1f(gl.getUniformLocation(program, 'u_classes'), textured ? Math.min(this.style.classes, MAX_CLASSES) : 0)
    gl.uniformMatrix3fv(gl.getUniformLocation(program, 'u_matrix'), false, this.matrix)
    gl.uniform2f(gl.getUniformLocation(program, 'u_texSize'), TEX_WIDTH, this.texHeight)
    const toRad = Math.PI / 180
    gl.uniform1f(gl.getUniformLocation(program, 'u_angle0'), this.hatchAngles[0] * toRad)
    gl.uniform1f(gl.getUniformLocation(program, 'u_angle1'), this.hatchAngles[1] * toRad)
    // In device pixels: lines 7 apart, a 1.25 ink band, a 1 halo band each side.
    gl.uniform1f(gl.getUniformLocation(program, 'u_period'), 7 * dpr)
    gl.uniform1f(gl.getUniformLocation(program, 'u_inkHalf'), 0.625 * dpr)
    gl.uniform1f(gl.getUniformLocation(program, 'u_haloWidth'), 1 * dpr)
    const ink = this.hatchInk
    const halo = this.hatchHalo
    gl.uniform3f(gl.getUniformLocation(program, 'u_ink'), ink[0], ink[1], ink[2])
    gl.uniform3f(gl.getUniformLocation(program, 'u_halo'), halo[0], halo[1], halo[2])
    const wasBlending = gl.isEnabled(gl.BLEND)
    gl.enable(gl.BLEND)
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA)
    gl.drawElements(gl.TRIANGLES, this.mesh.indices.length, gl.UNSIGNED_INT, 0)
    if (!wasBlending) gl.disable(gl.BLEND)
    gl.activeTexture(gl.TEXTURE0)
    gl.bindVertexArray(null)
  }

  private drawSelection(): void {
    if (this.selectionCount === 0) return
    const { gl } = this
    const program = this.ringProgram
    const dpr = globalThis.devicePixelRatio || 1
    gl.useProgram(program)
    gl.bindVertexArray(this.selectionVao)
    gl.uniformMatrix3fv(gl.getUniformLocation(program, 'u_matrix'), false, this.matrix)
    gl.uniform2f(
      gl.getUniformLocation(program, 'u_viewport'),
      gl.drawingBufferWidth || 1,
      gl.drawingBufferHeight || 1,
    )
    // Half widths in device pixels: a 2.5px accent band inside a 5px halo.
    for (const [halfWidth, c] of [
      [2.5, this.haloColor],
      [1.25, this.accentColor],
    ] as const) {
      gl.uniform1f(gl.getUniformLocation(program, 'u_halfWidth'), halfWidth * dpr)
      gl.uniform3f(gl.getUniformLocation(program, 'u_color'), c[0], c[1], c[2])
      gl.drawElements(gl.TRIANGLES, this.selectionCount, gl.UNSIGNED_INT, 0)
    }
    gl.bindVertexArray(null)
  }

  /** Outline, stripe, value, ring -- the contract's own draw order
   *  (D-06/MAP-07). Outline first so a coloured cell never has a stroke
   *  drawn over it; the stripe before the value pass since a contested
   *  cell's value is always NaN and so never overwrites it; the ring last
   *  so it sits over whichever of the first three marks the selected cell
   *  carries. The hatch goes over the fill and under the points, so it
   *  never covers a dot. Points go after the fill and before the ring, and
   *  the picked-site rings just after the points. The
   *  footprint goes under everything, so the hairline still reads at its
   *  edge. The grid lines of the outlines-only look go just over the fill
   *  and under the hatch. */
  draw(): void {
    if (this.textured() && this.classMaskDirty) this.uploadClassMask()
    this.drawFootprint()
    this.drawOutline()
    this.drawContested()
    this.drawFill()
    this.drawGridLines()
    this.drawHatch()
    this.drawPoints()
    this.drawSiteRings()
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
    gl.deleteProgram(this.pointsProgram)
    gl.deleteProgram(this.ringProgram)
    gl.deleteProgram(this.hatchProgram)
    gl.deleteProgram(this.siteRingProgram)
    gl.deleteVertexArray(this.siteRingVao)
    gl.deleteBuffer(this.siteRingBuffer)
    gl.deleteVertexArray(this.hatchVao)
    gl.deleteTexture(this.hatchTex)
    gl.deleteTexture(this.classTex)
    gl.deleteVertexArray(this.vao)
    gl.deleteVertexArray(this.outlineVao)
    gl.deleteVertexArray(this.contestedVao)
    gl.deleteVertexArray(this.selectionVao)
    gl.deleteVertexArray(this.footprintVao)
    gl.deleteVertexArray(this.gridVao)
    gl.deleteVertexArray(this.pointsVao)
    gl.deleteBuffer(this.positionsBuffer)
    gl.deleteBuffer(this.cellBuffer)
    gl.deleteBuffer(this.elementsBuffer)
    gl.deleteBuffer(this.outlineElements)
    gl.deleteBuffer(this.contestedElements)
    gl.deleteBuffer(this.selectionVerts)
    gl.deleteBuffer(this.selectionElements)
    gl.deleteBuffer(this.footprintElements)
    gl.deleteBuffer(this.gridElements)
    gl.deleteBuffer(this.pointsPosBuffer)
    gl.deleteBuffer(this.pointsValueBuffer)
    gl.deleteBuffer(this.pointsFlagBuffer)
    gl.deleteTexture(this.valuesTex)
    gl.deleteTexture(this.rampTex)
  }
}
