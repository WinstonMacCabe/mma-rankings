// The roster behind the secret /calendar2 page, and where each team's fixtures
// come from. Kept in one place so the fetch script and the page agree on who is
// being followed.

export type TeamSource =
  | { kind: 'espn-team'; sport: string; league: string; teamId: string; competition: string }
  | { kind: 'espn-core'; sport: string; league: string; teamId: string; competition: string }
  | { kind: 'mlb-stats'; teamId: number; competition: string }
  | { kind: 'army-rugby' }
  | { kind: 'super-league' }
  | { kind: 'ipl' }

export interface FollowedTeam {
  key: string
  name: string
  short: string
  label: string
  aliases: string[]
  sources: TeamSource[]
}

export const FOLLOWED_TEAMS: FollowedTeam[] = [
  {
    key: 'patriots',
    name: 'New England Patriots',
    short: 'Patriots',
    label: 'NFL',
    aliases: ['New England Patriots'],
    sources: [{ kind: 'espn-team', sport: 'football', league: 'nfl', teamId: '17', competition: 'NFL' }],
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
    key: 'blue-jays',
    name: 'Toronto Blue Jays',
    short: 'Blue Jays',
    label: 'MLB',
    aliases: ['Toronto Blue Jays'],
    sources: [{ kind: 'mlb-stats', teamId: 141, competition: 'MLB' }],
  },
  {
    key: 'man-city',
    name: 'Manchester City',
    short: 'Man City',
    label: 'Soccer',
    aliases: ['Manchester City'],
    sources: [{ kind: 'espn-core', sport: 'soccer', league: 'eng.1', teamId: '382', competition: 'Premier League' }],
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
    key: 'hamburger-sv',
    name: 'Hamburger SV',
    short: 'Hamburg',
    label: 'Soccer',
    aliases: ['Hamburger SV', 'Hamburg'],
    sources: [{ kind: 'espn-core', sport: 'soccer', league: 'ger.1', teamId: '127', competition: 'Bundesliga' }],
  },
  {
    key: 'cagliari',
    name: 'Cagliari',
    short: 'Cagliari',
    label: 'Soccer',
    aliases: ['Cagliari'],
    sources: [{ kind: 'espn-core', sport: 'soccer', league: 'ita.1', teamId: '2925', competition: 'Serie A' }],
  },
  {
    key: 'cf-montreal',
    name: 'CF Montréal',
    short: 'Montreal',
    label: 'Soccer',
    aliases: ['CF Montréal', 'CF Montreal', 'Montreal'],
    sources: [{ kind: 'espn-core', sport: 'soccer', league: 'usa.1', teamId: '9720', competition: 'MLS' }],
  },
  {
    key: 'as-monaco',
    name: 'AS Monaco',
    short: 'Monaco',
    label: 'Soccer',
    aliases: ['AS Monaco', 'Monaco'],
    sources: [{ kind: 'espn-core', sport: 'soccer', league: 'fra.1', teamId: '174', competition: 'Ligue 1' }],
  },
  {
    key: 'remo',
    name: 'Clube do Remo',
    short: 'Remo',
    label: 'Soccer',
    aliases: ['Remo', 'Clube do Remo'],
    sources: [{ kind: 'espn-core', sport: 'soccer', league: 'bra.1', teamId: '4936', competition: 'Série A' }],
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
    return n === a || (a.length >= 6 && n.includes(a))
  })
}