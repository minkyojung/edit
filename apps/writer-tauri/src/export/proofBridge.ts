/**
 * Tiny helper for hitting proof-server's `/documents/:slug/bridge/*` routes.
 *
 * The bridge prefix is gated by `enforceBridgeClientCompatibility`
 * (proof-sdk/server/client-capabilities.ts), which rejects any request
 * that doesn't carry these three headers with HTTP 426:
 *   - x-proof-client-version  (semver, ≥ 0.30.0 at time of writing)
 *   - x-proof-client-build    (any non-empty string)
 *   - x-proof-client-protocol (must be "3")
 *
 * The rest of the app reads marks straight off the local Y.Map and so
 * never trips this gate. Export is the first surface that needs marks
 * for *closed* pages too (exportAll iterates the wiki catalog without
 * opening every doc), which is what the bridge surface is for. Keeping
 * the headers in one place means a future protocol bump touches one
 * file instead of every fetch call site.
 *
 * The version we send is the *minimum proof-server accepts*, not the
 * writer-tauri package version — writer-tauri sits at 0.1.0, well
 * below proof-server's 0.30.0 floor, so claiming the floor is the
 * accurate description of the contract our requests actually
 * implement.
 */

const PROOF_BASE_URL = 'http://localhost:4000'

const BRIDGE_HEADERS: Record<string, string> = {
  'x-proof-client-version': '0.30.0',
  'x-proof-client-build': 'writer-tauri',
  'x-proof-client-protocol': '3',
}

export async function bridgeFetch(slug: string, subPath: string): Promise<Response> {
  return fetch(
    `${PROOF_BASE_URL}/documents/${encodeURIComponent(slug)}/bridge${subPath}`,
    { headers: BRIDGE_HEADERS },
  )
}
