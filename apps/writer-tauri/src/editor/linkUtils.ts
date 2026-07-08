// Shared helpers for link interaction code paths (Cmd+click, hover
// bar, etc.). Keeps the safe-scheme allowlist and the Tauri shell
// plumbing in one place so call sites don't drift.

import { open } from '@tauri-apps/plugin-shell'

import { notify } from '@/lib/notify'

const SAFE_SCHEMES = ['http://', 'https://', 'mailto:']

export function isSafeUrl(href: string): boolean {
  const lower = href.toLowerCase().trim()
  return SAFE_SCHEMES.some((s) => lower.startsWith(s))
}

/** Open `href` in the system browser if its scheme is on the allow
 * list. Returns false when the URL is rejected (caller can decide
 * whether to fall through). Surfaces a toast on Tauri shell failure. */
export function openLinkSafely(href: string): boolean {
  if (!isSafeUrl(href)) return false
  void open(href).catch(() => {
    notify.linkOpenFailed()
  })
  return true
}
