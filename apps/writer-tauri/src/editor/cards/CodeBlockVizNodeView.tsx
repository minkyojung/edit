// NodeView for `code_block` that renders ```mermaid / ```artifact fences as
// live visualizations in the document body, reusing the chat renderers
// (MermaidBlock / ArtifactBlock). Non-visualization code blocks fall back to
// the default editable `<pre><code>` so normal code (and its proof-mark
// decorations) is untouched.
//
// Model vs view: the diagram/artifact SOURCE stays in the node's text content
// (code_block is `content: 'text*'`), so markdown serialization
// (code-block-ext.ts toMarkdown) keeps working — the visualization is derived,
// never stored. In visualization mode we expose NO contentDOM; editing happens
// in a textarea whose changes are written back via a PM transaction (which
// dirtyTrackerPlugin observes → flush → disk).
//
// Interaction model: a hover toolbar gives ↑ / ↓ / 편집 / 삭제. Reordering is
// via the ↑/↓ buttons (swap with the neighbouring block) rather than mouse
// drag — the same choice Obsidian's core makes (move-line, not block-drag),
// and the only approach that works regardless of an artifact's iframe (which
// would otherwise swallow the mouse). Click selects the block (NodeSelection)
// so Backspace also deletes it. The artifact stays fully interactive in the doc.

import { $prose } from '@milkdown/kit/utils'
import { NodeSelection, Plugin } from '@milkdown/kit/prose/state'
import type { Node as PMNode } from '@milkdown/kit/prose/model'
import type { EditorView, NodeView } from '@milkdown/kit/prose/view'
import { createRoot, type Root } from 'react-dom/client'
import { MermaidBlock } from '@/viz/MermaidBlock'
import { ArtifactBlock } from '@/viz/ArtifactBlock'

const VIZ_LANGS = new Set(['mermaid', 'artifact'])
const SYNC_DEBOUNCE_MS = 300

// Lucide-style 14px stroke icons for the floating toolbar (vanilla DOM, so we
// inline the SVG markup rather than use the React icon components).
const svgIcon = (paths: string) =>
  `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${paths}</svg>`
const ICON_UP = svgIcon('<path d="m18 15-6-6-6 6"/>')
const ICON_DOWN = svgIcon('<path d="m6 9 6 6 6-6"/>')
const ICON_EDIT = svgIcon('<path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4Z"/>')
const ICON_DELETE = svgIcon(
  '<path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M10 11v6"/><path d="M14 11v6"/>',
)

class CodeBlockVizNodeView implements NodeView {
  dom: HTMLElement
  contentDOM?: HTMLElement

  private lang: string
  private readonly isViz: boolean

  // Visualization-mode fields (unused for plain code blocks).
  private root: Root | null = null
  private previewHost: HTMLElement | null = null
  private editorHost: HTMLElement | null = null
  private toolbar: HTMLElement | null = null
  private textarea: HTMLTextAreaElement | null = null
  private editing = false
  private currentCode: string
  private syncTimer: number | null = null

  constructor(
    node: PMNode,
    private readonly view: EditorView,
    private readonly getPos: () => number | undefined,
  ) {
    this.lang = String(node.attrs.language || '').toLowerCase()
    this.isViz = VIZ_LANGS.has(this.lang)
    this.currentCode = node.textContent

    if (!this.isViz) {
      // Plain code block — replicate the default editable rendering. PM owns
      // the contentDOM (so editing + proof-mark decorations are unchanged).
      const pre = document.createElement('pre')
      if (node.attrs.language)
        pre.setAttribute('data-language', String(node.attrs.language))
      const code = document.createElement('code')
      pre.appendChild(code)
      this.dom = pre
      this.contentDOM = code
      return
    }

    this.dom = document.createElement('div')
    this.dom.className = 'viz-block group relative my-2'
    this.dom.setAttribute('contenteditable', 'false')
    this.dom.setAttribute('data-viz-lang', this.lang)
    // Click selects the whole block (NodeSelection) so Backspace / the delete
    // button can remove it. Reorder is via the ↑/↓ toolbar buttons, not drag.
    this.dom.addEventListener('click', this.onClick)

    this.previewHost = document.createElement('div')
    this.root = createRoot(this.previewHost)
    this.buildEditor()
    this.buildToolbar()
    this.dom.append(this.previewHost, this.editorHost!, this.toolbar!)

    // A freshly-typed empty ```mermaid block has nowhere to type without a
    // contentDOM, so start such blocks in edit mode.
    this.editing = this.currentCode.trim().length === 0
    this.syncMode()
  }

  private buildEditor() {
    const host = document.createElement('div')
    host.className = 'rounded-md border bg-background'
    const ta = document.createElement('textarea')
    ta.className =
      'block w-full resize-y bg-transparent p-3 font-mono text-xs text-foreground outline-none'
    ta.spellcheck = false
    ta.rows = 6
    ta.addEventListener('input', () => {
      this.currentCode = ta.value
      this.scheduleSync()
    })
    ta.addEventListener('blur', () => {
      this.flushSync()
      this.editing = false
      this.syncMode()
    })
    ta.addEventListener('keydown', (e) => {
      // Esc or Cmd/Ctrl-Enter leaves edit mode (blur handles the rest).
      if (e.key === 'Escape' || ((e.metaKey || e.ctrlKey) && e.key === 'Enter')) {
        e.preventDefault()
        ta.blur()
      }
    })

    const bar = document.createElement('div')
    bar.className = 'flex justify-end border-t px-2 py-1'
    const done = document.createElement('button')
    done.type = 'button'
    done.textContent = '완료'
    done.className =
      'rounded px-1.5 py-0.5 text-[11px] text-muted-foreground hover:bg-muted'
    done.addEventListener('mousedown', (e) => {
      e.preventDefault()
      ta.blur()
    })
    bar.appendChild(done)

    host.append(ta, bar)
    this.editorHost = host
    this.textarea = ta
  }

  private buildToolbar() {
    // Floating pill: solid surface + border + shadow, with a divider between
    // the move group and the edit/delete group.
    const bar = document.createElement('div')
    bar.className =
      'absolute right-1.5 top-1.5 z-10 flex items-center gap-0.5 rounded-full border bg-popover px-1 py-0.5 text-muted-foreground shadow-md opacity-0 transition-opacity group-hover:opacity-100'

    const mkIconButton = (icon: string, title: string, onPress: () => void) => {
      const btn = document.createElement('button')
      btn.type = 'button'
      btn.title = title
      btn.setAttribute('aria-label', title)
      btn.innerHTML = icon
      btn.className =
        'flex h-6 w-6 items-center justify-center rounded-full hover:bg-muted hover:text-foreground'
      btn.addEventListener('mousedown', (e) => {
        e.preventDefault()
        e.stopPropagation()
        onPress()
      })
      return btn
    }
    const divider = () => {
      const d = document.createElement('div')
      d.className = 'mx-0.5 h-4 w-px bg-border'
      return d
    }

    bar.append(
      mkIconButton(ICON_UP, '위로 이동', () => this.moveBlock(-1)),
      mkIconButton(ICON_DOWN, '아래로 이동', () => this.moveBlock(1)),
      divider(),
      mkIconButton(ICON_EDIT, '소스 편집', () => {
        this.editing = true
        this.syncMode()
      }),
      mkIconButton(ICON_DELETE, '삭제', () => this.deleteSelf()),
    )
    this.toolbar = bar
  }

  // Click selects the whole block so Backspace/Delete removes it, like cards.
  private onClick = (): void => {
    if (this.editing) return
    const pos = this.getPos()
    if (pos == null) return
    const { state } = this.view
    this.view.dispatch(state.tr.setSelection(NodeSelection.create(state.doc, pos)))
  }

  // Swap this block with its previous (-1) / next (+1) sibling. No-op at the
  // edges. PM transaction → dirtyTrackerPlugin re-serializes → flush to disk.
  private moveBlock(dir: -1 | 1): void {
    const pos = this.getPos()
    if (pos == null) return
    const { state } = this.view
    const $pos = state.doc.resolve(pos)
    const parent = $pos.parent
    const index = $pos.index()
    const swapIndex = index + dir
    if (swapIndex < 0 || swapIndex >= parent.childCount) return
    const self = parent.child(index)
    let tr = state.tr
    if (dir === 1) {
      const next = parent.child(index + 1)
      const nextStart = pos + self.nodeSize
      tr = tr.delete(nextStart, nextStart + next.nodeSize).insert(pos, next)
    } else {
      const prev = parent.child(index - 1)
      const prevStart = pos - prev.nodeSize
      tr = tr.delete(pos, pos + self.nodeSize).insert(prevStart, self)
    }
    this.view.dispatch(tr.scrollIntoView())
    this.view.focus()
  }

  private deleteSelf(): void {
    const pos = this.getPos()
    if (pos == null) return
    const { state } = this.view
    const node = state.doc.nodeAt(pos)
    if (!node) return
    this.view.dispatch(state.tr.delete(pos, pos + node.nodeSize))
    this.view.focus()
  }

  private renderPreview() {
    if (!this.root) return
    const code = this.currentCode
    this.root.render(
      this.lang === 'artifact' ? (
        <ArtifactBlock code={code} isStreaming={false} embedded />
      ) : (
        <MermaidBlock code={code} isStreaming={false} embedded />
      ),
    )
  }

  private syncMode() {
    if (!this.previewHost || !this.editorHost || !this.toolbar) return
    this.previewHost.style.display = this.editing ? 'none' : ''
    this.editorHost.style.display = this.editing ? '' : 'none'
    this.toolbar.style.display = this.editing ? 'none' : ''
    if (this.editing) {
      if (this.textarea) {
        this.textarea.value = this.currentCode
        requestAnimationFrame(() => this.textarea?.focus())
      }
    } else {
      this.renderPreview()
    }
  }

  private scheduleSync() {
    if (this.syncTimer != null) window.clearTimeout(this.syncTimer)
    this.syncTimer = window.setTimeout(() => this.flushSync(), SYNC_DEBOUNCE_MS)
  }

  // Write the textarea's text back into the node via a PM transaction.
  // dirtyTrackerPlugin observes the dispatch and re-serializes to markdown.
  private flushSync() {
    if (this.syncTimer != null) {
      window.clearTimeout(this.syncTimer)
      this.syncTimer = null
    }
    const pos = this.getPos()
    if (pos == null) return
    const node = this.view.state.doc.nodeAt(pos)
    if (!node || node.type.name !== 'code_block') return
    if (node.textContent === this.currentCode) return
    const start = pos + 1
    const end = pos + node.nodeSize - 1
    const { schema } = this.view.state
    const tr = this.view.state.tr
    if (this.currentCode.length > 0) {
      tr.replaceWith(start, end, schema.text(this.currentCode))
    } else {
      tr.delete(start, end)
    }
    this.view.dispatch(tr)
  }

  update(node: PMNode): boolean {
    if (node.type.name !== 'code_block') return false
    const lang = String(node.attrs.language || '').toLowerCase()
    const nowViz = VIZ_LANGS.has(lang)
    // A change that crosses the viz/plain boundary, or swaps one viz language
    // for another (mermaid↔artifact), changes the DOM shape — let PM rebuild.
    if (nowViz !== this.isViz) return false
    if (this.isViz && lang !== this.lang) return false

    if (!this.isViz) {
      if (lang !== this.lang) {
        this.lang = lang
        if (node.attrs.language)
          this.dom.setAttribute('data-language', String(node.attrs.language))
        else this.dom.removeAttribute('data-language')
      }
      return true // PM manages the contentDOM
    }

    // React to external text changes (e.g. an AI edit) unless the user is
    // mid-edit in the textarea — don't clobber their typing.
    const newCode = node.textContent
    if (newCode !== this.currentCode && !this.editing) {
      this.currentCode = newCode
      this.renderPreview()
    }
    return true
  }

  selectNode(): void {
    this.dom.classList.add('ProseMirror-selectednode')
  }

  deselectNode(): void {
    this.dom.classList.remove('ProseMirror-selectednode')
  }

  // Viz mode owns its DOM entirely (no contentDOM) → ignore mutations. Plain
  // mode defers to PM so contentDOM editing works.
  ignoreMutation(): boolean {
    return this.isViz
  }

  // While editing, the textarea owns its keystrokes/selection so PM keymaps
  // don't fire. In preview we own click-select, so keep PM from also acting on
  // the click and clobbering our NodeSelection.
  stopEvent(event: Event): boolean {
    if (!this.isViz) return false
    if (this.editing) {
      return !!this.editorHost && this.editorHost.contains(event.target as Node)
    }
    return event.type === 'mousedown' || event.type === 'click'
  }

  destroy(): void {
    this.dom.removeEventListener('click', this.onClick)
    if (this.syncTimer != null) window.clearTimeout(this.syncTimer)
    if (this.root) {
      const root = this.root
      this.root = null
      // Defer so we don't unmount synchronously inside a PM update tick
      // (React warns about unmounting during render).
      queueMicrotask(() => root.unmount())
    }
  }
}

export const codeBlockVizNodeView = $prose(
  () =>
    new Plugin({
      props: {
        nodeViews: {
          code_block: (node, view, getPos) =>
            new CodeBlockVizNodeView(node, view, getPos),
        },
      },
    }),
)
