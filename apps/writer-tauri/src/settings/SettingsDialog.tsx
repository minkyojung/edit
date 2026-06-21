// The settings modal shell. Composes the reusable pieces into the Obsidian-style
// two-pane layout: a category rail on the left (SettingsNav) and the active panel on
// the right (ScrollArea). Mounted once at the app root; open-state lives in
// useSettingsDialog so any surface can open it.
//
// Dialog (Radix) gives us focus-trap, ESC-to-close, outside-click, and aria for free.
// We override the primitive's compact padding to fill the modal with the two panes.

import { useEffect } from 'react'
import {
  Dialog,
  DialogContent,
  DialogTitle,
} from '@/components/ui/dialog'
import { ScrollArea } from '@/components/ui/scroll-area'
import { openSettings, useSettingsDialog } from './useSettingsDialog'
import { SettingsNav } from './SettingsNav'
import { AppearanceSettings } from './categories/AppearanceSettings'
import { EditorSettings } from './categories/EditorSettings'
import { FilesSettings } from './categories/FilesSettings'
import { ConnectionsSettings } from './categories/ConnectionsSettings'

export function SettingsDialog() {
  const open = useSettingsDialog((s) => s.open)
  const setOpen = useSettingsDialog((s) => s.setOpen)
  // Active category lives in the store so deep links (openSettings('appearance'),
  // the command palette, future ⌘,-with-target) all land on the right pane.
  const active = useSettingsDialog((s) => s.category)
  const setActive = useSettingsDialog((s) => s.setCategory)

  // ⌘, opens settings — the de-facto macOS standard shortcut.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return
      if (e.shiftKey || e.altKey) return
      if (e.key === ',') {
        e.preventDefault()
        openSettings()
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [])

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="h-[86vh] max-h-[760px] w-[94vw] max-w-5xl gap-0 overflow-hidden rounded-2xl p-0 sm:max-w-5xl">
        <DialogTitle className="sr-only">Settings</DialogTitle>
        <div className="flex h-full">
          <SettingsNav active={active} onSelect={setActive} />
          <ScrollArea className="flex-1">
            <div className="px-6 py-5">
              {active === 'appearance' && <AppearanceSettings />}
              {active === 'editor' && <EditorSettings />}
              {active === 'files' && <FilesSettings />}
              {active === 'connections' && <ConnectionsSettings />}
            </div>
          </ScrollArea>
        </div>
      </DialogContent>
    </Dialog>
  )
}
