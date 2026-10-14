import * as fs from 'fs/promises'
import * as path from 'path'
import { NextResponse } from 'next/server'
import type { TeamsCalendarFile } from '@/lib/teams-calendar'

export const dynamic = 'force-dynamic'

const FILE = path.join(process.cwd(), 'public', 'data', 'teams-calendar.json')

const EMPTY: TeamsCalendarFile = {
  generatedAt: '',
  windowDays: 0,
  teams: [],
  fixtures: [],
}

// The fixture file is baked nightly by the workflow, so this route only has to
// read it. Anything that goes wrong (missing file, bad JSON, or a deployment
// that predates the file) degrades to an empty calendar rather than a 500.
export async function GET() {
  let payload: TeamsCalendarFile = EMPTY
  try {
    const raw = await fs.readFile(FILE, 'utf-8')
    const parsed = JSON.parse(raw) as Partial<TeamsCalendarFile>
    payload = {
      generatedAt: typeof parsed.generatedAt === 'string' ? parsed.generatedAt : '',
      windowDays: typeof parsed.windowDays === 'number' ? parsed.windowDays : 0,
      teams: Array.isArray(parsed.teams) ? parsed.teams : [],
      fixtures: Array.isArray(parsed.fixtures) ? parsed.fixtures : [],
    }
  } catch {
    payload = EMPTY
  }

  return NextResponse.json(payload)
}
