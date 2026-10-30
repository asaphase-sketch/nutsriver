'use client'

import { useState } from 'react'
import { Coins, KeyRound, Loader2, LogOut, Shield, Spade, Wifi, WifiOff } from 'lucide-react'
import { formatChips } from '@/lib/poker/cards'
import { usePoker } from '@/hooks/use-poker'
import { useToast } from '@/hooks/use-toast'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { AuthScreen } from '@/components/poker/auth-screen'
import { Lobby } from '@/components/poker/lobby'
import { TableView } from '@/components/poker/table-view'

export default function Home() {
  const poker = usePoker()

  return (
    <div className="flex min-h-screen flex-col bg-[#0c1512] text-white">
      {/* ambient background */}
      <div className="pointer-events-none fixed inset-0 -z-10 bg-[radial-gradient(ellipse_at_top,rgba(16,90,60,0.35),transparent_55%),radial-gradient(ellipse_at_bottom,rgba(120,80,20,0.12),transparent_50%)]" />

      <Header poker={poker} />

      <main className="flex flex-1 flex-col">
        {!poker.authChecked ? (
          <Splash />
        ) : !poker.user ? (
          <AuthScreen poker={poker} />
        ) : poker.activeTable && poker.tableViews[poker.activeTable] ? (
          <TableView poker={poker} view={poker.tableViews[poker.activeTable]} />
        ) : (
          <Lobby poker={poker} />
        )}
      </main>

      <footer className="mt-auto border-t border-white/5 py-4">
        <p className="px-4 text-center text-[11px] leading-relaxed text-white/35">
          NutsRiver is a free entertainment product. Play-money chips have no monetary value, cannot be
          purchased and cannot be redeemed. No real-money gambling takes place here. 18+ recommended. Play responsibly.
        </p>
      </footer>
    </div>
  )
}

function Header({ poker }: { poker: ReturnType<typeof usePoker> }) {
  const [pwOpen, setPwOpen] = useState(false)
  if (!poker.user) return null
  const low = poker.chips < 1000
  return (
    <header className="sticky top-0 z-30 border-b border-white/5 bg-[#0c1512]/90 backdrop-blur">
      <div className="mx-auto flex h-14 w-full max-w-7xl items-center gap-3 px-4">
        <button
          type="button"
          onClick={() => poker.setActiveTable(null)}
          className="flex items-center gap-2"
          aria-label="NutsRiver home"
        >
          <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-emerald-700 shadow-inner">
            <Spade className="h-4 w-4 text-amber-300" aria-hidden />
          </span>
          <span className="font-serif text-lg font-black tracking-wide text-white">
            Nuts<span className="text-amber-300">River</span>
          </span>
        </button>

        <div className="ml-auto flex items-center gap-2 sm:gap-3">
          {/* connection indicator is only meaningful while viewing a table —
              in the lobby no table socket is expected to be open */}
          {poker.activeTable && (
            <span
              className="flex items-center gap-1 text-[10px] font-semibold"
              title={poker.connected ? 'Connected to the table' : 'Reconnecting…'}
            >
              {poker.connected ? (
                <Wifi className="h-3.5 w-3.5 text-emerald-400" aria-hidden />
              ) : (
                <WifiOff className="h-3.5 w-3.5 text-rose-400" aria-hidden />
              )}
            </span>
          )}

          <span
            className={`flex items-center gap-1.5 rounded-full border px-3 py-1 text-sm font-bold tabular-nums ${
              low ? 'border-amber-300/50 bg-amber-400/10 text-amber-200' : 'border-white/10 bg-white/5 text-white'
            }`}
            title="Play-money chip balance"
          >
            <Coins className="h-3.5 w-3.5 text-amber-300" aria-hidden />
            {formatChips(poker.chips)}
          </span>

          {low && (
            <Button size="sm" className="hidden bg-amber-500 font-bold text-slate-950 hover:bg-amber-400 sm:inline-flex" onClick={() => poker.claimFreeChips()}>
              Free chips
            </Button>
          )}

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                className="flex h-8 w-8 items-center justify-center rounded-full bg-emerald-800 text-xs font-bold uppercase text-emerald-100 ring-1 ring-emerald-500/40 transition hover:ring-amber-300/60"
                aria-label="Account menu"
              >
                {poker.user.username.charAt(0)}
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-48 bg-slate-950 text-white">
              <DropdownMenuLabel className="text-white/80">{poker.user.username}</DropdownMenuLabel>
              <DropdownMenuSeparator className="bg-white/10" />
              {poker.user.role === 'admin' && (
                <DropdownMenuItem
                  className="text-amber-300 focus:bg-amber-500/10 focus:text-amber-200"
                  onClick={() => {
                    window.location.href = '/admin'
                  }}
                >
                  <Shield className="mr-2 h-4 w-4" aria-hidden /> Admin panel
                </DropdownMenuItem>
              )}
              <DropdownMenuItem
                className="text-emerald-200 focus:bg-emerald-500/10 focus:text-emerald-100"
                onClick={() => setPwOpen(true)}
              >
                <KeyRound className="mr-2 h-4 w-4" aria-hidden /> Change password
              </DropdownMenuItem>
              <DropdownMenuItem
                className="text-rose-300 focus:bg-rose-500/10 focus:text-rose-200"
                onClick={() => poker.logout()}
              >
                <LogOut className="mr-2 h-4 w-4" aria-hidden /> Log out
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
      <ChangePasswordDialog open={pwOpen} onClose={() => setPwOpen(false)} />
    </header>
  )
}

/** Self-service password change — requires the current password; other
 *  devices are logged out when it succeeds. */
function ChangePasswordDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { toast } = useToast()
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [confirm, setConfirm] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const mismatch = confirm.length > 0 && next !== confirm
  const canSubmit = current.length > 0 && next.length >= 8 && next === confirm && !busy

  function reset() {
    setCurrent('')
    setNext('')
    setConfirm('')
    setError(null)
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (!canSubmit) return
    setBusy(true)
    setError(null)
    try {
      const res = await fetch('/api/auth/password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ currentPassword: current, newPassword: next }),
      })
      const data = (await res.json().catch(() => ({}))) as { error?: string }
      if (!res.ok) {
        setError(data?.error ?? 'Could not change the password')
        return
      }
      reset()
      onClose()
      toast({ title: 'Password changed', description: 'Other devices were signed out.' })
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) reset()
        onClose()
      }}
    >
      <DialogContent className="w-[calc(100vw-2rem)] max-w-sm rounded-2xl border-white/10 bg-[#0e1a16] p-5 text-white sm:p-6">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-lg">
            <KeyRound className="h-5 w-5 text-emerald-300" aria-hidden /> Change password
          </DialogTitle>
          <DialogDescription className="text-xs text-white/50">
            Confirm your current password first. Any other signed-in device is logged out.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="mt-1 space-y-3">
          <label className="block space-y-1.5">
            <span className="text-xs font-medium text-white/60">Current password</span>
            <Input
              type="password"
              value={current}
              onChange={(e) => setCurrent(e.target.value)}
              autoComplete="current-password"
              required
              className="border-white/10 bg-slate-950/60 text-sm text-white placeholder:text-white/25"
            />
          </label>
          <label className="block space-y-1.5">
            <span className="text-xs font-medium text-white/60">New password (8+ characters)</span>
            <Input
              type="password"
              value={next}
              onChange={(e) => setNext(e.target.value)}
              autoComplete="new-password"
              required
              minLength={8}
              className="border-white/10 bg-slate-950/60 text-sm text-white placeholder:text-white/25"
            />
          </label>
          <label className="block space-y-1.5">
            <span className="text-xs font-medium text-white/60">Repeat new password</span>
            <Input
              type="password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              autoComplete="new-password"
              required
              className={
                mismatch
                  ? 'border-rose-500/50 bg-slate-950/60 text-sm text-white'
                  : 'border-white/10 bg-slate-950/60 text-sm text-white'
              }
            />
            {mismatch && <span className="text-xs text-rose-400">Passwords don&apos;t match yet</span>}
          </label>
          {error && <p className="text-sm text-rose-400">{error}</p>}
          <div className="flex gap-2 pt-1">
            <Button
              type="button"
              variant="outline"
              className="flex-1 border-white/10 bg-transparent text-white/70 hover:bg-white/5 hover:text-white"
              onClick={() => {
                reset()
                onClose()
              }}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={!canSubmit}
              className="flex-1 bg-emerald-700 font-semibold text-white hover:bg-emerald-600"
            >
              {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden />}
              Save
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  )
}

function Splash() {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-4 py-32">
      <span className="flex h-14 w-14 animate-pulse items-center justify-center rounded-2xl bg-emerald-700">
        <Spade className="h-7 w-7 text-amber-300" aria-hidden />
      </span>
      <p className="text-sm text-white/50">Shuffling up…</p>
    </div>
  )
}
