import { afterEach, describe, expect, it, vi } from 'vitest'
import { appNavigate, setAppNavigate } from './appNavigate'

afterEach(() => setAppNavigate(null))

describe('appNavigate', () => {
  it('routes through the bridged router navigate when set', () => {
    const nav = vi.fn()
    setAppNavigate(nav)
    appNavigate('/day/2026-01-01/abc', { replace: true })
    expect(nav).toHaveBeenCalledWith('/day/2026-01-01/abc', { replace: true })
  })

  it('falls back to window.location.hash before the bridge is wired', () => {
    setAppNavigate(null)
    appNavigate('/week/xyz')
    expect(window.location.hash).toBe('#/week/xyz')
  })
})
