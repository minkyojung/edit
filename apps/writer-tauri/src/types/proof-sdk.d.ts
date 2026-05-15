/**
 * Type declarations for proof-sdk modules consumed via the Vite
 * `@proof-sdk/*` alias (see vite.config.ts).
 *
 * Why this shim exists:
 *   - proof-sdk's source compiles under its own tsconfig, which is
 *     looser than ours (e.g. permissive `unknown` flows through
 *     `serializeProofMark` and the parseMarkdown helpers). When we
 *     point tsconfig.paths directly at proof-sdk source, our strict
 *     `noImplicitAny` / strict object literal checks light up errors
 *     inside files we don't own.
 *   - We need the runtime artifact (the plugin objects) but not the
 *     fine-grained internal types. Declaring the module shape here
 *     decouples the two — Vite still resolves the alias to real
 *     source at bundle time; the TypeScript layer trusts this shim.
 *
 * Keep this surface minimal — only the exports we actually consume
 * elsewhere in the app. Adding a new symbol means re-declaring it
 * here too, which is the cost of trading deep type coverage for
 * isolation from proof-sdk's stricter-than-ours warnings.
 */

declare module '@proof-sdk/editor/schema/proof-marks' {
  /**
   * proof-sdk publishes a mixed array of `$markAttr` plugins and
   * `$markSchema` tuple objects. The runtime works under Milkdown's
   * `.use()` (it accepts either), but the array type is opaque
   * enough that the adapter (`editor/proofMarks.ts`) flattens +
   * casts before handing it to the editor.
   */
  export const proofMarkPlugins: unknown[]
}

declare module '@proof-sdk/editor/schema/code-block-ext' {
  /**
   * `code_block` schema extension. proof-sdk redefines the
   * commonmark `code_block` node so it accepts proofAuthored /
   * proofSuggestion / proofComment / proofFlagged / proofApproved
   * marks (necessary for proof-marked code spans to survive the
   * markdown round-trip). Without this on the client, our
   * code_block schema differs from the server's, which is the
   * shape of mismatch that broke projection repair.
   */
  export const codeBlockExtPlugins: unknown[]
}

declare module '@proof-sdk/editor/schema/frontmatter' {
  /**
   * `frontmatter` block node. proof-sdk registers a YAML-style
   * frontmatter node so docs with `---\ntitle: ...\n---` headers
   * round-trip cleanly. We don't currently emit frontmatter
   * client-side, but the server expects this node type in its
   * schema; registering it on our side keeps the two schemas
   * structurally identical.
   */
  export const frontmatterSchema: unknown
}
