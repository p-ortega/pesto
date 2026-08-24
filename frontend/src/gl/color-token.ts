// Reads a resolved CSS custom property and converts it to the 0-1 floats
// WebGL2 wants, for the canvas clear colour, the hairline outline, the
// contested stripe/fill and the accent ring (views/map.ts).
//
// WINDOWS.md #10: getComputedStyle hands the hairline token back as an
// 8-digit hex string, not the rgba() form style.css authors it in --
// Chromium normalises a custom property carrying a <color> token this way.
// The old parser only handled 6-digit hex and rgba(), and read an 8-digit
// hex as a plain integer: that value is past 2^31, so bitwise arithmetic on
// it (`n >> 16`, say) overflows to a negative int32 and turns a faint white
// outline into bright yellow. This parses 3/4/6/8-digit hex and
// rgb()/rgba() forms by pulling the channel digits straight out of the
// string, never through a bitwise op on a value that can exceed 2^31, and
// always drops the alpha channel -- the caller wants an opaque line colour.

const HEX_PATTERN = /^#([0-9a-fA-F]{3,8})$/
const RGB_PATTERN = /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/

/**
 * Parses a resolved colour token's string value into an opaque RGB triple.
 * A token this cannot read throws rather than falling back to black, which
 * would be indistinguishable from a real black token (CLAUDE.md's rule
 * against dropping something without a trace) -- except for the empty
 * string, the value an unset custom property resolves to (this project's
 * every theme always defines every token it reads, so this only ever fires
 * in a test environment with no stylesheet loaded, never for a real user).
 */
export function parseColorToken(value: string): [number, number, number] {
  const trimmed = value.trim()

  if (trimmed === '') {
    return [0, 0, 0]
  }

  const hex = trimmed.match(HEX_PATTERN)
  if (hex) {
    const digits = hex[1]
    if (digits.length === 3 || digits.length === 4) {
      const [r, g, b] = digits
        .slice(0, 3)
        .split('')
        .map((c) => Number.parseInt(c + c, 16))
      return [r / 255, g / 255, b / 255]
    }
    if (digits.length === 6 || digits.length === 8) {
      const r = Number.parseInt(digits.slice(0, 2), 16)
      const g = Number.parseInt(digits.slice(2, 4), 16)
      const b = Number.parseInt(digits.slice(4, 6), 16)
      return [r / 255, g / 255, b / 255]
    }
  }

  const rgb = trimmed.match(RGB_PATTERN)
  if (rgb) {
    return [Number(rgb[1]) / 255, Number(rgb[2]) / 255, Number(rgb[3]) / 255]
  }

  throw new Error(`colour token value could not be parsed: "${value}"`)
}

/** Reads `name` off `document.documentElement`'s resolved style and parses
 *  it. No colour value is written in this file. */
export function readColorToken(name: string): [number, number, number] {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  return parseColorToken(value)
}
