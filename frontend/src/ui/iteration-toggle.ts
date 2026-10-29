// The iteration switch in the map's floating controls: one button per
// ingested iteration, labelled with the real iteration number. It is written
// over a list so more ingested iterations only grow the list. It computes
// and fetches nothing; the map view reacts to onChange.

import type { IngestState } from '../data/client'

export interface IterationToggleOptions {
  iterations: number[]
  current: number
  onChange: (iteration: number) => void
  /** A row inside a labelled card: no floating card of its own and no Iteration word. */
  bare?: boolean
}

export interface IterationToggleHandle {
  /** Moves the pressed button without calling onChange. */
  setCurrent(iteration: number): void
}

/** The iterations the ingest holds a usable parameter ensemble for, sorted and unique. */
export function iterationsFrom(state: IngestState): number[] {
  const found = new Set<number>()
  for (const artifact of state.artifacts) {
    if (artifact.kind !== 'par_ens' || artifact.state !== 'ok') continue
    const match = /^par_ens\/(\d+)$/.exec(artifact.name)
    if (match) found.add(Number(match[1]))
  }
  return [...found].sort((a, b) => a - b)
}

/** Draws nothing with fewer than two iterations: there is nothing to switch between. */
export function renderIterationToggle(el: HTMLElement, opts: IterationToggleOptions): IterationToggleHandle {
  el.textContent = ''
  if (opts.iterations.length < 2) {
    return { setCurrent: () => {} }
  }

  if (!opts.bare) el.classList.add('floating')
  el.classList.add('iteration-toggle')
  el.setAttribute('role', 'group')
  el.setAttribute('aria-label', 'Iteration')
  el.style.display = 'flex'
  el.style.flexDirection = 'row'
  el.style.gap = 'var(--space-sm)'
  el.style.alignItems = 'center'

  if (!opts.bare) {
    // The group's aria-label already says Iteration, so a screen reader would hear this twice.
    const label = document.createElement('span')
    label.classList.add('label')
    label.textContent = 'Iteration'
    label.setAttribute('aria-hidden', 'true')
    el.appendChild(label)
  }

  const buttons = new Map<number, HTMLButtonElement>()
  for (const iteration of opts.iterations) {
    const button = document.createElement('button')
    button.type = 'button'
    button.textContent = String(iteration)
    button.setAttribute('aria-label', `Iteration ${iteration}`)
    button.setAttribute('aria-pressed', String(iteration === opts.current))
    button.addEventListener('click', () => {
      opts.onChange(iteration)
    })
    buttons.set(iteration, button)
    el.appendChild(button)
  }

  return {
    setCurrent(iteration: number): void {
      for (const [number, button] of buttons) {
        button.setAttribute('aria-pressed', String(number === iteration))
      }
    },
  }
}
