// Shared chrome (toolbar button) treatment used across the header
// row's single-button capsules and pill groups. Modelled on macOS
// Tahoe's "Liquid Glass" toolbar: a translucent fill, a hairline
// outer border, an inset top highlight to suggest a lit surface, and
// a 1px rim shadow at the bottom to lift the surface off the canvas.
// Hover wash bumps the fill a step so the active target reads without
// shifting size.
//
// Applied via className on:
//   - SidebarTrigger, ContextPanelTrigger (single circular buttons)
//   - NavHistoryButtons wrapper (pill containing two buttons)
//   - DocMenu trigger (… menu button)
//
// Intentionally NOT applied to SidebarDateMenu (Day ⌄) — the sidebar's
// view picker reads better as a quiet ghost button so it doesn't
// compete with the editor header's chrome family for visual weight.
export const TAHOE_CHROME =
  'rounded-full border border-foreground/10 bg-foreground/[0.06] shadow-[inset_0_1px_0_color-mix(in_oklch,var(--foreground)_8%,transparent),0_1px_0_color-mix(in_oklch,var(--background)_60%,transparent)] hover:bg-foreground/[0.08]'
