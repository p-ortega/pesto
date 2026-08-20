// This file exists because a browser's native `EventSource` cannot carry
// the session token as a request header: its constructor has no option
// for a custom header at all -- a gap in the specification itself, not in
// any one browser -- and D-08 requires the token to travel as one. Putting
// the token back in the URL for this single route would undo the whole of
// D-08. So this module does by hand what that native client does inside
// itself: split the response body on a blank line, read the `data:`
// lines. That is a few dozen lines against a five-field line protocol
// with one delimiter, which is why this is the stated exception to this
// project's don't-hand-roll rule.

import { authHeaders as sessionHeaders } from '../auth/token'
import { ApiError, type ProblemDetails } from './client'

export interface SseEvent {
  event: string | null
  data: string
}

// The wire format allows exactly one leading space after the colon; a
// JSON payload that happens to start with a space of its own must not
// lose it.
function stripOneLeadingSpace(value: string): string {
  return value.startsWith(' ') ? value.slice(1) : value
}

/**
 * Split a buffer of `text/event-stream` bytes into the complete frames it
 * holds and the unconsumed remainder. Pure and synchronous, so every
 * parsing edge is testable without a network. `data:` lines within one
 * frame are concatenated with a newline between them, per the wire
 * format allowing several per frame. A frame with no `data:` line yields
 * no event but is still consumed -- a frame consisting only of an
 * `event: done` line is exactly this case. The caller owns the buffer:
 * this function never mutates its argument.
 */
export function parseFrames(buffer: string): { events: SseEvent[]; rest: string } {
  const events: SseEvent[] = []
  let rest = buffer

  while (true) {
    const boundary = rest.indexOf('\n\n')
    if (boundary === -1) {
      break
    }

    const segment = rest.slice(0, boundary)
    rest = rest.slice(boundary + 2)

    let eventName: string | null = null
    const dataLines: string[] = []
    for (const line of segment.split('\n')) {
      if (line.startsWith('data:')) {
        dataLines.push(stripOneLeadingSpace(line.slice('data:'.length)))
      } else if (line.startsWith('event:')) {
        eventName = stripOneLeadingSpace(line.slice('event:'.length))
      }
    }

    if (dataLines.length > 0) {
      events.push({ event: eventName, data: dataLines.join('\n') })
    }
  }

  return { events, rest }
}

// An abort a caller asked for is not a failure this module should report
// as one -- the caller already knows it stopped the read on purpose. Duck
// typed on `.name` rather than `instanceof DOMException`, since a scripted
// reader in a test can raise the same shape without a real one.
function isAbort(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { name?: unknown }).name === 'AbortError'
}

async function toProblem(response: Response): Promise<ApiError> {
  const problem = (await response.json()) as ProblemDetails
  return new ApiError(problem)
}

/**
 * Read a `text/event-stream` response with `fetch`, carrying the session
 * token on a header -- the whole reason this module exists rather than
 * constructing the browser's own event-stream client. Every event is
 * handed to `onEvent` as it is parsed; JSON parsing of `data` is left to
 * the caller, so this parser has one reason to fail rather than two.
 *
 * One `TextDecoder` instance is reused across every chunk, in streaming
 * mode: a fresh decoder per chunk corrupts a multi-byte character split
 * across a chunk boundary. The reader's lock is released in a `finally`
 * so a thrown error never leaves the stream locked.
 */
export async function readEvents(
  url: string,
  onEvent: (event: SseEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  let response: Response
  try {
    response = await fetch(url, { headers: sessionHeaders(), signal })
  } catch (error) {
    if (isAbort(error)) {
      return
    }
    throw error
  }

  if (!response.ok) {
    throw await toProblem(response)
  }

  const body = response.body
  if (!body) {
    return
  }

  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  try {
    while (true) {
      let step: { done: boolean; value?: Uint8Array }
      try {
        step = await reader.read()
      } catch (error) {
        if (isAbort(error)) {
          return
        }
        throw error
      }

      if (step.done || !step.value) {
        break
      }

      buffer += decoder.decode(step.value, { stream: true })
      const { events, rest } = parseFrames(buffer)
      buffer = rest
      for (const event of events) {
        onEvent(event)
      }
    }
  } finally {
    reader.releaseLock()
  }
}
