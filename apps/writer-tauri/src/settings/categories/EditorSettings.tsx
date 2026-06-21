// "Editor" settings panel — pick the editor engine. The default Milkdown
// (ProseMirror) editor vs the experimental CodeMirror editor. This is a
// dogfooding gate while the ProseMirror→CodeMirror migration is evaluated;
// the choice persists (cmEditorEnabled) and takes effect on reload.

import { Switch } from '@/components/ui/switch'
import { useSettingsStore } from '@/state/settingsStore'
import { SettingRow } from '../SettingRow'

export function EditorSettings() {
  const cmEnabled = useSettingsStore((s) => s.cmEditorEnabled)
  const setCmEnabled = useSettingsStore((s) => s.setCmEditorEnabled)

  return (
    <section>
      <h2 className="mb-2 text-base font-semibold text-foreground">Editor</h2>
      <SettingRow
        title="CodeMirror 에디터 (실험)"
        description="켜면 새 CodeMirror 에디터를 사용합니다. 변경하면 앱이 새로고침됩니다."
      >
        <Switch
          checked={cmEnabled}
          onCheckedChange={(v) => {
            setCmEnabled(v)
            location.reload()
          }}
          aria-label="Toggle CodeMirror editor"
        />
      </SettingRow>
    </section>
  )
}
