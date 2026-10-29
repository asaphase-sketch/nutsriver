/**
 * Engine simulation / fuzz test.
 * Verifies invariants over thousands of random-agent hands:
 *   1. Chip conservation: stacks + bets + committed + pot == total buy-ins (always)
 *   2. Every hand terminates with a summary; awards sum to the pot
 *   3. No negative stacks, valid board sizes, side pots resolve
 *   4. Hand evaluator sanity (known hands)
 * Run: bun sim.ts
 */
import { PokerTable } from '../src/lib/poker-engine/engine'
import type { HandSummary, TableConfig } from '../src/lib/poker-engine/types'
import { evaluate, evaluateOmaha, score5 } from '../src/lib/poker-engine/handEval'
import { parseCard } from '../src/lib/poker-engine/cards'

let failures = 0
function assert(cond: boolean, msg: string) {
  if (!cond) {
    failures++
    console.error(`  FAIL: ${msg}`)
  }
}

// ---------------- evaluator unit checks ----------------
function testEvaluator() {
  console.log('Evaluator unit tests...')
  const royal = evaluate(['As'.match(/../)!.join(''), 'Ks', 'Qs', 'Js', 'Ts', '2h', '3d'].map(parseCard))
  assert(royal.desc === 'Royal Flush', `royal: ${royal.desc}`)
  const quads = evaluate(['Ah', 'Ad', 'Ac', 'As', 'Kd', '2h', '3d'].map(parseCard))
  assert(quads.score[0] === 7, `quads: ${quads.desc}`)
  assert(
    evaluate(['As', 'Ks', 'Qs', 'Js', 'Ts', 'Ah', 'Ad'].map(parseCard)).score[0] === 8,
    'royal flush should beat trips',
  )
  // wheel loses to 6-high straight
  const wheel = score5(['Ah', '2d', '3c', '4s', '5h'].map(parseCard))
  const six = score5(['2h', '3d', '4c', '5s', '6h'].map(parseCard))
  assert(wheel[0] === 4 && wheel[1] === 5, `wheel high should be 5: ${wheel}`)
  assert(six[1] === 6, '6-high straight')
  // best-of-7 picks the better combo
  const ev = evaluate(['2h', '2d', '2c', '7s', '7h', '9d', '9c'].map(parseCard))
  assert(ev.score[0] === 6 && ev.score[1] === 2 && ev.score[2] === 9, `full house 2s over 9s: ${ev.desc}`)
  // kicker comparison
  assert(evaluate(['Ah', 'Ad', '5c', '6s', '8h'].map(parseCard)).score > evaluate(['Ah', 'Ad', '5c', '6s', '7h'].map(parseCard)).score, 'pair kicker 8 > 7')
  console.log('  evaluator OK')
}

// ---------------- omaha evaluator unit checks ----------------
function testOmahaEvaluator() {
  console.log('Omaha evaluator unit tests...')
  const P = (s: string) => parseCard(s)

  // board trips do NOT give you quads unless your two hole cards pair the board
  // hole AsAd KdKc (no aces pair... wait: hole has A,A — playing AsAd + AAA board = quad aces)
  {
    const ev = evaluateOmaha([P('As'), P('Ad'), P('Kd'), P('Kc')], [P('Ah'), P('Ac'), P('2d'), P('7h'), P('9c')])
    assert(ev.score[0] === 7 && ev.score[1] === 14, `quad aces from AAA board + AA hole: ${ev.desc}`)
  }
  // without paired hole cards, AAA board gives at most one pair of aces
  // (hole 9h + board 9c WOULD make two pair aces+nines, so use 8h instead)
  {
    const ev = evaluateOmaha([P('Ks'), P('Qd'), P('Jc'), P('8h')], [P('Ah'), P('Ac'), P('2d'), P('7h'), P('9c')])
    assert(ev.score[0] === 1 && ev.score[1] === 14, `trips impossible w/o ace in hole: ${ev.desc}`)
  }
  // one hole 9 + board 9 + AAA board = two pair aces and nines (not trips)
  {
    const ev = evaluateOmaha([P('Ks'), P('Qd'), P('Jc'), P('9h')], [P('Ah'), P('Ac'), P('2d'), P('7h'), P('9c')])
    assert(ev.score[0] === 2 && ev.score[1] === 14 && ev.score[2] === 9, `two pair aces+nines: ${ev.desc}`)
  }
  // flush requires exactly 2 hole of the suit + 3 board of the suit
  {
    const ev = evaluateOmaha([P('As'), P('Ks'), P('Qd'), P('Qc')], [P('2s'), P('5s'), P('9s'), P('Jh'), P('3d')])
    assert(ev.score[0] === 5 && ev.score[1] === 14, `flush AK high: ${ev.desc}`)
  }
  // 4 board spades + 1 hole spade → NO flush (must use exactly 2 hole)
  {
    const ev = evaluateOmaha([P('As'), P('Kh'), P('Qd'), P('Qc')], [P('2s'), P('5s'), P('9s'), P('Js'), P('3d')])
    // best uses As + one more hole + 3 board spades — only 1 spade in hole → no flush
    // K,Q straight? board 2,3,5,9,J + K,Q → no straight. best = K,Q,J,9,5 high card-ish...
    // actually As + Kh + 9s Js 3d? not flush. Just assert NOT a flush
    assert(ev.score[0] !== 5, `one hole spade + 4 board spades ≠ flush (got ${ev.desc})`)
  }
  // straight: hole 4,5 + board 6,7,8 → straight 8-high using exactly 4,5 from hole
  {
    const ev = evaluateOmaha([P('4h'), P('5d'), P('Ks'), P('2c')], [P('6h'), P('7d'), P('8c'), P('Kh'), P('As')])
    assert(ev.score[0] === 4 && ev.score[1] === 8, `straight 4-8: ${ev.desc}`)
  }
  // omaha5: exactly 2 hole (As,Ks) + exactly 3 board (Qs,Js,Ts) = royal flush
  {
    const ev = evaluateOmaha([P('As'), P('Ks'), P('Qd'), P('2c'), P('7h')], [P('Qs'), P('Js'), P('Ts'), P('5h'), P('9d')])
    assert(ev.score[0] === 8 && ev.score[1] === 14, `royal flush omaha5: ${ev.desc}`)
  }
  // board-only straight is NOT playable in omaha unless 2 hole cards fit
  {
    const ev = evaluateOmaha([P('Ah'), P('Kd'), P('2c'), P('3s')], [P('5h'), P('6d'), P('7c'), P('8h'), P('9s')])
    // hole A,K + 3 board: best is A,K,9,8,7 high card (no straight without using 2 hole)
    assert(ev.score[0] === 0, `board straight unplayable in omaha: ${ev.desc}`)
  }
  console.log('  omaha evaluator OK')
}

// ---------------- random-agent fuzz ----------------
interface SimPlayer {
  userId: string
  name: string
}

async function runFuzz(
  numPlayers: number,
  hands: number,
  label: string,
  stackScale: number,
  opts?: { gameType?: 'holdem' | 'omaha4' | 'omaha5' },
) {
  const cfg: TableConfig = {
    key: `sim-${label}`,
    name: `Sim ${label}`,
    smallBlind: 5,
    bigBlind: 10,
    maxSeats: Math.max(2, numPlayers),
    minBuyIn: 200 * stackScale,
    maxBuyIn: 400 * stackScale,
    botCount: 0,
    gameType: opts?.gameType ?? 'holdem',
  }
  let expectedTotal = 0
  const summaries: HandSummary[] = []
  const errors: string[] = []
  const need = opts?.gameType === 'omaha4' ? 4 : opts?.gameType === 'omaha5' ? 5 : 2
  const checkInvariant = () => {
    let total = table.lobbySummary().handsPlayed >= 0 ? 0 : 0
    // use snapshot to read stacks
    const snap = table.snapshotFor(null)
    for (const s of snap.seats) {
      // chips in play = stacks + outstanding bets (snap.pot is a display pot that
      // already includes uncollected street bets). committed is only an accounting
      // shadow used for side pots and must NOT be added here.
      if (s.status !== 'EMPTY') total += s.stack
    }
    total += snap.pot
    if (total !== expectedTotal) {
      if (errors.length === 0) {
        console.error(`  DEBUG first mismatch: accounted ${total} != expected ${expectedTotal} (hand ${snap.handNumber}, phase ${snap.phase}, displayPot ${snap.pot})`)
        for (const s of snap.seats) {
          if (s.status !== 'EMPTY')
            console.error(`    seat ${s.seatIndex} ${s.userId} stack=${s.stack} committed=${s.committed} bet=${s.bet} status=${s.status}`)
        }
      }
      errors.push(`chip conservation broken: ${total} != ${expectedTotal} (hand ${snap.handNumber}, phase ${snap.phase})`)
    }
    for (const s of snap.seats) {
      if (s.status !== 'EMPTY' && s.stack < 0) errors.push(`negative stack for ${s.userId}`)
    }
    if (snap.board.length !== 0 && snap.board.length !== 3 && snap.board.length !== 4 && snap.board.length !== 5) {
      errors.push(`bad board size ${snap.board.length}`)
    }
  }

  const table = new PokerTable(
    cfg,
    {
      onChange: () => {
        checkInvariant()
        const snap = table.snapshotFor(null)
        const actorId = snap.actorUserId
        if (actorId && actorId.startsWith('sim:') && snap.selfOptions) {
          const opts = snap.selfOptions
          // random agent with a bias to keep pots flowing
          const roll = Math.random()
          let action: 'fold' | 'check' | 'call' | 'bet' | 'raise' = 'fold'
          if (opts.canCheck) action = roll < 0.75 ? 'check' : opts.canRaise ? 'bet' : 'check'
          else action = roll < 0.28 ? 'fold' : roll < 0.85 ? 'call' : opts.canRaise ? 'raise' : 'call'
          let amount: number | undefined
          if ((action === 'bet' || action === 'raise') && opts.canRaise) {
            const span = opts.maxBetTo - opts.minBetTo
            amount = Math.floor(opts.minBetTo + Math.random() * Math.max(1, span))
            if (Math.random() < 0.1) amount = opts.maxBetTo // sometimes jam
          }
          const err = table.applyAction(actorId, action, amount)
          if (err) errors.push(`sim action rejected: ${action} ${amount}: ${err}`)
        }
      },
      onHandFinished: (summary) => {
        summaries.push(summary)
        const awarded = summary.results.reduce((a, r) => a + r.amount, 0)
        if (awarded !== summary.potTotal)
          errors.push(`hand ${summary.handNumber}: awarded ${awarded} != pot ${summary.potTotal}`)
        if (summary.potTotal <= 0) errors.push(`hand ${summary.handNumber}: empty pot`)
        if (need > 2) {
          for (const p of summary.participants) {
            if ((p.cards?.length ?? 0) !== need)
              errors.push(`hand ${summary.handNumber}: ${p.name} holds ${p.cards?.length} hole cards, need ${need}`)
          }
        }
      },
      onCashOut: () => {},
    },
    { actionMs: 4, showdownMs: 4, awardMs: 4, streetMs: 2, startMs: 2 },
  )

  // seat players with varying stacks to exercise side pots
  const reseat = (i: number) => {
    const empty: number[] = []
    const snap0 = table.snapshotFor(null)
    snap0.seats.forEach((s, idx) => {
      if (s.status === 'EMPTY') empty.push(idx)
    })
    if (empty.length === 0) return false
    const seat = empty[Math.floor(Math.random() * empty.length)]
    const amount = Math.max(cfg.minBuyIn, Math.min(cfg.maxBuyIn, cfg.minBuyIn + Math.floor(Math.random() * 6) * 50))
    expectedTotal += amount // must be counted BEFORE sitDown triggers the invariant check
    const err = table.sitDown(`sim:${i}`, `Sim${i}`, seat, amount)
    if (err) {
      errors.push(`sitDown failed: ${err}`)
      expectedTotal -= amount
      return false
    }
    return true
  }
  for (let i = 0; i < numPlayers; i++) reseat(i)

  const deadline = Date.now() + 120_000
  while (summaries.length < hands && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 20))
    // re-buy busted sim players so play continues
    for (let i = 0; i < numPlayers; i++) {
      const snapNow = table.snapshotFor(`sim:${i}`)
      if (snapNow.selfSeat === null) reseat(i)
    }
  }
  table.destroy()

  const avgBoard = summaries.filter((s) => s.results.length > 0).length
  console.log(
    `  ${label}: ${summaries.length} hands completed, showdown/award results: ${avgBoard}, invariants: ${errors.length === 0 ? 'OK' : 'FAILED'}`,
  )
  for (const e of errors.slice(0, 5)) console.error(`    ${e}`)
  assert(errors.length === 0, `${label} invariants`)
  assert(summaries.length >= hands, `${label} completed enough hands (${summaries.length}/${hands})`)
}

async function main() {
  testEvaluator()
  testOmahaEvaluator()
  await testRebuy()
  console.log('Fuzz: heads-up holdem, 400 hands...')
  await runFuzz(2, 400, 'heads-up', 1)
  console.log('Fuzz: 6-max omaha4, 300 hands...')
  await runFuzz(6, 300, 'omaha4-six', 1, { gameType: 'omaha4' })
  console.log('Fuzz: 6-max omaha5, 200 hands...')
  await runFuzz(6, 200, 'omaha5-six', 1, { gameType: 'omaha5' })
  console.log('Fuzz: 9-max omaha4, 200 hands...')
  await runFuzz(9, 200, 'omaha4-nine', 1, { gameType: 'omaha4' })

  if (failures === 0) {
    console.log('\nALL SIMULATION TESTS PASSED ✓')
    process.exit(0)
  } else {
    console.error(`\n${failures} FAILURES ✗`)
    process.exit(1)
  }
}

/** Seated top-up rules: caps, between-hands gating, stack math. */
async function testRebuy() {
  console.log('Rebuy unit tests...')
  const cfg: TableConfig = {
    key: 'sim-rebuy',
    name: 'Sim Rebuy',
    smallBlind: 1,
    bigBlind: 2,
    maxSeats: 2,
    minBuyIn: 40,
    maxBuyIn: 200,
    botCount: 0,
  }
  // long startMs keeps a wide deterministic WAITING window between hands
  const table = new PokerTable(
    cfg,
    { onChange: () => {}, onHandFinished: () => {}, onCashOut: () => {} },
    { actionMs: 30, showdownMs: 30, awardMs: 30, streetMs: 10, startMs: 500 },
  )
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
  const waitPhase = async (target: 'WAITING' | 'other', ms: number) => {
    const deadline = Date.now() + ms
    while (Date.now() < deadline) {
      const phase = table.snapshotFor(null).phase
      if (target === 'WAITING' ? phase === 'WAITING' : phase !== 'WAITING') return true
      await sleep(5)
    }
    return false
  }

  assert(table.sitDown('r:1', 'ReOne', 0, 100) === null, 'sit r:1')
  assert(table.sitDown('r:2', 'ReTwo', 1, 100) === null, 'sit r:2')

  // caps + validation (hand has not started yet — sync section)
  assert(table.canRebuy('r:1', 101)?.includes('max') === true, 'cap rejects over max')
  assert(table.canRebuy('r:1', 100) === null, 'at max allowed')
  assert(table.canRebuy('nobody', 10) != null, 'unseated rejected')
  assert(table.canRebuy('r:1', 0) != null, 'zero rejected')
  assert(table.canRebuy('r:1', 12.5) != null, 'fractional rejected')

  // in-hand gating: while r:1 is IN_HAND a top-up is rejected
  assert(await waitPhase('other', 3_000), 'hand started')
  if (table.snapshotFor('r:1').seats.find((s) => s.isSelf)?.status === 'IN_HAND') {
    assert(table.canRebuy('r:1', 50)?.includes('hand') === true, 'in-hand rejected')
  }

  // between hands (500ms window) a top-up validates, applies and logs
  assert(await waitPhase('WAITING', 3_000), 'hand finished — waiting window')
  const before = table.snapshotFor('r:1').seats.find((s) => s.isSelf)!.stack
  assert(table.canRebuy('r:1', 60) === null, 'rebuy ok between hands')
  assert(table.applyRebuy('r:1', 60) === null, 'applyRebuy ok')
  const after = table.snapshotFor('r:1').seats.find((s) => s.isSelf)!.stack
  assert(after === before + 60, `stack credited (${before} -> ${after})`)
  assert(table.snapshotFor(null).log.some((l) => l.includes('tops up 60')), 'log entry')
  table.destroy()
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
