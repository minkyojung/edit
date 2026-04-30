import { bootstrapDoc } from './docService'

const PROOF_URL = 'http://localhost:4000'
const DEFAULT_ACTOR = 'human:user'

type Creds = { slug: string; token: string }

export type MarkState = {
  marks: Record<string, unknown>
  revision?: number
  mutationBase?: { token?: string }
  updatedAt?: string
}

type StateResponse = {
  marks?: Record<string, unknown>
  revision?: number
  mutationBase?: { token?: string }
  updatedAt?: string
}

async function fetchState(creds: Creds): Promise<StateResponse | null> {
  const res = await fetch(`${PROOF_URL}/api/agent/${creds.slug}/state`, {
    headers: { 'x-share-token': creds.token }
  })
  if (!res.ok) return null
  return (await res.json()) as StateResponse
}

export async function fetchMarkState(): Promise<MarkState | null> {
  const creds = await bootstrapDoc()
  const state = await fetchState(creds)
  if (!state) return null
  return {
    marks: state.marks ?? {},
    revision: state.revision,
    mutationBase: state.mutationBase,
    updatedAt: state.updatedAt
  }
}

type MutationBase = { baseToken?: string; baseRevision?: number; baseUpdatedAt?: string }

function deriveBase(state: StateResponse | null): MutationBase {
  if (!state) return {}
  if (state.mutationBase?.token) return { baseToken: state.mutationBase.token }
  if (typeof state.revision === 'number') return { baseRevision: state.revision }
  if (state.updatedAt) return { baseUpdatedAt: state.updatedAt }
  return {}
}

type MutationResult = { success: boolean; status: number; body: unknown }

async function postMutation(
  creds: Creds,
  action: 'accept' | 'reject',
  markId: string,
  by: string,
  base: MutationBase
): Promise<MutationResult> {
  const res = await fetch(`${PROOF_URL}/api/agent/${creds.slug}/marks/${action}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-share-token': creds.token
    },
    body: JSON.stringify({ markId, by, ...base })
  })
  const body = await res.json().catch(() => null)
  return { success: res.ok, status: res.status, body }
}

async function performMutation(
  action: 'accept' | 'reject',
  markId: string,
  by: string
): Promise<MutationResult> {
  const creds = await bootstrapDoc()
  const initialState = await fetchState(creds)
  let base = deriveBase(initialState)

  let result = await postMutation(creds, action, markId, by, base)
  if (result.success) return result

  if (result.status === 409) {
    await new Promise((r) => setTimeout(r, 100))
    const fresh = await fetchState(creds)
    base = deriveBase(fresh)
    result = await postMutation(creds, action, markId, by, base)
  }
  return result
}

export function acceptMark(markId: string, by: string = DEFAULT_ACTOR): Promise<MutationResult> {
  return performMutation('accept', markId, by)
}

export function rejectMark(markId: string, by: string = DEFAULT_ACTOR): Promise<MutationResult> {
  return performMutation('reject', markId, by)
}
