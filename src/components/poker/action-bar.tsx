'use client'

import { useEffect, useMemo, useState } from 'react'
import { cn } from '@/lib/utils'
import { formatChips } from '@/lib/poker/cards'
import type { SelfOptions } from '@/lib/poker/types'
import { Button } from '@/components/ui/button'
import { Slider } from '@/components/ui/slider'

interface ActionBarProps {
  options: SelfOptions
  bigBlind: number
  pot: number
  currentBet: number
  busy?: boolean
  /** seconds remaining on the action clock (0 = no clock) */
  secondsLeft?: number
  onAction: (type: 'fold' | 'check' | 'call' | 'bet' | 'raise', amount?: number) => void
}

/** round to the nearest chip but keep within [min,max] */
function clampRound(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.round(v)))
}

export function ActionBar({ options, bigBlind, pot, currentBet, busy, secondsLeft = 0, onAction }: ActionBarProps) {
  const canAggress = options.canBet || options.canRaise
  const urgent = secondsLeft > 0 && secondsLeft <= 6
  // null = not touched yet → derive from the live options (no sync-effect needed)
  const [rawAmount, setRawAmount] = useState<number | null>(null)
  const amount = rawAmount == null
    ? options.minBetTo
    : clampRound(rawAmount, options.minBetTo, options.maxBetTo)
  const setAmount = (v: number) => setRawAmount(v)

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

  return (
    <div
      className={cn(
        'z-20 w-full rounded-xl border border-white/10 bg-slate-950/95 p-3 shadow-2xl shadow-black/60 backdrop-blur',
        'flex flex-col gap-3',
      )}
      role="toolbar"
      aria-label="Poker actions"
    >
      <div className="flex items-center justify-center gap-2 sm:gap-3">
        {secondsLeft > 0 && (
          <span
            className={cn(
              'flex h-9 w-9 shrink-0 items-center justify-center rounded-full border text-xs font-black tabular-nums sm:h-11 sm:w-11',
              urgent
                ? 'timer-urgent border-rose-400 bg-rose-950/80 text-rose-200'
                : 'border-amber-300/50 bg-amber-400/10 text-amber-200',
            )}
            aria-label={`${secondsLeft} seconds to act`}
          >
            {secondsLeft}
          </span>
        )}
        <Button
          variant="destructive"
          className="h-11 min-w-[5.5rem] flex-1 text-sm font-bold uppercase tracking-wide sm:flex-none sm:px-6"
          disabled={busy || !options.canFold}
          onClick={() => onAction('fold')}
        >
          Fold <span className="ml-1 hidden text-[10px] opacity-60 sm:inline">F</span>
        </Button>

        {options.canCheck ? (
          <Button
            className="h-11 min-w-[5.5rem] flex-1 bg-slate-700 text-sm font-bold uppercase tracking-wide hover:bg-slate-600 sm:flex-none sm:px-6"
            disabled={busy}
            onClick={() => onAction('check')}
          >
            Check <span className="ml-1 hidden text-[10px] opacity-60 sm:inline">C</span>
          </Button>
        ) : (
          <Button
            className="h-11 min-w-[6.5rem] flex-1 bg-emerald-600 text-sm font-bold uppercase tracking-wide hover:bg-emerald-500 sm:flex-none sm:px-6"
            disabled={busy || !options.canCall}
            onClick={() => onAction('call')}
          >
            Call {formatChips(options.callAmount)}
            <span className="ml-1 hidden text-[10px] opacity-60 sm:inline">C</span>
          </Button>
        )}

        {canAggress && (
          <Button
            className="h-11 min-w-[6.5rem] flex-1 bg-amber-500 text-sm font-bold uppercase tracking-wide text-slate-950 hover:bg-amber-400 sm:flex-none sm:px-6"
            disabled={busy}
            onClick={() => onAction(options.canBet ? 'bet' : 'raise', amount)}
          >
            {options.canBet ? 'Bet' : 'Raise to'} {formatChips(amount)}
            <span className="ml-1 hidden text-[10px] opacity-60 sm:inline">R</span>
          </Button>
        )}
      </div>

      {canAggress && (
        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-3">
            <Slider
              aria-label="Bet amount"
              min={options.minBetTo}
              max={options.maxBetTo}
              step={1}
              value={[amount]}
              onValueChange={([v]) => setAmount(clampRound(v, options.minBetTo, options.maxBetTo))}
              className="flex-1"
            />
            <span className="w-16 text-right text-sm font-bold tabular-nums text-amber-200">
              {formatChips(amount)}
            </span>
          </div>
          <div className="flex flex-wrap justify-center gap-1.5">
            {quickSizes.map((q) => (
              <button
                key={q.label}
                type="button"
                onClick={() => setAmount(q.to)}
                className={cn(
                  'min-h-8 rounded-md border border-white/10 bg-white/5 px-3 text-[11px] font-semibold text-white/80',
                  'transition hover:border-amber-300/50 hover:bg-amber-400/10 hover:text-amber-200',
                )}
              >
                {q.label}
              </button>
            ))}
          </div>
          <p className="text-center text-[10px] text-white/35">
            Blinds {formatChips(bigBlind / 2)}/{formatChips(bigBlind)} · shortcuts: F fold · C check/call · R raise
          </p>
        </div>
      )}
    </div>
  )
}
