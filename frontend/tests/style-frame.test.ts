// Source-scan coverage for the extracted stylesheet (D-10): every token
// is declared, the dark override touches only the themed tokens, the
// eight previously-unreferenced tokens now have real consumers, no
// `ui`/`views` module writes a raw hex colour, and `index.html` carries
// no inline rules of its own. Same shape as `theme.test.ts`'s own
// "no colour literals" source-scan test.

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const testDir = dirname(fileURLToPath(import.meta.url))
const frontendRoot = join(testDir, '..')
const styleSheetPath = join(frontendRoot, 'src', 'style.css')
const indexHtmlPath = join(frontendRoot, 'index.html')

const THEMED_TOKENS = [
  '--page-plane',
  '--surface',
  '--ink-primary',
  '--ink-secondary',
  '--ink-muted',
  '--gridline',
  '--axis',
  '--hairline',
  '--accent',
]
const STATUS_TOKENS = ['--status-good', '--status-warning', '--status-serious', '--status-critical']
const ALL_TOKENS = [...THEMED_TOKENS, ...STATUS_TOKENS]

// Phase 5 left these eight referenced nowhere under frontend/src -- D-10's
// whole point is that they now have real consumers.
const PREVIOUSLY_UNREFERENCED = [
  '--page-plane',
  '--surface',
  '--ink-primary',
  '--ink-secondary',
  '--ink-muted',
  '--gridline',
  '--axis',
  '--hairline',
]

function readStyleSheet(): string {
  return readFileSync(styleSheetPath, 'utf8')
}

function extractBlock(source: string, selector: string): string {
  const start = source.indexOf(selector)
  if (start === -1) {
    throw new Error(`selector ${selector} not found in style.css`)
  }
  const braceStart = source.indexOf('{', start)
  const braceEnd = source.indexOf('}', braceStart)
  return source.slice(braceStart + 1, braceEnd)
}

function walkTsFiles(dir: string): string[] {
  const files: string[] = []
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) {
      files.push(...walkTsFiles(full))
    } else if (name.endsWith('.ts')) {
      files.push(full)
    }
  }
  return files
}

describe('style.css token declarations', () => {
  it('declares every token in :root', () => {
    const source = readStyleSheet()
    const rootBlock = extractBlock(source, ':root')
    for (const token of ALL_TOKENS) {
      expect(rootBlock).toContain(`${token}:`)
    }
  })

  it('the dark override redeclares the nine themed tokens and leaves the four status colours alone', () => {
    const source = readStyleSheet()
    const darkBlock = extractBlock(source, "[data-theme='dark']")
    for (const token of THEMED_TOKENS) {
      expect(darkBlock).toContain(`${token}:`)
    }
    for (const token of STATUS_TOKENS) {
      expect(darkBlock).not.toContain(`${token}:`)
    }
  })
})

describe('token usage under frontend/src', () => {
  it('each previously-unreferenced token is used at least once', () => {
    const files = walkTsFiles(join(frontendRoot, 'src'))
    const sources = [readStyleSheet(), ...files.map((file) => readFileSync(file, 'utf8'))]
    const combined = sources.join('\n')
    for (const token of PREVIOUSLY_UNREFERENCED) {
      expect(combined).toContain(`var(${token})`)
    }
  })

  it('no file under frontend/src/ui or frontend/src/views writes a raw hex colour', () => {
    const hexPattern = /#[0-9a-fA-F]{3,8}\b/
    const scanDirs = ['ui', 'views']
    for (const scanDir of scanDirs) {
      for (const file of walkTsFiles(join(frontendRoot, 'src', scanDir))) {
        const source = readFileSync(file, 'utf8')
        expect(hexPattern.test(source), `${file} contains a raw hex colour`).toBe(false)
      }
    }
  })
})

describe('index.html', () => {
  it('references style.css and carries no rules of its own', () => {
    const source = readFileSync(indexHtmlPath, 'utf8')
    expect(source).toContain('style.css')
    expect(source).not.toContain('<style>')
    // Matches `wc -l`: counts newline characters, same as the acceptance check.
    const lineCount = (source.match(/\n/g) ?? []).length
    expect(lineCount).toBeLessThanOrEqual(16)
  })
})
