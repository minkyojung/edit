/**
 * proof-sdk mutation helper.
 *
 * Server에 변경 요청(mark accept/reject, suggest-*) 보낼 때 baseToken/baseRevision/
 * baseUpdatedAt 같은 mutation base를 동봉해서 stale write 를 막는다.
 *
 * proof-sdk 의 ShareClient.performMarkMutationWithRetry 패턴을 그대로 옮김.
 */

export const PROOF_URL = 'http://localhost:4000'

const STATE_RETRY_ATTEMPTS = 4
const STATE_RETRY_DELAY_MS = 100

export const TRANSIENT_MUTATION_CODES = new Set([
  'STALE_BASE',
  'PROJECTION_STALE',
  'AUTHORITATIVE_BASE_UNAVAILABLE',
  'MARK_NOT_FOUND',
  'MARK_NOT_HYDRATED',
  'COLLAB_SYNC_FAILED'
])

export type MutationBase =
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

export async function getMutationBase(slug: string, token: string): Promise<MutationBase> {
  for (let attempt = 0; attempt < STATE_RETRY_ATTEMPTS; attempt++) {
    const res = await fetch(`${PROOF_URL}/api/agent/${slug}/state`, {
      headers: { 'x-share-token': token }
    })
    if (!res.ok) {
      const text = await res.text()
      console.error('[proof] state fetch failed', { status: res.status, body: text })
      throw new Error(`state fetch failed: ${res.status} ${text}`)
    }
    const payload = (await res.json().catch(() => null)) as unknown
    const base = extractMutationBase(payload)
    if (base) return base
    if (attempt < STATE_RETRY_ATTEMPTS - 1) await sleep(STATE_RETRY_DELAY_MS)
  }
  throw new Error('Could not determine current mutation base')
}

type SubmitFn = (base: MutationBase) => Promise<Response>

/**
 * 1차 호출 → transient 에러면 새 base 받아서 1회 재시도.
 * 응답이 ok 이면 Response 반환, 아니면 throw.
 */
export async function withMutationBaseRetry(
  slug: string,
  token: string,
  submit: SubmitFn,
  label: string
): Promise<Response> {
  let base = await getMutationBase(slug, token)
  let res = await submit(base)

  if (!res.ok) {
    const body = (await res.clone().json().catch(() => null)) as
      | { code?: unknown; error?: unknown }
      | null
    const code = typeof body?.code === 'string' ? body.code.toUpperCase() : ''
    if (TRANSIENT_MUTATION_CODES.has(code)) {
      console.warn(`[proof] ${label} transient ${code}, retrying`)
      await sleep(STATE_RETRY_DELAY_MS)
      base = await getMutationBase(slug, token)
      res = await submit(base)
    }
  }

  if (!res.ok) {
    const text = await res.text()
    throw new Error(`${label} failed: ${res.status} ${text}`)
  }
  return res
}
