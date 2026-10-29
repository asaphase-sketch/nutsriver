/**
 * TournamentDO — one Durable Object per tournament.
 *
 * Hosts every table of the tournament as an internal PokerTable instance
 * (tables are tiny — a 90-player event is ten 9-max engines), which makes
 * balancing/consolidation a simple in-memory move instead of cross-DO
 * choreography. One alarm drives all tables, the blind clock and bots.
 *
 * Lifecycle: registering → running → finished (or cancelled).
 *   - registration happens in D1 (chip deduction + roster rows)
 *   - /start assigns seats across tables and flips to running
 *   - the engine fires onHandFinished BEFORE cleanup busts players, so
 *     bounties are awarded by detecting zero-stack seats at hand end
 *   - busts are recorded in bust order; the final player standing wins
 *   - payouts (prize pool + bounties) are paid in one D1 batch at the end
 *
 * Clients speak the exact same WS protocol as cash tables — the worker routes
 * `t:<tid>:<n>` table keys to this DO, so the existing table UI just works.
 */
import { PokerTable } from '../src/lib/poker-engine/engine'
import { botDecide } from '../src/lib/poker-engine/bots'
import { parseCard, randomIntBelow } from '../src/lib/poker-engine/cards'
import {
  blindLevel,
  type BotContext,
  type ChatMessage,
  type TournamentConfig,
  type TournamentState,
} from '../src/lib/poker-engine/types'
import {
  getTournament,
  setTournamentFields,
  tournamentEntries,
  finishTournamentPayouts,
  recordHand,
  findUser,
} from './store'
import type { Env } from './env'

const BOT_NAMES = [
  'ChipLeaderCarla', 'AllInAlex', 'BluffyBetty', 'RiverRatRay', 'TiltedTina',
  'PocketRocketPete', 'SandbaggingSam', 'LuckyLucy', 'NitNancy', 'GrinderGus',
]
let botNameIdx = 0
const nextBotName = () => BOT_NAMES[botNameIdx++ % BOT_NAMES.length]!

const MAX_CHAT = 60

/** Prize fractions by finishing place, normalized to sum = 1. */
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

interface RosterEntry {
  userId: string
  name: string
  isBot: boolean
  tableKey: string | null // internal table id like 't0'
  place: number | null
  bounty: number
}

const tableKeyOf = (tid: string, n: number) => `t:${tid}:${n}`

export class TournamentDO {
  private state: DurableObjectState
  private env: Env
  private tid = ''
  private cfg: TournamentConfig | null = null
  private tstate: TournamentState = 'registering'
  private level = 0
  private levelEndsAt: number | null = null
  private tables = new Map<string, PokerTable>() // internal keys t0, t1...
  private roster = new Map<string, RosterEntry>()
  private bustOrder: string[] = []
  private bountyPaid = 0
  private chats: ChatMessage[] = []
  private botDue = new Map<string, number>()
  private dirty = false
  private loaded: Promise<void> | null = null
  private ioJobs: Promise<unknown>[] = []
  private broadcastQueued = new Set<string>()
  private botSeq = 0

  constructor(state: DurableObjectState, env: Env) {
    this.state = state
    this.env = env
    this.tid = state.id.name ?? ''
  }

  // ---------- lifecycle ----------

  private ensureLoaded(): Promise<void> {
    if (!this.loaded) this.loaded = this.load()
    return this.loaded
  }

  private async load() {
    const savedCfg = await this.state.storage.get<string>('cfg')
    if (savedCfg) {
      try {
        this.cfg = JSON.parse(savedCfg) as TournamentConfig
      } catch {
        this.cfg = null
      }
    }
    if (!this.cfg) {
      const row = await getTournament(this.env.DB, this.tid)
      if (!row) return
      this.cfg = {
        id: row.id,
        name: row.name,
        gameType: row.gameType as TournamentConfig['gameType'],
        kind: row.kind as TournamentConfig['kind'],
        buyIn: row.buyIn,
        bounty: row.bounty,
        startingStack: row.startingStack,
        seatsPerTable: row.seatsPerTable,
        maxPlayers: row.maxPlayers,
        startAt: row.startAt,
        levelMs: row.levelMs,
        createdAt: row.createdAt,
      }
    }
    const savedState = await this.state.storage.get<string>('runtime')
    if (savedState) {
      try {
        const d = JSON.parse(savedState) as {
          tstate: TournamentState
          level: number
          levelEndsAt: number | null
          roster: [string, RosterEntry][]
          bustOrder: string[]
          bountyPaid: number
          chats: ChatMessage[]
        }
        this.tstate = d.tstate
        this.level = d.level
        this.levelEndsAt = d.levelEndsAt
        this.roster = new Map(d.roster)
        this.bustOrder = d.bustOrder
        this.bountyPaid = d.bountyPaid
        this.chats = d.chats ?? []
      } catch {
        /* fresh runtime */
      }
    }
    // restore table engines
    const engineBlobs = await this.state.storage.list<string>({ prefix: 'engine:' })
    for (const [k, blob] of engineBlobs) {
      const internal = k.slice('engine:'.length)
      const table = this.makeTable(internal)
      try {
        table.restoreState(blob)
      } catch (e) {
        console.error(`[${this.tid}] table ${internal} restore failed`, e)
      }
      this.tables.set(internal, table)
    }
    const now = Date.now()
    // scheduled tournaments start even if nobody is polling the lobby
    if (this.tstate === 'registering' && this.cfg.startAt && now >= this.cfg.startAt) {
      const d1 = await this.d1EntryCount()
      if (d1 + this.botCount() >= 2) await this.start()
    }
    await this.recomputeAlarm()
    await this.persistIfDirty()
  }

  private baseBb(): number {
    return Math.max(2, Math.floor((this.cfg?.startingStack ?? 1500) / 150))
  }

  private makeTable(internal: string): PokerTable {
    const lvl = blindLevel(this.level, this.baseBb())
    const seats = this.cfg?.seatsPerTable ?? 9
    const table = new PokerTable(
      {
        key: tableKeyOf(this.tid, Number(internal.slice(1))),
        name: `${this.cfg?.name ?? 'Tournament'} · Table ${Number(internal.slice(1)) + 1}`,
        smallBlind: lvl.sb,
        bigBlind: lvl.bb,
        maxSeats: seats,
        minBuyIn: this.cfg?.startingStack ?? 1500,
        maxBuyIn: this.cfg?.startingStack ?? 1500,
        botCount: 0,
        gameType: this.cfg?.gameType ?? 'holdem',
        tournament: true,
      },
      {
        onChange: () => this.onChange(internal),
        onHandFinished: (summary) => {
          this.ioJobs.push(recordHand(this.env.DB, summary))
          this.onHandFinished(internal, summary)
        },
        onCashOut: () => {
          /* tournaments never cash out — busts are tracked via onBust */
        },
        onBust: (userId) => this.onBust(internal, userId),
        onSchedule: (at) => this.recomputeAlarm(at),
        canStartHand: () => true,
      },
      this.env.E2E_FAST === '1'
        ? { actionMs: 2500, showdownMs: 700, awardMs: 700, streetMs: 400, startMs: 300 }
        : undefined,
    )
    return table
  }

  // ---------- persistence & alarms ----------

  private onChange(internal: string) {
    this.dirty = true
    this.queueBroadcast(internal)
    const table = this.tables.get(internal)
    const actor = table?.snapshotFor(null).actorUserId
    if (actor?.startsWith('bot:')) this.botDue.set(internal, Date.now() + 900 + randomIntBelow(1900))
    else this.botDue.delete(internal)
  }

  private queueBroadcast(internal: string) {
    if (this.broadcastQueued.has(internal)) return
    this.broadcastQueued.add(internal)
    queueMicrotask(() => {
      this.broadcastQueued.delete(internal)
      this.broadcastTable(internal)
    })
  }

  private async persistIfDirty() {
    if (!this.dirty || !this.cfg) return
    this.dirty = false
    await this.state.storage.put('cfg', JSON.stringify(this.cfg))
    await this.state.storage.put(
      'runtime',
      JSON.stringify({
        tstate: this.tstate,
        level: this.level,
        levelEndsAt: this.levelEndsAt,
        roster: [...this.roster.entries()],
        bustOrder: this.bustOrder,
        bountyPaid: this.bountyPaid,
        chats: this.chats,
      }),
    )
    for (const [internal, table] of this.tables) {
      await this.state.storage.put(`engine:${internal}`, table.serialize())
    }
  }

  private async recomputeAlarm(engineWake?: number, force = false) {
    const candidates: number[] = []
    if (engineWake != null) candidates.push(engineWake)
    for (const t of this.tables.values()) {
      const w = t.nextWakeAt()
      if (w != null) candidates.push(w)
    }
    for (const due of this.botDue.values()) candidates.push(due)
    if (this.levelEndsAt != null && this.tstate === 'running') candidates.push(this.levelEndsAt)
    if (this.tstate === 'registering' && this.cfg?.startAt) candidates.push(this.cfg.startAt)
    // No periodic housekeeping for tournaments: disconnected players auto-fold
    // via engine autoAct deadlines and blind off — all demand-driven wakes.
    // A finished/silent tournament must SLEEP completely (free-tier DO request
    // budget: an always-armed 10s heartbeat per DO burns ~86k requests/day).
    if (candidates.length === 0) {
      const current = await this.state.storage.getAlarm()
      if (current != null) await this.state.storage.deleteAlarm()
      return
    }
    const next = Math.min(...candidates)
    const current = await this.state.storage.getAlarm()
    if (force || current == null || next < current - 250) {
      await this.state.storage.setAlarm(next)
    }
  }

  async alarm() {
    await this.ensureLoaded()
    if (!this.cfg) return
    const now = Date.now()
    if (this.tstate === 'registering' && this.cfg.startAt && now >= this.cfg.startAt) {
      const d1 = await this.d1EntryCount()
      if (d1 + this.botCount() >= 2) await this.start()
    }
    if (this.tstate === 'running') {
      if (this.levelEndsAt != null && now >= this.levelEndsAt) await this.advanceLevel()
      for (const [internal, due] of [...this.botDue.entries()]) {
        if (now >= due) {
          this.botDue.delete(internal)
          this.driveBot(internal)
        }
      }
      for (const table of this.tables.values()) table.drain(now)
    }
    await this.drainIo()
    await this.persistIfDirty()
    await this.recomputeAlarm(undefined, true)
  }

  private async drainIo() {
    if (this.ioJobs.length === 0) return
    const jobs = this.ioJobs
    this.ioJobs = []
    await Promise.allSettled(jobs)
  }

  // ---------- registration / start ----------

  private botCount(): number {
    let n = 0
    for (const r of this.roster.values()) if (r.isBot) n++
    return n
  }

  private async d1EntryCount(): Promise<number> {
    try {
      return (await tournamentEntries(this.env.DB, this.tid)).length
    } catch {
      return 0
    }
  }

  /** Admin: seat N bot stand-ins. Only while registering. */
  async fillBots(count: number): Promise<number> {
    await this.ensureLoaded()
    if (!this.cfg || this.tstate !== 'registering') return 0
    const d1 = await this.d1EntryCount()
    let added = 0
    while (d1 + this.botCount() < this.cfg.maxPlayers && added < count) {
      const userId = `bot:tn${this.tid.slice(0, 6)}-${this.botSeq++}`
      this.roster.set(userId, { userId, name: nextBotName(), isBot: true, tableKey: null, place: null, bounty: 0 })
      added++
    }
    this.dirty = true
    if (this.cfg.kind === 'sitgo' && d1 + this.botCount() >= this.cfg.maxPlayers) await this.start()
    else {
      await this.persistIfDirty()
      await this.recomputeAlarm()
    }
    return added
  }

  /** Flip to running: assign seats, start the blind clock, deal. */
  async start(): Promise<{ ok: boolean; error?: string }> {
    await this.ensureLoaded()
    if (!this.cfg) return { ok: false, error: 'Unknown tournament' }
    if (this.tstate !== 'registering') return { ok: false, error: 'Tournament already started' }
    const d1Entries = await tournamentEntries(this.env.DB, this.tid)
    if (d1Entries.length + this.botCount() < 2) return { ok: false, error: 'Not enough players' }

    // prize pool from PAID (human) entries only — bots are house stand-ins
    const prizePool = d1Entries.length * Math.max(0, this.cfg.buyIn - this.cfg.bounty)
    await setTournamentFields(this.env.DB, this.tid, { state: 'running', prizePool })

    const tableCount = Math.max(1, Math.ceil((d1Entries.length + this.botCount()) / this.cfg.seatsPerTable))
    const humans = d1Entries.map((e) => ({ userId: e.userId, name: e.username ?? 'Player', isBot: false }))
    const bots = [...this.roster.values()].filter((r) => r.isBot).map((b) => ({ userId: b.userId, name: b.name, isBot: true }))
    const everyone = [...humans, ...bots]
    this.roster.clear()
    for (let i = 0; i < everyone.length; i++) {
      const p = everyone[i]!
      this.roster.set(p.userId, {
        userId: p.userId,
        name: p.name,
        isBot: p.isBot,
        tableKey: `t${i % tableCount}`,
        place: null,
        bounty: 0,
      })
    }
    for (let n = 0; n < tableCount; n++) {
      const internal = `t${n}`
      const table = this.tables.get(internal) ?? this.makeTable(internal)
      this.tables.set(internal, table)
      let seat = 0
      for (const r of this.roster.values()) {
        if (r.tableKey === internal) {
          table.sitDown(r.userId, r.name, seat % this.cfg.seatsPerTable, this.cfg.startingStack, r.isBot)
          seat++
        }
      }
    }
    this.tstate = 'running'
    this.level = 0
    this.levelEndsAt = Date.now() + this.cfg.levelMs
    this.dirty = true
    const lvl = blindLevel(0, this.baseBb())
    this.addChat({
      id: `sys-${Date.now()}`,
      from: 'system',
      name: 'Tournament',
      text: `Cards in the air! ${everyone.length} players — blinds ${lvl.sb}/${lvl.bb}`,
      at: Date.now(),
      system: true,
    })
    for (const internal of this.tables.keys()) {
      this.tables.get(internal)!.maybeScheduleStart()
      this.broadcastTable(internal)
    }
    await this.persistIfDirty()
    await this.recomputeAlarm(undefined, true)
    return { ok: true }
  }

  // ---------- game flow ----------

  /**
   * The engine fires onHandFinished BEFORE its cleanup busts the zero-stack
   * players, so this is the moment to award knockout bounties: every seat on
   * this table with stack 0 is about to bust, and the biggest pot winner of
   * the hand collects the bounty for each of them.
   */
  private onHandFinished(internal: string, summary: { results: { userId: string; name: string; amount: number }[] }) {
    if (!this.cfg) return
    const table = this.tables.get(internal)
    if (!table) return
    const snap = table.snapshotFor(null)
    const bustedNow = snap.seats.filter((s) => s.status !== 'EMPTY' && s.stack <= 0)
    if (bustedNow.length > 0 && this.cfg.bounty > 0) {
      const topWinner = summary.results[0]?.userId
      const winnerEntry = topWinner ? this.roster.get(topWinner) : null
      const cap = this.cfg.maxPlayers * this.cfg.bounty
      if (winnerEntry && this.bountyPaid < cap) {
        for (const _b of bustedNow) {
          void _b
          if (this.bountyPaid >= cap) break
          winnerEntry.bounty += this.cfg.bounty
          this.bountyPaid += this.cfg.bounty
        }
      }
    }
    this.dirty = true
    this.applyPendingLevel()
    this.balanceTables()
    if (this.aliveCount() <= 1) void this.finish()
  }

  /** Engine cleanup busted a player — record their finishing place. */
  private onBust(_internal: string, userId: string) {
    const r = this.roster.get(userId)
    if (!r || r.place != null) return
    const aliveBefore = this.aliveCount() + 1 // they were still alive a moment ago
    r.place = aliveBefore
    this.bustOrder.push(userId)
    this.dirty = true
    this.addChat({
      id: `sys-${Date.now()}-${randomIntBelow(1e6)}`,
      from: 'system',
      name: 'Tournament',
      text: `${r.name} finished #${aliveBefore}`,
      at: Date.now(),
      system: true,
    })
    if (this.aliveCount() <= 1) void this.finish()
  }

  private aliveCount(): number {
    let n = 0
    for (const r of this.roster.values()) if (r.place == null) n++
    return n
  }

  private applyPendingLevel() {
    if (!this.cfg) return
    const lvl = blindLevel(this.level, this.baseBb())
    for (const table of this.tables.values()) {
      if (table.snapshotFor(null).phase === 'WAITING') table.setBlinds(lvl.sb, lvl.bb)
    }
  }

  private async advanceLevel() {
    if (!this.cfg) return
    this.level++
    const lvl = blindLevel(this.level, this.baseBb())
    this.levelEndsAt = Date.now() + this.cfg.levelMs
    for (const table of this.tables.values()) {
      if (table.snapshotFor(null).phase === 'WAITING') table.setBlinds(lvl.sb, lvl.bb)
    }
    this.dirty = true
    this.addChat({
      id: `sys-${Date.now()}-${randomIntBelow(1e6)}`,
      from: 'system',
      name: 'Tournament',
      text: `Level ${this.level + 1} — blinds ${lvl.sb}/${lvl.bb}`,
      at: Date.now(),
      system: true,
    })
    for (const internal of this.tables.keys()) this.broadcastTable(internal)
  }

  /** Move players between hands to keep tables balanced; merge into one when small. */
  private balanceTables() {
    if (!this.cfg || this.tstate !== 'running') return
    const seatLists = new Map<string, { userId: string; name: string; isBot: boolean; stack: number }[]>()
    for (const [internal, table] of this.tables) {
      const list: { userId: string; name: string; isBot: boolean; stack: number }[] = []
      for (const s of table.snapshotFor(null).seats) {
        if (s.status !== 'EMPTY' && s.userId) list.push({ userId: s.userId, name: s.name, isBot: s.isBot, stack: s.stack })
      }
      seatLists.set(internal, list)
    }
    const totalPlayers = [...seatLists.values()].reduce((a, l) => a + l.length, 0)
    if (totalPlayers === 0) return
    const maxPer = this.cfg.seatsPerTable

    const moveTo = (srcTable: PokerTable, destTable: PokerTable, p: { userId: string; name: string; isBot: boolean; stack: number }, destInternal: string) => {
      if (srcTable.snapshotFor(null).phase !== 'WAITING') return false // between hands only
      const seatIdx = this.firstOpenSeat(destTable)
      if (seatIdx == null) return false
      const err = srcTable.standUp(p.userId)
      if (err) return false
      destTable.sitDown(p.userId, p.name, seatIdx, Math.max(1, p.stack), p.isBot)
      const r = this.roster.get(p.userId)
      if (r) r.tableKey = destInternal
      this.dirty = true
      return true
    }

    // late merge: everyone fits on one table
    if (totalPlayers <= maxPer) {
      const target = 't0'
      const dest = this.tables.get(target)
      if (!dest) return
      for (const [internal, list] of seatLists) {
        if (internal === target) continue
        const src = this.tables.get(internal)
        if (!src) continue
        for (const p of list) {
          if (p.stack <= 0) continue // they are mid-bust; skip
          moveTo(src, dest, p, target)
        }
      }
      return
    }

    // balance: move one player from the fullest to the emptiest when diff ≥ 2
    const sizes = [...seatLists.entries()].map(([k, l]) => ({ k, n: l.length })).sort((a, b) => b.n - a.n)
    if (!sizes.length) return
    const full = sizes[0]!
    const empty = sizes[sizes.length - 1]!
    if (full.k !== empty.k && full.n - empty.n >= 2 && empty.n < maxPer) {
      const src = this.tables.get(full.k)
      const dest = this.tables.get(empty.k)
      if (src && dest) {
        const mover = seatLists.get(full.k)!.find((p) => p.stack > 0)
        if (mover) moveTo(src, dest, mover, empty.k)
      }
    }
  }

  private firstOpenSeat(table: PokerTable): number | null {
    for (const s of table.snapshotFor(null).seats) if (s.status === 'EMPTY') return s.seatIndex
    return null
  }

  private async finish() {
    if (!this.cfg || this.tstate !== 'running') return
    // winner = the only roster entry without a place
    let winner: RosterEntry | null = null
    for (const r of this.roster.values()) if (r.place == null) winner = r
    if (winner) {
      winner.place = 1
      this.bustOrder.push(winner.userId)
    }
    const prizePool = (await this.d1EntryCount()) * Math.max(0, this.cfg.buyIn - this.cfg.bounty)
    const fr = payoutFractions(Math.max(2, this.roster.size))
    const order = [...this.roster.values()].sort((a, b) => (a.place ?? 999) - (b.place ?? 999))
    const results = order.map((r, i) => ({
      userId: r.userId,
      place: r.place ?? i + 1,
      prize: i < fr.length ? Math.floor(prizePool * fr[i]!) : 0,
      bounty: r.bounty,
    }))
    await finishTournamentPayouts(this.env.DB, this.tid, results)
    await setTournamentFields(this.env.DB, this.tid, {
      state: 'finished',
      winnerUserId: winner && !winner.isBot ? winner.userId : (order.find((r) => !r.isBot)?.userId ?? null),
      finishedAt: Date.now(),
    })
    this.tstate = 'finished'
    this.levelEndsAt = null
    this.dirty = true
    if (winner) {
      this.addChat({
        id: `sys-${Date.now()}`,
        from: 'system',
        name: 'Tournament',
        text: `${winner.name} WINS the tournament!`,
        at: Date.now(),
        system: true,
      })
    }
    for (const internal of this.tables.keys()) this.broadcastTable(internal)
    await this.persistIfDirty()
  }

  /** Cancel from the admin panel — stop the clock, worker refunds entries. */
  async cancel() {
    await this.ensureLoaded()
    this.tstate = 'cancelled'
    this.levelEndsAt = null
    for (const table of this.tables.values()) table.destroy()
    this.dirty = true
    await this.persistIfDirty()
  }

  // ---------- bots ----------

  private driveBot(internal: string) {
    const table = this.tables.get(internal)
    if (!table) return
    const snap = table.snapshotFor(null)
    const actorId = snap.actorUserId
    if (!actorId || !actorId.startsWith('bot:')) return
    try {
      const s2 = table.snapshotFor(actorId)
      if (s2.actorUserId !== actorId || !s2.selfOptions) return
      const opts = s2.selfOptions
      const actorView = s2.seats.find((x) => x.userId === actorId)
      if (!actorView) return
      const ctx: BotContext = {
        self: {
          userId: actorId,
          name: actorView.name,
          isBot: true,
          seatIndex: actorView.seatIndex,
          stack: actorView.stack,
          bet: actorView.bet,
          committed: actorView.committed,
          hole: [],
          inHand: true,
          folded: false,
          allIn: false,
          hasActed: false,
          lastAction: null,
          sittingOut: false,
          wantsLeave: false,
          connected: true,
          disconnectedAt: null,
        },
        hole: s2.selfCards.map(parseCard),
        board: s2.board.map(parseCard),
        phase: s2.phase,
        gameType: this.cfg?.gameType ?? 'holdem',
        currentBet: s2.currentBet,
        minRaiseTo: opts.minBetTo,
        maxBetTo: opts.maxBetTo,
        potTotal: Math.max(1, s2.pot),
        callAmount: opts.callAmount,
        canCheck: opts.canCheck,
        canRaise: opts.canRaise,
        activeOpponents: s2.seats.filter(
          (x) => x.userId && x.userId !== actorId && (x.status === 'IN_HAND' || x.status === 'ALL_IN'),
        ).length,
      }
      const decision = botDecide(ctx)
      if ((decision.type === 'bet' || decision.type === 'raise') && !opts.canRaise) {
        decision.type = opts.canCheck ? 'check' : 'call'
      }
      if (decision.type === 'call' && !opts.canCall) decision.type = opts.canCheck ? 'check' : 'fold'
      const err = table.applyAction(actorId, decision.type, decision.amount)
      if (err) table.applyAction(actorId, opts.canCheck ? 'check' : 'fold')
    } catch (e) {
      console.error(`[${this.tid}/${internal}] bot error`, e)
    }
  }

  // ---------- sockets ----------

  async fetch(request: Request): Promise<Response> {
    await this.ensureLoaded()
    if (!this.cfg) return Response.json({ error: 'Unknown tournament' }, { status: 404 })
    const url = new URL(request.url)
    const path = url.pathname

    if (path.endsWith('/upgrade')) {
      if (this.tstate !== 'running') return new Response('Tournament not running', { status: 409 })
      const userId = request.headers.get('x-nutsriver-user')
      if (!userId) return new Response('Unauthorized', { status: 401 })
      const username = request.headers.get('x-nutsriver-name') ?? 'Player'
      const requested = url.searchParams.get('table')
      const r = this.roster.get(userId)
      const internal = r?.tableKey ?? (requested ?? 't0')
      const table = this.tables.get(internal)
      if (!table) return Response.json({ error: 'Table not found' }, { status: 404 })
      const pair = new WebSocketPair()
      this.state.acceptWebSocket(pair[1], [userId, username, internal])
      pair[1].send(JSON.stringify({ t: 'state', view: table.snapshotFor(userId) }))
      pair[1].send(JSON.stringify({ t: 'chatHistory', tableKey: tableKeyOf(this.tid, Number(internal.slice(1))), messages: this.chats }))
      table.onConnect(userId)
      // registered but somehow seatless (e.g. moved while offline) — reseat
      const snap = table.snapshotFor(userId)
      if (r && r.place == null && snap.selfSeat == null) {
        const seatIdx = this.firstOpenSeat(table)
        if (seatIdx != null) table.sitDown(userId, username, seatIdx, this.cfg.startingStack, false)
      }
      return new Response(null, { status: 101, webSocket: pair[0] })
    }

    if (path.endsWith('/start')) return Response.json(await this.start())
    if (path.endsWith('/fill-bots')) {
      const count = Math.max(0, Math.min(200, Number(url.searchParams.get('count')) || 0))
      const added = await this.fillBots(count)
      return Response.json({ ok: true, added })
    }
    if (path.endsWith('/cancel')) {
      await this.cancel()
      return Response.json({ ok: true })
    }
    if (path.endsWith('/summary')) {
      const d1 = await this.d1EntryCount()
      const lvl = blindLevel(this.level, this.baseBb())
      return Response.json({
        tournamentId: this.tid,
        state: this.tstate,
        playersLeft: this.aliveCount(),
        entries: d1 + this.botCount(),
        level: this.level,
        blinds: lvl,
        levelEndsAt: this.levelEndsAt,
        tables: this.tables.size,
      })
    }
    if (path.endsWith('/seat-of')) {
      const userId = url.searchParams.get('userId') ?? ''
      const r = this.roster.get(userId)
      return Response.json({
        registered: this.roster.has(userId),
        eliminated: r?.place != null,
        place: r?.place ?? null,
        tableKey: r?.tableKey ? tableKeyOf(this.tid, Number(r.tableKey.slice(1))) : null,
      })
    }
    if (path.endsWith('/metrics')) {
      return Response.json({
        tournamentId: this.tid,
        state: this.tstate,
        playersLeft: this.aliveCount(),
        level: this.level,
        sockets: this.state.getWebSockets().length,
        tables: this.tables.size,
      })
    }
    return new Response('Not found', { status: 404 })
  }

  // ---------- WS handlers (same protocol as TableDO) ----------

  async webSocketOpen(ws: WebSocket) {
    await this.ensureLoaded()
    if (!this.cfg) return
    const internal = this.internalOf(ws)
    const table = internal ? this.tables.get(internal) : null
    if (!table) return
    const userId = this.userIdOf(ws)
    this.send(ws, { t: 'state', view: table.snapshotFor(userId) })
    this.send(ws, { t: 'chatHistory', tableKey: tableKeyOf(this.tid, Number(internal!.slice(1))), messages: this.chats })
    if (userId) table.onConnect(userId)
  }

  async webSocketMessage(ws: WebSocket, msg: string | ArrayBuffer) {
    await this.ensureLoaded()
    if (typeof msg !== 'string') return
    const userId = this.userIdOf(ws)
    if (!userId) return
    const internal = this.internalOf(ws)
    const table = internal ? this.tables.get(internal) : null
    if (!table) return
    if (this.rateLimited(ws)) return
    let data: any
    try {
      data = JSON.parse(msg)
    } catch {
      return
    }
    const type = String(data?.t ?? '')
    try {
      if (type === 'hello') {
        this.send(ws, { t: 'state', view: table.snapshotFor(userId) })
        this.send(ws, { t: 'chatHistory', tableKey: tableKeyOf(this.tid, Number(internal!.slice(1))), messages: this.chats })
        try {
          const u = await findUser(this.env.DB, userId)
          if (u) this.send(ws, { t: 'chips', chips: u.chips })
        } catch {
          /* best-effort balance resync */
        }
        table.onConnect(userId)
      } else if (type === 'sit') {
        // no buy-in — tournament seats are pre-assigned; reseat if seatless
        const r = this.roster.get(userId)
        if (r && r.place == null && table.snapshotFor(userId).selfSeat == null) {
          const seatIdx = this.firstOpenSeat(table)
          if (seatIdx != null) table.sitDown(userId, r.name, seatIdx, this.cfg!.startingStack, false)
        }
      } else if (type === 'stand') {
        // forfeit: leaving a running tournament eliminates you
        const err = table.standUp(userId)
        if (err) this.sendToUser(userId, { t: 'err', message: err })
      } else if (type === 'action') {
        const at = data?.type
        if (at !== 'fold' && at !== 'check' && at !== 'call' && at !== 'bet' && at !== 'raise') {
          return this.sendToUser(userId, { t: 'err', message: 'Invalid action' })
        }
        const err = table.applyAction(userId, at, Number(data?.amount ?? 0))
        if (err) this.sendToUser(userId, { t: 'err', message: err })
      } else if (type === 'chat') {
        const text = String(data?.text ?? '').trim().slice(0, 200)
        if (!text) return
        if (this.rateLimited(ws, 10, 10_000)) return
        this.addChat({ id: `c-${Date.now()}-${randomIntBelow(1e6)}`, from: userId, name: this.usernameOf(ws), text, at: Date.now() })
      }
    } catch (e) {
      console.error(`[${this.tid}] message error`, e)
      this.send(ws, { t: 'err', message: 'Server error — try again' })
    }
    table.drain(Date.now())
    await this.drainIo()
    await this.persistIfDirty()
    await this.recomputeAlarm()
  }

  async webSocketClose(ws: WebSocket) {
    await this.ensureLoaded()
    const userId = this.userIdOf(ws)
    const internal = this.internalOf(ws)
    const table = internal ? this.tables.get(internal) : null
    if (!userId || !table) return
    if (this.state.getWebSockets(userId).length === 0) table.onDisconnect(userId)
    await this.persistIfDirty()
    await this.recomputeAlarm()
  }

  async webSocketError(ws: WebSocket) {
    await this.webSocketClose(ws)
  }

  // ---------- helpers ----------

  private userIdOf(ws: WebSocket): string | null {
    return this.state.getTags(ws)[0] ?? null
  }

  private usernameOf(ws: WebSocket): string {
    return this.state.getTags(ws)[1] ?? 'Player'
  }

  private internalOf(ws: WebSocket): string | null {
    return this.state.getTags(ws)[2] ?? null
  }

  private rateBucket = new Map<WebSocket, { count: number; resetAt: number }>()

  private rateLimited(ws: WebSocket, max = 25, windowMs = 5000): boolean {
    const now = Date.now()
    let b = this.rateBucket.get(ws)
    if (!b || now > b.resetAt) {
      b = { count: 0, resetAt: now + windowMs }
      this.rateBucket.set(ws, b)
    }
    b.count++
    return b.count > max
  }

  private send(ws: WebSocket, payload: unknown) {
    try {
      ws.send(JSON.stringify(payload))
    } catch {
      /* socket closing */
    }
  }

  private sendToUser(userId: string, payload: unknown) {
    for (const ws of this.state.getWebSockets(userId)) this.send(ws, payload)
  }

  private broadcastTable(internal: string) {
    const table = this.tables.get(internal)
    if (!table) return
    for (const ws of this.state.getWebSockets()) {
      if (this.internalOf(ws) !== internal) continue
      const userId = this.userIdOf(ws)
      this.send(ws, { t: 'state', view: table.snapshotFor(userId) })
    }
  }

  private addChat(msg: ChatMessage) {
    this.chats.push(msg)
    if (this.chats.length > MAX_CHAT) this.chats.splice(0, this.chats.length - MAX_CHAT)
    this.dirty = true
    for (const ws of this.state.getWebSockets()) {
      const internal = this.internalOf(ws)
      const key = internal ? tableKeyOf(this.tid, Number(internal.slice(1))) : this.tid
      this.send(ws, { t: 'chatMsg', msg: { ...msg, tableKey: key } })
    }
  }
}
