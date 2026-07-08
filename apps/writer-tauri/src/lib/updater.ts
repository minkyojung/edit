import { check } from '@tauri-apps/plugin-updater'
import { relaunch } from '@tauri-apps/plugin-process'
import { toast } from 'sonner'

// How often to re-check after the initial startup check.
const CHECK_INTERVAL_MS = 60 * 60 * 1000 // 1 hour

// Guard so a slow check can't overlap with the next interval tick, and so a
// version we've already staged doesn't get downloaded / toasted twice.
let checking = false
let stagedVersion: string | null = null

/**
 * Check the GitHub Releases manifest for a newer signed build. If one exists,
 * download + install it in the background, then surface a non-blocking toast
 * offering an immediate restart. Ignoring the toast is fine — the staged
 * version applies on the next app launch.
 *
 * Failures (offline, no release yet, signature mismatch) are swallowed: the
 * next interval tick retries. The updater verifies the bundle signature
 * against the pubkey in tauri.conf.json before installing, so a tampered
 * manifest is discarded here, not surfaced.
 */
async function checkOnce(): Promise<void> {
  if (checking) return
  checking = true
  try {
    const update = await check()
    if (!update) return
    if (update.version === stagedVersion) return

    await update.downloadAndInstall()
    stagedVersion = update.version

    toast(`Octave ${update.version} ready`, {
      description: 'Restart to apply the update.',
      duration: Infinity,
      action: {
        label: 'Restart now',
        onClick: () => {
          void relaunch()
        },
      },
    })
  } catch (err) {
    // Best-effort: log for dogfooding telemetry, stay silent to the user.
    console.warn('[updater] check failed', err)
  } finally {
    checking = false
  }
}

/**
 * Start auto-update: one check shortly after launch, then hourly. Returns a
 * disposer (currently unused — the app lives for the whole process).
 */
export function startAutoUpdate(): () => void {
  // Defer the first check a few seconds so it never competes with cold-start
  // work (session restore, sidecar boot).
  const startTimer = setTimeout(() => void checkOnce(), 5000)
  const interval = setInterval(() => void checkOnce(), CHECK_INTERVAL_MS)
  return () => {
    clearTimeout(startTimer)
    clearInterval(interval)
  }
}
