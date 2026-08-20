// The screen every flow in this phase ends at (D-13's warm path, and the
// cold one too, once ingest finishes): the map itself is Phase 5.1's work,
// so this renders the same header and status bar as the other screens and
// drops in one clearly labelled panel where the canvas will go. Nothing
// has failed here -- research Open Question 3's whole point is that this
// must never read as an error state, so the panel carries the
// informational tone and none of the three status tones.

import type { IngestState } from '../data/client'
import {
  renderHeader,
  renderNotice,
  renderStatusBar,
  type NoticeTone,
  type RenderNoticeOptions,
} from '../ui/chrome'
import { currentTheme, setTheme, type ThemeChoice } from '../ui/theme'

export interface NoiseFact {
  has_noise: boolean | null
  decided_by: string
  evidence: string[]
  notes: string[]
}

export interface RunConfig {
  case: string
  n_par: number | null
  n_real: number | null
  noise: NoiseFact
}

export interface MountPlaceholderOptions {
  config: RunConfig | null
  state: IngestState
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`
  }
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes / 1024
  let unitIndex = 0
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024
    unitIndex += 1
  }
  return `${value.toFixed(1)} ${units[unitIndex]}`
}

function formatSeconds(seconds: number): string {
  return `${seconds.toFixed(1)} s`
}

// A fresh child per call, so several notices can sit in the same
// container without each new one erasing the last -- renderNotice itself
// clears whatever element it is given, which is right for one slot and
// wrong for a list of them (same technique progress.ts uses for its
// closing report).
function addNotice(container: HTMLElement, opts: RenderNoticeOptions): void {
  const el = document.createElement('div')
  renderNotice(el, opts)
  container.appendChild(el)
}

const CAPABILITY_LABELS: Record<'map' | 'stats' | 'chips', string> = {
  map: 'the map',
  stats: 'the summary statistics',
  chips: "the run's own configuration chips",
}

// The single status tone this module uses, for a blocked capability --
// kept as one named constant so the source carries exactly one quoted
// status-tone literal. The panel notice below uses the informational
// tone instead, which is not a status tone.
const BLOCKED_TONE: NoticeTone = 'warning'

// D-12's rule applied to a screen the user reaches after leaving the
// ingest screen, or after a reload: a blocked capability's artifact and
// its recorded reason must still be told here, not only on a screen the
// user has already left.
function renderBlockedCapabilities(container: HTMLElement, state: IngestState): void {
  container.textContent = ''

  const capabilities = [
    ['map', state.capabilities.map] as const,
    ['stats', state.capabilities.stats] as const,
    ['chips', state.capabilities.chips] as const,
  ]

  for (const [name, capability] of capabilities) {
    if (capability.available) {
      continue
    }
    for (const block of capability.blockedBy) {
      addNotice(container, {
        title: `${CAPABILITY_LABELS[name]} is unavailable`,
        detail: `${block.artifact}: ${block.reason}`,
        tone: BLOCKED_TONE,
      })
    }
  }
}

/**
 * The labelled placeholder where Phase 5.1 draws the map. Shares the same
 * header and status bar as every other screen; the space where the canvas
 * will go carries one informational notice naming what is missing and
 * which phase adds it -- never an error, because nothing has failed.
 */
export function mountPlaceholder(root: HTMLElement, opts: MountPlaceholderOptions): void {
  root.textContent = ''

  const header = document.createElement('div')
  const noticeArea = document.createElement('div')
  const panel = document.createElement('div')
  const statusBar = document.createElement('div')

  root.appendChild(header)
  root.appendChild(noticeArea)
  root.appendChild(panel)
  root.appendChild(statusBar)

  function paintHeader(): void {
    renderHeader(header, {
      title: opts.config?.case ?? 'This run',
      themeChoice: currentTheme(),
      onThemeChange: (choice: ThemeChoice) => {
        setTheme(choice)
        paintHeader()
      },
    })
  }
  paintHeader()

  renderNotice(panel, {
    title: 'The map is not built yet',
    detail: 'Phase 5.1 adds the WebGL2 canvas and its controls here.',
    tone: 'info',
  })

  renderBlockedCapabilities(noticeArea, opts.state)

  renderStatusBar(statusBar, {
    'Ingest time': opts.state.ingestSeconds === null ? null : formatSeconds(opts.state.ingestSeconds),
    'Cache size': opts.state.cacheBytes === null ? null : formatBytes(opts.state.cacheBytes),
  })
}
