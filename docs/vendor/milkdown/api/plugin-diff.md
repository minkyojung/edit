---
source: https://milkdown.dev/docs/api/plugin-diff
fetched: 2026-05-23
milkdown_version: 7.20.0
title: "@milkdown/plugin-diff"
---

# @milkdown/plugin-diff

Diff review plugin for [milkdown](https://milkdown.dev/). Compares two documents and lets users accept or reject individual changes.

## Usage

```typescript
import { Editor } from '@milkdown/kit/core'
import { diff } from '@milkdown/kit/plugin/diff'
import { diffComponent } from '@milkdown/kit/component/diff'
import { commonmark } from '@milkdown/kit/preset/commonmark'

const editor = await Editor.make()
  .use(commonmark)
  .use(diff)
  .use(diffComponent)
  .create()
```

### With Crepe

```typescript
import { Crepe, CrepeFeature } from '@milkdown/crepe'

const crepe = new Crepe({
  root: '#editor',
  features: {
    [CrepeFeature.AI]: true,
  },
})
await crepe.create()
```

## Starting a Diff Review

Pass the modified markdown to `startDiffReviewCmd`. The editor will show the differences and lock editing until the review is complete.

```typescript
import { callCommand } from '@milkdown/kit/utils'
import { startDiffReviewCmd } from '@milkdown/kit/plugin/diff'

editor.action(
  callCommand(startDiffReviewCmd.key, '# Updated content\n\nNew paragraph.')
)
```

You can also pass a pre-parsed ProseMirror `Node` directly using `startDiffReviewFromDocCmd`, which avoids the serialize→parse round-trip:

```typescript
import { startDiffReviewFromDocCmd } from '@milkdown/kit/plugin/diff'

editor.action(callCommand(startDiffReviewFromDocCmd.key, someDocNode))
```

## Accepting and Rejecting Changes

Users can click the Accept/Reject buttons on each change in the UI. You can also control this programmatically:

```typescript
import { callCommand } from '@milkdown/kit/utils'
import {
  acceptAllDiffsCmd,
  clearDiffReviewCmd,
  acceptDiffChunkCmd,
  rejectDiffChunkCmd,
} from '@milkdown/kit/plugin/diff'

// Accept all remaining changes
editor.action(callCommand(acceptAllDiffsCmd.key))

// Clear the review (discard remaining changes, keep accepted ones)
editor.action(callCommand(clearDiffReviewCmd.key))

// Accept/reject a specific change by index
editor.action(callCommand(acceptDiffChunkCmd.key, 0))
editor.action(callCommand(rejectDiffChunkCmd.key, 0))
```

The diff automatically deactivates and unlocks the editor when all changes have been resolved.

## Plugin Configuration

```typescript
import { diffConfig } from '@milkdown/kit/plugin/diff'

Editor.make()
  .config((ctx) => {
    ctx.update(diffConfig.key, (prev) => ({
      ...prev,
      ignoreAttrs: { heading: ['id'] }, // Ignore these attrs when diffing (default: { heading: ['id'] })
    }))
  })
  .use(diff)
  .use(diffComponent)
  .create()
```

## Component Configuration

The diff component handles the visual rendering of changes. It can be configured through `diffComponentConfig`:

```typescript
import { diffComponentConfig } from '@milkdown/kit/component/diff'

Editor.make()
  .config((ctx) => {
    ctx.update(diffComponentConfig.key, (prev) => ({
      ...prev,
      acceptLabel: 'Apply', // Accept button text (default: 'Accept')
      rejectLabel: 'Discard', // Reject button text (default: 'Reject')
      customBlockTypes: [
        // Node types using custom node views
        'table',
        'image-block',
        'code_block',
      ],
    }))
  })
  .use(diff)
  .use(diffComponent)
  .create()
```

### Custom Block Types

ProseMirror's inline decorations cannot penetrate custom node views. The `customBlockTypes` option tells the diff component which node types need block-level replacement handling instead of inline decorations.

When using Crepe, this is pre-configured with `['table', 'image-block', 'code_block']`.

## Styling

The diff component uses CSS classes that you need to style. When using Crepe, styles are included in the theme CSS automatically.

For standalone usage, the main CSS classes are:

| Class                           | Description                                |
| ------------------------------- | ------------------------------------------ |
| `.milkdown-diff-removed`        | Inline deletion (strikethrough)            |
| `.milkdown-diff-removed-block`  | Block-level deletion (node overlay)        |
| `.milkdown-diff-added`          | Inline insertion                           |
| `.milkdown-diff-added-block`    | Block-level insertion widget               |
| `.milkdown-diff-controls`       | Inline Accept/Reject button container      |
| `.milkdown-diff-controls-block` | Block-level Accept/Reject button container |
| `.milkdown-diff-accept`         | Accept button                              |
| `.milkdown-diff-reject`         | Reject button                              |

## Plugin

 #### diff `: MilkdownPlugin[]`
   The milkdown diff plugin.

 #### diffPlugin `: $Prose`
   The ProseMirror plugin that manages diff state.

 #### diffPluginKey `: PluginKey`
   The plugin key for accessing diff state.

 #### diffConfig `: $Ctx`
   The configuration context for the diff plugin.


## Commands

 #### startDiffReviewCmd `: $Command`
   Start a diff review with modified markdown.

 #### startDiffReviewFromDocCmd `: $Command`
   Start a diff review with a pre-parsed document node.
   Avoids the serialize→parse round-trip of startDiffReviewCmd.

 #### acceptDiffChunkCmd `: $Command`
   Accept a single pending change by index.

 #### rejectDiffChunkCmd `: $Command`
   Reject a single pending change by index.

 #### acceptDiffRangeCmd `: $Command`
   Accept a diff by explicit range. Used for merged custom block changes
   (tables, image-blocks, code blocks) where multiple sub-changes are
   grouped into a single visual change.

 #### rejectDiffRangeCmd `: $Command`
   Reject a diff by explicit range.

 #### acceptAllDiffsCmd `: $Command`
   Accept all remaining pending changes.

 #### clearDiffReviewCmd `: $Command`
   Clear the diff review and unlock the editor.


## Utilities

 #### computeDocDiff `(oldDoc: Node, newDoc: Node, options?: ComputeDocDiffOptions) → readonly Change[]`
   Compute fine-grained changes between two ProseMirror documents.

   Uses per-block LCS matching (recursing into container nodes like
   bullet_list, blockquote, table). Without `options.range`, the entire
   document is diffed.

   When `options.range` is provided, the diff is restricted to that
   region. The range must satisfy these preconditions or the call
   throws `RangeError`:

   - **boundary-aligned**: both endpoints sit between siblings of a
     common (non-textblock) container ancestor — i.e. not inside a
     textblock and not in the middle of a child node
   - **structurally identical path**: the chain of ancestors leading to
     that shared container has the same node types, attrs (modulo
     `ignoreAttrs`), and absolute start positions in both docs

   Out-of-bounds endpoints are clamped silently. An empty range returns
   no changes.

 #### getPendingChanges `(state: DiffState) → Change[]`
   Get only the pending (non-rejected) changes.

 #### isChangeRejected `(change: {fromB: number, toB: number}, rejectedRanges: {fromB: number, toB: number}[]) → boolean`
   Check if a change overlaps with any rejected range in newDoc.


## Types

#### interface DiffState



The diff plugin state.

 * **`newDoc`**`: Node`\
   The target (new) document that we're diffing toward

 * **`changes`**`: readonly Change[]`\
   Current changes between current doc and newDoc (recomputed on doc change)

 * **`rejectedRanges`**`: {fromB: number, toB: number}[]`\
   Ranges in newDoc that have been rejected (fromB..toB).
      *  These are stable because newDoc never changes.

 * **`active`**`: boolean`\
   Whether the diff review is currently active

#### interface DiffConfig



Configuration options for the diff plugin.

 * **`ignoreAttrs`**`: Record`\
   Map of node type names to attribute keys to ignore when diffing

#### interface DiffRange



A position range in both old and new documents.

 * **`fromA`**`: number`

 * **`toA`**`: number`

 * **`fromB`**`: number`

 * **`toB`**`: number`

 #### type DiffAction` = {type: "start", newDoc: Node} | {type: "accept", changeIndex: number} | {type: "reject", fromB: number, toB: number} | {type: "acceptRange", range: DiffRange} | {type: "rejectRange", range: DiffRange} | {type: "acceptAll"} | {type: "clear"}`
   Actions that can be dispatched to the diff plugin.

#### interface ComputeDocDiffOptions



Options for `computeDocDiff`.

 * **`range`**`?: ComputeDiffRange`\
   Restrict the diff to a sub-region of both documents.

 * **`ignoreAttrs`**`?: DiffIgnoreAttrs`\
   Map of node type names to attribute keys to ignore when diffing.

#### interface ComputeDiffRange



A symmetric range that restricts the diff to a sub-region of both documents.
The same `from`/`to` positions are used in both old and new docs.
Omitted fields default to 0 (start) or content.size (end).

 * **`from`**`?: number`

 * **`to`**`?: number`

 #### type DiffIgnoreAttrs` = Record`
   A map of node type names to arrays of attribute keys that should be
   ignored when computing diffs. For example, `{ heading: ['id'] }` will
   skip the `id` attribute on heading nodes.
