---
source: https://milkdown.dev/docs/api/plugin-slash
fetched: 2026-05-23
milkdown_version: 7.20.0
title: "@milkdown/plugin-slash"
---

# @milkdown/plugin-slash

Slash plugin for [milkdown](https://milkdown.dev/).
Add support for slash commands.

> Although this plugin is called _slash_, it is not limited to slash commands.
> It's also possible to use it for other commands, such as `@` to mentions or `:` to emoji.
>
> It's designed to solve one problem: input some characters and get a list of suggestions.

## Usage

#### Create Slash View

Create slash view is simple.
All you need to do is to implement the [Prosemirror Plugin.view](https://prosemirror.net/docs/ref/#state.PluginSpec.view).

```typescript
import { SlashProvider } from '@milkdown/kit/plugin/slash'

function slashPluginView(view) {
  const content = document.createElement('div')

  const provider = new SlashProvider({
    content,
  })

  return {
    update: (updatedView, prevState) => {
      provider.update(updatedView, prevState)
    },
    destroy: () => {
      provider.destroy()
      content.remove()
    },
  }
}
```

#### Bind Slash View

You need to bind the slash view to the plugin in `editor.config`.

```typescript
import { Editor } from '@milkdown/core'
import { slashFactory } from '@milkdown/plugin-slash'

const slash = slashFactory('my-slash')

Editor.make()
  .config((ctx) => {
    ctx.set(slash.key, {
      view: slashPluginView,
    })
  })
  .use(slash)
  .create()
```

## Use with React

[![Open in StackBlitz](https://developer.stackblitz.com/img/open_in_stackblitz.svg)](https://stackblitz.com/github/Milkdown/examples/tree/main/react-slash)

## Use with Vue

[![Open in StackBlitz](https://developer.stackblitz.com/img/open_in_stackblitz.svg)](https://stackblitz.com/github/Milkdown/examples/tree/main/vue-slash)

## API

 #### slashFactory `<Id extends string, State = any>(id: Id) → SlashPlugin`
   Create a slash plugin with a unique id.


#### class SlashProvider



A provider for creating slash.

 * `new `**`SlashProvider`**`(options: SlashProviderOptions)`

 * **`element`**`: HTMLElement`\
   The root element of the slash.

 * **`#offset`**`?: OffsetOptions`\
   The offset to get the block. Default is 0.

 * **`onShow`**`()`\
   On show callback.

 * **`onHide`**`()`\
   On hide callback.

 * **`update`**`(view: EditorView, prevState?: EditorState)`\
   Update provider state by editor view.

 * **`getContent`**`(view: EditorView, matchNode?: fn(node: Node) → boolean = (node) =>
      node.type.name === 'paragraph') → string | undefined`\
   Get the content of the current text block.
   Pass the `matchNode` function to determine whether the current node should be matched, by default, it will match the paragraph node.

 * **`destroy`**`()`\
   Destroy the slash.

 * **`show`**`()`\
   Show the slash.

 * **`hide`**`()`\
   Hide the slash.

#### interface SlashProviderOptions



Options for slash provider.

 * **`content`**`: HTMLElement`\
   The slash content.

 * **`debounce`**`?: number`\
   The debounce time for updating slash, 200ms by default.

 * **`shouldShow`**`?: fn(view: EditorView, prevState?: EditorState) → boolean`\
   The function to determine whether the tooltip should be shown.

 * **`trigger`**`?: string | string[]`\
   The key trigger for shouldShow, '/' by default.

 * **`offset`**`?: OffsetOptions`\
   The offset to get the block. Default is 0.

 * **`middleware`**`?: instantiated[]`\
   Other middlewares for floating ui. This will be added after the internal middlewares.

 * **`floatingUIOptions`**`?: Partial`\
   Options for floating ui. If you pass `middleware` or `placement`, it will override the internal settings.

 * **`root`**`?: HTMLElement`\
   The root element that the slash will be appended to.
