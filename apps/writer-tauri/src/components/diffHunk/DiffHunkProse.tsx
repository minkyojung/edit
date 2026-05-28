// Prose-style diff hunk — React wrapper.
//
// Mirrors `lib/diffHunk/proseDom.ts`. Flat tinted blocks (no padded
// card wrapper) so a single-line change occupies one editor line.
// `.pending-edit-tone--{add|remove}` carries the bg tint via CSS,
// applied to inner paragraphs / headings so the highlight hugs the
// text at the editor's natural line height.

import { renderMarkdownToFragment } from '@/lib/renderMarkdownInline'
import { renderMarkdownViaProseMirror } from '@/lib/renderProseMirrorMarkdown'
import { cn } from '@/lib/utils'

export function DiffHunkProse({
  before,
  after,
  className,
}: {
  before?: string
  after?: string
  className?: string
}) {
  return (
    <div className={cn('flex flex-col', className)}>
      {before && (
        <DiffHunkProseBlock markdown={before} tone="remove" ariaLabel="Before" />
      )}
      {after && (
        <DiffHunkProseBlock markdown={after} tone="add" ariaLabel="After" />
      )}
    </div>
  )
}

function DiffHunkProseBlock({
  markdown,
  tone,
  ariaLabel,
}: {
  markdown: string
  tone: 'add' | 'remove'
  ariaLabel: string
}) {
  return (
    <div
      aria-label={ariaLabel}
      ref={(el) => {
        if (!el) return
        const body = el.querySelector('[data-diff-body]')
        if (!body) return
        body.innerHTML = ''
        const pm = renderMarkdownViaProseMirror(markdown)
        if (pm.ok) body.appendChild(pm.dom)
        else body.appendChild(renderMarkdownToFragment(markdown))
      }}
    >
      {/* `.ProseMirror` makes editor typography apply; tone class
          drives bg tint + margin reset via index.css so the rendered
          paragraph hugs the editor's natural line height. */}
      <div
        data-diff-body
        className={cn(
          'ProseMirror pending-edit-tone',
          tone === 'add'
            ? 'pending-edit-tone--add'
            : 'pending-edit-tone--remove',
        )}
        style={{ minHeight: 0, cursor: 'default' }}
      />
    </div>
  )
}
