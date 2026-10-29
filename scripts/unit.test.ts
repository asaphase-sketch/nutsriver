/**
 * Fast deterministic unit tests (bun test) — the non-random half of the test
 * story alongside `bun run sim` (randomized fuzz) and e2e-workers.ts (E2E).
 *
 * Covers the pure modules a hand can't argue with:
 *   - src/lib/poker/layout.ts        (seat anchor math, incl. the mobile clamp)
 *   - src/lib/poker/cards.ts         (card code parsing, chip formatting)
 *   - src/lib/poker-engine/handEval.ts (5/7-card + Omaha evaluation, wheel/steel wheel)
 *   - src/lib/poker-engine/cards.ts  (numeric card encoding round-trip, deck)
 */

import { describe, expect, test } from 'bun:test'
import { displaySlot, seatAnchor, towardCenter } from '../src/lib/poker/layout'
import { formatChips, formatChipsShort, isRedSuit, splitCard } from '../src/lib/poker/cards'
import { compareHands, describe as describeScore, evaluate, evaluateOmaha, score5 } from '../src/lib/poker-engine/handEval'
import { cardCode, cardRank, parseCard } from '../src/lib/poker-engine/cards'

// ---------- layout ----------

describe('seat anchors', () => {
  test('every layout size keeps anchors inside the felt on phone widths', () => {
    for (const maxSeats of [2, 6, 9]) {
      for (let seat = 0; seat < maxSeats; seat++) {
        const a = seatAnchor(seat, maxSeats, 0)
        // the mobile clamp: ~100px plate on a 366×420px felt must stay inside
        expect(a.x).toBeGreaterThanOrEqual(14)
        expect(a.x).toBeLessThanOrEqual(86)
        expect(a.y).toBeGreaterThanOrEqual(18)
        expect(a.y).toBeLessThanOrEqual(88)
        expect(['left', 'center', 'right']).toContain(a.align)
        expect(a.cardsBelow).toBe(a.y < 50)
      }
    }
  })

  test('slot 0 is always bottom-center regardless of rotation', () => {
    for (const maxSeats of [2, 6, 9]) {
      for (let rotation = 0; rotation < maxSeats; rotation++) {
        const a = seatAnchor(rotation, maxSeats, rotation)
        expect(a.x).toBe(50)
        expect(a.y).toBe(88)
        expect(a.cardsBelow).toBe(false)
      }
    }
  })

  test('rotation wraps modularly across the seat ring', () => {
    // slot of seat s under rotation r === slot of (s - r) under rotation 0
    // (both in range) — e.g. rotating seat 8 to the bottom makes seat 0
    // render exactly where seat 1 renders unrotated
    const a = seatAnchor(0, 9, 8)
    const b = seatAnchor(1, 9, 0)
    expect(a).toEqual(b)
    // displaySlot agrees and stays in [0, n)
    expect(displaySlot(0, 9, 8)).toBe(displaySlot(1, 9, 0))
    expect(displaySlot(5, 9, 2)).toBe(3)
    // out-of-range seats render the center fallback instead of throwing
    expect(seatAnchor(-1, 9, 0)).toEqual({ x: 50, y: 50, cardsBelow: false, align: 'center' })
    expect(seatAnchor(99, 9, 0)).toEqual({ x: 50, y: 50, cardsBelow: false, align: 'center' })
  })

  test('self-centric rotation maps every occupied seat to a unique slot', () => {
    const seen = new Set<number>()
    for (let seat = 0; seat < 9; seat++) seen.add(displaySlot(seat, 9, 3))
    expect(seen.size).toBe(9)
  })

  test('towardCenter pulls points toward the felt middle monotonically', () => {
    const start = { x: 90, y: 90 }
    const step1 = towardCenter(start.x, start.y, 0.3)
    const step2 = towardCenter(start.x, start.y, 0.6)
    const step3 = towardCenter(start.x, start.y, 1)
    expect(step1.x).toBeLessThan(start.x)
    expect(step2.x).toBeLessThan(step1.x)
    expect(step3).toEqual({ x: 50, y: 50 })
  })
})

// ---------- client card helpers ----------

describe('splitCard', () => {
  test('parses rank and suit, expanding T to 10', () => {
    expect(splitCard('As')).toEqual({ rank: 'A', suit: 's' })
    expect(splitCard('td')).toEqual({ rank: '10', suit: 'd' })
    expect(splitCard('2c')).toEqual({ rank: '2', suit: 'c' })
  })

  test('rejects malformed codes', () => {
    for (const bad of ['', 'A', 'Xx', '1s', 'Az', 'Asx']) {
      expect(splitCard(bad)).toBeNull()
    }
  })

  test('suit colors match the two-color deck convention', () => {
    expect(isRedSuit('h')).toBe(true)
    expect(isRedSuit('d')).toBe(true)
    expect(isRedSuit('s')).toBe(false)
    expect(isRedSuit('c')).toBe(false)
  })
})

describe('chip formatting', () => {
  test('formatChips groups thousands and rounds', () => {
    expect(formatChips(12345)).toBe('12,345')
    expect(formatChips(999.6)).toBe('1,000')
    expect(formatChips(0)).toBe('0')
  })

  test('formatChipsShort compacts big numbers', () => {
    expect(formatChipsShort(9_999)).toBe('9,999')
    expect(formatChipsShort(12_500)).toBe('12.5k')
    expect(formatChipsShort(12_000)).toBe('12k')
    expect(formatChipsShort(1_000_000)).toBe('1M')
    expect(formatChipsShort(3_400_000)).toBe('3.4M')
  })
})

// ---------- hand evaluation ----------

const c = (code: string) => parseCard(code)

describe('score5 (exactly 5 cards)', () => {
  test('royal flush', () => {
    const s = score5([c('As'), c('Ks'), c('Qs'), c('Js'), c('Ts')])
    expect(s[0]).toBe(8)
    expect(s[1]).toBe(14)
    expect(describeScore(s)).toBe('Royal Flush')
  })

  test('wheel straight (A-2-3-4-5) scores as 5-high, not ace-high', () => {
    const s = score5([c('Ah'), c('2d'), c('3s'), c('4c'), c('5h')])
    expect(s[0]).toBe(4)
    expect(s[1]).toBe(5)
    expect(describeScore(s)).toBe('Straight, 5 high')
  })

  test('steel wheel (wheel flush) beats quads', () => {
    const steel = score5([c('Ah'), c('2h'), c('3h'), c('4h'), c('5h')])
    const quads = score5([c('Ac'), c('Ad'), c('As'), c('9h'), c('9d')])
    expect(steel[0]).toBe(8)
    expect(steel[1]).toBe(5)
    expect(compareHands({ score: steel, cards: [], desc: '' }, { score: quads, cards: [], desc: '' })).toBe(1)
  })

  test('6-high straight beats 5-high wheel', () => {
    const wheel = score5([c('Ah'), c('2d'), c('3s'), c('4c'), c('5h')])
    const six = score5([c('2h'), c('3d'), c('4s'), c('5c'), c('6h')])
    expect(compareHands({ score: six, cards: [], desc: '' }, { score: wheel, cards: [], desc: '' })).toBe(1)
  })

  test('flushes compare by all five ranks in order', () => {
    const a = score5([c('Ah'), c('Kh'), c('9h'), c('5h'), c('2h')])
    const b = score5([c('Ah'), c('Kh'), c('9h'), c('5h'), c('3h')])
    // same hand up to the last kicker — the 3 kicker wins
    expect(compareHands({ score: b, cards: [], desc: '' }, { score: a, cards: [], desc: '' })).toBe(1)
  })

  test('two pair orders high pair, low pair, then kicker', () => {
    const s = score5([c('Ah'), c('Ad'), c('3s'), c('3c'), c('Kh')])
    expect(s).toEqual([2, 14, 3, 13])
    expect(describeScore(s)).toBe('Two Pair, Aces and 3s')
  })

  test('full house ranks trips over pair, trips value first', () => {
    const s = score5([c('3h'), c('3d'), c('3s'), c('Kc'), c('Kh')])
    expect(s).toEqual([6, 3, 13])
    expect(describeScore(s)).toBe('Full House, 3s over Kings')
  })

  test('kicker comparison resolves equal pairs', () => {
    const a = score5([c('9h'), c('9d'), c('Ks'), c('7c'), c('5h')])
    const b = score5([c('9h'), c('9d'), c('Ks'), c('7c'), c('6h')])
    expect(compareHands({ score: b, cards: [], desc: '' }, { score: a, cards: [], desc: '' })).toBe(1)
    expect(compareHands({ score: a, cards: [], desc: '' }, { score: b, cards: [], desc: '' })).toBe(-1)
  })
})

describe('evaluate (best 5 of 7)', () => {
  test('finds the straight flush hiding among 7 cards', () => {
    const r = evaluate([c('2h'), c('3h'), c('4h'), c('5h'), c('6h'), c('Ad'), c('Kd')])
    expect(r.score[0]).toBe(8)
    expect(r.score[1]).toBe(6)
    expect(r.cards).toHaveLength(5)
  })

  test('prefers trips over two pair in a 7-card mix', () => {
    const r = evaluate([c('9h'), c('9d'), c('9s'), c('Kc'), c('Kd'), c('2h'), c('3c')])
    expect(r.score[0]).toBe(6) // full house actually (999 + KK)
    expect(describeScore(r.score)).toBe('Full House, 9s over Kings')
  })

  test('board-only hands evaluate identically for everyone (play-the-board)', () => {
    const board = [c('Ah'), c('Kh'), c('Qh'), c('Jh'), c('Th')]
    const r1 = evaluate([...board, c('2c'), c('3d')])
    const r2 = evaluate([...board, c('7c'), c('8d')])
    expect(r1.score).toEqual(r2.score)
    expect(r1.score[0]).toBe(8)
  })
})

describe('evaluateOmaha (exactly 2 hole + 3 board)', () => {
  test('does not award a flush from one hole suit + three board suits', () => {
    // hole has NO two spades, board has three — hold'em would run out a
    // flush via the board; Omaha's exactly-2 rule forbids it
    const r = evaluateOmaha([c('Ah'), c('Ad')], [c('Ks'), c('Qs'), c('Js')])
    expect(r.score[0]).toBe(1) // pair of aces only
  })

  test('awards the flush when exactly two hole cards are suited with the board', () => {
    // holes Ah Kh + board Qh Jh Th: the ONLY legal 5-card set is both holes
    // + all three board cards → royal flush. Two hearts in the same set is
    // impossible to exceed without using both suited holes — the rule holds.
    const r = evaluateOmaha([c('Ah'), c('Kh')], [c('Qh'), c('Jh'), c('Th')])
    expect(r.score[0]).toBe(8)
    expect(r.score[1]).toBe(14)
  })

  test('must use exactly two hole cards even when 5 board cards look better', () => {
    // board makes a straight by itself; hole cards don't improve it — Omaha
    // still forces 2 holes, so the best is what 2 holes + 3 board cards give
    const r = evaluateOmaha([c('2c'), c('3c')], [c('Ah'), c('Kh'), c('Qh'), c('Jh'), c('Th')])
    // 2c 3c + Ah Kh Qh → no straight; best is… A K Q high with flush? holes not hearts →
    // straight impossible; flush impossible; best = high card A? Actually KQ+A? pair? none.
    expect(r.score[0]).toBe(0)
    expect(r.score[1]).toBe(14)
  })

  test('steel wheel through the exactly-2 rule', () => {
    const r = evaluateOmaha([c('Ah'), c('2h')], [c('3h'), c('4h'), c('5h')])
    expect(r.score[0]).toBe(8)
    expect(r.score[1]).toBe(5)
  })

  test('omaha5 uses any two of five holes', () => {
    const r = evaluateOmaha(
      [c('Ah'), c('2h'), c('9c'), c('9d'), c('9s')],
      [c('3h'), c('4h'), c('5h')],
    )
    // both a steel wheel (Ah 2h + 3h4h5h) and quad nines are available;
    // straight flush (8) beats quads (7)
    expect(r.score[0]).toBe(8)
    expect(r.score[1]).toBe(5)
  })
})

// ---------- engine card encoding ----------

describe('card codec', () => {
  test('parse → code round-trips for all 52 cards', () => {
    const RANKS = '23456789TJQKA'
    const SUITS = 'shdc'
    for (const r of RANKS) {
      for (const s of SUITS) {
        const code = r + s
        expect(cardCode(parseCard(code))).toBe(code)
      }
    }
  })

  test('rank ordering is 2..14', () => {
    expect(cardRank(parseCard('2s'))).toBe(2)
    expect(cardRank(parseCard('Ts'))).toBe(10)
    expect(cardRank(parseCard('As'))).toBe(14)
  })

  test('distinct codes map to distinct cards', () => {
    const seen = new Set<number>()
    for (const r of '23456789TJQKA') for (const s of 'shdc') seen.add(parseCard(r + s))
    expect(seen.size).toBe(52)
  })
})
