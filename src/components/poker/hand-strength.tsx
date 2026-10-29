'use client'

import { useMemo } from 'react'
import { ScanSearch } from 'lucide-react'
import { cn } from '@/lib/utils'
import { evaluate, evaluateOmaha } from '@/lib/poker-engine/handEval'
import { parseCard } from '@/lib/poker-engine/cards'
import type { GameType } from '@/lib/poker/types'

/**
 * Live "your current best hand" badge — evaluates ONLY the viewer's own cards
 * (never sent to other players). Hold'em works from preflop on; Omaha needs a
 * board because the exactly-2-hole-cards rule makes preflop meaningless.
 */
export function HandStrength({
  selfCards,
  board,
  gameType,
  className,
}: {
  selfCards: string[]
  board: string[]
  gameType: GameType
  className?: string
}) {
  const label = useMemo(() => {
    const hole = selfCards.filter(Boolean)
    if (hole.length < 2) return null

    if (gameType === 'holdem') {
      if (board.length === 0) {
        // preflop: pocket pair or high card label from the two ranks
        const ranks = hole.map((c) => c[0])
        if (ranks[0] === ranks[1]) {
          const r = ranks[0] === 'T' ? '10' : ranks[0]
          return `Pocket Pair · ${r}${r}`
        }
        const hi = ['A', 'K', 'Q', 'J', 'T'].find((r) => ranks.includes(r)) ?? ranks[0]
        return `High Card · ${hi === 'T' ? '10' : hi}`
      }
      try {
        return evaluate([...hole, ...board].map(parseCard)).desc
      } catch {
        return null
      }
    }

    // omaha 4/5 — needs a board (exactly-2 rule makes preflop labels useless)
    if (board.length < 3) return null
    try {
      return evaluateOmaha(hole.map(parseCard), board.map(parseCard)).desc
    } catch {
      return null
    }
  }, [selfCards, board, gameType])

  if (!label) return null

  return (
    <div
      className={cn(
        'mx-auto flex w-fit items-center gap-1.5 rounded-full border border-emerald-300/30 bg-emerald-950/70 px-3 py-1 shadow-lg backdrop-blur-sm',
        className,
      )}
      title="Your current best hand"
    >
      <ScanSearch className="h-3.5 w-3.5 text-emerald-300" aria-hidden />
      <span className="text-[11px] font-semibold text-emerald-200 sm:text-xs">{label}</span>
    </div>
  )
}
