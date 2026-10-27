// A recording stand-in for CanvasRenderingContext2D. jsdom has no 2D
// context, so the chart kit is tested by the calls it makes. Every method
// call and every property set is logged in order, with a snapshot of the
// paint state at that moment, so a test can ask "what colour was set when
// this bar was filled".

import type { Chart2D } from '../../src/ui/charts/histogram'

export interface PaintState {
  fillStyle: unknown
  strokeStyle: unknown
  globalAlpha: number
  lineWidth: number
  dash: number[]
}

export interface RecordedCall {
  method: string
  args: unknown[]
  state: PaintState
}

const METHODS = [
  'clearRect',
  'fillRect',
  'strokeRect',
  'beginPath',
  'moveTo',
  'lineTo',
  'stroke',
  'fillText',
  'save',
  'restore',
  'setTransform',
] as const

export function createRecording2d(): { ctx: Chart2D; calls: RecordedCall[] } {
  const calls: RecordedCall[] = []
  const state: PaintState = {
    fillStyle: 'unset',
    strokeStyle: 'unset',
    globalAlpha: 1,
    lineWidth: 1,
    dash: [],
  }
  const snapshot = (): PaintState => ({ ...state, dash: [...state.dash] })
  const log = (method: string, args: unknown[]) => calls.push({ method, args, state: snapshot() })

  const target: Record<string, unknown> = {
    font: '',
    textAlign: 'start',
    textBaseline: 'alphabetic',
    measureText: (text: string) => ({ width: text.length * 6 }),
    setLineDash: (segments: number[]) => {
      state.dash = [...segments]
      log('setLineDash', [segments])
    },
  }
  for (const method of METHODS) {
    target[method] = (...args: unknown[]) => log(method, args)
  }
  for (const key of ['fillStyle', 'strokeStyle', 'globalAlpha', 'lineWidth'] as const) {
    Object.defineProperty(target, key, {
      get: () => state[key],
      set: (value: unknown) => {
        ;(state as unknown as Record<string, unknown>)[key] = value
        log(`set:${key}`, [value])
      },
    })
  }
  return { ctx: target as unknown as Chart2D, calls }
}
