'use client'

import { useCallback, useEffect, useState } from 'react'
import { ChevronRight, History } from 'lucide-react'
import { cn } from '@/lib/utils'
import { formatChips } from '@/lib/poker/cards'
import { cardCode } from '@/lib/poker-engine/cards'
import { PlayingCard } from '@/components/poker/playing-card'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Card, fetchJson, tableDisplayName, timeAgo } from './dashboard'
import type { HandDetail, HandRow } from './types'

const TABLE_KEYS = ['beginners', 'greenroom', 'riverkings', 'highrollers'] as const

interface HandsSectionProps {
  tableFilter: string | null
  onFilterChange: (t: string | null) => void
}

export function HandsSection({ tableFilter, onFilterChange }: HandsSectionProps) {
  const [hands, setHands] = useState<HandRow[]>([])
  const [loaded, setLoaded] = useState(false)
  const [cursor, setCursor] = useState<number | null>(null)
  const [selected, setSelected] = useState<HandDetail | null>(null)
  const [reloadKey, setReloadKey] = useState(0)

  // (re)load the first page whenever the table filter changes
  useEffect(() => {
    let cancelled = false
    const params = new URLSearchParams()
    if (tableFilter) params.set('table', tableFilter)
    params.set('limit', '30')
    fetchJson<{ hands: HandRow[] }>(`/api/admin/hands?${params}`).then((data) => {
      if (cancelled) return
      const rows = data?.hands ?? []
      setHands(rows)
      setCursor(rows.length ? rows[rows.length - 1]!.at : null)
      setLoaded(true)
    })
    return () => {
      cancelled = true
    }
  }, [tableFilter, reloadKey])

  const loadOlder = async () => {
    if (!cursor) return
    const params = new URLSearchParams()
    if (tableFilter) params.set('table', tableFilter)
    params.set('before', String(cursor))
    params.set('limit', '30')
    const data = await fetchJson<{ hands: HandRow[] }>(`/api/admin/hands?${params}`)
    if (data) {
      const rows = data.hands ?? []
      setHands((prev) => [...prev, ...rows])
      setCursor(rows.length ? rows[rows.length - 1]!.at : cursor)
    }
  }

  const openHand = async (id: string) => {
    const data = await fetchJson<{ hand: HandDetail }>(`/api/admin/hand?id=${encodeURIComponent(id)}`)
    if (data?.hand) setSelected(data.hand)
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => onFilterChange(null)}
          className={cn(
            'rounded-full px-3 py-1.5 text-xs font-semibold transition',
            tableFilter == null ? 'bg-emerald-500/15 text-emerald-200' : 'bg-white/5 text-white/50 hover:bg-white/10',
          )}
        >
          All tables
        </button>
        {TABLE_KEYS.map((key) => (
          <button
            key={key}
            type="button"
            onClick={() => onFilterChange(key)}
            className={cn(
              'rounded-full px-3 py-1.5 text-xs font-semibold transition',
              tableFilter === key ? 'bg-emerald-500/15 text-emerald-200' : 'bg-white/5 text-white/50 hover:bg-white/10',
            )}
          >
            {tableDisplayName(key)}
          </button>
        ))}
        <span className="ml-auto text-xs text-white/35">Every hand dealt on the site — newest first</span>
      </div>

      <Card>
        <ul className="divide-y divide-white/5">
          {hands.map((h) => (
            <li key={h.id}>
              <button
                type="button"
                onClick={() => openHand(h.id)}
                className="flex w-full items-center gap-3 px-4 py-3 text-left transition hover:bg-white/[0.04]"
              >
                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-amber-400/10">
                  <History className="h-4 w-4 text-amber-300" aria-hidden />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-semibold text-white">
                    Hand #{h.handNumber} <span className="font-normal text-white/40">at {tableDisplayName(h.tableKey) ?? h.tableKey}</span>
                  </p>
                  <p className="truncate text-xs text-white/40">
                    {timeAgo(h.at)} · won by {h.winners || '—'}
                  </p>
                </div>
                <span className="shrink-0 text-sm font-bold tabular-nums text-emerald-300">{formatChips(h.potTotal)}</span>
                <ChevronRight className="h-4 w-4 shrink-0 text-white/25" aria-hidden />
              </button>
            </li>
          ))}
          {hands.length === 0 && (
            <li className="px-4 py-12 text-center text-sm text-white/40">
              {loaded ? 'No hands recorded yet — play a hand first, or wait for the tables to run' : 'Loading…'}
            </li>
          )}
        </ul>
        {hands.length >= 30 && (
          <button
            type="button"
            onClick={() => loadOlder()}
            className="w-full border-t border-white/5 py-3 text-xs font-semibold text-white/50 transition hover:bg-white/5 hover:text-white"
          >
            Load older hands
          </button>
        )}
      </Card>

      {selected && <HandViewer hand={selected} onClose={() => setSelected(null)} />}
    </div>
  )
}

function HandViewer({ hand, onClose }: { hand: HandDetail; onClose: () => void }) {
  const board = hand.board ? hand.board.split(' ').filter(Boolean) : []
  const results = Array.isArray(hand.results) ? hand.results : []
  const participants = Array.isArray(hand.participants) ? hand.participants : []

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[85vh] max-w-2xl overflow-y-auto bg-slate-950 text-white">
        <DialogHeader>
          <DialogTitle className="font-serif text-xl">
            Hand #{hand.handNumber} — {tableDisplayName(hand.tableKey) ?? hand.tableKey}
          </DialogTitle>
          <p className="text-sm text-white/45">
            {new Date(hand.at).toISOString().replace('T', ' ').slice(0, 16)} UTC · pot {formatChips(hand.potTotal)} chips
          </p>
        </DialogHeader>

        {/* board */}
        <section>
          <h3 className="mb-2 text-[11px] font-bold uppercase tracking-widest text-white/40">Board</h3>
          <div className="flex gap-1.5">
            {board.map((code, i) => (
              <PlayingCard key={`${code}-${i}`} code={code} size="sm" />
            ))}
            {board.length === 0 && <span className="text-sm text-white/35">No board (won before the flop)</span>}
          </div>
        </section>

        {/* results */}
        {results.length > 0 && (
          <section>
            <h3 className="mb-2 text-[11px] font-bold uppercase tracking-widest text-white/40">Winners</h3>
            <div className="space-y-2">
              {results.map((r, i) => (
                <div key={`${r.userId}-${i}`} className="flex flex-wrap items-center gap-2 rounded-lg border border-emerald-500/20 bg-emerald-500/5 px-3 py-2">
                  <span className="font-semibold text-emerald-200">{r.name}</span>
                  <span className="text-sm font-bold text-emerald-300">+{formatChips(r.amount)}</span>
                  <span className="text-xs text-white/50">{r.desc}</span>
                  <span className="ml-auto flex gap-1">
                    {(r.cards ?? []).map((c, j) => (
                      <PlayingCard key={j} code={cardCode(c)} size="xs" />
                    ))}
                  </span>
                </div>
              ))}
            </div>
          </section>
        )}

        {/* participants */}
        {participants.length > 0 && (
          <section>
            <h3 className="mb-2 text-[11px] font-bold uppercase tracking-widest text-white/40">
              Players at the table <span className="normal-case text-white/30">(admin view — all hole cards)</span>
            </h3>
            <div className="overflow-hidden rounded-lg border border-white/10">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-white/5 text-left text-xs text-white/40">
                    <th className="px-3 py-2 font-medium">Player</th>
                    <th className="px-3 py-2 font-medium">Cards</th>
                    <th className="px-3 py-2 text-right font-medium">Committed</th>
                    <th className="px-3 py-2 text-right font-medium">Net</th>
                  </tr>
                </thead>
                <tbody>
                  {participants.map((p, i) => {
                    const won = results.filter((r) => r.userId === p.userId).reduce((a, r) => a + r.amount, 0)
                    const net = won - p.committed
                    const isBot = p.userId.startsWith('bot:')
                    return (
                      <tr key={`${p.userId}-${i}`} className="border-t border-white/5">
                        <td className="px-3 py-2">
                          <span className="font-semibold text-white">{p.name}</span>
                          {isBot && <span className="ml-2 rounded bg-amber-400/10 px-1.5 py-0.5 text-[9px] font-bold uppercase text-amber-300">robot</span>}
                        </td>
                        <td className="px-3 py-2">
                          <span className="flex gap-1">
                            {(p.cards ?? []).map((code, j) => (
                              <PlayingCard key={j} code={code} size="xs" />
                            ))}
                            {(p.cards ?? []).length === 0 && <span className="text-white/30">—</span>}
                          </span>
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums text-white/60">{formatChips(p.committed)}</td>
                        <td className={cn('px-3 py-2 text-right font-bold tabular-nums', net > 0 ? 'text-emerald-300' : net < 0 ? 'text-rose-300' : 'text-white/50')}>
                          {net > 0 ? '+' : ''}
                          {formatChips(net)}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </section>
        )}

        {/* action log */}
        {hand.log.length > 0 && (
          <section>
            <h3 className="mb-2 text-[11px] font-bold uppercase tracking-widest text-white/40">Action log</h3>
            <ol className="max-h-64 space-y-1 overflow-y-auto rounded-lg border border-white/10 bg-black/30 p-3 font-mono text-xs text-white/70">
              {hand.log.map((line, i) => (
                <li key={i} className={cn(line.startsWith('---') && 'font-bold text-amber-200/80', line.includes('ALL IN') && 'text-rose-300')}>
                  {line}
                </li>
              ))}
            </ol>
          </section>
        )}
      </DialogContent>
    </Dialog>
  )
}
