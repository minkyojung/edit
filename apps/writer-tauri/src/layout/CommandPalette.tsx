// Universal palette triggered by ⌘K (open) or ⌘G (open in date-mode).
// Replaces the earlier JumpToDateDialog. Same dialog shell, two
// "providers" (date / doc) that interpret the query independently
// and contribute groups of results.
//
// Mode:
//   - 'any'  — opened via ⌘K. Both date and doc providers run; if
//              the query parses as a date the "Jump to date" group
//              shows up alongside note matches.
//   - 'date' — opened via ⌘G. Doc provider suppressed; placeholder
//              and quick picks bias the user toward calendar
//              navigation. Power-user shortcut into the same shell.
//
// Empty query:
//   - 'any'  → recent docs (most-recently activated, falls back to
//              knownDocs order)
//   - 'date' → quick picks (Today / Yesterday / 7d / 30d ago)

import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import * as chrono from 'chrono-node'
import {
  IconArchive,
  IconCalendar,
  IconCalendarTime,
  IconFileDescription,
} from '@tabler/icons-react'
import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command'
import {
  useDocsStore,
  weekStartFor,
  type KnownDoc,
} from '@/state/docsStore'
import {
  formatLocalDate,
  todayLocalDate,
} from '@/hooks/useDocMeta'

type Mode = 'any' | 'date'

interface DateResult {
  kind: 'date'
  date: string
  label: string
}

interface DocResult {
  kind: 'doc'
  doc: KnownDoc
}

type Result = DateResult | DocResult

export function CommandPalette() {
  const [open, setOpen] = useState(false)
  const [mode, setMode] = useState<Mode>('any')
  const [query, setQuery] = useState('')

  const knownDocs = useDocsStore((s) => s.knownDocs)
  const activeSlug = useDocsStore((s) => s.activeSlug)
  const openDaily = useDocsStore((s) => s.openDaily)
  const setActive = useDocsStore((s) => s.setActive)
  const expandWeek = useDocsStore((s) => s.expandWeek)
  const archiveDoc = useDocsStore((s) => s.archiveDoc)
  const navigate = useNavigate()

  // Active doc — used by the "Archive current note" action. Only
  // writing-type counts; archiveDoc refuses dailies anyway.
  const activeDoc = useMemo(() => {
    if (!activeSlug) return null
    const d = knownDocs.find((x) => x.slug === activeSlug)
    return d && d.type === 'writing' && !d.archivedAt ? d : null
  }, [knownDocs, activeSlug])

  // Global shortcuts. ⌘K opens in any-mode, ⌘G opens in date-mode.
  // Browsers use ⌘G as "find next" by default — preventDefault keeps
  // it ours since the app has no native find.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return
      if (e.shiftKey || e.altKey) return
      if (e.key === 'k' || e.key === 'K') {
        e.preventDefault()
        setMode('any')
        setQuery('')
        setOpen(true)
        return
      }
      if (e.key === 'g' || e.key === 'G') {
        e.preventDefault()
        setMode('date')
        setQuery('')
        setOpen(true)
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [])

  const liveDocs = useMemo(
    () => knownDocs.filter((d) => !d.archivedAt),
    [knownDocs],
  )

  // Date provider — chrono parses free-form text, then we lock it to
  // local YYYY-MM-DD. Future dates allowed (some users plan); the
  // openDaily action is idempotent so it just creates the slot.
  const dateResult = useMemo<DateResult | null>(() => {
    if (!query.trim()) return null
    const parsed = chrono.parseDate(query, new Date(), { forwardDate: false })
    if (!parsed) return null
    const iso = formatLocalDate(parsed)
    return { kind: 'date', date: iso, label: formatJumpLabel(parsed, iso) }
  }, [query])

  // Doc provider — substring match on title. Cheap, no fuse dependency
  // for now. Daily entries match on their date label too so "may 4"
  // surfaces both the date jump and the actual daily.
  const docResults = useMemo<DocResult[]>(() => {
    if (mode === 'date') return []
    const q = query.trim().toLowerCase()
    if (!q) {
      // Empty query in any-mode: show recent activity. We don't have
      // a per-doc lastAccessed yet, so fall back to "recent first" by
      // knownDocs order, capped.
      return liveDocs.slice(0, 8).map((doc) => ({ kind: 'doc', doc }))
    }
    return liveDocs
      .filter((doc) => {
        const haystack =
          doc.type === 'daily' && doc.date
            ? `${doc.date} ${docDateLabel(doc.date)}`
            : (doc.title ?? '')
        return haystack.toLowerCase().includes(q)
      })
      .slice(0, 12)
      .map((doc) => ({ kind: 'doc', doc }))
  }, [liveDocs, query, mode])

  // Empty-state quick picks — only shown in date-mode with empty
  // query, mirrors the old JumpToDateDialog chips so muscle memory
  // survives.
  const quickPicks = useMemo<DateResult[]>(() => {
    if (mode !== 'date') return []
    if (query.trim()) return []
    const today = new Date()
    const mk = (offset: number, label: string): DateResult => {
      const d = new Date(today)
      d.setDate(today.getDate() - offset)
      const iso = formatLocalDate(d)
      return { kind: 'date', date: iso, label: `${label} · ${iso}` }
    }
    return [
      mk(0, 'Today'),
      mk(1, 'Yesterday'),
      mk(7, '7 days ago'),
      mk(30, '30 days ago'),
    ]
  }, [mode, query])

  const onSelect = async (r: Result) => {
    setOpen(false)
    if (r.kind === 'date') {
      expandWeek(weekStartFor(r.date))
      const slug = await openDaily(r.date)
      if (slug) navigate('/notes')
      return
    }
    // doc
    const slug = r.doc.slug
    const state = useDocsStore.getState()
    if (!state.openSlugs.includes(slug)) {
      useDocsStore.setState((s) =>
        s.openSlugs.includes(slug)
          ? s
          : { openSlugs: [...s.openSlugs, slug] },
      )
    }
    setActive(slug)
    navigate('/notes')
  }

  const placeholder =
    mode === 'date'
      ? 'Jump to date — e.g. yesterday, last monday, 5/4'
      : 'Search notes or jump to a date…'

  return (
    <CommandDialog open={open} onOpenChange={setOpen}>
      {/* cmdk's built-in filter sorts items by fuzzy match against
          their `value`. We do our own filtering above so the date
          provider's interpreted result isn't filtered out by cmdk's
          textual match. */}
      <Command shouldFilter={false}>
      <CommandInput
        placeholder={placeholder}
        value={query}
        onValueChange={setQuery}
      />
      <CommandList>
        {/* Actions on the active note. Only surfaces when there's a
            writing-type active doc — dailies aren't archivable and
            blank state has nothing to act on. */}
        {activeDoc && (
          <CommandGroup heading="Actions">
            <CommandItem
              value="action:archive-active"
              onSelect={() => {
                archiveDoc(activeDoc.slug)
                setOpen(false)
              }}
              className="text-destructive data-[selected=true]:text-destructive"
            >
              <IconArchive size={16} stroke={1.75} />
              <span className="flex-1 truncate">
                Archive “{activeDoc.title || 'Untitled'}”
              </span>
            </CommandItem>
          </CommandGroup>
        )}
        {dateResult && (
          <CommandGroup heading="Jump to date">
            <ResultRow
              key={`date-${dateResult.date}`}
              result={dateResult}
              onSelect={onSelect}
            />
          </CommandGroup>
        )}
        {quickPicks.length > 0 && (
          <CommandGroup heading="Quick">
            {quickPicks.map((p) => (
              <ResultRow key={`q-${p.date}`} result={p} onSelect={onSelect} />
            ))}
          </CommandGroup>
        )}
        {docResults.length > 0 && (
          <CommandGroup heading={query.trim() ? 'Notes' : 'Recent'}>
            {docResults.map((r) => (
              <ResultRow
                key={`doc-${r.doc.slug}`}
                result={r}
                onSelect={onSelect}
              />
            ))}
          </CommandGroup>
        )}
        <CommandEmpty>
          {mode === 'date' ? "Couldn't parse a date." : 'No matches.'}
        </CommandEmpty>
      </CommandList>
      </Command>
    </CommandDialog>
  )
}

function ResultRow({
  result,
  onSelect,
}: {
  result: Result
  onSelect: (r: Result) => void
}) {
  if (result.kind === 'date') {
    return (
      <CommandItem
        value={`date:${result.date}`}
        onSelect={() => onSelect(result)}
      >
        <IconCalendarTime size={16} stroke={1.75} />
        <span>{result.label}</span>
      </CommandItem>
    )
  }
  const { doc } = result
  const isDaily = doc.type === 'daily'
  const label = isDaily && doc.date ? docDateLabel(doc.date) : doc.title || 'Untitled'
  const sub = isDaily ? doc.date ?? '' : ''
  return (
    <CommandItem
      value={`doc:${doc.slug}:${label}`}
      onSelect={() => onSelect(result)}
    >
      {isDaily ? (
        <IconCalendar size={16} stroke={1.75} />
      ) : (
        <IconFileDescription size={16} stroke={1.75} />
      )}
      <span className="flex-1 truncate">{label}</span>
      {sub && (
        <span className="shrink-0 text-xs text-muted-foreground">{sub}</span>
      )}
    </CommandItem>
  )
}

function formatJumpLabel(d: Date, iso: string): string {
  const today = todayLocalDate()
  const isToday = iso === today
  const tomorrow = formatLocalDate(new Date(Date.now() + 86_400_000))
  const yesterday = formatLocalDate(new Date(Date.now() - 86_400_000))
  const rel = isToday
    ? 'Today'
    : iso === yesterday
      ? 'Yesterday'
      : iso === tomorrow
        ? 'Tomorrow'
        : d.toLocaleDateString(undefined, {
            weekday: 'short',
            month: 'short',
            day: 'numeric',
          })
  return `${rel} · ${iso}`
}

function docDateLabel(date: string): string {
  const today = todayLocalDate()
  if (date === today) return 'Today'
  const d = new Date(date)
  const t = new Date(today)
  const diffDays = Math.round((t.getTime() - d.getTime()) / 86_400_000)
  if (diffDays === 1) return 'Yesterday'
  if (diffDays > 0 && diffDays < 7) {
    return d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric' })
  }
  return d.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    ...(d.getFullYear() !== t.getFullYear() ? { year: 'numeric' } : {}),
  })
}
