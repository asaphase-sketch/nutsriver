import type { BotContext, ActionType, GameType } from './types'
import { cardRank, cardSuit, randomIntBelow } from './cards'
import { evaluate, evaluateOmaha } from './handEval'

/**
 * Lightweight heuristic bot AI for play-money tables.
 * Preflop: Chen formula (Hold'em) / rank+shape heuristic (Omaha).
 * Postflop: made-hand category + simple draws.
 * Deliberately imperfect and randomized so play feels human.
 */

function chenScore(a: number, b: number, suited: boolean): number {
  const hi = Math.max(a, b)
  const lo = Math.min(a, b)
  let pts = hi / 2
  if (hi === 14) pts += 0 // ace already valued
  if (a === b) {
    pts = Math.max(5, pts * 2)
  }
  if (suited) pts += 2
  const gap = hi - lo
  if (a !== b) {
    if (gap === 2) pts -= 1
    else if (gap === 3) pts -= 2
    else if (gap === 4) pts -= 4
    else if (gap >= 5) pts -= 5
    if (gap <= 1 && hi < 12) pts += 1 // connector bonus
  }
  return Math.ceil(pts)
}

/**
 * Omaha preflop strength 0-20: high-card content + pairedness + suitedness
 * (double-suited is premium) + connectivity. Deliberately coarse — bots just
 * need plausible range behavior, not GTO.
 */
function omahaPreflopScore(hole: number[]): number {
  const ranks = hole.map(cardRank).sort((a, b) => b - a)
  const suits = hole.map(cardSuit)
  // top-two high cards carry the most equity
  let pts = (ranks[0]! + ranks[1]!) / 2.2
  // pairs add strength (sets/boats potential)
  for (let i = 0; i < ranks.length; i++) {
    for (let j = i + 1; j < ranks.length; j++) {
      if (ranks[i] === ranks[j]) pts += 2.5
    }
  }
  // suited counts: single-suited +1.5, double-suited +3
  const suitCounts = [0, 0, 0, 0]
  for (const s of suits) suitCounts[s]!++
  const suitedPairs = suitCounts.reduce((a, n) => a + (n >= 2 ? (n * (n - 1)) / 2 : 0), 0)
  pts += Math.min(3, suitedPairs * 1.5)
  // connectivity of the top cards
  const uniq = [...new Set(ranks)].sort((a, b) => b - a)
  for (let i = 0; i + 1 < uniq.length && i < 3; i++) {
    const gap = uniq[i]! - uniq[i + 1]!
    if (gap === 1) pts += 1
    else if (gap === 2) pts += 0.5
  }
  return Math.ceil(Math.min(20, pts))
}

export function botDecide(ctx: BotContext): { type: ActionType; amount?: number } {
  const { hole, board, phase, currentBet, callAmount, canCheck, canRaise, minRaiseTo, maxBetTo, potTotal, gameType } = ctx
  const r = randomIntBelow(100) // per-decision noise
  const omaha: boolean = gameType !== 'holdem'

  if (phase === 'PREFLOP') {
    let score: number
    if (omaha) {
      score = omahaPreflopScore(hole)
    } else {
      const [c1, c2] = hole as [number, number]
      score = chenScore(cardRank(c1), cardRank(c2), cardSuit(c1) === cardSuit(c2))
    }
    const bb = Math.max(1, Math.floor(potTotal / 3)) // rough BB estimate
    const priceInBB = callAmount / bb
    // omaha ranges are wider — relax thresholds a touch
    const strong = omaha ? 13 : 10
    const good = omaha ? 11 : 8
    const medium = omaha ? 10 : 7
    const weak = omaha ? 9 : 5

    // strong hands raise, medium call, junk folds (with noise)
    const minRaise = minRaiseTo
    const potRaise = Math.min(maxBetTo, currentBet + potTotal + callAmount)
    if (score >= strong || (score >= good && r < 70)) {
      if (canRaise) return { type: currentBet === 0 ? 'bet' : 'raise', amount: Math.min(maxBetTo, Math.max(minRaise, potRaise)) }
      return { type: 'call' }
    }
    if (priceInBB <= 1) return { type: 'check' }
    if (score >= medium && priceInBB <= 4) return { type: 'call' }
    if (score >= medium - 1 && r < 55 && priceInBB <= 3) return { type: 'call' }
    if (score >= weak && r < 30 && priceInBB <= 2) return { type: 'call' }
    if (callAmount === 0) return { type: 'check' }
    return { type: 'fold' }
  }

  // ---- postflop ----
  const ev = omaha ? evaluateOmaha(hole, board) : evaluate([...hole, ...board])
  const cat = ev.score[0]
  const aggressive = r < 35

  const betSize = (frac: number) => Math.min(maxBetTo, Math.max(minRaiseTo, Math.round((potTotal * frac) / 10) * 10))

  // monster: value bet / raise big
  if (cat >= 6 || (cat === 5 && aggressive) || (cat === 4 && aggressive && board.length >= 4)) {
    if (canRaise && r < 75) {
      return { type: currentBet === 0 ? 'bet' : 'raise', amount: betSize(0.75) }
    }
    return { type: 'call' }
  }
  // decent made hand: second pair / top pair-ish (pair + high kickers)
  if (cat === 1 && ev.score[1] >= 11) {
    if (callAmount === 0) {
      if (r < 55) return { type: 'bet', amount: betSize(0.5) }
      return { type: 'check' }
    }
    if (callAmount <= potTotal * 0.5 || r < 40) return { type: 'call' }
    if (r < 15 && canRaise) return { type: 'raise', amount: betSize(0.7) }
    return { type: 'fold' }
  }
  // middle pair / low pair
  if (cat === 1) {
    if (callAmount === 0) {
      if (r < 25) return { type: 'bet', amount: betSize(0.45) }
      return { type: 'check' }
    }
    if (callAmount <= potTotal * 0.35 && r < 60) return { type: 'call' }
    return { type: r < 20 ? 'call' : 'fold' }
  }
  // draws: chase cheap (omaha has more of them — loosen)
  const drawBonus = omaha ? 0.15 : 0
  const isDraw = hasDraw(hole, board)
  if (isDraw && callAmount <= potTotal * (0.35 + drawBonus)) return { type: 'call' }
  if (isDraw && callAmount === 0 && r < 40) return { type: 'bet', amount: betSize(0.4) }
  // air
  if (callAmount === 0) {
    if (r < 30) return { type: 'bet', amount: betSize(0.45) } // occasional bluff
    return { type: 'check' }
  }
  if (callAmount <= potTotal * (0.15 + drawBonus) && r < 35) return { type: 'call' }
  return { type: 'fold' }
}

function hasDraw(hole: number[], board: number[]): boolean {
  const all = [...hole, ...board]
  if (board.length >= 5) return false
  // flush draw
  for (let s = 0; s < 4; s++) {
    const n = all.filter((c) => cardSuit(c) === s).length
    if (n === 4 && hole.some((c) => cardSuit(c) === s)) return true
  }
  // open-ended straight draw (cheap check on 4 consecutive ranks incl. a hole card)
  const ranks = [...new Set(all.map(cardRank))].sort((a, b) => a - b)
  for (let i = 0; i + 3 < ranks.length; i++) {
    if (ranks[i + 3]! - ranks[i]! === 3) return true
  }
  // wheel draw
  if (ranks.includes(14) && ranks.includes(2) && ranks.includes(3) && ranks.includes(4)) return true
  return false
}
