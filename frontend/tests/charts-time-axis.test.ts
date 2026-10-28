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

describe('timeAxis invert', () => {
  it('turns a pixel on a datetime axis back into the same day value toPx took', () => {
    const { axis } = timeAxis('datetime', [18262, 18628], [0, 400])
    expect(axis.invert(0)).toBe(18262)
    expect(axis.invert(400)).toBe(18628)
    for (const days of [18262, 18300.25, 18444.5, 18628]) {
      expect(Math.abs(axis.invert(axis.toPx(days)) - days)).toBeLessThan(1e-6)
    }
  })

  it('turns a pixel on a numeric axis back into model days', () => {
    const { axis } = timeAxis('numeric', [0, 365], [0, 400])
    for (const days of [0, 12.5, 200, 365]) expect(Math.abs(axis.invert(axis.toPx(days)) - days)).toBeLessThan(1e-9)
  })

  it('turns a pixel on an ordinal axis back into a position', () => {
    const { axis } = timeAxis('ordinal (no time found)', [0, 9], [0, 300])
    expect(axis.invert(150)).toBe(4.5)
    for (const pos of [0, 3, 9]) expect(Math.abs(axis.invert(axis.toPx(pos)) - pos)).toBeLessThan(1e-9)
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
