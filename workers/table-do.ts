/**
 * TableDO — one Durable Object per poker table (free-plan friendly).
 *
 * - Engine state is serialized to DO SQLite storage on every mutation and
 *   restored on wake, so the table survives eviction mid-hand.
 * - Deferred continuations (hand starts, streets, showdowns, action timeouts)
 *   are driven by durable alarms instead of setTimeout.
 * - WebSockets use the Hibernation API: idle connections cost nothing.
 * - Bots act only while a human is seated, so empty tables stay asleep.
 */
import { PokerTable } from '../src/lib/poker-engine/engine'
import { botDecide } from '../src/lib/poker-engine/bots'
import { parseCard, randomIntBelow } from '../src/lib/poker-engine/cards'
import { buyIn, cashOut, findUser, recordHand, getRobotsPolicy, setRobotsPolicy, type RobotsPolicy } from './store'
import { captureDiag } from './diag'
import type { Env } from './env'
import type { BotContext, ChatMessage, ClientPlayerView, ClientTableView, TableConfig } from '../src/lib/poker-engine/types'

export const TABLE_CONFIGS: TableConfig[] = [
  { key: 'beginners', name: 'Beginners Corner', smallBlind: 1, bigBlind: 2, maxSeats: 9, minBuyIn: 40, maxBuyIn: 600, botCount: 4 },
  { key: 'omahalite', name: 'Omaha Lite', smallBlind: 1, bigBlind: 2, maxSeats: 9, minBuyIn: 40, maxBuyIn: 600, botCount: 3, gameType: 'omaha4' },
  { key: 'greenroom', name: 'Green Room', smallBlind: 5, bigBlind: 10, maxSeats: 9, minBuyIn: 200, maxBuyIn: 5000, botCount: 3 },
  { key: 'omahajunction', name: 'Omaha Junction', smallBlind: 5, bigBlind: 10, maxSeats: 9, minBuyIn: 200, maxBuyIn: 5000, botCount: 3, gameType: 'omaha4' },
  { key: 'feltroyale', name: 'Felt Royale', smallBlind: 10, bigBlind: 20, maxSeats: 9, minBuyIn: 400, maxBuyIn: 8000, botCount: 3 },
  { key: 'highfive', name: 'High Five Club', smallBlind: 10, bigBlind: 20, maxSeats: 6, minBuyIn: 400, maxBuyIn: 8000, botCount: 2, gameType: 'omaha5' },
  { key: 'riverkings', name: 'River Kings', smallBlind: 25, bigBlind: 50, maxSeats: 6, minBuyIn: 1000, maxBuyIn: 20000, botCount: 2 },
  { key: 'omahaheights', name: 'Omaha Heights 5', smallBlind: 25, bigBlind: 50, maxSeats: 6, minBuyIn: 1000, maxBuyIn: 20000, botCount: 2, gameType: 'omaha5' },
  { key: 'highrollers', name: 'High Rollers', smallBlind: 100, bigBlind: 200, maxSeats: 6, minBuyIn: 4000, maxBuyIn: 50000, botCount: 2 },
  { key: 'nosebleed', name: 'Nosebleed Row', smallBlind: 500, bigBlind: 1000, maxSeats: 6, minBuyIn: 20000, maxBuyIn: 250000, botCount: 2 },
  // hidden table reserved for automated E2E runs (excluded from lobby/admin)
  { key: 'e2efelt', name: 'E2E Felt', smallBlind: 1, bigBlind: 2, maxSeats: 9, minBuyIn: 40, maxBuyIn: 600, botCount: 0, hidden: true },
]

const BOT_NAMES = [
  'ChipLeaderCarla', 'AllInAlex', 'BluffyBetty', 'RiverRatRay', 'TiltedTina',
  'PocketRocketPete', 'SandbaggingSam', 'LuckyLucy', 'NitNancy', 'GrinderGus',
]
let botNameIdx = 0
const nextBotName = () => BOT_NAMES[botNameIdx++ % BOT_NAMES.length]!

const HOUSEKEEPING_MS = 10_000
const MAX_CHAT = 60

export class TableDO {
  private state: DurableObjectState
  private env: Env
  private cfg: TableConfig
  private table: PokerTable | null = null
  private loaded: Promise<void> | null = null
  private chats: ChatMessage[] = []
  private dirty = false
  private botDue: number | null = null
  private hkAt = 0
  /** admin-controlled robots policy (global toggle + per-table seat target) */
  private policy: RobotsPolicy = { enabled: true, tableCounts: {} }
  private broadcastQueued = false

  constructor(state: DurableObjectState, env: Env) {
    this.state = state
    this.env = env
    const key = state.id.name
    this.cfg = TABLE_CONFIGS.find((t) => t.key === key) ?? TABLE_CONFIGS[0]!
  }

  // ---------- lifecycle ----------

  private ensureLoaded(): Promise<void> {
    if (!this.loaded) this.loaded = this.load()
    return this.loaded
  }

  private async load() {
    // TEMP diag: every load failure is captured into D1 (see workers/diag.ts)
    // before rethrowing, so the production 1101s become debuggable.
    try {
      await this.loadInner()
    } catch (e) {
      await captureDiag(this.env, `table:${this.cfg.key}`, e)
      throw e
    }
  }

  private async loadInner() {
    const savedEngine = await this.state.storage.get<string>('engine')
    const savedChat = await this.state.storage.get<string>('chat')
    try {
      this.policy = await getRobotsPolicy(this.env.DB)
    } catch {
      this.policy = { enabled: true, tableCounts: {} }
    }
    if (savedChat) {
      try {
        this.chats = JSON.parse(savedChat) as ChatMessage[]
      } catch {
        this.chats = []
      }
    }
    const now = Date.now()
    this.hkAt = now + HOUSEKEEPING_MS
    // test mode shortens the action timer so E2E runs complete in seconds
    const timings = this.env.E2E_FAST === '1' ? { actionMs: 3000, showdownMs: 800, awardMs: 800, streetMs: 500, startMs: 400 } : undefined
    this.table = new PokerTable(
      this.cfg,
      {
      onChange: () => this.onChange(),
      onHandFinished: (summary) => {
        recordHand(this.env.DB, summary)
      },
      onCashOut: (userId, amount) => {
        this.cashOutFor(userId, amount)
      },
      onSchedule: (at) => this.recomputeAlarm(at),
      canStartHand: () => this.humanSeated(),
      },
      timings,
    )
    if (savedEngine) {
      try {
        this.table.restoreState(savedEngine)
      } catch (e) {
        console.error(`[${this.cfg.key}] restore failed — starting fresh`, e)
        this.applyBotTarget(this.botTarget())
      }
    } else {
      this.applyBotTarget(this.botTarget())
    }
    // a bot may already be on the clock after restore
    const snap = this.table.snapshotFor(null)
    if (snap.actorUserId?.startsWith('bot:')) this.botDue = now + 1500
    await this.recomputeAlarm()
    await this.persistIfDirty()
  }

  // ---------- robots (admin-controlled) ----------

  /** Seat target for this table under the current policy. */
  private botTarget(): number {
    if (!this.policy.enabled) return 0
    const override = this.policy.tableCounts[this.cfg.key]
    return typeof override === 'number' ? Math.max(0, Math.min(override, this.cfg.maxSeats)) : this.cfg.botCount
  }

  /** Trim or top up house bots to exactly `target` seats. */
  private applyBotTarget(target: number) {
    if (!this.table) return
    const bots: ClientPlayerView[] = []
    for (const s of this.table.snapshotFor(null).seats) {
      if (s && s.isBot) bots.push(s)
    }
    let excess = bots.length - target
    // stand up the excess first — bots mid-hand are marked "leave after hand"
    // by standUp(), everyone else leaves immediately
    for (const b of bots) {
      if (excess <= 0) break
      this.table.standUp(b.userId)
      excess--
    }
    if (excess < 0) {
      for (let i = excess; i < 0; i++) {
        const empty: number[] = []
        for (let s = 0; s < this.cfg.maxSeats; s++) if (!this.table!.isOccupied(s)) empty.push(s)
        if (empty.length === 0) break
        const seat = empty[randomIntBelow(empty.length)]!
        const buyInAmount = Math.min(this.cfg.maxBuyIn, this.cfg.minBuyIn * (4 + randomIntBelow(4)))
        this.table.sitDown(`bot:${botNameIdx}`, nextBotName(), seat, buyInAmount, true)
      }
    }
  }

  /** Apply a policy pushed from the admin API and persist it. */
  async applyPolicy(policy: RobotsPolicy) {
    this.policy = policy
    this.applyBotTarget(this.botTarget())
    this.table?.drain(Date.now())
    await this.drainIo()
    await this.persistIfDirty()
    await this.recomputeAlarm()
  }

  private humanSeated(): boolean {
    if (!this.table) return false
    const snap = this.table.snapshotFor(null)
    return snap.seats.some((s) => s.status !== 'EMPTY' && !s.isBot)
  }

  // ---------- persistence & alarms ----------

  private onChange() {
    this.dirty = true
    this.queueBroadcast()
    const actor = this.table?.snapshotFor(null).actorUserId
    if (actor?.startsWith('bot:')) this.botDue = Date.now() + 900 + randomIntBelow(1900)
    else this.botDue = null
  }

  /** Coalesce bursts of engine updates into one WS send per microtask. */
  private queueBroadcast() {
    if (this.broadcastQueued) return
    this.broadcastQueued = true
    queueMicrotask(() => {
      this.broadcastQueued = false
      this.broadcast()
    })
  }

  private async persistIfDirty() {
    if (!this.dirty || !this.table) return
    this.dirty = false
    await this.state.storage.put('engine', this.table.serialize())
    await this.state.storage.put('chat', JSON.stringify(this.chats))
  }

  private async recomputeAlarm(engineWake?: number, force = false) {
    const candidates: number[] = []
    const wake = engineWake ?? this.table?.nextWakeAt() ?? null
    if (wake != null) candidates.push(wake)
    if (this.botDue != null) candidates.push(this.botDue)
    candidates.push(this.hkAt)
    const next = Math.min(...candidates)
    const current = await this.state.storage.getAlarm()
    // Never postpone from message handlers — a concurrent event may have set an
    // earlier (already due) alarm; postponing would cancel it and stall the hand.
    if (force || current == null || next < current - 250) {
      await this.state.storage.setAlarm(next)
    }
  }

  async alarm() {
    await this.ensureLoaded()
    const now = Date.now()
    if (!this.table) return
    if (this.env.E2E_FAST === '1')
      console.log(`[alarm] ${this.cfg.key} now=${now} wake=${this.table.nextWakeAt()} botDue=${this.botDue} hk=${this.hkAt} phase=${this.table.snapshotFor(null).phase} sockets=${this.state.getWebSockets().length}`)
    if (this.botDue != null && now >= this.botDue) {
      this.botDue = null
      this.driveBot(now)
    }
    if (now >= this.hkAt) {
      this.hkAt = now + HOUSEKEEPING_MS
      this.table.housekeeping(now)
    }
    this.table.drain(now)
    await this.drainIo()
    await this.persistIfDirty()
    // inside the alarm handler we are the authoritative recompute
    await this.recomputeAlarm(undefined, true)
  }

  /** Await any async engine-callback work (cash-outs, hand records). */
  private async drainIo() {
    if (this.ioJobs.length === 0) return
    const jobs = this.ioJobs
    this.ioJobs = []
    await Promise.allSettled(jobs)
  }

  // ---------- bots ----------

  private driveBot(now: number) {
    const table = this.table!
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
        gameType: this.cfg.gameType ?? 'holdem',
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
      console.error(`[${this.cfg.key}] bot error`, e)
    }
  }

  // ---------- sockets ----------

  async fetch(request: Request): Promise<Response> {
    await this.ensureLoaded()
    const url = new URL(request.url)
    if (url.pathname.endsWith('/upgrade')) {
      const userId = request.headers.get('x-nutsriver-user')
      if (!userId) return new Response('Unauthorized', { status: 401 })
      const username = request.headers.get('x-nutsriver-name') ?? 'Player'
      const pair = new WebSocketPair()
      this.state.acceptWebSocket(pair[1], [userId, username])
      // push initial payload directly — webSocketOpen does not always fire locally
      const view = this.table!.snapshotFor(userId)
      pair[1].send(JSON.stringify({ t: 'state', view }))
      pair[1].send(JSON.stringify({ t: 'chatHistory', tableKey: this.cfg.key, messages: this.chats }))
      this.table!.onConnect(userId)
      return new Response(null, { status: 101, webSocket: pair[0] })
    }
    if (url.pathname.endsWith('/summary')) {
      return Response.json(this.table!.lobbySummary())
    }
    if (url.pathname.endsWith('/metrics')) {
      const summary = this.table!.lobbySummary()
      return Response.json({
        tableKey: summary.tableKey,
        name: summary.name,
        humansSeated: summary.humansSeated,
        humansConnected: summary.humansConnected,
        botsSeated: summary.botsSeated,
        inHand: summary.inHand,
        handsPlayed: summary.handsPlayed,
        avgPot: summary.avgPot,
        sockets: this.state.getWebSockets().length,
      })
    }
    if (url.pathname.endsWith('/config')) {
      // admin route — GET returns the live policy view, POST applies a new one
      if (request.method === 'POST') {
        let body: RobotsPolicy | null = null
        try {
          body = (await request.json()) as RobotsPolicy
        } catch {
          return Response.json({ ok: false, error: 'Invalid JSON' }, { status: 400 })
        }
        if (!body || typeof body.enabled !== 'boolean' || typeof body.tableCounts !== 'object' || body.tableCounts === null) {
          return Response.json({ ok: false, error: 'enabled (bool) and tableCounts (object) required' }, { status: 400 })
        }
        const clean: RobotsPolicy = { enabled: body.enabled, tableCounts: {} }
        for (const cfg of TABLE_CONFIGS) {
          const v = body.tableCounts[cfg.key]
          if (typeof v === 'number' && Number.isFinite(v)) clean.tableCounts[cfg.key] = Math.max(0, Math.min(Math.floor(v), cfg.maxSeats))
        }
        await this.applyPolicy(clean)
        await setRobotsPolicy(this.env.DB, clean).catch(() => {})
        return Response.json({ ok: true, policy: clean })
      }
      const botsNow = this.table!.lobbySummary().botsSeated
      return Response.json({ ok: true, policy: this.policy, target: this.botTarget(), botsSeated: botsNow })
    }
    if (url.pathname.endsWith('/seat-of')) {
      const userId = url.searchParams.get('userId') ?? ''
      return Response.json({ seated: !!this.table!.seatOf(userId) })
    }
    if (url.pathname.endsWith('/force-stand')) {
      // admin route — immediate stand-up + full lifecycle so the cash-out
      // ledger entry and persistence actually happen
      const userId = url.searchParams.get('userId') ?? ''
      const err = this.table!.standUp(userId)
      if (err) return Response.json({ ok: false, error: err }, { status: 409 })
      this.table!.drain(Date.now())
      await this.drainIo()
      await this.persistIfDirty()
      await this.recomputeAlarm()
      return Response.json({ ok: true })
    }
    return new Response('Not found', { status: 404 })
  }

  async webSocketOpen(ws: WebSocket) {
    await this.ensureLoaded()
    if (!this.table) return
    this.send(ws, { t: 'state', view: this.table.snapshotFor(this.userIdOf(ws)) })
    this.send(ws, { t: 'chatHistory', tableKey: this.cfg.key, messages: this.chats })
    const userId = this.userIdOf(ws)
    if (userId) this.table.onConnect(userId)
  }

  async webSocketMessage(ws: WebSocket, msg: string | ArrayBuffer) {
    await this.ensureLoaded()
    if (typeof msg !== 'string') return
    const userId = this.userIdOf(ws)
    if (!userId) return
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
        // post-hibernation revival: re-send state + presence + authoritative balance
        this.send(ws, { t: 'state', view: this.table!.snapshotFor(userId) })
        this.send(ws, { t: 'chatHistory', tableKey: this.cfg.key, messages: this.chats })
        try {
          const u = await findUser(this.env.DB, userId)
          if (u) this.send(ws, { t: 'chips', chips: u.chips })
        } catch {
          /* balance resync is best-effort */
        }
        this.table!.onConnect(userId)
      } else if (type === 'sit') await this.handleSit(ws, userId, data)
      else if (type === 'stand') this.handleStand(userId)
      else if (type === 'sitout') this.table?.toggleSitOut(userId, !!data?.sitOut)
      else if (type === 'action') this.handleAction(userId, data)
      else if (type === 'rebuy') await this.handleRebuy(userId, data)
      else if (type === 'chat') this.handleChat(ws, userId, data)
    } catch (e) {
      console.error(`[${this.cfg.key}] message error`, e)
      this.send(ws, { t: 'err', message: 'Server error — try again' })
    }
    this.table?.drain(Date.now())
    await this.drainIo()
    await this.persistIfDirty()
    await this.recomputeAlarm()
  }

  async webSocketClose(ws: WebSocket) {
    await this.ensureLoaded()
    const userId = this.userIdOf(ws)
    if (!userId) return
    if (this.state.getWebSockets(userId).length === 0) {
      this.table?.onDisconnect(userId)
    }
    await this.persistIfDirty()
    await this.recomputeAlarm()
  }

  async webSocketError(ws: WebSocket) {
    await this.webSocketClose(ws)
  }

  private userIdOf(ws: WebSocket): string | null {
    const tags = this.state.getTags(ws)
    return tags[0] ?? null
  }

  private usernameOf(ws: WebSocket): string {
    const tags = this.state.getTags(ws)
    return tags[1] ?? 'Player'
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

  private broadcast() {
    if (!this.table) return
    for (const ws of this.state.getWebSockets()) {
      const userId = this.userIdOf(ws)
      const view = this.table.snapshotFor(userId)
      this.send(ws, { t: 'state', view })
    }
  }

  private addChat(msg: ChatMessage) {
    this.chats.push(msg)
    if (this.chats.length > MAX_CHAT) this.chats.splice(0, this.chats.length - MAX_CHAT)
    this.dirty = true
    for (const ws of this.state.getWebSockets()) this.send(ws, { t: 'chatMsg', msg: { ...msg, tableKey: this.cfg.key } })
  }

  // ---------- message handlers ----------

  private async handleSit(ws: WebSocket, userId: string, data: any) {
    const seatIndex = Number(data?.seatIndex)
    const amount = Math.floor(Number(data?.buyIn))
    if (!Number.isInteger(seatIndex) || seatIndex < 0) return this.send(ws, { t: 'err', message: 'Pick a seat' })
    if (!Number.isFinite(amount) || amount <= 0) return this.send(ws, { t: 'err', message: 'Invalid buy-in' })

    const deduct = await buyIn(this.env.DB, userId, amount, this.cfg.key)
    if (!deduct.ok) return this.send(ws, { t: 'err', message: deduct.error ?? 'Buy-in failed' })
    if (deduct.chips !== undefined) this.sendToUser(userId, { t: 'chips', chips: deduct.chips })

    const user = await findUser(this.env.DB, userId)
    const displayName = user?.username ?? this.usernameOf(ws)
    const err = this.table!.sitDown(userId, displayName, seatIndex, amount)
    if (err) {
      // seat got taken meanwhile — refund immediately
      const back = await cashOut(this.env.DB, userId, amount, this.cfg.key)
      if (back.ok && back.chips !== undefined) this.sendToUser(userId, { t: 'chips', chips: back.chips })
      return this.send(ws, { t: 'err', message: err })
    }
    this.addChat({
      id: `sys-${Date.now()}-${randomIntBelow(1e6)}`,
      from: 'system',
      name: 'Table',
      text: `${displayName} took seat ${seatIndex + 1}`,
      at: Date.now(),
      system: true,
    })
  }

  private handleStand(userId: string) {
    const err = this.table!.standUp(userId)
    if (err) this.sendToUser(userId, { t: 'err', message: err })
    else {
      const seat = this.table!.snapshotFor(userId).seats.find((s) => s.isSelf)
      this.addChat({
        id: `sys-${Date.now()}-${randomIntBelow(1e6)}`,
        from: 'system',
        name: 'Table',
        text: `${seat?.name ?? 'A player'} left the table`,
        at: Date.now(),
        system: true,
      })
    }
  }

  private handleAction(userId: string, data: any) {
    const type = data?.type
    if (type !== 'fold' && type !== 'check' && type !== 'call' && type !== 'bet' && type !== 'raise') {
      return this.sendToUser(userId, { t: 'err', message: 'Invalid action' })
    }
    const err = this.table!.applyAction(userId, type, Number(data?.amount ?? 0))
    if (err) this.sendToUser(userId, { t: 'err', message: err })
  }

  /** Seated top-up (cash tables): validate → deduct D1 → credit stack. */
  private async handleRebuy(userId: string, data: any) {
    const amount = Math.floor(Number(data?.amount))
    const err = this.table!.canRebuy(userId, amount)
    if (err) return this.sendToUser(userId, { t: 'err', message: err })

    const deduct = await buyIn(this.env.DB, userId, amount, this.cfg.key)
    if (!deduct.ok) return this.sendToUser(userId, { t: 'err', message: deduct.error ?? 'Top-up failed' })
    if (deduct.chips !== undefined) this.sendToUser(userId, { t: 'chips', chips: deduct.chips })

    // seat state could have changed while the D1 write was in flight
    const applyErr = this.table!.applyRebuy(userId, amount)
    if (applyErr) {
      const back = await cashOut(this.env.DB, userId, amount, this.cfg.key)
      if (back.ok && back.chips !== undefined) this.sendToUser(userId, { t: 'chips', chips: back.chips })
      return this.sendToUser(userId, { t: 'err', message: applyErr })
    }

    const seat = this.table!.snapshotFor(userId).seats.find((s) => s.isSelf)
    const user = await findUser(this.env.DB, userId)
    this.addChat({
      id: `sys-${Date.now()}-${randomIntBelow(1e6)}`,
      from: 'system',
      name: 'Table',
      text: `${user?.username ?? seat?.name ?? 'A player'} tops up ${amount} chips`,
      at: Date.now(),
      system: true,
    })
  }

  private handleChat(ws: WebSocket, userId: string, data: any) {
    const text = String(data?.text ?? '').trim().slice(0, 200)
    if (!text) return
    if (this.rateLimited(ws, 10, 10_000)) return
    this.addChat({
      id: `c-${Date.now()}-${randomIntBelow(1e6)}`,
      from: userId,
      name: this.usernameOf(ws),
      text,
      at: Date.now(),
    })
  }

  /** Cash out via engine callback (async D1 work is tracked and awaited). */
  private ioJobs: Promise<unknown>[] = []

  private cashOutFor(userId: string, amount: number) {
    this.ioJobs.push(
      cashOut(this.env.DB, userId, amount, this.cfg.key).then((r) => {
        if (r.ok && r.chips !== undefined) this.sendToUser(userId, { t: 'chips', chips: r.chips })
      }),
    )
  }
}
