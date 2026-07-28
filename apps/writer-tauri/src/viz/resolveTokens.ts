// Design-token resolver for the Mermaid renderer.
//
// Our palette tokens are authored in `oklch()` and `color-mix(in oklch, …)`
// (see index.css). Mermaid has its own colour engine that cannot parse those
// formats, so handing it `var(--token)` directly paints black or throws. The fix is to let the *browser* do the conversion: paint a
// hidden probe with `color: var(--token)`, then read it back with
// `getComputedStyle().color`, which the engine normalises to a plain
// `rgb()` / `rgba()` string Mermaid understands.
//
// Because the probe is mounted under <html> (where ThemeProvider toggles the
// `palette-*` / `light` / `dark` classes), the values returned automatically
// reflect the active theme. Re-run this whenever the palette changes.

/** Resolve a list of CSS custom-property names (e.g. `--foreground`) to the
 * browser-computed `rgb()` / `rgba()` string for the active theme. Tokens
 * that resolve to nothing are omitted from the result. */
export function resolveTokens(tokens: readonly string[]): Record<string, string> {
  const probe = document.createElement('span')
  probe.setAttribute('aria-hidden', 'true')
  probe.style.position = 'absolute'
  probe.style.width = '0'
  probe.style.height = '0'
  probe.style.visibility = 'hidden'
  probe.style.pointerEvents = 'none'
  document.body.appendChild(probe)

  const resolved: Record<string, string> = {}
  try {
    for (const token of tokens) {
      // A bogus fallback lets us detect a token that doesn't exist: if the
      // custom property is undefined the declaration is invalid and `color`
      // keeps its inherited value rather than our sentinel.
      probe.style.color = ''
      probe.style.color = `var(${token})`
      const value = getComputedStyle(probe).color
      if (value) resolved[token] = value
    }
  } finally {
    probe.remove()
  }
  return resolved
}

/** Resolve `--font-sans` to the concrete font-family stack for the active
 * theme. Kept here so all DOM-probe logic lives in one module. */
export function resolveFontFamily(): string {
  const probe = document.createElement('span')
  probe.setAttribute('aria-hidden', 'true')
  probe.style.position = 'absolute'
  probe.style.visibility = 'hidden'
  probe.style.pointerEvents = 'none'
  probe.style.fontFamily = 'var(--font-sans)'
  document.body.appendChild(probe)
  try {
    return getComputedStyle(probe).fontFamily
  } finally {
    probe.remove()
  }
}
