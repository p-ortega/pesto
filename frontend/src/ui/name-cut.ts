// A long site or group name keeps its end in view: names like `oname:...:bore-21b` share a long
// start and differ at the end, so a plain end ellipsis hides the part that tells them apart.

const SEPARATORS = [':', '_', '/', '|']
/** Names this short or shorter show whole, and a name with no usable last part keeps this many. */
const KEEP = 16
const TAIL_MIN = 4
const TAIL_MAX = 24

/**
 * Where the kept end of `name` starts, or -1 when the name is not split: the text after the
 * last ':', '_', '/' or '|' when it is 4 to 24 characters long, otherwise the last 16 characters.
 */
export function nameTailStart(name: string): number {
  if (name.length <= KEEP) return -1
  const last = Math.max(...SEPARATORS.map((s) => name.lastIndexOf(s)))
  const tail = last === -1 ? 0 : name.length - last - 1
  if (last !== -1 && tail >= TAIL_MIN && tail <= TAIL_MAX) return last + 1
  return name.length - KEEP
}

/**
 * Fills `cell` with `name` as a head that cuts with an ellipsis and a tail that never shrinks.
 * The cut is drawing only: the cell's text is the whole name, and its title is `title` or the name.
 */
export function paintCutName(cell: HTMLElement, name: string, title: string = name): void {
  cell.textContent = ''
  const at = nameTailStart(name)
  cell.classList.toggle('name-cut', at !== -1)
  if (at === -1) {
    cell.textContent = name
  } else {
    const head = document.createElement('span')
    head.classList.add('name-head')
    head.textContent = name.slice(0, at)
    const tail = document.createElement('span')
    tail.classList.add('name-tail')
    tail.textContent = name.slice(at)
    cell.append(head, tail)
  }
  if (title !== '') cell.title = title
}
