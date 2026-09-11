import { getAllBoxerPages, getSportPages } from '../lib/categories'
import { fetchBoxerRecords } from '../lib/wikipedia'
import type { BoxerStats } from '../lib/wikipedia'
import { readRankings, writeRankings } from '../lib/storage'
import type { BoxerRecord, Gender, RankingsData, SportKey } from '../lib/types'
import { SPORT_KEYS } from '../lib/types'

const BATCH_SIZE = 50
const BATCH_DELAY = 100
const MIN_LOSSES_FOR_WORST = 10

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
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
  boxing: 384,
}

// Hard cap on total fighters (including seniors) that a sport list can contain.
const SPORT_MAX_LEN: Partial<Record<SportKey, number>> = {
  kickboxing: 68,
}

// Minimum thirdary score (wins/losses, or wins if undefeated) for inclusion.
const MMA_MIN_SCORE = 6.24
const MIN_SCORE: Partial<Record<SportKey, number>> = {
  kickboxing: 8.5,
  muayThai: 3,
  freestyleWrestling: 2.81,
  brazilianJiuJitsu: 1.1,
}

function maxWinsFor(key: SportKey): number {
  return MAX_WINS[key] ?? 1_000_000
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
    .filter(f => f.imageUrl && (f.thirdaryScore ?? 0) >= (MIN_SCORE[key] ?? 0))
    .sort((a, b) =>
      (b.thirdaryScore ?? 0) - (a.thirdaryScore ?? 0) ||
      a.losses - b.losses ||
      (b.kos ?? 0) - (a.kos ?? 0)
    )

  const ranked: BoxerRecord[] = []
  let nonSeniorCount = 0
  const maxLen = SPORT_MAX_LEN[key]
  const hasMinScore = MIN_SCORE[key] !== undefined
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
    // Only apply the 50-fighter cap for sports without a minimum score —
    // sports with a MIN_SCORE use the score filter as their natural bound.
    if (!hasMinScore && nonSeniorCount >= 50) break
    if (maxLen !== undefined && ranked.length >= maxLen) break
  }
  return ranked
}

async function main() {
  console.log('Starting MMA rankings update...')
  console.log('Step 1: Discovering fighters from Wikipedia categories...')

  const startTime = Date.now()
  const pageMap = await getAllBoxerPages()
  const pageNames = Array.from(pageMap.keys())
  console.log(`Found ${pageMap.size} fighter pages in ${(Date.now() - startTime) / 1000}s`)

  if (pageMap.size === 0) {
    console.log('No fighters found. Exiting.')
    return
  }

  // Read previous rankings for rank-change tracking
  const previous = await readRankings()
  const prevBestRank = new Map<string, number>()
  const prevWorstRank = new Map<string, number>()
  const prevBestHistory = new Map<string, { highest: number; lowest: number }>()
  const prevWorstHistory = new Map<string, { highest: number; lowest: number }>()
  const prevThirdaryHistory = new Map<string, { highest: number; lowest: number }>()
  previous.fighters
    .filter(f => f.imageUrl)
    .forEach((f, i) => {
      prevBestRank.set(f.name, i + 1)
      prevBestHistory.set(f.name, { highest: f.highestRank ?? i + 1, lowest: f.lowestRank ?? i + 1 })
    })
  ;(previous.worst ?? [])
    .forEach((f, i) => {
      prevWorstRank.set(f.name, i + 1)
      prevWorstHistory.set(f.name, { highest: f.highestRank ?? i + 1, lowest: f.lowestRank ?? i + 1 })
    })
  ;(previous.thirdary ?? [])
    .forEach((f, i) => {
      prevThirdaryHistory.set(f.name, { highest: f.highestRank ?? i + 1, lowest: f.lowestRank ?? i + 1 })
    })

  console.log(`\nStep 2: Fetching records for all ${pageMap.size} fighters...`)

  const undefeated: BoxerRecord[] = []
  const winless: BoxerRecord[] = []
  const allRecords = new Map<string, BoxerStats>()
  let processed = 0
  const total = pageNames.length

  for (let i = 0; i < pageNames.length; i += BATCH_SIZE) {
    const batch = pageNames.slice(i, i + BATCH_SIZE)
    const results = await fetchBoxerRecords(batch)

    for (const [name, record] of results) {
      processed++
      if (processed % 200 === 0 || processed === total) {
        process.stdout.write(`\r  Progress: ${processed}/${total} (${((processed / total) * 100).toFixed(1)}%)`)
      }

      if (!record) continue
      if (record.total === null || record.wins === null || record.losses === null) continue

      allRecords.set(name, record)

      // Best: undefeated, >= 10 wins
      if (record.losses === 0 && record.wins >= 10) {
        undefeated.push({
          name,
          total: record.total,
          wins: record.wins,
          kos: record.kos ?? 0,
          losses: record.losses,
          draws: record.draws,
          nationality: record.nationality,
          weightClass: record.weightClass || undefined,
          imageUrl: record.imageUrl || undefined,
          gender: pageMap.get(name),
          wikipediaUrl: `https://en.wikipedia.org/wiki/${encodeURIComponent(name.replace(/ /g, '_'))}`,
          lastUpdated: new Date().toISOString(),
        })
      }

      // Worst: winless, >= threshold losses
      if (record.wins === 0 && record.losses >= MIN_LOSSES_FOR_WORST) {
        winless.push({
          name,
          total: record.total,
          wins: record.wins,
          kos: record.kos ?? 0,
          losses: record.losses,
          draws: record.draws,
          nationality: record.nationality,
          weightClass: record.weightClass || undefined,
          imageUrl: record.imageUrl || undefined,
          gender: pageMap.get(name),
          wikipediaUrl: `https://en.wikipedia.org/wiki/${encodeURIComponent(name.replace(/ /g, '_'))}`,
          lastUpdated: new Date().toISOString(),
        })
      }
    }

    await delay(BATCH_DELAY)
  }

  const ranked = undefeated
    .filter(f => f.imageUrl)
    .sort((a, b) => b.wins - a.wins || a.draws - b.draws || b.kos - a.kos || a.name.localeCompare(b.name))
    .map((f, i) => {
      const rank = i + 1
      const hist = prevBestHistory.get(f.name)
      return {
        ...f,
        previousRank: prevBestRank.get(f.name) || undefined,
        highestRank: hist ? Math.min(hist.highest, rank) : rank,
        lowestRank: hist ? Math.max(hist.lowest, rank) : rank,
      }
    })

  const worstRanked = winless
    .sort((a, b) => b.losses - a.losses || a.draws - b.draws || a.name.localeCompare(b.name))
    .map((f, i) => {
      const rank = i + 1
      const hist = prevWorstHistory.get(f.name)
      return {
        ...f,
        previousRank: prevWorstRank.get(f.name) || undefined,
        highestRank: hist ? Math.min(hist.highest, rank) : rank,
        lowestRank: hist ? Math.max(hist.lowest, rank) : rank,
      }
    })

  const now = new Date()

  // Thirdary ranking: score = wins / max(losses, 1). Undefeated = wins.
  // 384-wins cap applies to boxing only; other sports effectively uncapped. Tiebreaker: most KOs.
  // 50 non-seniors + all seniors above 50th non-senior
  const allThirdary: BoxerRecord[] = []
  for (const [name, record] of allRecords) {
    if (record.wins === 0) continue

    const wins = record.wins!
    const losses = record.losses ?? 0
    const total = record.total!
    const thirdaryScore = losses === 0 ? wins : wins / losses

    let age: number | null = null
    if (record.birthDate) {
      const parts = record.birthDate.split('-')
      const birthYear = parseInt(parts[0], 10)
      if (parts.length === 3) {
        const birthMonth = parseInt(parts[1], 10)
        const birthDay = parseInt(parts[2], 10)
        const birthdayThisYear = new Date(now.getFullYear(), birthMonth - 1, birthDay)
        age = now >= birthdayThisYear ? now.getFullYear() - birthYear : now.getFullYear() - birthYear - 1
      } else {
        age = now.getFullYear() - birthYear
      }
    }
    const isSenior = age !== null && age >= 50

    allThirdary.push({
      name,
      total,
      wins,
      kos: record.kos ?? 0,
      losses,
      draws: record.draws,
      nationality: record.nationality,
      weightClass: record.weightClass || undefined,
      imageUrl: record.imageUrl || undefined,
      gender: pageMap.get(name),
      wikipediaUrl: `https://en.wikipedia.org/wiki/${encodeURIComponent(name.replace(/ /g, '_'))}`,
      lastUpdated: new Date().toISOString(),
      thirdaryScore,
      birthDate: record.birthDate || undefined,
      isSenior,
    })
  }

  const allThirdaryScored = allThirdary
    .filter(f => f.imageUrl && (f.thirdaryScore ?? 0) >= MMA_MIN_SCORE)
    .sort((a, b) =>
      (b.thirdaryScore ?? 0) - (a.thirdaryScore ?? 0) ||
      a.losses - b.losses ||
      (b.kos ?? 0) - (a.kos ?? 0)
    )
  // No fighter cap — MMA_MIN_SCORE filter determines inclusion
  const thirdaryRanked: BoxerRecord[] = allThirdaryScored.map((f, i) => {
    const thirdRank = i + 1
    const hist = prevThirdaryHistory.get(f.name)
    return {
      ...f,
      previousRank: undefined,
      highestRank: hist ? Math.min(hist.highest, thirdRank) : thirdRank,
      lowestRank: hist ? Math.max(hist.lowest, thirdRank) : thirdRank,
    }
  })

  const thirdEligibleWorst = allThirdary
    .filter(f => f.imageUrl && (f.thirdaryScore ?? 0) > 0 && !f.isSenior)
    .sort((a, b) => (a.thirdaryScore ?? 0) - (b.thirdaryScore ?? 0) || b.losses - a.losses || (a.kos ?? 0) - (b.kos ?? 0))
  const thirdSeniorsWorst = allThirdary
    .filter(f => f.imageUrl && (f.thirdaryScore ?? 0) > 0 && f.isSenior)
    .sort((a, b) => (a.thirdaryScore ?? 0) - (b.thirdaryScore ?? 0) || b.losses - a.losses || (a.kos ?? 0) - (b.kos ?? 0))
  const thirdaryWorstRanked = [...thirdEligibleWorst.slice(0, 50), ...thirdSeniorsWorst]

  // Step 3: Multi-sport rankings (kickboxing, muay thai, wrestling, etc.).
  // Purely supplementary/cosmetic — failures here must never break MMA/news.
  const sports: RankingsData['sports'] = {}
  try {
    const sportPages = await getSportPages()
    const allSportTitles = new Set<string>()
    for (const key of SPORT_KEYS) {
      for (const page of sportPages[key].keys()) allSportTitles.add(page)
    }
    console.log(`\nStep 3: Fetching sport records for ${allSportTitles.size} unique fighter pages...`)

    const sportRecords = new Map<string, BoxerStats>()
    const titles = Array.from(allSportTitles)
    for (let i = 0; i < titles.length; i += BATCH_SIZE) {
      const batch = titles.slice(i, i + BATCH_SIZE)
      const results = await fetchBoxerRecords(batch)
      for (const [name, record] of results) {
        if (record) sportRecords.set(name, record)
      }
      await delay(BATCH_DELAY)
    }
    console.log(`Fetched records for ${sportRecords.size} sport fighter pages.`)

    const nowSport = new Date()
    for (const key of SPORT_KEYS) {
      const ranked = buildSportRanking(key, sportPages[key], sportRecords, previous, nowSport)
      if (ranked.length > 0) sports[key] = ranked
      if (ranked.length > 0) {
        console.log(`Sport ${key}: ${ranked.length} ranked. Top: ${ranked.slice(0, 5).map(f => `${f.name} (${f.wins}-${f.losses}-${f.draws})`).join(', ')}`)
      } else {
        console.log(`Sport ${key}: no rankings.`)
      }
    }
  } catch (err) {
    console.error('Sport rankings failed (continuing with MMA rankings only):', err)
  }

  await writeRankings(ranked, worstRanked, thirdaryRanked, thirdaryWorstRanked, Object.keys(sports).length > 0 ? sports : undefined)

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1)
  console.log(`\nDone! ${ranked.length} undefeated, ${worstRanked.length} winless, ${thirdaryRanked.length} thirdary, ${thirdaryWorstRanked.length} thirdary worst fighters ranked.`)
  console.log(`Sports ranked: ${Object.keys(sports).join(', ') || 'none'}`)
  console.log(`Total time: ${elapsed}s`)
  if (ranked.length > 0) {
    console.log(`Top 10 best: ${ranked.slice(0, 10).map(f => `${f.name} (${f.wins}-${f.losses}-${f.draws})`).join(', ')}`)
  }
  if (worstRanked.length > 0) {
    console.log(`Top 10 worst: ${worstRanked.slice(0, 10).map(f => `${f.name} (${f.wins}-${f.losses}-${f.draws})`).join(', ')}`)
  }
  if (thirdaryRanked.length > 0) {
    console.log(`Top 10 thirdary: ${thirdaryRanked.slice(0, 10).map(f => `${f.name} (${f.wins}-${f.losses}-${f.draws}) [${(f.thirdaryScore ?? 0).toFixed(2)}]`).join(', ')}`)
  }
}

main().catch(err => {
  console.error('Update failed:', err)
  process.exit(1)
})
