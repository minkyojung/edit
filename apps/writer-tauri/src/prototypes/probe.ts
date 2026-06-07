// Throwaway layout probe: mounts the REAL livePreview + cmTheme on a tiny list
// doc so a headless browser can screenshot the actual rendered layout. Not wired
// anywhere; served standalone at /probe.html during dev. Delete after debugging.
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { markdown } from '@codemirror/lang-markdown'
import { GFM } from '@lezer/markdown'
import { livePreview } from './livePreview'
import { cmPrototypeTheme } from './cmTheme'

const doc = `일반본문 단락입니다. 기준선을 보기 위한 문장.

- 불렛
- 두 번째 불렛은 아주 길어서 줄바꿈이 일어날 정도로 길게 작성한 문장입니다 그래서 다음 줄로 자연스럽게 넘어갑니다
- 셋째 불렛

1. 숫자 하나
2. 숫자 둘
10. 숫자 열

- [ ] 체크박스 미완료
- [x] 체크박스 완료
`

new EditorView({
  parent: document.getElementById('app')!,
  state: EditorState.create({
    doc,
    extensions: [
      EditorView.lineWrapping,
      markdown({ extensions: [GFM], addKeymap: false }),
      livePreview,
      cmPrototypeTheme,
    ],
  }),
})
