// Source scan: views talk to each other only through the shared store and
// the shell. No view imports another view, and the Params and Obs panels are
// mounted by the shell alone. views/map.ts is the shell, so it may import them all.

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, posix } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const testDir = dirname(fileURLToPath(import.meta.url))
const srcRoot = join(testDir, '..', 'src')

const SHELL = 'views/map.ts'
// Data halves load and classify but draw nothing, so a view may use one.
const DATA_MODULES = new Set(['views/parameter-field-source', 'views/observation-stat-source', 'views/overlay-source'])
const PARAMS_PANEL = 'ui/params-panel'
const OBS_PANEL = 'ui/obs-panel'

// Every `from '...'` on an import or export line, one specifier per hit.
function specifiersOf(source: string): string[] {
  const found: string[] = []
  const pattern = /^\s*(?:import|export)\b[^;]*?\bfrom\s+['"]([^'"]+)['"]/gm
  for (const match of source.matchAll(pattern)) found.push(match[1])
  const bare = /^\s*import\s+['"]([^'"]+)['"]/gm
  for (const match of source.matchAll(bare)) found.push(match[1])
  return found
}

// A relative specifier resolved to a path under src/ with no extension.
function resolveTarget(fromFile: string, specifier: string): string | null {
  if (!specifier.startsWith('.')) return null
  return posix.normalize(posix.join(posix.dirname(fromFile), specifier)).replace(/\.ts$/, '')
}

// Returns one plain sentence per broken rule. `files` maps a path under
// src/ (for example "views/map-view.ts") to its source text.
export function findViolations(files: Record<string, string>): string[] {
  const problems: string[] = []
  for (const [file, source] of Object.entries(files)) {
    const inViews = file.startsWith('views/')
    const isPanel = file === `${PARAMS_PANEL}.ts` || file === `${OBS_PANEL}.ts`
    if (file === SHELL || (!inViews && !isPanel)) continue
    const self = file.replace(/\.ts$/, '')
    for (const specifier of specifiersOf(source)) {
      const target = resolveTarget(file, specifier)
      if (target === null || target === self) continue
      if (target.startsWith('views/')) {
        const allowed = inViews && DATA_MODULES.has(target) && !DATA_MODULES.has(self)
        if (!allowed) problems.push(`${file} imports ${target}`)
      }
      if (inViews && (target === PARAMS_PANEL || target === OBS_PANEL)) problems.push(`${file} imports ${target}`)
    }
  }
  return problems
}

function walkTsFiles(dir: string): string[] {
  const files: string[] = []
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) files.push(...walkTsFiles(full))
    else if (name.endsWith('.ts')) files.push(full)
  }
  return files
}

function readSources(): Record<string, string> {
  const files: Record<string, string> = {}
  for (const full of walkTsFiles(srcRoot)) {
    files[posix.normalize(full.slice(srcRoot.length + 1).split('\\').join('/'))] = readFileSync(full, 'utf8')
  }
  return files
}

describe('no view imports another view', () => {
  it('holds for every module under src/', () => {
    expect(findViolations(readSources())).toEqual([])
  })

  it('the scan sees the modules the plan names', () => {
    const files = readSources()
    expect(Object.keys(files)).toEqual(
      expect.arrayContaining(['views/map-view.ts', 'views/parameter-field-source.ts', 'ui/params-panel.ts', 'ui/obs-panel.ts']),
    )
  })

  it('fails when the map view imports the Params panel', () => {
    const fixture = {
      'views/map-view.ts': "import { renderParamsPanel } from '../ui/params-panel'\n",
    }
    expect(findViolations(fixture)).toEqual(['views/map-view.ts imports ui/params-panel'])
  })

  it('fails when a view imports the Obs panel', () => {
    const fixture = {
      'views/map-view.ts': "import { renderObsPanel } from '../ui/obs-panel'\n",
    }
    expect(findViolations(fixture)).toEqual(['views/map-view.ts imports ui/obs-panel'])
  })

  it('fails when the Obs panel imports anything under views/', () => {
    const fixture = { 'ui/obs-panel.ts': "import { x } from '../views/map-view'\n" }
    expect(findViolations(fixture)).toEqual(['ui/obs-panel.ts imports views/map-view'])
  })

  it('lets a view import the observation stat source, which is a data module', () => {
    const fixture = { 'views/map-view.ts': "import { createObservationStatSource } from './observation-stat-source'\n" }
    expect(findViolations(fixture)).toEqual([])
  })

  it('lets the map view import the overlay source, which is a data module', () => {
    const fixture = { 'views/map-view.ts': "import { createOverlaySource } from './overlay-source'\n" }
    expect(findViolations(fixture)).toEqual([])
  })

  it('fails when the overlay source imports a view or another data module', () => {
    const fixture = {
      'views/overlay-source.ts': "import { x } from './map-view'\nimport type { Y } from './observation-stat-source'\n",
    }
    expect(findViolations(fixture)).toEqual([
      'views/overlay-source.ts imports views/map-view',
      'views/overlay-source.ts imports views/observation-stat-source',
    ])
  })

  it('fails when one view imports another, and when a type import does it', () => {
    const fixture = {
      'views/map-view.ts': "import { x } from './other-view'\nimport type { Y } from './third-view'\n",
    }
    expect(findViolations(fixture)).toEqual([
      'views/map-view.ts imports views/other-view',
      'views/map-view.ts imports views/third-view',
    ])
  })

  it('fails when the data source imports a view or the map view imports the shell', () => {
    const fixture = {
      'views/parameter-field-source.ts': "export { z } from './map-view'\n",
      'views/map-view.ts': "import { mountMap } from './map'\n",
    }
    expect(findViolations(fixture)).toEqual([
      'views/parameter-field-source.ts imports views/map-view',
      'views/map-view.ts imports views/map',
    ])
  })

  it('fails when the Params panel imports anything under views/', () => {
    const fixture = { 'ui/params-panel.ts': "import { UnmappedEntry } from '../views/parameter-field-source'\n" }
    expect(findViolations(fixture)).toEqual(['ui/params-panel.ts imports views/parameter-field-source'])
  })

  it('lets the shell import every one of them', () => {
    const fixture = {
      'views/map.ts':
        "import { mountMapView } from './map-view'\nimport { renderParamsPanel } from '../ui/params-panel'\nimport { renderObsPanel } from '../ui/obs-panel'\n",
    }
    expect(findViolations(fixture)).toEqual([])
  })
})
