// The line under a control that says why it is disabled (a reason, ℹ) or that
// a setting was changed for the user (a warning, ⚠).

export type NoteKind = 'reason' | 'warning'

export interface Note {
  kind: NoteKind
  text: string
}

const GLYPH: Record<NoteKind, string> = { reason: 'ℹ', warning: '⚠' }

/** Draws `note` into `el`, or empties and hides `el` for null. Only the glyph is warning ink: warning-ink text fails contrast on the light surface. */
export function paintNote(el: HTMLElement, note: Note | null): void {
  el.textContent = ''
  if (note === null) {
    el.style.display = 'none'
    return
  }
  const glyph = document.createElement('span')
  glyph.setAttribute('aria-hidden', 'true')
  glyph.textContent = GLYPH[note.kind]
  glyph.style.color = note.kind === 'warning' ? 'var(--status-warning)' : 'var(--ink-secondary)'
  const text = document.createElement('span')
  text.classList.add('note-text')
  text.style.color = note.kind === 'warning' ? 'var(--ink-primary)' : 'var(--ink-secondary)'
  text.textContent = note.text
  el.appendChild(glyph)
  el.appendChild(document.createTextNode(' '))
  el.appendChild(text)
  el.style.display = ''
}
