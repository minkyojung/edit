// Onboarding step — You're all set (completion).
//
// The payoff moment: the folder is chosen, so this celebrates and hands off to
// the editor. A single centred column (not the 2-column "sell" layout) with a
// confetti burst, an animated check, and the vault name so the loop closes
// ("it worked, here's your vault"). Pure view — the launcher opens the project
// window on "Open Octave"; the /onboard preview renders it with a no-op.

import { useEffect } from 'react'
import confetti from 'canvas-confetti'
import { motion } from 'motion/react'
import { IconCheck } from '@tabler/icons-react'
import { Button } from '@/components/ui/button'

interface Props {
  onEnter: () => void
  /** The chosen vault's display name, shown to confirm the setup. */
  vaultName?: string
  /** Disable the action while the project window is opening — prevents a
   * double-click from spawning two windows across the async gap. */
  busy?: boolean
  /** Set when the previous open attempt failed, so the user can retry
   * instead of being stranded with a button that silently did nothing. */
  error?: string | null
}

const container = { show: { transition: { staggerChildren: 0.08, delayChildren: 0.05 } } }
const item = { hidden: { y: 8, opacity: 0 }, show: { y: 0, opacity: 1 } }

export function DonePanel({ onEnter, vaultName, busy, error }: Props) {
  // One tasteful burst on arrival. Respects reduced-motion.
  useEffect(() => {
    const t = setTimeout(() => {
      confetti({
        particleCount: 90,
        spread: 72,
        startVelocity: 38,
        origin: { y: 0.62 },
        scalar: 0.9,
        disableForReducedMotion: true,
      })
    }, 150)
    return () => clearTimeout(t)
  }, [])

  return (
    <div className="flex h-full w-full items-center justify-center bg-background px-8">
      <motion.div
        className="w-full max-w-[420px] text-center"
        initial="hidden"
        animate="show"
        variants={container}
      >
        <motion.div
          variants={{ hidden: { scale: 0.5, opacity: 0 }, show: { scale: 1, opacity: 1 } }}
          transition={{ type: 'spring', stiffness: 360, damping: 18 }}
          className="mx-auto mb-6 flex size-16 items-center justify-center rounded-full bg-emerald-500/15 text-emerald-500"
        >
          <IconCheck size={32} stroke={2.5} />
        </motion.div>

        <motion.h1
          variants={item}
          className="mb-3 text-3xl font-bold leading-tight tracking-tight text-foreground"
        >
          You&apos;re all set.
        </motion.h1>

        <motion.p variants={item} className="mb-8 text-body leading-relaxed text-muted-foreground">
          {vaultName ? (
            <>
              Your vault{' '}
              <span className="font-medium text-foreground">{vaultName}</span> is
              ready — a welcome note is waiting inside.
            </>
          ) : (
            <>Your vault is ready — a welcome note is waiting inside.</>
          )}
        </motion.p>

        <motion.div variants={item}>
          <Button className="h-12 w-full rounded-xl" onClick={onEnter} disabled={busy}>
            {busy ? 'Opening…' : 'Open Octave'}
          </Button>
          {error && <p className="mt-3 text-footnote text-destructive">{error}</p>}
        </motion.div>
      </motion.div>
    </div>
  )
}
