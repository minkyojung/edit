import { describe, expect, it } from 'vitest'
import { extractErrorCode, humanizeError, classifyRunError } from './errorMessage'

describe('extractErrorCode', () => {
  it('pulls the leading ^CODE: classifier', () => {
    expect(extractErrorCode('AUTH: 401 unauthorized')).toBe('AUTH')
    expect(extractErrorCode(new Error('RATE_LIMIT: slow down'))).toBe('RATE_LIMIT')
  })
  it('returns undefined when there is no classifier', () => {
    expect(extractErrorCode('just a message')).toBeUndefined()
    expect(extractErrorCode('rpc error: -32603 boom')).toBeUndefined()
  })
})

describe('humanizeError', () => {
  it('maps every known classifier to friendly copy (no raw CODE: leak)', () => {
    const codes = [
      'SIDECAR_DIED',
      'IDLE_TIMEOUT',
      'NETWORK',
      'AUTH',
      'RATE_LIMIT',
      'SERVER',
      'BILLING',
      'INVALID',
      'TRUNCATED',
      'MAX_TURNS',
      'BUDGET',
      'FORMAT',
      'INTERNAL',
    ]
    for (const code of codes) {
      const out = humanizeError(`${code}: some raw detail`)
      expect(out).not.toMatch(/^[A-Z_]+:/) // never surface the bare classifier
      expect(out).not.toContain('some raw detail') // nor the raw tail
      expect(out.length).toBeGreaterThan(0)
    }
  })

  it('genericizes INTERNAL instead of leaking the raw tail', () => {
    expect(humanizeError('INTERNAL: TypeError: cannot read x of undefined')).toBe(
      'Something went wrong — please try again',
    )
  })

  it('genericizes transport-level rpc errors', () => {
    expect(humanizeError('rpc error: -32603 internal error')).toBe(
      'Something went wrong — please try again',
    )
    expect(humanizeError(new Error('rpc error: -32001 busy'))).toBe(
      'Something went wrong — please try again',
    )
  })

  it('EXEC forwards the SDK detail when present, else a bare line', () => {
    expect(humanizeError('EXEC: disk full')).toBe('Stopped on an error: disk full')
    expect(humanizeError('EXEC:')).toBe('Stopped on an error')
  })

  it('cleans a plain Error message and truncates very long ones', () => {
    expect(humanizeError(new Error('Error: something odd'))).toBe('something odd')
    expect(humanizeError('')).toBe('Something went wrong')
    const long = 'x'.repeat(500)
    const out = humanizeError(long)
    expect(out.length).toBe(238) // 237 + ellipsis
    expect(out.endsWith('…')).toBe(true)
  })
})

describe('classifyRunError', () => {
  it('user-pressed Stop (AbortError, not offline) → muted stopped card', () => {
    const err = new DOMException('aborted', 'AbortError')
    const out = classifyRunError(err, { offlineAborted: false })
    expect(out.terminal).toBe('stopped')
    expect(out.chatStatus).toBe('idle')
    expect(out.errorText).toBeNull()
    expect(out.errorCode).toBeUndefined()
  })

  it('offline mid-stream abort → NETWORK error card', () => {
    const err = new DOMException('aborted', 'AbortError')
    const out = classifyRunError(err, { offlineAborted: true })
    expect(out.terminal).toBe('error')
    expect(out.errorCode).toBe('NETWORK')
    expect(out.errorText).toBe('Lost network connection')
  })

  it('RATE_LIMIT carries resetsAt / rateLimitType / overageDisabledReason', () => {
    const err = Object.assign(new Error('RATE_LIMIT: slow down'), {
      rateLimit: { resetsAt: 123, rateLimitType: 'five_hour', overageDisabledReason: 'out_of_credits' },
      retryable: true,
    })
    const out = classifyRunError(err, { offlineAborted: false })
    expect(out.terminal).toBe('error')
    expect(out.errorCode).toBe('RATE_LIMIT')
    expect(out.resetsAt).toBe(123)
    expect(out.rateLimitType).toBe('five_hour')
    expect(out.overageDisabledReason).toBe('out_of_credits')
    expect(out.retryable).toBe(true)
  })

  it('does not attach rate-limit fields to non-RATE_LIMIT errors', () => {
    const err = Object.assign(new Error('AUTH: 401'), {
      rateLimit: { resetsAt: 999, rateLimitType: 'five_hour' },
    })
    const out = classifyRunError(err, { offlineAborted: false })
    expect(out.errorCode).toBe('AUTH')
    expect(out.resetsAt).toBeUndefined()
    expect(out.rateLimitType).toBeUndefined()
  })
})
