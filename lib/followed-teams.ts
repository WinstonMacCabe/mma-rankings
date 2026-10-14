// The roster behind the secret /calendar2 page, and where each team's fixtures
// come from. Kept in one place so the fetch script and the page agree on who is
// being followed.
//
// ESPN's public site API carries ten of these directly. Its team-schedule
// endpoint (`/teams/{id}/schedule`) returns the team's own season in a single
// request for the American leagues, which is the cheap path. For soccer and
// rugby that endpoint only ever lists *played* matches, so those come from
// ESPN's core API instead, which can list a team's events for a date range (one
// request per competition, plus one per event). Army's rugby schedule is
// scraped from its athletics site; the last two teams have no free feed yet and
// are wired as empty sources (see the note on each).

export type TeamSource =
  /** ESPN site team schedule — the team's own season. NFL / NBA / NHL / NCAAF. */
  | { kind: 'espn-team'; sport: string; league: string; teamId: string; competition: string }
  /** ESPN core API team events for a date range — soccer / rugby. */
  | { kind: 'espn-core'; sport: string; league: string; teamId: string; competition: string }
  /** MLB's official stats API. */
  | { kind: 'mlb-stats'; teamId: number; competition: string }
  /** Army West Point men's rugby — Sidearm athletics site. */
  | { kind: 'army-rugby' }
  /** Super League (rugby league). No free feed exists; see fetchSuperLeague. */
  | { kind: 'super-league' }
  /** Indian Premier League (cricket). No free feed exists; see fetchIpl. */
  | { kind: 'ipl' }

export interface FollowedTeam {
  key: string
  name: string
  /** Compact label for grid cells and filter chips. */
  short: string
  /** Sport/competition tag rendered against each fixture. */
  label: string
  /** Names the source might use for this side, matched case-insensitively. */
  aliases: string[]
  sources: TeamSource[]
}

export const FOLLOWED_TEAMS: FollowedTeam[] = [
  {
    key: 'blue-jays',
    name: 'Toronto Blue Jays',
    short: 'Blue Jays',
    label: 'MLB',
    aliases: ['Toronto Blue Jays'],
    sources: [{ kind: 'mlb-stats', teamId: 141, competition: 'MLB' }],
  },
  {
    key: 'raptors',
    name: 'Toronto Raptors',
    short: 'Raptors',
    label: 'NBA',
    aliases: ['Toronto Raptors'],
    sources: [{ kind: 'espn-team', sport: 'basketball', league: 'nba', teamId: '28', competition: 'NBA' }],
  },
  {
    key: 'patriots',
    name: 'New England Patriots',
    short: 'Patriots',
    label: 'NFL',
    aliases: ['New England Patriots'],
    sources: [{ kind: 'espn-team', sport: 'football', league: 'nfl', teamId: '17', competition: 'NFL' }],
  },
  {
    key: 'senators',
    name: 'Ottawa Senators',
    short: 'Senators',
    label: 'NHL',
    aliases: ['Ottawa Senators'],
    sources: [{ kind: 'espn-team', sport: 'hockey', league: 'nhl', teamId: '14', competition: 'NHL' }],
  },
  {
    key: 'army-football',
    name: 'Army Black Knights Football',
    short: 'Army FB',
    label: 'NCAAF',
    aliases: ['Army Black Knights'],
    sources: [{ kind: 'espn-team', sport: 'football', league: 'college-football', teamId: '349', competition: 'NCAA Football' }],
  },
  {
    key: 'army-rugby',
    name: 'Army Black Knights Rugby',
    short: 'Army Rugby',
    label: 'Rugby',
    aliases: ['Army', 'Army Black Knights'],
    sources: [{ kind: 'army-rugby' }],
  },
  {
    key: 'man-city',
    name: 'Manchester City',
    short: 'Man City',
    label: 'Soccer',
    aliases: ['Manchester City'],
    sources: [
      { kind: 'espn-core', sport: 'soccer', league: 'eng.1', teamId: '382', competition: 'Premier League' },
      { kind: 'espn-core', sport: 'soccer', league: 'uefa.champions', teamId: '382', competition: 'Champions League' },
      { kind: 'espn-core', sport: 'soccer', league: 'eng.league_cup', teamId: '382', competition: 'EFL Cup' },
      { kind: 'espn-core', sport: 'soccer', league: 'eng.fa', teamId: '382', competition: 'FA Cup' },
    ],
  },
  {
    key: 'exeter-chiefs',
    name: 'Exeter Chiefs',
    short: 'Exeter',
    label: 'Rugby',
    aliases: ['Exeter Chiefs', 'Exeter'],
    sources: [
      { kind: 'espn-core', sport: 'rugby', league: '267979', teamId: '116227', competition: 'Premiership Rugby' },
      { kind: 'espn-core', sport: 'rugby', league: '271937', teamId: '116227', competition: 'Champions Cup' },
    ],
  },
  {
    key: 'catalans-dragons',
    name: 'Catalans Dragons',
    short: 'Catalans',
    label: 'Rugby League',
    aliases: ['Catalans Dragons', 'Catalans'],
    sources: [{ kind: 'super-league' }],
  },
  {
    key: 'cagliari',
    name: 'Cagliari',
    short: 'Cagliari',
    label: 'Soccer',
    aliases: ['Cagliari'],
    sources: [
      { kind: 'espn-core', sport: 'soccer', league: 'ita.1', teamId: '2925', competition: 'Serie A' },
      { kind: 'espn-core', sport: 'soccer', league: 'ita.coppa_italia', teamId: '2925', competition: 'Coppa Italia' },
    ],
  },
  {
    key: 'remo',
    name: 'Clube do Remo',
    short: 'Remo',
    label: 'Soccer',
    aliases: ['Remo', 'Clube do Remo'],
    sources: [
      { kind: 'espn-core', sport: 'soccer', league: 'bra.1', teamId: '4936', competition: 'Série A' },
      { kind: 'espn-core', sport: 'soccer', league: 'bra.copa_do_brazil', teamId: '4936', competition: 'Copa do Brasil' },
    ],
  },
  {
    key: 'baltika',
    name: 'Baltika Kaliningrad',
    short: 'Baltika',
    label: 'Soccer',
    aliases: ['FC Baltika Kaliningrad', 'Baltika Kaliningrad', 'Baltika'],
    sources: [
      { kind: 'espn-core', sport: 'soccer', league: 'rus.1', teamId: '21949', competition: 'Russian Premier League' },
    ],
  },
  {
    key: 'rcb',
    name: 'Royal Challengers Bengaluru',
    short: 'RCB',
    label: 'Cricket',
    aliases: ['Royal Challengers Bengaluru', 'Royal Challengers Bangalore', 'RCB'],
    sources: [{ kind: 'ipl' }],
  },
]

export function teamMatches(name: string, team: FollowedTeam): boolean {
  const n = name.trim().toLowerCase()
  return team.aliases.some(alias => {
    const a = alias.trim().toLowerCase()
    if (!a) return false
    // Short aliases ("Remo", "RCB") only ever match exactly, so they cannot
    // swallow an unrelated club whose name merely contains them.
    return n === a || (a.length >= 6 && n.includes(a))
  })
}
