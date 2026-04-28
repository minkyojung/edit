import { app } from 'electron'
import { join } from 'path'
import { readFile, writeFile, mkdir } from 'fs/promises'
import { waitForServer } from './wikiService'

const PROOF_URL = 'http://localhost:4000'

type DocCreds = {
  slug: string
  token: string
}

type CollabSession = {
  collabWsUrl: string
  token: string
  slug: string
}

let bootstrapPromise: Promise<DocCreds> | null = null

function credsPath(): string {
  return join(app.getPath('userData'), 'doc.json')
}

async function loadCreds(): Promise<DocCreds | null> {
  try {
    const raw = await readFile(credsPath(), 'utf8')
    return JSON.parse(raw) as DocCreds
  } catch {
    return null
  }
}

async function saveCreds(creds: DocCreds): Promise<void> {
  await mkdir(app.getPath('userData'), { recursive: true })
  await writeFile(credsPath(), JSON.stringify(creds, null, 2), 'utf8')
}

async function isAlive(creds: DocCreds): Promise<boolean> {
  try {
    const res = await fetch(`${PROOF_URL}/documents/${creds.slug}/state`, {
      headers: { 'x-share-token': creds.token }
    })
    return res.ok
  } catch {
    return false
  }
}

async function createDoc(): Promise<DocCreds> {
  const res = await fetch(`${PROOF_URL}/documents`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      markdown: '# \n',
      title: 'writing',
      role: 'editor',
      ownerId: 'human:user'
    })
  })
  if (!res.ok) throw new Error(`failed to create doc: ${res.status}`)
  const data = (await res.json()) as { slug: string; accessToken: string }
  return { slug: data.slug, token: data.accessToken }
}

async function doBootstrap(): Promise<DocCreds> {
  await waitForServer()

  const existing = await loadCreds()
  if (existing && (await isAlive(existing))) {
    console.log('[doc] reusing existing doc', existing.slug)
    return existing
  }

  console.log('[doc] creating new writing doc')
  const fresh = await createDoc()
  await saveCreds(fresh)
  console.log('[doc] created', fresh.slug)
  return fresh
}

export function bootstrapDoc(): Promise<DocCreds> {
  if (!bootstrapPromise) {
    bootstrapPromise = doBootstrap().catch((err) => {
      bootstrapPromise = null
      throw err
    })
  }
  return bootstrapPromise
}

export async function getCollabSession(): Promise<CollabSession> {
  const creds = await bootstrapDoc()
  const res = await fetch(`${PROOF_URL}/documents/${creds.slug}/collab-session`, {
    headers: { 'x-share-token': creds.token }
  })
  if (!res.ok) throw new Error(`failed to get collab session: ${res.status}`)
  const data = (await res.json()) as { session: { collabWsUrl: string; token: string } }
  return {
    collabWsUrl: data.session.collabWsUrl,
    token: data.session.token,
    slug: creds.slug
  }
}
