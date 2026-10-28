import { describe, expect, it } from 'vitest'
import { modeOf } from '../src/state/modifiers'

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
