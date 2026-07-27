// Pins the copy each notice renders. These rows are the only place some
// mid-turn events become visible, so the wording is the feature — a label that
// silently loses a model name reads as an unrelated system message.

import { afterEach, describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { NoticeRow } from './NoticeRow'
import { _resetModelFacts, setModelFacts } from '@/chat/modelFacts'
import type { NoticePart } from '@/chat/types'

const text = (part: NoticePart) =>
  renderToStaticMarkup(<NoticeRow part={part} />).replace(/<[^>]*>/g, '')

const base = { id: 'n', ts: 0, type: 'notice' } as const

const substituted: NoticePart = {
  ...base,
  kind: 'model-unavailable',
  requestedModel: 'claude-opus-4-1-20250805',
  fallbackModel: 'claude-opus-4-8',
}

afterEach(() => _resetModelFacts())

describe('model-unavailable', () => {
  it('names the model the user picked AND the one that answered', () => {
    // What the running app sees: the catalog supplies the display name for a
    // model the built-in table doesn't carry.
    setModelFacts([{ id: 'claude-opus-4-1-20250805', displayName: 'Claude Opus 4.1' }])
    expect(text(substituted)).toContain('Opus 4.1 is unavailable — answered with Opus 4.8')
  })

  // Before the catalog lands (cold start, offline) there's no display name, and
  // the raw id would otherwise leak its release-date suffix into the sentence.
  it('stays readable with no catalog loaded', () => {
    expect(text(substituted)).toContain('opus-4-1 is unavailable — answered with Opus 4.8')
  })

  it('degrades without crashing when the ids are missing', () => {
    const out = text({ ...base, kind: 'model-unavailable' })
    expect(out).toContain('That model is unavailable')
    expect(out).toContain('another model')
  })
})

describe('the neighbouring kinds still read distinctly', () => {
  it('model-fallback stays about a safety refusal', () => {
    const out = text({ ...base, kind: 'model-fallback', fallbackModel: 'claude-opus-4-8' })
    expect(out).toContain('safety refusal')
    // The two kinds must not collapse into the same sentence — that's why
    // model-unavailable exists as its own kind.
    expect(out).not.toContain('unavailable')
  })

  it('permission-denied names the blocked tool', () => {
    expect(
      text({ ...base, kind: 'permission-denied', toolName: 'Read', reason: 'deny rule' }),
    ).toContain('Blocked: Read — deny rule')
  })
})
