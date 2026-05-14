// Static catalog for the slash menu. Each item is { label, keywords,
// icon, run } — `run` receives the editor view and applies whatever
// PM transformation the item represents. The trigger plugin will have
// already deleted the `/...` text by the time `run` fires, so commands
// see a clean cursor at the position the user typed `/`.
//
// Commands are picked from what the commonmark/gfm presets already
// register; this file is a thin presentational shell over them.

import {
  IconCheckbox,
  IconCode,
  IconH1,
  IconH2,
  IconH3,
  IconLetterCase,
  IconList,
  IconListNumbers,
  IconMinus,
  IconQuote,
} from '@tabler/icons-react'
import type { ComponentType } from 'react'
import { setBlockType, wrapIn } from '@milkdown/kit/prose/commands'
import { wrapInList } from '@milkdown/kit/prose/schema-list'
import type { EditorView } from '@milkdown/kit/prose/view'

import { wrapInTaskList } from './taskList'

export interface SlashItem {
  /** Stable id for keying / debugging. */
  id: string
  /** What the user sees. */
  label: string
  /** Extra strings the query can match besides label. */
  keywords: string[]
  icon: ComponentType<{ size?: number; stroke?: number }>
  /** Apply the item to the document. View focus is the caller's job. */
  run: (view: EditorView) => void
}

function setText(view: EditorView): void {
  const t = view.state.schema.nodes.paragraph
  if (t) setBlockType(t)(view.state, view.dispatch)
}

function setHeading(level: number) {
  return (view: EditorView) => {
    const t = view.state.schema.nodes.heading
    if (t) setBlockType(t, { level })(view.state, view.dispatch)
  }
}

function wrapBullet(view: EditorView): void {
  const t = view.state.schema.nodes.bullet_list
  if (t) wrapInList(t)(view.state, view.dispatch)
}

function wrapNumbered(view: EditorView): void {
  const t = view.state.schema.nodes.ordered_list
  if (t) wrapInList(t)(view.state, view.dispatch)
}

function wrapQuote(view: EditorView): void {
  const t = view.state.schema.nodes.blockquote
  if (t) wrapIn(t)(view.state, view.dispatch)
}

function setCodeBlock(view: EditorView): void {
  const t = view.state.schema.nodes.code_block
  if (t) setBlockType(t)(view.state, view.dispatch)
}

function insertDivider(view: EditorView): void {
  const t = view.state.schema.nodes.hr
  if (!t) return
  const tr = view.state.tr.replaceSelectionWith(t.create())
  view.dispatch(tr.scrollIntoView())
}

export const SLASH_ITEMS: SlashItem[] = [
  {
    id: 'text',
    label: 'Text',
    keywords: ['paragraph', 'plain', 'p'],
    icon: IconLetterCase,
    run: setText,
  },
  {
    id: 'h1',
    label: 'Heading 1',
    keywords: ['title', 'h1', '#'],
    icon: IconH1,
    run: setHeading(1),
  },
  {
    id: 'h2',
    label: 'Heading 2',
    keywords: ['subtitle', 'h2', '##'],
    icon: IconH2,
    run: setHeading(2),
  },
  {
    id: 'h3',
    label: 'Heading 3',
    keywords: ['h3', '###'],
    icon: IconH3,
    run: setHeading(3),
  },
  {
    id: 'bullet',
    label: 'Bullet list',
    keywords: ['ul', 'unordered', 'list', '-'],
    icon: IconList,
    run: wrapBullet,
  },
  {
    id: 'numbered',
    label: 'Numbered list',
    keywords: ['ol', 'ordered', '1.'],
    icon: IconListNumbers,
    run: wrapNumbered,
  },
  {
    id: 'todo',
    label: 'To-do list',
    keywords: ['todo', 'task', 'check', 'checkbox', '[ ]'],
    icon: IconCheckbox,
    run: wrapInTaskList,
  },
  {
    id: 'quote',
    label: 'Quote',
    keywords: ['blockquote', '>'],
    icon: IconQuote,
    run: wrapQuote,
  },
  {
    id: 'code',
    label: 'Code block',
    keywords: ['pre', '```'],
    icon: IconCode,
    run: setCodeBlock,
  },
  {
    id: 'divider',
    label: 'Divider',
    keywords: ['hr', 'rule', '---', 'horizontal'],
    icon: IconMinus,
    run: insertDivider,
  },
]
