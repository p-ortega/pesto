// The style the parameter field is drawn in: the user's request, and the
// effective style resolveStyle derives from it. The layer, the legend and the
// controls all read the one effective object, so the legend can never show
// steps the map does not draw (D-02).

import { classEdges, classOf, symmetricLimits, type LimitsMode, type ValueScale } from './colormap'

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

export const SYMMETRIC_LOG_REASON = 'a log scale has no zero to centre on'
export const SYMMETRIC_MANUAL_REASON = 'manual limits are used as typed'
export const SYMMETRIC_TURNED_OFF_PREFIX = 'symmetric was turned off: '

export const TEXTURE_CLASSES_NOTE = 'texture fill uses 7 classes; pick 9 or 11 here'
export const TEXTURE_DOTS_REASON = 'texture fill applies to cell fields; this group is drawn as dots'
export const OVERLAY_SUPPRESSED_REASON = 'off while texture fill is on: its lines would look like the fill'
/** The classes texture fill takes when the request is continuous (D-13). */
export const TEXTURE_DEFAULT_CLASSES = 7

/** Why the symmetric switch cannot apply under this scale and limits mode, or null when it can (D-09, D-10). */
export function symmetricRefusal(scale: ValueScale, limitsMode: LimitsMode): string | null {
  if (scale === 'log10') return SYMMETRIC_LOG_REASON
  if (limitsMode === 'manual') return SYMMETRIC_MANUAL_REASON
  return null
}

/**
 * Turns a symmetric request off when the scale or limits mode refuses it, and
 * names the reason so the caller can say so. Anything else passes unchanged.
 */
export function followLimits(
  style: FieldStyle,
  scale: ValueScale,
  limitsMode: LimitsMode,
): { style: FieldStyle; turnedOff: string | null } {
  const refusal = symmetricRefusal(scale, limitsMode)
  if (!style.symmetric || refusal === null) return { style, turnedOff: null }
  return { style: { ...style, symmetric: false }, turnedOff: refusal }
}

export function resolveStyle(requested: FieldStyle, ctx: StyleContext): { effective: EffectiveStyle; notes: StyleNotes } {
  const symmetricNote = symmetricRefusal(ctx.scale, ctx.limitsMode)
  const symmetric = requested.symmetric && symmetricNote === null
  // A dot group has no cell fill to texture; the reason is given even unasked so the switch can say why it is grey (D-31).
  const textureNote = ctx.drawsAsPoints ? TEXTURE_DOTS_REASON : requested.texture && requested.classes === 0 ? TEXTURE_CLASSES_NOTE : null
  const texture = requested.texture && !ctx.drawsAsPoints
  let classes: number = texture && requested.classes === 0 ? TEXTURE_DEFAULT_CLASSES : requested.classes
  let classesNote: string | null = null
  if (classes > 0) {
    // Classes split the limits that are drawn, so a symmetric [3, 3] still steps across -3..3.
    const [lo, hi] = symmetric ? symmetricLimits(ctx.limits) : ctx.limits
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
    effective: { classes, symmetric, texture },
    notes: { classes: classesNote, symmetric: symmetricNote, texture: textureNote },
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
