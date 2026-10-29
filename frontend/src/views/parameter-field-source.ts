// The data half of the map: what a parameter field is made of, how it is
// fetched, and how its cells are classified. The map view draws; this
// module loads and classifies. It renders nothing and reads no page state.

import { ApiError, gridCells, gridPointXy, gridValues, type GridValuesQuery } from '../data/client'
import { layerActiveMask, referencedMask } from '../data/domain'
import {
  EMPTY_PP_INDEX,
  classifyFieldCells,
  fetchPpIndex,
  gridField,
  type PpGroupInfo,
  type PpIndex,
} from '../data/fields'
import { LatestWins } from '../data/latest-wins'
import {
  classifyCells,
  fetchParTable,
  fetchParmap,
  joinBlockToIdentity,
  parseParIdentities,
  type CellClass,
  type ParIdentity,
} from '../data/parmap'
import { hasPosition, isPointGroup } from '../data/points'
import { fetchRealNames, type RealNamesResult } from '../data/reals'
import { fetchKey } from '../data/run'

// The eight statistics the server can serve; the same set the controls offer.
export type Statistic = 'value' | 'mean' | 'std' | 'q05' | 'q25' | 'q50' | 'q75' | 'q95'

export interface FieldRequest {
  iteration: number
  group: string
  kind: 'block' | 'cell'
  stat: Statistic
  realization: string | null
}

export type FieldAnswer = { stale: true } | { stale: false; field: Float32Array; request: FieldRequest }

export interface ParameterTables {
  parmap: Int32Array
  identities: ParIdentity[]
  joined: Array<ParIdentity | null>
  /** The raw table answer, shared with the Params panel so the table is fetched once. */
  parTable: Promise<ArrayBuffer>
}

export interface PointPositions {
  xy: Float32Array | null
  /** Why the positions were left out; null when they were read or the run recorded none. */
  problem: string | null
}

/** Everything that depends on the iteration, read together for one switch. */
export interface IterationData {
  iteration: number
  tables: ParameterTables
  cells: { cell: Int32Array; layer: Int32Array }
  pointXy: PointPositions
  realNames: RealNamesResult
}

export type IterationAnswer = { stale: true } | { stale: false; data: IterationData }

export interface ParameterFieldSource {
  /**
   * Fetches one field. A newer call aborts this one, and an answer that
   * is no longer the newest comes back `{ stale: true }` rather than being
   * returned for drawing. A real failure of the newest call is thrown.
   */
  fetchField(request: FieldRequest): Promise<FieldAnswer>
  /** Aborts the field fetch that is out, if any; its answer comes back stale. */
  cancelField(): void
  /** The same request as fetchField, outside its one slot, so the section can read sibling groups beside the plan. */
  loadField(request: FieldRequest, signal?: AbortSignal): Promise<Float32Array>
  /** The parmap and the parameter table are requested together, in that order. */
  loadParameterTables(iteration: number, signal?: AbortSignal): Promise<ParameterTables>
  /**
   * The ingest always writes an index, empty for a run with no pilot points,
   * so a failed read is a problem the caller must show; the index is then empty.
   */
  loadPpIndex(signal?: AbortSignal): Promise<{ index: PpIndex; problem: string | null }>
  loadCells(iteration: number, signal?: AbortSignal): Promise<{ cell: Int32Array; layer: Int32Array }>
  /** A failed or misshapen read comes back as a problem; the caller says so. */
  loadPointXy(iteration: number, rowCount: number, signal?: AbortSignal): Promise<PointPositions>
  loadRealNames(iteration: number, signal?: AbortSignal): Promise<RealNamesResult>
  /**
   * The tables, cell arrays, point positions and realization names of one
   * iteration, read in that order. A newer call aborts this one and this one
   * then answers `{ stale: true }`. A failed read is thrown.
   */
  loadIteration(iteration: number): Promise<IterationAnswer>
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function createParameterFieldSource(opts: { runId: string | null }): ParameterFieldSource {
  const slot = new LatestWins<Float32Array>()
  const iterationSlot = new LatestWins<IterationData>()

  function loadField(request: FieldRequest, signal?: AbortSignal): Promise<Float32Array> {
    const query: GridValuesQuery =
      request.stat === 'value'
        ? { iteration: request.iteration, realization: request.realization ?? undefined }
        : { iteration: request.iteration, stat: request.stat }
    return request.kind === 'cell' ? gridField({ ...query, group: request.group }, { signal }) : gridValues(query, { signal })
  }

  async function fetchField(request: FieldRequest): Promise<FieldAnswer> {
    const key = fetchKey(opts.runId, request.iteration, request.group, request.kind, request.stat, request.realization)
    const answer = await slot.run(key, (signal) => loadField(request, signal))
    return answer.stale ? { stale: true } : { stale: false, field: answer.value, request }
  }

  async function loadParameterTables(iteration: number, signal?: AbortSignal): Promise<ParameterTables> {
    const parmapRequest = fetchParmap(iteration, { signal })
    const parTable = fetchParTable({ signal })
    parTable.catch(() => {})
    const parmap = await parmapRequest
    const identities = parseParIdentities(await parTable)
    return { parmap, identities, joined: joinBlockToIdentity(parmap, identities), parTable }
  }

  async function loadPpIndex(signal?: AbortSignal): Promise<{ index: PpIndex; problem: string | null }> {
    try {
      return { index: await fetchPpIndex({ signal }), problem: null }
    } catch (error) {
      const reason = error instanceof ApiError ? (error.problem.detail ?? error.problem.title) : describeError(error)
      return { index: EMPTY_PP_INDEX, problem: reason }
    }
  }

  async function loadCells(iteration: number, signal?: AbortSignal): Promise<{ cell: Int32Array; layer: Int32Array }> {
    const cell = await gridCells('cell', iteration, { signal })
    const layer = await gridCells('layer', iteration, { signal })
    return { cell, layer }
  }

  async function loadPointXy(iteration: number, rowCount: number, signal?: AbortSignal): Promise<PointPositions> {
    try {
      const xy = await gridPointXy(iteration, { signal })
      if (xy === null || xy.length === 2 * rowCount) return { xy, problem: null }
      return {
        xy: null,
        problem: `It has ${xy.length} values, not the ${2 * rowCount} the map block needs (an x and a y per row).`,
      }
    } catch (error) {
      return { xy: null, problem: describeError(error) }
    }
  }

  function loadRealNames(iteration: number, signal?: AbortSignal): Promise<RealNamesResult> {
    return fetchRealNames(iteration, { signal })
  }

  async function loadIteration(iteration: number): Promise<IterationAnswer> {
    const answer = await iterationSlot.run(fetchKey(opts.runId, 'iteration', iteration), async (signal) => {
      const tables = await loadParameterTables(iteration, signal)
      const cells = await loadCells(iteration, signal)
      const pointXy = await loadPointXy(iteration, cells.cell.length, signal)
      const realNames = await loadRealNames(iteration, signal)
      return { iteration, tables, cells, pointXy, realNames }
    })
    return answer.stale ? { stale: true } : { stale: false, data: answer.value }
  }

  function cancelField(): void {
    slot.cancel()
  }

  return { fetchField, cancelField, loadField, loadParameterTables, loadPpIndex, loadCells, loadPointXy, loadRealNames, loadIteration }
}

export interface UnmappedEntry {
  group: string
  note: string | null
}

// What pesto recorded about one group's placement (GET /api/run/grid/placement).
export interface RecordedPlacement {
  rule: string
  mapped: number
  total: number
  notes: readonly string[]
}

function recordedNote(group: string, placement: ReadonlyMap<string, RecordedPlacement> | undefined): string | null {
  const recorded = placement?.get(group)
  if (recorded === undefined) return null
  if (recorded.notes.length > 0) return recorded.notes.join('; ')
  if (recorded.rule === 'unmapped') return `${group} — no placement rule matched, placed 0 of ${recorded.total}`
  return `${group} — placement rule ${recorded.rule} placed ${recorded.mapped} of ${recorded.total}`
}

// D-07: a group is drawable when a block row places on a real cell. An unmapped group's note is the
// pilot-point refusal, else what pesto recorded for it, else null when the placement route never named it.
export function computeGroupPlacement(
  identities: ParIdentity[],
  joined: Array<ParIdentity | null>,
  cells: Int32Array,
  ppIndex: PpIndex,
  placement?: ReadonlyMap<string, RecordedPlacement>,
): { drawable: string[]; unmapped: UnmappedEntry[]; interpolated: string[] } {
  const order: string[] = []
  const seen = new Set<string>()
  for (const identity of identities) {
    if (!seen.has(identity.pargp)) {
      seen.add(identity.pargp)
      order.push(identity.pargp)
    }
  }
  const placed = new Set<string>()
  for (let i = 0; i < joined.length; i++) {
    const identity = joined[i]
    if (identity !== null && cells[i] >= 0) placed.add(identity.pargp)
  }
  // An interpolated group draws as a field even when no parameter of it
  // places on a cell; a group the index refused carries the index's reason.
  const interpolated = new Set(ppIndex.groups.map((g) => g.group))
  const refused = new Map(ppIndex.not_interpolable.map((r) => [r.group, r.reason]))
  const drawable: string[] = []
  const unmapped: UnmappedEntry[] = []
  for (const group of order) {
    if (placed.has(group) || interpolated.has(group)) {
      drawable.push(group)
    } else {
      const reason = refused.get(group)
      unmapped.push({ group, note: reason === undefined ? recordedNote(group, placement) : `${group} — ${reason}` })
    }
  }
  return { drawable, unmapped, interpolated: drawable.filter((g) => interpolated.has(g)) }
}

// The drawn group's own partrans, read straight from the D-05 join --
// never a positional guess. A group with no identified row (never reached
// while drawnGroup itself came from this same join) returns null, which
// the scale default treats as linear.
export function partransForGroup(
  joined: Array<ParIdentity | null>,
  group: string,
  identities: ParIdentity[] = [],
): string | null {
  for (const identity of joined) {
    if (identity !== null && identity.pargp === group) return identity.partrans
  }
  // A pilot-point group need not sit in the map block at all; the control
  // table still names its partrans.
  for (const identity of identities) {
    if (identity.pargp === group) return identity.partrans
  }
  return null
}

export function interpolatedEntry(ppIndex: PpIndex, group: string | null): PpGroupInfo | null {
  return ppIndex.groups.find((g) => g.group === group) ?? null
}

// An interpolated group draws its field even when its points carry an x/y.
export function drawsAsPoints(
  fieldKind: 'block' | 'cell',
  drawnGroup: string | null,
  ppIndex: PpIndex,
  joined: Array<ParIdentity | null>,
  pointXy: Float32Array | null,
): boolean {
  if (fieldKind !== 'block' || drawnGroup === null || interpolatedEntry(ppIndex, drawnGroup) !== null) return false
  return isPointGroup(joined, pointXy, drawnGroup)
}

/** Holds the mask of cells some block row names, which does not change once the cell array is read. */
export interface MaskCache {
  referenced: Uint8Array | null
}

// In the model on one layer: the idomain when the grid has one, else any
// cell a block row names, at any layer (the mesh notes say which).
export function activeMask(
  idomain: Int32Array | null,
  cellArray: Int32Array,
  nCells: number,
  layerIndex: number,
  cache: MaskCache,
): Uint8Array {
  if (idomain !== null) return layerActiveMask(idomain, nCells, layerIndex)
  if (cache.referenced === null) cache.referenced = referencedMask(cellArray, nCells)
  return cache.referenced.slice()
}

// A dot group picked on a layer holding none of its dots opens on the lowest layer that does.
export function dotLayerFor(
  group: string,
  input: {
    ppIndex: PpIndex
    joined: Array<ParIdentity | null>
    pointXy: Float32Array | null
    layerArray: Int32Array
    currentLayer: number
  },
): number | null {
  const { ppIndex, joined, pointXy, layerArray, currentLayer } = input
  if (interpolatedEntry(ppIndex, group) !== null || !isPointGroup(joined, pointXy, group)) return null
  let lowest: number | null = null
  for (let row = 0; row < joined.length; row++) {
    if (joined[row]?.pargp !== group || pointXy === null || !hasPosition(pointXy, row)) continue
    const l = layerArray[row]
    if (l === currentLayer) return null
    if (l >= 0 && (lowest === null || l < lowest)) lowest = l
  }
  return lowest
}

// Under dots no cell carries a value, so this quiet fill is what shows the model's shape.
export function footprintMask(classes: CellClass[]): Uint8Array {
  const mask = new Uint8Array(classes.length)
  for (let c = 0; c < classes.length; c++) {
    const kind = classes[c].kind
    mask[c] = kind === 'points' || kind === 'no-parameter' ? 1 : 0
  }
  return mask
}

export interface PerCellInput {
  field: Float32Array
  layerIndex: number
  nCells: number
  fieldKind: 'block' | 'cell'
  /** The group the held field was fetched for. */
  fieldGroup: string | null
  drawnGroup: string | null
  ppIndex: PpIndex
  joined: Array<ParIdentity | null>
  cellArray: Int32Array
  layerArray: Int32Array
  pointXy: Float32Array | null
  idomain: Int32Array | null
  maskCache: MaskCache
}

// Reprojects a full block-order field into grid-cell order, filtered to
// one layer and the drawn group, from classifyCells' own D-06
// classification -- a contested cell gets no value at all (NaN; the
// stripe is its only mark) rather than the last-seen row's value.
export function computePerCell(input: PerCellInput): {
  perCell: Float32Array
  contested: number
  noValue: number
  classes: CellClass[]
} {
  const { field, layerIndex, nCells, fieldKind, fieldGroup, drawnGroup, ppIndex, joined, cellArray, layerArray } = input
  const active = () => activeMask(input.idomain, cellArray, nCells, layerIndex, input.maskCache)
  const entry = fieldKind === 'cell' ? interpolatedEntry(ppIndex, fieldGroup) : null
  if (fieldKind === 'cell' && entry !== null) {
    const mask = active()
    // The field is drawn only on its own layer, so only there does a value put a cell in the model.
    if (layerIndex === entry.layer) {
      for (let c = 0; c < mask.length; c++) {
        if (Number.isFinite(field[c])) mask[c] = 1
      }
    }
    const { classes, noValueCount } = classifyFieldCells(field, mask, entry.layer, layerIndex)
    const perCell = new Float32Array(nCells).fill(Number.NaN)
    for (let c = 0; c < nCells; c++) {
      if (classes[c].kind === 'interpolated') perCell[c] = field[c]
    }
    return { perCell, contested: 0, noValue: noValueCount, classes }
  }
  if (drawsAsPoints(fieldKind, drawnGroup, ppIndex, joined, input.pointXy)) {
    // The dots carry the values; a cell only says which of the group's rows it hosts.
    const hosted = new Map<number, number[]>()
    for (let row = 0; row < joined.length; row++) {
      const c = cellArray[row]
      if (joined[row]?.pargp !== drawnGroup || layerArray[row] !== layerIndex || c < 0 || c >= nCells) continue
      const rows = hosted.get(c)
      if (rows) rows.push(row)
      else hosted.set(c, [row])
    }
    const mask = active()
    const classes: CellClass[] = []
    let noValue = 0
    for (let c = 0; c < nCells; c++) {
      const rows = hosted.get(c)
      if (rows) classes.push({ kind: 'points', rows })
      else if (mask[c]) classes.push({ kind: 'no-parameter' })
      else classes.push({ kind: 'outside-model' })
      if (!rows && mask[c]) noValue += 1
    }
    return { perCell: new Float32Array(nCells).fill(Number.NaN), contested: 0, noValue, classes }
  }
  const { classes, contestedCount, noValueCount } = classifyCells(
    joined,
    cellArray,
    layerArray,
    drawnGroup ?? '',
    layerIndex,
    active(),
  )
  const perCell = new Float32Array(nCells).fill(Number.NaN)
  for (let c = 0; c < nCells; c++) {
    const cls = classes[c]
    if (cls.kind === 'valued') {
      perCell[c] = field[cls.row]
    }
  }
  return { perCell, contested: contestedCount, noValue: noValueCount, classes }
}
