/**
 * Thin adapter for proof-sdk's schema plugins.
 *
 * Purpose:
 *   - Pull mark schemas (`proofMarkPlugins`) and node schema
 *     extensions (`codeBlockExtPlugins`, `frontmatterSchema`) from
 *     proof-sdk source so the client and server share one schema.
 *   - Flatten + cast to `MilkdownPlugin[]` so Editor.use() accepts
 *     them under our strict tsconfig. proof-sdk's own builds compile
 *     under a looser tsconfig where the mixed-array / tuple shapes
 *     pass; here we need an explicit narrowing.
 *
 * Why three plugins:
 *   - `proofMarkPlugins`: the seven proof marks. Their attr set has
 *     to match the server's stored marks JSON shape, or projection
 *     repair crashes on the round-trip.
 *   - `codeBlockExtPlugins`: redefines the `code_block` node to
 *     allow proof marks as content. Without this on the client, a
 *     code block in our Y.XmlFragment is structurally different
 *     from what the server's schema expects, and the server's
 *     Yjs-fragment-to-PM conversion fails.
 *   - `frontmatterSchema`: a YAML-frontmatter block node. We don't
 *     emit one client-side, but registering the node keeps the two
 *     schemas symmetric so server-originated docs (e.g. via
 *     /rewrite.apply) can land without surprises.
 *
 * If proof-sdk later publishes a pre-flattened, strictly-typed
 * bundle that satisfies MilkdownPlugin[] directly, this whole file
 * collapses to a `export * from '@proof-sdk/...'`.
 */

import type { MilkdownPlugin } from '@milkdown/kit/ctx'
import { proofMarkPlugins as rawProofMarkPlugins } from './schema/proof-marks'
import { codeBlockExtPlugins as rawCodeBlockExt } from './schema/code-block-ext'
import { frontmatterSchema as rawFrontmatter } from './schema/frontmatter'

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

/**
 * Combined schema bundle — register this single export in
 * MilkdownEditor to keep the schema surface in one place. Order
 * follows proof-sdk/server/milkdown-headless.ts:150-158: marks
 * register before code-block extensions (which reference the mark
 * types in their `marks: '...'` spec).
 */
export const proofSchemaPlugins: MilkdownPlugin[] = [
  ...proofMarkPlugins,
  ...codeBlockExtPlugins,
  ...frontmatterSchema,
]
