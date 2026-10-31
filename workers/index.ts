/**
 * NutsRiver Worker — API routes + WebSocket upgrade + static assets.
 *
 * Same-origin paths the client already knows:
 *   POST /api/auth/register|login|logout|password   GET /api/auth/me
 *   GET  /api/lobby  GET /api/leaderboard  GET /api/my-tables
 *   POST /api/chips/claim                  WS  /api/poker-socket?table=<key|"lobby">
 *   everything else → static assets (Next.js export in /out)
 */
import { TableDO, TABLE_CONFIGS } from './table-do'
import { TournamentDO } from './tournament-do'
import { LobbyDO } from './lobby-do'
import { allTableSummaries, tableStub, tournamentLobbyView, tournamentStub } from './views'
import {
  ensureSchema, createUser, findUserByUsername, findUser, claimTopUp, countAdmins, promoteToAdmin,
  listUsers, adminAdjustChips, setUserBanned, adminOverview, adminActivity,
  listHands, getHand, listPlayerHands, getPlayerHand, listTransactions, getRobotsPolicy, setRobotsPolicy,
  pruneOldHands, pruneOldTransactions, getConfig,
  bumpSessionVer, setUsername, setPasswordHash, setUserRole, deleteUserAccount,
  bulkAdjustChips, adminLog, listAdminLog, listUserTransactions,
  createTournament, getTournament, registerForTournament,
  cancelTournament, adminListTournaments, setTournamentFields, listTopUsers,
  listTournaments, myTournamentEntries, tournamentEntries,
} from './store'
import { signToken, verifyToken, hashPassword, verifyPassword, parseCookie, sessionCookie, clearedSessionCookie, sessionExpiry, tokenMatchesUser } from './auth'
import type { Env } from './env'
import type { LobbyTableSummary, TournamentConfig, TournamentLobbyItem } from '../src/lib/poker-engine/types'

export { TableDO, TournamentDO, LobbyDO }

const VERSION = 'nutsriver-1.0.0'

// ---------- admin bootstrap ----------
// One-time claim: the first account that POSTs the matching passphrase from
// /admin becomes the site admin; afterwards the claim is burned (409).
// Only the SHA-256 digest ships in code — never the passphrase itself.
const ADMIN_CLAIM_SHA256 = '5e75d1eb565f7efa9c8d0ad7457ed018ca1cbbdb713b68b22dc6c75ecbf761a7'

async function sha256Hex(input: string): Promise<string> {
  const bits = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input))
  return [...new Uint8Array(bits)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

function timingSafeHexEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

const json = (data: unknown, init?: ResponseInit) =>
  Response.json(data, {
    ...init,
    headers: { 'Cache-Control': 'no-store', ...(init?.headers ?? {}) },
  })

// ---------- naive per-isolate rate limiting for auth endpoints ----------

const authBucket = new Map<string, { count: number; resetAt: number }>()

function authRateLimited(ip: string, max = 10, windowMs = 60_000, bucketKey?: string): boolean {
  const key = bucketKey ?? ip
  const now = Date.now()
  let b = authBucket.get(key)
  if (!b || now > b.resetAt) {
    b = { count: 0, resetAt: now + windowMs }
    authBucket.set(key, b)
  }
  b.count++
  return b.count > max
}

function clientIp(request: Request): string {
  return request.headers.get('cf-connecting-ip') ?? request.headers.get('x-forwarded-for') ?? 'local'
}

async function readJson<T>(request: Request): Promise<T | null> {
  try {
    return (await request.json()) as T
  } catch {
    return null
  }
}

// ---------- session helpers ----------

async function sessionOf(request: Request, env: Env) {
  const cookies = parseCookie(request.headers.get('cookie'))
  const token = cookies['poker_session']
  if (!token) return null
  const payload = await verifyToken(token, env.AUTH_SECRET)
  if (!payload) return null
  const user = await findUser(env.DB, payload.uid)
  // banned accounts lose all access immediately — even with a valid session;
  // a stale session generation (force-logout / password change) dies too
  if (!user || user.banned || !tokenMatchesUser(payload, user.sessionVer)) return null
  return { user, token }
}

/** Tournament table keys look like `t:<tournamentId>:<tableIndex>`. */
const TOURNAMENT_KEY = /^t:(.+):(\d+)$/

/** LobbyDO singleton — serves the live lobby socket + cached HTTP snapshot. */
function lobbyStub(env: Env): DurableObjectStub {
  return env.LOBBY.get(env.LOBBY.idFromName('lobby'))
}

function stubForTableKey(env: Env, key: string): { stub: DurableObjectStub; path: string } | null {
  const m = TOURNAMENT_KEY.exec(key)
  if (m) {
    const tid = m[1]!
    const idx = m[2]
    const stub = env.TOURNAMENT.get(env.TOURNAMENT.idFromName(tid))
    return { stub, path: `/tournament/${tid}/table/${idx}/upgrade` }
  }
  if (key === 'lobby') return { stub: lobbyStub(env), path: `/lobby/upgrade` }
  if (TABLE_CONFIGS.some((t) => t.key === key)) return { stub: tableStub(env, key), path: `/table/${key}/upgrade` }
  return null
}

// ---------- worker entry ----------

const worker: ExportedHandler<Env> = {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)
    const path = url.pathname

    try {
      await ensureSchema(env.DB)
    } catch (e) {
      console.error('[worker] schema failed', e)
      return json({ error: 'Database unavailable' }, { status: 503 })
    }

    // Fail fast when the deployment is misconfigured: signing a session
    // token with an empty secret would throw AFTER user rows were written
    // (register), leaving orphan accounts with no way to sign in.
    if (!env.AUTH_SECRET || env.AUTH_SECRET.length < 16) {
      console.error('[worker] AUTH_SECRET missing or too short — refusing state-changing auth')
      return json({ error: 'Server auth is not configured' }, { status: 503 })
    }

    // ---- auth ----
    if (path === '/api/auth/register' && request.method === 'POST') {
      if (authRateLimited(clientIp(request))) return json({ error: 'Too many attempts — slow down' }, { status: 429 })
      const body = await readJson<{ username?: string; password?: string }>(request)
      const username = String(body?.username ?? '').trim()
      const password = String(body?.password ?? '')
      if (!/^[a-zA-Z0-9_]{3,20}$/.test(username)) return json({ error: 'Username: 3-20 letters, numbers or underscore' }, { status: 400 })
      if (password.length < 8 || password.length > 100) return json({ error: 'Password must be 8-100 characters' }, { status: 400 })
      const existing = await findUserByUsername(env.DB, username)
      if (existing) return json({ error: 'Username taken' }, { status: 409 })
      const user = await createUser(env.DB, username, await hashPassword(password))
      if (!user) return json({ error: 'Could not create account — try again' }, { status: 500 })
      const token = await signToken({ uid: user.id, exp: sessionExpiry(), ver: user.sessionVer ?? 0 }, env.AUTH_SECRET)
      return json({ user }, { headers: { 'Set-Cookie': sessionCookie(token) } })
    }

    if (path === '/api/auth/login' && request.method === 'POST') {
      if (authRateLimited(clientIp(request))) return json({ error: 'Too many attempts — slow down' }, { status: 429 })
      const body = await readJson<{ username?: string; password?: string }>(request)
      const username = String(body?.username ?? '').trim()
      const password = String(body?.password ?? '')
      const record = await findUserByUsername(env.DB, username)
      // generic error — no username enumeration
      if (!record || record.banned || !(await verifyPassword(password, record.passwordHash))) {
        return json({ error: 'Invalid username or password' }, { status: 401 })
      }
      const token = await signToken({ uid: record.id, exp: sessionExpiry(), ver: record.sessionVer ?? 0 }, env.AUTH_SECRET)
      const { passwordHash: _ph, ...user } = record
      return json({ user }, { headers: { 'Set-Cookie': sessionCookie(token) } })
    }

    if (path === '/api/auth/logout' && request.method === 'POST') {
      return json({ ok: true }, { headers: { 'Set-Cookie': clearedSessionCookie() } })
    }

    if (path === '/api/auth/me' && request.method === 'GET') {
      const session = await sessionOf(request, env)
      return json({ user: session?.user ?? null })
    }

    // ---- self-service password change ----
    // Requires the current password. Bumps the session generation so every
    // OTHER device is logged out; the caller receives a fresh cookie.
    // Own rate-limit bucket (8/min per IP) — brute forcing the current-
    // password check is bounded by PBKDF2 cost + this cap, independent of
    // how busy the shared login/register bucket is.
    if (path === '/api/auth/password' && request.method === 'POST') {
      if (authRateLimited(clientIp(request), 8, 60_000, `pw:${clientIp(request)}`)) return json({ error: 'Too many attempts — slow down' }, { status: 429 })
      const session = await sessionOf(request, env)
      if (!session) return json({ error: 'Log in first' }, { status: 401 })
      const body = await readJson<{ currentPassword?: string; newPassword?: string }>(request)
      const current = String(body?.currentPassword ?? '')
      const next = String(body?.newPassword ?? '')
      if (next.length < 8 || next.length > 100) return json({ error: 'New password must be 8-100 characters' }, { status: 400 })
      const record = await findUserByUsername(env.DB, session.user.username)
      if (!record || !(await verifyPassword(current, record.passwordHash))) {
        return json({ error: 'Current password is incorrect' }, { status: 401 })
      }
      const newVer = (record.sessionVer ?? 0) + 1
      const ok = await setPasswordHash(env.DB, record.id, await hashPassword(next))
      if (!ok) return json({ error: 'Update failed' }, { status: 500 })
      await adminLog(env.DB, record.id, record.username, 'auth.password_change', record.username, 'self-service')
      const token = await signToken({ uid: record.id, exp: sessionExpiry(), ver: newVer }, env.AUTH_SECRET)
      const { passwordHash: _ph, ...user } = record
      return json({ user, ok: true }, { headers: { 'Set-Cookie': sessionCookie(token) } })
    }

    // ---- lobby (HTTP fallback — the live path is the LobbyDO socket) ----
    if (path === '/api/lobby' && request.method === 'GET') {
      // one DO request serves the cached combined snapshot instead of
      // fanning out to every table per client poll (charter §2 rule 3)
      try {
        const res = await lobbyStub(env).fetch('https://do/snapshot')
        if (res.ok) {
          const data = (await res.json()) as { tables: LobbyTableSummary[] }
          return json({ tables: data.tables ?? [] })
        }
      } catch {
        /* fall through to the direct fan-out */
      }
      const tables = await allTableSummaries(env)
      return json({ tables })
    }

    // ---- chip leaderboard (play-money standings, public read) ----
    if (path === '/api/leaderboard' && request.method === 'GET') {
      return json({ players: await listTopUsers(env.DB, 20) })
    }

    if (path === '/api/my-tables' && request.method === 'GET') {
      const session = await sessionOf(request, env)
      if (!session) return json({ error: 'Unauthorized' }, { status: 401 })
      const seated = await Promise.all(
        TABLE_CONFIGS.map(async (cfg) => {
          try {
            const res = await tableStub(env, cfg.key).fetch(`https://do/seat-of?userId=${encodeURIComponent(session.user.id)}`)
            const data = (await res.json()) as { seated: boolean }
            return data.seated ? cfg.key : null
          } catch {
            return null
          }
        }),
      )
      // running tournaments the player is still alive in
      const running = await listTournaments(env.DB, ['running'], 20)
      const myEntries = await myTournamentEntries(env.DB, session.user.id, 40)
      const entrySet = new Set(myEntries.filter((e) => e.eliminatedAt == null).map((e) => e.tournamentId))
      const tourneyTables: string[] = []
      for (const t of running) {
        if (!entrySet.has(t.id)) continue
        try {
          const res = await tournamentStub(env, t.id).fetch(`https://do/seat-of?userId=${encodeURIComponent(session.user.id)}`)
          const data = (await res.json()) as { tableKey?: string | null; eliminated?: boolean }
          if (data.tableKey && !data.eliminated) tourneyTables.push(data.tableKey)
        } catch {
          /* DO asleep */
        }
      }
      return json({ tables: [...seated.filter((k): k is string => k != null), ...tourneyTables] })
    }

    // ---- free chips ----
    if (path === '/api/chips/claim' && request.method === 'POST') {
      const session = await sessionOf(request, env)
      if (!session) return json({ error: 'Unauthorized' }, { status: 401 })
      const result = await claimTopUp(env.DB, session.user.id)
      if (!result.ok) return json({ error: result.error ?? 'Top-up unavailable', nextAt: result.nextAt }, { status: 400 })
      return json({ chips: result.chips })
    }

    // ---- my hand history (privacy-masked: opponents' cards only after showdown) ----
    if (path === '/api/my/hands' && request.method === 'GET') {
      const session = await sessionOf(request, env)
      if (!session) return json({ error: 'Unauthorized' }, { status: 401 })
      const tableKey = url.searchParams.get('table')
      const before = Number(url.searchParams.get('before')) || null
      const limit = Number(url.searchParams.get('limit')) || 15
      const hands = await listPlayerHands(env.DB, session.user.id, { tableKey: tableKey || null, before, limit })
      return json({ hands })
    }
    if (path === '/api/my/hand' && request.method === 'GET') {
      const session = await sessionOf(request, env)
      if (!session) return json({ error: 'Unauthorized' }, { status: 401 })
      const id = url.searchParams.get('id') ?? ''
      const hand = await getPlayerHand(env.DB, id, session.user.id)
      if (!hand) return json({ error: 'Hand not found' }, { status: 404 })
      return json({ hand })
    }

    // ---- tournaments (lobby + registration) ----
    if (path === '/api/tournaments' && request.method === 'GET') {
      const session = await sessionOf(request, env).catch(() => null)
      // materialize due scheduled tournaments (belt & braces with the DO alarm)
      const due = await listTournaments(env.DB, ['registering'], 20)
      const now = Date.now()
      for (const t of due) {
        if (t.startAt && now >= t.startAt) {
          env.TOURNAMENT.get(env.TOURNAMENT.idFromName(t.id))
            .fetch('https://do/start', { method: 'POST' })
            .catch(() => {})
        }
      }
      const items = await tournamentLobbyView(env.DB, env, session?.user.id ?? null)
      return json({ tournaments: items })
    }

    if (path === '/api/tournaments/register' && request.method === 'POST') {
      const session = await sessionOf(request, env)
      if (!session) return json({ error: 'Unauthorized' }, { status: 401 })
      const body = await readJson<{ id?: string }>(request)
      const id = String(body?.id ?? '')
      const t = await getTournament(env.DB, id)
      if (!t) return json({ error: 'Tournament not found' }, { status: 404 })
      if (t.state !== 'registering') return json({ error: 'Registration is closed' }, { status: 409 })
      const entries = await tournamentEntries(env.DB, id)
      if (entries.length >= t.maxPlayers) return json({ error: 'Tournament is full' }, { status: 409 })
      const result = await registerForTournament(env.DB, t, session.user.id, session.user.username)
      if (!result.ok) return json({ error: result.error ?? 'Registration failed' }, { status: 400 })
      // sitgo: start the moment the field is full
      if (t.kind === 'sitgo' && entries.length + 1 >= t.maxPlayers) {
        tournamentStub(env, id).fetch('https://do/start', { method: 'POST' }).catch(() => {})
      }
      return json({ ok: true, chips: result.chips })
    }

    if (path === '/api/tournaments/join' && request.method === 'POST') {
      const session = await sessionOf(request, env)
      if (!session) return json({ error: 'Unauthorized' }, { status: 401 })
      const body = await readJson<{ id?: string }>(request)
      const id = String(body?.id ?? '')
      const t = await getTournament(env.DB, id)
      if (!t) return json({ error: 'Tournament not found' }, { status: 404 })
      if (t.state !== 'running') return json({ error: 'Tournament is not running' }, { status: 409 })
      const res = await tournamentStub(env, id).fetch(`https://do/seat-of?userId=${encodeURIComponent(session.user.id)}`)
      const data = (await res.json()) as { tableKey?: string | null; eliminated?: boolean; place?: number | null }
      if (data.eliminated) return json({ error: `You finished #${data.place}`, place: data.place }, { status: 409 })
      if (!data.tableKey) return json({ error: 'No seat available' }, { status: 409 })
      return json({ ok: true, tableKey: data.tableKey })
    }

    // ---- admin ----
    if (path === '/api/admin/claim' && request.method === 'POST') {
      if (authRateLimited(clientIp(request), 5, 60_000)) return json({ error: 'Too many attempts — slow down' }, { status: 429 })
      const session = await sessionOf(request, env)
      if (!session) return json({ error: 'Log in first, then claim admin' }, { status: 401 })
      const body = await readJson<{ passphrase?: string }>(request)
      const digest = await sha256Hex(String(body?.passphrase ?? ''))
      if (!timingSafeHexEqual(digest, ADMIN_CLAIM_SHA256)) return json({ error: 'Wrong passphrase' }, { status: 403 })
      if ((await countAdmins(env.DB)) > 0) return json({ error: 'Admin already claimed — passphrase burned' }, { status: 409 })
      await promoteToAdmin(env.DB, session.user.id)
      const user = await findUser(env.DB, session.user.id)
      return json({ user })
    }

    if (path.startsWith('/api/admin/') && path !== '/api/admin/claim') {
      const session = await sessionOf(request, env)
      if (!session) return json({ error: 'Unauthorized' }, { status: 401 })
      if (session.user.role !== 'admin') return json({ error: 'Forbidden — admin only' }, { status: 403 })

      if (path === '/api/admin/users' && request.method === 'GET') {
        const q = url.searchParams.get('q') ?? undefined
        return json({ users: await listUsers(env.DB, { q }) })
      }
      if (path === '/api/admin/tables' && request.method === 'GET') {
        // cached LobbyDO snapshot — no per-table fan-out (free-tier budget)
        const res = await lobbyStub(env).fetch('https://do/snapshot').catch(() => null)
        if (res?.ok) {
          const data = (await res.json()) as { tables: LobbyTableSummary[] }
          return json({ tables: data.tables ?? [] })
        }
        return json({ tables: [] })
      }
      if (path === '/api/admin/chips' && request.method === 'POST') {
        const body = await readJson<{ userId?: string; delta?: number; reason?: string }>(request)
        const userId = String(body?.userId ?? '')
        const delta = Number(body?.delta)
        if (!userId || !Number.isInteger(delta)) return json({ error: 'userId and integer delta required' }, { status: 400 })
        const result = await adminAdjustChips(env.DB, userId, delta, String(body?.reason ?? ''))
        if (!result.ok) return json({ error: result.error ?? 'Adjustment failed' }, { status: 400 })
        await adminLog(env.DB, session.user.id, session.user.username, delta > 0 ? 'chips.grant' : 'chips.take', userId, `${delta > 0 ? '+' : ''}${delta} — ${String(body?.reason ?? '')}`)
        return json({ chips: result.chips })
      }

      // ---- godmode: bulk economy tool (grant/deduct from EVERY account) ----
      if (path === '/api/admin/chips/bulk' && request.method === 'POST') {
        const body = await readJson<{ delta?: number; reason?: string }>(request)
        const delta = Math.trunc(Number(body?.delta))
        if (!Number.isInteger(delta) || delta === 0 || Math.abs(delta) > 10_000_000) {
          return json({ error: 'Integer delta required (|delta| ≤ 10,000,000)' }, { status: 400 })
        }
        const result = await bulkAdjustChips(env.DB, delta, String(body?.reason ?? ''))
        if (!result.ok) return json({ error: result.error ?? 'Bulk update failed' }, { status: 400 })
        await adminLog(env.DB, session.user.id, session.user.username, 'chips.bulk', 'all', `${delta > 0 ? '+' : ''}${delta} × ${result.changed} accounts — ${String(body?.reason ?? '')}`)
        return json({ ok: true, changed: result.changed })
      }
      if (path === '/api/admin/standup' && request.method === 'POST') {
        const body = await readJson<{ userId?: string }>(request)
        const userId = String(body?.userId ?? '')
        if (!userId) return json({ error: 'userId required' }, { status: 400 })
        const stoodUp: string[] = []
        for (const cfg of TABLE_CONFIGS) {
          try {
            const res = await tableStub(env, cfg.key).fetch(`https://do/force-stand?userId=${encodeURIComponent(userId)}`)
            if (res.ok) stoodUp.push(cfg.key)
          } catch {
            /* table unreachable — skip */
          }
        }
        return json({ ok: stoodUp.length > 0, stoodUp })
      }

      // ---- dashboard overview: stats + activity + live table metrics ----
      // ONE LobbyDO snapshot serves table metrics — the previous per-table
      // fan-out burned 10 DO requests per admin poll and helped exhaust the
      // free-tier DO quota (incident 2026-10-29).
      if (path === '/api/admin/overview' && request.method === 'GET') {
        const [stats, activity, snapshot] = await Promise.all([
          adminOverview(env.DB),
          adminActivity(env.DB),
          lobbyStub(env)
            .fetch('https://do/snapshot')
            .then((res) => (res.ok ? (res.json() as Promise<{ tables: LobbyTableSummary[] }>) : null))
            .catch(() => null),
        ])
        const tables = (snapshot?.tables ?? []).map((t) => ({
          tableKey: t.tableKey,
          name: t.name,
          humansSeated: t.humansSeated,
          humansConnected: t.humansConnected,
          botsSeated: t.botsSeated,
          inHand: t.inHand,
          handsPlayed: t.handsPlayed,
          avgPot: t.avgPot,
          sockets: t.humansConnected,
          offline: false,
        }))
        const onlineNow = tables.reduce((a, m) => a + (Number(m.humansConnected) || 0), 0)
        const botsActive = tables.reduce((a, m) => a + (Number(m.botsSeated) || 0), 0)
        const activeTables = tables.filter((m) => Number(m.humansSeated) > 0).length
        return json({ stats, activity, tables, onlineNow, botsActive, activeTables, version: VERSION, serverTime: new Date().toISOString() })
      }

      // ---- hand history: list across all tables, then drill into one ----
      if (path === '/api/admin/hands' && request.method === 'GET') {
        const tableKey = url.searchParams.get('table')
        const before = Number(url.searchParams.get('before')) || null
        const limit = Number(url.searchParams.get('limit')) || 30
        const hands = await listHands(env.DB, { tableKey: tableKey || null, before, limit })
        return json({ hands })
      }
      if (path === '/api/admin/hand' && request.method === 'GET') {
        const id = url.searchParams.get('id') ?? ''
        const hand = await getHand(env.DB, id)
        if (!hand) return json({ error: 'Hand not found' }, { status: 404 })
        return json({ hand })
      }
      if (path === '/api/admin/transactions' && request.method === 'GET') {
        return json({ transactions: await listTransactions(env.DB, 50) })
      }

      // ---- robots policy: global toggle + per-table bot seat counts ----
      if (path === '/api/admin/robots' && request.method === 'GET') {
        const policy = await getRobotsPolicy(env.DB)
        const tables = await Promise.all(
          TABLE_CONFIGS.map(async (cfg) => {
            try {
              const res = await tableStub(env, cfg.key).fetch('https://do/config')
              if (res.ok) {
                const data = (await res.json()) as { target?: number; botsSeated?: number }
                return { tableKey: cfg.key, target: Number(data.target ?? 0), botsSeated: Number(data.botsSeated ?? 0) }
              }
            } catch {
              /* table unreachable */
            }
            return { tableKey: cfg.key, target: policy.enabled ? (policy.tableCounts[cfg.key] ?? cfg.botCount) : 0, botsSeated: 0 }
          }),
        )
        return json({ policy, tables })
      }
      if (path === '/api/admin/robots' && request.method === 'POST') {
        const body = await readJson<{ enabled?: boolean; tableCounts?: Record<string, number> }>(request)
        if (typeof body?.enabled !== 'boolean' || typeof body?.tableCounts !== 'object' || body.tableCounts === null) {
          return json({ error: 'enabled (bool) and tableCounts (object) required' }, { status: 400 })
        }
        const policy = { enabled: body.enabled, tableCounts: {} as Record<string, number> }
        for (const cfg of TABLE_CONFIGS) {
          const v = body.tableCounts[cfg.key]
          if (typeof v === 'number' && Number.isFinite(v)) policy.tableCounts[cfg.key] = Math.max(0, Math.min(Math.floor(v), cfg.maxSeats))
        }
        await setRobotsPolicy(env.DB, policy)
        await adminLog(env.DB, session.user.id, session.user.username, 'robots.policy', 'site', `${policy.enabled ? 'enabled' : 'disabled'} — bot seats: ${JSON.stringify(policy.tableCounts)}`)
        const applied: string[] = []
        for (const cfg of TABLE_CONFIGS) {
          try {
            const res = await tableStub(env, cfg.key).fetch('https://do/config', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(policy),
            })
            if (res.ok) applied.push(cfg.key)
          } catch {
            /* table asleep — it reads the policy from D1 on next wake */
          }
        }
        return json({ ok: true, policy, applied })
      }

      // ---- tournaments: admin create / list / start / fill / cancel ----
      if (path === '/api/admin/tournaments' && request.method === 'GET') {
        return json({ tournaments: await adminListTournaments(env.DB) })
      }
      if (path === '/api/admin/tournaments' && request.method === 'POST') {
        const body = await readJson<{
          name?: string
          gameType?: string
          kind?: string
          buyIn?: number
          bounty?: number
          startingStack?: number
          seatsPerTable?: number
          maxPlayers?: number
          startDelayMin?: number
          turbo?: boolean
        }>(request)
        const gameType = ['holdem', 'omaha4', 'omaha5'].includes(String(body?.gameType))
          ? (body?.gameType as TournamentConfig['gameType'])
          : 'holdem'
        const kind = body?.kind === 'scheduled' ? 'scheduled' : 'sitgo'
        const buyIn = Math.max(0, Math.min(1_000_000, Math.floor(Number(body?.buyIn ?? 1000))))
        const bounty = buyIn > 0 && body?.bounty ? Math.floor(buyIn / 2) : 0
        const startingStack = Math.max(200, Math.min(1_000_000, Math.floor(Number(body?.startingStack ?? 1500))))
        const seatsPerTable = [2, 6, 8, 9].includes(Number(body?.seatsPerTable)) ? Number(body?.seatsPerTable) : 9
        const maxPlayers = Math.max(2, Math.min(300, Math.floor(Number(body?.maxPlayers ?? seatsPerTable))))
        // E2E runs shrink the blind clock so tournaments finish quickly
        const levelMs = env.E2E_FAST === '1' && body?.turbo ? 5_000 : body?.turbo ? 120_000 : 300_000
        const startAt = kind === 'scheduled' ? Date.now() + Math.max(1, Math.floor(Number(body?.startDelayMin ?? 5))) * 60_000 : null
        if (kind === 'sitgo' && maxPlayers % 1 !== 0) return json({ error: 'Invalid capacity' }, { status: 400 })
        if (kind === 'sitgo' && maxPlayers % seatsPerTable !== 0 && maxPlayers !== 2 && seatsPerTable !== 2) {
          return json({ error: 'Sit & Go capacity should be a multiple of seats per table (or 2 for heads-up)' }, { status: 400 })
        }
        const cfg: TournamentConfig = {
          id: crypto.randomUUID().slice(0, 8),
          name: String(body?.name ?? '').trim().slice(0, 40) || 'NutsRiver Cup',
          gameType,
          kind,
          buyIn,
          bounty,
          startingStack,
          seatsPerTable,
          maxPlayers,
          startAt,
          levelMs,
          createdAt: Date.now(),
        }
        await createTournament(env.DB, cfg, 0)
        return json({ ok: true, tournament: cfg })
      }
      if (path === '/api/admin/tournaments/start' && request.method === 'POST') {
        const body = await readJson<{ id?: string }>(request)
        const id = String(body?.id ?? '')
        const res = await tournamentStub(env, id).fetch('https://do/start', { method: 'POST' })
        const data = (await res.json()) as { ok?: boolean; error?: string }
        return json(data, { status: res.ok ? 200 : 400 })
      }
      if (path === '/api/admin/tournaments/fill' && request.method === 'POST') {
        const body = await readJson<{ id?: string; count?: number }>(request)
        const id = String(body?.id ?? '')
        const count = Math.max(1, Math.min(200, Math.floor(Number(body?.count ?? 1))))
        const t = await getTournament(env.DB, id)
        if (!t) return json({ error: 'Tournament not found' }, { status: 404 })
        const res = await tournamentStub(env, id).fetch(`https://do/fill-bots?count=${count}`, { method: 'POST' })
        const data = (await res.json()) as { ok?: boolean; added?: number }
        // sitgo filled to capacity auto-starts inside the DO
        return json({ ok: true, added: data.added ?? 0 })
      }
      if (path === '/api/admin/tournaments/cancel' && request.method === 'POST') {
        const body = await readJson<{ id?: string }>(request)
        const id = String(body?.id ?? '')
        const t = await getTournament(env.DB, id)
        if (!t) return json({ error: 'Tournament not found' }, { status: 404 })
        await tournamentStub(env, id).fetch('https://do/cancel', { method: 'POST' })
        const refunded = await cancelTournament(env.DB, id)
        return json({ ok: true, refunded })
      }

      // ---- ban / unban (banning also force-stands the player everywhere,
      // kills their sessions and writes the audit trail) ----
      if (path === '/api/admin/ban' && request.method === 'POST') {
        const body = await readJson<{ userId?: string; banned?: boolean; reason?: string }>(request)
        const userId = String(body?.userId ?? '')
        const banned = !!body?.banned
        if (!userId) return json({ error: 'userId required' }, { status: 400 })
        const target = await findUser(env.DB, userId)
        if (!target) return json({ error: 'User not found' }, { status: 404 })
        if (target.role === 'admin') return json({ error: 'Cannot ban an admin' }, { status: 409 })
        const ok = await setUserBanned(env.DB, userId, banned)
        if (!ok) return json({ error: 'Update failed' }, { status: 500 })
        if (banned) {
          await bumpSessionVer(env.DB, userId) // live sockets die on their next call
          for (const cfg of TABLE_CONFIGS) {
            try {
              await tableStub(env, cfg.key).fetch(`https://do/force-stand?userId=${encodeURIComponent(userId)}`)
            } catch {
              /* table unreachable — skip */
            }
          }
        }
        await adminLog(env.DB, session.user.id, session.user.username, banned ? 'player.ban' : 'player.unban', userId, `${target.username}${body?.reason ? ` — ${String(body.reason)}` : ''}`)
        return json({ ok: true, banned })
      }

      // ---- godmode: audit trail ----
      if (path === '/api/admin/audit' && request.method === 'GET') {
        return json({ log: await listAdminLog(env.DB, 100) })
      }

      // ---- godmode: per-player ledger slice (player drawer) ----
      if (path === '/api/admin/player/transactions' && request.method === 'GET') {
        const userId = url.searchParams.get('userId') ?? ''
        if (!userId) return json({ error: 'userId required' }, { status: 400 })
        return json({ transactions: await listUserTransactions(env.DB, userId, 20) })
      }

      // ---- godmode: rename (moderation) ----
      if (path === '/api/admin/players/rename' && request.method === 'POST') {
        const body = await readJson<{ userId?: string; username?: string }>(request)
        const userId = String(body?.userId ?? '')
        const username = String(body?.username ?? '').trim()
        if (!userId || !/^[a-zA-Z0-9_]{3,20}$/.test(username)) return json({ error: 'userId and a valid username (3-20 letters/numbers/_) required' }, { status: 400 })
        const target = await findUser(env.DB, userId)
        if (!target) return json({ error: 'User not found' }, { status: 404 })
        const result = await setUsername(env.DB, userId, username)
        if (!result.ok) return json({ error: result.error ?? 'Rename failed' }, { status: 400 })
        await adminLog(env.DB, session.user.id, session.user.username, 'player.rename', userId, `${target.username} → ${username}`)
        return json({ ok: true })
      }

      // ---- godmode: password reset (generates one when omitted; shown ONCE) ----
      if (path === '/api/admin/players/password' && request.method === 'POST') {
        const body = await readJson<{ userId?: string; password?: string }>(request)
        const userId = String(body?.userId ?? '')
        const password = String(body?.password ?? '') || `rf-${crypto.randomUUID().slice(0, 8)}`
        if (!userId || password.length < 8 || password.length > 100) return json({ error: 'Password must be 8-100 characters' }, { status: 400 })
        const target = await findUser(env.DB, userId)
        if (!target) return json({ error: 'User not found' }, { status: 404 })
        const ok = await setPasswordHash(env.DB, userId, await hashPassword(password))
        if (!ok) return json({ error: 'Update failed' }, { status: 500 })
        await adminLog(env.DB, session.user.id, session.user.username, 'player.password', userId, target.username)
        return json({ ok: true, password })
      }

      // ---- godmode: force logout (kills every live session token) ----
      if (path === '/api/admin/players/logout' && request.method === 'POST') {
        const body = await readJson<{ userId?: string }>(request)
        const userId = String(body?.userId ?? '')
        if (!userId) return json({ error: 'userId required' }, { status: 400 })
        const target = await findUser(env.DB, userId)
        if (!target) return json({ error: 'User not found' }, { status: 404 })
        const ok = await bumpSessionVer(env.DB, userId)
        if (!ok) return json({ error: 'Update failed' }, { status: 500 })
        await adminLog(env.DB, session.user.id, session.user.username, 'player.logout', userId, target.username)
        return json({ ok: true })
      }

      // ---- godmode: promote / demote (self-demotion & last-admin guarded) ----
      if (path === '/api/admin/players/role' && request.method === 'POST') {
        const body = await readJson<{ userId?: string; role?: string }>(request)
        const userId = String(body?.userId ?? '')
        const role = body?.role === 'admin' ? 'admin' : 'player'
        if (!userId) return json({ error: 'userId required' }, { status: 400 })
        const target = await findUser(env.DB, userId)
        if (!target) return json({ error: 'User not found' }, { status: 404 })
        if (target.role === role) return json({ error: `Already ${role}` }, { status: 409 })
        if (role === 'player' && (await countAdmins(env.DB)) <= 1) return json({ error: 'Cannot demote the last admin' }, { status: 409 })
        const ok = await setUserRole(env.DB, userId, role)
        if (!ok) return json({ error: 'Update failed' }, { status: 500 })
        await adminLog(env.DB, session.user.id, session.user.username, role === 'admin' ? 'player.promote' : 'player.demote', userId, target.username)
        return json({ ok: true, role })
      }

      // ---- godmode: hard delete (stands the player up everywhere first) ----
      if (path === '/api/admin/players/delete' && request.method === 'POST') {
        const body = await readJson<{ userId?: string }>(request)
        const userId = String(body?.userId ?? '')
        if (!userId) return json({ error: 'userId required' }, { status: 400 })
        const target = await findUser(env.DB, userId)
        if (!target) return json({ error: 'User not found' }, { status: 404 })
        if (target.role === 'admin') return json({ error: 'Demote the admin before deleting' }, { status: 409 })
        for (const cfg of TABLE_CONFIGS) {
          try {
            await tableStub(env, cfg.key).fetch(`https://do/force-stand?userId=${encodeURIComponent(userId)}`)
          } catch {
            /* table unreachable — skip */
          }
        }
        const ok = await deleteUserAccount(env.DB, userId)
        if (!ok) return json({ error: 'Delete failed' }, { status: 500 })
        await adminLog(env.DB, session.user.id, session.user.username, 'player.delete', userId, target.username)
        return json({ ok: true })
      }

      // ---- godmode: locate a player across all tables (on-demand fan-out) ----
      if (path === '/api/admin/players/locate' && request.method === 'POST') {
        const body = await readJson<{ userId?: string }>(request)
        const userId = String(body?.userId ?? '')
        if (!userId) return json({ error: 'userId required' }, { status: 400 })
        const seated: string[] = []
        for (const cfg of TABLE_CONFIGS) {
          try {
            const res = await tableStub(env, cfg.key).fetch(`https://do/seat-of?userId=${encodeURIComponent(userId)}`)
            const data = (await res.json()) as { seated?: boolean }
            if (data.seated) seated.push(cfg.key)
          } catch {
            /* table unreachable — skip */
          }
        }
        return json({ seated })
      }

      // ---- godmode: kick from ONE table (surgical; standup covers all) ----
      if (path === '/api/admin/tables/kick' && request.method === 'POST') {
        const body = await readJson<{ tableKey?: string; userId?: string }>(request)
        const tableKey = String(body?.tableKey ?? '')
        const userId = String(body?.userId ?? '')
        if (!TABLE_CONFIGS.some((cfg) => cfg.key === tableKey)) return json({ error: 'Unknown table' }, { status: 400 })
        if (!userId) return json({ error: 'userId required' }, { status: 400 })
        try {
          const res = await tableStub(env, tableKey).fetch(`https://do/force-stand?userId=${encodeURIComponent(userId)}`)
          if (!res.ok) return json({ error: 'Player is not seated there' }, { status: 409 })
        } catch {
          return json({ error: 'Table is asleep' }, { status: 503 })
        }
        await adminLog(env.DB, session.user.id, session.user.username, 'table.kick', userId, tableKey)
        return json({ ok: true })
      }

      // ---- godmode: broadcast an announcement (lobby socket + table chats) ----
      if (path === '/api/admin/broadcast' && request.method === 'POST') {
        const body = await readJson<{ message?: string; target?: string }>(request)
        const message = String(body?.message ?? '').trim().slice(0, 200)
        const target = body?.target === 'tables' ? 'tables' : 'lobby'
        if (!message) return json({ error: 'Message required (≤200 chars)' }, { status: 400 })
        let reached = 0
        if (target === 'lobby') {
          try {
            const res = await lobbyStub(env).fetch('https://do/announce', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ message }),
            })
            if (res.ok) reached = Number(((await res.json()) as { viewers?: number }).viewers ?? 0)
          } catch {
            /* lobby asleep — nothing to announce to */
          }
        } else {
          const results = await Promise.all(
            TABLE_CONFIGS.map(async (cfg) => {
              try {
                const res = await tableStub(env, cfg.key).fetch('https://do/announce', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ message }),
                })
                return res.ok ? 1 : 0
              } catch {
                return 0
              }
            }),
          )
          reached = results.reduce<number>((a, b) => a + b, 0)
        }
        await adminLog(env.DB, session.user.id, session.user.username, 'broadcast', target, message)
        return json({ ok: true, reached, target })
      }
    }

    // ---- realtime ----
    if (path === '/api/poker-socket') {
      if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') {
        return json({ error: 'WebSocket upgrade required' }, { status: 426 })
      }
      const session = await sessionOf(request, env)
      if (!session) return json({ error: 'Unauthorized — please log in' }, { status: 401 })
      const tableKey = url.searchParams.get('table') ?? 'beginners'
      const routed = stubForTableKey(env, tableKey)
      const stub = routed?.stub ?? tableStub(env, tableKey)
      const doUrl = new URL(request.url)
      doUrl.pathname = routed?.path ?? `/table/${tableKey}/upgrade`
      if (routed?.path.includes('/tournament/')) {
        const idx = TOURNAMENT_KEY.exec(tableKey)?.[2] ?? '0'
        doUrl.searchParams.set('table', `t${idx}`)
      }
      const upstream = new Request(doUrl.toString(), request)
      upstream.headers.set('x-nutsriver-user', session.user.id)
      upstream.headers.set('x-nutsriver-name', session.user.username)
      return stub.fetch(upstream)
    }

    // ---- static assets (Next.js export) ----
    return env.ASSETS.fetch(request)
  },

  // ---------- cron: data retention (keeps the free-tier D1 footprint small) ----------
  // Hands: 14 days. Ledger: 90 days. Player stats stay forever.
  async scheduled(_event, env) {
    await ensureSchema(env.DB)
    const hands = await pruneOldHands(env.DB, 14 * 86_400_000)
    const txs = await pruneOldTransactions(env.DB, 90 * 86_400_000)
    console.log(`[cron] pruned hands=${hands} transactions=${txs}`)
  },
}

export default worker
