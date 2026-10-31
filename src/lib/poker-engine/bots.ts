import type { BotContext, ActionType, GameType } from './types'
import { cardRank, cardSuit, randomIntBelow } from './cards'
import { evaluate, evaluateOmaha, type EvalResult } from './handEval'

/**
 * Heuristic bot AI for play-money tables — plays sensible, winning poker.
 *
 * Preflop: Chen formula (Hold'em) / rank+shape heuristic (Omaha), sized
 *          opens (2.5-3BB + limpers), position-scaled ranges, real pot odds.
 * Postflop: made-hand strength + draw outs (Omaha-correct: exactly two hole
 *          cards play) → rough equity, compared against pot odds. Nut-aware
 *          for Omaha: big raises with non-nut made hands get folded.
 * Randomness is deliberately small (±10 on a 0-100 roll) so play feels human
 * without becoming illogical.
 */

const SUITS = 4

function chenScore(a: number, b: number, suited: boolean): number {
  const hi = Math.max(a, b)
  const lo = Math.min(a, b)
  let pts = hi / 2
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
 * (double-suited is premium) + connectivity. Coarse but directionally right:
 * aces, big pairs and double-suited rundown score high; danglers don't.
 */
function omahaPreflopScore(hole: number[]): number {
  const ranks = hole.map(cardRank).sort((a, b) => b - a)
  const suits = hole.map(cardSuit)
  let pts = (ranks[0]! + ranks[1]!) / 2.2
  for (let i = 0; i < ranks.length; i++) {
    for (let j = i + 1; j < ranks.length; j++) {
      if (ranks[i] === ranks[j]) pts += 2.5
    }
  }
  const suitCounts = [0, 0, 0, 0]
  for (const s of suits) suitCounts[s]!++
  const suitedPairs = suitCounts.reduce((a, n) => a + (n >= 2 ? (n * (n - 1)) / 2 : 0), 0)
  pts += Math.min(3, suitedPairs * 1.5)
  const uniq = [...new Set(ranks)].sort((a, b) => b - a)
  for (let i = 0; i + 1 < uniq.length && i < 3; i++) {
    const gap = uniq[i]! - uniq[i + 1]!
    if (gap === 1) pts += 1
    else if (gap === 2) pts += 0.5
  }
  // danglers (a card that shares neither rank nor suit with the others) hurt
  if (hole.length === 4) {
    for (let i = 0; i < 4; i++) {
      const shares = hole.some((c, j) => j !== i && (cardRank(c) === cardRank(hole[i]!) || cardSuit(c) === cardSuit(hole[i]!)))
      if (!shares) pts -= 1.5
    }
  }
  return Math.ceil(Math.min(20, pts))
}

/** Round a raise-to amount to the big blind, clamped to legal bounds. */
function sizeBet(frac: number, potTotal: number, bb: number, minRaiseTo: number, maxBetTo: number): number {
  const raw = Math.round((potTotal * frac) / bb) * bb
  return Math.min(maxBetTo, Math.max(minRaiseTo, raw))
}

/** Best current hand (Omaha rule enforced by the evaluators themselves). */
function bestHand(ctx: BotContext): EvalResult {
  return ctx.gameType === 'holdem' ? evaluate([...ctx.hole, ...ctx.board]) : evaluateOmaha(ctx.hole, ctx.board)
}

/**
 * Clean outs to a straight-or-better hand: for every rank, add a virtual card
 * of that rank and count the ranks whose arrival lifts the best hand to
 * straight or above. The evaluators' "best combo uses the new card" property
 * makes this exact for straights/flushes/boats without per-combo bookkeeping.
 */
function bigOuts(ctx: BotContext): number {
  if (ctx.board.length >= 5) return 0
  const base = bestHand(ctx)
  if (base.score[0] >= 8) return 0
  let outs = 0
  for (let r = 2; r <= 14; r++) {
    // skip ranks where all four cards are already visible — no out remains
    const visible = [...ctx.hole, ...ctx.board].filter((c) => cardRank(c) === r).length
    if (visible >= 4) continue
    const withCard =
      ctx.gameType === 'holdem'
        ? evaluate([...ctx.hole, r * SUITS, ...ctx.board])
        : evaluateOmaha([...ctx.hole, r * SUITS], ctx.board)
    if (withCard.score[0] >= 4 && withCard.score[0] > base.score[0]) outs++
  }
  return outs
}

/** Flush-draw outs, respecting how many hole cards each game lets you play. */
export function flushOuts(ctx: BotContext): number {
  if (ctx.board.length >= 5 || ctx.board.length < 3) return 0
  for (let s = 0; s < SUITS; s++) {
    const holeN = ctx.hole.filter((c) => cardSuit(c) === s).length
    const boardN = ctx.board.filter((c) => cardSuit(c) === s).length
    if (ctx.gameType === 'holdem') {
      if (holeN >= 1 && holeN + boardN === 4) return 9
    } else if (holeN === 2 && boardN === 2) {
      return 9 // exactly two hole + two board — complements to the nut draw
    }
  }
  return 0
}

export function botDecide(ctx: BotContext): { type: ActionType; amount?: number } {
  const { hole, board, phase, currentBet, callAmount, canCheck, canRaise, minRaiseTo, maxBetTo, potTotal, gameType, bigBlind, isButton } = ctx
  const r = randomIntBelow(100) // per-decision noise
  const omaha: boolean = gameType !== 'holdem'
  const bb = Math.max(1, bigBlind)

  // ---------------- preflop ----------------
  if (phase === 'PREFLOP') {
    const score = omaha ? omahaPreflopScore(hole) : chenScore(cardRank(hole[0]!), cardRank(hole[1]!), cardSuit(hole[0]!) === cardSuit(hole[1]!))
    const priceBB = callAmount / bb
    // position: act last postflop → play more hands, more aggressively
    const posAdj = isButton ? 1.5 : 0
    const strong = omaha ? 13 - posAdj : 10 - posAdj
    const good = omaha ? 11 - posAdj : 8 - posAdj
    const medium = omaha ? 10 - posAdj * 0.5 : 7 - posAdj * 0.5
    const weak = omaha ? 9 - posAdj * 0.5 : 5

    // standard open sizing: 2.5-3BB + 1BB per active limiter ahead
    const limiterBets = Math.max(0, currentBet - bb)
    const openTo = Math.min(maxBetTo, Math.max(minRaiseTo, Math.round(bb * 2.5) + limiterBets))
    const threeBetTo = sizeBet(1.0, potTotal + callAmount * 2, bb, minRaiseTo, maxBetTo)

    if (score >= strong || (score >= good && r < 70)) {
      if (canRaise) {
        // premium: 3-bet over a raise, otherwise standard open/pot-raise
        return currentBet > bb
          ? { type: 'raise', amount: threeBetTo }
          : { type: currentBet === 0 ? 'bet' : 'raise', amount: openTo }
      }
      return { type: 'call' }
    }
    // free/cheap look: check or defend wide (button + BB especially)
    if (callAmount === 0) return { type: 'check' }
    if (priceBB <= 1 && (isButton || score >= weak)) return { type: 'call' }
    if (score >= medium && priceBB <= 4) return { type: 'call' }
    if (score >= medium - 1 && r < 55 && priceBB <= 3) return { type: 'call' }
    if (score >= weak && r < 30 && priceBB <= 2) return { type: 'call' }
    return { type: 'fold' }
  }

  // ---------------- postflop ----------------
  const ev = bestHand(ctx)
  const cat = ev.score[0]
  const fOuts = flushOuts(ctx)
  const bOuts = bigOuts(ctx)
  const outs = fOuts + bOuts
  // equity: made hand base + draw equity (rule of 4/2) — 0..1
  const madeEquity = Math.min(0.97, cat * 0.11 + Math.min(1, ev.score[1]! / 14) * 0.06)
  const drawEquity = Math.min(0.45, (outs * (board.length === 3 ? 4 : 2)) / 100)
  const equity = Math.min(0.97, madeEquity + (cat >= 4 ? drawEquity * 0.3 : drawEquity))
  // price of a call vs pot after calling
  const potOdds = callAmount > 0 ? callAmount / (potTotal + callAmount) : 0
  const aggressive = r < 35
  const bet = (frac: number) => sizeBet(frac, potTotal, bb, minRaiseTo, maxBetTo)

  // ---- monster / nut-class: bet big, raise big, never slowplay multiway ----
  const omahaNut =
    omaha &&
    ((cat === 5 && board.filter((c) => cardSuit(c) === cardSuit(ev.cards[0]!)).length + 2 >= 5) || cat >= 6)
  if (cat >= 6 || omahaNut || (cat === 5 && !omaha) || (cat === 4 && ev.score[1]! >= 12 && !omaha)) {
    if (canRaise && r < 80) return { type: currentBet === 0 ? 'bet' : 'raise', amount: bet(0.85) }
    return { type: 'call' }
  }

  // ---- strong made (two pair+, top-pair-class in hold'em) ----
  if (cat >= 2 || (cat === 1 && ev.score[1]! >= 12)) {
    const strong = cat >= 3 || (cat === 2 && ev.score[1]! >= 11) || (!omaha && cat === 1 && ev.score[1]! >= 13)
    if (callAmount === 0) {
      if (strong && r < 65) return { type: 'bet', amount: bet(0.65) }
      if (r < 25) return { type: 'bet', amount: bet(0.5) }
      return { type: 'check' }
    }
    // value-raise vs a bet when strong, otherwise price-check the call
    if (strong && canRaise && r < 45) return { type: 'raise', amount: bet(0.9) }
    if (equity >= potOdds * 1.15 || r < 20) return { type: 'call' }
    if (r < 12 && canRaise) return { type: 'raise', amount: bet(0.8) }
    return { type: 'fold' }
  }

  // ---- draws: continue when the price is right, semi-bluff when checked to ----
  if (outs > 0) {
    if (callAmount === 0) {
      if (r < 40) return { type: 'bet', amount: bet(0.5) } // semi-bluff with fold equity
      return { type: 'check' }
    }
    if (equity >= potOdds * 1.1) return { type: 'call' }
    if (r < 12 && canRaise && equity >= potOdds) return { type: 'raise', amount: bet(0.8) }
    return { type: 'fold' }
  }

  // ---- weak made pair / air ----
  if (callAmount === 0) {
    // position bluff: on the button fire more often; otherwise mostly give up
    if (r < (isButton ? 40 : 22)) return { type: 'bet', amount: bet(0.45) }
    return { type: 'check' }
  }
  // Omaha discipline: one pair barely wins showdowns — pay only tiny prices
  const maxPay = omaha ? 0.12 : 0.2
  if (cat === 1 && equity >= potOdds * 1.2) return { type: 'call' }
  if (callAmount <= potTotal * maxPay && r < 30) return { type: 'call' }
  return { type: 'fold' }
}
