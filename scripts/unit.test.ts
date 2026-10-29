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


// ---------- hand trail + replayer state machine ----------

import { PokerTable } from '../src/lib/poker-engine/engine'
import type { HandSummary, HandTrailAction, TableConfig } from '../src/lib/poker-engine/types'
import { buildReplayStates, replayNets, type ReplayParticipant } from '../src/lib/poker/replay'

const TRAIL_CFG: TableConfig = {
  key: 't:trailtest',
  name: 'TrailTest',
  smallBlind: 10,
  bigBlind: 20,
  maxSeats: 6,
  minBuyIn: 1000,
  maxBuyIn: 2000,
  botCount: 0,
}

/** Drive one real engine hand: 'fold' = everyone folds (fold-win), 'call' = all call/check to showdown. */
async function playHand(policy: 'fold' | 'call'): Promise<HandSummary> {
  const summaries: HandSummary[] = []
  const table = new PokerTable(
    TRAIL_CFG,
    {
      onChange: () => {
        if (policy !== 'call') return
        const actorId = table.snapshotFor(null).actorUserId
        // selfOptions are viewer-scoped — read them as the acting player
        const opts = actorId ? table.snapshotFor(actorId).selfOptions : null
        if (!actorId || !opts) return
        if (opts.canCheck) table.applyAction(actorId, 'check')
        else if (opts.canCall) table.applyAction(actorId, 'call')
      },
      onHandFinished: (s) => summaries.push(s),
      onCashOut: () => {},
    },
    { actionMs: 20, showdownMs: 20, awardMs: 20, streetMs: 10, startMs: 10 },
  )
  for (let i = 0; i < 3; i++) table.sitDown(`t:${i}`, `Player${i}`, i, 1000)
  const deadline = Date.now() + 10_000
  while (summaries.length === 0 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 5))
    if (policy === 'fold') {
      const snap = table.snapshotFor(null)
      if (snap.actorUserId && snap.selfOptions) table.applyAction(snap.actorUserId, 'fold')
    }
  }
  table.destroy()
  expect(summaries.length).toBeGreaterThanOrEqual(1)
  return summaries[0]
}

function noHoleCardsInTrail(s: HandSummary) {
  // desc strings are public showdown hand names ("Pair of Kings") and may
  // legitimately contain rank+suit words — strip them before the leak check
  const trailJson = JSON.stringify(s.trail.map(({ desc, ...rest }) => rest))
  for (const p of s.participants) {
    for (const c of p.cards ?? []) {
      // engine cards are numeric — compare as public 2-char codes
      const code = typeof c === 'number' ? cardCode(c) : String(c)
      expect(trailJson).not.toContain(code)
    }
  }
}

describe('engine hand trail', () => {
  test('fold-win hand: posts first, single win == potTotal, no hole cards leaked', async () => {
    const s = await playHand('fold')
    const t = s.trail
    expect(t.length).toBeGreaterThanOrEqual(4)
    // sequence numbers strictly increase from 1
    t.forEach((a, i) => expect(a.n).toBe(i + 1))
    // two blind posts open the hand
    expect(t[0].act).toBe('post')
    expect(t[1].act).toBe('post')
    expect(t[0].street).toBe('PREFLOP')
    // exactly one win, equal to the pot, and it closes the trail
    const wins = t.filter((a) => a.act === 'win')
    expect(wins.length).toBe(1)
    expect(wins[0].amt).toBe(s.potTotal)
    expect(t[t.length - 1].act).toBe('win')
    expect(wins[0].street).toBe('SHOWDOWN')
    noHoleCardsInTrail(s)
  })

  test('showdown hand: deal steps 3/1/1 build the board, win shares sum to pot', async () => {
    const s = await playHand('call')
    const t = s.trail
    expect(t.length).toBeGreaterThanOrEqual(10)
    const deals = t.filter((a) => a.act === 'deal')
    expect(deals.map((d) => d.cards?.length ?? 0)).toEqual([3, 1, 1])
    expect(deals.map((d) => d.street)).toEqual(['FLOP', 'TURN', 'RIVER'])
    // board reconstruction matches the stored board exactly
    const board = deals.flatMap((d) => d.cards ?? [])
    expect(board).toEqual(s.board.map(cardCode))
    // only valid acts ever appear
    for (const a of t) expect(['post', 'fold', 'check', 'call', 'bet', 'raise', 'deal', 'refund', 'win']).toContain(a.act)
    // showdown wins: one or more shares, summing exactly to the pot
    const wins = t.filter((a) => a.act === 'win')
    expect(wins.length).toBeGreaterThanOrEqual(1)
    expect(wins.reduce((x, w) => x + (w.amt ?? 0), 0)).toBe(s.potTotal)
    // winners in the trail match the results payload
    const wonByName = new Map<string, number>()
    for (const w of wins) wonByName.set(w.who!, (wonByName.get(w.who!) ?? 0) + (w.amt ?? 0))
    for (const r of s.results) expect(wonByName.get(r.name)).toBe(r.amount)
    noHoleCardsInTrail(s)
  })
})

describe('replay state machine', () => {
  const P = (name: string, committed: number, cards?: string[]): ReplayParticipant => ({ userId: `u:${name}`, name, committed, cards })

  test('raise-to semantics, street collection, refund direction, board build, pot drain', () => {
    // Button=Ana, SB=Bob (10), BB=Cy (20). Ana raises to 60, both call. Flop:
    // Bob checks, Ana bets 100, Cy calls 40 all-in, Bob folds → uncalled 60
    // goes BACK to Ana on the street transition. Pot = 60+60+60 + 40+40 = 260.
    const participants = [P('Ana', 100, ['As', 'Ad']), P('Bob', 60), P('Cy', 100, ['Kh', 'Kd'])]
    const trail: HandTrailAction[] = [
      { n: 1, street: 'PREFLOP', act: 'post', who: 'Bob', amt: 10 },
      { n: 2, street: 'PREFLOP', act: 'post', who: 'Cy', amt: 20 },
      { n: 3, street: 'PREFLOP', act: 'raise', who: 'Ana', amt: 60 },
      { n: 4, street: 'PREFLOP', act: 'call', who: 'Bob', amt: 50 },
      { n: 5, street: 'PREFLOP', act: 'call', who: 'Cy', amt: 40 },
      { n: 6, street: 'FLOP', act: 'deal', cards: ['2h', '7c', 'Ad'] },
      { n: 7, street: 'FLOP', act: 'check', who: 'Bob' },
      { n: 8, street: 'FLOP', act: 'bet', who: 'Ana', amt: 100 },
      { n: 9, street: 'FLOP', act: 'call', who: 'Cy', amt: 40, ai: true },
      { n: 10, street: 'FLOP', act: 'fold', who: 'Bob' },
      { n: 11, street: 'TURN', act: 'refund', who: 'Ana', amt: 60 },
      { n: 12, street: 'TURN', act: 'deal', cards: ['9s'] },
      { n: 13, street: 'SHOWDOWN', act: 'win', who: 'Ana', amt: 260, desc: 'Three of a Kind, Aces' },
    ]

    const states = buildReplayStates(participants, trail)
    expect(states.length).toBe(14) // step 0 + 13 actions
    // step 0: nothing has happened
    expect(states[0].pot).toBe(0)
    expect(states[0].board).toEqual([])
    // preflop raise-to is a TOTAL, not incremental
    expect(states[3].seats.find((x) => x.name === 'Ana')!.streetBet).toBe(60)
    // flop deal collects preflop chips: 60×3 → pot 180, street bets cleared
    const flop = states[6]
    expect(flop.pot).toBe(180)
    expect(flop.board).toEqual(['2h', '7c', 'Ad'])
    expect(flop.seats.every((x) => x.streetBet === 0)).toBe(true)
    // Cy is only all-in AFTER the flop call (step 9), not at the flop deal
    expect(states[9].seats.find((x) => x.name === 'Cy')!.allIn).toBe(true)
    // turn deal collects flop action: Ana 40 (100−60 refund) + Cy 40 → pot 260
    expect(states[12].pot).toBe(260)
    expect(states[12].seats.find((x) => x.name === 'Ana')!.streetBet).toBe(0)
    // win drains pot to zero and marks the winner
    const fin = states[13]
    expect(fin.pot).toBe(0)
    expect(fin.finished).toBe(true)
    const ana = fin.seats.find((x) => x.name === 'Ana')!
    expect(ana.winner).toBe(true)
    expect(ana.won).toBe(260)
    expect(fin.board).toEqual(['2h', '7c', 'Ad', '9s'])
    // nets use participants' committed as ground truth and must sum to zero
    const nets = replayNets(participants, trail)
    expect([...nets.values()].reduce((a, b) => a + b, 0)).toBe(0)
    expect(nets.get('u:Ana')).toBe(260 - 100)
    expect(nets.get('u:Bob')).toBe(-60)
    expect(nets.get('u:Cy')).toBe(-100)
  })

  test('side pots: multiple win steps drain the pot share by share', () => {
    // Ana jams 100, Bob calls, Cy raises to 200, Bob calls 100 more.
    // Main pot (level 100) = 300, side pot (level 200) = 200. Total 500.
    const participants = [P('Ana', 100), P('Bob', 200), P('Cy', 200)]
    const trail: HandTrailAction[] = [
      { n: 1, street: 'PREFLOP', act: 'post', who: 'Bob', amt: 10 },
      { n: 2, street: 'PREFLOP', act: 'post', who: 'Cy', amt: 20 },
      { n: 3, street: 'PREFLOP', act: 'raise', who: 'Ana', amt: 100, ai: true },
      { n: 4, street: 'PREFLOP', act: 'call', who: 'Bob', amt: 90 },
      { n: 5, street: 'PREFLOP', act: 'raise', who: 'Cy', amt: 200 },
      { n: 6, street: 'PREFLOP', act: 'call', who: 'Bob', amt: 100 },
      { n: 7, street: 'SHOWDOWN', act: 'win', who: 'Cy', amt: 300, desc: 'Pair of Nines' },
      { n: 8, street: 'SHOWDOWN', act: 'win', who: 'Bob', amt: 200, desc: 'Pair of Sevens' },
    ]
    const states = buildReplayStates(participants, trail)
    expect(states.length).toBe(9)
    // after the first win the remaining side pot is still up
    expect(states[7].pot).toBe(200)
    const fin = states[8]
    expect(fin.pot).toBe(0)
    expect(fin.finished).toBe(true)
    expect(fin.seats.find((x) => x.name === 'Cy')!.won).toBe(300)
    expect(fin.seats.find((x) => x.name === 'Bob')!.won).toBe(200)
    const nets = replayNets(participants, trail)
    expect([...nets.values()].reduce((a, b) => a + b, 0)).toBe(0)
  })

  test('fold-win phantom winner absent from participants still renders and drains', () => {
    // SB posts 10, BB posts 20, SB folds → uncalled 20 returns to BB, BB wins SB's 10.
    // buildParticipants drops BB (committed 0 post-refund) — the replayer must
    // synthesize a phantom seat from the trail.
    const participants = [P('Sb', 10)]
    const trail: HandTrailAction[] = [
      { n: 1, street: 'PREFLOP', act: 'post', who: 'Sb', amt: 10 },
      { n: 2, street: 'PREFLOP', act: 'post', who: 'Bb', amt: 20 },
      { n: 3, street: 'PREFLOP', act: 'fold', who: 'Sb' },
      { n: 4, street: 'PREFLOP', act: 'refund', who: 'Bb', amt: 20 },
      { n: 5, street: 'SHOWDOWN', act: 'win', who: 'Bb', amt: 10 },
    ]
    const states = buildReplayStates(participants, trail)
    const fin = states[5]
    const bb = fin.seats.find((x) => x.name === 'Bb')
    expect(bb).toBeDefined()
    expect(bb!.winner).toBe(true)
    expect(bb!.won).toBe(10)
    expect(fin.pot).toBe(0)
  })

  test('winner badge shows NET (won − committed), not the gross pot', () => {
    // Regression (production, hand #437): BB posts 2, SB folds → uncalled 1
    // returns; BB wins pot 2 but only profited +1 (invested 1 net). The badge
    // must derive from won − committedTotal, never from won alone.
    const participants = [P('Sb', 1), P('Bb', 1)]
    const trail: HandTrailAction[] = [
      { n: 1, street: 'PREFLOP', act: 'post', who: 'Sb', amt: 1 },
      { n: 2, street: 'PREFLOP', act: 'post', who: 'Bb', amt: 2 },
      { n: 3, street: 'PREFLOP', act: 'fold', who: 'Sb' },
      { n: 4, street: 'PREFLOP', act: 'refund', who: 'Bb', amt: 1 },
      { n: 5, street: 'SHOWDOWN', act: 'win', who: 'Bb', amt: 2 },
    ]
    const states = buildReplayStates(participants, trail)
    const fin = states[states.length - 1]
    const bb = fin.seats.find((x) => x.name === 'Bb')!
    expect(bb.winner).toBe(true)
    expect(bb.won).toBe(2)
    expect(bb.committedTotal).toBe(1) // post-refund ground truth from participants
    const net = bb.won - bb.committedTotal
    expect(net).toBe(1) // badge renders "+1", not the misleading "+2"
    const nets = replayNets(participants, trail)
    expect(nets.get('u:Sb')).toBe(-1)
    expect(nets.get('u:Bb')).toBe(1)
    expect([...nets.values()].reduce((a, b) => a + b, 0)).toBe(0)
  })

  test('malformed trail never crashes — steps are skipped gracefully', () => {
    const junk = [
      { n: 1, street: 'PREFLOP', act: 'raise' }, // missing who
      { n: 2, street: 'FLOP', act: 'bet', who: 'Ghost', amt: -5 }, // unknown seat
      { n: 0, street: 'RIVER', act: 'win', who: 'Ana', amt: 10 }, // out-of-order n
    ] as unknown as HandTrailAction[]
    const states = buildReplayStates([P('Ana', 0)], junk)
    expect(states.length).toBeGreaterThanOrEqual(1)
    for (const st of states) {
      expect(st.pot).toBeGreaterThanOrEqual(0)
      for (const s of st.seats) expect(s.streetBet).toBeGreaterThanOrEqual(0)
    }
  })
})

// ---------- engine chip conservation: dead money must never burn ----------

describe('engine chip conservation', () => {
  test('folder committing above every alive player: refund capped by dead bet, chips conserve', async () => {
    // Acting order (any button, equal stacks): UTG raises 800, two players
    // call, BB re-raises (min-raise ≥1580; exactly 1580), UTG FOLDS his 800
    // (dead money), the two callers FOLD too. The re-raiser is refunded to
    // the folder's dead 800 (refund 780) — regression guard: the refund used
    // to ignore folders' bets and would have returned 1580−800=780 wrongly as
    // the full 1580, over-crediting the re-raiser and starving the pot. The
    // showdown side-pot burn is fuzz-guarded by the committed==pot invariant
    // in sim.ts across thousands of random hands.
    const queue: Array<{ type: 'fold' | 'check' | 'call' | 'bet' | 'raise'; amount?: number }> = [
      { type: 'raise', amount: 800 },
      { type: 'call' },
      { type: 'call' },
      { type: 'raise', amount: 1580 },
      { type: 'fold' },
      { type: 'fold' },
      { type: 'fold' },
    ]
    const summaries: HandSummary[] = []
    // actionMs is raised so the auto-fold clock can never outrun the script
    const table = new PokerTable(
      { key: 't:dead', name: 'DeadMoney', smallBlind: 10, bigBlind: 20, maxSeats: 4, minBuyIn: 200, maxBuyIn: 2000, botCount: 0 },
      {
        onChange: () => {},
        onHandFinished: (s) => summaries.push(s),
        onCashOut: () => {},
      },
      { actionMs: 5_000, showdownMs: 20, awardMs: 20, streetMs: 10, startMs: 10 },
    )
    for (let i = 0; i < 4; i++) table.sitDown(`t:${i}`, `P${i}`, i, 2000)
    const deadline = Date.now() + 10_000
    while (summaries.length === 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 5))
      const actorId = table.snapshotFor(null).actorUserId
      const next = queue[0]
      if (!actorId || !next) continue
      const err = table.applyAction(actorId, next.type, next.amount)
      if (err === null) queue.shift()
      else throw new Error(`script action rejected (${actorId}): ${next.type} ${next.amount ?? ''}: ${err}`)
    }
    table.destroy()
    expect(summaries.length).toBeGreaterThanOrEqual(1)
    const s = summaries[0]
    // the re-raiser is refunded down to the folder's dead 800 (1580 − 800)
    const bigRaise = s.trail.find((a) => a.act === 'raise' && a.amt === 1580)
    expect(bigRaise).toBeDefined()
    const refund = s.trail.find((a) => a.act === 'refund')
    expect(refund?.amt).toBe(780)
    expect(refund?.who).toBe(bigRaise!.who)
    // conservation: committed chips == pot == awarded == trail wins
    // all four players end committed at exactly 800 → 3200
    const committed = s.participants.reduce((a, p) => a + p.committed, 0)
    expect(committed).toBe(3200)
    expect(s.potTotal).toBe(3200)
    const awarded = s.results.reduce((a, r) => a + r.amount, 0)
    expect(awarded).toBe(3200)
    const trailWins = s.trail.filter((a) => a.act === 'win').reduce((a, x) => a + (x.amt ?? 0), 0)
    expect(trailWins).toBe(3200)
  })
})
