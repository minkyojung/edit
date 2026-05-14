// Configures @milkdown/kit/component/list-item-block's renderLabel
// callback to inject SVG icons for bullet / checked / unchecked items.
//
// The component is a Milkdown-native NodeView that wraps every
// list_item with a `.label-wrapper` for the marker and a `.children`
// slot for the content. It also wires a click handler on the wrapper
// that toggles `checked` via setNodeAttribute, which is exactly the
// behavior we want for `[ ]` task lists — no extra command needed.
//
// Defaults ship with Unicode glyphs (⦿ / ☐ / ☑) which read low-rent
// next to our other UI; we override with the same SVG set Crepe ships
// so visuals match what the rest of the Milkdown ecosystem looks like.
// `null` checked + bullet → SVG dot; numbered lists fall through to
// the auto-generated label (the actual number string).

import type { Ctx } from '@milkdown/kit/ctx'
import { listItemBlockConfig } from '@milkdown/kit/component/list-item-block'

// Renders for the three list_item visual states. We keep the *box*
// of a checkbox out of the SVG and let the span (`.milkdown-icon`)
// carry it via CSS border/background — same pattern shadcn's Checkbox
// uses (a button with border + an inner check mark). Putting the box
// in CSS lets us drive its color from theme tokens (--border /
// --primary / --primary-foreground) instead of hardcoding into SVG.
//
//   bullet     → dot SVG, span has no chrome
//   unchecked  → empty SVG, span IS the outlined box (CSS)
//   checked    → check-only SVG, span IS the filled box (CSS)
//
// Icon's renderer treats empty strings as "no innerHTML", so we use
// a self-closing <svg/> for the unchecked state to keep the slot
// non-empty without injecting markup.

const TABLER_SVG_ATTRS =
  'xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" ' +
  'fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"'

const BULLET_ICON = `
<svg ${TABLER_SVG_ATTRS}>
  <path d="M12 7a5 5 0 1 1 -4.995 5.217l-.005 -.217l.005 -.217a5 5 0 0 1 4.995 -4.783z" fill="currentColor" stroke="none" />
</svg>
`

const CHECKBOX_UNCHECKED_ICON = `<svg ${TABLER_SVG_ATTRS}></svg>`

// Heavier stroke + a path that spans most of the viewBox so the check
// reads at the small ~14px size we render at. Tabler's default check
// path (M9 12 l2 2 l4 -4) only fills the inner ~25% of the viewBox,
// which looked tiny inside our 1em box.
const CHECKBOX_CHECKED_ICON = `
<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24"
  fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
  <path d="M5 12l5 5L20 7" />
</svg>
`

export function configureListItemBlock(ctx: Ctx): void {
  ctx.set(listItemBlockConfig.key, {
    renderLabel: ({ label, listType, checked }) => {
      if (checked === true) return CHECKBOX_CHECKED_ICON
      if (checked === false) return CHECKBOX_UNCHECKED_ICON
      if (listType === 'bullet') return BULLET_ICON
      return label // ordered → "1.", "2." …
    },
  })
}
