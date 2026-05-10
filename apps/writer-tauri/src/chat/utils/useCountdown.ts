import { useEffect, useState } from 'react'

/** Re-renders once per second while a target ms-epoch is in the future,
 * returning seconds remaining (rounded up). Returns 0 once the target
 * passes (or when no target is set), and tears down its interval as
 * soon as the countdown reaches zero so we're not heating CPU forever
 * on a settled error card. */
export function useCountdown(targetMs: number | undefined): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (typeof targetMs !== 'number') return
    if (targetMs <= Date.now()) return
    const id = window.setInterval(() => {
      const t = Date.now()
      setNow(t)
      if (t >= targetMs) window.clearInterval(id)
    }, 1000)
    return () => window.clearInterval(id)
  }, [targetMs])
  if (typeof targetMs !== 'number') return 0
  return Math.max(0, Math.ceil((targetMs - now) / 1000))
}
