---
source: https://milkdown.dev/docs/api/core
fetched: 2026-05-23
milkdown_version: 7.20.0
title: "@milkdown/core"
---

# @milkdown/core

The core module for milkdown.

# Editor

#### class Editor



The milkdown editor class.

 * **`ctx`**`: Ctx`\
   Get the ctx of the editor.

 * **`status`**`: EditorStatus`\
   Get the status of the editor.

 * **`enableInspector`**`(enable?: boolean = true) → Editor`\
   Enable the inspector for the editor.
   You can also pass `false` to disable the inspector.

 * **`onStatusChange`**`(onChange: OnStatusChange) → Editor`\
   Subscribe to the status change event for the editor.
   The new subscription will replace the old one.

 * **`config`**`(configure: Config) → Editor`\
   Add a config for the editor.

 * **`removeConfig`**`(configure: Config) → Editor`\
   Remove a config for the editor.

 * **`use`**`(plugins: MilkdownPlugin | MilkdownPlugin[]) → Editor`\
   Use a plugin or a list of plugins for the editor.

 * **`remove`**`(plugins: MilkdownPlugin | MilkdownPlugin[]) → Promise`\
   Remove a plugin or a list of plugins from the editor.

 * **`create`**`() → Promise`\
   Create the editor with current config and plugins.
   If the editor is already created, it will be recreated.

 * **`destroy`**`(clearPlugins?: boolean = false) → Promise`\
   Destroy the editor.
   If you want to clear all plugins, set `clearPlugins` to `true`.

 * **`action`**`<T>(action: fn(ctx: Ctx) → T) → T`\
   Call an action with the ctx of the editor.
   This method should be used after the editor is created.

 * **`inspect`**`() → Telemetry[]`\
   Get inspections of plugins in editor.
   Make sure you have enabled inspector by `editor.enableInspector()` before calling this method.

 * `static `**`make`**`() → Editor`\
   Create a new editor instance.


 #### enum `EditorStatus`
   The status of the editor.

   * **`Idle`**\
     The editor is not initialized.

   * **`OnCreate`**\
     The editor is creating.

   * **`Created`**\
     The editor has been created and ready to use.

   * **`OnDestroy`**\
     The editor is destroying.

   * **`Destroyed`**\
     The editor has been destroyed.
 #### type OnStatusChange` = fn(status: EditorStatus)`
   Type for the callback called when editor status changed.


---

# Internal Plugins

## Config

 #### config `(configure: Config) → MilkdownPlugin`
   The config plugin.
   This plugin will load all user configs.


### Timer

 #### ConfigReady `: TimerType`
   The timer which will be resolved when the config plugin is ready.


## Init

 #### init `(editor: Editor) → MilkdownPlugin`
   The init plugin.
   This plugin prepare slices that needed by other plugins. And create a remark instance.

   This plugin will wait for the config plugin.


### Timer

 #### InitReady `: TimerType`
   The timer which will be resolved when the init plugin is ready.


### Slice

 #### initTimerCtx `: SliceType`
   A slice which stores timers that need to be waited for before starting to run the plugin.
   By default, it's `[ConfigReady]`.


 #### editorCtx `: SliceType`
   A slice which stores the editor instance.

 #### prosePluginsCtx `: SliceType`
   A slice which stores the prosemirror plugins.

 #### inputRulesCtx `: SliceType`
   A slice which stores the input rules.

 #### nodeViewCtx `: SliceType`
   A slice which stores the prosemirror node views.

 #### markViewCtx `: SliceType`
   A slice which stores the prosemirror mark views.


 #### remarkPluginsCtx `: SliceType`
   A slice which stores the remark plugins.

 #### remarkCtx `: SliceType`
   A slice which stores the remark instance.

 #### remarkStringifyOptionsCtx `: SliceType`
   A slice which stores the remark stringify options.


## Schema

 #### schema `: MilkdownPlugin`
   The schema plugin.
   This plugin will load all nodes spec and marks spec and create a schema.

   This plugin will wait for the init plugin.


### Timer

 #### SchemaReady `: TimerType`
   The timer which will be resolved when the schema plugin is ready.


### Slice

 #### schemaTimerCtx `: SliceType`
   A slice which stores timers that need to be waited for before starting to run the plugin.
   By default, it's `[InitReady]`.


 #### nodesCtx `: SliceType`
   A slice which stores the nodes spec.

 #### marksCtx `: SliceType`
   A slice which stores the marks spec.

 #### schemaCtx `: SliceType`
   A slice which contains the schema.


## Parser

 #### parser `: MilkdownPlugin`
   The parser plugin.
   This plugin will create a parser.

   This plugin will wait for the schema plugin.


### Timer

 #### ParserReady `: TimerType`
   The timer which will be resolved when the parser plugin is ready.


### Slice

 #### parserTimerCtx `: SliceType`
   A slice which stores timers that need to be waited for before starting to run the plugin.
   By default, it's `[SchemaReady]`.


 #### parserCtx `: SliceType`
   A slice which contains the parser.


## Serializer

 #### serializer `: MilkdownPlugin`
   The serializer plugin.
   This plugin will create a serializer.

   This plugin will wait for the schema plugin.


### Timer

 #### SerializerReady `: TimerType`
   The timer which will be resolved when the serializer plugin is ready.


### Slice

 #### serializerTimerCtx `: SliceType`
   A slice which stores timers that need to be waited for before starting to run the plugin.
   By default, it's `[SchemaReady]`.


 #### serializerCtx `: SliceType`
   A slice which contains the serializer.


## Commands

 #### commands `: MilkdownPlugin`
   The commands plugin.
   This plugin will create a command manager.

   This plugin will wait for the schema plugin.

#### class CommandManager



The command manager.
This manager will manage all commands in editor.
Generally, you don't need to use this manager directly.
You can use the `$command` and `$commandAsync` in `@milkdown/utils` to create and call a command.

 * **`ctx`**`: Ctx | null`

 * **`create`**`<T>(meta: CmdKey, value: Cmd) → Slice`\
   Register a command into the manager.

 * **`get`**`<T extends CmdKey>(slice: string) → Cmd`\
   **`get`**`<T>(slice: CmdKey) → Cmd`\
   **`get`**`(slice: string | CmdKey) → Cmd`\
   Get a command from the manager.

 * **`remove`**`<T extends CmdKey>(slice: string)`\
   **`remove`**`<T>(slice: CmdKey)`\
   **`remove`**`(slice: string | CmdKey)`\
   Remove a command from the manager.

 * **`call`**`<T extends CmdKey>(slice: string, payload?: NonNullable) → boolean`\
   **`call`**`<T>(slice: CmdKey, payload?: NonNullable) → boolean`\
   **`call`**`(slice: string | CmdKey, payload?: any) → boolean`\
   Call a registered command.

 * **`inline`**`(command: Command) → boolean`\
   Call an inline command.

 * **`chain`**`() → CommandChain`\
   Create a command chain.
   All commands added by `pipe` will be run in order until one of them returns `true`.

 #### createCmdKey `<T = undefined>(key?: string = 'cmdKey') → CmdKey`
   Create a command key, which is a slice type that contains a command.


#### interface CommandChain



A chainable command helper.

 * **`run`**`() → boolean`\
   Run the command chain.

 * **`inline`**`(command: Command) → CommandChain`\
   Add an inline command to the chain.

 * **`pipe`**`<T extends CmdKey>(slice: string, payload?: NonNullable) → CommandChain`\
   **`pipe`**`<T>(slice: CmdKey, payload?: NonNullable) → CommandChain`\
   **`pipe`**`(slice: string | CmdKey, payload?: any) → CommandChain`\
   Add a registered command to the chain.


### Timer

 #### CommandsReady `: TimerType`
   The timer which will be resolved when the commands plugin is ready.


### Slice

 #### commandsTimerCtx `: SliceType`
   A slice which stores timers that need to be waited for before starting to run the plugin.
   By default, it's `[SchemaReady]`.


 #### commandsCtx `: SliceType`
   A slice which contains the command manager.


## Keymap

 #### keymap `: MilkdownPlugin`
   The keymap plugin.
   This plugin will create a keymap manager.

   This plugin will wait for the schema plugin.

#### class KeymapManager



The keymap manager.
This class is used to manage the keymap.

 * **`#keymap`**`: KeymapItem[]`

 * **`ctx`**`: Ctx | null`

 * **`add`**`(keymap: KeymapItem) → fn()`\
   Add a keymap item.
   When not passing a priority, the priority will be 50.
   For the same key, the keymap with higher priority will be executed first.
   If the priority is the same, the keymap will be executed in the order of addition.

 * **`addObjectKeymap`**`(keymaps: Record) → fn()`\
   Add an object of keymap items.

 * **`addBaseKeymap`**`() → fn()`\
   Add the prosemirror base keymap.


### Timer

 #### KeymapReady `: TimerType`
   The timer which will be resolved when the keymap plugin is ready.


### Slice

 #### keymapTimerCtx `: SliceType`
   A slice which stores timers that need to be waited for before starting to run the plugin.
   By default, it's `[SchemaReady]`.


 #### keymapCtx `: SliceType`
   A slice which stores the keymap manager.


## Paste Rules

 #### pasteRule `: MilkdownPlugin`
   The paste rule plugin.
   This plugin will collect the paste rules to the editor view.

   This plugin will wait for the schema plugin.


### Timer

 #### PasteRulesReady `: TimerType`
   The timer which will be resolved when the paste rule plugin is ready.


### Slice

 #### pasteRulesTimerCtx `: SliceType`
   A slice which stores timers that need to be waited for before starting to run the paste rule plugin.
   By default, it's `[SchemaReady]`.


 #### pasteRulesCtx `: SliceType`
   A slice which contains the paste rules.

#### type PasteRule



A paste rule function which takes a slice and returns a new slice.

 * **`run`**`(slice: Slice, view: EditorView, isPlainText: boolean) → Slice`\
   The function to run the paste rule.

 * **`priority`**`?: number`\
   The priority of the paste rule. Higher priority rules will be run first. Default is 50.


## EditorState

 #### editorState `: MilkdownPlugin`
   The editor state plugin.
   This plugin will create a prosemirror editor state.

   This plugin will wait for the parser plugin, serializer plugin and commands plugin.


### Timer

 #### EditorStateReady `: TimerType`
   The timer which will be resolved when the editor state plugin is ready.


### Slice

 #### editorStateTimerCtx `: SliceType`
   A slice which stores timers that need to be waited for before starting to run the plugin.
   By default, it's `[ParserReady, SerializerReady, CommandsReady]`.


 #### editorStateCtx `: SliceType`
   A slice which contains the editor state.

 #### editorStateOptionsCtx `: SliceType`
   A slice which contains the options which is used to create the editor state.


## EditorView

 #### editorView `: MilkdownPlugin`
   The editor view plugin.
   This plugin will create an editor view.

   This plugin will wait for the editor state plugin.


### Timer

 #### EditorViewReady `: TimerType`
   The timer which will be resolved when the editor view plugin is ready.


### Ctx

 #### editorViewTimerCtx `: SliceType`
   A slice which stores timers that need to be waited for before starting to run the plugin.
   By default, it's `[EditorStateReady]`.


 #### defaultValueCtx `: SliceType`
   A slice which contains the default value of the editor.
   Can be markdown string, html string or json.

 #### rootCtx `: SliceType`
   A slice which contains the value to get the root element.
   Can be a selector string, a node or null.
   If it's null, the editor will be created in the body.

 #### rootDOMCtx `: SliceType`
   A slice which contains the actually root element.

 #### rootAttrsCtx `: SliceType`
   A slice which contains the root element attributes.
   You can add attributes to the root element by this slice.


 #### editorViewCtx `: SliceType`
   A slice which contains the editor view instance.

 #### editorViewOptionsCtx `: SliceType`
   A slice which contains the editor view options which will be passed to the editor view.
