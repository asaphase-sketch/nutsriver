'use client'

import { Info } from 'lucide-react'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog'
import { PlayingCard } from './playing-card'
import type { GameType } from '@/lib/poker/types'

const RANKINGS: { name: string; example: string[]; note: string }[] = [
  { name: 'Royal Flush', example: ['As', 'Ks', 'Qs', 'Js', 'Ts'], note: 'A-K-Q-J-10, same suit' },
  { name: 'Straight Flush', example: ['9h', '8h', '7h', '6h', '5h'], note: 'Five in a row, same suit' },
  { name: 'Four of a Kind', example: ['Qd', 'Qs', 'Qh', 'Qc', '2d'], note: 'Four equal ranks' },
  { name: 'Full House', example: ['Jh', 'Js', 'Jc', '8d', '8s'], note: 'Three of a kind + a pair' },
  { name: 'Flush', example: ['Kd', 'Td', '7d', '5d', '2d'], note: 'Five of the same suit' },
  { name: 'Straight', example: ['9c', '8d', '7h', '6s', '5c'], note: 'Five ranks in a row' },
  { name: 'Three of a Kind', example: ['7s', '7h', '7d', 'Kc', '3s'], note: 'Three equal ranks' },
  { name: 'Two Pair', example: ['As', 'Ah', '4d', '4c', '9s'], note: 'Two different pairs' },
  { name: 'One Pair', example: ['Tc', 'Th', 'Ad', '6s', '2c'], note: 'Two equal ranks' },
  { name: 'High Card', example: ['Ac', 'Jd', '8h', '6s', '3c'], note: 'No combination made' },
]

export function HandRankingsDialog({ gameType = 'holdem' }: { gameType?: GameType }) {
  const omaha = gameType !== 'holdem'
  return (
    <Dialog>
      <DialogTrigger asChild>
        <button
          type="button"
          aria-label="Hand rankings"
          className="flex items-center gap-1 rounded-md border border-white/10 bg-white/5 px-2.5 py-1.5 text-[11px] font-semibold text-white/70 transition hover:border-amber-300/50 hover:text-amber-200 sm:py-1"
        >
          <Info className="h-3.5 w-3.5 sm:hidden" aria-hidden />
          <span className="hidden sm:inline">Hand rankings</span>
        </button>
      </DialogTrigger>
      <DialogContent className="max-w-md bg-slate-950 text-white">
        <DialogHeader>
          <DialogTitle>Texas Hold&apos;em — Hand Rankings</DialogTitle>
          <DialogDescription className="text-white/50">
            Best five-card hand wins. Strongest combinations first.
            {omaha && ' Omaha reminder: your final hand must use exactly 2 of your hole cards and exactly 3 board cards.'}
          </DialogDescription>
        </DialogHeader>
        <div className="max-h-[60vh] space-y-2.5 overflow-y-auto pr-1">
          {RANKINGS.map((r, i) => (
            <div key={r.name} className="flex items-center gap-3 rounded-lg border border-white/10 bg-white/5 p-2">
              <span className="w-5 shrink-0 text-center text-xs font-bold text-amber-300">{i + 1}</span>
              <div className="flex shrink-0 gap-0.5">
                {r.example.map((c, j) => (
                  <PlayingCard key={j} code={c} size="xs" />
                ))}
              </div>
              <div className="min-w-0">
                <p className="truncate text-xs font-semibold">{r.name}</p>
                <p className="truncate text-[10px] text-white/45">{r.note}</p>
              </div>
            </div>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  )
}
