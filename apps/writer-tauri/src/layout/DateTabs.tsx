// Date-axis sidebar container. Replaces the week-grouped DocList
// with three explicit modes that match how the user thinks about
// time in this product:
//   • Day   — capture mode. Today's daily + its child notes.
//   • Week  — recent review. Sliding 7 days from today, scannable.
//   • Month — far review. Calendar grid with entry markers.
//
// Tab choice is runtime-only (docsStore.sidebarTab). Each launch
// resets to Day so the app reads as "you're here, now" on open;
// users who want a different default can land on Week/Month and
// it'll stick for the session.
//
// Views are kept in their own files so this container stays a
// thin shell — one place to look for the IA, three places to
// look for view internals.

import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { useDocsStore } from '@/state/docsStore'
import { DayView } from './views/DayView'
import { WeekView } from './views/WeekView'

export function DateTabs() {
  const tab = useDocsStore((s) => s.sidebarTab)
  const setTab = useDocsStore((s) => s.setSidebarTab)

  return (
    <Tabs
      value={tab}
      onValueChange={(v) => setTab(v as 'day' | 'week' | 'month')}
      className="px-2 pt-1"
    >
      <TabsList className="grid w-full grid-cols-3 h-7 rounded-md p-0.5">
        <TabsTrigger
          value="day"
          className="h-full rounded-sm text-[12px] font-medium"
        >
          Day
        </TabsTrigger>
        <TabsTrigger
          value="week"
          className="h-full rounded-sm text-[12px] font-medium"
        >
          Week
        </TabsTrigger>
        <TabsTrigger
          value="month"
          className="h-full rounded-sm text-[12px] font-medium"
        >
          Month
        </TabsTrigger>
      </TabsList>

      <TabsContent value="day" className="pt-2">
        <DayView />
      </TabsContent>
      <TabsContent value="week" className="pt-2">
        <WeekView />
      </TabsContent>
      <TabsContent value="month" className="pt-2">
        <ViewPlaceholder label="Month view" />
      </TabsContent>
    </Tabs>
  )
}

function ViewPlaceholder({ label }: { label: string }) {
  return (
    <div className="px-2 py-6 text-center text-[12px] text-muted-foreground/60">
      {label}
    </div>
  )
}
