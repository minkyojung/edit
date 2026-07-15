/**
 * appNavigate — a module-level bridge to React Router's `navigate`, so code
 * OUTSIDE the React tree (CodeMirror keymaps, chat tool renderers) can drive
 * routing THROUGH the router instead of assigning `window.location.hash`
 * raw. Setting the hash directly doesn't update React Router's `useLocation`
 * synchronously, which is the exact class of race that dropped the restored
 * doc on boot — routing all navigation through one bridge closes it.
 *
 * A single top-level component calls `setAppNavigate(navigate)` once on mount
 * (see RouteSyncBridge). Before that — or if the router unmounts — calls fall
 * back to `window.location.hash` so boot-time / edge navigations still work.
 */

export type AppNavigateFn = (to: string, opts?: { replace?: boolean }) => void

let bridged: AppNavigateFn | null = null

/** Wire the live React Router navigate into the bridge (or clear it on
 * unmount with `null`). Idempotent. */
export function setAppNavigate(fn: AppNavigateFn | null): void {
  bridged = fn
}

/** Navigate to `to` through React Router when the bridge is live, else fall
 * back to the raw hash (pre-mount). Callers pass router-shaped paths
 * (`/day/<date>/<slug>`), never `#`-prefixed. */
export function appNavigate(to: string, opts?: { replace?: boolean }): void {
  if (bridged) {
    bridged(to, opts)
  } else {
    window.location.hash = to
  }
}
