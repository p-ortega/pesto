// One MeshLayer double for every map test. It reads the method names off the
// real class, so a method added to MeshLayer is mocked here with no test edit.

import { vi } from 'vitest'

type MeshLayerModule = typeof import('../../src/gl/mesh-layer')

export function meshLayerMockModule(actual: MeshLayerModule): MeshLayerModule {
  const names = Object.getOwnPropertyNames(actual.MeshLayer.prototype).filter((name) => name !== 'constructor')
  const MeshLayer = vi.fn().mockImplementation(function MockMeshLayer(this: Record<string, unknown>) {
    for (const name of names) this[name] = vi.fn()
  })
  return { ...actual, MeshLayer: MeshLayer as unknown as MeshLayerModule['MeshLayer'] }
}
