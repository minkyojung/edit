// Audit E3: tall block widgets seed WidgetType.estimatedHeight so the heightmap isn't
// wildly off before first measure (scrollbar length + scrollTo/pos mapping don't jump on
// docs with several cards). Most are constants; the only branch worth pinning is
// MediaWidget's video-vs-audio estimate. (Youtube/Mermaid/PageHeader constants are
// covered by typecheck + the full suite — no behavioural surface to assert headlessly,
// jsdom does no layout.)

import { describe, it, expect } from 'vitest'
import { MediaWidget } from './mediaCards'
import { MermaidWidget } from './mermaidCards'

describe('block widget estimatedHeight (E3)', () => {
  it('MediaWidget estimates a tall video vs a one-row audio bar', () => {
    expect(new MediaWidget('video', 'clip.mp4', '').estimatedHeight).toBe(360)
    expect(new MediaWidget('audio', 'clip.mp3', '').estimatedHeight).toBe(54)
  })
  it('MermaidWidget seeds a positive height', () => {
    expect(new MermaidWidget('graph TD\nA-->B').estimatedHeight).toBeGreaterThan(0)
  })
})
