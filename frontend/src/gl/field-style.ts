// The style the parameter field is drawn in: the user's request, and the
// effective style resolveStyle derives from it. The layer, the legend and the
// controls all read the one effective object, so the legend can never show
// steps the map does not draw (D-02).

import { classEdges, classOf, type LimitsMode, type ValueScale } from './colormap'

export const CLASS_CHOICES = [0, 7, 9, 11] as const
export type ClassCount = (typeof CLASS_CHOICES)[number]

export function isClassCount(value: unknown): value is ClassCount {
  return typeof value === 'number' && (CLASS_CHOICES as readonly number[]).includes(value)
}

/** What the user asked for. classes 0 is continuous. */
export interface FieldStyle {
  classes: ClassCount
  symmetric: boolean
  texture: boolean
}

/** What is drawn: classes 0 is continuous, 1 the one-class case, otherwise 7, 9 or 11. */
export interface EffectiveStyle {
  classes: number
  symmetric: boolean
  texture: boolean
}

/** The visible reason for each setting that is not drawn as asked, or null. */
export interface StyleNotes {
  classes: string | null
  symmetric: string | null
  texture: string | null
}

export interface StyleContext {
  scale: ValueScale
  limitsMode: LimitsMode
  drawsAsPoints: boolean
  /** The limits in the drawn scale. */
  limits: [number, number]
  /** False when the drawn group has no finite value at all. */
  valued: boolean
}

export const DEFAULT_STYLE: FieldStyle = { classes: 0, symmetric: false, texture: false }
export const CONTINUOUS: EffectiveStyle = { classes: 0, symmetric: false, texture: false }

export const ONE_CLASS_EQUAL = 'the limits are equal, so every value falls in one class'
export const ONE_CLASS_EMPTY = 'no cell has a value, so there is nothing to class'

export function resolveStyle(requested: FieldStyle, ctx: StyleContext): { effective: EffectiveStyle; notes: StyleNotes } {
  let classes: number = requested.classes
  let classesNote: string | null = null
  if (classes > 0) {
    const [lo, hi] = ctx.limits
    // Limits that cannot be split draw every value in the ramp middle, the one swatch the legend shows.
    if (!ctx.valued) {
      classes = 1
      classesNote = ONE_CLASS_EMPTY
    } else if (!Number.isFinite(lo) || !Number.isFinite(hi) || !(hi > lo)) {
      classes = 1
      classesNote = ONE_CLASS_EQUAL
    }
  }
  return {
    effective: { classes, symmetric: false, texture: false },
    notes: { classes: classesNote, symmetric: null, texture: null },
  }
}

/** A class edge as the legend and readout print it: three significant figures. */
export function formatEdge(value: number): string {
  if (!Number.isFinite(value)) return '—'
  return String(Number(value.toPrecision(3)))
}

/**
 * The readout's class line, such as "class 4 of 9 (1.2 to 3.4)", or null when
 * the field is continuous or the value is missing. The value and the limits
 * are in the drawn scale, so on log10 the bracket says so.
 */
export function classLabel(value: number, limits: [number, number], effective: EffectiveStyle, scale: ValueScale): string | null {
  const n = effective.classes
  if (n <= 0 || !Number.isFinite(value)) return null
  const k = classOf(value, limits, n)
  const edges = classEdges(limits, n)
  const prefix = scale === 'log10' ? 'log₁₀ ' : ''
  return `class ${k + 1} of ${n} (${prefix}${formatEdge(edges[k])} to ${formatEdge(edges[k + 1])})`
}
