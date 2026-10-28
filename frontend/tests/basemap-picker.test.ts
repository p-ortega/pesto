// @vitest-environment jsdom
//
// The in-map basemap picker with the basemap client and fsRoots mocked.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ImageEntry, ImageListing } from '../src/data/basemap'
import { openBasemapPicker } from '../src/ui/basemap-picker'
import { expectNoRunTogetherText, loadRealStylesheet } from './support/run-together'

const mocks = vi.hoisted(() => ({
  basemapStart: vi.fn(),
  listImages: vi.fn(),
  fsRoots: vi.fn(),
}))

vi.mock('../src/data/basemap', () => ({ basemapStart: mocks.basemapStart, listImages: mocks.listImages }))
vi.mock('../src/data/client', () => ({ fsRoots: mocks.fsRoots }))

const NONE = { otherFiles: 0, notChecked: 0, unreadable: 0 }
const TIFF_REASON = 'TIFF and GeoTIFF basemaps are not supported yet (planned for M2)'

function entry(id: string, name: string, kind: ImageEntry['kind'], extra: Partial<ImageEntry> = {}): ImageEntry {
  return { id, name, kind, note: null, reason: null, ...extra }
}

function listing(entries: ImageEntry[], skipped = NONE): { ok: true; listing: ImageListing } {
  return { ok: true, listing: { entries, skipped } }
}

const RUN_LEVEL = listing([
  entry('d-maps', 'maps', 'folder'),
  entry('f-png', 'aerial.png', 'png', { note: 'the extension says .jpg but the bytes are PNG' }),
  entry('f-jpg', 'photo.jpg', 'jpeg'),
  entry('f-tif', 'dem.tif', 'tiff', { reason: TIFF_REASON }),
  entry('f-link', 'outside.png', 'link', { reason: 'this link points outside the folder' }),
])

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve()
  await new Promise((resolve) => setTimeout(resolve, 0))
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

function dialog(host: HTMLElement): HTMLElement {
  const found = host.querySelector<HTMLElement>('[role="dialog"]')
  if (!found) throw new Error('no dialog')
  return found
}

function crumbNames(host: HTMLElement): string[] {
  return Array.from(host.querySelectorAll('.basemap-picker-crumbs button')).map((b) => b.textContent ?? '')
}

function rowNames(host: HTMLElement): string[] {
  return Array.from(host.querySelectorAll('.basemap-picker-name')).map((n) => n.textContent ?? '')
}

function row(host: HTMLElement, name: string): HTMLButtonElement {
  const found = Array.from(host.querySelectorAll<HTMLButtonElement>('.basemap-picker-row')).find(
    (b) => b.querySelector('.basemap-picker-name')?.textContent === name,
  )
  if (!found) throw new Error(`no row ${name}`)
  return found
}

function button(host: HTMLElement, text: string): HTMLButtonElement {
  const found = Array.from(host.querySelectorAll<HTMLButtonElement>('button')).find((b) => b.textContent === text)
  if (!found) throw new Error(`no button ${text}`)
  return found
}

async function open(onPick = vi.fn(), onClose = vi.fn()) {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const handle = openBasemapPicker(host, { onPick, onClose })
  await settle()
  return { host, handle, onPick, onClose }
}

beforeEach(() => {
  document.body.textContent = ''
  mocks.basemapStart.mockReset().mockResolvedValue({ ok: true, folder: { id: 'r1', name: 'my-run' } })
  mocks.listImages.mockReset().mockImplementation(async (id: string) => {
    if (id === 'r1') return RUN_LEVEL
    if (id === 'd-maps') return listing([entry('f-deep', 'deep.png', 'png')])
    return listing([])
  })
  mocks.fsRoots.mockReset().mockResolvedValue([
    { id: 'root-home', name: '~', isRun: false, reason: null },
    { id: 'root-vol', name: '/Volumes/archive', isRun: false, reason: 'that folder cannot be read' },
  ])
})

afterEach(() => {
  document.head.textContent = ''
})

describe('openBasemapPicker', () => {
  it('opens a labelled modal dialog on the run folder under a Start crumb', async () => {
    const { host } = await open()
    const d = dialog(host)
    expect(d.getAttribute('aria-modal')).toBe('true')
    expect(d.getAttribute('aria-label')).toBe('Choose a basemap image')
    expect(mocks.basemapStart).toHaveBeenCalledTimes(1)
    expect(mocks.listImages).toHaveBeenCalledWith('r1', expect.objectContaining({ signal: expect.any(AbortSignal) }))
    expect(crumbNames(host)).toEqual(['Start', 'my-run'])
    expect(rowNames(host)).toEqual(['maps', 'aerial.png', 'photo.jpg', 'dem.tif', 'outside.png'])
    expect(document.activeElement).toBe(row(host, 'maps'))
  })

  it('enters a folder, adds a crumb, and shows an earlier level from the cache with no new request', async () => {
    const { host } = await open()
    row(host, 'maps').click()
    await settle()
    expect(crumbNames(host)).toEqual(['Start', 'my-run', 'maps'])
    expect(rowNames(host)).toEqual(['deep.png'])

    const calls = mocks.listImages.mock.calls.length
    button(host, 'my-run').click()
    await settle()
    expect(mocks.listImages.mock.calls.length).toBe(calls)
    expect(crumbNames(host)).toEqual(['Start', 'my-run'])
    expect(rowNames(host)).toContain('aerial.png')
  })

  it('lists the starting places as folders under Start, so any folder the run picker reaches is reachable', async () => {
    const { host } = await open()
    button(host, 'Start').click()
    await settle()
    expect(mocks.fsRoots).toHaveBeenCalledTimes(1)
    expect(crumbNames(host)).toEqual(['Start'])
    expect(rowNames(host)).toEqual(['~', '/Volumes/archive'])
    expect(row(host, '/Volumes/archive').disabled).toBe(true)
    expect(row(host, '/Volumes/archive').textContent).toContain('that folder cannot be read')

    row(host, '~').click()
    await settle()
    expect(mocks.listImages).toHaveBeenLastCalledWith('root-home', expect.anything())
    expect(crumbNames(host)).toEqual(['Start', '~'])
  })

  it('hands a PNG or JPEG to onPick with its id and name and closes', async () => {
    const { host, onPick, onClose } = await open()
    row(host, 'photo.jpg').click()
    expect(onPick).toHaveBeenCalledWith({ id: 'f-jpg', name: 'photo.jpg' })
    expect(host.querySelector('[role="dialog"]')).toBeNull()
    expect(onClose).not.toHaveBeenCalled()
  })

  it('shows TIFF and link rows disabled with their reasons, and a click does nothing', async () => {
    const { host, onPick } = await open()
    const tiff = row(host, 'dem.tif')
    const link = row(host, 'outside.png')
    expect(tiff.disabled).toBe(true)
    expect(link.disabled).toBe(true)
    expect(tiff.querySelector('.basemap-picker-reason')?.textContent).toBe(TIFF_REASON)
    expect(link.querySelector('.basemap-picker-reason')?.textContent).toBe('this link points outside the folder')
    tiff.click()
    link.click()
    expect(onPick).not.toHaveBeenCalled()
    expect(host.querySelector('[role="dialog"]')).not.toBeNull()
  })

  it('shows a row note under its name', async () => {
    const { host } = await open()
    expect(row(host, 'aerial.png').querySelector('.basemap-picker-note')?.textContent).toBe(
      'the extension says .jpg but the bytes are PNG',
    )
  })

  it('says how many files it did not show and why, and says nothing for zero counts', async () => {
    mocks.listImages.mockResolvedValueOnce(listing([], { otherFiles: 3, notChecked: 12, unreadable: 2 }))
    const { host } = await open()
    const lines = Array.from(host.querySelectorAll('.basemap-picker-skipped > div')).map((d) => d.textContent)
    expect(lines).toEqual([
      '3 other files are not shown: they are not PNG, JPEG or TIFF',
      '12 files were not checked: the folder holds more than pesto reads at once',
      '2 files could not be read',
    ])
  })

  it('shows no skipped line when every count is zero', async () => {
    const { host } = await open()
    expect(host.querySelectorAll('.basemap-picker-skipped > div').length).toBe(0)
  })

  it('closes on Escape and calls onClose once', async () => {
    const { host, onClose, handle } = await open()
    dialog(host).dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    expect(host.querySelector('.basemap-picker')).toBeNull()
    handle.close()
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('closes on Cancel and calls onClose once', async () => {
    const { host, onClose } = await open()
    const cancel = button(host, 'Cancel')
    cancel.click()
    cancel.click()
    expect(host.querySelector('.basemap-picker')).toBeNull()
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('shows a refused listing inside the dialog and keeps the last good level', async () => {
    mocks.listImages.mockImplementation(async (id: string) =>
      id === 'r1' ? RUN_LEVEL : { ok: false, reason: 'that folder is no longer available', code: null },
    )
    const { host } = await open()
    row(host, 'maps').click()
    await settle()
    expect(dialog(host).querySelector('.basemap-picker-status')?.textContent).toBe('that folder is no longer available')
    expect(crumbNames(host)).toEqual(['Start', 'my-run'])
    expect(rowNames(host)).toContain('aerial.png')
  })

  it('shows a refused start inside the dialog', async () => {
    mocks.basemapStart.mockResolvedValue({ ok: false, reason: 'no run is open', code: 'no_run' })
    const { host } = await open()
    expect(dialog(host).querySelector('.basemap-picker-status')?.textContent).toBe('no run is open')
    expect(crumbNames(host)).toEqual(['Start'])
  })

  it('drops a slower listing for a folder the user has already left', async () => {
    mocks.listImages.mockResolvedValueOnce(
      listing([entry('d-a', 'A', 'folder'), entry('d-b', 'B', 'folder')]),
    )
    const a = deferred<unknown>()
    const b = deferred<unknown>()
    const { host } = await open()
    mocks.listImages.mockImplementation((id: string) => (id === 'd-a' ? a.promise : b.promise))

    row(host, 'A').click()
    row(host, 'B').click()
    b.resolve(listing([entry('f-b', 'from-b.png', 'png')]))
    await settle()
    a.resolve(listing([entry('f-a', 'from-a.png', 'png')]))
    await settle()

    expect(rowNames(host)).toEqual(['from-b.png'])
    expect(crumbNames(host)).toEqual(['Start', 'my-run', 'B'])
  })

  it('renders a file name holding markup as text', async () => {
    mocks.listImages.mockResolvedValueOnce(listing([entry('f-x', '<img src=x onerror=alert(1)>.png', 'png')]))
    const { host } = await open()
    expect(rowNames(host)).toEqual(['<img src=x onerror=alert(1)>.png'])
    expect(host.querySelector('img')).toBeNull()
  })

  it('keeps every part of a row apart with the real stylesheet', async () => {
    loadRealStylesheet()
    mocks.listImages.mockResolvedValueOnce(listing(RUN_LEVEL.listing.entries, { otherFiles: 1, notChecked: 1, unreadable: 1 }))
    const { host } = await open()
    expectNoRunTogetherText(dialog(host), 'basemap-picker')
    const lines = Array.from(host.querySelectorAll('.basemap-picker-skipped > div')).map((d) => d.textContent)
    expect(lines).toEqual([
      '1 other file is not shown: it is not PNG, JPEG or TIFF',
      '1 file was not checked: the folder holds more than pesto reads at once',
      '1 file could not be read',
    ])
  })
})
