// Scaffold for a fresh translation project.
//
// A translation project is just a folder with a translation-flavoured
// CLAUDE.md plus two directories:
//
//   <root>/
//   ├── CLAUDE.md       ← the "routing brain": tells the agent it is a
//   │                     translation apprentice and how to keep the reference
//   ├── manuscript/     ← source text + translation
//   └── reference/      ← the memory layer (glossary, style guide, and
//                         whatever else the work needs)
//
// The reference layer is a VISIBLE folder of plain markdown so the translator
// can open and edit it — transparency is the trust story. We seed only the two
// universal files every translation needs (glossary + style guide); anything
// type-specific (characters / world / timeline for fiction, key concepts for
// non-fiction) is grown by the agent on demand per the CLAUDE.md, so the folder
// shape flexes to the work instead of being a fixed template.
//
// These helpers take an ABSOLUTE root and write straight through plugin-fs
// (not the active-vault helpers): the launcher window scaffolds a folder that
// is NOT its active vault — in fact the launcher has no active vault at all
// under the window-per-project model. Idempotent: every write is guarded by an
// existence check, so re-scaffolding an existing project never clobbers a
// translator's edited files.

import { exists, mkdir, writeTextFile } from '@tauri-apps/plugin-fs'
import { join } from '@tauri-apps/api/path'

/** Translation-project CLAUDE.md — a small, stable contract. The growing
 * knowledge lives in `reference/` and is read on demand, so this stays cheap
 * as a cached prefix. The translator owns the file and may edit it. */
const TRANSLATION_CLAUDE_MD = `# Translation project

You assist a human literary translator. The translator holds the pen; you are
the apprentice. Your job is not to translate *for* them but to **remember every
decision, keep it consistent, and never lose it** — so a long work stays
coherent across chapters, sessions, and people.

## Project settings

Fill these in for this work; leave everything that grows to the reference.

- **Languages**: [source] → [target]
- **Voice / register**: [e.g. warm, plain Korean; 해요체; keep the author's wit]
- **Standing rules**: [anything that always applies — e.g. keep English product
  names as-is]

## Layout

- \`manuscript/\` — the source text and your translation.
- \`reference/\` — the memory layer. Plain markdown the translator reads and
  edits freely. Two files always apply:
  - \`reference/glossary.md\` — the canonical translation for each recurring term.
  - \`reference/style-guide.md\` — the current voice, tone, and notation rules.

  Beyond these, create and maintain whatever **this** work needs to stay
  consistent — e.g. \`characters.md\`, \`world.md\`, \`timeline.md\` for fiction;
  key-concept notes for non-fiction. Don't create files the work doesn't need.

## How you work

- **New chapter in** → read it, pull out what later chapters must stay
  consistent with, and **propose** updates to the reference (creating a new
  file if the material calls for one). Don't write to disk directly — propose
  and let the translator approve.
- **Before translating** → consult \`reference/\` so terms and voice match
  earlier chapters.
- **Conflict** → if a draft contradicts a recorded choice ("we used A before,
  this is B"), flag it. Don't silently pick one.
- **Unsure** whether something is new or already recorded → ask. Never
  guess-merge.

## Reviewing your work

After drafting a translation or updating the reference, review before handing
back — check against the source and \`reference/\` through these lenses:
- **Fidelity** — does it match the source's meaning? (drift, mistranslation)
- **Consistency** — recurring terms/names match \`glossary.md\`; voice matches
  \`style-guide.md\`.
- **Coverage** — is anything in the source missing from the translation?
- **Reference gaps** — recurring terms (2+ uses) not yet recorded?

Report each flag with its location, what's wrong, and which rule/source it
breaks. Surface only flags you're confident are real — skip intentional
variation, one-off wording, and nitpicks not in the style guide. The translator
judges each flag; never auto-fix.

## What to record

Only what affects consistency or the reader's experience later: recurring
terms, coined concepts, proper nouns, voice/style choices — and, for fiction,
characters, settings, and timeline. Skip one-off wording.

## Working rules

- Propose changes through the approval flow; never auto-write the manuscript or
  the reference files.
- Keep the reference files current and human-readable — they are the source of
  truth the translator owns. (Git records when and why things changed.)

## Tools

Explore with the built-in Read / Glob / Grep. The reference is markdown on
disk — grep it to find earlier choices instead of loading the whole thing into
context.
`

/** Seed glossary — a table so the shape is clear from first open. */
const GLOSSARY_SEED = `# Glossary

The canonical translation for each recurring term. Keep it current; this is the
source of truth the translator owns.

| Source | Target | Notes |
| --- | --- | --- |
`

/** Seed style guide — the living rules doc every translation needs. */
const STYLE_GUIDE_SEED = `# Style guide

The current voice, tone, and notation rules for this translation. Edit freely —
this is a living document the translator owns. (Git records when and why rules
changed.)

## Voice & tone

-

## Notation & formatting

-

## Names & proper nouns

-
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
  await mkdir(await join(root, 'reference'), { recursive: true })

  await writeIfAbsent(await join(root, 'CLAUDE.md'), TRANSLATION_CLAUDE_MD)
  await writeIfAbsent(await join(root, 'reference', 'glossary.md'), GLOSSARY_SEED)
  await writeIfAbsent(
    await join(root, 'reference', 'style-guide.md'),
    STYLE_GUIDE_SEED,
  )
}

/** Heuristic: does this folder look like a translation project? Used to label
 * the project and to gate the boot sequence (translation projects skip the
 * wiki-legacy migrations). A `manuscript/` directory is the distinctive marker
 * the scaffold always writes — far less likely to collide with a wiki vault's
 * folders than a generic name like `reference/`. */
export async function isTranslationProject(root: string): Promise<boolean> {
  return await exists(await join(root, 'manuscript'))
}
