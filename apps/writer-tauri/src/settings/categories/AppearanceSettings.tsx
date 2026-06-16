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
import { SettingRow } from '../SettingRow'

type PaletteOption = {
  value: Palette
  label: string
  swatch: { bg: string; fg: string; border: string }
}

const PALETTE_OPTIONS: PaletteOption[] = [
  { value: 'charcoal', label: 'Charcoal', swatch: { bg: '#141414', fg: '#ECECEC', border: '#333333' } },
  { value: 'graphite', label: 'Graphite', swatch: { bg: '#1D2024', fg: '#ECECEE', border: '#383940' } },
  { value: 'olive', label: 'Olive', swatch: { bg: '#111001', fg: '#E8E4D0', border: '#3A3520' } },
  { value: 'paper', label: 'Paper', swatch: { bg: '#D2D2D2', fg: '#1A1A1A', border: '#A8A8A8' } },
  { value: 'mist', label: 'Mist', swatch: { bg: '#E9EAEC', fg: '#1D2024', border: '#B8BABE' } },
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

  return (
    <section>
      <h2 className="mb-2 text-base font-semibold text-foreground">Appearance</h2>
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
    </section>
  )
}
