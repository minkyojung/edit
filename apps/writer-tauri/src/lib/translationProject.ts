// Scaffold for a fresh translation project.
//
// A translation project is just a folder with a translation-flavoured
// CLAUDE.md plus two directories:
//
//   <root>/
//   ├── CLAUDE.md      ← the "routing brain": tells the agent it is a
//   │                    translation apprentice and how to keep the bible
//   ├── manuscript/    ← source text + translation
//   └── bible/         ← the memory layer (decisions, terms, facts)
//
// Note on `bible/` (not `.bible/`): the bible is meant to be openable and
// editable by the translator — transparency is the trust story — so it is
// a visible folder, not a dot-hidden one.
//
// These helpers take an ABSOLUTE root and write straight through
// plugin-fs (not the active-vault helpers): the launcher window scaffolds
// a folder that is NOT its active vault — in fact the launcher has no
// active vault at all under the window-per-project model. Idempotent:
// every write is guarded by an existence check, so opening / re-scaffolding
// an existing translation folder never clobbers a translator's edited
// CLAUDE.md or decision log.

import { exists, mkdir, writeTextFile } from '@tauri-apps/plugin-fs'
import { join } from '@tauri-apps/api/path'

/** Translation-project CLAUDE.md. Scoped to the non-fiction beachhead
 * (self-help / essay): the load-bearing memory is terminology + voice
 * consistency, so the heavy fiction machinery (characters, worldbuilding,
 * entity resolution) is deliberately left out. The translator owns this
 * file after creation and is free to edit it. */
const TRANSLATION_CLAUDE_MD = `# Translation project

You assist a human literary translator. The translator holds the pen; you
are an apprentice. Your job is not to replace the translator but to
**remember every decision, enforce it consistently, and never lose it** —
so the work stays coherent across a long book.

## Project layout

- \`manuscript/\` — source text and its translation.
- \`bible/\` — the memory layer. Plain markdown the translator can read and
  edit at any time.
  - \`bible/decisions.md\` — **append-only** log of how a term, name, or
    style choice was translated. Every entry records **where** it was
    decided (chapter/section) and **why**. Never rewrite past entries.
  - \`bible/glossary.md\` — the current canonical translation for each
    recurring term or coined concept (a quick lookup view; decisions.md
    is the source of truth).

## How to work

1. **When a new chapter/section comes in**, read it and pull out anything
   that affects consistency: recurring terms, coined concepts, proper
   nouns, the author's voice (formality, sentence rhythm), and any choice
   a future chapter must match.
2. **Record decisions** by proposing additions to \`bible/decisions.md\`
   (append) and \`bible/glossary.md\`. Do not auto-write — propose, and let
   the translator approve.
3. **Before translating**, load \`bible/\` as context so terminology and
   voice stay consistent with earlier chapters.
4. **Consistency check**: when a new translation conflicts with a recorded
   decision ("earlier we used A, this is B"), flag it — do not silently
   pick one.
5. **When unsure** whether something is a new term or an existing one,
   ask the translator. Never guess-merge.

## Tools

Explore the project with the built-in Read / Glob / Grep tools — the
bible is markdown on disk, so grep finds past decisions without loading
the whole thing into context.
`

/** Initial decisions log. A short header so the file exists and the
 * append-only convention is visible from the first open. */
const DECISIONS_SEED = `# Decisions

Append-only log of translation decisions. Each entry: what was decided,
where (chapter/section), and why. Never rewrite past entries.

`

/** Initial glossary. */
const GLOSSARY_SEED = `# Glossary

Canonical translation for each recurring term. The source of truth is
\`decisions.md\`; this is the quick-lookup view.

`

/** Write `content` to `absPath` only if it doesn't already exist — guards
 * the scaffold against clobbering a translator's edits on re-run. */
async function writeIfAbsent(absPath: string, content: string): Promise<void> {
  if (!(await exists(absPath))) {
    await writeTextFile(absPath, content)
  }
}

/** Create the translation-project skeleton inside `root` (an absolute
 * folder path). Idempotent — safe to re-run on an existing project. */
export async function scaffoldTranslationProject(root: string): Promise<void> {
  await mkdir(await join(root, 'manuscript'), { recursive: true })
  await mkdir(await join(root, 'bible'), { recursive: true })

  await writeIfAbsent(await join(root, 'CLAUDE.md'), TRANSLATION_CLAUDE_MD)
  await writeIfAbsent(await join(root, 'bible', 'decisions.md'), DECISIONS_SEED)
  await writeIfAbsent(await join(root, 'bible', 'glossary.md'), GLOSSARY_SEED)
}

/** Heuristic: does this folder look like a translation project? Used by
 * "Open folder" to label/record the project type. A `bible/` directory is
 * the marker the scaffold always writes. */
export async function isTranslationProject(root: string): Promise<boolean> {
  return await exists(await join(root, 'bible'))
}
