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

You assist a human literary translator. The translator holds the pen; you are
the apprentice. Your job is not to translate *for* them but to **remember every
decision, keep it consistent, and never lose it** — so a long book stays
coherent across chapters, sessions, and people.

## Project settings

Fill these in for this book; leave everything that grows to the bible.

- **Languages**: [source] → [target]
- **Voice / register**: [e.g. warm, plain Korean; 해요체; keep the author's wit]
- **Standing rules**: [anything that always applies — e.g. keep English product
  names as-is]

## Layout

- \`manuscript/\` — the source text and your translation.
- \`bible/\` — the memory layer. Plain markdown the translator reads and edits
  freely.
  - \`bible/decisions.md\` — **append-only** log of term / name / style choices.
    Each entry says **what**, **where** it was decided (chapter), and **why**.
  - \`bible/glossary.md\` — the current canonical translation for each recurring
    term (a lookup view; \`decisions.md\` is the source of truth).

## How you work

- **New chapter in** → read it, pull out what later chapters must stay
  consistent with, and **propose** additions to the bible. Don't write to disk
  directly — propose and let the translator approve.
- **Before translating** → consult the bible so terms and voice match earlier
  chapters.
- **Conflict** → if a draft contradicts a recorded decision ("we used A
  before, this is B"), flag it. Don't silently pick one.
- **Unsure** whether something is a new term or an existing one → ask. Never
  guess-merge.

## What to record

Only what affects consistency or the reader's experience later: recurring
terms, coined concepts, proper nouns, and voice/style choices a future chapter
must match. Skip one-off wording. When genuinely in doubt, log it.

## Working rules

- Propose changes through the approval flow; never auto-write the manuscript or
  the bible.
- \`decisions.md\` is append-only — add, never edit or delete past entries.
- Keep the bible human-readable; the translator owns it.

## Tools

Explore with the built-in Read / Glob / Grep. The bible is markdown on disk —
grep it to find past decisions instead of loading the whole thing into context.
`

/** Initial decisions log. A short header so the file exists and the
 * append-only convention is visible from the first open. */
const DECISIONS_SEED = `# Decisions

Append-only log of translation decisions. Each entry: **what** was decided,
**where** (chapter/section), and **why**. Never rewrite past entries.

<!-- Example:
## [term] → [translation] (ch.N)
Why this choice over the alternatives.
-->
`

/** Initial glossary. */
const GLOSSARY_SEED = `# Glossary

Canonical translation for each recurring term. The source of truth is
\`decisions.md\`; this is the quick-lookup view.

| Source | Target | Notes |
| --- | --- | --- |
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
