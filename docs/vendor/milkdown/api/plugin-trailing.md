---
source: https://milkdown.dev/docs/api/plugin-trailing
fetched: 2026-05-23
milkdown_version: 7.20.0
title: "@milkdown/plugin-trailing"
---

# @milkdown/plugin-trailing

Add a trailing node at the end of the document automatically.

```typescript
import { Editor } from '@milkdown/kit/core'
import { trailing } from '@milkdown/kit/plugin/trailing'

Editor.make().use(trailing).create()
```

 #### trailing `: MilkdownPlugin[]`
   All plugins exported by this package.


## Options

 #### trailingConfig `: $Ctx`
   A slice contains the trailing config.
   You can use [TrailingConfigOptions](#TrailingConfigOptions) to customize the behavior of the plugin.

#### interface TrailingConfigOptions



Options for trailing config.

 * **`shouldAppend`**`(lastNode: Node | null, state: EditorState) → boolean`\
   A function that returns a boolean value.
   If it returns `true`, the plugin will append a node at the end of the document.
   By default, it returns `false` if the last node is a heading or a paragraph.

 * **`getNode`**`(state: EditorState) → Node`\
   A function that returns a node.
   By default, it returns a paragraph node.


## Plugin

 #### trailingPlugin `: $Prose`
   The prosemirror plugin for trailing.
