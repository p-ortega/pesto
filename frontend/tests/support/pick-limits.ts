// The picking speed limits. They must equal SpeedLimits in
// src/pesto/bench/limits.py; tests/bench/test_pick_limits_match.py reads this
// file and fails when they differ. A pesto bench result file can supply them
// instead (PESTO_BENCH_JSON), which is how a run judges by the limits it was
// reported against.

import { readFileSync } from 'node:fs'

export const PICK_LIMITS = { pick_index_build_ms: 1000, pick_p95_ms: 1 } as const

export interface PickLimits {
  pick_index_build_ms: number
  pick_p95_ms: number
}

function limitFrom(limits: Record<string, unknown>, name: keyof PickLimits, file: string): number {
  const value = limits[name]
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${file}: speed_limits.${name} is missing or not a number`)
  }
  return value
}

export function pickLimits(): PickLimits {
  const file = process.env.PESTO_BENCH_JSON
  if (file === undefined || file === '') return { ...PICK_LIMITS }
  const body: unknown = JSON.parse(readFileSync(file, 'utf8'))
  const limits = (body as { speed_limits?: Record<string, unknown> } | null)?.speed_limits
  if (limits === undefined || typeof limits !== 'object') {
    throw new Error(`${file}: no speed_limits in this pesto bench result`)
  }
  return {
    pick_index_build_ms: limitFrom(limits, 'pick_index_build_ms', file),
    pick_p95_ms: limitFrom(limits, 'pick_p95_ms', file),
  }
}
