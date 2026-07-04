// Routines page — the main-area entry point for the agent's editable task
// "brains" (`.claude/commands/*.md`: how it organizes the inbox, files the
// daily, etc.). Mirrors SkillsPage, but the files live under the hidden
// `.claude/` dir so they aren't catalogued as notes — so instead of opening
// them in the editor by slug, this page edits the prompt body inline (load →
// textarea → save). Sits in the AppShell content column like any note view.
//
// "Routine" is our product label; the underlying file IS a Claude Code slash
// command (`.claude/commands/<name>.md`).

import { useEffect, useState } from 'react'
import { IconChevronLeft, IconChevronRight, IconRoute } from '@tabler/icons-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import {
  listRoutines,
  readRoutineBody,
  saveRoutineBody,
  type VaultRoutine,
} from '@/lib/routinesLib'

export function RoutinesPage() {
  const [routines, setRoutines] = useState<VaultRoutine[]>([])
  const [loading, setLoading] = useState(true)
  // The routine being edited (null = list view), plus its live buffer.
  const [editing, setEditing] = useState<VaultRoutine | null>(null)
  const [body, setBody] = useState('')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    setLoading(true)
    listRoutines()
      .then(setRoutines)
      .catch(() => setRoutines([]))
      .finally(() => setLoading(false))
  }, [])

  const open = async (r: VaultRoutine) => {
    try {
      const b = await readRoutineBody(r.fileName)
      setBody(b)
      setEditing(r)
    } catch {
      toast.error('Couldn’t open this routine')
    }
  }

  const save = async () => {
    if (!editing) return
    setSaving(true)
    try {
      await saveRoutineBody(editing.fileName, editing.description, body)
      toast.success(`Saved — “${editing.name}” takes effect on the next run`)
      setEditing(null)
    } catch {
      toast.error('Couldn’t save this routine')
    } finally {
      setSaving(false)
    }
  }

  // pt clears the absolutely-positioned EditorHeader AppShell overlays.
  const wrap = 'mx-auto w-full max-w-2xl px-6 pb-16 pt-[calc(var(--header-h)+8px)]'

  if (editing) {
    return (
      <div className={wrap}>
        <button
          type="button"
          onClick={() => setEditing(null)}
          className="mb-3 flex items-center gap-1 text-body text-muted-foreground transition-colors hover:text-foreground"
        >
          <IconChevronLeft size={16} stroke={2} />
          Routines
        </button>
        <h1 className="text-lg font-semibold text-foreground">{editing.name}</h1>
        {editing.description && (
          <p className="mb-3 mt-0.5 text-footnote text-muted-foreground">
            {editing.description}
          </p>
        )}
        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          spellCheck={false}
          className="mt-2 min-h-[420px] w-full resize-y rounded-[10px] border border-border/60 bg-card p-3.5 font-mono text-footnote leading-relaxed text-foreground outline-none focus:border-border"
        />
        <div className="mt-3 flex items-center justify-end gap-2">
          <Button variant="ghost" onClick={() => setEditing(null)} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={() => void save()} disabled={saving}>
            {saving ? 'Saving…' : 'Save'}
          </Button>
        </div>
      </div>
    )
  }

  return (
    <div className={wrap}>
      <h1 className="mb-1 text-lg font-semibold text-foreground">Routines</h1>
      <p className="mb-4 text-footnote text-muted-foreground">
        How the agent handles each task — edit these to change what it does when it
        organizes your inbox, files a daily, or saves a chat to the wiki.
      </p>

      {loading ? (
        <p className="py-10 text-center text-body text-muted-foreground">불러오는 중…</p>
      ) : routines.length === 0 ? (
        <p className="py-10 text-center text-body text-muted-foreground">
          아직 루틴이 없어요. 볼트를 열면 기본 루틴이 자동으로 생깁니다.
        </p>
      ) : (
        <ul className="overflow-hidden rounded-[10px] border border-border/60 bg-card">
          {routines.map((r, i) => (
            <li key={r.fileName} className="group relative">
              <button
                type="button"
                onClick={() => void open(r)}
                className="flex w-full items-center gap-3 pl-3 pr-3.5 text-left transition-colors hover:bg-accent/50"
              >
                <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-[7px] bg-secondary text-secondary-foreground">
                  <IconRoute size={16} stroke={2} />
                </span>
                <span
                  className={`flex min-w-0 flex-1 items-center py-2.5 ${
                    i > 0 ? 'border-t border-border/60' : ''
                  }`}
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-body font-medium text-foreground">
                      {r.name}
                    </span>
                    {r.description && (
                      <span className="block truncate text-caption text-muted-foreground">
                        {r.description}
                      </span>
                    )}
                  </span>
                  <IconChevronRight
                    size={16}
                    stroke={2}
                    className="ml-2 shrink-0 text-muted-foreground/40"
                  />
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
