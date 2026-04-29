import { app, safeStorage, shell } from 'electron'
import { createHash, randomBytes } from 'crypto'
import { writeFile, readFile, unlink } from 'fs/promises'
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'

// Claude Code OAuth client. Same client_id used by `claude setup-token`.
// Verified via observed OAuth traffic; not officially documented.
const CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e'
const AUTHORIZE_URL = 'https://claude.ai/oauth/authorize'
const TOKEN_URL = 'https://console.anthropic.com/v1/oauth/token'
const REDIRECT_URI = 'https://console.anthropic.com/oauth/code/callback'
const SCOPES = 'org:create_api_key user:profile user:inference'

const TOKEN_FILE = () => join(app.getPath('userData'), 'anthropic-oauth.bin')

type PendingFlow = {
  verifier: string
}

let pending: PendingFlow | null = null

type AuthListener = (status: 'authenticated' | 'unauthenticated') => void
const listeners = new Set<AuthListener>()

function emit(status: 'authenticated' | 'unauthenticated'): void {
  listeners.forEach((l) => {
    try {
      l(status)
    } catch (err) {
      console.error('[oauth] listener error', err)
    }
  })
}

export function onAuthChange(cb: AuthListener): () => void {
  listeners.add(cb)
  return () => listeners.delete(cb)
}

function base64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function genVerifier(): string {
  return base64url(randomBytes(32))
}

function genChallenge(verifier: string): string {
  return base64url(createHash('sha256').update(verifier).digest())
}

export async function startOAuthFlow(): Promise<void> {
  const verifier = genVerifier()
  pending = { verifier }

  const url = new URL(AUTHORIZE_URL)
  url.searchParams.set('code', 'true')
  url.searchParams.set('client_id', CLIENT_ID)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('redirect_uri', REDIRECT_URI)
  url.searchParams.set('scope', SCOPES)
  url.searchParams.set('code_challenge', genChallenge(verifier))
  url.searchParams.set('code_challenge_method', 'S256')
  url.searchParams.set('state', verifier)

  await shell.openExternal(url.toString())
}

export async function completeOAuthFlow(input: string): Promise<void> {
  if (!pending) throw new Error('No OAuth flow in progress. Click sign-in first.')

  // Anthropic returns the code as `<code>#<state>` in the manual-paste flow.
  const trimmed = input.trim()
  const [code, returnedState] = trimmed.includes('#')
    ? trimmed.split('#')
    : [trimmed, pending.verifier]

  if (returnedState !== pending.verifier) {
    pending = null
    throw new Error('OAuth state mismatch — possible tampering. Try again.')
  }

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'authorization_code',
      code,
      state: pending.verifier,
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT_URI,
      code_verifier: pending.verifier
    })
  })

  pending = null

  if (!res.ok) {
    const body = await res.text()
    throw new Error(`Token exchange failed (${res.status}): ${body}`)
  }

  const data = (await res.json()) as { access_token?: string }
  if (!data.access_token) throw new Error('Token response missing access_token')

  await saveToken(data.access_token)
  emit('authenticated')
}

async function saveToken(token: string): Promise<void> {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('Secure storage is unavailable on this system')
  }
  const encrypted = safeStorage.encryptString(token)
  await writeFile(TOKEN_FILE(), encrypted, { mode: 0o600 })
}

export function getToken(): string | null {
  const path = TOKEN_FILE()
  if (!existsSync(path)) return null
  try {
    if (!safeStorage.isEncryptionAvailable()) return null
    const buf = readFileSync(path)
    return safeStorage.decryptString(buf)
  } catch (err) {
    console.error('[oauth] failed to read token', err)
    return null
  }
}

export function hasToken(): boolean {
  return getToken() !== null
}

export async function clearToken(): Promise<void> {
  const path = TOKEN_FILE()
  if (existsSync(path)) {
    try {
      await unlink(path)
    } catch (err) {
      console.error('[oauth] failed to delete token', err)
    }
  }
  emit('unauthenticated')
}

export async function loadTokenAsync(): Promise<string | null> {
  const path = TOKEN_FILE()
  if (!existsSync(path)) return null
  try {
    if (!safeStorage.isEncryptionAvailable()) return null
    const buf = await readFile(path)
    return safeStorage.decryptString(buf)
  } catch (err) {
    console.error('[oauth] failed to read token', err)
    return null
  }
}
