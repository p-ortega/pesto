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

export function readChartTokens(_el: Element): ChartTokens {
  return { axis: '', gridline: '', inkPrimary: '', inkMuted: '', series1: '', series2: '' }
}
