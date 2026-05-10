import { useEffect, useRef } from 'react'

export function useDebouncedText(
  text: string | null,
  delay: number,
  callback: (text: string) => void
): void {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const callbackRef = useRef(callback)
  callbackRef.current = callback

  useEffect(() => {
    if (text == null) return
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => {
      callbackRef.current(text)
    }, delay)
    return () => {
      if (timer.current) clearTimeout(timer.current)
    }
  }, [text, delay])
}
