// Design-system gallery — the in-app, Storybook-free "living style guide".
// Reached from the sidebar "Gallery" footer row, rendered in the main area
// like any note view (see SkillsPage). Built bottom-up by dependency order:
// Foundations (tokens) first, then Primitives, Compositions, Surfaces.
//
// This file is the SINGLE source of the gallery; it imports the REAL tokens
// (via `var(--…)`) and components so it can never drift from production.
// Step 1 ships Foundations → Color only; later steps append sections.

import type { ReactNode } from 'react'
import { IconPlus, IconBrain, IconFileText } from '@tabler/icons-react'
import type { ChatTurn, MessagePart } from '@/chat/types'
import { MessageRow } from '@/chat/messages/MessageRow'
import { ActivityRow } from '@/chat/parts/ActivityRow'
import { CompactDivider } from '@/chat/parts/CompactDivider'
import { RetryRow } from '@/chat/parts/RetryRow'
import { StoppedCard } from '@/chat/messages/StoppedCard'
import { ErrorCard } from '@/chat/messages/ErrorCard'
import { humanizeError } from '@/chat/utils/errorMessage'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Badge } from '@/components/ui/badge'
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  CardFooter,
} from '@/components/ui/card'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs'
import { DiffBlock } from '@/components/DiffBlock'
import type { DiffLine } from '@/lib/git'
import { SettingRow } from '@/settings/SettingRow'
import { Skeleton } from '@/components/ui/skeleton'
import { Spinner } from '@/components/ui/spinner'
import { Separator } from '@/components/ui/separator'
import {
  Dialog,
  DialogTrigger,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
  DialogClose,
} from '@/components/ui/dialog'
import {
  Popover,
  PopoverTrigger,
  PopoverContent,
} from '@/components/ui/popover'
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip'
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu'

// Color roles, grouped by purpose. Names only — the swatch resolves each
// live via `var(--<role>)`, so values track the theme automatically and the
// only thing maintained here is the (rarely-changing) list of role names.
// NB: read the base `--<role>` tokens (on :root), NOT the `--color-<role>`
// aliases — those live in `@theme inline` and are inlined into utilities,
// not emitted as runtime CSS variables (so `var(--color-…)` is empty).
const COLOR_GROUPS: { title: string; tokens: string[] }[] = [
  {
    title: 'Surface',
    tokens: [
      'background',
      'foreground',
      'card',
      'card-foreground',
      'popover',
      'popover-foreground',
      'muted',
      'muted-foreground',
      'border',
      'input',
    ],
  },
  {
    title: 'Brand & Action',
    tokens: [
      'primary',
      'primary-foreground',
      'secondary',
      'secondary-foreground',
      'accent',
      'accent-foreground',
      'ring',
    ],
  },
  {
    title: 'Status',
    tokens: [
      'destructive',
      'success',
      'success-foreground',
      'warning',
      'warning-foreground',
      'info',
      'info-foreground',
    ],
  },
  {
    title: 'Sidebar',
    tokens: [
      'sidebar',
      'sidebar-foreground',
      'sidebar-accent',
      'sidebar-accent-foreground',
      'sidebar-active',
      'sidebar-active-foreground',
      'sidebar-border',
      'sidebar-primary',
      'sidebar-primary-foreground',
      'sidebar-ring',
      'sidebar-trigger',
    ],
  },
]

// Diff tokens live under --diff-* (not --color-*), so they get their own var
// prefix. Listed because the DiffBlock / review surfaces depend on them.
const DIFF_TOKENS = [
  'diff-added-bg',
  'diff-added-fg',
  'diff-added-line',
  'diff-removed-bg',
  'diff-removed-fg',
  'diff-removed-line',
]

function Swatch({ varName, label }: { varName: string; label: string }) {
  return (
    <div className="flex items-center gap-2.5">
      <span
        className="h-9 w-9 shrink-0 rounded-md border border-border/60"
        style={{ background: `var(${varName})` }}
      />
      <span className="min-w-0">
        <span className="block truncate text-[13px] text-foreground">{label}</span>
        <span className="block truncate font-mono text-[11px] text-muted-foreground">
          {varName}
        </span>
      </span>
    </div>
  )
}

function ColorGroup({ title, vars }: { title: string; vars: { varName: string; label: string }[] }) {
  return (
    <div>
      <h3 className="mb-3 text-[13px] font-medium text-muted-foreground">{title}</h3>
      <div className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-3">
        {vars.map((v) => (
          <Swatch key={v.varName} varName={v.varName} label={v.label} />
        ))}
      </div>
    </div>
  )
}

// ── Typography ────────────────────────────────────────────────────────
// The --text-*, --font-weight-*, --gap-*, --radius-sm..4xl tokens live in
// `@theme inline` (index.css), so they are inlined into utility classes and
// NOT emitted as runtime CSS variables — `var(--text-body)` is empty. The
// gallery therefore renders these via their generated utility class (weights,
// radius) or, where no utility exists (the size ramp, spacing), via the
// resolved value the token compiles to (documented here as the source of
// truth). Color / surface-radius / window-radius stay on :root, so those
// still read live through var().
const TYPE_SCALE: { token: string; px: number }[] = [
  { token: 'caption', px: 11 },
  { token: 'footnote', px: 12 },
  { token: 'callout', px: 13 },
  { token: 'body', px: 14 },
  { token: 'headline', px: 14 }, // body size, rendered semibold
  { token: 'title-3', px: 16 },
  { token: 'title-2', px: 18 },
  { token: 'title-1', px: 24 },
]
// name → built-in Tailwind weight utility (always generated, maps to the
// --font-weight-* values).
const WEIGHTS: { name: string; value: number; cls: string }[] = [
  { name: 'regular', value: 400, cls: 'font-normal' },
  { name: 'medium', value: 500, cls: 'font-medium' },
  { name: 'semibold', value: 600, cls: 'font-semibold' },
  { name: 'bold', value: 700, cls: 'font-bold' },
]
const LINE_HEIGHTS = ['tight', 'snug', 'normal', 'loose']
const TRACKINGS = ['tight', 'normal', 'wide']

function TypeScaleRow({ token, px }: { token: string; px: number }) {
  const semibold = token === 'headline'
  return (
    <div className="flex items-baseline gap-4">
      <span className="w-32 shrink-0 font-mono text-[11px] text-muted-foreground">
        --text-{token} · {px}
      </span>
      <span
        className="truncate text-foreground"
        style={{ fontSize: px, fontWeight: semibold ? 600 : undefined }}
      >
        다람쥐 헌 쳇바퀴 Ag
      </span>
    </div>
  )
}

function WeightRow({ name, value, cls }: { name: string; value: number; cls: string }) {
  return (
    <div className="flex items-baseline gap-4">
      <span className="w-32 shrink-0 font-mono text-[11px] text-muted-foreground">
        {name} · {value}
      </span>
      <span className={`text-[15px] text-foreground ${cls}`}>다람쥐 헌 쳇바퀴 Ag</span>
    </div>
  )
}

// ── Spacing ───────────────────────────────────────────────────────────
// Resolved values (see @theme inline note above). Bar width = the px the
// token compiles to.
const SPACING: { token: string; px: number }[] = [
  { token: 'gap-inline', px: 8 },
  { token: 'gap-row', px: 12 },
  { token: 'gap-section', px: 24 },
  { token: 'padding-card', px: 16 },
  { token: 'padding-row-x', px: 12 },
  { token: 'padding-row-y', px: 8 },
]

function SpacingBar({ token, px }: { token: string; px: number }) {
  return (
    <div className="flex items-center gap-4">
      <span className="w-32 shrink-0 font-mono text-[11px] text-muted-foreground">
        --{token} · {px}
      </span>
      <span className="h-3 rounded-sm bg-foreground/70" style={{ width: px }} />
    </div>
  )
}

// ── Radius ────────────────────────────────────────────────────────────
// radius-sm..4xl → rounded-* utilities (generated from @theme). surface- and
// window-radius are on :root, so they read live via var().
const RADIUS_UTILS = ['sm', 'md', 'lg', 'xl', '2xl', '3xl', '4xl']
const RADIUS_VARS = ['surface-radius', 'window-radius']

function RadiusSwatch({ label, cls, varName }: { label: string; cls?: string; varName?: string }) {
  return (
    <div className="flex flex-col items-center gap-1.5">
      <span
        className={`h-14 w-14 border border-border bg-card ${cls ?? ''}`}
        style={varName ? { borderRadius: `var(--${varName})` } : undefined}
      />
      <span className="font-mono text-[10px] text-muted-foreground">{label}</span>
    </div>
  )
}

// ── Primitives · Button ───────────────────────────────────────────────
// Imports the REAL Button (components/ui/button.tsx) and lays out its
// variants × sizes × disabled. hover / focus are live — hover or tab the
// buttons in the page to see those states.
const BUTTON_VARIANTS = ['default', 'outline', 'secondary', 'ghost', 'destructive', 'link'] as const
const BADGE_VARIANTS = [
  'default',
  'secondary',
  'destructive',
  'info',
  'success',
  'warning',
  'outline',
  'ghost',
  'link',
] as const
const BUTTON_TEXT_SIZES = ['xs', 'sm', 'default', 'lg'] as const
const BUTTON_ICON_SIZES = ['icon-xs', 'icon-sm', 'icon', 'icon-lg'] as const

// ── Compositions ──────────────────────────────────────────────────────
// Mock data so the presentational compositions render realistically (these
// units take data/children rather than just variant props).
const DIFF_DEMO: DiffLine[] = [
  { kind: 'context', text: '## Meeting notes', lineNum: 1 },
  { kind: 'remove', text: 'Action items at the bottom.', lineNum: 2 },
  { kind: 'add', text: 'Action items pinned to the top.', lineNum: 2 },
  { kind: 'context', text: 'Attendees: Will, AI', lineNum: 3 },
]

// A labeled row of demo items (reused across primitive subgroups).
// ── Chat-states fixtures ───────────────────────────────────────────────
// Mock data so the real chat components render in isolation, per scenario.
const noop = () => {}
let mockTurnSeq = 0
function mockTurn(over: Partial<ChatTurn>): ChatTurn {
  return { id: `gallery-${mockTurnSeq++}`, role: 'assistant', content: '', ts: Date.now(), ...over }
}
const SampleBody = (
  <div className="text-sm leading-relaxed text-foreground">
    Here&rsquo;s the draft intro you asked for — two sentences, matched to the
    manuscript&rsquo;s voice.
  </div>
)
// One ErrorCard per code; `humanizeError` gives the production copy so the
// gallery can never drift from the real strings.
const ERROR_CASES: {
  code: string
  detail?: string
  retryable?: boolean
  rate?: boolean
}[] = [
  { code: 'SERVER', retryable: true },
  { code: 'MAX_TURNS', retryable: true },
  { code: 'RATE_LIMIT', retryable: true, rate: true },
  { code: 'AUTH', retryable: false },
  { code: 'BILLING', retryable: false },
  { code: 'TRUNCATED', retryable: true },
  { code: 'EXEC', detail: 'spawn failed: ENOENT', retryable: true },
  { code: 'INVALID', retryable: false },
  { code: 'FORMAT', retryable: true },
]

// Part fixtures for full-turn scenarios (rendered through the real MessageRow).
const reasoningPart = (text: string): MessagePart => ({
  id: `p-${mockTurnSeq++}`,
  ts: 0,
  type: 'reasoning',
  text,
})
const textPart = (text: string): MessagePart => ({
  id: `p-${mockTurnSeq++}`,
  ts: 0,
  type: 'text',
  text,
})
const toolPartFx = (toolName: string, input: unknown): MessagePart => ({
  id: `p-${mockTurnSeq++}`,
  ts: 0,
  type: 'tool',
  toolName,
  toolCallId: `tc-${mockTurnSeq}`,
  input,
  state: 'output-available',
  output: 'ok',
})
const retryPartFx = (attempt: number, maxRetries: number, error: string): MessagePart => ({
  id: `p-${mockTurnSeq++}`,
  ts: 0,
  type: 'retry',
  attempt,
  maxRetries,
  error,
})
const userTurn = (content: string): ChatTurn => mockTurn({ role: 'user', content })

/** Renders a sequence of turns through the real MessageRow — user bubble,
 * assistant process (activity rows), and the terminal outcome — so a whole
 * conversation moment can be eyeballed, not just isolated cards. */
function Scenario({ title, turns }: { title: string; turns: ChatTurn[] }) {
  return (
    <div className="w-full max-w-xl">
      <div className="mb-1.5 text-xs text-muted-foreground">{title}</div>
      <div className="flex flex-col gap-4 rounded-xl border border-border/60 bg-background p-4">
        {turns.map((t, i) => (
          <MessageRow
            key={t.id}
            turn={t}
            threadId={null}
            onRegenerate={t.role === 'assistant' && i === turns.length - 1 ? noop : undefined}
          />
        ))}
      </div>
    </div>
  )
}

function Subgroup({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div>
      <h3 className="mb-3 text-[13px] font-medium text-muted-foreground">{title}</h3>
      <div className="flex flex-wrap items-center gap-3">{children}</div>
    </div>
  )
}

// Section id derived from its title so the nav and the anchors can't drift.
const slugify = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    // scroll-mt clears the fixed header when the nav scrolls to this anchor.
    <section id={slugify(title)} className="mb-12 scroll-mt-[calc(var(--header-h)+16px)]">
      <h2 className="mb-5 border-b border-border/60 pb-2 text-base font-semibold text-foreground">
        {title}
      </h2>
      <div className="space-y-8">{children}</div>
    </section>
  )
}

// Left nav. Buttons (not <a href="#…">) because the app uses HashRouter —
// a hash anchor would hijack the route. scrollIntoView jumps to the section.
const NAV: { group: string; titles: string[] }[] = [
  {
    group: 'Foundations',
    titles: [
      'Foundations · Color',
      'Foundations · Typography',
      'Foundations · Spacing',
      'Foundations · Radius',
      'Foundations · Interaction',
    ],
  },
  {
    group: 'Primitives',
    titles: [
      'Primitives · Button',
      'Primitives · Inputs',
      'Primitives · Display',
      'Primitives · Overlays',
      'Primitives · Navigation',
    ],
  },
  { group: 'Compositions', titles: ['Compositions'] },
  { group: 'Surfaces', titles: ['Surfaces · Chat states'] },
  { group: 'Consistency', titles: ['Consistency · Controls', 'Consistency · Panels'] },
]

function GalleryNav() {
  const go = (title: string) =>
    document.getElementById(slugify(title))?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  return (
    <nav className="sticky top-[calc(var(--header-h)+16px)] hidden h-max w-36 shrink-0 text-[13px] lg:block">
      {NAV.map((g) => (
        <div key={g.group} className="mb-4">
          <div className="mb-1.5 font-medium text-foreground">{g.group}</div>
          <ul className="space-y-0.5">
            {g.titles.map((t) => (
              <li key={t}>
                <button
                  type="button"
                  onClick={() => go(t)}
                  className="block w-full truncate text-left text-muted-foreground transition-colors hover:text-foreground"
                >
                  {t.includes('·') ? t.split('·').pop()?.trim() : t}
                </button>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </nav>
  )
}

export function GalleryPage() {
  return (
    // pt clears the absolutely-positioned EditorHeader AppShell overlays
    // (matches SkillsPage).
    <div className="mx-auto flex w-full max-w-5xl gap-10 px-6 pb-16 pt-[calc(var(--header-h)+8px)]">
      <GalleryNav />
      <div className="min-w-0 max-w-3xl flex-1">
      <h1 className="mb-8 text-lg font-semibold text-foreground">Gallery</h1>

      <Section title="Foundations · Color">
        {COLOR_GROUPS.map((g) => (
          <ColorGroup
            key={g.title}
            title={g.title}
            vars={g.tokens.map((t) => ({ varName: `--${t}`, label: t }))}
          />
        ))}
        <ColorGroup
          title="Diff"
          vars={DIFF_TOKENS.map((t) => ({ varName: `--${t}`, label: t }))}
        />
      </Section>

      <Section title="Foundations · Typography">
        <div>
          <h3 className="mb-3 text-[13px] font-medium text-muted-foreground">Type scale</h3>
          <div className="space-y-2.5">
            {TYPE_SCALE.map((t) => (
              <TypeScaleRow key={t.token} token={t.token} px={t.px} />
            ))}
          </div>
        </div>
        <div>
          <h3 className="mb-3 text-[13px] font-medium text-muted-foreground">Weights</h3>
          <div className="space-y-2.5">
            {WEIGHTS.map((w) => (
              <WeightRow key={w.name} name={w.name} value={w.value} cls={w.cls} />
            ))}
          </div>
        </div>
        <div className="flex flex-wrap gap-x-10 gap-y-1 font-mono text-[11px] text-muted-foreground">
          <span>line-height: {LINE_HEIGHTS.map((h) => `${h}`).join(' · ')}</span>
          <span>tracking: {TRACKINGS.map((t) => `${t}`).join(' · ')}</span>
        </div>
      </Section>

      <Section title="Foundations · Spacing">
        <div className="space-y-3">
          {SPACING.map((s) => (
            <SpacingBar key={s.token} token={s.token} px={s.px} />
          ))}
        </div>
      </Section>

      <Section title="Foundations · Radius">
        <div className="flex flex-wrap gap-6">
          {RADIUS_UTILS.map((r) => (
            <RadiusSwatch key={r} label={`radius-${r}`} cls={`rounded-${r}`} />
          ))}
          {RADIUS_VARS.map((r) => (
            <RadiusSwatch key={r} label={r} varName={r} />
          ))}
        </div>
      </Section>

      <Section title="Foundations · Interaction">
        <p className="text-[13px] text-muted-foreground">
          The two-tone row interaction the sidebar uses, now available app-wide:
          hover = <code className="font-mono">--accent</code>, selected ={' '}
          <code className="font-mono">--selected</code>.
        </p>
        <div className="max-w-xs space-y-1">
          <div className="rounded-sm px-3 py-2 text-[13px] text-foreground">Resting</div>
          <div className="rounded-sm bg-accent px-3 py-2 text-[13px] text-accent-foreground">
            Hover · --accent
          </div>
          <div className="rounded-sm bg-selected px-3 py-2 text-[13px] text-selected-foreground">
            Selected · --selected
          </div>
        </div>
      </Section>

      <Section title="Primitives · Button">
        <Subgroup title="Variants">
          {BUTTON_VARIANTS.map((v) => (
            <Button key={v} variant={v}>
              {v}
            </Button>
          ))}
        </Subgroup>
        <Subgroup title="Disabled">
          {BUTTON_VARIANTS.map((v) => (
            <Button key={v} variant={v} disabled>
              {v}
            </Button>
          ))}
        </Subgroup>
        <Subgroup title="Sizes">
          {BUTTON_TEXT_SIZES.map((s) => (
            <Button key={s} size={s}>
              {s}
            </Button>
          ))}
        </Subgroup>
        <Subgroup title="Icon sizes">
          {BUTTON_ICON_SIZES.map((s) => (
            <Button key={s} size={s} aria-label={s}>
              <IconPlus />
            </Button>
          ))}
        </Subgroup>
      </Section>

      <Section title="Primitives · Inputs">
        <Subgroup title="Input">
          <Input className="w-56" placeholder="Placeholder" />
          <Input className="w-56" defaultValue="Filled value" />
          <Input className="w-56" placeholder="Disabled" disabled />
          <Input className="w-56" defaultValue="Invalid" aria-invalid />
        </Subgroup>
        <Subgroup title="Textarea">
          <Textarea className="w-56" placeholder="Placeholder" />
          <Textarea className="w-56" placeholder="Disabled" disabled />
        </Subgroup>
        <Subgroup title="Select">
          <Select>
            <SelectTrigger className="w-56">
              <SelectValue placeholder="Select an option" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="one">Option one</SelectItem>
              <SelectItem value="two">Option two</SelectItem>
              <SelectItem value="three">Option three</SelectItem>
            </SelectContent>
          </Select>
          <Select disabled>
            <SelectTrigger className="w-56">
              <SelectValue placeholder="Disabled" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="one">Option one</SelectItem>
            </SelectContent>
          </Select>
        </Subgroup>
      </Section>

      <Section title="Primitives · Display">
        <Subgroup title="Badge">
          {BADGE_VARIANTS.map((v) => (
            <Badge key={v} variant={v}>
              {v}
            </Badge>
          ))}
        </Subgroup>
        <Subgroup title="Card">
          <Card className="w-72">
            <CardHeader>
              <CardTitle>Card title</CardTitle>
              <CardDescription>A short supporting description.</CardDescription>
            </CardHeader>
            <CardContent className="text-[13px] text-muted-foreground">
              Card body content sits here.
            </CardContent>
            <CardFooter className="gap-2">
              <Button size="sm" variant="ghost">
                Cancel
              </Button>
              <Button size="sm">Confirm</Button>
            </CardFooter>
          </Card>
        </Subgroup>
        <Subgroup title="Avatar">
          <Avatar>
            <AvatarFallback>WJ</AvatarFallback>
          </Avatar>
          <Avatar>
            <AvatarFallback>AI</AvatarFallback>
          </Avatar>
        </Subgroup>
        <Subgroup title="Skeleton">
          <div className="w-56 space-y-2">
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-2/3" />
            <Skeleton className="h-9 w-24" />
          </div>
        </Subgroup>
        <Subgroup title="Spinner">
          <Spinner className="size-5 text-muted-foreground" />
        </Subgroup>
        <Subgroup title="Separator">
          <div className="w-56">
            <span className="text-[13px] text-foreground">Above</span>
            <Separator className="my-2" />
            <span className="text-[13px] text-foreground">Below</span>
          </div>
          <div className="flex h-6 items-center gap-3 text-[13px] text-foreground">
            <span>Left</span>
            <Separator orientation="vertical" />
            <span>Right</span>
          </div>
        </Subgroup>
      </Section>

      <Section title="Primitives · Overlays">
        <Subgroup title="Triggers (click / hover to open)">
          <Dialog>
            <DialogTrigger asChild>
              <Button variant="outline">Dialog</Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Dialog title</DialogTitle>
                <DialogDescription>
                  A modal surface — overlay, content, header, footer.
                </DialogDescription>
              </DialogHeader>
              <DialogFooter>
                <DialogClose asChild>
                  <Button variant="ghost">Cancel</Button>
                </DialogClose>
                <DialogClose asChild>
                  <Button>Confirm</Button>
                </DialogClose>
              </DialogFooter>
            </DialogContent>
          </Dialog>

          <Popover>
            <PopoverTrigger asChild>
              <Button variant="outline">Popover</Button>
            </PopoverTrigger>
            <PopoverContent className="text-[13px] text-muted-foreground">
              Popover content floats over the page on the popover surface.
            </PopoverContent>
          </Popover>

          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="outline">Tooltip</Button>
            </TooltipTrigger>
            <TooltipContent>Tooltip text</TooltipContent>
          </Tooltip>

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline">Dropdown</Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent>
              <DropdownMenuLabel>Menu</DropdownMenuLabel>
              <DropdownMenuItem>First item</DropdownMenuItem>
              <DropdownMenuItem>Second item</DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem variant="destructive">Delete</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </Subgroup>
      </Section>

      <Section title="Primitives · Navigation">
        <Subgroup title="Tabs">
          <Tabs defaultValue="one" className="max-w-md">
            <TabsList>
              <TabsTrigger value="one">First</TabsTrigger>
              <TabsTrigger value="two">Second</TabsTrigger>
              <TabsTrigger value="three">Third</TabsTrigger>
            </TabsList>
            <TabsContent value="one" className="pt-3 text-[13px] text-muted-foreground">
              First panel content.
            </TabsContent>
            <TabsContent value="two" className="pt-3 text-[13px] text-muted-foreground">
              Second panel content.
            </TabsContent>
            <TabsContent value="three" className="pt-3 text-[13px] text-muted-foreground">
              Third panel content.
            </TabsContent>
          </Tabs>
        </Subgroup>
      </Section>

      <Section title="Compositions">
        <div>
          <h3 className="mb-3 text-[13px] font-medium text-muted-foreground">DiffBlock</h3>
          <div className="max-w-md">
            <DiffBlock lines={DIFF_DEMO} />
          </div>
        </div>
        <div>
          <h3 className="mb-3 text-[13px] font-medium text-muted-foreground">SettingRow</h3>
          <div className="max-w-md divide-y divide-border rounded-xl border border-border px-4">
            <SettingRow title="Theme" description="Color palette for the app.">
              <Select>
                <SelectTrigger className="w-40">
                  <SelectValue placeholder="Dark" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="dark">Dark</SelectItem>
                  <SelectItem value="light">Light</SelectItem>
                </SelectContent>
              </Select>
            </SettingRow>
            <SettingRow title="Reset onboarding" description="Show the intro flow again next launch.">
              <Button size="sm" variant="outline">
                Reset
              </Button>
            </SettingRow>
          </div>
        </div>
      </Section>

      <Section title="Consistency · Controls">
        <p className="text-[13px] text-muted-foreground">
          Same control family — but each has a different corner radius today
          (button 4xl · input 3xl · select 2xl/3xl · textarea 2xl). Side by side
          the mismatch shows; pick one radius to unify them.
        </p>
        <div className="flex flex-wrap items-center gap-3">
          <Button>Button</Button>
          <Input className="w-40" placeholder="Input" />
          <Select>
            <SelectTrigger className="w-40">
              <SelectValue placeholder="Select" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="a">Option</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <Textarea className="max-w-md" placeholder="Textarea" />
      </Section>

      <Section title="Surfaces · Chat states">
        <p className="text-[13px] text-muted-foreground">
          Every in-turn activity and turn outcome, rendered from the real chat
          components with mock data — so tone, icon, and actions can be compared
          side by side. Activity rows share the <code>ActivityRow</code> base;
          terminal cards share <code>InlineCard</code>.
        </p>

        <Subgroup title="Activity rows — steps inside a turn (ActivityRow base)">
          <div className="w-full max-w-xl divide-y divide-border/40 rounded-xl border border-border/60 px-1">
            <ActivityRow icon={<IconBrain size={14} />} label="Thinking" />
            <ActivityRow
              icon={<IconFileText size={14} />}
              label="Read part1.md"
              preview="7 lines"
            />
            <RetryRow
              part={{
                id: 'r1',
                ts: 0,
                type: 'retry',
                attempt: 1,
                maxRetries: 3,
                error: 'server_error',
              }}
            />
            <RetryRow
              part={{
                id: 'r2',
                ts: 0,
                type: 'retry',
                attempt: 3,
                maxRetries: 3,
                error: 'rate_limit',
              }}
            />
            <CompactDivider
              part={{
                id: 'c',
                ts: 0,
                type: 'compact',
                trigger: 'auto',
                preTokens: 120000,
                postTokens: 40000,
              }}
            />
          </div>
        </Subgroup>

        <Subgroup title="Turn endings — terminal cards (InlineCard base)">
          <div className="flex w-full max-w-xl flex-col gap-3">
            <StoppedCard
              turn={mockTurn({ status: 'stopped', content: 'partial draft…' })}
              body={SampleBody}
              hasText
              durationLabel="8.4s"
              onRegenerate={noop}
            />
            {ERROR_CASES.map((c) => (
              <ErrorCard
                key={c.code}
                turn={mockTurn({
                  status: 'error',
                  errorCode: c.code,
                  errorText: humanizeError(`${c.code}: ${c.detail ?? ''}`),
                  retryable: c.retryable,
                  resetsAt: c.rate ? Date.now() + 90_000 : undefined,
                  rateLimitType: c.rate ? 'five_hour' : undefined,
                })}
                // Structured errors usually have no streamed body — show the
                // error-led card (with one bodied example to compare).
                body={c.code === 'EXEC' ? SampleBody : null}
                hasText={c.code === 'EXEC'}
                hasThinking={false}
                durationLabel="2.1s"
                onRegenerate={noop}
              />
            ))}
          </div>
        </Subgroup>

        <Subgroup title="Scenarios — bubble + activity rows + outcome (real MessageRow)">
          <Scenario
            title="Streaming — thinking, tool, and a retry, live"
            turns={[
              userTurn('Draft the chapter 1 intro into part1.md.'),
              mockTurn({
                status: 'streaming',
                parts: [
                  reasoningPart('Reading the outline to match the manuscript voice…'),
                  toolPartFx('Grep', { pattern: 'voice', path: 'manuscript/ch01' }),
                  retryPartFx(2, 3, 'server_error'),
                ],
              }),
            ]}
          />
          <Scenario
            title="Failed — server error after a retry"
            turns={[
              userTurn('Draft the chapter 1 intro into part1.md.'),
              mockTurn({
                status: 'error',
                durationMs: 4100,
                errorCode: 'SERVER',
                errorText: humanizeError('SERVER: '),
                retryable: true,
                parts: [
                  reasoningPart('Reading the outline to match the manuscript voice…'),
                  toolPartFx('Grep', { pattern: 'voice', path: 'manuscript/ch01' }),
                  retryPartFx(3, 3, 'server_error'),
                ],
              }),
            ]}
          />
          <Scenario
            title="Failed — rate limited, with live countdown"
            turns={[
              userTurn('Translate the selected paragraph into Korean.'),
              mockTurn({
                status: 'error',
                durationMs: 1200,
                errorCode: 'RATE_LIMIT',
                errorText: humanizeError('RATE_LIMIT: '),
                retryable: true,
                resetsAt: Date.now() + 45_000,
                rateLimitType: 'five_hour',
                parts: [reasoningPart('Preparing the translation…')],
              }),
            ]}
          />
          <Scenario
            title="Stopped — user pressed Stop mid-answer"
            turns={[
              userTurn('Write a 500-word essay on solitude.'),
              mockTurn({
                status: 'stopped',
                durationMs: 8400,
                content: 'Solitude is not the same as loneliness…',
                parts: [
                  reasoningPart('Outlining three movements…'),
                  textPart(
                    'Solitude is not the same as loneliness. Where loneliness is an ache for what is absent, solitude is a chosen room…',
                  ),
                ],
              }),
            ]}
          />
          <Scenario
            title="Done — normal completion"
            turns={[
              userTurn('Summarize this note in one line.'),
              mockTurn({
                status: 'done',
                durationMs: 2300,
                stopReason: 'end_turn',
                content: 'A short manifesto on sovereign individuality.',
                parts: [textPart('A short manifesto on sovereign individuality.')],
              }),
            ]}
          />
        </Subgroup>
      </Section>

      <Section title="Consistency · Panels">
        <p className="text-[13px] text-muted-foreground">
          Floating surfaces — open each. Radii differ today (dialog 4xl ·
          popover 3xl · dropdown 2xl/3xl · tooltip lg/xl). They should share one.
        </p>
        <div className="flex flex-wrap items-center gap-3">
          <Dialog>
            <DialogTrigger asChild>
              <Button variant="outline">Dialog</Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Dialog</DialogTitle>
                <DialogDescription>Compare this corner radius.</DialogDescription>
              </DialogHeader>
            </DialogContent>
          </Dialog>
          <Popover>
            <PopoverTrigger asChild>
              <Button variant="outline">Popover</Button>
            </PopoverTrigger>
            <PopoverContent className="text-[13px] text-muted-foreground">
              Compare this corner radius.
            </PopoverContent>
          </Popover>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline">Dropdown</Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent>
              <DropdownMenuItem>Item one</DropdownMenuItem>
              <DropdownMenuItem>Item two</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="outline">Tooltip</Button>
            </TooltipTrigger>
            <TooltipContent>Compare this radius</TooltipContent>
          </Tooltip>
        </div>
      </Section>
      </div>
    </div>
  )
}
