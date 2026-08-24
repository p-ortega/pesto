// A recording stub standing in for WebGL2RenderingContext -- logs the name
// and arguments of every method MeshLayer calls, and returns just enough of
// a value (a unique tagged object, or true for a status check) to keep the
// class's own logic moving. Nothing here can render a pixel; it only proves
// which calls were made and with what arguments, which is what
// tests/mesh-layer.test.ts and the map integration tests both need.

export interface RecordedCall {
  method: string
  args: unknown[]
}

export function createRecordingGl(): { gl: WebGL2RenderingContext; calls: RecordedCall[] } {
  const calls: RecordedCall[] = []
  let nextId = 1
  const tag = (kind: string) => ({ __tag: kind, __id: nextId++ })
  const record =
    (method: string) =>
    (...args: unknown[]) => {
      calls.push({ method, args })
    }

  const CONSTANTS: Record<string, string | number> = {
    TEXTURE_2D: 'TEXTURE_2D',
    ARRAY_BUFFER: 'ARRAY_BUFFER',
    ELEMENT_ARRAY_BUFFER: 'ELEMENT_ARRAY_BUFFER',
    STATIC_DRAW: 'STATIC_DRAW',
    DYNAMIC_DRAW: 'DYNAMIC_DRAW',
    FLOAT: 'FLOAT',
    TRIANGLES: 'TRIANGLES',
    LINES: 'LINES',
    UNSIGNED_INT: 'UNSIGNED_INT',
    R32F: 'R32F',
    RGBA: 'RGBA',
    RED: 'RED',
    UNSIGNED_BYTE: 'UNSIGNED_BYTE',
    NEAREST: 'NEAREST',
    LINEAR: 'LINEAR',
    CLAMP_TO_EDGE: 'CLAMP_TO_EDGE',
    TEXTURE_MIN_FILTER: 'TEXTURE_MIN_FILTER',
    TEXTURE_MAG_FILTER: 'TEXTURE_MAG_FILTER',
    TEXTURE_WRAP_S: 'TEXTURE_WRAP_S',
    COMPILE_STATUS: 'COMPILE_STATUS',
    LINK_STATUS: 'LINK_STATUS',
    VERTEX_SHADER: 'VERTEX_SHADER',
    FRAGMENT_SHADER: 'FRAGMENT_SHADER',
    TEXTURE0: 0,
    TEXTURE1: 1,
    COLOR_BUFFER_BIT: 'COLOR_BUFFER_BIT',
    BLEND: 'BLEND',
    SRC_ALPHA: 'SRC_ALPHA',
    ONE_MINUS_SRC_ALPHA: 'ONE_MINUS_SRC_ALPHA',
  }

  const gl = {
    ...CONSTANTS,
    createShader: (...a: unknown[]) => {
      record('createShader')(...a)
      return tag('shader')
    },
    shaderSource: record('shaderSource'),
    compileShader: record('compileShader'),
    getShaderParameter: () => true,
    getShaderInfoLog: () => '',
    createProgram: (...a: unknown[]) => {
      record('createProgram')(...a)
      return tag('program')
    },
    attachShader: record('attachShader'),
    linkProgram: record('linkProgram'),
    getProgramParameter: () => true,
    getProgramInfoLog: () => '',
    createVertexArray: (...a: unknown[]) => {
      record('createVertexArray')(...a)
      return tag('vao')
    },
    bindVertexArray: record('bindVertexArray'),
    createBuffer: (...a: unknown[]) => {
      record('createBuffer')(...a)
      return tag('buffer')
    },
    bindBuffer: record('bindBuffer'),
    bufferData: record('bufferData'),
    getAttribLocation: () => nextId++,
    enableVertexAttribArray: record('enableVertexAttribArray'),
    vertexAttribPointer: record('vertexAttribPointer'),
    createTexture: (...a: unknown[]) => {
      record('createTexture')(...a)
      return tag('texture')
    },
    bindTexture: record('bindTexture'),
    texStorage2D: record('texStorage2D'),
    texParameteri: record('texParameteri'),
    texSubImage2D: record('texSubImage2D'),
    texImage2D: record('texImage2D'),
    useProgram: record('useProgram'),
    activeTexture: record('activeTexture'),
    getUniformLocation: (...a: unknown[]) => {
      record('getUniformLocation')(...a)
      return tag('uniform')
    },
    uniform1i: record('uniform1i'),
    uniform2f: record('uniform2f'),
    uniform3f: record('uniform3f'),
    uniform4f: record('uniform4f'),
    uniformMatrix3fv: record('uniformMatrix3fv'),
    isEnabled: (...a: unknown[]) => {
      record('isEnabled')(...a)
      return false
    },
    enable: record('enable'),
    disable: record('disable'),
    blendFunc: record('blendFunc'),
    drawElements: record('drawElements'),
    deleteProgram: record('deleteProgram'),
    deleteVertexArray: record('deleteVertexArray'),
    deleteBuffer: record('deleteBuffer'),
    deleteTexture: record('deleteTexture'),
    viewport: record('viewport'),
    clearColor: record('clearColor'),
    clear: record('clear'),
  }

  return { gl: gl as unknown as WebGL2RenderingContext, calls }
}
