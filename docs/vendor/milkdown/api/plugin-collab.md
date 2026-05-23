---
source: https://milkdown.dev/docs/api/plugin-collab
fetched: 2026-05-23
milkdown_version: 7.20.0
title: "@milkdown/plugin-collab"
---

# @milkdown/plugin-collab

This plugin used to support collaborative editing for milkdown.

Please check the [collaborative editing guide](/docs/guide/collaborative-editing) to learn more.

```typescript
import { collab, collabServiceCtx } from '@milkdown/plugin-collab'

async function setup() {
  const editor = await Editor.make().use(collab).create()

  const doc = new Doc()
  const wsProvider = new WebsocketProvider('<YOUR_WS_HOST>', 'milkdown', doc)

  editor.action((ctx) => {
    const collabService = ctx.get(collabServiceCtx)

    collabService
      // bind doc and awareness
      .bindDoc(doc)
      .setAwareness(wsProvider.awareness)
      // connect yjs with milkdown
      .connect()
  })
}
```

## Plugin

 #### collab `: MilkdownPlugin`
   The collab plugin.

 #### CollabReady `: TimerType`
   The timer that indicates the collab plugin is ready.


## Service

 #### collabServiceCtx `: SliceType`
   A slice that contains the collab service.

#### class CollabService



The collab service is used to manage the collaboration plugins.
It is used to provide the collaboration plugins to the editor.

 * **`bindCtx`**`(ctx: Ctx) → CollabService`\
   Bind the context to the service.

 * **`bindDoc`**`(doc: Doc) → CollabService`\
   Bind the document to the service.

 * **`bindXmlFragment`**`(xmlFragment: YXmlFragment) → CollabService`\
   Bind the Yjs XmlFragment to the service.

 * **`setOptions`**`(options: CollabServiceOptions) → CollabService`\
   Set the options of the service.

 * **`mergeOptions`**`(options: Partial) → CollabService`\
   Merge some options to the service.
   The options will be merged to the existing options.
   THe options should be partial of the `CollabServiceOptions`.

 * **`setAwareness`**`(awareness: Awareness) → CollabService`\
   Set the awareness of the service.

 * **`applyTemplate`**`(template: DefaultValue, condition?: fn(yDocNode: Node, templateNode: Node) → boolean) → CollabService`\
   Apply the template to the document.

 * **`connect`**`() → CollabService | undefined`\
   Connect the service.

 * **`disconnect`**`() → CollabService`\
   Disconnect the service.

#### interface CollabServiceOptions



Options for the collab service.

 * **`yCursorStateField`**`?: string`\
   The field name of the yCursor plugin.

 * **`ySyncOpts`**`?: YSyncOpts`\
   Options for the ySync plugin.

 * **`yCursorOpts`**`?: yCursorOpts`\
   Options for the yCursor plugin.

 * **`yUndoOpts`**`?: yUndoOpts`\
   Options for the yUndo plugin.
