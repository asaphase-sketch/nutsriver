import type {
  Card,
  ClientPlayerView,
  ClientTableView,
  HandSummary,
  HandTrailAction,
  LastAction,
  LobbyTableSummary,
  Phase,
  SeatPlayer,
  SelfOptions,
  ShowdownReveal,
  TableConfig,
} from './types'
import { cardCode, freshDeck, randomIntBelow, secureShuffle } from './cards'
import { evaluate, evaluateOmaha } from './handEval'
import { HOLE_CARDS, type GameType } from './types'

export const ACTION_TIME_MS = 25_000
const HAND_END_SHOWDOWN_MS = 4_200
const HAND_END_AWARD_MS = 2_200
const NEXT_HAND_DELAY_MS = 1_600
const STREET_RUNOUT_MS = 900
const DISCONNECT_STANDUP_MS = 120_000
const MAX_LOG = 60

export interface EngineTimings {
  actionMs: number
  showdownMs: number
  awardMs: number
  streetMs: number
  startMs: number
}

const DEFAULT_TIMINGS: EngineTimings = {
  actionMs: ACTION_TIME_MS,
  showdownMs: HAND_END_SHOWDOWN_MS,
  awardMs: HAND_END_AWARD_MS,
  streetMs: STREET_RUNOUT_MS,
  startMs: 800,
}

export interface EngineCallbacks {
  /** any state mutation worth broadcasting */
  onChange(): void
  /** a hand fully completed */
  onHandFinished(summary: HandSummary): void
  /** a human player's stack must be returned to their lobby balance */
  onCashOut(userId: string, amount: number, tableKey: string): void
  /** a player (human or bot) busted out of a tournament table */
  onBust?(userId: string, tableKey: string): void
  /** a deferred continuation was scheduled for `at` — host must wake by then */
  onSchedule?(at: number): void
  /** gate for starting a NEW hand (e.g. skip bot-only tables to save resources) */
  canStartHand?(): boolean
}

export class PokerTable {
  readonly cfg: TableConfig
  private seats: (SeatPlayer | null)[]
  private phase: Phase = 'WAITING'
  private handNumber = 0
  private dealerSeat = -1
  private sbSeat = -1
  private bbSeat = -1
  private actorSeat = -1
  private deck: Card[] = []
  private board: Card[] = []
  private pot = 0
  private currentBet = 0
  private minRaise = 0
  private lastRaiseIncomplete = false
  private actionDeadline: number | null = null
  private timer: ReturnType<typeof setTimeout> | null = null
  /** next deferred continuation (driven by host alarm / internal timer) */
  private pending: { id: string; at: number; fn: () => void } | null = null
  private log: string[] = []
  /** structured public action trail for the CURRENT hand (replayer backbone) */
  private trail: HandTrailAction[] = []
  private trailN = 0
  private lastSummary: HandSummary | null = null
  /** hole cards shown to everyone — populated at showdown AND when an all-in
   *  runout starts ('cards on their backs', the PokerStars/GGPoker standard).
   *  Cleared at the start of every hand. */
  private reveals = new Map<string, ShowdownReveal>()
  private winAmounts = new Map<string, number>()
  private handsPlayed = 0
  private totalPotSum = 0
  private destroyed = false

  constructor(
    cfg: TableConfig,
    private cb: EngineCallbacks,
    timings?: Partial<EngineTimings>,
  ) {
    this.cfg = cfg
    this.seats = new Array(cfg.maxSeats).fill(null)
    this.timings = { ...DEFAULT_TIMINGS, ...timings }
  }

  private timings: EngineTimings

  /** Tournament hosts raise blinds between hands. Only valid while waiting. */
  setBlinds(sb: number, bb: number) {
    ;(this.cfg as { smallBlind: number; bigBlind: number }).smallBlind = sb
    ;(this.cfg as { smallBlind: number; bigBlind: number }).bigBlind = bb
  }

  gameType(): GameType {
    return this.cfg.gameType ?? 'holdem'
  }

  destroy() {
    this.destroyed = true
    this.clearTimer()
  }

  // ---------------- presence / seating ----------------

  seatOf(userId: string): SeatPlayer | null {
    for (const s of this.seats) if (s && s.userId === userId) return s
    return null
  }

  isOccupied(seatIndex: number): boolean {
    return !!this.seats[seatIndex]
  }

  sitDown(
    userId: string,
    name: string,
    seatIndex: number,
    buyIn: number,
    isBot = false,
  ): string | null {
    if (seatIndex < 0 || seatIndex >= this.cfg.maxSeats) return 'Invalid seat'
    if (this.seats[seatIndex]) return 'Seat is taken'
    if (this.seatOf(userId)) return 'Already seated'
    if (buyIn < this.cfg.minBuyIn || buyIn > this.cfg.maxBuyIn)
      return `Buy-in must be between ${this.cfg.minBuyIn} and ${this.cfg.maxBuyIn}`
    this.seats[seatIndex] = {
      userId,
      name,
      isBot,
      seatIndex,
      stack: buyIn,
      bet: 0,
      committed: 0,
      inHand: false,
      folded: false,
      allIn: false,
      hasActed: false,
      lastAction: null,
      sittingOut: false,
      wantsLeave: false,
      hole: [],
      connected: true,
      disconnectedAt: null,
    }
    this.addLog(`${name} sits down with ${buyIn} chips`)
    this.emitChange()
    this.maybeScheduleStart()
    return null
  }

  standUp(userId: string): string | null {
    const p = this.seatOf(userId)
    if (!p) return 'Not seated'
    if (p.inHand && !p.folded && this.isBettingPhase()) {
      p.wantsLeave = true
      this.addLog(`${p.name} will leave after this hand`)
      this.emitChange()
      return null
    }
    this.executeStandUp(p)
    this.emitChange()
    this.maybeScheduleStart()
    return null
  }

  toggleSitOut(userId: string, wantOut: boolean): string | null {
    const p = this.seatOf(userId)
    if (!p) return 'Not seated'
    p.sittingOut = wantOut
    this.addLog(`${p.name} ${wantOut ? 'is sitting out' : 'is back in'}`)
    this.emitChange()
    this.maybeScheduleStart()
    return null
  }

  /** Validate a seated top-up (cash tables only — host deducts D1 first). */
  canRebuy(userId: string, amount: number): string | null {
    const p = this.seatOf(userId)
    if (!p) return 'Not seated'
    if (this.cfg.tournament) return 'No rebuys in tournaments'
    if (!Number.isFinite(amount) || amount < 1 || !Number.isInteger(amount)) return 'Invalid top-up amount'
    if (p.inHand) return 'Finish your hand first — top-up applies between hands'
    if (p.stack + amount > this.cfg.maxBuyIn)
      return `Table max is ${this.cfg.maxBuyIn} — you can add at most ${this.cfg.maxBuyIn - p.stack}`
    return null
  }

  /** Credit a validated top-up to the seat stack (D1 deduction already done). */
  applyRebuy(userId: string, amount: number): string | null {
    const p = this.seatOf(userId)
    if (!p) return 'Not seated'
    if (amount < 1 || !Number.isInteger(amount)) return 'Invalid top-up amount'
    p.stack += amount
    this.addLog(`${p.name} tops up ${amount} chips`)
    this.emitChange()
    return null
  }

  onConnect(userId: string) {
    const p = this.seatOf(userId)
    if (p && !p.connected) {
      p.connected = true
      p.disconnectedAt = null
      this.emitChange()
      // A returning player can be the second eligible seat at a dormant
      // table (idle tables have no alarm — see host hkIntervalMs) — without
      // this, the next hand would never start until someone re-seated.
      this.maybeScheduleStart()
    }
  }

  onDisconnect(userId: string) {
    const p = this.seatOf(userId)
    if (p && !p.isBot) {
      p.connected = false
      p.disconnectedAt = Date.now()
      // tournaments: disconnected players stay in — autoAct folds their hands
      // and the blinds drain their stack (standard tournament behavior)
      if (!this.cfg.tournament) {
        p.sittingOut = true
        this.addLog(`${p.name} disconnected — sitting out`)
      } else {
        this.addLog(`${p.name} disconnected — hands auto-folded`)
      }
      this.emitChange()
      this.maybeScheduleStart()
    }
  }

  /** periodic housekeeping: stand up long-disconnected players (cash games only) */
  housekeeping(now: number) {
    if (this.cfg.tournament) return // tournament players blind off instead
    for (const p of this.seats) {
      if (p && !p.isBot && !p.connected && p.disconnectedAt && now - p.disconnectedAt > DISCONNECT_STANDUP_MS) {
        if (p.inHand && !p.folded && this.isBettingPhase()) {
          p.wantsLeave = true
        } else {
          this.executeStandUp(p)
          this.emitChange()
        }
      }
    }
  }

  private executeStandUp(p: SeatPlayer) {
    if (p.stack > 0 && !p.isBot && !this.cfg.tournament) {
      this.cb.onCashOut(p.userId, p.stack, this.cfg.key)
    }
    if (this.cfg.tournament && p.stack > 0) {
      // leaving a running tournament forfeits the remaining stack
      this.addLog(`${p.name} forfeits ${p.stack} chips and leaves`)
    } else {
      this.addLog(`${p.name} leaves the table (${p.stack} chips)`)
    }
    const busted = this.cfg.tournament
    this.seats[p.seatIndex] = null
    if (busted) this.cb.onBust?.(p.userId, this.cfg.key)
  }

  // ---------------- hand lifecycle ----------------

  private eligiblePlayers(): SeatPlayer[] {
    return this.seats.filter(
      (s): s is SeatPlayer => !!s && !s.sittingOut && s.stack > 0 && !s.wantsLeave && !s.inHand,
    )
  }

  private activeInHand(): SeatPlayer[] {
    return this.seats.filter((s): s is SeatPlayer => !!s && s.inHand)
  }

  private canActPlayers(): SeatPlayer[] {
    return this.seats.filter((s): s is SeatPlayer => !!s && s.inHand && !s.allIn && s.stack > 0)
  }

  private isBettingPhase(): boolean {
    return this.phase === 'PREFLOP' || this.phase === 'FLOP' || this.phase === 'TURN' || this.phase === 'RIVER'
  }

  maybeScheduleStart() {
    if (this.destroyed) return
    this.maybeStartHand()
  }

  /** Start a hand if the table is ready and the host allows it. */
  maybeStartHand() {
    if (this.destroyed) return
    if (this.phase === 'WAITING' && this.eligiblePlayers().length >= 2 && (this.cb.canStartHand?.() ?? true)) {
      this.schedule(() => this.startHand(), this.timings.startMs, 'startHand')
    }
  }

  /**
   * Defer a continuation by `ms`. The continuation is stored as `pending` and
   * executed by drain(): the internal timer self-drains (Node / tests), while
   * durable hosts (Durable Objects) arm an alarm at `onSchedule(at)`.
   */
  private schedule(fn: () => void, ms: number, id: string) {
    this.clearTimer()
    this.actionDeadline = null
    const at = Date.now() + ms
    this.pending = { id, at, fn }
    this.cb.onSchedule?.(at)
    this.timer = setTimeout(() => {
      this.timer = null
      this.drain(Date.now())
    }, ms)
  }

  /** Run any due deferred continuation. Safe to call at any time. */
  drain(now: number) {
    if (this.destroyed) return
    const p = this.pending
    if (p && now >= p.at) {
      this.pending = null
      try {
        p.fn()
      } catch (e) {
        console.error(`[${this.cfg.key}] engine error`, e)
      }
    }
  }

  /** Earliest pending continuation time (null when idle) — for alarm scheduling. */
  nextWakeAt(): number | null {
    return this.pending?.at ?? null
  }

  /**
   * Full state snapshot for durable hosts — survives Durable Object eviction.
   * All fields are plain data; the pending continuation is stored by id and
   * rebuilt on restore.
   */
  serialize(): string {
    return JSON.stringify({
      v: 1,
      seats: this.seats,
      phase: this.phase,
      handNumber: this.handNumber,
      dealerSeat: this.dealerSeat,
      sbSeat: this.sbSeat,
      bbSeat: this.bbSeat,
      actorSeat: this.actorSeat,
      deck: this.deck,
      board: this.board,
      pot: this.pot,
      currentBet: this.currentBet,
      minRaise: this.minRaise,
      lastRaiseIncomplete: this.lastRaiseIncomplete,
      actionDeadline: this.actionDeadline,
      log: this.log,
      lastSummary: this.lastSummary,
      reveals: [...this.reveals.entries()],
      winAmounts: [...this.winAmounts.entries()],
      handsPlayed: this.handsPlayed,
      totalPotSum: this.totalPotSum,
      pending: this.pending ? { id: this.pending.id, at: this.pending.at } : null,
    })
  }

  /** Restore state produced by serialize() onto a freshly constructed instance. */
  restoreState(json: string) {
    const d = JSON.parse(json) as {
      seats: (SeatPlayer | null)[]
      phase: Phase
      handNumber: number
      dealerSeat: number
      sbSeat: number
      bbSeat: number
      actorSeat: number
      deck: Card[]
      board: Card[]
      pot: number
      currentBet: number
      minRaise: number
      lastRaiseIncomplete: boolean
      actionDeadline: number | null
      log: string[]
      lastSummary: HandSummary | null
      reveals: [string, ShowdownReveal][]
      winAmounts: [string, number][]
      handsPlayed: number
      totalPotSum: number
      pending: { id: string; at: number } | null
    }
    this.seats = d.seats
    this.phase = d.phase
    this.handNumber = d.handNumber
    this.dealerSeat = d.dealerSeat
    this.sbSeat = d.sbSeat
    this.bbSeat = d.bbSeat
    this.actorSeat = d.actorSeat
    this.deck = d.deck
    this.board = d.board
    this.pot = d.pot
    this.currentBet = d.currentBet
    this.minRaise = d.minRaise
    this.lastRaiseIncomplete = d.lastRaiseIncomplete
    this.actionDeadline = d.actionDeadline
    this.log = d.log
    this.lastSummary = d.lastSummary
    this.reveals = new Map(d.reveals)
    this.winAmounts = new Map(d.winAmounts)
    this.handsPlayed = d.handsPlayed
    this.totalPotSum = d.totalPotSum
    if (d.pending) {
      const { id, at } = d.pending
      const fn =
        id === 'startHand'
          ? () => this.startHand()
          : id === 'nextStreet'
            ? () => this.nextStreet()
            : id === 'cleanup'
              ? () => this.cleanupBetweenHands()
              : id.startsWith('autoAct:')
                ? () => this.autoAct(Number(id.slice('autoAct:'.length)))
                : null
      if (fn) {
        this.pending = { id, at, fn }
        this.cb.onSchedule?.(at)
        if (at > Date.now()) {
          this.timer = setTimeout(() => {
            this.timer = null
            this.drain(Date.now())
          }, at - Date.now())
        }
      }
    }
  }

  private clearTimer() {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    this.pending = null
  }

  private startHand() {
    const elig = this.eligiblePlayers()
    if (elig.length < 2 || this.destroyed) {
      this.phase = 'WAITING'
      return
    }
    this.handNumber++
    this.deck = secureShuffle(freshDeck())
    this.board = []
    this.pot = 0
    this.currentBet = 0
    this.minRaise = this.cfg.bigBlind
    this.lastRaiseIncomplete = false
    this.reveals.clear()
    this.winAmounts.clear()
    this.phase = 'PREFLOP'
    this.trail = []
    this.trailN = 0
    this.addLog(`--- Hand #${this.handNumber} ---`)

    // move the button to the next eligible seat
    if (this.dealerSeat < 0 || !elig.some((p) => p.seatIndex === this.dealerSeat)) {
      this.dealerSeat = elig[randomIntBelow(elig.length)].seatIndex
    } else {
      this.dealerSeat = this.nextEligibleSeat(this.dealerSeat, elig)
    }

    // deal hole cards per player, starting left of the button
    const holeCount = HOLE_CARDS[this.gameType()]
    for (let i = 0; i < elig.length; i++) {
      const p = elig[(i + 1) % elig.length]
      p.hole = []
      for (let c = 0; c < holeCount; c++) p.hole.push(this.deck.pop()!)
      p.inHand = true
      p.folded = false
      p.allIn = false
      p.hasActed = false
      p.bet = 0
      p.committed = 0
      p.lastAction = null
    }

    const headsUp = elig.length === 2
    if (headsUp) {
      this.sbSeat = this.dealerSeat
      this.bbSeat = this.nextInHandSeat(this.dealerSeat)
    } else {
      this.sbSeat = this.nextInHandSeat(this.dealerSeat)
      this.bbSeat = this.nextInHandSeat(this.sbSeat)
    }
    this.postBlind(this.seats[this.sbSeat]!, this.cfg.smallBlind, 'small blind')
    this.postBlind(this.seats[this.bbSeat]!, this.cfg.bigBlind, 'big blind')
    // The live preflop bet is the LARGEST blind actually posted — a short
    // all-in BB does not lower it below the SB's post (his toCall would go
    // negative), and a short SB does not raise it. Callers match the real
    // number (no phantom toCall, no post-hoc refund of the difference).
    this.currentBet = Math.max(this.seats[this.sbSeat]!.bet, this.seats[this.bbSeat]!.bet)
    this.minRaise = this.cfg.bigBlind

    const first = this.nextActorSeat(this.bbSeat)
    if (first === -1) {
      // everyone is all-in from the blinds — run the board out
      this.emitChange()
      this.schedule(() => this.nextStreet(), this.timings.streetMs, 'nextStreet')
    } else {
      this.beginTurn(first)
    }
    this.emitChange()
  }

  private postBlind(p: SeatPlayer, amount: number, label: string) {
    const pay = Math.min(amount, p.stack)
    p.stack -= pay
    p.bet += pay
    p.committed += pay
    if (p.stack === 0) p.allIn = true
    p.lastAction = { type: 'bet', amount: pay, at: Date.now() }
    this.addLog(`${p.name} posts ${label} ${pay}`)
    this.tAdd({ street: 'PREFLOP', act: 'post', who: p.name, amt: pay })
  }

  private nextEligibleSeat(from: number, elig: SeatPlayer[]): number {
    const idxs = elig.map((p) => p.seatIndex).sort((a, b) => a - b)
    for (let i = 1; i <= this.cfg.maxSeats; i++) {
      const s = (from + i) % this.cfg.maxSeats
      if (idxs.includes(s)) return s
    }
    return from
  }

  /** next seat (circular) holding an in-hand player */
  private nextInHandSeat(from: number): number {
    for (let i = 1; i <= this.cfg.maxSeats; i++) {
      const s = (from + i) % this.cfg.maxSeats
      const p = this.seats[s]
      if (p && p.inHand) return s
    }
    return -1
  }

  /** next seat (circular) that can still act */
  private nextActorSeat(from: number): number {
    for (let i = 1; i <= this.cfg.maxSeats; i++) {
      const s = (from + i) % this.cfg.maxSeats
      const p = this.seats[s]
      if (p && p.inHand && !p.allIn && !p.folded && p.stack > 0) return s
    }
    return -1
  }

  // ---------------- actions ----------------

  /** Total chips currently in the middle: collected pot + all current-street bets. */
  private streetPot(): number {
    return this.pot + [...this.seats].reduce((a, p) => a + (p?.bet ?? 0), 0)
  }

  /**
   * Pot-limit raise-to cap for `actor` (standard PLO): call first, then raise
   * up to the resulting pot — cap = currentBet + streetPot + toCall, never
   * beyond the actor's all-in. With no bet on the street the cap is the street
   * pot itself (an opening bet may size up to the pot).
   */
  private potLimitCap(actor: SeatPlayer): number {
    const streetPot = this.streetPot()
    const maxTo = actor.bet + actor.stack
    const toCall = Math.max(0, this.currentBet - actor.bet)
    const cap = this.currentBet === 0 ? streetPot : this.currentBet + streetPot + toCall
    return Math.min(cap, maxTo)
  }

  applyAction(
    userId: string,
    type: 'fold' | 'check' | 'call' | 'bet' | 'raise',
    amount?: number,
  ): string | null {
    if (!this.isBettingPhase()) return 'No betting right now'
    if (this.actorSeat < 0) return 'No action pending'
    const p = this.seats[this.actorSeat]
    if (!p || p.userId !== userId) return 'Not your turn'

    switch (type) {
      case 'fold':
        p.folded = true
        p.inHand = false
        p.lastAction = { type: 'fold', at: Date.now() }
        this.addLog(`${p.name} folds`)
        this.tAdd({ street: this.trailStreet(), act: 'fold', who: p.name })
        break
      case 'check': {
        if (this.currentBet !== p.bet) return 'Cannot check — there is a bet to call'
        p.lastAction = { type: 'check', at: Date.now() }
        this.addLog(`${p.name} checks`)
        this.tAdd({ street: this.trailStreet(), act: 'check', who: p.name })
        break
      }
      case 'call': {
        const owe = this.currentBet - p.bet
        if (owe <= 0) return 'Nothing to call'
        const pay = Math.min(owe, p.stack)
        p.stack -= pay
        p.bet += pay
        p.committed += pay
        if (p.stack === 0) p.allIn = true
        p.lastAction = { type: 'call', amount: pay, at: Date.now() }
        this.addLog(p.allIn ? `${p.name} calls ${pay} — ALL IN` : `${p.name} calls ${pay}`)
        this.tAdd({ street: this.trailStreet(), act: 'call', who: p.name, amt: pay, ...(p.allIn ? { ai: true } : {}) })
        break
      }
      case 'bet':
      case 'raise': {
        const maxTo = p.bet + p.stack
        // server-authoritative cap: pot-limit tables can never be overbet
        // (the dealer simply caps the amount, as a live dealer would)
        const cap = this.cfg.limit === 'pl' ? this.potLimitCap(p) : maxTo
        let target = Math.floor(amount ?? 0)
        if (target > maxTo) target = maxTo
        if (target > cap) target = cap
        const isAllIn = target === maxTo
        // An incomplete all-in raise does NOT reopen betting (PokerStars/TDA
        // rule): a player who has already acted may only call or fold. The
        // UI guard in selfOptions is not enough — enforce it server-side so
        // a crafted client cannot illegally re-raise over a short all-in.
        if (this.lastRaiseIncomplete && p.hasActed)
          return 'Betting was not reopened — call or fold'
        const minTo = this.currentBet === 0 ? this.cfg.bigBlind : this.currentBet + this.minRaise
        if (target < minTo && !isAllIn)
          return `Minimum is ${minTo}`
        if (target <= this.currentBet && !isAllIn) return 'Raise must exceed the current bet'
        if (target <= this.currentBet && isAllIn) return 'Stack too small to raise'

        const pay = target - p.bet
        p.stack -= pay
        p.bet = target
        p.committed += pay
        if (p.stack === 0) p.allIn = true
        const wasBet = this.currentBet === 0
        if (isAllIn && target < minTo) {
          // incomplete all-in raise: does not reopen betting
          this.currentBet = target
          this.lastRaiseIncomplete = true
        } else {
          this.minRaise = Math.max(this.minRaise, target - this.currentBet)
          this.currentBet = target
          this.lastRaiseIncomplete = false
          for (const o of this.activeInHand()) {
            if (o !== p && !o.allIn) o.hasActed = false
          }
        }
        p.lastAction = { type: wasBet ? 'bet' : 'raise', amount: target, at: Date.now() }
        this.addLog(
          p.allIn
            ? `${p.name} bets ${target} — ALL IN`
            : `${p.name} ${wasBet ? 'bets' : 'raises to'} ${target}`,
        )
        this.tAdd({ street: this.trailStreet(), act: wasBet ? 'bet' : 'raise', who: p.name, amt: target, ...(p.allIn ? { ai: true } : {}) })
        break
      }
    }
    p.hasActed = true
    this.afterAction(p)
    return null
  }

  private afterAction(actor: SeatPlayer) {
    const alive = this.activeInHand()
    if (alive.length === 1) {
      this.awardUncontested(alive[0])
      return
    }
    const actors = this.canActPlayers()
    const allSettled = actors.every((p) => p.hasActed && p.bet === this.currentBet)
    if (actors.length === 0 || allSettled) {
      this.nextStreet()
      return
    }
    // find next player who still owes action or has not acted
    let next = this.nextActorSeat(actor.seatIndex)
    while (next !== -1) {
      const p = this.seats[next]!
      if (!p.hasActed || p.bet !== this.currentBet) break
      next = this.nextActorSeat(next)
      if (next === actor.seatIndex) break
    }
    if (next === -1) {
      this.nextStreet()
      return
    }
    this.beginTurn(next)
    this.emitChange()
  }

  private beginTurn(seatIndex: number) {
    this.actorSeat = seatIndex
    // schedule() clears actionDeadline as a side effect — arm the clock AFTER
    // it so the snapshot carries the real deadline (and clients can render it)
    this.schedule(() => this.autoAct(seatIndex), this.timings.actionMs, `autoAct:${seatIndex}`)
    this.actionDeadline = Date.now() + this.timings.actionMs
  }

  private autoAct(seatIndex: number) {
    if (this.actorSeat !== seatIndex || !this.isBettingPhase()) return
    const p = this.seats[seatIndex]
    if (!p) return
    const canCheck = this.currentBet === p.bet
    this.addLog(`${p.name}'s time expires`)
    this.applyAction(p.userId, canCheck ? 'check' : 'fold')
    this.emitChange()
  }

  // ---------------- streets / pots ----------------

  /** return any uncalled bet portion to the lone aggressor */
  private refundUncalled() {
    const inHand = this.activeInHand()
    if (inHand.length < 1) return
    const bets = inHand.map((p) => p.bet)
    const maxBet = Math.max(...bets)
    const holders = inHand.filter((p) => p.bet === maxBet)
    if (holders.length === 1 && maxBet > 0) {
      // The second-highest street bet must include FOLDED players' dead bets:
      // a folder's chips stay in the pot, so the aggressor is only "uncalled"
      // down to the largest bet anyone (alive or folded) put in this street.
      // Counting active players only over-refunded and burned dead money
      // above every alive player's committed in the side-pot construction.
      const second = Math.max(0, ...this.seats.filter((p): p is SeatPlayer => !!p && p !== holders[0] && p.bet > 0).map((p) => p.bet))
      const refund = maxBet - second
      if (refund > 0) {
        holders[0].stack += refund
        holders[0].bet -= refund
        holders[0].committed -= refund
        this.addLog(`Uncalled ${refund} returned to ${holders[0].name}`)
        this.tAdd({ street: this.trailStreet(), act: 'refund', who: holders[0].name, amt: refund })
      }
    }
  }

  private nextStreet() {
    this.actorSeat = -1
    this.actionDeadline = null
    this.clearTimer()
    this.refundUncalled()
    // move current street bets into the pot — INCLUDING dead money from folded players
    for (const p of this.seats) {
      if (p && p.bet > 0) {
        this.pot += p.bet
        p.bet = 0
      }
    }
    const alive = this.activeInHand()
    if (alive.length === 1) {
      this.awardUncontested(alive[0])
      return
    }
    // all-in runout: betting is finished and at least two hands are racing —
    // flip every live hand face-up BEFORE the remaining board is dealt, so
    // clients watch the runout with cards on their backs (worldwide standard)
    if (this.canActPlayers().length <= 1) this.revealRunout(alive)
    if (this.board.length === 0) this.dealStreet(3, 'FLOP')
    else if (this.board.length === 3) this.dealStreet(1, 'TURN')
    else if (this.board.length === 4) this.dealStreet(1, 'RIVER')
    else if (this.board.length === 5) {
      this.showdown()
      return
    }
    this.phase = this.board.length === 3 ? 'FLOP' : this.board.length === 4 ? 'TURN' : 'RIVER'

    const actors = this.canActPlayers()
    this.currentBet = 0
    this.minRaise = this.cfg.bigBlind
    this.lastRaiseIncomplete = false
    for (const p of alive) {
      p.hasActed = false
      p.lastAction = null
    }
    if (actors.length <= 1) {
      // no meaningful betting possible — run the board out with delays
      this.emitChange()
      this.schedule(() => this.nextStreet(), this.timings.streetMs, 'nextStreet')
      return
    }
    const first = this.nextActorSeat(this.dealerSeat)
    if (first === -1) {
      this.emitChange()
      this.schedule(() => this.nextStreet(), this.timings.streetMs, 'nextStreet')
    } else {
      this.beginTurn(first)
    }
    this.emitChange()
  }

  /**
   * All-in runout reveal: every still-alive hand goes on its back. Entries
   * carry cards only — desc/best arrive when the real showdown evaluates the
   * complete board (showdown() overwrites these entries).
   */
  private revealRunout(alive: SeatPlayer[]) {
    let added = false
    for (const p of alive) {
      if (!this.reveals.has(p.userId)) {
        this.reveals.set(p.userId, { userId: p.userId, cards: [...p.hole], desc: null, best: null })
        added = true
      }
    }
    if (added) this.addLog(`All-in — ${alive.map((p) => p.name).join(', ')} show their cards`)
  }

  private dealStreet(n: number, label: string) {
    const drawn = this.drawCards(this.board.length === 0 ? 3 : n).map(cardCode)
    if (drawn.length === 3) this.addLog(`FLOP [${drawn.join(' ')}]`)
    else this.addLog(`${label} [${drawn[0]}]`)
    const street: HandTrailAction['street'] =
      this.board.length === 3 ? 'FLOP' : this.board.length === 4 ? 'TURN' : 'RIVER'
    this.tAdd({ street, act: 'deal', cards: drawn })
  }

  private drawCards(n: number): Card[] {
    const out: Card[] = []
    for (let i = 0; i < n; i++) out.push(this.deck.pop()!)
    this.board.push(...out)
    return out
  }

  private awardUncontested(winner: SeatPlayer) {
    this.refundUncalled()
    for (const p of this.seats) {
      if (p && p.bet > 0) {
        this.pot += p.bet
        p.bet = 0
      }
    }
    const amount = this.pot
    winner.stack += amount
    this.pot = 0
    this.totalPotSum += amount
    this.winAmounts.set(winner.userId, amount)
    this.addLog(`${winner.name} wins ${amount} (everyone folded)`)
    this.tAdd({ street: 'SHOWDOWN', act: 'win', who: winner.name, amt: amount })
    this.phase = 'SHOWDOWN'
    this.reveals.clear()
    const summary: HandSummary = {
      tableKey: this.cfg.key,
      handNumber: this.handNumber,
      board: [...this.board],
      potTotal: amount,
      results: [{ userId: winner.userId, name: winner.name, amount, desc: 'All others folded', cards: [] }],
      participants: this.buildParticipants(),
      log: [...this.log],
      trail: [...this.trail],
    }
    this.lastSummary = summary
    this.handsPlayed++
    this.finishHand(summary, this.timings.awardMs)
  }

  private buildParticipants() {
    return this.seats
      .filter((s): s is SeatPlayer => !!s && s.committed > 0)
      .map((s) => ({
        userId: s.userId,
        name: s.name,
        committed: s.committed,
        // hole cards ride along for the admin hand-history store; the client
        // view (snapshotFor) never forwards participants, so players cannot
        // see opponents' cards through this field
        cards: [...s.hole],
      }))
  }

  // ---------------- showdown ----------------

  private showdown() {
    const alive = this.activeInHand()
    this.phase = 'SHOWDOWN'
    this.clearTimer()
    this.actionDeadline = null

    // evaluate every remaining player (variant-aware)
    const omaha = this.gameType() !== 'holdem'
    const evals = new Map<string, ReturnType<typeof evaluate>>()
    for (const p of alive) {
      const ev = omaha ? evaluateOmaha(p.hole, this.board) : evaluate([...p.hole, ...this.board])
      evals.set(p.userId, ev)
      this.reveals.set(p.userId, { userId: p.userId, cards: [...p.hole], desc: ev.desc, best: ev.cards })
    }

    // build side pots from ALIVE players' committed levels. Dead money from
    // folded players flows into the alive levels below their committed —
    // levels defined only by folded stacks would have no eligible winners
    // and their slice would silently vanish, so they are never created.
    const committedPlayers = this.seats.filter((s): s is SeatPlayer => !!s && s.committed > 0)
    const levels = [...new Set(alive.map((p) => p.committed))].sort((a, b) => a - b)
    const pots: { amount: number; eligible: SeatPlayer[] }[] = []
    let prev = 0
    for (const level of levels) {
      let amount = 0
      for (const p of committedPlayers) amount += Math.max(0, Math.min(p.committed, level) - prev)
      const eligible = alive.filter((p) => p.committed >= level)
      if (amount > 0 && eligible.length > 0) pots.push({ amount, eligible })
      prev = level
    }

    const wins = new Map<string, number>()
    const descs = new Map<string, string>()
    let potIdx = 0
    for (const pot of pots) {
      potIdx++
      let best: SeatPlayer[] = []
      let bestScore: number[] | null = null
      for (const p of pot.eligible) {
        const sc = evals.get(p.userId)!.score
        if (!bestScore || this.cmpScore(sc, bestScore) > 0) {
          bestScore = sc
          best = [p]
        } else if (this.cmpScore(sc, bestScore) === 0) {
          best.push(p)
        }
      }
      const share = Math.floor(pot.amount / best.length)
      let remainder = pot.amount - share * best.length
      // Odd chips go to the first hand LEFT of the button (PokerStars / TDA
      // rule). seatDistance ranks the dealer 0 — first — which would hand the
      // odd chip to the BUTTON whenever he is part of the split (heads-up
      // chops), so rank the dealer LAST instead.
      const oddRank = (p: SeatPlayer) => {
        const d = this.seatDistance(p.seatIndex)
        return d === 0 ? this.cfg.maxSeats : d
      }
      const ordered = [...best].sort((a, b) => oddRank(a) - oddRank(b))
      // per-pot share (NOT cumulative across pots) for the trail's win steps
      const potShare = new Map<string, number>()
      for (const p of ordered) {
        let amt = share
        if (remainder > 0) {
          amt += 1
          remainder--
        }
        p.stack += amt
        wins.set(p.userId, (wins.get(p.userId) ?? 0) + amt)
        potShare.set(p.userId, amt)
        descs.set(p.userId, evals.get(p.userId)!.desc)
      }
      this.addLog(
        `${potIdx > 1 ? 'Side pot' : 'Pot'} ${pot.amount} → ${ordered.map((p) => p.name).join(' & ')} (${evals.get(ordered[0].userId)!.desc})`,
      )
      for (const p of ordered) {
        this.tAdd({
          street: 'SHOWDOWN',
          act: 'win',
          who: p.name,
          amt: potShare.get(p.userId) ?? 0,
          desc: evals.get(p.userId)!.desc ?? undefined,
        })
      }
    }

    const potTotal = pots.reduce((a, p) => a + p.amount, 0)
    this.pot = 0
    this.totalPotSum += potTotal
    for (const [userId, amt] of wins) this.winAmounts.set(userId, amt)

    const results = [...wins.entries()].map(([userId, amount]) => {
      const p = this.seatOf(userId)!
      return {
        userId,
        name: p.name,
        amount,
        desc: descs.get(userId)!,
        cards: evals.get(userId)!.cards,
      }
    })
    const summary: HandSummary = {
      tableKey: this.cfg.key,
      handNumber: this.handNumber,
      board: [...this.board],
      potTotal,
      results,
      participants: this.buildParticipants(),
      log: [...this.log],
      trail: [...this.trail],
    }
    this.lastSummary = summary
    this.handsPlayed++
    this.finishHand(summary, this.timings.showdownMs)
  }

  private cmpScore(a: number[], b: number[]): number {
    for (let i = 0; i < Math.min(a.length, b.length); i++) {
      if (a[i] !== b[i]) return a[i] > b[i] ? 1 : -1
    }
    return 0
  }

  private seatDistance(seatIndex: number): number {
    return (seatIndex - this.dealerSeat + this.cfg.maxSeats) % this.cfg.maxSeats
  }

  private finishHand(summary: HandSummary, delayMs: number) {
    this.actorSeat = -1
    this.actionDeadline = null
    this.clearTimer()
    this.emitChange()
    this.cb.onHandFinished(summary)
    this.schedule(() => this.cleanupBetweenHands(), delayMs, 'cleanup')
  }

  private cleanupBetweenHands() {
    if (this.destroyed) return
    // stand up players who requested leave
    for (const p of [...this.seats]) {
      if (!p) continue
      if (p.wantsLeave) {
        this.executeStandUp(p)
      } else if (p.stack <= 0) {
        if (this.cfg.tournament) {
          // tournament bust — seat cleared, host tracks the finishing place
          this.addLog(`${p.name} is eliminated`)
          this.seats[p.seatIndex] = null
          this.cb.onBust?.(p.userId, this.cfg.key)
        } else if (p.isBot) {
          // play-money bots simply rebuy
          p.stack = this.cfg.minBuyIn * 4
          this.addLog(`${p.name} reloads ${p.stack} chips`)
        } else {
          this.executeStandUp(p)
        }
      }
    }
    for (const p of this.seats) {
      if (p) {
        p.inHand = false
        p.folded = false
        p.allIn = false
        p.hasActed = false
        p.bet = 0
        p.committed = 0
        p.hole = []
        p.lastAction = null
      }
    }
    this.board = []
    this.pot = 0
    this.currentBet = 0
    this.phase = 'WAITING'
    this.emitChange()
    this.maybeScheduleStart()
  }

  // ---------------- misc ----------------

  private addLog(line: string) {
    this.log.push(line)
    if (this.log.length > MAX_LOG) this.log.splice(0, this.log.length - MAX_LOG)
  }

  /** append one public step to the current hand's action trail */
  private tAdd(a: Omit<HandTrailAction, 'n'>) {
    this.trail.push({ ...a, n: ++this.trailN })
  }

  /** current street for trail entries — 'WAITING' is impossible mid-hand but map it anyway */
  private trailStreet(): HandTrailAction['street'] {
    return this.phase === 'WAITING' ? 'PREFLOP' : this.phase
  }

  private emitChange() {
    this.cb.onChange()
  }

  lobbySummary(): LobbyTableSummary {
    const seated = this.seats.filter((s): s is SeatPlayer => !!s)
    return {
      tableKey: this.cfg.key,
      name: this.cfg.name,
      smallBlind: this.cfg.smallBlind,
      bigBlind: this.cfg.bigBlind,
      maxSeats: this.cfg.maxSeats,
      minBuyIn: this.cfg.minBuyIn,
      maxBuyIn: this.cfg.maxBuyIn,
      gameType: this.gameType(),
      playersSeated: seated.length,
      humansSeated: seated.filter((s) => !s.isBot).length,
      humansConnected: seated.filter((s) => !s.isBot && s.connected).length,
      botsSeated: seated.filter((s) => s.isBot).length,
      inHand: this.isBettingPhase() || this.phase === 'SHOWDOWN',
      avgPot: this.handsPlayed > 0 ? Math.round(this.totalPotSum / this.handsPlayed) : 0,
      handsPlayed: this.handsPlayed,
      botOnly: seated.every((s) => s.isBot),
    }
  }

  // ---------------- view snapshot ----------------

  snapshotFor(userId: string | null): ClientTableView {
    const self = userId ? this.seatOf(userId) : null
    const seats: ClientPlayerView[] = this.seats.map((p, i): ClientPlayerView => {
      if (!p)
        return {
          seatIndex: i,
          userId: '',
          name: '',
          isBot: false,
          stack: 0,
          bet: 0,
          committed: 0,
          cards: [],
          cardsRevealed: false,
          status: 'EMPTY',
          isDealer: false,
          isSmallBlind: false,
          isBigBlind: false,
          isActor: false,
          lastAction: null,
          connected: true,
          handDesc: null,
          winAmount: null,
          isSelf: false,
        }
      const reveal = this.reveals.get(p.userId)
      // reveals exist only at showdown or during an all-in runout (both public
      // moments) — showdown() always overwrites runout entries with desc/best
      const showCards = !!reveal
      return {
        seatIndex: i,
        userId: p.userId,
        name: p.name,
        isBot: p.isBot,
        stack: p.stack,
        bet: p.bet,
        committed: p.committed,
        cards: showCards
          ? reveal!.cards.map(cardCode)
          : self && p.userId === self.userId
            ? p.hole.map(cardCode)
            : p.inHand
              ? p.hole.map(() => null)
              : [],
        cardsRevealed: showCards,
        status: p.inHand
          ? p.allIn
            ? 'ALL_IN'
            : 'IN_HAND'
          : p.folded
            ? 'FOLDED'
            : p.sittingOut
              ? 'SITTING_OUT'
              : 'WAITING',
        isDealer: p.inHand && i === this.dealerSeat,
        isSmallBlind: this.phase === 'PREFLOP' && i === this.sbSeat,
        isBigBlind: this.phase === 'PREFLOP' && i === this.bbSeat,
        isActor: i === this.actorSeat,
        lastAction: p.lastAction,
        connected: p.connected,
        handDesc: reveal?.desc ?? null,
        winAmount: this.winAmounts.get(p.userId) ?? null,
        isSelf: !!self && p.userId === self.userId,
      }
    })

    let selfOptions: SelfOptions | null = null
    if (self && self.seatIndex === this.actorSeat && this.isBettingPhase() && !self.folded && !self.allIn) {
      const toCall = this.currentBet - self.bet
      const maxTo = self.bet + self.stack
      const canRaise =
        maxTo > this.currentBet && !(this.lastRaiseIncomplete && self.hasActed) && this.canActPlayers().length >= 2
      const minTo =
        this.currentBet === 0 ? this.cfg.bigBlind : Math.min(this.currentBet + this.minRaise, maxTo)
      // pot-limit tables: slider/quick-size ceiling is the pot cap; no-limit
      // tables keep the stack as the only ceiling and expose the true
      // pot-size raise-to as the 'pot' quick-size reference
      const potCap = this.cfg.limit === 'pl' ? this.potLimitCap(self) : this.currentBet + this.streetPot() + Math.max(0, toCall)
      selfOptions = {
        canFold: true,
        canCheck: toCall <= 0,
        canCall: toCall > 0,
        callAmount: Math.min(toCall, self.stack),
        canBet: this.currentBet === 0 && self.stack > 0 && canRaise,
        canRaise,
        minBetTo: minTo,
        maxBetTo: this.cfg.limit === 'pl' ? Math.min(maxTo, potCap) : maxTo,
        potBetTo: Math.min(maxTo, potCap),
      }
    }

    return {
      tableKey: this.cfg.key,
      name: this.cfg.name,
      smallBlind: this.cfg.smallBlind,
      bigBlind: this.cfg.bigBlind,
      maxSeats: this.cfg.maxSeats,
      minBuyIn: this.cfg.minBuyIn,
      maxBuyIn: this.cfg.maxBuyIn,
      gameType: this.gameType(),
      phase: this.phase,
      handNumber: this.handNumber,
      board: this.board.map(cardCode),
      pot: this.pot + [...this.seats].reduce((a, p) => a + (p?.bet ?? 0), 0),
      currentBet: this.currentBet,
      minRaise: this.minRaise,
      actionDeadline: this.actionDeadline,
      actionWindow: this.actionDeadline != null ? this.timings.actionMs : null,
      actorUserId: this.actorSeat >= 0 ? (this.seats[this.actorSeat]?.userId ?? null) : null,
      seats,
      selfSeat: self ? self.seatIndex : null,
      selfCards: self && self.inHand ? self.hole.map(cardCode) : [],
      selfOptions,
      log: [...this.log].slice(-40),
      lastSummary: this.lastSummary
        ? {
            handNumber: this.lastSummary.handNumber,
            potTotal: this.lastSummary.potTotal,
            results: this.lastSummary.results,
            board: this.lastSummary.board.map(cardCode),
          }
        : null,
    }
  }
}
