// Token interpolation — replace `{{token}}` placeholders in text with computed
// values. Pure, dependency-free, and NOT template-specific: templates are the
// first consumer, but any inserted / generated markdown can call this.
//
// Two things are deliberately OUT of scope here:
//   • {{cursor}} — a caret-placement marker, not a value. It's left untouched
//     so the editor insert path can locate + strip it (see CURSOR_TOKEN).
//   • unknown tokens — left as-is (a user's typo stays visible rather than
//     silently vanishing).
//
// Date/time tokens all derive from a single `now` instant so a template that
// uses several stays internally consistent (no cross-token drift at midnight).

/** Caret-placement marker. Interpolation leaves it in place; the editor insert
 * path removes it and drops the cursor where it was. */
export const CURSOR_TOKEN = '{{cursor}}'

export interface InterpolateContext {
  /** The instant all date/time tokens derive from. Defaults to `new Date()`. */
  now?: Date
}

function pad(n: number): string {
  return String(n).padStart(2, '0')
}

/** Local `YYYY-MM-DD` — matches the vault's daily-note date format. */
function ymd(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

function addDays(d: Date, days: number): Date {
  const r = new Date(d)
  r.setDate(r.getDate() + days)
  return r
}

/** Monday of the week containing `d` (ISO week: Monday-start). */
function mondayOf(d: Date): Date {
  const r = new Date(d)
  const mondayOffset = (r.getDay() + 6) % 7 // getDay: 0=Sun…6=Sat ⇒ 0=Mon…6=Sun
  return addDays(r, -mondayOffset)
}

/** Replace known `{{token}}` placeholders in `text`. Unknown tokens and
 * {{cursor}} are left untouched. Whitespace inside the braces is tolerated
 * (`{{ today }}`), matching is case-insensitive. */
export function interpolate(text: string, ctx: InterpolateContext = {}): string {
  const now = ctx.now ?? new Date()
  const hm = `${pad(now.getHours())}:${pad(now.getMinutes())}`
  const values: Record<string, string> = {
    today: ymd(now),
    date: ymd(now),
    tomorrow: ymd(addDays(now, 1)),
    yesterday: ymd(addDays(now, -1)),
    now: hm,
    time: hm,
    'this-week': ymd(mondayOf(now)),
    'next-week': ymd(addDays(mondayOf(now), 7)),
  }
  return text.replace(/\{\{\s*([a-z-]+)\s*\}\}/gi, (match, name: string) => {
    const key = name.toLowerCase()
    return key in values ? values[key] : match
  })
}
