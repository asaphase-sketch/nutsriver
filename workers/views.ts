/**
 * Shared lobby view builders — used by both the Worker routes (index.ts) and
 * the LobbyDO (lobby-do.ts). Kept in one place so the HTTP fallback and the
 * WebSocket push always agree on the payload shape.
 */
import { TABLE_CONFIGS } from './table-do'
export { TABLE_CONFIGS }
import type { Env } from './env'
import type { LobbyTableSummary, TournamentLobbyItem } from '../src/lib/poker-engine/types'
import { listTournaments, myTournamentEntries, tournamentEntries } from './store'

export function tableStub(env: Env, key: string): DurableObjectStub {
  const known = TABLE_CONFIGS.some((t) => t.key === key)
  const id = env.TABLE.idFromName(known ? key : 'beginners')
  return env.TABLE.get(id)
}

export function tournamentStub(env: Env, tid: string): DurableObjectStub {
  return env.TOURNAMENT.get(env.TOURNAMENT.idFromName(tid))
}

/** Live summary for one cash table — 1 DO request. */
export async function tableSummary(env: Env, key: string): Promise<LobbyTableSummary | null> {
  try {
    const res = await tableStub(env, key).fetch('https://do/summary')
    if (!res.ok) return null
    return (await res.json()) as LobbyTableSummary
  } catch {
    return null
  }
}

/** All lobby-visible cash table summaries in parallel. */
export async function allTableSummaries(env: Env): Promise<LobbyTableSummary[]> {
  const results = await Promise.all(
    TABLE_CONFIGS.filter((cfg) => !cfg.hidden).map((cfg) => tableSummary(env, cfg.key)),
  )
  return results.filter((s): s is LobbyTableSummary => s != null)
}

/**
 * Summaries for a SUBSET of lobby-visible tables — used by the LobbyDO's
 * rotating heartbeat: idle tables are refreshed a few per tick so the DO
 * request volume stays inside the free-tier budget (see lobby-do.ts).
 */
export async function tableSummariesForKeys(env: Env, keys: string[]): Promise<LobbyTableSummary[]> {
  const results = await Promise.all(keys.map((key) => tableSummary(env, key)))
  return results.filter((s): s is LobbyTableSummary => s != null)
}

/**
 * Tournament lobby list. With `userId` the personal fields (myEntry, myTableKey,
 * finishPlace…) are authoritative; with `userId = null` they are neutral — the
 * client overlays its own last-known personal state on top of the pushed list.
 */
export async function tournamentLobbyView(
  db: D1Database,
  env: Env,
  userId: string | null,
): Promise<TournamentLobbyItem[]> {
  const rows = await listTournaments(db, ['registering', 'running', 'finished'], 30)
  const mine = userId ? await myTournamentEntries(db, userId) : []
  const mineMap = new Map(mine.map((e) => [e.tournamentId, e]))
  const items: TournamentLobbyItem[] = []
  for (const row of rows) {
    const base = {
      id: row.id,
      name: row.name,
      gameType: row.gameType as TournamentLobbyItem['gameType'],
      kind: row.kind as TournamentLobbyItem['kind'],
      buyIn: row.buyIn,
      bounty: row.bounty,
      startingStack: row.startingStack,
      seatsPerTable: row.seatsPerTable,
      maxPlayers: row.maxPlayers,
      startAt: row.startAt,
      levelMs: row.levelMs,
      state: row.state as TournamentLobbyItem['state'],
      prizePool: row.prizePool,
      registeredAt: mineMap.get(row.id)?.registeredAt ?? null,
      finishPlace: mineMap.get(row.id)?.finishPlace ?? null,
      prizeWon: mineMap.get(row.id)?.prizeWon ?? null,
      bountyWon: mineMap.get(row.id)?.bountyWon ?? null,
    }
    let live: Record<string, unknown> = {}
    if (row.state === 'running') {
      try {
        const res = await tournamentStub(env, row.id).fetch('https://do/summary')
        if (res.ok) live = (await res.json()) as Record<string, unknown>
      } catch {
        /* DO asleep — fall back to D1-only fields */
      }
    }
    let myTableKey: string | null = null
    if (userId && row.state === 'running' && mineMap.has(row.id)) {
      try {
        const res = await tournamentStub(env, row.id).fetch(`https://do/seat-of?userId=${encodeURIComponent(userId)}`)
        if (res.ok) {
          const data = (await res.json()) as { tableKey?: string | null; eliminated?: boolean }
          myTableKey = data.eliminated ? null : (data.tableKey ?? null)
        }
      } catch {
        /* DO unreachable */
      }
    }
    items.push({
      ...base,
      entries: Number(live.entries ?? 0) || (row.state === 'registering' ? await tournamentEntries(db, row.id).then((e) => e.length).catch(() => 0) : 0),
      playersLeft: Number(live.playersLeft ?? 0),
      level: Number(live.level ?? 0),
      blinds: (live.blinds as { sb: number; bb: number } | undefined) ?? null,
      levelEndsAt: (live.levelEndsAt as number | null | undefined) ?? null,
      myEntry: mineMap.has(row.id),
      myTableKey,
    })
  }
  return items
}
