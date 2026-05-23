---
source: https://milkdown.dev/docs/api/plugin-history
fetched: 2026-05-23
milkdown_version: 7.20.0
title: "@milkdown/plugin-history"
---

# @milkdown/plugin-history

History undo & redo support for [milkdown](https://milkdown.dev/).

## Usage

```typescript
import { Editor } from '@milkdown/kit/core'
import { history } from '@milkdown/kit/plugin/history'
import { commonmark } from '@milkdown/kit/preset/commonmark'
import { nord } from '@milkdown/theme-nord'

Editor.make().use(nord).use(commonmark).use(history).create()
```

## Plugin

 #### history `: MilkdownPlugin[]`
   The milkdown history plugin.

 #### historyProviderConfig `: $Ctx`
   The [config](https://prosemirror.net/docs/ref/#history.history%5Econfig) of prosemirror history plugin.

 #### historyProviderPlugin `: $Prose`
   The milkdown wrapper of [history API](https://prosemirror.net/docs/ref/#history.history) in [prosemirror-history](https://prosemirror.net/docs/ref/#history).


## Keymap

 #### historyKeymap `: $UserKeymap`
   The keymap of history plugin, it's `mod-z` for undo and `mod-y`/`shift-mod-z` for redo.


You can remap the keymap by using the `historyKeymap.key`.

```typescript
import { history, historyKeymap } from '@milkdown/plugin-history'

Editor.make()
  .config((ctx) => {
    ctx.set(historyKeymap.key, {
      // Remap to one shortcut.
      Undo: 'Mod-z',
      // Remap to multiple shortcuts.
      Redo: ['Mod-y', 'Shift-Mod-z'],
    })
  })
  .use(nord)
  .use(commonmark)
  .use(history)
  .create()
```

## Commands

 #### undoCommand `: $Command`
   The milkdown command wrapper of [undo API](https://prosemirror.net/docs/ref/#history.undo) in [prosemirror-history](https://prosemirror.net/docs/ref/#history).

 #### redoCommand `: $Command`
   The milkdown command wrapper of [redo API](https://prosemirror.net/docs/ref/#history.redo) in [prosemirror-history](https://prosemirror.net/docs/ref/#history).


You can call the commands programmatically.

```typescript
import { Undo, history } from '@milkdown/plugin-history'
import { callCommand } from '@milkdown/plugin-utils'

const editor = await Editor.make().use(/* ... */).use(history).create()

editor.action(callCommand(Undo))
```
