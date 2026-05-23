---
source: https://milkdown.dev/docs/api/plugin-clipboard
fetched: 2026-05-23
milkdown_version: 7.20.0
title: "@milkdown/plugin-clipboard"
---

# @milkdown/plugin-clipboard

Markdown copy & paste support for [milkdown](https://milkdown.dev/).

```typescript
import { Editor } from '@milkdown/kit/core'
import { clipboard } from '@milkdown/kit/plugin/clipboard'

Editor.make().use(clipboard).create()
```

This plugin adds support for:

1. Copying content from the editor to the clipboard as Markdown.
2. Pasting Markdown content into the editor.
3. Pasting content as a code block copied from VSCode.

 #### clipboard `: $Prose`
   The prosemirror plugin for clipboard.
