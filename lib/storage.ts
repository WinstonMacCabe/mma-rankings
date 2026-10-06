import * as fs from 'fs/promises'
import * as path from 'path'
import type { RankingsData, BoxerRecord, UpcomingFightsData, BoxingRecordsData, BoxingRecordEntry } from './types'

const DATA_DIR = path.join(process.cwd(), 'public', 'data')
const DATA_FILE = path.join(DATA_DIR, 'rankings.json')
const NEWS_FILE = path.join(DATA_DIR, 'upcoming-fights.json')
const BOXING_RECORDS_FILE = path.join(DATA_DIR, 'boxing-records.json')

export async function readRankings(): Promise<RankingsData> {
  try {
    const raw = await fs.readFile(DATA_FILE, 'utf-8')
    return JSON.parse(raw) as RankingsData
  } catch {
    return { lastUpdated: '', fighters: [] }
  }
}

export async function writeRankings(
  fighters: BoxerRecord[],
  worst: BoxerRecord[] = [],
  thirdary: BoxerRecord[] = [],
  thirdaryWorst: BoxerRecord[] = [],
  sports: RankingsData['sports'] = undefined
): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true })
  const data: RankingsData = {
    lastUpdated: new Date().toISOString(),
    fighters,
    worst: worst.length > 0 ? worst : undefined,
    thirdary: thirdary.length > 0 ? thirdary : undefined,
    thirdaryWorst: thirdaryWorst.length > 0 ? thirdaryWorst : undefined,
    sports,
  }
  await fs.writeFile(DATA_FILE, JSON.stringify(data, null, 2), 'utf-8')
}

export async function writeBoxingRecords(records: Record<string, BoxingRecordEntry>): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true })

  // The boxing site imports this file verbatim to discover fighters its own
  // crawl cannot reach (pages without a boxing infobox or record section).
  // A partial crawl -- rate limiting, failed batches, a scoped run -- would
  // otherwise publish a shrunken feed and silently drop those fighters from
  // its rankings. Prefer this run's parse for every name we have, and carry
  // forward anything we had before but are missing now.
  let previous: Record<string, BoxingRecordEntry> = {}
  try {
    const raw = await fs.readFile(BOXING_RECORDS_FILE, 'utf-8')
    previous = (JSON.parse(raw) as BoxingRecordsData).records ?? {}
  } catch {
    // no previous file -- nothing to preserve
  }

  const merged: Record<string, BoxingRecordEntry> = { ...records }
  let carried = 0
  for (const [name, prior] of Object.entries(previous)) {
    if (!(name in merged)) {
      merged[name] = prior
      carried++
    }
  }

  const prevCount = Object.keys(previous).length
  const newCount = Object.keys(records).length
  if (carried > 0) {
    console.warn(
      `Boxing records fell from ${prevCount} to ${newCount}; carried over ${carried} ` +
        `entries from the previous file (now ${Object.keys(merged).length}). ` +
        `The crawl that produced this run was probably partial.`,
    )
  }

  const data: BoxingRecordsData = {
    lastUpdated: new Date().toISOString(),
    records: merged,
  }
  await fs.writeFile(BOXING_RECORDS_FILE, JSON.stringify(data, null, 2), 'utf-8')
}

export async function readUpcomingFights(): Promise<UpcomingFightsData> {
  try {
    const raw = await fs.readFile(NEWS_FILE, 'utf-8')
    return JSON.parse(raw) as UpcomingFightsData
  } catch {
    return { lastUpdated: '', fights: [] }
  }
}
