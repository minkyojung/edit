# Handoff: add /privacy and /terms to the octave.run landing (Next.js)

Paste this file into the landing repo's AI session. Bring these three files:

- `landing-handoff.md` (this file — the brief)
- `privacy-policy.md` (the Privacy Policy content)
- `terms-of-service.md` (the Terms of Service content)

## Goal

Publish two legal pages on the marketing site so they're reachable at:

- `https://octave.run/privacy`
- `https://octave.run/terms`

These URLs are already linked from the desktop app's onboarding (so they're
currently broken links), and both are required in the Google OAuth consent screen
before the app can move out of "Testing" mode. So getting them live is a blocker
for production sign-in.

## Content

Use the text in `privacy-policy.md` and `terms-of-service.md` verbatim (they are
accurate to Octave's actual data practices). They are **drafts** — the operator
should reconcile them with a generator (Termly/iubenda) or a lawyer before
relying on them, but publish them as-is to unblock the links/OAuth for now.

Both start with an HTML comment (`<!-- DRAFT ... -->`) — strip that comment out
of the rendered page; it's a note for the operator, not for readers.

## Implementation (Next.js App Router — the clean way)

Render the Markdown to styled pages. Recommended stack:

1. Add a markdown renderer:
   ```bash
   npm i react-markdown remark-gfm
   ```
2. Put the content files somewhere importable, e.g. `content/privacy.md` and
   `content/terms.md` (copy from the two files above; keep them as `.md`).
3. A shared legal layout with readable typography (Tailwind `@tailwindcss/typography`
   `prose`, or the site's existing prose styles):
   ```tsx
   // app/(legal)/legal.tsx  — or inline in each page
   import ReactMarkdown from 'react-markdown'
   import remarkGfm from 'remark-gfm'

   export function LegalPage({ markdown }: { markdown: string }) {
     return (
       <main className="mx-auto max-w-2xl px-6 py-16">
         <article className="prose prose-neutral dark:prose-invert">
           <ReactMarkdown remarkPlugins={[remarkGfm]}>{markdown}</ReactMarkdown>
         </article>
       </main>
     )
   }
   ```
4. The two routes (read the file at build time — these are static):
   ```tsx
   // app/privacy/page.tsx
   import fs from 'node:fs'
   import path from 'node:path'
   import type { Metadata } from 'next'
   import { LegalPage } from '../(legal)/legal'

   export const metadata: Metadata = {
     title: 'Privacy Policy — Octave',
     description: 'How Octave handles your data.',
   }

   export default function Page() {
     const md = fs
       .readFileSync(path.join(process.cwd(), 'content/privacy.md'), 'utf8')
       .replace(/<!--[\s\S]*?-->/g, '') // strip the DRAFT operator note
     return <LegalPage markdown={md} />
   }
   ```
   Mirror this for `app/terms/page.tsx` → `content/terms.md`, title "Terms of
   Service — Octave".

   (If the site prefers MDX, `.mdx` files + `@next/mdx` also work — either is fine.
   The file-read approach above keeps the content as plain Markdown the operator
   can edit without touching JSX.)

## Also do

- **Footer links**: add "Privacy" and "Terms" to the site footer, pointing to
  `/privacy` and `/terms`.
- **SEO**: these should be indexable (no `noindex`); add them to the sitemap if
  the site has one.
- Confirm the pages render the tables (GDPR legal-basis table, sub-processors
  table) correctly — that's why `remark-gfm` is included.

## After they're live (operator does this, not the landing repo)

1. In the Google Cloud OAuth consent screen (Branding), set the **Privacy Policy
   URL** = `https://octave.run/privacy` and **Terms of Service URL** =
   `https://octave.run/terms`, plus the app homepage `https://octave.run`.
2. That unblocks moving the OAuth app from Testing → Production (and any Google
   verification).

## Notes

- Operator: **Minkyo Jung** (individual). Contact: **william@octave.run**.
  Governing law: Republic of Korea. (Already baked into the content.)
- Keep the effective date (`July 10, 2026`) or update it to the real publish date.
