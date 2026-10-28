// How base is drawn and named on every chart and legend. It holds no colour:
// base always takes the series colour of its own iteration (D-17).

export const BASE_STYLE = Object.freeze({
  lineWidth: 2.5,
  markerRadius: 4.5,
  label: 'base',
  legend: 'base: the bold line, in the colour of its iteration',
})

export function baseLegendFor(iteration: number, present: boolean): string {
  return present ? BASE_STYLE.legend : `no base realization in iteration ${iteration}`
}
