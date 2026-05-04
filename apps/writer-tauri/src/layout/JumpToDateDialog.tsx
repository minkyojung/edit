// Quick "go to a specific daily" dialog. Opens on ⌘G from anywhere
// in the editor surface. Native <input type="date"> drives the
// picker (cheap, OS-native, accessible) plus a row of relative
// chips for the common targets — Today, Yesterday, last week.
//
// Submitting a date calls openDaily, which is idempotent: if the
// daily already exists it activates that tab, otherwise it creates
// one. Either way the user lands on /notes with that day in view.

import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { useDocsStore, weekStartFor } from '@/state/docsStore'
import {
  formatLocalDate,
  todayLocalDate,
} from '@/hooks/useDocMeta'

interface QuickPick {
  label: string
  date: string
}

function quickPicks(): QuickPick[] {
  const today = new Date()
  const mk = (offset: number) => {
    const d = new Date(today)
    d.setDate(today.getDate() - offset)
    return formatLocalDate(d)
  }
  return [
    { label: 'Today', date: mk(0) },
    { label: 'Yesterday', date: mk(1) },
    { label: '7 days ago', date: mk(7) },
    { label: '30 days ago', date: mk(30) },
  ]
}

export function JumpToDateDialog() {
  const [open, setOpen] = useState(false)
  const [value, setValue] = useState(todayLocalDate())
  const openDaily = useDocsStore((s) => s.openDaily)
  const expandWeek = useDocsStore((s) => s.expandWeek)
  const navigate = useNavigate()
  const picks = useMemo(quickPicks, [])

  // Global ⌘G / Ctrl+G shortcut. Browsers bind ⌘G to "find next"
  // by default, but our app overrides since we don't have a native
  // find — preventDefault keeps it ours. Pre-fills the input with
  // today on open so just-press-enter jumps home.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return
      if (e.shiftKey || e.altKey) return
      if (e.key !== 'g' && e.key !== 'G') return
      e.preventDefault()
      setValue(todayLocalDate())
      setOpen(true)
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [])

  const jump = async (date: string) => {
    setOpen(false)
    // Make sure the target week section is open before openDaily
    // resolves, so the sidebar's scrollIntoView effect lands the
    // row in view rather than into a folded section.
    expandWeek(weekStartFor(date))
    const slug = await openDaily(date)
    if (slug) navigate('/notes')
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="sm:max-w-[380px]">
        <DialogHeader>
          <DialogTitle>Jump to date</DialogTitle>
          <DialogDescription>
            Open a daily entry by date. Empty days are created on the spot.
          </DialogDescription>
        </DialogHeader>

        <form
          onSubmit={(e) => {
            e.preventDefault()
            if (value) jump(value)
          }}
          className="flex items-center gap-2"
        >
          <input
            type="date"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            autoFocus
            className="flex-1 rounded-md border bg-background px-2.5 py-1.5 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
          />
          <Button type="submit" size="sm" disabled={!value}>
            Open
          </Button>
        </form>

        <div className="flex flex-wrap gap-1.5 pt-1">
          {picks.map((p) => (
            <button
              key={p.date}
              type="button"
              onClick={() => jump(p.date)}
              className="rounded-md border px-2 py-1 text-xs text-muted-foreground transition-colors outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/40"
            >
              {p.label}
            </button>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  )
}
