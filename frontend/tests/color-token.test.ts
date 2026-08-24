// WINDOWS.md #10: getComputedStyle serialises --hairline (authored as
// rgba(255, 255, 255, 0.1)) back as the 8-digit hex #ffffff1a, not an
// rgba() string. readColorToken's old int32 bitwise arithmetic overflowed
// on that 8-digit value and turned faint white into bright yellow. This
// test drives the pure parser directly with the literal strings a real
// browser hands back, since jsdom does not reproduce that serialisation.

import { describe, expect, it } from 'vitest'
import { parseColorToken } from '../src/views/map'

describe('parseColorToken', () => {
  it('reads an 8-digit hex token as its RGB triple, ignoring alpha', () => {
    // The exact dark-theme --hairline serialisation measured in a real
    // browser. Must come back near-white, never the old yellow result.
    expect(parseColorToken('#ffffff1a')).toEqual([1, 1, 1])
  })

  it('reads the light-theme 8-digit hex hairline the same way', () => {
    const [r, g, b] = parseColorToken('#0b0b0b1a')
    expect(r).toBeCloseTo(11 / 255, 5)
    expect(g).toBeCloseTo(11 / 255, 5)
    expect(b).toBeCloseTo(11 / 255, 5)
  })

  it('reads a plain 6-digit hex token', () => {
    const [r, g, b] = parseColorToken('#2a78d6')
    expect(r).toBeCloseTo(0x2a / 255, 5)
    expect(g).toBeCloseTo(0x78 / 255, 5)
    expect(b).toBeCloseTo(0xd6 / 255, 5)
  })

  it('reads a 3-digit shorthand hex token', () => {
    expect(parseColorToken('#fff')).toEqual([1, 1, 1])
  })

  it('reads a 4-digit shorthand hex token, ignoring the alpha digit', () => {
    expect(parseColorToken('#fff8')).toEqual([1, 1, 1])
  })

  it('reads an rgb() token', () => {
    const [r, g, b] = parseColorToken('rgb(42, 120, 214)')
    expect(r).toBeCloseTo(42 / 255, 5)
    expect(g).toBeCloseTo(120 / 255, 5)
    expect(b).toBeCloseTo(214 / 255, 5)
  })

  it('reads an rgba() token, ignoring the alpha channel', () => {
    expect(parseColorToken('rgba(255, 255, 255, 0.1)')).toEqual([1, 1, 1])
  })

  it('never returns int32-overflowed channels for a value past 2^31 when parsed as a bare hex integer', () => {
    // The old bug: Number.parseInt('ffffff1a', 16) | 0 wraps to a negative
    // int32, and (-230 >> 16) & 255 comes out 255 -- rgb(255, 255, 26),
    // bright yellow, for a token that should read as near-white.
    const [r, g, b] = parseColorToken('#ffffff1a')
    expect([r, g, b]).not.toEqual([1, 1, 26 / 255])
  })

  it('throws rather than silently returning black for a resolved-but-unreadable token', () => {
    expect(() => parseColorToken('not-a-color')).toThrow()
  })

  it('treats an empty string as an unset property, not a resolved-but-garbage value', () => {
    // The empty string is what an unset custom property resolves to --
    // this project's every theme defines every token this reads, so this
    // path only ever fires in a test environment with no stylesheet
    // loaded. That is a distinct case from a browser handing back a
    // resolved value this code cannot read, which is the actual defect
    // this file exists to catch, so only that case throws.
    expect(parseColorToken('')).toEqual([0, 0, 0])
  })
})
