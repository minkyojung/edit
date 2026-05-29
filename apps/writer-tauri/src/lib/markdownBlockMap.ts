// Map "markdown line N" → "PM doc range of the deepest block containing
// that line". Built once from a snapshot string + the current PM doc, then
// consulted by the diff-driven pending-hunks pipeline so a single
// removed/added line lands on the right block range (not the whole list /
// blockquote / table).
//
// Why this exists: `propose_write` now sends whole-file replacements, so
// the inline review widget has to derive "what actually changed" from
// (snapshot, after) — see `computePendingHunks`. To highlight the right
// PM range, we need a "markdown line → PM range" lookup. The snapshot's
// markdown AST (remark + remark-gfm) carries `position.start.line` /
// `position.end.line` for every block; the PM doc carries node sizes
// indexed by child order. As long as both parse the snapshot to the same
// block structure (commonmark + gfm — same grammar Milkdown uses), a
// parallel walk by index gives us the matched (mdLine, pmRange) pairs.
//
// Container blocks (list, listItem, blockquote, table, tableRow) recurse
// so we can pinpoint a single list_item or table_cell. Leaf blocks
// (paragraph, heading, code) record the whole block range against every
// line they span — diffLines inside a multi-line paragraph reflows to
// "whole paragraph replaced" rather than line-level inside the block.
//
// Returns null on any structure mismatch (AST child count ≠ PM child
// count) so the caller can gracefully fall back to the prior single-
// widget behaviour rather than placing a decoration at the wrong spot.

import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkGfm from 'remark-gfm'
import type { Node as PMNode } from '@milkdown/kit/prose/model'
import type { Root, RootContent } from 'mdast'

export interface BlockRange {
  pmFrom: number
  pmTo: number
}

/** Lookup keyed by 1-indexed markdown line. */
export type BlockMap = Map<number, BlockRange>

/** AST node types that contain other blocks. For these we recurse so a
 * single child can be pinpointed; everything else is a leaf that owns
 * its whole line range as a block. */
const CONTAINER_AST_TYPES = new Set<string>([
  'list',
  'listItem',
  'blockquote',
  'table',
  'tableRow',
])

/** Parse `snapshotMd` with remark + remark-gfm, then walk the AST and
 * the PM doc in parallel by child index, recording PM ranges for every
 * markdown line they span. Returns `null` when the structures don't
 * align — caller should fall back. */
export function buildBlockMap(
  snapshotMd: string,
  pmDoc: PMNode,
): BlockMap | null {
  let tree: Root
  try {
    tree = unified()
      .use(remarkParse)
      .use(remarkGfm)
      .parse(snapshotMd) as Root
  } catch {
    return null
  }

  const map: BlockMap = new Map()
  try {
    walkParallel(tree.children, pmDoc, /* pmInnerStart */ 0, map)
  } catch {
    return null
  }
  return map
}

/** Walk a sibling list of AST nodes alongside the matching PM children
 * inside `pmParent`. `pmInnerStart` is the PM position of the FIRST
 * child inside `pmParent` (i.e. parent's start + 1 for non-root, 0 for
 * root/doc).
 *
 * Throws when the child counts don't line up; the top-level catcher
 * turns that into a `null` BlockMap. */
function walkParallel(
  astChildren: readonly RootContent[],
  pmParent: PMNode,
  pmInnerStart: number,
  map: BlockMap,
): void {
  if (astChildren.length !== pmParent.childCount) {
    throw new Error('AST/PM child count mismatch')
  }
  let cursor = pmInnerStart
  for (let i = 0; i < astChildren.length; i++) {
    const astChild = astChildren[i]
    const pmChild = pmParent.child(i)
    const childEnd = cursor + pmChild.nodeSize
    if (astChild.position) {
      for (
        let line = astChild.position.start.line;
        line <= astChild.position.end.line;
        line++
      ) {
        // Inner blocks (visited later by recursion) overwrite the
        // outer container's entry, leaving the lookup pointing at the
        // deepest block — which is what we want for pinpoint marking.
        // The container's entry is still useful when a line lives at
        // the container level only (e.g. an empty listItem line that
        // has no inner block).
        map.set(line, { pmFrom: cursor, pmTo: childEnd })
      }
    }
    if (
      CONTAINER_AST_TYPES.has(astChild.type) &&
      hasChildren(astChild) &&
      pmChild.childCount > 0
    ) {
      walkParallel(astChild.children, pmChild, cursor + 1, map)
    }
    cursor = childEnd
  }
}

function hasChildren(
  node: RootContent,
): node is RootContent & { children: readonly RootContent[] } {
  return 'children' in node && Array.isArray((node as { children?: unknown }).children)
}
