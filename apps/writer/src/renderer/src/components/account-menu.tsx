import { useCallback } from 'react'
import { HugeiconsIcon } from '@hugeicons/react'
import {
  User02Icon,
  Sun03Icon,
  Moon02Icon,
  ComputerDesk01Icon,
} from '@hugeicons/core-free-icons'
import { useTheme } from '@/components/theme-provider'
import { Button } from '@/components/ui/button'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip'
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
} from '@/components/ui/dropdown-menu'

export function AccountMenu(): React.ReactElement {
  const { theme, setTheme } = useTheme()

  const handleSignOut = useCallback(async () => {
    await window.auth.logout()
  }, [])

  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" aria-label="Account menu">
              <Avatar className="size-7">
                <AvatarFallback>
                  <HugeiconsIcon icon={User02Icon} className="size-4" strokeWidth={2} />
                </AvatarFallback>
              </Avatar>
            </Button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent>Connected to Claude</TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="end">
        <DropdownMenuLabel>Connected to Claude</DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuLabel>Theme</DropdownMenuLabel>
        <DropdownMenuRadioGroup
          value={theme}
          onValueChange={(v) => setTheme(v as 'light' | 'dark' | 'system')}
        >
          <DropdownMenuRadioItem value="light">
            <HugeiconsIcon icon={Sun03Icon} strokeWidth={2} />
            Light
          </DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="dark">
            <HugeiconsIcon icon={Moon02Icon} strokeWidth={2} />
            Dark
          </DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="system">
            <HugeiconsIcon icon={ComputerDesk01Icon} strokeWidth={2} />
            System
          </DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={handleSignOut}>Sign out</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
