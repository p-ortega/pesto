// The data half of the map: what a parameter field is made of and how it is
// fetched. The map view draws; this module loads and classifies. It renders
// nothing and reads no page state.

import { gridValues, type GridValuesQuery } from '../data/client'
import { gridField } from '../data/fields'
import { LatestWins } from '../data/latest-wins'
import { fetchKey } from '../data/run'

// The eight statistics the server can serve; the same set the controls offer.
export type Statistic = 'value' | 'mean' | 'std' | 'q05' | 'q25' | 'q50' | 'q75' | 'q95'

export interface FieldRequest {
  iteration: number
  group: string
  kind: 'block' | 'cell'
  stat: Statistic
  realization: string | null
}

export type FieldAnswer = { stale: true } | { stale: false; field: Float32Array; request: FieldRequest }

export interface ParameterFieldSource {
  /**
   * Fetches one field. A newer call aborts this one, and an answer that
   * is no longer the newest comes back `{ stale: true }` rather than being
   * returned for drawing. A real failure of the newest call is thrown.
   */
  fetchField(request: FieldRequest): Promise<FieldAnswer>
}

export function createParameterFieldSource(opts: { runId: string }): ParameterFieldSource {
  const slot = new LatestWins<Float32Array>()

  async function fetchField(request: FieldRequest): Promise<FieldAnswer> {
    const key = fetchKey(opts.runId, request.iteration, request.group, request.kind, request.stat, request.realization)
    const query: GridValuesQuery =
      request.stat === 'value'
        ? { iteration: request.iteration, realization: request.realization ?? undefined }
        : { iteration: request.iteration, stat: request.stat }
    const answer = await slot.run(key, (signal) =>
      request.kind === 'cell'
        ? gridField({ ...query, group: request.group }, { signal })
        : gridValues(query, { signal }),
    )
    return answer.stale ? { stale: true } : { stale: false, field: answer.value, request }
  }

  return { fetchField }
}
