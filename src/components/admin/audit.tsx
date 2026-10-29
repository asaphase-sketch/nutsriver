'use client'

/**
 * GODMODE audit trail + broadcast console.
 * - Audit: every admin mutation is logged server-side; this renders it.
 * - Broadcast: push announcements to the lobby socket or into every table's
 *   chat as a Dealer message.
 */

import { useCallback, useEffect, useState } from 'react'
import { Loader2, Megaphone, Radio, ScrollText } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Card, fetchJson, timeAgo } from './dashboard'
import type { AuditRow } from './types'

const ACTION_TONE: Record<string, string> = {
  'player.ban': 'bg-rose-500/15 text-rose-300',
  'player.unban': 'bg-emerald-500/15 text-emerald-300',
  'player.delete': 'bg-rose-700/25 text-rose-300',
  'chips.grant': 'bg-emerald-500/10 text-emerald-300',
  'chips.take': 'bg-amber-400/10 text-amber-300',
  'chips.bulk': 'bg-amber-400/15 text-amber-300',
  broadcast: 'bg-sky-500/10 text-sky-300',
}

export function AuditSection() {
  const [log, setLog] = useState<AuditRow[]>([])
  const [loaded, setLoaded] = useState(false)
  const [reloadKey, setReloadKey] = useState(0)
  const reload = useCallback(() => setReloadKey((k) => k + 1), [])

  useEffect(() => {
    let cancelled = false
    fetchJson<{ log: AuditRow[] }>('/api/admin/audit').then((d) => {
      if (cancelled) return
      if (d) setLog(d.log ?? [])
      setLoaded(true)
    })
    return () => {
      cancelled = true
    }
  }, [reloadKey])

  return (
    <Card className="p-4 sm:p-5">
      <div className="flex items-center justify-between gap-3">
        <h2 className="flex items-center gap-2 text-sm font-bold uppercase tracking-wider text-white/60">
          <ScrollText className="h-4 w-4 text-emerald-300" aria-hidden /> Audit trail
        </h2>
        <button
          type="button"
          onClick={reload}
          className="rounded-lg border border-white/10 bg-white/5 p-2 text-white/60 transition hover:bg-white/10 hover:text-white"
          aria-label="Refresh audit log"
        >
          <Loader2 className={cn('h-4 w-4', !loaded && 'animate-spin')} aria-hidden />
        </button>
      </div>
      <ul className="mt-3 space-y-2">
        {log.map((row) => (
          <li key={row.id} className="flex items-start gap-3 rounded-lg border border-white/5 bg-white/[0.03] px-3 py-2.5">
            <span
              className={cn(
                'shrink-0 rounded px-2 py-0.5 text-[10px] font-bold uppercase leading-4',
                ACTION_TONE[row.action] ?? 'bg-white/10 text-white/60',
              )}
            >
              {row.action}
            </span>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm text-white/80">
                <span className="font-semibold text-white">{row.actorName}</span>
                {' → '}
                <span className="text-white/60">{row.target}</span>
              </p>
              {row.detail && <p className="truncate text-xs text-white/45">{row.detail}</p>}
            </div>
            <span className="shrink-0 text-[11px] text-white/35">{timeAgo(row.at)}</span>
          </li>
        ))}
        {log.length === 0 && (
          <li className="py-8 text-center text-sm text-white/35">{loaded ? 'No admin actions recorded yet' : 'Loading…'}</li>
        )}
      </ul>
    </Card>
  )
}

export function BroadcastSection() {
  const [message, setMessage] = useState('')
  const [target, setTarget] = useState<'lobby' | 'tables'>('lobby')
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<{ text: string; ok: boolean } | null>(null)

  const send = async () => {
    setBusy(true)
    setNotice(null)
    try {
      const res = await fetch('/api/admin/broadcast', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: message.trim(), target }),
      })
      const data = (await res.json().catch(() => ({}))) as { ok?: boolean; reached?: number; error?: string }
      if (res.ok && data.ok) {
        setNotice({
          text:
            target === 'lobby'
              ? `Announced to ${data.reached ?? 0} lobby viewer(s)`
              : `Delivered to the chat of ${data.reached ?? 0} table(s)`,
          ok: true,
        })
        setMessage('')
      } else {
        setNotice({ text: data.error ?? 'Broadcast failed', ok: false })
      }
    } catch {
      setNotice({ text: 'Network error', ok: false })
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card className="p-4 sm:p-5">
      <h2 className="flex items-center gap-2 text-sm font-bold uppercase tracking-wider text-white/60">
        <Megaphone className="h-4 w-4 text-amber-300" aria-hidden /> Broadcast
      </h2>
      <p className="mt-1 text-sm text-white/50">
        Push a message to players in real time — the lobby shows a gold banner; table mode posts it into every table&apos;s
        chat as the Dealer.
      </p>

      <div className="mt-4 flex gap-1.5">
        {(
          [
            { id: 'lobby', label: 'Lobby banner', icon: Radio },
            { id: 'tables', label: 'Table chats (as Dealer)', icon: Megaphone },
          ] as const
        ).map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setTarget(t.id)}
            aria-pressed={target === t.id}
            className={cn(
              'flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-semibold transition',
              target === t.id
                ? 'border-amber-300/60 bg-amber-400/15 text-amber-200'
                : 'border-white/10 bg-white/5 text-white/50 hover:text-white',
            )}
          >
            <t.icon className="h-3.5 w-3.5" aria-hidden /> {t.label}
          </button>
        ))}
      </div>

      <textarea
        value={message}
        onChange={(e) => setMessage(e.target.value.slice(0, 200))}
        rows={3}
        placeholder="e.g. Tournament starts in 10 minutes — register now!"
        className="mt-3 w-full resize-none rounded-lg border border-white/10 bg-slate-950/70 px-3 py-2.5 text-sm text-white placeholder:text-white/30 focus:border-emerald-400/50 focus:outline-none"
        aria-label="Announcement message"
      />
      <div className="mt-1 flex items-center justify-between">
        <span className="text-[11px] text-white/35">{message.length}/200</span>
        <button
          type="button"
          onClick={send}
          disabled={busy || !message.trim()}
          className="flex items-center gap-2 rounded-lg bg-gradient-to-b from-amber-400 to-amber-600 px-5 py-2 text-sm font-bold text-slate-950 shadow transition hover:brightness-110 disabled:opacity-50"
        >
          {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Megaphone className="h-4 w-4" aria-hidden />}
          Announce
        </button>
      </div>
      {notice && (
        <p
          role="status"
          className={cn(
            'mt-3 rounded-lg border px-4 py-2 text-sm',
            notice.ok ? 'border-emerald-500/20 bg-emerald-500/10 text-emerald-200' : 'border-rose-500/20 bg-rose-500/10 text-rose-200',
          )}
        >
          {notice.text}
        </p>
      )}
    </Card>
  )
}
