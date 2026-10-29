import type { Card } from './types'
import { cardRank, cardSuit } from './cards'

/**
 * 5/6/7-card hand evaluator.
 * Score is an array [category, ...kickers] compared lexicographically.
 * Categories: 8=StraightFlush 7=Quads 6=FullHouse 5=Flush 4=Straight
 *             3=Trips 2=TwoPair 1=Pair 0=HighCard
 */

export const CATEGORY_NAMES = [
  'High Card',
  'One Pair',
  'Two Pair',
  'Three of a Kind',
  'Straight',
  'Flush',
  'Full House',
  'Four of a Kind',
  'Straight Flush',
] as const

export type HandScore = number[]

function compareScoreArrays(a: HandScore, b: HandScore): number {
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i++) {
    if (a[i] !== b[i]) return a[i] > b[i] ? 1 : -1
  }
  return a.length - b.length
}

/** Score exactly 5 cards. */
export function score5(cards: Card[]): HandScore {
  const ranks = cards.map(cardRank).sort((x, y) => y - x) // desc
  const suits = cards.map(cardSuit)
  const isFlush = suits.every((s) => s === suits[0])

  // rank counts
  const counts = new Map<number, number>()
  for (const r of ranks) counts.set(r, (counts.get(r) ?? 0) + 1)
  // groups sorted by count desc, then rank desc
  const groups = [...counts.entries()].sort((a, b) =>
    a[1] !== b[1] ? b[1] - a[1] : b[0] - a[0],
  )

  // straight detection on unique ranks desc
  const uniq = [...new Set(ranks)].sort((x, y) => y - x)
  let straightHigh = 0
  if (uniq.length === 5) {
    if (uniq[0] - uniq[4] === 4) straightHigh = uniq[0]
    else if (uniq[0] === 14 && uniq[1] === 5 && uniq[4] === 2) straightHigh = 5 // wheel A-5
  }

  if (isFlush && straightHigh) return [8, straightHigh]
  if (groups[0][1] === 4) return [7, groups[0][0], groups[1][0]]
  if (groups[0][1] === 3 && groups[1][1] === 2) return [6, groups[0][0], groups[1][0]]
  if (isFlush) return [5, ...ranks]
  if (straightHigh) return [4, straightHigh]
  if (groups[0][1] === 3) {
    const kickers = ranks.filter((r) => r !== groups[0][0])
    return [3, groups[0][0], ...kickers]
  }
  if (groups[0][1] === 2 && groups[1][1] === 2) {
    const [hi, lo] = [groups[0][0], groups[1][0]].sort((a, b) => b - a)
    const kicker = ranks.filter((r) => r !== hi && r !== lo)[0]
    return [2, hi, lo, kicker]
  }
  if (groups[0][1] === 2) {
    const kickers = ranks.filter((r) => r !== groups[0][0])
    return [1, groups[0][0], ...kickers]
  }
  return [0, ...ranks]
}

export interface EvalResult {
  score: HandScore
  cards: Card[] // the best 5 cards
  desc: string
}

const ALL_5_COMBOS_7 = (() => {
  const combos: number[][] = []
  for (let a = 0; a < 7; a++)
    for (let b = a + 1; b < 7; b++)
      for (let c = b + 1; c < 7; c++)
        for (let d = c + 1; d < 7; d++)
          for (let e = d + 1; e < 7; e++) combos.push([a, b, c, d, e])
  return combos
})()

const ALL_5_COMBOS_6 = (() => {
  const combos: number[][] = []
  for (let a = 0; a < 6; a++)
    for (let b = a + 1; b < 6; b++)
      for (let c = b + 1; c < 6; c++)
        for (let d = c + 1; d < 6; d++)
          for (let e = d + 1; e < 6; e++) combos.push([a, b, c, d, e])
  return combos
})()

/** Evaluate the best 5-card hand out of 5, 6 or 7 cards. */
export function evaluate(cards: Card[]): EvalResult {
  let best: EvalResult | null = null
  const combos =
    cards.length === 7 ? ALL_5_COMBOS_7 : cards.length === 6 ? ALL_5_COMBOS_6 : [[0, 1, 2, 3, 4]]
  for (const idx of combos) {
    const hand = [cards[idx[0]], cards[idx[1]], cards[idx[2]], cards[idx[3]], cards[idx[4]]]
    const score = score5(hand)
    if (!best || compareScoreArrays(score, best.score) > 0) {
      best = { score, cards: hand, desc: describe(score) }
    }
  }
  return best!
}

export function compareHands(a: EvalResult, b: EvalResult): number {
  return compareScoreArrays(a.score, b.score)
}

// ---------------- Omaha (exactly 2 hole + exactly 3 board) ----------------

/** All index combinations of `n` choose 2 (for hole cards). */
const CHOOSE2: Record<number, number[][]> = {}
/** All index combinations of `n` choose 3 (for board cards). */
const CHOOSE3: Record<number, number[][]> = {}

function combos2(n: number): number[][] {
  if (!CHOOSE2[n]) {
    const out: number[][] = []
    for (let a = 0; a < n; a++) for (let b = a + 1; b < n; b++) out.push([a, b])
    CHOOSE2[n] = out
  }
  return CHOOSE2[n]!
}

function combos3(n: number): number[][] {
  if (!CHOOSE3[n]) {
    const out: number[][] = []
    for (let a = 0; a < n; a++)
      for (let b = a + 1; b < n; b++) for (let c = b + 1; c < n; c++) out.push([a, b, c])
    CHOOSE3[n] = out
  }
  return CHOOSE3[n]!
}

/**
 * Omaha evaluation: the best 5-card hand MUST use exactly two hole cards and
 * exactly three board cards. Omaha 4 → 6 × C(board,3) combos; Omaha 5 →
 * 10 × C(board,3) combos. `board` must be 3, 4 or 5 cards.
 */
export function evaluateOmaha(hole: Card[], board: Card[]): EvalResult {
  if (hole.length < 2) throw new Error('Omaha needs at least 2 hole cards')
  if (board.length < 3 || board.length > 5) throw new Error('Omaha board must be 3-5 cards')
  let best: EvalResult | null = null
  for (const [hi, hj] of combos2(hole.length)) {
    for (const [bi, bj, bk] of combos3(board.length)) {
      const score = score5([hole[hi]!, hole[hj]!, board[bi]!, board[bj]!, board[bk]!])
      if (!best || compareScoreArrays(score, best.score) > 0) {
        best = { score, cards: [hole[hi]!, hole[hj]!, board[bi]!, board[bj]!, board[bk]!], desc: describe(score) }
      }
    }
  }
  return best!
}

export function describe(score: HandScore): string {
  const R = (v: number) => {
    if (v === 14) return 'Ace'
    if (v === 13) return 'King'
    if (v === 12) return 'Queen'
    if (v === 11) return 'Jack'
    return String(v)
  }
  switch (score[0]) {
    case 8:
      return score[1] === 14 ? 'Royal Flush' : `Straight Flush, ${R(score[1])} high`
    case 7:
      return `Four of a Kind, ${R(score[1])}s`
    case 6:
      return `Full House, ${R(score[1])}s over ${R(score[2])}s`
    case 5:
      return `Flush, ${R(score[1])} high`
    case 4:
      return `Straight, ${R(score[1])} high`
    case 3:
      return `Three of a Kind, ${R(score[1])}s`
    case 2:
      return `Two Pair, ${R(score[1])}s and ${R(score[2])}s`
    case 1:
      return `One Pair, ${R(score[1])}s`
    default:
      return `High Card, ${R(score[1])}`
  }
}
