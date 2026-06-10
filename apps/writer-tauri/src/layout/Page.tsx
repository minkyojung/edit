/**
 * Page — the single rendering unit for any open doc.
 *
 * Composes the title surface (PageHeader) with the editor body
 * (MilkdownEditor) so that consumers mount one component per
 * open doc instead of stitching header + editor at every call
 * site. The doc-kind branch that decides "what does the title
 * area look like" lives inside PageHeader; the editor itself
 * is agnostic to it.
 *
 * Routes / shells render <Page handle status onViewReady/>.
 * The editor still receives the handle and runs all its plugins —
 * it just no longer renders the page header on its own.
 */

import { lazy, Suspense } from 'react'
import type { EditorView } from '@milkdown/kit/prose/view'
import type { CollabHandle, CollabStatus } from '@/hooks/useCollabDoc'
import { MilkdownEditor } from '@/editor/MilkdownEditor'
import { PageHeader } from './PageHeader'

interface Props {
  handle: CollabHandle | null
  status: CollabStatus
  onViewReady?: (view: EditorView | null) => void
}

// Stage-1 swap flag (DEV-only, reversible). Flip in the console:
//   localStorage.setItem('writer.cmEditor', '1'); location.reload()
// to mount the CodeMirror editor instead of Milkdown; remove it to revert.
// Lazy so the CM editor + its prototype modules never enter the production bundle.
const CmEditor = lazy(() => import('@/editor/CmEditor').then((m) => ({ default: m.CmEditor })))
const useCmEditor = (): boolean =>
  import.meta.env.DEV && typeof localStorage !== 'undefined' && localStorage.getItem('writer.cmEditor') === '1'

export function Page({ handle, status, onViewReady }: Props) {
  const header = handle ? <PageHeader slug={handle.slug} /> : null
  if (useCmEditor()) {
    return (
      <Suspense fallback={null}>
        <CmEditor handle={handle} status={status} onViewReady={onViewReady} header={header} />
      </Suspense>
    )
  }
  return <MilkdownEditor handle={handle} status={status} onViewReady={onViewReady} header={header} />
}
