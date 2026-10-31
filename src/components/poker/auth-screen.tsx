'use client'

import { useState } from 'react'
import { Club, Loader2, ShieldCheck, Sparkles, Users } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import type { PokerClient } from '@/hooks/use-poker'

interface AuthScreenProps {
  poker: PokerClient
}

const USERNAME_RE = /^[A-Za-z0-9_]{3,16}$/

export function AuthScreen({ poker }: AuthScreenProps) {
  return (
    <div className="mx-auto flex w-full max-w-5xl flex-1 flex-col items-center justify-center gap-10 px-4 py-10 lg:flex-row lg:gap-16">
      {/* hero */}
      <section className="max-w-md text-center lg:text-left">
        <div className="mb-4 inline-flex items-center gap-2 rounded-full border border-amber-300/30 bg-amber-400/10 px-3 py-1 text-xs font-semibold text-amber-200">
          <Sparkles className="h-3.5 w-3.5" aria-hidden />
          Free to play · No real money · Ever
        </div>
        <h1 className="font-serif text-4xl font-black leading-tight text-white sm:text-5xl">
          nuts<span className="text-orange-400">river</span>
          <span className="mt-1 block bg-gradient-to-r from-amber-200 via-orange-300 to-orange-500 bg-clip-text text-2xl font-bold text-transparent sm:text-3xl">
            Play-Money Poker
          </span>
        </h1>
        <p className="mt-4 text-sm leading-relaxed text-white/60 sm:text-base">
          No-Limit Texas Hold&apos;em with cryptographically fair shuffling, server-authoritative dealing
          and live opponents at every table. Chips are for fun only and can never be bought, sold or
          cashed out.
        </p>
        <ul className="mt-6 space-y-2 text-left text-sm text-white/70">
          <li className="flex items-center gap-2">
            <ShieldCheck className="h-4 w-4 shrink-0 text-emerald-400" aria-hidden />
            Fair play — crypto-secure RNG, audited chip ledger
          </li>
          <li className="flex items-center gap-2">
            <Users className="h-4 w-4 shrink-0 text-emerald-400" aria-hidden />
            Live tables with house bots, chat and hand history
          </li>
          <li className="flex items-center gap-2">
            <Club className="h-4 w-4 shrink-0 text-emerald-400" aria-hidden />
            Four stakes rooms, 10,000 free chips on signup
          </li>
        </ul>
      </section>

      {/* auth card */}
      <Card className="w-full max-w-sm border-white/10 bg-slate-950/80 shadow-2xl shadow-black/50">
        <AuthCard poker={poker} />
      </Card>
    </div>
  )
}

function AuthCard({ poker }: AuthScreenProps) {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  const submit = async (mode: 'login' | 'register') => {
    setError(null)
    const u = username.trim()
    if (!USERNAME_RE.test(u)) {
      setError('Username must be 3-16 letters, numbers or underscores')
      return
    }
    if (mode === 'register') {
      if (password.length < 8) {
        setError('Password must be at least 8 characters')
        return
      }
      if (password !== confirm) {
        setError('Passwords do not match')
        return
      }
    }
    setLoading(true)
    try {
      const user = mode === 'login' ? await poker.login(u, password) : await poker.register(u, password)
      void user // hook state updates drive the view switch
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong')
    } finally {
      setLoading(false)
    }
  }

  const inputCls = 'h-11 bg-white/5 border-white/15 text-white placeholder:text-white/30'

  return (
    <Tabs defaultValue="login">
      <CardHeader className="pb-2">
        <CardTitle className="text-xl text-white">Welcome, player</CardTitle>
        <CardDescription className="text-white/50">
          Sign in or create a free account — 18+ recommended.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <TabsList className="mb-4 grid w-full grid-cols-2 bg-white/5">
          <TabsTrigger value="login" className="text-sm">Sign in</TabsTrigger>
          <TabsTrigger value="register" className="text-sm">Create account</TabsTrigger>
        </TabsList>

        <TabsContent value="login" className={cn('space-y-3')}>
          <form
            className="space-y-3"
            onSubmit={(e) => {
              e.preventDefault()
              submit('login')
            }}
          >
            <div className="space-y-1.5">
              <Label htmlFor="login-user" className="text-white/70">Username</Label>
              <Input
                id="login-user"
                autoComplete="username"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                className={inputCls}
                placeholder="e.g. AceHunter"
                required
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="login-pass" className="text-white/70">Password</Label>
              <Input
                id="login-pass"
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className={inputCls}
                placeholder="••••••••"
                required
              />
            </div>
            {error && <p className="text-xs font-medium text-rose-400">{error}</p>}
            <Button type="submit" className="h-11 w-full bg-emerald-600 font-bold hover:bg-emerald-500" disabled={loading}>
              {loading && <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden />}
              Sign in &amp; play
            </Button>
          </form>
        </TabsContent>

        <TabsContent value="register" className="space-y-3">
          <form
            className="space-y-3"
            onSubmit={(e) => {
              e.preventDefault()
              submit('register')
            }}
          >
            <div className="space-y-1.5">
              <Label htmlFor="reg-user" className="text-white/70">Username</Label>
              <Input
                id="reg-user"
                autoComplete="username"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                className={inputCls}
                placeholder="3-16 letters, numbers, _"
                required
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="reg-pass" className="text-white/70">Password</Label>
              <Input
                id="reg-pass"
                type="password"
                autoComplete="new-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className={inputCls}
                placeholder="At least 8 characters"
                required
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="reg-confirm" className="text-white/70">Confirm password</Label>
              <Input
                id="reg-confirm"
                type="password"
                autoComplete="new-password"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                className={inputCls}
                placeholder="Repeat your password"
                required
              />
            </div>
            {error && <p className="text-xs font-medium text-rose-400">{error}</p>}
            <Button type="submit" className="h-11 w-full bg-emerald-600 font-bold hover:bg-emerald-500" disabled={loading}>
              {loading && <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden />}
              Create account — get 10,000 chips
            </Button>
            <p className="text-center text-[10px] leading-relaxed text-white/35">
              Play-money only. Chips have no monetary value and cannot be purchased or redeemed.
            </p>
          </form>
        </TabsContent>
      </CardContent>
    </Tabs>
  )
}
