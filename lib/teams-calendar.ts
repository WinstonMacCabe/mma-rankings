// Types and pure helpers for the secret /calendar2 page — a calendar of the
// followed teams' fixtures. Kept separate from lib/calendar.ts, which is tuned
// for fight cards (surname merging, matchups, confidence) and is mirrored
// byte-for-byte into the boxing repo; fixtures need none of that.

/** The site renders every kickoff in Atlantic time, so it must be named here. */
export const ATLANTIC_TZ = 'America/Halifax'

export interface TeamFixture {
  id: string
  /** 'YYYY-MM-DD' in Atlantic time — the day the fixture falls on for the viewer. */
  date: string
  /** ISO UTC kickoff, or null when only the day is known (e.g. a TBD time). */
  kickoff: string | null
  home: string
  away: string
  homeShort: string
  awayShort: string
  competition: string
  venue: string | null
  /** Keys from followed-teams.ts for any followed side involved. */
  teamKeys: string[]
  /** Which followed keys are on which side, so labels can say vs/at. */
  homeKeys: string[]
  awayKeys: string[]
  source: string
}

export interface TeamStatus {
  key: string
  name: string
  short: string
  label: string
  /** Fixtures found for this team inside the window. */
  count: number
  /** Whether every source for this team answered. */
  ok: boolean
  note?: string
}

export interface TeamsCalendarFile {
  generatedAt: string
  windowDays: number
  teams: TeamStatus[]
  fixtures: TeamFixture[]
}

export interface FixtureMonth {
  key: string
  label: string
  count: number
}

export interface FixtureDay {
  date: string
  day: number
  inMonth: boolean
  isToday: boolean
  fixtures: TeamFixture[]
}

export function monthKeyOf(date: string): string {
  return date.slice(0, 7)
}

export function monthLabel(key: string): string {
  const [y, m] = key.split('-').map(Number)
  if (!y || !m) return key
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString('en-US', {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  })
}

/** What the viewer sees on a card, e.g. "Man City vs Ipswich" / "Blue Jays at Yankees". */
export function fixtureLabel(fixture: TeamFixture, shortByKey: Record<string, string>): string {
  const key = fixture.teamKeys[0]
  const followed = key ? shortByKey[key] : undefined
  if (!followed) return `${fixture.awayShort} at ${fixture.homeShort}`
  return fixture.homeKeys.includes(key)
    ? `${followed} vs ${fixture.awayShort}`
    : `${followed} at ${fixture.homeShort}`
}

export function summariseFixtureMonths(fixtures: TeamFixture[]): FixtureMonth[] {
  const counts = new Map<string, number>()
  for (const f of fixtures) {
    const k = monthKeyOf(f.date)
    counts.set(k, (counts.get(k) ?? 0) + 1)
  }
  return [...counts.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([key, count]) => ({ key, label: monthLabel(key), count }))
}

/** 6x7 grid of day cells covering a month. */
export function buildFixtureGrid(fixtures: TeamFixture[], year: number, month: number): FixtureDay[] {
  const byDate = new Map<string, TeamFixture[]>()
  for (const f of fixtures) {
    const list = byDate.get(f.date)
    if (list) list.push(f)
    else byDate.set(f.date, [f])
  }

  const firstWeekday = new Date(Date.UTC(year, month - 1, 1)).getUTCDay()
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate()
  const daysInPrevMonth = new Date(Date.UTC(year, month - 1, 0)).getUTCDate()
  const today = new Date().toISOString().slice(0, 10)

  const cells: FixtureDay[] = []
  for (let i = 0; i < 42; i++) {
    let y = year
    let m = month
    let d = i - firstWeekday + 1
    if (d < 1) {
      m = month - 1
      if (m < 1) { m = 12; y-- }
      d = daysInPrevMonth + d
    } else if (d > daysInMonth) {
      m = month + 1
      if (m > 12) { m = 1; y++ }
      d = d - daysInMonth
    }
    const date = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`
    cells.push({
      date,
      day: d,
      inMonth: m === month && y === year,
      isToday: date === today,
      fixtures: byDate.get(date) ?? [],
    })
  }
  return cells
}

/** "7:45 PM ADT" in Atlantic time, or null when the kickoff time is unknown. */
export function formatKickoff(iso: string | null): string | null {
  if (!iso) return null
  return new Date(iso).toLocaleTimeString('en-US', {
    timeZone: ATLANTIC_TZ,
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
  })
}

export function formatDay(date: string): string {
  const [y, m, d] = date.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  })
}
