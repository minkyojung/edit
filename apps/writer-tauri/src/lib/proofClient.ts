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

export const proofClient = {
  // Uses the agent path (/documents without /api prefix) which skips client version headers
  async createDoc(title: string, markdown = '# ' + title + '\n\n'): Promise<{ slug: string }> {
    return request('/documents', {
      method: 'POST',
      body: JSON.stringify({ title, markdown }),
    })
  },
  async getCollabSession(slug: string): Promise<{ session: CollabSession }> {
    return request(`/documents/${slug}/collab-session`)
  },
}
