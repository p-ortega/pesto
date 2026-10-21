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

// The synthetic run's six unit cells lie in a row, x from 0 to 6 and y from
// 0 to 1 (tests/fixtures/synthetic_run.py). Camera.fit centres that row on
// the canvas with 4% padding, so every cell's screen box follows from the
// canvas's own size -- computed here from Camera.fit's own math, never a
// magic number, because the canvas takes the size of the frame it sits in
// rather than a fixed 800x480.
interface CellLayout {
  width: number
  height: number
  /** One cell's screen width, and height: the cells are unit squares. */
  cell: number
  left: (i: number) => number
  centreX: (i: number) => number
  midY: number
  /** A point on the canvas well clear of every cell. */
  clear: [number, number]
}

async function cellLayout(page: Page): Promise<CellLayout> {
  const box = await page.locator('canvas').boundingBox()
  if (!box) throw new Error('no canvas on the page')
  const width = Math.round(box.width)
  const height = Math.round(box.height)
  const cell = 0.96 * Math.min(width / 6, height / 1)
  const left = (i: number) => Math.round(width / 2 + cell * (i - 3))
  const centreX = (i: number) => Math.round(width / 2 + cell * (i - 2.5))
  const midY = Math.round(height / 2)
  const clear: [number, number] = [Math.round(width / 2), Math.min(height - 2, Math.round(midY + cell))]
  if (clear[1] <= midY + cell / 2) throw new Error('the canvas is too short to have a point clear of the row of cells')
  return { width, height, cell, left, centreX, midY, clear }
}

// Reads the camera back from the matrix the map uploads on every draw. Must run
// before page.goto: the hook wraps the WebGL call and stores a copy of the matrix.
async function installCameraHook(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const original = WebGL2RenderingContext.prototype.uniformMatrix3fv
    WebGL2RenderingContext.prototype.uniformMatrix3fv = function (this: WebGL2RenderingContext, ...args) {
      ;(window as unknown as { __pestoMatrix: number[] }).__pestoMatrix = Array.from(args[2] as Float32List)
      return original.apply(this, args)
    }
  })
}

async function cameraMatrix(page: Page): Promise<number[] | null> {
  return page.evaluate(() => (window as unknown as { __pestoMatrix?: number[] }).__pestoMatrix ?? null)
}

async function drawnMatrix(page: Page): Promise<number[]> {
  await expect.poll(() => cameraMatrix(page)).not.toBeNull()
  return (await cameraMatrix(page))!
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

  // Cell 0 is G1's contested cell (p1 and p2, both G1, on the same cell
  // and layer); cells 1-3 are G2's, active but outside the drawn group (no
  // value); cells 4-5 carry no parameter of any group at all (outside the
  // model). This is D-06's four-mark contract, read back as real pixels at
  // the positions cellLayout derives from the canvas's size.
  test('marks two absences differently: a hairline for outside the model, nothing at all for no parameter here', async ({
    page,
  }) => {
    await page.goto(pestoUrl)
    await expect(page.locator('canvas[data-drawn="true"]')).toBeVisible({ timeout: 30_000 })

    const layout = await cellLayout(page)
    const png = await page.locator('canvas').screenshot()
    const dataUrl = `data:image/png;base64,${png.toString('base64')}`

    const background = await pixelAt(page, dataUrl, ...layout.clear)
    const cellTwoBlank = await pixelAt(page, dataUrl, layout.centreX(2), layout.midY) // G2's cell, active, not the drawn group
    const cellFourInterior = await pixelAt(page, dataUrl, layout.centreX(4), layout.midY) // outside the model, away from its border

    // A cell in the model but not in the drawn group is exactly the page
    // plane showing through: it must not borrow the hairline.
    expect(cellTwoBlank).toEqual(background)
    // A cell outside the model has no fill either...
    expect(cellFourInterior).toEqual(background)

    // ...but its ring is stroked in the hairline colour somewhere along
    // cell 4's left edge, a 1px line that anti-aliasing can shift by a
    // pixel either way -- scan a small neighbourhood rather than asserting
    // one exact coordinate.
    let borderFound = false
    const edge = layout.left(4)
    for (let x = edge - 4; x <= edge + 5; x++) {
      const pixel = await pixelAt(page, dataUrl, x, layout.midY)
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

    const layout = await cellLayout(page)
    const png = await page.locator('canvas').screenshot()
    const dataUrl = `data:image/png;base64,${png.toString('base64')}`

    const background = await pixelAt(page, dataUrl, ...layout.clear)

    // A stripe pattern shows at least two distinct colours across the
    // cell's interior -- a solid ramp fill (or an averaged/first-wins
    // colour) would show exactly one.
    const colours = new Set<string>()
    for (let x = layout.left(0) + 8; x <= layout.left(1) - 8; x += 4) {
      const pixel = await pixelAt(page, dataUrl, x, layout.midY)
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

    const layout = await cellLayout(page)
    await page.locator('canvas').click({ position: { x: layout.centreX(0), y: layout.midY } })

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

    const layout = await cellLayout(page)
    await page.locator('canvas').click({ position: { x: layout.centreX(4), y: layout.midY } })

    const bodyText = (await page.textContent('body')) ?? ''
    expect(bodyText).toContain('No parameter of G1 sits on this cell.')
  })

  // WINDOWS.md #6: G1 (the default drawn group) places only on cell 0, and
  // only at layer 0. Moving the slider to layer 1 leaves G1 with zero cells
  // anywhere on the grid -- the exact shape of the live repro on
  // hm_20251104154614 (group gwt_src_benzene_63, layer 10, where none of
  // the run's four drawable groups has a single cell). The whole model
  // extent must read as absence, the same page-plane colour already proven
  // for a merely-not-this-group cell, never the ramp's low end.
  test('a layer where the drawn group has zero cells shows the page plane, not a ramp colour', async ({
    page,
  }) => {
    await page.goto(pestoUrl)
    await expect(page.locator('canvas[data-drawn="true"]')).toBeVisible({ timeout: 30_000 })

    await page.evaluate(() => {
      const input = document.querySelector('input[aria-label="Layer"]') as HTMLInputElement
      input.value = '1'
      input.dispatchEvent(new Event('input'))
    })

    const bodyText = (await page.textContent('body')) ?? ''
    expect(bodyText).toMatch(/0 cells contested/)
    expect(bodyText).toMatch(/4 cells no value/)

    const layout = await cellLayout(page)
    const png = await page.locator('canvas').screenshot()
    const dataUrl = `data:image/png;base64,${png.toString('base64')}`

    const background = await pixelAt(page, dataUrl, ...layout.clear)
    const cellZero = await pixelAt(page, dataUrl, layout.centreX(0), layout.midY) // G1's own cell, now no-parameter at layer 1

    expect(cellZero).toEqual(background)
  })

  // G4layer1's two pilot points sit at x 1.5 (p8 = 10) and x 3.5 (p9 = 20);
  // its factor file spreads them across all six cells, so the field rises
  // from cell 0 to cell 5 and cell 2 takes half of each point.
  test('an interpolated pilot-point group draws a gradient from one point to the other, and the readout names both', async ({
    page,
  }) => {
    await page.goto(pestoUrl)
    await expect(page.locator('canvas[data-drawn="true"]')).toBeVisible({ timeout: 30_000 })
    await page.selectOption('select[aria-label="Parameter group"]', 'G4layer1')
    await expect(page.locator('.floating-bottom-left')).toContainText('G4layer1 · interpolated')

    const layout = await cellLayout(page)
    const png = await page.locator('canvas').screenshot()
    const dataUrl = `data:image/png;base64,${png.toString('base64')}`
    const first = await pixelAt(page, dataUrl, layout.centreX(0), layout.midY)
    const middle = await pixelAt(page, dataUrl, layout.centreX(2), layout.midY)
    const last = await pixelAt(page, dataUrl, layout.centreX(5), layout.midY)
    expect(first).not.toEqual(last)
    expect(middle).not.toEqual(first)
    expect(middle).not.toEqual(last)

    await page.locator('canvas').click({ position: { x: layout.centreX(2), y: layout.midY } })
    await expect(page.locator('.floating-bottom-right')).toContainText('Interpolated from 2 pilot points')
    await expect(page.locator('.floating-bottom-right')).toContainText('p8 (weight 0.50)')
  })

  // G5's two points, p10 = 30 at x 2.25 and p11 = 60 at x 2.75, both sit in
  // cell 2 on layer 0: they draw as two dots, not one contested cell.
  test('a group placed by x/y draws as dots, and a click on one names its parameter and position', async ({
    page,
  }) => {
    await page.goto(pestoUrl)
    await expect(page.locator('canvas[data-drawn="true"]')).toBeVisible({ timeout: 30_000 })
    await page.selectOption('select[aria-label="Parameter group"]', 'G5')
    await expect(page.locator('.floating-bottom-left')).toContainText('2 points on this layer')
    await expect(page.locator('.floating-bottom-left')).not.toContainText('contested')

    const layout = await cellLayout(page)
    const dotX = Math.round(layout.width / 2 + layout.cell * (2.75 - 3))
    await page.locator('canvas').click({ position: { x: dotX, y: layout.midY } })
    await expect(page.locator('.floating-bottom-right')).toContainText('p11')
    await expect(page.locator('.floating-bottom-right')).toContainText('x 3, y 1 · layer 0')
  })

  // G-07-3: the top-left cluster is a see-through box. A press in its gaps used to
  // land on the box, not the canvas, so a drag there did nothing.
  test('a press in the see-through part of the top-left cluster lands on the canvas and pans', async ({ page }) => {
    await installCameraHook(page)
    await page.goto(pestoUrl)
    await expect(page.locator('canvas[data-drawn="true"]')).toBeVisible({ timeout: 30_000 })
    const before = await drawnMatrix(page)

    const point = await page.evaluate(() => {
      const cluster = document.querySelector('.floating-top-left') as HTMLElement
      const box = cluster.getBoundingClientRect()
      const kids = Array.from(cluster.children).map((child) => child.getBoundingClientRect())
      for (let y = Math.ceil(box.top) + 1; y < box.bottom - 1; y += 4) {
        for (let x = Math.ceil(box.left) + 1; x < box.right - 1; x += 4) {
          const inside = kids.some((k) => x >= k.left && x <= k.right && y >= k.top && y <= k.bottom)
          if (!inside) return { x, y, hit: document.elementFromPoint(x, y)?.tagName ?? null }
        }
      }
      return null
    })
    expect(point, 'no see-through point inside the top-left cluster').not.toBeNull()
    expect(point!.hit).toBe('CANVAS')

    await page.mouse.move(point!.x, point!.y)
    await page.mouse.down()
    await page.mouse.move(point!.x + 60, point!.y + 40, { steps: 6 })
    await page.mouse.up()

    await expect.poll(async () => (await drawnMatrix(page)).slice(6, 8).join(',')).not.toBe(before.slice(6, 8).join(','))
  })

  // G-07-3: every pan ended with a click that selected the cell under the release point.
  test('the click that ends a drag selects nothing', async ({ page }) => {
    await installCameraHook(page)
    await page.goto(pestoUrl)
    await expect(page.locator('canvas[data-drawn="true"]')).toBeVisible({ timeout: 30_000 })
    const before = await drawnMatrix(page)

    const readout = page.locator('.floating-bottom-right')
    const readoutBefore = await readout.innerText()
    const layout = await cellLayout(page)
    const box = (await page.locator('canvas').boundingBox())!

    // One cell to the right: pressed over cell 1, released over cell 2.
    const startX = box.x + layout.centreX(1)
    const endX = box.x + layout.centreX(2)
    const y = box.y + layout.midY
    await page.mouse.move(startX, y)
    await page.mouse.down()
    await page.mouse.move(endX, y, { steps: 8 })
    await page.mouse.up()

    await expect.poll(async () => (await drawnMatrix(page))[6]).not.toBe(before[6])
    await expect(readout).toHaveText(readoutBefore)

    // Control: a plain click on a cell does select. Cell 0 now sits where cell 1 was.
    await page.mouse.click(startX, y)
    await expect(readout).toContainText('Contested cell')
  })

  // G-07-3: the zoom followed the number of wheel events, not the distance scrolled.
  test('a small wheel step zooms less than a mouse notch, and a sideways swipe does not zoom', async ({ page }) => {
    await installCameraHook(page)
    await page.goto(pestoUrl)
    await expect(page.locator('canvas[data-drawn="true"]')).toBeVisible({ timeout: 30_000 })
    const box = (await page.locator('canvas').boundingBox())!
    const centre = { x: box.x + box.width / 2, y: box.y + box.height / 2 }

    const start = await drawnMatrix(page)
    await page.mouse.move(centre.x, centre.y)
    await page.mouse.wheel(0, -1)
    await expect.poll(async () => (await drawnMatrix(page))[0]).not.toBe(start[0])
    const small = (await drawnMatrix(page))[0] / start[0]
    expect(small).toBeGreaterThan(1)
    expect(small).toBeLessThan(1.01)

    await page.goto(pestoUrl)
    await expect(page.locator('canvas[data-drawn="true"]')).toBeVisible({ timeout: 30_000 })
    const fresh = await drawnMatrix(page)
    await page.mouse.move(centre.x, centre.y)
    await page.mouse.wheel(0, -100)
    await expect.poll(async () => (await drawnMatrix(page))[0]).not.toBe(fresh[0])
    expect(Math.abs((await drawnMatrix(page))[0] / fresh[0] - 1.1)).toBeLessThan(1e-3)

    // The sideways swipe comes first and the notch after it, so once the notch has
    // landed the swipe was handled: the whole change must be the notch alone.
    const beforeSwipe = (await drawnMatrix(page))[0]
    await page.mouse.wheel(25, 0)
    await page.mouse.wheel(0, -100)
    await expect.poll(async () => (await drawnMatrix(page))[0]).not.toBe(beforeSwipe)
    expect(Math.abs((await drawnMatrix(page))[0] / beforeSwipe - 1.1)).toBeLessThan(1e-3)
  })
})
