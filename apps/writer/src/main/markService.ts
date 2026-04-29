import { bootstrapDoc } from './docService'
import { PROOF_URL, withMutationBaseRetry, type MutationBase } from './proofClient'

const ACTOR = 'human:user'

async function callMarkApi(action: 'accept' | 'reject', markId: string): Promise<void> {
  const doc = await bootstrapDoc()
  const submit = (base: MutationBase): Promise<Response> =>
    fetch(`${PROOF_URL}/api/agent/${doc.slug}/marks/${action}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-share-token': doc.token
      },
      body: JSON.stringify({ markId, by: ACTOR, ...base })
    })
  await withMutationBaseRetry(doc.slug, doc.token, submit, `mark ${action}`)
}

export function acceptMark(markId: string): Promise<void> {
  return callMarkApi('accept', markId)
}

export function rejectMark(markId: string): Promise<void> {
  return callMarkApi('reject', markId)
}
