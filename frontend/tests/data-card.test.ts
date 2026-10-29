// The Data card's folded line: what the map draws, in the words the footer and readout use,
// with the layer in its compact both-numbers form.

import { describe, expect, it } from 'vitest'
import { dataSummary } from '../src/ui/data-card'

describe('dataSummary for a parameter field', () => {
  const par = { source: 'par' as const, group: 'G1', layer: 3, drawn: 'base', iterations: 1, iteration: 0 }

  it('names the group, the layer in both numbers and the drawn realization', () => {
    expect(dataSummary(par)).toBe('G1 · layer 4 (3) · base')
  })

  it('names the iteration only when the run holds two or more', () => {
    expect(dataSummary({ ...par, iterations: 2, iteration: 3 })).toBe('G1 · layer 4 (3) · base · iteration 3')
    expect(dataSummary({ ...par, iterations: 1, iteration: 3 })).toBe('G1 · layer 4 (3) · base')
  })

  it('names a statistic in place of a realization', () => {
    expect(dataSummary({ ...par, drawn: 'mean' })).toBe('G1 · layer 4 (3) · mean')
  })

  it('says no group before one is chosen and layer unknown when the layer cannot be told', () => {
    expect(dataSummary({ ...par, group: null })).toBe('no group · layer 4 (3) · base')
    expect(dataSummary({ ...par, group: '' })).toBe('no group · layer 4 (3) · base')
    expect(dataSummary({ ...par, layer: null })).toBe('G1 · layer unknown · base')
    expect(dataSummary({ ...par, layer: -1 })).toBe('G1 · layer unknown · base')
  })

  it('passes a group name through untouched, digits included', () => {
    expect(dataSummary({ ...par, group: 'npfklayer3pp' })).toBe('npfklayer3pp · layer 4 (3) · base')
  })
})

describe('dataSummary for the observation colouring', () => {
  const obs = {
    source: 'obs' as const,
    group: 'gw_head',
    statistic: 'mean residual',
    layer: 0,
    allLayers: false,
    time: '2001-01-01',
  }

  it('names the group, the statistic, the layer and the time', () => {
    expect(dataSummary(obs)).toBe('gw_head · mean residual · layer 1 (0) · 2001-01-01')
  })

  it('says all layers in place of the layer when the box is ticked', () => {
    expect(dataSummary({ ...obs, allLayers: true })).toBe('gw_head · mean residual · all layers · 2001-01-01')
  })

  it('leaves the time out when there is none', () => {
    expect(dataSummary({ ...obs, time: null })).toBe('gw_head · mean residual · layer 1 (0)')
  })

  it('says no group and layer unknown the same way', () => {
    expect(dataSummary({ ...obs, group: null, layer: null })).toBe('no group · mean residual · layer unknown · 2001-01-01')
  })
})
