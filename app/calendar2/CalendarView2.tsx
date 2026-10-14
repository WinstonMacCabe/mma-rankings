'use client'

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import {
  buildFixtureGrid,
  fixtureLabel,
  formatDay,
  formatKickoff,
  monthLabel,
  summariseFixtureMonths,
  type TeamFixture,
  type TeamsCalendarFile,
} from '@/lib/teams-calendar'

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

function monthKey(year: number, month: number) {
  return `${year}-${String(month).padStart(2, '0')}`
}

function shiftMonth(year: number, month: number, delta: number) {
  const d = new Date(Date.UTC(year, month - 1 + delta, 1))
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1 }
}

function Tag({ children }: { children: React.ReactNode }) {
  return <span className="text-[10px] uppercase tracking-[0.1em] text-black/50">{children}</span>
}

function FixtureLine({ label, kickoff }: { label: string; kickoff: string | null }) {
  return (
    <>
      <div className="truncate text-[9px] font-semibold leading-tight sm:text-[10px]">{label}</div>
      {kickoff && <div className="hidden truncate text-[9px] text-black/45 sm:block">{kickoff}</div>}
    </>
  )
}

export default function CalendarView2() {
  const [data, setData] = useState<TeamsCalendarFile | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [cursor, setCursor] = useState<{ year: number; month: number } | null>(null)
  const [selected, setSelected] = useState<TeamFixture | null>(null)
  const [openDayKey, setOpenDayKey] = useState<string | null>(null)
  // Teams switched off in the filter. Stored as hidden (rather than shown) so a
  // newly added team defaults to visible without touching this state.
  const [hidden, setHidden] = useState<Set<string>>(new Set())

  useEffect(() => {
    fetch('/api/calendar2')
      .then(r => r.json())
      .then((payload: TeamsCalendarFile) => {
        setData(payload)
        setLoading(false)
      })
      .catch(() => {
        setError('Failed to load the calendar')
        setLoading(false)
      })
  }, [])

  const shortByKey = useMemo(() => {
    const map: Record<string, string> = {}
    for (const team of data?.teams ?? []) map[team.key] = team.short
    return map
  }, [data])

  const fixtures = useMemo(() => {
    const all = data?.fixtures ?? []
    if (hidden.size === 0) return all
    return all.filter(f => f.teamKeys.some(k => !hidden.has(k)))
  }, [data, hidden])

  const months = useMemo(() => summariseFixtureMonths(fixtures), [fixtures])

  const active = useMemo(() => {
    if (cursor) return cursor
    const first = months[0]?.key
    if (first) {
      const [y, m] = first.split('-').map(Number)
      return { year: y, month: m }
    }
    const now = new Date()
    return { year: now.getFullYear(), month: now.getMonth() + 1 }
  }, [cursor, months])

  const grid = useMemo(
    () => (data ? buildFixtureGrid(fixtures, active.year, active.month) : []),
    [data, fixtures, active]
  )
  const inMonth = useMemo(() => grid.filter(c => c.inMonth), [grid])
  const monthCount = useMemo(() => inMonth.reduce((n, c) => n + c.fixtures.length, 0), [inMonth])
  const openDay = useMemo(
    () => (openDayKey ? grid.find(c => c.date === openDayKey) ?? null : null),
    [grid, openDayKey]
  )
  const key = monthKey(active.year, active.month)

  const teams = data?.teams ?? []
  const online = teams.filter(t => t.ok).length

  function toggleTeam(teamKey: string) {
    setHidden(prev => {
      const next = new Set(prev)
      if (next.has(teamKey)) next.delete(teamKey)
      else next.add(teamKey)
      return next
    })
  }

  return (
    <div className="min-h-screen bg-white text-[#1d1d1f]">
      <header className="sticky top-0 z-20 border-b border-black/10 bg-white/80 backdrop-blur-xl">
        <div className="relative mx-auto flex min-h-16 max-w-7xl flex-wrap items-center justify-between gap-x-3 gap-y-1 px-4 py-2 sm:h-16 sm:flex-nowrap sm:py-0">
          <nav className="flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1 sm:gap-3">
            <a href="https://boxingpugilism.vercel.app" target="_blank" rel="noopener noreferrer" className="text-[13px] uppercase tracking-[0.05em] text-black/40 transition-colors hover:text-[#1d1d1f] sm:text-[17px]">Boxing</a>
            <a href="https://mmapugilism.vercel.app" target="_blank" rel="noopener noreferrer" className="text-[13px] uppercase tracking-[0.05em] text-black/40 transition-colors hover:text-[#1d1d1f] sm:text-[17px]">MMA</a>
            <a href="https://generalspugilism.vercel.app" target="_blank" rel="noopener noreferrer" className="text-[13px] uppercase tracking-[0.05em] text-black/40 transition-colors hover:text-[#1d1d1f] sm:text-[17px]">Generals</a>
          </nav>
          <div className="pointer-events-none absolute left-1/2 hidden -translate-x-1/2 text-[30px] font-bold uppercase tracking-[0.08em] text-[#1d1d1f] sm:block">
            Winston&apos;s Rankings
          </div>
          <Link href="/" className="shrink-0 rounded-sm border border-black/80 px-2.5 py-1.5 text-[13px] uppercase tracking-[0.05em] transition-colors hover:bg-black hover:text-white sm:px-3.5 sm:py-2 sm:text-[17px]">
            Rankings
          </Link>
        </div>
      </header>

      <main className="mx-auto max-w-7xl px-4 py-8">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 className="text-[34px] font-bold uppercase leading-none tracking-[0.04em]">Team Calendar</h1>
            <p className="mt-2 text-[13px] text-black/50">
              Upcoming games for the followed teams.
              {data && (
                <>
                  {' '}
                  <span className="text-black/70">
                    {fixtures.length} fixture{fixtures.length === 1 ? '' : 's'}
                  </span>
                  {' '}
                  over the next {data.windowDays} days.
                </>
              )}
            </p>
          </div>

          <div className="flex w-full items-center gap-2 sm:w-auto">
            <button
              onClick={() => setCursor(shiftMonth(active.year, active.month, -1))}
              aria-label="Previous month"
              className="flex h-10 w-10 items-center justify-center rounded-sm border border-black/80 transition-colors hover:bg-black hover:text-white"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M15 18l-6-6 6-6" /></svg>
            </button>
            <div className="min-w-0 flex-1 text-center text-[16px] font-bold uppercase tracking-[0.04em] sm:min-w-[190px] sm:flex-none sm:text-[20px] sm:tracking-[0.06em]">
              {data ? monthLabel(key) : '—'}
            </div>
            <button
              onClick={() => setCursor(shiftMonth(active.year, active.month, 1))}
              aria-label="Next month"
              className="flex h-10 w-10 items-center justify-center rounded-sm border border-black/80 transition-colors hover:bg-black hover:text-white"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M9 18l6-6-6-6" /></svg>
            </button>
            <button
              onClick={() => {
                const now = new Date()
                setCursor({ year: now.getFullYear(), month: now.getMonth() + 1 })
                setSelected(null)
              }}
              className="rounded-sm border border-black/40 px-3 py-2 text-[13px] uppercase tracking-[0.08em] text-black/60 transition-colors hover:border-black hover:text-black"
            >
              Today
            </button>
          </div>
        </div>

        {fixtures.length > 0 && (
          <div className="mt-5 flex flex-wrap gap-1.5">
            {fixtures.length !== (data?.fixtures.length ?? 0) && (
              <button
                onClick={() => setHidden(new Set())}
                className="rounded-sm border border-black/20 px-2.5 py-1 text-[11px] uppercase tracking-[0.08em] text-black/55 transition-colors hover:border-black hover:text-black"
              >
                All teams
              </button>
            )}
            {teams.map(team => {
              const off = hidden.has(team.key)
              return (
                <button
                  key={team.key}
                  onClick={() => toggleTeam(team.key)}
                  title={team.note ?? team.name}
                  className={`rounded-sm border px-2.5 py-1 text-[11px] uppercase tracking-[0.08em] transition-colors ${
                    off
                      ? 'border-black/15 text-black/30 line-through'
                      : 'border-black/40 text-black/75 hover:border-black hover:text-black'
                  }`}
                >
                  {team.short} <span className="opacity-60">{team.count}</span>
                </button>
              )
            })}
          </div>
        )}

        {data && months.length > 0 && (
          <div className="mt-3 flex flex-wrap gap-1.5">
            {months.map(m => {
              const [y, mo] = m.key.split('-').map(Number)
              const isActive = m.key === key
              return (
                <button
                  key={m.key}
                  onClick={() => { setCursor({ year: y, month: mo }); setSelected(null) }}
                  className={`rounded-sm border px-2.5 py-1 text-[11px] uppercase tracking-[0.08em] transition-colors ${
                    isActive ? 'border-black bg-black text-white' : 'border-black/20 text-black/55 hover:border-black hover:text-black'
                  }`}
                >
                  {m.label} <span className="opacity-60">{m.count}</span>
                </button>
              )
            })}
          </div>
        )}

        {loading && <p className="mt-10 text-[13px] uppercase tracking-[0.1em] text-black/40">Loading calendar…</p>}
        {error && <p className="mt-10 text-[13px] text-red-700">{error}</p>}

        {!loading && !error && data && (
          <>
            <div className="mt-5 border border-black/15">
              <div className="grid grid-cols-7 border-b border-black/15 bg-black/[0.03]">
                {WEEKDAYS.map(d => (
                  <div key={d} className="px-0.5 py-2 text-center text-[10px] uppercase tracking-[0.04em] text-black/45 sm:px-2 sm:text-[11px] sm:tracking-[0.12em]">
                    {d}
                  </div>
                ))}
              </div>
              <div className="grid grid-cols-7">
                {grid.map(cell => (
                  <div
                    key={cell.date}
                    role="button"
                    tabIndex={0}
                    aria-expanded={openDayKey === cell.date}
                    aria-label={`${formatDay(cell.date)}, ${cell.fixtures.length} fixture${cell.fixtures.length === 1 ? '' : 's'}`}
                    onClick={() => setOpenDayKey(prev => (prev === cell.date ? null : cell.date))}
                    onKeyDown={e => {
                      if (e.key !== 'Enter' && e.key !== ' ') return
                      e.preventDefault()
                      setOpenDayKey(cell.date)
                    }}
                    className={`min-h-[62px] cursor-pointer border-b border-r border-black/10 p-1 transition-colors hover:bg-black/[0.04] focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-black/50 sm:min-h-[104px] sm:p-1.5 ${
                      cell.inMonth ? 'bg-white' : 'bg-black/[0.02]'
                    } ${openDayKey === cell.date ? 'bg-black/[0.05] ring-1 ring-inset ring-black/40' : ''}`}
                  >
                    <div className="flex items-center justify-between">
                      <span
                        className={`text-[12px] tabular-nums ${
                          cell.isToday
                            ? 'flex h-[21px] w-[21px] items-center justify-center rounded-full bg-black font-semibold text-white'
                            : cell.inMonth
                              ? 'text-black/70'
                              : 'text-black/25'
                        }`}
                      >
                        {cell.day}
                      </span>
                      {cell.fixtures.length > 0 && (
                        <span className="text-[10px] font-semibold tabular-nums text-black/30">{cell.fixtures.length}</span>
                      )}
                    </div>
                    <div className="mt-1 space-y-1 overflow-hidden">
                      {cell.fixtures.map(f => (
                        <button
                          key={f.id}
                          onClick={ev => {
                            ev.stopPropagation()
                            setSelected(f)
                          }}
                          className="block w-full rounded-sm border border-black/15 bg-white px-1 py-0.5 text-left transition-colors hover:border-black sm:px-1.5 sm:py-1"
                        >
                          <FixtureLine label={fixtureLabel(f, shortByKey)} kickoff={formatKickoff(f.kickoff)} />
                        </button>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {openDay && (
              <div className="mt-4 border border-black/25 p-4">
                <div className="flex flex-wrap items-center gap-2">
                  <h2 className="text-[12px] font-semibold uppercase tracking-[0.12em] text-black/50">
                    {formatDay(openDay.date)} — {openDay.fixtures.length} fixture
                    {openDay.fixtures.length === 1 ? '' : 's'}
                  </h2>
                  <button
                    onClick={() => setOpenDayKey(null)}
                    className="ml-auto text-[11px] uppercase tracking-[0.12em] text-black/40 hover:text-black"
                  >
                    Close day
                  </button>
                </div>
                {openDay.fixtures.length === 0 ? (
                  <p className="mt-3 text-[13px] text-black/45">Nothing scheduled on this day.</p>
                ) : (
                  <ul className="mt-3 space-y-1.5">
                    {openDay.fixtures.map(f => (
                      <li key={f.id}>
                        <button
                          onClick={() => setSelected(f)}
                          className="flex w-full items-start gap-3 rounded-sm border border-black/10 px-2.5 py-2 text-left transition-colors hover:border-black"
                        >
                          <span className="min-w-0 flex-1">
                            <span className="block text-[13px] font-semibold">{fixtureLabel(f, shortByKey)}</span>
                            <span className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5">
                              <Tag>{f.competition}</Tag>
                              {f.venue && <span className="text-[11px] text-black/45">{f.venue}</span>}
                            </span>
                          </span>
                          <span className="shrink-0 text-right text-[12px] tabular-nums text-black/60">
                            {formatKickoff(f.kickoff) ?? 'TBD'}
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}

            {selected && (
              <div className="mt-4 border border-black/80 p-5">
                <div className="flex flex-wrap items-center gap-2">
                  <Tag>{selected.competition}</Tag>
                  <span className="text-black/20">·</span>
                  <span className="text-[11px] uppercase tracking-[0.12em] text-black/50">{selected.source}</span>
                  <button
                    onClick={() => setSelected(null)}
                    className="ml-auto text-[11px] uppercase tracking-[0.12em] text-black/40 hover:text-black"
                  >
                    Close
                  </button>
                </div>
                <h3 className="mt-2 text-[22px] font-bold leading-tight">
                  {selected.away} at {selected.home}
                </h3>
                <p className="mt-2 text-[14px] text-black/70">
                  {formatDay(selected.date)}
                  {formatKickoff(selected.kickoff) ? `, ${formatKickoff(selected.kickoff)}` : ' (time TBD)'}
                  {selected.venue ? ` · ${selected.venue}` : ''}
                </p>
                {selected.teamKeys.length > 0 && (
                  <div className="mt-4 border-t border-black/10 pt-3">
                    <h4 className="text-[11px] uppercase tracking-[0.12em] text-black/45">Followed side</h4>
                    <ul className="mt-2 flex flex-wrap gap-1.5">
                      {selected.teamKeys.map(k => (
                        <li key={k} className="rounded-sm border border-black/20 px-2 py-0.5 text-[12px]">
                          {shortByKey[k] ?? k}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            )}

            <div className="mt-6 flex flex-wrap items-center gap-x-5 gap-y-2 text-[11px] uppercase tracking-[0.1em] text-black/45">
              <span className="text-black/60">{monthCount} in {monthLabel(key)}</span>
              <span className="ml-auto">
                Feeds {online}/{teams.length} online
                {online < teams.length && ' — some teams have no fixture feed'}
              </span>
            </div>
          </>
        )}

        {!loading && !error && data && data.fixtures.length === 0 && (
          <p className="mt-10 text-[13px] text-black/50">No upcoming fixtures found.</p>
        )}
      </main>
    </div>
  )
}
