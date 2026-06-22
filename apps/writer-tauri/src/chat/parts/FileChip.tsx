import {
  IconBrandReact,
  IconFile,
  IconFileCode,
  IconFileText,
} from '@tabler/icons-react'
import type { Icon } from '@tabler/icons-react'

/** A file reference rendered as a bordered chip — a file-type icon + the
 * basename — shown next to an activity row's label (e.g. `Read 563 lines
 * [App.tsx]`, `Edit [note.md]`). The name truncates so a long file name
 * never blows out the row. */
export function FileChip({ name }: { name: string }) {
  const Icon = iconForFile(name)
  return (
    <span className="inline-flex min-w-0 items-center gap-1 rounded-md border border-border px-1.5 py-0.5 text-[13px] text-muted-foreground">
      <Icon size={13} className="shrink-0" />
      <span className="truncate">{name}</span>
    </span>
  )
}

/** Map a file name's extension to a type icon for its chip. */
function iconForFile(name: string): Icon {
  const ext = name.slice(name.lastIndexOf('.') + 1).toLowerCase()
  switch (ext) {
    case 'tsx':
    case 'jsx':
      return IconBrandReact
    case 'ts':
    case 'js':
    case 'mjs':
    case 'cjs':
    case 'json':
    case 'css':
    case 'html':
    case 'py':
    case 'rs':
    case 'go':
      return IconFileCode
    case 'md':
    case 'mdx':
    case 'txt':
      return IconFileText
    default:
      return IconFile
  }
}
