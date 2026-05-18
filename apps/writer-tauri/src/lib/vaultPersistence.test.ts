/**
 * Vault persistence — Y.Doc binary round-trip contract.
 *
 * Pins the core invariant of Path C Stage 1+2: the `.ydoc` sidecar
 * round-trips a Y.Doc through `Y.encodeStateAsUpdate` →
 * `Y.applyUpdate` without losing body, marks, or their relative
 * positions. The runtime flushes/loads exercise the same Yjs API
 * surface tested here, so a failure in any of these specs is a
 * direct signal that the vault layer's data persistence is broken.
 *
 * Scope: pure Yjs behavior + the shape contract we depend on. No
 * Tauri fs, no docsStore, no EditorView — those are integration
 * concerns the runtime covers end-to-end (commit-time manual check).
 * Here we lock in only what Y.encodeStateAsUpdate / Y.applyUpdate
 * guarantee, so a future yjs upgrade or our own misuse surfaces in
 * CI rather than as silent mark loss.
 */

import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import type { Mark } from '@/domain/marks'

/** Build a fixture Mark. Defaults to a pending replace suggestion;
 * overrides cover specific fields under test. The shape mirrors
 * what markStore.add writes into Y.Map at runtime. */
function fixtureMark(overrides: Partial<Mark> = {}): Mark {
  return {
    id: overrides.id ?? 'mark-1',
    kind: 'suggestion',
    suggestionType: 'replace',
    quote: 'hello',
    startRel: overrides.startRel ?? 'AQ==',
    endRel: overrides.endRel ?? 'Ag==',
    content: 'goodbye',
    status: 'pending',
    by: 'ai:test',
    createdAt: '2026-05-18T15:00:00Z',
    ...overrides,
  }
}

/** Encode `src` to a binary update, apply it to a fresh Y.Doc, and
 * return that destination doc. Mirrors flushDirty's encode side and
 * applyVaultBodyToYDoc's apply side without touching disk. */
function roundtrip(src: Y.Doc): Y.Doc {
  const update = Y.encodeStateAsUpdate(src)
  const dst = new Y.Doc()
  Y.applyUpdate(dst, update, 'doc-init')
  return dst
}

describe('vault persistence — Y.Map<Mark> round-trip', () => {
  it('preserves a single mark entry', () => {
    const src = new Y.Doc()
    const mark = fixtureMark()
    src.getMap<Mark>('marks').set(mark.id, mark)

    const dst = roundtrip(src)

    const restored = dst.getMap<Mark>('marks').get(mark.id)
    expect(restored).toEqual(mark)
  })

  it('preserves multiple marks with distinct ids', () => {
    const src = new Y.Doc()
    const marks: Mark[] = [
      fixtureMark({ id: 'm1', quote: 'foo' }),
      fixtureMark({ id: 'm2', quote: 'bar', suggestionType: 'insert', content: 'baz' }),
      fixtureMark({
        id: 'm3',
        kind: 'comment',
        suggestionType: undefined,
        content: undefined,
        text: 'hello world',
      } as Partial<Mark> as Mark),
    ]
    for (const m of marks) src.getMap<Mark>('marks').set(m.id, m)

    const dst = roundtrip(src)
    const restoredMap = dst.getMap<Mark>('marks')

    expect(restoredMap.size).toBe(3)
    for (const m of marks) {
      expect(restoredMap.get(m.id)).toEqual(m)
    }
  })

  it('preserves the RelativePosition anchor strings verbatim', () => {
    // The startRel / endRel fields ARE the anchor — runtime depends
    // on these surviving the binary trip intact so markStore.restore
    // can decode them against the rehydrated Y.Doc on next session.
    const src = new Y.Doc()
    const mark = fixtureMark({
      startRel: 'eyJjbGllbnQiOjEyMzQ1Njc4OSwiY2xvY2siOjQyfQ==',
      endRel: 'eyJjbGllbnQiOjEyMzQ1Njc4OSwiY2xvY2siOjQ4fQ==',
    })
    src.getMap<Mark>('marks').set(mark.id, mark)

    const dst = roundtrip(src)
    const restored = dst.getMap<Mark>('marks').get(mark.id)

    expect(restored?.startRel).toBe(mark.startRel)
    expect(restored?.endRel).toBe(mark.endRel)
  })

  it('preserves an empty marks map', () => {
    // Empty doc must still round-trip — flushDirty fires on
    // first-mount even before the user adds any marks.
    const src = new Y.Doc()
    src.getMap<Mark>('marks') // touch to ensure the type registers

    const dst = roundtrip(src)
    expect(dst.getMap<Mark>('marks').size).toBe(0)
  })
})

describe('vault persistence — XmlFragment body round-trip', () => {
  it('preserves XmlText content inside the prosemirror fragment', () => {
    const src = new Y.Doc()
    const frag = src.getXmlFragment('prosemirror')
    const paragraph = new Y.XmlElement('paragraph')
    paragraph.push([new Y.XmlText('Hello world')])
    frag.push([paragraph])

    const dst = roundtrip(src)
    const restoredFrag = dst.getXmlFragment('prosemirror')

    expect(restoredFrag.length).toBe(1)
    const restoredParagraph = restoredFrag.get(0) as Y.XmlElement
    expect(restoredParagraph.nodeName).toBe('paragraph')
    const text = restoredParagraph.get(0) as Y.XmlText
    expect(text.toString()).toBe('Hello world')
  })

  it('preserves multiple paragraphs in order', () => {
    const src = new Y.Doc()
    const frag = src.getXmlFragment('prosemirror')
    for (const line of ['First', 'Second', 'Third']) {
      const p = new Y.XmlElement('paragraph')
      p.push([new Y.XmlText(line)])
      frag.push([p])
    }

    const dst = roundtrip(src)
    const restoredFrag = dst.getXmlFragment('prosemirror')

    expect(restoredFrag.length).toBe(3)
    const lines = restoredFrag.toArray().map((p) => {
      const text = (p as Y.XmlElement).get(0) as Y.XmlText
      return text.toString()
    })
    expect(lines).toEqual(['First', 'Second', 'Third'])
  })
})

describe('vault persistence — RelativePosition follows text edits', () => {
  // The reason `.ydoc` beats text-search anchoring: the
  // RelativePosition shifts with body mutations rather than
  // orphaning the mark when the surrounding text changes. This
  // mirrors the AI-rewrites-the-body scenario that text-search
  // couldn't handle.

  it('a relative position points to the same logical char after a prefix insert', () => {
    const src = new Y.Doc()
    const text = src.getText('content')
    text.insert(0, 'world')
    // Mark anchored at the start of 'world' (offset 0).
    const rel = Y.createRelativePositionFromTypeIndex(text, 0)

    // Simulate the AI prepending "Hello " — the absolute offset of
    // 'world' shifts to 6, but the relative anchor should follow.
    text.insert(0, 'Hello ')

    const resolved = Y.createAbsolutePositionFromRelativePosition(rel, src)
    expect(resolved?.index).toBe(6)
    expect(text.toString().slice(resolved!.index)).toBe('world')
  })

  it('survives a binary round-trip while still tracking the right char', () => {
    // End-to-end check: encode after the edit, apply to a fresh doc,
    // resolve the relative position there. The mark should still
    // point to the same logical character even after persistence +
    // restore in a different Y.Doc instance.
    const src = new Y.Doc()
    const text = src.getText('content')
    text.insert(0, 'world')
    const rel = Y.createRelativePositionFromTypeIndex(text, 0)
    text.insert(0, 'Hello ')

    const update = Y.encodeStateAsUpdate(src)
    const dst = new Y.Doc()
    Y.applyUpdate(dst, update, 'doc-init')

    const restoredText = dst.getText('content')
    const resolved = Y.createAbsolutePositionFromRelativePosition(rel, dst)
    expect(resolved?.index).toBe(6)
    expect(restoredText.toString().slice(resolved!.index)).toBe('world')
  })
})

describe('vault persistence — body + marks together', () => {
  it('round-trips a fragment with marks in Y.Map atomically', () => {
    // The flushDirty path serializes the entire Y.Doc in one
    // `encodeStateAsUpdate` call — body and marks land in the same
    // binary blob. Restoring puts both back in lock-step, the
    // invariant that lets us drop the separate `.marks.json` write.
    const src = new Y.Doc()
    const frag = src.getXmlFragment('prosemirror')
    const p = new Y.XmlElement('paragraph')
    p.push([new Y.XmlText('A line of writing')])
    frag.push([p])

    const mark = fixtureMark({ id: 'm-co', quote: 'writing' })
    src.getMap<Mark>('marks').set(mark.id, mark)

    const dst = roundtrip(src)

    expect(dst.getXmlFragment('prosemirror').length).toBe(1)
    expect(dst.getMap<Mark>('marks').size).toBe(1)
    expect(dst.getMap<Mark>('marks').get(mark.id)).toEqual(mark)
  })
})
