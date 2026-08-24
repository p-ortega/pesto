// The end-to-end proof of the whole tracer: a synthetic run's grid, joined
// with its parameter identities, drawn on the graphics card through the
// real routes -- no benchmark data needed, so this runs on any machine.
// Follows picker-ingest.spec.ts's launch helper for spawning a real
// `pesto` process and reading its printed URL.

import { expect, test } from '@playwright/test'
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(HERE, '..', '..', '..')
const BUILT_INDEX = path.join(REPO_ROOT, 'src', 'pesto', 'static', 'index.html')

interface Launched {
  proc: ChildProcess
  url: string
}

async function runToCompletion(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(command, args, { cwd: REPO_ROOT })
    let stderrBuffer = ''
    proc.stderr?.on('data', (chunk) => {
      stderrBuffer += chunk.toString('utf8')
    })
    proc.on('exit', (code) => {
      if (code === 0) {
        resolve()
      } else {
        reject(new Error(`${command} ${args.join(' ')} exited (code ${code}): ${stderrBuffer}`))
      }
    })
  })
}

// Spawns the real console script pointed straight at the synthetic run and
// reads its own printed line for the URL and token -- the run's cache is
// already fresh, so this opens the map with no ingest screen in between.
async function launchPesto(runDir: string): Promise<Launched> {
  const proc = spawn('uv', ['run', 'pesto', '--no-browser', runDir], { cwd: REPO_ROOT, env: process.env })

  const url = await new Promise<string>((resolve, reject) => {
    let buffer = ''
    let stderrBuffer = ''
    const timer = setTimeout(() => {
      reject(new Error(`timed out waiting for "pesto serving" on stdout. stderr so far: ${stderrBuffer}`))
    }, 60_000)

    proc.stdout?.on('data', (chunk) => {
      buffer += chunk.toString('utf8')
      const match = buffer.match(/pesto serving (\S+)/)
      if (match) {
        clearTimeout(timer)
        resolve(match[1])
      }
    })
    proc.stderr?.on('data', (chunk) => {
      stderrBuffer += chunk.toString('utf8')
    })
    proc.on('exit', (code) => {
      clearTimeout(timer)
      reject(new Error(`pesto exited (code ${code}) before printing its serving URL: ${stderrBuffer}`))
    })
  })

  return { proc, url }
}

test.describe('the map draws a synthetic run end to end, through the real routes', () => {
  test.skip(!existsSync(BUILT_INDEX), `the built frontend is missing at ${BUILT_INDEX} -- run "npm run build" first`)

  let launched: Launched
  let pestoUrl: string

  test.beforeAll(async () => {
    const runDir = mkdtempSync(path.join(tmpdir(), 'pesto-mesh-synth-'))
    await runToCompletion('uv', ['run', 'python', '-m', 'tests.fixtures.synthetic_run', runDir])

    launched = await launchPesto(runDir)
    pestoUrl = launched.url
  })

  test.afterAll(() => {
    launched?.proc.kill()
  })

  test('draws the model grid coloured by one group field, on a themed canvas', async ({ page }) => {
    await page.goto(pestoUrl)

    await expect(page.locator('canvas[data-drawn="true"]')).toBeVisible({ timeout: 30_000 })

    const bodyText = (await page.textContent('body')) ?? ''
    expect(bodyText).toMatch(/Ingest time/)
    expect(bodyText).not.toMatch(/Critical/)

    await expect(page.locator('canvas')).toHaveScreenshot('mesh-synthetic-run.png', { maxDiffPixels: 60 })
  })
})
