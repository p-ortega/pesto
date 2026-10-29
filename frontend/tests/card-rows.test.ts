// @vitest-environment jsdom
//
// One row of a card's label-and-control grid, and the Data card's fixed rows.

import { describe, expect, it } from 'vitest'
import { cardRow } from '../src/ui/card-rows'
import { renderDataCard } from '../src/ui/data-card'

describe('cardRow', () => {
  it('appends a row holding the label text and an empty control cell, and returns all three', () => {
    const host = document.createElement('div')
    const { row, label, control } = cardRow(host, 'Layer')
    expect(host.lastElementChild).toBe(row)
    expect(row.tagName).toBe('DIV')
    expect(row.classList.contains('card-row')).toBe(true)
    expect(label.classList.contains('card-row-label')).toBe(true)
    expect(label.classList.contains('label')).toBe(true)
    expect(label.textContent).toBe('Layer')
    expect(control.classList.contains('card-row-control')).toBe(true)
    expect(control.childNodes.length).toBe(0)
    expect(row.children[0]).toBe(label)
    expect(row.children[1]).toBe(control)
  })

  it('keeps an empty label empty and puts text in through textContent', () => {
    const host = document.createElement('div')
    const { label } = cardRow(host, '<b>x</b>')
    expect(label.querySelector('b')).toBeNull()
    expect(label.textContent).toBe('<b>x</b>')
    expect(cardRow(host, '').label.textContent).toBe('')
  })
})

describe('renderDataCard', () => {
  it('appends the eight rows in order and returns them by name', () => {
    const body = document.createElement('div')
    const rows = renderDataCard(body)
    const labels = Array.from(body.querySelectorAll(':scope > .card-row > .card-row-label')).map((el) => el.textContent)
    expect(labels).toEqual(['Colour by', 'Group', 'Iteration', 'Layer', '', 'Statistic', 'Realization', 'Time'])
    const order = [
      rows.colourBy,
      rows.group,
      rows.iteration,
      rows.layer,
      rows.allLayers,
      rows.statistic,
      rows.realization,
      rows.time,
    ].map((r) => r.row)
    expect(Array.from(body.children)).toEqual(order)
  })

  it('tags the realization row for parameters, and the all-layers and time rows for observations', () => {
    const body = document.createElement('div')
    const rows = renderDataCard(body)
    expect(rows.realization.row.getAttribute('data-colour-source')).toBe('par')
    expect(rows.allLayers.row.getAttribute('data-colour-source')).toBe('obs')
    expect(rows.time.row.getAttribute('data-colour-source')).toBe('obs')
    for (const row of [rows.colourBy, rows.group, rows.iteration, rows.layer, rows.statistic]) {
      expect(row.row.hasAttribute('data-colour-source')).toBe(false)
    }
  })

  it('leaves every control cell empty for its control to fill', () => {
    const body = document.createElement('div')
    renderDataCard(body)
    for (const control of body.querySelectorAll('.card-row-control')) expect(control.childNodes.length).toBe(0)
  })
})
