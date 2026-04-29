import { app, safeStorage, shell } from 'electron'
import { createHash, randomBytes } from 'crypto'
import { writeFile, unlink } from 'fs/promises'
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'

// Claude Code OAuth client. Same client_id used by `claude setup-token`.
// Verified via observed OAuth traffic; not officially documented.
const CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e'
const AUTHORIZE_URL = 'https://claude.ai/oauth/authorize'
const TOKEN_URL = 'https://console.anthropic.com/v1/oauth/token'
const REDIRECT_URI = 'https://console.anthropic.com/oauth/code/callback'
const SCOPES = 'org:create_api_key user:profile user:inference'

const REFRESH_SAFETY_MARGIN_MS = 5 * 60 * 1000

const TOKEN_FILE = (): string => join(app.getPath('userData'), 'anthropic-oauth.bin')

type TokenBundle = {
  accessToken: string
  refreshToken: string | null
  expiresAt: number | null
}

type PendingFlow = { verifier: string }
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

function bundleFromTokenResponse(
  data: {
    access_token?: string
    refresh_token?: string
    expires_in?: number
    error?: string
    error_description?: string
  },
  prev?: TokenBundle | null
): TokenBundle {
  if (data.error) {
    throw new Error(`OAuth error: ${data.error_description ?? data.error}`)
  }
  if (!data.access_token) throw new Error('Token response missing access_token')
  if (!data.access_token.startsWith('sk-ant-oat')) {
    throw new Error('Unexpected access_token format')
  }
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? prev?.refreshToken ?? null,
    expiresAt: typeof data.expires_in === 'number' ? Date.now() + data.expires_in * 1000 : null
  }
}

async function saveBundle(bundle: TokenBundle): Promise<void> {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('Secure storage is unavailable on this system')
  }
  const encrypted = safeStorage.encryptString(JSON.stringify(bundle))
  await writeFile(TOKEN_FILE(), encrypted, { mode: 0o600 })
}

function loadBundle(): TokenBundle | null {
  const path = TOKEN_FILE()
  if (!existsSync(path)) return null
  if (!safeStorage.isEncryptionAvailable()) return null
  try {
    const buf = readFileSync(path)
    const decrypted = safeStorage.decryptString(buf)
    const parsed = JSON.parse(decrypted) as Partial<TokenBundle>
    if (!parsed.accessToken) return null
    return {
      accessToken: parsed.accessToken,
      refreshToken: parsed.refreshToken ?? null,
      expiresAt: parsed.expiresAt ?? null
    }
  } catch (err) {
    console.error('[oauth] failed to read token bundle', err)
    return null
  }
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

  const trimmed = input.trim()
  if (!trimmed) throw new Error('Authorization code is empty')

  const [code, returnedState] = trimmed.includes('#')
    ? trimmed.split('#')
    : [trimmed, pending.verifier]

  if (!code) throw new Error('Authorization code is empty')

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

  const data = (await res.json()) as Parameters<typeof bundleFromTokenResponse>[0]
  const bundle = bundleFromTokenResponse(data)
  await saveBundle(bundle)
  emit('authenticated')
}

async function refreshAccessToken(prev: TokenBundle): Promise<TokenBundle | null> {
  if (!prev.refreshToken) return null

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'refresh_token',
      refresh_token: prev.refreshToken,
      client_id: CLIENT_ID
    })
  })

  if (!res.ok) {
    const body = await res.text()
    console.error('[oauth] refresh failed', res.status, body)
    return null
  }

  const data = (await res.json()) as Parameters<typeof bundleFromTokenResponse>[0]
  const next = bundleFromTokenResponse(data, prev)
  await saveBundle(next)
  return next
}

let inflightRefresh: Promise<TokenBundle | null> | null = null

export async function getValidToken(): Promise<string | null> {
  let bundle = loadBundle()
  if (!bundle) return null

  const needsRefresh =
    bundle.expiresAt !== null && Date.now() > bundle.expiresAt - REFRESH_SAFETY_MARGIN_MS

  if (!needsRefresh) return bundle.accessToken

  // Coalesce concurrent refresh attempts so two simultaneous queries don't
  // race the token endpoint and invalidate each other's refresh tokens.
  if (!inflightRefresh) {
    inflightRefresh = refreshAccessToken(bundle).finally(() => {
      inflightRefresh = null
    })
  }
  bundle = await inflightRefresh

  if (!bundle) {
    await clearToken()
    return null
  }
  return bundle.accessToken
}

export function hasToken(): boolean {
  return loadBundle() !== null
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
