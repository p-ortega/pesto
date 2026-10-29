// The Data card: what is drawn. Every row has a fixed place, and a row stays out of sight until
// a control is rendered into it (style.css, .card-row:has(> .card-row-control:empty)).

import { layerCompact } from '../data/layer-words'
import { cardRow, type CardRow } from './card-rows'

export interface DataCardRows {
  colourBy: CardRow
  group: CardRow
  iteration: CardRow
  layer: CardRow
  allLayers: CardRow
  statistic: CardRow
  realization: CardRow
  time: CardRow
}

function colourSource(row: CardRow, source: 'par' | 'obs'): CardRow {
  row.row.setAttribute('data-colour-source', source)
  return row
}

export function renderDataCard(body: HTMLElement): DataCardRows {
  body.classList.add('card-rows')
  return {
    colourBy: cardRow(body, 'Colour by'),
    group: cardRow(body, 'Group'),
    iteration: cardRow(body, 'Iteration'),
    layer: cardRow(body, 'Layer'),
    // The All layers checkbox names itself, so its row has no label.
    allLayers: colourSource(cardRow(body, ''), 'obs'),
    statistic: cardRow(body, 'Statistic'),
    realization: colourSource(cardRow(body, 'Realization'), 'par'),
    time: colourSource(cardRow(body, 'Time'), 'obs'),
  }
}

/** What the Data card's folded line is built from: the drawn parameter field, or the observation colouring. */
export type DataSummaryInput =
  | {
      source: 'par'
      group: string | null
      layer: number | null
      /** The realization name or statistic, in the words the footer and readout use. */
      drawn: string
      /** How many iterations the run holds; the iteration is named only with two or more. */
      iterations: number
      iteration: number
    }
  | {
      source: 'obs'
      group: string | null
      statistic: string
      layer: number | null
      allLayers: boolean
      /** The shown time without its `i of n` part; null leaves the time out. */
      time: string | null
    }

/** `G1 · layer 4 (3) · base · iteration 3`, or `gw_head · mean residual · layer 1 (0) · 2001-01-01`. */
export function dataSummary(input: DataSummaryInput): string {
  const group = input.group === null || input.group === '' ? 'no group' : input.group
  const layer = `layer ${layerCompact(input.layer)}`
  if (input.source === 'obs') {
    const parts = [group, input.statistic, input.allLayers ? 'all layers' : layer]
    if (input.time !== null && input.time !== '') parts.push(input.time)
    return parts.join(' · ')
  }
  const parts = [group, layer, input.drawn]
  if (input.iterations >= 2) parts.push(`iteration ${input.iteration}`)
  return parts.join(' · ')
}
