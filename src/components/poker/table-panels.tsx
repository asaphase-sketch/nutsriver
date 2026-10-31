'use client'

/**
 * Energy-Tilt table panels — the left column (chat / last hand / session
 * stats / hand log + full history) and the right column (table info / your
 * seat) of the table screen. Every value shown is REAL server data: chat and
 * the action log stream over the table socket, the last-hand recap comes from
 * the snapshot summary, and stats come from the live lobby counters.
 */

import { useEffect, useRef, useState } from 'react'
import { Bot, Coins, Gauge, History, Info, ListOrdered, MessageSquare, Send, Sparkles, Users } from 'lucide-react'
import { cn } from '@/lib/utils'
import { formatChips, PHASE_LABEL } from '@/lib/poker/cards'
import { GAME_LABEL, type ChatMessage, type ClientTableView, type LobbyTableSummary } from '@/lib/poker/types'
import { Input } from '@/components/ui/input'
import { ScrollArea } from '@/components/ui/scroll-area'
import { PlayingCard } from './playing-card'
import { HandHistoryPanel } from './hand-history'

/* chat name colors — stable per name hash (sample-style colored senders) */
const NAME_COLORS = [
  'text-orange-300',
  'text-sky-300',
  'text-emerald-300',
  'text-fuchsia-300',
  'text-amber-300',
  'text-rose-300',
  'text-lime-300',
  'text-violet-300',
]
function nameColor(name: string): string {
  let h = 0
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) | 0
  return NAME_COLORS[Math.abs(h) % NAME_COLORS.length]!
}

function PanelShell({
  title,
  icon,
  children,
  className,
  bodyClassName,
}: {
  title: string
  icon: React.ReactNode
  children: React.ReactNode
  className?: string
  bodyClassName?: string
}) {
  return (
    <section className={cn('neon-panel flex min-h-0 flex-col overflow-hidden', className)}>
      <header className="flex items-center gap-1.5 border-b border-orange-300/10 px-3 py-2">
        {icon}
        <h3 className="text-[10px] font-black uppercase tracking-[0.14em] text-orange-200/90">{title}</h3>
      </header>
      <div className={cn('min-h-0 flex-1', bodyClassName)}>{children}</div>
    </section>
  )
}

/* ==================== LEFT COLUMN ==================== */

/** TABLE CHAT — live room chat with input. */
export function TableChatPanel({
  messages,
  onSend,
  className,
}: {
  messages: ChatMessage[]
  onSend: (text: string) => void
  className?: string
}) {
  const [text, setText] = useState('')
  const areaRef = useRef<HTMLDivElement>(null)

  // auto-scroll the panel viewport (never scrollIntoView — it yanks the page)
  const scrollToBottom = () => {
    const vp = areaRef.current?.querySelector<HTMLElement>('[data-radix-scroll-area-viewport]')
    if (vp) vp.scrollTop = vp.scrollHeight
  }
  useEffect(() => {
    scrollToBottom()
  }, [messages.length])

  const submit = () => {
    const t = text.trim().slice(0, 200)
    if (!t) return
    onSend(t)
    setText('')
  }

  return (
    <PanelShell title="Table chat" icon={<MessageSquare className="h-3.5 w-3.5 text-orange-300" aria-hidden />} className={className}>
      <div ref={areaRef} className="flex h-full min-h-0 flex-col gap-2 p-2">
        <ScrollArea className="min-h-0 flex-1">
          <div className="space-y-1 pr-3">
            {messages.length === 0 && (
              <p className="py-5 text-center text-[11px] text-white/35">No messages yet — say hello</p>
            )}
            {messages.map((m) => (
              <p key={m.id} className={cn('text-[11px] leading-snug', m.system ? 'italic text-white/40' : 'text-white/85')}>
                {!m.system && <span className={cn('font-bold', nameColor(m.name))}>{m.name}: </span>}
                {m.text}
              </p>
            ))}
          </div>
        </ScrollArea>
        <form
          className="flex shrink-0 gap-1.5"
          onSubmit={(e) => {
            e.preventDefault()
            submit()
          }}
        >
          <Input
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Type a message…"
            maxLength={200}
            aria-label="Chat message"
            className="h-8 border-orange-300/15 bg-black/30 text-xs text-white placeholder:text-white/25 focus-visible:ring-orange-400/40"
          />
          <button
            type="submit"
            aria-label="Send chat"
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-gradient-to-b from-orange-400 to-orange-600 text-slate-950 shadow-md shadow-orange-900/40 transition hover:brightness-110"
          >
            <Send className="h-3.5 w-3.5" />
          </button>
        </form>
      </div>
    </PanelShell>
  )
}

/** LAST HAND — recap of the most recent hand (board + winners), real data. */
export function LastHandPanel({ view, className }: { view: ClientTableView; className?: string }) {
  const s = view.lastSummary
  const winners = s?.results.filter((r) => r.amount > 0) ?? []
  return (
    <PanelShell title="Last hand" icon={<History className="h-3.5 w-3.5 text-orange-300" aria-hidden />} className={className}>
      <div className="space-y-2 p-3">
        {s && s.board.length > 0 ? (
          <>
            <div className="flex gap-1">
              {s.board.map((code, i) => (
                <PlayingCard key={`${s.handNumber}-${i}`} code={code} size="xs" />
              ))}
            </div>
            <p className="text-[11px] font-semibold text-emerald-300">
              {winners.length > 0
                ? `Won ${formatChips(s.potTotal)} — ${winners.map((w) => w.name).join(' & ')}`
                : `Hand #${s.handNumber} · ${formatChips(s.potTotal)} pot`}
            </p>
          </>
        ) : (
          <p className="text-[11px] leading-relaxed text-white/40">
            The previous hand&apos;s board, pot and winners appear here as soon as one completes.
          </p>
        )}
      </div>
    </PanelShell>
  )
}

/** TABLE STATS — live counters for THIS table (lobby feed + snapshot). */
export function TableStatsPanel({
  view,
  lobby,
  className,
}: {
  view: ClientTableView
  lobby: LobbyTableSummary | undefined
  className?: string
}) {
  const seated = view.seats.filter((s) => s.status !== 'EMPTY').length
  const stats: { value: string; label: string }[] = [
    { value: `#${view.handNumber || '—'}`, label: 'Hand' },
    { value: lobby ? formatChips(lobby.avgPot) : '—', label: 'Avg pot' },
    { value: `${seated}/${view.maxSeats}`, label: 'Seated' },
  ]
  return (
    <PanelShell title="Table stats" icon={<Gauge className="h-3.5 w-3.5 text-orange-300" aria-hidden />} className={className}>
      <div className="grid grid-cols-3 gap-1 p-3 text-center">
        {stats.map((s) => (
          <div key={s.label}>
            <p className="text-sm font-black tabular-nums text-orange-100">{s.value}</p>
            <p className="mt-0.5 text-[9px] font-semibold uppercase tracking-wider text-white/40">{s.label}</p>
          </div>
        ))}
      </div>
    </PanelShell>
  )
}

/** HAND LOG — the live action log of the current/previous hand + full history. */
export function HandLogPanel({ view, className }: { view: ClientTableView; className?: string }) {
  const [showHistory, setShowHistory] = useState(false)
  const logRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = logRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [view.log.length])
  return (
    <PanelShell
      title="Hand log"
      icon={<ListOrdered className="h-3.5 w-3.5 text-orange-300" aria-hidden />}
      className={className}
      bodyClassName="flex flex-col"
    >
      <div ref={logRef} className="min-h-0 flex-1 overflow-y-auto p-2">
        <div className="space-y-0.5">
          {view.log.map((line, i) => (
            <p
              key={i}
              className={cn(
                'font-mono text-[10px] leading-relaxed',
                line.startsWith('---') ? 'font-bold text-orange-300/80' : 'text-white/60',
              )}
            >
              {line}
            </p>
          ))}
        </div>
      </div>
      <button
        type="button"
        onClick={() => setShowHistory((v) => !v)}
        aria-expanded={showHistory}
        className="shrink-0 border-t border-orange-300/10 px-3 py-2 text-left text-[10px] font-bold uppercase tracking-wider text-orange-200/80 transition hover:text-orange-100"
      >
        {showHistory ? 'Hide full history ▲' : 'Full history & replayer ▼'}
      </button>
      {showHistory && (
        <div className="max-h-72 shrink-0 overflow-y-auto border-t border-orange-300/10 p-2">
          <HandHistoryPanel view={view} />
        </div>
      )}
    </PanelShell>
  )
}

/* ==================== RIGHT COLUMN ==================== */

function InfoRow({ icon, label, value }: { icon: React.ReactNode; label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2.5 px-3 py-2">
      <span className="text-orange-300/80">{icon}</span>
      <span className="w-16 shrink-0 text-[10px] font-semibold uppercase tracking-wider text-white/40">{label}</span>
      <span className="ml-auto text-right text-xs font-bold tabular-nums text-white/90">{value}</span>
    </div>
  )
}

/** TABLE INFO — stakes, game, buy-in range, occupancy (all from the snapshot). */
export function TableInfoPanel({
  view,
  tourneyName,
  playersLeft,
  levelLabel,
  className,
}: {
  view: ClientTableView
  tourneyName?: string
  playersLeft?: number
  levelLabel?: string
  className?: string
}) {
  const seated = view.seats.filter((s) => s.status !== 'EMPTY').length
  const gameType = view.gameType ?? 'holdem'
  return (
    <PanelShell title="Table info" icon={<Info className="h-3.5 w-3.5 text-orange-300" aria-hidden />} className={className}>
      <div className="divide-y divide-white/5 py-0.5">
        <InfoRow icon={<Sparkles className="h-3.5 w-3.5" aria-hidden />} label="Game" value={GAME_LABEL[gameType]} />
        <InfoRow icon={<Coins className="h-3.5 w-3.5" aria-hidden />} label="Stakes" value={`${formatChips(view.smallBlind)} / ${formatChips(view.bigBlind)}`} />
        {tourneyName ? (
          <>
            <InfoRow icon={<Info className="h-3.5 w-3.5" aria-hidden />} label="Event" value={<span className="line-clamp-1">{tourneyName}</span>} />
            <InfoRow icon={<Users className="h-3.5 w-3.5" aria-hidden />} label="Left" value={playersLeft != null ? `${playersLeft} players` : '—'} />
            <InfoRow icon={<Gauge className="h-3.5 w-3.5" aria-hidden />} label="Blinds" value={levelLabel ?? `${formatChips(view.smallBlind)} / ${formatChips(view.bigBlind)}`} />
          </>
        ) : (
          <InfoRow icon={<Coins className="h-3.5 w-3.5" aria-hidden />} label="Buy-in" value={`${formatChips(view.minBuyIn)} – ${formatChips(view.maxBuyIn)}`} />
        )}
        <InfoRow icon={<Users className="h-3.5 w-3.5" aria-hidden />} label="Players" value={`${seated} / ${view.maxSeats}`} />
        <InfoRow
          icon={<Bot className="h-3.5 w-3.5" aria-hidden />}
          label="Status"
          value={`${PHASE_LABEL[view.phase]}${view.handNumber ? ` · #${view.handNumber}` : ''}`}
        />
      </div>
    </PanelShell>
  )
}
