// Sibling groups for the section: groups whose names differ only in the digits after "layer", so
// one property split one group per layer fills the whole section. The name only says who is a
// sibling; the layer each one fills is read from the data, never from those digits.

import type { PpIndex } from './fields'
import { layerRangeWords, layerWords } from './layer-words'
import type { ParIdentity } from './parmap'

const LAYER_DIGITS = /layer(\d+)/gi

export type SiblingKey = { key: string } | { key: null; reason: string | null }

/** The family key, with the digits after "layer" (any case) replaced by "#"; null when there is no such run or more than one. */
export function siblingKey(group: string): SiblingKey {
  const runs = Array.from(group.matchAll(LAYER_DIGITS))
  if (runs.length === 0) return { key: null, reason: null }
  if (runs.length > 1) {
    return { key: null, reason: `group ${group} has digits after "layer" in ${runs.length} places, so the section does not look for its sibling groups` }
  }
  const run = runs[0]
  const start = (run.index ?? 0) + 'layer'.length
  return { key: `${group.slice(0, start)}#${group.slice(start + run[1].length)}` }
}

export interface SiblingInput {
  /** Every group the run names, in any order; repeats are ignored. */
  groups: readonly string[]
  ppIndex: PpIndex
  joined: Array<ParIdentity | null>
  cellArray: Int32Array
  layerArray: Int32Array
  nlay: number
  /** True for a group placed as dots, which the section shows no value for. */
  isPointGroup(group: string): boolean
}

export interface SiblingMember {
  group: string
  /** 'cell' for an interpolated group (one value per cell), 'block' for one placed by its par_cell rows. */
  kind: 'block' | 'cell'
  /** Zero-based layers inside the grid, sorted. */
  layers: number[]
}

export interface SiblingPlan {
  key: string
  /** Every sibling that fills at least one layer, the picked group included. */
  members: SiblingMember[]
  /** Per layer, the groups that fill it, sorted; two or more is a contested layer. */
  fillers: string[][]
  /** Siblings left out, and layers named outside the grid, each with its reason. */
  notes: string[]
}

/** The picked group's family and the layer each one fills; null when it has no sibling. */
export function planSiblings(picked: string, input: SiblingInput): SiblingPlan | null {
  const own = siblingKey(picked)
  if (own.key === null) return null
  const key = own.key
  const family = Array.from(new Set(input.groups.filter((g) => g === picked || siblingKey(g).key === key)))
  if (!family.includes(picked)) family.push(picked)
  if (family.length < 2) return null
  family.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))

  const interpolated = new Map(input.ppIndex.groups.map((g) => [g.group, g]))
  const blockLayers = new Map<string, Set<number>>()
  const wanted = new Set(family.filter((g) => !interpolated.has(g)))
  for (let i = 0; i < input.joined.length; i++) {
    const g = input.joined[i]?.pargp
    if (g === undefined || !wanted.has(g) || input.cellArray[i] < 0 || input.layerArray[i] < 0) continue
    let held = blockLayers.get(g)
    if (held === undefined) blockLayers.set(g, (held = new Set()))
    held.add(input.layerArray[i])
  }

  const members: SiblingMember[] = []
  const notes: string[] = []
  const fillers: string[][] = Array.from({ length: input.nlay }, () => [])
  for (const group of family) {
    const entry = interpolated.get(group)
    let kind: 'block' | 'cell'
    let named: number[]
    if (entry !== undefined) {
      kind = 'cell'
      named = [entry.layer]
    } else if (input.isPointGroup(group)) {
      notes.push(`group ${group} is placed as dots, so the section shows no value for it`)
      continue
    } else {
      kind = 'block'
      named = Array.from(blockLayers.get(group) ?? []).sort((a, b) => a - b)
      if (named.length === 0) {
        const refused = input.ppIndex.not_interpolable.find((r) => r.group === group)
        const why = refused === undefined ? '' : ` (its pilot points were not interpolated: ${refused.reason})`
        notes.push(`group ${group} has no pilot-point layer and no parameter placed on a cell, so it fills no layer${why}`)
        continue
      }
    }
    const inside = named.filter((l) => Number.isInteger(l) && l >= 0 && l < input.nlay)
    const outside = named.filter((l) => !inside.includes(l))
    if (outside.length > 0) {
      notes.push(`group ${group} names ${layerRangeWords(outside)}, which this grid of ${input.nlay} layers does not have`)
    }
    if (inside.length === 0) continue
    members.push({ group, kind, layers: inside })
    for (const l of inside) fillers[l].push(group)
  }
  return { key, members, fillers, notes }
}

function groupWords(groups: readonly string[]): string {
  if (groups.length <= 1) return groups.join('')
  return `${groups.slice(0, -1).join(', ')} and ${groups[groups.length - 1]}`
}

/** The line for a layer two or more siblings fill; neither is picked. */
export function contestedLine(layer: number, groups: readonly string[]): string {
  return `${layerWords(layer)} is contested: ${groupWords(groups)} ${groups.length === 2 ? 'both' : 'all'} fill it; no value drawn`
}

export interface LegendEntry {
  text: string
  /** The full mapping, for a tooltip; absent when the text says it all. */
  title?: string
}

export interface StackStatus {
  /** Layers whose group's field is still being read. */
  loading: number[]
  failed: Array<{ group: string; layers: number[]; reason: string }>
}

/** The legend lines of a stacked section: who fills which layer, what is contested, missing, loading or failed. */
export function stackLegend(plan: SiblingPlan, status: StackStatus): LegendEntry[] {
  const nlay = plan.fillers.length
  const filled: number[] = []
  const unfilled: number[] = []
  const mapping: string[] = []
  for (let l = 0; l < nlay; l++) {
    const groups = plan.fillers[l]
    if (groups.length === 0) unfilled.push(l)
    else filled.push(l)
    if (groups.length === 1) mapping.push(`${layerWords(l)}: ${groups[0]}`)
    else if (groups.length > 1) mapping.push(`${layerWords(l)}: ${groups.join(' and ')} (contested)`)
    else mapping.push(`${layerWords(l)}: no group`)
  }
  const n = plan.members.length
  const entries: LegendEntry[] = []
  if (filled.length > 0) {
    entries.push({
      text: `${plan.key}: ${layerRangeWords(filled)} from ${n} ${n === 1 ? 'group' : 'groups'}`,
      title: mapping.join('\n'),
    })
  }
  if (unfilled.length > 0) entries.push({ text: `no group of ${plan.key} fills ${layerRangeWords(unfilled)}` })
  for (let l = 0; l < nlay; l++) {
    const groups = plan.fillers[l]
    if (groups.length > 1) entries.push({ text: contestedLine(l, groups) })
  }
  if (status.loading.length > 0) entries.push({ text: `reading ${layerRangeWords(status.loading)}…` })
  for (const f of status.failed) {
    const verb = new Set(f.layers).size === 1 ? 'is' : 'are'
    entries.push({ text: `${f.group} could not be read, so ${layerRangeWords(f.layers)} ${verb} drawn with no value: ${f.reason}` })
  }
  for (const note of plan.notes) entries.push({ text: note })
  return entries
}

export interface SiblingFieldRequest {
  kind: 'block' | 'cell'
  /** Ignored for 'block': one block field holds every group. */
  group: string
  iteration: number
  stat: string
  realization: string | null
}

export type SiblingFieldState = { state: 'loading' } | { state: 'ok'; raw: Float32Array } | { state: 'failed'; reason: string }

export function siblingFieldKey(r: SiblingFieldRequest): string {
  const real = r.stat === 'value' ? r.realization : null
  return JSON.stringify([r.kind, r.kind === 'cell' ? r.group : null, r.iteration, r.stat, real])
}

interface Entry {
  request: SiblingFieldRequest
  state: SiblingFieldState
  controller: AbortController | null
}

/**
 * The sibling fields of one section, read a few at a time. Only what the last `want` named is
 * kept, so a change of iteration, statistic or family lets the old fields go.
 */
export class SiblingFields {
  private entries = new Map<string, Entry>()
  private queue: string[] = []
  private active = 0

  constructor(
    private readonly load: (request: SiblingFieldRequest, signal: AbortSignal) => Promise<Float32Array>,
    private readonly onSettled: () => void,
    private readonly maxConcurrent = 3,
  ) {}

  get(request: SiblingFieldRequest): SiblingFieldState | undefined {
    return this.entries.get(siblingFieldKey(request))?.state
  }

  /** Keeps and reads exactly these fields; anything else held or out is dropped. */
  want(requests: readonly SiblingFieldRequest[]): void {
    const keys = new Map(requests.map((r) => [siblingFieldKey(r), r]))
    for (const [key, entry] of this.entries) {
      if (keys.has(key)) continue
      this.drop(key, entry)
    }
    this.queue = this.queue.filter((key) => keys.has(key))
    for (const [key, request] of keys) {
      if (this.entries.has(key)) continue
      this.entries.set(key, { request, state: { state: 'loading' }, controller: null })
      this.queue.push(key)
    }
    this.pump()
  }

  /** Stops every read and forgets what did not land, so showing the section again retries it. */
  stop(): void {
    for (const [key, entry] of this.entries) {
      if (entry.state.state !== 'ok') this.drop(key, entry)
    }
    this.queue = []
  }

  clear(): void {
    for (const [key, entry] of this.entries) this.drop(key, entry)
    this.queue = []
  }

  private drop(key: string, entry: Entry): void {
    entry.controller?.abort()
    this.entries.delete(key)
  }

  private pump(): void {
    while (this.active < this.maxConcurrent && this.queue.length > 0) {
      const key = this.queue.shift()!
      const entry = this.entries.get(key)
      if (entry === undefined || entry.controller !== null) continue
      const controller = new AbortController()
      entry.controller = controller
      this.active += 1
      void this.load(entry.request, controller.signal).then(
        (raw) => this.settle(key, entry, { state: 'ok', raw }),
        (error: unknown) => this.settle(key, entry, { state: 'failed', reason: error instanceof Error ? error.message : String(error) }),
      )
    }
  }

  private settle(key: string, entry: Entry, state: SiblingFieldState): void {
    this.active -= 1
    // A dropped read is neither drawn nor reported; only the entry still held may land.
    const current = this.entries.get(key) === entry && !entry.controller?.signal.aborted
    if (current) {
      entry.state = state
      entry.controller = null
    }
    this.pump()
    if (current) this.onSettled()
  }
}
