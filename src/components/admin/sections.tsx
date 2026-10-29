'use client'

import { useCallback, useEffect, useState } from 'react'
import { Ban, Bot, Minus, Plus, ShieldCheck, Search, Save } from 'lucide-react'
import { cn } from '@/lib/utils'
import { formatChips } from '@/lib/poker/cards'
import { Card, fetchJson, tableDisplayName } from './dashboard'
import type { AdminUser, RobotsData, TxRow } from './types'

const TABLE_KEYS = ['beginners', 'greenroom', 'riverkings', 'highrollers'] as const

function Notice({ text }: { text: string | null }) {
  if (!text) return null
  return (
    <p className="rounded-lg border border-emerald-500/20 bg-emerald-500/10 px-4 py-2 text-sm text-emerald-200" role="status">
      {text}
    </p>
  )
}

// ---------------- Players ----------------

export function PlayersSection() {
  const [users, setUsers] = useState<AdminUser[]>([])
  const [loaded, setLoaded] = useState(false)
  const [query, setQuery] = useState('')
  const [amounts, setAmounts] = useState<Record<string, string>>({})
  const [notice, setNotice] = useState<string | null>(null)
  const [reloadKey, setReloadKey] = useState(0)
  const reload = useCallback(() => setReloadKey((k) => k + 1), [])

  useEffect(() => {
    let cancelled = false
    fetchJson<{ users: AdminUser[] }>('/api/admin/users').then((data) => {
      if (cancelled) return
      if (data) setUsers(data.users ?? [])
      setLoaded(true)
    })
    return () => {
      cancelled = true
    }
  }, [reloadKey])

  const adjustChips = async (u: AdminUser, direction: 1 | -1) => {
    const parsed = Number.parseInt(amounts[u.id] ?? '', 10)
    if (!Number.isInteger(parsed) || parsed === 0) {
      setNotice('Enter a non-zero whole number first')
      return
    }
    const res = await fetch('/api/admin/chips', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: u.id, delta: direction > 0 ? parsed : -parsed, reason: 'admin panel' }),
    })
    const data = (await res.json().catch(() => ({}))) as { chips?: number; error?: string }
    setNotice(res.ok ? `${u.username}: balance is now ${formatChips(data.chips ?? 0)}` : (data.error ?? 'Adjustment failed'))
    if (res.ok) setAmounts((prev) => ({ ...prev, [u.id]: '' }))
    reload()
  }

  const forceStandUp = async (u: AdminUser) => {
    const res = await fetch('/api/admin/standup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: u.id }),
    })
    const data = (await res.json().catch(() => ({}))) as { ok?: boolean; stoodUp?: string[] }
    setNotice(res.ok && data.ok ? `${u.username} removed from ${data.stoodUp?.join(', ')}` : `${u.username} is not seated`)
    reload()
  }

  const setBan = async (u: AdminUser, banned: boolean) => {
    const res = await fetch('/api/admin/ban', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: u.id, banned }),
    })
    const data = (await res.json().catch(() => ({}))) as { error?: string }
    setNotice(res.ok ? `${u.username} is now ${banned ? 'BANNED — logged out and blocked from tables' : 'unbanned'}` : (data.error ?? 'Failed'))
    reload()
  }

  const q = query.trim().toLowerCase()
  const filtered = q ? users.filter((u) => u.username.toLowerCase().includes(q)) : users

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-white/30" aria-hidden />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search players…"
            className="h-10 w-64 rounded-lg border border-white/10 bg-slate-950/70 pl-9 pr-3 text-sm text-white placeholder:text-white/30 focus:border-emerald-400/50 focus:outline-none"
            aria-label="Search players"
          />
        </div>
        <span className="text-sm text-white/40">
          {filtered.length} of {users.length} players
        </span>
      </div>
      <Notice text={notice} />

      <div className="overflow-x-auto rounded-xl border border-white/10">
        <table className="w-full min-w-[900px] text-sm">
          <thead>
            <tr className="border-b border-white/10 bg-slate-900/80 text-left text-white/50">
              <th className="px-4 py-3 font-medium">Player</th>
              <th className="px-4 py-3 font-medium">Balance</th>
              <th className="px-4 py-3 font-medium">Hands</th>
              <th className="px-4 py-3 font-medium">Biggest pot</th>
              <th className="px-4 py-3 font-medium">Joined</th>
              <th className="px-4 py-3 font-medium">Adjust chips</th>
              <th className="px-4 py-3 font-medium">Controls</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((u) => (
              <tr key={u.id} className={cn('border-b border-white/5 last:border-0', u.banned && 'bg-rose-500/5')}>
                <td className="px-4 py-3">
                  <span className="font-semibold text-white">{u.username}</span>
                  {u.role === 'admin' && (
                    <span className="ml-2 rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-bold uppercase text-amber-300">admin</span>
                  )}
                  {u.banned && (
                    <span className="ml-2 rounded bg-rose-500/15 px-1.5 py-0.5 text-[10px] font-bold uppercase text-rose-300">banned</span>
                  )}
                </td>
                <td className="px-4 py-3 font-semibold tabular-nums text-emerald-300">{formatChips(u.chips)}</td>
                <td className="px-4 py-3 tabular-nums text-white/70">
                  {formatChips(u.handsPlayed)} <span className="text-white/35">/ {formatChips(u.handsWon)} won</span>
                </td>
                <td className="px-4 py-3 tabular-nums text-white/70">{formatChips(u.biggestPotWon)}</td>
                <td className="px-4 py-3 text-white/45">{new Date(u.createdAt).toISOString().slice(0, 10)}</td>
                <td className="px-4 py-3">
                  <div className="flex items-center gap-2">
                    <input
                      value={amounts[u.id] ?? ''}
                      onChange={(e) => setAmounts((prev) => ({ ...prev, [u.id]: e.target.value }))}
                      placeholder="±amount"
                      inputMode="numeric"
                      className="h-8 w-24 rounded border border-white/10 bg-slate-950/60 px-2 text-white placeholder:text-white/30 focus:outline-none"
                      aria-label={`Chip amount for ${u.username}`}
                    />
                    <button onClick={() => adjustChips(u, 1)} className="rounded bg-emerald-600/20 px-2 py-1 text-xs font-semibold text-emerald-300 hover:bg-emerald-600/30">
                      + Give
                    </button>
                    <button onClick={() => adjustChips(u, -1)} className="rounded bg-rose-600/20 px-2 py-1 text-xs font-semibold text-rose-300 hover:bg-rose-600/30">
                      − Take
                    </button>
                  </div>
                </td>
                <td className="px-4 py-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      onClick={() => forceStandUp(u)}
                      className="rounded bg-slate-700/40 px-2 py-1 text-xs font-semibold text-white/70 hover:bg-slate-700/60 hover:text-white"
                    >
                      Stand up
                    </button>
                    {u.role !== 'admin' &&
                      (u.banned ? (
                        <button
                          onClick={() => setBan(u, false)}
                          className="flex items-center gap-1 rounded bg-emerald-600/20 px-2 py-1 text-xs font-semibold text-emerald-300 hover:bg-emerald-600/30"
                        >
                          <ShieldCheck className="h-3 w-3" aria-hidden /> Unban
                        </button>
                      ) : (
                        <button
                          onClick={() => setBan(u, true)}
                          className="flex items-center gap-1 rounded bg-rose-600/20 px-2 py-1 text-xs font-semibold text-rose-300 hover:bg-rose-600/30"
                        >
                          <Ban className="h-3 w-3" aria-hidden /> Ban
                        </button>
                      ))}
                  </div>
                </td>
              </tr>
            ))}
            {filtered.length === 0 && (
              <tr>
                <td colSpan={7} className="px-4 py-10 text-center text-white/40">
                  {loaded ? (q ? `No players match “${query}”` : 'No players yet') : 'Loading…'}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}

// ---------------- Robots ----------------

export function RobotsSection() {
  const [data, setData] = useState<RobotsData | null>(null)
  const [enabled, setEnabled] = useState(true)
  const [counts, setCounts] = useState<Record<string, number>>({})
  const [seated, setSeated] = useState<Record<string, number>>({})
  const [saving, setSaving] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [reloadKey, setReloadKey] = useState(0)
  const reload = useCallback(() => setReloadKey((k) => k + 1), [])

  useEffect(() => {
    let cancelled = false
    fetchJson<RobotsData>('/api/admin/robots').then((d) => {
      if (cancelled) return
      if (d) {
        setData(d)
        setEnabled(d.policy.enabled)
        setCounts({ ...d.policy.tableCounts })
        const s: Record<string, number> = {}
        for (const t of d.tables) s[t.tableKey] = t.botsSeated
        setSeated(s)
      }
    })
    return () => {
      cancelled = true
    }
  }, [reloadKey])

  const step = (key: string, delta: number) => {
    setCounts((prev) => {
      const cur = prev[key] ?? -1 // -1 = table default
      const base = cur === -1 ? DEFAULTS[key]! : cur
      const next = Math.max(0, Math.min(base + delta, 9))
      return { ...prev, [key]: next }
    })
  }

  const save = async () => {
    setSaving(true)
    setNotice(null)
    try {
      const res = await fetch('/api/admin/robots', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled, tableCounts: counts }),
      })
      const d = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string; applied?: string[] }
      if (res.ok && d.ok) {
        setNotice(`Saved — applied live on ${d.applied?.length ?? 0} table(s). Sleeping tables pick it up when they wake.`)
        reload()
      } else {
        setNotice(d.error ?? 'Save failed')
      }
    } finally {
      setSaving(false)
    }
  }

  const effective = (key: string): number => {
    const v = counts[key]
    return v === undefined ? DEFAULTS[key]! : v
  }

  return (
    <div className="space-y-4">
      <Card className="p-5">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <h2 className="flex items-center gap-2 font-bold text-white">
              <Bot className="h-5 w-5 text-amber-300" aria-hidden /> House robots
            </h2>
            <p className="mt-1 max-w-xl text-sm text-white/50">
              Robots keep tables lively when real players are short-handed. They act only while at least one
              human is seated, they never play alone, and they reload their own play-money stacks. Nothing runs
              unless <span className="font-semibold text-white/80">you</span> allow it here.
            </p>
          </div>
          <label className="flex cursor-pointer items-center gap-3">
            <span className="text-sm font-semibold text-white/70">{enabled ? 'Enabled' : 'Disabled'}</span>
            <button
              type="button"
              role="switch"
              aria-checked={enabled}
              onClick={() => setEnabled(!enabled)}
              className={cn(
                'relative h-7 w-12 rounded-full transition',
                enabled ? 'bg-emerald-500' : 'bg-slate-600',
              )}
            >
              <span
                className={cn(
                  'absolute top-1 h-5 w-5 rounded-full bg-white shadow transition-all',
                  enabled ? 'left-6' : 'left-1',
                )}
              />
            </button>
          </label>
        </div>
      </Card>

      <div className="grid gap-4 sm:grid-cols-2">
        {TABLE_KEYS.map((key) => (
          <Card key={key} className={cn('p-5', !enabled && 'opacity-60')}>
            <div className="flex items-center justify-between">
              <h3 className="font-serif font-bold text-white">{tableDisplayName(key)}</h3>
              <span className="text-xs text-white/40">
                {seated[key] ?? 0} seated now
              </span>
            </div>
            <div className="mt-4 flex items-center gap-3">
              <button
                type="button"
                onClick={() => step(key, -1)}
                disabled={!enabled || effective(key) === 0}
                className="flex h-9 w-9 items-center justify-center rounded-lg border border-white/10 bg-white/5 text-white transition hover:bg-white/10 disabled:opacity-30"
                aria-label={`Fewer robots at ${tableDisplayName(key)}`}
              >
                <Minus className="h-4 w-4" aria-hidden />
              </button>
              <span className="min-w-14 text-center text-2xl font-bold tabular-nums text-white">
                {enabled ? effective(key) : 0}
              </span>
              <button
                type="button"
                onClick={() => step(key, 1)}
                disabled={!enabled || effective(key) >= 8}
                className="flex h-9 w-9 items-center justify-center rounded-lg border border-white/10 bg-white/5 text-white transition hover:bg-white/10 disabled:opacity-30"
                aria-label={`More robots at ${tableDisplayName(key)}`}
              >
                <Plus className="h-4 w-4" aria-hidden />
              </button>
              <span className="text-xs text-white/35">robot seats (0–8)</span>
            </div>
          </Card>
        ))}
      </div>

      <Notice text={notice} />
      <button
        type="button"
        onClick={save}
        disabled={saving || !data}
        className="flex items-center gap-2 rounded-lg bg-amber-500 px-6 py-2.5 font-bold text-slate-950 transition hover:bg-amber-400 disabled:opacity-50"
      >
        <Save className="h-4 w-4" aria-hidden />
        {saving ? 'Applying…' : 'Save robot policy'}
      </button>
    </div>
  )
}

const DEFAULTS: Record<string, number> = {
  beginners: 4,
  greenroom: 3,
  riverkings: 2,
  highrollers: 2,
}

// ---------------- Transactions ----------------

export function TransactionsSection() {
  const [txs, setTxs] = useState<TxRow[]>([])
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    let cancelled = false
    fetchJson<{ transactions: TxRow[] }>('/api/admin/transactions').then((d) => {
      if (cancelled) return
      if (d) setTxs(d.transactions ?? [])
      setLoaded(true)
    })
    return () => {
      cancelled = true
    }
  }, [])

  return (
    <div className="overflow-x-auto rounded-xl border border-white/10">
      <table className="w-full min-w-[760px] text-sm">
        <thead>
          <tr className="border-b border-white/10 bg-slate-900/80 text-left text-white/50">
            <th className="px-4 py-3 font-medium">When</th>
            <th className="px-4 py-3 font-medium">Player</th>
            <th className="px-4 py-3 font-medium">Type</th>
            <th className="px-4 py-3 font-medium">Detail</th>
            <th className="px-4 py-3 text-right font-medium">Amount</th>
            <th className="px-4 py-3 text-right font-medium">Balance after</th>
          </tr>
        </thead>
        <tbody>
          {txs.map((t, i) => (
            <tr key={`${t.at}-${i}`} className="border-b border-white/5 last:border-0">
              <td className="px-4 py-2.5 text-white/45">{new Date(t.at).toISOString().replace('T', ' ').slice(5, 16)}</td>
              <td className="px-4 py-2.5 font-semibold text-white">{t.username}</td>
              <td className="px-4 py-2.5">
                <span
                  className={cn(
                    'rounded px-2 py-0.5 text-[10px] font-bold uppercase',
                    t.reason === 'admin_adjust' && 'bg-amber-400/10 text-amber-300',
                    t.reason === 'buyin' && 'bg-sky-500/10 text-sky-300',
                    t.reason === 'cashout' && 'bg-emerald-500/10 text-emerald-300',
                    t.reason === 'topup' && 'bg-white/10 text-white/60',
                  )}
                >
                  {t.reason.replace('_', ' ')}
                </span>
              </td>
              <td className="max-w-52 truncate px-4 py-2.5 text-white/50">{t.detail}</td>
              <td className={cn('px-4 py-2.5 text-right font-bold tabular-nums', t.amount >= 0 ? 'text-emerald-300' : 'text-rose-300')}>
                {t.amount > 0 ? '+' : ''}
                {formatChips(t.amount)}
              </td>
              <td className="px-4 py-2.5 text-right tabular-nums text-white/70">{formatChips(t.balanceAfter)}</td>
            </tr>
          ))}
          {txs.length === 0 && (
            <tr>
              <td colSpan={6} className="px-4 py-10 text-center text-white/40">
                {loaded ? 'No transactions yet' : 'Loading…'}
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  )
}
