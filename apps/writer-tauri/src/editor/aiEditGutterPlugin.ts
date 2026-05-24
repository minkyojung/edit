// Gutter marker plugin for AI-edit commits in the active wiki page.
//
// Visual: a 4px coloured bar on the left of every top-level block
// touched by an unreviewed `ai-edit:*` commit. Green = pure addition,
// yellow = mixed add+remove (replace), red = pure removal. Inserted as
// `Decoration.node` on the block — letting PM own positioning and DOM
// re-rendering — and styled via ::before in aiEditGutter.css so we
// never have to invent our own coordinate system.
//
// Data flow:
//   gitStore.activity              (last-reviewed..HEAD, refreshed
//                                     after every commit / revert)
//      ↓ filter to ai-edit subjects + drop dismissed sha
//   gitStore.commitDetails[sha]    (lazy git_show; we prefetch in
//                                     MilkdownEditor's subscribe path)
//      ↓ for files whose path == active doc's relPath
//   lineNum → top-level block index
//      ↓ collapse multiple shas hitting the same block
//   Decoration.node(blockPos, blockPos + blockSize, { class })
//
// The lineNum→block mapping uses a heuristic per-block line-count
// (see `blockLineCount`) rather than a full markdown serialize each
// rebuild. Paragraph- and heading-heavy docs (the dominant ai-edit
// target) match git's view exactly; code fences and tables drift by
// a few lines, which is acceptable for the MVP "near this block"
// signal. See plan U.2 → Block index 매핑 한계.

import { $prose } from '@milkdown/kit/utils'
import { Plugin, PluginKey } from '@milkdown/kit/prose/state'
import { Decoration, DecorationSet } from '@milkdown/kit/prose/view'
import type { Node as PMNode } from '@milkdown/kit/prose/model'
import type { CommitDetail, CommitInfo, DiffLine } from '@/lib/git'

export const aiEditGutterKey = new PluginKey<DecorationSet>('aiEditGutter')

export type AiEditGutterKind = 'add' | 'replace' | 'remove'

interface GutterMarker {
  /** Top-level block index in the current PM doc. */
  blockIndex: number
  /** PM position where the block starts (offset returned by
   * `doc.forEach`). The decoration covers [pos, pos + nodeSize]. */
  pos: number
  size: number
  /** Most recent sha touching this block — drives the bar colour.
   * Older shas affecting the same block live in `allShas`. */
  kind: AiEditGutterKind
  /** All ai-edit shas that touch this block, newest-first. The
   * popover (U.3) walks this list to show every contributing commit. */
  shas: string[]
}

export interface AiEditGutterOpts {
  /** Vault-relative path of the doc currently mounted in this editor
   * (e.g. "wiki/Tom.md"). Null when no doc is open — the plugin
   * skips work and returns an empty decoration set. */
  getActiveRelPath: () => string | null
  /** Active ai-edit shas in newest-first order, already filtered for
   * dismissed entries. The caller (gitStore subscriber) owns the
   * regex match + dismiss filter so the plugin stays a pure mapper. */
  getActiveShas: () => string[]
  /** Lookup memoised git_show output. Returns undefined when the
   * detail hasn't been prefetched yet; the plugin treats that as
   * "skip for now, rebuild will rerun once it arrives". */
  getCommitDetail: (sha: string) => CommitDetail | undefined
  /** Optional: also surface the most recent commit subject so the
   * inline data-attribute reads back useful context in DevTools.
   * Not required for U.2 rendering. */
  getCommit?: (sha: string) => CommitInfo | undefined
}

/** Markdown line-count heuristic. Block types this writer actually
 * emits in wiki pages are paragraphs, headings, lists, blockquotes,
 * and the occasional code block / hr. We approximate the count rather
 * than re-serializing each block (single-block serialize requires
 * synthesising a temp doc with a top-level schema node — fine but
 * costly on every doc change). Drift is bounded: ai-edit commits
 * mostly append paragraphs, where the heuristic is exact. */
function blockLineCount(node: PMNode): number {
  const t = node.type.name
  if (t === 'paragraph' || t === 'heading' || t === 'horizontal_rule') {
    return 1
  }
  if (t === 'code_block') {
    // Body lines + opening fence + closing fence. Empty body still
    // emits two fence lines.
    const body = node.textContent
    const bodyLines = body.length === 0 ? 0 : body.split('\n').length
    return bodyLines + 2
  }
  if (t === 'blockquote') {
    // Recurse into children — blockquotes wrap paragraphs and other
    // blocks one-to-one onto markdown lines (each `>` prefix is its
    // own line).
    let n = 0
    node.forEach((child) => {
      n += blockLineCount(child)
    })
    return Math.max(1, n)
  }
  if (
    t === 'bullet_list' ||
    t === 'ordered_list' ||
    t === 'task_list'
  ) {
    // One markdown line per list_item, ignoring nested-list line
    // count. The MVP eats this inaccuracy.
    return Math.max(1, node.childCount)
  }
  if (t === 'table') {
    // Header row + alignment separator + body rows.
    return Math.max(2, node.childCount + 1)
  }
  return 1
}

/** Walk the top-level children of `doc` once and build a lookup
 * keyed by markdown line number. Returns
 *   - `blocks`: ordered metadata about each top-level block;
 *   - `lineToIndex`: O(1) line → blockIndex resolver via clamped
 *     binary index.
 * Line numbers are 1-based to match unified-diff hunk headers. */
interface BlockMap {
  blocks: Array<{
    index: number
    pos: number
    size: number
    startLine: number
    endLine: number
  }>
  blockForLine: (line: number) => number | null
}

function buildBlockMap(doc: PMNode): BlockMap {
  const blocks: BlockMap['blocks'] = []
  let cumulative = 1
  doc.forEach((child, offset, index) => {
    const lines = blockLineCount(child)
    const startLine = cumulative
    const endLine = cumulative + lines - 1
    blocks.push({
      index,
      pos: offset,
      size: child.nodeSize,
      startLine,
      endLine,
    })
    // +1 for the block we just laid down's trailing line, +1 for
    // the blank-line separator between top-level blocks.
    cumulative = endLine + 2
  })

  function blockForLine(line: number): number | null {
    if (blocks.length === 0) return null
    if (line <= 0) return 0
    // Linear scan — doc has at most ~hundreds of top-level blocks;
    // binary search isn't worth the complexity.
    for (let i = 0; i < blocks.length; i += 1) {
      if (line <= blocks[i].endLine) return i
    }
    // Past the end (file grew since the commit, or our heuristic
    // undershot). Clamp to last block so the marker still appears
    // somewhere reasonable.
    return blocks.length - 1
  }

  return { blocks, blockForLine }
}

/** Classify a block's edit kind based on which diff-line directions
 * are present. Mixed = replace; pure-add = add; pure-remove = remove.
 * Empty list means the sha doesn't touch this block at all. */
function kindForBlock(
  hasAdd: boolean,
  hasRemove: boolean,
): AiEditGutterKind | null {
  if (hasAdd && hasRemove) return 'replace'
  if (hasAdd) return 'add'
  if (hasRemove) return 'remove'
  return null
}

function buildDecos(
  doc: PMNode,
  opts: AiEditGutterOpts,
): DecorationSet {
  const relPath = opts.getActiveRelPath()
  if (!relPath) return DecorationSet.empty
  const shas = opts.getActiveShas()
  if (shas.length === 0) return DecorationSet.empty

  const map = buildBlockMap(doc)
  if (map.blocks.length === 0) return DecorationSet.empty

  // Aggregate per-block contributions across every active sha. Newer
  // shas come first in `shas` — we record them in that order so the
  // popover (U.3) reads newest → oldest naturally.
  const byBlock = new Map<number, GutterMarker>()

  for (const sha of shas) {
    const detail = opts.getCommitDetail(sha)
    if (!detail) continue
    const file = detail.files.find((f) => f.path === relPath)
    if (!file) continue

    // Group diff lines by which block they map to, so a single sha
    // touching multiple blocks emits separate markers and a single
    // sha touching one block twice (add+remove on adjacent lines)
    // collapses to one `replace` marker on that block.
    const perBlock = new Map<number, { add: boolean; remove: boolean }>()
    for (const line of file.lines as DiffLine[]) {
      if (line.lineNum === 0) continue
      const blockIdx = map.blockForLine(line.lineNum)
      if (blockIdx === null) continue
      let acc = perBlock.get(blockIdx)
      if (!acc) {
        acc = { add: false, remove: false }
        perBlock.set(blockIdx, acc)
      }
      if (line.kind === 'add') acc.add = true
      else acc.remove = true
    }

    for (const [blockIdx, flags] of perBlock) {
      const kind = kindForBlock(flags.add, flags.remove)
      if (!kind) continue
      const block = map.blocks[blockIdx]
      const existing = byBlock.get(blockIdx)
      if (existing) {
        // Older sha touching the same block — preserve the newer
        // sha's colour (it's already there) and append to shas list.
        existing.shas.push(sha)
      } else {
        byBlock.set(blockIdx, {
          blockIndex: blockIdx,
          pos: block.pos,
          size: block.size,
          kind,
          shas: [sha],
        })
      }
    }
  }

  if (byBlock.size === 0) return DecorationSet.empty

  const decos: Decoration[] = []
  for (const marker of byBlock.values()) {
    decos.push(
      Decoration.node(
        marker.pos,
        marker.pos + marker.size,
        {
          class: `ai-edit-gutter ai-edit-gutter--${marker.kind}`,
          'data-ai-edit-shas': marker.shas.join(','),
          'data-ai-edit-kind': marker.kind,
        },
      ),
    )
  }

  return DecorationSet.create(doc, decos)
}

export function createAiEditGutterPlugin(opts: AiEditGutterOpts) {
  return $prose(
    () =>
      new Plugin({
        key: aiEditGutterKey,
        state: {
          init(_, { doc }) {
            return buildDecos(doc, opts)
          },
          apply(tr, prev) {
            if (tr.docChanged) return buildDecos(tr.doc, opts)
            const meta = tr.getMeta(aiEditGutterKey)
            if (meta === 'rebuild') return buildDecos(tr.doc, opts)
            return prev
          },
        },
        props: {
          decorations(state) {
            return aiEditGutterKey.getState(state)
          },
        },
      }),
  )
}
