---
source: https://milkdown.dev/docs/api/utils
fetched: 2026-05-23
milkdown_version: 7.20.0
title: "@milkdown/utils"
---

# @milkdown/utils

# Composable

## Basic

 #### $ctx `<T, N extends string>(value: T, name: N) → $Ctx`
   Create a slice plugin. The plugin will be registered in the `ctx` and can be accessed by other parts of the editor.
   ```ts
   const counterCtx = $ctx(0, 'counter');
   ```

   Additional property:
   - `key`: The key of the slice.


 #### $remark `<Id extends string, Options>(id: Id, remark: fn(ctx: Ctx) → RemarkPluginRaw, initialOptions?: NonNullable) → $Remark`
   Create a milkdown wrapper for [remark plugin](https://github.com/remarkjs/remark/blob/main/doc/plugins.md).
   It takes a factory function which returns a [remark plugin](https://github.com/remarkjs/remark/blob/main/doc/plugins.md).

   Additional property:
   - `id`: The id of the remark plugin.
   - `plugin`: The remark plugin created.
   - `options`: The ctx contains the options of the remark plugin.


 #### $node `(id: string, schema: fn(ctx: Ctx) → NodeSchema) → $Node`
   Create a node plugin.
   It takes a node id and a factory function.
   The factory should return a function that returns a [node schema](/transformer#interface-nodeschema).

   Additional property:
   - `id`: The id of the node.
   - `schema`: The node schema created.
   - `type`: A function that will return the [prosemirror node type](https://prosemirror.net/docs/ref/#model.NodeType).

 #### $nodeAsync `(id: string, schema: fn(ctx: Ctx) → Promise, timerName?: string) → WithTimer`
   The async version for `$node`. You can use `await` in the factory when creating the node schema.

   Additional property:
   - `id`: The id of the node.
   - `schema`: The node schema created.
   - `type`: A function that will return the [prosemirror node type](https://prosemirror.net/docs/ref/#model.NodeType).
   - `timer`: The timer which will be resolved when the node schema is ready.


 #### $mark `(id: string, schema: fn(ctx: Ctx) → MarkSchema) → $Mark`
   Create a mark plugin.
   It takes a mark id and a factory function.
   The factory should return a function that returns a [mark schema](/transformer#interface-markschema).

   Additional property:
   - `id`: The id of the mark.
   - `schema`: The mark schema created.
   - `type`: A function that will return the [prosemirror mark type](https://prosemirror.net/docs/ref/#model.MarkType).

 #### $markAsync `(id: string, schema: fn(ctx: Ctx) → Promise, timerName?: string) → WithTimer`
   The async version for `$mark`. You can use `await` in the factory when creating the mark schema.

   Additional property:
   - `id`: The id of the mark.
   - `schema`: The mark schema created.
   - `type`: A function that will return the [prosemirror mark type](https://prosemirror.net/docs/ref/#model.MarkType).
   - `timer`: The timer which will be resolved when the mark schema is ready.


 #### $prose `(prose: fn(ctx: Ctx) → Plugin) → $Prose`
   Create a milkdown wrapper for [prosemirror plugin](https://prosemirror.net/docs/ref/#state.Plugin).
   It takes a factory function which returns a [prosemirror plugin](https://prosemirror.net/docs/ref/#state.Plugin).

   Additional property:
   - `plugin`: The prosemirror plugin created.
   - `key`: The [prosemirror plugin key](https://prosemirror.net/docs/ref/#state.PluginKey) of the plugin.

 #### $proseAsync `(prose: fn(ctx: Ctx) → Promise, timerName?: string) → WithTimer`
   The async version for `$prose`. You can use `await` in the factory when creating the plugin.

   Additional property:
   - `plugin`: The prosemirror plugin created.
   - `key`: The [prosemirror plugin key](https://prosemirror.net/docs/ref/#state.PluginKey) of the plugin.
   - `timer`: The timer which will be resolved when the plugin is ready.


 #### $inputRule `(inputRule: fn(ctx: Ctx) → InputRule) → $InputRule`
   Create an input rule plugin.
   It takes a factory function which returns a [prosemirror input rule](https://prosemirror.net/docs/ref/#inputrules.InputRule).

   Additional property:
   - `inputRule`: The prosemirror input rule created.

 #### $inputRuleAsync `(inputRule: fn(ctx: Ctx) → Promise, timerName?: string) → WithTimer`
   The async version for `$inputRule`. You can use `await` in the factory when creating the input rule.

   Additional property:
   - `inputRule`: The prosemirror input rule created.
   - `timer`: The timer which will be resolved when the input rule is ready.


 #### $pasteRule `(pasteRule: fn(ctx: Ctx) → PasteRule) → $PasteRule`
   Create a paste rule plugin.
   It takes a factory function which returns a paste rule.

   Additional property:
   - `pasteRule`: The paste rule created.

 #### $pasteRuleAsync `(pasteRule: fn(ctx: Ctx) → Promise, timerName?: string) → WithTimer`
   The async version for `$pasteRule`. You can use `await` in the factory when creating the paste rule.

   Additional property:
   - `pasteRule`: The paste rule created.
   - `timer`: The timer which will be resolved when the paste rule is ready.


 #### $shortcut `(shortcut: fn(ctx: Ctx) → Keymap) → $Shortcut`
   Create a shortcut for the editor.
   It takes a factory function which returns a [prosemirror keymap](https://prosemirror.net/docs/ref/#keymap).

   Additional property:
   - `keymap`: The prosemirror keymap created.

 #### $shortcutAsync `(shortcut: fn(ctx: Ctx) → Promise, timerName?: string) → WithTimer`
   The async version for `$shortcut`. You can use `await` in the factory when creating the keymap.

   Additional property:
   - `keymap`: The prosemirror keymap created.
   - `timer`: The timer which will be resolved when the plugin is ready.


 #### $command `<T, K extends string>(key: K, cmd: fn(ctx: Ctx) → Cmd) → $Command`
   Create a command plugin. The command will be registered in the `commandsCtx` and can be called by other parts of the editor.
   It takes a key and a factory function. The factory function will be called when the plugin is created.
   The factory should return a function that will be called when the command is executed.
   The function should receive at **most one parameter**, which is the payload of the command.
   And the payload should always be **optional**.

   ```ts
   import { setBlockType } from '@milkdown/prose/commands'

   const commandPlugin = $command('SetAsHeading', (ctx) => {
     return (level = 1) => setBlockType(headingSchema.type(), { level });
   });
   ```

   Additional property:
   - `key`: The key of the command.
   - `run`: The function to run the command.

   You can use `callCommand` in `editor.action` to call the command.

   ```ts
   import { callCommand } from '@milkdown/utils';
   const editor = Editor.make().use(/* some plugins */).use(commandPlugin).create();

   editor.action(callCommand(commandPlugin.key, 3));
   ```

 #### $commandAsync `<T, K extends string>(key: K, cmd: fn(ctx: Ctx) → Promise, timerName?: string) → WithTimer`
   The async version for `$command`. You can use `await` in the factory when creating the command.
   ```ts
   const commandPlugin = $commandASync('LoadRemoteDoc', (ctx) => {
     return async (url = 'my-remote-api') => {
       const doc = await LoadRemoteDoc(url);
       return addDoc(doc);
     }
   });
   ```

   Additional property:
   - `key`: The key of the command.
   - `run`: The function to run the command.
   - `timer`: The timer which will be resolved when the command is ready.


 #### $view `<T extends $Mark | $Node, V extends NodeViewConstructor | MarkViewConstructor = GetConstructor&lt;T>>(type: T, view: fn(ctx: Ctx) → V) → $View`
   Create a [prosemirror node/mark view](https://prosemirror.net/docs/ref/#view.NodeView) plugin.
   It takes two arguments
   - `type`: The node/mark plugin that needs to add a view.
   - `view`: The factory that creates the view. It should return a function that returns a [node/mark view constructor](https://prosemirror.net/docs/ref/#view.NodeView).

   Additional property:
   - `view`: The view created.
   - `type`: The node/mark plugin that needs to add a view.

 #### $viewAsync `<T extends $Mark | $Node, V extends NodeViewConstructor | MarkViewConstructor = GetConstructor&lt;T>>(type: T, view: fn(ctx: Ctx) → Promise, timerName?: string) → WithTimer`
   The async version for `$view`. You can use `await` in the factory when creating the view.

   Additional property:
   - `view`: The view created.
   - `type`: The node/mark plugin that needs to add a view.
   - `timer`: The timer which will be resolved when the view is ready.


## Composed

 #### $nodeAttr `(name: string, value?: fn(node: Node) → Record = () => ({})) → $NodeAttr`
   Create a slice which contains the attributes for node schema.

 #### $nodeSchema `<T extends string>(id: T, schema: GetNodeSchema) → $NodeSchema`
   Create a plugin for node schema.
   The first parameter is the id of the node schema.
   The second parameter is the function that returns the node schema.

   The function will return a plugin with additional properties:
   - `id`: The id of the node schema.
   - `type`: A function witch will return the type of the node schema.
   - `ctx`: The context of the node schema.
   - `node`: The node schema plugin.
   - `schema`: The node schema.
   - `key`: The key of slice which contains the node schema factory.
   - `extendSchema`: A function witch will return a plugin that can extend the node schema.


 #### $markAttr `(name: string, value?: fn(mark: Mark) → Record = () => ({})) → $MarkAttr`
   Create a slice which contains the attributes for mark schema.

 #### $markSchema `<T extends string>(id: T, schema: GetMarkSchema) → $MarkSchema`
   Create a plugin for mark schema.
   The first parameter is the id of the mark schema.
   The second parameter is the function that returns the mark schema.

   The function will return a plugin with additional properties:
   - `id`: The id of the mark schema.
   - `type`: A function witch will return the type of the mark schema.
   - `ctx`: The context of the mark schema.
   - `mark`: The mark schema plugin.
   - `schema`: The mark schema.
   - `key`: The key of slice which contains the mark schema factory.
   - `extendSchema`: A function witch will return a plugin that can extend the mark schema.


 #### $useKeymap `<N extends string, Key extends string>(name: N, userKeymap: UserKeymapConfig) → $UserKeymap`
   Create a keymap which can be customized by user.
   It takes two arguments:
   - `name`: The name of the keymap.
   - `userKeymap`: The keymap config which contains the shortcuts and the command.


# Macros

 #### getHTML `() → fn(ctx: Ctx) → string`
   Get content of the editor as HTML string.

 #### getMarkdown `(range?: {from: number, to: number}) → fn(ctx: Ctx) → string`
   Get content of the editor as markdown string.
   If range is provided, it will return the markdown string of the range.
   If range is not provided, it will return the markdown string of the whole document.

 #### outline `() → fn(ctx: Ctx) → {text: string, level: number, id: string}[]`
   Get outline of the editor.


 #### markdownToSlice `(markdown: string) → fn(ctx: Ctx) → Slice`
   Convert markdown string to slice.


 #### insert `(markdown: string, inline?: boolean = false) → fn(ctx: Ctx)`
   Insert markdown string into the editor.

 #### insertPos `(markdown: string, pos: number, inline?: boolean = false) → fn(ctx: Ctx)`
   Insert markdown string to the given position.
   If inline is true, the markdown will be inserted as inline text.
   If inline is false, the markdown will be inserted as block text.

 #### replaceAll `(markdown: string, flush?: boolean = false) → fn(ctx: Ctx)`
   Replace all content of the editor with markdown string.
   If flush is true, the editor state will be re-created.

 #### replaceRange `(markdown: string, range: {from: number, to: number}) → fn(ctx: Ctx)`
   Replace the content of the given range with the markdown string.

 #### callCommand `<T extends CmdKey>(slice: string, payload?: NonNullable) → fn(ctx: Ctx) → boolean`
   **`callCommand`**`<T>(slice: CmdKey, payload?: NonNullable) → fn(ctx: Ctx) → boolean`
   **`callCommand`**`(slice: string | CmdKey, payload?: any) → fn(ctx: Ctx) → boolean`
   Call a command. You can pass the command key and the payload to the macro.


 #### setAttr `(pos: number, update: fn(prevAttrs: Attrs) → Attrs) → fn(ctx: Ctx)`
   Set the attributes of the node at the given position.

 #### forceUpdate `() → fn(ctx: Ctx)`
   Force update the editor.
