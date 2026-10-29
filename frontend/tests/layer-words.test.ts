// Layer words for a person, held to the same case table as the server's helper so both
// sides write the same text.

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { gridLayerCountWords, layerCompact, layerListWords, layerRangeWords, layerWords } from '../src/data/layer-words'

interface Case {
  fn: string
  args: unknown[]
  expected: string
}

const CASES: Case[] = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'tests', 'fixtures', 'layer_words_cases.json'), 'utf8'))

const TWINS: Record<string, (...args: never[]) => string> = {
  layer_words: layerWords,
  layer_compact: layerCompact,
  layer_range_words: layerRangeWords,
  layer_list_words: layerListWords,
  grid_layer_count_words: gridLayerCountWords,
}

describe('layer words', () => {
  it('has a twin for every function the shared table names', () => {
    expect(CASES.length).toBeGreaterThan(0)
    for (const c of CASES) expect(TWINS[c.fn], c.fn).toBeDefined()
  })

  it.each(CASES.map((c) => [`${c.fn}(${JSON.stringify(c.args)})`, c] as const))('%s reads as the table says', (_, c) => {
    const fn = TWINS[c.fn] as (...args: unknown[]) => string
    expect(fn(...c.args)).toBe(c.expected)
  })
})
