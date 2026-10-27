// A shared selection that already has one parameter group chosen, for tests
// that mount the whole map screen and then look at the Params list, which
// stays empty until a group is chosen.

import { emptySelection } from '../../src/state/rules'
import { createSelectionStore, type SelectionStore } from '../../src/state/selection'

export function storeWithGroup(group: string): SelectionStore {
  return createSelectionStore({ initial: { ...emptySelection('run', 0), parGroups: new Set([group]) } })
}
