/**
 * Page — the single rendering unit for any open doc.
 *
 * A thin wrapper that lazy-mounts the editor body (CmEditor) per open doc. The
 * title surface (PageHeader) is no longer stitched above the editor here — it
 * renders INSIDE CodeMirror as a top block widget (see cmPageHeaderWidget) so it
 * scrolls away with the body. The doc-kind branch that decides "what does the title
 * area look like" still lives inside PageHeader.
 *
 * Routes / shells render <Page handle status/>.
 */

import { lazy, Suspense } from 'react'
import type { CollabHandle, CollabStatus } from '@/hooks/useCollabDoc'

interface Props {
  handle: CollabHandle | null
  status: CollabStatus
}

// CodeMirror is the editor. (Milkdown was retired — see the CM migration plan.)
// Lazy-loaded so the large CM module is split out of the initial bundle.
// The note title + properties (PageHeader) now render INSIDE the editor as a top
// block widget (see cmPageHeaderWidget) so they scroll away with the body, so Page
// no longer stitches a header above the editor.
const CmEditor = lazy(() => import('@/editor/CmEditor').then((m) => ({ default: m.CmEditor })))

export function Page({ handle, status }: Props) {
  return (
    <Suspense fallback={null}>
      <CmEditor handle={handle} status={status} />
    </Suspense>
  )
}
