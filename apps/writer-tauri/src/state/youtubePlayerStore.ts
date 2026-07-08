// Bridge between a clicked transcript/summary timestamp and the mounted
// YouTube embed. The link-click plugin can't reach the embed directly
// (different React subtree), so it pushes a seek request here; the
// YoutubeEmbed for the matching video reacts to it (seeks if already
// playing, otherwise starts playing at that point).
//
// `nonce` makes repeated clicks on the SAME timestamp still fire the
// embed's effect — the request object changes identity each time.

import { create } from 'zustand'

interface YoutubePlayerState {
  pendingSeek: { videoId: string; sec: number; nonce: number } | null
  requestSeek: (videoId: string, sec: number) => void
}

let nonce = 0

export const useYoutubePlayerStore = create<YoutubePlayerState>((set) => ({
  pendingSeek: null,
  requestSeek: (videoId, sec) =>
    set({ pendingSeek: { videoId, sec, nonce: (nonce += 1) } }),
}))
