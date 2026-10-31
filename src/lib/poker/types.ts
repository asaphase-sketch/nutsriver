/**
 * Client-side mirrors of the poker service's redacted view models.
 * The server sends per-user snapshots (hole cards only for their owner).
 */

export type Phase = 'WAITING' | 'PREFLOP' | 'FLOP' | 'TURN' | 'RIVER' | 'SHOWDOWN'
export type ActionType = 'fold' | 'check' | 'call' | 'bet' | 'raise'

export type GameType = 'holdem' | 'omaha4' | 'omaha5'

export const GAME_LABEL: Record<GameType, string> = {
  holdem: "Hold'em",
  omaha4: 'PLO 4',
  omaha5: 'PLO 5',
}

/** Betting structure label — Omaha games run pot-limit (standard PLO rules). */
export const GAME_LIMIT_LABEL: Record<GameType, string> = {
  holdem: 'No-Limit',
  omaha4: 'Pot-Limit',
  omaha5: 'Pot-Limit',
}

export const HOLE_CARDS: Record<GameType, number> = {
  holdem: 2,
  omaha4: 4,
  omaha5: 5,
}

export interface LastAction {
  type: ActionType
  amount?: number
  at: number
}

export interface SelfOptions {
  canFold: boolean
  canCheck: boolean
  canCall: boolean
  callAmount: number
  canBet: boolean
  canRaise: boolean
  minBetTo: number
  maxBetTo: number
  potBetTo: number
}

export interface PotShare {
  userId: string
  name: string
  amount: number
  desc: string
  cards: string[]
}

export interface ClientPlayerView {
  seatIndex: number
  userId: string
  name: string
  isBot: boolean
  stack: number
  bet: number
  committed: number
  cards: (string | null)[]
  cardsRevealed: boolean
  status: 'EMPTY' | 'WAITING' | 'SITTING_OUT' | 'IN_HAND' | 'FOLDED' | 'ALL_IN'
  isDealer: boolean
  isSmallBlind: boolean
  isBigBlind: boolean
  isActor: boolean
  lastAction: LastAction | null
  connected: boolean
  handDesc: string | null
  winAmount: number | null
  isSelf: boolean
}

export interface ClientTableView {
  tableKey: string
  name: string
  smallBlind: number
  bigBlind: number
  maxSeats: number
  minBuyIn: number
  maxBuyIn: number
  gameType?: GameType
  phase: Phase
  handNumber: number
  board: string[]
  pot: number
  currentBet: number
  minRaise: number
  actionDeadline: number | null
  /** ms window the current actor was given (deadline − window = turn start) */
  actionWindow: number | null
  actorUserId: string | null
  seats: ClientPlayerView[]
  selfSeat: number | null
  selfCards: string[]
  selfOptions: SelfOptions | null
  log: string[]
  lastSummary: {
    handNumber: number
    potTotal: number
    results: PotShare[]
    board: string[]
  } | null
}

export interface LobbyTableSummary {
  tableKey: string
  name: string
  smallBlind: number
  bigBlind: number
  maxSeats: number
  minBuyIn: number
  maxBuyIn: number
  gameType?: GameType
  playersSeated: number
  humansSeated: number
  inHand: boolean
  avgPot: number
  handsPlayed: number
  botOnly: boolean
}

/** Public play-money leaderboard row (mirrors the /api/leaderboard payload). */
export interface LeaderboardRow {
  username: string
  chips: number
  handsPlayed: number
  handsWon: number
  biggestPotWon: number
}

// ---------- tournaments ----------

export type TournamentState = 'registering' | 'running' | 'finished' | 'cancelled'
export type TournamentKind = 'sitgo' | 'scheduled'

export interface TournamentLobbyItem {
  id: string
  name: string
  gameType: GameType
  kind: TournamentKind
  buyIn: number
  bounty: number
  startingStack: number
  seatsPerTable: number
  maxPlayers: number
  startAt: number | null
  levelMs: number
  state: TournamentState
  prizePool: number
  entries: number
  playersLeft: number
  myEntry: boolean
  level: number
  blinds: { sb: number; bb: number } | null
  levelEndsAt: number | null
  myTableKey: string | null
  registeredAt: number | null
  finishPlace: number | null
  prizeWon: number | null
  bountyWon: number | null
}

/** Prize preview shared with the server's payout ladder. */
export function payoutFractions(fieldSize: number): number[] {
  if (fieldSize <= 2) return [1]
  if (fieldSize <= 4) return [0.7, 0.3]
  if (fieldSize <= 6) return [0.6, 0.25, 0.15]
  if (fieldSize <= 9) return [0.5, 0.3, 0.2]
  const places = Math.min(15, Math.max(3, Math.floor(fieldSize / 4)))
  const weights = Array.from({ length: places }, (_, i) => Math.pow(0.6, i))
  const sum = weights.reduce((a, w) => a + w, 0)
  const fr = weights.map((w) => w / sum)
  fr[fr.length - 1]! += 1 - fr.reduce((a, f) => a + f, 0)
  return fr
}

export interface ChatMessage {
  id: string
  from: string
  name: string
  text: string
  at: number
  system?: boolean
  tableKey?: string
}

export interface PokerUser {
  id: string
  username: string
  chips: number
  handsPlayed?: number
  handsWon?: number
  biggestPotWon?: number
  role?: 'player' | 'admin'
}
