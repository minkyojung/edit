// "Files & Notes" settings panel. Hosts the default new-note folder — the dial behind
// the host-forced placement (toPendingChange → createGenericNote). Changing it here
// changes where new chat notes land, immediately and persistently.

import { useDocsStore } from '@/state/docsStore'
import { useSettingsStore } from '@/state/settingsStore'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { SettingRow } from '../SettingRow'

export function FilesSettings() {
  const knownFolders = useDocsStore((s) => s.knownFolders)
  const defaultNoteFolder = useSettingsStore((s) => s.defaultNoteFolder)
  const setDefaultNoteFolder = useSettingsStore((s) => s.setDefaultNoteFolder)
  const vaultPath = useSettingsStore((s) => s.vaultPaths[s.activeVaultIndex] ?? '')

  // Options: every real folder, plus 'inbox' (the default landing zone) and the current
  // value — so the select always shows a valid, selectable current choice.
  const options = [...new Set(['inbox', defaultNoteFolder, ...knownFolders])]
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b))

  return (
    <section>
      <h2 className="mb-2 text-base font-semibold text-foreground">Files &amp; Notes</h2>
      <SettingRow title="Vault" description="The folder your notes live in.">
        <span
          className="block max-w-[20rem] truncate font-mono text-xs text-muted-foreground"
          title={vaultPath}
        >
          {vaultPath || 'Not set'}
        </span>
      </SettingRow>
      <SettingRow
        title="New note folder"
        description="Where notes created from chat are placed. The model's chosen folder is ignored."
      >
        <Select value={defaultNoteFolder} onValueChange={setDefaultNoteFolder}>
          <SelectTrigger className="w-48">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {options.map((f) => (
              <SelectItem key={f} value={f}>
                {f}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </SettingRow>
    </section>
  )
}
