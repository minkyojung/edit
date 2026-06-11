// FolderTree — Obsidian-style sidebar tree built from the catalog.
//
// Renders `buildFileTree(knownDocs)` using the same primitives DocTreeNode
// uses (TreeRow + Collapsible + TreeSub), so it's pixel-consistent with the
// existing sidebar. Folders expand/collapse; clicking a file opens it via
// the normal slug URL. Mounted behind the `writer.folderTree` dev flag so
// it coexists with the date views until it's ready to replace them.
//
// Fold state is local + by folder path (not persisted yet) — fine for the
// spike; a persisted store can come with the routing work.

import { useMemo, useState, type MouseEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  IconBrandYoutube,
  IconChevronRight,
  IconFileText,
  IconWorld,
} from '@tabler/icons-react'
import { useDocsStore, type KnownDoc } from '@/state/docsStore'
import { useActiveSlug } from '@/hooks/useActiveSlug'
import { buildFileTree, type TreeNode } from '@/lib/fileTree'
import { buildViewUrl } from '@/lib/viewUrl'
import {
  TreeRow,
  TreeRowLabel,
  TreeRowLead,
  TreeSub,
} from '@/components/ui/tree-row'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible'

function FileIcon({ type }: { type: KnownDoc['type'] }) {
  if (type === 'youtube')
    return <IconBrandYoutube size={16} className="text-red-500" />
  if (type === 'article')
    return <IconWorld size={16} className="text-muted-foreground" />
  return <IconFileText size={16} className="text-muted-foreground" />
}

interface NodeProps {
  node: TreeNode
  expanded: Set<string>
  onToggle: (path: string) => void
  onOpen: (slug: string) => void
  activeSlug: string | null
}

function FolderTreeNode({ node, expanded, onToggle, onOpen, activeSlug }: NodeProps) {
  if (node.kind === 'file') {
    return (
      <li>
        <TreeRow active={node.slug === activeSlug}>
          <TreeRowLead>
            <FileIcon type={node.type} />
          </TreeRowLead>
          <TreeRowLabel onClick={() => onOpen(node.slug)}>
            <span className="truncate">{node.name}</span>
          </TreeRowLabel>
        </TreeRow>
      </li>
    )
  }

  const isOpen = expanded.has(node.path)
  return (
    <Collapsible asChild open={isOpen} onOpenChange={() => onToggle(node.path)}>
      <li>
        <TreeRow>
          <CollapsibleTrigger asChild>
            <TreeRowLead
              aria-label={isOpen ? 'Collapse' : 'Expand'}
              onClick={(e: MouseEvent) => e.stopPropagation()}
            >
              <IconChevronRight
                size={16}
                stroke={1.75}
                className="transition-transform"
                style={{ transform: isOpen ? 'rotate(90deg)' : 'rotate(0deg)' }}
              />
            </TreeRowLead>
          </CollapsibleTrigger>
          <TreeRowLabel onClick={() => onToggle(node.path)}>
            <span className="truncate">{node.name}</span>
          </TreeRowLabel>
        </TreeRow>
        <CollapsibleContent asChild>
          <TreeSub>
            {node.children.map((child) => (
              <FolderTreeNode
                key={child.path}
                node={child}
                expanded={expanded}
                onToggle={onToggle}
                onOpen={onOpen}
                activeSlug={activeSlug}
              />
            ))}
          </TreeSub>
        </CollapsibleContent>
      </li>
    </Collapsible>
  )
}

export function FolderTree() {
  const knownDocs = useDocsStore((s) => s.knownDocs)
  const sidebarTab = useDocsStore((s) => s.sidebarTab)
  const dayAnchor = useDocsStore((s) => s.dayAnchor)
  const monthAnchor = useDocsStore((s) => s.monthAnchor)
  const navigate = useNavigate()
  const activeSlug = useActiveSlug()

  const tree = useMemo(() => buildFileTree(knownDocs), [knownDocs])
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set())

  const onToggle = (path: string) =>
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  const onOpen = (slug: string) =>
    navigate(buildViewUrl({ tab: sidebarTab, dayAnchor, monthAnchor, slug }))

  return (
    <ul className="flex flex-col px-2 py-1">
      {tree.map((node) => (
        <FolderTreeNode
          key={node.path}
          node={node}
          expanded={expanded}
          onToggle={onToggle}
          onOpen={onOpen}
          activeSlug={activeSlug}
        />
      ))}
    </ul>
  )
}
