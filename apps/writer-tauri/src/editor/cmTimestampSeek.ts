// CodeMirror: a plain click on a transcript/summary timestamp link seeks
// the embedded YouTube player (via youtubePlayerStore) instead of placing
// the caret or opening a browser tab. Cmd/Ctrl-click is left to linkClick
// (which opens the real video externally). Mirrors what the Milkdown
// linkClickPlugin does for the other editor.

import { EditorView } from '@codemirror/view'
import type { Extension } from '@codemirror/state'

import { linkAtPos } from '@/prototypes/linkNav'
import { parseYoutubeTimestampLink } from '@/lib/youtube'
import { useYoutubePlayerStore } from '@/state/youtubePlayerStore'

export const timestampSeekClick: Extension = EditorView.domEventHandlers({
  mousedown(event, view) {
    // Cmd/Ctrl-click falls through to linkClick → open in browser.
    if (event.metaKey || event.ctrlKey) return false
    const target = event.target as HTMLElement | null
    if (!target?.closest?.('.cm-link')) return false
    const pos = view.posAtCoords({ x: event.clientX, y: event.clientY })
    if (pos == null) return false
    const url = linkAtPos(view.state, pos)
    if (!url) return false
    const ts = parseYoutubeTimestampLink(url)
    if (!ts) return false
    event.preventDefault()
    useYoutubePlayerStore.getState().requestSeek(ts.videoId, ts.sec)
    return true
  },
})
