import { bootstrapDoc } from './docService'

const PROOF_URL = 'http://localhost:4000'

async function callMarkApi(action: 'accept' | 'reject', markId: string): Promise<void> {
  const doc = await bootstrapDoc()
  const res = await fetch(`${PROOF_URL}/api/agent/${doc.slug}/marks/${action}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-share-token': doc.token
    },
    body: JSON.stringify({ markId })
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`mark ${action} failed: ${res.status} ${text}`)
  }
}

export function acceptMark(markId: string): Promise<void> {
  return callMarkApi('accept', markId)
}

export function rejectMark(markId: string): Promise<void> {
  return callMarkApi('reject', markId)
}
