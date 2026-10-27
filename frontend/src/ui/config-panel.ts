// The Config tab: one row per setup fact (D-15) with its value and source, and every
// reading under a warning when sources disagree (D-14). Nothing is fetched here.

import { factDisagrees, type ConfigFact, type ConfigReading, type ConfigPayload } from '../data/config'
import { makeFocusable, renderNotice } from './chrome'
import { formatBytes } from './progress'

export interface ConfigPanelOptions {
  config: ConfigPayload | null
}

export interface ConfigPanelHandle {
  onShow(): void
  onHide(): void
}

interface Line {
  text: string
  /** Shown in its own span next to the text; null when the text already names it. */
  source: string | null
  title: string
  muted: boolean
}

function line(r: ConfigReading, text: string, muted: boolean, source: string | null = r.source): Line {
  return { text, source, title: r.evidence, muted }
}

function unique(items: string[]): string[] {
  return Array.from(new Set(items))
}

function isFileReading(r: ConfigReading): boolean {
  return r.extra !== null && typeof r.extra.name === 'string' && typeof r.extra.size_bytes === 'number'
}

// The localization file is shown by name and size; the server's own text also has the time.
function fileText(r: ConfigReading, labelled: boolean): string {
  const extra = r.extra
  if (extra === null || !isFileReading(r)) return r.shown
  const base = `${String(extra.name)}, ${formatBytes(Number(extra.size_bytes))}`
  if (!labelled) return base
  return extra.now === true ? `now: ${base}` : `at the ingest: ${base}`
}

function readingText(fact: ConfigFact, r: ConfigReading): string {
  if (fact.key !== 'localization') return r.shown
  const changed = fact.readings.some((other) => other.extra?.now === true)
  if (isFileReading(r)) return fileText(r, changed)
  return r.extra?.now === true ? `now: ${r.shown}` : r.shown
}

function onOff(r: ConfigReading): string {
  return r.value === true ? 'on' : r.value === false ? 'off' : r.shown
}

interface RowParts {
  headline: Line | null
  lines: Line[]
}

function baseParts(fact: ConfigFact, disagree: boolean): RowParts {
  const cache = fact.readings.filter((r) => r.source === 'cache')
  const others = fact.readings.filter((r) => r.source !== 'cache')
  const lines = cache.map((r) => line(r, r.shown, false))
  for (const r of others) {
    lines.push(disagree && r.value !== null ? line(r, `${r.source} says ${r.shown}`, false, null) : line(r, r.shown, true))
  }
  return { headline: lines.shift() ?? null, lines }
}

function generalParts(fact: ConfigFact, disagree: boolean): RowParts {
  const valued = fact.readings.filter((r) => r.value !== null)
  const supporting = fact.readings.filter((r) => r.value === null)
  const lines: Line[] = []
  let headline: Line
  if (valued.length > 0) {
    const first = valued[0]
    const sources = disagree ? [first.source] : unique(valued.map((r) => r.source))
    const text = fact.key === 'localization' ? onOff(first) : first.shown
    headline = { text, source: sources.join(', '), title: first.evidence, muted: false }
    if (disagree) {
      for (const r of valued.slice(1)) lines.push(line(r, `${r.source} says ${r.shown}`, false, null))
    }
    // The headline for localization is on or off, so the readings behind it stay listed.
    if (fact.key === 'localization') {
      const behind = disagree ? valued.slice(0, 1) : valued
      lines.unshift(...behind.map((r) => line(r, r.shown, true)))
    }
  } else {
    const first = supporting.shift() as ConfigReading
    headline = line(first, readingText(fact, first), false)
  }
  for (const r of supporting) lines.push(line(r, readingText(fact, r), true))
  // The file can be hundreds of megabytes, so pesto only states it (CONF-02).
  if (fact.key === 'localization' && fact.readings.some(isFileReading)) {
    lines.push({ text: 'pesto did not read this file', source: null, title: '', muted: true })
  }
  return { headline, lines }
}

function lookedForParts(fact: ConfigFact): RowParts {
  const lines: Line[] = []
  if (fact.looked_for.length > 0) {
    lines.push({ text: 'pesto looked for:', source: null, title: '', muted: true })
    for (const place of fact.looked_for) lines.push({ text: place, source: null, title: '', muted: true })
  }
  return { headline: { text: 'not found', source: null, title: '', muted: false }, lines }
}

function appendParts(parent: HTMLElement, entry: Line): void {
  const text = document.createElement('span')
  text.classList.add('config-value')
  text.textContent = entry.text
  parent.appendChild(text)
  if (entry.source) {
    const source = document.createElement('span')
    source.classList.add('config-source')
    source.textContent = entry.source
    parent.appendChild(source)
  }
}

function appendLine(parent: HTMLElement, entry: Line): void {
  const el = document.createElement('div')
  el.classList.add('config-line')
  if (entry.muted) el.classList.add('config-muted')
  if (entry.title !== '') el.title = entry.title
  appendParts(el, entry)
  parent.appendChild(el)
}

function renderFactRow(list: HTMLElement, fact: ConfigFact): void {
  const row = document.createElement('div')
  row.classList.add('config-row')
  row.dataset.fact = fact.key
  const evidence = fact.readings.filter((r) => r.evidence !== '').map((r) => `${r.source}: ${r.evidence}`)
  if (evidence.length > 0) row.title = evidence.join('\n')

  const disagree = factDisagrees(fact)
  const parts =
    fact.readings.length === 0
      ? lookedForParts(fact)
      : fact.key === 'base'
        ? baseParts(fact, disagree)
        : generalParts(fact, disagree)

  const main = document.createElement('div')
  main.classList.add('config-main')
  const label = document.createElement('span')
  label.classList.add('label', 'config-label')
  label.textContent = fact.label
  main.appendChild(label)
  if (parts.headline !== null) appendParts(main, parts.headline)
  row.appendChild(main)

  if (disagree) {
    const warning = document.createElement('div')
    renderNotice(warning, { title: 'Sources disagree', tone: 'warning' })
    row.appendChild(warning)
  }
  for (const entry of parts.lines) appendLine(row, entry)

  // "not found" is the server's note when it has nothing else to say; the row already says it.
  if (fact.note !== null && !(fact.readings.length === 0 && fact.note === 'not found')) {
    appendLine(row, { text: fact.note, source: null, title: '', muted: true })
  }
  list.appendChild(row)
}

function noteFor(config: ConfigPayload | null): { title: string; detail?: string; tone: 'info' | 'warning' } | null {
  if (config === null) {
    return {
      title: "This run's configuration could not be read",
      detail: 'The setup facts come from the run’s cached configuration.',
      tone: 'warning',
    }
  }
  const facts = config.facts ?? []
  if (facts.length > 0) return null
  return {
    title: 'No setup facts are stored for this run',
    detail: config.facts_note ?? 'Run the ingest again to read them.',
    tone: 'info',
  }
}

export function renderConfigPanel(el: HTMLElement, opts: ConfigPanelOptions): ConfigPanelHandle {
  el.textContent = ''
  el.classList.add('surface', 'config-panel')

  const title = document.createElement('div')
  title.classList.add('heading')
  title.textContent = 'Config'
  el.appendChild(title)

  const note = noteFor(opts.config)
  if (note !== null) {
    const host = document.createElement('div')
    renderNotice(host, note)
    el.appendChild(host)
  } else {
    const list = document.createElement('div')
    list.classList.add('scroll-pane', 'config-list')
    makeFocusable(list, 'Run setup facts')
    for (const fact of opts.config?.facts ?? []) renderFactRow(list, fact)
    el.appendChild(list)
  }

  return { onShow: () => undefined, onHide: () => undefined }
}
