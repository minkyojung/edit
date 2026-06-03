/**
 * Thin adapter around the schema plugins defined under ./schema.
 *
 * Why this exists:
 *   - Flatten + cast each plugin bundle to `MilkdownPlugin[]` so
 *     Editor.use() accepts them under our strict tsconfig.
 *
 * Why three plugins:
 *   - `proofMarkPlugins`: five proof marks (Suggestion / Comment /
 *     Authored / Flagged / Approved).
 *   - `codeBlockExtPlugins`: redefines the `code_block` node to
 *     allow proof marks as content, so a marked code span survives
 *     the markdown ↔ PM round-trip.
 *   - `frontmatterSchema`: a YAML-frontmatter block node. We don't
 *     emit one ourselves, but registering the node keeps round-tripped
 *     docs from rejecting incoming frontmatter.
 */

import type { MilkdownPlugin } from '@milkdown/kit/ctx'
import { proofMarkPlugins as rawProofMarkPlugins } from './schema/proof-marks'
import { codeBlockExtPlugins as rawCodeBlockExt } from './schema/code-block-ext'
import { frontmatterSchema as rawFrontmatter } from './schema/frontmatter'
import { imageBlockSchema as rawImageBlock } from './schema/image-block'
import { videoBlockSchema as rawVideoBlock } from './schema/video-block'
import { audioBlockSchema as rawAudioBlock } from './schema/audio-block'
import { githubActivityBlockSchema as rawGithubActivity } from './schema/github-activity-block'

export const proofMarkPlugins: MilkdownPlugin[] = (
  rawProofMarkPlugins as unknown as MilkdownPlugin[]
).flat()

export const codeBlockExtPlugins: MilkdownPlugin[] = (
  rawCodeBlockExt as unknown as MilkdownPlugin[]
).flat()

/** Frontmatter is a single `$nodeSchema` (returns a tuple-like
 * plugin object). We spread it into an array here for consistency
 * with the other schema bundles. */
export const frontmatterSchema: MilkdownPlugin[] = [
  rawFrontmatter as unknown as MilkdownPlugin,
].flat()

/** Block-level image node. Same shape as frontmatter (single
 * $nodeSchema), so the same wrap idiom applies. */
export const imageBlockSchema: MilkdownPlugin[] = [
  rawImageBlock as unknown as MilkdownPlugin,
].flat()

/** Block-level video node. Round-trips through raw `<video>` HTML;
 * see `schema/video-block.ts` for the parseMarkdown/toMarkdown
 * details. Same wrap idiom as imageBlockSchema. */
export const videoBlockSchema: MilkdownPlugin[] = [
  rawVideoBlock as unknown as MilkdownPlugin,
].flat()

/** Block-level audio node. Round-trips through raw `<audio>` HTML
 * with a `title` attribute the user fills in via the input above
 * the controls. Same wrap idiom as the other block schemas. */
export const audioBlockSchema: MilkdownPlugin[] = [
  rawAudioBlock as unknown as MilkdownPlugin,
].flat()

/** Block-level GitHub-activity anchor. Stores only a date marker in the
 * markdown; the card body is rendered live from events.db. Same wrap
 * idiom as the other block schemas. */
export const githubActivityBlockSchema: MilkdownPlugin[] = [
  rawGithubActivity as unknown as MilkdownPlugin,
].flat()

/**
 * Combined schema bundle — register this single export in MilkdownEditor
 * to keep the schema surface in one place. Order matters: marks register
 * before the code-block extension (which references the mark types in
 * its `marks: '...'` content spec).
 */
export const proofSchemaPlugins: MilkdownPlugin[] = [
  ...proofMarkPlugins,
  ...codeBlockExtPlugins,
  ...frontmatterSchema,
  ...imageBlockSchema,
  ...videoBlockSchema,
  ...audioBlockSchema,
  ...githubActivityBlockSchema,
]
