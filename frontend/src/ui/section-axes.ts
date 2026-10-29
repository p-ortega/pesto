// The section's frame, drawn on a 2D canvas over it: distance from A across the bottom, elevation
// up the left, A and B at the ends of the line, and a dashed outline over the plan's layer in every
// piece (D-19, D-21, D-35, D-40). It reads only the camera and the held answer, so a lost graphics
// context costs it nothing. Colours come from tokens and every word goes through fillText.

import { scaleLinear } from 'd3-scale'
import type { SectionAnswer } from '../data/section'
import { readColorToken } from '../gl/color-token'
import type { SectionCamera, SectionInset } from '../gl/section-camera'
import type { Chart2D } from './charts/histogram'

/** The chart kit's context plus the two calls a turned title needs. */
export type SectionAxes2D = Chart2D & Pick<CanvasRenderingContext2D, 'translate' | 'rotate'>

/** What an axis says when the grid records no length unit; no unit is ever guessed (D-35). */
export const UNKNOWN_UNITS = 'model units'
/** Room for the axes, in CSS pixels; the section's fit keeps clear of it. */
export const AXIS_LEFT_CSS_PX = 64
export const AXIS_BOTTOM_CSS_PX = 44
/** About one tick per this many CSS pixels; d3 then picks round values near that count. */
export const TICK_SPACING_CSS_PX = 80

const FONT_CSS_PX = 11
const TICK_CSS_PX = 4
const END_MARK_CSS_PX = 10

export function distanceTitle(units: string | null): string {
  return `distance from A (${units ?? UNKNOWN_UNITS})`
}

export function elevationTitle(units: string | null): string {
  return `elevation (${units ?? UNKNOWN_UNITS})`
}

export function tickCount(pixels: number, ratio: number): number {
  return Math.max(2, Math.floor(pixels / (TICK_SPACING_CSS_PX * ratio)))
}

/** The inset the section's fit leaves for the axes, in canvas pixels, right of a left band of
 *  `bandCss` CSS pixels that the map's cards cover (LD-4). */
export function axesInset(ratio: number, bandCss = 0): SectionInset {
  return { left: (bandCss + AXIS_LEFT_CSS_PX) * ratio, right: 0, top: 0, bottom: AXIS_BOTTOM_CSS_PX * ratio }
}

export interface SectionAxesPaint {
  camera: SectionCamera
  answer: SectionAnswer
  /** The plan's layer, outlined in every piece; out of range draws no band. */
  planLayer: number
  width: number
  height: number
  /** The left band the last fit kept clear, in CSS px; the elevation axis is drawn right of it. */
  bandCss?: number
}

export interface SectionAxesOptions {
  /** The positioned box holding the map canvas; the overlay goes in it. */
  area: HTMLElement
  /** The overlay's 2D context; tests pass a recording one, since jsdom has none. */
  context?: (overlay: HTMLCanvasElement) => SectionAxes2D | null
}

export interface SectionAxesHandle {
  paint(input: SectionAxesPaint): void
  setVisible(on: boolean): void
  dispose(): void
}

function cssColour(name: string): string {
  const [r, g, b, a] = readColorToken(name)
  return `rgba(${Math.round(r * 255)}, ${Math.round(g * 255)}, ${Math.round(b * 255)}, ${a})`
}

export function renderSectionAxes(opts: SectionAxesOptions): SectionAxesHandle {
  const overlay = document.createElement('canvas')
  overlay.classList.add('section-axes-overlay')
  overlay.setAttribute('aria-hidden', 'true')
  overlay.hidden = true
  opts.area.appendChild(overlay)
  const getContext = opts.context ?? ((el: HTMLCanvasElement) => el.getContext('2d') as SectionAxes2D | null)

  function band(ctx: SectionAxes2D, { camera, answer, planLayer }: SectionAxesPaint, ratio: number): void {
    if (!(Number.isInteger(planLayer) && planLayer >= 0 && planLayer < answer.nlay)) return
    const rows = answer.nlay + 1
    ctx.save()
    ctx.strokeStyle = cssColour('--ink-primary')
    ctx.lineWidth = 1.5 * ratio
    ctx.setLineDash([4 * ratio, 3 * ratio])
    for (let p = 0; p < answer.nPieces; p++) {
      const top = answer.z[p * rows + planLayer]
      const bottom = answer.z[p * rows + planLayer + 1]
      // A piece with no finite elevation is already drawn and counted as absence.
      if (!Number.isFinite(top) || !Number.isFinite(bottom)) continue
      const [x0, y0] = camera.worldToScreen(answer.s0[p], top)
      const [x1, y1] = camera.worldToScreen(answer.s1[p], bottom)
      ctx.strokeRect(x0, y0, x1 - x0, y1 - y0)
    }
    ctx.restore()
  }

  function axes(ctx: SectionAxes2D, { camera, answer, width, height, bandCss = 0 }: SectionAxesPaint, ratio: number): void {
    const bandLeft = bandCss * ratio
    const left = (bandCss + AXIS_LEFT_CSS_PX) * ratio
    const base = height - AXIS_BOTTOM_CSS_PX * ratio
    const tick = TICK_CSS_PX * ratio
    const font = `${FONT_CSS_PX * ratio}px system-ui, sans-serif`
    const axisColour = cssColour('--axis')
    const labelColour = cssColour('--ink-secondary')

    // The strips the fit keeps clear, filled so a panned section never runs under the labels.
    ctx.fillStyle = cssColour('--page-plane')
    ctx.fillRect(0, base, width, height - base)
    ctx.fillRect(0, 0, left, base)

    ctx.strokeStyle = axisColour
    ctx.lineWidth = ratio
    ctx.setLineDash([])
    ctx.beginPath()
    ctx.moveTo(left, base)
    ctx.lineTo(width, base)
    ctx.moveTo(left, 0)
    ctx.lineTo(left, base)
    ctx.stroke()

    const distance = scaleLinear().domain([camera.screenToWorld(left, 0)[0], camera.screenToWorld(width, 0)[0]]).range([left, width])
    const sCount = tickCount(width - left, ratio)
    const sFormat = distance.tickFormat(sCount)
    const elevation = scaleLinear().domain([camera.screenToWorld(0, base)[1], camera.screenToWorld(0, 0)[1]]).range([base, 0])
    const zCount = tickCount(base, ratio)
    const zFormat = elevation.tickFormat(zCount)

    ctx.font = font
    ctx.fillStyle = labelColour
    ctx.textAlign = 'center'
    ctx.textBaseline = 'top'
    ctx.beginPath()
    for (const value of distance.ticks(sCount)) {
      const x = distance(value)
      ctx.moveTo(x, base)
      ctx.lineTo(x, base + tick)
      ctx.fillText(sFormat(value), x, base + tick + 2 * ratio)
    }
    ctx.textAlign = 'right'
    ctx.textBaseline = 'middle'
    for (const value of elevation.ticks(zCount)) {
      const y = elevation(value)
      ctx.moveTo(left - tick, y)
      ctx.lineTo(left, y)
      ctx.fillText(zFormat(value), left - tick - 2 * ratio, y)
    }
    ctx.stroke()

    // A and B at 0 and the line's length, whether or not the mesh reaches them (D-40).
    ctx.fillStyle = cssColour('--ink-primary')
    ctx.strokeStyle = cssColour('--ink-primary')
    ctx.font = `600 ${FONT_CSS_PX * ratio}px system-ui, sans-serif`
    ctx.textAlign = 'center'
    ctx.textBaseline = 'bottom'
    for (const [letter, s] of [
      ['A', 0],
      ['B', answer.line.length],
    ] as const) {
      const [x] = camera.worldToScreen(s, 0)
      if (x < left || x > width) continue
      ctx.beginPath()
      ctx.moveTo(x, base - END_MARK_CSS_PX * ratio)
      ctx.lineTo(x, base)
      ctx.stroke()
      ctx.fillText(letter, x, base - END_MARK_CSS_PX * ratio - 2 * ratio)
    }

    ctx.font = font
    ctx.fillStyle = labelColour
    ctx.textAlign = 'center'
    ctx.textBaseline = 'bottom'
    ctx.fillText(distanceTitle(answer.lengthUnits), (left + width) / 2, height - 2 * ratio)
    ctx.save()
    ctx.translate(bandLeft + 2 * ratio, base / 2)
    ctx.rotate(-Math.PI / 2)
    ctx.textBaseline = 'top'
    ctx.fillText(elevationTitle(answer.lengthUnits), 0, 0)
    ctx.restore()
  }

  return {
    paint(input) {
      if (overlay.width !== input.width) overlay.width = input.width
      if (overlay.height !== input.height) overlay.height = input.height
      const ctx = getContext(overlay)
      if (ctx === null) return
      const ratio = window.devicePixelRatio || 1
      ctx.clearRect(0, 0, overlay.width, overlay.height)
      ctx.save()
      band(ctx, input, ratio)
      axes(ctx, input, ratio)
      ctx.restore()
    },
    setVisible(on) {
      overlay.hidden = !on
    },
    dispose() {
      overlay.remove()
    },
  }
}
