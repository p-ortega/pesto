// The colours a chart draws with, as resolved CSS strings. They come from
// the theme's custom properties so a chart follows light and dark.

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
