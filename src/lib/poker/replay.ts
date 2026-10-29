/**
 * Hand replayer state machine — pure, deterministic, unit-tested.
 *
 * Replays a hand's public action trail (HandTrailAction[]) into a full list
 * of per-step view states. The UI renders `states[step]`; stepping forward
 * never requires re-deriving anything, and the final state must agree with
 * the stored hand facts (board, participants' net committed, win totals).
 *
 * Simulation rules (mirroring the engine's chip flow):
 *   post/call  → streetBet += amt (call amt is incremental)
 *   bet/raise  → streetBet = amt  (raise-to TOTAL for the street)
 *   fold/check → status only
 *   refund     → streetBet -= amt (uncalled portion returns pre-collection)
 *   deal       → collect all streetBets into the pot, reveal board cards
 *   win        → collect any remaining streetBets (final street / fold-wins
 *                have no trailing 'deal'), then drain the pot by the share
 *
 * Side-pot showdowns emit MULTIPLE 'win' steps — every step is processed;
 * nothing short-circuits, so all shares drain the pot to 0.
 *
 * The trail is public information by construction (engine never records hole
 * cards into it) — hole cards shown by the replayer come from the masked
 * `participants` payload, not from the trail.
 */

import type { HandTrailAction } from '../poker-engine/types'

export interface ReplaySeat {
  name: string
  userId: string
  /** hole card codes IF known for this viewer (server masks opponents') */
  hole: string[]
  /** true contribution to the pot (post-refund ground truth) */
  committedTotal: number
  /** live bet on the current street at this step */
  streetBet: number
  /** chips collected into the pot so far */
  collected: number
  folded: boolean
  allIn: boolean
  lastAct: { act: HandTrailAction['act']; amt?: number; ai?: boolean } | null
  /** winnings accumulated so far (steps up to and including this one) */
  won: number
  winner: boolean
}

export interface ReplayState {
  /** index into the states array (0 = pre-blinds setup) */
  step: number
  street: 'PREFLOP' | 'FLOP' | 'TURN' | 'RIVER' | 'SHOWDOWN'
  board: string[]
  /** collected pot minus winnings paid out — never below 0 */
  pot: number
  seats: ReplaySeat[]
  /** the trail action that PRODUCED this state (absent at step 0) */
  action: HandTrailAction | null
  finished: boolean
}

export interface ReplayParticipant {
  userId: string
  name: string
  committed: number
  cards?: string[]
}

function potOf(seats: ReplaySeat[]): number {
  return Math.max(0, seats.reduce((t, s) => t + s.collected, 0) - seats.reduce((t, s) => t + s.won, 0))
}

/**
 * Build the full state list for a hand. Returns at least one state (the
 * step-0 setup) even for a degenerate/legacy trail. Tolerates malformed
 * steps by skipping them — a replayer must never crash on stored data.
 */
export function buildReplayStates(participants: ReplayParticipant[], trail: HandTrailAction[]): ReplayState[] {
  const seats: ReplaySeat[] = (participants ?? []).map((p) => ({
    name: p.name,
    userId: p.userId,
    hole: Array.isArray(p.cards) ? p.cards : [],
    committedTotal: p.committed,
    streetBet: 0,
    collected: 0,
    folded: false,
    allIn: false,
    lastAct: null,
    won: 0,
    winner: false,
  }))
  const byName = new Map(seats.map((s) => [s.name, s]))
  // trail actors missing from participants get phantom seats — a fold-win
  // winner's committed can be 0 post-refund, so buildParticipants drops them
  for (const a of trail ?? []) {
    if (a.who && !byName.has(a.who)) {
      const phantom: ReplaySeat = {
        name: a.who,
        userId: '',
        hole: [],
        committedTotal: 0,
        streetBet: 0,
        collected: 0,
        folded: false,
        allIn: false,
        lastAct: null,
        won: 0,
        winner: false,
      }
      seats.push(phantom)
      byName.set(a.who, phantom)
    }
  }
  const snap = () => seats.map((s) => ({ ...s, lastAct: s.lastAct ? { ...s.lastAct } : null }))

  const states: ReplayState[] = [
    { step: 0, street: 'PREFLOP', board: [], pot: 0, seats: snap(), action: null, finished: false },
  ]

  let board: string[] = []
  let sawWin = false

  const sorted = [...(trail ?? [])].sort((a, b) => a.n - b.n)
  for (const a of sorted) {
    const seat = a.who ? byName.get(a.who) : undefined
    switch (a.act) {
      case 'post':
      case 'call': {
        if (!seat || typeof a.amt !== 'number') break
        seat.streetBet += a.amt
        seat.lastAct = { act: a.act, amt: a.amt, ai: a.ai }
        if (a.ai) seat.allIn = true
        break
      }
      case 'bet':
      case 'raise': {
        if (!seat || typeof a.amt !== 'number') break
        // raise-to total; guard against a malformed decreasing value
        seat.streetBet = Math.max(seat.streetBet, a.amt)
        seat.lastAct = { act: a.act, amt: a.amt, ai: a.ai }
        if (a.ai) seat.allIn = true
        break
      }
      case 'fold': {
        if (!seat) break
        seat.folded = true
        seat.lastAct = { act: 'fold' }
        break
      }
      case 'check': {
        if (!seat) break
        seat.lastAct = { act: 'check' }
        break
      }
      case 'refund': {
        if (!seat || typeof a.amt !== 'number') break
        seat.streetBet = Math.max(0, seat.streetBet - a.amt)
        break
      }
      case 'deal': {
        const cards = Array.isArray(a.cards) ? a.cards : []
        // collect street bets into the pot, then reveal the board
        for (const s of seats) {
          s.collected += s.streetBet
          s.streetBet = 0
          s.lastAct = null
        }
        board = [...board, ...cards]
        break
      }
      case 'win': {
        if (!seat || typeof a.amt !== 'number') break
        // final street / fold-wins carry no trailing 'deal' — collect first
        for (const s of seats) {
          s.collected += s.streetBet
          s.streetBet = 0
        }
        seat.won += a.amt
        seat.winner = true
        seat.lastAct = { act: 'win', amt: a.amt }
        sawWin = true
        break
      }
      default:
        break
    }
    states.push({
      step: states.length,
      street: a.street,
      board: [...board],
      pot: potOf(seats),
      seats: snap(),
      action: a,
      finished: sawWin,
    })
  }

  return states
}

/**
 * Per-participant net result over the whole hand (won − committed).
 * Participants' committed is ground truth; winnings accumulate from 'win'
 * steps. On a healthy trail the nets sum to 0 (play-money — no rake).
 */
export function replayNets(participants: ReplayParticipant[], trail: HandTrailAction[]): Map<string, number> {
  const won = new Map<string, number>()
  for (const a of trail ?? []) {
    if (a.act === 'win' && a.who && typeof a.amt === 'number') {
      won.set(a.who, (won.get(a.who) ?? 0) + a.amt)
    }
  }
  const nets = new Map<string, number>()
  for (const p of participants ?? []) {
    nets.set(p.userId, (won.get(p.name) ?? 0) - p.committed)
  }
  return nets
}
