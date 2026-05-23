// Shared src resolution for every card-type NodeView (inline image,
// block imageBlock, videoBlock, future audioBlock, …). The commonmark
// preset stores the markdown `src` verbatim — `images/foo.jpg` for a
// vault-relative reference, `videos/clip.mp4` for a video, or a full
// URL when the assistant embeds one — but Tauri's webview only loads
// filesystem files through the asset protocol. This helper is the
// one place that knows about that translation:
//
//   `images/foo.jpg`  →  <vault-root>/images/foo.jpg  →  asset URL
//   `videos/clip.mp4` →  <vault-root>/videos/clip.mp4 →  asset URL
//
// Markdown source stays portable (vim, grep, git, Obsidian all see
// the relative path); the asset URL only materialises in the DOM.

import { convertFileSrc } from '@tauri-apps/api/core'
import { join } from '@tauri-apps/api/path'
import { getActiveVaultPath } from '@/state/settingsStore'

const ABSOLUTE_URL_RE = /^[a-z][a-z0-9+.-]*:/i

/**
 * Resolve a raw markdown `src` to a URL the WebView can load.
 *
 *   - Absolute URLs (http, https, data, blob, …) pass through.
 *   - Vault-relative paths resolve to the asset:// protocol URL.
 *   - Returns null when no vault is selected — caller should clear the
 *     element's src attribute and wait for a future update tick.
 *
 * Always async so callers have one shape to handle; the absolute-URL
 * fast path still goes through the microtask queue but doesn't touch
 * disk. NodeViews must compare-and-skip with a local `lastSrc` ref so
 * a stale resolve doesn't overwrite a newer one.
 */
export async function resolveVaultAssetSrc(
  rawSrc: string,
): Promise<string | null> {
  if (ABSOLUTE_URL_RE.test(rawSrc)) return rawSrc
  const vaultPath = getActiveVaultPath()
  if (!vaultPath) return null
  const abs = await join(vaultPath, rawSrc)
  return convertFileSrc(abs)
}
