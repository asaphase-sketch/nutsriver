'use client'

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { Loader2, Shield, Spade } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Dashboard } from '@/components/admin/dashboard'

interface Me {
  id: string
  username: string
  chips: number
  role?: 'player' | 'admin'
}

export default function AdminPage() {
  const [me, setMe] = useState<Me | null>(null)
  const [authChecked, setAuthChecked] = useState(false)
  const [passphrase, setPassphrase] = useState('')
  const [claimBusy, setClaimBusy] = useState(false)
  const [claimError, setClaimError] = useState<string | null>(null)

  const refreshMe = useCallback(async () => {
    try {
      const res = await fetch('/api/auth/me', { cache: 'no-store' })
      const data = await res.json()
      setMe(data?.user ?? null)
      return (data?.user ?? null) as Me | null
    } catch {
      setMe(null)
      return null
    } finally {
      setAuthChecked(true)
    }
  }, [])

  useEffect(() => {
    refreshMe()
  }, [refreshMe])

  async function claim(e: React.FormEvent) {
    e.preventDefault()
    setClaimBusy(true)
    setClaimError(null)
    try {
      const res = await fetch('/api/admin/claim', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ passphrase }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        setClaimError(data?.error ?? 'Claim failed')
        return
      }
      setPassphrase('')
      refreshMe()
    } finally {
      setClaimBusy(false)
    }
  }

  if (!authChecked) {
    return (
      <Shell>
        <Loader2 className="h-8 w-8 animate-spin text-emerald-400" aria-label="Loading" />
      </Shell>
    )
  }

  if (!me) {
    return (
      <Shell>
        <h1 className="text-2xl font-bold text-white">Control panel</h1>
        <p className="mt-2 text-white/70">You need to be logged in as the administrator.</p>
        <Link href="/" className="mt-6 inline-flex items-center gap-2 rounded-lg bg-emerald-700 px-5 py-2.5 font-semibold text-white hover:bg-emerald-600">
          <Spade className="h-4 w-4" aria-hidden /> Back to the poker room
        </Link>
      </Shell>
    )
  }

  if (me.role !== 'admin') {
    return (
      <Shell>
        <div className="w-full max-w-md rounded-2xl border border-amber-500/20 bg-slate-900/80 p-8">
          <span className="flex h-12 w-12 items-center justify-center rounded-xl bg-amber-500/10">
            <Shield className="h-6 w-6 text-amber-300" aria-hidden />
          </span>
          <h1 className="mt-4 text-xl font-bold text-white">Claim admin access</h1>
          <p className="mt-1 text-sm text-white/60">
            Signed in as <span className="font-semibold text-white">{me.username}</span>. Enter the admin passphrase once — it
            activates for this account and is then burned.
          </p>
          <form onSubmit={claim} className="mt-5 space-y-3">
            <Input
              type="password"
              value={passphrase}
              onChange={(e) => setPassphrase(e.target.value)}
              placeholder="Admin passphrase"
              autoFocus
              className="border-white/10 bg-slate-950/60 text-white placeholder:text-white/30"
            />
            {claimError && <p className="text-sm text-rose-400">{claimError}</p>}
            <Button type="submit" disabled={claimBusy || !passphrase} className="w-full bg-amber-500 text-slate-950 hover:bg-amber-400">
              {claimBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Shield className="h-4 w-4" aria-hidden />}
              Claim admin
            </Button>
          </form>
        </div>
      </Shell>
    )
  }

  return <Dashboard username={me.username} />
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen items-start justify-center bg-[#0c1512] px-4 pt-24 text-white">
      <div className="w-full max-w-xl">{children}</div>
    </div>
  )
}
