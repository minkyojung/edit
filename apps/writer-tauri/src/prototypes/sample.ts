// Sample markdown for the CodeMirror Live Preview spike. Covers every
// Tier 1 + Tier 2 construct so the prototype can be eyeballed against the
// real Milkdown editor. Images use a remote URL + a data URI on purpose —
// the spike does NOT resolve vault-relative asset paths.

export const SAMPLE = `# CodeMirror Live Preview

A spike to see whether **CodeMirror** renders our markdown as nicely as the
current _ProseMirror_ editor. Inline \`code\` should look right too.

## Tier 1 — everyday typography

Paragraphs wrap naturally and keep a comfortable reading measure. Put your
cursor on **this line** and the bold markers should reveal themselves.

### Lists

- First bullet
- Second bullet with a [normal link](https://example.com)
- Third bullet

1. Ordered one
2. Ordered two
3. Ordered three

> A blockquote should sit behind a soft left border and read in a muted tone.

---

## Tier 2 — richer objects

An inline image rendered as a real picture:

![A scenic placeholder](https://picsum.photos/480/240)

A base64 data-URI image:

![data uri](data:image/svg+xml;base64,PHN2ZyB4bWxucz0naHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmcnIHdpZHRoPScxMjAnIGhlaWdodD0nNDAnPjxyZWN0IHdpZHRoPScxMjAnIGhlaWdodD0nNDAnIHJ4PSc2JyBmaWxsPSdjcmltc29uJy8+PC9zdmc+)

### Task list

- [ ] Unchecked task
- [x] Checked task

### Wikilinks

Link to another note like [[Daily Standup]] or [[Project Brasilia]], and a
broken one [[Nonexistent Note]] (styled red/dashed).

### Table

| Feature | PM | CM |
| --- | --- | --- |
| Anchor stability | 100% | 100% |
| Anchor LOC | 724 | 130 |

### Fenced code

\`\`\`ts
function greet(name: string): string {
  return \`hello, \${name}\`
}
\`\`\`

### Chart card (Mermaid — the card proof spike)

\`\`\`mermaid
flowchart LR
  A[Write] --> B[AI suggests edit]
  B --> C{Keep?}
  C -->|yes| D[Apply to doc]
  C -->|no| A
\`\`\`

### Video card (reuses MediaControls)

<video src="https://www.w3schools.com/html/mov_bbb.mp4" controls></video>

### Audio card (reuses MediaControls)

<audio src="https://www.w3schools.com/html/horse.mp3" title="Sample audio" controls></audio>
`
