// The plan / section toggle at the map's top right (D-06). "Section view" stays disabled, with the
// reason as text, while the run cannot have a section, while the server refuses the line, and
// until a line exists, in that order. Every word reaches the DOM through textContent.

export interface SectionControlsOptions {
  onPlan(): void
  onSection(): void
}

export interface SectionControlsHandle {
  setHasLine(on: boolean): void
  setShown(on: boolean): void
  setLoading(on: boolean): void
  setRefusal(reason: string | null): void
  /** Why this run can have no section at all, or null when it can; it wins over any other reason. */
  setCapability(reason: string | null): void
  dispose(): void
}

export const NO_LINE_REASON = 'draw a section line on the plan first'
export const LOADING_TEXT = 'loading the section'

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
  const reasonEl = document.createElement('div')
  reasonEl.classList.add('label', 'wrap-note')
  wrap.appendChild(row)
  wrap.appendChild(reasonEl)
  host.appendChild(wrap)

  let hasLine = false
  let shown = false
  let loading = false
  let refusal: string | null = null
  let capability: string | null = null

  function paint(): void {
    planButton.setAttribute('aria-pressed', String(!shown))
    sectionButton.setAttribute('aria-pressed', String(shown))
    const blocked = capability ?? refusal ?? (hasLine ? null : NO_LINE_REASON)
    sectionButton.disabled = blocked !== null
    sectionButton.title = blocked ?? 'Show the section along the line'
    const text = blocked ?? (loading ? LOADING_TEXT : '')
    reasonEl.textContent = text
    reasonEl.hidden = text === ''
  }
  paint()

  const onPlanClick = () => opts.onPlan()
  const onSectionClick = () => {
    if (!sectionButton.disabled) opts.onSection()
  }
  planButton.addEventListener('click', onPlanClick)
  sectionButton.addEventListener('click', onSectionClick)

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
    setCapability(reason) {
      capability = reason
      paint()
    },
    dispose() {
      planButton.removeEventListener('click', onPlanClick)
      sectionButton.removeEventListener('click', onSectionClick)
      wrap.remove()
    },
  }
}
