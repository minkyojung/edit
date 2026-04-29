/**
 * proofAuthored mark — 글자 단위 작성자 추적.
 *
 * proof-sdk의 schema를 우리 환경에 맞춰 가져온 버전.
 * attrs:
 *   - by:  "human:user" | "ai:copyeditor" | ...
 *   - id:  optional, 마크와 연결할 때 사용
 */
import { $markAttr, $markSchema } from '@milkdown/kit/utils'
import type { Attrs } from '@milkdown/kit/prose/model'

export const proofAuthoredAttr = $markAttr('proofAuthored', () => ({
  by: {},
  id: {}
}))

export const proofAuthoredSchema = $markSchema('proofAuthored', (ctx) => ({
  attrs: {
    by: { default: 'human:user' },
    id: { default: null }
  },
  inclusive: true,
  excludes: 'proofAuthored',
  spanning: true,
  parseDOM: [
    {
      tag: 'span[data-proof="authored"]',
      getAttrs: (dom: HTMLElement): Attrs => ({
        by: dom.getAttribute('data-by') || 'human:user',
        id: dom.getAttribute('data-proof-id') || null
      })
    }
  ],
  toDOM: (mark) => {
    void ctx
    return [
      'span',
      {
        'data-proof': 'authored',
        'data-by': mark.attrs.by,
        ...(mark.attrs.id ? { 'data-proof-id': mark.attrs.id } : {})
      },
      0
    ]
  },
  parseMarkdown: {
    match: () => false,
    runner: () => {}
  },
  toMarkdown: {
    match: (mark) => mark.type.name === 'proofAuthored',
    runner: () => false
  }
}))

