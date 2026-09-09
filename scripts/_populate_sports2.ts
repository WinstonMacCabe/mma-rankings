import { getSportPages } from '../lib/categories'
import { fetchBoxerRecords, checkImageSizes } from '../lib/wikipedia'
import type { BoxerStats } from '../lib/wikipedia'
import { readRankings, writeRankings } from '../lib/storage'
import type { BoxerRecord, Gender, SportKey } from '../lib/types'
import { SPORT_KEYS } from '../lib/types'
import * as fs from 'node:fs'
import * as path from 'node:path'

const BATCH_SIZE = 50
const BATCH_DELAY = 100
const CHECKPOINT = path.join(__dirname, '.sport_records_checkpoint.json')

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function saveCheckpoint(records: Map<string, BoxerStats>): void {
  fs.writeFileSync(CHECKPOINT, JSON.stringify(Array.from(records.entries())))
}

function loadCheckpoint(): Map<string, BoxerStats> {
  if (!fs.existsSync(CHECKPOINT)) return new Map()
  try {
    const raw = JSON.parse(fs.readFileSync(CHECKPOINT, 'utf8')) as [string, BoxerStats][]
    return new Map(raw)
  } catch {
    return new Map()
  }
}

function computeAge(birthDate: string | undefined, now: Date): number | null {
  if (!birthDate) return null
  const parts = birthDate.split('-')
  const birthYear = parseInt(parts[0], 10)
  if (isNaN(birthYear)) return null
  if (parts.length === 3) {
    const birthMonth = parseInt(parts[1], 10)
    const birthDay = parseInt(parts[2], 10)
    const birthdayThisYear = new Date(now.getFullYear(), birthMonth - 1, birthDay)
    return now >= birthdayThisYear ? now.getFullYear() - birthYear : now.getFullYear() - birthYear - 1
  }
  return now.getFullYear() - birthYear
}

const MAX_WINS: Partial<Record<SportKey, number>> = {
  sumo: 3000,
  mongolianWrestling: 1500,
}

function maxWinsFor(key: SportKey): number {
  return MAX_WINS[key] ?? 384
}

function buildSportRanking(
  key: SportKey,
  pages: Map<string, Gender>,
  records: Map<string, BoxerStats>,
  previous: Awaited<ReturnType<typeof readRankings>>,
  now: Date
): BoxerRecord[] {
  const prevSport = previous.sports?.[key] ?? []
  const prevRank = new Map<string, number>()
  const prevHistory = new Map<string, { highest: number; lowest: number }>()
  prevSport.forEach((f, i) => {
    prevRank.set(f.name, i + 1)
    prevHistory.set(f.name, { highest: f.highestRank ?? i + 1, lowest: f.lowestRank ?? i + 1 })
  })

  const nowIso = now.toISOString()
  const all: BoxerRecord[] = []
  for (const [name, gender] of pages) {
    const record = records.get(name)
    if (!record) continue
    const sportRec = record.sportRecords?.[key]
    if (!sportRec) continue
    const { wins, losses, draws, noContests } = sportRec
    if (wins === 0 || wins > maxWinsFor(key)) continue
    const total = wins + losses + draws + noContests
    const age = computeAge(record.birthDate, now)
    all.push({
      name,
      total,
      wins,
      kos: sportRec.kos ?? 0,
      losses,
      draws,
      nationality: record.nationality,
      weightClass: record.weightClass || undefined,
      imageUrl: record.imageUrl || undefined,
      gender: gender || undefined,
      wikipediaUrl: `https://en.wikipedia.org/wiki/${encodeURIComponent(name.replace(/ /g, '_'))}`,
      lastUpdated: nowIso,
      thirdaryScore: losses === 0 ? wins : wins / losses,
      birthDate: record.birthDate || undefined,
      isSenior: age !== null && age >= 50,
    })
  }

  const scored = all
    .filter(f => (f.thirdaryScore ?? 0) > 0)
    .sort((a, b) =>
      (b.thirdaryScore ?? 0) - (a.thirdaryScore ?? 0) ||
      a.losses - b.losses ||
      (b.kos ?? 0) - (a.kos ?? 0)
    )

  const ranked: BoxerRecord[] = []
  let nonSeniorCount = 0
  for (let i = 0; i < scored.length; i++) {
    const f = scored[i]
    const rank = i + 1
    const hist = prevHistory.get(f.name)
    ranked.push({
      ...f,
      previousRank: prevRank.get(f.name) || undefined,
      highestRank: hist ? Math.min(hist.highest, rank) : rank,
      lowestRank: hist ? Math.max(hist.lowest, rank) : rank,
    })
    if (!f.isSenior) nonSeniorCount++
    if (nonSeniorCount >= 50) break
  }
  return ranked
}

async function main() {
  console.log('Rebuilding all sport rankings (with sumo + mongolian wrestling)...')
  const startTime = Date.now()

  const previous = await readRankings()

  const sportPages = await getSportPages()
  const allSportTitles = new Set<string>()
  for (const key of SPORT_KEYS) {
    console.log(`Sport ${key}: ${sportPages[key].size} pages found`)
    for (const page of sportPages[key].keys()) allSportTitles.add(page)
  }
  console.log(`\nFetching sport records for ${allSportTitles.size} unique fighter pages...`)

  const sportRecords = loadCheckpoint()
  const titles = Array.from(allSportTitles)
  const toFetch = titles.filter(t => !sportRecords.has(t))
  console.log(`Resuming from checkpoint: ${titles.length - toFetch.length}/${titles.length} already fetched`)
  for (let i = 0; i < toFetch.length; i += BATCH_SIZE) {
    const batch = toFetch.slice(i, i + BATCH_SIZE)
    const results = await fetchBoxerRecords(batch)
    for (const [name, record] of results) {
      if (record) sportRecords.set(name, record)
    }
    saveCheckpoint(sportRecords)
    await delay(BATCH_DELAY)
    if ((i / BATCH_SIZE) % 10 === 0) {
      console.log(`  fetched ${Math.min(i + BATCH_SIZE, toFetch.length)}/${toFetch.length} (${((Date.now() - startTime) / 1000).toFixed(1)}s)`)
    }
  }
  console.log(`Fetched records for ${sportRecords.size} sport fighter pages.`)

  // Image validation: verify URLs resolve, fall back to pageimages for broken ones
  const imageUrls = Array.from(new Set(
    Array.from(sportRecords.values()).map(r => r?.imageUrl).filter((u): u is string => !!u)
  ))
  console.log(`Validating ${imageUrls.length} image URLs...`)
  const sizeMap = await checkImageSizes(imageUrls)
  let brokenCount = 0
  for (const [name, record] of sportRecords) {
    if (record && record.imageUrl && !sizeMap.has(record.imageUrl)) {
      record.imageUrl = ''
      brokenCount++
    }
  }
  if (brokenCount > 0) {
    console.log(`Found ${brokenCount} broken images, retrying via pageimages...`)
    const needsFallback = Array.from(sportRecords.entries())
      .filter(([, r]) => r && !r.imageUrl)
      .map(([name]) => name)
    for (let i = 0; i < needsFallback.length; i += 50) {
      const batch = needsFallback.slice(i, i + 50)
      try {
        const params = new URLSearchParams({
          action: 'query', prop: 'pageimages', piprop: 'thumbnail', pithumbsize: '300',
          titles: batch.join('|'), format: 'json', origin: '*',
        })
        const res = await fetch(`https://en.wikipedia.org/w/api.php?${params}`, {
          headers: { 'User-Agent': 'MMARankings/1.0' },
        })
        if (res.ok) {
          const data = await res.json() as any
          const pages = data?.query?.pages ?? {}
          for (const [, p] of Object.entries(pages) as any[]) {
            if (p.title && p.thumbnail?.source) {
              const existing = sportRecords.get(p.title)
              if (existing && !existing.imageUrl) {
                existing.imageUrl = p.thumbnail.source
              }
            }
          }
        }
      } catch { }
    }
    const stillMissing = Array.from(sportRecords.values()).filter(r => r && !r.imageUrl).length
    console.log(`After fallback: ${stillMissing} fighters still without image.`)
  }

  const now = new Date()
  const sports: Record<SportKey, BoxerRecord[]> = {} as Record<SportKey, BoxerRecord[]>
  for (const key of SPORT_KEYS) {
    const ranked = buildSportRanking(key, sportPages[key], sportRecords, previous, now)
    if (ranked.length > 0) {
      sports[key] = ranked
      console.log(`Sport ${key}: ${ranked.length} ranked. Top: ${ranked.slice(0, 5).map(f => `${f.name} (${f.wins}-${f.losses}-${f.draws})`).join(', ')}`)
    } else {
      console.log(`Sport ${key}: no rankings.`)
    }
  }

  await writeRankings(previous?.fighters ?? [], previous?.worst ?? [], previous?.thirdary ?? [], previous?.thirdaryWorst ?? [], sports)

  fs.rmSync(CHECKPOINT, { force: true })

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1)
  console.log(`\nDone in ${elapsed}s. Sports ranked: ${Object.keys(sports).join(', ') || 'none'}`)
}

main().catch(err => {
  console.error('Update failed:', err)
  process.exit(1)
})