// Builds public/data/teams-calendar.json — the fixture list behind the secret
// /calendar2 page. Run by the nightly workflow (`npm run update-teams-calendar`)
// and committed alongside the rankings data so the deployed page always has a
// freshly baked file to serve.
//
// Sources, and why each is what it is:
//   * ESPN             — ten of the teams. The American leagues (NFL/NBA/NHL/
//                        NCAAF) come from the site API's team-schedule
//                        endpoint, which returns a whole season in one request.
//                        Soccer and rugby instead use the core API
//                        (`sports.core.api.espn.com`), whose per-team season
//                        events endpoint accepts a date range and so returns
//                        just the window (one request per competition, plus one
//                        per event for its detail). The old approach — scanning
//                        the site scoreboard one day at a time — meant ~990
//                        requests a night and got the caller's IP blocked by
//                        ESPN's edge, so it is gone. The core API is also the
//                        fallback for the American leagues if the site API
//                        refuses a request.
//   * statsapi.mlb.com — the Blue Jays, from MLB's own schedule API.
//   * goarmywestpoint  — Army rugby, whose Sidearm/Nuxt page embeds the whole
//                        schedule as devalue-flattened data in __NUXT_DATA__.
//   * Super League and the IPL have no free, reliable fixture feed: the official
//                        sites render client-side (and Super League's week
//                        navigation ignores the query string), BBC/Sky do not
//                        list future fixtures, SofaScore returns 403 and the
//                        TheSportsDB free tier returns a single event. Those two
//                        teams are wired as empty sources so the calendar is
//                        honest about it rather than silently omitting them.

/* eslint-disable @typescript-eslint/no-explicit-any -- The ESPN, MLB and
   devalue payloads this script reads are large, undocumented, and partly
   index-flattened; modelling every field would be more noise than signal. */

import * as fs from 'fs/promises'
import * as path from 'path'
import { FOLLOWED_TEAMS, teamMatches, type FollowedTeam, type TeamSource } from '../lib/followed-teams'
import { ATLANTIC_TZ, type TeamFixture, type TeamsCalendarFile, type TeamStatus } from '../lib/teams-calendar'

const OUT_FILE = path.join(process.cwd(), 'public', 'data', 'teams-calendar.json')
const WINDOW_DAYS = Number(process.env.TEAMS_CALENDAR_DAYS) || 90
const CONCURRENCY = Number(process.env.TEAMS_CALENDAR_CONCURRENCY) || 6
// ESPN's edge blocks non-browser user agents with a 403, so this must look like
// a real browser. It is also what the Army athletics site expects.
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

const ARMY_RUGBY_SCHEDULE = 'https://goarmywestpoint.com/sports/mens-rugby/schedule'
const ARMY_RUGBY_TZ = 'America/New_York'

const ESPN_SITE = 'https://site.api.espn.com/apis/site/v2'
const ESPN_CORE = 'https://sports.core.api.espn.com/v2'

// ---------------------------------------------------------------- utilities

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function getJson<T = any>(url: string, tries = 3): Promise<T | null> {
  for (let attempt = 0; attempt < tries; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': UA, Accept: 'application/json' },
        signal: AbortSignal.timeout(15000),
      })
      if (res.status === 429 || res.status >= 500) {
        await sleep(400 * (attempt + 1))
        continue
      }
      if (!res.ok) return null
      return (await res.json()) as T
    } catch {
      await sleep(300 * (attempt + 1))
    }
  }
  return null
}

async function getText(url: string, tries = 3): Promise<string | null> {
  for (let attempt = 0; attempt < tries; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': UA },
        redirect: 'follow',
        signal: AbortSignal.timeout(20000),
      })
      if (res.status === 429 || res.status >= 500) {
        await sleep(400 * (attempt + 1))
        continue
      }
      if (!res.ok) return null
      return await res.text()
    } catch {
      await sleep(300 * (attempt + 1))
    }
  }
  return null
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length)
  let next = 0
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (true) {
      const i = next++
      if (i >= items.length) return
      out[i] = await fn(items[i], i)
    }
  })
  await Promise.all(workers)
  return out
}

// ---------------------------------------------------------------- time zones

function tzDay(iso: string, tz: string): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(iso))
  const m: Record<string, string> = {}
  for (const p of parts) m[p.type] = p.value
  return `${m.year}-${m.month}-${m.day}`
}

function tzOffsetMs(date: Date, tz: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(date)
  const m: Record<string, string> = {}
  for (const p of parts) m[p.type] = p.value
  const asUtc = Date.UTC(+m.year, +m.month - 1, +m.day, +m.hour % 24, +m.minute, +m.second)
  return asUtc - date.getTime()
}

/** A wall-clock time in `tz` -> the matching UTC instant. */
function zonedToUtc(naive: string, tz: string): string {
  const [datePart, timePart = '00:00:00'] = naive.split('T')
  const [y, mo, d] = datePart.split('-').map(Number)
  const [h, mi, s] = timePart.split(':').map(Number)
  const guess = Date.UTC(y, mo - 1, d, h, mi, s || 0)
  return new Date(guess - tzOffsetMs(new Date(guess), tz)).toISOString()
}

function addDays(date: string, n: number): string {
  const [y, m, d] = date.split('-').map(Number)
  const dt = new Date(Date.UTC(y, m - 1, d) + n * 86400000)
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`
}

const TODAY = tzDay(new Date().toISOString(), ATLANTIC_TZ)
const WINDOW_END = addDays(TODAY, WINDOW_DAYS)

// ---------------------------------------------------------------- fixtures

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
}

function espnShort(team: any): string {
  return (
    team?.shortDisplayName ||
    team?.abbreviation ||
    (typeof team?.displayName === 'string' ? team.displayName.split(/\s+/).slice(-1)[0] : '') ||
    team?.displayName ||
    '?'
  )
}

/** Turn one ESPN event (team schedule or league scoreboard) into a fixture. */
function fixtureFromEspn(event: any, competition: string, source: string): TeamFixture | null {
  const kickoff: string | undefined = event?.date
  if (!kickoff) return null
  const comp = event?.competitions?.[0]
  const competitors: any[] = comp?.competitors ?? []
  const home = competitors.find(c => c?.homeAway === 'home')?.team
  const away = competitors.find(c => c?.homeAway === 'away')?.team
  if (!home?.displayName || !away?.displayName) return null

  const homeTeam = FOLLOWED_TEAMS.find(t => teamMatches(home.displayName, t))
  const awayTeam = FOLLOWED_TEAMS.find(t => teamMatches(away.displayName, t))
  const homeKeys = homeTeam ? [homeTeam.key] : []
  const awayKeys = awayTeam ? [awayTeam.key] : []
  const date = tzDay(kickoff, ATLANTIC_TZ)

  return {
    id: `${date}-${slug(home.displayName)}-${slug(away.displayName)}`,
    date,
    kickoff,
    home: home.displayName,
    away: away.displayName,
    homeShort: homeTeam?.short ?? espnShort(home),
    awayShort: awayTeam?.short ?? espnShort(away),
    competition,
    venue: comp?.venue?.fullName ?? event?.venue?.fullName ?? null,
    teamKeys: [...homeKeys, ...awayKeys],
    homeKeys,
    awayKeys,
    source,
  }
}

// ---------------------------------------------------------------- ESPN

type EspnSource = { sport: string; league: string; teamId: string; competition: string }

/**
 * The core API names a fixture "Away at Home" for soccer and the American
 * leagues, but "Home vs Away" for rugby; `shortName` follows the same order with
 * "@" / "VS". Returns null for anything that fits neither shape.
 */
function parseSideNames(name: string, short: string) {
  let home: string
  let away: string
  let homeShort = ''
  let awayShort = ''
  if (name.includes(' at ')) {
    const [a, h] = name.split(' at ')
    away = a.trim()
    home = (h ?? '').trim()
  } else if (/ vs /i.test(name)) {
    const [h, a] = name.split(/ vs /i)
    home = h.trim()
    away = (a ?? '').trim()
  } else {
    return null
  }
  if (short.includes(' @ ')) {
    const [a, h] = short.split(' @ ')
    awayShort = a.trim()
    homeShort = (h ?? '').trim()
  } else if (/ vs /i.test(short)) {
    const [h, a] = short.split(/ vs /i)
    homeShort = h.trim()
    awayShort = (a ?? '').trim()
  }
  if (!home || !away) return null
  return { home, away, homeShort, awayShort }
}

/** Turn one core-API event into a fixture, identifying our side by team id. */
function fixtureFromEspnCore(event: any, competition: string, teamId: string, team: FollowedTeam): TeamFixture | null {
  const kickoff: string | undefined = event?.date
  if (!kickoff) return null
  const comp = event?.competitions?.[0]
  const competitors: any[] = comp?.competitors ?? []
  const homeComp = competitors.find(c => c?.homeAway === 'home')
  const awayComp = competitors.find(c => c?.homeAway === 'away')
  if (!homeComp || !awayComp) return null

  const sides = parseSideNames(String(event.name ?? ''), String(event.shortName ?? ''))
  if (!sides) return null

  let homeIsUs = String(homeComp.id) === String(teamId)
  let awayIsUs = String(awayComp.id) === String(teamId)
  // Ids are the reliable signal; fall back to the roster's name aliases only if
  // neither side matched by id.
  if (!homeIsUs && !awayIsUs) {
    homeIsUs = teamMatches(sides.home, team)
    awayIsUs = teamMatches(sides.away, team)
  }
  if (homeIsUs && awayIsUs) awayIsUs = false
  if (!homeIsUs && !awayIsUs) return null

  const date = tzDay(kickoff, ATLANTIC_TZ)
  return {
    id: `${date}-${slug(sides.home)}-${slug(sides.away)}`,
    date,
    kickoff,
    home: sides.home,
    away: sides.away,
    homeShort: homeIsUs ? team.short : sides.homeShort || sides.home,
    awayShort: awayIsUs ? team.short : sides.awayShort || sides.away,
    competition,
    venue: comp?.venue?.fullName ?? event?.venue?.fullName ?? null,
    teamKeys: [team.key],
    homeKeys: homeIsUs ? [team.key] : [],
    awayKeys: awayIsUs ? [team.key] : [],
    source: 'ESPN',
  }
}

/** Core-API team events for the window — the workhorse for soccer and rugby. */
async function fromEspnCore(src: EspnSource, team: FollowedTeam) {
  const start = TODAY.replace(/-/g, '')
  const end = WINDOW_END.replace(/-/g, '')
  const year = new Date().getUTCFullYear()
  const refs = new Set<string>()
  let listed = false

  // Season labels are inconsistent between sports (soccer labels a season by its
  // starting year, rugby by its ending one), so offer the year either side and
  // let the date range decide which season is actually live.
  for (const season of [year - 1, year, year + 1]) {
    const json = await getJson<any>(
      `${ESPN_CORE}/sports/${src.sport}/leagues/${src.league}/seasons/${season}/teams/${src.teamId}/events?dates=${start}-${end}&limit=100`
    )
    if (!json) continue
    listed = true
    for (const item of json.items ?? []) if (item?.$ref) refs.add(String(item.$ref))
  }

  const pages = await mapLimit([...refs], CONCURRENCY, ref => getJson<any>(ref.replace(/^http:/, 'https:')))
  const detailFailures = pages.filter(page => !page).length

  const fixtures: TeamFixture[] = []
  for (const page of pages) {
    if (!page) continue
    const fixture = fixtureFromEspnCore(page, src.competition, src.teamId, team)
    if (fixture) fixtures.push(fixture)
  }

  // A source with no season list answered is down; a few missed event details
  // are transient and still leave the source usable.
  const ok = listed && detailFailures <= Math.floor(refs.size * 0.1)
  return { fixtures, ok }
}

async function fromEspnTeamSchedule(src: Extract<TeamSource, { kind: 'espn-team' }>, team: FollowedTeam) {
  const json = await getJson<any>(`${ESPN_SITE}/sports/${src.sport}/${src.league}/teams/${src.teamId}/schedule`)
  if (json) {
    const events: any[] = json.events ?? []
    const fixtures = events
      .map(event => fixtureFromEspn(event, src.competition, 'ESPN'))
      .filter((fixture: TeamFixture | null): fixture is TeamFixture => Boolean(fixture))
    // The site API answered and the season's games were recognisable — trust it.
    if (events.length === 0 || fixtures.length > 0) return { fixtures, ok: true }
  }
  // Blocked (ESPN's edge 403s flagged callers) or the shape changed: fall back to
  // the core API, which identifies sides by id and needs no schedule endpoint.
  return fromEspnCore(src, team)
}

async function fromMlbStats(src: Extract<TeamSource, { kind: 'mlb-stats' }>) {
  // One request for the whole league gives us abbreviations for the opponents.
  const teamsJson = await getJson<{ teams?: any[] }>('https://statsapi.mlb.com/api/v1/teams?sportId=1')
  const abbr = new Map<number, string>()
  for (const t of teamsJson?.teams ?? []) abbr.set(t.id, t.abbreviation ?? t.teamName ?? t.name)

  const json = await getJson<any>(
    `https://statsapi.mlb.com/api/v1/schedule?sportId=1&teamId=${src.teamId}&startDate=${TODAY}&endDate=${WINDOW_END}`
  )
  if (!json) return { fixtures: [] as TeamFixture[], ok: false }

  const us = FOLLOWED_TEAMS.find(t => t.sources.some(s => s.kind === 'mlb-stats' && s.teamId === src.teamId))
  const fixtures: TeamFixture[] = []
  for (const day of json.dates ?? []) {
    for (const g of day.games ?? []) {
      const homeTeam = g.teams?.home?.team
      const awayTeam = g.teams?.away?.team
      const kickoff: string | undefined = g.gameDate
      if (!homeTeam?.name || !awayTeam?.name || !kickoff) continue
      const homeIsUs = us ? teamMatches(homeTeam.name, us) : false
      const awayIsUs = us ? teamMatches(awayTeam.name, us) : false
      if (!homeIsUs && !awayIsUs) continue
      const date = tzDay(kickoff, ATLANTIC_TZ)
      fixtures.push({
        id: `${date}-${slug(homeTeam.name)}-${slug(awayTeam.name)}`,
        date,
        kickoff,
        home: homeTeam.name,
        away: awayTeam.name,
        homeShort: homeIsUs && us ? us.short : abbr.get(homeTeam.id) ?? homeTeam.name,
        awayShort: awayIsUs && us ? us.short : abbr.get(awayTeam.id) ?? awayTeam.name,
        competition: src.competition,
        venue: g.venue?.name ?? null,
        teamKeys: us ? [us.key] : [],
        homeKeys: homeIsUs && us ? [us.key] : [],
        awayKeys: awayIsUs && us ? [us.key] : [],
        source: 'MLB',
      })
    }
  }
  return { fixtures, ok: true }
}

// ---------------------------------------------------------------- Army rugby

/** Resolve one index of a devalue-flattened array into real values. */
function resolveDevalue(raw: any[], index: number, seen: Map<number, any>): any {
  if (index === null || index === undefined) return index
  const value = raw[index]
  if (value === null || typeof value !== 'object') return value
  if (seen.has(index)) return seen.get(index)
  if (Array.isArray(value)) {
    const arr: any[] = []
    seen.set(index, arr)
    for (const item of value) arr.push(resolveDevalue(raw, item, seen))
    return arr
  }
  const obj: Record<string, any> = {}
  seen.set(index, obj)
  for (const [k, v] of Object.entries(value)) obj[k] = resolveDevalue(raw, v as number, seen)
  return obj
}

async function fromArmyRugby() {
  const html = await getText(ARMY_RUGBY_SCHEDULE)
  if (!html) return { fixtures: [] as TeamFixture[], ok: false, note: 'schedule page unreachable' }
  const match = html.match(/<script[^>]*id="__NUXT_DATA__"[^>]*>([\s\S]*?)<\/script>/)
  if (!match) return { fixtures: [] as TeamFixture[], ok: false, note: 'schedule markup changed' }

  let raw: any[]
  try {
    raw = JSON.parse(match[1])
  } catch {
    return { fixtures: [] as TeamFixture[], ok: false, note: 'schedule data unparseable' }
  }

  const team = FOLLOWED_TEAMS.find(t => t.sources.some(s => s.kind === 'army-rugby'))!
  const fixtures: TeamFixture[] = []
  const seen = new Set<string>()

  raw.forEach((value, index) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return
    if (!('opponent' in value) || !('date' in value)) return
    const game = resolveDevalue(raw, index, new Map())

    // `opponent` resolves to a record, not a string. The primary rows name it in
    // `title`; the duplicate row uses `name`.
    const rawOpponent = game.opponent
    const opponent = String(
      rawOpponent && typeof rawOpponent === 'object'
        ? rawOpponent.title ?? rawOpponent.name ?? rawOpponent.shortName ?? rawOpponent.displayName ?? ''
        : rawOpponent ?? ''
    ).trim()
    const naive = String(game.date ?? '')
    if (!opponent || !/^\d{4}-\d{2}-\d{2}/.test(naive)) return

    // The page emits an October game twice — the second copy drops `at_vs` — so
    // collapse on day + opponent and keep the first, fully specified row.
    const dedupeKey = `${naive.slice(0, 10)}|${opponent.toLowerCase()}`
    if (seen.has(dedupeKey)) return
    seen.add(dedupeKey)

    const tbd = game.tbd === true || /^tbd$/i.test(String(game.time ?? ''))
    const kickoff = tbd ? null : zonedToUtc(naive, ARMY_RUGBY_TZ)
    const date = kickoff ? tzDay(kickoff, ATLANTIC_TZ) : naive.slice(0, 10)
    const armyHome = String(game.at_vs ?? 'vs').toLowerCase() === 'vs'

    const home = armyHome ? team.name : opponent
    const away = armyHome ? opponent : team.name
    // Home games name the site ("Anderson Rugby Complex"); away rows only carry
    // the host city, which is still a useful hint.
    const venue = game.facility?.title ? String(game.facility.title) : game.location ? String(game.location) : null

    fixtures.push({
      id: `${date}-${slug(home)}-${slug(away)}`,
      date,
      kickoff,
      home,
      away,
      homeShort: armyHome ? team.short : opponent,
      awayShort: armyHome ? opponent : team.short,
      competition: 'College Rugby',
      venue,
      teamKeys: [team.key],
      homeKeys: armyHome ? [team.key] : [],
      awayKeys: armyHome ? [] : [team.key],
      source: 'Army West Point',
    })
  })

  return { fixtures, ok: true }
}

// ------------------------------------------------------- unsupported sources

async function fromSuperLeague() {
  // No free fixture feed was found: superleague.co.uk renders week 1 only and
  // ignores its own week parameter, BBC/Sky publish no future fixtures and the
  // TheSportsDB free tier returns a single event. Left deliberately empty.
  return {
    fixtures: [] as TeamFixture[],
    ok: false,
    note: 'No free Super League fixture feed',
  }
}

async function fromIpl() {
  // Same story for cricket: iplt20.com renders fixtures client-side and the
  // series feeds carry nothing while the IPL is out of season.
  return {
    fixtures: [] as TeamFixture[],
    ok: false,
    note: 'No free IPL fixture feed',
  }
}

// ---------------------------------------------------------------- assembly

async function collect(team: FollowedTeam) {
  const fixtures: TeamFixture[] = []
  let ok = true
  let note: string | undefined

  for (const source of team.sources) {
    let result: { fixtures: TeamFixture[]; ok: boolean; note?: string }
    switch (source.kind) {
      case 'espn-team':
        result = await fromEspnTeamSchedule(source, team)
        break
      case 'espn-core':
        result = await fromEspnCore(source, team)
        break
      case 'mlb-stats':
        result = await fromMlbStats(source)
        break
      case 'army-rugby':
        result = await fromArmyRugby()
        break
      case 'super-league':
        result = await fromSuperLeague()
        break
      case 'ipl':
        result = await fromIpl()
        break
    }
    fixtures.push(...result.fixtures)
    if (!result.ok) {
      ok = false
      note = note ?? result.note
    }
  }

  return { fixtures, ok, note }
}

function withinWindow(fixture: TeamFixture): boolean {
  return fixture.date >= TODAY && fixture.date <= WINDOW_END
}

async function main() {
  console.log(`Building team calendar: window ${TODAY} .. ${WINDOW_END} (${WINDOW_DAYS} days)`)

  const byKey = new Map<string, TeamFixture>()
  const statuses: TeamStatus[] = []

  for (const team of FOLLOWED_TEAMS) {
    const { fixtures, ok, note } = await collect(team)
    const kept = fixtures.filter(withinWindow)
    for (const fixture of kept) {
      const existing = byKey.get(fixture.id)
      if (existing) {
        // Same game seen through two sources: keep one and remember every
        // followed side involved.
        for (const key of fixture.teamKeys) if (!existing.teamKeys.includes(key)) existing.teamKeys.push(key)
        for (const key of fixture.homeKeys) if (!existing.homeKeys.includes(key)) existing.homeKeys.push(key)
        for (const key of fixture.awayKeys) if (!existing.awayKeys.includes(key)) existing.awayKeys.push(key)
      } else {
        byKey.set(fixture.id, fixture)
      }
    }
    statuses.push({
      key: team.key,
      name: team.name,
      short: team.short,
      label: team.label,
      count: kept.length,
      ok,
      ...(note ? { note } : {}),
    })
    console.log(`  ${ok ? 'ok  ' : 'warn'} ${team.short.padEnd(12)} ${kept.length} fixture(s)${note ? ` — ${note}` : ''}`)
  }

  const fixtures = [...byKey.values()].sort(
    (a, b) => a.date.localeCompare(b.date) || a.competition.localeCompare(b.competition) || a.home.localeCompare(b.home)
  )

  const file: TeamsCalendarFile = {
    generatedAt: new Date().toISOString(),
    windowDays: WINDOW_DAYS,
    teams: statuses,
    fixtures,
  }

  await fs.mkdir(path.dirname(OUT_FILE), { recursive: true })
  await fs.writeFile(OUT_FILE, JSON.stringify(file, null, 2) + '\n', 'utf-8')
  console.log(`Wrote ${fixtures.length} fixture(s) for ${statuses.length} team(s) to ${OUT_FILE}`)
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
