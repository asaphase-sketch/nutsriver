'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useToast } from '@/hooks/use-toast'
import type {
  ChatMessage,
  ClientTableView,
  LobbyTableSummary,
  PokerUser,
  TournamentLobbyItem,
} from '@/lib/poker/types'

/** Realtime endpoint — one WebSocket per subscribed table (?table=<key>). */
export const POKER_SOCKET_PATH = '/api/poker-socket'

export interface PokerClient {
  authChecked: boolean
  user: PokerUser | null
  connected: boolean
  chips: number
  lobbyTables: LobbyTableSummary[]
  tournaments: TournamentLobbyItem[]
  /** live snapshots per subscribed table key */
  tableViews: Record<string, ClientTableView>
  /** chat history per table key */
  chats: Record<string, ChatMessage[]>
  /** admin broadcasts pushed through the LobbyDO socket (most recent last) */
  announcements: { id: string; message: string; at: number }[]
  dismissAnnouncement: (id: string) => void
  /** table currently open in the UI (null = lobby) */
  activeTable: string | null
  setActiveTable: (key: string | null) => void
  login: (username: string, password: string) => Promise<PokerUser>
  register: (username: string, password: string) => Promise<PokerUser>
  logout: () => Promise<void>
  sitDown: (tableKey: string, seatIndex: number, buyIn: number) => void
  subscribeTable: (tableKey: string) => void
  unsubscribeTable: (tableKey: string) => void
  standUp: (tableKey: string) => void
  setSitOut: (tableKey: string, sitOut: boolean) => void
  rebuy: (tableKey: string, amount: number) => void
  act: (tableKey: string, type: 'fold' | 'check' | 'call' | 'bet' | 'raise', amount?: number) => void
  sendChat: (tableKey: string, text: string) => void
  claimFreeChips: () => void
  registerTournament: (id: string) => Promise<boolean>
  joinTournament: (id: string) => Promise<void>
  refreshTournaments: () => void
}

type OutMsg =
  | { t: 'sit'; seatIndex: number; buyIn: number }
  | { t: 'stand' }
  | { t: 'sitout'; sitOut: boolean }
  | { t: 'rebuy'; amount: number }
  | { t: 'action'; type: 'fold' | 'check' | 'call' | 'bet' | 'raise'; amount?: number }
  | { t: 'chat'; text: string }

function wsUrl(tableKey: string): string {
  const proto = typeof location !== 'undefined' && location.protocol === 'https:' ? 'wss' : 'ws'
  return `${proto}://${location.host}${POKER_SOCKET_PATH}?table=${encodeURIComponent(tableKey)}`
}

export function usePoker(): PokerClient {
  const { toast } = useToast()
  const [authChecked, setAuthChecked] = useState(false)
  const [user, setUser] = useState<PokerUser | null>(null)
  const [connected, setConnected] = useState(false)
  const [chips, setChips] = useState(0)
  const [announcements, setAnnouncements] = useState<{ id: string; message: string; at: number }[]>([])
  const [lobbyTables, setLobbyTables] = useState<LobbyTableSummary[]>([])
  const [tournaments, setTournaments] = useState<TournamentLobbyItem[]>([])
  const [tableViews, setTableViews] = useState<Record<string, ClientTableView>>({})
  const [chats, setChats] = useState<Record<string, ChatMessage[]>>({})
  const [activeTable, setActiveTable] = useState<string | null>(null)

  const socketsRef = useRef<Map<string, WebSocket>>(new Map())
  const retryRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map())
  const attemptsRef = useRef<Map<string, number>>(new Map())
  const connectRef = useRef<(key: string) => void>(() => {})
  const subscribedRef = useRef<Set<string>>(new Set())
  const pendingSitRef = useRef<{ tableKey: string; seatIndex: number; buyIn: number } | null>(null)
  /** true while the LobbyDO socket is delivering live lobby/tournament pushes */
  const lobbyLiveRef = useRef(false)
  /** last authoritative personal tournament fields per id — overlays server pushes */
  const tourOverlayRef = useRef<Map<string, Partial<TournamentLobbyItem>>>(new Map())
  // synchronous mirrors of state used by teardown decisions — React state and
  // render-scoped refs lag one commit behind imperative flows like sitDown
  const activeTableRef = useRef<string | null>(null)
  const tableViewsRef = useRef<Record<string, ClientTableView>>({})
  const toastRef = useRef(toast)
  /** whether a logged-in user exists — the socket lifecycle keys off this only */
  const authed = user != null

  // authoritative active-table switch — updates the mirror ref synchronously so
  // teardown decisions (and effects) never act on a stale value
  const setActiveTableSafe = useCallback((key: string | null) => {
    activeTableRef.current = key
    setActiveTable(key)
  }, [])

  useEffect(() => {
    toastRef.current = toast
  }, [toast])

  // ---------- auth bootstrap ----------
  useEffect(() => {
    let cancelled = false
    fetch('/api/auth/me')
      .then((r) => r.json())
      .then((data) => {
        if (!cancelled && data?.user) {
          setUser(data.user)
          setChips(data.user.chips ?? 0)
        }
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setAuthChecked(true)
      })
    return () => {
      cancelled = true
    }
  }, [])

  const syncConnected = useCallback(() => {
    let open = 0
    for (const ws of socketsRef.current.values()) {
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) open++
    }
    setConnected(open > 0)
  }, [])

  const send = useCallback((key: string, msg: OutMsg) => {
    const ws = socketsRef.current.get(key)
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg))
  }, [])

  const disconnect = useCallback(
    (key: string) => {
      const retry = retryRef.current.get(key)
      if (retry) {
        clearTimeout(retry)
        retryRef.current.delete(key)
      }
      attemptsRef.current.delete(key)
      const ws = socketsRef.current.get(key)
      if (ws) {
        socketsRef.current.delete(key)
        ws.onclose = null
        ws.onerror = null
        ws.onmessage = null
        ws.onopen = null
        try {
          ws.close()
        } catch {
          /* already closed */
        }
      }
      syncConnected()
    },
    [syncConnected],
  )

  const connect = useCallback(
    (key: string) => {
      if (socketsRef.current.has(key) || typeof window === 'undefined') return
      let ws: WebSocket
      try {
        ws = new WebSocket(wsUrl(key))
      } catch {
        return
      }
      socketsRef.current.set(key, ws)

      ws.onopen = () => {
        attemptsRef.current.delete(key)
        syncConnected()
        ws.send(JSON.stringify({ t: 'hello' }))
        const sit = pendingSitRef.current
        if (sit && sit.tableKey === key) {
          pendingSitRef.current = null
          ws.send(JSON.stringify({ t: 'sit', seatIndex: sit.seatIndex, buyIn: sit.buyIn } satisfies OutMsg))
        }
      }

      ws.onmessage = (ev) => {
        let data: any
        try {
          data = JSON.parse(typeof ev.data === 'string' ? ev.data : '')
        } catch {
          return
        }
        if (data?.t === 'lobby' && Array.isArray(data.tables)) {
          // live lobby push from LobbyDO — outbound pushes are free on the DO,
          // so this replaces per-client polling entirely (charter §2)
          lobbyLiveRef.current = true
          setLobbyTables(data.tables as LobbyTableSummary[])
          // a recent admin announcement is replayed on (re)connect
          if (data.announcement?.message) {
            const a = {
              id: String(data.announcement.at ?? Date.now()),
              message: String(data.announcement.message).slice(0, 200),
              at: Number(data.announcement.at) || Date.now(),
            }
            setAnnouncements((prev) => (prev.some((x) => x.id === a.id) ? prev : [...prev, a].slice(-3)))
          }
          if (Array.isArray(data.tournaments)) {
            setTournaments(
              (data.tournaments as TournamentLobbyItem[]).map((t) => {
                const o = tourOverlayRef.current.get(t.id)
                return o ? { ...t, ...o } : t
              }),
            )
          }
        } else if (data?.t === 'announcement' && data.message) {
          // admin broadcast pushed through the LobbyDO socket
          const a = { id: String(data.at ?? Date.now()), message: String(data.message).slice(0, 200), at: Number(data.at) || Date.now() }
          setAnnouncements((prev) => [...prev.filter((x) => x.id !== a.id), a].slice(-3))
        } else if (data?.t === 'state' && data.view?.tableKey) {
          const view = data.view as ClientTableView
          tableViewsRef.current = { ...tableViewsRef.current, [view.tableKey]: view }
          setTableViews((prev) => ({ ...prev, [view.tableKey]: view }))
        } else if (data?.t === 'chatHistory' && data.tableKey) {
          setChats((prev) => ({ ...prev, [data.tableKey]: data.messages ?? [] }))
        } else if (data?.t === 'chatMsg' && data.msg?.id) {
          const msg = data.msg as ChatMessage
          setChats((prev) => {
            const k = msg.tableKey ?? key
            const list = prev[k] ?? []
            if (list.some((m) => m.id === msg.id)) return prev
            return { ...prev, [k]: [...list, msg].slice(-80) }
          })
        } else if (data?.t === 'chips' && typeof data.chips === 'number') {
          // chips state only — mutating `user` here would re-trigger effects
          setChips(data.chips)
        } else if (data?.t === 'err') {
          const message = data.message || 'Something went wrong'
          if (data.nextAt) {
            const when = new Date(data.nextAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
            toastRef.current({ title: 'Free chips', description: `${message} — next top-up at ${when}`, variant: 'destructive' })
          } else {
            toastRef.current({ title: 'Poker', description: message, variant: 'destructive' })
          }
        }
      }

      ws.onclose = (ev) => {
        socketsRef.current.delete(key)
        syncConnected()
        if (key === 'lobby') lobbyLiveRef.current = false
        // 1008 = policy violation (auth rejected) — do not retry
        if (ev.code === 1008 || !subscribedRef.current.has(key)) return
        const attempts = (attemptsRef.current.get(key) ?? 0) + 1
        attemptsRef.current.set(key, attempts)
        const delay = Math.min(1000 * attempts, 5000)
        const timer = setTimeout(() => {
          retryRef.current.delete(key)
          if (subscribedRef.current.has(key)) connectRef.current(key)
        }, delay)
        retryRef.current.set(key, timer)
      }

      ws.onerror = () => {
        /* close handler drives reconnection */
      }
    },
    [syncConnected],
  )

  // ---------- teardown on logout ----------
  const teardownSockets = useCallback(() => {
    for (const key of [...socketsRef.current.keys()]) disconnect(key)
    subscribedRef.current = new Set()
    pendingSitRef.current = null
  }, [disconnect])

  useEffect(() => {
    connectRef.current = connect
  }, [connect])

  // ---------- reload recovery: which tables hold my seat? ----------
  useEffect(() => {
    if (!authed) return
    let cancelled = false
    fetch('/api/my-tables')
      .then((r) => (r.ok ? r.json() : { tables: [] }))
      .then((data: { tables: string[] }) => {
        if (cancelled || !data.tables?.length) return
        for (const key of data.tables) {
          subscribedRef.current.add(key)
          connect(key)
        }
        // restore the table view after a page reload
        setActiveTableSafe(activeTableRef.current ?? data.tables[0]!)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [authed, connect, setActiveTableSafe])

  // ---------- live lobby: one always-on LobbyDO socket replaces polling ----------
  // Outbound server pushes are free on hibernating DOs, so a single socket per
  // client is dramatically cheaper than every client polling (charter §2).
  useEffect(() => {
    if (!authed) return
    subscribedRef.current.add('lobby')
    connect('lobby')
  }, [authed, connect])

  // ---------- lobby polling (FALLBACK ONLY — runs while the lobby socket is down) ----------
  // Polls only while the lobby is on screen: paused when the tab is hidden,
  // while a table view is open, and whenever the live lobby socket is delivering.
  useEffect(() => {
    if (!authed) return
    let cancelled = false
    const load = () =>
      fetch('/api/lobby')
        .then((r) => (r.ok ? r.json() : { tables: [] }))
        .then((data: { tables: LobbyTableSummary[] }) => {
          if (!cancelled) setLobbyTables(data.tables ?? [])
        })
        .catch(() => {})
    const maybeLoad = () => {
      if (document.visibilityState !== 'visible') return
      if (activeTableRef.current != null) return
      if (lobbyLiveRef.current) return
      load()
    }
    maybeLoad()
    const id = setInterval(maybeLoad, 15000)
    const onVisibility = () => {
      if (document.visibilityState === 'visible') maybeLoad()
    }
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      cancelled = true
      clearInterval(id)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [authed])

  // ---------- tournaments (live push via lobby socket; HTTP is authoritative seed + fallback) ----------
  const refreshTournaments = useCallback(() => {
    fetch('/api/tournaments')
      .then((r) => (r.ok ? r.json() : { tournaments: [] }))
      .then((data: { tournaments: TournamentLobbyItem[] }) => {
        const list = data.tournaments ?? []
        // remember the authoritative personal fields — lobby pushes carry only
        // the shared view, so the personal state overlays on top
        const overlay = tourOverlayRef.current
        overlay.clear()
        for (const t of list) {
          overlay.set(t.id, {
            myEntry: t.myEntry,
            myTableKey: t.myTableKey,
            finishPlace: t.finishPlace,
            prizeWon: t.prizeWon,
            bountyWon: t.bountyWon,
            registeredAt: t.registeredAt,
          })
        }
        setTournaments(list)
      })
      .catch(() => {})
  }, [])

  useEffect(() => {
    if (!authed) return
    refreshTournaments()
    const id = setInterval(() => {
      if (document.visibilityState !== 'visible') return
      if (activeTableRef.current != null) return
      if (lobbyLiveRef.current) return
      refreshTournaments()
    }, 15000)
    return () => clearInterval(id)
  }, [authed, refreshTournaments])

  // ---------- actions ----------
  const subscribe = useCallback(
    (key: string) => {
      if (!key) return
      subscribedRef.current.add(key)
      connect(key)
    },
    [connect],
  )

  const unsubscribe = useCallback(
    (key: string) => {
      // race guard: sitDown flips the active table synchronously, but the sit
      // snapshot takes a server round-trip — a lobby cleanup firing in between
      // must not tear down the very socket the sit was sent on
      const seated = tableViewsRef.current[key]?.selfSeat != null
      if (activeTableRef.current === key || pendingSitRef.current?.tableKey === key || seated) return
      subscribedRef.current.delete(key)
      disconnect(key)
      setTableViews((prev) => {
        if (!(key in prev)) return prev
        const next = { ...prev }
        delete next[key]
        return next
      })
    },
    [disconnect],
  )

  const login = useCallback(async (username: string, password: string) => {
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    })
    const data = await res.json()
    if (!res.ok) throw new Error(data?.error || 'Login failed')
    setUser(data.user)
    setChips(data.user.chips ?? 0)
    return data.user as PokerUser
  }, [])

  const register = useCallback(async (username: string, password: string) => {
    const res = await fetch('/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    })
    const data = await res.json()
    if (!res.ok) throw new Error(data?.error || 'Registration failed')
    setUser(data.user)
    setChips(data.user.chips ?? 0)
    return data.user as PokerUser
  }, [])

  const logout = useCallback(async () => {
    try {
      await fetch('/api/auth/logout', { method: 'POST' })
    } catch {
      /* ignore */
    }
    teardownSockets()
    setUser(null)
    setChips(0)
    setTableViews({})
    tableViewsRef.current = {}
    setChats({})
    setLobbyTables([])
    setActiveTableSafe(null)
  }, [teardownSockets, setActiveTableSafe])

  const sitDown = useCallback(
    (tableKey: string, seatIndex: number, buyIn: number) => {
      pendingSitRef.current = { tableKey, seatIndex, buyIn }
      subscribedRef.current.add(tableKey)
      const ws = socketsRef.current.get(tableKey)
      if (ws && ws.readyState === WebSocket.OPEN) {
        pendingSitRef.current = null
        ws.send(JSON.stringify({ t: 'sit', seatIndex, buyIn } satisfies OutMsg))
      } else {
        connect(tableKey)
      }
      setActiveTableSafe(tableKey)
    },
    [connect, setActiveTableSafe],
  )

  const unsubscribeTable = useCallback(
    (key: string) => {
      unsubscribe(key)
    },
    [unsubscribe],
  )

  const standUp = useCallback(
    (tableKey: string) => {
      send(tableKey, { t: 'stand' })
    },
    [send],
  )

  const setSitOut = useCallback(
    (tableKey: string, sitOut: boolean) => {
      send(tableKey, { t: 'sitout', sitOut })
    },
    [send],
  )

  const rebuy = useCallback(
    (tableKey: string, amount: number) => {
      send(tableKey, { t: 'rebuy', amount })
    },
    [send],
  )

  const act = useCallback(
    (tableKey: string, type: 'fold' | 'check' | 'call' | 'bet' | 'raise', amount?: number) => {
      send(tableKey, { t: 'action', type, amount })
    },
    [send],
  )

  const sendChat = useCallback(
    (tableKey: string, text: string) => {
      send(tableKey, { t: 'chat', text })
    },
    [send],
  )

  const claimFreeChips = useCallback(() => {
    fetch('/api/chips/claim', { method: 'POST' })
      .then(async (res) => {
        const data = await res.json()
        if (res.ok && typeof data.chips === 'number') {
          setChips(data.chips)
          toastRef.current({ title: 'Free chips', description: 'Balance topped up to 10,000' })
        } else if (data?.nextAt) {
          const when = new Date(data.nextAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
          toastRef.current({ title: 'Free chips', description: `${data.error ?? 'Top-up unavailable'} — next top-up at ${when}`, variant: 'destructive' })
        } else {
          toastRef.current({ title: 'Poker', description: data?.error || 'Something went wrong', variant: 'destructive' })
        }
      })
      .catch(() => {
        toastRef.current({ title: 'Poker', description: 'Network error', variant: 'destructive' })
      })
  }, [])

  // ---------- tournaments ----------
  const registerTournament = useCallback(
    async (id: string) => {
      try {
        const res = await fetch('/api/tournaments/register', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id }),
        })
        const data = await res.json()
        if (res.ok) {
          if (typeof data.chips === 'number') setChips(data.chips)
          toastRef.current({ title: 'Tournament', description: 'Registered — good luck!' })
          refreshTournaments()
          return true
        }
        toastRef.current({ title: 'Tournament', description: data?.error || 'Registration failed', variant: 'destructive' })
        return false
      } catch {
        toastRef.current({ title: 'Poker', description: 'Network error', variant: 'destructive' })
        return false
      }
    },
    [refreshTournaments],
  )

  const joinTournament = useCallback(
    async (id: string) => {
      try {
        const res = await fetch('/api/tournaments/join', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id }),
        })
        const data = await res.json()
        if (res.ok && data.tableKey) {
          subscribedRef.current.add(data.tableKey)
          connect(data.tableKey)
          setActiveTableSafe(data.tableKey)
          refreshTournaments()
          return
        }
        toastRef.current({ title: 'Tournament', description: data?.error || data?.error || 'Could not join', variant: 'destructive' })
        refreshTournaments()
      } catch {
        toastRef.current({ title: 'Poker', description: 'Network error', variant: 'destructive' })
      }
    },
    [connect, setActiveTableSafe, refreshTournaments],
  )

  return {
    authChecked,
    user,
    connected,
    chips,
    lobbyTables,
    tournaments,
    tableViews,
    chats,
    announcements,
    dismissAnnouncement: (id: string) => setAnnouncements((prev) => prev.filter((a) => a.id !== id)),
    activeTable,
    setActiveTable: setActiveTableSafe,
    login,
    register,
    logout,
    sitDown,
    subscribeTable: subscribe,
    unsubscribeTable,
    standUp,
    setSitOut,
    rebuy,
    act,
    sendChat,
    claimFreeChips,
    registerTournament,
    joinTournament,
    refreshTournaments,
  }
}

/** Countdown toward a server deadline: fraction (1 → 0) + seconds left.
 *  The window comes from the snapshot so the bar always matches the real clock. */
export function useCountdown(
  deadline: number | null,
  windowMs: number | null,
): { fraction: number; secondsLeft: number } {
  const [state, setState] = useState({ fraction: 1, secondsLeft: 0 })
  useEffect(() => {
    if (!deadline) {
      const raf = requestAnimationFrame(() => setState({ fraction: 1, secondsLeft: 0 }))
      return () => cancelAnimationFrame(raf)
    }
    const window = windowMs && windowMs > 0 ? windowMs : 25_000
    const tick = () => {
      const remain = Math.max(0, deadline - Date.now())
      setState({
        fraction: Math.max(0, Math.min(1, remain / window)),
        secondsLeft: Math.ceil(remain / 1000),
      })
    }
    const raf = requestAnimationFrame(tick)
    const id = setInterval(tick, 100)
    return () => {
      cancelAnimationFrame(raf)
      clearInterval(id)
    }
  }, [deadline, windowMs])
  return state
}
