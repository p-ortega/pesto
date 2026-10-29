// The overlay swatches in the controls must slant the way the map's hatch does. The map draws
// at bounds at 45 degrees and a prior-data conflict at 135 (MeshLayer's default angles); CSS
// turns the other way, so the stylesheet needs swatchCssAngle of each.

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { swatchCssAngle } from '../src/gl/colormap'

const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'style.css'), 'utf8').replace(
  /\/\*[\s\S]*?\*\//g,
  '',
)

function angleOf(selectorLine: string): number {
  const rule = css.match(new RegExp(`${selectorLine.replace(/\./g, '\\.')}\\s*\\{[^}]*?repeating-linear-gradient\\(\\s*(\\d+)deg`))
  if (rule === null) throw new Error(`no repeating gradient found in the rule for ${selectorLine}`)
  return Number(rule[1])
}

describe('overlay swatch angles', () => {
  it('slant the at-bounds swatch like the map hatch at 45 degrees', () => {
    expect(angleOf('.hatch-swatch.at-bounds')).toBe(swatchCssAngle(45))
  })

  it('slant the conflict swatch and mark like the map hatch at 135 degrees', () => {
    expect(angleOf('.conflict-mark')).toBe(swatchCssAngle(135))
  })
})
