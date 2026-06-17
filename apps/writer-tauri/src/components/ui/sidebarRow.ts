// Single source of truth for sidebar ROW interaction styling — the
// resting text color, corner radius, hover, and selected (data-active)
// look. Both the footer menu buttons (SidebarMenuButton) and the
// folder-tree rows (TreeRow) apply this string, so the two never drift
// and the look is tuned in one place.
//
// Vibrancy: the sidebar surface is translucent (frosted), so hover / selected
// use TRANSLUCENT overlays (bg-foreground/N) instead of solid token fills —
// the blur shows through and the highlight reads as a tint, not a floating
// block. foreground/N adapts per theme (light overlay on dark themes, dark on
// light). Opaque-surface selections elsewhere keep the solid --selected tone;
// this overlay is sidebar-specific.
export const SIDEBAR_ROW_INTERACTION =
  'rounded-sm text-sidebar-foreground/60 ' +
  'hover:bg-foreground/8 hover:text-sidebar-foreground ' +
  'data-active:bg-foreground/16 data-active:text-sidebar-foreground'
