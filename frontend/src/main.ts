// The boot sequence and the screen router: picker, estimate, progress and
// the placeholder, joined into the one flow the phase promises. D-13 is a
// routing rule rather than a screen -- a run whose cache is already fresh
// mounts the placeholder directly, with neither the estimate gate nor the
// progress screen ever shown. No history entry and no hash route is ever
// added here: the address bar was deliberately stripped of the token at
// boot (D-08), and putting state back into it would be the first step
// toward putting the token back too.

import { readTokenOnce } from './auth/token'
import { apiGet, ApiError, ingestState, type IngestState } from './data/client'
import { renderNotice } from './ui/chrome'
import { mountPicker } from './ui/dir-picker'
import { mountEstimate, mountProgress } from './ui/progress'
import { initTheme } from './ui/theme'
import { mountPlaceholder, type RunConfig } from './views/placeholder'

let activeTeardown: (() => void) | null = null

function getRoot(): HTMLElement {
  const app = document.getElementById('app')
  if (!app) {
    throw new Error('the root element #app is missing from the page')
  }
  return app
}

// Every screen transition runs through here first, so a screen that reads
// a stream -- only the progress screen does today -- always has its read
// aborted the moment the flow moves on, whatever the reason for moving.
function clearTeardown(): void {
  if (activeTeardown) {
    activeTeardown()
    activeTeardown = null
  }
}

// A run that could not be reached at all -- a network failure, or an
// ingest-state read that itself fails -- must still say so on screen
// rather than leave a blank page. This is the same failure CLAUDE.md's
// "never answer when you cannot tell" rule exists to stop, and the one
// Plan 05-01's own checkpoint caught for the tracer's single route.
function renderBootFailure(error: unknown): void {
  clearTeardown()
  const root = getRoot()
  root.textContent = ''
  const panel = document.createElement('div')
  root.appendChild(panel)

  if (error instanceof ApiError) {
    renderNotice(panel, {
      title: error.problem.title,
      detail: error.problem.detail,
      tone: 'critical',
    })
    return
  }
  renderNotice(panel, { title: 'pesto could not start', tone: 'critical' })
}

function isNoRunOpen(error: unknown): boolean {
  return error instanceof ApiError && error.problem.status === 409
}

// A run can be open with nothing ingested for it yet -- the config
// artifact simply is not readable, which is ordinary before a first
// ingest, not a failure to report here. The freshness check that follows
// decides where to go regardless of this read's own outcome.
async function loadConfig(): Promise<RunConfig | null> {
  try {
    return (await apiGet('/api/run/config')) as RunConfig
  } catch {
    return null
  }
}

function showPicker(): void {
  clearTeardown()
  mountPicker(getRoot(), {
    onOpened: () => {
      void afterRunOpened()
    },
  })
}

function showEstimate(): void {
  clearTeardown()
  void mountEstimate(getRoot(), {
    onAgree: () => showProgress(),
    onDecline: () => showPicker(),
  })
}

function showProgress(): void {
  clearTeardown()
  activeTeardown = mountProgress(getRoot(), {
    onFinished: () => {
      void afterIngestFinished()
    },
  })
}

function showPlaceholder(config: RunConfig | null, state: IngestState): void {
  clearTeardown()
  mountPlaceholder(getRoot(), { config, state })
}

// D-13: the freshness answer decides how many screens the user sees. A
// fresh cache shows the placeholder immediately, with the recorded ingest
// time and cache size already in the state response -- so the figures are
// on screen without a screen of their own for them.
async function routeByFreshness(config: RunConfig | null): Promise<void> {
  let state: IngestState
  try {
    state = await ingestState()
  } catch (error) {
    renderBootFailure(error)
    return
  }

  if (state.fresh) {
    showPlaceholder(config, state)
    return
  }

  showEstimate()
}

// The picker's own onOpened callback does not assume a freshly-opened run
// is cold -- a user may open one they ingested last week, and that path
// must skip the estimate and progress screens exactly like a warm boot.
async function afterRunOpened(): Promise<void> {
  const config = await loadConfig()
  await routeByFreshness(config)
}

// The progress screen always ends at the placeholder, whatever state the
// ingest left the artifacts in -- routing through the freshness check
// again here could bounce a cancelled or partial ingest straight back to
// the estimate screen it just left.
async function afterIngestFinished(): Promise<void> {
  const config = await loadConfig()
  let state: IngestState
  try {
    state = await ingestState()
  } catch (error) {
    renderBootFailure(error)
    return
  }
  showPlaceholder(config, state)
}

async function boot(): Promise<void> {
  readTokenOnce()
  initTheme()

  let config: RunConfig | null = null
  try {
    config = (await apiGet('/api/run/config')) as RunConfig
  } catch (error) {
    if (isNoRunOpen(error)) {
      showPicker()
      return
    }
    // A run is open but its config could not be read yet -- see
    // loadConfig's note above. Fall through with no config in hand.
  }

  await routeByFreshness(config)
}

void boot()
