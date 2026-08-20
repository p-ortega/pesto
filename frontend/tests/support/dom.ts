// A hand-rolled stand-in for the DOM.
//
// jsdom and happy-dom are not among this project's five approved frontend
// packages (PROJECT.md) -- `npm ci` against frontend/package-lock.json
// resolves neither, they only appear as vitest's own optional peer
// dependencies with nothing installed behind them. So the plan's
// `@vitest-environment jsdom` instruction is not available here; only
// vitest's default node environment is. This implements exactly the
// subset of Document/Element/Event that theme.ts, chrome.ts and
// dir-picker.ts touch, stubbed in via `vi.stubGlobal`, the same pattern
// Plan 05-01 already used for `location`/`history` in token.test.ts.

type Listener = (event: FakeEvent) => void

export class FakeEvent {
  readonly type: string
  readonly key?: string
  defaultPrevented = false

  constructor(type: string, init: { key?: string } = {}) {
    this.type = type
    this.key = init.key
  }

  preventDefault(): void {
    this.defaultPrevented = true
  }
}

class FakeClassList {
  private readonly names = new Set<string>()

  add(name: string): void {
    this.names.add(name)
  }

  contains(name: string): boolean {
    return this.names.has(name)
  }
}

export class FakeTextNode {
  parentNode: FakeElement | null = null

  constructor(public data: string) {}

  get textContent(): string {
    return this.data
  }
}

export class FakeElement {
  readonly tagName: string
  readonly childNodes: Array<FakeElement | FakeTextNode> = []
  readonly attributes = new Map<string, string>()
  readonly style: Record<string, string> = {}
  readonly classList = new FakeClassList()
  parentNode: FakeElement | null = null
  disabled = false
  value = ''
  private readonly listeners = new Map<string, Set<Listener>>()

  constructor(tagName: string) {
    this.tagName = tagName.toUpperCase()
  }

  get children(): FakeElement[] {
    return this.childNodes.filter((node): node is FakeElement => node instanceof FakeElement)
  }

  get textContent(): string {
    return this.childNodes.map((node) => node.textContent).join('')
  }

  set textContent(value: string) {
    this.childNodes.length = 0
    if (value) {
      this.childNodes.push(new FakeTextNode(value))
    }
  }

  appendChild<T extends FakeElement | FakeTextNode>(node: T): T {
    node.parentNode = this
    this.childNodes.push(node)
    return node
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value)
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null
  }

  addEventListener(type: string, listener: Listener): void {
    if (!this.listeners.has(type)) {
      this.listeners.set(type, new Set())
    }
    this.listeners.get(type)?.add(listener)
  }

  removeEventListener(type: string, listener: Listener): void {
    this.listeners.get(type)?.delete(listener)
  }

  // Bubbles unconditionally -- the only delegation this app needs is
  // Escape on the picker's list container, caught from whichever entry
  // dispatched the keydown.
  dispatchEvent(event: FakeEvent): void {
    let node: FakeElement | null = this
    while (node) {
      node.listeners.get(event.type)?.forEach((listener) => listener(event))
      node = node.parentNode
    }
  }
}

export function createFakeDocument(): {
  documentElement: FakeElement
  createElement: (tag: string) => FakeElement
} {
  return {
    documentElement: new FakeElement('html'),
    createElement: (tag: string) => new FakeElement(tag),
  }
}

export function createFakeLocalStorage(initial?: Record<string, string>) {
  const store = new Map<string, string>(Object.entries(initial ?? {}))
  return {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => {
      store.set(key, value)
    },
    removeItem: (key: string) => {
      store.delete(key)
    },
    clear: () => {
      store.clear()
    },
  }
}

export function createThrowingLocalStorage() {
  const fail = () => {
    throw new Error('storage disabled')
  }
  return { getItem: fail, setItem: fail, removeItem: fail, clear: fail }
}

export interface FakeMediaQueryList {
  matches: boolean
  addEventListener: (type: 'change', listener: (event: { matches: boolean }) => void) => void
  removeEventListener: (type: 'change', listener: (event: { matches: boolean }) => void) => void
  setMatches: (value: boolean) => void
}

export function createFakeMediaQueryList(initialMatches: boolean): FakeMediaQueryList {
  let matches = initialMatches
  const listeners = new Set<(event: { matches: boolean }) => void>()
  return {
    get matches() {
      return matches
    },
    addEventListener: (_type, listener) => {
      listeners.add(listener)
    },
    removeEventListener: (_type, listener) => {
      listeners.delete(listener)
    },
    setMatches: (value: boolean) => {
      matches = value
      listeners.forEach((listener) => listener({ matches }))
    },
  }
}

// Waits a couple of macrotask turns so a chain of awaited fetch/json
// promises inside the module under test has settled before an assertion
// runs -- the same need main.test.ts's bootMain() already had.
export async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
  await new Promise((resolve) => setTimeout(resolve, 0))
  await new Promise((resolve) => setTimeout(resolve, 0))
}
