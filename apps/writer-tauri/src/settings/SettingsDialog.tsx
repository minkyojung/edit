// The settings modal shell. Composes the reusable pieces into the Obsidian-style
// two-pane layout: a category rail on the left (SettingsNav) and the active panel on
// the right (ScrollArea). Mounted once at the app root; open-state lives in
// useSettingsDialog so any surface can open it.
//
// Dialog (Radix) gives us focus-trap, ESC-to-close, outside-click, and aria for free.
// We override the primitive's compact padding to fill the modal with the two panes.

import { useState } from 'react'
import {
  Dialog,
  DialogContent,
  DialogTitle,
} from '@/components/ui/dialog'
import { ScrollArea } from '@/components/ui/scroll-area'
import { useSettingsDialog } from './useSettingsDialog'
import { SettingsNav, type SettingsCategory } from './SettingsNav'
import { GeneralSettings } from './categories/GeneralSettings'
import { AppearanceSettings } from './categories/AppearanceSettings'
import { FilesSettings } from './categories/FilesSettings'

export function SettingsDialog() {
  const open = useSettingsDialog((s) => s.open)
  const setOpen = useSettingsDialog((s) => s.setOpen)
  const [active, setActive] = useState<SettingsCategory>('general')

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="h-[86vh] max-h-[760px] w-[94vw] max-w-5xl gap-0 overflow-hidden rounded-2xl p-0 sm:max-w-5xl">
        <DialogTitle className="sr-only">Settings</DialogTitle>
        <div className="flex h-full">
          <SettingsNav active={active} onSelect={setActive} />
          <ScrollArea className="flex-1">
            <div className="px-6 py-5">
              {active === 'general' && <GeneralSettings />}
              {active === 'appearance' && <AppearanceSettings />}
              {active === 'files' && <FilesSettings />}
            </div>
          </ScrollArea>
        </div>
      </DialogContent>
    </Dialog>
  )
}
