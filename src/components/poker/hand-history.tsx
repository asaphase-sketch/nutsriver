'use client'

/**
 * Player-facing hand history — side-panel "History" tab.
 *
 * Lists the most recent hands dealt at THIS table (newest first) with the
 * requester's net result, and drills into a full detail dialog: board,
 * winners with hand descriptions, participant stacks and the complete action
 * log. Privacy: opponents' hole cards are only included by the server for
 * hands that reached showdown (where they were revealed live anyway); the
 * requester's own cards are always visible.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { ChevronRight, History, RefreshCw } from 'lucide-react'
import { cn } from '@/lib/utils'
import { formatChips } from '@/lib/poker/cards'
import type { ClientTableView } from '@/lib/poker/types'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { ScrollArea } from '@/components/ui/scroll-area'
import { PlayingCard } from './playing-card'

interface HandRow {
  id: string
  tableKey: string
  handNumber: number
  potTotal: number
  winners: string
  at: number
  showdown: boolean
  myNet: number | null
  myCards: string[] | null
  board: string
}

interface HandDetail {
  id: string
  tableKey: string
  handNumber: number
  board: string
  potTotal: number
  results: { userId: string; name: string; amount: number; desc: string; cards: string[] }[]
  participants: { userId: string; name: string; committed: number; cards?: string[] }[]
  log: string[]
  at: number
  showdown: boolean
}

const PAGE = 15
/** grace between the WS snapshot bumping handNumber and the D1 row landing */
const REFRESH_DELAY_MS = 1600

function timeAgo(at: number): string {
  const s = Math.max(1, Math.floor((Date.now() - at) / 1000))
  if (s < 60) return `${s}s ago`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
}

export function HandHistoryPanel({ view }: { view: ClientTableView }) {
  const [hands, setHands] = useState<HandRow[]>([])
  const [loaded, setLoaded] = useState(false)
  const [cursor, setCursor] = useState<number | null>(null)
  const [selected, setSelected] = useState<HandDetail | null>(null)
  const [loadingMore, setLoadingMore] = useState(false)
  const reqIdRef = useRef(0)

  const tableKey = view.tableKey

  const loadFirstPage = useCallback(() => {
    const reqId = ++reqIdRef.current
    fetch(`/api/my/hands?table=${encodeURIComponent(tableKey)}&limit=${PAGE}`)
      .then((r) => (r.ok ? r.json() : { hands: [] }))
      .then((data: { hands?: HandRow[] }) => {
        // a newer load (auto-refresh or remount) supersedes this response
        if (reqId !== reqIdRef.current) return
        const rows = data?.hands ?? []
        setHands(rows)
        setCursor(rows.length ? rows[rows.length - 1]!.at : null)
        setLoaded(true)
      })
      .catch(() => {
        if (reqId === reqIdRef.current) setLoaded(true)
      })
  }, [tableKey])

  // first page on mount + auto-refresh when a new hand starts/finishes —
  // delayed so the server's D1 record has landed before we ask for it
  useEffect(() => {
    const t = setTimeout(loadFirstPage, 300)
    return () => clearTimeout(t)
  }, [loadFirstPage])

  useEffect(() => {
    if (view.handNumber <= 0) return
    const t = setTimeout(loadFirstPage, REFRESH_DELAY_MS)
    return () => clearTimeout(t)
  }, [view.handNumber, loadFirstPage])

  const loadOlder = async () => {
    if (!cursor || loadingMore) return
    setLoadingMore(true)
    try {
      const r = await fetch(`/api/my/hands?table=${encodeURIComponent(tableKey)}&before=${cursor}&limit=${PAGE}`)
      const data = r.ok ? ((await r.json()) as { hands?: HandRow[] }) : { hands: [] }
      const rows = data.hands ?? []
      setHands((prev) => [...prev, ...rows])
      setCursor(rows.length ? rows[rows.length - 1]!.at : null)
    } catch {
      /* keep current list */
    } finally {
      setLoadingMore(false)
    }
  }

  const openHand = async (id: string) => {
    try {
      const r = await fetch(`/api/my/hand?id=${encodeURIComponent(id)}`)
      if (!r.ok) return
      const data = (await r.json()) as { hand?: HandDetail }
      if (data.hand) setSelected(data.hand)
    } catch {
      /* ignore */
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-2">
      <div className="flex items-center justify-between">
        <p className="text-[11px] uppercase tracking-wider text-white/40">
          {hands.length > 0 ? `${hands.length} recent hand${hands.length === 1 ? '' : 's'}` : 'Recent hands'}
        </p>
        <Button
          variant="ghost"
          size="icon"
          className="h-6 w-6 text-white/40 hover:text-white"
          onClick={loadFirstPage}
          aria-label="Refresh history"
        >
          <RefreshCw className="h-3.5 w-3.5" />
        </Button>
      </div>

      <ScrollArea className="min-h-0 flex-1 rounded-md border border-white/10 bg-black/25">
        <ul className="divide-y divide-white/5 pr-1">
          {hands.map((h) => {
            const boardCards = h.board ? h.board.split(' ').filter(Boolean) : []
            const net = h.myNet
            return (
              <li key={h.id}>
                <button
                  type="button"
                  onClick={() => openHand(h.id)}
                  className="flex w-full items-center gap-2 px-2 py-2.5 text-left transition hover:bg-white/[0.04]"
                >
                  <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-amber-400/10">
                    <History className="h-3.5 w-3.5 text-amber-300" aria-hidden />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-1.5">
                      <span className="text-xs font-bold text-white">#{h.handNumber}</span>
                      {h.showdown && (
                        <span className="rounded bg-sky-400/15 px-1 py-px text-[9px] font-bold uppercase tracking-wide text-sky-300">
                          showdown
                        </span>
                      )}
                      <span className="text-[10px] text-white/35">{timeAgo(h.at)}</span>
                    </span>
                    <span className="block truncate text-[11px] text-white/50">
                      {h.winners ? `won by ${h.winners}` : '—'} · pot {formatChips(h.potTotal)}
                    </span>
                  </span>
                  <span className="flex shrink-0 items-center gap-1">
                    {(h.myCards ?? []).map((c, i) => (
                      <PlayingCard key={`${h.id}-${i}`} code={c} size="xs" />
                    ))}
                  </span>
                  {net != null && (
                    <span
                      className={cn(
                        'w-14 shrink-0 text-right text-xs font-bold tabular-nums',
                        net > 0 ? 'text-emerald-300' : net < 0 ? 'text-rose-300' : 'text-white/40',
                      )}
                    >
                      {net > 0 ? '+' : ''}
                      {formatChips(net)}
                    </span>
                  )}
                  <ChevronRight className="h-3.5 w-3.5 shrink-0 text-white/20" aria-hidden />
                </button>
              </li>
            )
          })}
          {!loaded && (
            <li className="px-3 py-10 text-center text-xs text-white/35">Loading history…</li>
          )}
          {loaded && hands.length === 0 && (
            <li className="px-3 py-10 text-center text-xs text-white/35">
              No hands recorded yet at this table — they appear here as soon as one completes
            </li>
          )}
        </ul>
        {cursor && (
          <button
            type="button"
            onClick={loadOlder}
            disabled={loadingMore}
            className="w-full border-t border-white/5 py-2.5 text-[11px] font-semibold text-white/50 transition hover:bg-white/5 hover:text-white disabled:opacity-40"
          >
            {loadingMore ? 'Loading…' : 'Older hands'}
          </button>
        )}
      </ScrollArea>

      {selected && <HandViewerDialog hand={selected} onClose={() => setSelected(null)} />}
    </div>
  )
}

function HandViewerDialog({ hand, onClose }: { hand: HandDetail; onClose: () => void }) {
  const board = hand.board ? hand.board.split(' ').filter(Boolean) : []
  const results = Array.isArray(hand.results) ? hand.results : []
  const participants = Array.isArray(hand.participants) ? hand.participants : []

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[85vh] max-w-2xl overflow-y-auto bg-slate-950 text-white">
        <DialogHeader>
          <DialogTitle className="font-serif text-xl">
            Hand #{hand.handNumber} <span className="text-sm font-normal text-white/45">· pot {formatChips(hand.potTotal)}</span>
          </DialogTitle>
          <p className="text-xs text-white/45">
            {timeAgo(hand.at)}
            {hand.showdown ? ' · showdown — all revealed cards shown' : ' · ended by folds — opponents’ cards stay hidden'}
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

        {/* winners */}
        {results.length > 0 && (
          <section>
            <h3 className="mb-2 text-[11px] font-bold uppercase tracking-widest text-white/40">Winners</h3>
            <div className="space-y-2">
              {results.map((r, i) => (
                <div
                  key={`${r.userId}-${i}`}
                  className="flex flex-wrap items-center gap-2 rounded-lg border border-emerald-500/20 bg-emerald-500/5 px-3 py-2"
                >
                  <span className="font-semibold text-emerald-200">{r.name}</span>
                  <span className="text-sm font-bold text-emerald-300">+{formatChips(r.amount)}</span>
                  <span className="text-xs text-white/50">{r.desc}</span>
                </div>
              ))}
            </div>
          </section>
        )}

        {/* participants */}
        {participants.length > 0 && (
          <section>
            <h3 className="mb-2 text-[11px] font-bold uppercase tracking-widest text-white/40">Players</h3>
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
                          {isBot && (
                            <span className="ml-2 rounded bg-amber-400/10 px-1.5 py-0.5 text-[9px] font-bold uppercase text-amber-300">
                              robot
                            </span>
                          )}
                        </td>
                        <td className="px-3 py-2">
                          <span className="flex gap-1">
                            {(p.cards ?? []).map((code, j) => (
                              <PlayingCard key={j} code={code} size="xs" />
                            ))}
                            {(p.cards ?? []).length === 0 && <span className="text-xs text-white/30">hidden</span>}
                          </span>
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums text-white/60">{formatChips(p.committed)}</td>
                        <td
                          className={cn(
                            'px-3 py-2 text-right font-bold tabular-nums',
                            net > 0 ? 'text-emerald-300' : net < 0 ? 'text-rose-300' : 'text-white/50',
                          )}
                        >
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
            <ol className="max-h-56 space-y-1 overflow-y-auto rounded-lg border border-white/10 bg-black/30 p-3 font-mono text-[11px] text-white/70">
              {hand.log.map((line, i) => (
                <li
                  key={i}
                  className={cn(
                    line.startsWith('---') && 'font-bold text-amber-200/80',
                    line.includes('ALL IN') && 'text-rose-300',
                  )}
                >
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
