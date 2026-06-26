// "Editor" settings panel — tune the editor's text column width + alignment.
// (The engine toggle was retired: CodeMirror is now the only editor.)

import { Button } from '@/components/ui/button'
import { useSettingsStore } from '@/state/settingsStore'
import { SettingRow } from '../SettingRow'

const COLUMN_WIDTHS = [650, 680, 700, 720] as const

export function EditorSettings() {
  const columnWidth = useSettingsStore((s) => s.editorColumnWidth)
  const setColumnWidth = useSettingsStore((s) => s.setEditorColumnWidth)
  const textAlign = useSettingsStore((s) => s.editorTextAlign)
  const setTextAlign = useSettingsStore((s) => s.setEditorTextAlign)

  return (
    <section>
      <h2 className="mb-2 text-body font-semibold text-foreground">Editor</h2>
      <SettingRow
        title="본문 너비"
        description="CodeMirror 에디터 본문 컬럼의 최대 너비(px). 클릭하면 바로 적용됩니다."
      >
        <div className="flex gap-1">
          {COLUMN_WIDTHS.map((w) => (
            <Button
              key={w}
              size="sm"
              variant={columnWidth === w ? 'default' : 'outline'}
              onClick={() => setColumnWidth(w)}
              aria-pressed={columnWidth === w}
            >
              {w}
            </Button>
          ))}
        </div>
      </SettingRow>
      <SettingRow
        title="정렬"
        description="양끝 정렬은 영어 단어를 하이픈으로 끊어 양쪽 끝을 맞춥니다. 좌측 정렬은 우측이 들쭉날쭉(ragged). 클릭하면 바로 적용됩니다."
      >
        <div className="flex gap-1">
          <Button
            size="sm"
            variant={textAlign === 'justify' ? 'default' : 'outline'}
            onClick={() => setTextAlign('justify')}
            aria-pressed={textAlign === 'justify'}
          >
            양끝
          </Button>
          <Button
            size="sm"
            variant={textAlign === 'left' ? 'default' : 'outline'}
            onClick={() => setTextAlign('left')}
            aria-pressed={textAlign === 'left'}
          >
            좌측
          </Button>
        </div>
      </SettingRow>
    </section>
  )
}
