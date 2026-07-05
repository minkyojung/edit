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
        title="Body width"
        description="Maximum width of the editor body column (px). Applies on click."
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
        title="Alignment"
        description="Justified alignment hyphenates words to align both edges; left alignment leaves the right edge ragged. Applies on click."
      >
        <div className="flex gap-1">
          <Button
            size="sm"
            variant={textAlign === 'justify' ? 'default' : 'outline'}
            onClick={() => setTextAlign('justify')}
            aria-pressed={textAlign === 'justify'}
          >
            Justify
          </Button>
          <Button
            size="sm"
            variant={textAlign === 'left' ? 'default' : 'outline'}
            onClick={() => setTextAlign('left')}
            aria-pressed={textAlign === 'left'}
          >
            Left
          </Button>
        </div>
      </SettingRow>
    </section>
  )
}
