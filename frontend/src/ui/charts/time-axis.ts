// The x axis of a site's time series, chosen by the site's time kind. The
// server sends datetime sites as days since 1970-01-01 (UTC), numeric sites
// as model days and ordinal sites as positions. The axis says which one it
// is and never reads a position as a date.

import { scaleLinear, scaleUtc } from 'd3-scale'
import { linearAxis, type Axis } from './axes'

const MS_PER_DAY = 86_400_000
const TICK_PX = 90

function dayToDate(days: number): Date {
  return new Date(days * MS_PER_DAY)
}

function dateToDay(date: Date): number {
  return date.getTime() / MS_PER_DAY
}

// "ordinal (no time found)" gives "no time found"; any other kind is shown as sent.
function bracketed(kind: string): string {
  const match = /^ordinal \((.*)\)$/.exec(kind)
  return match ? match[1] : kind
}

function integerAxis(domain: [number, number], range: [number, number]): Axis {
  const scale = scaleLinear().domain(domain).range(range)
  return {
    toPx: (value) => scale(value),
    invert: (px) => scale.invert(px),
    ticks: scale
      .ticks(5)
      .filter(Number.isInteger)
      .map((value) => ({ value, label: String(value), px: scale(value) })),
  }
}

function utcAxis(domain: [number, number], range: [number, number]): Axis {
  const scale = scaleUtc().domain(domain.map(dayToDate)).range(range)
  const count = Math.max(2, Math.floor(Math.abs(range[1] - range[0]) / TICK_PX))
  const format = scale.tickFormat(count)
  return {
    toPx: (days) => scale(dayToDate(days)),
    invert: (px) => dateToDay(scale.invert(px)),
    ticks: scale.ticks(count).map((date) => ({
      value: dateToDay(date),
      label: format(date),
      px: scale(date),
    })),
  }
}

export function timeAxisTitle(kind: string): string {
  if (kind === 'datetime') return 'date'
  if (kind === 'numeric') return 'model time (days)'
  return `position in site (${bracketed(kind)})`
}

export function timeAxis(
  kind: string,
  domain: [number, number],
  range: [number, number],
): { axis: Axis; title: string } {
  const title = timeAxisTitle(kind)
  if (kind === 'datetime') return { axis: utcAxis(domain, range), title }
  if (kind === 'numeric') return { axis: linearAxis(domain, range), title }
  // An ordinal or unrecognised kind is positions, so ticks sit on whole positions.
  return { axis: integerAxis(domain, range), title }
}

export function formatTimeValue(kind: string, value: number): string {
  if (!Number.isFinite(value)) return 'no value'
  if (kind === 'datetime') {
    const iso = dayToDate(value).toISOString()
    return Number.isInteger(value) ? iso.slice(0, 10) : `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`
  }
  if (kind === 'numeric') return `day ${value} (model time)`
  return `position ${value} in site (${bracketed(kind)})`
}
