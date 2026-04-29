import { bootstrapDoc } from './docService'

const PROOF_URL = 'http://localhost:4000'
const ACTOR = 'human:user'
const STATE_RETRY_ATTEMPTS = 4
const STATE_RETRY_DELAY_MS = 100

const TRANSIENT_CODES = new Set([
  'STALE_BASE',
  'PROJECTION_STALE',
  'AUTHORITATIVE_BASE_UNAVAILABLE',
  'MARK_NOT_FOUND',
  'MARK_NOT_HYDRATED',
  'COLLAB_SYNC_FAILED'
])

type MutationBase =
  | { baseToken: string }
  | { baseRevision: number }
  | { baseUpdatedAt: string }
  | Record<string, never>

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

function extractMutationBase(payload: unknown): MutationBase | null {
  if (!payload || typeof payload !== 'object') return null
  const p = payload as Record<string, unknown>

  const mb = p.mutationBase
  if (mb && typeof mb === 'object' && !Array.isArray(mb)) {
    const token = (mb as { token?: unknown }).token
    if (typeof token === 'string' && token.trim()) return { baseToken: token.trim() }
  }

  const revision = p.revision
  if (typeof revision === 'number' && Number.isInteger(revision) && revision > 0) {
    return { baseRevision: revision }
  }

  const updatedAt = p.updatedAt
  if (typeof updatedAt === 'string' && updatedAt.trim()) {
    return { baseUpdatedAt: updatedAt.trim() }
  }

  return null
}

async function getMutationBase(slug: string, token: string): Promise<MutationBase> {
  for (let attempt = 0; attempt < STATE_RETRY_ATTEMPTS; attempt++) {
    const res = await fetch(`${PROOF_URL}/api/agent/${slug}/state`, {
      headers: { 'x-share-token': token }
    })
    if (!res.ok) {
      const text = await res.text()
      console.error('[mark] state fetch failed', { status: res.status, body: text })
      throw new Error(`state fetch failed: ${res.status} ${text}`)
    }
    const payload = (await res.json().catch(() => null)) as unknown
    const base = extractMutationBase(payload)
    console.log('[mark] /state response', {
      attempt,
      hasMutationBase: !!(payload as { mutationBase?: unknown })?.mutationBase,
      revision: (payload as { revision?: unknown })?.revision,
      updatedAt: (payload as { updatedAt?: unknown })?.updatedAt,
      extractedBase: base
    })
    if (base) return base
    if (attempt < STATE_RETRY_ATTEMPTS - 1) await sleep(STATE_RETRY_DELAY_MS)
  }
  throw new Error('Could not determine current mutation base')
}

async function submitMarkMutation(
  action: 'accept' | 'reject',
  slug: string,
  token: string,
  markId: string,
  base: MutationBase
): Promise<Response> {
  return fetch(`${PROOF_URL}/api/agent/${slug}/marks/${action}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-share-token': token
    },
    body: JSON.stringify({ markId, by: ACTOR, ...base })
  })
}

async function callMarkApi(action: 'accept' | 'reject', markId: string): Promise<void> {
  console.log(`[mark] ${action} START`, { markId })
  const doc = await bootstrapDoc()

  let base = await getMutationBase(doc.slug, doc.token)
  console.log(`[mark] ${action} submit (1st)`, { markId, base })
  let res = await submitMarkMutation(action, doc.slug, doc.token, markId, base)
  console.log(`[mark] ${action} response (1st)`, { status: res.status, ok: res.ok })

  if (!res.ok) {
    const body = await res.clone().json().catch(() => null) as { code?: unknown; error?: unknown } | null
    const code = typeof body?.code === 'string' ? body.code.toUpperCase() : ''
    console.warn(`[mark] ${action} 1st attempt failed`, { status: res.status, code, error: body?.error })
    if (TRANSIENT_CODES.has(code)) {
      console.log(`[mark] ${action} retrying after transient error`, { code })
      await sleep(STATE_RETRY_DELAY_MS)
      base = await getMutationBase(doc.slug, doc.token)
      console.log(`[mark] ${action} submit (retry)`, { markId, base })
      res = await submitMarkMutation(action, doc.slug, doc.token, markId, base)
      console.log(`[mark] ${action} response (retry)`, { status: res.status, ok: res.ok })
    }
  }

  if (!res.ok) {
    const text = await res.text()
    console.error(`[mark] ${action} FAILED`, { markId, status: res.status, body: text })
    throw new Error(`mark ${action} failed: ${res.status} ${text}`)
  }
  console.log(`[mark] ${action} DONE`, { markId })
}

export function acceptMark(markId: string): Promise<void> {
  return callMarkApi('accept', markId)
}

export function rejectMark(markId: string): Promise<void> {
  return callMarkApi('reject', markId)
}
