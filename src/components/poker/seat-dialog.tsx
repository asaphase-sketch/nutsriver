'use client'

import { useMemo, useState } from 'react'
import { formatChips } from '@/lib/poker/cards'
import type { ClientTableView } from '@/lib/poker/types'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Slider } from '@/components/ui/slider'

interface SeatDialogProps {
  view: ClientTableView
  seatIndex: number
  balance: number
  open: boolean
  onClose: () => void
  onConfirm: (seatIndex: number, buyIn: number) => void
}

export function SeatDialog({ view, seatIndex, balance, open, onClose, onConfirm }: SeatDialogProps) {
  const maxAllowed = Math.min(view.maxBuyIn, Math.max(0, balance))
  const defaultBuyIn = Math.min(maxAllowed, Math.max(view.minBuyIn, view.bigBlind * 100))
  // null = untouched → derive from table defaults (the dialog remounts each time it opens)
  const [rawBuyIn, setRawBuyIn] = useState<number | null>(null)
  const buyIn = rawBuyIn == null ? defaultBuyIn : rawBuyIn
  const setBuyIn = (v: number) => setRawBuyIn(v)

  const tooPoor = balance < view.minBuyIn
  const quick = useMemo(() => {
    const mk = (bb: number) => Math.min(maxAllowed, Math.max(view.minBuyIn, view.bigBlind * bb))
    return [
      { label: 'Min', v: view.minBuyIn },
      { label: '50 BB', v: mk(50) },
      { label: '100 BB', v: mk(100) },
      { label: 'Max', v: maxAllowed },
    ]
  }, [maxAllowed, view.minBuyIn, view.bigBlind])

  const canConfirm = !tooPoor && buyIn >= view.minBuyIn && buyIn <= maxAllowed

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-sm bg-slate-950 text-white">
        <DialogHeader>
          <DialogTitle>
            Seat {seatIndex + 1} — {view.name}
          </DialogTitle>
          <DialogDescription className="text-white/50">
            Blinds {formatChips(view.smallBlind)}/{formatChips(view.bigBlind)} · buy-in {formatChips(view.minBuyIn)}–
            {formatChips(view.maxBuyIn)} · your balance {formatChips(balance)}
          </DialogDescription>
        </DialogHeader>

        {tooPoor ? (
          <p className="rounded-md border border-rose-500/40 bg-rose-500/10 p-3 text-sm text-rose-200">
            You need at least {formatChips(view.minBuyIn)} chips for this table. Claim free chips in the lobby.
          </p>
        ) : (
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-sm text-white/60">Buy-in amount</span>
              <span className="text-lg font-bold tabular-nums text-amber-300">{formatChips(buyIn)}</span>
            </div>
            <Slider
              aria-label="Buy-in amount"
              min={view.minBuyIn}
              max={maxAllowed}
              step={1}
              value={[buyIn]}
              onValueChange={([v]) => setBuyIn(v)}
              disabled={maxAllowed <= view.minBuyIn}
            />
            <div className="flex justify-between gap-1.5">
              {quick.map((q) => (
                <button
                  key={q.label}
                  type="button"
                  onClick={() => setBuyIn(q.v)}
                  className="flex-1 rounded-md border border-white/10 bg-white/5 px-2 py-1 text-[11px] font-semibold text-white/75 transition hover:border-amber-300/50 hover:text-amber-200"
                >
                  {q.label}
                </button>
              ))}
            </div>
          </div>
        )}

        <DialogFooter className="gap-2">
          <Button variant="ghost" onClick={onClose} className="text-white/70">
            Cancel
          </Button>
          <Button
            className="bg-emerald-600 hover:bg-emerald-500"
            disabled={!canConfirm}
            onClick={() => onConfirm(seatIndex, buyIn)}
          >
            Take this seat
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
