// D-04's legend: the ramp, its numeric end values, the scale in use and
// whether it was inferred from partrans, the limits mode in force, the
// drawn group, and the contested and no-value cell counts. Every string
// reaches the DOM through textContent alone, so a group name carrying
// markup renders as text.

import {
  classColour,
  classEdges,
  ramp,
  swatchCssAngle,
  textureAngles,
  type ColormapName,
  type LimitsMode,
  type ValueScale,
} from '../gl/colormap'
import { formatEdge, type EffectiveStyle, type StyleNotes } from '../gl/field-style'

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
  /** Set for an interpolated field: cells it paints that idomain marks inactive. */
  inactiveDrawn?: number
  /** The effective style the layer draws with; absent means continuous. */
  style?: EffectiveStyle
  styleNotes?: StyleNotes
  /** True while the field is drawn see-through over a basemap, so its colours no longer match the ramp. */
  blended?: boolean
}

const LIMITS_LABEL: Record<LimitsMode, string> = {
  robust: 'Robust 2–98%',
  minmax: 'Min–max',
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

  const table = ramp(opts.colormap, opts.reverse)
  const classes = opts.style?.classes ?? 0
  if (classes > 0) {
    renderClasses(el, table, classes, opts.limits, opts.style?.texture ?? false)
  } else {
    renderRamp(el, table, opts.limits)
  }
  renderLines(el, opts)
}

// One swatch per class from classColour, the function the shader's texel
// indices come from, and one edge value per class boundary (D-06, D-07).
// Under patterns each swatch is ink lines at its step angle over the surface (D-15).
// Rows the edge numbers take turns over: two up to 5 steps, more beyond, so about 4rem of a 15rem body is each number's.
export function edgeRows(n: number): number {
  return Math.max(2, Math.ceil((4 * n) / 11))
}

function renderClasses(el: HTMLElement, table: Uint8Array, n: number, limits: [number, number], texture: boolean): void {
  // One grid of half-columns with spares at each end: edge j is centred on line 2j+r+1, where swatch j starts.
  // Edges take turns over r rows, so each number gets r swatches of width inside the 240px card body;
  // r grows with the step count so an edge number like 0.00267 clears its same-row neighbour.
  const rows = edgeRows(n)
  const grid = document.createElement('div')
  grid.classList.add('legend-class-grid')
  grid.style.display = 'grid'
  grid.style.width = '100%'
  grid.style.gridTemplateColumns = `repeat(${2 * n + 2 * rows}, 1fr)`
  grid.style.columnGap = '0'
  const angles = textureAngles(n)
  for (let k = 0; k < n; k++) {
    const swatch = document.createElement('span')
    swatch.classList.add('legend-class')
    swatch.setAttribute('aria-hidden', 'true')
    swatch.style.gridRow = '1'
    swatch.style.gridColumn = `${2 * k + rows + 1} / span 2`
    if (texture) {
      swatch.style.height = '12px'
      swatch.style.boxSizing = 'border-box'
      swatch.style.border = '1px solid var(--hairline)'
      swatch.style.background =
        `repeating-linear-gradient(${swatchCssAngle(angles[k])}deg, var(--ink-primary) 0 1px, transparent 1px 4px), var(--surface)`
    } else {
      const [r, g, b] = classColour(k, n, table)
      swatch.style.height = '8px'
      swatch.style.background = `rgb(${r}, ${g}, ${b})`
    }
    grid.appendChild(swatch)
  }

  classEdges(limits, n).forEach((value, j) => {
    const edge = document.createElement('span')
    edge.classList.add('legend-edge', 'tabular-nums')
    edge.style.gridRow = String(2 + (j % rows))
    edge.style.gridColumn = `${2 * j + 1} / span ${2 * rows}`
    edge.style.textAlign = 'center'
    edge.style.whiteSpace = 'nowrap'
    edge.style.padding = '0 2px'
    edge.textContent = formatEdge(value)
    grid.appendChild(edge)
  })
  el.appendChild(grid)
}

function renderRamp(el: HTMLElement, table: Uint8Array, limits: [number, number]): void {
  // The ramp swatch: a CSS gradient sampled from the same 256-entry table
  // the GPU draws with, so the legend can never show a different ramp
  // than the one actually on screen.
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

  // The end values, at least 7ch so the block does not reflow as the user
  // drags, and wider for a long label so the two never run together -- a value exactly at the limit is what the ramp actually shows
  // at that end.
  const endValues = document.createElement('div')
  endValues.classList.add('legend-figures')
  const lowEl = document.createElement('span')
  lowEl.classList.add('tabular-nums')
  lowEl.style.display = 'inline-block'
  lowEl.style.minWidth = '7ch'
  lowEl.style.whiteSpace = 'nowrap'
  lowEl.textContent = formatEndValue(limits[0])
  const highEl = document.createElement('span')
  highEl.classList.add('tabular-nums')
  highEl.style.display = 'inline-block'
  highEl.style.minWidth = '7ch'
  highEl.style.whiteSpace = 'nowrap'
  highEl.textContent = formatEndValue(limits[1])
  endValues.appendChild(lowEl)
  endValues.appendChild(highEl)
  el.appendChild(endValues)
}

function renderLines(el: HTMLElement, opts: LegendOptions): void {
  if (opts.styleNotes?.classes) {
    const noteLine = document.createElement('div')
    noteLine.classList.add('label', 'legend-keep')
    noteLine.textContent = opts.styleNotes.classes
    el.appendChild(noteLine)
  }

  // Read from the effective style only, so the legend never claims limits that are not drawn (D-11).
  if (opts.style?.symmetric) {
    const symmetricLine = document.createElement('div')
    symmetricLine.classList.add('label')
    symmetricLine.textContent = 'centred on zero'
    el.appendChild(symmetricLine)
  }

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

  if (opts.blended) {
    const blendedLine = document.createElement('div')
    blendedLine.classList.add('label', 'legend-keep')
    blendedLine.textContent = 'blended — colours approximate'
    el.appendChild(blendedLine)
  }

  // The drawn group's name -- truncated with an ellipsis, the full name
  // carried in title, same convention as the readout and the Params
  // panel. textContent only, so a non-ASCII or markup-bearing name from
  // the control file renders exactly as recorded, never as markup.
  const groupLine = document.createElement('div')
  groupLine.classList.add('label', 'truncate', 'legend-name')
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
  // A zero count is no warning, so the folded legend leaves it out and keeps the line on one row.
  if (opts.contested === 0) contestedEl.classList.add('legend-zero')
  if (opts.noValue === 0) noValueEl.classList.add('legend-zero')
  countsLine.appendChild(contestedEl)
  countsLine.appendChild(noValueEl)
  if (opts.contested > 0 || opts.noValue > 0) countsLine.classList.add('legend-keep')
  el.appendChild(countsLine)

  if (typeof opts.inactiveDrawn === 'number' && opts.inactiveDrawn > 0) {
    const inactiveLine = document.createElement('div')
    inactiveLine.classList.add('label', 'tabular-nums', 'legend-keep')
    inactiveLine.textContent = `${opts.inactiveDrawn} cells inactive in idomain, still drawn`
    el.appendChild(inactiveLine)
  }
}
