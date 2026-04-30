import { useEffect, useState } from 'react'
import * as Y from 'yjs'
import { HocuspocusProvider } from '@hocuspocus/provider'
import { proofClient, waitUntilReady } from '../lib/proofClient'

export type CollabStatus = 'initializing' | 'connecting' | 'connected' | 'error'

export interface CollabDoc {
  ydoc: Y.Doc
  provider: HocuspocusProvider
  status: CollabStatus
}

const DOC_SLUG_KEY = 'writer-tauri:doc-slug'
const DOC_TITLE = 'My Document'

export function useCollabDoc(): CollabDoc | null {
  const [collabDoc, setCollabDoc] = useState<CollabDoc | null>(null)

  useEffect(() => {
    let cancelled = false
    let ydoc: Y.Doc | null = null
    let provider: HocuspocusProvider | null = null

    async function init() {
      const ready = await waitUntilReady(15_000)
      if (!ready || cancelled) return

      // Reuse existing slug or create a new doc
      let slug = localStorage.getItem(DOC_SLUG_KEY)
      if (!slug) {
        try {
          const created = await proofClient.createDoc(DOC_TITLE)
          slug = created.slug
          localStorage.setItem(DOC_SLUG_KEY, slug)
        } catch (err) {
          console.error('[collab] failed to create doc', err)
          if (!cancelled) setCollabDoc(null)
          return
        }
      }

      let wsUrl: string
      let token: string
      try {
        const { session } = await proofClient.getCollabSession(slug)
        wsUrl = session.collabWsUrl
        token = session.token
      } catch (err) {
        console.error('[collab] failed to get collab session', err)
        if (!cancelled) setCollabDoc(null)
        return
      }

      if (cancelled) return

      ydoc = new Y.Doc()
      provider = new HocuspocusProvider({
        url: wsUrl,
        name: slug,
        document: ydoc,
        token,
        onStatus: ({ status }) => {
          if (cancelled) return
          setCollabDoc((prev) =>
            prev
              ? { ...prev, status: status === 'connected' ? 'connected' : 'connecting' }
              : prev,
          )
        },
      })

      if (!cancelled) {
        setCollabDoc({ ydoc, provider, status: 'connecting' })
      }
    }

    init()

    return () => {
      cancelled = true
      provider?.destroy()
      ydoc?.destroy()
      provider = null
      ydoc = null
    }
  }, [])

  return collabDoc
}
