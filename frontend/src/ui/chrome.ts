// The header, status bar and notice renderer every screen in this app
// shares, so the ingest screen and Phase 5.1's map inherit one frame
// rather than each inventing their own. Every colour here is a
// `var(--...)` reference into the tokens `index.html` defines -- nothing
// in this module picks a colour of its own.

import type { ThemeChoice } from './theme'

const THEME_CHOICES: readonly ThemeChoice[] = ['dark', 'light', 'system']

const THEME_LABELS: Record<ThemeChoice, string> = {
  dark: 'Dark',
  light: 'Light',
  system: 'System',
}

export type NoticeTone = 'info' | 'warning' | 'serious' | 'critical'

interface ToneStyle {
  icon: string
  word: string
  colorVar: string
}

// Every tone carries an icon and a word together, never colour alone
// (visual contract § 11) -- identity survives for a colour-blind reader.
const TONE_STYLE: Record<NoticeTone, ToneStyle> = {
  info: { icon: 'ℹ', word: 'Note', colorVar: 'var(--status-good)' },
  warning: { icon: '⚠', word: 'Warning', colorVar: 'var(--status-warning)' },
  serious: { icon: '⚠', word: 'Serious', colorVar: 'var(--status-serious)' },
  critical: { icon: '✕', word: 'Critical', colorVar: 'var(--status-critical)' },
}

// Nothing in this module animates today, but the guard is written once
// here so a future transition starts already respecting the rule, rather
// than being added and the rule forgotten (§ 11: dropped entirely under
// this query).
function prefersReducedMotion(): boolean {
  try {
    return matchMedia('(prefers-reduced-motion: reduce)').matches
  } catch {
    return true
  }
}

function chromeTransition(): string {
  return prefersReducedMotion() ? 'none' : 'background-color 120ms ease'
}

export interface RenderHeaderOptions {
  title: string
  subtitle?: string
  themeChoice: ThemeChoice
  onThemeChange: (choice: ThemeChoice) => void
}

/**
 * The run title on the left, the theme control on the right, matching
 * visual contract § 6's header. The configuration chips § 6 also puts
 * here belong to MAP-10 and Phase 5.1; this leaves the space and adds
 * none. The theme control is a real `<select>`, keyboard reachable by
 * construction (MAP-11).
 */
export function renderHeader(el: HTMLElement, opts: RenderHeaderOptions): void {
  el.textContent = ''
  el.style.transition = chromeTransition()

  const titleGroup = document.createElement('div')
  const titleEl = document.createElement('span')
  titleEl.textContent = opts.title
  titleGroup.appendChild(titleEl)

  if (opts.subtitle) {
    const subtitleEl = document.createElement('span')
    subtitleEl.textContent = opts.subtitle
    titleGroup.appendChild(subtitleEl)
  }

  const themeLabel = document.createElement('label')
  themeLabel.textContent = 'Theme'

  const select = document.createElement('select')
  select.setAttribute('aria-label', 'Theme')
  for (const choice of THEME_CHOICES) {
    const option = document.createElement('option')
    option.setAttribute('value', choice)
    option.textContent = THEME_LABELS[choice]
    select.appendChild(option)
  }
  select.value = opts.themeChoice
  select.addEventListener('change', () => {
    const value = select.value
    if (value === 'dark' || value === 'light' || value === 'system') {
      opts.onThemeChange(value)
    }
  })
  themeLabel.appendChild(select)

  el.appendChild(titleGroup)
  el.appendChild(themeLabel)
}

export type StatusFields = Record<string, string | number | null>

/**
 * A row of labelled figures -- real numbers, never progress theatre
 * (§ 6). A `null` value renders as a placeholder dash with its label
 * intact, since a blank cell would read as zero.
 */
export function renderStatusBar(el: HTMLElement, fields: StatusFields): void {
  el.textContent = ''
  for (const [label, value] of Object.entries(fields)) {
    const field = document.createElement('span')

    const labelEl = document.createElement('span')
    labelEl.textContent = label
    field.appendChild(labelEl)

    const valueEl = document.createElement('span')
    valueEl.classList.add('tabular-nums')
    valueEl.textContent = value === null ? '—' : String(value)
    field.appendChild(valueEl)

    el.appendChild(field)
  }
}

export interface RenderNoticeOptions {
  title: string
  detail?: string
  tone: NoticeTone
}

/**
 * The one designed-state renderer every reachable empty or error state in
 * this phase goes through -- what makes MAP-06's "never a blank panel" a
 * thing a test can check rather than a review comment.
 */
export function renderNotice(el: HTMLElement, opts: RenderNoticeOptions): void {
  el.textContent = ''
  const style = TONE_STYLE[opts.tone]

  const notice = document.createElement('div')
  notice.style.color = style.colorVar

  const iconEl = document.createElement('span')
  iconEl.textContent = style.icon
  notice.appendChild(iconEl)

  const wordEl = document.createElement('span')
  wordEl.textContent = style.word
  notice.appendChild(wordEl)

  const titleEl = document.createElement('span')
  titleEl.textContent = opts.title
  notice.appendChild(titleEl)

  if (opts.detail) {
    const detailEl = document.createElement('span')
    detailEl.textContent = opts.detail
    notice.appendChild(detailEl)
  }

  el.appendChild(notice)
}
