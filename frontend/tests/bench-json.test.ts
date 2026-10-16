import { describe, expect, it } from 'vitest'
import {
  isSoftwareRenderer,
  judgedResultsBlocker,
  nearestRankP95,
  parseBenchResult,
  stripToken,
  summarize,
} from './visual/bench-json'

function benchJson(): Record<string, unknown> {
  return {
    run: { path: '/data/pesto-bench/forecast', name: 'forecast' },
    cache: { warm_dir: '/scratch/forecast/ingest-2' },
    speed_limits: { reopen_seconds: 1.5, slider_fetch_p95_ms: 150, slider_no_fetch_p95_ms: 50 },
    browser_targets: {
      iteration: 3,
      heaviest: { group: 'hk', layer: 2, cells: 1200 },
      pilot_point: { group: 'npfklayer3pp', layer: 2, n_pp: 40 },
    },
  }
}

describe('parseBenchResult', () => {
  it('reads a complete bench result into a target', () => {
    const target = parseBenchResult(benchJson())
    expect(target).toEqual({
      label: 'forecast',
      runDir: '/data/pesto-bench/forecast',
      cacheDir: '/scratch/forecast/ingest-2',
      limits: { reopenMs: 1500, fetchP95Ms: 150, noFetchP95Ms: 50 },
      iteration: 3,
      heaviest: { group: 'hk', layer: 2, cells: 1200 },
      pilotPoint: { group: 'npfklayer3pp', layer: 2, nPp: 40 },
    })
  })

  it('names the exact key path when a key is missing', () => {
    const json = benchJson()
    delete (json.cache as Record<string, unknown>).warm_dir
    expect(() => parseBenchResult(json)).toThrow('bench result is missing cache.warm_dir')
  })

  it('names the key path when a key has the wrong type', () => {
    const json = benchJson()
    ;(json.speed_limits as Record<string, unknown>).slider_fetch_p95_ms = '150'
    expect(() => parseBenchResult(json)).toThrow('speed_limits.slider_fetch_p95_ms')
  })

  it('refuses something that is not an object at all', () => {
    expect(() => parseBenchResult(null)).toThrow('bench result is not a JSON object')
  })

  it('returns null for a heaviest group or pilot-point group the run does not have', () => {
    const json = benchJson()
    const targets = json.browser_targets as Record<string, unknown>
    targets.heaviest = null
    targets.pilot_point = null
    const target = parseBenchResult(json)
    expect(target.heaviest).toBeNull()
    expect(target.pilotPoint).toBeNull()
  })
})

describe('percentiles', () => {
  it('has no p95 for no samples', () => {
    expect(nearestRankP95([])).toBeNull()
  })

  it('takes the nearest rank, whatever order the samples come in', () => {
    expect(nearestRankP95([5, 1, 2, 3, 4])).toBe(5)
    const hundred = Array.from({ length: 100 }, (_, i) => 100 - i)
    expect(nearestRankP95(hundred)).toBe(95)
  })

  it('summarizes count, p50, p95 and max on the same rule', () => {
    expect(summarize([4, 1, 3, 2])).toEqual({ count: 4, p50: 2, p95: 4, max: 4 })
    expect(summarize([])).toEqual({ count: 0, p50: null, p95: null, max: null })
  })

  it('does not reorder the caller\'s samples', () => {
    const samples = [3, 1, 2]
    summarize(samples)
    expect(samples).toEqual([3, 1, 2])
  })
})

describe('isSoftwareRenderer', () => {
  it('is true for the software renderers, in any case', () => {
    expect(isSoftwareRenderer('ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero)))')).toBe(true)
    expect(isSoftwareRenderer('llvmpipe (LLVM 15.0.7, 256 bits)')).toBe(true)
    expect(isSoftwareRenderer('Google SOFTWARE rasterizer')).toBe(true)
  })

  it('is false for a hardware renderer, and for one it cannot read', () => {
    expect(isSoftwareRenderer('ANGLE (Apple, ANGLE Metal Renderer: Apple M4 Max, Unspecified Version)')).toBe(false)
  })
})

describe('stripToken', () => {
  it('removes the token and keeps the path and the other parameters', () => {
    expect(stripToken('http://127.0.0.1:8765/api/run/grid/values?iteration=0&token=abc123&realization=r1')).toBe(
      'http://127.0.0.1:8765/api/run/grid/values?iteration=0&realization=r1',
    )
  })

  it('leaves a url without a token alone', () => {
    expect(stripToken('http://127.0.0.1:8765/api/run/meta?kind=par')).toBe('http://127.0.0.1:8765/api/run/meta?kind=par')
  })

  it('removes a token that is the only parameter', () => {
    expect(stripToken('http://127.0.0.1:8765/?token=abc')).toBe('http://127.0.0.1:8765/')
  })
})

describe('judgedResultsBlocker', () => {
  const file = (runs: Record<string, unknown>) => JSON.stringify({ run_id: '2026-10-09T10:00:00Z', runs })

  it('keeps a file with a judged run in it, naming the run id', () => {
    const why = judgedResultsBlocker(file({ forecast: { judged: true }, other: { judged: false } }))
    expect(why).toContain('judged results')
    expect(why).toContain('2026-10-09T10:00:00Z')
  })

  it('lets a file with only unjudged runs be replaced', () => {
    expect(judgedResultsBlocker(file({ synthetic: { judged: false } }))).toBeNull()
    expect(judgedResultsBlocker(file({}))).toBeNull()
  })

  it('keeps a file it cannot read or understand', () => {
    expect(judgedResultsBlocker('{ not json')).toContain('not valid JSON')
        expect(judgedResultsBlocker('null')).toContain('not a results file')
    expect(judgedResultsBlocker(JSON.stringify({ runs: 5 }))).toContain('not readable')
  })
})
