// ProseMirror adapter for the anchor-stability harness — the CONTROL.
//
// It drives the REAL shipped anchor code (resolveAnchor, the plugin's
// apply() mapping/re-resolution, anchorToTargets + reconcile + commit,
// looseReplace) against a hand-built test doc. The only thing it fakes
// is the markdown↔doc materialisation, which is deliberately a tiny,
// fixture-scoped helper (paragraphs / ATX headings / single-level
// bullets) — NOT a general parser. The fixture markdown is the single
// source of truth; this adapter renders it into PM, the CM adapter (Phase
// 2) will use it verbatim.
//
// Headless faithfulness: we install `inlineReviewPluginSpec` (the bare
// ProseMirror Plugin extracted from the $prose wrapper) on a plain
// EditorState. `init`/`apply` run for real; `view()` (raf + store
// subscription + DOM widgets) never runs because we never build an
// EditorView — exactly the layer we don't want in a unit measurement.

import { Schema } from '@milkdown/kit/prose/model'
import type { Node as PMNode } from '@milkdown/kit/prose/model'
import { EditorState } from '@milkdown/kit/prose/state'
import type {
  AnchorProbe,
  EditorAdapter,
  Fixture,
  Op,
} from '../anchorStability.types'
import {
  inlineReviewKey,
  inlineReviewPluginSpec,
  resolveAnchor,
} from '../../inlineReviewPlugin'
import { anchorToTargets, isBlockInsertionReplace } from '../../pendingTargets'
import {
  commitSuggestionInDoc,
  reconcilePendingDeletes,
  reconcilePendingInserts,
} from '../../markReconcile'
import { looseReplace } from '@/lib/looseMatch'
import { useDocsStore } from '@/state/docsStore'
import {
  usePendingChangesStore,
  type PendingEdit,
} from '@/state/pendingChangesStore'

const SLUG = 'poc:anchor'
const CHANGE_ID = 'pocchange1' // colon-free (parseMarkId splits on ':')
const EDIT_ID = 'edit1'
const MARK_ID_BASE = `${CHANGE_ID}:${EDIT_ID}`

// ── Test schema (existing test idiom + the proofSuggestion mark) ──────

export const testSchema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { group: 'block', content: 'inline*', toDOM: () => ['p', 0] },
    heading: {
      group: 'block',
      content: 'inline*',
      attrs: { level: { default: 1 } },
      toDOM: (n) => [`h${n.attrs.level as number}`, 0],
    },
    bullet_list: { group: 'block', content: 'list_item+', toDOM: () => ['ul', 0] },
    list_item: { content: 'paragraph+', toDOM: () => ['li', 0] },
    text: { group: 'inline' },
  },
  marks: {
    proofSuggestion: {
      attrs: { id: { default: null }, kind: { default: 'replace' }, by: { default: 'unknown' } },
      inclusive: false,
      toDOM: () => ['span', 0],
    },
  },
})

function inline(text: string): PMNode[] {
  return text.length ? [testSchema.text(text)] : []
}

/** Fixture-scoped markdown → test doc. Supports ONLY the fixture subset:
 * blank-line-separated paragraphs, ATX headings, single-level bullet
 * lists. Block segmentation matches remark for these shapes (the hunks
 * path's buildBlockMap relies on that; fixtures guard with a not-null
 * check). Headings/bullets strip their marker so textContent mirrors what
 * a NodeView would render — the form findTextRange searches. */
export function mdToTestDoc(md: string): PMNode {
  const lines = md.split('\n')
  const blocks: PMNode[] = []
  let para: string[] = []
  const flush = () => {
    if (para.length) {
      blocks.push(testSchema.nodes.paragraph.create(null, inline(para.join(' '))))
      para = []
    }
  }
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    if (line.trim() === '') {
      flush()
      i++
      continue
    }
    const h = /^(#{1,6})\s+(.*)$/.exec(line)
    if (h) {
      flush()
      blocks.push(
        testSchema.nodes.heading.create({ level: h[1].length }, inline(h[2])),
      )
      i++
      continue
    }
    if (/^[-*+]\s+/.test(line)) {
      flush()
      const items: PMNode[] = []
      while (i < lines.length && /^[-*+]\s+/.test(lines[i])) {
        const text = lines[i].replace(/^[-*+]\s+/, '')
        items.push(
          testSchema.nodes.list_item.create(
            null,
            testSchema.nodes.paragraph.create(null, inline(text)),
          ),
        )
        i++
      }
      blocks.push(testSchema.nodes.bullet_list.create(null, items))
      continue
    }
    para.push(line)
    i++
  }
  flush()
  if (blocks.length === 0) blocks.push(testSchema.nodes.paragraph.create())
  return testSchema.nodes.doc.create(null, blocks)
}

/** Inverse of mdToTestDoc for the accept-fidelity (secondary) metric.
 * Deterministic; fixtures author expectedBody to match this shape. */
export function docToMd(doc: PMNode): string {
  const out: string[] = []
  doc.forEach((node) => {
    if (node.type.name === 'heading') {
      out.push(`${'#'.repeat(node.attrs.level as number)} ${node.textContent}`)
    } else if (node.type.name === 'bullet_list') {
      const bullets: string[] = []
      node.forEach((li) => bullets.push(`- ${li.textContent}`))
      out.push(bullets.join('\n'))
    } else {
      out.push(node.textContent)
    }
  })
  return out.join('\n\n')
}

// ── Dumb literal find (user-edit simulator; NOT the anchor logic) ─────

/** First literal occurrence of `needle` in a textblock, as a PM range.
 * Plain first-match — deliberately independent of findTextRange's tier
 * system so simulating the user never exercises the code under test. */
function dumbFind(doc: PMNode, needle: string): { from: number; to: number } | null {
  let res: { from: number; to: number } | null = null
  doc.descendants((node, pos) => {
    if (res) return false
    if (!node.isTextblock) return true
    const idx = node.textContent.indexOf(needle)
    if (idx >= 0) {
      const from = pos + 1 + idx
      res = { from, to: from + needle.length }
    }
    return false
  })
  return res
}

/** ~60 chars of text ending at `pos` (across block joins). Used to check
 * an add/insert anchor still sits right after its preceding content. */
function tailBefore(doc: PMNode, pos: number): string {
  const from = Math.max(0, pos - 60)
  try {
    return doc.textBetween(from, Math.min(pos, doc.content.size), '\n', '')
  } catch {
    return ''
  }
}

// ── Store seeding / reset ────────────────────────────────────────────

function setBody(body: string): void {
  useDocsStore.setState((s) => ({
    handles: {
      ...s.handles,
      [SLUG]: {
        slug: SLUG,
        bodyMarkdown: body,
        contentReady: Promise.resolve(),
        destroy: () => {},
      },
    },
  }))
}

function getBody(): string {
  return useDocsStore.getState().handles[SLUG]?.bodyMarkdown ?? ''
}

function resetStores(): void {
  usePendingChangesStore.setState({ byId: {} })
  useDocsStore.setState({ handles: {} })
}

// ── Adapter ──────────────────────────────────────────────────────────

interface PmHandle {
  state: EditorState
  edit: PendingEdit
}

function isInlinePath(edit: PendingEdit): boolean {
  return (
    edit.kind === 'delete' ||
    (edit.kind === 'replace' && !!edit.before && !isBlockInsertionReplace(edit))
  )
}

export const pmAdapter: EditorAdapter<PmHandle> = {
  init(fixture: Fixture): PmHandle {
    resetStores()
    setBody(fixture.initialBody)
    const edit: PendingEdit = { ...fixture.edit, id: EDIT_ID }
    usePendingChangesStore.getState().push({
      id: CHANGE_ID,
      source: 'chat',
      pageSlug: SLUG,
      groupId: 'pocgroup',
      edits: [edit],
      context: {},
    })
    const state = EditorState.create({
      schema: testSchema,
      doc: mdToTestDoc(fixture.initialBody),
      plugins: [inlineReviewPluginSpec(SLUG)],
    })
    return { state, edit }
  },

  applyUserOp(h: PmHandle, op: Op): PmHandle {
    const { state } = h
    let tr = state.tr
    let body = getBody()

    switch (op.kind) {
      case 'insertText': {
        const r = dumbFind(state.doc, op.find)
        if (!r) return h
        tr = tr.insertText(op.text, op.where === 'before' ? r.from : r.to)
        const si = body.indexOf(op.find)
        if (si >= 0) {
          const at = op.where === 'before' ? si : si + op.find.length
          body = body.slice(0, at) + op.text + body.slice(at)
        }
        break
      }
      case 'deleteText': {
        const r = dumbFind(state.doc, op.find)
        if (!r) return h
        tr = tr.delete(r.from, r.to)
        const si = body.indexOf(op.find)
        if (si >= 0) body = body.slice(0, si) + body.slice(si + op.find.length)
        break
      }
      case 'replaceText': {
        const r = dumbFind(state.doc, op.find)
        if (!r) return h
        tr = tr.insertText(op.text, r.from, r.to)
        const si = body.indexOf(op.find)
        if (si >= 0) body = body.slice(0, si) + op.text + body.slice(si + op.find.length)
        break
      }
      case 'insertBlock': {
        const r = dumbFind(state.doc, op.afterFind)
        if (!r) return h
        const at = state.doc.resolve(r.to).after(1)
        tr = tr.insert(at, mdToTestDoc(op.markdown).content)
        const si = body.indexOf(op.afterFind)
        if (si >= 0) {
          const le = body.indexOf('\n', si)
          const cut = le < 0 ? body.length : le
          body = `${body.slice(0, cut)}\n\n${op.markdown}${body.slice(cut)}`
        }
        break
      }
      case 'deleteBlock': {
        const r = dumbFind(state.doc, op.find)
        if (!r) return h
        const $ = state.doc.resolve(r.from)
        tr = tr.delete($.before(1), $.after(1))
        const si = body.indexOf(op.find)
        if (si >= 0) {
          let ls = body.lastIndexOf('\n', si)
          ls = ls < 0 ? 0 : ls
          let le = body.indexOf('\n', si)
          le = le < 0 ? body.length : le
          body = body.slice(0, ls) + body.slice(le)
        }
        break
      }
    }

    if (!tr.docChanged) return h
    // Update the disk-side body BEFORE applying, so the plugin's
    // re-resolution branch (unplaced/silent) reads a consistent body.
    setBody(body)
    return { state: state.apply(tr), edit: h.edit }
  },

  probe(h: PmHandle): AnchorProbe {
    const ps = inlineReviewKey.getState(h.state)
    const res = ps?.resolved[0]?.resolution
    if (!res) return { status: 'unplaced', targetText: null, textBeforeInsert: null }
    if (res.status === 'placed') {
      const a = res.anchor
      const targetText =
        a.from !== undefined && a.to !== undefined
          ? h.state.doc.textBetween(a.from, a.to)
          : null
      const textBeforeInsert =
        a.insertAt !== undefined ? tailBefore(h.state.doc, a.insertAt) : null
      return { status: 'placed', targetText, textBeforeInsert }
    }
    return { status: res.status, targetText: null, textBeforeInsert: null }
  },

  accept(h: PmHandle): string {
    const { edit } = h
    const body = getBody()
    if (isInlinePath(edit)) {
      return looseReplace(body, edit.before ?? '', edit.after ?? '') ?? body
    }
    // Block / add / hunks / whole-file: materialise then commit. Mirrors
    // inlineReviewPlugin's runReconcile (minus the store-published parser),
    // passing a fixture-scoped parse.
    let st = h.state
    const res = resolveAnchor(st.doc, edit, SLUG)
    const targets = anchorToTargets(res, MARK_ID_BASE, edit, st.doc, (md) =>
      mdToTestDoc(md).content,
    )
    const trD = reconcilePendingDeletes(st, targets.deletes)
    if (trD) st = st.apply(trD)
    const trI = reconcilePendingInserts(st, targets.inserts)
    if (trI) st = st.apply(trI)
    const commit = commitSuggestionInDoc(st, CHANGE_ID)
    if (commit) st = st.apply(commit.tr)
    return docToMd(st.doc)
  },

  dispose(): void {
    resetStores()
  },
}
