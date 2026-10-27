// The time axis follows the site's time kind and names it.

import { scaleUtc } from 'd3-scale'
import { describe, expect, it } from 'vitest'
import { formatTimeValue, timeAxis, timeAxisTitle } from '../src/ui/charts/time-axis'

const DAY = 86_400_000

describe('timeAxis', () => {
  it('reads a datetime site as UTC dates, with tick pixels equal to scaleUtc', () => {
    const { axis, title } = timeAxis('datetime', [18262, 18628], [0, 400])
    expect(title).toBe('date')
    expect(axis.ticks.length).toBeGreaterThan(1)
    expect(axis.ticks[0].label).toContain('2020')

    const scale = scaleUtc()
      .domain([new Date(18262 * DAY), new Date(18628 * DAY)])
      .range([0, 400])
    const count = Math.max(2, Math.floor(400 / 90))
    const expected = scale.ticks(count)
    expect(axis.ticks.map((t) => t.value * DAY)).toEqual(expected.map((d) => d.getTime()))
    expect(axis.ticks.map((t) => t.px)).toEqual(expected.map((d) => scale(d)))
    expect(axis.toPx(18262)).toBe(0)
    expect(axis.toPx(18628)).toBe(400)
  })

  it('names a numeric site model time in days', () => {
    const { axis, title } = timeAxis('numeric', [0, 365], [0, 400])
    expect(title).toBe('model time (days)')
    expect(axis.toPx(365)).toBe(400)
  })

  it('puts an ordinal site on whole positions only and says so', () => {
    const none = timeAxis('ordinal (no time found)', [0, 9], [0, 300])
    expect(none.title).toBe('position in site (no time found)')
    expect(none.axis.ticks.length).toBeGreaterThan(1)
    for (const tick of none.axis.ticks) expect(Number.isInteger(tick.value)).toBe(true)

    const short = timeAxis('ordinal (no time found)', [0, 3], [0, 300])
    for (const tick of short.axis.ticks) expect(Number.isInteger(tick.value)).toBe(true)

    expect(timeAxis('ordinal (mixed time kinds)', [0, 9], [0, 300]).title).toBe(
      'position in site (mixed time kinds)',
    )
  })

  it('treats an unknown kind as positions with the kind in brackets, never as dates', () => {
    const { axis, title } = timeAxis('lunar', [0, 9], [0, 300])
    expect(title).toBe('position in site (lunar)')
    for (const tick of axis.ticks) expect(tick.label).toBe(String(tick.value))
  })
})

describe('timeAxisTitle and formatTimeValue', () => {
  it('gives each kind its own wording', () => {
    expect(timeAxisTitle('datetime')).toBe('date')
    expect(timeAxisTitle('numeric')).toBe('model time (days)')
    expect(timeAxisTitle('ordinal (no time found)')).toBe('position in site (no time found)')
  })

  it('formats a value in the words of its kind', () => {
    expect(formatTimeValue('datetime', 18262)).toBe('2020-01-01')
    expect(formatTimeValue('datetime', 18262.5)).toBe('2020-01-01 12:00 UTC')
    expect(formatTimeValue('numeric', 12.5)).toBe('day 12.5 (model time)')
    expect(formatTimeValue('ordinal (no time found)', 3)).toBe('position 3 in site (no time found)')
    expect(formatTimeValue('lunar', 3)).toBe('position 3 in site (lunar)')
  })

  it('says so when there is no value instead of printing a date for it', () => {
    expect(formatTimeValue('datetime', Number.NaN)).toBe('no value')
  })
})
