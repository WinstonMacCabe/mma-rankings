const API_URL = 'https://en.wikipedia.org/w/api.php'
const USER_AGENT = 'MMARankings/1.0 probe'

async function fetchPage(title: string): Promise<string | null> {
  const params = new URLSearchParams({ action: 'query', prop: 'revisions', rvprop: 'content', titles: title, format: 'json', origin: '*' })
  const res = await fetch(`${API_URL}?${params}`, { headers: { 'User-Agent': USER_AGENT } })
  if (!res.ok) return null
  const data = await res.json() as any
  const page = Object.values(data?.query?.pages ?? {})[0] as any
  return page?.revisions?.[0]?.['*'] ?? null
}

async function main() {
  const { extractSportRecords } = await import('../lib/wikipedia')
  const fighters: [string, string][] = [
    ['Lethwei+KunKhmer', 'Dave Leduc'],
    ['Judo', 'Teddy Riner'],
    ['Judo', 'Florian Gardin'],
  ]

  for (const [sport, page] of fighters) {
    const wt = await fetchPage(page)
    if (!wt) { console.log(`${sport} (${page}): NOT FOUND`); continue }
    const records = extractSportRecords(wt)
    console.log(`\n${sport} (${page}):`)
    for (const [key, rec] of Object.entries(records)) {
      if (rec && (rec.wins + rec.losses + rec.draws) > 0) {
        console.log(`  ${key}: ${rec.wins}-${rec.losses}-${rec.draws} (ko=${rec.kos})`)
      }
    }
    if (Object.keys(records).length === 0) console.log('  (no records found)')
  }
}

main().catch(err => { console.error(err); process.exit(1) })