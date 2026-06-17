// Design-system gallery — the in-app, Storybook-free "living style guide".
// Reached from the sidebar "Gallery" footer row, rendered in the main area
// like any note view (see SkillsPage). Built bottom-up by dependency order:
// Foundations (tokens) first, then Primitives, Compositions, Surfaces.
//
// This file is the SINGLE source of the gallery; it imports the REAL tokens
// (via `var(--…)`) and components so it can never drift from production.
// Step 1 ships Foundations → Color only; later steps append sections.

import type { ReactNode } from 'react'
import { IconPlus } from '@tabler/icons-react'
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
import { Skeleton } from '@/components/ui/skeleton'
import { Spinner } from '@/components/ui/spinner'
import { Separator } from '@/components/ui/separator'

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

// A labeled row of demo items (reused across primitive subgroups).
function Subgroup({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div>
      <h3 className="mb-3 text-[13px] font-medium text-muted-foreground">{title}</h3>
      <div className="flex flex-wrap items-center gap-3">{children}</div>
    </div>
  )
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="mb-12">
      <h2 className="mb-5 border-b border-border/60 pb-2 text-base font-semibold text-foreground">
        {title}
      </h2>
      <div className="space-y-8">{children}</div>
    </section>
  )
}

export function GalleryPage() {
  return (
    // pt clears the absolutely-positioned EditorHeader AppShell overlays
    // (matches SkillsPage).
    <div className="mx-auto w-full max-w-3xl px-6 pb-16 pt-[calc(var(--header-h)+8px)]">
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
    </div>
  )
}
