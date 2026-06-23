/**
 * Page — the single rendering unit for any open doc.
 *
 * Composes the title surface (PageHeader) with the editor body (CmEditor)
 * so that consumers mount one component per open doc instead of stitching
 * header + editor at every call site. The doc-kind branch that decides
 * "what does the title area look like" lives inside PageHeader; the editor
 * itself is agnostic to it.
 *
 * Routes / shells render <Page handle status onViewReady/>.
 */

import { lazy, Suspense } from 'react'
import type { EditorView } from '@milkdown/kit/prose/view'
import type { CollabHandle, CollabStatus } from '@/hooks/useCollabDoc'
import { PageHeader } from './PageHeader'

interface Props {
  handle: CollabHandle | null
  status: CollabStatus
  onViewReady?: (view: EditorView | null) => void
}

// CodeMirror is the editor. (Milkdown was retired — see the CM migration plan.)
// Lazy-loaded so the large CM module is split out of the initial bundle.
const CmEditor = lazy(() => import('@/editor/CmEditor').then((m) => ({ default: m.CmEditor })))

export function Page({ handle, status, onViewReady }: Props) {
  const header = handle ? <PageHeader slug={handle.slug} /> : null
  return (
    <Suspense fallback={null}>
      <CmEditor handle={handle} status={status} onViewReady={onViewReady} header={header} />
    </Suspense>
  )
}
