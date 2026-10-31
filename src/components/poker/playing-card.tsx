'use client'

import { useSyncExternalStore } from 'react'
import { cn } from '@/lib/utils'
import { isRedSuit, splitCard, suitSymbol } from '@/lib/poker/cards'
import { getFourColor, setFourColor as setFourColorPref, subscribeFourColor } from '@/lib/poker/four-color'

type CardSize = 'xs' | 'sm' | 'md' | 'lg'

const SIZE_CLASSES: Record<CardSize, string> = {
  xs: 'w-7 h-10 rounded text-[10px]',
  sm: 'w-9 h-[3.25rem] rounded-md text-xs',
  md: 'w-11 h-16 rounded-md text-sm',
  lg: 'w-14 h-20 rounded-lg text-base',
}

const CENTER_SUIT: Record<CardSize, string> = {
  xs: 'text-sm',
  sm: 'text-lg',
  md: 'text-2xl',
  lg: 'text-3xl',
}

const RANK_SIZE: Record<CardSize, string> = {
  xs: 'text-[10px]',
  sm: 'text-[13px]',
  md: 'text-[17px]',
  lg: 'text-xl',
}

interface PlayingCardProps {
  /** card code like "As" — omit/undefined for an empty slot */
  code?: string | null
  faceDown?: boolean
  size?: CardSize
  className?: string
  /** subtle deal-in animation */
  animate?: boolean
  /** 3D flip when revealed at showdown */
  flip?: boolean
  /** winner highlight */
  highlight?: boolean
  /** delay for the deal-in animation (ms) — sequences card-by-card dealing */
  delayMs?: number
}

/** Shared four-color deck preference — every card on the page follows the toggle. */
function useFourColor(): boolean {
  return useSyncExternalStore(subscribeFourColor, getFourColor, () => false)
}

export function toggleFourColor() {
  setFourColorPref(!getFourColor())
}

export function PlayingCard({ code, faceDown, size = 'md', className, animate, flip, highlight, delayMs }: PlayingCardProps) {
  const sizeCls = SIZE_CLASSES[size]
  const fourColor = useFourColor()
  const delayStyle = animate && delayMs != null && delayMs > 0 ? { animationDelay: `${delayMs}ms` } : undefined

  if (faceDown) {
    return (
      <div
        aria-hidden
        style={delayStyle}
        className={cn(
          'card-back select-none border border-rose-950/70 shadow-md shadow-black/40',
          sizeCls,
          animate && 'card-deal',
          flip && 'card-flip',
          className,
        )}
      >
        <div className="absolute inset-[3px] rounded-[inherit] border border-white/25" />
        <div className="absolute inset-[3px] rounded-[inherit] bg-[radial-gradient(circle_at_30%_20%,rgba(255,255,255,0.18),transparent_55%)]" />
        <span className="absolute inset-0 flex items-center justify-center text-white/40">
          <svg viewBox="0 0 24 24" className="w-1/3 h-1/3" fill="currentColor" aria-hidden>
            <path d="M12 2C9 7 4 9.5 4 14a4.6 4.6 0 0 0 7 4c-.4 1.6-1.2 2.8-2.5 4h7c-1.3-1.2-2.1-2.4-2.5-4a4.6 4.6 0 0 0 7-4c0-4.5-5-7-8-12Z" />
          </svg>
        </span>
      </div>
    )
  }

  const parsed = code ? splitCard(code) : null
  if (!parsed) {
    return (
      <div
        aria-hidden
        className={cn(
          'border border-dashed border-white/15 bg-black/20',
          SIZE_CLASSES[size],
          className,
        )}
      />
    )
  }

  const red = isRedSuit(parsed.suit)
  // classic two-color deck: black/red — four-color deck (PokerStars scheme):
  // spades black, hearts red, diamonds blue, clubs green
  const suitColor = fourColor
    ? parsed.suit === 'd'
      ? 'text-sky-600'
      : parsed.suit === 'c'
        ? 'text-emerald-600'
        : red
          ? 'text-rose-600'
          : 'text-slate-900'
    : red
      ? 'text-rose-600'
      : 'text-slate-900'
  return (
    <div
      style={delayStyle}
      className={cn(
        'relative flex select-none flex-col justify-between bg-gradient-to-b from-white to-slate-100 p-1 font-semibold leading-none text-slate-900 shadow-md shadow-black/40 ring-1 ring-black/10',
        sizeCls,
        animate && 'card-deal',
        flip && 'card-flip',
        highlight && 'card-win ring-2 ring-orange-300',
        className,
      )}
      aria-label={`${parsed.rank} of ${parsed.suit === 's' ? 'spades' : parsed.suit === 'h' ? 'hearts' : parsed.suit === 'd' ? 'diamonds' : 'clubs'}`}
    >
      <span className={cn('text-left tracking-tighter', RANK_SIZE[size], suitColor)}>{parsed.rank}</span>
      <span
        className={cn(
          'absolute inset-0 flex items-center justify-center drop-shadow-sm',
          CENTER_SUIT[size],
          suitColor,
        )}
      >
        {suitSymbol(parsed.suit)}
      </span>
      <span
        className={cn(
          'absolute inset-0 rounded-[inherit] bg-[linear-gradient(160deg,rgba(255,255,255,0.65),transparent_38%)]',
        )}
        aria-hidden
      />
      <span className={cn('rotate-180 self-end tracking-tighter', RANK_SIZE[size], suitColor)}>
        {parsed.rank}
      </span>
    </div>
  )
}
