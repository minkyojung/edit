---
source: https://milkdown.dev/docs/api/preset-commonmark
fetched: 2026-05-23
milkdown_version: 7.20.0
title: "@milkdown/preset-commonmark"
---

# @milkdown/preset-commonmark

Commonmark preset for [milkdown](https://milkdown.dev/).

```typescript
import { Editor } from '@milkdown/kit/core'
import { commonmark } from '@milkdown/kit/preset/commonmark'

Editor.make().use(commonmark).create()
```

 #### commonmark `: MilkdownPlugin[]`
   The commonmark preset, includes all the plugins.


# Attr

The context with the name `attr` is used to set the attributes of the node and mark.
You can set the attributes by setting the `attr` in `editor.config`.

For example, you can set the `data-test-id` and `class` of all the `paragraph` nodes.

```typescript
import { commonmark, paragraphAttr } from '@milkdown/kit/preset/commonmark'

Editor.make()
  .config((ctx) => {
    ctx.set(paragraphAttr.key, {
      'data-test-id': uuid(),
      class: 'paragraph',
    })
  })
  .use(commonmark)
  .create()
```

---

# Nodes

## Doc

 #### docSchema `: $Node`
   The top-level document node.


## Text

 #### textSchema `: $Node`
   The bottom-level node.


## Paragraph

 #### paragraphAttr `: $NodeAttr`
   HTML attributes for paragraph node.

 #### paragraphSchema `: $NodeSchema`
   Schema for paragraph node.

 #### turnIntoTextCommand `: $Command`
   This command can turn the selected block into paragraph.

 #### paragraphKeymap `: $UserKeymap`
   Keymap for paragraph node.
   - `<Mod-Alt-0>`: Turn the selected block into paragraph.


## Heading

 #### headingAttr `: $NodeAttr`
   HTML attributes for heading node.

 #### headingSchema `: $NodeSchema`
   Schema for heading node.

 #### headingIdGenerator `: $Ctx`
   This is a slice contains a function to generate heading id.
   You can configure it to generate id in your own way.

 #### wrapInHeadingInputRule `: $InputRule`
   This input rule can turn the selected block into heading.
   You can input numbers of `#` and a `space` to create heading.

 #### wrapInHeadingCommand `: $Command`
   This command can turn the selected block into heading.
   You can pass the level of heading to this command.
   By default, the level is 1, which means it will create a `h1` element.

 #### downgradeHeadingCommand `: $Command`
   This command can downgrade the selected heading.
   For example, if you have a `h2` element, and you call this command, you will get a `h1` element.
   If the element is already a `h1` element, it will turn it into a `p` element.

 #### headingKeymap `: $UserKeymap`
   Keymap for heading node.
   - `<Mod-Alt-{1-6}>`: Turn the selected block into `h{1-6}` element.
   - `<Delete>/<Backspace>`: Downgrade the selected heading.


## Image

 #### imageAttr `: $NodeAttr`
   HTML attributes for image node.

 #### imageSchema `: $NodeSchema`
   Schema for image node.

 #### insertImageCommand `: $Command`
   This command will insert a image node.
   You can pass a payload to set `src`, `alt` and `title` for the image node.

 #### updateImageCommand `: $Command`
   This command will update the selected image node.
   You can pass a payload to update `src`, `alt` and `title` for the image node.

 #### insertImageInputRule `: $InputRule`
   This input rule will insert a image node.
   You can input `![alt](src "title")` to insert a image node.
   The `title` is optional.


## Blockquote

 #### blockquoteAttr `: $NodeAttr`
   HTML attributes for blockquote node.

 #### blockquoteSchema `: $NodeSchema`
   Schema for blockquote node.

 #### wrapInBlockquoteInputRule `: $InputRule`
   This input rule will convert a line that starts with `> ` into a blockquote.
   You can type `> ` at the start of a line to create a blockquote.

 #### wrapInBlockquoteCommand `: $Command`
   This command will wrap the current selection in a blockquote.

 #### blockquoteKeymap `: $UserKeymap`
   Keymap for blockquote.
   - `Mod-Shift-b`: Wrap selection in blockquote.


## Ordered List

 #### orderedListAttr `: $NodeAttr`
   HTML attributes for ordered list node.

 #### orderedListSchema `: $NodeSchema`
   Schema for ordered list node.

 #### wrapInOrderedListInputRule `: $InputRule`
   Input rule for wrapping a block in ordered list node.

 #### wrapInOrderedListCommand `: $Command`
   Command for wrapping a block in ordered list node.

 #### orderedListKeymap `: $UserKeymap`
   Keymap for ordered list node.
   - `Mod-Alt-7`: Wrap a block in ordered list.


## Bullet List

 #### bulletListAttr `: $NodeAttr`
   HTML attributes for bullet list node.

 #### bulletListSchema `: $NodeSchema`
   Schema for bullet list node.

 #### wrapInBulletListInputRule `: $InputRule`
   Input rule for wrapping a block in bullet list node.

 #### wrapInBulletListCommand `: $Command`
   Command for creating bullet list node.

 #### bulletListKeymap `: $UserKeymap`
   Keymap for bullet list node.
   - `Mod-Alt-8`: Wrap a block in bullet list.


## List Item

 #### listItemAttr `: $NodeAttr`
   HTML attributes for list item node.

 #### listItemSchema `: $NodeSchema`
   Schema for list item node.

 #### sinkListItemCommand `: $Command`
   The command to sink list item.

   For example:
   ```md
   * List item 1
   * List item 2 <- cursor here
   ```
   Will get:
   ```md
   * List item 1
     * List item 2
   ```

 #### liftListItemCommand `: $Command`
   The command to lift list item.

   For example:
   ```md
   * List item 1
     * List item 2 <- cursor here
   ```
   Will get:
   ```md
   * List item 1
   * List item 2
   ```

 #### splitListItemCommand `: $Command`
   The command to split a list item.

   For example:
   ```md
   * List item 1
   * List item 2 <- cursor here
   ```
   Will get:
   ```md
   * List item 1
   * List item 2
   * <- cursor here
   ```

 #### liftFirstListItemCommand `: $Command`
   The command to remove list item **only if**:

   - Selection is at the start of the list item.
   - List item is the only child of the list.

   Most of the time, you shouldn't use this command directly.

 #### listItemKeymap `: $UserKeymap`
   Keymap for list item node.
   - `<Enter>`: Split the current list item.
   - `<Tab>/<Mod-]>`: Sink the current list item.
   - `<Shift-Tab>/<Mod-[>`: Lift the current list item.


## Code Block

 #### codeBlockAttr `: $NodeAttr`
   HTML attributes for code block node.

 #### codeBlockSchema `: $NodeSchema`
   Schema for code block node.

 #### createCodeBlockInputRule `: $InputRule`
   A input rule for creating code block.
   For example, ` ```javascript ` will create a code block with language javascript.

 #### createCodeBlockCommand `: $Command`
   A command for creating code block.
   You can pass the language of the code block as the parameter.

 #### updateCodeBlockLanguageCommand `: $Command`
   A command for updating the code block language of the target position.

 #### codeBlockKeymap `: $UserKeymap`
   Keymap for code block.
   - `Mod-Alt-c`: Create a code block.


## Hard Break

 #### hardbreakAttr `: $NodeAttr`
   HTML attributes for the hardbreak node.

   Default value:
   - `data-is-inline` - Whether the hardbreak is inline.

 #### hardbreakSchema `: $NodeSchema`
   Hardbreak node schema.

 #### insertHardbreakCommand `: $Command`
   Command to insert a hardbreak.

 #### hardbreakKeymap `: $UserKeymap`
   Keymap for the hardbreak node.
   - `Shift-Enter` - Insert a hardbreak.


## Horizontal Rule

 #### hrAttr `: $NodeAttr`
   HTML attributes for the hr node.

 #### hrSchema `: $NodeSchema`
   Hr node schema.

 #### insertHrInputRule `: $InputRule`
   Input rule to insert a hr.
   For example, `---` will be converted to a hr.

 #### insertHrCommand `: $Command`
   Command to insert a hr.


## HTML

 #### htmlAttr `: $NodeAttr`

 #### htmlSchema `: $NodeSchema`


---

# Marks

## Emphasis

 #### emphasisAttr `: $MarkAttr`
   HTML attributes for the emphasis mark.

 #### emphasisSchema `: $MarkSchema`
   Emphasis mark schema.

 #### toggleEmphasisCommand `: $Command`
   A command to toggle the emphasis mark.

 #### emphasisKeymap `: $UserKeymap`
   Keymap for the emphasis mark.
   - `Mod-i` - Toggle the emphasis mark.

 #### emphasisStarInputRule `: $InputRule`
   Input rule for use `*` to create emphasis mark.

 #### emphasisUnderscoreInputRule `: $InputRule`
   Input rule for use `_` to create emphasis mark.


## Strong

 #### strongAttr `: $MarkAttr`
   HTML attributes for the strong mark.

 #### strongSchema `: $MarkSchema`
   Strong mark schema.

 #### toggleStrongCommand `: $Command`
   A command to toggle the strong mark.

 #### strongKeymap `: $UserKeymap`
   Keymap for the strong mark.
   - `Mod-b` - Toggle the strong mark.

 #### strongInputRule `: $InputRule`
   A input rule that will capture the strong mark.


## Inline Code

 #### inlineCodeAttr `: $MarkAttr`
   HTML attributes for the inlineCode mark.

 #### inlineCodeSchema `: $MarkSchema`
   InlineCode mark schema.

 #### toggleInlineCodeCommand `: $Command`
   A command to toggle the inlineCode mark.

 #### inlineCodeKeymap `: $UserKeymap`
   Keymap for the inlineCode mark.
   - `Mod-e` - Toggle the inlineCode mark.

 #### inlineCodeInputRule `: $InputRule`
   Input rule for create inlineCode mark.


## Link

 #### linkAttr `: $MarkAttr`
   HTML attributes for the link mark.

 #### linkSchema `: $MarkSchema`
   Link mark schema.

 #### toggleLinkCommand `: $Command`
   A command to toggle the link mark.
   You can pass the `href` and `title` to the link.

 #### updateLinkCommand `: $Command`
   A command to update the link mark.
   You can pass the `href` and `title` to update the link.


---

# Utility Commands

 #### isMarkSelectedCommand `: $Command`
   A command to check if a mark is selected.

 #### isNodeSelectedCommand `: $Command`
   A command to check if a node is selected.

 #### clearTextInCurrentBlockCommand `: $Command`
   A command to clear text in the current block.

 #### setBlockTypeCommand `: $Command`
   Set block type to target block and attribute.

 #### wrapInBlockTypeCommand `: $Command`
   A command to wrap the current block with a block type.

 #### addBlockTypeCommand `: $Command`
   A command to add a block type to the current selection.

 #### selectTextNearPosCommand `: $Command`
   A command to select text near a position.


---

# Prosemirror Plugins

 #### inlineNodesCursorPlugin `: $Prose`
   This plugin is to solve the [chrome 98 bug](https://discuss.prosemirror.net/t/cursor-jumps-at-the-end-of-line-when-it-betweens-two-inline-nodes/4641).


 #### hardbreakFilterPlugin `: $Prose`
   This plugin is used to filter the hardbreak node.
   If the hardbreak is going to be inserted within a node that is in the `hardbreakFilterNodes`, ignore it.

 #### hardbreakFilterNodes `: $Ctx`
   This slice contains the nodes that within which the hardbreak will be ignored.


 #### syncHeadingIdPlugin `: $Prose`
   This plugin is used to sync the heading id when the heading content changes.
   It will use the `headingIdGenerator` to generate the id.


 #### syncListOrderPlugin `: $Prose`
   This plugin is used to keep the label of list item up to date in ordered list.


 #### hardbreakClearMarkPlugin `: $Prose`
   This plugin is used to clear the marks around the hardbreak node.


---

# Remark Plugins

 #### remarkInlineLinkPlugin `: $Remark`
   This plugin wraps [remark-inline-links](https://github.com/remarkjs/remark-inline-links).

 #### remarkAddOrderInListPlugin `: $Remark`
   This plugin is used to add order in list for remark AST.

 #### remarkLineBreak `: $Remark`
   This plugin is used to add inline line break for remark AST.
   The inline line break should be treated as a `space`.
   And the normal line break should be treated as a `LF`.

 #### remarkMarker `: $Remark`
   This plugin is used to keep the marker (`_` and `*`) of emphasis and strong nodes.
