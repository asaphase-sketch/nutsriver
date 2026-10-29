/**
 * Shared types for the poker engine and service.
 * All amounts are integer play-money chips. No real value.
 */

/** Card encoded 0..51: rank = floor(c/4) with 0=2 .. 12=A; suit = c%4 (0=s,1=h,2=d,3=c) */
export type Card = number

export type Phase =
  | 'WAITING'
  | 'PREFLOP'
  | 'FLOP'
  | 'TURN'
  | 'RIVER'
  | 'SHOWDOWN'

/** Poker variant played at a table. */
export type GameType = 'holdem' | 'omaha4' | 'omaha5'

export const GAME_LABEL: Record<GameType, string> = {
  holdem: "Hold'em",
  omaha4: 'Omaha 4',
  omaha5: 'Omaha 5',
}

/** Hole cards dealt per player for each game type. */
export const HOLE_CARDS: Record<GameType, number> = {
  holdem: 2,
  omaha4: 4,
  omaha5: 5,
}

export type ActionType = 'fold' | 'check' | 'call' | 'bet' | 'raise'

export interface TableConfig {
  key: string
  name: string
  smallBlind: number
  bigBlind: number
  maxSeats: number
  minBuyIn: number
  maxBuyIn: number
  botCount: number
  gameType?: GameType
  /** tournament tables never rebuy/cash-out; busted players are eliminated */
  tournament?: boolean
  /** hidden from lobby/admin lists — reserved for automated E2E runs */
  hidden?: boolean
}

export interface LastAction {
  type: ActionType
  amount?: number
  at: number
}

export interface SeatPlayer {
  userId: string
  name: string
  isBot: boolean
  seatIndex: number
  stack: number
  /** chips committed in the CURRENT betting round */
  bet: number
  /** chips committed in the whole hand (for side pots) */
  committed: number
  /** dealt into current hand and has not folded */
  inHand: boolean
  folded: boolean
  allIn: boolean
  hasActed: boolean
  lastAction: LastAction | null
  sittingOut: boolean
  wantsLeave: boolean
  hole: Card[]
  // presence
  connected: boolean
  disconnectedAt: number | null
}

export interface PotShare {
  userId: string
  name: string
  amount: number
  desc: string // winning hand description
  cards: Card[] // best 5 cards
}

/**
 * One step of a hand's public action trail — the structured backbone of the
 * hand replayer. Contains ONLY public information (names, chip amounts,
 * community cards): never hole cards, so a trail is safe to serve to every
 * participant without masking.
 */
export interface HandTrailAction {
  /** 1-based sequence within the hand — strictly increasing */
  n: number
  street: 'PREFLOP' | 'FLOP' | 'TURN' | 'RIVER' | 'SHOWDOWN'
  act:
    | 'post' // blind post
    | 'fold'
    | 'check'
    | 'call' // amt = chips paid now
    | 'bet' // amt = bet-to total on this street
    | 'raise' // amt = raise-to total on this street
    | 'deal' // community cards revealed (cards = codes dealt this street)
    | 'refund' // uncalled bet portion returned (amt)
    | 'win' // pot share (amt, desc)
  /** acting player's display name (absent for `deal`) */
  who?: string
  /** chip amount relevant to the action */
  amt?: number
  /** community card codes revealed by a `deal` step */
  cards?: string[]
  /** all-in marker for call/bet/raise */
  ai?: boolean
  /** winning hand description on `win` steps */
  desc?: string
}

export interface HandSummary {
  tableKey: string
  handNumber: number
  board: Card[]
  potTotal: number
  results: PotShare[]
  participants: { userId: string; name: string; committed: number; cards?: Card[] }[]
  log: string[]
  /** structured public action trail (replayer backbone) */
  trail: HandTrailAction[]
}

export interface ShowdownReveal {
  userId: string
  cards: Card[]
  desc: string | null
  best: Card[] | null
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

/** Options a bot may consider — mirrors SelfOptions plus context */
export interface BotContext {
  self: SeatPlayer
  hole: Card[]
  board: Card[]
  phase: Phase
  gameType: GameType
  currentBet: number
  minRaiseTo: number
  maxBetTo: number
  potTotal: number
  callAmount: number
  canCheck: boolean
  canRaise: boolean
  activeOpponents: number
}

// ---------- Client view models (redacted snapshots) ----------

export interface ClientPlayerView {
  seatIndex: number
  userId: string
  name: string
  isBot: boolean
  stack: number
  bet: number
  committed: number
  cards: (string | null)[] // card codes; null = hidden back
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
  gameType: GameType
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
  gameType: GameType
  playersSeated: number
  humansSeated: number
  humansConnected: number
  botsSeated: number
  inHand: boolean
  avgPot: number
  handsPlayed: number
  botOnly: boolean
}

export interface ChatMessage {
  id: string
  from: string
  name: string
  text: string
  at: number
  system?: boolean
}

// ---------- tournaments ----------

export type TournamentState = 'registering' | 'running' | 'finished' | 'cancelled'
export type TournamentKind = 'sitgo' | 'scheduled'

export interface TournamentConfig {
  id: string
  name: string
  gameType: GameType
  kind: TournamentKind
  buyIn: number
  bounty: number
  startingStack: number
  seatsPerTable: number
  maxPlayers: number
  /** epoch ms for scheduled tournaments; null = start when full */
  startAt: number | null
  /** blind level duration in ms (regular 300_000, turbo 120_000) */
  levelMs: number
  createdAt: number
}

/** A blind level in a tournament schedule. */
export interface BlindLevel {
  sb: number
  bb: number
}

/** Client-facing tournament lobby entry. */
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

/** Blind schedule generator — shipped in shared code so client previews match. */
export function blindLevel(levelIndex: number, baseBb: number): BlindLevel {
  // 5/10 → doubling-ish ladder with soft steps, ~15 levels deep
  const bbs = [baseBb]
  for (let i = 1; i < 16; i++) {
    const step = i <= 4 ? 2 : i <= 8 ? 1.5 : 1.4
    bbs.push(Math.round(bbs[i - 1]! * step))
  }
  const bb = bbs[Math.min(levelIndex, bbs.length - 1)]!
  const sb = Math.max(1, Math.floor(bb / 2))
  return { sb, bb }
}
