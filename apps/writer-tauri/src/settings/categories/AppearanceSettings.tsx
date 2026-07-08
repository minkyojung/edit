// "Appearance" settings panel — theme palette + UI font. These used to live in the
// sidebar account dropdown; they're settings, so they belong in the modal. The option
// data and swatch moved here with them (the dropdown no longer references them).

import { useTheme, type Palette } from '@/components/theme-provider'
import { useFont, type FontOption } from '@/components/font-provider'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { invoke } from '@tauri-apps/api/core'
import { IconVolume } from '@tabler/icons-react'
import { useSettingsStore, type NotificationSound } from '@/state/settingsStore'
import { SettingRow } from '../SettingRow'

/** Preview a sound through the Rust `afplay` command. No-op for the silent
 * option. Best-effort — a failed preview never surfaces. */
function previewSound(sound: NotificationSound) {
  if (sound === 'None') return
  void invoke('play_system_sound', { name: sound }).catch(() => {})
}

// Vibrancy is a macOS-only window effect; hide the toggle elsewhere.
const IS_MAC = typeof navigator !== 'undefined' && /Mac/i.test(navigator.userAgent)

type PaletteOption = {
  value: Palette
  label: string
  swatch: { bg: string; fg: string; border: string }
}

const PALETTE_OPTIONS: PaletteOption[] = [
  { value: 'dark', label: 'Dark', swatch: { bg: '#252525', fg: '#ECECEC', border: '#3A3A3A' } },
  { value: 'light', label: 'Light', swatch: { bg: '#FFFFFF', fg: '#1A1A1A', border: '#D2D2D2' } },
  { value: 'graphite', label: 'Graphite', swatch: { bg: '#1D2024', fg: '#ECECEE', border: '#383940' } },
]

type FontOptionDef = {
  value: FontOption
  label: string
  /** Inline font-family so each row previews its own typeface. */
  preview: string
}

const FONT_OPTIONS: FontOptionDef[] = [
  { value: 'pretendard', label: 'Pretendard', preview: "'Pretendard Variable', sans-serif" },
  { value: 'geist', label: 'Geist', preview: "'Geist Variable', sans-serif" },
  { value: 'nunito', label: 'Nunito Sans', preview: "'Nunito Sans Variable', sans-serif" },
]

// Completion-notification sounds — macOS system sound names, plus a silent
// option. 'Glass' is the default familiar chime.
const SOUND_OPTIONS: { value: NotificationSound; label: string }[] = [
  { value: 'Glass', label: 'Glass' },
  { value: 'Ping', label: 'Ping' },
  { value: 'Pop', label: 'Pop' },
  { value: 'Bottle', label: 'Bottle' },
  { value: 'Sosumi', label: 'Sosumi' },
  { value: 'None', label: 'None (silent)' },
]

function PaletteSwatch({ swatch }: { swatch: PaletteOption['swatch'] }) {
  return (
    <span
      className="inline-flex size-4 shrink-0 items-center justify-center overflow-hidden rounded-full"
      style={{ backgroundColor: swatch.bg, boxShadow: `inset 0 0 0 1px ${swatch.border}` }}
      aria-hidden
    >
      <span className="block size-2 rounded-full" style={{ backgroundColor: swatch.fg }} />
    </span>
  )
}

export function AppearanceSettings() {
  const { palette, setPalette } = useTheme()
  const { font, setFont } = useFont()
  const vibrancy = useSettingsStore((s) => s.sidebarVibrancyEnabled)
  const setVibrancy = useSettingsStore((s) => s.setSidebarVibrancy)
  const notifSound = useSettingsStore((s) => s.notificationSound)
  const setNotifSound = useSettingsStore((s) => s.setNotificationSound)

  return (
    <section>
      <h2 className="mb-2 text-body font-semibold text-foreground">Appearance</h2>
      <SettingRow title="Theme" description="The color palette for the whole app.">
        <Select value={palette} onValueChange={(v) => setPalette(v as Palette)}>
          <SelectTrigger className="w-48">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {PALETTE_OPTIONS.map((o) => (
              <SelectItem key={o.value} value={o.value}>
                <span className="flex items-center gap-2">
                  <PaletteSwatch swatch={o.swatch} />
                  {o.label}
                </span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </SettingRow>
      <SettingRow title="Font" description="The typeface used across the interface.">
        <Select value={font} onValueChange={(v) => setFont(v as FontOption)}>
          <SelectTrigger className="w-48">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {FONT_OPTIONS.map((o) => (
              <SelectItem key={o.value} value={o.value} style={{ fontFamily: o.preview }}>
                {o.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </SettingRow>
      {IS_MAC && (
        <SettingRow
          title="Sidebar vibrancy"
          description="Frosted translucent sidebar that blends with the desktop behind the window."
        >
          <Switch
            checked={vibrancy}
            onCheckedChange={setVibrancy}
            aria-label="Toggle sidebar vibrancy"
          />
        </SettingRow>
      )}
      {IS_MAC && (
        <SettingRow
          title="Completion sound"
          description="Sound played when a background chat job finishes (only while the app is unfocused)."
        >
          <div className="flex items-center gap-1.5">
            <Select
              value={notifSound}
              onValueChange={(v) => {
                const sound = v as NotificationSound
                setNotifSound(sound)
                previewSound(sound) // hear it the moment you pick it
              }}
            >
              <SelectTrigger className="w-40">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {SOUND_OPTIONS.map((o) => (
                  <SelectItem key={o.value} value={o.value}>
                    {o.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {/* Replay the current sound (re-selecting the same value won't fire
                onValueChange, so this is how you hear it again). */}
            <button
              type="button"
              onClick={() => previewSound(notifSound)}
              disabled={notifSound === 'None'}
              aria-label="Play sound"
              className="shrink-0 rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
            >
              <IconVolume size={16} stroke={1.5} />
            </button>
          </div>
        </SettingRow>
      )}
    </section>
  )
}
