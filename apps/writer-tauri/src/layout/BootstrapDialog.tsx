// First-run welcome dialog.
//
// Default flow (URL → Self Profile):
//   1. Source  — user pastes blog / Substack / Medium URLs (one per
//                line). Markdown Import remains accessible via a
//                small secondary link for users who prefer files.
//   2. Analyze — runs extractProfile (URL → LLM → ProfileFields),
//                saves the result to the wiki:profile page, navigates
//                the editor there. The on-page banner (E.5.d) becomes
//                the "review" surface; no in-modal review step.
//
// Markdown fallback (Stage1 secondary link):
//   1. Source  — same dialog, user clicks "Or import markdown notes"
//   2. Analyze — runs runImport (file picker → bootstrapIngest),
//                proposals land in the existing WikiPageBanner.
//
// Skip / Finish / Esc all flip settingsStore.bootstrapCompleted so
// the dialog stays gone across app restarts. BootGate controls
// when this mounts.

import { useEffect, useRef, useState } from 'react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { useSettingsStore } from '@/state/settingsStore'
import { notify } from '@/lib/notify'
import {
  runImport,
  type ImportProgress,
  type ImportResult,
} from '@/agent/import/runImport'
import {
  extractProfile,
  type ExtractProfileProgress,
} from '@/agent/profile/extractProfile'
import { saveProfileToVault } from '@/agent/profile/saveProfile'
import { useDocsStore } from '@/state/docsStore'

type Stage = 'source' | 'url-analyze' | 'markdown-analyze'

interface Props {
  open: boolean
  onClose: () => void
}

export function BootstrapDialog({ open, onClose }: Props) {
  const [stage, setStage] = useState<Stage>('source')
  const [urls, setUrls] = useState<string[]>([])
  const markCompleted = useSettingsStore((s) => s.markBootstrapCompleted)

  const handleSkip = () => {
    markCompleted()
    onClose()
  }

  const handleFinish = () => {
    markCompleted()
    onClose()
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        // Closing via Esc / outside-click counts as Skip — bootstrap
        // is one-shot and shouldn't reappear next launch just
        // because the user dismissed it casually.
        if (!next) handleSkip()
      }}
    >
      <DialogContent className="max-w-lg">
        {stage === 'source' && (
          <Stage1Source
            onSkip={handleSkip}
            onSubmitUrls={(parsed) => {
              setUrls(parsed)
              setStage('url-analyze')
            }}
            onUseMarkdown={() => setStage('markdown-analyze')}
          />
        )}
        {stage === 'url-analyze' && (
          <Stage2UrlAnalyze
            urls={urls}
            onCancel={() => setStage('source')}
            onFinish={handleFinish}
          />
        )}
        {stage === 'markdown-analyze' && (
          <Stage2MarkdownAnalyze
            onCancel={() => setStage('source')}
            onFinish={handleFinish}
          />
        )}
      </DialogContent>
    </Dialog>
  )
}

interface Stage1Props {
  onSkip: () => void
  onSubmitUrls: (parsed: string[]) => void
  onUseMarkdown: () => void
}

function Stage1Source({ onSkip, onSubmitUrls, onUseMarkdown }: Stage1Props) {
  const [raw, setRaw] = useState('')
  const parsed = parseUrls(raw)
  const canProceed = parsed.length > 0

  return (
    <>
      <DialogHeader>
        <DialogTitle>Tell us about you</DialogTitle>
        <DialogDescription>
          Paste links to your writing — blog, Substack, Medium, Ghost,
          WordPress, anything public. One URL per line. We&apos;ll read
          them and draft a profile you can edit.
        </DialogDescription>
      </DialogHeader>
      <textarea
        className="min-h-32 w-full resize-y rounded-md border border-border bg-background p-3 font-mono text-sm placeholder:text-muted-foreground focus:border-foreground focus:outline-none"
        placeholder={'https://your-blog.com\nhttps://your-name.substack.com\nhttps://medium.com/@your-handle'}
        value={raw}
        onChange={(e) => setRaw(e.target.value)}
        spellCheck={false}
        autoFocus
      />
      {parsed.length > 0 && (
        <p className="text-xs text-muted-foreground">
          {parsed.length} {parsed.length === 1 ? 'URL' : 'URLs'} ready.
        </p>
      )}
      <button
        type="button"
        onClick={onUseMarkdown}
        className="self-start text-xs text-muted-foreground underline-offset-2 hover:underline"
      >
        Or import markdown notes instead
      </button>
      <DialogFooter className="flex items-center justify-between sm:justify-between">
        <Button variant="ghost" onClick={onSkip} className="text-muted-foreground">
          Skip &amp; start blank
        </Button>
        <Button onClick={() => onSubmitUrls(parsed)} disabled={!canProceed}>
          Next
        </Button>
      </DialogFooter>
    </>
  )
}

/** Split a textarea blob into a clean URL list. Strips whitespace,
 * drops blanks, drops anything that doesn't parse as URL — the user
 * sees the live "N URLs ready" count update as they fix typos. */
function parseUrls(raw: string): string[] {
  const lines = raw.split(/[\r\n]+/).map((s) => s.trim()).filter((s) => s.length > 0)
  const valid: string[] = []
  for (const line of lines) {
    try {
      const u = new URL(line)
      if (u.protocol === 'http:' || u.protocol === 'https:') {
        valid.push(line)
      }
    } catch {
      /* skip invalid */
    }
  }
  return valid
}

interface Stage2UrlProps {
  urls: string[]
  /** Extraction failed wholesale (no usable sources). Bounce back
   * to Stage 1 so the user can edit URLs or hit Skip. */
  onCancel: () => void
  /** Profile saved successfully (or 0-source noop). Closes the
   * dialog and lets the post-finish handler navigate the user to
   * the wiki:profile page. */
  onFinish: () => void
}

function Stage2UrlAnalyze({ urls, onCancel, onFinish }: Stage2UrlProps) {
  const [progress, setProgress] = useState<ExtractProfileProgress | null>(null)
  const startedRef = useRef(false)

  useEffect(() => {
    if (startedRef.current) return
    startedRef.current = true

    void (async () => {
      try {
        const result = await extractProfile(urls, { onProgress: setProgress })
        // Total failure — nothing valid extracted. Bounce back so
        // the user can fix the URL list rather than landing on an
        // empty profile page.
        if (result.sourcesProcessed === 0) {
          notify.profileBootstrapComplete({
            sourcesProcessed: 0,
            sourcesFailed: result.sourcesFailed,
            saved: false,
          })
          onCancel()
          return
        }
        // Save the markdown into wiki:profile (creates the page if
        // it doesn't exist yet). Failure here is rare but possible
        // (parser not ready, vault write error) — surface and bail.
        const slug = await saveProfileToVault(result.profileMarkdown)
        if (!slug) {
          notify.profileBootstrapComplete({
            sourcesProcessed: result.sourcesProcessed,
            sourcesFailed: result.sourcesFailed,
            saved: false,
          })
          onCancel()
          return
        }
        // Surface the outcome BEFORE closing — toast becomes the
        // persistent feedback while the modal animates out and the
        // editor navigates to the profile page.
        notify.profileBootstrapComplete({
          sourcesProcessed: result.sourcesProcessed,
          sourcesFailed: result.sourcesFailed,
          saved: true,
        })
        // Navigate the editor to the freshly-saved profile page so
        // the user lands on it as the dialog closes. The on-page
        // banner (E.5.d) will be the "review" surface.
        useDocsStore.getState().setActive(slug)
        onFinish()
      } catch (err) {
        console.error('[bootstrap] extractProfile failed', err)
        notify.profileBootstrapComplete({
          sourcesProcessed: 0,
          sourcesFailed: urls.length,
          saved: false,
        })
        onCancel()
      }
    })()
    // urls is captured via ref-guard; effect intentionally runs once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const statusLine = (() => {
    if (!progress) {
      return `Fetching ${urls.length} ${urls.length === 1 ? 'source' : 'sources'}…`
    }
    if (progress.synthesisRunning) {
      return 'Synthesising your profile…'
    }
    return `Reading ${progress.urlsDone} / ${progress.urlsTotal} sources…`
  })()

  return (
    <>
      <DialogHeader>
        <DialogTitle>Drafting your profile</DialogTitle>
        <DialogDescription>{statusLine}</DialogDescription>
      </DialogHeader>
      <div className="flex items-center justify-center py-8">
        <Spinner />
      </div>
    </>
  )
}

interface Stage2MarkdownProps {
  /** User cancelled the OS picker (no files chosen). Stage 1 takes
   * over so they can pick again or hit Skip. */
  onCancel: () => void
  /** Import finished (at least one file processed). Closes the
   * dialog and persists bootstrapCompleted. */
  onFinish: () => void
}

function Stage2MarkdownAnalyze({ onCancel, onFinish }: Stage2MarkdownProps) {
  const [progress, setProgress] = useState<ImportProgress | null>(null)
  const [result, setResult] = useState<ImportResult | null>(null)
  const startedRef = useRef(false)

  // Fire the import exactly once on mount. React StrictMode double-
  // mounts every dev-time effect, which would open the OS picker
  // twice; the ref short-circuits the second run. (Not an issue in
  // production, but the dev experience matters during dogfood.)
  useEffect(() => {
    if (startedRef.current) return
    startedRef.current = true

    void (async () => {
      try {
        const res = await runImport({ onProgress: setProgress })
        setResult(res)
        if (res.filesProcessed === 0) {
          // User cancelled the picker — bounce back to Stage 1 so
          // they can retry or hit Skip explicitly.
          onCancel()
          return
        }
        // Surface the outcome BEFORE closing the dialog so the toast
        // is the persistent feedback while the modal animates out.
        // Without this the dialog just disappears and the user has
        // no idea whether the LLM extracted anything (a valid 0-
        // proposal result looks identical to a 12-proposal result).
        notify.bootstrapImportComplete({
          filesProcessed: res.filesProcessed,
          filesFailed: res.filesFailed,
          totalProposals: res.totalProposals,
        })
        onFinish()
      } catch (err) {
        // runImport itself doesn't throw (per-file errors are
        // caught inside), but be defensive: surface to console
        // and let the user pick again via Stage 1.
        console.error('[bootstrap] runImport failed', err)
        onCancel()
      }
    })()
    // onCancel / onFinish are stable refs from the parent's
    // closure — including them would re-fire on every parent
    // render, which the ref guard already prevents but eslint
    // doesn't know that. Empty deps is correct here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const statusLine = (() => {
    if (result) {
      const noun = result.totalProposals === 1 ? 'proposal' : 'proposals'
      return `Done. ${result.totalProposals} ${noun} queued.`
    }
    if (progress) {
      const noun = progress.proposalsCount === 1 ? 'proposal' : 'proposals'
      return `Reading ${progress.filesDone} / ${progress.filesTotal} files… ${progress.proposalsCount} ${noun} so far.`
    }
    return 'Pick the files to import.'
  })()

  return (
    <>
      <DialogHeader>
        <DialogTitle>Analyzing your notes</DialogTitle>
        <DialogDescription>{statusLine}</DialogDescription>
      </DialogHeader>
      <div className="flex items-center justify-center py-8">
        {result ? null : <Spinner />}
      </div>
    </>
  )
}

// Dev handle so we can verify the dialog renders without wiring it
// into BootGate yet. Removed once B1.c lands (the real entry).
if (import.meta.env.DEV) {
  ;(window as unknown as { BootstrapDialog: typeof BootstrapDialog }).BootstrapDialog = BootstrapDialog
}
