// How the map follows the shared selection (LINK-02, D-08 to D-10, D-20): which drawn dots hold
// a selected id, and the counts of selected items the map cannot draw, as plain sentences.
// No DOM here; the map view puts the sentences on screen as text.

/** The indices of drawn dots whose id is selected, ascending. A null id never matches. */
export function selectedDotIndices(
  rows: Int32Array | readonly number[],
  idOf: (row: number) => number | string | null,
  selected: ReadonlySet<number | string>,
): number[] {
  const out: number[] = []
  if (selected.size === 0) return out
  for (let i = 0; i < rows.length; i++) {
    const id = idOf(rows[i])
    if (id !== null && selected.has(id)) out.push(i)
  }
  return out
}
