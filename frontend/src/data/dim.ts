// The one dim rule every view shares (D-02, D-03): a mark draws faint only
// when its own kind has a selection and the mark is not in it. Dimming never
// hides or removes a mark.

export { readDimAlpha } from '../ui/charts/tokens'

export function isDimmed<T>(selected: ReadonlySet<T>, id: T): boolean {
  return selected.size > 0 && !selected.has(id)
}
