// Shared visual shell for floating editor menus — one place to change the
// popover chrome. Currently SelectionMenu; kept shared so any future
// floating menu matches it. Compose with cn() plus per-menu layout
// (width, flex direction).
export const FLOATING_MENU_SHELL =
  'rounded-2xl bg-popover p-2.5 shadow-2xl shadow-black/45 ring-1 ring-border'
