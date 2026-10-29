'use client'

import { useMemo, useState } from 'react'
import { PlusCircle } from 'lucide-react'
import { formatChips } from '@/lib/poker/cards'
import { Button } from '@/components/ui/button'
import { Slider } from '@/components/ui/slider'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'

interface RebuyDialogProps {
  open: boolean
  onClose: () => void
  onConfirm: (amount: number) => void
  stack: number
  maxBuyIn: number
  bigBlind: number
  balance: number
}

/** Seated top-up dialog (cash tables only). */
export function RebuyDialog({ open, onClose, onConfirm, stack, maxBuyIn, bigBlind, balance }: RebuyDialogProps) {
  const maxAdd = Math.max(0, Math.min(maxBuyIn - stack, balance))
  // null = untouched → follow the live default; reset whenever the dialog closes
  const [rawAmount, setRawAmount] = useState<number | null>(null)
  const amount = Math.min(Math.max(1, rawAmount ?? Math.min(maxAdd, bigBlind * 100)), Math.max(1, maxAdd))
  const setAmount = (v: number) => setRawAmount(v)
  const close = () => {
    setRawAmount(null)
    onClose()
  }

  const presets = useMemo(() => {
    const bb = (n: number) => Math.min(maxAdd, bigBlind * n)
    return [
      { label: '40 BB', to: bb(40) },
      { label: '100 BB', to: bb(100) },
      { label: 'Half', to: Math.floor(maxAdd / 2) },
      { label: 'Max', to: maxAdd },
    ].filter((p) => p.to > 0)
  }, [maxAdd, bigBlind])

  if (maxAdd <= 0) return null

  return (
    <Dialog open={open} onOpenChange={(v) => !v && close()}>
      <DialogContent className="border-white/15 bg-slate-950/95 text-white sm:max-w-sm">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-base">
            <PlusCircle className="h-4 w-4 text-amber-300" aria-hidden /> Top up your stack
          </DialogTitle>
          <DialogDescription className="text-xs text-white/60">
            Add chips from your balance without leaving the seat. Applies between hands.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          <div className="flex items-center justify-between rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-xs">
            <span className="text-white/60">Your stack</span>
            <span className="font-bold tabular-nums text-amber-200">{formatChips(stack)}</span>
          </div>
          <div className="flex items-center gap-3">
            <Slider
              aria-label="Top-up amount"
              min={1}
              max={maxAdd}
              step={1}
              value={[Math.min(amount, maxAdd)]}
              onValueChange={([v]) => setAmount(v)}
              className="flex-1"
            />
            <span className="w-16 text-right text-sm font-bold tabular-nums text-amber-200">
              {formatChips(Math.min(amount, maxAdd))}
            </span>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {presets.map((p) => (
              <button
                key={p.label}
                type="button"
                onClick={() => setAmount(p.to)}
                className="rounded-md border border-white/10 bg-white/5 px-2.5 py-1 text-[11px] font-semibold text-white/80 transition hover:border-amber-300/50 hover:bg-amber-400/10 hover:text-amber-200"
              >
                {p.label}
              </button>
            ))}
          </div>
          <p className="text-[10px] text-white/40">
            Balance {formatChips(balance)} · table max {formatChips(maxBuyIn)}
          </p>
        </div>

        <DialogFooter className="gap-2">
          <Button variant="ghost" className="text-white/70 hover:text-white" onClick={close}>
            Cancel
          </Button>
          <Button
            className="bg-amber-500 font-bold text-slate-950 hover:bg-amber-400"
            disabled={amount < 1}
            onClick={() => {
              setRawAmount(null)
              onConfirm(Math.min(amount, maxAdd))
            }}
          >
            Top up {formatChips(Math.min(amount, maxAdd))}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
