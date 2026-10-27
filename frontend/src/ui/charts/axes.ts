export interface AxisTick {
  value: number
  label: string
  px: number
}

export interface Axis {
  toPx(value: number): number
  ticks: AxisTick[]
}

export function linearAxis(_domain: [number, number], _range: [number, number], _tickCount = 5): Axis {
  return { toPx: () => 0, ticks: [] }
}

export function logAxis(_nativeDomain: [number, number], _range: [number, number]): Axis | null {
  return null
}
