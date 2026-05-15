const BASE_URL = 'http://localhost:4000'

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE_URL}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...init?.headers },
  })
  if (!res.ok) throw new Error(`proof-server ${res.status}: ${path}`)
  return res.json() as Promise<T>
}

export async function waitUntilReady(maxMs = 10_000): Promise<boolean> {
  const deadline = Date.now() + maxMs
  while (Date.now() < deadline) {
    try {
      await fetch(`${BASE_URL}/health`, { signal: AbortSignal.timeout(500) })
      return true
    } catch {
      await new Promise((r) => setTimeout(r, 300))
    }
  }
  return false
}

export interface CollabSession {
  collabWsUrl: string
  token: string
  role: string
  syncProtocol: string
}

// Mark mutation (create / accept / reject) used to live here as REST helpers.
// They were replaced by direct Y.Doc + Y.Map writes (see markActions and
// MarkToolbar) so the OAuth-bearing client doesn't need to hold the
// /api/documents ops surface anymore.
//
// 2026-05 — bringing the ops surface back, but on the canonical
// /documents/:slug/ops route from the public proof-sdk contract. The
// direct-Yjs path produced a class of "server quietly reverts our
// content" bugs we kept band-aiding (split-tr in markActions.ts,
// anchor-on-existing-text in applyIngest.ts) because the server's
// drift detector misreads composite local writes as projection
// wipes. POSTing the mutation as a typed op makes the server itself
// produce the Yjs update; drift detection can't fire on changes the
// server originated, so the band-aids become unnecessary as call
// sites migrate over. ops() below is the foundation; no caller wired
// to it yet (next PRs swap the implementations one feature at a time).

export const proofClient = {
  // Uses the agent path (/documents without /api prefix) which skips client version headers.
  // markdown is required as a parameter but may be empty — proof-server now accepts blank
  // bodies, so fresh notes pass '' rather than seeding a body template. Callsites that
  // want a starter template still pass a literal markdown string.
  //
  // options.slug — when provided, the server registers under this slug
  // instead of minting its own. Used by the offline-first creation path:
  // the client decides the slug up front (so the editor and IndexedDB
  // can start working before the network), then calls this as a fire-
  // and-forget registration. The endpoint is idempotent on slug, so a
  // retry after a partial failure returns the existing doc unchanged.
  async createDoc(
    title: string,
    markdown: string,
    options: { slug?: string } = {},
  ): Promise<{ slug: string; alreadyExisted?: boolean }> {
    return request('/documents', {
      method: 'POST',
      body: JSON.stringify({
        title,
        markdown,
        ...(options.slug ? { slug: options.slug } : {}),
      }),
    })
  },
  async getCollabSession(slug: string): Promise<{ session: CollabSession }> {
    return request(`/documents/${slug}/collab-session`)
  },
  // Hard delete on the sidecar — used only when emptying the trash or
  // permanently removing a single trashed doc. Soft-delete is purely a
  // frontend concern (knownDocs.deletedAt); the server keeps the doc
  // intact until this call. The sidecar treats this as destructive:
  // the row stays with share_state='DELETED' but is unreadable, and
  // the y-state is dropped.
  async deleteDocForever(slug: string): Promise<{ success: true }> {
    return request(`/documents/${slug}`, { method: 'DELETE' })
  },
  // POST /documents/:slug/ops — typed mutation surface for marks,
  // suggestions, and full-doc rewrites. See OpsPayload for the
  // operation menu the server understands today (mirrors
  // proof-sdk/server/document-ops.ts DocumentOpType).
  //
  // Idempotency-Key is auto-generated per call so the same op
  // dispatched twice (e.g. a retry after a flaky network) coalesces
  // to one server-side mutation. token is the per-doc access token
  // from getCollabSession; required by the server for any non-public
  // operation. Throws OpsError on non-2xx so callers can branch on
  // structured codes (ANCHOR_NOT_FOUND, STALE_REVISION, etc.) rather
  // than parsing strings.
  async ops(slug: string, token: string | null, payload: OpsPayload): Promise<OpsResponse> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Idempotency-Key': crypto.randomUUID(),
    }
    if (token) headers.Authorization = `Bearer ${token}`
    const res = await fetch(`${BASE_URL}/documents/${slug}/ops`, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
    })
    const body = await safeParseJson(res)
    if (!res.ok) {
      const code = isRecord(body) && typeof body.code === 'string' ? body.code : null
      const error = isRecord(body) && typeof body.error === 'string' ? body.error : res.statusText
      throw new OpsError(res.status, code, error, body)
    }
    return body as OpsResponse
  },
}

// ── ops types ───────────────────────────────────────────────────

/**
 * Ops payload shape matches proof-sdk's document-engine field names —
 * specifically `markId` everywhere a mark is referenced. The earlier
 * draft used `suggestionId` / `commentId` which the server's
 * document-engine.ts ignores (it reads `body.markId`), producing a
 * silent 400 "Missing markId". Names corrected before the first real
 * caller wires in.
 */
export type OpsPayload =
  | { type: 'comment.add'; quote: string; text: string; by: string }
  | { type: 'comment.reply'; markId: string; text: string; by: string }
  | { type: 'comment.resolve'; markId: string; by: string }
  | { type: 'comment.unresolve'; markId: string; by: string }
  | { type: 'suggestion.add'; kind: 'insert' | 'delete' | 'replace'; quote: string; content?: string; by: string; status?: 'accepted' }
  | { type: 'suggestion.accept'; markId: string; by: string }
  | { type: 'suggestion.reject'; markId: string; by: string }
  | { type: 'rewrite.apply'; content: string; by: string }

export interface OpsResponse {
  success?: boolean
  // The server returns operation-specific shapes; callers should
  // narrow on `type` of the request rather than the response. Common
  // fields when present:
  id?: string
  markId?: string
  revision?: number
  [key: string]: unknown
}

/** Structured error for /ops failures. `code` mirrors the server's
 * structured codes (PROJECTION_STALE, STALE_REVISION, ANCHOR_NOT_FOUND,
 * IDEMPOTENCY_KEY_REQUIRED, etc.) so callers can branch on cause
 * without parsing the message. */
export class OpsError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string | null,
    message: string,
    public readonly body: unknown,
  ) {
    super(message)
    this.name = 'OpsError'
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

async function safeParseJson(res: Response): Promise<unknown> {
  try {
    return await res.json()
  } catch {
    return null
  }
}
