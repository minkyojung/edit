// App-owned release notes. Bundled with the binary (like the CLAUDE.md
// schema), so "what's new" ships with each update and is always available
// offline — no network, no GitHub API. Add one entry per release, newest
// first, with the version matching `tauri.conf.json` / the git tag.
//
// `notes` is plain markdown, rendered read-only by <ReleaseNotes>. Keep it
// short and user-facing (what changed, why it matters) — not a commit log.

export interface ChangelogEntry {
  /** SemVer, matching the release tag (no leading `v`). */
  version: string
  /** Human date `YYYY-MM-DD` (display only). */
  date?: string
  /** The single most important thing this release brings — one plain line,
   * shown as the sidebar teaser. Clicking opens the full `notes`. */
  headline: string
  /** User-facing release notes, markdown (shown on the What's-new page). */
  notes: string
}

/** Newest first. The entry whose `version` equals the running app version is
 * what the "What's new" panel shows after an update. */
export const CHANGELOG: ChangelogEntry[] = [
  {
    version: '0.0.10',
    date: '2026-07-22',
    headline: 'IME typing in lists, and steadier tables.',
    notes: [
      '### Typing with an IME in lists',
      '',
      '- Pressing Enter after typing in an IME language (such as Korean) in a bulleted or numbered list now starts a new item, instead of just a plain line break.',
      '- A list marker renders the moment you stop composing, rather than staying raw until your next keystroke.',
      '',
      '### Steadier tables',
      '',
      '- Cell edits save the instant you make them, closing a window where text you just deleted could reappear.',
      "- Rendered tables are now deletable: press Backspace or Delete at a table's edge to select it, then again to remove it.",
      '- Removing the last remaining column deletes the whole table, instead of leaving an empty shell behind.',
      '',
      '### Sidebar',
      '',
      '- Your Google profile picture shows in the sidebar again, instead of falling back to a generic icon.',
      '- The tag filter pane is gone for now while it gets redesigned.',
    ].join('\n'),
  },
  {
    version: '0.0.9',
    date: '2026-07-20',
    headline: 'A properties panel you can reorder, rename, and fill in.',
    notes: [
      '### A properties panel, like Notion',
      '',
      "- Every frontmatter field now shows as an editable row between a note's title and body, in the order they appear in the file.",
      '- Drag rows by the handle to reorder them — the new order is saved right into your note.',
      '- Rename or delete a property from its name menu, and add new ones with **Add a property**.',
      '- Values edit in place: a status badge, tag chips, a read toggle, and custom fields that pick their own editor — a list becomes chips, `true`/`false` a switch, everything else a text box.',
      '',
      '### Steadier metadata',
      '',
      '- Notes now use the standard `created` and `source` field names, migrated automatically the next time each note is saved.',
      "- Status and tags always stay put and can't be removed by accident, and digit-only property names are turned away so your row order never shuffles.",
    ].join('\n'),
  },
  {
    version: '0.0.7',
    date: '2026-07-14',
    headline: 'Smarter updates, note templates, and a calmer chat.',
    notes: [
      '### Updates, handled for you',
      '',
      "- New versions download quietly in the background. When one's ready you get a single prompt — **See changes**, **Restart when idle**, or **Restart** — so an update never interrupts what you're doing.",
      "- After updating, a **What's new** card (this one) slides in at the bottom of the sidebar.",
      '',
      '### Templates',
      '',
      '- Create notes from your own **markdown templates** with `{{variable}}` placeholders — one-click setup, then insert from the slash menu.',
      '',
      '### A calmer chat',
      '',
      '- Sending a message now pins it to the top and reads top-down, so the transcript no longer jumps or flickers as the answer streams in.',
      '- A richer composer: inline file chips, plus **/** slash and **@** mention menus as you type.',
      "- When you reject a suggested edit or one can't apply, the assistant is told — so it adjusts instead of repeating the same change.",
      '',
      '### Steadier notes',
      '',
      '- Renaming a note now **rewrites links to it across the whole vault**.',
      '- Moving or renaming a note outside the app keeps your open tab in sync.',
      '- A batch of save-safety fixes so edits are never lost during saves, external changes, or updates.',
      '',
      '### Under the hood',
      '',
      '- App bookkeeping moved into a hidden `.octave/` folder — and old chat-storage folders are hidden from the sidebar — keeping your vault a clean folder of just your notes.',
    ].join('\n'),
  },
  {
    version: '0.0.6',
    date: '2026-07-13',
    headline: 'Updates download in the background and explain themselves.',
    notes: [
      '### Updates that explain themselves',
      '',
      "- Updates now download quietly in the background — you'll just see a **Restart to update** prompt when one's ready, no download button or progress to babysit.",
      '- After updating, this **What’s new** note tells you what changed.',
      '- Settings ▸ **About** shows your version and lets you check for updates anytime.',
    ].join('\n'),
  },
  {
    version: '0.0.5',
    date: '2026-07-13',
    headline: 'The update prompt is one notice that flows in place.',
    notes: [
      '- The update prompt is now a single notice that flows from *available* to *ready* in place, instead of two separate toasts.',
    ].join('\n'),
  },
  {
    version: '0.0.4',
    date: '2026-07-13',
    headline: 'Rounder window corners on macOS 26.',
    notes: ['- Rounder window corners on macOS 26.'].join('\n'),
  },
  {
    version: '0.0.3',
    date: '2026-07-13',
    headline: 'Auto-update is now reliable and shows its status.',
    notes: [
      '- Auto-update is now reliable and visible: failures surface instead of failing silently, and Settings ▸ About shows the current status.',
    ].join('\n'),
  },
]

/** The changelog entry for `version`, or null when none is authored (e.g. a
 * dev/local build whose version isn't in the shipped list). */
export function changelogFor(version: string): ChangelogEntry | null {
  return CHANGELOG.find((e) => e.version === version) ?? null
}
