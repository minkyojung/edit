import { useEffect, useRef, useState } from 'react'
import * as Y from 'yjs'
import { HocuspocusProvider } from '@hocuspocus/provider'
import { proofClient, waitUntilReady } from '../lib/proofClient'

export type CollabStatus = 'initializing' | 'connecting' | 'connected' | 'error'

export type StoredMarkStatus = 'pending' | 'accepted' | 'rejected'
export type MarkKind = 'authored' | 'approved' | 'flagged' | 'comment' | 'insert' | 'delete' | 'replace'

export interface StoredMark {
  id?: string
  kind: MarkKind
  by?: string
  at?: string
  quote?: string
  range?: { from: number; to: number }
  startRel?: string
  endRel?: string
  content?: string
  status?: StoredMarkStatus
  text?: string
  resolved?: boolean
  orphaned?: boolean
  note?: string
}

export interface CollabHandle {
  ydoc: Y.Doc
  provider: HocuspocusProvider
}

const DOC_SLUG_KEY = 'writer-tauri:doc-slug'
const DOC_TITLE = 'My Document'

// Returns a stable handle (ydoc + provider never change once set) and a separate status.
export function useCollabDoc(): { handle: CollabHandle | null; status: CollabStatus } {
  const [handle, setHandle] = useState<CollabHandle | null>(null)
  const [status, setStatus] = useState<CollabStatus>('initializing')
  // Keep a ref so onStatus callback can always read the latest cancelled flag
  const cancelledRef = useRef(false)

  useEffect(() => {
    cancelledRef.current = false
    let ydoc: Y.Doc | null = null
    let provider: HocuspocusProvider | null = null

    async function init() {
      const ready = await waitUntilReady(15_000)
      if (cancelledRef.current) return
      if (!ready) {
        setStatus('error')
        return
      }

      let slug = localStorage.getItem(DOC_SLUG_KEY)
      if (!slug) {
        try {
          const created = await proofClient.createDoc(DOC_TITLE)
          slug = created.slug
          localStorage.setItem(DOC_SLUG_KEY, slug)
        } catch (err) {
          console.error('[collab] failed to create doc', err)
          if (!cancelledRef.current) setStatus('error')
          return
        }
      }

      let wsUrl: string
      let token: string
      try {
        const { session } = await proofClient.getCollabSession(slug)
        // The server (ws.ts) detects collab connections by ?role=... in the URL.
        // It also validates the token from URL params before handing off to Hocuspocus.
        // This matches the v2 `parameters: { token, role }` behavior that the server expects.
        const url = new URL(session.collabWsUrl)
        url.searchParams.set('token', session.token)
        url.searchParams.set('role', session.role)
        wsUrl = url.toString()
        token = session.token
      } catch (err) {
        console.error('[collab] failed to get collab session', err)
        if (!cancelledRef.current) setStatus('error')
        return
      }

      if (cancelledRef.current) return

      ydoc = new Y.Doc()
      provider = new HocuspocusProvider({
        url: wsUrl,
        name: slug,
        document: ydoc,
        token,
        onStatus: ({ status: s }) => {
          if (cancelledRef.current) return
          setStatus(s === 'connected' ? 'connected' : 'connecting')
        },
      })

      setHandle({ ydoc, provider })
      setStatus('connecting')
    }

    init()

    return () => {
      cancelledRef.current = true
      provider?.destroy()
      ydoc?.destroy()
      provider = null
      ydoc = null
      setHandle(null)
      setStatus('initializing')
    }
  }, [])

  return { handle, status }
}
