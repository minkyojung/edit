// Doc properties — the ordered full-frontmatter model behind the
// Notion-style properties panel. A note's `fm` is the in-memory mirror of
// its on-disk YAML block: every top-level scalar / string-list key, in
// file order. Keys whose value the flat model can't represent (nested
// maps, non-scalar list items) are absent here; on write they stay
// foreign and mergeFrontmatter preserves their original lines verbatim.
//
// Order is load-bearing: the panel renders rows in `fm` order and the
// flush emits keys in `fm` order, so the YAML key order in the file IS
// the persisted row order (the Obsidian model — no separate order store
// to drift from the file).

/** One frontmatter entry: the raw key and its raw string(-list) value,
 *  exactly as parsed by `splitFrontmatterFull` (source-text fidelity,
 *  no type coercion). */
export interface FmEntry {
  key: string
  value: string | string[]
}

/** Project `splitFrontmatterFull(...).data` into the ordered entry list.
 *  JS objects preserve string-key insertion order, and the YAML parser
 *  inserts keys in document order, so `Object.entries` IS the file order.
 *  Returns undefined for an empty block so docs without frontmatter don't
 *  carry an empty array through the catalog. */
export function fmEntriesFromData(
  data: Record<string, string | string[]>,
): FmEntry[] | undefined {
  const entries = Object.entries(data).map(([key, value]) => ({ key, value }))
  return entries.length > 0 ? entries : undefined
}
