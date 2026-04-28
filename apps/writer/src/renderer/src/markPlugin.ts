import { $prose } from '@milkdown/kit/utils'
import { Plugin, PluginKey } from '@milkdown/kit/prose/state'
import { Decoration, DecorationSet } from '@milkdown/kit/prose/view'
import type { Node as ProseMirrorNode } from '@milkdown/kit/prose/model'
import * as Y from 'yjs'

export type StoredMark = {
  kind?: string
  quote?: string
  content?: string
  status?: string
  by?: string
  startRel?: string
  endRel?: string
}

type MarksMap = Record<string, StoredMark>

type MarksState = {
  marks: MarksMap
}

const marksKey = new PluginKey<MarksState>('proof-marks')

const STYLES: Record<string, string> = {
  insert: 'background-color: rgba(34, 197, 94, 0.10); border-bottom: 1px dashed rgb(34, 197, 94);',
  delete: 'background-color: rgba(239, 68, 68, 0.20); text-decoration: line-through; color: rgba(0, 0, 0, 0.55);',
  replace: 'background-color: rgba(239, 68, 68, 0.20); text-decoration: line-through; color: rgba(0, 0, 0, 0.55);'
}

const WIDGET_STYLE =
  'background-color: rgba(34, 197, 94, 0.20); border-bottom: 2px solid rgb(34, 197, 94); margin-left: 4px; padding: 0 2px;'

function findQuoteRange(doc: ProseMirrorNode, quote: string): { from: number; to: number } | null {
  let result: { from: number; to: number } | null = null
  doc.descendants((node, pos) => {
    if (result) return false
    if (node.isText && node.text) {
      const idx = node.text.indexOf(quote)
      if (idx !== -1) {
        result = { from: pos + idx, to: pos + idx + quote.length }
        return false
      }
    }
    return true
  })
  return result
}

type ResolvedMark = {
  id: string
  mark: StoredMark
  range: { from: number; to: number }
}

function resolveMarks(doc: ProseMirrorNode, marks: MarksMap): ResolvedMark[] {
  const resolved: ResolvedMark[] = []
  for (const [id, mark] of Object.entries(marks)) {
    if (!mark || typeof mark !== 'object') continue
    const kind = mark.kind
    if (kind !== 'insert' && kind !== 'delete' && kind !== 'replace') continue
    if (mark.status && mark.status !== 'pending') continue
    if (!mark.quote) continue
    const range = findQuoteRange(doc, mark.quote)
    if (!range) continue
    resolved.push({ id, mark, range })
  }
  return resolved
}

function pickPrimaryReplaceIds(resolved: ResolvedMark[]): Set<string> {
  const groups = new Map<string, ResolvedMark[]>()
  for (const item of resolved) {
    if (item.mark.kind !== 'replace') continue
    const key = `${item.range.from}:${item.range.to}`
    const group = groups.get(key) ?? []
    group.push(item)
    groups.set(key, group)
  }
  const primary = new Set<string>()
  for (const group of groups.values()) {
    group.sort((a, b) => {
      const aTime = a.mark.createdAt ? Date.parse(a.mark.createdAt) : 0
      const bTime = b.mark.createdAt ? Date.parse(b.mark.createdAt) : 0
      if (bTime !== aTime) return bTime - aTime
      return b.id.localeCompare(a.id)
    })
    if (group[0]) primary.add(group[0].id)
  }
  return primary
}

function buildDecorations(doc: ProseMirrorNode, marks: MarksMap): DecorationSet {
  const decorations: Decoration[] = []
  const resolved = resolveMarks(doc, marks)
  const primaryReplaceIds = pickPrimaryReplaceIds(resolved)

  for (const { id, mark, range } of resolved) {
    const kind = mark.kind!
    if (kind === 'replace' && !primaryReplaceIds.has(id)) continue

    decorations.push(
      Decoration.inline(range.from, range.to, {
        style: STYLES[kind],
        'data-mark-id': id,
        'data-mark-kind': kind
      })
    )

    if ((kind === 'replace' || kind === 'insert') && mark.content) {
      const content = mark.content
      const widgetKind = kind === 'replace' ? 'replace-insert' : 'insert-widget'
      decorations.push(
        Decoration.widget(
          range.to,
          () => {
            const span = document.createElement('span')
            span.style.cssText = WIDGET_STYLE
            span.setAttribute('data-mark-id', id)
            span.setAttribute('data-mark-kind', widgetKind)
            span.textContent = content
            return span
          },
          { side: 1, key: `${kind}-${id}` }
        )
      )
    }
  }

  return DecorationSet.create(doc, decorations)
}

export const proofMarksPlugin = (ydoc: Y.Doc) =>
  $prose(() =>
    new Plugin<MarksState>({
      key: marksKey,
      state: {
        init: () => ({ marks: {} }),
        apply(tr, value) {
          const meta = tr.getMeta(marksKey)
          if (meta && meta.type === 'SET_MARKS') {
            return { marks: meta.marks }
          }
          return value
        }
      },
      props: {
        decorations(state) {
          const pluginState = marksKey.getState(state)
          if (!pluginState) return DecorationSet.empty
          return buildDecorations(state.doc, pluginState.marks)
        }
      },
      view(view) {
        const marksMap = ydoc.getMap('marks')

        const sync = (): void => {
          const marks: MarksMap = {}
          marksMap.forEach((value, key) => {
            marks[key] = value as StoredMark
          })
          view.dispatch(view.state.tr.setMeta(marksKey, { type: 'SET_MARKS', marks }))
        }

        sync()
        marksMap.observe(sync)

        return {
          destroy() {
            marksMap.unobserve(sync)
          }
        }
      }
    })
  )
