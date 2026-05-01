// Tiny doc-revision broadcaster.
//
// React components that need to derive state from the live ProseMirror doc
// (e.g. MarkPopover's context preview) subscribe via usePmDocVersion. The
// plugin bumps the version on every doc-changing transaction; subscribers
// re-read the doc on the next render.
//
// We deliberately publish a monotonic counter (not the doc itself) so
// useSyncExternalStore's getSnapshot remains referentially stable when
// nothing changed — that keeps React from re-rendering needlessly.

import { $prose } from '@milkdown/kit/utils'
import { Plugin } from '@milkdown/kit/prose/state'

let version = 0
const subscribers = new Set<() => void>()

export function subscribeToPmDocChanges(cb: () => void): () => void {
  subscribers.add(cb)
  return () => subscribers.delete(cb)
}

export function getPmDocVersion(): number {
  return version
}

function notify() {
  version += 1
  subscribers.forEach((cb) => cb())
}

export function createDocVersionPlugin() {
  return $prose(
    () =>
      new Plugin({
        view: () => ({
          update: (view, prevState) => {
            if (view.state.doc !== prevState.doc) notify()
          },
        }),
      }),
  )
}
