export type Gender = 'male' | 'female'

export type SportKey =
  | 'boxing'
  | 'kickboxing'
  | 'muayThai'
  | 'karate'
  | 'taekwondo'
  | 'savate'
  | 'sanda'
  | 'sambo'
  | 'judo'
  | 'freestyleWrestling'
  | 'brazilianJiuJitsu'

export interface SportRecord {
  wins: number
  kos: number
  losses: number
  draws: number
  noContests: number
}

export const SPORT_KEYS: SportKey[] = [
  'kickboxing',
  'muayThai',
  'karate',
  'freestyleWrestling',
  'brazilianJiuJitsu',
]

export interface BoxerRecord {
  name: string
  total: number
  wins: number
  kos: number
  losses: number
  draws: number
  nationality: string
  wikipediaUrl: string
  lastUpdated: string
  gender?: Gender
  weightClass?: string
  imageUrl?: string
  previousRank?: number
  thirdaryScore?: number
  birthDate?: string
  isSenior?: boolean
}

export interface RankingsData {
  lastUpdated: string
  fighters: BoxerRecord[]
  worst?: BoxerRecord[]
  thirdary?: BoxerRecord[]
  thirdaryWorst?: BoxerRecord[]
  sports?: Partial<Record<SportKey, BoxerRecord[]>>
}

export interface WikipediaInfobox {
  total: number | null
  wins: number | null
  kos: number | null
  losses: number | null
  draws: number | null
  nationality: string
}

export interface UpcomingFightEntry {
  boxerName: string
  headline: string
  url: string
  source: string
  publishedAt: string
}

export interface UpcomingFightsData {
  lastUpdated: string
  fights: UpcomingFightEntry[]
}
