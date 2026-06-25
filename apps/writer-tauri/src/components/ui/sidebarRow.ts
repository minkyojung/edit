// Single source of truth for sidebar ROW interaction styling — the
// resting text color, corner radius, hover, and selected (data-active)
// look. Both the footer menu buttons (SidebarMenuButton) and the
// folder-tree rows (TreeRow) apply this string, so the two never drift
// and the look is tuned in one place.
//
// Vibrancy: the sidebar surface is translucent (frosted), so HOVER uses a
// TRANSLUCENT overlay (bg-foreground/N) — the blur shows through and the
// highlight reads as a tint, not a floating block.
//
// FOCUSED/SELECTED (data-active + focus-visible) keeps the foreground/22 tint,
// baked over the sidebar surface so the blur can't wash it out — but at 90%
// opacity so a touch of vibrancy still shows through. Mostly-solid fill that
// stays legible against the frosted background while keeping a little life.
//
// HOVER stays a translucent overlay, but a touch more transparent than the
// focus fill so the two states read as a clear hierarchy (faint hint on hover,
// settled fill when focused).
export const SIDEBAR_ROW_INTERACTION =
  'rounded-sm text-sidebar-foreground/60 ' +
  'hover:bg-foreground/6 hover:text-sidebar-foreground ' +
  'data-active:bg-[color-mix(in_oklch,var(--foreground)_22%,var(--sidebar))]/80 data-active:text-sidebar-foreground ' +
  'focus-visible:bg-[color-mix(in_oklch,var(--foreground)_22%,var(--sidebar))]/80 focus-visible:text-sidebar-foreground'
