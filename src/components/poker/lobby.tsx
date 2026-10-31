'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { DoorOpen, Gift, Medal, Megaphone, Trophy, Users, X, Zap } from 'lucide-react'
import { cn } from '@/lib/utils'
import { formatChips } from '@/lib/poker/cards'
import {
  GAME_LABEL,
  type ClientTableView,
  type GameType,
  type LeaderboardRow,
  type TournamentLobbyItem,
} from '@/lib/poker/types'
import type { PokerClient } from '@/hooks/use-poker'
import { useToast } from '@/hooks/use-toast'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { SeatDialog } from './seat-dialog'

const FREE_CHIP_THRESHOLD = 1000

type LobbyTab = 'cash' | 'tournaments' | 'leaderboard'
type StakeBucket = 'all' | 'micro' | 'mid' | 'high'
type GameFilter = 'all' | GameType
type SortMode = 'recommended' | 'stakes-asc' | 'stakes-desc' | 'players' | 'action'

/** Stake buckets by big blind — mirrors the lobby filter chips. */
const stakeBucketOf = (bb: number): Exclude<StakeBucket, 'all'> =>
  bb <= 10 ? 'micro' : bb <= 100 ? 'mid' : 'high'

const STAKE_LABEL: Record<Exclude<StakeBucket, 'all'>, string> = {
  micro: 'Micro ≤10',
  mid: 'Mid ≤100',
  high: 'High 100+',
}

function Chip({
  active,
  onClick,
  children,
  title,
}: {
  active: boolean
  onClick: () => void
  children: React.ReactNode
  title?: string
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-pressed={active}
      className={cn(
        'rounded-full border px-3 py-1 text-xs font-semibold transition',
        active
          ? 'border-amber-300/60 bg-amber-400/15 text-amber-200'
          : 'border-white/10 bg-white/5 text-white/55 hover:border-white/25 hover:text-white',
      )}
    >
      {children}
    </button>
  )
}

interface LobbyProps {
  poker: PokerClient
}

export function Lobby({ poker }: LobbyProps) {
  const [tab, setTab] = useState<LobbyTab>('cash')
  const [seatTableKey, setSeatTableKey] = useState<string | null>(null)
  const [pickedSeat, setPickedSeat] = useState<number | null>(null)
  const [now, setNow] = useState(() => Date.now())

  const view: ClientTableView | null = seatTableKey ? poker.tableViews[seatTableKey] ?? null : null

  // keep a ref to the latest hook state so the cleanup below never reads stale data
  const pokerRef = useRef(poker)
  useEffect(() => {
    pokerRef.current = poker
  }, [poker])

  // countdown ticker for scheduled tournaments
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [])

  // subscribe while the seat picker is open so the seat map stays fresh
  const { subscribeTable, unsubscribeTable } = poker
  useEffect(() => {
    if (!seatTableKey) return
    subscribeTable(seatTableKey)
    return () => {
      const latest = pokerRef.current
      const seated = latest.tableViews[seatTableKey]?.selfSeat != null
      const viewing = latest.activeTable === seatTableKey
      if (!seated && !viewing) unsubscribeTable(seatTableKey)
    }
  }, [seatTableKey, subscribeTable, unsubscribeTable])

  const seatedSomewhere = Object.values(poker.tableViews).find((v) => v.selfSeat != null)

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-1 flex-col gap-5 p-4">
      {/* admin announcements — gold 2.5D strip, dismissible, most recent last */}
      {poker.announcements.map((a) => (
        <div
          key={a.id}
          role="status"
          className="flex items-start gap-3 rounded-xl border border-amber-300/40 bg-gradient-to-b from-amber-400/15 to-amber-600/5 px-4 py-3 shadow-lg shadow-amber-900/20"
        >
          <Megaphone className="mt-0.5 h-4 w-4 shrink-0 text-amber-300" aria-hidden />
          <p className="min-w-0 flex-1 text-sm font-medium text-amber-100">{a.message}</p>
          <button
            type="button"
            onClick={() => poker.dismissAnnouncement(a.id)}
            aria-label="Dismiss announcement"
            className="shrink-0 rounded-md p-1 text-amber-200/60 transition hover:bg-white/10 hover:text-amber-100"
          >
            <X className="h-3.5 w-3.5" aria-hidden />
          </button>
        </div>
      ))}

      <section className="text-center">
        <h2 className="font-serif text-2xl font-bold text-white sm:text-3xl">nuts<span className="text-orange-400">river</span> lobby</h2>
        <p className="mt-1 text-sm text-white/50">
          Play-money poker — No-Limit Hold&apos;em &amp; Pot-Limit Omaha, cash games and tournaments.
        </p>
      </section>

      {/* tabs */}
      <div className="mx-auto flex w-full max-w-md rounded-xl border border-white/10 bg-slate-950/70 p-1">
        {(
          [
            { id: 'cash', label: 'Cash Games' },
            { id: 'tournaments', label: 'Tournaments' },
            { id: 'leaderboard', label: 'Leaderboard' },
          ] as const
        ).map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setTab(t.id)}
            className={cn(
              'flex-1 rounded-lg px-3 py-2 text-sm font-bold transition',
              tab === t.id
                ? 'bg-gradient-to-b from-amber-400 to-amber-600 text-slate-950 shadow'
                : 'text-white/60 hover:text-white',
            )}
          >
            {t.label}
          </button>
        ))}
      </div>

      {seatedSomewhere && (
        <button
          type="button"
          onClick={() => poker.setActiveTable(seatedSomewhere.tableKey)}
          className="mx-auto flex items-center gap-2 rounded-full border border-emerald-400/40 bg-emerald-500/15 px-4 py-2 text-sm font-semibold text-emerald-200 transition hover:bg-emerald-500/25"
        >
          <DoorOpen className="h-4 w-4" aria-hidden />
          You have a seat at {seatedSomewhere.name} — return to the table
        </button>
      )}

      {tab === 'cash' ? (
        <CashLobby poker={poker} onPick={(key, seat) => (setSeatTableKey(key), setPickedSeat(seat))} />
      ) : tab === 'tournaments' ? (
        <TournamentLobby poker={poker} now={now} />
      ) : (
        <LeaderboardTab poker={poker} />
      )}

      {poker.user && poker.chips < FREE_CHIP_THRESHOLD && (
        <button
          type="button"
          onClick={() => poker.claimFreeChips()}
          className="mx-auto mb-2 flex items-center gap-2 rounded-xl border border-amber-300/40 bg-amber-400/10 px-5 py-3 text-sm font-semibold text-amber-200 transition hover:bg-amber-400/20"
        >
          <Gift className="h-4 w-4" aria-hidden />
          Running low? Claim 10,000 free play-money chips
        </button>
      )}

      {/* seat picker → buy-in flow */}
      {seatTableKey && view && pickedSeat == null && (
        <SeatPickerDialog
          view={view}
          balance={poker.chips}
          onClose={() => setSeatTableKey(null)}
          onPick={(idx) => setPickedSeat(idx)}
        />
      )}

      {seatTableKey && view && pickedSeat != null && (
        <SeatDialog
          view={view}
          seatIndex={pickedSeat}
          balance={poker.chips}
          open
          onClose={() => {
            setSeatTableKey(null)
            setPickedSeat(null)
          }}
          onConfirm={(seatIndex, buyIn) => {
            poker.sitDown(seatTableKey, seatIndex, buyIn)
            setSeatTableKey(null)
            setPickedSeat(null)
          }}
        />
      )}
    </div>
  )
}

// ==================== cash ====================

const SORT_LABEL: Record<SortMode, string> = {
  recommended: 'Recommended',
  'stakes-asc': 'Stakes: low → high',
  'stakes-desc': 'Stakes: high → low',
  players: 'Most players',
  action: 'Biggest pots',
}

function CashLobby({ poker, onPick }: { poker: PokerClient; onPick: (key: string, seat: number | null) => void }) {
  const { toast } = useToast()
  const [gameFilter, setGameFilter] = useState<GameFilter>('all')
  const [stakeFilter, setStakeFilter] = useState<StakeBucket>('all')
  const [openOnly, setOpenOnly] = useState(false)
  const [sort, setSort] = useState<SortMode>('recommended')
  const [quickSeatKey, setQuickSeatKey] = useState<string | null>(null)
  const quickBuyInRef = useRef(0)

  const tableViews = poker.tableViews

  // complete a Quick Seat once the table snapshot arrives: sit at the first
  // open seat with the pre-computed buy-in. Fires exactly once per attempt
  // (ref guard — table snapshots keep streaming in); the button-label reset
  // is deferred to a task so the effect body never sets state synchronously.
  const quickDoneRef = useRef<string | null>(null)
  useEffect(() => {
    if (!quickSeatKey || quickDoneRef.current === quickSeatKey) return
    const view = tableViews[quickSeatKey]
    if (!view) return
    quickDoneRef.current = quickSeatKey
    if (view.selfSeat == null) {
      const empty = view.seats.find((s) => s.status === 'EMPTY')
      if (empty) {
        poker.sitDown(quickSeatKey, empty.seatIndex, quickBuyInRef.current)
      } else {
        toast({ title: 'Quick Seat', description: 'That table just filled up — try again.', variant: 'destructive' })
      }
    }
    const id = window.setTimeout(() => {
      setQuickSeatKey(null)
      quickDoneRef.current = null
    }, 0)
    return () => window.clearTimeout(id)
  }, [quickSeatKey, tableViews, poker, toast])

  // Quick Seat watchdog — the table socket must produce a snapshot within 6s
  useEffect(() => {
    if (!quickSeatKey) return
    const id = setTimeout(() => {
      toast({ title: 'Quick Seat', description: 'Could not reach that table — try again.', variant: 'destructive' })
      setQuickSeatKey(null)
    }, 6000)
    return () => clearTimeout(id)
  }, [quickSeatKey])

  const tables = useMemo(() => {
    const list = poker.lobbyTables.filter((t) => {
      if (gameFilter !== 'all' && (t.gameType ?? 'holdem') !== gameFilter) return false
      if (stakeFilter !== 'all' && stakeBucketOf(t.bigBlind) !== stakeFilter) return false
      if (openOnly && t.playersSeated >= t.maxSeats) return false
      return true
    })
    const by: Record<SortMode, (a: (typeof list)[number], b: (typeof list)[number]) => number> = {
      recommended: (a, b) =>
        b.humansSeated - a.humansSeated || (b.inHand ? 1 : 0) - (a.inHand ? 1 : 0) || a.bigBlind - b.bigBlind,
      'stakes-asc': (a, b) => a.bigBlind - b.bigBlind,
      'stakes-desc': (a, b) => b.bigBlind - a.bigBlind,
      players: (a, b) => b.playersSeated - a.playersSeated || a.bigBlind - b.bigBlind,
      action: (a, b) => b.avgPot - a.avgPot,
    }
    return [...list].sort(by[sort])
  }, [poker.lobbyTables, gameFilter, stakeFilter, openOnly, sort])

  const quickSeatNow = () => {
    const balance = poker.chips
    const candidates = poker.lobbyTables
      .filter((t) => t.playersSeated < t.maxSeats && balance >= t.minBuyIn)
      .sort((a, b) => b.humansSeated - a.humansSeated || a.bigBlind - b.bigBlind)
    if (candidates.length === 0) {
      const anyOpen = poker.lobbyTables.some((t) => t.playersSeated < t.maxSeats)
      toast({
        title: 'Quick Seat',
        description: anyOpen
          ? 'Your balance is too low for every open table — claim free chips first.'
          : 'Every seat is taken right now — try again in a moment.',
        variant: 'destructive',
      })
      return
    }
    const t = candidates[0]!
    // default buy-in: 100 big blinds clamped to the table window and the balance
    const target = Math.min(t.maxBuyIn, t.bigBlind * 100)
    quickBuyInRef.current = balance >= target ? target : Math.max(t.minBuyIn, Math.floor(balance))
    setQuickSeatKey(t.tableKey)
    poker.subscribeTable(t.tableKey)
  }

  return (
    <section className="flex flex-col gap-4" aria-label="Poker tables">
      {/* filters + sort + quick seat */}
      <div className="flex flex-col gap-3 rounded-2xl border border-white/10 bg-slate-950/70 p-3">
        <div className="flex flex-wrap items-center gap-2">
          <span className="mr-1 text-[11px] font-bold uppercase tracking-wider text-white/40">Game</span>
          <Chip active={gameFilter === 'all'} onClick={() => setGameFilter('all')}>All</Chip>
          {(['holdem', 'omaha4', 'omaha5'] as const).map((gt) => (
            <Chip key={gt} active={gameFilter === gt} onClick={() => setGameFilter(gt)}>
              {GAME_LABEL[gt]}
            </Chip>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="mr-1 text-[11px] font-bold uppercase tracking-wider text-white/40">Stakes</span>
          <Chip active={stakeFilter === 'all'} onClick={() => setStakeFilter('all')}>All</Chip>
          {(['micro', 'mid', 'high'] as const).map((s) => (
            <Chip key={s} active={stakeFilter === s} onClick={() => setStakeFilter(s)}>
              {STAKE_LABEL[s]}
            </Chip>
          ))}
          <Chip active={openOnly} onClick={() => setOpenOnly(!openOnly)} title="Only tables with an open seat">
            Seats open
          </Chip>
          <div className="ml-auto flex items-center gap-2">
            <Select value={sort} onValueChange={(v) => setSort(v as SortMode)}>
              <SelectTrigger className="h-8 w-[168px] border-white/10 bg-white/5 text-xs text-white" aria-label="Sort tables">
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="bg-slate-950 text-white">
                {(Object.keys(SORT_LABEL) as SortMode[]).map((s) => (
                  <SelectItem key={s} value={s} className="text-xs">
                    {SORT_LABEL[s]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              className="bg-emerald-600 font-bold hover:bg-emerald-500"
              onClick={quickSeatNow}
              disabled={quickSeatKey != null}
            >
              <Zap className="mr-1 h-4 w-4" aria-hidden />
              {quickSeatKey != null ? 'Seat found…' : 'Quick Seat'}
            </Button>
          </div>
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {tables.map((t) => {
          const live = tableViews[t.tableKey]
          const seatedHere = live?.selfSeat != null
          const gt = t.gameType ?? 'holdem'
          const full = t.playersSeated >= t.maxSeats
          return (
            <article
              key={t.tableKey}
              className="flex flex-col rounded-2xl border border-white/10 bg-slate-950/70 p-4 shadow-lg shadow-black/30 transition hover:border-amber-300/30"
            >
              <div className="flex items-start justify-between gap-2">
                <div>
                  <h3 className="font-serif text-lg font-bold text-white">{t.name}</h3>
                  <p className="text-xs font-semibold text-amber-200/90">
                    Blinds {formatChips(t.smallBlind)}/{formatChips(t.bigBlind)}
                  </p>
                </div>
                <div className="flex flex-col items-end gap-1">
                  <span
                    className={cn(
                      'rounded px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider ring-1',
                      gt === 'holdem'
                        ? 'bg-white/10 text-white/70 ring-white/15'
                        : 'bg-emerald-500/15 text-emerald-300 ring-emerald-400/30',
                    )}
                  >
                    {GAME_LABEL[gt]}
                  </span>
                  <span
                    className={cn(
                      'rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider',
                      t.inHand ? 'bg-emerald-500/20 text-emerald-300' : 'bg-white/10 text-white/50',
                    )}
                  >
                    {t.inHand ? 'Live' : 'Waiting'}
                  </span>
                </div>
              </div>

              <dl className="mt-3 grid grid-cols-3 gap-2 text-center">
                <div className="rounded-lg bg-white/5 py-1.5">
                  <dt className="text-[10px] uppercase tracking-wide text-white/40">Seats</dt>
                  <dd className={cn('text-sm font-bold', full ? 'text-rose-300' : 'text-white')}>
                    {t.playersSeated}/{t.maxSeats}
                  </dd>
                </div>
                <div className="rounded-lg bg-white/5 py-1.5">
                  <dt className="text-[10px] uppercase tracking-wide text-white/40">Avg pot</dt>
                  <dd className="text-sm font-bold text-white">{formatChips(t.avgPot)}</dd>
                </div>
                <div className="rounded-lg bg-white/5 py-1.5">
                  <dt className="text-[10px] uppercase tracking-wide text-white/40">Hands</dt>
                  <dd className="text-sm font-bold text-white">{formatChips(t.handsPlayed)}</dd>
                </div>
              </dl>

              <div className="mt-3 flex items-center justify-between text-[11px] text-white/45">
                <span className="flex items-center gap-1">
                  <Users className="h-3 w-3" aria-hidden />
                  {t.humansSeated > 0 ? `${t.humansSeated} human${t.humansSeated > 1 ? 's' : ''}` : 'Bots only'}
                </span>
                <span>
                  Buy-in {formatChips(t.minBuyIn)}–{formatChips(t.maxBuyIn)}
                </span>
              </div>

              <div className="mt-4">
                <Button
                  className={cn(
                    'w-full font-bold',
                    seatedHere
                      ? 'bg-slate-700 hover:bg-slate-600'
                      : full
                        ? 'bg-slate-800 text-white/50 hover:bg-slate-800'
                        : 'bg-emerald-600 hover:bg-emerald-500',
                  )}
                  onClick={() =>
                    seatedHere
                      ? poker.setActiveTable(t.tableKey)
                      : onPick(t.tableKey, null)
                  }
                >
                  {seatedHere ? 'Return to table' : full ? 'Table full' : 'Take a seat'}
                </Button>
              </div>
            </article>
          )
        })}

        {tables.length === 0 && poker.lobbyTables.length > 0 && (
          <p className="col-span-full rounded-2xl border border-white/10 bg-slate-950/70 py-12 text-center text-sm text-white/45">
            No tables match these filters — loosen them to see the full room.
          </p>
        )}

        {poker.lobbyTables.length === 0 && (
          <p className="col-span-full py-16 text-center text-sm text-white/40">
            {poker.connected ? 'Loading tables…' : 'Connecting to the poker room…'}
          </p>
        )}
      </div>
    </section>
  )
}

// ==================== leaderboard ====================

const MEDAL = ['text-amber-300', 'text-slate-300', 'text-orange-400']

function LeaderboardTab({ poker }: { poker: PokerClient }) {
  const [rows, setRows] = useState<LeaderboardRow[] | null>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let cancelled = false
    const load = () =>
      fetch('/api/leaderboard')
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error('failed'))))
        .then((d: { players: LeaderboardRow[] }) => {
          if (!cancelled) {
            setRows(d.players ?? [])
            setFailed(false)
          }
        })
        .catch(() => {
          if (!cancelled) setFailed(true)
        })
    load()
    const id = setInterval(() => {
      if (document.visibilityState !== 'hidden') load()
    }, 30_000)
    return () => {
      cancelled = true
      clearInterval(id)
    }
  }, [])

  if (rows == null) {
    return (
      <p className="rounded-2xl border border-white/10 bg-slate-950/70 py-16 text-center text-sm text-white/40">
        Loading the chip leaderboard…
      </p>
    )
  }
  if (failed || rows.length === 0) {
    return (
      <p className="rounded-2xl border border-white/10 bg-slate-950/70 py-16 text-center text-sm text-white/40">
        No standings yet — play a few hands to appear on the leaderboard.
      </p>
    )
  }

  const me = poker.user?.username
  const podium = rows.slice(0, 3)
  const rest = rows.slice(3)

  return (
    <section className="flex flex-col gap-4" aria-label="Chip leaderboard">
      {/* top 3 podium */}
      <div className="grid gap-3 sm:grid-cols-3">
        {podium.map((p, i) => (
          <article
            key={p.username}
            className={cn(
              'flex flex-col items-center gap-1 rounded-2xl border p-4 text-center shadow-lg shadow-black/30',
              i === 0
                ? 'border-amber-300/40 bg-gradient-to-b from-amber-400/15 to-slate-950/80'
                : 'border-white/10 bg-slate-950/70',
              p.username === me && 'ring-1 ring-emerald-400/60',
            )}
          >
            <Medal className={cn('h-6 w-6', MEDAL[i])} aria-hidden />
            <h3 className="font-serif text-base font-bold text-white">{p.username}</h3>
            <p className="text-lg font-black tabular-nums text-amber-200">{formatChips(p.chips)}</p>
            <p className="text-[11px] text-white/45">
              {formatChips(p.handsPlayed)} hands · {p.handsPlayed > 0 ? Math.round((p.handsWon / p.handsPlayed) * 100) : 0}% won
            </p>
            <p className="text-[11px] text-white/40">biggest pot {formatChips(p.biggestPotWon)}</p>
          </article>
        ))}
      </div>

      {/* 4..20 */}
      <div className="overflow-hidden rounded-2xl border border-white/10 bg-slate-950/70">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-white/10 text-left text-[11px] uppercase tracking-wider text-white/40">
              <th className="px-4 py-2 font-bold">#</th>
              <th className="px-2 py-2 font-bold">Player</th>
              <th className="px-2 py-2 text-right font-bold">Chips</th>
              <th className="hidden px-2 py-2 text-right font-bold sm:table-cell">Hands</th>
              <th className="hidden px-2 py-2 text-right font-bold sm:table-cell">Won %</th>
              <th className="hidden px-4 py-2 text-right font-bold md:table-cell">Biggest pot</th>
            </tr>
          </thead>
          <tbody>
            {rest.map((p, i) => (
              <tr
                key={p.username}
                className={cn(
                  'border-b border-white/5 last:border-0',
                  p.username === me && 'bg-emerald-500/10',
                )}
              >
                <td className="px-4 py-2 font-bold tabular-nums text-white/50">{i + 4}</td>
                <td className="px-2 py-2 font-semibold text-white/90">
                  {p.username}
                  {p.username === me && <span className="ml-2 text-[10px] font-bold text-emerald-300">YOU</span>}
                </td>
                <td className="px-2 py-2 text-right font-bold tabular-nums text-amber-200">{formatChips(p.chips)}</td>
                <td className="hidden px-2 py-2 text-right tabular-nums text-white/60 sm:table-cell">{formatChips(p.handsPlayed)}</td>
                <td className="hidden px-2 py-2 text-right tabular-nums text-white/60 sm:table-cell">
                  {p.handsPlayed > 0 ? Math.round((p.handsWon / p.handsPlayed) * 100) : 0}%
                </td>
                <td className="hidden px-4 py-2 text-right tabular-nums text-white/60 md:table-cell">{formatChips(p.biggestPotWon)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="text-center text-[11px] text-white/35">
        Play-money standings only — chips have no monetary value and refresh for free when you run low.
      </p>
    </section>
  )
}

// ==================== tournaments ====================

function TournamentLobby({ poker, now }: { poker: PokerClient; now: number }) {
  const live = poker.tournaments.filter((t) => t.state === 'registering' || t.state === 'running')
  const done = poker.tournaments.filter((t) => t.state === 'finished').slice(0, 6)

  return (
    <section className="flex flex-col gap-4" aria-label="Tournaments">
      {live.length === 0 && (
        <p className="rounded-2xl border border-white/10 bg-slate-950/70 py-12 text-center text-sm text-white/40">
          No tournaments right now — ask the room admin to open one from the nutsriver control panel.
        </p>
      )}

      {live.map((t) => (
        <TournamentCard key={t.id} t={t} poker={poker} now={now} />
      ))}

      {done.length > 0 && (
        <div className="rounded-2xl border border-white/10 bg-slate-950/70 p-4">
          <h3 className="mb-2 flex items-center gap-2 text-sm font-bold text-white/80">
            <Trophy className="h-4 w-4 text-amber-300" aria-hidden /> Recent results
          </h3>
          <ul className="flex flex-col gap-1.5 text-xs text-white/60">
            {done.map((t) => (
              <li key={t.id} className="flex flex-wrap items-center gap-x-2">
                <span className="font-semibold text-white/85">{t.name}</span>
                <span className="text-white/40">{GAME_LABEL[t.gameType]}</span>
                {t.finishPlace != null && (
                  <span className={cn('font-bold', t.finishPlace === 1 ? 'text-amber-300' : 'text-emerald-300/80')}>
                    you placed #{t.finishPlace}
                  </span>
                )}
                {(t.prizeWon ?? 0) + (t.bountyWon ?? 0) > 0 && (
                  <span className="text-emerald-300">+{formatChips((t.prizeWon ?? 0) + (t.bountyWon ?? 0))}</span>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  )
}

function TournamentCard({ t, poker, now }: { t: TournamentLobbyItem; poker: PokerClient; now: number }) {
  const [busy, setBusy] = useState(false)
  const gt = t.gameType
  const bounty = t.bounty > 0

  const register = async () => {
    setBusy(true)
    await poker.registerTournament(t.id)
    setBusy(false)
  }

  const join = async () => {
    setBusy(true)
    await poker.joinTournament(t.id)
    setBusy(false)
  }

  const startsIn = t.startAt ? Math.max(0, Math.floor((t.startAt - now) / 1000)) : null
  const canJoinLive = t.state === 'running' && t.myEntry && t.myTableKey

  return (
    <article className="flex flex-col gap-3 rounded-2xl border border-amber-300/20 bg-gradient-to-b from-slate-950/80 to-slate-900/60 p-4 shadow-lg shadow-black/30 sm:flex-row sm:items-center">
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="font-serif text-lg font-bold text-white">{t.name}</h3>
          <span className="rounded bg-emerald-500/15 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-emerald-300 ring-1 ring-emerald-400/30">
            {GAME_LABEL[gt]}
          </span>
          {bounty && (
            <span className="rounded bg-rose-500/15 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-rose-300 ring-1 ring-rose-400/30">
              Knockout {formatChips(t.bounty)}
            </span>
          )}
          <span
            className={cn(
              'rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider',
              t.state === 'running' ? 'bg-emerald-500/20 text-emerald-300' : 'bg-amber-500/20 text-amber-300',
            )}
          >
            {t.state === 'running' ? 'Running' : t.kind === 'sitgo' ? 'Sit & Go' : 'Scheduled'}
          </span>
        </div>

        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-white/55">
          <span>
            Buy-in <b className="text-amber-200">{t.buyIn > 0 ? formatChips(t.buyIn) : 'FREE'}</b>
          </span>
          <span>
            Stack <b className="text-white/80">{formatChips(t.startingStack)}</b>
          </span>
          <span>
            Prize pool{' '}
            <b className="text-emerald-300">{t.prizePool > 0 ? formatChips(t.prizePool) : '—'}</b>
          </span>
          <span>
            Seats <b className="text-white/80">{t.entries}/{t.maxPlayers}</b>
          </span>
          {t.state === 'running' && (
            <>
              <span>
                Left <b className="text-white/80">{t.playersLeft}</b>
              </span>
              {t.blinds && (
                <span>
                  Blinds <b className="text-white/80">{formatChips(t.blinds.sb)}/{formatChips(t.blinds.bb)}</b>
                </span>
              )}
            </>
          )}
          {t.state === 'registering' && startsIn != null && (
            <span className="flex items-center gap-1 text-amber-200/90">
              <Zap className="h-3 w-3" aria-hidden />
              starts in {Math.floor(startsIn / 60)}:{String(startsIn % 60).padStart(2, '0')}
            </span>
          )}
          {t.state === 'running' && t.levelEndsAt && (
            <span className="text-white/40">
              level up in {Math.max(0, Math.floor((t.levelEndsAt - now) / 60000))}m
            </span>
          )}
        </div>
      </div>

      <div className="flex shrink-0 items-center gap-2">
        {t.state === 'registering' ? (
          t.myEntry ? (
            <span className="rounded-lg border border-emerald-400/40 bg-emerald-500/10 px-4 py-2 text-xs font-bold text-emerald-300">
              Registered ✓
            </span>
          ) : (
            <Button
              disabled={busy || t.entries >= t.maxPlayers}
              className="bg-emerald-600 font-bold hover:bg-emerald-500"
              onClick={register}
            >
              {t.entries >= t.maxPlayers ? 'Full' : t.buyIn > 0 ? `Register — ${formatChips(t.buyIn)}` : 'Register — FREE'}
            </Button>
          )
        ) : t.state === 'running' ? (
          t.myEntry ? (
            canJoinLive ? (
              <Button className="bg-emerald-600 font-bold hover:bg-emerald-500" onClick={join} disabled={busy}>
                Take my seat
              </Button>
            ) : (
              <span className="rounded-lg border border-white/15 bg-white/5 px-4 py-2 text-xs font-semibold text-white/60">
                {t.finishPlace != null ? `Finished #${t.finishPlace}` : 'In the field'}
              </span>
            )
          ) : (
            <span className="rounded-lg border border-white/15 bg-white/5 px-4 py-2 text-xs font-semibold text-white/50">
              Spectate from the lobby
            </span>
          )
        ) : (
          <span className="rounded-lg border border-white/15 bg-white/5 px-4 py-2 text-xs font-semibold text-white/50">
            Completed
          </span>
        )}
      </div>
    </article>
  )
}

function SeatPickerDialog({
  view,
  balance,
  onClose,
  onPick,
}: {
  view: ClientTableView
  balance: number
  onClose: () => void
  onPick: (seatIndex: number) => void
}) {
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-sm bg-slate-950 text-white">
        <DialogHeader>
          <DialogTitle>{view.name} — choose your seat</DialogTitle>
          <DialogDescription className="text-white/50">
            Blinds {formatChips(view.smallBlind)}/{formatChips(view.bigBlind)} · your balance{' '}
            {formatChips(balance)}
          </DialogDescription>
        </DialogHeader>
        {balance < view.minBuyIn ? (
          <p className="rounded-md border border-rose-500/40 bg-rose-500/10 p-3 text-sm text-rose-200">
            You need at least {formatChips(view.minBuyIn)} chips for this table. Claim free chips in the
            lobby first.
          </p>
        ) : (
          <div className="grid grid-cols-3 gap-2">
            {view.seats.map((s) => {
              const isOpen = s.status === 'EMPTY'
              return (
                <button
                  key={s.seatIndex}
                  type="button"
                  disabled={!isOpen}
                  onClick={() => onPick(s.seatIndex)}
                  className={cn(
                    'rounded-lg border p-2 text-center text-xs font-semibold transition',
                    isOpen
                      ? 'border-emerald-400/40 bg-emerald-500/10 text-emerald-200 hover:bg-emerald-500/25'
                      : 'cursor-not-allowed border-white/10 bg-white/5 text-white/30',
                  )}
                >
                  Seat {s.seatIndex + 1}
                  <span className="block text-[10px] font-normal opacity-70">
                    {isOpen ? 'Open' : s.status === 'EMPTY' ? '—' : 'Taken'}
                  </span>
                </button>
              )
            })}
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
