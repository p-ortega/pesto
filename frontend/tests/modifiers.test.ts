import { afterEach, describe, expect, it, vi } from 'vitest'
import { modeOf, removeKeyName } from '../src/state/modifiers'

describe('modeOf', () => {
  it('a plain click replaces', () => {
    expect(modeOf({ altKey: false, shiftKey: false })).toBe('replace')
  })

  it('shift adds', () => {
    expect(modeOf({ altKey: false, shiftKey: true })).toBe('add')
  })

  it('alt removes', () => {
    expect(modeOf({ altKey: true, shiftKey: false })).toBe('remove')
  })

  it('alt wins when shift is held too', () => {
    expect(modeOf({ altKey: true, shiftKey: true })).toBe('remove')
  })
})

describe('removeKeyName', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('is Option when the client hints name macOS', () => {
    vi.stubGlobal('navigator', { userAgentData: { platform: 'macOS' }, platform: '' })
    expect(removeKeyName()).toBe('Option')
  })

  it('is Option on an older Mac browser with no client hints', () => {
    vi.stubGlobal('navigator', { platform: 'MacIntel' })
    expect(removeKeyName()).toBe('Option')
  })

  it('is Alt on Windows and Linux', () => {
    vi.stubGlobal('navigator', { platform: 'Win32' })
    expect(removeKeyName()).toBe('Alt')
    vi.stubGlobal('navigator', { platform: 'Linux x86_64' })
    expect(removeKeyName()).toBe('Alt')
  })

  it('is Alt when the browser names no platform', () => {
    vi.stubGlobal('navigator', { platform: '' })
    expect(removeKeyName()).toBe('Alt')
  })
})
