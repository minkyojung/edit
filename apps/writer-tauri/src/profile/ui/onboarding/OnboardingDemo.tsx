// Auto-playing product demo shown in the onboarding right panel. It replays one
// story on a loop, rendered to look like the REAL editor — an inline suggestion
// with the old text struck through (red) and the new text highlighted (green),
// the same marks the CodeMirror proof-review uses (see editor/cmInBufferReview.ts):
//
//   request → think (line by line) → inline red/green suggestion → Keep → applied → (loop)
//
// ─────────────────────────────────────────────────────────────────────────────
// EDIT THIS PER RELEASE. Each launch targets a different audience; just rewrite
// SCRIPT below to retell the story in their language. Nothing else needs to
// change — the beats/animation are content-agnostic.
// ─────────────────────────────────────────────────────────────────────────────

import { useEffect, useState } from 'react'
import { IconCheck, IconPencil, IconSearch, IconFileText, IconQuote } from '@tabler/icons-react'
import { InlineCard } from '@/chat/ui/InlineCard'
import { ActivityRow } from '@/chat/parts/ActivityRow'
import { ProcessGroup } from '@/chat/parts/ProcessGroup'
import { cn } from '@/lib/utils'
import { SuggestionSwap, type SwapState } from '@/profile/ui/onboarding/SuggestionSwap'

const SCRIPT = {
  // What the user asks for (typed out in beat 1).
  request: 'Have I written about solitude before?',
  // The librarian's reasoning, revealed one line at a time (beat 2). Each line
  // carries its own icon (search → find → quote).
  thinking: [
    { icon: IconSearch, text: 'Searching 1,240 notes for “solitude”…' },
    { icon: IconFileText, text: 'Found it in Quiet Mornings (2021)' },
    { icon: IconQuote, text: 'Your own phrasing fits here' },
  ],
  // Folded-turn summary (shown once the thinking settles).
  summary: 'Searched 1,240 notes → Quiet Mornings',
  // The note being edited (beats 3–5).
  file: 'essays/solitude.md',
  // Caption under the diff — how the AI describes the edit.
  caption: 'Rewrote the opening in your own words, from Quiet Mornings (2021).',
  // The edit as a line diff. `prefix` is unchanged (stays plain); only the tail
  // swaps: `before` (old, red) → `after` (new, green — from the user's own past
  // essay).
  prefix: 'Solitude ',
  before: 'is just being by yourself.',
  after: 'has a texture I keep returning to — as I wrote in Quiet Mornings, less absence than attention.',
}

type Beat = 'request' | 'thinking' | 'propose' | 'accept' | 'done'
const BEATS: { beat: Beat; ms: number }[] = [
  { beat: 'request', ms: 1500 },
  { beat: 'thinking', ms: 2800 },
  { beat: 'propose', ms: 2800 },
  { beat: 'accept', ms: 1600 },
  { beat: 'done', ms: 2400 },
]
const THINK_LINE_MS = 650

export function OnboardingDemo() {
  const [i, setI] = useState(0)
  useEffect(() => {
    const t = setTimeout(() => setI((n) => (n + 1) % BEATS.length), BEATS[i].ms)
    return () => clearTimeout(t)
  }, [i])
  const beat = BEATS[i].beat
  const suggesting = beat === 'propose' || beat === 'accept'
  const swapState: SwapState =
    beat === 'propose' ? 'proposed' : beat === 'accept' ? 'accepted' : 'done'

  // Reveal the thinking lines one at a time while the 'thinking' beat is on.
  const [revealed, setRevealed] = useState(0)
  useEffect(() => {
    if (beat !== 'thinking') {
      setRevealed(0)
      return
    }
    setRevealed(1)
    const id = setInterval(
      () => setRevealed((r) => Math.min(r + 1, SCRIPT.thinking.length)),
      THINK_LINE_MS,
    )
    return () => clearInterval(id)
  }, [beat])

  // Reserve the fully-expanded height (min-h) and centre THAT block, so the
  // content builds top-down and lands centred once everything is shown — instead
  // of the whole thing growing out from the middle each beat.
  return (
    <div className="flex h-full w-full items-center justify-center px-6">
      <div className="w-full max-w-[300px] min-h-[280px] space-y-5">
        {/* Request bubble — appears first, stays for the rest of the loop. */}
        <div
          className={cn(
            'ml-auto w-fit max-w-full rounded-2xl rounded-br-md bg-primary px-3 py-2 text-footnote text-primary-foreground transition-opacity duration-500',
            beat === 'request' ? 'opacity-100' : 'opacity-90',
          )}
        >
          {SCRIPT.request}
        </div>

        {/* Process — the librarian's reasoning. Streams open (one row at a time)
            during 'thinking', then folds into a summary dropdown once the answer
            begins, exactly like a settled assistant turn. */}
        {beat !== 'request' && (
          <ProcessGroup summary={SCRIPT.summary} isStreaming={beat === 'thinking'}>
            {(beat === 'thinking' ? SCRIPT.thinking.slice(0, revealed) : SCRIPT.thinking).map((t) => (
              <div
                key={t.text}
                className="duration-300 animate-in fade-in-0 slide-in-from-bottom-1"
              >
                <ActivityRow icon={<t.icon size={15} stroke={1.75} />} label={t.text} />
              </div>
            ))}
          </ProcessGroup>
        )}

        {/* Editor with the inline suggestion (red strike → green insert), then
            applied — same note surface throughout so it reads as one edit. The
            Keep/Reject actions sit OUTSIDE the note, below it. */}
        {(suggesting || beat === 'done') && (
          <div className="space-y-3 duration-500 animate-in fade-in-0">
            <InlineCard className="text-footnote">
              <div className="flex items-center gap-1.5 border-b border-border px-3 py-2 text-muted-foreground">
                {beat === 'done' ? (
                  <IconCheck size={13} className="text-emerald-500" />
                ) : (
                  <IconPencil size={13} />
                )}
                <span className="truncate font-mono text-caption">{SCRIPT.file}</span>
              </div>
              <p className="px-3 py-2.5 leading-relaxed text-foreground">
                <SuggestionSwap
                  state={swapState}
                  prefix={SCRIPT.prefix}
                  before={SCRIPT.before}
                  after={SCRIPT.after}
                />
              </p>
            </InlineCard>

            {/* The assistant's written answer — prose OUTSIDE the tool card, the
                way the SDK streams model output alongside tool results. */}
            <p className="text-[15px] leading-relaxed text-foreground">{SCRIPT.caption}</p>
          </div>
        )}
      </div>
    </div>
  )
}
