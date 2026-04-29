import { query } from '@anthropic-ai/claude-agent-sdk'
import { getValidToken } from './oauthService'

export class NotAuthenticatedError extends Error {
  constructor() {
    super('No Anthropic OAuth token. User must sign in.')
    this.name = 'NotAuthenticatedError'
  }
}

type QueryArgs = Parameters<typeof query>[0]

export async function authedQuery(args: QueryArgs): Promise<ReturnType<typeof query>> {
  const token = await getValidToken()
  if (!token) throw new NotAuthenticatedError()

  // The Claude Agent SDK reads this exact env var for OAuth-based auth. Do not rename.
  process.env.CLAUDE_CODE_OAUTH_TOKEN = token

  // Make sure the SDK doesn't fall back to a stronger-priority credential
  // belonging to a different account on the user's machine.
  delete process.env.ANTHROPIC_API_KEY
  delete process.env.ANTHROPIC_AUTH_TOKEN

  return query(args)
}

export function isAuthError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err)
  return /401|unauthorized|invalid[_ ]?token|authentication/i.test(msg)
}
