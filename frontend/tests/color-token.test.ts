// @vitest-environment jsdom
// WINDOWS.md #10: getComputedStyle serialises --hairline (authored as
// rgba(255, 255, 255, 0.1)) back as the 8-digit hex #ffffff1a, not an
// rgba() string. readColorToken's old int32 bitwise arithmetic overflowed
// on that 8-digit value and turned faint white into bright yellow. This
// test drives the pure parser directly with the literal strings a real
// browser hands back, since jsdom does not reproduce that serialisation.

import { describe, expect, it } from 'vitest'
import { parseNumberToken, readNumberToken } from '../src/gl/color-token'
import { parseColorToken } from '../src/views/map'

describe('parseColorToken', () => {
  // WINDOWS.md #12: the orchestrator's prior instruction to drop the alpha
  // channel was wrong -- --hairline is authored at 10% opacity on purpose,
  // and dropping it draws the outline at full strength. This is the test
  // that would have caught that bad instruction.
  it('reports the alpha channel of an 8-digit hex token instead of discarding it', () => {
    const [, , , a] = parseColorToken('#ffffff1a')
    expect(a).toBeCloseTo(26 / 255, 5)
    expect(a).toBeCloseTo(0.102, 3)
  })

  it('reads an 8-digit hex token as its RGBA quadruple, no longer discarding alpha', () => {
    // The exact dark-theme --hairline serialisation measured in a real
    // browser. Must come back near-white, never the old yellow result.
    expect(parseColorToken('#ffffff1a')).toEqual([1, 1, 1, 26 / 255])
  })

  it('reads the light-theme 8-digit hex hairline the same way', () => {
    const [r, g, b, a] = parseColorToken('#0b0b0b1a')
    expect(r).toBeCloseTo(11 / 255, 5)
    expect(g).toBeCloseTo(11 / 255, 5)
    expect(b).toBeCloseTo(11 / 255, 5)
    expect(a).toBeCloseTo(26 / 255, 5)
  })

  it('reads a plain 6-digit hex token as fully opaque', () => {
    const [r, g, b, a] = parseColorToken('#2a78d6')
    expect(r).toBeCloseTo(0x2a / 255, 5)
    expect(g).toBeCloseTo(0x78 / 255, 5)
    expect(b).toBeCloseTo(0xd6 / 255, 5)
    expect(a).toBe(1)
  })

  it('reads a 3-digit shorthand hex token as fully opaque', () => {
    expect(parseColorToken('#fff')).toEqual([1, 1, 1, 1])
  })

  it('reads a 4-digit shorthand hex token, carrying its alpha digit', () => {
    // '8' repeated is '88' = 136, not the '0.1'-ish fraction a human might
    // guess -- this is what the shorthand form's own doubling rule gives.
    const [r, g, b, a] = parseColorToken('#fff8')
    expect([r, g, b]).toEqual([1, 1, 1])
    expect(a).toBeCloseTo(136 / 255, 5)
  })

  it('reads an rgb() token as fully opaque', () => {
    const [r, g, b, a] = parseColorToken('rgb(42, 120, 214)')
    expect(r).toBeCloseTo(42 / 255, 5)
    expect(g).toBeCloseTo(120 / 255, 5)
    expect(b).toBeCloseTo(214 / 255, 5)
    expect(a).toBe(1)
  })

  it('reads an rgba() token, carrying the alpha channel', () => {
    expect(parseColorToken('rgba(255, 255, 255, 0.1)')).toEqual([1, 1, 1, 0.1])
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
    expect(parseColorToken('')).toEqual([0, 0, 0, 1])
  })
})

describe('parseNumberToken', () => {
  it('reads a fraction token as its number', () => {
    expect(parseNumberToken('0.35')).toBe(0.35)
    expect(parseNumberToken(' 0.3 ')).toBe(0.3)
  })

  it('treats an empty string as an unset property and dims nothing', () => {
    expect(parseNumberToken('')).toBe(1)
  })

  it('throws, naming the value, for something that is not a number', () => {
    expect(() => parseNumberToken('abc')).toThrow(/"abc"/)
  })

  it('throws, naming the value, for a number outside 0 to 1', () => {
    expect(() => parseNumberToken('1.5')).toThrow(/"1\.5"/)
    expect(() => parseNumberToken('-0.1')).toThrow(/"-0\.1"/)
  })

  it('reads a token off the document root', () => {
    document.documentElement.style.setProperty('--test-fraction', '0.25')
    try {
      expect(readNumberToken('--test-fraction')).toBe(0.25)
    } finally {
      document.documentElement.style.removeProperty('--test-fraction')
    }
  })
})
