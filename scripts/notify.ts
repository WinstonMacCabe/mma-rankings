import * as fs from 'fs'
import * as path from 'path'
import { execSync } from 'child_process'
import nodemailer from 'nodemailer'
import type { BoxerRecord } from '../lib/types'
import { renderEmailHtml, type EmailSection } from './email-html'

const FIGHTS_FILE = path.join(process.cwd(), 'public', 'data', 'upcoming-fights.json')
const RANKINGS_FILE = path.join(process.cwd(), 'public', 'data', 'rankings.json')

interface ScheduledEntry {
  boxerName: string
  sport?: string
  headline: string
  url: string
  source: string
  publishedAt: string
  date: string
  granularity?: 'day' | 'month'
  matchup?: string
  opponent?: string
  confidence?: string
}

interface UpcomingLike {
  fights?: ScheduledEntry[]
}

interface RankingsLike {
  fighters?: BoxerRecord[]
  worst?: BoxerRecord[]
  thirdary?: BoxerRecord[]
  sports?: Record<string, BoxerRecord[]>
}

const SPORT_LABELS: Record<string, string> = {
  kickboxing: 'Kickboxing', muayThai: 'Muay Thai', karate: 'Karate',
  freestyleWrestling: 'Freestyle Wrestling', ncaaWrestling: 'NCAA Wrestling',
  brazilianJiuJitsu: 'BJJ', sumo: 'Sumo', mongolianWrestling: 'Mongolian Wrestling',
  lethwei: 'Lethwei', kunKhmer: 'Kun Khmer', sambo: 'Sambo',
  grecoRomanWrestling: 'Greco-Roman', sanshou: 'Sanshou',
  submissionWrestling: 'Sub. Wrestling', judo: 'Judo', bareKnuckle: 'Bare Knuckle',
}

function loadJsonSafe<T>(filePath: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T
  } catch {
    return null
  }
}

function gitShowHead<T>(filePath: string): T | null {
  try {
    const raw = execSync(`git show HEAD:${filePath}`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
    return JSON.parse(raw) as T
  } catch {
    return null
  }
}

function diffRankings(current: BoxerRecord[], previous: BoxerRecord[]): { added: BoxerRecord[]; removed: BoxerRecord[] } {
  const prevNames = new Set(previous.map(f => f.name))
  const curNames = new Set(current.map(f => f.name))
  const added = current.filter(f => !prevNames.has(f.name))
  const removed = previous.filter(f => !curNames.has(f.name))
  return { added, removed }
}

function fightKey(f: ScheduledEntry): string {
  return f.url || `${f.boxerName}|${f.date}|${(f.matchup || '').toLowerCase()}`
}

function dateText(date: string): string {
  if (!date) return ''
  if (/^\d{4}-\d{2}$/.test(date)) {
    const [y, m] = date.split('-').map(Number)
    return new Date(y, m - 1, 1).toLocaleDateString('en-US', { month: 'long', year: 'numeric' })
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    const d = new Date(`${date}T00:00:00Z`)
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' })
  }
  return date
}

async function main() {
  const from = process.env.NOTIFY_EMAIL_FROM
  const pass = process.env.NOTIFY_EMAIL_PASS
  const to = process.env.NOTIFY_EMAIL_TO

  if (!from || !pass || !to) {
    console.log('Missing NOTIFY_EMAIL_* env vars. Skipping notification.')
    return
  }

  const sections: EmailSection[] = []

  // 1. Load rankings first to map fighters to sports
  const curRankings = loadJsonSafe<RankingsLike>(RANKINGS_FILE)
  const prevRankings = gitShowHead<RankingsLike>('public/data/rankings.json')

  const fighterSports = new Map<string, string>()
  if (curRankings) {
    const scoutSportLabel = (sportKey: string): string => SPORT_LABELS[sportKey] || sportKey
    const addSport = (list: BoxerRecord[] | undefined, sportName: string) => {
      if (!list) return
      for (const f of list) {
        if (!fighterSports.has(f.name)) fighterSports.set(f.name, sportName)
      }
    }
    // MMA first so it takes priority for featured fighters
    addSport(curRankings.thirdary, 'MMA')
    addSport(curRankings.fighters, 'MMA')
    if (curRankings.sports && typeof curRankings.sports === 'object') {
      for (const [k, list] of Object.entries(curRankings.sports)) {
        addSport(list, scoutSportLabel(k))
      }
    }
  }

  // 2. New scheduled fights only (day AND month) — bookings not present at git HEAD.
  const curFights = (loadJsonSafe<UpcomingLike>(FIGHTS_FILE)?.fights ?? []) as ScheduledEntry[]
  const prevFights = (gitShowHead<UpcomingLike>('public/data/upcoming-fights.json')?.fights ?? []) as ScheduledEntry[]

  const prevKeys = new Set(prevFights.map(fightKey))
  const newScheduled = [...curFights.filter(f => !prevKeys.has(fightKey(f)))].sort((a, b) => a.date.localeCompare(b.date))

  if (newScheduled.length > 0) {
    const groupedScheduled = new Map<string, ScheduledEntry[]>()
    for (const f of newScheduled) {
      const sport = f.sport ? (SPORT_LABELS[f.sport] || f.sport) : (fighterSports.get(f.boxerName) || 'MMA')
      if (!groupedScheduled.has(sport)) groupedScheduled.set(sport, [])
      groupedScheduled.get(sport)!.push(f)
    }

    for (const [sport, fights] of groupedScheduled.entries()) {
      const rows = fights.map(f => {
        const label = f.opponent ? `${f.boxerName} vs ${f.opponent}` : f.boxerName
        return {
          label,
          text: dateText(f.date),
          url: f.url,
          sub: f.source,
        }
      })

      // Dedupe: same booking announced in multiple articles.
      const seenRows = new Set<string>()
      const uniqueRows = rows.filter(r => {
        const key = `${r.label.split(' vs ')[0]}|${r.text}|${r.label.split(' vs ').pop()?.toLowerCase().split(/\s+/).pop() || ''}`
        if (seenRows.has(key)) return false
        seenRows.add(key)
        return true
      })

      sections.push({
        heading: `${sport} New Scheduled Fights (${uniqueRows.length})`,
        rows: uniqueRows,
      })
    }
  }

  // 3. Ranking changes — new and departed fighters
  let rankingsChanged = false
  if (curRankings && prevRankings) {
    const bestDiff = diffRankings(curRankings.fighters ?? [], prevRankings.fighters ?? [])
    const worstDiff = diffRankings(curRankings.worst ?? [], prevRankings.worst ?? [])
    const thirdDiff = diffRankings(curRankings.thirdary ?? [], prevRankings.thirdary ?? [])

    const allAdded = [...bestDiff.added, ...worstDiff.added, ...thirdDiff.added]
    const allRemoved = [...bestDiff.removed, ...worstDiff.removed, ...thirdDiff.removed]

    const addedNames = [...new Map(allAdded.map(f => [f.name, f])).values()]
    const removedNames = [...new Map(allRemoved.map(f => [f.name, f])).values()]

    if (addedNames.length > 0) {
      rankingsChanged = true
      sections.push({
        heading: `New Fighters (${addedNames.length})`,
        rows: addedNames.map(f => ({ label: f.name, text: `${f.wins}-${f.losses}-${f.draws}` })),
      })
    }

    if (removedNames.length > 0) {
      rankingsChanged = true
      sections.push({
        heading: `Gone but Not Forgotten (${removedNames.length})`,
        rows: removedNames.map(f => ({ label: f.name, text: `${f.wins}-${f.losses}-${f.draws}` })),
      })
    }

    const sports = ['kickboxing', 'muayThai', 'karate', 'freestyleWrestling', 'ncaaWrestling', 'brazilianJiuJitsu', 'sumo', 'mongolianWrestling', 'lethwei', 'kunKhmer', 'sambo', 'grecoRomanWrestling', 'sanshou', 'submissionWrestling', 'bareKnuckle'] as const
    for (const sport of sports) {
      const cur = curRankings.sports?.[sport] ?? []
      const prev = prevRankings.sports?.[sport] ?? []
      const diff = diffRankings(cur, prev)
      if (diff.added.length > 0 || diff.removed.length > 0) {
        rankingsChanged = true
        const rows = [
          ...diff.added.map(f => ({ label: '+ ' + f.name, text: `${f.wins}-${f.losses}-${f.draws}` })),
          ...diff.removed.map(f => ({ label: '- ' + f.name, text: `${f.wins}-${f.losses}-${f.draws}` })),
        ]
        sections.push({
          heading: `${sport} (${diff.added.length} in, ${diff.removed.length} out)`,
          rows,
        })
      }
    }
  }

  if (sections.length === 0) {
    console.log('No new scheduled fights or ranking changes. Skipping notification.')
    return
  }

  const subject = [
    newScheduled.length > 0 ? `${newScheduled.length} new scheduled fight${newScheduled.length === 1 ? '' : 's'}` : null,
    rankingsChanged ? 'rankings updated' : null,
  ].filter(Boolean).join(', ')

  const text = `Fight rankings update\n\n${sections
    .map(section => `${section.heading.toUpperCase()}\n${section.rows
      .map(row => `- ${row.label ? `${row.label}: ` : ''}${row.text}${row.url ? ` ${row.url}` : ''}`)
      .join('\n')}`)
    .join('\n\n')}`

  const html = renderEmailHtml('MMA', sections)

  const transporter = nodemailer.createTransport({
    host: process.env.NOTIFY_EMAIL_HOST || 'smtp.gmail.com',
    port: 465,
    secure: true,
    auth: { user: from, pass },
  })

  await transporter.sendMail({ from, to, subject, text, html })
  console.log(`Sent notification to ${to}: ${subject}`)
}

main().catch(err => {
  console.error('Notification failed:', err)
  process.exit(1)
})