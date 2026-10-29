'use client'

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { ArrowLeft, Coins, LogOut, Pause, Play, Palette, PlusCircle, RotateCw, Trophy, Volume2, VolumeX } from 'lucide-react'
import { cn } from '@/lib/utils'
import { formatChips, PHASE_LABEL } from '@/lib/poker/cards'
import { seatAnchor, towardCenter } from '@/lib/poker/layout'
import { GAME_LABEL, type ClientTableView } from '@/lib/poker/types'
import { useCountdown, type PokerClient } from '@/hooks/use-poker'
import { useTableSounds } from '@/hooks/use-table-sounds'
import { getMuteSnapshot, setMuted, subscribeMute } from '@/lib/poker/sounds'
import { getFourColor, subscribeFourColor } from '@/lib/poker/four-color'
import { Button } from '@/components/ui/button'
import { ActionBar } from './action-bar'
import { HandRankingsDialog } from './hand-rankings'
import { HandStrength } from './hand-strength'
import { PlayingCard, toggleFourColor } from './playing-card'
import { RebuyDialog } from './rebuy-dialog'
import { Seat, BetChip } from './seat'
import { SeatDialog } from './seat-dialog'
import { SidePanel } from './side-panel'

interface TableViewProps {
  poker: PokerClient
  view: ClientTableView
}

/** Tournament table keys look like `t:<id>:<n>`. */
const isTournamentTable = (key: string) => key.startsWith('t:')

/** ms between dealt cards around the table (matches Seat's DEAL_STEP_MS) */
const DEAL_STEP_MS = 150

type Perspective = 'me' | number

function loadPersp(tableKey: string): Perspective {
  try {
    const raw = localStorage.getItem(`nr-persp:${tableKey}`)
    if (raw === 'me' || raw == null) return 'me'
    const n = Number(raw)
    return Number.isInteger(n) && n >= 0 ? n : 'me'
  } catch {
    return 'me'
  }
}

export function TableView({ poker, view }: TableViewProps) {
  const [seatDialogFor, setSeatDialogFor] = useState<number | null>(null)
  const [rebuyOpen, setRebuyOpen] = useState(false)
  const actingUntilRef = useRef(0)
  const [busy, setBusy] = useState(false)
  const muted = useSyncExternalStore(subscribeMute, getMuteSnapshot, () => false)
  const fourColor = useSyncExternalStore(subscribeFourColor, getFourColor, () => false)
  const [now, setNow] = useState(() => Date.now())
  const { fraction: timeFraction, secondsLeft } = useCountdown(view.actionDeadline, view.actionWindow)

  const tournament = isTournamentTable(view.tableKey)
  const gameType = view.gameType ?? 'holdem'

  useTableSounds(view, poker.user?.id ?? null)

  // countdown ticker (tournament level clock + deal-expiry bookkeeping)
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [])

  // (re-)join the table room on mount — server-side join is idempotent, so this
  // also heals any unsubscribe race when coming from the seat picker
  const { tableKey } = view
  const subscribeTable = poker.subscribeTable
  useEffect(() => {
    subscribeTable(tableKey)
  }, [tableKey, subscribeTable])

  const isSeated = view.selfSeat != null
  const self = isSeated ? view.seats[view.selfSeat!] : null
  const selfSittingOut = self?.status === 'SITTING_OUT'

  // ---------- view rotation (self always center-south unless overridden) ----------
  const [persp, setPersp] = useState<Perspective>(() => loadPersp(tableKey))
  useEffect(() => {
    try {
      localStorage.setItem(`nr-persp:${tableKey}`, String(persp))
    } catch {
      /* private mode — rotation just won't persist */
    }
  }, [persp, tableKey])

  const rotation = persp === 'me' ? (view.selfSeat ?? 0) : persp

  const occupiedSeats = useMemo(
    () => view.seats.filter((s) => s.status !== 'EMPTY').map((s) => s.seatIndex),
    [view.seats],
  )
  const perspCycle = useMemo(() => {
    const list = [...occupiedSeats].sort((a, b) => a - b)
    if (isSeated && view.selfSeat != null) {
      // "me" first, then the rest in seat order
      const rest = list.filter((s) => s !== view.selfSeat)
      return [view.selfSeat, ...rest]
    }
    return list
  }, [occupiedSeats, isSeated, view.selfSeat])

  const rotateView = useCallback(() => {
    const current = persp === 'me' ? (view.selfSeat ?? perspCycle[0] ?? 0) : persp
    const idx = perspCycle.indexOf(current)
    const next = perspCycle[(idx + 1) % Math.max(1, perspCycle.length)]
    setPersp(next === view.selfSeat ? 'me' : next)
  }, [persp, perspCycle, view.selfSeat])

  const canRotate = perspCycle.length >= 2
  const rotationLabel = persp === 'me' ? 'Me' : `Seat ${(typeof persp === 'number' ? persp : 0) + 1}`

  // ---------- two-round deal animation ----------
  // The deal nonce IS the hand number: every new hand changes each card's React
  // key, remounting them and replaying the staggered deal-in (pass 1 = first
  // hole card each, pass 2 = second). No timers, no effects — pure derivation.
  const dealNonce = view.handNumber

  // deal order starts left of the dealer button and follows seat order;
  // empty seats are skipped so the rhythm stays even
  const dealIndexOf = useMemo(() => {
    const occupied = occupiedSeats
    if (occupied.length === 0) return new Map<number, number>()
    const dealer = view.seats.find((s) => s.isDealer)?.seatIndex ?? occupied[0]!
    const maxN = view.maxSeats
    const ordered = [...occupied].sort((a, b) => {
      const da = (((a - dealer - 1) % maxN) + maxN) % maxN
      const db = (((b - dealer - 1) % maxN) + maxN) % maxN
      return da - db
    })
    const map = new Map<number, number>()
    ordered.forEach((seat, i) => map.set(seat, i))
    return map
  }, [occupiedSeats, view.seats, view.maxSeats])

  const doAction = (type: 'fold' | 'check' | 'call' | 'bet' | 'raise', amount?: number) => {
    if (Date.now() < actingUntilRef.current) return
    actingUntilRef.current = Date.now() + 500
    setBusy(true)
    window.setTimeout(() => setBusy(false), 500)
    poker.act(view.tableKey, type, amount)
  }

  const confirmSeat = (seatIndex: number, buyIn: number) => {
    poker.sitDown(view.tableKey, seatIndex, buyIn)
    setSeatDialogFor(null)
  }

  const toggleMute = useCallback(() => {
    setMuted(!muted)
  }, [muted])

  // rebuy availability — seated humans on cash tables, between hands
  const canRebuy =
    isSeated &&
    !tournament &&
    !!self &&
    self.stack < view.maxBuyIn &&
    poker.chips > 0 &&
    (view.phase === 'WAITING' || view.phase === 'SHOWDOWN' || (self.status !== 'IN_HAND' && self.status !== 'ALL_IN'))

  // tournament level countdown (from lobby snapshot; harmless when absent)
  const myTourney = tournament
    ? poker.tournaments.find((t) => view.tableKey.startsWith(`t:${t.id}:`))
    : null
  const levelRemainSec = myTourney?.levelEndsAt
    ? Math.max(0, Math.floor((myTourney.levelEndsAt - now) / 1000))
    : 0

  // pot chip stack tier for the center visual
  const potTier = view.pot >= view.bigBlind * 50 ? 3 : view.pot >= view.bigBlind * 10 ? 2 : view.pot > 0 ? 1 : 0

  return (
    <div className="mx-auto flex w-full max-w-7xl flex-1 flex-col gap-3 p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:p-4">
      {/* table header */}
      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="ghost"
          size="sm"
          className="text-white/70 hover:text-white"
          onClick={() => poker.setActiveTable(null)}
        >
          <ArrowLeft className="mr-1 h-4 w-4" /> Lobby
        </Button>
        <h1 className="text-sm font-bold text-white sm:text-base">{view.name}</h1>
        <span className="rounded bg-gradient-to-b from-amber-400/25 to-amber-600/20 px-2 py-0.5 text-[11px] font-bold tracking-wide text-amber-200 ring-1 ring-amber-300/40">
          {GAME_LABEL[gameType]}
        </span>
        <span className="rounded bg-white/10 px-2 py-0.5 text-[11px] font-semibold text-white/70">
          {formatChips(view.smallBlind)}/{formatChips(view.bigBlind)}
        </span>
        <span className="rounded bg-white/10 px-2 py-0.5 text-[11px] font-medium text-white/60">
          Hand #{view.handNumber || '—'} · {PHASE_LABEL[view.phase]}
        </span>
        <div className="ml-auto flex max-w-full flex-wrap items-center justify-end gap-1 sm:gap-2">
          {canRotate && (
            <Button
              variant="ghost"
              size="sm"
              className="text-white/70 hover:text-white"
              onClick={rotateView}
              title="Rotate your view around the table"
            >
              <RotateCw className="mr-1 h-3.5 w-3.5" /> {rotationLabel}
            </Button>
          )}
          {canRebuy && (
            <Button
              variant="ghost"
              size="sm"
              className="text-emerald-300/90 hover:bg-emerald-500/10 hover:text-emerald-200"
              onClick={() => setRebuyOpen(true)}
            >
              <PlusCircle className="mr-1 h-3.5 w-3.5" /> Rebuy
            </Button>
          )}
          <HandRankingsDialog gameType={gameType} />
          <Button
            variant="ghost"
            size="sm"
            className={fourColor ? 'text-sky-300 hover:text-sky-200' : 'text-white/70 hover:text-white'}
            onClick={toggleFourColor}
            title="Four-color deck — diamonds blue, clubs green"
            aria-pressed={fourColor}
            aria-label="Toggle four-color deck"
          >
            <Palette className="h-4 w-4" />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="text-white/70 hover:text-white"
            onClick={toggleMute}
            aria-label={muted ? 'Unmute sounds' : 'Mute sounds'}
          >
            {muted ? <VolumeX className="h-4 w-4" /> : <Volume2 className="h-4 w-4" />}
          </Button>
          {isSeated && !tournament && (
            <Button
              variant="ghost"
              size="sm"
              className="text-white/70 hover:text-white"
              onClick={() => poker.setSitOut(view.tableKey, !selfSittingOut)}
            >
              {selfSittingOut ? <Play className="mr-1 h-3.5 w-3.5" /> : <Pause className="mr-1 h-3.5 w-3.5" />}
              {selfSittingOut ? 'Sit in' : 'Sit out'}
            </Button>
          )}
          {isSeated && (
            <Button
              variant="ghost"
              size="sm"
              className="text-rose-300/80 hover:bg-rose-500/10 hover:text-rose-200"
              onClick={() => poker.standUp(view.tableKey)}
            >
              <LogOut className="mr-1 h-3.5 w-3.5" /> {tournament ? 'Forfeit' : 'Stand up'}
            </Button>
          )}
        </div>
      </div>

      <div className="grid flex-1 gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
        {/* felt */}
        <section className="flex min-w-0 flex-col gap-3">
          <div
            className={cn(
              'felt felt-2 felt-watermark felt-short relative w-full select-none overflow-hidden shadow-2xl shadow-black/60 aspect-[4/4.6] sm:aspect-[16/10.5]',
              'rail-2',
            )}
          >
            {/* tournament strip */}
            {tournament && (
              <div className="absolute left-1/2 top-2 z-20 flex -translate-x-1/2 items-center gap-2 rounded-full border border-amber-300/40 bg-black/55 px-3 py-1 text-[10px] font-semibold text-amber-200 shadow-lg backdrop-blur-sm sm:text-xs">
                <Trophy className="h-3.5 w-3.5" aria-hidden />
                {myTourney ? myTourney.name : 'Tournament'}
                {myTourney ? ` · ${myTourney.playersLeft} left` : ''}
                {levelRemainSec > 0 && (
                  <span className="text-white/60">
                    · next level {Math.floor(levelRemainSec / 60)}:{String(levelRemainSec % 60).padStart(2, '0')}
                  </span>
                )}
              </div>
            )}

            {/* center: pot + board */}
            <div className="absolute left-1/2 top-1/2 z-0 flex -translate-x-1/2 -translate-y-1/2 flex-col items-center gap-2">
              <div className="flex items-center gap-2 rounded-full border border-amber-300/40 bg-black/45 px-3 py-1 shadow-lg backdrop-blur-sm">
                {/* chip stack tiers */}
                <span className="relative inline-block h-3.5 w-4" aria-hidden>
                  {potTier >= 1 && <span className="chip chip-1" />}
                  {potTier >= 2 && <span className="chip chip-2" />}
                  {potTier >= 3 && <span className="chip chip-3" />}
                </span>
                <span className="text-xs font-bold tabular-nums text-amber-200 sm:text-sm">
                  {view.pot > 0 ? formatChips(view.pot) : 'Pot empty'}
                </span>
              </div>
              <div className="flex gap-1 sm:gap-1.5">
                {[0, 1, 2, 3, 4].map((i) => (
                  <PlayingCard
                    key={`${view.handNumber}-${i}`}
                    code={view.board[i] ?? null}
                    size="md"
                    animate={!!view.board[i]}
                    flip={!!view.board[i]}
                  />
                ))}
              </div>
              {view.phase === 'SHOWDOWN' && view.lastSummary && (
                <p className="banner-up rounded bg-black/40 px-2 py-0.5 text-[10px] font-semibold text-emerald-300">
                  {view.lastSummary.results.map((r) => `${r.name} +${formatChips(r.amount)}`).join(' · ')}
                </p>
              )}
            </div>

            {/* seats + bet chips */}
            {view.seats.map((p) => {
              const anchor = seatAnchor(p.seatIndex, view.maxSeats, rotation)
              const betPos = towardCenter(anchor.x, anchor.y, 0.42)
              return (
                <div key={p.seatIndex}>
                  {p.status !== 'EMPTY' && p.bet > 0 && (
                    <div
                      className="absolute z-10 -translate-x-1/2 -translate-y-1/2"
                      style={{ left: `${betPos.x}%`, top: `${betPos.y}%` }}
                    >
                      <BetChip amount={p.bet} />
                    </div>
                  )}
                  <div
                    className="absolute -translate-x-1/2 -translate-y-1/2"
                    style={{ left: `${anchor.x}%`, top: `${anchor.y}%` }}
                  >
                    <Seat
                      player={p}
                      isSelf={p.isSelf}
                      isActor={p.isActor}
                      timeFraction={timeFraction}
                      secondsLeft={secondsLeft}
                      cardsBelow={anchor.cardsBelow}
                      align={anchor.align}
                      compact={false}
                      canTakeSeat={!isSeated && !tournament && p.status === 'EMPTY'}
                      onTakeSeat={(idx) => setSeatDialogFor(idx)}
                      dealNonce={dealNonce}
                      dealIndex={dealIndexOf.get(p.seatIndex) ?? 0}
                      seatCount={Math.max(2, occupiedSeats.length)}
                    />
                  </div>
                </div>
              )
            })}

            {/* take-a-seat hint (cash games only) */}
            {!isSeated && !tournament && (
              <button
                type="button"
                onClick={() => {
                  const empty = view.seats.find((s) => s.status === 'EMPTY')
                  if (empty) setSeatDialogFor(empty.seatIndex)
                }}
                className="absolute bottom-3 left-1/2 z-10 -translate-x-1/2 rounded-full bg-gradient-to-b from-amber-400 to-amber-600 px-4 py-1.5 text-xs font-bold uppercase tracking-wide text-slate-950 shadow-lg ring-1 ring-amber-300/60 transition hover:brightness-110"
              >
                Take a seat
              </button>
            )}
            {!isSeated && tournament && (
              <div className="absolute bottom-3 left-1/2 z-10 -translate-x-1/2 rounded-full bg-black/55 px-4 py-1.5 text-xs font-semibold text-amber-200/90 ring-1 ring-amber-300/30">
                Spectating — your seat is assigned when you register
              </div>
            )}
          </div>

          {/* live hand evaluator for own cards */}
          {isSeated && (
            <HandStrength selfCards={view.selfCards} board={view.board} gameType={gameType} />
          )}

          {/* action bar or waiting hint — the bar is sticky so Fold/Check/Raise
              stay reachable on phones even while scrolled to chat/history */}
          {view.selfOptions && isSeated ? (
            <div className="sticky bottom-0 z-30 -mx-1 px-1 pb-[max(0.25rem,env(safe-area-inset-bottom))] pt-1">
              <ActionBar
                options={view.selfOptions}
                bigBlind={view.bigBlind}
                pot={view.pot}
                currentBet={view.currentBet}
                busy={busy}
                secondsLeft={secondsLeft}
                onAction={doAction}
              />
            </div>
          ) : isSeated ? (
            <div className="rounded-xl border border-white/10 bg-slate-950/60 px-4 py-3 text-center text-xs text-white/50">
              {selfSittingOut
                ? 'You are sitting out — press “Sit in” to join the next hand.'
                : view.phase === 'WAITING' || view.phase === 'SHOWDOWN'
                  ? 'Waiting for the next hand… cards will be dealt automatically.'
                  : 'Hand in progress — your turn will come around.'}
            </div>
          ) : (
            <div className="rounded-xl border border-amber-300/20 bg-amber-400/5 px-4 py-3 text-center text-xs text-amber-200/80">
              {tournament
                ? 'You are watching this tournament table.'
                : 'You are watching this table. Pick an open seat to play the next hand.'}
            </div>
          )}
        </section>

        {/* side panel — desktop */}
        <aside className="hidden min-h-[420px] lg:flex lg:flex-col">
          <SidePanel view={view} messages={poker.chats[view.tableKey] ?? []} onSend={(t) => poker.sendChat(view.tableKey, t)} />
        </aside>
      </div>

      {/* side panel — mobile */}
      <div className={cn('h-72 lg:hidden')}>
        <SidePanel view={view} messages={poker.chats[view.tableKey] ?? []} onSend={(t) => poker.sendChat(view.tableKey, t)} />
      </div>

      {view.seats[seatDialogFor ?? 0] && seatDialogFor != null && (
        <SeatDialog
          view={view}
          seatIndex={seatDialogFor}
          balance={poker.chips}
          open={seatDialogFor != null}
          onClose={() => setSeatDialogFor(null)}
          onConfirm={confirmSeat}
        />
      )}

      <RebuyDialog
        open={rebuyOpen}
        onClose={() => setRebuyOpen(false)}
        onConfirm={(amount) => {
          poker.rebuy(view.tableKey, amount)
          setRebuyOpen(false)
        }}
        stack={self?.stack ?? 0}
        maxBuyIn={view.maxBuyIn}
        bigBlind={view.bigBlind}
        balance={poker.chips}
      />
    </div>
  )
}
