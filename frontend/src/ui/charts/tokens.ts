// The colours a chart draws with, as resolved CSS strings. They come from
// the theme's custom properties so a chart follows light and dark.

import { parseNumberToken } from '../../gl/color-token'

export interface ChartTokens {
  axis: string
  gridline: string
  inkPrimary: string
  inkMuted: string
  series1: string
  series2: string
}

export function readChartTokens(el: Element): ChartTokens {
  const style = getComputedStyle(el)
  const read = (name: string) => style.getPropertyValue(name).trim()
  return {
    axis: read('--axis'),
    gridline: read('--gridline'),
    inkPrimary: read('--ink-primary'),
    inkMuted: read('--ink-muted'),
    series1: read('--series-1'),
    series2: read('--series-2'),
  }
}

/** How faint an unselected mark draws, from the theme's --dim-alpha. Kept off
 *  ChartTokens so the literals tests build stay valid. */
export function readDimAlpha(el: Element): number {
  return parseNumberToken(getComputedStyle(el).getPropertyValue('--dim-alpha'))
}
