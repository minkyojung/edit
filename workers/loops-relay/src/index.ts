// Loops relay (Cloudflare Worker).
//
// Holds the Loops API key server-side so the desktop app never ships it. The
// app POSTs the signed-in user's Google access token; we re-derive the verified
// email from Google (so nobody can inject someone else's address), upsert the
// Loops contact, and send the transactional welcome email.
//
// Welcome is TRANSACTIONAL — no marketing consent needed. The contact is created
// with subscribed:false so it never lands on a marketing list until the user
// explicitly opts in later.

export interface Env {
  LOOPS_API_KEY: string // secret — set with: npx wrangler secret put LOOPS_API_KEY
  LOOPS_WELCOME_ID: string // var — the welcome transactional email id (wrangler.toml)
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

    let body: { token?: string; name?: string }
    try {
      body = await req.json()
    } catch {
      return json({ error: 'invalid json' }, 400)
    }
    if (!body.token) return json({ error: 'token required' }, 400)

    // Verify the request by asking Google whose token this is. This both
    // authenticates the caller and gives us a trustworthy email — nobody can
    // register an address they don't actually control.
    const info = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
      headers: { Authorization: `Bearer ${body.token}` },
    })
    if (!info.ok) return json({ error: 'invalid google token' }, 401)
    const profile = (await info.json()) as {
      email?: string
      email_verified?: boolean
      sub?: string
      name?: string
    }
    if (!profile.email) return json({ error: 'no email on token' }, 401)

    const firstName = (body.name || profile.name || '').trim().split(/\s+/)[0] || ''

    // Upsert the contact. subscribed:false → transactional only; never on a
    // marketing list until the user explicitly opts in.
    const contact = await fetch('https://app.loops.so/api/v1/contacts/update', {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${env.LOOPS_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        email: profile.email,
        userId: profile.sub,
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
        email: profile.email,
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
