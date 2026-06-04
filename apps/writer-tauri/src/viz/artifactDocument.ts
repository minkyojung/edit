// Builder for the sandboxed-artifact iframe document.
//
// The AI emits a self-contained HTML artifact in a ```artifact fence. We never
// inject that HTML into the host DOM — instead we wrap it into a full document
// string and hand it to an `sandbox="allow-scripts"` iframe (NO
// allow-same-origin → opaque origin). That sandbox is the PRIMARY isolation
// boundary; the injected CSP below is defense-in-depth plus the network
// kill-switch. A security spike confirmed this blocks Tauri IPC, parent-window
// access, and all network while still letting inline scripts run.
//
// This module is intentionally string-only (no DOM mutation of the host) so the
// security-critical assembly is unit-testable in isolation. The one DOM touch —
// buildArtifactThemeCss — reads design tokens via resolveTokens and is kept
// here for cohesion.

import { resolveFontFamily, resolveTokens } from './resolveTokens'

// Enforced inside every artifact frame, as the first <head> child. A meta CSP
// only governs content that appears AFTER it, and multiple policies combine
// restrictively (a later policy can only narrow, never widen) — so AI HTML
// cannot loosen this even if it injects its own. `'unsafe-inline'` for scripts
// is acceptable ONLY because the frame's origin is opaque (no reach to parent /
// Tauri IPC / network); there is deliberately no `'unsafe-eval'`.
export const ARTIFACT_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  'img-src data:',
  'font-src data:',
  "connect-src 'none'", // network kill-switch: no fetch / XHR / WS / beacon
  'media-src data:',
  "form-action 'none'",
  "base-uri 'none'",
  "frame-src 'none'", // no nested frames (escape route)
  "child-src 'none'",
  "object-src 'none'",
].join('; ')

// Design tokens injected so AI HTML can theme with var(--x) and match the
// active palette. resolveTokens resolves them to concrete rgb() in the HOST
// (where the palette class lives); the iframe has no palette context of its own.
const ARTIFACT_TOKENS = [
  '--background',
  '--foreground',
  '--card',
  '--card-foreground',
  '--primary',
  '--primary-foreground',
  '--secondary',
  '--secondary-foreground',
  '--muted',
  '--muted-foreground',
  '--accent',
  '--accent-foreground',
  '--border',
  '--ring',
  // Categorical data palette — equal-chroma, hue-rotated (see index.css).
  '--viz-cat-1',
  '--viz-cat-2',
  '--viz-cat-3',
  '--viz-cat-4',
  '--viz-cat-5',
  '--viz-cat-6',
] as const

/** Build a `:root{}` block of the active palette's tokens (resolved to rgb())
 * plus `--art-font-sans`. Call at render time and pass to buildArtifactSrcdoc;
 * re-call when the palette changes. */
export function buildArtifactThemeCss(): string {
  const tokens = resolveTokens(ARTIFACT_TOKENS)
  const decls = Object.entries(tokens).map(([name, value]) => `${name}:${value};`)
  decls.push(`--art-font-sans:${resolveFontFamily()};`)
  return `:root{${decls.join('')}}`
}

// Base stylesheet injected into every artifact — the visualization design
// system. It styles raw elements (headings, body, tables) to the app's tone,
// defines sizing variables, and provides named primitives (.viz-card / .viz-kpi
// / .viz-grid / .viz-legend) so AI HTML stays consistent with little effort.
// References the theme tokens injected just before it (themeCss); fallbacks
// keep it sane if a token is missing.
const ARTIFACT_BASE_CSS = [
  '*{box-sizing:border-box}',
  'html,body{margin:0;padding:0}',
  ':root{--viz-maxw:640px;--viz-gap:12px;--viz-radius:12px;--viz-pad:16px}',
  'body{font-family:var(--art-font-sans,system-ui,sans-serif);' +
    'color:var(--foreground,#111);background:transparent;font-size:14px;' +
    'line-height:1.5;padding:8px;-webkit-font-smoothing:antialiased}',
  // Keep content within a consistent column, centred.
  'body>*{max-width:var(--viz-maxw);margin-inline:auto}',
  // Typography
  'h1,h2,h3{margin:0 0 .5em;line-height:1.25;font-weight:650;letter-spacing:-0.01em}',
  'h1{font-size:1.5rem}h2{font-size:1.25rem}h3{font-size:1.05rem}',
  'p{margin:0 0 .75em}',
  'a{color:var(--viz-cat-1,#4f7cff)}',
  '.viz-muted,small{color:var(--muted-foreground,#666)}',
  // Media
  'img,svg,canvas{max-width:100%;height:auto}',
  // Tables
  'table{width:100%;border-collapse:collapse;font-size:.9em}',
  'th,td{text-align:left;padding:8px 10px;border-bottom:1px solid var(--border,#e5e5e5)}',
  'th{color:var(--muted-foreground,#666);font-weight:600}',
  'td{font-variant-numeric:tabular-nums}',
  // Primitives
  '.viz-card{background:var(--card,#fff);border:1px solid var(--border,#e5e5e5);' +
    'border-radius:var(--viz-radius);padding:var(--viz-pad)}',
  '.viz-grid{display:grid;gap:var(--viz-gap);' +
    'grid-template-columns:repeat(auto-fit,minmax(140px,1fr))}',
  '.viz-kpi{display:flex;flex-direction:column;gap:2px}',
  '.viz-kpi-value{font-size:1.6rem;font-weight:700;font-variant-numeric:tabular-nums;line-height:1.1}',
  '.viz-kpi-label{font-size:.8rem;color:var(--muted-foreground,#666)}',
  '.viz-legend{display:flex;flex-wrap:wrap;gap:8px 16px;font-size:.85em}',
  '.viz-legend>*{display:flex;align-items:center;gap:6px}',
  '.viz-swatch{width:10px;height:10px;border-radius:3px;flex:none}',
].join('')

/** Flatten AI HTML to a body fragment: if it returned a whole document we strip
 * the structural wrappers but KEEP their contents (so head <style>/<script>
 * survive — many models put styles in <head>). Also drop AI-authored CSP /
 * <base> / viewport metas so ours stay authoritative. The sandbox enforces
 * isolation regardless; this is just to keep our wrapper coherent. */
function flattenToFragment(html: string): string {
  return html
    .replace(/<!doctype[^>]*>/gi, '')
    .replace(/<\/?html[^>]*>/gi, '')
    .replace(/<\/?head[^>]*>/gi, '')
    .replace(/<\/?body[^>]*>/gi, '')
    .replace(/<meta[^>]+http-equiv\s*=\s*["']?content-security-policy["']?[^>]*>/gi, '')
    .replace(/<base[^>]*>/gi, '')
    .replace(/<meta[^>]+name\s*=\s*["']?viewport["']?[^>]*>/gi, '')
}

/** Trusted (NOT AI) height reporter, injected last in <body>. Measures the
 * document and posts the height to the host, keyed by a per-iframe nonce so the
 * host can tell concurrent artifacts apart. It can only ever send a number — it
 * cannot read the parent (cross-origin). rAF-coalesced to avoid postMessage
 * spam during animations. */
function heightReporterScript(nonce: string): string {
  const NONCE = JSON.stringify(nonce)
  return (
    '<script>(function(){' +
    `var NONCE=${NONCE};` +
    'function measure(){var d=document.documentElement,b=document.body;' +
    'return Math.max(b?b.scrollHeight:0,d?d.scrollHeight:0,b?b.offsetHeight:0,d?d.offsetHeight:0);}' +
    "function post(){try{parent.postMessage({source:'artifact-frame',nonce:NONCE,type:'height',height:measure()},'*');}catch(e){}}" +
    'var pending=false;function schedule(){if(pending)return;pending=true;' +
    'requestAnimationFrame(function(){pending=false;post();});}' +
    'try{var ro=new ResizeObserver(schedule);ro.observe(document.documentElement);' +
    'if(document.body)ro.observe(document.body);}catch(e){}' +
    "window.addEventListener('load',schedule);schedule();" +
    '})();</script>'
  )
}

/** Assemble the full srcdoc for an artifact iframe. Pure string assembly. */
export function buildArtifactSrcdoc(opts: {
  html: string
  nonce: string
  themeCss: string
}): string {
  const fragment = flattenToFragment(opts.html)
  return (
    '<!DOCTYPE html><html><head>' +
    `<meta http-equiv="Content-Security-Policy" content="${ARTIFACT_CSP}">` +
    '<base target="_blank">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    // themeCss (the :root tokens) MUST come before the base sheet, which
    // consumes those vars (--viz-cat-*, --card, --border, …).
    `<style>${opts.themeCss}${ARTIFACT_BASE_CSS}</style>` +
    '</head><body>' +
    fragment +
    heightReporterScript(opts.nonce) +
    '</body></html>'
  )
}
