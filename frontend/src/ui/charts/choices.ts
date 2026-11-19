// What the user chose on each kind of chart: scale, range and shown parts.
// Kept for the page session only, so a new site or group opens the way the last one was left.

export type ScaleKind = 'linear' | 'log'
export type RangeKind = 'all' | 'observed'
export type SeriesPart = 'first' | 'last' | 'observed' | 'noise' | 'base'

export interface ChartChoices {
  /** `options` is whether a site plot's row of switches is open in the side panel. */
  series: { scale: ScaleKind; range: RangeKind; show: Record<SeriesPart, boolean>; options: boolean }
  oneToOne: { scale: ScaleKind }
  residual: { scale: ScaleKind }
  parameter: { scale: ScaleKind }
}

function defaults(): ChartChoices {
  return {
    series: { scale: 'linear', range: 'all', show: { first: true, last: true, observed: true, noise: true, base: true }, options: false },
    oneToOne: { scale: 'linear' },
    residual: { scale: 'linear' },
    parameter: { scale: 'linear' },
  }
}

export const chartChoices: ChartChoices = defaults()

/** Only for tests: puts every choice back to its default. */
export function resetChartChoices(): void {
  Object.assign(chartChoices, defaults())
}
