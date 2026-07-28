// The save path PULLS the body from the live CM editor at flush time (CM state is the
// source of truth) instead of the editor mirroring it on every keystroke. Pin that
// bridge: pullActiveCmBody reads the registered getBody() ON EACH CALL (not a stale
// snapshot), is scoped to the active slug, and goes null once the editor unregisters
// (then the flush uses the cache the unmount checkpoint refreshed).

import { describe, expect, it, vi } from 'vitest'
import {
  registerCmEditor,
  unregisterCmEditor,
  pullActiveCmBody,
  applyMarkdownToActiveCmEditor,
  rejectActiveCmChange,
  isChangeMaterializedInActiveCm,
  requestScrollToChange,
  type CmEditorBridge,
} from './activeCmEditor'

const noop = () => {}
const notMaterialized = () => false

// A fully-spied bridge so each test can assert the registry routed to the RIGHT
// callback (the B3 object refactor must not drop or cross-wire any of the six).
function spyBridge(slug: string, over: Partial<CmEditorBridge> = {}): CmEditorBridge {
  return {
    slug,
    setBody: vi.fn(),
    rejectChange: vi.fn(),
    scrollToChange: vi.fn(),
    isMaterialized: vi.fn(() => false),
    getBody: () => '',
    ...over,
  }
}

const nextFrame = () => new Promise<void>((r) => requestAnimationFrame(() => r()))

describe('pullActiveCmBody', () => {
  it('returns null when no editor is registered', () => {
    expect(pullActiveCmBody('a')).toBeNull()
  })

  it('returns getBody() for the registered slug, null for any other', () => {
    registerCmEditor({
      slug: 'a',
      setBody: noop,
      rejectChange: noop,
      scrollToChange: noop,
      isMaterialized: notMaterialized,
      getBody: () => 'BODY-A',
    })
    expect(pullActiveCmBody('a')).toBe('BODY-A')
    expect(pullActiveCmBody('other')).toBeNull()
    unregisterCmEditor('a')
    expect(pullActiveCmBody('a')).toBeNull()
  })

  it('reads getBody() live on every call (not a cached snapshot)', () => {
    let body = 'v1'
    registerCmEditor({
      slug: 'a',
      setBody: noop,
      rejectChange: noop,
      scrollToChange: noop,
      isMaterialized: notMaterialized,
      getBody: () => body,
    })
    expect(pullActiveCmBody('a')).toBe('v1')
    body = 'v2' // a later keystroke would change what the live editor returns
    expect(pullActiveCmBody('a')).toBe('v2')
    unregisterCmEditor('a')
  })
})

// Prove the other five bridge callbacks are wired through the CmEditorBridge object and
// stay slug-scoped — i.e. the B3 positional→object change didn't drop or cross-wire one.
describe('capability functions route to the bridge', () => {
  it('applyMarkdownToActiveCmEditor → setBody(md, changeId), true only for the active slug', () => {
    const b = spyBridge('a')
    registerCmEditor(b)
    expect(applyMarkdownToActiveCmEditor('a', 'NEW', 'c1')).toBe(true)
    expect(b.setBody).toHaveBeenCalledWith('NEW', 'c1')
    // Wrong slug: no call, returns false.
    expect(applyMarkdownToActiveCmEditor('other', 'X')).toBe(false)
    expect(b.setBody).toHaveBeenCalledTimes(1)
    unregisterCmEditor('a')
    expect(applyMarkdownToActiveCmEditor('a', 'Y')).toBe(false) // none registered
  })

  it('rejectActiveCmChange → rejectChange(changeId), slug-scoped', () => {
    const b = spyBridge('a')
    registerCmEditor(b)
    expect(rejectActiveCmChange('a', 'c9')).toBe(true)
    expect(b.rejectChange).toHaveBeenCalledWith('c9')
    expect(rejectActiveCmChange('other', 'c9')).toBe(false)
    expect(b.rejectChange).toHaveBeenCalledTimes(1)
    unregisterCmEditor('a')
  })

  it('isChangeMaterializedInActiveCm → isMaterialized(changeId) for the active slug, false otherwise', () => {
    const b = spyBridge('a', { isMaterialized: vi.fn(() => true) })
    registerCmEditor(b)
    expect(isChangeMaterializedInActiveCm('a', 'c1')).toBe(true)
    expect(b.isMaterialized).toHaveBeenCalledWith('c1')
    expect(isChangeMaterializedInActiveCm('other', 'c1')).toBe(false) // not the active slug
    unregisterCmEditor('a')
    expect(isChangeMaterializedInActiveCm('a', 'c1')).toBe(false) // none registered
  })

  it('requestScrollToChange scrolls immediately when the target editor is already active', () => {
    const b = spyBridge('a')
    registerCmEditor(b)
    requestScrollToChange('a', 'c5')
    expect(b.scrollToChange).toHaveBeenCalledWith('c5')
    unregisterCmEditor('a')
  })
})

// The cross-note jump: the scroll request arrives BEFORE its editor mounts (same click
// navigates to another note). The next matching register consumes it, deferred a frame.
describe('pendingScroll consumption on register', () => {
  it('a parked scroll fires once when its editor registers (deferred a frame)', async () => {
    // No editor active → the request parks.
    requestScrollToChange('later', 'c7')
    const b = spyBridge('later')
    registerCmEditor(b)
    expect(b.scrollToChange).not.toHaveBeenCalled() // deferred to the next frame
    await nextFrame()
    expect(b.scrollToChange).toHaveBeenCalledWith('c7')
    expect(b.scrollToChange).toHaveBeenCalledTimes(1)
    unregisterCmEditor('later')
  })

  it('a register for a DIFFERENT slug does not consume the parked scroll', async () => {
    requestScrollToChange('wanted', 'c8')
    const other = spyBridge('elsewhere')
    registerCmEditor(other)
    await nextFrame()
    expect(other.scrollToChange).not.toHaveBeenCalled()
    // The right editor still consumes it when it finally mounts.
    const wanted = spyBridge('wanted')
    registerCmEditor(wanted)
    await nextFrame()
    expect(wanted.scrollToChange).toHaveBeenCalledWith('c8')
    unregisterCmEditor('wanted')
  })

  it('a parked scroll EXPIRES — a much later mount is not hijacked', async () => {
    const now = Date.now()
    const spy = vi.spyOn(Date, 'now')
    spy.mockReturnValue(now)
    requestScrollToChange('stale', 'c9') // parked "now"
    spy.mockReturnValue(now + 60_000) // …the navigation never happened; a minute passes
    const late = spyBridge('stale')
    registerCmEditor(late)
    await nextFrame()
    expect(late.scrollToChange).not.toHaveBeenCalled() // no surprise jump
    unregisterCmEditor('stale')
    spy.mockRestore()
  })
})
