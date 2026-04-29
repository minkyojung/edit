import { $prose } from '@milkdown/kit/utils'
import { Plugin, PluginKey } from '@milkdown/kit/prose/state'
import { Decoration, DecorationSet } from '@milkdown/kit/prose/view'
import type { EditorView } from '@milkdown/kit/prose/view'
import type { Node as ProseMirrorNode } from '@milkdown/kit/prose/model'
import type { Schema } from '@milkdown/kit/prose/model'
import type { Transaction } from '@milkdown/kit/prose/state'
import * as Y from 'yjs'
import {
  buildTextIndex,
  getTextForRange,
  mapTextOffsetsToRange,
  normalizeQuote,
  resolveQuoteRange
} from './textRange'

export type StoredMark = {
  kind?: string
  quote?: string
  content?: string
  status?: string
  by?: string
  startRel?: string
  endRel?: string
  createdAt?: string
}

type MarksMap = Record<string, StoredMark>

type MarksState = {
  marks: MarksMap
  focusedMarkId: string | null
  tombstones: Set<string>
}

export const marksKey = new PluginKey<MarksState>('proof-marks')

const STRIKE = 'background-color: rgba(239, 68, 68, 0.20); text-decoration: line-through; color: var(--muted-foreground);'
const STYLES: Record<string, string> = {
  insert: 'background-color: rgba(34, 197, 94, 0.10); border-bottom: 1px dashed rgb(34, 197, 94);',
  delete: STRIKE,
  replace: STRIKE
}

const WIDGET_STYLE =
  'background-color: rgba(34, 197, 94, 0.20); border-bottom: 2px solid rgb(34, 197, 94); margin-left: 4px; padding: 0 2px;'

function parseRelativeCharOffset(value: string | undefined): number | null {
  if (typeof value !== 'string') return null
  const match = value.match(/^char:(\d+)$/)
  if (!match) return null
  const parsed = Number.parseInt(match[1], 10)
  if (!Number.isFinite(parsed) || parsed < 0) return null
  return parsed
}

function resolveRangeFromRelativeAnchors(
  doc: ProseMirrorNode,
  startRel: string | undefined,
  endRel: string | undefined
): { from: number; to: number } | null {
  const startOffset = parseRelativeCharOffset(startRel)
  const endOffset = parseRelativeCharOffset(endRel)
  if (startOffset === null || endOffset === null || endOffset <= startOffset) return null
  const index = buildTextIndex(doc)
  if (!index) return null
  return mapTextOffsetsToRange(index, startOffset, endOffset)
}

function resolveStoredMarkRange(
  doc: ProseMirrorNode,
  stored: StoredMark
): { from: number; to: number } | null {
  const normalizedStoredQuote = stored.quote ? normalizeQuote(stored.quote) : ''

  // 1순위: char 오프셋 (startRel/endRel)
  const relativeRange = resolveRangeFromRelativeAnchors(doc, stored.startRel, stored.endRel)
  if (relativeRange && normalizedStoredQuote) {
    const actualQuote = normalizeQuote(getTextForRange(doc, relativeRange))
    if (actualQuote === normalizedStoredQuote) return relativeRange
  }

  // 2순위: quote 검색 (정규화 + 모호성 체크)
  if (normalizedStoredQuote) {
    return resolveQuoteRange(doc, normalizedStoredQuote)
  }

  return null
}

type ResolvedMark = {
  id: string
  mark: StoredMark
  range: { from: number; to: number }
}

function resolveMarks(
  doc: ProseMirrorNode,
  marks: MarksMap,
  tombstones: Set<string>
): ResolvedMark[] {
  const resolved: ResolvedMark[] = []
  for (const [id, mark] of Object.entries(marks)) {
    if (tombstones.has(id)) continue
    if (!mark || typeof mark !== 'object') continue
    const kind = mark.kind
    if (kind !== 'insert' && kind !== 'delete' && kind !== 'replace') continue
    if (mark.status && mark.status !== 'pending') continue
    if (!mark.quote) continue
    const range = resolveStoredMarkRange(doc, mark)
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

function getRenderableMarks(
  doc: ProseMirrorNode,
  marks: MarksMap,
  tombstones: Set<string>
): ResolvedMark[] {
  const resolved = resolveMarks(doc, marks, tombstones)
  const primaryReplaceIds = pickPrimaryReplaceIds(resolved)
  const renderable = resolved.filter((r) => r.mark.kind !== 'replace' || primaryReplaceIds.has(r.id))
  renderable.sort((a, b) => a.range.from - b.range.from)
  return renderable
}

function pickFocus(renderable: ResolvedMark[], current: string | null): string | null {
  if (renderable.length === 0) return null
  if (current && renderable.some((r) => r.id === current)) return current
  return renderable[0].id
}

function getNextFocus(renderable: ResolvedMark[], current: string | null): string | null {
  if (renderable.length === 0) return null
  const idx = renderable.findIndex((r) => r.id === current)
  if (idx === -1) return renderable[0].id
  const next = renderable[idx + 1]
  return next ? next.id : null
}

type Segment = { segment: string; index: number; isWordLike?: boolean }

function segmentText(text: string): Segment[] | null {
  if (typeof Intl === 'undefined' || typeof Intl.Segmenter !== 'function') return null
  try {
    const locale = typeof navigator !== 'undefined' ? navigator.language : 'en'
    const segmenter = new Intl.Segmenter(locale, { granularity: 'word' })
    return [...segmenter.segment(text)] as Segment[]
  } catch {
    return null
  }
}

/**
 * 단어 경계를 인식해서 마크 적용 범위를 자연스럽게 정렬한다.
 *
 * 원칙:
 *   - 마크가 단어(또는 단어들의 묶음)와 정확히 일치할 때만 인접 공백을 흡수
 *   - 단어 안에 걸친 부분 마크면 그대로 (사용자 의도 보존)
 *   - quote 또는 content가 이미 양 끝 공백을 포함하면 안 건드림
 */
function alignRangeToWordBoundary(
  doc: ProseMirrorNode,
  range: { from: number; to: number },
  contentBoundary: { startsWithSpace: boolean; endsWithSpace: boolean }
): { from: number; to: number } {
  const text = doc.textBetween(range.from, range.to)
  if (text.startsWith(' ') || text.endsWith(' ')) return range
  if (contentBoundary.startsWithSpace || contentBoundary.endsWithSpace) return range

  const $from = doc.resolve(range.from)
  if (!$from.parent.isTextblock) return range
  const blockStart = $from.start($from.depth)
  const blockEnd = $from.end($from.depth)
  if (range.to > blockEnd) return range

  const blockText = doc.textBetween(blockStart, blockEnd)
  if (!blockText) return range

  const relFrom = range.from - blockStart
  const relTo = range.to - blockStart

  const segments = segmentText(blockText)
  if (!segments) return range

  const startsAtBoundary = segments.some((s) => s.index === relFrom)
  const endsAtBoundary = segments.some((s) => s.index + s.segment.length === relTo)
  if (!startsAtBoundary || !endsAtBoundary) return range

  const before = segments.find((s) => s.index + s.segment.length === relFrom)
  const after = segments.find((s) => s.index === relTo)

  // 뒤쪽에 비-단어(공백 등) → trailing 흡수
  if (after && !after.isWordLike && /^\s+$/.test(after.segment)) {
    return { from: range.from, to: range.to + after.segment.length }
  }
  // 앞쪽에 비-단어 + 뒤쪽은 단어가 아니거나 없음 (block 끝) → leading 흡수
  if (before && !before.isWordLike && /^\s+$/.test(before.segment)) {
    return { from: range.from - before.segment.length, to: range.to }
  }
  return range
}

function applyResolvedMarkToTr(
  tr: Transaction,
  doc: ProseMirrorNode,
  schema: Schema,
  resolved: ResolvedMark
): Transaction {
  const { mark, range } = resolved
  const kind = mark.kind
  const authoredMarkType = schema.marks.proofAuthored ?? null
  const authoredBy = mark.by || 'ai:copyeditor'
  let authorRange: { from: number; to: number } | null = null

  if (kind === 'delete') {
    const adjusted = alignRangeToWordBoundary(doc, range, {
      startsWithSpace: false,
      endsWithSpace: false
    })
    tr = tr.delete(adjusted.from, adjusted.to)
  } else if (kind === 'replace' && mark.content !== undefined) {
    const content = mark.content
    const adjusted = alignRangeToWordBoundary(doc, range, {
      startsWithSpace: content.startsWith(' '),
      endsWithSpace: content.endsWith(' ')
    })
    tr = tr.replaceWith(adjusted.from, adjusted.to, schema.text(content))
    authorRange = { from: adjusted.from, to: adjusted.from + content.length }
  } else if (kind === 'insert' && mark.content !== undefined) {
    const content = mark.content
    tr = tr.insert(range.to, schema.text(content))
    authorRange = { from: range.to, to: range.to + content.length }
  }

  if (authorRange && authoredMarkType) {
    tr = tr.removeMark(authorRange.from, authorRange.to, authoredMarkType)
    tr = tr.addMark(authorRange.from, authorRange.to, authoredMarkType.create({ by: authoredBy }))
  }

  return tr
}

function applyMarkChange(
  view: EditorView,
  resolved: ResolvedMark,
  nextFocusId: string | null,
  tombstoneId: string
): void {
  let tr = applyResolvedMarkToTr(view.state.tr, view.state.doc, view.state.schema, resolved)
  tr = tr.setMeta(marksKey, { addTombstone: tombstoneId, setFocus: nextFocusId })
  tr = tr.setMeta('ai-authored', true)
  view.dispatch(tr)
}

function acceptAllOnView(view: EditorView): string[] {
  const pluginState = marksKey.getState(view.state)
  if (!pluginState) return []
  const renderable = getRenderableMarks(view.state.doc, pluginState.marks, pluginState.tombstones)
  if (renderable.length === 0) return []

  const doc = view.state.doc
  const schema = view.state.schema
  // 뒤→앞 순으로 적용해야 앞쪽 마크의 from/to 가 유효 유지
  const sorted = [...renderable].sort((a, b) => b.range.from - a.range.from)
  let tr = view.state.tr
  for (const resolved of sorted) {
    tr = applyResolvedMarkToTr(tr, doc, schema, resolved)
  }
  const ids = renderable.map((r) => r.id)
  tr = tr.setMeta(marksKey, { addTombstones: ids, setFocus: null })
  tr = tr.setMeta('ai-authored', true)
  view.dispatch(tr)
  return ids
}

function rejectAllOnView(view: EditorView): string[] {
  const pluginState = marksKey.getState(view.state)
  if (!pluginState) return []
  const renderable = getRenderableMarks(view.state.doc, pluginState.marks, pluginState.tombstones)
  if (renderable.length === 0) return []
  const ids = renderable.map((r) => r.id)
  view.dispatch(view.state.tr.setMeta(marksKey, { addTombstones: ids, setFocus: null }))
  return ids
}

let activeView: EditorView | null = null
type CountListener = (count: number) => void
const countListeners = new Set<CountListener>()
let lastCount = 0

function emitCount(count: number): void {
  if (count === lastCount) return
  lastCount = count
  for (const listener of countListeners) listener(count)
}

export function subscribeMarkCount(listener: CountListener): () => void {
  countListeners.add(listener)
  listener(lastCount)
  return () => {
    countListeners.delete(listener)
  }
}

export function acceptAllMarks(): void {
  if (!activeView) return
  const ids = acceptAllOnView(activeView)
  for (const id of ids) {
    window.marks.accept(id).catch((err) => console.error('[mark accept]', err))
  }
}

export function rejectAllMarks(): void {
  if (!activeView) return
  const ids = rejectAllOnView(activeView)
  for (const id of ids) {
    window.marks.reject(id).catch((err) => console.error('[mark reject]', err))
  }
}

export type ProcessedMark = {
  status: 'accepted' | 'rejected'
  kind: 'insert' | 'delete' | 'replace'
  quote: string
  content?: string
}

export function collectProcessedHistory(ydoc: Y.Doc, limit = 30): ProcessedMark[] {
  const map = ydoc.getMap('marks')
  const items: { mark: ProcessedMark; createdAt: number }[] = []
  map.forEach((value) => {
    const m = value as StoredMark | undefined
    if (!m || typeof m !== 'object') return
    if (m.status !== 'accepted' && m.status !== 'rejected') return
    if (m.kind !== 'insert' && m.kind !== 'delete' && m.kind !== 'replace') return
    if (!m.quote) return
    items.push({
      mark: { status: m.status, kind: m.kind, quote: m.quote, content: m.content },
      createdAt: m.createdAt ? Date.parse(m.createdAt) : 0
    })
  })
  items.sort((a, b) => b.createdAt - a.createdAt)
  return items.slice(0, limit).map((i) => i.mark)
}

if (typeof window !== 'undefined') {
  ;(window as unknown as { __proofDebug: () => unknown }).__proofDebug = () => {
    if (!activeView) return { error: 'no active view' }
    const ps = marksKey.getState(activeView.state)
    if (!ps) return { error: 'no plugin state' }
    const renderable = getRenderableMarks(activeView.state.doc, ps.marks, ps.tombstones)
    return {
      lastEmittedCount: lastCount,
      marksInState: Object.keys(ps.marks).length,
      tombstones: ps.tombstones.size,
      renderableCount: renderable.length,
      docSize: activeView.state.doc.content.size,
      docText: activeView.state.doc.textContent.slice(0, 200),
      marks: Object.entries(ps.marks).map(([id, m]) => ({
        id,
        kind: m.kind,
        status: m.status,
        quote: m.quote,
        startRel: m.startRel,
        endRel: m.endRel,
        content: m.content,
        resolved: !!resolveStoredMarkRange(activeView!.state.doc, m)
      })),
      renderableIds: renderable.map((r) => r.id)
    }
  }
}

function buildDecorations(
  doc: ProseMirrorNode,
  marks: MarksMap,
  focusedId: string | null,
  tombstones: Set<string>
): DecorationSet {
  const decorations: Decoration[] = []
  const renderable = getRenderableMarks(doc, marks, tombstones)

  for (const { id, mark, range } of renderable) {
    const kind = mark.kind!
    const isFocused = id === focusedId

    decorations.push(
      Decoration.inline(range.from, range.to, {
        style: STYLES[kind],
        class: isFocused ? 'mark-focused' : '',
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
        init: () => ({ marks: {}, focusedMarkId: null, tombstones: new Set<string>() }),
        apply(tr, value, _oldState, newState) {
          const meta = tr.getMeta(marksKey) as
            | {
                setMarks?: MarksMap
                setFocus?: string | null
                addTombstone?: string
                addTombstones?: string[]
              }
            | undefined
          let next = value
          if (meta?.setMarks !== undefined) {
            const newMarks = meta.setMarks
            let nextTombstones = next.tombstones
            for (const id of next.tombstones) {
              if (!(id in newMarks)) {
                if (nextTombstones === next.tombstones) nextTombstones = new Set(next.tombstones)
                nextTombstones.delete(id)
              }
            }
            next = { ...next, marks: newMarks, tombstones: nextTombstones }
          }
          if (meta?.addTombstone) {
            const newTombstones = new Set(next.tombstones)
            newTombstones.add(meta.addTombstone)
            next = { ...next, tombstones: newTombstones }
          }
          if (meta?.addTombstones && meta.addTombstones.length > 0) {
            const newTombstones = new Set(next.tombstones)
            for (const id of meta.addTombstones) newTombstones.add(id)
            next = { ...next, tombstones: newTombstones }
          }
          if (meta?.setFocus !== undefined) {
            next = { ...next, focusedMarkId: meta.setFocus }
          }
          if (next !== value || tr.docChanged) {
            const renderable = getRenderableMarks(newState.doc, next.marks, next.tombstones)
            const newFocus = pickFocus(renderable, next.focusedMarkId)
            if (newFocus !== next.focusedMarkId) {
              next = { ...next, focusedMarkId: newFocus }
            }
            // doc 이 바뀌었는데 state ref 가 그대로면 PM 이 decorations() 를
            // 재호출하지 않아 quote→range 재매칭이 안 일어난다 (collab 으로
            // marks 가 빈 doc 에 먼저 도착하는 race 시 0개 stuck). 강제로 새 ref.
            if (tr.docChanged && next === value) {
              next = { ...value }
            }
            emitCount(renderable.length)
          }
          return next
        }
      },
      props: {
        decorations(state) {
          const pluginState = marksKey.getState(state)
          if (!pluginState) return DecorationSet.empty
          return buildDecorations(state.doc, pluginState.marks, pluginState.focusedMarkId, pluginState.tombstones)
        },
        handleKeyDown(view, event) {
          // ⇧⌘A / ⇧⌘R (또는 Ctrl 변형) — 일괄 수락 / 일괄 거절
          const isCmd = event.metaKey || event.ctrlKey
          if (event.shiftKey && isCmd && !event.altKey) {
            const k = event.key.toLowerCase()
            if (k === 'a') {
              event.preventDefault()
              acceptAllMarks()
              return true
            }
            if (k === 'r') {
              event.preventDefault()
              rejectAllMarks()
              return true
            }
          }

          const isTab = event.key === 'Tab'
          const isEsc = event.key === 'Escape'
          if (!isTab && !isEsc) return false
          if (event.shiftKey || event.metaKey || event.ctrlKey || event.altKey) return false

          const pluginState = marksKey.getState(view.state)
          if (!pluginState || !pluginState.focusedMarkId) return false
          const renderable = getRenderableMarks(view.state.doc, pluginState.marks, pluginState.tombstones)
          if (renderable.length === 0) return false
          const currentId = pluginState.focusedMarkId
          const current = renderable.find((r) => r.id === currentId)
          if (!current) return false
          const nextId = getNextFocus(renderable, currentId)

          event.preventDefault()
          if (isTab) {
            console.log('[mark client] Tab → apply + accept', { id: currentId, kind: current.mark.kind, range: current.range, docSize: view.state.doc.content.size })
            applyMarkChange(view, current, nextId, currentId)
            console.log('[mark client] after apply, docSize:', view.state.doc.content.size)
            window.marks.accept(currentId).catch((err) => console.error('[mark accept]', err))
          } else {
            console.log('[mark client] Esc → reject', { id: currentId })
            view.dispatch(view.state.tr.setMeta(marksKey, { addTombstone: currentId, setFocus: nextId }))
            window.marks.reject(currentId).catch((err) => console.error('[mark reject]', err))
          }
          return true
        }
      },
      view(view) {
        activeView = view
        const marksMap = ydoc.getMap('marks')

        const sync = (): void => {
          const marks: MarksMap = {}
          marksMap.forEach((value, key) => {
            marks[key] = value as StoredMark
          })
          console.log('[mark client] marksMap observer fired, count:', Object.keys(marks).length, 'docSize:', view.state.doc.content.size)
          view.dispatch(view.state.tr.setMeta(marksKey, { setMarks: marks }))
        }

        sync()
        marksMap.observe(sync)

        // ydoc 텍스트 변경도 추적
        const xmlFragment = ydoc.getXmlFragment('prosemirror')
        const fragmentObserver = (): void => {
          console.log('[mark client] ydoc fragment changed, length:', xmlFragment.length, 'docSize:', view.state.doc.content.size)
        }
        xmlFragment.observeDeep(fragmentObserver)

        return {
          destroy() {
            marksMap.unobserve(sync)
            xmlFragment.unobserveDeep(fragmentObserver)
            if (activeView === view) activeView = null
          }
        }
      }
    })
  )
