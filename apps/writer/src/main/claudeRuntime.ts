import { query } from '@anthropic-ai/claude-agent-sdk'
import { getToken } from './oauthService'

export class NotAuthenticatedError extends Error {
  constructor() {
    super('No Anthropic OAuth token. User must sign in.')
    this.name = 'NotAuthenticatedError'
  }
}

type QueryArgs = Parameters<typeof query>[0]

export function authedQuery(args: QueryArgs): ReturnType<typeof query> {
  const token = getToken()
  if (!token) throw new NotAuthenticatedError()

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
