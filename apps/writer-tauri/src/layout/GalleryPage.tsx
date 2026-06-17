// Design-system gallery — the in-app, Storybook-free "living style guide".
// Reached from the sidebar "Gallery" footer row, rendered in the main area
// like any note view (see SkillsPage). Built bottom-up by dependency order:
// Foundations (tokens) first, then Primitives, Compositions, Surfaces.
//
// This file is the SINGLE source of the gallery; it imports the REAL tokens
// (via `var(--…)`) and components so it can never drift from production.
// Step 1 ships Foundations → Color only; later steps append sections.

import type { ReactNode } from 'react'

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
    </div>
  )
}
