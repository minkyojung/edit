// Loops relay (Cloudflare Worker).
//
// Holds the Loops API key server-side so the desktop app never ships it. The
// app POSTs the signed-in user's Google access token; we verify the token was
// minted for OUR app (audience check), re-derive the Google-verified email (so
// nobody can inject someone else's address), upsert the Loops contact, and
// send the transactional welcome email.
//
// Welcome is TRANSACTIONAL — no marketing consent needed. The contact is created
// with subscribed:false so it never lands on a marketing list until the user
// explicitly opts in later.

interface RateLimit {
  limit(options: { key: string }): Promise<{ success: boolean }>
}

export interface Env {
  LOOPS_API_KEY: string // secret — set with: npx wrangler secret put LOOPS_API_KEY
  LOOPS_WELCOME_ID: string // var — the welcome transactional email id (wrangler.toml)
  GOOGLE_CLIENT_ID: string // secret — the app's OAuth client_id(s); comma-separated for multiple
  IP_LIMITER: RateLimit // native rate-limit binding (wrangler.toml)
  EMAIL_LIMITER: RateLimit // native rate-limit binding (wrangler.toml)
}

const CORS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    if (req.method === 'OPTIONS') return new Response(null, { headers: CORS })
    if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405)

    // Coarse IP guard before we do any upstream work.
    const ip = req.headers.get('cf-connecting-ip') ?? 'unknown'
    if (!(await env.IP_LIMITER.limit({ key: ip })).success) {
      return json({ error: 'rate limited' }, 429)
    }

    let body: { token?: string; name?: string }
    try {
      body = await req.json()
    } catch {
      return json({ error: 'invalid json' }, 400)
    }
    if (!body.token) return json({ error: 'token required' }, 400)

    // Verify the token with Google's tokeninfo. Unlike userinfo, this returns
    // the audience the token was minted for, so we can reject any Google access
    // token that wasn't issued to our own app. It also gives us the email and
    // its verified status, and rejects expired tokens, in one call.
    const info = await fetch(
      `https://oauth2.googleapis.com/tokeninfo?access_token=${encodeURIComponent(body.token)}`,
    )
    if (!info.ok) return json({ error: 'invalid google token' }, 401)
    const tk = (await info.json()) as {
      aud?: string
      azp?: string
      email?: string
      email_verified?: string | boolean
      sub?: string
    }

    // The token MUST have been issued to our own OAuth client, otherwise any
    // Google access token carrying the email scope (from any app) would pass.
    const allowed = env.GOOGLE_CLIENT_ID.split(',').map((s) => s.trim())
    if (!allowed.includes(tk.aud ?? '') && !allowed.includes(tk.azp ?? '')) {
      return json({ error: 'token audience mismatch' }, 401)
    }
    if (!tk.email) return json({ error: 'no email on token' }, 401)
    // Only act on a Google-verified address (tokeninfo returns "true"/"false").
    if (String(tk.email_verified) !== 'true') {
      return json({ error: 'email not verified' }, 401)
    }

    // Per-email guard: bounds welcome sends / contact churn for one address.
    if (!(await env.EMAIL_LIMITER.limit({ key: tk.email })).success) {
      return json({ error: 'rate limited' }, 429)
    }

    const firstName = (body.name || '').trim().split(/\s+/)[0] || ''

    // Upsert the contact. subscribed:false → transactional only; never on a
    // marketing list until the user explicitly opts in.
    const contact = await fetch('https://app.loops.so/api/v1/contacts/update', {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${env.LOOPS_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        email: tk.email,
        userId: tk.sub,
        firstName,
        source: 'desktop-onboarding',
        subscribed: false,
      }),
    })
    if (!contact.ok) {
      return json({ error: 'loops contact failed', detail: await safeText(contact) }, 502)
    }

    // Send the welcome (transactional — bypasses subscription status).
    const email = await fetch('https://app.loops.so/api/v1/transactional', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.LOOPS_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        transactionalId: env.LOOPS_WELCOME_ID,
        email: tk.email,
        dataVariables: { firstName },
      }),
    })
    if (!email.ok) {
      return json({ error: 'loops welcome failed', detail: await safeText(email) }, 502)
    }

    return json({ ok: true }, 200)
  },
}

function json(obj: unknown, status: number): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS },
  })
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text()
  } catch {
    return ''
  }
}
