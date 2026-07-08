// OS-level (macOS Notification Center) completion pings, via the Tauri
// notification plugin. Distinct from `lib/notify` (in-app sonner toasts): this
// reaches the user when they've left the app.
//
// Gate: fire ONLY while the app window is unfocused. If the user is in the app,
// the running-tab status + transcript already surface completion, so an OS
// notification would just be noise. Best-effort throughout — notifications are
// non-critical, so a missing permission (or the plugin being inert in dev) is
// swallowed silently.
//
// macOS caveat: notifications are only delivered from a registered `.app`
// bundle. Under `tauri dev` they typically won't appear — test in a built app.

import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from '@tauri-apps/plugin-notification'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { useSettingsStore } from '@/state/settingsStore'

/** Notify that a background chat job finished. No-op when the window is focused
 * (the user is watching) or permission is denied. */
export async function notifyJobDone(title: string, body?: string): Promise<void> {
  try {
    if (await getCurrentWindow().isFocused()) return
    let granted = await isPermissionGranted()
    if (!granted) granted = (await requestPermission()) === 'granted'
    if (!granted) return
    // Sound is user-configurable (Settings → Appearance). 'None' → silent; any
    // other value is a macOS system-sound name (file in /System/Library/Sounds).
    const choice = useSettingsStore.getState().notificationSound
    sendNotification({ title, body, sound: choice === 'None' ? undefined : choice })
  } catch {
    // best-effort — never let a notification failure affect the run
  }
}
