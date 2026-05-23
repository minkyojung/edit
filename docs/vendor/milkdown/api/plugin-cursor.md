---
source: https://milkdown.dev/docs/api/plugin-cursor
fetched: 2026-05-23
milkdown_version: 7.20.0
title: "@milkdown/plugin-cursor"
---

# @milkdown/plugin-cursor

Add [drop cursor](https://github.com/ProseMirror/prosemirror-dropcursor) and
[gap cursor](https://github.com/ProseMirror/prosemirror-gapcursor) support.

## Usage

```typescript
import { Editor } from '@milkdown/kit/core'
import { cursor } from '@milkdown/kit/plugin/cursor'
import { commonmark } from '@milkdown/kit/preset/commonmark'
import { nord } from '@milkdown/theme-nord'

Editor.make().use(nord).use(commonmark).use(cursor).create()
```

 #### cursor `: MilkdownPlugin[]`
   All plugins exported by this package.


## Ctx

 #### type dropIndicatorConfig` = {meta?: Meta} & fn(ctx: Ctx) → CtxRunner & {key: SliceType}`
   Configuration for the drop indicator.

   The drop indicator configuration with default values.

 #### dropIndicatorState `: $Ctx`
   The drop indicator state to store the current drop indicator information.


## Plugins

 #### dropIndicatorDOMPlugin `: $Prose`
   The drop indicator DOM plugin to render the drop indicator as a DOM element.

 #### dropIndicatorPlugin `: $Prose`
   Drop indicator plugin to update the drop indicator state.

 #### gapCursorPlugin `: $Prose`
   This plugin wraps [gap cursor](https://github.com/ProseMirror/prosemirror-gapcursor).


## Deprecated

 #### dropCursorConfig `: $Ctx`
   @deprecated
   Use `dropIndicatorConfig` instead.
   Backward compatibility export for `dropCursorConfig`
