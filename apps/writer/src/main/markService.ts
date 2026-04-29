import { bootstrapDoc } from './docService'

const PROOF_URL = 'http://localhost:4000'

export type MarkState = {
  marks: Record<string, unknown>
  revision?: number
}

export async function fetchMarkState(): Promise<MarkState | null> {
  const creds = await bootstrapDoc()
  const res = await fetch(`${PROOF_URL}/api/agent/${creds.slug}/state`, {
    headers: { 'x-share-token': creds.token }
  })
  if (!res.ok) return null
  const data = (await res.json()) as { marks?: Record<string, unknown>; revision?: number }
  return { marks: data.marks ?? {}, revision: data.revision }
}
