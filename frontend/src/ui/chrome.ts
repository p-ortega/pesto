// The header, status bar and notice renderer every screen in this app
// shares, so the ingest screen and Phase 5.1's map inherit one frame
// rather than each inventing their own. Every colour here is a
// `var(--...)` reference into the tokens `index.html` defines -- nothing
// in this module picks a colour of its own.

import { listWords, mismatchWords, type BaseFactState } from '../data/config'
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
  info: { icon: 'ℹ', word: 'Note', colorVar: 'var(--ink-muted)' },
  warning: { icon: '⚠', word: 'Warning', colorVar: 'var(--status-warning)' },
  serious: { icon: '⚠', word: 'Serious', colorVar: 'var(--status-serious)' },
  critical: { icon: '✕', word: 'Critical', colorVar: 'var(--status-critical)' },
}

// Read once here and reused everywhere motion needs the same check
// (§ 11: dropped entirely under this query) -- exported so plan 05.1-08's
// camera easing shares this one media query rather than writing a second.
export function prefersReducedMotion(): boolean {
  try {
    return matchMedia('(prefers-reduced-motion: reduce)').matches
  } catch {
    return true
  }
}

function chromeTransition(): string {
  return prefersReducedMotion() ? 'none' : 'background-color 120ms ease'
}

// MAP-10's five facts, read straight from RunConfig (src/pesto/cache/
// runconfig.py) -- every count is `null` when pesto could not determine
// it, never zero, so a chip is omitted rather than shown with a guessed 0.
export interface ChipRunConfig {
  n_par: number | null
  n_real: number | null
  base_realization: boolean | null
  n_iterations: number | null
  noptmax: number | null
  projection: string | null
  has_noise: boolean | null
  /** Keys of the facts whose readings disagree (D-17); absent for a config with no facts. */
  disagree?: string[]
  /** For each key in `disagree`, the files whose readings do not match, such as `.rec` and `.pst`. */
  mismatch?: Record<string, string[]>
  /** The file pesto takes noise from, `.rec` or `.pst`; null when nothing decided it. */
  noise_from?: string | null
  /** The files with a noise reading that says the opposite of `has_noise`. */
  noise_against?: string[]
  /** What the base fact says about the last ingested iteration; null when it says nothing. */
  base?: BaseFactState | null
}

export interface ChipFailure {
  artifact: string
  reason: string
}

// D-12: either the five facts, or the one recorded failure -- never both,
// and never a mix, so a caller cannot accidentally show stale chips beside
// a failure chip.
export type ChipsInput = { config: ChipRunConfig; failure: null } | { config: null; failure: ChipFailure }

function appendChip(
  el: HTMLElement,
  text: string,
  opts?: { colorVar?: string; numeric?: boolean; truncate?: boolean; title?: string },
): HTMLElement {
  const chip = document.createElement('span')
  chip.classList.add('chip')
  if (opts?.title) chip.title = opts.title
  if (opts?.numeric) chip.classList.add('tabular-nums')
  if (opts?.truncate) chip.classList.add('truncate')
  if (opts?.colorVar) chip.style.color = opts.colorVar
  chip.textContent = text
  el.appendChild(chip)
  return chip
}

const FACT_WORDS: Record<string, string> = {
  ensemble_size: 'ensemble size',
  base: 'base',
  noptmax: 'iterations (noptmax)',
  noise: 'noise',
}

function disagreeing(disagree: string[], keys: string[]): string[] {
  return keys.filter((key) => disagree.includes(key))
}

// The base part of the realization chip: the base fact when it says something, else the old yes or no.
function baseChipWord(config: ChipRunConfig): string | null {
  const base = config.base
  if (base?.state === 'present') return 'base alive'
  if (base?.state === 'not_included') return 'no base'
  if (base?.state === 'missing' && base.iteration !== undefined) return `base missing at iteration ${base.iteration}`
  if (config.base_realization === null) return null
  return config.base_realization ? 'base alive' : 'base lost'
}

function mismatchedFiles(config: ChipRunConfig, marked: string[]): string[] {
  return Array.from(new Set(marked.flatMap((key) => config.mismatch?.[key] ?? [])))
}

function mismatchSuffix(files: string[]): string {
  if (files.length === 0) return 'files do not match'
  if (files.length === 1) return `lines in the ${files[0]} do not match`
  return `${listWords(files)} do not match`
}

// A chip whose readings disagree carries the warning icon and the words, never colour alone (D-17).
function appendFactChip(
  el: HTMLElement,
  config: ChipRunConfig,
  parts: (string | null)[],
  marked: string[],
  opts: { numeric?: boolean; warn?: boolean; title?: string; says?: string | null } = {},
): void {
  const text = parts.filter((p): p is string => p !== null)
  if (marked.length === 0) {
    const plain = text.join(' · ')
    appendChip(el, opts.warn ? `${TONE_STYLE.warning.icon} ${plain}` : plain, {
      numeric: opts.numeric,
      colorVar: opts.warn ? TONE_STYLE.warning.colorVar : undefined,
      title: opts.title,
    })
    return
  }
  const names = marked.map((key) => FACT_WORDS[key] ?? key).join(', ')
  const files = mismatchedFiles(config, marked)
  appendChip(el, `${TONE_STYLE.warning.icon} ${[...text, opts.says ?? mismatchSuffix(files)].join(' · ')}`, {
    numeric: opts.numeric,
    colorVar: TONE_STYLE.warning.colorVar,
    title: `${mismatchWords(files)} on ${names}. The Config tab lists what each one says.`,
  })
}

function noiseText(config: ChipRunConfig): string {
  const state = config.has_noise === true ? 'on' : config.has_noise === false ? 'off' : 'not known'
  return config.noise_from ? `noise: ${state} (from ${config.noise_from})` : `noise: ${state}`
}

// ".pst says on": what the other file says, in the same on and off words as the chip.
function noiseAgainstText(config: ChipRunConfig): string | null {
  const against = config.noise_against ?? []
  if (config.has_noise === null || against.length === 0) return null
  const also = config.noise_from && against.includes(config.noise_from) ? ' also' : ''
  return `${listWords(against)}${also} ${against.length > 1 ? 'say' : 'says'} ${config.has_noise ? 'off' : 'on'}`
}

/**
 * MAP-10's five header chips, or the single D-12 failure chip. Follows
 * `renderStatusBar`'s one-span-per-fact, `tabular-nums`-on-the-number shape.
 * The realization chip is shown only once both the count and whether base
 * survived are known, or its readings disagree -- a count with no verdict on
 * base and no disagreement stays silent rather than guessing.
 */
export function renderChips(el: HTMLElement, opts: ChipsInput): void {
  el.textContent = ''
  // WINDOWS.md #13's sweep: this row's own spacing used to come only from
  // the ambient `.header > div` rule -- true when a caller happened to hand
  // this a direct child of a `.header`-classed element, silently absent
  // otherwise. The Spacing Scale's own "sm: gap between a chip's parts"
  // is exactly this row, so it carries its own gap now.
  el.classList.add('legend-figures')

  if (opts.failure) {
    const text = `${opts.failure.artifact} failed — ${opts.failure.reason}`
    const chip = appendChip(el, text, { colorVar: TONE_STYLE.serious.colorVar, truncate: true })
    chip.title = opts.failure.reason
    return
  }

  const config = opts.config
  const disagree = config.disagree ?? []
  const baseWord = baseChipWord(config)

  if (config.n_par !== null) {
    appendChip(el, `${config.n_par} par`, { numeric: true })
  }

  const realMarked = disagreeing(disagree, ['ensemble_size', 'base'])
  if (config.n_real !== null && (baseWord !== null || realMarked.length > 0)) {
    // G-14-5: the header names base but holds no button, so it says where the button is.
    appendFactChip(el, config, [`${config.n_real} reals`, baseWord], realMarked, {
      numeric: true,
      title: 'Select base is on the Site plots line of the Obs tab.',
    })
  }

  if (config.n_iterations !== null) {
    // The say-what-was-inferred case: strictly below noptmax is a run that
    // stopped short; at equality the plain form is shown.
    const text =
      config.noptmax !== null && config.n_iterations < config.noptmax
        ? `${config.n_iterations} of ${config.noptmax} iter`
        : `${config.n_iterations} iter`
    appendFactChip(el, config, [text], disagreeing(disagree, ['noptmax']), { numeric: true })
  }

  const noiseMarked = disagreeing(disagree, ['noise'])
  if (config.has_noise === false || noiseMarked.length > 0) {
    appendFactChip(el, config, [noiseText(config)], noiseMarked, {
      warn: config.has_noise === false,
      says: noiseAgainstText(config),
    })
  }

  appendChip(el, config.projection ? 'crs' : 'no crs', { colorVar: 'var(--ink-muted)' })
}

export interface RenderHeaderOptions {
  title: string
  subtitle?: string
  themeChoice: ThemeChoice
  onThemeChange: (choice: ThemeChoice) => void
  /** `null`/absent until the run's configuration has landed -- a chip is a
   *  stated fact about the run or it is absent entirely, never a
   *  placeholder row (MAP-10). */
  chips?: ChipsInput | null
  /** Controls a view puts in the header row, after the chips and before the theme control. */
  extras?: HTMLElement[]
}

/**
 * The run title on the left, the theme control on the right, matching
 * visual contract § 6's header, with MAP-10's configuration chips between
 * them once the run's configuration has landed. The theme control is a
 * real `<select>`, keyboard reachable by construction (MAP-11).
 */
// The pesto mascot: a side-on mortar heaped with pesto, the pestle plunged in, a basil leaf and a face.
const LOGO_BODY =
  '<g transform="translate(27 32) rotate(40)">' +
  '<path d="M-5.5 2 L-3.6 -30 L3.6 -30 L5.5 2 Z" fill="var(--brand-cream)"/>' +
  '<circle cx="0" cy="-31" r="4.7" fill="var(--brand-cream)"/>' +
  '</g>' +
  '<path d="M21 25 C12.5 24 8.5 17 9.5 9 C17.5 10 22.5 17 21 25 Z" fill="var(--brand-leaf)"/>' +
  '<path d="M12 29 Q32 13 52 29 Z" fill="var(--brand-basil)"/>' +
  '<rect x="6" y="28" width="52" height="5.5" rx="2.75" fill="var(--brand-cream)"/>' +
  '<path d="M10 33 H54 V36 C54 47 45 54 32 54 C19 54 10 47 10 36 Z" fill="var(--brand-cream)"/>' +
  '<rect x="27" y="52" width="10" height="6" fill="var(--brand-cream)"/>' +
  '<rect x="21.5" y="56" width="21" height="4.5" rx="2.25" fill="var(--brand-cream)"/>' +
  '<ellipse cx="23.5" cy="42" rx="3.6" ry="4.6" fill="var(--chrome-bg)"/>' +
  '<ellipse cx="23.9" cy="42.4" rx="2.5" ry="3.4" fill="var(--chrome-bg)"/>' +
  '<circle cx="22.8" cy="40.6" r="1.15" fill="var(--brand-glint)"/>' +
  '<circle cx="24.8" cy="44" r="0.55" fill="var(--brand-glint)"/>' +
  '<ellipse cx="40.5" cy="42" rx="3.6" ry="4.6" fill="var(--chrome-bg)"/>' +
  '<ellipse cx="40.9" cy="42.4" rx="2.5" ry="3.4" fill="var(--chrome-bg)"/>' +
  '<circle cx="39.8" cy="40.6" r="1.15" fill="var(--brand-glint)"/>' +
  '<circle cx="41.8" cy="44" r="0.55" fill="var(--brand-glint)"/>' +
  '<path d="M29.6 45.6 Q32 48 34.4 45.6" fill="none" stroke="var(--chrome-bg)" stroke-width="1.3" stroke-linecap="round"/>' +
  '<ellipse cx="17.2" cy="46.6" rx="2.2" ry="1.3" fill="var(--brand-cheek)" opacity=".85"/>' +
  '<ellipse cx="46.8" cy="46.6" rx="2.2" ry="1.3" fill="var(--brand-cheek)" opacity=".85"/>'

export function logoSvg(size: number): string {
  return `<svg width="${size}" height="${size}" viewBox="0 0 64 64" aria-hidden="true">${LOGO_BODY}</svg>`
}

function brandMark(): HTMLElement {
  const brand = document.createElement('span')
  brand.classList.add('brand')
  brand.innerHTML = logoSvg(26)
  const word = document.createElement('span')
  word.textContent = 'pesto'
  brand.appendChild(word)
  return brand
}

export function renderHeader(el: HTMLElement, opts: RenderHeaderOptions): void {
  el.textContent = ''
  el.style.transition = chromeTransition()

  const titleGroup = document.createElement('div')
  titleGroup.appendChild(brandMark())

  const titleEl = document.createElement('span')
  titleEl.classList.add('heading')
  titleEl.textContent = opts.title
  titleGroup.appendChild(titleEl)

  if (opts.subtitle) {
    const subtitleEl = document.createElement('span')
    subtitleEl.textContent = opts.subtitle
    titleGroup.appendChild(subtitleEl)
  }

  el.appendChild(titleGroup)

  if (opts.chips) {
    const chipsEl = document.createElement('div')
    renderChips(chipsEl, opts.chips)
    el.appendChild(chipsEl)
  }

  for (const extra of opts.extras ?? []) el.appendChild(extra)

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
  notice.classList.add('notice-parts')
  // Only the icon and tone word carry the tone colour; coloured sentences read as alarms.
  const iconEl = document.createElement('span')
  iconEl.textContent = style.icon
  iconEl.style.color = style.colorVar
  notice.appendChild(iconEl)

  const wordEl = document.createElement('span')
  wordEl.classList.add('notice-word')
  wordEl.textContent = style.word
  wordEl.style.color = style.colorVar
  notice.appendChild(wordEl)

  const titleEl = document.createElement('span')
  titleEl.classList.add('notice-title')
  titleEl.textContent = opts.title
  notice.appendChild(titleEl)

  if (opts.detail) {
    const detailEl = document.createElement('span')
    detailEl.classList.add('notice-detail')
    detailEl.textContent = opts.detail
    notice.appendChild(detailEl)
  }

  el.appendChild(notice)
}

// A scroll pane must take focus, or a keyboard user cannot scroll it at all.
export function makeFocusable(pane: HTMLElement, name: string): void {
  pane.tabIndex = 0
  pane.setAttribute('role', 'region')
  pane.setAttribute('aria-label', name)
}
