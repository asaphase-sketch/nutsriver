'use client'

import { Bot, WifiOff } from 'lucide-react'
import { cn } from '@/lib/utils'
import { formatChips } from '@/lib/poker/cards'
import type { ClientPlayerView } from '@/lib/poker/types'
import { PlayingCard } from './playing-card'

interface SeatProps {
  player: ClientPlayerView
  isSelf: boolean
  isActor: boolean
  timeFraction: number
  secondsLeft: number
  cardsBelow: boolean
  align: 'left' | 'center' | 'right'
  compact: boolean
  canTakeSeat: boolean
  onTakeSeat?: (seatIndex: number) => void
  /** 0 = dealing disabled; nonce re-triggers the animation every new hand */
  dealNonce?: number
  dealIndex?: number
  seatCount?: number
  /** showdown: codes of the cards forming the winner's hand — these pulse */
  winCards?: Set<string> | null
}

const ACTION_LABEL: Record<string, string> = {
  fold: 'Fold',
  check: 'Check',
  call: 'Call',
  bet: 'Bet',
  raise: 'Raise',
}

/** ms between each dealt card around the table */
const DEAL_STEP_MS = 150

export function Seat({
  player,
  isSelf,
  isActor,
  timeFraction,
  secondsLeft,
  cardsBelow,
  align,
  compact,
  onTakeSeat,
  canTakeSeat,
  dealNonce = 0,
  dealIndex = 0,
  seatCount = 1,
  winCards = null,
}: SeatProps) {
  // ---- empty seat ----
  if (player.status === 'EMPTY') {
    return (
      <button
        type="button"
        onClick={() => canTakeSeat && onTakeSeat?.(player.seatIndex)}
        disabled={!canTakeSeat}
        aria-label={`Seat ${player.seatIndex + 1} — open`}
        className={cn(
          'group flex h-14 w-14 flex-col items-center justify-center rounded-full border-2 border-dashed sm:h-16 sm:w-16',
          canTakeSeat
            ? 'border-white/30 bg-black/20 text-white/50 transition hover:border-amber-300/70 hover:bg-black/40 hover:text-amber-200'
            : 'border-white/10 bg-black/10 text-white/25',
        )}
      >
        <span className="text-xl leading-none group-hover:scale-110 transition">+</span>
        <span className="mt-0.5 text-[9px] uppercase tracking-wider opacity-70">Seat</span>
      </button>
    )
  }

  const folded = player.status === 'FOLDED'
  const allIn = player.status === 'ALL_IN'
  const sittingOut = player.status === 'SITTING_OUT'
  const won = player.winAmount != null && player.winAmount > 0
  const cardSize = isSelf ? 'md' : 'sm'
  const urgent = isActor && secondsLeft > 0 && secondsLeft <= 6

  /** card i of this seat appears on its i-th pass around the table */
  const dealDelay = (pass: number) =>
    dealNonce > 0 && !folded ? (dealIndex + pass * seatCount) * DEAL_STEP_MS : undefined

  return (
    <div
      className={cn(
        'relative flex flex-col items-center gap-1',
        isSelf ? 'w-[8.6rem] sm:w-40' : 'w-[6.2rem] sm:w-28',
        folded && 'opacity-45',
        align === 'left' && 'items-start',
        align === 'right' && 'items-end',
      )}
    >
      {/* hole cards */}
      <div
        className={cn(
          'z-10 flex gap-0.5',
          !cardsBelow && '-mb-3',
          cardsBelow && '-mt-3 order-last',
        )}
      >
        {player.cards.length > 0 ? (
          player.cards.map((c, i) =>
            c ? (
              <PlayingCard
                key={`${dealNonce}-${i}`}
                code={c}
                size={cardSize}
                animate={dealNonce > 0}
                delayMs={dealDelay(i)}
                flip={!isSelf && player.cardsRevealed}
                highlight={won && !folded && !!winCards?.has(c)}
                className={cn(folded && 'grayscale')}
              />
            ) : (
              <PlayingCard
                key={`${dealNonce}-${i}`}
                faceDown
                size={cardSize}
                animate={dealNonce > 0}
                delayMs={dealDelay(i)}
                className={cn(folded && 'grayscale')}
              />
            ),
          )
        ) : null}
      </div>

      {/* name plate */}
      <div
        className={cn(
          'relative w-full overflow-hidden rounded-lg border bg-slate-900/90 px-2 py-1.5 shadow-lg shadow-black/50 backdrop-blur-sm',
          isActor ? 'border-amber-300 shadow-amber-500/20' : 'border-white/10',
          isSelf && 'ring-1 ring-emerald-400/60',
          won && 'border-emerald-300 bg-emerald-950/90',
          isActor && !urgent && 'actor-glow',
          urgent && 'timer-urgent',
        )}
      >
        {/* countdown bar */}
        {isActor && timeFraction < 1 && (
          <div className="absolute inset-x-0 top-0 h-[3px] bg-black/40">
            <div
              className={cn('h-full transition-[width] duration-100 ease-linear', timeFraction > 0.35 ? 'bg-emerald-400' : 'bg-rose-500')}
              style={{ width: `${timeFraction * 100}%` }}
            />
          </div>
        )}

        <div className="flex items-center gap-1.5">
          <span
            className={cn(
              'flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[10px] font-bold uppercase sm:h-7 sm:w-7 sm:text-xs',
              player.isBot ? 'bg-slate-700 text-slate-300' : 'bg-emerald-800 text-emerald-100',
              !player.connected && 'opacity-50',
            )}
          >
            {player.isBot ? <Bot className="h-3.5 w-3.5 sm:h-4 sm:w-4" aria-hidden /> : player.name.charAt(0)}
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1">
              <span className="truncate text-[10px] font-semibold text-white/90 sm:text-xs" title={player.name}>
                {player.name}
              </span>
              {!player.connected && <WifiOff className="h-2.5 w-2.5 shrink-0 text-rose-400" aria-label="disconnected" />}
            </div>
            <div className={cn('font-medium tabular-nums text-amber-200/90', isSelf ? 'text-[11px] sm:text-sm' : 'text-[9px] sm:text-[11px]')}>
              {formatChips(player.stack)}
            </div>
          </div>
          {/* numeric seconds badge */}
          {isActor && secondsLeft > 0 && (
            <span
              className={cn(
                'ml-0.5 shrink-0 rounded px-1 py-0.5 text-[9px] font-black tabular-nums',
                urgent ? 'bg-rose-600 text-white' : 'bg-amber-400/20 text-amber-200',
              )}
            >
              {secondsLeft}s
            </span>
          )}
        </div>

        {/* badges row */}
        <div className="mt-1 flex flex-wrap items-center gap-1">
          {player.isDealer && (
            <span
              className="dealer-puck flex h-4 w-4 items-center justify-center rounded-full text-[8px] font-black text-slate-900"
              title="Dealer"
            >
              D
            </span>
          )}
          {player.isSmallBlind && (
            <span className="rounded bg-white/15 px-1 text-[8px] font-bold text-white/80" title="Small blind">SB</span>
          )}
          {player.isBigBlind && (
            <span className="rounded bg-white/15 px-1 text-[8px] font-bold text-white/80" title="Big blind">BB</span>
          )}
          {allIn && (
            <span className="rounded bg-rose-600 px-1 text-[8px] font-black uppercase tracking-wide text-white">
              All-in
            </span>
          )}
          {sittingOut && (
            <span className="rounded bg-slate-700 px-1 text-[8px] font-semibold uppercase text-white/70">Sit out</span>
          )}
          {folded && (
            <span className="rounded bg-black/40 px-1 text-[8px] font-semibold uppercase text-white/50">Fold</span>
          )}
          {!compact && player.lastAction && (player.status === 'IN_HAND' || folded) && (
            <span className="text-[8px] font-medium uppercase tracking-wide text-white/45">
              {ACTION_LABEL[player.lastAction.type] ?? player.lastAction.type}
              {player.lastAction.amount != null && player.lastAction.type !== 'fold' && player.lastAction.type !== 'check'
                ? ` ${formatChips(player.lastAction.amount)}`
                : ''}
            </span>
          )}
        </div>

        {/* winning hand description */}
        {won && player.handDesc && (
          <div className="mt-1 truncate rounded bg-emerald-500/20 px-1 py-0.5 text-center text-[8px] font-semibold text-emerald-200 sm:text-[9px]">
            {player.handDesc}
          </div>
        )}
        {won && (
          <div className="mt-0.5 text-center text-[10px] font-black text-emerald-300 sm:text-xs">
            +{formatChips(player.winAmount!)}
          </div>
        )}
      </div>
    </div>
  )
}

/** Chip pill showing a player's current street bet, floating toward the pot. */
export function BetChip({ amount }: { amount: number }) {
  if (amount <= 0) return null
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full border border-amber-300/60 bg-slate-950/85 px-1.5 py-0.5',
        'text-[9px] font-bold tabular-nums text-amber-200 shadow-md shadow-black/50 sm:text-[10px]',
      )}
    >
      <span className="bet-chip-3d" aria-hidden />
      {formatChips(amount)}
    </span>
  )
}
