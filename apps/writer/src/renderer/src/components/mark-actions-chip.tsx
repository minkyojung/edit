import React, { useEffect, useState } from 'react'
import { HugeiconsIcon } from '@hugeicons/react'
import { Tick02Icon, Cancel01Icon } from '@hugeicons/core-free-icons'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip'
import { acceptAllMarks, rejectAllMarks, subscribeMarkCount } from '../markPlugin'

const isMac =
  typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform)
const cmd = isMac ? '⌘' : 'Ctrl'

export function MarkActionsChip(): React.ReactElement | null {
  const [count, setCount] = useState(0)

  useEffect(() => subscribeMarkCount(setCount), [])

  if (count === 0) return null

  return (
    <div className="flex items-center gap-1 rounded-full border border-border bg-background/80 pl-3 pr-1 py-0.5 font-sans text-xs text-muted-foreground shadow-sm backdrop-blur">
      <span>
        <span className="font-medium text-foreground">{count}</span>개 제안
      </span>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className="size-6 rounded-full"
            onClick={() => acceptAllMarks()}
            aria-label="모두 수락"
          >
            <HugeiconsIcon icon={Tick02Icon} className="size-3.5" strokeWidth={2.5} />
          </Button>
        </TooltipTrigger>
        <TooltipContent>모두 수락 ({`⇧${cmd}A`})</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className="size-6 rounded-full"
            onClick={() => rejectAllMarks()}
            aria-label="모두 거절"
          >
            <HugeiconsIcon icon={Cancel01Icon} className="size-3.5" strokeWidth={2.5} />
          </Button>
        </TooltipTrigger>
        <TooltipContent>모두 거절 ({`⇧${cmd}R`})</TooltipContent>
      </Tooltip>
    </div>
  )
}
