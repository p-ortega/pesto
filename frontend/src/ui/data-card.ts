// The Data card: what is drawn. Every row has a fixed place, and a row stays out of sight until
// a control is rendered into it (style.css, .card-row:has(> .card-row-control:empty)).

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
