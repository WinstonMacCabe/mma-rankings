const USER_AGENT = 'MMARankings/1.0 (https://github.com/user/mma; mma-app@example.com)'
const API_URL = 'https://en.wikipedia.org/w/api.php'

function extractInfobox(wikitext: string): string | null {
  const prefixes = ['{{Infobox martial artist', '{{Infobox person']
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

function parseImageUrl(rawImage: string): string {
  if (!rawImage) return ''
  let cleaned = rawImage
  const fileMatch = cleaned.match(/\[\[(?:File|Image):([^\]|]+)/i)
  if (fileMatch) {
    cleaned = fileMatch[1]
  } else {
    cleaned = cleaned.replace(/^(?:File|Image):/i, '').replace(/\|.*$/, '').trim()
  }
  const extMatch = cleaned.match(/(.+\.(?:jpg|jpeg|png|gif|svg|webp|tiff?))/i)
  if (extMatch) cleaned = extMatch[1]
  if (!cleaned) return ''
  if (cleaned.startsWith('<!--') || cleaned.includes('Insert image') || cleaned.includes('only free-content')) return ''
  if (!/\.(jpg|jpeg|png|gif|svg|webp|tiff?)$/i.test(cleaned)) return ''
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
  }

  const infobox = extractInfobox(wikitext)
  const personInfobox = extractInfobox(wikitext.indexOf('{{Infobox person') >= 0 ? wikitext : '')

  let rawWeight = ''
  let mmaKowin = 0, mmaSubwin = 0, mmaDecwin = 0
  let mmaKOLoss = 0, mmaSubLoss = 0, mmaDecLoss = 0, mmaDQLoss = 0
  let foundWinFields = false, foundLossFields = false

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
  }
  const mmaTotalLosses = mmaKOLoss + mmaSubLoss + mmaDecLoss + mmaDQLoss
  if (foundLossFields) {
    result.losses = mmaTotalLosses
  }

  // Try to extract person infobox for image/nationality
  const personInfo = extractInfobox(wikitext)
  if (personInfo && (!result.image || !result.nationality)) {
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

  return {
    total,
    wins,
    kos: infobox.kos ?? 0,
    losses,
    draws,
    nationality: infobox.nationality,
    weightClass: infobox.weightClass,
    imageUrl: infobox.image,
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
