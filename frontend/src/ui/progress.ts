// The two screens of watching a run ingest (D-11, D-12, D-13's cold path):
// an estimate gate the user must agree to before anything starts, and the
// ingesting screen itself, with per-artifact rows appearing as the
// progress stream produces them and a closing report naming anything a
// failed artifact leaves unavailable. Every colour here is a `var(--...)`
// reference into the same status tokens `chrome.ts` uses for a notice;
// nothing in this module picks a colour of its own. Every server-supplied
// string -- an artifact name, a reason, an estimate note -- reaches the
// DOM through `textContent`, never through markup assignment.

import {
  ingestCancel,
  ingestEstimate,
  ingestStart,
  ingestState,
  INGEST_EVENTS_URL,
  type IngestEstimate,
  type IngestState,
} from '../data/client'
import { readEvents as readProgressStream, type SseEvent } from '../data/sse'
import { renderHeader, renderNotice, renderStatusBar, type RenderNoticeOptions } from './chrome'
import { currentTheme, setTheme, type ThemeChoice } from './theme'

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

// A fresh child per call, so several notices can sit in one container
// without each new one erasing the last -- `renderNotice` itself clears
// whatever element it is given, which is right for a single-notice slot
// and wrong for a list of them.
function addNotice(container: HTMLElement, opts: RenderNoticeOptions): void {
  const el = document.createElement('div')
  renderNotice(el, opts)
  container.appendChild(el)
}

function activatesOnEnter(el: HTMLButtonElement, run: () => void): void {
  el.addEventListener('click', run)
  el.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault()
      run()
    }
  })
}

export interface MountEstimateOptions {
  onAgree: () => void
  onDecline: () => void
}

/**
 * The estimate gate: a projected total, free space beside it, and every
 * artifact the estimate could not size, named rather than folded silently
 * into the total. Nothing starts until the user activates agree -- this
 * function issues no request beyond reading the estimate itself.
 */
export async function mountEstimate(root: HTMLElement, opts: MountEstimateOptions): Promise<void> {
  root.textContent = ''

  const headerEl = document.createElement('div')
  const body = document.createElement('div')
  const noticeArea = document.createElement('div')
  const controls = document.createElement('div')
  root.appendChild(headerEl)
  root.appendChild(body)
  root.appendChild(noticeArea)
  root.appendChild(controls)

  function paintHeader(): void {
    renderHeader(headerEl, {
      title: 'Before ingesting: a projected cost',
      themeChoice: currentTheme(),
      onThemeChange: (choice: ThemeChoice) => {
        setTheme(choice)
        paintHeader()
      },
    })
  }
  paintHeader()

  const agreeButton = document.createElement('button')
  agreeButton.textContent = 'Agree and ingest'
  activatesOnEnter(agreeButton, () => opts.onAgree())

  const declineButton = document.createElement('button')
  declineButton.textContent = 'Go back'
  activatesOnEnter(declineButton, () => opts.onDecline())

  controls.appendChild(agreeButton)
  controls.appendChild(declineButton)

  let estimate: IngestEstimate
  try {
    estimate = await ingestEstimate()
  } catch {
    addNotice(noticeArea, { title: 'the projected size could not be read', tone: 'critical' })
    return
  }

  const totalLine = document.createElement('p')
  totalLine.textContent = `Projected cache size: ${formatBytes(estimate.total)} (a projection, not a measurement)`
  body.appendChild(totalLine)

  const freeLine = document.createElement('p')
  freeLine.textContent = estimate.cacheRootExists
    ? `Free space where the cache lives: ${formatBytes(estimate.freeBytes)}`
    : `Free space, for the directory that is about to be created: ${formatBytes(estimate.freeBytes)}`
  body.appendChild(freeLine)

  if (estimate.freeBytes < estimate.total) {
    addNotice(noticeArea, {
      title: 'the projection is larger than the free space shown above',
      detail: 'this is a projection, not a guarantee -- you can still agree and proceed',
      tone: 'warning',
    })
  }

  if (estimate.notes.length > 0) {
    const notesHeading = document.createElement('p')
    notesHeading.textContent = 'These artifacts could not be sized and are left out of the total above:'
    body.appendChild(notesHeading)

    const notesList = document.createElement('ul')
    for (const note of estimate.notes) {
      const item = document.createElement('li')
      item.textContent = note
      notesList.appendChild(item)
    }
    body.appendChild(notesList)
  }
}

interface ProgressRow {
  artifact: string
  state: string
  sourceBytes: number
  writtenBytes: number
  seconds: number
  reason: string | null
}

function toProgressRow(raw: unknown): ProgressRow {
  const row = raw as {
    artifact: string
    state: string
    source_bytes: number
    written_bytes: number
    seconds: number
    reason: string | null
  }
  return {
    artifact: row.artifact,
    state: row.state,
    sourceBytes: row.source_bytes,
    writtenBytes: row.written_bytes,
    seconds: row.seconds,
    reason: row.reason,
  }
}

interface RowElements {
  item: HTMLElement
  iconEl: HTMLElement
  wordEl: HTMLElement
  sourceEl: HTMLElement
  writtenEl: HTMLElement
  durationEl: HTMLElement
  reasonEl: HTMLElement
}

// The four states a progress row can be in, each with its own icon, word
// and one of the four unthemed status tokens -- so state never depends on
// colour alone (visual contract § 11).
const ROW_STYLE: Record<string, { icon: string; word: string; colorVar: string }> = {
  started: { icon: '…', word: 'Started', colorVar: 'var(--status-warning)' },
  ok: { icon: '✓', word: 'Done', colorVar: 'var(--status-good)' },
  skipped: { icon: '⏭', word: 'Already fresh', colorVar: 'var(--status-serious)' },
  failed: { icon: '✕', word: 'Failed', colorVar: 'var(--status-critical)' },
}

function createRowSkeleton(name: string): RowElements {
  const item = document.createElement('li')
  const iconEl = document.createElement('span')
  const nameEl = document.createElement('span')
  nameEl.textContent = name
  const wordEl = document.createElement('span')
  const sourceEl = document.createElement('span')
  const writtenEl = document.createElement('span')
  const durationEl = document.createElement('span')
  const reasonEl = document.createElement('span')

  item.appendChild(iconEl)
  item.appendChild(nameEl)
  item.appendChild(wordEl)
  item.appendChild(sourceEl)
  item.appendChild(writtenEl)
  item.appendChild(durationEl)
  item.appendChild(reasonEl)

  return { item, iconEl, wordEl, sourceEl, writtenEl, durationEl, reasonEl }
}

// A `started` row does not yet know its written size or its duration --
// rendering the wire's zeros for them would be a figure that is not a
// measurement. Every later state (ok, skipped, failed) knows both for
// real, including a genuine zero, so it renders the number rather than
// the placeholder.
function applyRowState(elements: RowElements, row: ProgressRow): void {
  const style = ROW_STYLE[row.state] ?? { icon: '?', word: row.state, colorVar: '' }

  elements.item.style.color = style.colorVar
  elements.iconEl.textContent = style.icon
  elements.wordEl.textContent = style.word
  elements.sourceEl.textContent = formatBytes(row.sourceBytes)

  const known = row.state !== 'started'
  elements.writtenEl.textContent = known ? formatBytes(row.writtenBytes) : '—'
  elements.durationEl.textContent = known ? formatSeconds(row.seconds) : '—'

  elements.reasonEl.textContent = row.state === 'failed' && row.reason ? row.reason : ''
}

function upsertRow(
  container: HTMLElement,
  rowsByArtifact: Map<string, RowElements>,
  row: ProgressRow,
): void {
  let elements = rowsByArtifact.get(row.artifact)
  if (!elements) {
    elements = createRowSkeleton(row.artifact)
    container.appendChild(elements.item)
    rowsByArtifact.set(row.artifact, elements)
  }
  applyRowState(elements, row)
}

const CAPABILITY_LABELS: Record<'map' | 'stats' | 'chips', string> = {
  map: 'the map',
  stats: 'the summary statistics',
  chips: "the run's own configuration chips",
}

// D-12: a partial ingest proceeds with what worked. This never says the
// whole ingest failed -- it names, one at a time, which capability rests
// on which artifact and the manifest's own recorded reason for it.
function renderClosingReport(noticeArea: HTMLElement, statusBar: HTMLElement, state: IngestState): void {
  noticeArea.textContent = ''

  const capabilities = [
    ['map', state.capabilities.map] as const,
    ['stats', state.capabilities.stats] as const,
    ['chips', state.capabilities.chips] as const,
  ]
  const blocked = capabilities.filter(([, capability]) => !capability.available)

  if (blocked.length === 0) {
    addNotice(noticeArea, { title: 'ingest complete', tone: 'info' })
  } else {
    for (const [name, capability] of blocked) {
      for (const block of capability.blockedBy) {
        addNotice(noticeArea, {
          title: `${CAPABILITY_LABELS[name]} is unavailable`,
          detail: `${block.artifact}: ${block.reason}`,
          tone: 'warning',
        })
      }
    }
  }

  renderStatusBar(statusBar, {
    'Ingest time': state.ingestSeconds === null ? null : formatSeconds(state.ingestSeconds),
    'Cache size': state.cacheBytes === null ? null : formatBytes(state.cacheBytes),
  })
}

export interface MountProgressOptions {
  onFinished: () => void
}

/**
 * The ingesting screen: starts the ingest, opens the progress stream, and
 * renders one row per artifact that updates in place as it moves from
 * started to a terminal state. Returns a teardown function; calling it
 * aborts the stream read and issues no cancel call of its own -- leaving
 * the screen is not a decision to stop the work (D-11).
 */
export function mountProgress(root: HTMLElement, opts: MountProgressOptions): () => void {
  root.textContent = ''

  const headerRow = document.createElement('div')
  const headerEl = document.createElement('div')
  const cancelButton = document.createElement('button')
  cancelButton.textContent = 'Cancel'
  headerRow.appendChild(headerEl)
  headerRow.appendChild(cancelButton)

  const noticeArea = document.createElement('div')
  const rowsList = document.createElement('ul')
  const statusBar = document.createElement('div')

  root.appendChild(headerRow)
  root.appendChild(noticeArea)
  root.appendChild(rowsList)
  root.appendChild(statusBar)

  function paintHeader(): void {
    renderHeader(headerEl, {
      title: 'Ingesting',
      themeChoice: currentTheme(),
      onThemeChange: (choice: ThemeChoice) => {
        setTheme(choice)
        paintHeader()
      },
    })
  }
  paintHeader()

  activatesOnEnter(cancelButton, () => {
    cancelButton.disabled = true
    ingestCancel().catch(() => {
      addNotice(noticeArea, { title: 'the cancel request could not be sent', tone: 'serious' })
    })
  })

  const controller = new AbortController()
  const rowsByArtifact = new Map<string, RowElements>()

  async function handleDone(): Promise<void> {
    let state: IngestState
    try {
      state = await ingestState()
    } catch {
      addNotice(noticeArea, { title: 'the closing report could not be read', tone: 'critical' })
      opts.onFinished()
      return
    }
    renderClosingReport(noticeArea, statusBar, state)
    opts.onFinished()
  }

  function handleEvent(event: SseEvent): void {
    if (event.event === 'done') {
      void handleDone()
      return
    }
    upsertRow(rowsList, rowsByArtifact, toProgressRow(JSON.parse(event.data)))
  }

  async function run(): Promise<void> {
    try {
      await ingestStart()
    } catch {
      addNotice(noticeArea, { title: 'the ingest could not be started', tone: 'critical' })
      return
    }

    try {
      await readProgressStream(INGEST_EVENTS_URL, handleEvent, controller.signal)
    } catch {
      if (!controller.signal.aborted) {
        addNotice(noticeArea, { title: 'the progress stream was interrupted', tone: 'serious' })
      }
    }
  }

  void run()

  return () => {
    controller.abort()
  }
}
