// "Report a problem": a quiet button and the dialog it opens. The dialog shows
// the whole report before anything is sent, and nothing is sent by pesto at
// all: the user opens a GitHub issue in their own browser, or copies the text.

import { fetchReport, NEW_ISSUE_URL, type ProblemReport } from '../data/report'

export const REPORT_BUTTON_TEXT = 'Report a problem'

const INTRO =
  'This is everything pesto will put in the report. It leaves out your case name, folders, ' +
  'and parameter, group and site names. Read it before you send it.'
const BUILDING = 'Building the report…'
const FAILED = 'pesto could not build the report. You can still write the issue yourself on GitHub.'
const TOO_LONG = 'The report is too long for the link. Press Copy, then paste it into the issue.'
const COPIED = 'Copied.'
const NOT_COPIED = 'The report could not be copied. Select the text and copy it yourself.'

export interface ReportDialogHandle {
  close(): void
}

let openDialog: ReportDialogHandle | null = null

async function copyText(text: string, box: HTMLTextAreaElement): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    // No clipboard access, as on a page that is not focused: fall back to the selection.
    try {
      box.select()
      return document.execCommand('copy')
    } catch {
      return false
    }
  }
}

/** Opens the dialog and fetches the report. A second call while one is open returns the open one. */
export function openReportDialog(read: () => Promise<ProblemReport> = fetchReport): ReportDialogHandle {
  if (openDialog) return openDialog
  const returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null

  const overlay = document.createElement('div')
  overlay.classList.add('report-overlay')
  const panel = document.createElement('div')
  panel.classList.add('report-panel')
  panel.setAttribute('role', 'dialog')
  panel.setAttribute('aria-modal', 'true')
  panel.setAttribute('aria-label', REPORT_BUTTON_TEXT)

  const title = document.createElement('div')
  title.classList.add('heading')
  title.textContent = REPORT_BUTTON_TEXT
  const intro = document.createElement('div')
  intro.classList.add('label', 'wrap-note')
  intro.textContent = INTRO
  const status = document.createElement('div')
  status.classList.add('report-status', 'wrap-note')
  status.setAttribute('role', 'status')
  status.textContent = BUILDING
  const box = document.createElement('textarea')
  box.classList.add('report-text', 'scroll-pane')
  box.readOnly = true
  box.setAttribute('aria-label', 'The report')
  box.hidden = true

  const actions = document.createElement('div')
  actions.classList.add('report-actions')
  const issueLink = document.createElement('a')
  issueLink.classList.add('report-link')
  issueLink.textContent = 'Open a GitHub issue'
  issueLink.href = NEW_ISSUE_URL
  issueLink.target = '_blank'
  issueLink.rel = 'noopener noreferrer'
  const copyButton = document.createElement('button')
  copyButton.type = 'button'
  copyButton.textContent = 'Copy'
  copyButton.disabled = true
  const closeButton = document.createElement('button')
  closeButton.type = 'button'
  closeButton.textContent = 'Close'
  actions.append(issueLink, copyButton, closeButton)

  panel.append(title, intro, status, box, actions)
  overlay.appendChild(panel)
  document.body.appendChild(overlay)

  let closed = false
  let report: ProblemReport | null = null

  function close(): void {
    if (closed) return
    closed = true
    document.removeEventListener('keydown', onKey, true)
    overlay.remove()
    openDialog = null
    returnFocus?.focus()
  }

  function onKey(event: KeyboardEvent): void {
    if (event.key !== 'Escape') return
    event.preventDefault()
    event.stopPropagation()
    close()
  }

  // Capture, so Escape closes this dialog before a screen underneath acts on it.
  document.addEventListener('keydown', onKey, true)
  overlay.addEventListener('click', (event) => {
    if (event.target === overlay) close()
  })
  closeButton.addEventListener('click', close)
  copyButton.addEventListener('click', () => {
    if (!report) return
    void copyText(report.body, box).then((ok) => {
      if (!closed) status.textContent = ok ? COPIED : NOT_COPIED
    })
  })

  read().then(
    (result) => {
      if (closed) return
      report = result
      box.value = result.body
      box.hidden = false
      issueLink.href = result.issueUrl
      copyButton.disabled = false
      status.textContent = result.truncated ? TOO_LONG : ''
    },
    () => {
      if (closed) return
      status.textContent = FAILED
      status.classList.add('refused')
    },
  )

  closeButton.focus()
  openDialog = { close }
  return openDialog
}

/** The quiet button every status bar and ingest failure message carries. */
export function reportButton(): HTMLButtonElement {
  const button = document.createElement('button')
  button.type = 'button'
  button.classList.add('report-button')
  button.textContent = REPORT_BUTTON_TEXT
  button.title = 'Build a report you can read first, then post as a GitHub issue'
  button.addEventListener('click', () => {
    openReportDialog()
  })
  return button
}
