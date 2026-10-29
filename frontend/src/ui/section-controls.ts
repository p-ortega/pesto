// The tools card at the map's top right (D-06, LD-1): the plan / section toggle, then the map tools.
// "Section view" stays disabled, with the reason as text, while the run cannot have a section,
// while the server refuses the line, and until a line exists, in that order. Every word reaches
// the DOM through textContent.

import type { VeMode } from '../gl/section-camera'

export interface SectionControlsOptions {
  onPlan(): void
  onSection(): void
  /** The exaggeration the user picked; only offered while the section shows (D-20). */
  onVe?(mode: VeMode): void
}

export interface SectionControlsHandle {
  setHasLine(on: boolean): void
  setShown(on: boolean): void
  setLoading(on: boolean): void
  setRefusal(reason: string | null): void
  /** Why the last request failed when asking again may work; the button stays enabled. */
  setFailure(reason: string | null): void
  /** Why this run can have no section at all, or null when it can; it wins over any other reason. */
  setCapability(reason: string | null): void
  /** The row the map's tools go in: Draw section line, Lasso sites, Fit to extent. */
  toolsRow: HTMLElement
  /** The box under the card's rows for one reason line per disabled button, in button order. */
  reasons: HTMLElement
  dispose(): void
}

export const NO_LINE_REASON = 'draw a section line on the plan first'
export const LOADING_TEXT = 'loading the section'
export const VE_LABEL = 'Vertical exaggeration'
export const VE_CHOICES: readonly VeMode[] = ['fitted', 1, 2, 5, 10, 20, 50, 100]

export function renderSectionControls(host: HTMLElement, opts: SectionControlsOptions): SectionControlsHandle {
  const wrap = document.createElement('div')
  wrap.classList.add('floating', 'section-controls')
  const row = document.createElement('div')
  row.classList.add('section-toggle-row')
  const planButton = document.createElement('button')
  planButton.type = 'button'
  planButton.classList.add('section-toggle')
  planButton.textContent = 'Plan view'
  const sectionButton = document.createElement('button')
  sectionButton.type = 'button'
  sectionButton.classList.add('section-toggle')
  sectionButton.textContent = 'Section view'
  row.appendChild(planButton)
  row.appendChild(sectionButton)
  const toolsRow = document.createElement('div')
  toolsRow.classList.add('tools-row')
  toolsRow.setAttribute('data-testid', 'map-tools')
  toolsRow.setAttribute('role', 'group')
  toolsRow.setAttribute('aria-label', 'Map tools')
  const reasons = document.createElement('div')
  reasons.classList.add('tools-reasons')
  const reasonEl = document.createElement('div')
  reasonEl.classList.add('label', 'wrap-note')
  reasons.appendChild(reasonEl)
  const veRow = document.createElement('label')
  veRow.classList.add('section-ve-row', 'label')
  const veText = document.createElement('span')
  veText.textContent = VE_LABEL
  const veSelect = document.createElement('select')
  veSelect.setAttribute('aria-label', VE_LABEL)
  for (const choice of VE_CHOICES) {
    const option = document.createElement('option')
    option.value = String(choice)
    option.textContent = choice === 'fitted' ? 'fitted' : `${choice}×`
    veSelect.appendChild(option)
  }
  veSelect.value = 'fitted'
  veRow.appendChild(veText)
  veRow.appendChild(veSelect)
  wrap.appendChild(row)
  wrap.appendChild(toolsRow)
  wrap.appendChild(veRow)
  wrap.appendChild(reasons)
  host.appendChild(wrap)

  let hasLine = false
  let shown = false
  let loading = false
  let refusal: string | null = null
  let failure: string | null = null
  let capability: string | null = null

  function paint(): void {
    planButton.setAttribute('aria-pressed', String(!shown))
    sectionButton.setAttribute('aria-pressed', String(shown))
    const blocked = capability ?? refusal ?? (hasLine ? null : NO_LINE_REASON)
    sectionButton.disabled = blocked !== null
    sectionButton.title = blocked ?? 'Show the section along the line'
    const text = blocked ?? (loading ? LOADING_TEXT : (failure ?? ''))
    reasonEl.textContent = text
    reasonEl.hidden = text === ''
    veRow.hidden = !shown
  }
  paint()

  const onPlanClick = () => opts.onPlan()
  const onSectionClick = () => {
    if (!sectionButton.disabled) opts.onSection()
  }
  const onVeChange = () => {
    const value = veSelect.value
    opts.onVe?.(value === 'fitted' ? 'fitted' : Number(value))
  }
  planButton.addEventListener('click', onPlanClick)
  sectionButton.addEventListener('click', onSectionClick)
  veSelect.addEventListener('change', onVeChange)

  return {
    setHasLine(on) {
      hasLine = on
      paint()
    },
    setShown(on) {
      shown = on
      paint()
    },
    setLoading(on) {
      loading = on
      paint()
    },
    setRefusal(reason) {
      refusal = reason
      paint()
    },
    setFailure(reason) {
      failure = reason
      paint()
    },
    setCapability(reason) {
      capability = reason
      paint()
    },
    toolsRow,
    reasons,
    dispose() {
      planButton.removeEventListener('click', onPlanClick)
      sectionButton.removeEventListener('click', onSectionClick)
      veSelect.removeEventListener('change', onVeChange)
      wrap.remove()
    },
  }
}
