// Agents page — the main-area entry point for the agent "roles" the user can
// pick for a chat (researcher, translator, proofreader, …). Mirrors
// SkillsPage / RoutinesPage: a grouped list where clicking a row opens that
// role's markdown (`_system/agent/agents/*.md`) in the editor — the files are
// catalogued as notes, so they auto-save like any note. Sits in the AppShell
// content column like any note view.

import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { IconChevronRight, IconUsers, IconTrash } from '@tabler/icons-react'
import { useDocsStore } from '@/state/docsStore'
import { buildViewUrl } from '@/lib/viewUrl'
import { listAgents, AGENTS_REL, type VaultAgent } from '@/lib/agentsLib'
import { deleteAssetByPath } from '@/lib/deleteAsset'
import { confirm } from '@/state/confirmStore'

export function AgentsPage() {
  const [agents, setAgents] = useState<VaultAgent[]>([])
  const [loading, setLoading] = useState(true)
  const navigate = useNavigate()
  const sidebarTab = useDocsStore((s) => s.sidebarTab)
  const dayAnchor = useDocsStore((s) => s.dayAnchor)
  const monthAnchor = useDocsStore((s) => s.monthAnchor)

  useEffect(() => {
    setLoading(true)
    listAgents()
      .then(setAgents)
      .catch(() => setAgents([]))
      .finally(() => setLoading(false))
  }, [])

  const open = (slug: string) => {
    if (!slug) return
    navigate(buildViewUrl({ tab: sidebarTab, dayAnchor, monthAnchor, slug }))
  }

  const remove = async (agent: VaultAgent) => {
    const ok = await confirm({
      title: `Delete “${agent.name}”?`,
      description: 'This cannot be undone.',
    })
    if (!ok) return
    try {
      await deleteAssetByPath(`${AGENTS_REL}/${agent.fileName}`)
      setAgents((cur) => cur.filter((a) => a.fileName !== agent.fileName))
    } catch (err) {
      console.warn('[agents] delete failed', agent.fileName, err)
    }
  }

  return (
    // pt clears the absolutely-positioned EditorHeader AppShell overlays.
    <div className="mx-auto w-full max-w-2xl px-6 pb-16 pt-[calc(var(--header-h)+8px)]">
      <h1 className="mb-4 text-lg font-semibold text-foreground">Agents</h1>

      {loading ? (
        <p className="py-10 text-center text-body text-muted-foreground">Loading…</p>
      ) : agents.length === 0 ? (
        <p className="py-10 text-center text-body text-muted-foreground">
          No agents yet. Opening a vault adds the defaults.
        </p>
      ) : (
        <ul className="overflow-hidden rounded-[10px] border border-border/60 bg-card">
          {agents.map((a, i) => (
            <li key={a.fileName} className="group relative">
              <button
                type="button"
                onClick={() => open(a.slug)}
                disabled={!a.slug}
                className="flex w-full items-center gap-3 pl-3 pr-3.5 text-left transition-colors hover:bg-accent/50 disabled:cursor-default disabled:hover:bg-transparent"
              >
                <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-[7px] bg-secondary text-secondary-foreground">
                  <IconUsers size={16} stroke={2} />
                </span>
                <span
                  className={`flex min-w-0 flex-1 items-center py-2.5 ${
                    i > 0 ? 'border-t border-border/60' : ''
                  }`}
                >
                  <span className="flex-1 truncate text-body font-medium text-foreground">
                    {a.name}
                  </span>
                  <IconChevronRight
                    size={16}
                    stroke={2}
                    className="shrink-0 text-muted-foreground/40"
                  />
                </span>
              </button>
              <button
                type="button"
                aria-label={`Delete ${a.name}`}
                onClick={() => void remove(a)}
                className="absolute top-1/2 right-9 -translate-y-1/2 rounded-md p-1.5 text-muted-foreground opacity-0 transition hover:bg-background hover:text-destructive group-hover:opacity-100"
              >
                <IconTrash size={15} stroke={1.5} />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
