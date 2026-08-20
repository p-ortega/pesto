import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderNotice, renderStatusBar } from '../src/ui/chrome'
import {
  createFakeDocument,
  createFakeLocalStorage,
  createFakeMediaQueryList,
  createThrowingLocalStorage,
  type FakeMediaQueryList,
} from './support/dom'

const testDir = dirname(fileURLToPath(import.meta.url))

function stubEnvironment(options: {
  storedTheme?: string
  darkMatches?: boolean
  throwingStorage?: boolean
}): FakeMediaQueryList {
  vi.stubGlobal('document', createFakeDocument())

  const mediaQuery = createFakeMediaQueryList(options.darkMatches ?? false)
  vi.stubGlobal('matchMedia', () => mediaQuery)

  vi.stubGlobal(
    'localStorage',
    options.throwingStorage
      ? createThrowingLocalStorage()
      : createFakeLocalStorage(options.storedTheme ? { 'pesto.theme': options.storedTheme } : {}),
  )

  return mediaQuery
}

async function freshTheme() {
  vi.resetModules()
  return import('../src/ui/theme')
}

describe('initTheme', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('resolves an empty store to the system preference', async () => {
    stubEnvironment({ darkMatches: true })
    const { initTheme } = await freshTheme()
    initTheme()
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark')
  })

  it('a stored light choice wins over a dark system preference', async () => {
    stubEnvironment({ storedTheme: 'light', darkMatches: true })
    const { initTheme } = await freshTheme()
    initTheme()
    expect(document.documentElement.getAttribute('data-theme')).toBe('light')
  })

  it('a stored dark choice survives a reload', async () => {
    stubEnvironment({ storedTheme: 'dark', darkMatches: false })
    const { initTheme } = await freshTheme()
    initTheme()
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark')
  })

  it('does not throw with storage disabled, and resolves to system', async () => {
    stubEnvironment({ throwingStorage: true, darkMatches: true })
    const { initTheme, currentTheme } = await freshTheme()
    expect(() => initTheme()).not.toThrow()
    expect(currentTheme()).toBe('system')
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark')
  })
})

describe('setTheme / currentTheme', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('setTheme persists the choice and currentTheme reads it back after a reload', async () => {
    stubEnvironment({ darkMatches: false })
    const { setTheme, currentTheme, initTheme } = await freshTheme()
    setTheme('dark')
    initTheme()
    expect(currentTheme()).toBe('dark')
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark')
  })

  it('currentTheme reports system, not the value it resolves to', async () => {
    stubEnvironment({ darkMatches: true })
    const { setTheme, currentTheme } = await freshTheme()
    setTheme('system')
    expect(currentTheme()).toBe('system')
  })

  it('a live system change flips the attribute after setTheme("system")', async () => {
    const mediaQuery = stubEnvironment({ darkMatches: false })
    const { setTheme } = await freshTheme()
    setTheme('system')
    expect(document.documentElement.getAttribute('data-theme')).toBe('light')
    mediaQuery.setMatches(true)
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark')
  })
})

describe('renderNotice', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('renders a heading and a non-empty element for every tone', () => {
    const doc = createFakeDocument()
    vi.stubGlobal('document', doc)
    for (const tone of ['info', 'warning', 'serious', 'critical'] as const) {
      const el = doc.createElement('div')
      renderNotice(el as unknown as HTMLElement, { title: `refused-${tone}`, tone })
      expect(el.textContent).toContain(`refused-${tone}`)
      expect(el.children.length).toBeGreaterThan(0)
    }
  })

  it('renders a title with no detail without throwing', () => {
    const doc = createFakeDocument()
    vi.stubGlobal('document', doc)
    const el = doc.createElement('div')
    expect(() =>
      renderNotice(el as unknown as HTMLElement, { title: 'ok', tone: 'critical' }),
    ).not.toThrow()
    expect(el.textContent).toContain('ok')
  })
})

describe('renderStatusBar', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('renders every figure with the tabular-nums class', () => {
    const doc = createFakeDocument()
    vi.stubGlobal('document', doc)
    const el = doc.createElement('div')
    renderStatusBar(el as unknown as HTMLElement, { ingested: 2.1 })
    const field = el.children[0]
    const value = field.children[1]
    expect(value.classList.contains('tabular-nums')).toBe(true)
    expect(value.textContent).toBe('2.1')
  })

  it('renders a placeholder dash for a null figure, keeping its label', () => {
    const doc = createFakeDocument()
    vi.stubGlobal('document', doc)
    const el = doc.createElement('div')
    renderStatusBar(el as unknown as HTMLElement, { ingested: null })
    expect(el.textContent).toContain('ingested')
    expect(el.textContent).toContain('—')
  })
})

describe('no colour literals', () => {
  it('theme.ts and chrome.ts contain no hex, rgb() or hsl() colour', () => {
    const pattern = /#[0-9a-fA-F]{3,8}\b|rgb\(|hsl\(/
    for (const relative of ['../src/ui/theme.ts', '../src/ui/chrome.ts']) {
      const source = readFileSync(join(testDir, relative), 'utf8')
      expect(pattern.test(source)).toBe(false)
    }
  })
})
