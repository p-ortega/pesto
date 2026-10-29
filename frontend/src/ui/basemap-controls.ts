// The basemap controls: Add, confirm a world-file placement, type four numbers, Remove, colour and
// field opacity. They report clicks and draw nothing; colour and opacity arrive with the view (D-32).

import type { Extent } from '../data/basemap'

export type BasemapView =
  | { kind: 'none' }
  | { kind: 'busy'; text: string }
  | { kind: 'proposal'; name: string; worldFile: string; extent: Extent; notes: string[] }
  | { kind: 'numbers'; name: string; reason: string; worldFiles: string[]; modelExtent: Extent; error?: string }
  | { kind: 'refused'; reason: string }
  | {
      kind: 'ready'
      name: string
      placedBy: 'world_file' | 'numbers'
      worldFile: string | null
      extent: Extent
      notes: string[]
      colour: boolean
      opacity: number
    }
  | { kind: 'unavailable'; reason: string }
  | { kind: 'failed'; reason: string }

export interface BasemapControlsOptions {
  onAdd(): void
  onConfirm(): void
  onSubmitNumbers(extent: Extent): void
  onCancel(): void
  onRemove(): void
  onColourChange(on: boolean): void
  /** 0 to 1; 0 is the outlines-only mode. */
  onOpacityChange(alpha: number): void
}

export interface BasemapControlsHandle {
  el: HTMLElement
  show(view: BasemapView): void
  dispose(): void
}

export const NOT_FINITE = 'each of the four numbers must be a finite number'

const NUMBER_FIELDS = ['x min', 'x max', 'y min', 'y max'] as const

export function formatCoordinate(value: number): string {
  return String(Number(value.toFixed(3)))
}

export function formatExtent(extent: Extent): string {
  const [x0, x1, y0, y1] = extent.map(formatCoordinate)
  return `x ${x0} to ${x1} · y ${y0} to ${y1}`
}

export function opacityText(percent: number): string {
  return percent === 0 ? 'outlines only' : `${percent}%`
}

/** What the folded basemap card says after "Basemap: ". */
export function basemapSummary(view: BasemapView): string {
  switch (view.kind) {
    case 'none':
      return 'none'
    case 'busy':
      return view.text
    case 'proposal':
      return `place ${view.name}?`
    case 'numbers':
      return `${view.name} needs four numbers`
    case 'ready':
      return view.name
    case 'refused':
    case 'unavailable':
    case 'failed':
      return view.reason
  }
}

/** The typed numbers as an extent, or the reason they cannot be one. */
export function readNumbers(values: readonly string[]): { ok: true; extent: Extent } | { ok: false; reason: string } {
  const numbers = values.map((v) => (v.trim() === '' ? Number.NaN : Number(v)))
  if (numbers.length !== 4 || !numbers.every(Number.isFinite)) return { ok: false, reason: NOT_FINITE }
  const [x0, x1, y0, y1] = numbers
  if (!(x0 < x1)) return { ok: false, reason: 'x min must be less than x max' }
  if (!(y0 < y1)) return { ok: false, reason: 'y min must be less than y max' }
  return { ok: true, extent: [x0, x1, y0, y1] }
}

export function renderBasemapControls(host: HTMLElement, opts: BasemapControlsOptions): BasemapControlsHandle {
  host.textContent = ''
  const el = document.createElement('div')
  el.classList.add('basemap-controls')
  el.setAttribute('role', 'group')
  el.setAttribute('aria-label', 'Basemap')
  host.appendChild(el)

  let disposed = false
  // Typed numbers survive a re-show for the same image, so a server refusal does not wipe them.
  let typed: { name: string; values: string[] } | null = null

  function line(text: string, ...classes: string[]): HTMLDivElement {
    const div = document.createElement('div')
    div.textContent = text
    div.classList.add(...classes)
    el.appendChild(div)
    return div
  }

  function button(text: string, onClick: () => void, parent: HTMLElement = el): HTMLButtonElement {
    const b = document.createElement('button')
    b.type = 'button'
    b.textContent = text
    b.addEventListener('click', () => {
      if (!disposed) onClick()
    })
    parent.appendChild(b)
    return b
  }

  function actions(): HTMLDivElement {
    const row = document.createElement('div')
    row.classList.add('basemap-actions')
    el.appendChild(row)
    return row
  }

  function notes(list: readonly string[]): void {
    for (const note of list) line(note, 'basemap-note')
  }

  function showNumbers(view: Extract<BasemapView, { kind: 'numbers' }>): void {
    line(view.reason, 'basemap-reason')
    if (view.worldFiles.length > 0) {
      line(`world files found: ${view.worldFiles.join(', ')}`, 'basemap-note')
    }
    line(`the model spans ${formatExtent(view.modelExtent)}`, 'basemap-hint')

    const form = document.createElement('form')
    form.classList.add('basemap-numbers')
    form.noValidate = true
    const fields = document.createElement('div')
    fields.classList.add('basemap-number-fields')
    const keep = typed !== null && typed.name === view.name ? typed.values : null
    const inputs = NUMBER_FIELDS.map((label, i) => {
      const wrap = document.createElement('label')
      const text = document.createElement('span')
      text.textContent = label
      const input = document.createElement('input')
      input.type = 'number'
      input.step = 'any'
      input.inputMode = 'decimal'
      input.setAttribute('aria-label', label)
      if (keep) input.value = keep[i]
      wrap.append(text, input)
      fields.appendChild(wrap)
      return input
    })
    const error = document.createElement('div')
    error.classList.add('basemap-warning')
    error.setAttribute('role', 'alert')
    error.textContent = view.error ?? ''
    const row = document.createElement('div')
    row.classList.add('basemap-actions')
    const place = document.createElement('button')
    place.type = 'submit'
    place.textContent = 'Place'
    row.appendChild(place)
    button('Cancel', () => opts.onCancel(), row)
    form.append(fields, error, row)
    el.appendChild(form)
    form.addEventListener('submit', (event) => {
      event.preventDefault()
      submit()
    })

    function submit(): void {
      if (disposed) return
      const values = inputs.map((input) => input.value)
      typed = { name: view.name, values }
      const read = readNumbers(values)
      if (!read.ok) {
        error.textContent = read.reason
        return
      }
      error.textContent = ''
      opts.onSubmitNumbers(read.extent)
    }
  }

  function showReady(view: Extract<BasemapView, { kind: 'ready' }>): void {
    const worldFile = view.worldFile === null ? '' : ` ${view.worldFile}`
    const by =
      view.placedBy === 'world_file'
        ? `basemap placed by world file${worldFile}`
        : 'basemap placed by four numbers you typed'
    line(by, 'basemap-status')
    line(formatExtent(view.extent), 'basemap-extent')
    notes(view.notes)
    button('Remove basemap', () => opts.onRemove())

    const colourLabel = document.createElement('label')
    const colourText = document.createElement('span')
    colourText.textContent = 'Colour'
    const colour = document.createElement('input')
    colour.type = 'checkbox'
    colour.checked = view.colour
    colour.setAttribute('aria-label', 'Colour')
    colour.addEventListener('change', () => {
      if (!disposed) opts.onColourChange(colour.checked)
    })
    colourLabel.append(colour, colourText)
    el.appendChild(colourLabel)

    const opacityLabel = document.createElement('label')
    const opacityName = document.createElement('span')
    opacityName.textContent = 'Field opacity'
    const range = document.createElement('input')
    range.type = 'range'
    range.min = '0'
    range.max = '100'
    range.step = '1'
    range.setAttribute('aria-label', 'Field opacity')
    const start = Math.round(Math.min(1, Math.max(0, view.opacity)) * 100)
    range.value = String(start)
    const reading = document.createElement('span')
    reading.classList.add('basemap-opacity-reading')
    reading.textContent = opacityText(start)
    range.setAttribute('aria-valuetext', reading.textContent)
    range.addEventListener('input', () => {
      if (disposed) return
      const percent = Number(range.value)
      reading.textContent = opacityText(percent)
      range.setAttribute('aria-valuetext', reading.textContent)
      opts.onOpacityChange(percent / 100)
    })
    opacityLabel.append(opacityName, range, reading)
    el.appendChild(opacityLabel)
  }

  function show(view: BasemapView): void {
    if (disposed) return
    el.textContent = ''
    el.setAttribute('data-view', view.kind)
    if (view.kind !== 'numbers') typed = null
    switch (view.kind) {
      case 'none':
        button('Add basemap', () => opts.onAdd())
        return
      case 'busy':
        line(view.text, 'basemap-muted')
        return
      case 'proposal': {
        line(`Place ${view.name} by its world file ${view.worldFile}?`, 'basemap-status')
        line(formatExtent(view.extent), 'basemap-extent')
        notes(view.notes)
        const row = actions()
        button('Confirm', () => opts.onConfirm(), row)
        button('Cancel', () => opts.onCancel(), row)
        return
      }
      case 'numbers':
        showNumbers(view)
        return
      case 'refused':
        line(view.reason, 'basemap-warning')
        button('Add basemap', () => opts.onAdd())
        return
      case 'ready':
        showReady(view)
        return
      case 'unavailable':
        line(view.reason, 'basemap-warning')
        button('Remove basemap', () => opts.onRemove())
        return
      case 'failed':
        line(view.reason, 'basemap-muted')
        return
    }
  }

  show({ kind: 'none' })

  return {
    el,
    show,
    dispose() {
      disposed = true
      host.textContent = ''
    },
  }
}
