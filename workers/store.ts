/**
 * D1 access layer — replaces the Prisma/SQLite store. All balance mutations
 * are guarded by conditional UPDATEs (atomic) and fully ledgered in
 * ChipTransaction. Amounts are integer play-money chips with no cash value.
 *
 * v2: HandHistory gains per-hand action log + full participant roster (with
 * hole cards for the admin hand viewer), User gains a banned flag, and a
 * SiteConfig key-value table stores admin-controlled robots policy.
 * Hand recording is batched into a single D1 round-trip (free-tier friendly).
 */
import { cardCode } from '../src/lib/poker-engine/cards'
import type { HandTrailAction, TournamentConfig } from '../src/lib/poker-engine/types'

export type UserRole = 'player' | 'admin'

export interface UserInfo {
  id: string
  username: string
  chips: number
  handsPlayed: number
  handsWon: number
  biggestPotWon: number
  role: UserRole
  banned?: boolean
  /** bumped to invalidate every outstanding session token (force logout) */
  sessionVer?: number
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS User (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  passwordHash TEXT NOT NULL,
  chips INTEGER NOT NULL DEFAULT 10000,
  handsPlayed INTEGER NOT NULL DEFAULT 0,
  handsWon INTEGER NOT NULL DEFAULT 0,
  biggestPotWon INTEGER NOT NULL DEFAULT 0,
  lastTopupAt INTEGER,
  createdAt INTEGER NOT NULL,
  role TEXT NOT NULL DEFAULT 'player'
);
CREATE TABLE IF NOT EXISTS ChipTransaction (
  id TEXT PRIMARY KEY,
  userId TEXT NOT NULL,
  amount INTEGER NOT NULL,
  reason TEXT NOT NULL,
  balanceAfter INTEGER NOT NULL,
  detail TEXT,
  at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tx_user ON ChipTransaction (userId, at);
CREATE TABLE IF NOT EXISTS HandHistory (
  id TEXT PRIMARY KEY,
  tableKey TEXT NOT NULL,
  handNumber INTEGER NOT NULL,
  board TEXT NOT NULL,
  potTotal INTEGER NOT NULL,
  results TEXT NOT NULL,
  trail TEXT NOT NULL DEFAULT '[]',
  at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_hand_table ON HandHistory (tableKey, handNumber);
CREATE TABLE IF NOT EXISTS SiteConfig (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS Tournament (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  gameType TEXT NOT NULL,
  kind TEXT NOT NULL,
  buyIn INTEGER NOT NULL,
  bounty INTEGER NOT NULL DEFAULT 0,
  startingStack INTEGER NOT NULL,
  seatsPerTable INTEGER NOT NULL,
  maxPlayers INTEGER NOT NULL,
  startAt INTEGER,
  levelMs INTEGER NOT NULL,
  state TEXT NOT NULL DEFAULT 'registering',
  prizePool INTEGER NOT NULL DEFAULT 0,
  winnerUserId TEXT,
  createdAt INTEGER NOT NULL,
  finishedAt INTEGER
);
CREATE INDEX IF NOT EXISTS idx_tournament_state ON Tournament (state, createdAt);
CREATE TABLE IF NOT EXISTS TournamentEntry (
  tournamentId TEXT NOT NULL,
  userId TEXT NOT NULL,
  registeredAt INTEGER NOT NULL,
  eliminatedAt INTEGER,
  finishPlace INTEGER,
  bountyWon INTEGER NOT NULL DEFAULT 0,
  prizeWon INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (tournamentId, userId)
);
CREATE INDEX IF NOT EXISTS idx_entry_user ON TournamentEntry (userId, registeredAt);
CREATE TABLE IF NOT EXISTS AdminLog (
  id TEXT PRIMARY KEY,
  at INTEGER NOT NULL,
  actorId TEXT NOT NULL,
  actorName TEXT NOT NULL,
  action TEXT NOT NULL,
  target TEXT NOT NULL,
  detail TEXT
);
CREATE INDEX IF NOT EXISTS idx_adminlog_at ON AdminLog (at);
`

/** Idempotent additive migrations — safe to run on every cold start. */
const MIGRATIONS: string[] = [
  "ALTER TABLE User ADD COLUMN role TEXT NOT NULL DEFAULT 'player'",
  'ALTER TABLE User ADD COLUMN banned INTEGER NOT NULL DEFAULT 0',
  "ALTER TABLE HandHistory ADD COLUMN log TEXT NOT NULL DEFAULT '[]'",
  "ALTER TABLE HandHistory ADD COLUMN participants TEXT NOT NULL DEFAULT '[]'",
  "ALTER TABLE HandHistory ADD COLUMN trail TEXT NOT NULL DEFAULT '[]'",
  'CREATE INDEX IF NOT EXISTS idx_tx_at ON ChipTransaction (at)',
  'CREATE INDEX IF NOT EXISTS idx_hand_at ON HandHistory (at)',
  'ALTER TABLE User ADD COLUMN sessionVer INTEGER NOT NULL DEFAULT 0',
]

let schemaPromise: Promise<void> | null = null

/** Idempotent — applied once per isolate on first DB touch. */
export function ensureSchema(db: D1Database): Promise<void> {
  if (!schemaPromise) {
    const statements = SCHEMA.split(';')
      .map((s) => s.trim())
      .filter(Boolean)
    schemaPromise = (async () => {
      for (const stmt of statements) {
        await db.prepare(stmt).run()
      }
      for (const m of MIGRATIONS) {
        try {
          await db.prepare(m).run()
        } catch {
          /* column/index already exists — expected on warm databases */
        }
      }
    })()
    schemaPromise.catch(() => {
      schemaPromise = null
    })
  }
  return schemaPromise
}

export const TOPUP_THRESHOLD = 1000
export const TOPUP_COOLDOWN_MS = 10 * 60 * 1000
export const TOPUP_AMOUNT = 10000
export const STARTING_CHIPS = 10000

const UUID = () => crypto.randomUUID()

export async function createUser(db: D1Database, username: string, passwordHash: string): Promise<UserInfo | null> {
  const id = UUID()
  const now = Date.now()
  const res = await db
    .prepare('INSERT INTO User (id, username, passwordHash, chips, createdAt) VALUES (?, ?, ?, ?, ?)')
    .bind(id, username, passwordHash, STARTING_CHIPS, now)
    .run()
  if (!res.success) return null
  return { id, username, chips: STARTING_CHIPS, handsPlayed: 0, handsWon: 0, biggestPotWon: 0, role: 'player' }
}

export async function findUserByUsername(db: D1Database, username: string): Promise<(UserInfo & { passwordHash: string }) | null> {
  const row = await db
    .prepare('SELECT id, username, passwordHash, chips, handsPlayed, handsWon, biggestPotWon, role, banned, sessionVer FROM User WHERE username = ?')
    .bind(username)
    .first<any>()
  if (!row) return null
  return {
    id: row.id,
    username: row.username,
    passwordHash: row.passwordHash,
    chips: row.chips,
    handsPlayed: row.handsPlayed,
    handsWon: row.handsWon,
    biggestPotWon: row.biggestPotWon,
    role: (row.role as UserRole) ?? 'player',
    banned: !!row.banned,
    sessionVer: Number(row.sessionVer) || 0,
  }
}

export async function findUser(db: D1Database, userId: string): Promise<UserInfo | null> {
  const row = await db
    .prepare('SELECT id, username, chips, handsPlayed, handsWon, biggestPotWon, role, banned, sessionVer FROM User WHERE id = ?')
    .bind(userId)
    .first<any>()
  if (!row) return null
  return {
    id: row.id,
    username: row.username,
    chips: row.chips,
    handsPlayed: row.handsPlayed,
    handsWon: row.handsWon,
    biggestPotWon: row.biggestPotWon,
    role: (row.role as UserRole) ?? 'player',
    banned: !!row.banned,
    sessionVer: Number(row.sessionVer) || 0,
  }
}

// ---------- site config (robots policy etc.) ----------

export async function getConfig(db: D1Database, key: string): Promise<string | null> {
  const row = await db.prepare('SELECT value FROM SiteConfig WHERE key = ?').bind(key).first<any>()
  return row?.value ?? null
}

export async function setConfig(db: D1Database, key: string, value: string): Promise<void> {
  await db
    .prepare('INSERT INTO SiteConfig (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .bind(key, value)
    .run()
}

export interface RobotsPolicy {
  enabled: boolean
  /** per-table bot seat target; missing entry = table default */
  tableCounts: Record<string, number>
}

export const DEFAULT_ROBOTS_POLICY: RobotsPolicy = { enabled: true, tableCounts: {} }

export async function getRobotsPolicy(db: D1Database): Promise<RobotsPolicy> {
  try {
    const raw = await getConfig(db, 'robots')
    if (!raw) return { ...DEFAULT_ROBOTS_POLICY, tableCounts: {} }
    const parsed = JSON.parse(raw) as Partial<RobotsPolicy>
    return {
      enabled: parsed.enabled !== false,
      tableCounts: parsed.tableCounts && typeof parsed.tableCounts === 'object' ? parsed.tableCounts : {},
    }
  } catch {
    return { ...DEFAULT_ROBOTS_POLICY, tableCounts: {} }
  }
}

export async function setRobotsPolicy(db: D1Database, policy: RobotsPolicy): Promise<void> {
  await setConfig(db, 'robots', JSON.stringify({ enabled: policy.enabled, tableCounts: policy.tableCounts }))
}

// ---------- admin ----------

export async function countAdmins(db: D1Database): Promise<number> {
  const row = await db.prepare("SELECT COUNT(*) AS n FROM User WHERE role = 'admin'").first<any>()
  return row?.n ?? 0
}

export async function promoteToAdmin(db: D1Database, userId: string): Promise<void> {
  await db.prepare("UPDATE User SET role = 'admin' WHERE id = ?").bind(userId).run()
}

export interface AdminUserRow {
  id: string
  username: string
  chips: number
  handsPlayed: number
  handsWon: number
  biggestPotWon: number
  role: UserRole
  banned: boolean
  createdAt: number
}

export async function listUsers(db: D1Database, opts: { q?: string; limit?: number } = {}): Promise<AdminUserRow[]> {
  const q = (opts.q ?? '').trim()
  const limit = Math.min(opts.limit ?? 200, 500)
  const base = 'SELECT id, username, chips, handsPlayed, handsWon, biggestPotWon, role, banned, createdAt FROM User'
  const res = q
    ? await db
        .prepare(`${base} WHERE username LIKE ? ORDER BY createdAt DESC LIMIT ?`)
        .bind(`%${q}%`, limit)
        .all<any>()
    : await db.prepare(`${base} ORDER BY createdAt DESC LIMIT ?`).bind(limit).all<any>()
  return (res.results ?? []).map((row) => ({
    id: row.id,
    username: row.username,
    chips: row.chips,
    handsPlayed: row.handsPlayed,
    handsWon: row.handsWon,
    biggestPotWon: row.biggestPotWon,
    role: (row.role as UserRole) ?? 'player',
    banned: !!row.banned,
    createdAt: row.createdAt,
  }))
}

/** Ban / unban. Banned users fail login and every authenticated call. */
export async function setUserBanned(db: D1Database, userId: string, banned: boolean): Promise<boolean> {
  const res = await db.prepare('UPDATE User SET banned = ? WHERE id = ?').bind(banned ? 1 : 0, userId).run()
  return res.success && (res.meta.changes ?? 0) > 0
}

// ---------- godmode: deep player administration ----------

/**
 * Force logout — bumping sessionVer instantly invalidates every outstanding
 * token for the user (sessionOf() compares the token's ver against the row).
 */
export async function bumpSessionVer(db: D1Database, userId: string): Promise<boolean> {
  const res = await db.prepare('UPDATE User SET sessionVer = sessionVer + 1 WHERE id = ?').bind(userId).run()
  return res.success && (res.meta.changes ?? 0) > 0
}

/** Rename a player (moderation tool). Enforces uniqueness, keeps the id. */
export async function setUsername(db: D1Database, userId: string, username: string): Promise<{ ok: boolean; error?: string }> {
  const clash = await db.prepare('SELECT id FROM User WHERE username = ? AND id != ?').bind(username, userId).first<any>()
  if (clash) return { ok: false, error: 'Username taken' }
  const res = await db.prepare('UPDATE User SET username = ? WHERE id = ?').bind(username, userId).run()
  return res.success && (res.meta.changes ?? 0) > 0 ? { ok: true } : { ok: false, error: 'User not found' }
}

/** Set a new password hash AND kill existing sessions (password change = re-login). */
export async function setPasswordHash(db: D1Database, userId: string, passwordHash: string): Promise<boolean> {
  const res = await db
    .prepare('UPDATE User SET passwordHash = ?, sessionVer = sessionVer + 1 WHERE id = ?')
    .bind(passwordHash, userId)
    .run()
  return res.success && (res.meta.changes ?? 0) > 0
}

export async function setUserRole(db: D1Database, userId: string, role: UserRole): Promise<boolean> {
  const res = await db.prepare('UPDATE User SET role = ? WHERE id = ?').bind(role, userId).run()
  return res.success && (res.meta.changes ?? 0) > 0
}

/** Hard-delete an account. Tournament entries go too; hands/ledger keep name snapshots. */
export async function deleteUserAccount(db: D1Database, userId: string): Promise<boolean> {
  await db.prepare('DELETE FROM TournamentEntry WHERE userId = ?').bind(userId).run()
  const res = await db.prepare('DELETE FROM User WHERE id = ?').bind(userId).run()
  return res.success && (res.meta.changes ?? 0) > 0
}

/**
 * Bulk chip grant/deduction across ALL accounts (promos, economy fixes).
 * One statement; negative deltas floor at zero so nobody goes negative.
 * The ledger gets one summary entry (detail carries the affected count).
 */
export async function bulkAdjustChips(
  db: D1Database,
  delta: number,
  reason: string,
): Promise<{ ok: boolean; changed?: number; error?: string }> {
  if (!Number.isInteger(delta) || delta === 0) return { ok: false, error: 'Invalid amount' }
  const res =
    delta > 0
      ? await db.prepare('UPDATE User SET chips = chips + ?').bind(delta).run()
      : await db
          .prepare('UPDATE User SET chips = CASE WHEN chips + ? < 0 THEN 0 ELSE chips + ? END')
          .bind(delta, delta)
          .run()
  if (!res.success) return { ok: false, error: 'Bulk update failed' }
  const changed = res.meta.changes ?? 0
  await ledger(db, 'bulk', delta, 'admin_adjust', 0, `${reason || 'Bulk adjustment'} — ${changed} accounts`)
  return { ok: true, changed }
}

// ---------- admin audit trail ----------

export interface AdminLogRow {
  id: string
  at: number
  actorName: string
  action: string
  target: string
  detail: string | null
}

/** Append an audit entry — best-effort: logging must never break the action. */
export async function adminLog(
  db: D1Database,
  actorId: string,
  actorName: string,
  action: string,
  target: string,
  detail?: string,
): Promise<void> {
  try {
    await db
      .prepare('INSERT INTO AdminLog (id, at, actorId, actorName, action, target, detail) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .bind(UUID(), Date.now(), actorId, actorName, action, target, detail ?? null)
      .run()
  } catch (e) {
    console.error('[store] admin log failed', e)
  }
}

export async function listAdminLog(db: D1Database, limit = 80): Promise<AdminLogRow[]> {
  const res = await db
    .prepare('SELECT id, at, actorName, action, target, detail FROM AdminLog ORDER BY at DESC LIMIT ?')
    .bind(Math.min(limit, 200))
    .all<any>()
  return (res.results ?? []).map((row) => ({
    id: row.id,
    at: row.at,
    actorName: row.actorName,
    action: row.action,
    target: row.target,
    detail: row.detail ?? null,
  }))
}

/** Per-player ledger slice for the godmode player drawer. */
export async function listUserTransactions(db: D1Database, userId: string, limit = 20) {
  const res = await db
    .prepare('SELECT amount, reason, balanceAfter, detail, at FROM ChipTransaction WHERE userId = ? ORDER BY at DESC LIMIT ?')
    .bind(userId, Math.min(limit, 50))
    .all<any>()
  return (res.results ?? []).map((row) => ({
    amount: row.amount,
    reason: row.reason,
    balanceAfter: row.balanceAfter,
    detail: row.detail,
    at: row.at,
  }))
}

/** Public play-money leaderboard row — no ids, no emails, just standings. */
export interface LeaderboardRow {
  username: string
  chips: number
  handsPlayed: number
  handsWon: number
  biggestPotWon: number
}

/** Top chip stacks for the lobby leaderboard (banned accounts excluded). */
export async function listTopUsers(db: D1Database, limit = 20): Promise<LeaderboardRow[]> {
  await ensureSchema(db)
  const res = await db
    .prepare('SELECT username, chips, handsPlayed, handsWon, biggestPotWon FROM User WHERE banned = 0 ORDER BY chips DESC, handsPlayed ASC LIMIT ?')
    .bind(Math.max(1, Math.min(limit, 50)))
    .all<any>()
  return (res.results ?? []).map((row) => ({
    username: String(row.username),
    chips: Number(row.chips) || 0,
    handsPlayed: Number(row.handsPlayed) || 0,
    handsWon: Number(row.handsWon) || 0,
    biggestPotWon: Number(row.biggestPotWon) || 0,
  }))
}

/** Aggregated dashboard counters — one D1 round-trip via batch(). */
export async function adminOverview(db: D1Database) {
  const dayStart = Math.floor(Date.now() / 86_400_000) * 86_400_000 - new Date().getTimezoneOffset() * 60_000
  const [total, newToday, banned, chips, handsToday, potStats, bigPot] = await db.batch([
    db.prepare('SELECT COUNT(*) AS n FROM User'),
    db.prepare('SELECT COUNT(*) AS n FROM User WHERE createdAt >= ?').bind(dayStart),
    db.prepare('SELECT COUNT(*) AS n FROM User WHERE banned = 1'),
    db.prepare('SELECT COALESCE(SUM(chips), 0) AS n FROM User'),
    db.prepare('SELECT COUNT(*) AS n FROM HandHistory WHERE at >= ?').bind(dayStart),
    db.prepare('SELECT COALESCE(AVG(potTotal), 0) AS avg, COUNT(*) AS n FROM HandHistory WHERE at >= ?').bind(dayStart),
    db.prepare('SELECT COALESCE(MAX(potTotal), 0) AS n FROM HandHistory'),
  ])
  return {
    totalUsers: (total.results?.[0] as any)?.n ?? 0,
    newUsersToday: (newToday.results?.[0] as any)?.n ?? 0,
    bannedUsers: (banned.results?.[0] as any)?.n ?? 0,
    chipsInCirculation: (chips.results?.[0] as any)?.n ?? 0,
    handsToday: (handsToday.results?.[0] as any)?.n ?? 0,
    avgPotToday: Math.round((potStats.results?.[0] as any)?.avg ?? 0),
    handsTotal: (potStats.results?.[0] as any)?.n ?? 0,
    biggestPotEver: (bigPot.results?.[0] as any)?.n ?? 0,
  }
}

export interface AdminActivityItem {
  kind: 'register' | 'hand' | 'tx'
  at: number
  text: string
  detail?: string
  amount?: number
}

/** Recent-activity feed: registrations + finished hands + chip ledger. */
export async function adminActivity(db: D1Database): Promise<AdminActivityItem[]> {
  const [regs, hands, txs] = await db.batch([
    db.prepare('SELECT username, createdAt FROM User ORDER BY createdAt DESC LIMIT 8'),
    db.prepare('SELECT tableKey, handNumber, potTotal, results, at FROM HandHistory ORDER BY at DESC LIMIT 8'),
    db.prepare('SELECT amount, reason, detail, at FROM ChipTransaction ORDER BY at DESC LIMIT 8'),
  ])
  const items: AdminActivityItem[] = []
  for (const r of (regs.results ?? []) as any[]) {
    items.push({ kind: 'register', at: r.createdAt, text: `New player registered`, detail: r.username })
  }
  for (const h of (hands.results ?? []) as any[]) {
    let winner = ''
    try {
      const results = JSON.parse(h.results) as { name: string; amount: number }[]
      winner = results.map((r) => r.name).join(' & ')
    } catch {
      /* ignore */
    }
    items.push({
      kind: 'hand',
      at: h.at,
      text: `Hand #${h.handNumber} finished at ${h.tableKey}`,
      detail: winner ? `won by ${winner}` : undefined,
      amount: h.potTotal,
    })
  }
  for (const t of (txs.results ?? []) as any[]) {
    items.push({ kind: 'tx', at: t.at, text: `${t.reason}`, detail: t.detail ?? undefined, amount: t.amount })
  }
  return items.sort((a, b) => b.at - a.at).slice(0, 12)
}

// ---------- hand history ----------

export interface AdminHandRow {
  id: string
  tableKey: string
  handNumber: number
  potTotal: number
  winners: string
  at: number
}

export async function listHands(
  db: D1Database,
  opts: { tableKey?: string | null; before?: number | null; limit?: number } = {},
): Promise<AdminHandRow[]> {
  const limit = Math.min(Math.max(opts.limit ?? 30, 1), 100)
  const clauses: string[] = []
  const binds: unknown[] = []
  if (opts.tableKey) {
    clauses.push('tableKey = ?')
    binds.push(opts.tableKey)
  }
  if (opts.before) {
    clauses.push('at < ?')
    binds.push(opts.before)
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''
  const res = await db
    .prepare(`SELECT id, tableKey, handNumber, potTotal, results, at FROM HandHistory ${where} ORDER BY at DESC, handNumber DESC LIMIT ?`)
    .bind(...binds, limit)
    .all<any>()
  return (res.results ?? []).map((row) => {
    let winners = ''
    try {
      winners = (JSON.parse(row.results) as { name: string }[]).map((r) => r.name).join(' & ')
    } catch {
      /* ignore */
    }
    return { id: row.id, tableKey: row.tableKey, handNumber: row.handNumber, potTotal: row.potTotal, winners, at: row.at }
  })
}

export interface AdminHandDetail {
  id: string
  tableKey: string
  handNumber: number
  board: string
  potTotal: number
  results: unknown
  participants: unknown
  log: string[]
  at: number
}

export async function getHand(db: D1Database, id: string): Promise<AdminHandDetail | null> {
  const row = await db
    .prepare('SELECT id, tableKey, handNumber, board, potTotal, results, participants, log, at FROM HandHistory WHERE id = ?')
    .bind(id)
    .first<any>()
  if (!row) return null
  let log: string[] = []
  try {
    log = typeof row.log === 'string' ? (JSON.parse(row.log) as string[]) : []
  } catch {
    /* older rows: reconstruct from newline string */
    if (typeof row.log === 'string' && row.log.length) log = row.log.split('\n')
  }
  let participants: unknown = []
  let results: unknown = []
  try {
    participants = JSON.parse(row.participants ?? '[]')
  } catch {
    /* ignore */
  }
  try {
    results = JSON.parse(row.results ?? '[]')
  } catch {
    /* ignore */
  }
  return {
    id: row.id,
    tableKey: row.tableKey,
    handNumber: row.handNumber,
    board: row.board,
    potTotal: row.potTotal,
    results,
    participants,
    log,
    at: row.at,
  }
}

// ---------- player-facing hand history (privacy-masked) ----------

/**
 * A hand reached a real showdown when any result carries a genuine hand
 * description. Fold-wins are labelled exactly 'All others folded' by the
 * engine, and at showdown EVERY alive player's cards are revealed on the
 * table (engine showdown() reveals all) — so that binary flag decides
 * whether opponents' hole cards may leave the server.
 */
const FOLD_WIN_DESC = 'All others folded'

interface StoredParticipant {
  userId: string
  name: string
  committed: number
  cards?: string[]
}

interface StoredResult {
  userId: string
  name: string
  amount: number
  desc: string
  cards: number[]
}

export interface PlayerHandRow {
  id: string
  tableKey: string
  handNumber: number
  potTotal: number
  winners: string
  at: number
  /** true when the hand reached showdown (opponents' cards were shown live) */
  showdown: boolean
  /** my net for the hand (won − committed); null when I wasn't dealt in */
  myNet: number | null
  /** my hole cards as codes; null when I wasn't dealt in */
  myCards: string[] | null
  board: string
}

export async function listPlayerHands(
  db: D1Database,
  userId: string,
  opts: { tableKey?: string | null; before?: number | null; limit?: number } = {},
): Promise<PlayerHandRow[]> {
  const limit = Math.min(Math.max(opts.limit ?? 15, 1), 50)
  const clauses: string[] = []
  const binds: unknown[] = []
  if (opts.tableKey) {
    clauses.push('tableKey = ?')
    binds.push(opts.tableKey)
  }
  if (opts.before) {
    clauses.push('at < ?')
    binds.push(opts.before)
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''
  const res = await db
    .prepare(`SELECT id, tableKey, handNumber, board, potTotal, results, participants, at FROM HandHistory ${where} ORDER BY at DESC, handNumber DESC LIMIT ?`)
    .bind(...binds, limit)
    .all<any>()
  return (res.results ?? []).map((row) => {
    let results: StoredResult[] = []
    let participants: StoredParticipant[] = []
    try {
      results = JSON.parse(row.results ?? '[]') as StoredResult[]
    } catch {
      /* ignore */
    }
    try {
      participants = JSON.parse(row.participants ?? '[]') as StoredParticipant[]
    } catch {
      /* ignore */
    }
    const showdown = results.some((r) => r.desc && r.desc !== FOLD_WIN_DESC)
    const mine = participants.find((p) => p.userId === userId) ?? null
    const won = results.filter((r) => r.userId === userId).reduce((a, r) => a + r.amount, 0)
    return {
      id: row.id,
      tableKey: row.tableKey,
      handNumber: row.handNumber,
      potTotal: row.potTotal,
      winners: results.map((r) => r.name).join(' & '),
      at: row.at,
      showdown,
      myNet: mine ? won - mine.committed : null,
      myCards: mine?.cards ?? null,
      board: row.board ?? '',
    }
  })
}

export interface PlayerHandDetail {
  id: string
  tableKey: string
  handNumber: number
  board: string
  potTotal: number
  results: { userId: string; name: string; amount: number; desc: string; cards: string[] }[]
  participants: { userId: string; name: string; committed: number; cards?: string[] }[]
  log: string[]
  trail: HandTrailAction[]
  at: number
  showdown: boolean
}

/**
 * Full hand detail for ONE player. Opponents' hole cards are stripped unless
 * the hand reached showdown (where they were revealed to everyone anyway);
 * the requester always sees their own cards. The action log is public — the
 * live table already broadcasts it to every connected client.
 */
export async function getPlayerHand(db: D1Database, id: string, userId: string): Promise<PlayerHandDetail | null> {
  const row = await db
    .prepare('SELECT id, tableKey, handNumber, board, potTotal, results, participants, log, trail, at FROM HandHistory WHERE id = ?')
    .bind(id)
    .first<any>()
  if (!row) return null
  let results: StoredResult[] = []
  let participants: StoredParticipant[] = []
  try {
    results = JSON.parse(row.results ?? '[]') as StoredResult[]
  } catch {
    /* ignore */
  }
  try {
    participants = JSON.parse(row.participants ?? '[]') as StoredParticipant[]
  } catch {
    /* ignore */
  }
  let log: string[] = []
  try {
    log = typeof row.log === 'string' ? (JSON.parse(row.log) as string[]) : []
  } catch {
    if (typeof row.log === 'string' && row.log.length) log = row.log.split('\n')
  }
  // defensive shape-check: only well-formed public action objects survive
  const VALID_ACTS = new Set(['post', 'fold', 'check', 'call', 'bet', 'raise', 'deal', 'refund', 'win'])
  let trail: HandTrailAction[] = []
  try {
    const parsed = typeof row.trail === 'string' ? (JSON.parse(row.trail) as unknown) : []
    if (Array.isArray(parsed)) {
      trail = parsed.filter(
        (a): a is HandTrailAction =>
          !!a && typeof a === 'object' && typeof (a as any).n === 'number' && VALID_ACTS.has((a as any).act),
      )
    }
  } catch {
    /* legacy row without a trail — empty is fine */
  }
  const showdown = results.some((r) => r.desc && r.desc !== FOLD_WIN_DESC)
  return {
    id: row.id,
    tableKey: row.tableKey,
    handNumber: row.handNumber,
    board: row.board ?? '',
    potTotal: row.potTotal,
    results: results.map((r) => ({ userId: r.userId, name: r.name, amount: r.amount, desc: r.desc, cards: [] })),
    participants: participants.map((p) => {
      const isMine = p.userId === userId
      return {
        userId: p.userId,
        name: p.name,
        committed: p.committed,
        // showdown revealed everyone; fold-wins keep only my own cards
        cards: showdown || isMine ? p.cards : undefined,
      }
    }),
    log,
    trail,
    at: row.at,
    showdown,
  }
}

export async function pruneOldHands(db: D1Database, olderThanMs: number): Promise<number> {
  const res = await db.prepare('DELETE FROM HandHistory WHERE at < ?').bind(Date.now() - olderThanMs).run()
  return res.meta.changes ?? 0
}

export async function pruneOldTransactions(db: D1Database, olderThanMs: number): Promise<number> {
  const res = await db.prepare('DELETE FROM ChipTransaction WHERE at < ?').bind(Date.now() - olderThanMs).run()
  return res.meta.changes ?? 0
}

// ---------- chip ledger ----------

/** Recent ledger entries with usernames — admin Transactions tab. */
export async function listTransactions(db: D1Database, limit = 40) {
  const res = await db
    .prepare(
      `SELECT t.amount, t.reason, t.balanceAfter, t.detail, t.at, u.username
       FROM ChipTransaction t LEFT JOIN User u ON u.id = t.userId
       ORDER BY t.at DESC LIMIT ?`,
    )
    .bind(Math.min(limit, 100))
    .all<any>()
  return (res.results ?? []).map((row) => ({
    username: row.username ?? '(deleted)',
    amount: row.amount,
    reason: row.reason,
    balanceAfter: row.balanceAfter,
    detail: row.detail,
    at: row.at,
  }))
}

/** Admin chip correction — signed delta, atomic, fully ledgered. */
export async function adminAdjustChips(
  db: D1Database,
  userId: string,
  delta: number,
  reason: string,
): Promise<{ ok: boolean; chips?: number; error?: string }> {
  if (!Number.isInteger(delta) || delta === 0) return { ok: false, error: 'Invalid amount' }
  if (delta < 0) {
    const guard = await db
      .prepare('UPDATE User SET chips = chips + ? WHERE id = ? AND chips >= ?')
      .bind(delta, userId, -delta)
      .run()
    if (!guard.success || (guard.meta.changes ?? 0) === 0) return { ok: false, error: 'User does not have that many chips' }
  } else {
    const guard = await db.prepare('UPDATE User SET chips = chips + ? WHERE id = ?').bind(delta, userId).run()
    if (!guard.success || (guard.meta.changes ?? 0) === 0) return { ok: false, error: 'User not found' }
  }
  const balance = await balanceOf(db, userId)
  if (balance == null) return { ok: false, error: 'User not found' }
  try {
    await ledger(db, userId, delta, 'admin_adjust', balance, reason || 'Admin adjustment')
  } catch (e) {
    console.error('[store] admin ledger failed', e)
  }
  return { ok: true, chips: balance }
}

async function balanceOf(db: D1Database, userId: string): Promise<number | null> {
  const row = await db.prepare('SELECT chips FROM User WHERE id = ?').bind(userId).first<any>()
  return row ? row.chips : null
}

async function ledger(db: D1Database, userId: string, amount: number, reason: string, balanceAfter: number, detail: string) {
  await db
    .prepare('INSERT INTO ChipTransaction (id, userId, amount, reason, balanceAfter, detail, at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .bind(UUID(), userId, amount, reason, balanceAfter, detail, Date.now())
    .run()
}

/** Atomically deduct buy-in chips; fails when funds are insufficient. */
export async function buyIn(db: D1Database, userId: string, amount: number, tableKey: string): Promise<{ ok: boolean; chips?: number; error?: string }> {
  if (!Number.isInteger(amount) || amount <= 0) return { ok: false, error: 'Invalid buy-in' }
  const guard = await db
    .prepare('UPDATE User SET chips = chips - ? WHERE id = ? AND chips >= ?')
    .bind(amount, userId, amount)
    .run()
  if (!guard.success) return { ok: false, error: 'Buy-in failed' }
  if ((guard.meta.changes ?? 0) === 0) return { ok: false, error: 'Not enough chips — claim free chips in the lobby' }
  const balance = await balanceOf(db, userId)
  if (balance == null) return { ok: false, error: 'User not found' }
  try {
    await ledger(db, userId, -amount, 'buyin', balance, `Buy-in at table ${tableKey}`)
  } catch (e) {
    console.error('[store] buyin ledger failed', e)
  }
  return { ok: true, chips: balance }
}

/** Return a player's table stack to their lobby balance. */
export async function cashOut(db: D1Database, userId: string, amount: number, tableKey: string): Promise<{ ok: boolean; chips?: number }> {
  if (!Number.isInteger(amount) || amount <= 0) return { ok: true }
  const guard = await db
    .prepare('UPDATE User SET chips = chips + ? WHERE id = ?')
    .bind(amount, userId)
    .run()
  if (!guard.success) return { ok: false }
  const balance = await balanceOf(db, userId)
  if (balance == null) return { ok: false }
  try {
    await ledger(db, userId, amount, 'cashout', balance, `Cash out from table ${tableKey}`)
  } catch (e) {
    console.error('[store] cashout ledger failed', e)
  }
  return { ok: true, chips: balance }
}

/** Free play-money top-up: allowed when balance is low and cooldown has passed. */
export async function claimTopUp(db: D1Database, userId: string): Promise<{ ok: boolean; chips?: number; nextAt?: number; error?: string }> {
  const now = Date.now()
  const before = await balanceOf(db, userId)
  if (before == null) return { ok: false, error: 'User not found' }
  const row = await db.prepare('SELECT lastTopupAt FROM User WHERE id = ?').bind(userId).first<any>()
  if (!row) return { ok: false, error: 'User not found' }
  if (row.lastTopupAt && now - row.lastTopupAt < TOPUP_COOLDOWN_MS) {
    return { ok: false, nextAt: row.lastTopupAt + TOPUP_COOLDOWN_MS, error: 'Top-up cooldown active' }
  }
  if (before >= TOPUP_THRESHOLD) return { ok: false, error: `Free chips available only below ${TOPUP_THRESHOLD}` }
  const guard = await db
    .prepare('UPDATE User SET chips = ?, lastTopupAt = ? WHERE id = ? AND chips = ?')
    .bind(TOPUP_AMOUNT, now, userId, before)
    .run()
  if (!guard.success || (guard.meta.changes ?? 0) === 0) return { ok: false, error: 'Top-up failed — try again' }
  try {
    await ledger(db, userId, TOPUP_AMOUNT - before, 'topup', TOPUP_AMOUNT, 'Free play-money top-up')
  } catch (e) {
    console.error('[store] topup ledger failed', e)
  }
  return { ok: true, chips: TOPUP_AMOUNT }
}

export interface HandParticipantRecord {
  userId: string
  name: string
  committed: number
  /** hole card codes — admin-only omniscient history, never shown to players */
  cards?: string[]
}

/** Persist a completed hand + update player stats in ONE batched round-trip. */
export async function recordHand(
  db: D1Database,
  summary: {
    handNumber: number
    tableKey: string
    board: number[]
    potTotal: number
    results: { userId: string; name: string; amount: number; desc: string; cards: number[] }[]
    participants: { userId: string; name: string; committed: number; cards?: number[] }[]
    log?: string[]
    trail?: HandTrailAction[]
  },
) {
  try {
    const stmts: D1PreparedStatement[] = []
    const participants: HandParticipantRecord[] = summary.participants.map((p) => ({
      userId: p.userId,
      name: p.name,
      committed: p.committed,
      ...(p.cards && p.cards.length >= 2 ? { cards: p.cards.map(cardCode) } : {}),
    }))
    stmts.push(
      db
        .prepare('INSERT INTO HandHistory (id, tableKey, handNumber, board, potTotal, results, participants, log, trail, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .bind(
          UUID(),
          summary.tableKey,
          summary.handNumber,
          summary.board.map(cardCode).join(' '),
          summary.potTotal,
          JSON.stringify(summary.results),
          JSON.stringify(participants),
          JSON.stringify(summary.log ?? []),
          JSON.stringify(summary.trail ?? []),
          Date.now(),
        ),
    )
    for (const p of summary.participants) {
      if (!p.userId || p.userId.startsWith('bot:')) continue
      const won = summary.results.find((r) => r.userId === p.userId)
      stmts.push(
        db
          .prepare('UPDATE User SET handsPlayed = handsPlayed + 1, handsWon = handsWon + ?, biggestPotWon = MAX(biggestPotWon, ?) WHERE id = ?')
          .bind(won ? 1 : 0, won ? won.amount : 0, p.userId),
      )
    }
    await db.batch(stmts)
  } catch (e) {
    console.error('[store] recordHand failed', e)
  }
}

// ==================== tournaments ====================

export interface TournamentRow {
  id: string
  name: string
  gameType: string
  kind: string
  buyIn: number
  bounty: number
  startingStack: number
  seatsPerTable: number
  maxPlayers: number
  startAt: number | null
  levelMs: number
  state: string
  prizePool: number
  winnerUserId: string | null
  createdAt: number
  finishedAt: number | null
}

export interface TournamentEntryRow {
  tournamentId: string
  userId: string
  username?: string
  registeredAt: number
  eliminatedAt: number | null
  finishPlace: number | null
  bountyWon: number
  prizeWon: number
}

export async function createTournament(db: D1Database, cfg: TournamentConfig, prizePool: number): Promise<TournamentRow> {
  const now = Date.now()
  await db
    .prepare(
      'INSERT INTO Tournament (id, name, gameType, kind, buyIn, bounty, startingStack, seatsPerTable, maxPlayers, startAt, levelMs, state, prizePool, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    )
    .bind(cfg.id, cfg.name, cfg.gameType, cfg.kind, cfg.buyIn, cfg.bounty, cfg.startingStack, cfg.seatsPerTable, cfg.maxPlayers, cfg.startAt, cfg.levelMs, 'registering', prizePool, cfg.createdAt)
    .run()
  return {
    id: cfg.id,
    name: cfg.name,
    gameType: cfg.gameType,
    kind: cfg.kind,
    buyIn: cfg.buyIn,
    bounty: cfg.bounty,
    startingStack: cfg.startingStack,
    seatsPerTable: cfg.seatsPerTable,
    maxPlayers: cfg.maxPlayers,
    startAt: cfg.startAt,
    levelMs: cfg.levelMs,
    state: 'registering',
    prizePool,
    winnerUserId: null,
    createdAt: cfg.createdAt,
    finishedAt: null,
  }
}

function rowToTournament(r: any): TournamentRow {
  return {
    id: r.id,
    name: r.name,
    gameType: r.gameType,
    kind: r.kind,
    buyIn: r.buyIn,
    bounty: r.bounty,
    startingStack: r.startingStack,
    seatsPerTable: r.seatsPerTable,
    maxPlayers: r.maxPlayers,
    startAt: r.startAt,
    levelMs: r.levelMs,
    state: r.state,
    prizePool: r.prizePool,
    winnerUserId: r.winnerUserId,
    createdAt: r.createdAt,
    finishedAt: r.finishedAt,
  }
}

export async function getTournament(db: D1Database, id: string): Promise<TournamentRow | null> {
  const r = await db.prepare('SELECT * FROM Tournament WHERE id = ?').bind(id).first<any>()
  return r ? rowToTournament(r) : null
}

export async function listTournaments(db: D1Database, states: string[], limit = 40): Promise<TournamentRow[]> {
  const placeholders = states.map(() => '?').join(',')
  const res = await db
    .prepare(`SELECT * FROM Tournament WHERE state IN (${placeholders}) ORDER BY createdAt DESC LIMIT ?`)
    .bind(...states, limit)
    .all<any>()
  return (res.results ?? []).map(rowToTournament)
}

export async function setTournamentFields(
  db: D1Database,
  id: string,
  fields: Partial<Pick<TournamentRow, 'state' | 'prizePool' | 'winnerUserId' | 'finishedAt' | 'startAt'>>,
): Promise<void> {
  const sets: string[] = []
  const vals: unknown[] = []
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined) continue
    sets.push(`${k} = ?`)
    vals.push(v)
  }
  if (!sets.length) return
  vals.push(id)
  await db.prepare(`UPDATE Tournament SET ${sets.join(', ')} WHERE id = ?`).bind(...vals).run()
}

/** Atomically deduct buy-in and insert the entry. Refunds on any failure. */
export async function registerForTournament(
  db: D1Database,
  tournament: TournamentRow,
  userId: string,
  username: string,
): Promise<{ ok: boolean; chips?: number; error?: string }> {
  const amount = tournament.buyIn
  if (amount > 0) {
    const guard = await db
      .prepare('UPDATE User SET chips = chips - ? WHERE id = ? AND chips >= ?')
      .bind(amount, userId, amount)
      .run()
    if (!guard.success) return { ok: false, error: 'Registration failed' }
    if ((guard.meta.changes ?? 0) === 0) return { ok: false, error: 'Not enough chips — claim free chips in the lobby' }
  }
  try {
    await db
      .prepare('INSERT INTO TournamentEntry (tournamentId, userId, registeredAt) VALUES (?, ?, ?)')
      .bind(tournament.id, userId, Date.now())
      .run()
  } catch {
    // duplicate entry (PRIMARY KEY) or other insert failure → undo the deduction
    if (amount > 0) await db.prepare('UPDATE User SET chips = chips + ? WHERE id = ?').bind(amount, userId).run()
    const dup = await db
      .prepare('SELECT 1 FROM TournamentEntry WHERE tournamentId = ? AND userId = ?')
      .bind(tournament.id, userId)
      .first<any>()
    const chips = amount > 0 ? ((await balanceOf(db, userId)) ?? undefined) : undefined
    return dup
      ? { ok: false, error: 'Already registered', chips }
      : { ok: false, error: 'Registration failed', chips }
  }
  if (amount > 0) {
    const balance = await balanceOf(db, userId)
    if (balance != null) {
      try {
        await ledger(db, userId, -amount, 'tournament_buyin', balance, `Tournament entry: ${tournament.name}`)
      } catch (e) {
        console.error('[store] tournament ledger failed', e)
      }
    }
    return { ok: true, chips: balance ?? undefined }
  }
  const balance = await balanceOf(db, userId)
  return { ok: true, chips: balance ?? undefined }
}

export async function tournamentEntries(db: D1Database, id: string): Promise<TournamentEntryRow[]> {
  const res = await db
    .prepare(
      'SELECT e.*, u.username FROM TournamentEntry e LEFT JOIN User u ON u.id = e.userId WHERE e.tournamentId = ? ORDER BY e.registeredAt',
    )
    .bind(id)
    .all<any>()
  return (res.results ?? []).map((r) => ({
    tournamentId: r.tournamentId,
    userId: r.userId,
    username: r.username,
    registeredAt: r.registeredAt,
    eliminatedAt: r.eliminatedAt,
    finishPlace: r.finishPlace,
    bountyWon: r.bountyWon,
    prizeWon: r.prizeWon,
  }))
}

export async function tournamentEntryCount(db: D1Database, id: string): Promise<number> {
  const r = await db.prepare('SELECT COUNT(*) AS n FROM TournamentEntry WHERE tournamentId = ?').bind(id).first<any>()
  return r?.n ?? 0
}

export async function myTournamentEntries(db: D1Database, userId: string, limit = 60): Promise<TournamentEntryRow[]> {
  const res = await db
    .prepare('SELECT * FROM TournamentEntry WHERE userId = ? ORDER BY registeredAt DESC LIMIT ?')
    .bind(userId, limit)
    .all<any>()
  return (res.results ?? []).map((r) => ({
    tournamentId: r.tournamentId,
    userId: r.userId,
    registeredAt: r.registeredAt,
    eliminatedAt: r.eliminatedAt,
    finishPlace: r.finishPlace,
    bountyWon: r.bountyWon,
    prizeWon: r.prizeWon,
  }))
}

/** Final results: set places + pay prizes and bounties in one batch. */
export async function finishTournamentPayouts(
  db: D1Database,
  id: string,
  results: { userId: string; place: number; prize: number; bounty: number }[],
): Promise<void> {
  const now = Date.now()
  const stmts: D1PreparedStatement[] = []
  for (const r of results) {
    if (r.userId.startsWith('bot:')) continue
    stmts.push(
      db
        .prepare('UPDATE TournamentEntry SET finishPlace = ?, bountyWon = ?, prizeWon = ?, eliminatedAt = COALESCE(eliminatedAt, ?) WHERE tournamentId = ? AND userId = ?')
        .bind(r.place, r.bounty, r.prize, now, id, r.userId),
    )
    const credit = r.prize + r.bounty
    if (credit > 0) {
      stmts.push(db.prepare('UPDATE User SET chips = chips + ? WHERE id = ?').bind(credit, r.userId))
    }
  }
  // ledger entries need balances — do them one by one after the batch
  await db.batch(stmts)
  for (const r of results) {
    const credit = r.prize + r.bounty
    if (r.userId.startsWith('bot:') || credit <= 0) continue
    const balance = await balanceOf(db, r.userId)
    if (balance == null) continue
    const detail =
      r.prize > 0 && r.bounty > 0
        ? `Tournament payout + bounty (place ${r.place})`
        : r.prize > 0
          ? `Tournament payout (place ${r.place})`
          : `Tournament bounty`
    try {
      await ledger(db, r.userId, credit, r.prize > 0 ? 'tournament_prize' : 'tournament_bounty', balance, detail)
    } catch {
      /* ledger best-effort */
    }
  }
}

/** Cancel: refund every paid entry, mark cancelled. */
export async function cancelTournament(db: D1Database, id: string): Promise<number> {
  const t = await getTournament(db, id)
  if (!t) return 0
  if (t.state === 'finished' || t.state === 'cancelled') return 0
  const entries = await tournamentEntries(db, id)
  const stmts: D1PreparedStatement[] = []
  let refunded = 0
  for (const e of entries) {
    if (e.userId.startsWith('bot:')) continue
    const already = e.eliminatedAt != null
    if (t.state === 'running' && already) continue // busts are not refunded
    if (t.state === 'running' && e.prizeWon > 0) continue
    if (t.buyIn > 0) {
      stmts.push(db.prepare('UPDATE User SET chips = chips + ? WHERE id = ?').bind(t.buyIn, e.userId))
      refunded++
    }
  }
  if (stmts.length) await db.batch(stmts)
  for (const e of entries) {
    if (e.userId.startsWith('bot:')) continue
    if (t.state === 'running' && e.eliminatedAt != null) continue
    if (t.buyIn > 0) {
      const balance = await balanceOf(db, e.userId)
      if (balance != null) {
        try {
          await ledger(db, e.userId, t.buyIn, 'tournament_refund', balance, `Tournament cancelled: ${t.name}`)
        } catch {
          /* best-effort */
        }
      }
    }
  }
  await setTournamentFields(db, id, { state: 'cancelled', finishedAt: Date.now() })
  return refunded
}

export interface AdminTournamentRow extends TournamentRow {
  entries: number
}

export async function adminListTournaments(db: D1Database, limit = 60): Promise<AdminTournamentRow[]> {
  const rows = await listTournaments(db, ['registering', 'running', 'finished', 'cancelled'], limit)
  const out: AdminTournamentRow[] = []
  for (const r of rows) {
    const n = await tournamentEntryCount(db, r.id)
    out.push({ ...r, entries: n })
  }
  return out
}
