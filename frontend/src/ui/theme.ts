// Dark, Light or System. The resolved value paints `data-theme` on the
// document; the stored choice is what a control renders as selected --
// kept distinct from whichever of dark/light it currently resolves to, so
// a "System" control does not flip to reading "Dark" the moment the OS
// preference does.

export type ThemeChoice = 'dark' | 'light' | 'system'

const STORAGE_KEY = 'pesto.theme'
const DARK_QUERY = '(prefers-color-scheme: dark)'

let activeQuery: MediaQueryList | null = null
let activeListener: ((event: MediaQueryListEvent) => void) | null = null

function isThemeChoice(value: string | null): value is ThemeChoice {
  return value === 'dark' || value === 'light' || value === 'system'
}

function readStored(): ThemeChoice {
  try {
    const value = localStorage.getItem(STORAGE_KEY)
    return isThemeChoice(value) ? value : 'system'
  } catch {
    // A browser with storage disabled falls back to system rather than
    // throwing during boot.
    return 'system'
  }
}

function writeStored(choice: ThemeChoice): void {
  try {
    localStorage.setItem(STORAGE_KEY, choice)
  } catch {
    // Keeps the choice for this tab only; boot must not fail over it.
  }
}

function resolve(choice: ThemeChoice): 'dark' | 'light' {
  if (choice !== 'system') {
    return choice
  }
  return matchMedia(DARK_QUERY).matches ? 'dark' : 'light'
}

function unsubscribe(): void {
  if (activeQuery && activeListener) {
    activeQuery.removeEventListener('change', activeListener)
  }
  activeQuery = null
  activeListener = null
}

function apply(choice: ThemeChoice): void {
  unsubscribe()
  document.documentElement.setAttribute('data-theme', resolve(choice))

  if (choice === 'system') {
    const query = matchMedia(DARK_QUERY)
    const listener = (event: MediaQueryListEvent): void => {
      document.documentElement.setAttribute('data-theme', event.matches ? 'dark' : 'light')
    }
    query.addEventListener('change', listener)
    activeQuery = query
    activeListener = listener
  }
}

export function initTheme(): void {
  apply(readStored())
}

export function setTheme(choice: ThemeChoice): void {
  writeStored(choice)
  apply(choice)
}

export function currentTheme(): ThemeChoice {
  return readStored()
}
