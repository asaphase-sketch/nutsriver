'use client'

import { useEffect, useRef } from 'react'
import type { ClientTableView } from '@/lib/poker/types'
import {
  initSounds,
  playAllIn,
  playChips,
  playDeal,
  playFlip,
  playFold,
  playLevelUp,
  playWin,
  playYourTurn,
} from '@/lib/poker/sounds'

/**
 * Watches a table snapshot and fires the matching synthesized effect.
 * All detection is diff-based on refs — no re-render cost.
 */
export function useTableSounds(view: ClientTableView, selfUserId: string | null) {
  const prev = useRef<{
    board: number
    handNumber: number
    selfCards: number
    myTurn: boolean
    allInSeen: Set<string>
    foldsSeen: Set<string>
    winnersSeen: Set<string>
    levelKey: string
  }>({
    board: 0,
    handNumber: 0,
    selfCards: 0,
    myTurn: false,
    allInSeen: new Set(),
    foldsSeen: new Set(),
    winnersSeen: new Set(),
    levelKey: '',
  })

  // init once on mount (restores mute preference)
  useEffect(() => {
    initSounds()
  }, [])

  useEffect(() => {
    const p = prev.current
    const key = view.tableKey

    // new hand dealt → swish + deal my cards
    if (view.handNumber !== p.handNumber) {
      p.handNumber = view.handNumber
      p.board = 0
      p.selfCards = 0
      p.allInSeen = new Set()
      p.foldsSeen = new Set()
      p.winnersSeen = new Set()
      if (view.phase === 'PREFLOP') playDeal(view.selfCards.length || 2)
    }

    // board runout → flips
    if (view.board.length > p.board) {
      playFlip()
      p.board = view.board.length
    }

    // hole cards revealed to me (reconnect / late deal)
    if (view.selfCards.length > p.selfCards) {
      p.selfCards = view.selfCards.length
      playDeal(view.selfCards.length)
    }

    // my turn begins
    const myTurn = !!selfUserId && view.actorUserId === selfUserId && !!view.selfOptions
    if (myTurn && !p.myTurn) playYourTurn()
    p.myTurn = myTurn

    // per-player action cues
    for (const s of view.seats) {
      if (!s.userId || s.status === 'EMPTY') continue
      const la = s.lastAction
      if (la) {
        const sig = `${key}:${s.userId}:${la.at}`
        if (la.type === 'fold' && !p.foldsSeen.has(sig)) {
          p.foldsSeen.add(sig)
          if (p.foldsSeen.size > 400) p.foldsSeen = new Set([...p.foldsSeen].slice(-200))
          playFold()
        }
        if ((la.type === 'bet' || la.type === 'raise' || la.type === 'call') && s.status === 'IN_HAND') {
          const allInSig = `${key}:${s.userId}:allin:${la.at}`
          if (!p.allInSeen.has(allInSig)) {
            p.allInSeen.add(allInSig)
            if (p.allInSeen.size > 100) p.allInSeen = new Set([...p.allInSeen].slice(-50))
            if (la.amount != null && s.stack === 0) playAllIn()
            else playChips()
          }
        }
      }
      // winner glow
      if (s.winAmount != null && s.winAmount > 0) {
        const sig = `${key}:${s.userId}:win:${view.handNumber}`
        if (!p.winnersSeen.has(sig)) {
          p.winnersSeen.add(sig)
          if (p.winnersSeen.size > 50) p.winnersSeen = new Set([...p.winnersSeen].slice(-25))
          if (s.userId === selfUserId) playWin()
          else playChips()
        }
      }
    }

    // blind level tick (tournament tables update smallBlind on level change)
    const levelKey = `${key}:${view.smallBlind}/${view.bigBlind}`
    if (p.levelKey && p.levelKey !== levelKey && view.handNumber > 0) playLevelUp()
    p.levelKey = levelKey
  }, [view, selfUserId])
}
