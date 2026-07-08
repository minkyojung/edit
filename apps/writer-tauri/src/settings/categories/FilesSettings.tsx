// "Files & Notes" settings panel. Hosts the default new-note folder — the dial behind
// the host-forced placement (toPendingChange → createGenericNote). Changing it here
// changes where new chat notes land, immediately and persistently.

import { useDocsStore } from '@/state/docsStore'
import { useSettingsStore } from '@/state/settingsStore'
import { CHAT_MODELS, CHAT_MODEL_LABELS, type ChatModel } from '@/chat/types'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { SettingRow } from '../SettingRow'

export function FilesSettings() {
  const knownFolders = useDocsStore((s) => s.knownFolders)
  const defaultNoteFolder = useSettingsStore((s) => s.defaultNoteFolder)
  const setDefaultNoteFolder = useSettingsStore((s) => s.setDefaultNoteFolder)
  const intakeModel = useSettingsStore((s) => s.intakeModel)
  const setIntakeModel = useSettingsStore((s) => s.setIntakeModel)
  const inboxAutoOrganize = useSettingsStore((s) => s.inboxAutoOrganize)
  const setInboxAutoOrganize = useSettingsStore((s) => s.setInboxAutoOrganize)
  const sandboxEnabled = useSettingsStore((s) => s.sandboxEnabled)
  const setSandboxEnabled = useSettingsStore((s) => s.setSandboxEnabled)
  const vaultPath = useSettingsStore((s) => s.vaultPaths[s.activeVaultIndex] ?? '')

  // Options: every real folder, plus 'inbox' (the default landing zone) and the current
  // value — so the select always shows a valid, selectable current choice.
  const options = [...new Set(['inbox', defaultNoteFolder, ...knownFolders])]
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b))

  return (
    <section>
      <h2 className="mb-2 text-body font-semibold text-foreground">Files &amp; Notes</h2>
      <SettingRow title="Vault" description="The folder your notes live in.">
        <span
          className="block max-w-[20rem] truncate font-mono text-footnote text-muted-foreground"
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
      <SettingRow
        title="Organize model"
        description="Model used when Organize files notes into the wiki/daily. Haiku is cheaper for bulk passes; Opus is highest quality."
      >
        <Select value={intakeModel} onValueChange={(v) => setIntakeModel(v as ChatModel)}>
          <SelectTrigger className="w-48">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {CHAT_MODELS.map((m) => (
              <SelectItem key={m} value={m}>
                {CHAT_MODEL_LABELS[m]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </SettingRow>
      <SettingRow
        title="Auto-organize inbox"
        description="When you pause (~1 min idle), file new inbox captures into the wiki and move them to their folder — the same as clicking Organize. Only runs when there are new captures."
      >
        <Switch
          checked={inboxAutoOrganize}
          onCheckedChange={setInboxAutoOrganize}
        />
      </SettingRow>
      <SettingRow
        title="Protect secrets & block data exfiltration"
        description="Stops the AI from sending data to the internet or reading secret files (SSH keys, tokens, credentials) — so a malicious instruction hidden in a captured web page or transcript can't leak your data. Leave on unless you know you need it off."
      >
        <Switch checked={sandboxEnabled} onCheckedChange={setSandboxEnabled} />
      </SettingRow>
    </section>
  )
}
