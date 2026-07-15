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
  /** User-facing release notes, markdown. */
  notes: string
}

/** Newest first. The entry whose `version` equals the running app version is
 * what the "What's new" panel shows after an update. */
export const CHANGELOG: ChangelogEntry[] = [
  {
    version: '0.0.7',
    date: '2026-07-14',
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
      '### A richer chat composer',
      '',
      '- Inline file chips, plus **/** slash and **@** mention menus as you type.',
      '',
      '### Steadier notes',
      '',
      '- Renaming a note now **rewrites links to it across the whole vault**.',
      '- Moving or renaming a note outside the app keeps your open tab in sync.',
      '- A batch of save-safety fixes so edits are never lost during saves, external changes, or updates.',
      '',
      '### Under the hood',
      '',
      '- App bookkeeping moved into a hidden `.octave/` folder, keeping your vault a clean folder of just your notes.',
    ].join('\n'),
  },
  {
    version: '0.0.6',
    date: '2026-07-13',
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
    notes: [
      '- The update prompt is now a single notice that flows from *available* to *ready* in place, instead of two separate toasts.',
    ].join('\n'),
  },
  {
    version: '0.0.4',
    date: '2026-07-13',
    notes: ['- Rounder window corners on macOS 26.'].join('\n'),
  },
  {
    version: '0.0.3',
    date: '2026-07-13',
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
