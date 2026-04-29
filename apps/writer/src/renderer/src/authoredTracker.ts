/**
 * 사용자 입력에 proofAuthored:human 마크를 자동 부여한다.
 *
 * 동작:
 *   1. handleTextInput  — 사용자 입력 시 위치만 기록 (pending)
 *   2. appendTransaction — transaction 끝에 한 번에 마크 적용
 *      'ai-authored' meta가 붙은 트랜잭션은 skip (Tab 수락 처리와 충돌 방지)
 *   3. handlePaste     — 붙여넣은 텍스트는 'unknown:pasted'로 마킹
 */
import { $prose } from '@milkdown/kit/utils'
import { Plugin, PluginKey } from '@milkdown/kit/prose/state'
import type { MarkType, Slice, Node as ProseMirrorNode } from '@milkdown/kit/prose/model'

const HUMAN_ACTOR = 'human:user'
const PASTE_ACTOR = 'unknown:pasted'

type PendingRange = { from: number; to: number; by: string }

const authoredTrackerKey = new PluginKey('proof-authored-tracker')

function getAuthoredMarkType(state: { schema: { marks: Record<string, MarkType> } }): MarkType | null {
  return state.schema.marks.proofAuthored ?? null
}

function sliceHasAuthoredMarks(slice: Slice, markType: MarkType): boolean {
  let found = false
  const visit = (node: ProseMirrorNode): void => {
    if (found) return
    if (node.isText && node.marks.some((m) => m.type === markType)) {
      found = true
      return
    }
    if (node.content && node.content.size > 0) node.content.forEach(visit)
  }
  slice.content.forEach(visit)
  return found
}

function mergeRanges(ranges: PendingRange[]): PendingRange[] {
  if (ranges.length <= 1) return ranges
  const sorted = [...ranges].sort((a, b) => a.from - b.from)
  const merged: PendingRange[] = [sorted[0]]
  for (let i = 1; i < sorted.length; i++) {
    const cur = sorted[i]
    const last = merged[merged.length - 1]
    if (last.by === cur.by && cur.from <= last.to + 2) {
      last.to = Math.max(last.to, cur.to)
    } else {
      merged.push({ ...cur })
    }
  }
  return merged
}

export const authoredTrackerPlugin = $prose(() => {
  let pending: PendingRange[] = []

  return new Plugin({
    key: authoredTrackerKey,

    props: {
      handleTextInput(_view, from, _to, text) {
        if (!text) return false
        pending.push({ from, to: from + text.length, by: HUMAN_ACTOR })
        return false
      },

      handlePaste(view, _event, slice) {
        const markType = getAuthoredMarkType(view.state)
        if (!markType) return false
        if (sliceHasAuthoredMarks(slice, markType)) return false

        const { from } = view.state.selection
        let tr = view.state.tr.replaceSelection(slice)
        const insertFrom = tr.mapping.map(from, -1)
        const insertTo = insertFrom + slice.size

        if (insertTo > insertFrom) {
          tr = tr.removeMark(insertFrom, insertTo, markType)
          tr = tr.addMark(insertFrom, insertTo, markType.create({ by: PASTE_ACTOR }))
        }
        tr = tr.setMeta('ai-authored', true)
        view.dispatch(tr)
        return true
      }
    },

    appendTransaction(transactions, _oldState, newState) {
      if (pending.length === 0) return null

      const markType = getAuthoredMarkType(newState)
      if (!markType) {
        pending = []
        return null
      }

      const docChanged = transactions.some((tr) => tr.docChanged)
      const skip = transactions.some(
        (tr) => tr.getMeta('ai-authored') || tr.getMeta('document-load')
      )

      if (!docChanged || skip) {
        pending = []
        return null
      }

      let tr = newState.tr
      const merged = mergeRanges(pending)
      const docSize = newState.doc.content.size

      for (const range of merged) {
        const from = Math.max(0, Math.min(range.from, docSize))
        const to = Math.max(from, Math.min(range.to, docSize))
        if (to <= from) continue
        tr = tr.removeMark(from, to, markType)
        tr = tr.addMark(from, to, markType.create({ by: range.by }))
      }
      pending = []

      if (tr.steps.length === 0) return null
      return tr.setMeta('ai-authored', true)
    }
  })
})
