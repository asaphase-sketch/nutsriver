'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import {
  Activity, ArrowLeftRight, ArrowLeft, Bot, Coins, Database, Gauge, History, LayoutDashboard,
  Radio, RefreshCw, ShieldCheck, Spade, Table2, Trophy, UserPlus, Users, Wifi,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { formatChips, formatChipsShort } from '@/lib/poker/cards'
import type { OverviewData } from './types'
import { PlayersSection, RobotsSection, TransactionsSection } from './sections'
import { HandsSection } from './hands'
import { TournamentsSection } from './tournaments'

export type AdminTab = 'dashboard' | 'tables' | 'players' | 'hands' | 'tournaments' | 'robots' | 'transactions' | 'system'

const NAV: { id: AdminTab; label: string; icon: typeof LayoutDashboard }[] = [
  { id: 'dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { id: 'tables', label: 'Live Tables', icon: Table2 },
  { id: 'players', label: 'Players', icon: Users },
  { id: 'hands', label: 'Hand History', icon: History },
  { id: 'tournaments', label: 'Tournaments', icon: Trophy },
  { id: 'robots', label: 'Robots', icon: Bot },
  { id: 'transactions', label: 'Transactions', icon: ArrowLeftRight },
  { id: 'system', label: 'System', icon: Gauge },
]

export const TABLE_NAMES: Record<string, string> = {
  beginners: 'Beginners Corner',
  greenroom: 'Green Room',
  riverkings: 'River Kings',
  highrollers: 'High Rollers',
  omahajunction: 'Omaha Junction',
  omahaheights: 'Omaha Heights 5',
}

/** Pretty name for any table key, including tournament tables `t:<id>:<n>`. */
export function tableDisplayName(key: string): string {
  if (TABLE_NAMES[key]) return TABLE_NAMES[key]
  const m = /^t:([^:]+):(\d+)$/.exec(key)
  if (m) return `Tournament ${m[1]} · Table ${Number(m[2]) + 1}`
  return key
}

export async function fetchJson<T>(url: string, init?: RequestInit): Promise<T | null> {
  try {
    const res = await fetch(url, { cache: 'no-store', ...init })
    if (!res.ok) return null
    return (await res.json()) as T
  } catch {
    return null
  }
}

export function timeAgo(at: number): string {
  const s = Math.max(1, Math.floor((Date.now() - at) / 1000))
  if (s < 60) return `${s}s ago`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
}

export function Card({ children, className }: { children?: React.ReactNode; className?: string }) {
  return <div className={cn('rounded-xl border border-white/10 bg-slate-900/70 shadow-lg shadow-black/20', className)}>{children}</div>
}

export function KpiCard({
  icon: Icon, label, value, sub, tone = 'emerald',
}: {
  icon: typeof Users
  label: string
  value: string
  sub?: string
  tone?: 'emerald' | 'amber' | 'sky' | 'rose'
}) {
  const tones = {
    emerald: 'bg-emerald-500/10 text-emerald-300',
    amber: 'bg-amber-400/10 text-amber-300',
    sky: 'bg-sky-500/10 text-sky-300',
    rose: 'bg-rose-500/10 text-rose-300',
  }
  return (
    <Card className="p-4">
      <div className="flex items-center gap-3">
        <span className={cn('flex h-10 w-10 shrink-0 items-center justify-center rounded-lg', tones[tone])}>
          <Icon className="h-5 w-5" aria-hidden />
        </span>
        <div className="min-w-0">
          <p className="truncate text-[11px] font-semibold uppercase tracking-wider text-white/40">{label}</p>
          <p className="text-xl font-bold tabular-nums text-white">{value}</p>
        </div>
      </div>
      {sub && <p className="mt-2 truncate text-xs text-white/45">{sub}</p>}
    </Card>
  )
}

interface DashboardProps {
  username: string
}

export function Dashboard({ username }: DashboardProps) {
  const [tab, setTab] = useState<AdminTab>('dashboard')
  const [overview, setOverview] = useState<OverviewData | null>(null)
  const [clock, setClock] = useState(() => new Date())
  const [handsTableFilter, setHandsTableFilter] = useState<string | null>(null)

  const loadOverview = useCallback(async () => {
    const data = await fetchJson<OverviewData>('/api/admin/overview')
    if (data) setOverview(data)
  }, [])

  // initial load + auto refresh while live sections are visible
  useEffect(() => {
    let cancelled = false
    const tick = () => {
      if (document.visibilityState !== 'visible') return
      if (tab === 'dashboard' || tab === 'tables' || tab === 'system') {
        fetchJson<OverviewData>('/api/admin/overview').then((data) => {
          if (!cancelled && data) setOverview(data)
        })
      }
    }
    tick()
    // 30s cadence: the overview is served from the LobbyDO cache (one DO
    // request per poll) — keeps the admin panel inside the free-tier budget.
    const id = setInterval(tick, 30_000)
    return () => {
      cancelled = true
      clearInterval(id)
    }
  }, [tab])

  // wall clock for the header
  useEffect(() => {
    const id = setInterval(() => setClock(new Date()), 1000)
    return () => clearInterval(id)
  }, [])

  const openHands = useCallback((tableKey: string | null) => {
    setHandsTableFilter(tableKey)
    setTab('hands')
  }, [])

  return (
    <div className="flex min-h-screen bg-[#0c1512] text-white">
      {/* sidebar (desktop) */}
      <aside className="sticky top-0 hidden h-screen w-60 shrink-0 flex-col border-r border-white/5 bg-slate-950/80 md:flex">
        <div className="flex items-center gap-2.5 border-b border-white/5 px-5 py-5">
          <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-emerald-700">
            <Spade className="h-4 w-4 text-amber-300" aria-hidden />
          </span>
          <div>
            <p className="font-serif text-lg font-black leading-none tracking-wide">
              Nuts<span className="text-amber-300">River</span>
            </p>
            <p className="mt-1 text-[10px] font-semibold uppercase tracking-widest text-white/35">Control Panel</p>
          </div>
        </div>
        <nav className="flex-1 space-y-1 overflow-y-auto p-3" aria-label="Admin sections">
          {NAV.map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => setTab(item.id)}
              aria-current={tab === item.id ? 'page' : undefined}
              className={cn(
                'flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition',
                tab === item.id
                  ? 'bg-emerald-500/10 text-emerald-200 ring-1 ring-emerald-400/20'
                  : 'text-white/55 hover:bg-white/5 hover:text-white',
              )}
            >
              <item.icon className="h-4 w-4 shrink-0" aria-hidden />
              {item.label}
            </button>
          ))}
        </nav>
        <div className="border-t border-white/5 p-4">
          <p className="flex items-center gap-2 text-xs text-white/50">
            <ShieldCheck className="h-3.5 w-3.5 text-amber-300" aria-hidden />
            <span className="truncate font-semibold text-white/80">{username}</span>
          </p>
          <Link
            href="/"
            className="mt-3 flex items-center justify-center gap-2 rounded-lg bg-emerald-700/80 px-3 py-2 text-xs font-semibold text-white transition hover:bg-emerald-600"
          >
            <ArrowLeft className="h-3.5 w-3.5" aria-hidden /> Back to poker room
          </Link>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        {/* top bar */}
        <header className="sticky top-0 z-20 border-b border-white/5 bg-[#0c1512]/90 backdrop-blur">
          <div className="flex h-14 items-center gap-3 px-4 sm:px-6">
            <span className="flex items-center gap-2 md:hidden">
              <span className="flex h-7 w-7 items-center justify-center rounded-md bg-emerald-700">
                <Spade className="h-3.5 w-3.5 text-amber-300" aria-hidden />
              </span>
              <span className="font-serif font-black">Nuts<span className="text-amber-300">River</span></span>
            </span>
            <h1 className="hidden text-sm font-semibold uppercase tracking-widest text-white/60 md:block">
              {NAV.find((n) => n.id === tab)?.label}
            </h1>
            <div className="ml-auto flex items-center gap-2">
              {overview?.onlineNow != null && (
                <span className="hidden items-center gap-1.5 rounded-full border border-emerald-400/30 bg-emerald-500/10 px-3 py-1 text-xs font-semibold text-emerald-300 sm:flex">
                  <Radio className="h-3 w-3 animate-pulse" aria-hidden />
                  {overview.onlineNow} online
                </span>
              )}
              <span className="hidden text-xs tabular-nums text-white/40 lg:block">
                {clock.toISOString().slice(11, 19)} UTC
              </span>
              <button
                type="button"
                onClick={loadOverview}
                className="rounded-lg border border-white/10 bg-white/5 p-2 text-white/60 transition hover:bg-white/10 hover:text-white"
                aria-label="Refresh data"
              >
                <RefreshCw className="h-4 w-4" aria-hidden />
              </button>
            </div>
          </div>
          {/* mobile nav */}
          <nav className="flex gap-1 overflow-x-auto border-t border-white/5 px-2 py-1.5 md:hidden" aria-label="Admin sections">
            {NAV.map((item) => (
              <button
                key={item.id}
                type="button"
                onClick={() => setTab(item.id)}
                className={cn(
                  'flex shrink-0 items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-semibold transition',
                  tab === item.id ? 'bg-emerald-500/15 text-emerald-200' : 'text-white/50 hover:bg-white/5',
                )}
              >
                <item.icon className="h-3.5 w-3.5" aria-hidden />
                {item.label}
              </button>
            ))}
          </nav>
        </header>

        <main className="mx-auto w-full max-w-7xl flex-1 p-4 sm:p-6">
          {tab === 'dashboard' && <OverviewSection overview={overview} onOpenHands={openHands} onGoRobots={() => setTab('robots')} />}
          {tab === 'tables' && <TablesSection overview={overview} onOpenHands={openHands} />}
          {tab === 'players' && <PlayersSection />}
          {tab === 'hands' && <HandsSection tableFilter={handsTableFilter} onFilterChange={setHandsTableFilter} />}
          {tab === 'tournaments' && <TournamentsSection />}
          {tab === 'robots' && <RobotsSection />}
          {tab === 'transactions' && <TransactionsSection />}
          {tab === 'system' && <SystemSection overview={overview} />}
        </main>
      </div>
    </div>
  )
}

// ---------------- Dashboard (overview) ----------------

function OverviewSection({
  overview,
  onOpenHands,
  onGoRobots,
}: {
  overview: OverviewData | null
  onOpenHands: (t: string | null) => void
  onGoRobots: () => void
}) {
  if (!overview) {
    return (
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {Array.from({ length: 6 }).map((_, i) => (
          <Card key={i} className="h-24 animate-pulse opacity-40" />
        ))}
      </div>
    )
  }
  const { stats } = overview
  return (
    <div className="space-y-6">
      <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3" aria-label="Key metrics">
        <KpiCard icon={Users} label="Total players" value={formatChips(stats.totalUsers)} sub={`${stats.newUsersToday} joined today`} />
        <KpiCard icon={Wifi} label="Online now" value={formatChips(overview.onlineNow)} sub={`${overview.activeTables} of ${overview.tables.length || 10} tables occupied`} tone="sky" />
        <KpiCard icon={Coins} label="Chips in play" value={formatChipsShort(stats.chipsInCirculation)} sub="play-money, no cash value" tone="amber" />
        <KpiCard icon={Table2} label="Hands today" value={formatChips(stats.handsToday)} sub={`${formatChips(stats.handsTotal)} hands all time`} />
        <KpiCard icon={Bot} label="Robots seated" value={formatChips(overview.botsActive)} sub="controlled from the Robots tab" tone="amber" />
        <KpiCard icon={History} label="Avg pot today" value={formatChipsShort(stats.avgPotToday)} sub={`biggest ever ${formatChipsShort(stats.biggestPotEver)}`} tone="sky" />
      </section>

      <div className="grid gap-4 lg:grid-cols-5">
        {/* activity feed */}
        <Card className="p-4 lg:col-span-2">
          <h2 className="flex items-center gap-2 text-sm font-bold uppercase tracking-wider text-white/60">
            <Activity className="h-4 w-4 text-emerald-300" aria-hidden /> Real-time activity
          </h2>
          <ul className="mt-3 max-h-96 space-y-2.5 overflow-y-auto pr-1">
            {overview.activity.map((item, i) => (
              <li key={`${item.at}-${i}`} className="flex items-start gap-2.5 text-sm">
                <span
                  className={cn(
                    'mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-md',
                    item.kind === 'register' && 'bg-emerald-500/10 text-emerald-300',
                    item.kind === 'hand' && 'bg-amber-400/10 text-amber-300',
                    item.kind === 'tx' && 'bg-sky-500/10 text-sky-300',
                  )}
                >
                  {item.kind === 'register' ? (
                    <UserPlus className="h-3 w-3" aria-hidden />
                  ) : item.kind === 'hand' ? (
                    <Spade className="h-3 w-3" aria-hidden />
                  ) : (
                    <ArrowLeftRight className="h-3 w-3" aria-hidden />
                  )}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-white/80">
                    {item.text}
                    {item.detail && <span className="text-white/45"> — {item.detail}</span>}
                  </p>
                  <p className="text-[11px] text-white/35">
                    {timeAgo(item.at)}
                    {item.amount != null && item.kind !== 'tx' ? ` · pot ${formatChips(item.amount)}` : ''}
                    {item.amount != null && item.kind === 'tx' ? ` · ${item.amount > 0 ? '+' : ''}${formatChips(item.amount)}` : ''}
                  </p>
                </div>
              </li>
            ))}
            {overview.activity.length === 0 && <li className="py-6 text-center text-sm text-white/35">No activity yet</li>}
          </ul>
        </Card>

        {/* online tables */}
        <Card className="p-4 lg:col-span-3">
          <h2 className="flex items-center gap-2 text-sm font-bold uppercase tracking-wider text-white/60">
            <Table2 className="h-4 w-4 text-emerald-300" aria-hidden /> Live tables
          </h2>
          <div className="mt-3 space-y-2">
            {overview.tables.map((t) => (
              <div key={t.tableKey} className="flex items-center gap-3 rounded-lg border border-white/5 bg-white/[0.03] px-3 py-2.5">
                <div className="min-w-0 flex-1">
                  <p className="flex items-center gap-2 truncate font-semibold text-white">
                    {t.name ?? TABLE_NAMES[t.tableKey] ?? t.tableKey}
                    {t.offline ? (
                      <span className="rounded bg-white/10 px-1.5 py-0.5 text-[10px] font-bold uppercase text-white/40">asleep</span>
                    ) : t.inHand ? (
                      <span className="rounded bg-rose-500/15 px-1.5 py-0.5 text-[10px] font-bold uppercase text-rose-300">in hand</span>
                    ) : (
                      <span className="rounded bg-emerald-500/15 px-1.5 py-0.5 text-[10px] font-bold uppercase text-emerald-300">waiting</span>
                    )}
                  </p>
                  <p className="text-xs text-white/45">
                    {t.humansConnected} online · {t.humansSeated} seated · {t.botsSeated} robots · pot avg {formatChips(t.avgPot)} · {formatChips(t.handsPlayed)} hands
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => onOpenHands(t.tableKey)}
                  className="shrink-0 rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-xs font-semibold text-white/70 transition hover:bg-white/10 hover:text-white"
                >
                  Hands
                </button>
              </div>
            ))}
          </div>
        </Card>
      </div>

      {/* system status strip */}
      <SystemStrip overview={overview} onGoRobots={onGoRobots} />
    </div>
  )
}

function SystemStrip({ overview, onGoRobots }: { overview: OverviewData; onGoRobots: () => void }) {
  const enginesUp = overview.tables.filter((t) => !t.offline).length
  const cells = [
    { icon: Gauge, label: 'API', value: 'Operational', ok: true },
    { icon: Database, label: 'Database', value: 'Operational', ok: true },
    { icon: Radio, label: 'Realtime', value: `${overview.onlineNow} online`, ok: true },
    { icon: Table2, label: 'Game engines', value: `${enginesUp}/${overview.tables.length || 10} up`, ok: enginesUp > 0 },
    { icon: Bot, label: 'Robots', value: overview.botsActive > 0 ? `${overview.botsActive} seated` : 'off', ok: true, onClick: onGoRobots },
    { icon: ShieldCheck, label: 'Version', value: overview.version.replace('nutsriver-', 'v'), ok: true },
  ]
  return (
    <Card className="p-4">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        {cells.map((c) => (
          <button
            key={c.label}
            type="button"
            onClick={c.onClick}
            disabled={!c.onClick}
            className={cn('flex items-center gap-2 rounded-lg bg-white/[0.03] px-3 py-2 text-left', c.onClick && 'transition hover:bg-white/[0.07]')}
          >
            <c.icon className={cn('h-4 w-4 shrink-0', c.ok ? 'text-emerald-400' : 'text-rose-400')} aria-hidden />
            <div className="min-w-0">
              <p className="truncate text-[10px] font-semibold uppercase tracking-wide text-white/40">{c.label}</p>
              <p className="truncate text-xs font-bold text-white/85">{c.value}</p>
            </div>
          </button>
        ))}
      </div>
      <p className="mt-3 text-[11px] text-white/30">
        All systems report from the live edge. Data refreshes automatically every 30 seconds while this page is visible.
      </p>
    </Card>
  )
}

// ---------------- Tables ----------------

function TablesSection({ overview, onOpenHands }: { overview: OverviewData | null; onOpenHands: (t: string) => void }) {
  if (!overview) return <Card className="h-40 animate-pulse opacity-40" />
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      {overview.tables.map((t) => (
        <Card key={t.tableKey} className="p-5">
          <div className="flex items-start justify-between gap-2">
            <div>
              <h2 className="font-serif text-lg font-bold">{t.name ?? TABLE_NAMES[t.tableKey] ?? t.tableKey}</h2>
              <p className="text-xs text-white/40">key: {t.tableKey}</p>
            </div>
            {t.offline ? (
              <span className="rounded bg-white/10 px-2 py-0.5 text-[10px] font-bold uppercase text-white/40">asleep</span>
            ) : t.inHand ? (
              <span className="rounded bg-rose-500/15 px-2 py-0.5 text-[10px] font-bold uppercase text-rose-300">in hand</span>
            ) : (
              <span className="rounded bg-emerald-500/15 px-2 py-0.5 text-[10px] font-bold uppercase text-emerald-300">waiting</span>
            )}
          </div>
          <dl className="mt-4 grid grid-cols-2 gap-2 text-sm">
            {[
              ['Humans seated', formatChips(t.humansSeated)],
              ['Humans online', formatChips(t.humansConnected)],
              ['Robots seated', formatChips(t.botsSeated)],
              ['Open sockets', formatChips(t.sockets)],
              ['Hands played', formatChips(t.handsPlayed)],
              ['Avg pot', formatChips(t.avgPot)],
            ].map(([k, v]) => (
              <div key={k} className="flex justify-between rounded-lg bg-white/[0.03] px-3 py-1.5">
                <dt className="text-white/45">{k}</dt>
                <dd className="font-semibold tabular-nums text-white">{v}</dd>
              </div>
            ))}
          </dl>
          <button
            type="button"
            onClick={() => onOpenHands(t.tableKey)}
            className="mt-4 w-full rounded-lg bg-emerald-700 px-4 py-2 text-sm font-semibold text-white transition hover:bg-emerald-600"
          >
            <History className="mr-2 inline h-4 w-4" aria-hidden /> View hand history
          </button>
        </Card>
      ))}
    </div>
  )
}

// ---------------- System ----------------

function SystemSection({ overview }: { overview: OverviewData | null }) {
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card className="p-5">
        <h2 className="flex items-center gap-2 text-sm font-bold uppercase tracking-wider text-white/60">
          <Gauge className="h-4 w-4 text-emerald-300" aria-hidden /> Platform
        </h2>
        <dl className="mt-3 space-y-2 text-sm">
          {[
            ['Version', overview?.version ?? '—'],
            ['Server time (UTC)', overview?.serverTime ? new Date(overview.serverTime).toISOString().replace('T', ' ').slice(0, 19) : '—'],
            ['Runtime', 'Cloudflare Workers + Durable Objects'],
            ['Database', 'Cloudflare D1 (SQLite)'],
            ['Realtime', 'WebSocket Hibernation API'],
            ['Scheduling', 'Durable alarms (no polling)'],
          ].map(([k, v]) => (
            <div key={k} className="flex justify-between gap-4 border-b border-white/5 pb-2 last:border-0">
              <dt className="text-white/45">{k}</dt>
              <dd className="text-right font-medium text-white/85">{v}</dd>
            </div>
          ))}
        </dl>
      </Card>
      <Card className="p-5">
        <h2 className="flex items-center gap-2 text-sm font-bold uppercase tracking-wider text-white/60">
          <Database className="h-4 w-4 text-emerald-300" aria-hidden /> Data & retention
        </h2>
        <dl className="mt-3 space-y-2 text-sm">
          {[
            ['Players', overview ? formatChips(overview.stats.totalUsers) : '—'],
            ['Hands stored', overview ? formatChips(overview.stats.handsTotal) : '—'],
            ['Chips in circulation', overview ? formatChips(overview.stats.chipsInCirculation) : '—'],
            ['Hand retention', '14 days (auto-pruned daily at 03:17 UTC)'],
            ['Ledger retention', '90 days (auto-pruned daily)'],
            ['Banned accounts', overview ? formatChips(overview.stats.bannedUsers) : '—'],
          ].map(([k, v]) => (
            <div key={k} className="flex justify-between gap-4 border-b border-white/5 pb-2 last:border-0">
              <dt className="text-white/45">{k}</dt>
              <dd className="text-right font-medium text-white/85">{v}</dd>
            </div>
          ))}
        </dl>
        <p className="mt-4 rounded-lg border border-emerald-500/20 bg-emerald-500/5 p-3 text-xs leading-relaxed text-emerald-200/70">
          Capacity plan: the stack is sized for ~1,000 daily players on the Cloudflare free tier — static
          assets are unmetered, gameplay runs inside hibernating Durable Objects, all writes are batched,
          and a daily cron keeps the database small.
        </p>
      </Card>
    </div>
  )
}
