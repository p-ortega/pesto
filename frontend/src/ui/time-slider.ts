// The map's time slider for observation colouring. It steps through one group's exact times and
// tells the caller which step was chosen; it draws nothing. Every string reaches the DOM through
// textContent.

import { formatTimeValue, timeAxisTitle } from './charts/time-axis'

export interface TimeSliderOptions {
  onChange: (index: number) => void
  /** A row inside a labelled card: no floating card of its own and no Time word. */
  bare?: boolean
}

export interface TimeSliderHandle {
  /** `note` is a sentence about how the time was chosen, such as a carry from the last group. */
  show(times: number[], kind: string, stepsBy: 'time' | 'position', index: number, note: string | null, group?: string | null): void
  /** A group whose times cannot be put on one axis: the reason and no slider. */
  refuse(reason: string): void
  hide(): void
  /** Moves the slider without calling onChange. */
  setIndex(index: number): void
  /** A line about the frame being read or why it could not be; null clears it. */
  setStatus(text: string | null): void
  /** The shown time without its place among the times, or null when no time is shown. */
  currentText(): string | null
}

export function renderTimeSlider(host: HTMLElement, opts: TimeSliderOptions): TimeSliderHandle {
  host.textContent = ''
  if (!opts.bare) host.classList.add('floating')
  host.classList.add('time-slider')
  host.hidden = true

  const label = document.createElement('label')
  label.classList.add('label')
  const textEl = document.createElement('span')
  textEl.classList.add('tabular-nums', 'time-slider-text')
  const slot = document.createElement('span')
  slot.classList.add('time-slider-slot')
  if (!opts.bare) {
    const title = document.createElement('span')
    title.textContent = 'Time'
    label.appendChild(title)
  }
  label.appendChild(slot)
  label.appendChild(textEl)

  const stepsEl = document.createElement('div')
  stepsEl.classList.add('label', 'wrap-note', 'time-slider-steps')
  const noteEl = document.createElement('div')
  noteEl.classList.add('label', 'wrap-note', 'time-slider-note')
  const statusEl = document.createElement('div')
  statusEl.classList.add('label', 'wrap-note', 'time-slider-status')
  statusEl.setAttribute('role', 'status')

  host.appendChild(label)
  host.appendChild(stepsEl)
  host.appendChild(noteEl)
  host.appendChild(statusEl)

  let times: number[] = []
  let kind = ''
  let input: HTMLInputElement | null = null
  let shown: string | null = null

  function paintText(index: number): void {
    const time = times[index]
    shown = time === undefined ? null : formatTimeValue(kind, time)
    textEl.textContent = shown === null ? '' : `${shown} · ${index + 1} of ${times.length}`
  }

  function clearLines(): void {
    stepsEl.textContent = ''
    noteEl.textContent = ''
    statusEl.textContent = ''
  }

  function reset(): void {
    slot.textContent = ''
    input = null
    times = []
    shown = null
    clearLines()
  }

  function makeRange(group: string | null): HTMLInputElement {
    const range = document.createElement('input')
    range.type = 'range'
    range.step = '1'
    range.setAttribute('aria-label', group === null ? 'Observation time' : `Observation time of ${group}`)
    range.addEventListener('input', () => {
      const next = Number(range.value)
      if (!Number.isInteger(next) || next < 0 || next >= times.length) return
      paintText(next)
      opts.onChange(next)
    })
    return range
  }

  return {
    show(nextTimes, nextKind, stepsBy, index, note, group = null) {
      // The same input is kept when it can be, so a focused slider stays focused across a redraw.
      const keep = input !== null && nextTimes.length > 1
      if (!keep) reset()
      else clearLines()
      times = [...nextTimes]
      kind = nextKind
      host.hidden = false
      label.hidden = false
      const at = Math.min(Math.max(index, 0), Math.max(times.length - 1, 0))
      // One time has nothing to step through, so it is shown as text with no range input.
      if (times.length > 1) {
        const range = input ?? makeRange(group)
        range.min = '0'
        range.max = String(times.length - 1)
        range.value = String(at)
        range.setAttribute('aria-label', group === null ? 'Observation time' : `Observation time of ${group}`)
        if (input === null) {
          slot.appendChild(range)
          input = range
        }
      }
      paintText(at)
      if (stepsBy === 'position') stepsEl.textContent = `steps by ${timeAxisTitle(kind)}`
      noteEl.textContent = note ?? ''
    },
    refuse(reason) {
      reset()
      host.hidden = false
      label.hidden = true
      noteEl.textContent = `No time slider: ${reason}`
    },
    hide() {
      reset()
      host.hidden = true
    },
    setIndex(index) {
      if (index < 0 || index >= times.length) return
      if (input !== null) input.value = String(index)
      paintText(index)
    },
    setStatus(text) {
      statusEl.textContent = text ?? ''
    },
    currentText() {
      return shown
    },
  }
}
