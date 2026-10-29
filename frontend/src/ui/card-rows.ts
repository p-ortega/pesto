// One row of a card's two-column grid: a label on the left, the control cell on the right.

export interface CardRow {
  row: HTMLDivElement
  label: HTMLSpanElement
  control: HTMLDivElement
}

/** Appends a row to `host`. The label is only what the eye reads; each control keeps its own aria-label. */
export function cardRow(host: HTMLElement, label: string): CardRow {
  const row = document.createElement('div')
  row.classList.add('card-row')
  const labelEl = document.createElement('span')
  labelEl.classList.add('label', 'card-row-label')
  labelEl.textContent = label
  const control = document.createElement('div')
  control.classList.add('card-row-control')
  row.append(labelEl, control)
  host.appendChild(row)
  return { row, label: labelEl, control }
}
