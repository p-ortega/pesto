// D-04's legend: the ramp, its numeric end values, the scale in use and
// whether it was inferred from partrans, the limits mode in force, the
// drawn group, and the contested and no-value cell counts. Every string
// reaches the DOM through textContent alone, so a group name carrying
// markup renders as text.

import { ramp, type ColormapName, type LimitsMode, type ValueScale } from '../gl/colormap'

export interface LegendOptions {
  colormap: ColormapName
  reverse: boolean
  limits: [number, number]
  scale: ValueScale
  /** True when the scale in use is still partrans's own inferred default
   *  -- false once the user has explicitly picked a scale. */
  scaleInferred: boolean
  limitsMode: LimitsMode
  group: string
  contested: number
  noValue: number
  /** Set for an x/y group drawn as dots: the count on this layer. */
  points?: number
}

const LIMITS_LABEL: Record<LimitsMode, string> = {
  robust: 'Robust 2-98%',
  minmax: 'Min-max',
  manual: 'Manual',
}

function formatEndValue(value: number): string {
  if (!Number.isFinite(value)) return '—'
  return value.toPrecision(4)
}

/**
 * Renders the seven fields D-04 fixes into `el`. Passing `null` clears the
 * element and renders nothing at all -- with no field drawn there is never
 * a legend describing nothing; the designed-state notice carries the
 * reason instead.
 */
export function renderLegend(el: HTMLElement, opts: LegendOptions | null): void {
  el.textContent = ''
  if (opts === null) {
    return
  }
  el.classList.add('floating')

  // The ramp swatch: a CSS gradient sampled from the same 256-entry table
  // the GPU draws with, so the legend can never show a different ramp
  // than the one actually on screen.
  const table = ramp(opts.colormap, opts.reverse)
  const stops: string[] = []
  for (let i = 0; i < 256; i += 32) {
    const r = table[i * 4]
    const g = table[i * 4 + 1]
    const b = table[i * 4 + 2]
    stops.push(`rgb(${r}, ${g}, ${b}) ${((i / 255) * 100).toFixed(0)}%`)
  }
  const swatch = document.createElement('div')
  swatch.setAttribute('aria-hidden', 'true')
  swatch.style.height = '8px'
  swatch.style.width = '128px'
  swatch.style.background = `linear-gradient(to right, ${stops.join(', ')})`
  el.appendChild(swatch)

  // The end values, fixed width so the block does not reflow as the user
  // drags -- a value exactly at the limit is what the ramp actually shows
  // at that end.
  const endValues = document.createElement('div')
  endValues.classList.add('legend-figures')
  const lowEl = document.createElement('span')
  lowEl.classList.add('tabular-nums')
  lowEl.style.display = 'inline-block'
  lowEl.style.width = '7ch'
  lowEl.textContent = formatEndValue(opts.limits[0])
  const highEl = document.createElement('span')
  highEl.classList.add('tabular-nums')
  highEl.style.display = 'inline-block'
  highEl.style.width = '7ch'
  highEl.textContent = formatEndValue(opts.limits[1])
  endValues.appendChild(lowEl)
  endValues.appendChild(highEl)
  el.appendChild(endValues)

  // The scale in use, and whether it was inferred from partrans rather
  // than chosen explicitly -- the log default is an inference and §1
  // requires pesto to say what it inferred.
  const scaleLine = document.createElement('div')
  scaleLine.classList.add('label')
  const scaleWord = opts.scale === 'log10' ? 'Log₁₀' : 'Linear'
  scaleLine.textContent = opts.scaleInferred ? `Scale: ${scaleWord} (inferred from partrans)` : `Scale: ${scaleWord}`
  el.appendChild(scaleLine)

  const limitsLine = document.createElement('div')
  limitsLine.classList.add('label')
  limitsLine.textContent = `Limits: ${LIMITS_LABEL[opts.limitsMode]}`
  el.appendChild(limitsLine)

  // The drawn group's name -- truncated with an ellipsis, the full name
  // carried in title, same convention as the readout and the Params
  // panel. textContent only, so a non-ASCII or markup-bearing name from
  // the control file renders exactly as recorded, never as markup.
  const groupLine = document.createElement('div')
  groupLine.classList.add('label', 'truncate')
  groupLine.textContent = opts.group
  groupLine.title = opts.group
  el.appendChild(groupLine)

  const countsLine = document.createElement('div')
  countsLine.classList.add('label', 'legend-figures')
  if (opts.points !== undefined) {
    const pointsEl = document.createElement('span')
    pointsEl.classList.add('tabular-nums')
    pointsEl.textContent = `${opts.points} points on this layer`
    countsLine.appendChild(pointsEl)
    el.appendChild(countsLine)
    return
  }
  // The two absence counts: D-06's contested mark and the no-parameter
  // case, side by side.
  const contestedEl = document.createElement('span')
  contestedEl.classList.add('tabular-nums')
  contestedEl.textContent = `${opts.contested} cells contested`
  const noValueEl = document.createElement('span')
  noValueEl.classList.add('tabular-nums')
  noValueEl.textContent = `${opts.noValue} cells no value`
  countsLine.appendChild(contestedEl)
  countsLine.appendChild(noValueEl)
  el.appendChild(countsLine)
}
