---
source: https://milkdown.dev/docs/api/transformer
fetched: 2026-05-23
milkdown_version: 7.20.0
title: "@milkdown/transformer"
---

# @milkdown/transformer

Transformer APIs are used to transform between the editor's prosemirror state and the markdown AST.
In most cases, you don't need to use these APIs directly.
You only need to learn how to use the
[ParserState](#class-parserstate-extends-stack) and [SerializerState](#class-serializerstate-extends-stack)
when writing syntax plugins.

## Parser

#### class ParserState extends Stack



A state machine for parser. Transform remark AST into prosemirror state.

 * **`schema`**`: Schema`\
   The schema in current editor.

 * **`injectRoot`**`(node: MarkdownNode, nodeType: NodeType, attrs?: Attrs) → ParserState`\
   Inject root node for prosemirror state.

 * **`openNode`**`(nodeType: NodeType, attrs?: Attrs) → ParserState`\
   Open a new node, the next operations will
   add nodes into that new node until `closeNode` is called.

 * **`closeNode`**`() → ParserState`\
   Close the current node and push it into the parent node.

 * **`addNode`**`(nodeType: NodeType, attrs?: Attrs, content?: Node[]) → ParserState`\
   Add a node into current node.

 * **`openMark`**`(markType: MarkType, attrs?: Attrs) → ParserState`\
   Open a new mark, the next nodes added will have that mark.

 * **`closeMark`**`(markType: MarkType) → ParserState`\
   Close a opened mark.

 * **`addText`**`(text: string) → ParserState`\
   Add a text node into current node.

 * **`next`**`(nodes?: MarkdownNode | MarkdownNode[] = []) → ParserState`\
   Give the node or node list back to the state and
   the state will find a proper runner (by `match` method in parser spec) to handle it.

 * **`toDoc`**`() → Node`\
   Build the current state into a [prosemirror document](https://prosemirror.net/docs/ref/#model.Document_Structure).

 * **`run`**`(remark: Processor, markdown: string) → ParserState`\
   Transform a markdown string into prosemirror state.

 * `static `**`create`**`(schema: Schema, remark: Processor) → Parser`\
   Create a parser from schema and remark instance.

   ```typescript
   const parser = ParserState.create(schema, remark)
   const prosemirrorNode = parser(SomeMarkdownText)
   ```


 #### type Parser` = fn(text: string) → Node`
   The parser type which is used to transform markdown text into prosemirror node.

#### interface NodeParserSpec



The spec for node parser in schema.

 * **`match`**`(node: MarkdownNode) → boolean`\
   The match function to check if the node is the target node.
   For example:

   ```typescript
   match: (node) => node.type === 'paragraph'
   ```

 * **`runner`**`(state: ParserState, node: MarkdownNode, proseType: NodeType)`\
   The runner function to transform the node into prosemirror node.
   Generally, you should call methods in `state` to add node to state.
   For example:

   ```typescript
   runner: (state, node, type) => {
     state
       .openNode(type)
       .next(node.children)
       .closeNode();
   }
   ```

#### interface MarkParserSpec



The spec for mark parser in schema.

 * **`match`**`(node: MarkdownNode) → boolean`\
   The match function to check if the node is the target mark.
   For example:

   ```typescript
   match: (mark) => mark.type === 'emphasis'
   ```

 * **`runner`**`(state: ParserState, node: MarkdownNode, proseType: MarkType)`\
   The runner function to transform the node into prosemirror mark.
   Generally, you should call methods in `state` to add mark to state.
   For example:

   ```typescript
   runner: (state, node, type) => {
     state
       .openMark(type)
       .next(node.children)
       .closeMark(type)
   }
   ```


## Serializer

#### class SerializerState extends Stack



State for serializer.
Transform prosemirror state into remark AST.

 * **`schema`**`: Schema`\
   Get the schema of state.

 * **`openNode`**`(type: string, value?: string, props?: JSONRecord) → SerializerState`\
   Open a new node, the next operations will
   add nodes into that new node until `closeNode` is called.

 * **`#moveSpaces`**`(element: {type: string, children?: MarkdownNode[], value?: string, props: JSONRecord, push: fn(node: MarkdownNode, ...rest: MarkdownNode[]), pop: fn() → MarkdownNode | undefined}, onPush: fn() → MarkdownNode) → MarkdownNode`

 * **`closeNode`**`() → SerializerState`\
   Close the current node and push it into the parent node.

 * **`addNode`**`(type: string, children?: MarkdownNode[], value?: string, props?: JSONRecord) → SerializerState`\
   Add a node into current node.

 * **`withMark`**`(mark: Mark, type: string, value?: string, props?: JSONRecord) → SerializerState`\
   Open a new mark, the next nodes added will have that mark.
   The mark will be closed automatically.

 * **`closeMark`**`(mark: Mark) → SerializerState`\
   Close a opened mark.
   In most cases you don't need this because
   marks will be closed automatically.

 * **`next`**`(nodes: Node | Fragment) → SerializerState`\
   Give the node or node list back to the state and
   the state will find a proper runner (by `match` method in serializer spec) to handle it.

 * **`toString`**`(remark: Processor) → string`\
   Use a remark parser to serialize current AST stored.

 * **`run`**`(tree: Node) → SerializerState`\
   Transform a prosemirror node tree into remark AST.

 * `static `**`create`**`(schema: Schema, remark: Processor) → Serializer`\
   Create a serializer from schema and remark instance.

   ```typescript
   const serializer = SerializerState.create(schema, remark)
   const markdown = parser(prosemirrorDoc)
   ```


 #### type Serializer` = fn(content: Node) → string`
   The serializer type which is used to transform prosemirror node into markdown text.

#### interface NodeSerializerSpec



The spec for node serializer in schema.

 * **`match`**`(node: Node) → boolean`\
   The match function to check if the node is the target node.
   For example:

   ```typescript
   match: (node) => node.type.name === 'paragraph'
   ```

 * **`runner`**`(state: SerializerState, node: Node)`\
   The runner function to transform the node into markdown text.
   Generally, you should call methods in `state` to add node to state.
   For example:

   ```typescript
   runner: (state, node) => {
     state
       .openNode(node.type.name)
       .next(node.content)
       .closeNode();
   }
   ```

#### interface MarkSerializerSpec



The spec for mark serializer in schema.

 * **`match`**`(mark: Mark) → boolean`\
   The match function to check if the node is the target mark.
   For example:

   ```typescript
   match: (mark) => mark.type.name === 'emphasis'
   ```

 * **`runner`**`(state: SerializerState, mark: Mark, node: Node) → boolean | undefined`\
   The runner function to transform the node into markdown text.
   Generally, you should call methods in `state` to add mark to state.
   For example:

   ```typescript
   runner: (state, mark, node) => {
     state.withMark(mark, 'emphasis');
   }
   ```


---

## Schema

#### interface NodeSchema

 extends `NodeSpec`

Schema spec for node. It is a super set of [NodeSpec](https://prosemirror.net/docs/ref/#model.NodeSpec).

 * **`toMarkdown`**`: NodeSerializerSpec`\
   To markdown serializer spec.

 * **`parseMarkdown`**`: NodeParserSpec`\
   Parse markdown serializer spec.

 * **`priority`**`?: number`\
   The priority of the node, by default it's 50.

#### interface MarkSchema

 extends `MarkSpec`

Schema spec for mark. It is a super set of [MarkSpec](https://prosemirror.net/docs/ref/#model.MarkSpec).

 * **`toMarkdown`**`: MarkSerializerSpec`\
   To markdown serializer spec.

 * **`parseMarkdown`**`: MarkParserSpec`\
   Parse markdown serializer spec.


## Utility Types

#### interface RemarkPlugin`<T = Record&lt;string, unknown>>`



The universal type of a [remark plugin](https://github.com/remarkjs/remark/blob/main/doc/plugins.md).

 * **`plugin`**`: Plugin`

 * **`options`**`: T`

 #### type RemarkParser` = Processor`
   The type of [remark instance](https://github.com/remarkjs/remark/tree/main/packages/remark#remark-1).

 #### type MarkdownNode` = Node & {children?: MarkdownNode[], [string]: unknown}`
   The universal type of a node in [mdast](https://github.com/syntax-tree/mdast).


## Stack

#### class Stack`<Node, Element extends StackElement>`



The stack that is used to store the elements.

> Generally, you don't need to use this class directly.

When using the stack, users can call `stack.open` to push a new element into the stack.
And use `stack.push` to push a node into the top element.
Then use `stack.close` to close the top element and pop it.

For example: `stack.open(A).push(B).push(C).close()` will generate a structure like `A(B, C)`.

 * **`size`**`() → number`\
   Get the size of the stack.

 * **`top`**`() → Element | undefined`\
   Get the top element of the stack.

 * **`push`**`(node: Node)`\
   Push a node into the top element.

 * **`open`**`(node: Element)`\
   Push a new element.

 * **`close`**`() → Element`\
   Close the top element and pop it.

#### abstract class StackElement`<Node>`



The element of the stack, which holds an array of nodes.

 * **`push`**`(node: Node, ...rest: Node[])`\
   A method that can `push` a node into the element.
