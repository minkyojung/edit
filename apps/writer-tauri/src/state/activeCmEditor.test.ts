// The save path PULLS the body from the live CM editor at flush time (CM state is the
// source of truth) instead of the editor mirroring it on every keystroke. Pin that
// bridge: pullActiveCmBody reads the registered getBody() ON EACH CALL (not a stale
// snapshot), is scoped to the active slug, and goes null once the editor unregisters
// (then the flush uses the cache the unmount checkpoint refreshed).

import { describe, expect, it } from 'vitest'
import { registerCmEditor, unregisterCmEditor, pullActiveCmBody } from './activeCmEditor'

const noop = () => {}
const notMaterialized = () => false

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
