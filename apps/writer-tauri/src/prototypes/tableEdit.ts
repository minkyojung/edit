// String→string edits on a GFM pipe-table source. The document text is the single
// source of truth: the table widget's buttons call these to compute new source and
// dispatch it as a normal CM change, then the decoration re-renders the <table>.
// Minimal + self-contained for the spike (no external table kernel / adapter).

const isDelim = (line: string): boolean => /^[\s|:-]+$/.test(line) && line.includes('-')

/** Number of cells in a `| a | b | c |` row (between the edge pipes). */
function columnCount(line: string): number {
  return Math.max(1, line.split('|').length - 2)
}

/** Append an empty row (matching the header's column count) at the bottom. */
export function addRow(source: string): string {
  const header = source.split('\n').find((l) => l.includes('|')) ?? source
  const row = '|' + '  |'.repeat(columnCount(header))
  return source.replace(/\s+$/, '') + '\n' + row
}

/** Append a new last column: an empty cell on every row, a `---` cell on the
 * delimiter row (so the table stays valid GFM). */
export function addColumn(source: string): string {
  return source
    .split('\n')
    .map((line) => (line.includes('|') ? `${line.trimEnd()} ${isDelim(line) ? '---' : ''} |` : line))
    .join('\n')
}
