// "General" settings panel. Minimal for now — the vault path (read-only display). Add
// real General settings here as SettingRows over time.

import { useSettingsStore } from '@/state/settingsStore'
import { SettingRow } from '../SettingRow'

export function GeneralSettings() {
  const vaultPath = useSettingsStore((s) => s.vaultPaths[s.activeVaultIndex] ?? '')
  return (
    <section>
      <h2 className="mb-2 text-base font-semibold text-foreground">General</h2>
      <SettingRow title="Vault" description="The folder your notes live in.">
        <span
          className="block max-w-[20rem] truncate font-mono text-xs text-muted-foreground"
          title={vaultPath}
        >
          {vaultPath || 'Not set'}
        </span>
      </SettingRow>
    </section>
  )
}
