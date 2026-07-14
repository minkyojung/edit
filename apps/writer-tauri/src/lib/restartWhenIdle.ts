// "Restart when idle" — apply a staged update at the next safe moment
// instead of interrupting the user (the Conductor pattern). Armed from the
// update-ready toast; polls until it's safe, then relaunches into the
// already-downloaded + installed build.
//
// "Safe" = restarting now loses nothing and interrupts nothing:
//   - no in-flight chat run (a stream would be cut off),
//   - no unsaved edits (a dirty doc hasn't flushed to disk yet),
//   - the user hasn't touched the app for IDLE_MS (don't yank it mid-use).
//
// If the app is quit before it ever goes idle, the staged install applies on
// the next launch anyway — so arming is always safe; worst case is "applies a
// bit later" rather than "never".

import { useChatRuns } from '@/stores/chatRuns'
import { getDirtySlugs } from '@/lib/docFileSync'
import { updater } from '@/lib/updater'

/** No user input for this long → treated as idle. */
const IDLE_MS = 45_000
/** How often the armed monitor re-checks the safe conditions. */
const POLL_MS = 5_000

let lastActivity = Date.now()
let armed = false
let timer: ReturnType<typeof setInterval> | null = null
let activityBound = false

/** Lazily attach passive listeners that refresh `lastActivity` on any user
 * interaction. Bound only once, only when first armed (no cost otherwise). */
function bindActivity() {
  if (activityBound) return
  activityBound = true
  const mark = () => {
    lastActivity = Date.now()
  }
  for (const ev of ['pointerdown', 'keydown', 'wheel', 'mousemove'] as const) {
    window.addEventListener(ev, mark, { passive: true })
  }
}

/** True when restarting now won't disrupt anything (see file header). Pure
 * given the injected `now` + module signals — exported for reasoning/tests. */
export function canRestartNow(now = Date.now()): boolean {
  if (useChatRuns.getState().runs.size > 0) return false
  if (getDirtySlugs().length > 0) return false
  if (now - lastActivity < IDLE_MS) return false
  return true
}

function disarm() {
  armed = false
  if (timer) {
    clearInterval(timer)
    timer = null
  }
}

/** Arm "restart when idle": poll until {@link canRestartNow}, then relaunch
 * into the staged update. Idempotent (a second arm is a no-op). */
export function armRestartWhenIdle() {
  bindActivity()
  if (armed) return
  armed = true
  // Reset the idle clock so a click (which IS activity) doesn't count as idle.
  lastActivity = Date.now()
  timer = setInterval(() => {
    if (canRestartNow()) {
      disarm()
      void updater.install()
    }
  }, POLL_MS)
}

/** Whether a restart-when-idle is currently pending. */
export function isRestartArmed(): boolean {
  return armed
}
