// String→string edits on a GFM pipe-table source. The document text is the single
// source of truth: the table widget's buttons call these to compute new source and
// dispatch it as a normal CM change, then the decoration re-renders the <table>.
// Minimal + self-contained for the spike (no external table kernel / adapter).

const isDelim = (line: string): boolean => /^[\s|:-]+$/.test(line) && line.includes('-')

/** Split a row on UNESCAPED pipes only — a `\|` inside a cell is a literal pipe
 * (GFM escaping), not a column boundary. */
const splitOnPipe = (line: string): string[] => line.split(/(?<!\\)\|/)

/** Number of cells in a `| a | b | c |` row (between the edge pipes). */
function columnCount(line: string): number {
  return Math.max(1, splitOnPipe(line).length - 2)
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

/** Remove the `col`-th cell (0-based) from every row, including the delimiter.
 * No-op when the table has a single column (would leave a degenerate `||` row). */
export function deleteColumn(source: string, col: number): string {
  const header = source.split('\n').find((l) => l.includes('|'))
  if (!header || columnCount(header) <= 1) return source
  return source
    .split('\n')
    .map((line) => {
      if (!line.includes('|')) return line
      const parts = splitOnPipe(line) // ['', c0, c1, ..., '']  (edge pipes → empty ends)
      if (col + 1 < parts.length - 1) parts.splice(col + 1, 1)
      return parts.join('|')
    })
    .join('\n')
}

/** Remove the `dataRow`-th DATA row (0-based; the header and delimiter are kept). */
export function deleteRow(source: string, dataRow: number): string {
  let seenHeader = false
  let dataIdx = -1
  return source
    .split('\n')
    .filter((line) => {
      if (!line.includes('|') || isDelim(line)) return true
      if (!seenHeader) {
        seenHeader = true
        return true // header row
      }
      dataIdx++
      return dataIdx !== dataRow
    })
    .join('\n')
}
