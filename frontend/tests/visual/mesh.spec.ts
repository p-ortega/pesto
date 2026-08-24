// The end-to-end proof of the whole tracer: a synthetic run's grid, joined
// with its parameter identities, drawn on the graphics card through the
// real routes -- no benchmark data needed, so this runs on any machine.
// Follows picker-ingest.spec.ts's launch helper for spawning a real
// `pesto` process and reading its printed URL.

import { expect, test, type Page } from '@playwright/test'
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

// Reads back one pixel from a screenshot PNG -- the live canvas is created
// with preserveDrawingBuffer: false (gl/context.ts), so its backbuffer can
// already be gone by the time a later page.evaluate reads it directly. A
// screenshot goes through the compositor and captures what was actually
// presented; this decodes that same PNG in-page instead.
async function pixelAt(page: Page, dataUrl: string, x: number, y: number): Promise<number[]> {
  return page.evaluate(
    async ([url, px, py]) => {
      const image = new Image()
      image.src = url as string
      await image.decode()
      const readback = document.createElement('canvas')
      readback.width = image.naturalWidth
      readback.height = image.naturalHeight
      const ctx2d = readback.getContext('2d')!
      ctx2d.drawImage(image, 0, 0)
      const [r, g, b, a] = ctx2d.getImageData(px as number, py as number, 1, 1).data
      return [r, g, b, a]
    },
    [dataUrl, x, y] as const,
  )
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

    // The divider and Params panel this plan adds must not cost the map
    // its own chrome: the selection controls and the legend still render,
    // asserted on the DOM rather than only checked by eye (a prior attempt
    // at this plan broke exactly this without either kind of test catching
    // it).
    await expect(page.locator('input[aria-label="Layer"]')).toBeAttached()
    await expect(page.locator('select[aria-label="Statistic"]')).toBeAttached()
    await expect(page.locator('input[aria-label="Realization"]')).toBeAttached()
    await expect(page.locator('select[aria-label="Colormap"]')).toBeAttached()
    await expect(page.locator('select[aria-label="Value scale"]')).toBeAttached()
    expect(bodyText).toMatch(/Scale: Log₁₀ \(inferred from partrans\)/)
    expect(bodyText).toMatch(/Limits: Robust 2-98%/)
    expect(bodyText).toMatch(/1 cells contested/)
    expect(bodyText).toMatch(/3 cells no value/)
    await expect(page.locator('[role="separator"][aria-label="Resize panel"]')).toBeAttached()
    await expect(page.locator('button', { hasText: 'Fit to extent' })).toBeAttached()

    await expect(page.locator('canvas')).toHaveScreenshot('mesh-synthetic-run.png', { maxDiffPixels: 60 })
  })

  // Regression for WINDOWS.md #3: the four overlays used to all resolve to
  // the same computed corner (auto/auto offsets with no positioning context
  // on the map area) and sit on top of each other. This reads real
  // getBoundingClientRect() geometry -- a check that only checking for
  // `.floating`'s presence would not have caught, since every overlay
  // already carried that class before the fix.
  test('the controls, group picker, legend and readout sit in four distinct corners and never overlap', async ({
    page,
  }) => {
    await page.goto(pestoUrl)
    await expect(page.locator('canvas[data-drawn="true"]')).toBeVisible({ timeout: 30_000 })

    const geometry = await page.evaluate(() => {
      function rectOf(el: Element | null): DOMRect | null {
        return el ? el.getBoundingClientRect() : null
      }
      const canvas = document.querySelector('canvas')
      const topLeft = document.querySelector('.floating-top-left')
      const bottomLeft = document.querySelector('.floating-bottom-left')
      const bottomRight = document.querySelector('.floating-bottom-right')
      const topLeftChildren = topLeft ? Array.from(topLeft.children) : []
      return {
        canvas: rectOf(canvas)?.toJSON() ?? null,
        topLeft: rectOf(topLeft)?.toJSON() ?? null,
        bottomLeft: rectOf(bottomLeft)?.toJSON() ?? null,
        bottomRight: rectOf(bottomRight)?.toJSON() ?? null,
        controls: rectOf(topLeftChildren[0] ?? null)?.toJSON() ?? null,
        picker: rectOf(topLeftChildren[1] ?? null)?.toJSON() ?? null,
      }
    })

    const { canvas, topLeft, bottomLeft, bottomRight, controls, picker } = geometry
    expect(canvas).not.toBeNull()
    expect(topLeft).not.toBeNull()
    expect(bottomLeft).not.toBeNull()
    expect(bottomRight).not.toBeNull()
    expect(controls).not.toBeNull()
    expect(picker).not.toBeNull()

    // Each cluster anchors to its own named corner of the canvas, not to a
    // shared default position.
    expect(topLeft!.top).toBeLessThan(canvas!.top + canvas!.height / 2)
    expect(topLeft!.left).toBeLessThan(canvas!.left + canvas!.width / 2)
    expect(bottomLeft!.bottom).toBeGreaterThan(canvas!.top + canvas!.height / 2)
    expect(bottomLeft!.left).toBeLessThan(canvas!.left + canvas!.width / 2)
    expect(bottomRight!.bottom).toBeGreaterThan(canvas!.top + canvas!.height / 2)
    expect(bottomRight!.right).toBeGreaterThan(canvas!.left + canvas!.width / 2)

    // The three clusters carry three distinct corners -- no two share the
    // same computed top-left origin, which is exactly what the bug did.
    expect(`${topLeft!.top},${topLeft!.left}`).not.toBe(`${bottomLeft!.top},${bottomLeft!.left}`)
    expect(`${bottomLeft!.top},${bottomLeft!.left}`).not.toBe(`${bottomRight!.top},${bottomRight!.left}`)
    expect(`${topLeft!.top},${topLeft!.left}`).not.toBe(`${bottomRight!.top},${bottomRight!.left}`)

    // The group picker rides under the controls, in DOM order and on
    // screen, not stacked on top of them.
    expect(picker!.top).toBeGreaterThanOrEqual(controls!.bottom)

    // No two of the three corner clusters overlap each other's box.
    function overlaps(a: DOMRect, b: DOMRect): boolean {
      return a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom
    }
    expect(overlaps(topLeft!, bottomLeft!)).toBe(false)
    expect(overlaps(bottomLeft!, bottomRight!)).toBe(false)
    expect(overlaps(topLeft!, bottomRight!)).toBe(false)
  })

  // Plan 05.1-08/D-16: the synthetic run's mesh already carries no CRS
  // (tests/fixtures/synthetic_run.py passes crs=None), so the no-CRS
  // designed state is already reachable through this same fixture --
  // informational, never a warning (visual contract §9).
  test('a run with no CRS reads as a normal, informational state -- never a warning', async ({ page }) => {
    await page.goto(pestoUrl)
    await expect(page.locator('canvas[data-drawn="true"]')).toBeVisible({ timeout: 30_000 })

    const notice = page.locator('[data-testid="map-notices"]')
    await expect(notice).toContainText('No coordinate system')
    await expect(notice).toContainText('Note')
    await expect(notice).not.toContainText('Warning')
    await expect(notice).not.toContainText('Critical')

    await expect(notice).toHaveScreenshot('mesh-no-crs-notice.png')
  })

  // The synthetic run's six cells lay out in a row, each 128 screen px
  // wide starting at x=16 given the fixed 800x480 canvas and camera.fit's
  // 4% padding (Camera.fit's own math, computed once here rather than
  // asserted against a magic number). Cell 0 is G1's contested cell (p1
  // and p2, both G1, on the same cell and layer); cells 1-3 are G2's,
  // active but outside the drawn group (no value); cells 4-5 carry no
  // parameter of any group at all (outside the model). This is D-06's
  // four-mark contract, read back as real pixels.
  test('marks two absences differently: a hairline for outside the model, nothing at all for no parameter here', async ({
    page,
  }) => {
    await page.goto(pestoUrl)
    await expect(page.locator('canvas[data-drawn="true"]')).toBeVisible({ timeout: 30_000 })

    const png = await page.locator('canvas').screenshot()
    const dataUrl = `data:image/png;base64,${png.toString('base64')}`

    const background = await pixelAt(page, dataUrl, 400, 400) // well clear of every cell
    const cellTwoBlank = await pixelAt(page, dataUrl, 336, 240) // G2's cell, active, not the drawn group
    const cellFourInterior = await pixelAt(page, dataUrl, 592, 240) // outside the model, away from its border

    // A cell in the model but not in the drawn group is exactly the page
    // plane showing through: it must not borrow the hairline.
    expect(cellTwoBlank).toEqual(background)
    // A cell outside the model has no fill either...
    expect(cellFourInterior).toEqual(background)

    // ...but its ring is stroked in the hairline colour somewhere along
    // cell 4's left edge (x=528), a 1px line that anti-aliasing can shift
    // by a pixel either way -- scan a small neighbourhood rather than
    // asserting one exact coordinate.
    let borderFound = false
    for (let x = 524; x <= 533; x++) {
      const pixel = await pixelAt(page, dataUrl, x, 240)
      if (pixel.some((channel, i) => channel !== background[i])) {
        borderFound = true
        break
      }
    }
    expect(borderFound).toBe(true)
  })

  // p1 and p2 are both G1, both on cell 0 and layer 0 -- D-06's contested
  // mark, never an averaged or first-wins colour.
  test('a contested cell shows a 22.5-degree stripe, not an averaged colour', async ({ page }) => {
    await page.goto(pestoUrl)
    await expect(page.locator('canvas[data-drawn="true"]')).toBeVisible({ timeout: 30_000 })

    const png = await page.locator('canvas').screenshot()
    const dataUrl = `data:image/png;base64,${png.toString('base64')}`

    const background = await pixelAt(page, dataUrl, 400, 400)

    // A stripe pattern shows at least two distinct colours across the
    // cell's interior -- a solid ramp fill (or an averaged/first-wins
    // colour) would show exactly one.
    const colours = new Set<string>()
    for (let x = 24; x <= 136; x += 4) {
      const pixel = await pixelAt(page, dataUrl, x, 240)
      colours.add(pixel.join(','))
    }
    expect(colours.size).toBeGreaterThanOrEqual(2)

    // Neither of those colours is the page-plane background -- the
    // contested cell is never blank.
    for (const colour of colours) {
      expect(colour).not.toEqual(background.join(','))
    }
  })

  test('clicking a contested cell opens a readout naming every parameter on it', async ({ page }) => {
    await page.goto(pestoUrl)
    await expect(page.locator('canvas[data-drawn="true"]')).toBeVisible({ timeout: 30_000 })

    const bodyBeforeClick = (await page.textContent('body')) ?? ''
    expect(bodyBeforeClick).toContain('Click a cell to see its value.')

    await page.locator('canvas').click({ position: { x: 80, y: 240 } })

    const bodyText = (await page.textContent('body')) ?? ''
    expect(bodyText).toContain('Contested cell')
    expect(bodyText).toContain('p1 (G1)')
    expect(bodyText).toContain('p2 (G1)')
    expect(bodyText).toContain('layer 0, cell 0')
  })

  test('clicking a cell outside the model says plainly there is no parameter of the drawn group', async ({
    page,
  }) => {
    await page.goto(pestoUrl)
    await expect(page.locator('canvas[data-drawn="true"]')).toBeVisible({ timeout: 30_000 })

    await page.locator('canvas').click({ position: { x: 592, y: 240 } })

    const bodyText = (await page.textContent('body')) ?? ''
    expect(bodyText).toContain('No parameter of G1 sits on this cell.')
  })
})
