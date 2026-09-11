const USER_AGENT = 'MMARankings/1.0 (https://github.com/user/mma; mma-app@example.com)'
const API_URL = 'https://en.wikipedia.org/w/api.php'

import type { SportKey, SportRecord } from './types'

async function fetchJsonWithRetry(url: string, opts: { headers: Record<string, string> }, retries = 5): Promise<{ ok: boolean; status: number; data?: any }> {
  let lastErr: unknown
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, { ...opts, signal: AbortSignal.timeout(45000) })
      if (res.status === 429) {
        await new Promise(r => setTimeout(r, 5000 * attempt))
        continue
      }
      if (!res.ok) return { ok: false, status: res.status }
      const data = await res.json()
      return { ok: true, status: res.status, data }
    } catch (err) {
      lastErr = err
      const isTimeout = err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')
      const msg = err instanceof Error ? err.message : String(err)
      if (isTimeout) console.warn(`[retry ${attempt}/${retries}] fetch timed out after 45s: ${url.slice(0, 90)}...`)
      else console.warn(`[retry ${attempt}/${retries}] fetch failed: ${msg}`)
      await new Promise(r => setTimeout(r, 2000 * attempt))
    }
  }
  throw lastErr
}

export function extractInfobox(wikitext: string, prefixFilter?: string[]): string | null {
  const prefixes = prefixFilter || ['{{Infobox martial artist', '{{Infobox person', '{{Infobox officeholder', '{{Infobox military']
  let bestStart = Infinity
  let bestPrefix = ''
  for (const prefix of prefixes) {
    const start = wikitext.indexOf(prefix)
    if (start < 0) continue
    if (start < bestStart) {
      bestStart = start
      bestPrefix = prefix
    }
  }
  if (bestPrefix === '') return null

  let depth = 0
  for (let i = bestStart; i < wikitext.length; i++) {
    if (wikitext[i] === '{' && wikitext[i + 1] === '{') { depth++; i++ }
    else if (wikitext[i] === '}' && wikitext[i + 1] === '}') {
      depth--
      i++
      if (depth === 0) return wikitext.slice(bestStart, i + 1)
    }
  }
  return null
}

export function stripWikiMarkup(text: string): string {
  return text
    .replace(/\[\[(?:[^\]|]*\|)?([^\]]*)\]\]/g, '$1')
    .replace(/'''/g, '')
    .replace(/''/g, '')
    .replace(/\{\{[^}]*\}\}/g, '')
    .replace(/<ref[^>]*\/>/g, '')
    .replace(/<ref[^>]*>[\s\S]*?<\/ref>/g, '')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

interface ParsedInfobox {
  total: number | null
  wins: number | null
  kos: number | null
  losses: number | null
  draws: number | null
  no_contests: number | null
  nationality: string
  weightClass: string
  image: string
  birthDate: string
  boxWin: number | null
  boxKOWin: number | null
  boxLoss: number | null
  boxKOLoss: number | null
  boxDraw: number | null
  boxNC: number | null
  kickWin: number | null
  kickKOWin: number | null
  kickLoss: number | null
  kickKOLoss: number | null
  kickDraw: number | null
  kickNC: number | null
}

function extractWeightClass(raw: string): string {
  let text = raw
  if (text.includes('{{plainlist')) {
    const inner = text.replace(/^\{\{plainlist\s*\|?/, '').replace(/\}\}$/, '')
    const items = inner.split('*').map(s => s.trim()).filter(Boolean)
    if (items.length > 0) text = items[0]
    else text = ''
  }
  text = text.replace(/<[^>]+>/g, ' ')
  text = text.replace(/\{\{[^}]*\}\}/g, ' ')
  text = text.replace(/\[\[(?:[^\]|]*\|)?([^\]]*)\]\]/g, '$1')
  text = text.replace(/'''/g, '').replace(/''/g, '')
  text = text.replace(/&nbsp;/g, ' ')
  text = text.replace(/\s+/g, ' ').trim()

  const weightClasses: [string, string][] = [
    ['Super heavyweight', 'super heavyweight'],
    ['Light heavyweight', 'light heavyweight'],
    ['Super middleweight', 'super middleweight'],
    ['Super featherweight', 'super featherweight'],
    ['Light welterweight', 'light welterweight'],
    ['Light middleweight', 'light middleweight'],
    ['Featherweight', 'featherweight'],
    ['Cruiserweight', 'cruiserweight'],
    ['Middleweight', 'middleweight'],
    ['Welterweight', 'welterweight'],
    ['Lightweight', 'lightweight'],
    ['Heavyweight', 'heavyweight'],
    ['Bantamweight', 'bantamweight'],
    ['Strawweight', 'strawweight'],
    ['Flyweight', 'flyweight'],
    ['Atomweight', 'atomweight'],
  ]
  const normalized = text.toLowerCase().replace(/[-–]/g, ' ')
  for (const [display, lowerWc] of weightClasses) {
    const idx = normalized.indexOf(lowerWc)
    if (idx !== -1) {
      const before = idx === 0 || normalized[idx - 1] === ' '
      const after = idx + lowerWc.length >= normalized.length || normalized[idx + lowerWc.length] === ' '
      if (before && after) return display
    }
  }
  if (/^\d+(\.\d+)?\s*(kg|lbs?)\s/i.test(text) || /^\d+(\.\d+)?\s*(kg|lbs?)\.?\s*$/i.test(text)) return ''
  const words = text.split(/\s+/).filter(Boolean)
  if (words.length === 1) return words[0]
  if (words.length > 1) return words[0] + ' ' + words[1]
  return ''
}

export function parseParamLine(line: string): Map<string, string> {
  const params = new Map<string, string>()
  const rest = line.startsWith('|') ? line.slice(1) : line
  const paramRegex = /([\w ]+)\s*=\s*/g
  let m: RegExpExecArray | null

  while ((m = paramRegex.exec(rest)) !== null) {
    const key = m[1].trim().toLowerCase().replace(/ /g, '_')
    const valStart = m.index + m[0].length
    let valEnd = rest.length
    let braceDepth = 0
    for (let j = valStart; j < rest.length; j++) {
      if (rest[j] === '{' && rest[j + 1] === '{') { braceDepth++; j++ }
      else if (rest[j] === '}' && rest[j + 1] === '}') { braceDepth--; j++ }
      else if (rest[j] === '|' && braceDepth === 0) {
        const afterPipe = rest.slice(j + 1)
        if (/^[\w ]+=(?:.|$)/.test(afterPipe)) { valEnd = j; break }
      }
    }
    let value = rest.slice(valStart, valEnd).trim()
    if (value.endsWith('|') && !value.includes('{{')) value = value.slice(0, -1).trim()
    if (key && value) params.set(key, value)
  }

  return params
}

const BLOCKED_IMAGES = /Med[\s_]*\d*\.png|Generic_belt_icon\.svg|Olympic[\s_]*rings\.svg|Boxbelt|Medal[\s_]|Ribbon[\s_]|File-icon|Shoulder_mark|Flag[\s_]*of|\bflags?\b|Badge|Logo|Coat_of_arms|Icon/i

function parseImageUrl(rawImage: string): string {
  if (!rawImage) return ''
  let cleaned = rawImage
  const fileMatch = cleaned.match(/\[\[(?:File|Image):([^\]|]+)/i)
  if (fileMatch) {
    cleaned = fileMatch[1]
  } else {
    cleaned = cleaned.replace(/^(?:File|Image):/i, '').replace(/\|.*$/, '').trim()
  }
  const extMatch = cleaned.match(/(.+\.(?:jpg|jpeg|png|gif|svg|webp))/i)
  if (extMatch) cleaned = extMatch[1]
  if (!cleaned) return ''
  if (cleaned.startsWith('<!--') || cleaned.includes('Insert image') || cleaned.includes('only free-content')) return ''
  if (!/\.(jpg|jpeg|png|gif|svg|webp)$/i.test(cleaned)) return ''
  if (BLOCKED_IMAGES.test(cleaned)) return ''
  return `https://en.wikipedia.org/wiki/Special:FilePath/${encodeURIComponent(cleaned.replace(/ /g, '_'))}`
}

function parseWikitextInfobox(wikitext: string): ParsedInfobox {
  const result: ParsedInfobox = {
    total: null,
    wins: null,
    kos: null,
    losses: null,
    draws: null,
    no_contests: null,
    nationality: '',
    weightClass: '',
    image: '',
    birthDate: '',
    boxWin: null,
    boxKOWin: null,
    boxLoss: null,
    boxKOLoss: null,
    boxDraw: null,
    boxNC: null,
    kickWin: null,
    kickKOWin: null,
    kickLoss: null,
    kickKOLoss: null,
    kickDraw: null,
    kickNC: null,
  }

  const infobox = extractInfobox(wikitext)
  const personInfobox = extractInfobox(wikitext, ['{{Infobox person', '{{Infobox officeholder', '{{Infobox military'])

  let rawWeight = ''
  let mmaKowin = 0, mmaSubwin = 0, mmaDecwin = 0
  let mmaKOLoss = 0, mmaSubLoss = 0, mmaDecLoss = 0, mmaDQLoss = 0
  let foundWinFields = false, foundLossFields = false
  let fallbackWin = 0, fallbackLoss = 0, foundFallbackWin = false, foundFallbackLoss = false

  if (infobox) {
    const lines = infobox.split('\n')
    let multiLineKey = ''
    let multiLineValue = ''
    let templateDepth = 0
    let skipMultiLine = false

    for (const line of lines) {
      const rest = line.startsWith('|') ? line.slice(1) : line
      const paramRegex = /([\w ]+)\s*=\s*/g
      let m: RegExpExecArray | null
      skipMultiLine = false

      while ((m = paramRegex.exec(rest)) !== null) {
        const key = m[1].trim().toLowerCase().replace(/ /g, '_')
        const valStart = m.index + m[0].length
        let valEnd = rest.length
        let braceDepth = 0
        for (let j = valStart; j < rest.length; j++) {
          if (rest[j] === '{' && rest[j + 1] === '{') { braceDepth++; j++ }
          else if (rest[j] === '}' && rest[j + 1] === '}') { braceDepth--; j++ }
          else if (rest[j] === '|' && braceDepth === 0) {
            const afterPipe = rest.slice(j + 1)
            if (/^[\w ]+=(?:.|$)/.test(afterPipe)) { valEnd = j; break }
          }
        }
        let value = rest.slice(valStart, valEnd).trim()
        if (value.endsWith('|') && !value.includes('{{')) value = value.slice(0, -1).trim()
        if (key === 'weight' || key === 'weight_class') {
          if (key === 'weight_class' || !rawWeight) rawWeight = value
          if (value.includes('{{') || value.includes('}}')) {
            templateDepth = (value.match(/\{\{/g) || []).length - (value.match(/\}\}/g) || []).length
            if (templateDepth > 0) {
              multiLineKey = key
              multiLineValue = value
              skipMultiLine = true
              continue
            }
          }
        } else {
          value = stripWikiMarkup(value)
        }
        if (key) {
          if (key === 'nationality') {
            if (value && !result.nationality) result.nationality = value
          } else if (key === 'birth_place' || key === 'image') {
            // handled from person infobox
          } else {
            // Numeric or flag fields
            if (key === 'total' || key === 'total_fights') {
              const n = parseInt(value, 10)
              if (!isNaN(n)) result.total = n
            } else if (key === 'mma_kowin') {
              foundWinFields = true
              const n = parseInt(value, 10)
              if (!isNaN(n)) mmaKowin = n
            } else if (key === 'mma_subwin') {
              foundWinFields = true
              const n = parseInt(value, 10)
              if (!isNaN(n)) mmaSubwin = n
            } else if (key === 'mma_decwin') {
              foundWinFields = true
              const n = parseInt(value, 10)
              if (!isNaN(n)) mmaDecwin = n
            } else if (key === 'mma_koloss') {
              foundLossFields = true
              const n = parseInt(value, 10)
              if (!isNaN(n)) mmaKOLoss = n
            } else if (key === 'mma_subloss') {
              foundLossFields = true
              const n = parseInt(value, 10)
              if (!isNaN(n)) mmaSubLoss = n
            } else if (key === 'mma_decloss') {
              foundLossFields = true
              const n = parseInt(value, 10)
              if (!isNaN(n)) mmaDecLoss = n
            } else if (key === 'mma_dqloss') {
              foundLossFields = true
              const n = parseInt(value, 10)
              if (!isNaN(n)) mmaDQLoss = n
            } else if (key === 'mma_draw') {
              foundLossFields = true
              const n = parseInt(value, 10)
              if (!isNaN(n)) result.draws = n
            } else if (key === 'box_win') {
              const n = parseInt(value, 10)
              if (!isNaN(n)) result.boxWin = n
            } else if (key === 'box_kowin') {
              const n = parseInt(value, 10)
              if (!isNaN(n)) result.boxKOWin = n
            } else if (key === 'box_loss') {
              const n = parseInt(value, 10)
              if (!isNaN(n)) result.boxLoss = n
            } else if (key === 'box_koloss') {
              const n = parseInt(value, 10)
              if (!isNaN(n)) result.boxKOLoss = n
            } else if (key === 'box_draw') {
              const n = parseInt(value, 10)
              if (!isNaN(n)) result.boxDraw = n
            } else if (key === 'box_nc') {
              const n = parseInt(value, 10)
              if (!isNaN(n)) result.boxNC = n
            } else if (key === 'kickbox_win') {
              const n = parseInt(value, 10)
              if (!isNaN(n)) result.kickWin = n
            } else if (key === 'kickbox_kowin') {
              const n = parseInt(value, 10)
              if (!isNaN(n)) result.kickKOWin = n
            } else if (key === 'kickbox_loss') {
              const n = parseInt(value, 10)
              if (!isNaN(n)) result.kickLoss = n
            } else if (key === 'kickbox_koloss') {
              const n = parseInt(value, 10)
              if (!isNaN(n)) result.kickKOLoss = n
            } else if (key === 'kickbox_draw') {
              const n = parseInt(value, 10)
              if (!isNaN(n)) result.kickDraw = n
            } else if (key === 'kickbox_nc') {
              const n = parseInt(value, 10)
              if (!isNaN(n)) result.kickNC = n
            } else if (key === 'no_contests' || key === 'nc') {
              const n = parseInt(value, 10)
              if (!isNaN(n)) result.no_contests = n
            } else if (key === 'ko' || key === 'win_by_ko') {
              foundWinFields = true
              const n = parseInt(value, 10)
              if (!isNaN(n)) result.kos = n
            } else if (key === 'mma_win' || key === 'wins') {
              const n = parseInt(value, 10)
              if (!isNaN(n)) { fallbackWin = n; foundFallbackWin = true }
            } else if (key === 'mma_loss' || key === 'losses') {
              const n = parseInt(value, 10)
              if (!isNaN(n)) { fallbackLoss = n; foundFallbackLoss = true }
            }
          }
        }
      }

      if (templateDepth > 0 && (multiLineKey === 'weight' || multiLineKey === 'weight_class') && !skipMultiLine) {
        multiLineValue += '\n' + line
        const opens = (line.match(/\{\{/g) || []).length
        const closes = (line.match(/\}\}/g) || []).length
        templateDepth += opens - closes
        if (templateDepth <= 0) {
          if (multiLineKey === 'weight' || multiLineKey === 'weight_class') {
            rawWeight = multiLineValue
          }
          templateDepth = 0
          multiLineKey = ''
        }
      }
    }
  }

  // Compute totals from mma_* breakdowns
  const mmaTotalWins = mmaKowin + mmaSubwin + mmaDecwin
  if (foundWinFields) {
    result.wins = mmaTotalWins > 0 ? mmaTotalWins : (foundFallbackWin ? fallbackWin : 0)
    result.kos = mmaKowin
  } else if (foundFallbackWin) {
    result.wins = fallbackWin
  }
  const mmaTotalLosses = mmaKOLoss + mmaSubLoss + mmaDecLoss + mmaDQLoss
  if (foundLossFields) {
    result.losses = mmaTotalLosses > 0 ? mmaTotalLosses : (foundFallbackLoss ? fallbackLoss : 0)
  } else if (foundFallbackLoss) {
    result.losses = fallbackLoss
  }

  // Try to extract person infobox for image/nationality/birth date (person-first to avoid embed=yes martial artist modules)
  const personInfo = extractInfobox(wikitext, ['{{Infobox person', '{{Infobox officeholder', '{{Infobox military', '{{Infobox martial artist', '{{Infobox boxer', '{{Infobox sportsperson', '{{Infobox wrestler', '{{Infobox amateur wrestler', '{{Infobox sumo wrestler', '{{Infobox professional wrestler'])
  if (personInfo) {
    const lines = personInfo.split('\n')
    for (const line of lines) {
      const params = parseParamLine(line)
      if (!result.image) {
        const rawImage = params.get('image')
        if (rawImage) {
          const url = parseImageUrl(rawImage)
          if (url) result.image = url
        }
      }
      if (!result.birthDate) {
        const rawBirthDate = params.get('birth_date')
        if (rawBirthDate) {
          const fullDateMatch = rawBirthDate.match(/\{\{birth date[^|]*\|(\d{4})\|(\d{1,2})\|(\d{1,2})/)
          if (fullDateMatch) {
            result.birthDate = `${fullDateMatch[1]}-${fullDateMatch[2].padStart(2, '0')}-${fullDateMatch[3].padStart(2, '0')}`
          } else {
            const yearMatch = rawBirthDate.match(/(\d{4})/)
            if (yearMatch) result.birthDate = yearMatch[1]
          }
        }
      }
      if (!result.nationality) {
        const nat = params.get('nationality')
        const birthPlace = params.get('birth_place')
        if (nat) {
          result.nationality = stripWikiMarkup(nat)
        } else if (birthPlace) {
          const cleaned = stripWikiMarkup(birthPlace)
          const parts = cleaned.split(',').map(s => s.trim()).filter(Boolean)
          result.nationality = parts[parts.length - 1] || ''
        }
      }
    }
  }

  result.weightClass = extractWeightClass(rawWeight)

  return result
}

export interface BoxerStats {
  total: number | null
  wins: number | null
  kos: number | null
  losses: number | null
  draws: number
  nationality: string
  weightClass: string
  imageUrl: string
  birthDate: string
  qualityWins: number
  sportRecords: Partial<Record<SportKey, SportRecord>>
}

const SPORT_KEYWORDS: { key: SportKey; pattern: RegExp }[] = [
  { key: 'muayThai', pattern: /muay\s*thai|muay\b/i },
  { key: 'lethwei', pattern: /lethwei/i },
  { key: 'kunKhmer', pattern: /kun\s*khmer|pradal\s*serey/i },
  { key: 'sanshou', pattern: /sanshou|san\s*shou|sanda|san\s*da\b|wushu/i },
  { key: 'sanda', pattern: /sanda|san\s*da\b|wushu|sanshou|san\s*shou/i },
  { key: 'kickboxing', pattern: /kick\s*-?\s*box|full\s*[- ]?contact\s+karate/i },
  { key: 'karate', pattern: /karate|kyokushin|knockdown\s*karate/i },
  { key: 'taekwondo', pattern: /taekwondo|t[aá]e?\s*kwon/i },
  { key: 'savate', pattern: /savate|boxe\s*fran[cç]aise/i },
  { key: 'capoeira', pattern: /capoeira/i },
  { key: 'sumo', pattern: /sumo(?:\s*wrestling|\s*record)?\b|rikishi|\bbasho\b/i },
  { key: 'mongolianWrestling', pattern: /mongolian\s*wrestling|bökh|bukh\s*wrestling/i },
  { key: 'grecoRomanWrestling', pattern: /greco[\s-]*roman/i },
  { key: 'catchWrestling', pattern: /catch\s*wrestling|catch\s*wrestl/i },
  { key: 'freestyleWrestling', pattern: /freestyle\s*wrestling|freestyle|international\s*wrestling|olympic\s*wrestling/i },
  { key: 'ncaaWrestling', pattern: /ncaa|collegiate|folkstyle|folk\s*style|amateur\s*wrestling|varsity\s*wrestling/i },
  { key: 'brazilianJiuJitsu', pattern: /jiu[\s-]?jitsu|jujitsu|bjj|brazilian\s*jiu|submission\s*grappling|\bgrappling\b/i },
  { key: 'submissionWrestling', pattern: /submission\s*wrestling/i },
  { key: 'judo', pattern: /judo/i },
  { key: 'sambo', pattern: /sambo|combat\s*sambo/i },
  { key: 'lutaLivre', pattern: /luta[\s-]?livre/i },
  { key: 'bareKnuckle', pattern: /bare[- ]?knuckle/i },
  { key: 'boxing', pattern: /boxing|boxe\b|prizefight/i },
]

export function detectSport(label: string): SportKey | null {
  for (const { key, pattern } of SPORT_KEYWORDS) {
    if (pattern.test(label)) return key
  }
  return null
}

function emptySportRecord(): SportRecord {
  return { wins: 0, kos: 0, losses: 0, draws: 0, noContests: 0 }
}

export function parseRecordSummary(value: string): SportRecord | null {
  const text = value.replace(/'''/g, '').replace(/[’`]/g, "'").trim()
  if (!/win/i.test(text)) return null

  const rec = emptySportRecord()
  let found = false

  const winMatch = text.match(/(\d+)\s*(?:\([^)]*\))?\s*(?:win)/i)
  const lossMatch = text.match(/(\d+)\s*(?:\([^)]*\))?\s*(?:loss)/i)
  const drawMatch = text.match(/(\d+)\s*(?:\([^)]*\))?\s*(?:draw)/i)
  if (winMatch) { rec.wins = parseInt(winMatch[1], 10); found = true }
  if (lossMatch) { rec.losses = parseInt(lossMatch[1], 10); found = true }
  if (drawMatch) { rec.draws = parseInt(drawMatch[1], 10); found = true }
  const ncMatch = text.match(/(\d+)\s*(?:no\s*contests?|NC\b)/i)
  if (ncMatch) { rec.noContests = parseInt(ncMatch[1], 10); found = true }

  const koMatches = [...text.matchAll(/(\d+)\s*(?:\(T\)KO|TKO|KO)/gi)]
  if (koMatches.length > 0) {
    rec.kos = parseInt(koMatches[0][1], 10)
    found = true
  }

  return found ? rec : null
}

function parseRecordSummaryForSport(value: string, prefer: SportKey | null): SportRecord | null {
  if (!prefer) return parseRecordSummary(value)
  const text = value.replace(/'''/g, '').replace(/['']/g, "'").trim()

  const segments = text.split(/<br\s*\/?>\s*\|?\s*|\|\s*/i).map(s => s.trim()).filter(Boolean)
  if (segments.length <= 1) return parseRecordSummary(value)

  for (const seg of segments) {
    if (detectSport(seg) === prefer) return parseRecordSummary(seg)
  }
  return parseRecordSummary(value)
}

function parseRecordRow(row: string): { result: 'win' | 'loss' | 'draw' | 'nc'; method: string } | null {
  // Drop leftover row-separator attributes (e.g. the tail of `|-  style="..."`)
  const cleaned = row.replace(/^[^\n]*\n/, '').trim()
  if (!cleaned) return null

  // Cells may be split across lines (`\n| Win\n| Method`) or packed with `||`
  // on one line (BoxRec-style: `| 2015-10-31 || Loss || ...`). Handle both.
  const parts = cleaned.split(/\n\|/)
  if (parts.length > 0 && parts[0].trim() === '') parts.shift()
  const cells: string[] = []
  for (const part of parts) {
    for (const seg of part.split('||')) {
      const cell = stripInline(seg)
      if (cell) cells.push(cell)
    }
  }
  if (cells.length === 0) return null

  // Result word sits in the first cell (multi-line tables) or the second
  // (BoxRec `date || Result || Opponent ...` rows).
  let result: 'win' | 'loss' | 'draw' | 'nc' | null = null
  let resultCell = -1
  for (let i = 0; i < Math.min(cells.length, 4); i++) {
    const c = cells[i]
    if (/\bWin\b/i.test(c)) { result = 'win'; resultCell = i; break }
    else if (/\bLoss(es)?\b/i.test(c)) { result = 'loss'; resultCell = i; break }
    else if (/\bDraw\b/i.test(c)) { result = 'draw'; resultCell = i; break }
    else if (/\bNC\b/i.test(c)) { result = 'nc'; resultCell = i; break }
  }
  if (!result) return null

  let method = ''
  for (let i = resultCell + 1; i < cells.length; i++) {
    if (/TKO|\bKO\b|submission|sub\(/i.test(cells[i])) { method = cells[i]; break }
  }
  return { result, method }
}

function stripInline(text: string): string {
  return stripWikiMarkup(text).replace(/^\|/, '').trim()
}

function countTableRows(tableBody: string): SportRecord | null {
  const rec = emptySportRecord()
  const rows = tableBody.split(/\n\|-/)
  let foundRows = false
  let counted = false

  for (const rawRow of rows) {
    const row = rawRow.trim()
    if (!row || !/\|/.test(row)) continue
    const parsed = parseRecordRow(row)
    if (!parsed) continue
    foundRows = true
    if (parsed.result === 'win') {
      rec.wins++
      if (/TKO|\bKO\b/i.test(parsed.method)) rec.kos++
      counted = true
    } else if (parsed.result === 'loss') {
      rec.losses++
      counted = true
    } else if (parsed.result === 'draw') {
      rec.draws++
      counted = true
    } else if (parsed.result === 'nc') {
      rec.noContests++
      counted = true
    }
  }

  return foundRows && counted ? rec : null
}

export function parseBespokeBlock(block: string): SportRecord | null {
  const rec = emptySportRecord()
  const rows = block.split(/\n\|-/)
  let found = false

  for (const rawRow of rows) {
    const row = rawRow.trim()
    if (!row) continue
    let cells = row.split(/\n\|/)
    if (cells.length > 0 && cells[0].trim() === '') cells.shift()
    cells = cells.map(c => stripInline(c)).filter(Boolean)
    if (cells.length === 0) continue

    let result: 'win' | 'loss' | 'draw' | 'nc' | null = null
    for (const cell of cells) {
      if (/\bWin\b/i.test(cell)) { result = 'win'; break }
      if (/\bLoss(es)?\b/i.test(cell)) { result = 'loss'; break }
      if (/\bDraw\b/i.test(cell)) { result = 'draw'; break }
      if (/\bNC\b/i.test(cell)) { result = 'nc'; break }
    }
    if (!result) continue

    if (result === 'win') {
      rec.wins++
      if (cells.some(c => /TKO|\bKO\b/i.test(c))) rec.kos++
    } else if (result === 'loss') {
      rec.losses++
    } else if (result === 'draw') {
      rec.draws++
    } else if (result === 'nc') {
      rec.noContests++
    }
    found = true
  }

  return found ? rec : null
}

interface RecordTableMatch {
  sport: SportKey | null
  sectionSport: SportKey | null
  block: string
  title: string
  recordSummary: string
  index: number
}

function parseSumoRecordBox(wikitext: string): SportRecord | null {
  const rec = emptySportRecord()
  const found = false
  const startRegex = /\{\{\s*Sumo\s+record\s+box\s+start/gi
  const endRegex = /\{\{\s*Sumo\s+record\s+box\s+end/gi
  const rowRegex = /\{\{\s*Basho\s*\|([^}]+)\}\}/g
  let sm: RegExpExecArray | null
  let anyRows = false
  while ((sm = startRegex.exec(wikitext)) !== null) {
    const startIndex = sm.index
    endRegex.lastIndex = startIndex
    const em = endRegex.exec(wikitext)
    const endIndex = em ? em.index : wikitext.length
    const block = wikitext.slice(startIndex, endIndex)
    rowRegex.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = rowRegex.exec(block)) !== null) {
      const args = m[1].split('|').map(a => a.trim())
      if (args.length < 5) continue
      if (/^(KYUJO|MAEZUMOU|SHINJO|ATSUDORI)$/i.test(args[0])) continue
      const wins = parseInt(args[3], 10)
      const losses = parseInt(args[4], 10)
      if (isNaN(wins) || isNaN(losses)) continue
      rec.wins += wins
      rec.losses += losses
      anyRows = true
    }
    startRegex.lastIndex = endIndex
  }
  return anyRows ? { ...rec, kos: 0 } : null
}

const MONGOLIAN_ROW_REGEX = /\{\{\s*Mongolian\s+Wrestling\s+Record\s*\|([^}]+)\}\}/g
const MONGOLIAN_START_REGEX = /\{\{\s*Mongolian\s+Wrestling\s+Record\/Start/gi
const MONGOLIAN_END_REGEX = /\{\{\s*Mongolian\s+Wrestling\s+Record\/End/gi

function parseMongolianWrestlingRecord(wikitext: string): SportRecord | null {
  const rec = emptySportRecord()
  let anyRows = false
  let sm: RegExpExecArray | null
  while ((sm = MONGOLIAN_START_REGEX.exec(wikitext)) !== null) {
    const startIndex = sm.index
    MONGOLIAN_END_REGEX.lastIndex = startIndex
    const em = MONGOLIAN_END_REGEX.exec(wikitext)
    const endIndex = em ? em.index : wikitext.length
    const block = wikitext.slice(startIndex, endIndex)
    MONGOLIAN_ROW_REGEX.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = MONGOLIAN_ROW_REGEX.exec(block)) !== null) {
      const args = m[1].split('|').map(a => a.trim())
      if (args.length < 5) continue
      if (args[0] === 'Start' || args[0].startsWith('/')) continue
      const wins = parseInt(args[4], 10)
      const losses = parseInt(args[args.length - 1], 10)
      if (isNaN(wins) || isNaN(losses)) continue
      rec.wins += wins
      rec.losses += losses
      anyRows = true
    }
    MONGOLIAN_START_REGEX.lastIndex = endIndex
  }
  return anyRows ? { ...rec, kos: 0 } : null
}

export function findRecordTables(wikitext: string): RecordTableMatch[] {
  const matches: RecordTableMatch[] = []
  const headerRegex = /\n={2,}[^=\n]+={2,}/g
  const headers: { index: number; title: string }[] = []
  let hm: RegExpExecArray | null
  while ((hm = headerRegex.exec(wikitext)) !== null) {
    headers.push({
      index: hm.index,
      title: hm[0].replace(/={2,}/g, '').trim(),
    })
  }

  const tableRegex = /\{\{(Fight|Kickboxing|MMA)\s*record\s*start([\s\S]*?)\}\}/gi
  // Single-sport page fallback: derive the sport from the {{Infobox martial artist}}
  // style/sport params, used only when a page has exactly one record table that
  // carries no sport signal of its own (e.g. a generic "Fight record" heading).
  const styleSport = (() => {
    const martialInfobox = extractInfobox(wikitext, ['{{Infobox martial artist'])
    if (!martialInfobox) return null
    for (const line of martialInfobox.split('\n')) {
      const v = parseParamLine(line).get('style') ?? parseParamLine(line).get('sport')
      if (!v) continue
      const detected = detectSport(stripWikiMarkup(v))
      if (detected) return detected
    }
    return null
  })()
  const hasMmaSignal = /\bmma\b|mixed\s+martial\s+arts|\bufc\b/i.test(wikitext)

  let m: RegExpExecArray | null
  while ((m = tableRegex.exec(wikitext)) !== null) {
    const blockText = m[2]
    const mIndex = m.index
    let title = ''
    const titleMatch = blockText.match(/\|title\s*=\s*([^|\n]*)/i)
    if (titleMatch) title = stripWikiMarkup(titleMatch[1]).trim()

    let recordSummary = ''
    const recMatch = blockText.match(/\|record\s*=\s*([^\n]+)/i)
    if (recMatch && recMatch[1].trim()) recordSummary = recMatch[1].replace(/\|\s*$/, '').trim()

    let sport = detectSport(title)
    const sectionHeader = headers.filter(h => h.index < mIndex).slice(-1)[0]
    const sectionSport = sectionHeader ? detectSport(sectionHeader.title) : null
    if (!sport) {
      if (sectionHeader) sport = sectionSport
    }
    if (!sport) {
      // Combined "Kickboxing / Muay Thai record" style titles: blacklist MMA-only sections
      if (!/\bmixed martial arts record\b/i.test(title)) {
        sport = detectSport(title.replace(/record\b/gi, '')) ?? null
      }
    }

    // Skip amateur / exhibition / invitational record tables — rankings need professional records
    if (/\b(amateur|exhibition|invitational)\b/i.test(title)) continue

    matches.push({ index: m.index, sport, sectionSport, block: blockText, title, recordSummary })
  }

  // Single, sport-unresolved record table on a non-MMA page: attribute it to the
  // infobox's declared style (e.g. a Kun Khmer fighter whose page is entirely Kun
  // Khmer but whose table just says generic "Fight record").
  if (matches.length === 1 && !matches[0].sport && styleSport && !hasMmaSignal) {
    matches[0].sport = styleSport
  }

  return matches
}

export function extractSportRecords(wikitext: string): Partial<Record<SportKey, SportRecord>> {
  const out: Partial<Record<SportKey, SportRecord>> = {}

  function addRecord(key: SportKey | null, rec: SportRecord | null) {
    if (!key || !rec) return
    if (rec.wins + rec.losses + rec.draws + rec.noContests <= 0) return
    const existing = out[key]
    if (!existing) {
      out[key] = { ...rec }
      return
    }
    const recTotal = rec.wins + rec.losses
    const existingTotal = existing.wins + existing.losses
    if (recTotal > existingTotal) out[key] = { ...rec }
  }

  // 1. Infobox boxer
  if (/^\{\{Infobox boxer/i.test(wikitext.trim())) {
    const infobox = extractInfobox(wikitext, ['{{Infobox boxer'])
    if (infobox) {
      const params = infobox.split('\n')
      let wins: number | null = null
      let losses: number | null = null
      let draws: number | null = null
      let nc: number | null = null
      let kos: number | null = null
      for (const line of params) {
        const parsed = parseParamLine(line)
        const w = parsed.get('wins')
        const l = parsed.get('losses')
        const d = parsed.get('draws')
        const ncRaw = parsed.get('no_contests') ?? parsed.get('nc')
        const koRaw = parsed.get('ko') ?? parsed.get('KOs')
        if (w) { const n = parseInt(stripWikiMarkup(w), 10); if (!isNaN(n)) wins = n }
        if (l) { const n = parseInt(stripWikiMarkup(l), 10); if (!isNaN(n)) losses = n }
        if (d) { const n = parseInt(stripWikiMarkup(d), 10); if (!isNaN(n)) draws = n }
        if (ncRaw) { const n = parseInt(stripWikiMarkup(ncRaw), 10); if (!isNaN(n)) nc = n }
        if (koRaw) { const n = parseInt(stripWikiMarkup(koRaw), 10); if (!isNaN(n)) kos = n }
      }
      if (wins !== null && losses !== null) {
        const hasBareKnuckleRecord =
          /bare[- ]?knuckle(?:(?!muay\s*thai).){0,160}\brecord\b|\brecord\b(?:(?!muay\s*thai).){0,160}bare[- ]?knuckle/i.test(wikitext)
        const mentionsBareKnuckleMuayThai = /bare[- ]?knuckle(?:\s+boxing)?\s+muay\s*thai|bkmt\b/i.test(wikitext)
        addRecord(hasBareKnuckleRecord && !mentionsBareKnuckleMuayThai ? 'bareKnuckle' : 'boxing', {
          wins,
          kos: kos ?? 0,
          losses,
          draws: draws ?? 0,
          noContests: nc ?? 0,
        })
      }
    }
  }

  // 2. Infobox martial artist breakdowns
  const martial = extractInfobox(wikitext)
  if (martial) {
    const paramKeys = martial.split('\n').map(l => parseParamLine(l))
    const get = (key: string): number | null => {
      for (const p of paramKeys) {
        const v = p.get(key)
        if (v) {
          const n = parseInt(stripWikiMarkup(v), 10)
          if (!isNaN(n)) return n
        }
      }
      return null
    }
    const boxWin = get('box_win')
    const boxLoss = get('box_loss')
    if (boxWin !== null && boxLoss !== null) {
      addRecord('boxing', {
        wins: boxWin,
        kos: get('box_kowin') ?? 0,
        losses: boxLoss,
        draws: get('box_draw') ?? 0,
        noContests: get('box_nc') ?? 0,
      })
    }
    const kickWin = get('kickbox_win')
    const kickLoss = get('kickbox_loss')
    if (kickWin !== null && kickLoss !== null) {
      addRecord('kickboxing', {
        wins: kickWin,
        kos: get('kickbox_kowin') ?? 0,
        losses: kickLoss,
        draws: get('kickbox_draw') ?? 0,
        noContests: get('kickbox_nc') ?? 0,
      })
    }
  }

  // 3. Record tables (Fight / Kickboxing / MMA record start)
  const tables = findRecordTables(wikitext)
  const combinedCandidates: RecordTableMatch[] = []
  for (const table of tables) {
    let rec = parseRecordSummaryForSport(table.recordSummary, table.sport)
    if (!rec && table.sport) {
      // Row-count fallback: inspect the wikitext between this table's opening
      // template and the next section header / {{end}}
      const startIdx = table.index
      const openEnd = wikitext.indexOf('}}', startIdx)
      const bodyStart = openEnd + 2
      const endOfSection = wikitext.indexOf('\n=', bodyStart)
      const endOfTable = wikitext.indexOf('{{end}}', bodyStart)
      const candidates: number[] = []
      if (endOfSection > -1) candidates.push(endOfSection)
      if (endOfTable > -1) candidates.push(endOfTable)
      const bodyEnd = candidates.length > 0 ? Math.min(...candidates) : wikitext.length
      const body = wikitext.slice(bodyStart, bodyEnd)
      rec = countTableRows(body)
    }
    addRecord(table.sport, rec)
    if (
      rec && table.sectionSport && table.sport &&
      table.sectionSport !== table.sport &&
      table.sectionSport === 'muayThai'
    ) {
      combinedCandidates.push(table)
    }
  }

  // Combined-record sections (e.g. "Muay Thai and kickboxing record"): when a fighter's
  // only record table in such a section is titled generically, attribute it to the section
  // sport too — but only if they have no dedicated table for that sport already.
  for (const table of combinedCandidates) {
    if (out[table.sectionSport!]) continue
    const rec = parseRecordSummaryForSport(table.recordSummary, table.sectionSport)
    if (rec) addRecord(table.sectionSport, rec)
  }

  // 4. Bespoke tables (freestyle wrestling, judo, karate, grappling, sanda, etc.)
  const allHeaders: { start: number; contentStart: number; title: string }[] = []
  const headerRegex2 = /\n={2,}([^=\n]+)={2,}/g
  let h2: RegExpExecArray | null
  while ((h2 = headerRegex2.exec(wikitext)) !== null) {
    allHeaders.push({ start: h2.index, contentStart: h2.index + h2[0].length, title: h2[1].trim() })
  }
  for (let i = 0; i < allHeaders.length; i++) {
    const h = allHeaders[i]
    const sport = detectSport(h.title)
    if (!sport) continue
    // Skip amateur/exhibition headers for professional-combat sports
    const PRO_SPORTS: SportKey[] = ['kickboxing', 'muayThai', 'boxing', 'sanda', 'sanshou', 'savate', 'taekwondo']
    if (PRO_SPORTS.includes(sport) && /\b(amateur|exhibition|invitational)\b/i.test(h.title)) continue
    const nextHeader = allHeaders.slice(i + 1).find(n => n.contentStart > h.contentStart)
    const nextIndex = nextHeader ? nextHeader.start : wikitext.length
    const slice = wikitext.slice(h.contentStart, nextIndex)
    const tableBlocks: string[] = []
    const sStartRegex = /\{\{s-start\b([\s\S]*?)(?:\{\{s-end\}\}|\{\{end\}\})/g
    let sm2: RegExpExecArray | null
    while ((sm2 = sStartRegex.exec(slice)) !== null) tableBlocks.push(sm2[1])
    const wtRegex = /\{\|\s*[\s\S]*?(?:\{\{[sS]-end\}\}|\n\|\})/g
    let sm3: RegExpExecArray | null
    while ((sm3 = wtRegex.exec(slice)) !== null) tableBlocks.push(sm3[0])
    for (const block of tableBlocks) {
      const rec = parseBespokeBlock(block)
      addRecord(sport, rec)
    }
  }

  // 5. Sumo record box ({{Sumo record box start}}...{{Sumo record box end}})
  addRecord('sumo', parseSumoRecordBox(wikitext))

  // 6. Mongolian wrestling record ({{Mongolian Wrestling Record/Start}}...{{Mongolian Wrestling Record/End}})
  addRecord('mongolianWrestling', parseMongolianWrestlingRecord(wikitext))

  return out
}

function countQualityWins(wikitext: string): number {
  const recordHeader = wikitext.match(/={2,}\s*(Professional\s+)?(Mixed martial arts\s+)?record\s*={2,}/i)
  if (!recordHeader) return 0

  const headerEnd = recordHeader.index! + recordHeader[0].length
  const remaining = wikitext.slice(headerEnd)
  const endMatch = remaining.match(/\n={2,}\s*[A-Z]/)
  const endIndex = endMatch && endMatch.index !== undefined ? headerEnd + endMatch.index : wikitext.length
  const section = wikitext.slice(headerEnd, endIndex)

  const rows = section.split(/\n\|-/)

  let qualityWins = 0
  for (const row of rows) {
    if (!/\bWin\b/i.test(row)) continue
    const cells = row.split(/\n\|/).map(c => c.trim()).filter(Boolean)
    const opponentCell = cells[2] || ''
    if (/\[\[.+?\]\]/.test(opponentCell)) qualityWins++
  }
  return qualityWins
}

export function processRecord(wikitext: string): BoxerStats | null {
  const infobox = parseWikitextInfobox(wikitext)
  const sportRecords = extractSportRecords(wikitext)

  let imageUrl = infobox.image
  if (!imageUrl) {
    const fileMatches = wikitext.matchAll(/\[\[(?:File|Image):([^\]|]+)/gi)
    for (const m of fileMatches) {
      const candidate = parseImageUrl(m[1])
      if (candidate) { imageUrl = candidate; break }
    }
  }

  if (infobox.wins === null || infobox.losses === null) {
    return {
      total: null,
      wins: null,
      kos: infobox.kos ?? 0,
      losses: null,
      draws: infobox.draws ?? 0,
      nationality: infobox.nationality,
      weightClass: infobox.weightClass,
      imageUrl,
      birthDate: infobox.birthDate,
      qualityWins: 0,
      sportRecords,
    }
  }

  const wins = infobox.wins
  const losses = infobox.losses
  const draws = infobox.draws ?? 0
  const noContests = infobox.no_contests ?? 0
  let total = infobox.total
  if (total === null) total = wins + losses + draws + noContests

  return {
    total,
    wins,
    kos: infobox.kos ?? 0,
    losses,
    draws,
    nationality: infobox.nationality,
    weightClass: infobox.weightClass,
    imageUrl,
    birthDate: infobox.birthDate,
    qualityWins: countQualityWins(wikitext),
    sportRecords,
  }
}

export async function fetchBoxerRecord(name: string): Promise<BoxerStats | null> {
  const wikitext = await fetchPageWikitext(name)
  if (!wikitext) return null
  return processRecord(wikitext)
}

async function fetchPageWikitext(title: string): Promise<string | null> {
  const params = new URLSearchParams({
    action: 'query',
    prop: 'revisions',
    rvprop: 'content',
    format: 'json',
    origin: '*',
    titles: title,
  })

  const url = `${API_URL}?${params.toString()}`
  let res: Response
  try {
    res = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT },
      signal: AbortSignal.timeout(45000),
    })
  } catch {
    await new Promise(r => setTimeout(r, 5000))
    res = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT },
      signal: AbortSignal.timeout(45000),
    })
  }

  if (res.status === 404) return null
  if (res.status === 429) {
    await new Promise(r => setTimeout(r, 2000))
    return fetchPageWikitext(title)
  }
  if (!res.ok) return null

  const data = await res.json() as any
  const pages = data?.query?.pages ?? {}
  const page = Object.values(pages)[0] as any
  if (!page?.revisions?.[0]?.['*']) return null
  return page.revisions[0]['*']
}

export async function fetchBoxerRecords(titles: string[]): Promise<Map<string, BoxerStats | null>> {
  const results = new Map<string, BoxerStats | null>()

  for (let i = 0; i < titles.length; i += 50) {
    const batch = titles.slice(i, i + 50)
    const params = new URLSearchParams({
      action: 'query',
      prop: 'revisions',
      rvprop: 'content',
      format: 'json',
      origin: '*',
      titles: batch.join('|'),
    })

    const url = `${API_URL}?${params.toString()}`
    const { ok, data } = await fetchJsonWithRetry(url, { headers: { 'User-Agent': USER_AGENT } })

    if (!ok) {
      console.warn(`[fetchBoxerRecords] batch failed (${titles.length}); dropping ${batch.length} pages, e.g. ${batch.slice(0, 3).join(' | ')}`)
      for (const title of batch) results.set(title, null)
      continue
    }

    const pages = data?.query?.pages ?? {}

    for (const [pid, page] of Object.entries(pages)) {
      const p = page as any
      if (pid === '-1') {
        console.warn(`[fetchBoxerRecords] page not found in batch: ${(page as any)?.title ?? 'unknown'}`)
        continue
      }
      const title = p.title as string
      const wikitext = p?.revisions?.[0]?.['*']
      if (!wikitext) {
        console.warn(`[fetchBoxerRecords] no wikitext for ${title}`)
        results.set(title, null)
      } else {
        results.set(title, processRecord(wikitext))
      }
    }

    for (const title of batch) {
      if (!results.has(title)) results.set(title, null)
    }

    // Fallback: fetch pageimages for fighters with no imageUrl
    const missingImage = batch.filter(t => {
      const r = results.get(t)
      return r && !r.imageUrl
    })
    if (missingImage.length > 0) {
      try {
        const imgParams = new URLSearchParams({
          action: 'query',
          prop: 'pageimages',
          piprop: 'thumbnail',
          pithumbsize: '300',
          titles: missingImage.join('|'),
          format: 'json',
          origin: '*',
        })
        const imgRes = await fetch(`${API_URL}?${imgParams.toString()}`, {
          headers: { 'User-Agent': USER_AGENT },
          signal: AbortSignal.timeout(30000),
        })
        if (imgRes.ok) {
          const imgData = await imgRes.json() as any
          const imgPages = imgData?.query?.pages ?? {}
          for (const [, p] of Object.entries(imgPages) as any[]) {
            if (p.title && p.thumbnail?.source) {
              const existing = results.get(p.title)
              if (existing && !existing.imageUrl) {
                results.set(p.title, { ...existing, imageUrl: p.thumbnail.source })
              }
            }
          }
        }
      } catch { }
    }

    // Validate imageUrls: check for broken/nonexistent files, clear so pageimages can retry
    const urlsToCheck = batch
      .map(t => ({ name: t, url: results.get(t)?.imageUrl }))
      .filter((x): x is { name: string; url: string } => !!x.url)
    if (urlsToCheck.length > 0) {
      try {
        const titleToEntry = new Map<string, { name: string; url: string }>()
        const fileTitles = urlsToCheck.map(({ name, url }) => {
          const match = url.match(/Special:FilePath\/(.+)$/)
          if (!match) return null
          const title = `File:${decodeURIComponent(match[1]).replace(/_/g, ' ')}`
          titleToEntry.set(title, { name, url })
          return title
        }).filter(Boolean) as string[]

        if (fileTitles.length > 0) {
          const checkParams = new URLSearchParams({
            action: 'query', prop: 'imageinfo', iiprop: 'size',
            titles: fileTitles.join('|'), format: 'json', origin: '*',
          })
          const checkRes = await fetch(`${API_URL}?${checkParams}`, { headers: { 'User-Agent': USER_AGENT }, signal: AbortSignal.timeout(30000) })
          if (checkRes.ok) {
            const checkData = await checkRes.json() as any
            const existingTitles = new Set<string>()
            for (const [, page] of Object.entries(checkData?.query?.pages ?? {}) as any[]) {
              if (page?.imageinfo?.[0]?.width) existingTitles.add(page.title)
            }
            const broken: string[] = []
            for (const [title, { name, url }] of titleToEntry) {
              if (!existingTitles.has(title)) {
                const r = results.get(name)
                if (r) { results.set(name, { ...r, imageUrl: '' }); broken.push(name) }
              }
            }
            // Retry broken ones via pageimages
            if (broken.length > 0) {
              const retryParams = new URLSearchParams({
                action: 'query', prop: 'pageimages', piprop: 'thumbnail', pithumbsize: '300',
                titles: broken.join('|'), format: 'json', origin: '*',
              })
              const retryRes = await fetch(`${API_URL}?${retryParams}`, { headers: { 'User-Agent': USER_AGENT }, signal: AbortSignal.timeout(30000) })
              if (retryRes.ok) {
                const retryData = await retryRes.json() as any
                for (const [, p] of Object.entries(retryData?.query?.pages ?? {}) as any[]) {
                  if (p.title && p.thumbnail?.source) {
                    const existing = results.get(p.title)
                    if (existing && !existing.imageUrl) results.set(p.title, { ...existing, imageUrl: p.thumbnail.source })
                  }
                }
              }
            }
          }
        }
      } catch { }
    }

    await new Promise(r => setTimeout(r, 200))
  }

  return results
}

export async function checkImageSizes(imageUrls: string[]): Promise<Map<string, number>> {
  const sizeMap = new Map<string, number>()
  if (imageUrls.length === 0) return sizeMap

  for (let i = 0; i < imageUrls.length; i += 50) {
    const batch = imageUrls.slice(i, i + 50)
    const titleToUrl = new Map<string, string>()
    const fileTitles = batch.map(url => {
      const match = url.match(/Special:FilePath\/(.+)$/)
      if (!match) return null
      const title = `File:${decodeURIComponent(match[1]).replace(/_/g, ' ')}`
      titleToUrl.set(title, url)
      return title
    }).filter(Boolean) as string[]

    if (fileTitles.length === 0) continue

    const params = new URLSearchParams({
      action: 'query',
      prop: 'imageinfo',
      iiprop: 'size',
      titles: fileTitles.join('|'),
      format: 'json',
      origin: '*',
    })

    const url = `${API_URL}?${params.toString()}`
    try {
      const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT }, signal: AbortSignal.timeout(30000) })
      if (!res.ok) continue
      const data = await res.json() as any
      const pages = data?.query?.pages ?? {}

      for (const [, page] of Object.entries(pages) as any[]) {
        const info = page?.imageinfo?.[0]
        if (info && info.width) {
          const originalUrl = titleToUrl.get(page.title)
          if (originalUrl) {
            sizeMap.set(originalUrl, info.width)
          }
        }
      }
    } catch { }

    await new Promise(r => setTimeout(r, 200))
  }

  return sizeMap
}

