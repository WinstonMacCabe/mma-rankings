const USER_AGENT = 'MMARankings/1.0 (https://github.com/user/mma; mma-app@example.com)'
const API_URL = 'https://en.wikipedia.org/w/api.php'

function extractInfobox(wikitext: string, prefixFilter?: string[]): string | null {
  const prefixes = prefixFilter || ['{{Infobox martial artist', '{{Infobox person', '{{Infobox officeholder', '{{Infobox military']
  for (const prefix of prefixes) {
    const start = wikitext.indexOf(prefix)
    if (start < 0) continue

    let depth = 0
    for (let i = start; i < wikitext.length; i++) {
      if (wikitext[i] === '{' && wikitext[i + 1] === '{') { depth++; i++ }
      else if (wikitext[i] === '}' && wikitext[i + 1] === '}') {
        depth--
        i++
        if (depth === 0) return wikitext.slice(start, i + 1)
      }
    }
  }
  return null
}

function stripWikiMarkup(text: string): string {
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

function parseParamLine(line: string): Map<string, string> {
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

const BLOCKED_IMAGES = /Med[\s_]*\d*\.png|Generic_belt_icon\.svg|Olympic[\s_]*rings\.svg|Boxbelt|Medal[\s_]|Ribbon[\s_]|File-icon|Shoulder_mark|Flag_of|Badge|Logo|Coat_of_arms|Icon/i

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
    result.wins = mmaTotalWins
    result.kos = mmaKowin
  } else if (foundFallbackWin) {
    result.wins = fallbackWin
  }
  const mmaTotalLosses = mmaKOLoss + mmaSubLoss + mmaDecLoss + mmaDQLoss
  if (foundLossFields) {
    result.losses = mmaTotalLosses
  } else if (foundFallbackLoss) {
    result.losses = fallbackLoss
  }

  // Try to extract person infobox for image/nationality/birth date
  const personInfo = extractInfobox(wikitext)
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
          const yearMatch = rawBirthDate.match(/(\d{4})/)
          if (yearMatch) result.birthDate = yearMatch[1]
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
  losses: number
  draws: number
  nationality: string
  weightClass: string
  imageUrl: string
  birthDate: string
  qualityWins: number
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

function processRecord(wikitext: string): BoxerStats | null {
  const infobox = parseWikitextInfobox(wikitext)
  if (infobox.wins === null || infobox.losses === null) return null

  const wins = infobox.wins
  const losses = infobox.losses
  const draws = infobox.draws ?? 0
  const noContests = infobox.no_contests ?? 0
  let total = infobox.total
  if (total === null) total = wins + losses + draws + noContests

  let imageUrl = infobox.image
  if (!imageUrl) {
    const fileMatches = wikitext.matchAll(/\[\[(?:File|Image):([^\]|]+)/gi)
    for (const m of fileMatches) {
      const candidate = parseImageUrl(m[1])
      if (candidate) { imageUrl = candidate; break }
    }
  }

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
  const res = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT },
  })

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
    const res = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT },
    })

    if (res.status === 429) {
      await new Promise(r => setTimeout(r, 5000))
      i -= 50
      continue
    }

    if (!res.ok) {
      for (const title of batch) results.set(title, null)
      continue
    }

    const data = await res.json() as any
    const pages = data?.query?.pages ?? {}

    for (const [pid, page] of Object.entries(pages)) {
      const p = page as any
      if (pid === '-1') continue
      const title = p.title as string
      const wikitext = p?.revisions?.[0]?.['*']
      if (!wikitext) {
        results.set(title, null)
      } else {
        results.set(title, processRecord(wikitext))
      }
    }

    for (const title of batch) {
      if (!results.has(title)) results.set(title, null)
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
      const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } })
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

