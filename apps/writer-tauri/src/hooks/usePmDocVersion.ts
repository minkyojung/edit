// React 18 hook bound to the doc-version broadcaster.
// Returns a number that increments whenever any editor's doc changes;
// callers don't use the value, they just depend on it (e.g. in useMemo)
// to re-derive doc-derived state.

import { useSyncExternalStore } from 'react'
import { getPmDocVersion, subscribeToPmDocChanges } from '@/editor/docVersionPlugin'

export function usePmDocVersion(): number {
  return useSyncExternalStore(subscribeToPmDocChanges, getPmDocVersion)
}
