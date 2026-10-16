// A no-op unless a test installs window.__pestoFrames before the page loads.
export interface FrameStamp {
  t: number
  selection: string
  layer: number
  group: string | null
}

declare global {
  interface Window {
    __pestoFrames?: FrameStamp[]
  }
}

export function frameLogInstalled(): boolean {
  return Array.isArray(window.__pestoFrames)
}

export function markFrame(stamp: Omit<FrameStamp, 't'>): void {
  const log = window.__pestoFrames
  if (Array.isArray(log)) log.push({ t: performance.now(), ...stamp })
}
