'use client'

/**
 * GODMODE Players section — server-side search, filter chips, player cards
 * (mobile-first; no horizontal-scroll table) and a bottom-sheet control
 * drawer with the full godmode toolkit: chip presets, locate & surgical
 * kick, force logout, password reset, rename, role, ban and delete.
 * Every action is audited server-side.
 */

import { useCallback, useEffect, useState } from 'react'
import {
  Ban, ChevronRight, Coins, Eye, KeyRound, Loader2, LogOut, Pencil, RefreshCw,
  Search, ShieldCheck, ShieldEllipsis, Trash2, UserMinus, UserPlus, VenetianMask,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { formatChips } from '@/lib/poker/cards'
import { Card, fetchJson, tableDisplayName } from './dashboard'
import type { AdminUser, TxRow } from './types'
import {
  Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle,
} from '@/components/ui/sheet'

const CHIP_PRESETS = [1_000, 10_000, 100_000]

type Filter = 'all' | 'banned' | 'admins'

function Notice({ text, tone = 'ok' }: { text: string | null; tone?: 'ok' | 'err' }) {
  if (!text) return null
  return (
    <p
      role="status"
      className={cn(
        'rounded-lg border px-4 py-2 text-sm',
        tone === 'ok'
          ? 'border-emerald-500/20 bg-emerald-500/10 text-emerald-200'
          : 'border-rose-500/20 bg-rose-500/10 text-rose-200',
      )}
    >
      {text}
    </p>
  )
}

async function post<T>(url: string, body: unknown): Promise<{ ok: boolean; data: T | null }> {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    const data = (await res.json().catch(() => null)) as T | null
    return { ok: res.ok, data }
  } catch {
    return { ok: false, data: null }
  }
}

export function PlayersSection() {
  const [users, setUsers] = useState<AdminUser[]>([])
  const [loaded, setLoaded] = useState(false)
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<Filter>('all')
  const [selected, setSelected] = useState<AdminUser | null>(null)
  const [reloadKey, setReloadKey] = useState(0)
  const reload = useCallback(() => setReloadKey((k) => k + 1), [])

  // debounce server-side search
  useEffect(() => {
    const t = setTimeout(() => reload(), 250)
    return () => clearTimeout(t)
  }, [query, reload])

  useEffect(() => {
    let cancelled = false
    fetchJson<{ users: AdminUser[] }>(`/api/admin/users?q=${encodeURIComponent(query)}`).then((data) => {
      if (cancelled) return
      if (data) setUsers(data.users ?? [])
      setLoaded(true)
    })
    return () => {
      cancelled = true
    }
  }, [reloadKey, query])

  const filtered = users.filter((u) =>
    filter === 'banned' ? u.banned : filter === 'admins' ? u.role === 'admin' : true,
  )

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2.5">
        <div className="relative min-w-0 flex-1 sm:max-w-xs">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-white/30" aria-hidden />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search players…"
            className="h-10 w-full rounded-lg border border-white/10 bg-slate-950/70 pl-9 pr-3 text-sm text-white placeholder:text-white/30 focus:border-emerald-400/50 focus:outline-none"
            aria-label="Search players"
          />
        </div>
        <div className="flex gap-1.5">
          {(['all', 'banned', 'admins'] as const).map((f) => (
            <button
              key={f}
              type="button"
              onClick={() => setFilter(f)}
              aria-pressed={filter === f}
              className={cn(
                'rounded-full border px-3 py-1.5 text-xs font-semibold capitalize transition',
                filter === f
                  ? 'border-amber-300/60 bg-amber-400/15 text-amber-200'
                  : 'border-white/10 bg-white/5 text-white/50 hover:text-white',
              )}
            >
              {f}
            </button>
          ))}
        </div>
        <span className="ml-auto text-xs text-white/40">{filtered.length} player(s)</span>
      </div>

      <div className="grid gap-2.5 sm:grid-cols-2 xl:grid-cols-3">
        {filtered.map((u) => (
          <button
            key={u.id}
            type="button"
            onClick={() => setSelected(u)}
            className={cn(
              'group flex items-center gap-3 rounded-xl border p-3.5 text-left transition',
              'border-white/10 bg-gradient-to-b from-slate-900/80 to-slate-950/80 shadow-lg shadow-black/20',
              'hover:border-amber-300/30 hover:shadow-amber-900/20',
              u.banned && 'opacity-70',
            )}
          >
            <span
              className={cn(
                'flex h-10 w-10 shrink-0 items-center justify-center rounded-lg font-serif text-lg font-black',
                u.role === 'admin' ? 'bg-amber-400/15 text-amber-300' : 'bg-emerald-500/10 text-emerald-300',
              )}
              aria-hidden
            >
              {u.username.slice(0, 1).toUpperCase()}
            </span>
            <span className="min-w-0 flex-1">
              <span className="flex items-center gap-1.5">
                <span className="truncate font-semibold text-white">{u.username}</span>
                {u.role === 'admin' && (
                  <span className="rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-bold uppercase text-amber-300">admin</span>
                )}
                {u.banned && (
                  <span className="rounded bg-rose-500/15 px-1.5 py-0.5 text-[10px] font-bold uppercase text-rose-300">banned</span>
                )}
              </span>
              <span className="mt-0.5 block truncate text-xs text-white/45">
                <span className="font-bold text-emerald-300">{formatChips(u.chips)}</span>
                {' · '}{formatChips(u.handsPlayed)} hands · top pot {formatChips(u.biggestPotWon)}
              </span>
            </span>
            <ChevronRight className="h-4 w-4 shrink-0 text-white/25 transition group-hover:text-amber-200" aria-hidden />
          </button>
        ))}
        {filtered.length === 0 && (
          <Card className="col-span-full p-8 text-center text-sm text-white/40">
            {loaded ? 'No players match' : 'Loading…'}
          </Card>
        )}
      </div>

      <PlayerDrawer
        user={selected}
        onDone={(msg, ok) => {
          setSelected((prev) => (prev && ok ? { ...prev } : prev))
          reload()
        }}
        onDeleted={() => {
          setSelected(null)
          reload()
        }}
        onClose={() => setSelected(null)}
      />
    </div>
  )
}

// ---------------- godmode drawer ----------------

function PlayerDrawer({
  user,
  onClose,
  onDeleted,
}: {
  user: AdminUser | null
  onDone: (msg: string, ok: boolean) => void
  onDeleted: () => void
  onClose: () => void
}) {
  const [busy, setBusy] = useState<string | null>(null)
  const [notice, setNotice] = useState<{ text: string; tone: 'ok' | 'err' } | null>(null)
  const [custom, setCustom] = useState('')
  const [banReason, setBanReason] = useState('')
  const [newName, setNewName] = useState('')
  const [renameOpen, setRenameOpen] = useState(false)
  const [seatedAt, setSeatedAt] = useState<string[] | null>(null)
  const [txs, setTxs] = useState<TxRow[]>([])

  useEffect(() => {
    setNotice(null)
    setCustom('')
    setBanReason('')
    setNewName('')
    setRenameOpen(false)
    setSeatedAt(null)
    setTxs([])
    if (user?.id) {
      fetchJson<{ transactions: TxRow[] }>(`/api/admin/player/transactions?userId=${user.id}`).then((d) => {
        if (d) setTxs(d.transactions ?? [])
      })
    }
  }, [user?.id])

  if (!user) return null

  const run = async (label: string, fn: () => Promise<string>) => {
    setBusy(label)
    setNotice(null)
    try {
      setNotice({ text: await fn(), tone: 'ok' })
    } catch (e) {
      setNotice({ text: (e as Error).message, tone: 'err' })
    } finally {
      setBusy(null)
    }
  }

  const guard = async (url: string, body: unknown, okMsg: string) => {
    const { ok, data } = await post<{ ok?: boolean; error?: string }>(url, body)
    if (!ok) throw new Error(data?.error ?? 'Action failed')
    return okMsg
  }

  const adjustChips = (delta: number) =>
    run('chips', async () => {
      const { ok, data } = await post<{ chips?: number; error?: string }>('/api/admin/chips', {
        userId: user.id,
        delta,
        reason: 'godmode drawer',
      })
      if (!ok) throw new Error(data?.error ?? 'Adjustment failed')
      return `Balance is now ${formatChips(data?.chips ?? 0)}`
    })

  const locate = () =>
    run('locate', async () => {
      const { ok, data } = await post<{ seated?: string[] }>('/api/admin/players/locate', { userId: user.id })
      if (!ok) throw new Error(data ? (data as { error?: string }).error ?? 'Locate failed' : 'Locate failed')
      const seats = data?.seated ?? []
      setSeatedAt(seats)
      return seats.length ? `Seated at: ${seats.map(tableDisplayName).join(', ')}` : 'Not seated at any table'
    })

  const kick = (tableKey: string) =>
    run(`kick:${tableKey}`, () => guard('/api/admin/tables/kick', { tableKey, userId: user.id }, 'Kicked from table'))

  const forceLogout = () =>
    run('logout', () => guard('/api/admin/players/logout', { userId: user.id }, 'All sessions killed — player must log in again'))

  const resetPassword = () =>
    run('password', async () => {
      const { ok, data } = await post<{ password?: string; error?: string }>('/api/admin/players/password', { userId: user.id })
      if (!ok) throw new Error(data?.error ?? 'Reset failed')
      return `New password (shown once): ${data?.password}`
    })

  const rename = () =>
    run('rename', () => guard('/api/admin/players/rename', { userId: user.id, username: newName.trim() }, 'Renamed'))

  const setRole = (role: 'admin' | 'player') =>
    run('role', () => guard('/api/admin/players/role', { userId: user.id, role }, role === 'admin' ? 'Promoted to admin' : 'Demoted to player'))

  const setBan = (banned: boolean) =>
    run('ban', () => guard('/api/admin/ban', { userId: user.id, banned, reason: banReason.trim() || undefined }, banned ? 'BANNED — sessions killed' : 'Unbanned'))

  const remove = () =>
    run('delete', async () => {
      await guard('/api/admin/players/delete', { userId: user.id }, 'Account deleted')
      onDeleted()
      return 'Account deleted'
    })

  const actionBtn =
    'flex items-center justify-center gap-1.5 rounded-lg px-3 py-2 text-xs font-bold transition disabled:opacity-40'

  return (
    <Sheet open={!!user} onOpenChange={(open) => !open && onClose()}>
      <SheetContent
        side="bottom"
        className="h-[88dvh] overflow-y-auto rounded-t-2xl border-white/10 bg-[#0c1512] p-0 text-white sm:left-auto sm:right-4 sm:top-16 sm:h-[calc(100dvh-5rem)] sm:w-[420px] sm:rounded-2xl sm:border"
      >
        <div className="sticky top-0 z-10 border-b border-white/10 bg-[#0c1512]/95 px-5 pb-4 pt-4 backdrop-blur">
          <SheetHeader className="p-0">
            <SheetTitle className="flex items-center gap-3 text-left">
              <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-gradient-to-b from-emerald-500/20 to-emerald-800/30 font-serif text-xl font-black text-emerald-300 shadow-inner">
                {user.username.slice(0, 1).toUpperCase()}
              </span>
              <span className="min-w-0">
                <span className="flex items-center gap-1.5">
                  <span className="truncate text-lg">{user.username}</span>
                  {user.role === 'admin' && (
                    <span className="rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-bold uppercase text-amber-300">admin</span>
                  )}
                  {user.banned && (
                    <span className="rounded bg-rose-500/15 px-1.5 py-0.5 text-[10px] font-bold uppercase text-rose-300">banned</span>
                  )}
                </span>
                <SheetDescription asChild>
                  <span className="mt-0.5 block text-xs text-white/45">
                    joined {new Date(user.createdAt).toISOString().slice(0, 10)} · {formatChips(user.handsPlayed)} hands · {formatChips(user.handsWon)} won
                  </span>
                </SheetDescription>
              </span>
            </SheetTitle>
          </SheetHeader>
          <p className="mt-3 flex items-center gap-2 rounded-lg border border-emerald-400/20 bg-emerald-500/5 px-3 py-2 text-sm">
            <Coins className="h-4 w-4 text-emerald-300" aria-hidden />
            <span className="font-bold tabular-nums text-emerald-200">{formatChips(user.chips)}</span>
            <span className="text-white/35">play-money balance</span>
          </p>
        </div>

        <div className="space-y-5 p-5">
          <Notice text={notice?.text ?? null} tone={notice?.tone} />

          {/* chips */}
          <section>
            <h3 className="text-[11px] font-bold uppercase tracking-widest text-white/40">Chips</h3>
            <div className="mt-2 grid grid-cols-3 gap-2">
              {CHIP_PRESETS.map((v) => (
                <button
                  key={v}
                  type="button"
                  disabled={busy != null}
                  onClick={() => adjustChips(v)}
                  className={cn(actionBtn, 'bg-emerald-600/20 text-emerald-300 hover:bg-emerald-600/30')}
                >
                  <UserPlus className="h-3.5 w-3.5" aria-hidden />+{formatChips(v)}
                </button>
              ))}
              {CHIP_PRESETS.map((v) => (
                <button
                  key={`-${v}`}
                  type="button"
                  disabled={busy != null}
                  onClick={() => adjustChips(-v)}
                  className={cn(actionBtn, 'bg-rose-600/15 text-rose-300 hover:bg-rose-600/25')}
                >
                  <UserMinus className="h-3.5 w-3.5" aria-hidden />−{formatChips(v)}
                </button>
              ))}
            </div>
            <div className="mt-2 flex gap-2">
              <input
                value={custom}
                onChange={(e) => setCustom(e.target.value.replace(/[^0-9]/g, ''))}
                placeholder="Custom amount"
                inputMode="numeric"
                className="h-9 min-w-0 flex-1 rounded-lg border border-white/10 bg-slate-950/70 px-3 text-sm text-white placeholder:text-white/30 focus:outline-none"
                aria-label="Custom chip amount"
              />
              <button
                type="button"
                disabled={busy != null || !custom}
                onClick={() => {
                  const v = Number(custom)
                  if (v > 0) adjustChips(v).then(() => setCustom(''))
                }}
                className={cn(actionBtn, 'bg-emerald-600/20 text-emerald-300 hover:bg-emerald-600/30')}
              >
                Give
              </button>
              <button
                type="button"
                disabled={busy != null || !custom}
                onClick={() => {
                  const v = Number(custom)
                  if (v > 0) adjustChips(-v).then(() => setCustom(''))
                }}
                className={cn(actionBtn, 'bg-rose-600/15 text-rose-300 hover:bg-rose-600/25')}
              >
                Take
              </button>
            </div>
          </section>

          {/* presence */}
          <section>
            <h3 className="text-[11px] font-bold uppercase tracking-widest text-white/40">Presence</h3>
            <div className="mt-2 flex gap-2">
              <button type="button" disabled={busy != null} onClick={locate} className={cn(actionBtn, 'flex-1 border border-white/10 bg-white/5 text-white hover:bg-white/10')}>
                {busy === 'locate' ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : <Eye className="h-3.5 w-3.5" aria-hidden />}
                Locate at tables
              </button>
              <button
                type="button"
                disabled={busy != null}
                onClick={() =>
                  run('standup', () => guard('/api/admin/standup', { userId: user.id }, 'Stood up from every table'))
                }
                className={cn(actionBtn, 'flex-1 border border-white/10 bg-white/5 text-white hover:bg-white/10')}
              >
                <VenetianMask className="h-3.5 w-3.5" aria-hidden /> Stand up everywhere
              </button>
            </div>
            {seatedAt != null && seatedAt.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-2">
                {seatedAt.map((key) => (
                  <button
                    key={key}
                    type="button"
                    disabled={busy != null}
                    onClick={() => kick(key)}
                    className="flex items-center gap-1.5 rounded-full border border-rose-400/30 bg-rose-500/10 px-3 py-1 text-xs font-semibold text-rose-200 transition hover:bg-rose-500/20"
                  >
                    {tableDisplayName(key)} — kick
                  </button>
                ))}
              </div>
            )}
          </section>

          {/* account */}
          <section>
            <h3 className="text-[11px] font-bold uppercase tracking-widest text-white/40">Account</h3>
            <div className="mt-2 grid grid-cols-2 gap-2">
              <button type="button" disabled={busy != null} onClick={forceLogout} className={cn(actionBtn, 'border border-white/10 bg-white/5 text-white hover:bg-white/10')}>
                <LogOut className="h-3.5 w-3.5" aria-hidden /> Force logout
              </button>
              <button type="button" disabled={busy != null} onClick={resetPassword} className={cn(actionBtn, 'border border-white/10 bg-white/5 text-white hover:bg-white/10')}>
                <KeyRound className="h-3.5 w-3.5" aria-hidden /> Reset password
              </button>
              <button
                type="button"
                disabled={busy != null}
                onClick={() => {
                  setNewName(user.username)
                  setRenameOpen((v) => !v)
                }}
                className={cn(actionBtn, 'border border-white/10 bg-white/5 text-white hover:bg-white/10')}
              >
                <Pencil className="h-3.5 w-3.5" aria-hidden /> Rename
              </button>
              {user.role === 'admin' ? (
                <button type="button" disabled={busy != null} onClick={() => setRole('player')} className={cn(actionBtn, 'border border-white/10 bg-white/5 text-white hover:bg-white/10')}>
                  <ShieldEllipsis className="h-3.5 w-3.5" aria-hidden /> Demote
                </button>
              ) : (
                <button type="button" disabled={busy != null} onClick={() => setRole('admin')} className={cn(actionBtn, 'border border-white/10 bg-white/5 text-white hover:bg-white/10')}>
                  <ShieldCheck className="h-3.5 w-3.5" aria-hidden /> Promote
                </button>
              )}
            </div>
            {renameOpen && (
              <div className="mt-2 flex gap-2">
                <input
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  placeholder="New username"
                  className="h-9 min-w-0 flex-1 rounded-lg border border-white/10 bg-slate-950/70 px-3 text-sm text-white placeholder:text-white/30 focus:outline-none"
                  aria-label="New username"
                />
                <button
                  type="button"
                  disabled={busy != null || newName.trim().length < 3}
                  onClick={() => rename().then(() => setRenameOpen(false))}
                  className={cn(actionBtn, 'bg-emerald-600/20 text-emerald-300 hover:bg-emerald-600/30')}
                >
                  <RefreshCw className="h-3.5 w-3.5" aria-hidden /> Apply
                </button>
              </div>
            )}
          </section>

          {/* moderation */}
          {user.role !== 'admin' && (
            <section>
              <h3 className="text-[11px] font-bold uppercase tracking-widest text-white/40">Moderation</h3>
              <input
                value={banReason}
                onChange={(e) => setBanReason(e.target.value)}
                placeholder="Reason (recorded in the audit log)"
                className="mt-2 h-9 w-full rounded-lg border border-white/10 bg-slate-950/70 px-3 text-sm text-white placeholder:text-white/30 focus:outline-none"
                aria-label="Moderation reason"
              />
              <div className="mt-2 grid grid-cols-2 gap-2">
                {user.banned ? (
                  <button type="button" disabled={busy != null} onClick={() => setBan(false)} className={cn(actionBtn, 'bg-emerald-600/20 text-emerald-300 hover:bg-emerald-600/30')}>
                    <ShieldCheck className="h-3.5 w-3.5" aria-hidden /> Unban
                  </button>
                ) : (
                  <button type="button" disabled={busy != null} onClick={() => setBan(true)} className={cn(actionBtn, 'bg-rose-600/20 text-rose-300 hover:bg-rose-600/30')}>
                    <Ban className="h-3.5 w-3.5" aria-hidden /> Ban
                  </button>
                )}
                <button
                  type="button"
                  disabled={busy != null}
                  onClick={() => {
                    if (window.confirm(`Delete ${user.username} permanently? This cannot be undone.`)) remove()
                  }}
                  className={cn(actionBtn, 'bg-rose-700/25 text-rose-300 hover:bg-rose-700/40')}
                >
                  <Trash2 className="h-3.5 w-3.5" aria-hidden /> Delete account
                </button>
              </div>
            </section>
          )}

          {/* recent ledger */}
          <section>
            <h3 className="text-[11px] font-bold uppercase tracking-widest text-white/40">Recent transactions</h3>
            <ul className="mt-2 space-y-1.5">
              {txs.map((t, i) => (
                <li key={`${t.at}-${i}`} className="flex items-center justify-between gap-3 rounded-lg bg-white/[0.03] px-3 py-1.5 text-xs">
                  <span className="min-w-0 flex-1 truncate text-white/45">
                    {t.reason.replace('_', ' ')} · {new Date(t.at).toISOString().slice(5, 16).replace('T', ' ')}
                  </span>
                  <span className={cn('font-bold tabular-nums', t.amount >= 0 ? 'text-emerald-300' : 'text-rose-300')}>
                    {t.amount > 0 ? '+' : ''}{formatChips(t.amount)}
                  </span>
                </li>
              ))}
              {txs.length === 0 && <li className="rounded-lg bg-white/[0.03] px-3 py-2 text-center text-xs text-white/35">No ledger entries</li>}
            </ul>
          </section>
        </div>
      </SheetContent>
    </Sheet>
  )
}
