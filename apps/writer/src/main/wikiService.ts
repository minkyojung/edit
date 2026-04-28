import { app } from 'electron'
import { join } from 'path'
import { readFile, writeFile, mkdir } from 'fs/promises'

const PROOF_URL = 'http://localhost:4000'
const INITIAL_BELIEF_TEMPLATE = `# 사용자 글쓰기 스타일

이 페이지는 사용자의 글쓰기 취향과 스타일을 정리한다.
교열 에이전트는 제안을 만들기 전 이 페이지를 참고한다.

## 문체

- (직접 채워주세요)

## 어휘

- (직접 채워주세요)

## 피하는 표현

- (직접 채워주세요)
`

type WikiCreds = {
  slug: string
  token: string
}

let cached: WikiCreds | null = null

function credsPath(): string {
  return join(app.getPath('userData'), 'wiki.json')
}

async function loadCreds(): Promise<WikiCreds | null> {
  try {
    const raw = await readFile(credsPath(), 'utf8')
    return JSON.parse(raw) as WikiCreds
  } catch {
    return null
  }
}

async function saveCreds(creds: WikiCreds): Promise<void> {
  await mkdir(app.getPath('userData'), { recursive: true })
  await writeFile(credsPath(), JSON.stringify(creds, null, 2), 'utf8')
}

async function waitForServer(timeoutMs = 15000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${PROOF_URL}/health`)
      if (res.ok) return
    } catch {
      // server not up yet
    }
    await new Promise((r) => setTimeout(r, 300))
  }
  throw new Error('proof-sdk server did not become ready')
}

async function isAlive(creds: WikiCreds): Promise<boolean> {
  try {
    const res = await fetch(`${PROOF_URL}/documents/${creds.slug}/state`, {
      headers: { 'x-share-token': creds.token }
    })
    return res.ok
  } catch {
    return false
  }
}

async function createBeliefDoc(): Promise<WikiCreds> {
  const res = await fetch(`${PROOF_URL}/documents`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      markdown: INITIAL_BELIEF_TEMPLATE,
      title: 'belief',
      role: 'editor',
      ownerId: 'human:user'
    })
  })
  if (!res.ok) throw new Error(`failed to create belief doc: ${res.status}`)
  const data = (await res.json()) as { slug: string; accessToken: string }
  return { slug: data.slug, token: data.accessToken }
}

export async function bootstrapWiki(): Promise<WikiCreds> {
  if (cached) return cached

  await waitForServer()

  const existing = await loadCreds()
  if (existing && (await isAlive(existing))) {
    console.log('[wiki] reusing existing doc', existing.slug)
    cached = existing
    return existing
  }

  console.log('[wiki] creating new belief doc')
  const fresh = await createBeliefDoc()
  await saveCreds(fresh)
  console.log('[wiki] created', fresh.slug)
  cached = fresh
  return fresh
}

export async function readBelief(): Promise<string> {
  const creds = await bootstrapWiki()
  const res = await fetch(`${PROOF_URL}/documents/${creds.slug}/state`, {
    headers: { 'x-share-token': creds.token }
  })
  if (!res.ok) throw new Error(`failed to read belief: ${res.status}`)
  const data = (await res.json()) as { markdown: string }
  return data.markdown
}

export async function writeBelief(markdown: string): Promise<void> {
  const creds = await bootstrapWiki()
  const res = await fetch(`${PROOF_URL}/documents/${creds.slug}`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      'x-share-token': creds.token
    },
    body: JSON.stringify({ markdown })
  })
  if (!res.ok) throw new Error(`failed to write belief: ${res.status}`)
}
