---
source: https://milkdown.dev/docs/api/plugin-tooltip
fetched: 2026-05-23
milkdown_version: 7.20.0
title: "@milkdown/plugin-tooltip"
---

# @milkdown/plugin-tooltip

Tooltip plugin for [milkdown](https://milkdown.dev/).
Add support for universal tooltip in milkdown.

## Usage

#### Create Tooltip View

Create tooltip view is simple.
All you need to do is to implement the [Prosemirror Plugin.view](https://prosemirror.net/docs/ref/#state.PluginSpec.view).

```typescript
import { TooltipProvider } from '@milkdown/kit/plugin/tooltip'

function tooltipPluginView(view) {
  const content = document.createElement('div')

  const provider = new TooltipProvider({
    content: this.content,
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

#### Bind Tooltip View

You need to bind the tooltip view to the plugin in `editor.config`.

```typescript
import { Editor } from '@milkdown/core'
import { tooltipFactory } from '@milkdown/plugin-tooltip'

const tooltip = tooltipFactory('my-tooltip')

Editor.make()
  .config((ctx) => {
    ctx.set(tooltip.key, {
      view: tooltipPluginView,
    })
  })
  .use(tooltip)
  .create()
```

## Use with React

[![Open in StackBlitz](https://developer.stackblitz.com/img/open_in_stackblitz.svg)](https://stackblitz.com/github/Milkdown/examples/tree/main/react-tooltip)

## Use with Vue

[![Open in StackBlitz](https://developer.stackblitz.com/img/open_in_stackblitz.svg)](https://stackblitz.com/github/Milkdown/examples/tree/main/vue-tooltip)

## API

 #### tooltipFactory `<Id extends string, State = any>(id: Id) → TooltipPlugin`
   Create a tooltip plugin with a unique id.


#### class TooltipProvider



A provider for creating tooltip.

 * `new `**`TooltipProvider`**`(options: TooltipProviderOptions)`

 * **`element`**`: HTMLElement`\
   The root element of the tooltip.

 * **`onShow`**`()`\
   On show callback.

 * **`onHide`**`()`\
   On hide callback.

 * **`#updatePosition`**`(reference: VirtualElement)`\
   @internel

 * **`update`**`(view: EditorView, prevState?: EditorState)`\
   Update provider state by editor view.

 * **`destroy`**`()`\
   Destroy the tooltip.

 * **`show`**`(virtualElement?: VirtualElement, editorView?: EditorView)`\
   Show the tooltip.

 * **`hide`**`()`\
   Hide the tooltip.

#### interface TooltipProviderOptions



Options for tooltip provider.

 * **`content`**`: HTMLElement`\
   The tooltip content.

 * **`debounce`**`?: number`\
   The debounce time for updating tooltip, 200ms by default.

 * **`shouldShow`**`?: fn(view: EditorView, prevState?: EditorState) → boolean`\
   The function to determine whether the tooltip should be shown.

 * **`offset`**`?: OffsetOptions`\
   The offset to get the block. Default is 0.

 * **`shift`**`?: instantiated`\
   The amount to shift options the block by.

 * **`middleware`**`?: instantiated[]`\
   Other middlewares for floating ui. This will be added after the internal middlewares.

 * **`floatingUIOptions`**`?: Partial`\
   Options for floating ui. If you pass `middleware` or `placement`, it will override the internal settings.

 * **`root`**`?: HTMLElement`\
   The root element that the tooltip will be appended to.
