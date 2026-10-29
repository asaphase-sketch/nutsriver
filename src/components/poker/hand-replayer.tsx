'use client'

/**
 * Hand replayer — PokerStars-style street-by-street replay of a stored hand.
 *
 * Driven entirely by the hand's structured public action trail
 * (buildReplayStates in src/lib/poker/replay.ts): every step is a pure
 * derived state, so scrubbing backwards/forwards is exact and the final
 * frame provably agrees with the stored pot/board. Hole cards come from the
 * server-masked participants payload — opponents' cards appear only when the
 * hand reached showdown (or for the viewer's own seat).
 *
 * Mobile-first: full-screen sheet, ≥44px touch targets, safe-area padding,
 * sticky control bar; the felt reuses the live table's self-centric seat
 * anchoring (hero bottom-center).
 */

import { useEffect, useMemo, useState } from 'react'
import { ChevronLeft, ChevronRight, Crown, Pause, Play, SkipForward } from 'lucide-react'
import { cn } from '@/lib/utils'
import { formatChips } from '@/lib/poker/cards'
import { seatAnchor } from '@/lib/poker/layout'
import { buildReplayStates, type ReplaySeat, type ReplayState } from '@/lib/poker/replay'
import type { HandTrailAction } from '@/lib/poker-engine/types'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Slider } from '@/components/ui/slider'
import { PlayingCard } from './playing-card'

export interface ReplayerHand {
  handNumber: number
  tableKey: string
  potTotal: number
  board: string
  showdown: boolean
  participants: { userId: string; name: string; committed: number; cards?: string[] }[]
  trail?: HandTrailAction[]
  myUserId?: string | null
}

const SPEEDS = [1, 2, 4] as const
const STEP_MS = 1400

function actLabel(a: NonNullable<ReplaySeat['lastAct']>): string | null {
  const amt = a.amt !== undefined ? formatChips(a.amt) : null
  switch (a.act) {
    case 'post':
      return amt ? `posts ${amt}` : null
    case 'fold':
      return 'Fold'
    case 'check':
      return 'Check'
    case 'call':
      return amt ? `Call ${amt}` : 'Call'
    case 'bet':
      return amt ? `Bet ${amt}` : 'Bet'
    case 'raise':
      return amt ? `Raise ${amt}` : 'Raise'
    case 'win':
      return amt ? `Wins ${amt}` : 'Wins'
    default:
      return null
  }
}

/** one seat plate on the mini felt */
function ReplaySeatPlate({
  seat,
  anchor,
  isHero,
  showCards,
  isWinner,
}: {
  seat: ReplaySeat
  anchor: { x: number; y: number; align: 'left' | 'center' | 'right'; cardsBelow: boolean }
  isHero: boolean
  showCards: boolean
  isWinner: boolean
}) {
  const label = seat.lastAct ? actLabel(seat.lastAct) : null
  return (
    <div
      className="absolute -translate-x-1/2 -translate-y-1/2"
      style={{ left: `${anchor.x}%`, top: `${anchor.y}%` }}
    >
      <div
        className={cn(
          'flex w-[clamp(84px,26vw,118px)] flex-col items-center gap-0.5 rounded-xl border px-1.5 py-1 backdrop-blur-sm transition-colors',
          seat.folded && 'border-white/10 bg-black/40 opacity-45',
          !seat.folded && seat.winner && 'border-amber-300/70 bg-amber-400/15 shadow-[0_0_18px_rgba(251,191,36,0.35)]',
          !seat.folded && !seat.winner && 'border-white/15 bg-black/45',
          isHero && !seat.folded && 'ring-1 ring-emerald-300/60',
        )}
      >
        {/* hole cards (masked server-side) */}
        {showCards && seat.hole.length > 0 && (
          <div className="flex gap-0.5">
            {seat.hole.map((c, i) => (
              <PlayingCard key={`${c}-${i}`} code={c} size="xs" animate flip />
            ))}
          </div>
        )}
        <div className="flex w-full items-center justify-center gap-1">
          {seat.winner && <Crown className="h-3 w-3 shrink-0 text-amber-300" />}
          <span className="truncate text-[11px] font-semibold leading-tight text-white/90">{seat.name}</span>
        </div>
        {/* live street bet */}
        {seat.streetBet > 0 && (
          <span className="rounded-full bg-emerald-500/25 px-1.5 text-[10px] font-bold leading-4 text-emerald-200">
            {formatChips(seat.streetBet)}
          </span>
        )}
        {/* action badge */}
        {label && (
          <span
            className={cn(
              'max-w-full truncate rounded px-1 text-[9px] font-bold uppercase leading-4 tracking-wide',
              seat.lastAct?.act === 'fold' && 'bg-white/10 text-white/50',
              seat.lastAct?.act === 'check' && 'bg-sky-400/20 text-sky-200',
              (seat.lastAct?.act === 'call' || seat.lastAct?.act === 'post') && 'bg-emerald-400/20 text-emerald-200',
              (seat.lastAct?.act === 'bet' || seat.lastAct?.act === 'raise') && 'bg-orange-400/25 text-orange-200',
              seat.lastAct?.act === 'win' && 'bg-amber-400/25 text-amber-200',
              seat.lastAct?.ai && 'bg-red-500/30 text-red-200',
            )}
          >
            {seat.lastAct?.ai ? 'All-in' : ''}
            {seat.lastAct?.ai && label ? ' · ' : ''}
            {label}
          </span>
        )}
        {isWinner && seat.won > 0 && (() => {
          // NET (won − committed, post-refund ground truth) — not the gross
          // pot: a winner who posted more than the pot (uncalled refund,
          // lost side pot) must never read as "+pot". Zero nets stay quiet.
          const net = seat.won - seat.committedTotal
          if (net === 0) return null
          return (
            <span
              className={cn(
                'text-[10px] font-bold leading-3',
                net > 0 ? 'text-amber-300' : 'text-red-300',
              )}
            >
              {net > 0 ? '+' : '−'}
              {formatChips(Math.abs(net))}
            </span>
          )
        })()}
      </div>
    </div>
  )
}

export function HandReplayer({ hand, onClose }: { hand: ReplayerHand; onClose: () => void }) {
  const states = useMemo<ReplayState[]>(
    () => buildReplayStates(hand.participants ?? [], hand.trail ?? []),
    [hand.participants, hand.trail],
  )
  const last = states.length - 1
  const [step, setStep] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [speedIdx, setSpeedIdx] = useState(0)

  const state = states[Math.min(step, last)]
  const finished = step >= last

  // auto-play engine — the interval no-ops at the end (no setState in
  // effects); the Play button restarts from step 0 when finished
  useEffect(() => {
    if (!playing) return
    const id = setInterval(() => {
      setStep((s) => (s >= last ? s : s + 1))
    }, Math.max(120, Math.round(STEP_MS / SPEEDS[speedIdx])))
    return () => clearInterval(id)
  }, [playing, speedIdx, last])

  const heroIdx = hand.myUserId
    ? (hand.participants ?? []).findIndex((p) => p.userId === hand.myUserId)
    : -1
  const rotation = heroIdx >= 0 ? heroIdx : 0
  const n = state.seats.length
  const boardShown = state.board
  const boardSlots = Math.max(5, boardShown.length)

  const streetLabel =
    state.street === 'SHOWDOWN' ? (finished ? 'Complete' : 'Showdown') : state.street

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="flex h-[100dvh] w-full max-w-lg flex-col gap-2 overflow-hidden bg-slate-950 p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] text-white sm:h-[90vh]">
        <DialogHeader className="shrink-0 space-y-0">
          <DialogTitle className="flex items-baseline gap-2 font-serif text-lg">
            Hand #{hand.handNumber}
            <span className="text-xs font-normal text-white/45">
              step {step}/{last}
            </span>
          </DialogTitle>
        </DialogHeader>

        {/* mini felt (2.5D: radial sheen, rim, inset shadows) */}
        <div className="relative min-h-0 flex-1">
          <div
            className="absolute inset-0 overflow-hidden rounded-[28px] border border-emerald-950/80 shadow-[inset_0_0_60px_rgba(0,0,0,0.55),0_10px_30px_rgba(0,0,0,0.5)]"
            style={{
              background:
                'radial-gradient(ellipse 90% 78% at 50% 42%, #0d7a52 0%, #0a5c40 45%, #07422e 78%, #052e21 100%)',
            }}
          >
            {/* table rim */}
            <div className="pointer-events-none absolute inset-2 rounded-[22px] border border-white/10 shadow-[inset_0_2px_14px_rgba(255,255,255,0.08)]" />

            {/* center: street label + board + pot */}
            <div className="absolute left-1/2 top-1/2 flex -translate-x-1/2 -translate-y-1/2 flex-col items-center gap-1.5">
              <span className="rounded-full bg-black/40 px-2 py-0.5 text-[10px] font-bold uppercase tracking-widest text-white/70">
                {streetLabel}
              </span>
              <div className="flex gap-1">
                {Array.from({ length: boardSlots }).map((_, i) => {
                  const code = boardShown[i]
                  return (
                    <PlayingCard
                      key={code ? `${code}-${i}` : `slot-${i}`}
                      code={code ?? null}
                      faceDown={!code}
                      size="xs"
                      animate={!!code}
                      delayMs={i * 90}
                      highlight={!!code && state.seats.some((s) => s.winner)}
                    />
                  )
                })}
              </div>
              <span
                className={cn(
                  'rounded-full px-2.5 py-0.5 text-xs font-bold shadow-[0_2px_8px_rgba(0,0,0,0.4)]',
                  state.pot > 0 ? 'bg-gradient-to-b from-emerald-400/30 to-emerald-700/40 text-emerald-100' : 'bg-black/30 text-white/40',
                )}
              >
                Pot {formatChips(state.pot)}
              </span>
            </div>

            {/* seats */}
            {state.seats.map((seat, i) => (
              <ReplaySeatPlate
                key={seat.userId || seat.name}
                seat={seat}
                anchor={seatAnchor(i, n, rotation)}
                isHero={i === rotation && heroIdx >= 0}
                showCards
                isWinner={finished}
              />
            ))}
          </div>
        </div>

        {/* controls */}
        <div className="shrink-0 space-y-1.5">
          <Slider
            value={[Math.min(step, last)]}
            min={0}
            max={Math.max(1, last)}
            step={1}
            onValueChange={(v) => setStep(v[0] ?? 0)}
            className="py-1"
          />
          <div className="flex items-center justify-between gap-1.5">
            <div className="flex gap-1.5">
              <Button
                variant="secondary"
                size="icon"
                aria-label="Previous step"
                disabled={step <= 0}
                onClick={() => {
                  setPlaying(false)
                  setStep((s) => Math.max(0, s - 1))
                }}
                className="h-11 w-11 rounded-full"
              >
                <ChevronLeft className="h-5 w-5" />
              </Button>
              <Button
                variant="secondary"
                size="icon"
                aria-label={playing ? 'Pause replay' : 'Play replay'}
                disabled={last === 0}
                onClick={() => {
                  if (finished) setStep(0)
                  setPlaying((p) => !p)
                }}
                className="h-11 w-11 rounded-full bg-emerald-500/90 text-white hover:bg-emerald-500"
              >
                {playing && !finished ? <Pause className="h-5 w-5" /> : <Play className="h-5 w-5" />}
              </Button>
              <Button
                variant="secondary"
                size="icon"
                aria-label="Next step"
                disabled={finished}
                onClick={() => {
                  setPlaying(false)
                  setStep((s) => Math.min(last, s + 1))
                }}
                className="h-11 w-11 rounded-full"
              >
                <ChevronRight className="h-5 w-5" />
              </Button>
              <Button
                variant="secondary"
                size="icon"
                aria-label="Jump to result"
                disabled={finished}
                onClick={() => {
                  setPlaying(false)
                  setStep(last)
                }}
                className="h-11 w-11 rounded-full"
              >
                <SkipForward className="h-5 w-5" />
              </Button>
            </div>
            <Button
              variant="secondary"
              size="sm"
              aria-label="Change replay speed"
              onClick={() => setSpeedIdx((i) => (i + 1) % SPEEDS.length)}
              className="h-11 rounded-full px-4 text-sm font-bold"
            >
              {SPEEDS[speedIdx]}×
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
