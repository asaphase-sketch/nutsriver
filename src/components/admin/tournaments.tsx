'use client'

import { useCallback, useEffect, useState } from 'react'
import { Bot, Play, RefreshCw, Trophy, XCircle } from 'lucide-react'
import { cn } from '@/lib/utils'
import { formatChips } from '@/lib/poker/cards'
import { GAME_LABEL, payoutFractions, type GameType } from '@/lib/poker/types'
import { useToast } from '@/hooks/use-toast'
import { Button } from '@/components/ui/button'

/**
 * Admin tournaments: create (any variant / speed / structure), force-start,
 * fill seats with house bots, cancel with refunds. All actions hit
 * /api/admin/tournaments*.
 */

interface AdminTournament {
  id: string
  name: string
  gameType: string
  kind: string
  buyIn: number
  bounty: number
  startingStack: number
  seatsPerTable: number
  maxPlayers: number
  startAt: number | null
  levelMs: number
  state: string
  prizePool: number
  entries: number
  createdAt: number
  finishedAt: number | null
}

const gameTypes: GameType[] = ['holdem', 'omaha4', 'omaha5']

export function TournamentsSection() {
  const { toast } = useToast()
  const [rows, setRows] = useState<AdminTournament[]>([])
  const [busy, setBusy] = useState(false)
  const [form, setForm] = useState({
    name: 'NutsRiver Cup',
    gameType: 'holdem' as GameType,
    kind: 'sitgo',
    buyIn: 1000,
    turbo: true,
    bounty: false,
    startingStack: 1500,
    seatsPerTable: 9,
    maxPlayers: 9,
    startDelayMin: 5,
  })

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/admin/tournaments')
      if (!res.ok) return
      const data = (await res.json()) as { tournaments: AdminTournament[] }
      setRows(data.tournaments ?? [])
    } catch {
      /* offline */
    }
  }, [])

  useEffect(() => {
    load()
    const id = setInterval(load, 15000)
    return () => clearInterval(id)
  }, [load])

  const create = async () => {
    setBusy(true)
    try {
      const res = await fetch('/api/admin/tournaments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      })
      const data = await res.json()
      if (res.ok) {
        toast({ title: 'Tournament created', description: `${form.name} is open for registration` })
        await load()
      } else {
        toast({ title: 'Create failed', description: data?.error ?? 'Error', variant: 'destructive' })
      }
    } finally {
      setBusy(false)
    }
  }

  const act = async (path: string, id: string, extra?: Record<string, unknown>, label = 'Done') => {
    setBusy(true)
    try {
      const res = await fetch(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, ...extra }),
      })
      const data = await res.json()
      if (res.ok) {
        toast({ title: label, description: data?.added != null ? `${data.added} bots seated` : undefined })
        await load()
      } else {
        toast({ title: 'Action failed', description: data?.error ?? 'Error', variant: 'destructive' })
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex flex-col gap-6">
      {/* create form */}
      <section className="rounded-2xl border border-white/10 bg-slate-950/60 p-4">
        <h2 className="mb-3 flex items-center gap-2 text-sm font-bold uppercase tracking-widest text-white/70">
          <Trophy className="h-4 w-4 text-amber-300" aria-hidden /> Create tournament
        </h2>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Field label="Name">
            <input
              className="w-full rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-sm text-white outline-none focus:border-emerald-400/50"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              placeholder="NutsRiver Cup"
            />
          </Field>
          <Field label="Game">
            <div className="flex gap-1">
              {gameTypes.map((g) => (
                <button
                  key={g}
                  type="button"
                  onClick={() => setForm({ ...form, gameType: g })}
                  className={cn(
                    'flex-1 rounded-lg px-2 py-2 text-xs font-bold transition',
                    form.gameType === g ? 'bg-emerald-600 text-white' : 'bg-white/5 text-white/50 hover:text-white',
                  )}
                >
                  {GAME_LABEL[g]}
                </button>
              ))}
            </div>
          </Field>
          <Field label="Format">
            <div className="flex gap-1">
              {(['sitgo', 'scheduled'] as const).map((k) => (
                <button
                  key={k}
                  type="button"
                  onClick={() => setForm({ ...form, kind: k })}
                  className={cn(
                    'flex-1 rounded-lg px-2 py-2 text-xs font-bold transition',
                    form.kind === k ? 'bg-emerald-600 text-white' : 'bg-white/5 text-white/50 hover:text-white',
                  )}
                >
                  {k === 'sitgo' ? 'Sit & Go' : 'Scheduled'}
                </button>
              ))}
            </div>
          </Field>
          <Field label={form.kind === 'scheduled' ? 'Starts in (min)' : 'Turbo speed'}>
            {form.kind === 'scheduled' ? (
              <input
                type="number"
                min={1}
                max={1440}
                className="w-full rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-sm text-white outline-none focus:border-emerald-400/50"
                value={form.startDelayMin}
                onChange={(e) => setForm({ ...form, startDelayMin: Number(e.target.value) || 5 })}
              />
            ) : (
              <button
                type="button"
                onClick={() => setForm({ ...form, turbo: !form.turbo })}
                className={cn(
                  'w-full rounded-lg px-2 py-2 text-xs font-bold transition',
                  form.turbo ? 'bg-amber-500/90 text-slate-950' : 'bg-white/5 text-white/50',
                )}
              >
                {form.turbo ? 'TURBO (2-min levels)' : 'Regular (5-min levels)'}
              </button>
            )}
          </Field>
          <Field label="Buy-in">
            <input
              type="number"
              min={0}
              className="w-full rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-sm text-white outline-none focus:border-emerald-400/50"
              value={form.buyIn}
              onChange={(e) => setForm({ ...form, buyIn: Math.max(0, Number(e.target.value) || 0) })}
            />
          </Field>
          <Field label="Starting stack">
            <input
              type="number"
              min={200}
              className="w-full rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-sm text-white outline-none focus:border-emerald-400/50"
              value={form.startingStack}
              onChange={(e) => setForm({ ...form, startingStack: Number(e.target.value) || 1500 })}
            />
          </Field>
          <Field label="Seats / table">
            <div className="flex gap-1">
              {[2, 6, 9].map((n) => (
                <button
                  key={n}
                  type="button"
                  onClick={() =>
                    setForm({
                      ...form,
                      seatsPerTable: n,
                      maxPlayers: n === 2 ? 2 : n * Math.max(1, Math.round(form.maxPlayers / n)),
                    })
                  }
                  className={cn(
                    'flex-1 rounded-lg px-2 py-2 text-xs font-bold transition',
                    form.seatsPerTable === n ? 'bg-emerald-600 text-white' : 'bg-white/5 text-white/50 hover:text-white',
                  )}
                >
                  {n === 2 ? 'HU' : `${n}-max`}
                </button>
              ))}
            </div>
          </Field>
          <Field label="Capacity">
            <input
              type="number"
              min={2}
              max={300}
              className="w-full rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-sm text-white outline-none focus:border-emerald-400/50"
              value={form.maxPlayers}
              onChange={(e) => setForm({ ...form, maxPlayers: Number(e.target.value) || 9 })}
            />
          </Field>
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-4">
          <label className="flex items-center gap-2 text-xs font-semibold text-white/70">
            <input
              type="checkbox"
              checked={form.bounty}
              onChange={(e) => setForm({ ...form, bounty: e.target.checked })}
              className="h-4 w-4 accent-emerald-500"
            />
            Knockout (half the buy-in becomes a per-bust bounty)
          </label>
          <p className="text-xs text-white/40">
            Prizes: {payoutFractions(form.maxPlayers).length > 0
              ? payoutFractions(form.maxPlayers)
                  .slice(0, 4)
                  .map((f, i) => `${i + 1}: ${Math.round(f * 100)}%`)
                  .join(' · ')
              : ''}
            {payoutFractions(form.maxPlayers).length > 4 ? ' …' : ''}
          </p>
          <Button className="ml-auto bg-emerald-600 font-bold hover:bg-emerald-500" disabled={busy} onClick={create}>
            <Trophy className="mr-1 h-4 w-4" /> Create tournament
          </Button>
        </div>
      </section>

      {/* list */}
      <section className="rounded-2xl border border-white/10 bg-slate-950/60 p-4">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-bold uppercase tracking-widest text-white/70">All tournaments</h2>
          <button
            type="button"
            onClick={load}
            className="rounded-lg border border-white/10 bg-white/5 p-1.5 text-white/60 hover:text-white"
            aria-label="Refresh"
          >
            <RefreshCw className="h-3.5 w-3.5" />
          </button>
        </div>

        {rows.length === 0 && <p className="py-6 text-center text-sm text-white/40">No tournaments yet.</p>}

        <div className="flex flex-col gap-2">
          {rows.map((t) => (
            <div
              key={t.id}
              className="flex flex-col gap-2 rounded-xl border border-white/10 bg-black/25 p-3 sm:flex-row sm:items-center"
            >
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-bold text-white">{t.name}</span>
                  <span className="rounded bg-emerald-500/15 px-1.5 py-0.5 text-[10px] font-bold uppercase text-emerald-300">
                    {GAME_LABEL[(t.gameType as GameType) ?? 'holdem']}
                  </span>
                  <span
                    className={cn(
                      'rounded px-1.5 py-0.5 text-[10px] font-bold uppercase',
                      t.state === 'running'
                        ? 'bg-emerald-500/20 text-emerald-300'
                        : t.state === 'registering'
                          ? 'bg-amber-500/20 text-amber-300'
                          : t.state === 'finished'
                            ? 'bg-white/10 text-white/50'
                            : 'bg-rose-500/20 text-rose-300',
                    )}
                  >
                    {t.state}
                  </span>
                  {t.bounty > 0 && (
                    <span className="rounded bg-rose-500/15 px-1.5 py-0.5 text-[10px] font-bold uppercase text-rose-300">
                      KO
                    </span>
                  )}
                </div>
                <p className="mt-1 text-xs text-white/45">
                  {formatChips(t.buyIn)} buy-in · {formatChips(t.startingStack)} stack · {t.seatsPerTable}-max ·{' '}
                  {t.entries}/{t.maxPlayers} entries · prize pool {t.prizePool > 0 ? formatChips(t.prizePool) : '—'} ·{' '}
                  {t.levelMs <= 120_000 ? 'turbo' : 'regular'}
                </p>
              </div>
              <div className="flex shrink-0 flex-wrap items-center gap-1.5">
                {t.state === 'registering' && (
                  <>
                    <Button
                      size="sm"
                      variant="outline"
                      className="border-white/15 bg-white/5 text-xs text-white/80 hover:bg-white/10"
                      disabled={busy}
                      onClick={() => act('/api/admin/tournaments/fill', t.id, { count: t.maxPlayers - t.entries }, 'Bots seated')}
                    >
                      <Bot className="mr-1 h-3.5 w-3.5" /> Fill bots
                    </Button>
                    <Button
                      size="sm"
                      className="bg-emerald-600 text-xs font-bold hover:bg-emerald-500"
                      disabled={busy}
                      onClick={() => act('/api/admin/tournaments/start', t.id, {}, 'Tournament started')}
                    >
                      <Play className="mr-1 h-3.5 w-3.5" /> Start now
                    </Button>
                  </>
                )}
                {(t.state === 'registering' || t.state === 'running') && (
                  <Button
                    size="sm"
                    variant="outline"
                    className="border-rose-500/30 bg-rose-500/10 text-xs text-rose-300 hover:bg-rose-500/20"
                    disabled={busy}
                    onClick={() => act('/api/admin/tournaments/cancel', t.id, {}, 'Cancelled & refunded')}
                  >
                    <XCircle className="mr-1 h-3.5 w-3.5" /> Cancel
                  </Button>
                )}
              </div>
            </div>
          ))}
        </div>
      </section>
    </div>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[10px] font-bold uppercase tracking-wider text-white/40">{label}</span>
      {children}
    </label>
  )
}
