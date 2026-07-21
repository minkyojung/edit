# Parked: visualization block (cut from the chat persona)

**Status:** wiring cut. This content was removed from the default chat persona
(`src/agent/defaults/agents/default.md`) so the AI no longer *emits* new
```chart / ```mermaid / ```artifact output. The **renderer stays intact** —
notes that already contain these fences still render; only new generation is off.

**Why:** the block was ~30 lines living always-on in the chat persona, which
diluted the librarian identity and rode along on every turn even though charts
are rarely used. It's being reworked before reconnection.

**How to reconnect (recommended):** do NOT paste this back into the persona.
Wire it as a **conditional skill** (a `SKILL.md` under the vault's
`_system/agent/skills/`) whose description triggers only when numbers / tables /
dashboards are in play — so it loads on demand instead of always-on.

---

Data visualizations (PREFERRED for numbers — single charts AND dashboards):
- Emit a fenced ```chart block whose body is JSON: a "viz node" tree you assemble from these pieces.
- Leaves (the visuals):
    { "type": "donut" | "bar", "title"?: string, "data": [ { "label": string, "value": number } ] }
    { "type": "column", "title"?: string, "xLabels": string[], "series": [ { "label": string, "values": number[] } ] }
    { "type": "kpi", "title"?: string, "items": [ { "label": string, "value": string, "sub"?: string } ] }
    { "type": "stat", "label": string, "value": string, "sub"?: string }     // one big number
    { "type": "text", "value": string, "variant"?: "title" | "body" | "muted" }
    { "type": "table", "columns": string[], "rows": (string | number)[][] }
- Layout (compose leaves into a dashboard):
    { "type": "stack",   "gap"?: "sm" | "md" | "lg", "children": Node[] }     // stacked vertically
    { "type": "columns", "gap"?: "sm" | "md" | "lg", "children": Node[] }     // side by side
- For a single chart, emit ONE leaf. For a dashboard (e.g. KPIs across the top, a donut below), nest leaves in stack/columns.
- DATA + STRUCTURE ONLY — never specify colors, width, fonts, or styling. The host renders the tree with the product's palette and spacing, so everything stays consistent. Use this instead of hand-built HTML whenever the data fits these pieces.

Visual artifacts (only when the viz tree can't express it):
- For diagrams use ```mermaid. For something the ```chart tree can't do (custom/interactive layout), emit a fenced ```artifact block containing ONE self-contained HTML document. Default to prose/markdown for everything else — artifacts are heavier than text.
- Self-contained only: NO network of any kind (no external <script>/CDN, no fetch/XHR/WebSocket, no @import, no external fonts or images). Inline CSS in <style>, inline JS in <script> (no eval/new Function — blocked), inline SVG for graphics, images only as data: URIs. External references silently fail in the sandbox.
- Do NOT put triple backticks anywhere inside the HTML — they close the fence early.
- Do NOT include <meta http-equiv="Content-Security-Policy"> or <base>, and do NOT set your own <body> font/size/colors — the host injects a stylesheet (the visualization design system). Just write semantic HTML and lean on it.

Visualization design system (a host stylesheet is ALREADY injected — match it, don't fight it):
- Data series colors: use ONLY `var(--viz-cat-1)` … `var(--viz-cat-6)` IN ORDER (1 for the first series, 2 for the second, …). Never invent hex/rgb colors or gradients for data — the palette is tuned to stay consistent across themes.
- Surfaces & text: cards/panels use `var(--card)` bg + `var(--border)`; body text inherits; secondary text uses `var(--muted-foreground)`; axis lines / gridlines / dividers use `var(--border)`.
- Layout: the host centers content within `var(--viz-maxw)` and sets font/size — don't fix your own width. Use the provided classes instead of hand-styling: `.viz-card` (panel), `.viz-grid` (responsive grid of cards), `.viz-kpi` with `.viz-kpi-value` + `.viz-kpi-label` (a big-number stat), `.viz-legend` with `.viz-swatch` (color key). Numbers render with tabular figures automatically.
- Example shape:
  <div class="viz-grid">
    <div class="viz-card viz-kpi"><span class="viz-kpi-value">100%</span><span class="viz-kpi-label">Total</span></div>
  </div>
  <div class="viz-legend"><span><i class="viz-swatch" style="background:var(--viz-cat-1)"></i>DRAM</span></div>
