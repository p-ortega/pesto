// @vitest-environment jsdom
//
// "Report a problem": the dialog, and the button on every screen's status bar
// and beside an ingest failure message.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fetchReport, NEW_ISSUE_URL, type ProblemReport } from '../src/data/report'
import { renderStatusBar } from '../src/ui/chrome'
import { mountPicker } from '../src/ui/dir-picker'
import { mountEstimate, mountProgress } from '../src/ui/progress'
import { openReportDialog, reportButton, REPORT_BUTTON_TEXT } from '../src/ui/report'
import { expectNoRunTogetherText, loadRealStylesheet } from './support/run-together'

const BODY = '## What happened\n\n- pesto: 0.1.0\n- par_ens/1: failed\n  - reason: failed to read <path>/<case>.1.par.jcb'
const REPORT: ProblemReport = {
  title: 'pesto 0.1.0: par_ens/1 failed',
  body: BODY,
  issueUrl: `${NEW_ISSUE_URL}?title=pesto&body=report`,
  truncated: false,
}
const INTRO =
  'This is everything pesto will put in the report. It leaves out your case name, folders, ' +
  'and parameter, group and site names. Read it before you send it.'

function jsonResponse(status: number, body: unknown) {
  return { ok: status >= 200 && status < 300, status, json: async () => body }
}

async function settle(): Promise<void> {
  for (let i = 0; i < 6; i += 1) await new Promise((resolve) => setTimeout(resolve, 0))
}

function dialog(): HTMLElement | null {
  return document.querySelector<HTMLElement>('[role="dialog"]')
}

function buttonNamed(root: ParentNode, text: string): HTMLButtonElement {
  const found = Array.from(root.querySelectorAll('button')).find((b) => b.textContent === text)
  if (!found) throw new Error(`no button "${text}"`)
  return found
}

function stubTheme(): void {
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener: () => undefined, removeEventListener: () => undefined }))
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => undefined })
}

beforeEach(() => {
  loadRealStylesheet()
  stubTheme()
})

afterEach(() => {
  document.querySelectorAll('.report-overlay').forEach((el) => {
    buttonNamed(el, 'Close').click()
  })
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  document.head.textContent = ''
  document.body.textContent = ''
})

describe('the report dialog', () => {
  it('opens as a modal dialog titled "Report a problem" with the one plain sentence', async () => {
    openReportDialog(async () => REPORT)
    await settle()

    const panel = dialog()
    expect(panel).not.toBeNull()
    expect(panel!.getAttribute('aria-modal')).toBe('true')
    expect(panel!.getAttribute('aria-label')).toBe('Report a problem')
    expect(panel!.querySelector('.heading')!.textContent).toBe('Report a problem')
    expect(panel!.textContent).toContain(INTRO)
  })

  it('shows the whole report in a read-only text box', async () => {
    openReportDialog(async () => REPORT)
    await settle()

    const box = dialog()!.querySelector('textarea')!
    expect(box.readOnly).toBe(true)
    expect(box.hidden).toBe(false)
    expect(box.value).toBe(BODY)
  })

  it('says it is building the report until the report arrives', async () => {
    let arrive!: (report: ProblemReport) => void
    openReportDialog(() => new Promise<ProblemReport>((resolve) => (arrive = resolve)))

    expect(dialog()!.querySelector('[role="status"]')!.textContent).toBe('Building the report…')
    expect(dialog()!.querySelector('textarea')!.hidden).toBe(true)
    expect(buttonNamed(dialog()!, 'Copy').disabled).toBe(true)

    arrive(REPORT)
    await settle()
    expect(dialog()!.querySelector('[role="status"]')!.textContent).toBe('')
    expect(buttonNamed(dialog()!, 'Copy').disabled).toBe(false)
  })

  it('"Open a GitHub issue" points at the issue link, in a new tab, with noopener', async () => {
    openReportDialog(async () => REPORT)
    await settle()

    const link = dialog()!.querySelector('a')!
    expect(link.textContent).toBe('Open a GitHub issue')
    expect(link.getAttribute('href')).toBe(REPORT.issueUrl)
    expect(link.target).toBe('_blank')
    expect(link.rel.split(' ')).toContain('noopener')
  })

  it('Copy puts the whole report on the clipboard and says so', async () => {
    const writeText = vi.fn(async () => undefined)
    vi.stubGlobal('navigator', { clipboard: { writeText } })
    openReportDialog(async () => REPORT)
    await settle()

    buttonNamed(dialog()!, 'Copy').click()
    await settle()

    expect(writeText).toHaveBeenCalledWith(BODY)
    expect(dialog()!.querySelector('[role="status"]')!.textContent).toBe('Copied.')
  })

  it('says plainly when the report could not be copied', async () => {
    vi.stubGlobal('navigator', {
      clipboard: {
        writeText: async () => {
          throw new Error('denied')
        },
      },
    })
    openReportDialog(async () => REPORT)
    await settle()

    buttonNamed(dialog()!, 'Copy').click()
    await settle()

    expect(dialog()!.querySelector('[role="status"]')!.textContent).toBe(
      'The report could not be copied. Select the text and copy it yourself.',
    )
  })

  it('Close removes the dialog and gives the focus back', async () => {
    const opener = document.createElement('button')
    document.body.appendChild(opener)
    opener.focus()
    openReportDialog(async () => REPORT)
    await settle()

    buttonNamed(dialog()!, 'Close').click()

    expect(dialog()).toBeNull()
    expect(document.activeElement).toBe(opener)
  })

  it('Escape closes the dialog', async () => {
    openReportDialog(async () => REPORT)
    await settle()

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))

    expect(dialog()).toBeNull()
  })

  it('a second press while it is open does not stack a second dialog', async () => {
    openReportDialog(async () => REPORT)
    openReportDialog(async () => REPORT)
    await settle()

    expect(document.querySelectorAll('[role="dialog"]').length).toBe(1)
  })

  it('says so plainly when the report cannot be built, and still links to the issues page', async () => {
    openReportDialog(async () => {
      throw new Error('boom')
    })
    await settle()

    const panel = dialog()!
    expect(panel.querySelector('[role="status"]')!.textContent).toBe(
      'pesto could not build the report. You can still write the issue yourself on GitHub.',
    )
    expect(panel.querySelector('textarea')!.hidden).toBe(true)
    expect(buttonNamed(panel, 'Copy').disabled).toBe(true)
    const link = panel.querySelector('a')!
    expect(link.getAttribute('href')).toBe(NEW_ISSUE_URL)
    expect(link.target).toBe('_blank')
  })

  it('says to paste the report when it is too long for the link', async () => {
    openReportDialog(async () => ({ ...REPORT, truncated: true }))
    await settle()

    expect(dialog()!.querySelector('[role="status"]')!.textContent).toBe(
      'The report is too long for the link. Press Copy, then paste it into the issue.',
    )
  })

  it('never runs its text together', async () => {
    openReportDialog(async () => ({ ...REPORT, truncated: true }))
    await settle()

    expectNoRunTogetherText(dialog()!, 'report.ts dialog')
  })

  it('uses none of the words kept off the screen', async () => {
    openReportDialog(async () => REPORT)
    await settle()
    const words = (dialog()!.textContent ?? '').toLowerCase()

    for (const word of ['source', 'chip', 'drill-down']) expect(words).not.toContain(word)
  })
})

describe('fetchReport', () => {
  it('reads the report from /api/report and maps the wire names', async () => {
    const fetchStub = vi.fn(async (_route: string) =>
      jsonResponse(200, { title: 't', body: 'b', issue_url: `${NEW_ISSUE_URL}?title=t&body=b`, truncated: true }),
    )
    vi.stubGlobal('fetch', fetchStub)

    const report = await fetchReport()

    expect(fetchStub.mock.calls[0][0]).toBe('/api/report')
    expect(report).toEqual({ title: 't', body: 'b', issueUrl: `${NEW_ISSUE_URL}?title=t&body=b`, truncated: true })
  })

  it('opens nothing but the new-issue page, whatever link the server sent', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(200, { title: 't', body: 'b', issue_url: 'https://example.com/x' })))

    expect((await fetchReport()).issueUrl).toBe(NEW_ISSUE_URL)
  })
})

describe('the report button', () => {
  it('fetches the report and opens the dialog when pressed', async () => {
    const fetchStub = vi.fn(async () => jsonResponse(200, { title: 't', body: BODY, issue_url: NEW_ISSUE_URL, truncated: false }))
    vi.stubGlobal('fetch', fetchStub)
    const button = reportButton()
    document.body.appendChild(button)

    button.click()
    await settle()

    expect(fetchStub).toHaveBeenCalledTimes(1)
    expect(dialog()!.querySelector('textarea')!.value).toBe(BODY)
  })

  it('is the last thing renderStatusBar puts on a status bar, however often it repaints', () => {
    const bar = document.createElement('div')
    bar.classList.add('status-bar')
    renderStatusBar(bar, { 'Ingest time': '39.9 s' })
    renderStatusBar(bar, { 'Ingest time': '39.9 s', 'Cache size': '264.9 MB' })

    const buttons = bar.querySelectorAll('.report-button')
    expect(buttons.length).toBe(1)
    expect(bar.lastElementChild).toBe(buttons[0])
    expect(buttons[0].textContent).toBe(REPORT_BUTTON_TEXT)
    expectNoRunTogetherText(bar, 'status bar with the report button')
  })
})

describe('every screen with a status bar carries the report button', () => {
  function statusBarButton(root: HTMLElement): Element | null {
    return root.querySelector('.status-bar .report-button')
  }

  it('the welcome screen, before and after the first folder listing', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(200, [{ id: 'a', name: 'runs', is_run: false, reason: null }])))
    const root = document.createElement('div')
    document.body.appendChild(root)

    mountPicker(root, { onOpened: () => undefined })
    expect(statusBarButton(root)).not.toBeNull()
    await settle()
    expect(statusBarButton(root)).not.toBeNull()
  })

  it('the welcome screen when the folder listing fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(500, { type: 'about:blank', title: 'boom', status: 500 })))
    const root = document.createElement('div')
    document.body.appendChild(root)

    mountPicker(root, { onOpened: () => undefined })
    await settle()

    expect(statusBarButton(root)).not.toBeNull()
  })

  it('the estimate screen', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse(200, { total: 1, per_artifact: [], notes: [], free_bytes: 2, cache_root_exists: true })),
    )
    const root = document.createElement('div')
    document.body.appendChild(root)

    await mountEstimate(root, { onAgree: () => undefined, onDecline: () => undefined })

    expect(statusBarButton(root)).not.toBeNull()
  })

  it('the ingest progress screen, from the moment it is shown', () => {
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => undefined)))
    const root = document.createElement('div')
    document.body.appendChild(root)

    const stop = mountProgress(root, { onFinished: () => undefined })

    expect(statusBarButton(root)).not.toBeNull()
    stop()
  })
})

describe('an ingest failure message carries the report button beside it', () => {
  const encoder = new TextEncoder()

  function streamOf(text: string) {
    let sent = false
    return {
      ok: true,
      status: 200,
      body: {
        getReader: () => ({
          read: async () => {
            if (sent) return { done: true, value: undefined }
            sent = true
            return { done: false, value: encoder.encode(text) }
          },
          releaseLock: () => undefined,
        }),
      },
    }
  }

  function row(overrides: Record<string, unknown>): string {
    const body = { artifact: 'grid', state: 'ok', index: 0, total: 2, source_bytes: 1, written_bytes: 1, seconds: 1, reason: null, notes: [], ...overrides }
    return `data: ${JSON.stringify(body)}\n\n`
  }

  function mountWithStream(text: string, startStatus = 202): HTMLElement {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string, init?: RequestInit) => {
        const path = new URL(input, 'http://localhost').pathname
        if (path === '/api/run/ingest' && init?.method === 'POST') {
          return jsonResponse(startStatus, startStatus >= 400 ? { type: 'about:blank', title: 'no', status: startStatus } : { started: true })
        }
        if (path === '/api/run/ingest/events') return streamOf(text)
        throw new Error(`unhandled request: ${path}`)
      }),
    )
    const root = document.createElement('div')
    document.body.appendChild(root)
    mountProgress(root, { onFinished: () => undefined })
    return root
  }

  it('a failed row has the button in the same row as its reason, and a row that worked has none', async () => {
    const root = mountWithStream(
      row({ artifact: 'grid' }) + row({ artifact: 'par_ens/1', state: 'failed', reason: 'the header could not be read' }),
    )
    await settle()

    const items = Array.from(root.querySelectorAll('li')).filter((li) => li.parentElement?.classList.contains('scroll-pane'))
    expect(items.length).toBe(2)
    expect(items[0].querySelector('.report-button')).toBeNull()
    expect(items[1].textContent).toContain('the header could not be read')
    expect(items[1].querySelectorAll('.report-button').length).toBe(1)
    expectNoRunTogetherText(items[1], 'a failed ingest row')
  })

  it('an ingest that stops with an error says so, with the button beside the message', async () => {
    const root = mountWithStream('event: error\ndata: {"title":"ingest failed","status":500,"detail":"the worker stopped"}\n\n')
    await settle()

    const beside = root.querySelector('.report-beside')
    expect(beside).not.toBeNull()
    expect(beside!.textContent).toContain('the ingest failed')
    expect(beside!.textContent).toContain('the worker stopped')
    expect(beside!.querySelector('.report-button')).not.toBeNull()
    expectNoRunTogetherText(beside as HTMLElement, 'an ingest failure notice')
  })

  it('an ingest that could not be started has the button beside the message', async () => {
    const root = mountWithStream('', 500)
    await settle()

    const beside = root.querySelector('.report-beside')
    expect(beside!.textContent).toContain('the ingest could not be started')
    expect(beside!.querySelector('.report-button')).not.toBeNull()
  })
})
