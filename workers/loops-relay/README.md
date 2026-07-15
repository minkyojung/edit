# loops-relay

A tiny Cloudflare Worker that relays onboarding sign-ups to [Loops](https://loops.so)
so the desktop app never has to ship the Loops API key.

Flow: the app POSTs the signed-in user's **Google access token** → the Worker
verifies it with Google (getting a trustworthy email), upserts the Loops contact
(`subscribed:false`), and sends the **transactional welcome** email.

Welcome is transactional, so no marketing consent is needed yet. Marketing
consent must be collected separately before adding anyone to a marketing list.

## Deploy

```bash
cd workers/loops-relay
npm install

# 1. Set the welcome email id in wrangler.toml (LOOPS_WELCOME_ID) — get it from
#    Loops → Transactional → your welcome email → transactionalId.

# 2. Log in to Cloudflare (opens a browser).
npx wrangler login

# 3. Store the Loops API key as an encrypted secret (never in code).
npx wrangler secret put LOOPS_API_KEY   # paste the key from Loops → Settings → API

# 4. Deploy → prints the Worker URL (https://loops-relay.<subdomain>.workers.dev).
npx wrangler deploy
```

## Request

```
POST /
{ "token": "<google access token>", "name": "Optional Display Name" }
```

Returns `{ "ok": true }` on success. Errors are 4xx/5xx with a JSON `error`.

## Smoke test

```bash
curl -sS -X POST https://loops-relay.<subdomain>.workers.dev \
  -H 'Content-Type: application/json' \
  -d '{"token":"invalid"}'
# → 401 {"error":"invalid google token"}  (confirms the Worker is live)
```

A real end-to-end test happens once the app is wired to POST the token after
Google sign-in.
