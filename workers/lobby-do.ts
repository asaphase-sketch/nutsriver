/**
 * LobbyDO — one Durable Object that pushes live lobby state to every open
 * client socket, replacing per-client HTTP polling (free-tier rule: push over
 * poll — outbound WS messages cost nothing, inbound polls cost requests).
 *
 * Design (charter §2):
 * - Hibernation API: idle sockets are free; the DO sleeps entirely when the
 *   last viewer leaves (alarm cleared) and wakes on the next connection.
 * - One alarm fans out to table DOs + tournament DOs in parallel and
 *   broadcasts ONE combined payload; per-client cost is zero.
 * - Cadence adapts to room size: 15s for a small room (snappy), 45s when the
 *   room is busy (request budget scales for the 100-CCU target). Idle tables
 *   refresh round-robin, a few per tick, to respect the free-tier DO budget.
 * - HTTP /snapshot serves the cached payload for the /api/lobby fallback.
 */
import type { Env } from './env'
import type { LobbyTableSummary, TournamentLobbyItem } from '../src/lib/poker-engine/types'
import { TABLE_CONFIGS, tableSummariesForKeys, tournamentLobbyView } from './views'
import { captureDiag } from './diag'

const SMALL_ROOM = 15
const FAST_MS = 15_000
const SLOW_MS = 45_000
const MAX_CACHE_AGE_MS = 90_000
/** Idle tables refreshed per heartbeat (round-robin) — keeps DO requests inside the free tier. */
const IDLE_REFRESH_PER_TICK = 3

interface LobbyPayload {
  tables: LobbyTableSummary[]
  tournaments: TournamentLobbyItem[]
  at: number
}

export class LobbyDO {
  private state: DurableObjectState
  private env: Env
  private cache: LobbyPayload | null = null
  private refreshing: Promise<void> | null = null
  private rotateIdx = 0

  constructor(state: DurableObjectState, env: Env) {
    this.state = state
    this.env = env
  }

  // ---------- snapshot ----------

  /** Cached payload; refreshes in the background when stale. */
  private async snapshot(): Promise<LobbyPayload> {
    const fresh =
      this.cache != null && Date.now() - this.cache.at < MAX_CACHE_AGE_MS
    if (!fresh) await this.refresh()
    return (
      this.cache ?? { tables: [], tournaments: [], at: Date.now() }
    )
  }

  /**
   * Fan out to the tables that NEED a refresh + D1 tournament view — ONE
   * combined fetch round.
   *
   * Request budget (free tier): a full 10-table sweep every 10s costs ~86k
   * DO requests/day for ONE open lobby tab — the entire allowance (this
   * exhausted production on 2026-10-29). Instead each heartbeat refreshes
   * only LIVE tables (humans seated/connected or a hand running) plus a
   * rotating slice of IDLE ones; unrefreshed tables keep their cached row.
   */
  private async refresh(): Promise<void> {
    if (this.refreshing) return this.refreshing
    this.refreshing = (async () => {
      const allKeys = TABLE_CONFIGS.filter((cfg) => !cfg.hidden).map((cfg) => cfg.key)
      const cachedTables = this.cache?.tables ?? []
      const byKey = new Map(cachedTables.map((t) => [t.tableKey, t]))
      const live = allKeys.filter((key) => {
        const t = byKey.get(key)
        // unknown (never loaded) tables always count as live → first sweep is full
        return !t || t.humansSeated > 0 || t.humansConnected > 0 || t.inHand
      })
      const idle = allKeys.filter((key) => !live.includes(key))
      const idleSlice: string[] = []
      for (let i = 0; i < Math.min(IDLE_REFRESH_PER_TICK, idle.length); i++) {
        idleSlice.push(idle[(this.rotateIdx + i) % idle.length]!)
      }
      this.rotateIdx = (this.rotateIdx + idleSlice.length) % Math.max(1, idle.length)
      const [refreshed, tournaments] = await Promise.all([
        tableSummariesForKeys(this.env, [...live, ...idleSlice]),
        tournamentLobbyView(this.env.DB, this.env, null).catch(() => [] as TournamentLobbyItem[]),
      ])
      const fresh = new Map(refreshed.map((t) => [t.tableKey, t]))
      const tables: LobbyTableSummary[] = allKeys.map((key) => fresh.get(key) ?? byKey.get(key) ?? null).filter(
        (t): t is LobbyTableSummary => t != null,
      )
      this.cache = { tables, tournaments, at: Date.now() }
    })()
    try {
      await this.refreshing
    } finally {
      this.refreshing = null
    }
  }

  // ---------- websocket lifecycle (hibernation) ----------

  async fetch(request: Request): Promise<Response> {
    // TEMP diag: capture fatal errors into D1 before rethrowing (workers/diag.ts)
    try {
      return await this.handleFetch(request)
    } catch (e) {
      await captureDiag(this.env, 'lobby', e)
      throw e
    }
  }

  private async handleFetch(request: Request): Promise<Response> {
    const url = new URL(request.url)
    if (url.pathname.endsWith('/upgrade')) {
      const pair = new WebSocketPair()
      this.state.acceptWebSocket(pair[1], ['lobby'])
      // greet with the current snapshot immediately (refresh if cache is cold)
      const payload = await this.snapshot()
      this.send(pair[1], { t: 'lobby', ...payload })
      await this.arm()
      return new Response(null, { status: 101, webSocket: pair[0] })
    }
    if (url.pathname.endsWith('/snapshot')) {
      const payload = await this.snapshot()
      return Response.json(payload)
    }
    if (url.pathname.endsWith('/metrics')) {
      return Response.json({
        viewers: this.state.getWebSockets().length,
        cachedAt: this.cache?.at ?? null,
        tables: this.cache?.tables.length ?? 0,
      })
    }
    if (url.pathname.endsWith('/announce')) {
      // admin broadcast — push an announcement to every open lobby socket
      let message = ''
      try {
        const body = (await request.json()) as { message?: string }
        message = String(body?.message ?? '').slice(0, 200)
      } catch {
        return Response.json({ ok: false, error: 'Invalid JSON' }, { status: 400 })
      }
      if (!message) return Response.json({ ok: false, error: 'Message required' }, { status: 400 })
      const viewers = this.state.getWebSockets().length
      for (const ws of this.state.getWebSockets()) {
        this.send(ws, { t: 'announcement', message, at: Date.now() })
      }
      return Response.json({ ok: true, viewers })
    }
    return new Response('Not found', { status: 404 })
  }

  async webSocketOpen(ws: WebSocket) {
    // hibernation revival: greet again + keep the alarm alive
    const payload = await this.snapshot()
    this.send(ws, { t: 'lobby', ...payload })
    await this.arm()
  }

  async webSocketMessage(ws: WebSocket, msg: string | ArrayBuffer) {
    // the client says hello on every (re)connect — re-greet with fresh state
    if (typeof msg !== 'string') return
    try {
      const data = JSON.parse(msg) as { t?: string }
      if (data?.t === 'hello') {
        const payload = await this.snapshot()
        this.send(ws, { t: 'lobby', ...payload })
        await this.arm()
      }
    } catch {
      /* malformed message — ignore */
    }
  }

  async webSocketClose(_ws: WebSocket) {
    if (this.state.getWebSockets().length === 0) {
      // last viewer left — sleep (clear the alarm; next connection re-arms)
      await this.state.storage.deleteAlarm()
    }
  }

  async webSocketError(ws: WebSocket) {
    await this.webSocketClose(ws)
  }

  // ---------- alarm: the single heartbeat of the lobby ----------

  async alarm() {
    try {
      await this.alarmInner()
    } catch (e) {
      await captureDiag(this.env, 'lobby:alarm', e)
      throw e
    }
  }

  private async alarmInner() {
    const viewers = this.state.getWebSockets().length
    if (viewers === 0) {
      await this.state.storage.deleteAlarm()
      return
    }
    await this.refresh()
    const payload = this.cache
    if (payload) {
      for (const ws of this.state.getWebSockets()) {
        this.send(ws, { t: 'lobby', ...payload })
      }
    }
    await this.arm()
  }

  /** Re-arm the heartbeat; cadence widens with room size (charter §2 rule 3). */
  private async arm() {
    const viewers = this.state.getWebSockets().length
    const interval = viewers <= SMALL_ROOM ? FAST_MS : SLOW_MS
    const next = Date.now() + interval
    const current = await this.state.storage.getAlarm()
    if (current == null || next < current - 250) {
      await this.state.storage.setAlarm(next)
    }
  }

  private send(ws: WebSocket, payload: unknown) {
    try {
      ws.send(JSON.stringify(payload))
    } catch {
      /* socket closing */
    }
  }
}
