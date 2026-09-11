import * as fs from 'fs/promises'
import * as path from 'path'
import { execSync } from 'child_process'
import nodemailer from 'nodemailer'
import type { BoxerRecord, RankingsData } from '../lib/types'

const FIGHTS_FILE = path.join(process.cwd(), 'public', 'data', 'upcoming-fights.json')
const RANKINGS_FILE = path.join(process.cwd(), 'public', 'data', 'rankings.json')

interface UpcomingFightEntry {
  boxerName: string
  headline: string
  url: string
  source: string
  publishedAt: string
}

function loadJsonSafe(filePath: string): any {
  try {
    return JSON.parse(require('fs').readFileSync(filePath, 'utf8'))
  } catch {
    return null
  }
}

function gitShowHead(filePath: string): any {
  try {
    const raw = execSync(`git show HEAD:${filePath}`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
    return JSON.parse(raw)
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

async function main() {
  const from = process.env.NOTIFY_EMAIL_FROM
  const pass = process.env.NOTIFY_EMAIL_PASS
  const to = process.env.NOTIFY_EMAIL_TO

  if (!from || !pass || !to) {
    console.log('Missing NOTIFY_EMAIL_* env vars. Skipping notification.')
    return
  }

  const sections: string[] = []

  // 1. Load Rankings first to map fighters to sports
  const curRankings = loadJsonSafe(RANKINGS_FILE) as RankingsData | null
  const prevRankings = gitShowHead('public/data/rankings.json') as RankingsData | null

  const fighterSports = new Map<string, string>()
  if (curRankings) {
    const SPORT_LABELS: Record<string, string> = {
      kickboxing: 'Kickboxing', muayThai: 'Muay Thai', karate: 'Karate',
      freestyleWrestling: 'Freestyle Wrestling', ncaaWrestling: 'NCAA Wrestling',
      brazilianJiuJitsu: 'BJJ', sumo: 'Sumo', mongolianWrestling: 'Mongolian Wrestling',
      lethwei: 'Lethwei', kunKhmer: 'Kun Khmer', sambo: 'Sambo',
      grecoRomanWrestling: 'Greco-Roman', bareKnuckle: 'Bare Knuckle', judo: 'Judo'
    }
    const addSport = (list: any[] | undefined, sportName: string) => {
      if (!list) return
      for (const f of list) {
        if (!fighterSports.has(f.name)) fighterSports.set(f.name, sportName)
      }
    }
    // We add MMA first so it takes priority for thirdary fighters
    addSport(curRankings.thirdary, 'MMA')
    addSport(curRankings.fighters, 'MMA')
    if (curRankings.sports) {
      for (const [k, list] of Object.entries(curRankings.sports)) {
        addSport(list as any[], SPORT_LABELS[k] || k)
      }
    }
  }

  // 2. Fight news
  const curFights = (loadJsonSafe(FIGHTS_FILE)?.fights ?? []) as UpcomingFightEntry[]
  let prevFights: UpcomingFightEntry[] = []
  try {
    prevFights = (gitShowHead('public/data/upcoming-fights.json')?.fights ?? []) as UpcomingFightEntry[]
  } catch { /* ignore */ }

  const prevUrls = new Set(prevFights.map(f => f.url))
  const newFights = curFights.filter(f => !prevUrls.has(f.url))
  
  if (newFights.length > 0) {
    const groupedNews = new Map<string, UpcomingFightEntry[]>()
    for (const f of newFights) {
      const sport = fighterSports.get(f.boxerName) || 'MMA' // fallback to MMA if not found
      if (!groupedNews.has(sport)) groupedNews.set(sport, [])
      groupedNews.get(sport)!.push(f)
    }

    const newsLines = [`New fight news (${newFights.length}):`]
    for (const [sport, fights] of groupedNews.entries()) {
      newsLines.push(`\n[${sport.toUpperCase()}]`)
      for (const f of fights) {
        const date = f.publishedAt ? new Date(f.publishedAt).toLocaleDateString() : '?'
        newsLines.push(`  - ${f.boxerName}: ${f.headline} [${f.source}, ${date}] ${f.url}`)
      }
    }
    sections.push(newsLines.join('\n'))
  }

  // 3. Ranking changes — new and departed fighters
  if (curRankings && prevRankings) {
    // Best (undefeated) list
    const bestDiff = diffRankings(curRankings.fighters ?? [], prevRankings.fighters ?? [])
    // Worst (winless) list
    const worstDiff = diffRankings(curRankings.worst ?? [], prevRankings.worst ?? [])
    // Thirdary list
    const thirdDiff = diffRankings(curRankings.thirdary ?? [], prevRankings.thirdary ?? [])

    const allAdded = [...bestDiff.added, ...worstDiff.added, ...thirdDiff.added]
    const allRemoved = [...bestDiff.removed, ...worstDiff.removed, ...thirdDiff.removed]

    // Deduplicate by name
    const addedNames = [...new Map(allAdded.map(f => [f.name, f])).values()]
    const removedNames = [...new Map(allRemoved.map(f => [f.name, f])).values()]

    if (addedNames.length > 0) {
      const lines = addedNames.map(f => `  - ${f.name} (${f.wins}-${f.losses}-${f.draws})`)
      sections.push(`New fighters (${addedNames.length}):\n${lines.join('\n')}`)
    }

    if (removedNames.length > 0) {
      const lines = removedNames.map(f => `  - ${f.name} (${f.wins}-${f.losses}-${f.draws})`)
      sections.push(`Gone but not forgotten (${removedNames.length}):\n${lines.join('\n')}`)
    }

    // Sport ranking changes
    const sports = ['kickboxing', 'muayThai', 'karate', 'freestyleWrestling', 'brazilianJiuJitsu', 'sumo', 'mongolianWrestling', 'lethwei', 'kunKhmer', 'judo', 'bareKnuckle'] as const
    for (const sport of sports) {
      const cur = curRankings.sports?.[sport] ?? []
      const prev = prevRankings.sports?.[sport] ?? []
      const diff = diffRankings(cur, prev)
      if (diff.added.length > 0 || diff.removed.length > 0) {
        const lines: string[] = []
        for (const f of diff.added) lines.push(`  + ${f.name} (${f.wins}-${f.losses}-${f.draws})`)
        for (const f of diff.removed) lines.push(`  - ${f.name} (${f.wins}-${f.losses}-${f.draws})`)
        sections.push(`${sport} (${diff.added.length} in, ${diff.removed.length} out):\n${lines.join('\n')}`)
      }
    }
  }

  if (sections.length === 0) {
    console.log('No new fights or ranking changes. Skipping notification.')
    return
  }

  const subject = [
    newFights.length > 0 ? `${newFights.length} new fight` : null,
    (curRankings && prevRankings) ? 'rankings updated' : null,
  ].filter(Boolean).join(', ')

  const text = `Fight rankings update\n\n${sections.join('\n\n')}`

  const transporter = nodemailer.createTransport({
    host: process.env.NOTIFY_EMAIL_HOST || 'smtp.gmail.com',
    port: 465,
    secure: true,
    auth: { user: from, pass },
  })

  await transporter.sendMail({ from, to, subject, text })
  console.log(`Sent notification to ${to}: ${subject}`)
}

main().catch(err => {
  console.error('Notification failed:', err)
  process.exit(1)
})
