// Set a media element's `src` to the vault-resolved asset URL.
//
// The block widgets store the RAW markdown src (`images/foo.png`, `videos/clip.mp4`),
// but the Tauri webview can only load filesystem files through the asset:// protocol.
// resolveVaultAssetSrc does that translation (absolute URLs — http/blob/data — pass
// through unchanged, so dev prototypes with remote URLs still work). It's async, so we
// token-guard: a stale resolve never overwrites a newer src, and re-setting the same
// raw src is a no-op (no reload). Mirrors the compare-and-skip the PM NodeViews use.

import { resolveVaultAssetSrc } from '@/editor/utils/resolveVaultAssetSrc'

type Tracked = { _wantSrc?: string }

export function setVaultAssetSrc(
  el: HTMLImageElement | HTMLMediaElement,
  rawSrc: string,
): void {
  const tracked = el as unknown as Tracked
  if (tracked._wantSrc === rawSrc) return
  tracked._wantSrc = rawSrc
  void resolveVaultAssetSrc(rawSrc).then((url) => {
    if (tracked._wantSrc !== rawSrc) return // a newer src superseded this resolve
    if (url) el.src = url
  })
}
