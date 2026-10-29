// One value per section quad, read from the field the plan already holds, by the plan's own join
// rules (D-08, D-09). Only the quads in the answer are visited, so no nlay x ncells array is
// built (D-27), and every quad left uncoloured is counted for the legend.

import type { ParIdentity } from './parmap'
import type { SectionAnswer } from './section'

export interface SectionValues {
  /** One per quad; NaN draws no fill. */
  values: Float32Array
  /** An active quad with no value from the drawn group: the quiet footprint fill (D-36). */
  noValue: Uint8Array
  /** A quad drawn as the hairline outline. */
  absence: Uint8Array
  /** Two or more rows of the drawn group on the quad's cell and layer (D-09). */
  contestedMask: Uint8Array
  /** Finite values outside the limits; they fall in the end classes (D-10). */
  beyondLimits: number
  /** Quads idomain marks inactive or pass-through that the field holds a value for (D-34). */
  inactiveWithValue: number
  /** Other absent quads the field holds a value for: no usable thickness, or outside the model with no idomain. */
  absentWithValue: number
  contested: number
  /** The zero-based layers the drawn group sets anywhere in the model, sorted. */
  layersSet: number[]
}

// Statuses 1 and 2 are idomain 0 and idomain -1; 3 to 5 come from the elevations.
function idomainAbsence(status: number): boolean {
  return status === 1 || status === 2
}

/** The part of the plan's held state the recolour reads; the section view's plan state is one. */
export interface SectionValuesInput {
  /** Block rows when fieldKind is 'block', one value per cell when 'cell'; already scaled. */
  fullField: Float32Array | null
  limits: [number, number]
  fieldKind: 'block' | 'cell'
  drawnGroup: string | null
  ppLayer: number | null
  joined: Array<ParIdentity | null>
  cellArray: Int32Array
  layerArray: Int32Array
  nCells: number
  drawsAsPoints: boolean
  obsActive: boolean
  hasIdomain: boolean
  referenced: Uint8Array | null
}

// A row index per quad (block), -1 for none and -2 for contested.
const NONE = -1
const CONTESTED = -2

export function sectionValues(answer: SectionAnswer, plan: SectionValuesInput): SectionValues {
  const { nlay, nPieces, cell, status } = answer
  const n = nPieces * nlay
  const values = new Float32Array(n).fill(Number.NaN)
  const noValue = new Uint8Array(n)
  const absence = new Uint8Array(n)
  const contestedMask = new Uint8Array(n)
  const nCells = plan.nCells
  const useReferenced = !plan.hasIdomain && plan.referenced !== null

  for (let q = 0; q < n; q++) {
    const c = cell[Math.floor(q / nlay)]
    const outside = useReferenced && !(c >= 0 && c < nCells && plan.referenced![c])
    absence[q] = status[q] !== 0 || outside ? 1 : 0
  }

  // The value each quad would take before absence, NaN where the drawn group gives none.
  const raw = new Float32Array(n).fill(Number.NaN)
  let layersSet: number[] = []
  const field = plan.fullField
  const group = plan.drawnGroup
  const canColour = !plan.obsActive && field !== null && group !== null

  if (canColour && plan.fieldKind === 'block') {
    const inAnswer = new Set<number>()
    for (let p = 0; p < nPieces; p++) inAnswer.add(cell[p])
    const rowAt = new Map<number, number>()
    const layers = new Set<number>()
    for (let i = 0; i < plan.joined.length; i++) {
      if (plan.joined[i]?.pargp !== group) continue
      const l = plan.layerArray[i]
      const c = plan.cellArray[i]
      if (l >= 0) layers.add(l)
      if (!inAnswer.has(c) || c < 0 || c >= nCells || l < 0 || l >= nlay) continue
      const key = l * nCells + c
      rowAt.set(key, rowAt.has(key) ? CONTESTED : i)
    }
    layersSet = Array.from(layers).sort((x, y) => x - y)
    if (!plan.drawsAsPoints) {
      for (let q = 0; q < n; q++) {
        const c = cell[Math.floor(q / nlay)]
        const row = rowAt.get((q % nlay) * nCells + c) ?? NONE
        if (row === CONTESTED) contestedMask[q] = 1
        else if (row !== NONE) raw[q] = field[row]
      }
    }
  } else if (canColour && plan.fieldKind === 'cell' && plan.ppLayer !== null) {
    const ppLayer = plan.ppLayer
    layersSet = [ppLayer]
    if (!plan.drawsAsPoints && ppLayer >= 0 && ppLayer < nlay) {
      for (let p = 0; p < nPieces; p++) {
        const c = cell[p]
        if (c >= 0 && c < field.length) raw[p * nlay + ppLayer] = field[c]
      }
    }
  }

  const lo = Math.min(plan.limits[0], plan.limits[1])
  const hi = Math.max(plan.limits[0], plan.limits[1])
  let beyondLimits = 0
  let inactiveWithValue = 0
  let absentWithValue = 0
  let contested = 0
  for (let q = 0; q < n; q++) {
    const v = raw[q]
    const valued = Number.isFinite(v)
    if (absence[q]) {
      // A contested quad holds values too, so it is counted like a single one.
      const held = valued || contestedMask[q] === 1
      contestedMask[q] = 0
      if (!held) continue
      if (idomainAbsence(status[q])) inactiveWithValue += 1
      else absentWithValue += 1
      continue
    }
    if (contestedMask[q]) {
      contested += 1
      continue
    }
    if (!valued) {
      noValue[q] = 1
      continue
    }
    values[q] = v
    if (v < lo || v > hi) beyondLimits += 1
  }

  return { values, noValue, absence, contestedMask, beyondLimits, inactiveWithValue, absentWithValue, contested, layersSet }
}

function joinList(items: number[]): string {
  if (items.length === 1) return String(items[0])
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`
}

/** Says which layers one group sets, or null when it sets every layer or none (D-09). */
export function layersSetLine(group: string, layers: number[], nlay: number): string | null {
  const distinct = Array.from(new Set(layers)).sort((x, y) => x - y)
  if (distinct.length === 0) return null
  let every = true
  for (let l = 0; l < nlay; l++) {
    if (!distinct.includes(l)) {
      every = false
      break
    }
  }
  if (every) return null
  const which = distinct.length === 1 ? `layer ${distinct[0]} only` : `layers ${joinList(distinct)}`
  return `group ${group} sets ${which}; other layers have no value from this group`
}
