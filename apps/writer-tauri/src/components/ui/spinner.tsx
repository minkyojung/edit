import { cn } from "@/lib/utils"
import { IconLoader2 } from "@tabler/icons-react"

function Spinner({ className }: { className?: string }) {
  return (
    <IconLoader2 size={16} stroke={2} role="status" aria-label="Loading" className={cn("animate-spin", className)} />
  )
}

export { Spinner }
