// The boot sequence and the screen router: picker, estimate, progress and
// the map, joined into the one flow the phase promises. D-13 is a
// routing rule rather than a screen -- a run whose cache is already fresh
// mounts the map directly, with neither the estimate gate nor the
// progress screen ever shown. No history entry and no hash route is ever
// added here: the address bar was deliberately stripped of the token at
// boot (D-08), and putting state back into it would be the first step
// toward putting the token back too.

import { forgetToken, hasToken, readTokenOnce } from './auth/token'
import { apiGet, ApiError, ingestState, type IngestState, type RewriteFacts } from './data/client'
import { renderNotice, type RenderNoticeOptions } from './ui/chrome'
import { mountPicker } from './ui/dir-picker'
import { mountEstimate, mountProgress } from './ui/progress'
import { initTheme } from './ui/theme'
import { mountMap, type RunConfig } from './views/map'

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

function isTokenRejected(error: unknown): boolean {
  return error instanceof ApiError && error.problem.status === 401
}

// The token is stripped from the address bar at boot, so a tab that has lost
// it cannot get it back on its own. Say that plainly instead of showing the
// server's "invalid or missing token", which reads like a fault rather than
// an expired session and leaves the user with nothing to do.
function renderSessionEnded(): void {
  clearTeardown()
  const root = getRoot()
  root.textContent = ''
  const panel = document.createElement('div')
  root.appendChild(panel)
  renderNotice(panel, {
    title: 'This session has ended',
    detail:
      'The link that opened pesto works once. Relaunch pesto from the terminal to start a new session.',
    tone: 'warning',
  })
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

function showProgress(notices: RenderNoticeOptions[] = []): void {
  clearTeardown()
  activeTeardown = mountProgress(getRoot(), {
    notices,
    onFinished: () => {
      void afterIngestFinished()
    },
  })
}

// A cache made at a higher version than this pesto writes came from a
// different pesto, not an older one; saying "older" there would be wrong.
function whoMadeIt(rewrite: RewriteFacts): string {
  return rewrite.found > rewrite.expected ? 'a different pesto' : 'an older pesto'
}

function rewriteNotices(rewrite: RewriteFacts): RenderNoticeOptions[] {
  return [
    {
      title: `This cache was made by ${whoMadeIt(rewrite)} (cache version ${rewrite.found}). Re-reading the run once.`,
      tone: 'info',
    },
  ]
}

// D-07: an old cache in a folder pesto cannot write to is neither read nor
// rewritten. Say so, name the folder (already shortened to ~ by the server)
// and the one thing the user can do about it.
function renderRewriteRefusal(rewrite: RewriteFacts): void {
  clearTeardown()
  const root = getRoot()
  root.textContent = ''
  const panel = document.createElement('div')
  root.appendChild(panel)
  renderNotice(panel, {
    title: "This cache is out of date and can't be rewritten here",
    detail:
      `The cache in ${rewrite.folder} was made by ${whoMadeIt(rewrite)} (cache version ${rewrite.found}), ` +
      "and pesto can't write to that folder. " +
      'Open the run again with --cache-dir set to a folder you can write to.',
    tone: 'critical',
  })
}

function showMap(config: RunConfig | null, state: IngestState): void {
  clearTeardown()
  mountMap(getRoot(), { config, state })
}

// D-13: the freshness answer decides how many screens the user sees. A
// fresh cache shows the map immediately, with the recorded ingest
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
    showMap(config, state)
    return
  }

  // An old cache is re-read at once, with the reason on screen; there is
  // nothing for the user to agree to that they did not already choose by
  // opening the run.
  if (state.rewrite) {
    if (state.rewrite.writable) {
      showProgress(rewriteNotices(state.rewrite))
    } else {
      renderRewriteRefusal(state.rewrite)
    }
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

// The progress screen always ends at the map, whatever state the
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
  showMap(config, state)
}

async function boot(): Promise<void> {
  readTokenOnce()
  initTheme()

  // A reload recovers the token from sessionStorage; nothing there means this
  // tab never had one, or pesto has been relaunched since.
  if (!hasToken()) {
    renderSessionEnded()
    return
  }

  let config: RunConfig | null = null
  try {
    config = (await apiGet('/api/run/config')) as RunConfig
  } catch (error) {
    if (isTokenRejected(error)) {
      forgetToken()
      renderSessionEnded()
      return
    }
    if (isNoRunOpen(error)) {
      showPicker()
      return
    }
    // A run is open but its config could not be read yet -- see
    // loadConfig's note above. Fall through with no config in hand.
  }

  try {
    await routeByFreshness(config)
  } catch (error) {
    if (isTokenRejected(error)) {
      forgetToken()
      renderSessionEnded()
      return
    }
    renderBootFailure(error)
  }
}

void boot()
