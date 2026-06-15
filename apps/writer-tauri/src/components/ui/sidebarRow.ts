// Single source of truth for sidebar ROW interaction styling — the
// resting text color, corner radius, hover, and selected (data-active)
// look. Both the footer menu buttons (SidebarMenuButton) and the
// folder-tree rows (TreeRow) apply this string, so the two never drift
// and the look is tuned in one place.
//
// Colors come from tokens: hover = --sidebar-accent, selected =
// --sidebar-active (a distinct, stronger tone than hover). Structural
// bits (flex layout, height, padding, svg sizing) stay on each
// component — only the shared "interaction skin" lives here.
export const SIDEBAR_ROW_INTERACTION =
  'rounded-sm text-sidebar-foreground/60 ' +
  'hover:bg-sidebar-accent hover:text-sidebar-accent-foreground ' +
  'data-active:bg-sidebar-active data-active:text-sidebar-active-foreground'
