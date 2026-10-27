import type { Chart2D, ChartSize } from './histogram'

export interface CanvasHostOptions {
  label: string
  draw: (ctx: Chart2D, size: ChartSize) => void
  context?: () => Chart2D | null
}

export interface CanvasHost {
  redraw(): void
  onShow(): void
  onHide(): void
  setLabel(text: string): void
  destroy(): void
}

export function createCanvasHost(_container: HTMLElement, _options: CanvasHostOptions): CanvasHost {
  return { redraw() {}, onShow() {}, onHide() {}, setLabel() {}, destroy() {} }
}
