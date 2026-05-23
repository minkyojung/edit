---
source: https://milkdown.dev/docs/api/plugin-emoji
fetched: 2026-05-23
milkdown_version: 7.20.0
title: "@milkdown/plugin-emoji"
---

# @milkdown/plugin-emoji

Add support for emoji through [shortcuts](https://www.webfx.com/tools/emoji-cheat-sheet/).

Rendered by [twemoji](https://github.com/twitter/twemoji).

## Usage

```typescript
import { Editor } from '@milkdown/core'
import { emoji } from '@milkdown/plugin-emoji'

Editor.make().use(emoji).create()
```

 #### emoji `: MilkdownPlugin[]`
   All plugins exported by this package.


## Plugins

 #### emojiAttr `: $NodeAttr`
   HTML attributes for emoji node.

 #### emojiSchema `: $NodeSchema`
   Schema for emoji node.


 #### insertEmojiInputRule `: $InputRule`
   Input rule for inserting emoji.
   For example, `:smile:` will be replaced with `😄`.


 #### remarkEmojiPlugin `: $Remark`
   This plugin wraps [remark-emoji](https://github.com/rhysd/remark-emoji).

 #### remarkTwemojiPlugin `: $Remark`
   This plugin is used for transforming emoji to twemoji.
