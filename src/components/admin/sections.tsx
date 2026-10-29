'use client'

/**
 * Robots + Transactions sections. The godmode Players section lives in
 * ./players (bottom-sheet drawer + full toolkit); the old inline one is
 * retired. Audit/Broadcast live in ./audit.
 */
import { useCallback, useEffect, useState } from 'react'
import { Bot, Minus, Plus, Save } from 'lucide-react'
import { cn } from '@/lib/utils'
import { formatChips } from '@/lib/poker/cards'
import { Card, fetchJson, tableDisplayName } from './dashboard'
import type { RobotsData, TxRow } from './types'

// PlayersSection moved to ./players — re-exported so existing imports keep working.
export { PlayersSection } from './players'

function Notice({ text }: { text: string | null }) {
  if (!text) return null
  return (
    <p className="rounded-lg border border-emerald-500/20 bg-emerald-500/10 px-4 py-2 text-sm text-emerald-200" role="status">
      {text}
    </p>
  )
}

// ---------------- Robots ----------------

/** ALL lobby-visible tables — was hardcoded to 4, missing every Omaha table. */
const TABLE_KEYS = [
  'beginners', 'omahalite', 'greenroom', 'omahajunction', 'feltroyale',
  'highfive', 'riverkings', 'omahaheights', 'highrollers', 'nosebleed',
] as const

const TABLE_DEFAULT_BOTS: Record<string, number> = {
  beginners: 4,
  omahalite: 3,
  greenroom: 3,
  omahajunction: 3,
  feltroyale: 3,
  highfive: 2,
  riverkings: 2,
  omahaheights: 2,
  highrollers: 2,
  nosebleed: 2,
}

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
      const base = cur === -1 ? TABLE_DEFAULT_BOTS[key]! : cur
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
    return v === undefined ? TABLE_DEFAULT_BOTS[key]! : v
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
