---
source: https://milkdown.dev/docs/api/plugin-indent
fetched: 2026-05-23
milkdown_version: 7.20.0
title: "@milkdown/plugin-indent"
---

# @milkdown/plugin-indent

Indent support for [milkdown](https://milkdown.dev/).

```typescript
import { Editor } from '@milkdown/kit/core'
import { indent } from '@milkdown/kit/plugin/indent'

Editor.make().use(indent).create()
```

 #### indent `: MilkdownPlugin[]`
   The plugin of indent.


## Options

 #### indentConfig `: $Ctx`
   A slice contains the indent config.
   You can use [IndentConfigOptions](#IndentConfigOptions) to customize the behavior of the plugin.

   ```ts
   import { indent, indentConfig } from '@milkdown/plugin-indent'

   Editor
     .make()
     .config((ctx) => {
       ctx.set(indentConfig.key, {
         type: 'space',
         size: 4,
       })
     })
   ```

#### interface IndentConfigOptions



Add indent config.

 * **`type`**`: "space" | "tab"`\
   The type of indent, `space` or `tab`. By default, it's `space`.

 * **`size`**`: number`\
   The size of indent. By default, it's `2`.


## Plugin

 #### indentPlugin `: $Shortcut`
   Add indent shortcut, when users press `Tab`, the plugin will insert indent text.
