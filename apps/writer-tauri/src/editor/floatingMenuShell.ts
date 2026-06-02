// Shared visual shell for floating editor menus — one place to change the
// popover chrome. Currently SelectionMenu; kept shared so any future
// floating menu matches it. Compose with cn() plus per-menu layout
// (width, flex direction).
export const FLOATING_MENU_SHELL =
  'rounded-xl bg-popover/85 p-1 shadow-xl shadow-black/30 ring-1 ring-border backdrop-blur-xl'
