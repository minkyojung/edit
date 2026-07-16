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
import { Button } from '@/components/ui/button'
import { seedStarterTemplates, STARTER_TEMPLATES_FOLDER } from '@/lib/templates'
import { SettingRow } from '../SettingRow'

export function FilesSettings() {
  const knownFolders = useDocsStore((s) => s.knownFolders)
  const createFolder = useDocsStore((s) => s.createFolder)
  const defaultNoteFolder = useSettingsStore((s) => s.defaultNoteFolder)
  const setDefaultNoteFolder = useSettingsStore((s) => s.setDefaultNoteFolder)
  const knowledgeBaseFolder = useSettingsStore((s) => s.knowledgeBaseFolder)
  const setKnowledgeBaseFolder = useSettingsStore((s) => s.setKnowledgeBaseFolder)
  const templatesFolder = useSettingsStore((s) => s.templatesFolder)
  const setTemplatesFolder = useSettingsStore((s) => s.setTemplatesFolder)
  const intakeModel = useSettingsStore((s) => s.intakeModel)
  const setIntakeModel = useSettingsStore((s) => s.setIntakeModel)
  const inboxAutoOrganize = useSettingsStore((s) => s.inboxAutoOrganize)
  const setInboxAutoOrganize = useSettingsStore((s) => s.setInboxAutoOrganize)
  const sandboxEnabled = useSettingsStore((s) => s.sandboxEnabled)
  const setSandboxEnabled = useSettingsStore((s) => s.setSandboxEnabled)
  const vaultPath = useSettingsStore((s) => s.vaultPaths[s.activeVaultIndex] ?? '')

  // Only real, user-facing folders belong in these pickers. Hide the
  // agent-owned `_system` tree and any other internal folder (any segment
  // starting with `_` or `.`) — you never file notes / knowledge / templates
  // into those.
  const isInternalFolder = (f: string) =>
    f.split('/').some((seg) => seg.startsWith('_') || seg.startsWith('.'))
  const realFolders = knownFolders.filter((f) => f && !isInternalFolder(f))

  // New-note / knowledge-base pickers keep their role defaults ('inbox', 'wiki')
  // plus the current value always selectable, so the control renders a choice
  // even before those (scaffolded) folders exist on disk.
  const roleOptions = [
    ...new Set(['inbox', 'wiki', defaultNoteFolder, knowledgeBaseFolder, ...realFolders]),
  ]
    .filter((f) => f && !isInternalFolder(f))
    .sort((a, b) => a.localeCompare(b))

  // Templates picker lists ONLY folders that actually exist. A not-yet-created
  // templates folder must not masquerade as real — the select shows a
  // placeholder until the user makes (or picks) a real folder, at which point
  // it appears here and reads as selected.
  const templateOptions = [...realFolders].sort((a, b) => a.localeCompare(b))

  // "Set up" is offered until a real templates folder is configured. One click
  // creates the folder, seeds the onboarding guide, and points the setting at
  // it — the editor picks it up live (CmEditor watches templatesFolder).
  const templatesConfigured = Boolean(templatesFolder) && realFolders.includes(templatesFolder)
  const onSetupTemplates = async () => {
    await createFolder(STARTER_TEMPLATES_FOLDER) // mkdir + knownFolders (picker/sidebar)
    await seedStarterTemplates() // guide page, skipped if present
    setTemplatesFolder(STARTER_TEMPLATES_FOLDER)
  }

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
            {roleOptions.map((f) => (
              <SelectItem key={f} value={f}>
                {f}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </SettingRow>
      <SettingRow
        title="Knowledge base folder"
        description="Where the agent files durable, synthesized knowledge (entity & topic pages). Injected into the AI each turn; changing it takes effect on the next message."
      >
        <Select value={knowledgeBaseFolder} onValueChange={setKnowledgeBaseFolder}>
          <SelectTrigger className="w-48">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {roleOptions.map((f) => (
              <SelectItem key={f} value={f}>
                {f}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </SettingRow>
      <SettingRow
        title="Templates folder"
        description="Where your template notes live. Their markdown feeds the editor's / menu (insert at cursor) and ⌘K's New from template. An empty or missing folder just shows no templates."
      >
        <div className="flex items-center gap-2">
          <Select value={templatesFolder} onValueChange={setTemplatesFolder}>
            <SelectTrigger className="w-48">
              <SelectValue placeholder="None yet" />
            </SelectTrigger>
            <SelectContent>
              {templateOptions.map((f) => (
                <SelectItem key={f} value={f}>
                  {f}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {!templatesConfigured && (
            <Button variant="outline" size="sm" onClick={onSetupTemplates}>
              Create folder
            </Button>
          )}
        </div>
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
      <SettingRow
        title="Keep background tasks alive (beta)"
        description="Keeps the AI's conversation running so long background tasks (like deep research) survive across turns instead of being cut off — and their result shows up on its own when done. Experimental; turn off if chat behaves oddly."
      >
        <Switch
          checked={persistentQueryEnabled}
          onCheckedChange={setPersistentQueryEnabled}
        />
      </SettingRow>
    </section>
  )
}
