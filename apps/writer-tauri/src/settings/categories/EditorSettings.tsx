// "Editor" settings panel — tune the editor's text alignment.
// (Body width is fixed at 750px; the engine toggle was retired: CodeMirror is
// now the only editor.)

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { useSettingsStore } from '@/state/settingsStore'
import { SettingRow } from '../SettingRow'

type TextAlign = 'justify' | 'left'

const ALIGN_OPTIONS: { value: TextAlign; label: string }[] = [
  { value: 'justify', label: 'Justify' },
  { value: 'left', label: 'Left' },
]

export function EditorSettings() {
  const textAlign = useSettingsStore((s) => s.editorTextAlign)
  const setTextAlign = useSettingsStore((s) => s.setEditorTextAlign)

  return (
    <section>
      <h2 className="mb-2 text-body font-semibold text-foreground">Editor</h2>
      <SettingRow
        title="Alignment"
        description="Justified alignment hyphenates words to align both edges; left alignment leaves the right edge ragged."
      >
        <Select
          value={textAlign}
          onValueChange={(v) => setTextAlign(v as TextAlign)}
        >
          <SelectTrigger size="sm" className="w-32">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {ALIGN_OPTIONS.map((o) => (
              <SelectItem key={o.value} value={o.value}>
                {o.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </SettingRow>
    </section>
  )
}
