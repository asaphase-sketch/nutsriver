'use client'

import { useEffect, useMemo, useState } from 'react'
import { Coins, Plus } from 'lucide-react'
import { cn } from '@/lib/utils'
import { formatChips } from '@/lib/poker/cards'
import type { SelfOptions } from '@/lib/poker/types'
import { Slider } from '@/components/ui/slider'

interface ActionBarProps {
  options: SelfOptions
  bigBlind: number
  pot: number
  currentBet: number
  busy?: boolean
  /** seconds remaining on the action clock (0 = no clock) */
  secondsLeft?: number
  /** real lobby balance — shown as the sample's BALANCE pill */
  balance?: number
  /** + button next to the balance pill (free top-up when low) */
  onTopUp?: () => void
  onAction: (type: 'fold' | 'check' | 'call' | 'bet' | 'raise', amount?: number) => void
}

/** round to the nearest chip but keep within [min,max] */
function clampRound(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.round(v)))
}

export function ActionBar({ options, bigBlind, pot, currentBet, busy, secondsLeft = 0, balance, onTopUp, onAction }: ActionBarProps) {
  const canAggress = options.canBet || options.canRaise
  const urgent = secondsLeft > 0 && secondsLeft <= 6
  // null = not touched yet → derive from the live options (no sync-effect needed)
  const [rawAmount, setRawAmount] = useState<number | null>(null)
  const amount = rawAmount == null
    ? options.minBetTo
    : clampRound(rawAmount, options.minBetTo, options.maxBetTo)
  const setAmount = (v: number) => setRawAmount(v)

  const step = useMemo(() => {
    const bb = Math.max(bigBlind, 1)
    if (options.maxBetTo <= 20 * bb) return bb
    if (options.maxBetTo <= 100 * bb) return 5 * bb
    return 25 * bb
  }, [bigBlind, options.maxBetTo])

  const quickSizes = useMemo(() => {
    if (!canAggress) return []
    const potAfterCall = pot + (options.canCall ? options.callAmount : 0)
    const target = (frac: number) =>
      clampRound(currentBet + frac * potAfterCall, options.minBetTo, options.maxBetTo)
    return [
      { label: 'Min', to: options.minBetTo },
      { label: '⅓ pot', to: target(1 / 3) },
      { label: '½ pot', to: target(1 / 2) },
      { label: 'Pot', to: target(1) },
      { label: 'All-in', to: options.maxBetTo },
    ]
  }, [canAggress, options, pot, currentBet])

  // keyboard shortcuts: F fold, C check/call, R confirm bet/raise
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return
      const k = e.key.toLowerCase()
      if (k === 'f' && options.canFold) onAction('fold')
      else if (k === 'c') {
        if (options.canCheck) onAction('check')
        else if (options.canCall) onAction('call')
      } else if (k === 'r' && canAggress) {
        onAction(options.canBet ? 'bet' : 'raise', amount)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [options, canAggress, amount, onAction])

  const raise = () => onAction(options.canBet ? 'bet' : 'raise', amount)

  return (
    <div
      className={cn(
        'neon-panel z-20 w-full border-orange-300/25 p-2.5 sm:p-3',
        'flex flex-col gap-2.5',
      )}
      role="toolbar"
      aria-label="Poker actions"
    >
      {/* primary row — fold · check/call · raise */}
      <div className="flex items-stretch justify-center gap-2 sm:gap-3">
        {secondsLeft > 0 && (
          <span
            className={cn(
              'flex h-11 w-11 shrink-0 items-center justify-center self-center rounded-full border text-sm font-black tabular-nums',
              urgent
                ? 'timer-urgent border-rose-400 bg-rose-950/80 text-rose-200'
                : 'border-orange-300/50 bg-orange-400/10 text-orange-200',
            )}
            aria-label={`${secondsLeft} seconds to act`}
          >
            {secondsLeft}
          </span>
        )}
        <button
          type="button"
          disabled={busy || !options.canFold}
          onClick={() => onAction('fold')}
          className="h-12 min-w-[7rem] flex-1 rounded-xl border-2 border-rose-500/70 bg-rose-950/40 text-sm font-black uppercase tracking-widest text-rose-200 shadow-lg shadow-black/40 transition hover:bg-rose-900/50 disabled:cursor-not-allowed disabled:opacity-40 sm:flex-none sm:px-8"
        >
          Fold
        </button>

        {options.canCheck ? (
          <button
            type="button"
            disabled={busy}
            onClick={() => onAction('check')}
            className="h-12 min-w-[7rem] flex-1 rounded-xl border border-white/15 bg-white/10 text-sm font-black uppercase tracking-widest text-white shadow-lg shadow-black/40 transition hover:bg-white/15 disabled:cursor-not-allowed disabled:opacity-40 sm:flex-none sm:px-8"
          >
            Check
          </button>
        ) : (
          <button
            type="button"
            disabled={busy || !options.canCall}
            onClick={() => onAction('call')}
            className="h-12 min-w-[7.5rem] flex-1 rounded-xl border border-sky-400/40 bg-sky-950/50 text-sm font-black uppercase tracking-widest text-sky-200 shadow-lg shadow-black/40 transition hover:bg-sky-900/50 disabled:cursor-not-allowed disabled:opacity-40 sm:flex-none sm:px-6"
          >
            Call {formatChips(options.callAmount)}
          </button>
        )}

        {canAggress && (
          <button
            type="button"
            disabled={busy}
            onClick={raise}
            className="neon-cta h-12 min-w-[8.5rem] flex-1 rounded-xl text-sm font-black uppercase tracking-widest text-slate-950 transition disabled:cursor-not-allowed disabled:opacity-40 sm:flex-none sm:px-8"
          >
            <span className="block leading-tight">{options.canBet ? 'Bet' : 'Raise to'}</span>
            <span className="block text-base leading-tight">{formatChips(amount)}</span>
          </button>
        )}
      </div>

      {/* sizing row — stepper · slider · quick sizes */}
      {canAggress && (
        <div className="flex flex-col gap-2">
          <div className="mx-auto flex w-full max-w-md items-center gap-2">
            <button
              type="button"
              aria-label="Decrease bet"
              disabled={busy}
              onClick={() => setAmount(clampRound(amount - step, options.minBetTo, options.maxBetTo))}
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-white/10 bg-white/5 text-lg font-black text-white/80 transition hover:border-orange-300/40 hover:text-white disabled:opacity-40"
            >
              −
            </button>
            <div className="relative flex h-9 flex-1 items-center justify-center rounded-lg border border-orange-300/25 bg-black/40">
              <span className="text-sm font-black tabular-nums text-orange-100">{formatChips(amount)}</span>
            </div>
            <button
              type="button"
              aria-label="Increase bet"
              disabled={busy}
              onClick={() => setAmount(clampRound(amount + step, options.minBetTo, options.maxBetTo))}
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-white/10 bg-white/5 text-lg font-black text-white/80 transition hover:border-orange-300/40 hover:text-white disabled:opacity-40"
            >
              +
            </button>
          </div>
          <Slider
            aria-label="Bet amount"
            min={options.minBetTo}
            max={options.maxBetTo}
            step={1}
            value={[amount]}
            onValueChange={([v]) => setAmount(clampRound(v, options.minBetTo, options.maxBetTo))}
            className="mx-auto w-full max-w-md"
          />
          <div className="flex flex-wrap justify-center gap-1.5">
            {quickSizes.map((q) => (
              <button
                key={q.label}
                type="button"
                onClick={() => setAmount(q.to)}
                className={cn(
                  'min-h-8 rounded-lg border border-white/10 bg-white/5 px-3 text-[11px] font-bold text-white/75',
                  'transition hover:border-orange-300/50 hover:bg-orange-400/10 hover:text-orange-200',
                )}
              >
                {q.label}
              </button>
            ))}
          </div>
          <p className="text-center text-[10px] text-white/30">
            Blinds {formatChips(bigBlind / 2)}/{formatChips(bigBlind)} · shortcuts: F fold · C check/call · R raise
          </p>
        </div>
      )}

      {/* balance pill — sample-style, real lobby balance + free top-up */}
      {balance != null && (
        <div className="flex items-center justify-between">
          <span className="flex items-center gap-2 rounded-xl border border-orange-300/25 bg-black/40 px-3 py-1.5">
            <span className="text-[9px] font-black uppercase tracking-[0.14em] text-white/40">Balance</span>
            <span className="flex items-center gap-1 text-sm font-black tabular-nums text-orange-100">
              <Coins className="h-3.5 w-3.5 text-orange-300" aria-hidden />
              {formatChips(balance)}
            </span>
            {onTopUp && (
              <button
                type="button"
                onClick={onTopUp}
                aria-label="Claim free chips"
                title="Claim free chips (available below 1,000)"
                className="flex h-6 w-6 items-center justify-center rounded-md bg-gradient-to-b from-orange-400 to-orange-600 text-slate-950 transition hover:brightness-110"
              >
                <Plus className="h-3.5 w-3.5" />
              </button>
            )}
          </span>
        </div>
      )}
    </div>
  )
}
