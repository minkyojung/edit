---
source: https://milkdown.dev/docs/api/plugin-listener
fetched: 2026-05-23
milkdown_version: 7.20.0
title: "@milkdown/plugin-listener"
---

# @milkdown/plugin-listener

Listener plugin for milkdown.

## Usage

```typescript
import { Editor } from '@milkdown/kit/core'
import { listener, listenerCtx } from '@milkdown/kit/plugin/listener'
import { commonmark } from '@milkdown/kit/preset/commonmark'
import { nord } from '@milkdown/theme-nord'

Editor.make()
  .config((ctx) => {
    const listener = ctx.get(listenerCtx)

    listener.markdownUpdated((ctx, markdown, prevMarkdown) => {
      if (markdown !== prevMarkdown) {
        YourMarkdownUpdater(markdown)
      }
    })
  })
  .use(listener)
  // use other plugins
  .create()
```

## Plugin

 #### key `: PluginKey`
   The plugin key of the listener prosemirror plugin.

 #### listener `: MilkdownPlugin`
   The listener plugin.


## Listener

 #### listenerCtx `: SliceType`
   The ctx key of the listener manager.
   You can use `ctx.get(listenerCtx)` to get the [listener manager](#class-listenermanager).


#### class ListenerManager



The manager of listeners. It provides methods to subscribe to events.

 * **`listeners`**`: Subscribers`\
   A getter to get all [subscribers](#interface-subscribers). You should not use this method directly.

 * **`beforeMount`**`(fn: fn(ctx: Ctx)) → ListenerManager`\
   Subscribe to the beforeMount event.
   This event will be triggered before the editor is mounted.

 * **`mounted`**`(fn: fn(ctx: Ctx)) → ListenerManager`\
   Subscribe to the mounted event.
   This event will be triggered after the editor is mounted.

 * **`updated`**`(fn: fn(ctx: Ctx, doc: Node, prevDoc: Node | null)) → ListenerManager`\
   Subscribe to the updated event.
   This event will be triggered after the editor state is updated and **the document is changed**.
   The second parameter is the current document and the third parameter is the previous document.

 * **`markdownUpdated`**`(fn: fn(ctx: Ctx, markdown: string, prevMarkdown: string)) → ListenerManager`\
   Subscribe to the markdownUpdated event.
   This event will be triggered after the editor state is updated and **the document is changed**.
   The second parameter is the current markdown and the third parameter is the previous markdown.

 * **`blur`**`(fn: fn(ctx: Ctx)) → ListenerManager`\
   Subscribe to the blur event.
   This event will be triggered when the editor is blurred.

 * **`focus`**`(fn: fn(ctx: Ctx)) → ListenerManager`\
   Subscribe to the focus event.
   This event will be triggered when the editor is focused.

 * **`destroy`**`(fn: fn(ctx: Ctx)) → ListenerManager`\
   Subscribe to the destroy event.
   This event will be triggered before the editor is destroyed.

 * **`selectionUpdated`**`(fn: fn(ctx: Ctx, selection: Selection, prevSelection: Selection | null)) → ListenerManager`\
   Subscribe to the selectionUpdated event.
   This event will be triggered when the editor selection is updated.

#### interface Subscribers



The dictionary of subscribers of each event.

 * **`beforeMount`**`: (fn(ctx: Ctx))[]`

 * **`mounted`**`: (fn(ctx: Ctx))[]`

 * **`updated`**`: (fn(ctx: Ctx, doc: Node, prevDoc: Node))[]`

 * **`markdownUpdated`**`: (fn(ctx: Ctx, markdown: string, prevMarkdown: string))[]`

 * **`blur`**`: (fn(ctx: Ctx))[]`

 * **`focus`**`: (fn(ctx: Ctx))[]`

 * **`destroy`**`: (fn(ctx: Ctx))[]`

 * **`selectionUpdated`**`: (fn(ctx: Ctx, selection: Selection, prevSelection: Selection | null))[]`
