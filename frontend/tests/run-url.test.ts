// Every run-scoped request is built by runUrl, so M3 can change the wire
// shape in one place. runUrl is wrapped here to prefix "/RUN"; a fetcher that
// still builds its own string would show up without the prefix.

import { tableFromArrays, tableToIPC } from 'apache-arrow'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  fsRoots,
  gridCells,
  gridIdomain,
  gridMesh,
  gridMeshBuffer,
  gridParmap,
  gridPointXy,
  gridValues,
  ingestCancel,
  ingestEstimate,
  ingestEventsUrl,
  ingestStart,
  ingestState,
  readViewState,
  runMeta,
  runReals,
  writeViewState,
  type ViewState,
} from '../src/data/client'
import { fetchPpIndex, fieldContributors, gridField } from '../src/data/fields'
import { fetchRealNames } from '../src/data/reals'

let prefix = '/RUN'

vi.mock('../src/data/run', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/data/run')>()
  return {
    ...real,
    runUrl: (runId: string | null, path: string, query?: Record<string, string | number | undefined>) =>
      prefix + real.runUrl(runId, path, query),
  }
})

type Kind = 'json' | 'bytes' | 'mesh-buffer' | 'arrow'

const VIEW: ViewState = {
  divider: 0.5,
  colormap: 'viridis',
  reverse: false,
  scale: 'linear',
  limitsMode: 'robust',
  group: null,
  stat: 'mean',
  layer: null,
}

const VIEW_WIRE = {
  divider: 0.5,
  colormap: 'viridis',
  reverse: false,
  scale: 'linear',
  limits_mode: 'robust',
  group: null,
  stat: 'mean',
  layer: null,
}

const JSON_BODIES: Record<string, unknown> = {
  mesh: { n_vert: 3, n_tri: 1, n_cells: 1, nlay: 1, bounds: [0, 0, 1, 1], crs: null, tag: null },
  pp: { groups: [], not_interpolable: [], notes: [] },
  contributors: { contributors: [] },
  state: {
    fresh: true,
    artifacts: [],
    capabilities: {
      map: { available: true, blocked_by: [] },
      stats: { available: true, blocked_by: [] },
      chips: { available: true, blocked_by: [] },
    },
    ingest_seconds: null,
    cache_bytes: null,
  },
  estimate: { total: 1, per_artifact: [], notes: [], free_bytes: 1, cache_root_exists: true },
  view: VIEW_WIRE,
  empty: {},
  roots: [],
}

function reply(kind: Kind, jsonKey: string): Response {
  if (kind === 'json') return new Response(JSON.stringify(JSON_BODIES[jsonKey]), { status: 200 })
  if (kind === 'arrow') {
    const bytes = tableToIPC(tableFromArrays({ realization: ['r1', 'r2'] }), 'stream')
    return new Response(bytes.buffer as ArrayBuffer, { status: 200 })
  }
  const headers = kind === 'mesh-buffer' ? { 'X-Pesto-Meta': JSON.stringify({ dtype: '<f4' }) } : undefined
  return new Response(new Float32Array([1, 2]).buffer, { status: 200, headers })
}

let urls: string[] = []
let nextReply: Response

beforeEach(() => {
  prefix = '/RUN'
  urls = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL) => {
      urls.push(String(input))
      return nextReply
    }),
  )
})

afterEach(() => {
  vi.unstubAllGlobals()
})

async function lastUrlOf(kind: Kind, jsonKey: string, call: () => Promise<unknown>): Promise<string> {
  urls = []
  nextReply = reply(kind, jsonKey)
  await call()
  expect(urls).toHaveLength(1)
  return urls[0]!
}

const CASES: [string, Kind, string, () => Promise<unknown>][] = [
  ['gridMesh', 'json', 'mesh', () => gridMesh()],
  ['gridIdomain', 'bytes', '', () => gridIdomain()],
  ['gridMeshBuffer', 'mesh-buffer', '', () => gridMeshBuffer('positions')],
  ['gridParmap', 'bytes', '', () => gridParmap(2)],
  ['gridValues', 'bytes', '', () => gridValues({ iteration: 2, stat: 'mean' })],
  ['gridCells', 'bytes', '', () => gridCells('cell', 2)],
  ['gridPointXy', 'bytes', '', () => gridPointXy(2)],
  ['runMeta', 'bytes', '', () => runMeta('par', ['parnme'], ['x'])],
  ['runReals', 'arrow', '', () => runReals(2)],
  ['fetchRealNames', 'arrow', '', () => fetchRealNames(2)],
  ['fetchPpIndex', 'json', 'pp', () => fetchPpIndex()],
  ['gridField', 'bytes', '', () => gridField({ iteration: 2, group: 'hk', stat: 'mean' })],
  ['fieldContributors', 'json', 'contributors', () => fieldContributors(2, 'hk', 7)],
  ['ingestState', 'json', 'state', () => ingestState()],
  ['ingestEstimate', 'json', 'estimate', () => ingestEstimate()],
  ['ingestStart', 'json', 'empty', () => ingestStart()],
  ['ingestCancel', 'json', 'empty', () => ingestCancel()],
  ['readViewState', 'json', 'view', () => readViewState()],
  ['writeViewState', 'json', 'view', () => writeViewState(VIEW)],
]

describe('run-scoped fetchers', () => {
  it.each(CASES)('%s builds its URL through runUrl', async (_name, kind, jsonKey, call) => {
    const url = await lastUrlOf(kind, jsonKey, call)
    expect(url.startsWith('/RUN/api/run')).toBe(true)
  })

  it('leaves the picker routes outside runUrl', async () => {
    const url = await lastUrlOf('json', 'roots', () => fsRoots())
    expect(url).toBe('/api/fs/roots')
  })

  it('builds the progress stream URL through runUrl', () => {
    expect(ingestEventsUrl()).toBe('/RUN/api/run/ingest/events')
  })
})

describe('the wire shape in M1', () => {
  beforeEach(() => {
    prefix = ''
  })

  it('keeps the M0 paths and query order', async () => {
    const seen: [string, () => Promise<unknown>, Kind, string][] = [
      ['/api/run/grid/mesh', () => gridMesh(), 'json', 'mesh'],
      ['/api/run/grid/mesh/idomain', () => gridIdomain(), 'bytes', ''],
      ['/api/run/grid/mesh/positions', () => gridMeshBuffer('positions'), 'mesh-buffer', ''],
      ['/api/run/grid/parmap?iteration=2', () => gridParmap(2), 'bytes', ''],
      ['/api/run/grid/values?iteration=2&stat=mean', () => gridValues({ iteration: 2, stat: 'mean' }), 'bytes', ''],
      [
        '/api/run/grid/values?iteration=2&realization=r001',
        () => gridValues({ iteration: 2, realization: 'r001' }),
        'bytes',
        '',
      ],
      ['/api/run/grid/cells/xy?iteration=2', () => gridCells('xy', 2), 'bytes', ''],
      ['/api/run/meta?kind=par', () => runMeta('par'), 'bytes', ''],
      [
        '/api/run/meta?kind=par&columns=a%2Cb&optional_columns=c',
        () => runMeta('par', ['a', 'b'], ['c']),
        'bytes',
        '',
      ],
      ['/api/run/reals?iteration=2', () => runReals(2), 'arrow', ''],
      ['/api/run/grid/pp', () => fetchPpIndex(), 'json', 'pp'],
      [
        '/api/run/grid/field?iteration=2&group=hk&stat=mean',
        () => gridField({ iteration: 2, group: 'hk', stat: 'mean' }),
        'bytes',
        '',
      ],
      [
        '/api/run/grid/field/cell?iteration=2&group=hk&cell=7',
        () => fieldContributors(2, 'hk', 7),
        'json',
        'contributors',
      ],
      ['/api/run/ingest/state', () => ingestState(), 'json', 'state'],
      ['/api/run/view', () => readViewState(), 'json', 'view'],
    ]
    for (const [expected, call, kind, jsonKey] of seen) {
      expect(await lastUrlOf(kind, jsonKey, call)).toBe(expected)
    }
  })
})
