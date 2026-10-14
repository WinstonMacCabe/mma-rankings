import type { Metadata } from 'next'
import CalendarView2 from './CalendarView2'

// A private page: reachable by URL but never linked, and kept out of search.
export const metadata: Metadata = {
  title: 'Team Calendar',
  description: 'Upcoming games for the followed teams.',
  robots: { index: false, follow: false, nocache: true },
}

export default function Calendar2Page() {
  return <CalendarView2 />
}
