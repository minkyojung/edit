// Serialization normaliser: drop trailing empty paragraphs before the
// live doc becomes disk-bound markdown.
//
// Why this exists:
//   ProseMirror's `doc` schema is `block+`, so a note can never be truly
//   empty — Milkdown auto-fills one empty paragraph, and the editor also
//   keeps an empty trailing paragraph as the "type here next" landing
//   spot. Milkdown's serializer writes that trailing empty paragraph to
//   disk as a stray blank line, so adding a single line of text yields
//   `text\n \n`-style noise. Worse, because every open re-serializes and
//   re-writes (see docFileSync flush), that noise made a viewed-but-
//   unedited note show up as a phantom change in the review panel.
//
//   Trimming the trailing empty paragraph(s) at the single disk-bound
//   serialize choke point (dirtyTrackerPlugin) makes the round-trip
//   idempotent for that case: `text` serializes to `text`, not `text\n `.
//
// Safety:
//   - Never trims below one block (the schema minimum), so a genuinely
//     empty note keeps its single empty paragraph — that's the
//     placeholder state, which serializes to an empty body.
//   - Only removes `paragraph` nodes with no content. A trailing heading,
//     list, blockquote, or code block is real content and stays.
//   - Pure: returns the same node reference when there's nothing to trim.

import { Fragment, type Node as PMNode } from '@milkdown/kit/prose/model'

/** Return a copy of `doc` with trailing empty paragraphs removed, or the
 * same reference when the last block isn't an empty paragraph. Keeps at
 * least one child so the result still satisfies the `block+` schema. */
export function stripTrailingEmptyParagraphs(doc: PMNode): PMNode {
  const children: PMNode[] = []
  doc.forEach((child) => children.push(child))

  let end = children.length
  while (end > 1) {
    const last = children[end - 1]
    if (last.type.name === 'paragraph' && last.content.size === 0) {
      end -= 1
    } else {
      break
    }
  }

  if (end === children.length) return doc
  return doc.copy(Fragment.fromArray(children.slice(0, end)))
}
