// Pure helpers for the slider check: reading the JSON `pesto bench` writes,
// nearest-rank percentiles, and two small guards. No node imports, so vitest
// can test it without a browser.

export interface HeaviestTarget {
  group: string
  layer: number
  cells: number
}

export interface PilotPointTarget {
  group: string
  layer: number
  nPp: number
}

export interface BenchTarget {
  label: string
  runDir: string
  cacheDir: string
  limits: { reopenMs: number; fetchP95Ms: number; noFetchP95Ms: number }
  iteration: number
  heaviest: HeaviestTarget | null
  pilotPoint: PilotPointTarget | null
}

export interface Summary {
  count: number
  p50: number | null
  p95: number | null
  max: number | null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function section(parent: Record<string, unknown>, key: string, trail: string): Record<string, unknown> {
  const value = parent[key]
  if (!isRecord(value)) throw new Error(`bench result is missing ${trail}`)
  return value
}

function text(parent: Record<string, unknown>, key: string, trail: string): string {
  const value = parent[key]
  if (typeof value !== 'string' || value === '') throw new Error(`bench result is missing ${trail} (expected text)`)
  return value
}

function num(parent: Record<string, unknown>, key: string, trail: string): number {
  const value = parent[key]
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`bench result is missing ${trail} (expected a number)`)
  }
  return value
}

export function parseBenchResult(json: unknown): BenchTarget {
  if (!isRecord(json)) throw new Error('bench result is not a JSON object')

  const run = section(json, 'run', 'run')
  const cache = section(json, 'cache', 'cache')
  const limits = section(json, 'speed_limits', 'speed_limits')
  const targets = section(json, 'browser_targets', 'browser_targets')

  let heaviest: HeaviestTarget | null = null
  if (targets.heaviest !== null && targets.heaviest !== undefined) {
    const h = section(targets, 'heaviest', 'browser_targets.heaviest')
    heaviest = {
      group: text(h, 'group', 'browser_targets.heaviest.group'),
      layer: num(h, 'layer', 'browser_targets.heaviest.layer'),
      cells: num(h, 'cells', 'browser_targets.heaviest.cells'),
    }
  } else if (targets.heaviest === undefined) {
    throw new Error('bench result is missing browser_targets.heaviest')
  }

  let pilotPoint: PilotPointTarget | null = null
  if (targets.pilot_point !== null && targets.pilot_point !== undefined) {
    const p = section(targets, 'pilot_point', 'browser_targets.pilot_point')
    pilotPoint = {
      group: text(p, 'group', 'browser_targets.pilot_point.group'),
      layer: num(p, 'layer', 'browser_targets.pilot_point.layer'),
      nPp: num(p, 'n_pp', 'browser_targets.pilot_point.n_pp'),
    }
  } else if (targets.pilot_point === undefined) {
    throw new Error('bench result is missing browser_targets.pilot_point')
  }

  return {
    label: text(run, 'name', 'run.name'),
    runDir: text(run, 'path', 'run.path'),
    cacheDir: text(cache, 'warm_dir', 'cache.warm_dir'),
    limits: {
      reopenMs: num(limits, 'reopen_seconds', 'speed_limits.reopen_seconds') * 1000,
      fetchP95Ms: num(limits, 'slider_fetch_p95_ms', 'speed_limits.slider_fetch_p95_ms'),
      noFetchP95Ms: num(limits, 'slider_no_fetch_p95_ms', 'speed_limits.slider_no_fetch_p95_ms'),
    },
    iteration: num(targets, 'iteration', 'browser_targets.iteration'),
    heaviest,
    pilotPoint,
  }
}

// Nearest rank: the smallest sample with at least `fraction` of all samples at or below it.
function nearestRank(sorted: number[], fraction: number): number {
  const rank = Math.max(1, Math.ceil(fraction * sorted.length))
  return sorted[rank - 1]
}

export function nearestRankP95(samples: number[]): number | null {
  if (samples.length === 0) return null
  return nearestRank([...samples].sort((a, b) => a - b), 0.95)
}

export function summarize(samples: number[]): Summary {
  if (samples.length === 0) return { count: 0, p50: null, p95: null, max: null }
  const sorted = [...samples].sort((a, b) => a - b)
  return {
    count: sorted.length,
    p50: nearestRank(sorted, 0.5),
    p95: nearestRank(sorted, 0.95),
    max: sorted[sorted.length - 1],
  }
}

export function isSoftwareRenderer(renderer: string): boolean {
  return /swiftshader|llvmpipe|software/i.test(renderer)
}

// Keeps the path and every other parameter, so a recorded request is still readable.
export function stripToken(url: string): string {
  const absolute = /^[a-z][a-z0-9+.-]*:\/\//i.test(url)
  let parsed: URL
  try {
    parsed = new URL(url, 'http://placeholder.invalid')
  } catch {
    return url.replace(/([?&])token=[^&#]*&?/g, '$1').replace(/[?&]$/, '')
  }
  parsed.searchParams.delete('token')
  return absolute ? parsed.toString() : parsed.pathname + parsed.search + parsed.hash
}
