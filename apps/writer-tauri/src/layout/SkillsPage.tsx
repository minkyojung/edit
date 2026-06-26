// Skills page — the main-area entry point for the skills the chat agent has
// learned (propose_skill → Keep). Reached from the single "Skills" footer
// row. Rendered as a grouped settings-style list: each row is icon + name +
// chevron; clicking opens its SKILL.md in the editor (skills are catalogued
// as notes). A hover-revealed trash deletes. Sits in the AppShell content
// column like any note view — not a modal.

import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { IconBolt, IconChevronRight, IconTrash } from '@tabler/icons-react'
import { useDocsStore } from '@/state/docsStore'
import { buildViewUrl } from '@/lib/viewUrl'
import { listSkills, deleteSkill, type VaultSkill } from '@/lib/skillsLib'

export function SkillsPage() {
  const [skills, setSkills] = useState<VaultSkill[]>([])
  const [loading, setLoading] = useState(true)
  const navigate = useNavigate()
  const sidebarTab = useDocsStore((s) => s.sidebarTab)
  const dayAnchor = useDocsStore((s) => s.dayAnchor)
  const monthAnchor = useDocsStore((s) => s.monthAnchor)

  useEffect(() => {
    setLoading(true)
    listSkills()
      .then(setSkills)
      .catch(() => setSkills([]))
      .finally(() => setLoading(false))
  }, [])

  const openSkill = (slug: string) => {
    if (!slug) return
    navigate(buildViewUrl({ tab: sidebarTab, dayAnchor, monthAnchor, slug }))
  }

  const remove = async (dir: string) => {
    try {
      await deleteSkill(dir)
      setSkills((cur) => cur.filter((s) => s.dir !== dir))
    } catch (err) {
      console.warn('[skills] delete failed', dir, err)
    }
  }

  return (
    // pt clears the absolutely-positioned EditorHeader AppShell overlays.
    <div className="mx-auto w-full max-w-2xl px-6 pb-16 pt-[calc(var(--header-h)+8px)]">
      <h1 className="mb-4 text-lg font-semibold text-foreground">Skills</h1>

      {loading ? (
        <p className="py-10 text-center text-body text-muted-foreground">불러오는 중…</p>
      ) : skills.length === 0 ? (
        <p className="py-10 text-center text-body text-muted-foreground">
          아직 저장된 스킬이 없어요. 작업하다 보면 AI가 “스킬로 저장할까요?”라고 제안합니다.
        </p>
      ) : (
        // macOS System Settings-style grouped list: one rounded card, colored
        // icon chips, bold labels, chevrons, and hairline separators that are
        // inset to align with the label (not the icon).
        <ul className="overflow-hidden rounded-[10px] border border-border/60 bg-card">
          {skills.map((s, i) => (
            <li key={s.dir} className="group relative">
              <button
                type="button"
                onClick={() => openSkill(s.slug)}
                disabled={!s.slug}
                className="flex w-full items-center gap-3 pl-3 pr-3.5 text-left transition-colors hover:bg-accent/50 disabled:cursor-default disabled:hover:bg-transparent"
              >
                <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-[7px] bg-secondary text-secondary-foreground">
                  <IconBolt size={16} stroke={2} />
                </span>
                {/* The separator lives on this inner element so it starts at the
                    label and clears the icon column, like macOS. */}
                <span
                  className={`flex min-w-0 flex-1 items-center py-2.5 ${
                    i > 0 ? 'border-t border-border/60' : ''
                  }`}
                >
                  <span className="flex-1 truncate text-body font-medium text-foreground">
                    {s.name}
                  </span>
                  <IconChevronRight
                    size={16}
                    stroke={2}
                    className="shrink-0 text-muted-foreground/40"
                  />
                </span>
              </button>
              {/* Sibling (not nested) so it's valid HTML and captures its own
                  click; overlaid just before the chevron, shown on row hover. */}
              <button
                type="button"
                aria-label={`Delete ${s.name}`}
                onClick={() => void remove(s.dir)}
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
