// The shared MeshLayer double must mock every method the real class has, so a
// map test never fails with "not a function" after MeshLayer grows a method.

import { describe, expect, it, vi } from 'vitest'
import * as real from '../src/gl/mesh-layer'
import { meshLayerMockModule } from './support/mesh-layer-mock'

const methodNames = Object.getOwnPropertyNames(real.MeshLayer.prototype).filter((name) => name !== 'constructor')

describe('meshLayerMockModule', () => {
  it('gives each instance a mock for every MeshLayer prototype method', () => {
    const mocked = meshLayerMockModule(real)
    const instance = new mocked.MeshLayer({} as WebGL2RenderingContext, {} as real.MeshData) as unknown as Record<
      string,
      unknown
    >
    expect(methodNames.length).toBeGreaterThan(0)
    for (const name of methodNames) {
      expect(typeof instance[name], name).toBe('function')
      expect(vi.isMockFunction(instance[name]), name).toBe(true)
    }
  })

  it('covers the methods the old hand-written mocks listed', () => {
    for (const name of ['setValues', 'setSelected', 'setPoints', 'draw', 'reupload', 'dispose']) {
      expect(methodNames).toContain(name)
    }
  })

  it('records instances on the constructor mock the way the tests read them', () => {
    const mocked = meshLayerMockModule(real)
    const instance = new mocked.MeshLayer({} as WebGL2RenderingContext, {} as real.MeshData)
    expect(vi.mocked(mocked.MeshLayer).mock.instances[0]).toBe(instance)
  })

  it('gives separate instances separate mocks', () => {
    const mocked = meshLayerMockModule(real)
    const a = new mocked.MeshLayer({} as WebGL2RenderingContext, {} as real.MeshData) as unknown as Record<string, unknown>
    const b = new mocked.MeshLayer({} as WebGL2RenderingContext, {} as real.MeshData) as unknown as Record<string, unknown>
    expect(a.draw).not.toBe(b.draw)
  })

  it('keeps every other export of the module as the real value', () => {
    const mocked = meshLayerMockModule(real) as unknown as Record<string, unknown>
    const others = Object.keys(real).filter((key) => key !== 'MeshLayer')
    for (const key of others) expect(mocked[key], key).toBe((real as Record<string, unknown>)[key])
    expect(mocked.MeshLayer).not.toBe(real.MeshLayer)
  })
})
