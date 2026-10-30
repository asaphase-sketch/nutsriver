/**
 * Headless E2E for the Cloudflare Workers deployment (raw WebSocket).
 * register → open table WS → sit → wait for turn → act → stand → verify balance.
 * Run: bun scripts/e2e-workers.ts   (E2E_BASE overrides target, default :3000)
 */

const BASE = process.env.E2E_BASE ?? 'http://localhost:3000'
const TABLE = process.env.E2E_TABLE ?? 'e2efelt'
const username = `Flow${Math.floor(Math.random() * 100000)}`
const usernameB = `Riva${Math.floor(Math.random() * 100000)}`
const password = 'flow-test-12345'

export {} // module (top-level await)

/** live sockets during the test — on failure we try to release the seats so
 *  runs don't leave zombie players blocking the table */
let liveWs: WebSocket | null = null
let liveWsB: WebSocket | null = null

function fail(msg: string): never {
  console.error(`FAIL: ${msg}`)
  try {
    for (const sock of [liveWs, liveWsB]) {
      if (sock && sock.readyState === WebSocket.OPEN) {
        sock.send(JSON.stringify({ t: 'stand' }))
      }
    }
    // block briefly so the stand messages flush before exit
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2000)
  } catch {
    /* best effort */
  }
  process.exit(1)
}

// ---------- register ----------
const reg = await fetch(`${BASE}/api/auth/register`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ username, password }),
})
const setCookie = reg.headers.get('set-cookie') ?? ''
const token = /poker_session=([^;]+)/.exec(setCookie)?.[1]
if (!token) fail(`register failed: ${reg.status} ${await reg.text()}`)
const regBody = (await reg.json()) as { user?: { id: string; chips: number } }
const userId = regBody.user?.id
console.log('registered:', username, 'chips:', regBody.user?.chips)
const cookie = `poker_session=${token}`

// ---------- lobby ----------
const lobby = await fetch(`${BASE}/api/lobby`)
const lobbyBody = (await lobby.json()) as { tables?: unknown[] }
if (!lobbyBody.tables?.length) fail('lobby returned no tables')
console.log('lobby tables:', lobbyBody.tables.length)

// ---------- leaderboard (public play-money standings) ----------
{
  const lb = await fetch(`${BASE}/api/leaderboard`)
  if (lb.status !== 200) fail(`leaderboard should be 200, got ${lb.status}`)
  const body = (await lb.json()) as {
    players?: { username: string; chips: number; handsPlayed: number; handsWon: number; biggestPotWon: number }[]
  }
  if (!Array.isArray(body.players) || body.players.length === 0) fail('leaderboard returned no players')
  const top = body.players[0]!
  if (typeof top.username !== 'string' || typeof top.chips !== 'number') fail('leaderboard row shape invalid')
  if ('id' in top || 'passwordHash' in top || 'role' in top) fail('leaderboard leaks private fields')
  const desc = body.players.every((p, i) => i === 0 || body.players![i - 1]!.chips >= p.chips)
  if (!desc) fail('leaderboard not sorted by chips desc')
  console.log(`leaderboard: ${body.players.length} players, leader ${top.username} @ ${top.chips} ✓`)
}

// ---------- live lobby socket (LobbyDO push — the polling replacement) ----------
{
  const lws = new WebSocket(BASE.replace(/^http/, 'ws') + '/api/poker-socket?table=lobby', {
    headers: { cookie },
  } as unknown as string[])
  let got: any = null
  try {
    got = await new Promise<any>((resolve, reject) => {
      const to = setTimeout(() => reject(new Error('lobby ws timeout')), 10_000)
      lws.onmessage = (ev) => {
        try {
          const data = JSON.parse(ev.data as string)
          if (data?.t === 'lobby') {
            clearTimeout(to)
            resolve(data)
          }
        } catch {
          /* ignore */
        }
      }
      lws.onerror = () => {
        clearTimeout(to)
        reject(new Error('lobby ws error'))
      }
    })
  } catch (e) {
    fail(`live lobby: ${(e as Error).message}`)
  }
  const tables = got.tables ?? []
  if (!Array.isArray(tables) || tables.length < 8) fail(`live lobby push expected ≥8 tables, got ${tables?.length}`)
  if (!Array.isArray(got.tournaments)) fail('live lobby push missing tournaments array')
  const keys = tables.map((t: any) => t.tableKey)
  for (const expected of ['feltroyale', 'nosebleed', 'highfive', 'omahalite']) {
    if (!keys.includes(expected)) fail(`new table missing from live lobby push: ${expected}`)
  }
  const sample = tables[0]!
  for (const f of ['tableKey', 'name', 'bigBlind', 'playersSeated', 'maxSeats', 'inHand']) {
    if (!(f in sample)) fail(`live lobby table row missing field: ${f}`)
  }
  try {
    lws.close()
  } catch {
    /* already closed */
  }
  console.log(`live lobby socket: push with ${tables.length} tables + ${got.tournaments.length} tournaments ✓`)
}

// ---------- second player (tables may have zero bots — admin policy) ----------
const regB = await fetch(`${BASE}/api/auth/register`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ username: usernameB, password }),
})
const setCookieB = regB.headers.get('set-cookie') ?? ''
const tokenB = /poker_session=([^;]+)/.exec(setCookieB)?.[1]
if (!tokenB) fail(`player B register failed: ${regB.status}`)
const regBodyB = (await regB.json()) as { user?: { id: string; chips: number } }
console.log('registered:', usernameB, 'chips:', regBodyB.user?.chips)
const cookieB = `poker_session=${tokenB}`
const userIdB = regBodyB.user?.id

// ---------- websocket ----------
const url = BASE.replace(/^http/, 'ws') + `/api/poker-socket?table=${TABLE}`
// bun's WebSocket accepts per-instance headers (not in lib.dom types)
const ws = new WebSocket(url, { headers: { cookie } } as unknown as string[])
liveWs = ws

const state = {
  view: null as Record<string, any> | null,
  chips: regBody.user?.chips ?? 0,
  chatHistory: 0,
  chatMsg: 0,
  lastErr: null as string | null,
}

const failTimer = setTimeout(() => fail('E2E timeout (420s)'), 420_000)

ws.onmessage = (ev) => {
  let data: any
  try {
    data = JSON.parse(ev.data as string)
  } catch {
    return
  }
  if (data.t === 'state') {
    state.view = data.view
  } else if (data.t === 'chatHistory') {
    state.chatHistory = data.messages?.length ?? 0
  } else if (data.t === 'chatMsg') {
    state.chatMsg++
  } else if (data.t === 'chips') {
    state.chips = data.chips
  } else if (data.t === 'err') {
    state.lastErr = data.message as string
    console.error('server error:', data.message)
  }
}

ws.onerror = () => fail('websocket error')

await new Promise<void>((resolve, reject) => {
  ws.onopen = () => resolve()
  setTimeout(() => reject(new Error('ws open timeout')), 8000)
})
console.log('ws open')
ws.send(JSON.stringify({ t: 'hello' }))

// wait for first snapshot
const waitState = async (cond: (v: Record<string, any>) => boolean, label: string, ms = 15_000) => {
  const start = Date.now()
  while (Date.now() - start < ms) {
    if (state.view && cond(state.view)) return state.view
    await new Promise((r) => setTimeout(r, 100))
  }
  fail(`timeout waiting for ${label}`)
}

await waitState((v) => Array.isArray(v.seats) && v.seats.length > 0, 'first snapshot')
console.log(`snapshot: phase=${state.view!.phase} seats=${state.view!.seats.length} bots present`)

// ---------- sit both players (bots may be disabled by admin policy) ----------
const emptySeat = state.view!.seats.find((s: any) => s.status === 'EMPTY')
if (!emptySeat) fail('no empty seat')
ws.send(JSON.stringify({ t: 'sit', seatIndex: emptySeat.seatIndex, buyIn: 200 }))
console.log(`A sitting at seat ${emptySeat.seatIndex} buy-in 200`)

const seated = await waitState((v) => v.selfSeat != null, 'seat confirmation')
console.log(`seated at ${seated.selfSeat}, stack=${seated.seats.find((s: any) => s.isSelf)?.stack}`)
if (state.chips === regBody.user?.chips) fail('chips not deducted after buy-in')
console.log('chips after buy-in:', state.chips)

// chat round-trip
ws.send(JSON.stringify({ t: 'chat', text: 'gl everyone' }))

// player B joins and sits next to A so a hand can start even with no bots
const wsB = new WebSocket(url, { headers: { cookie: cookieB } } as unknown as string[])
liveWsB = wsB
const stateB = { view: null as Record<string, any> | null, chips: regBodyB.user?.chips ?? 0 }
wsB.onmessage = (ev) => {
  let data: any
  try {
    data = JSON.parse(ev.data as string)
  } catch {
    return
  }
  if (data.t === 'state') stateB.view = data.view
  else if (data.t === 'chips') stateB.chips = data.chips
}
wsB.onerror = () => fail('websocket B error')
await new Promise<void>((resolve, reject) => {
  wsB.onopen = () => resolve()
  setTimeout(() => reject(new Error('ws B open timeout')), 8000)
})
wsB.send(JSON.stringify({ t: 'hello' }))
const startB = Date.now()
while (Date.now() - startB < 15_000) {
  if (stateB.view && Array.isArray(stateB.view.seats) && stateB.view.seats.length > 0) break
  await new Promise((r) => setTimeout(r, 100))
}
const seatB = stateB.view!.seats.find((s: any) => s.status === 'EMPTY')
if (!seatB) fail('no empty seat for player B')
wsB.send(JSON.stringify({ t: 'sit', seatIndex: seatB.seatIndex, buyIn: 200 }))
const seatedBStart = Date.now()
while (Date.now() - seatedBStart < 15_000) {
  if (stateB.view?.selfSeat != null) break
  await new Promise((r) => setTimeout(r, 100))
}
if (stateB.view?.selfSeat == null) fail('player B never seated')
console.log(`B seated at seat ${stateB.view!.selfSeat} — heads-up ready`)

// ---------- auto-act both players every street until the hand ends ----------
// (both humans keep check/calling until showdown — folding through streets on
// the 25s clock would take minutes)
// Under E2E_FAST (3s clocks) A also holds its FIRST turn to verify the server
// timer auto-acts on deadline. On real clocks (prod, 25s, shared table with
// leftover slow hands) we only ASSERT the clock fields and act normally.
const HOLD_FOR_TIMER = process.env.E2E_FAST === '1'
let timerHoldUntil = 0
let timerChecked = false
let lastActA = 0
let lastActB = 0
let handDoneA = false
const start = Date.now()
while (Date.now() - start < 200_000) {
  const v = state.view!
  const stillIn = v.selfSeat != null && v.phase !== 'SHOWDOWN' && v.phase !== 'WAITING'
  if (!timerChecked && stillIn && v.selfOptions) {
    // first observed turn — verify the server clock reaches the client
    const windowMs = typeof v.actionWindow === 'number' && v.actionWindow > 0 ? v.actionWindow : 0
    if (windowMs === 0) fail(`actionWindow missing/invalid in snapshot: ${JSON.stringify(v.actionWindow)}`)
    if (typeof v.actionDeadline !== 'number' || v.actionDeadline <= Date.now())
      fail(`actionDeadline missing/stale: ${v.actionDeadline}`)
    timerChecked = true
    console.log(`action clock live ✓ (${Math.round(windowMs / 100) / 10}s window)`)
    if (HOLD_FOR_TIMER) {
      timerHoldUntil = Date.now() + windowMs + 8_000
      console.log('timer test: holding A\'s turn to let the server clock fire')
    }
  }
  if (stillIn && v.selfCards?.length > 0 && v.selfOptions && Date.now() - lastActA > 600 && Date.now() > timerHoldUntil) {
    const o = v.selfOptions
    const type = o.canCheck ? 'check' : o.canCall && o.callAmount <= 60 ? 'call' : 'fold'
    console.log(`A #${v.handNumber} ${v.phase} → ${type}`)
    ws.send(JSON.stringify({ t: 'action', type }))
    lastActA = Date.now()
  }
  if (timerHoldUntil > 0 && timerChecked && Date.now() >= timerHoldUntil) {
    const selfSeat = v.seats?.find((s: any) => s.isSelf)
    const expired = (v.log as string[])?.some((l) => l.includes(`${username}'s time expires`))
    const folded = selfSeat?.status === 'FOLDED' || selfSeat?.status === 'SITTING_OUT'
    if (!expired && !folded) fail(`action timer did not auto-act (status=${selfSeat?.status})`)
    console.log(`timer test: server auto-acted ✓ (${expired ? 'log entry' : 'status ' + selfSeat?.status})`)
    timerHoldUntil = 0 // resume normal play
  }
  if (!stillIn && v.phase === 'SHOWDOWN') handDoneA = true
  const vb = stateB.view
  const stillInB = vb?.selfSeat != null && vb.phase !== 'SHOWDOWN' && vb.phase !== 'WAITING'
  if (stillInB && vb?.selfCards?.length > 0 && vb.selfOptions && Date.now() - lastActB > 600) {
    const o = vb.selfOptions
    const type = o.canCheck ? 'check' : o.canCall && o.callAmount <= 60 ? 'call' : 'fold'
    console.log(`B #${vb.handNumber} ${vb.phase} → ${type}`)
    wsB.send(JSON.stringify({ t: 'action', type }))
    lastActB = Date.now()
  }
  if (handDoneA && v.phase === 'WAITING' && timerChecked) break // hand fully resolved
  if (v.selfSeat == null && Date.now() - start > 5_000) break // already stood (deferred)
  await new Promise((r) => setTimeout(r, 150))
}
if (!timerChecked) {
  const v = state.view!
  console.error('DEBUG state at no-clock fail:', JSON.stringify({
    phase: v.phase,
    hand: v.handNumber,
    selfSeat: v.selfSeat,
    myStatus: v.seats?.find((s: any) => s.isSelf)?.status,
    actor: v.actorUserId,
    opts: !!v.selfOptions,
    dl: v.actionDeadline,
    win: v.actionWindow,
    seated: v.seats?.filter((s: any) => s.status !== 'EMPTY').map((s: any) => `${s.name.slice(0, 8)}:${s.status}:${s.connected}`),
  }))
  fail('action clock test never saw A on the clock')
}
if (lastActA === 0 && lastActB === 0) fail('neither player ever got action options')
console.log('hand played to completion')

// ---------- rebuy (seated top-up) — B sits out so no new hand races in ----------
wsB.send(JSON.stringify({ t: 'sitout', sitOut: true }))
// wait until A is genuinely between hands: phase WAITING AND A not in a hand
// (B's sitout guarantees no further hand can start once this one resolves)
const rebuyStart = Date.now()
for (;;) {
  const v = state.view!
  const selfStatus = v.seats?.find((s: any) => s.isSelf)?.status
  if (v.phase === 'WAITING' && selfStatus !== 'IN_HAND' && selfStatus !== 'ALL_IN') break
  if (Date.now() - rebuyStart > 150_000) fail(`table never settled between hands for rebuy (phase=${v.phase} status=${selfStatus})`)
  await new Promise((r) => setTimeout(r, 200))
}

const selfBefore = state.view!.seats.find((s: any) => s.isSelf)
const stackBefore = selfBefore?.stack ?? 0
const chipsBefore = state.chips
ws.send(JSON.stringify({ t: 'rebuy', amount: 100 }))
const rebuyWait = Date.now()
let rebuyOk = false
while (Date.now() - rebuyWait < 15_000) {
  const sNow = state.view!.seats.find((s: any) => s.isSelf)?.stack ?? 0
  if (state.chips === chipsBefore - 100 && sNow === stackBefore + 100) {
    rebuyOk = true
    break
  }
  await new Promise((r) => setTimeout(r, 200))
}
if (!rebuyOk) fail(`rebuy did not land (chips ${chipsBefore}→${state.chips}, stack ${stackBefore}→${state.view!.seats.find((s: any) => s.isSelf)?.stack})`)
console.log(`rebuy: +100 stack & -100 balance ✓ (balance ${state.chips})`)

// over-cap rebuy must be rejected without touching balances
state.lastErr = null
ws.send(JSON.stringify({ t: 'rebuy', amount: 1_000_000 }))
await new Promise((r) => setTimeout(r, 1500))
const capErr = state.lastErr as string | null
if (!capErr || !capErr.includes('max')) fail(`over-cap rebuy should error with max, got: ${capErr}`)
const stackAfterCap = state.view!.seats.find((s: any) => s.isSelf)?.stack ?? 0
if (state.chips !== chipsBefore - 100 || stackAfterCap !== stackBefore + 100)
  fail('rejected rebuy mutated balances')
console.log('rebuy: over-cap rejected, balances untouched ✓')

// ---------- my hand history: list, detail, privacy masking ----------
// The completed hand (check/call to the river) should be recorded by now —
// the rebuy round-trip already awaited the DO's drainIo.
{
  const anon = await fetch(`${BASE}/api/my/hands?table=${TABLE}`)
  if (anon.status !== 401) fail(`my/hands anonymous should be 401, got ${anon.status}`)
  const anonDetail = await fetch(`${BASE}/api/my/hand?id=x`)
  if (anonDetail.status !== 401) fail(`my/hand anonymous should be 401, got ${anonDetail.status}`)

  const hh = await fetch(`${BASE}/api/my/hands?table=${TABLE}&limit=10`, { headers: { cookie } })
  if (hh.status !== 200) fail(`my/hands failed: ${hh.status}`)
  const hhBody = (await hh.json()) as {
    hands?: { id: string; handNumber: number; potTotal: number; winners: string; at: number; showdown: boolean; myNet: number | null; myCards: string[] | null; board: string }[]
  }
  const rows = hhBody.hands ?? []
  if (rows.length === 0) fail('my/hands returned no rows after a completed hand')
  const mine = rows.find((r) => r.myNet != null && r.myCards != null && r.myCards.length > 0)
  if (!mine) fail(`my/hands rows lack my net/hole cards: ${JSON.stringify(rows[0])}`)
  console.log(`hand history: list ok — hand #${mine!.handNumber} pot ${mine!.potTotal} net ${mine!.myNet} (${rows.length} rows)`)

  const detail = await fetch(`${BASE}/api/my/hand?id=${encodeURIComponent(mine!.id)}`, { headers: { cookie } })
  if (detail.status !== 200) fail(`my/hand detail failed: ${detail.status}`)
  const dBody = (await detail.json()) as {
    hand?: { showdown: boolean; participants: { userId: string; cards?: string[] }[]; log: string[] } | null
  }
  const d = dBody.hand
  if (!d || !Array.isArray(d.log) || !Array.isArray(d.participants)) fail('my/hand detail malformed')

  // replayer trail: present, ordered, public-only — hole cards never included
  const trail = (d as { trail?: { n: number; act: string; who?: string; amt?: number; cards?: string[]; desc?: string }[] }).trail
  if (!Array.isArray(trail) || trail.length === 0) fail('my/hand detail must carry a non-empty action trail (replayer)')
  if (trail!.some((a, i) => a.n !== i + 1)) fail('trail sequence numbers must be 1..N in order')
  const VALID_ACTS = new Set(['post', 'fold', 'check', 'call', 'bet', 'raise', 'deal', 'refund', 'win'])
  if (trail!.some((a) => !VALID_ACTS.has(a.act))) fail(`trail carries an unknown act: ${JSON.stringify(trail!.find((a) => !VALID_ACTS.has(a.act)))}`)
  // desc strings are public hand names — strip before the leak scan
  const trailJson = JSON.stringify(trail!.map(({ desc, ...rest }) => rest))
  for (const p of d.participants) {
    for (const c of p.cards ?? []) {
      if (trailJson.includes(c)) fail(`PRIVACY LEAK: hole card ${c} present in the action trail`)
    }
  }
  console.log(`hand history: action trail ok (${trail!.length} steps) — replayer ready ✓`)

  if (d.showdown) {
    for (const p of d.participants) {
      if (p.userId !== userId! && (p.cards?.length ?? 0) === 0)
        fail('showdown hand must reveal opponents that were dealt in')
    }
    console.log('hand history: showdown detail reveals participants ✓')
  } else {
    console.log('hand history: first hand was a fold-win (showdown reveal check deferred to next hand)')
  }

  // force a FOLD-WIN hand: bring B back in, fold A at the first turn — the
  // server must strip EVERY opponent's hole cards from that record
  wsB.send(JSON.stringify({ t: 'sitout', sitOut: false }))
  const foldStart = Date.now()
  let foldedOnce = false
  while (Date.now() - foldStart < 60_000 && !foldedOnce) {
    const v = state.view!
    if (v.selfSeat != null && v.phase !== 'WAITING' && v.phase !== 'SHOWDOWN' && v.selfOptions) {
      ws.send(JSON.stringify({ t: 'action', type: 'fold' }))
      wsB.send(JSON.stringify({ t: 'sitout', sitOut: true }))
      foldedOnce = true
      break
    }
    await new Promise((r) => setTimeout(r, 100))
  }
  if (!foldedOnce) fail('could not play the fold-win masking hand (no turn observed)')

  let foldRow: (typeof rows)[number] | null = null
  const histStart = Date.now()
  while (Date.now() - histStart < 20_000 && !foldRow) {
    const v = state.view!
    // defensive: if another hand started before B's sit-out landed, fold again
    if (v.selfSeat != null && v.phase !== 'WAITING' && v.phase !== 'SHOWDOWN' && v.selfOptions) {
      ws.send(JSON.stringify({ t: 'action', type: 'fold' }))
    }
    const hh2 = await fetch(`${BASE}/api/my/hands?table=${TABLE}&limit=10`, { headers: { cookie } })
    const rows2 = hh2.ok ? ((await hh2.json()) as { hands?: typeof rows }).hands ?? [] : []
    foldRow = rows2.find((r) => r.showdown === false && r.myNet != null) ?? null
    if (!foldRow) await new Promise((r) => setTimeout(r, 500))
  }
  if (!foldRow) fail('fold-win hand never appeared in my/hands')
  console.log(`hand history: fold-win hand #${foldRow!.handNumber} recorded (net ${foldRow!.myNet})`)

  const fd = await fetch(`${BASE}/api/my/hand?id=${encodeURIComponent(foldRow!.id)}`, { headers: { cookie } })
  if (fd.status !== 200) fail(`fold-win detail failed: ${fd.status}`)
  const fdBody = (await fd.json()) as { hand?: { showdown: boolean; participants: { userId: string; name: string; cards?: string[] }[] } | null }
  const fh = fdBody.hand
  if (!fh || fh.showdown !== false) fail('fold-win detail should carry showdown=false')
  for (const p of fh!.participants) {
    if (p.userId !== userId! && (p.cards?.length ?? 0) > 0)
      fail(`PRIVACY LEAK: opponent ${p.name} cards visible on a fold-win hand`)
  }
  const myP = fh!.participants.find((p) => p.userId === userId!)
  if (!myP || (myP.cards?.length ?? 0) === 0) fail('my own cards must always be visible in detail')
  console.log('hand history: fold-win masking enforced — opponents hidden, my cards visible ✓')

  // cross-user masking: player B must NOT see A's cards for the same fold-win hand
  const fdB = await fetch(`${BASE}/api/my/hand?id=${encodeURIComponent(foldRow!.id)}`, { headers: { cookie: cookieB } })
  if (fdB.status !== 200) fail(`fold-win detail for B failed: ${fdB.status}`)
  const fdBBody = (await fdB.json()) as { hand?: { participants: { userId: string; cards?: string[] }[] } | null }
  const aRow = fdBBody.hand?.participants.find((p) => p.userId === userId!)
  if ((aRow?.cards?.length ?? 0) > 0) fail('PRIVACY LEAK: A\'s cards visible to player B on a fold-win hand')
  console.log('hand history: cross-user masking (B cannot see A) ✓')
}
// B stays sat out — A can stand up immediately for exact cash-out math

// ---------- stand up & verify cash-out ----------
await new Promise((r) => setTimeout(r, 2500))
// exact math: stand-up moves the seat stack onto the lobby balance
const meBefore = (await (await fetch(`${BASE}/api/auth/me`, { headers: { cookie } })).json()) as {
  user?: { chips: number }
}
const balanceNow = meBefore.user?.chips ?? 0
const stackNow = state.view!.seats.find((s: any) => s.isSelf)?.stack ?? 0
console.log(`standing up — balance ${balanceNow} + stack ${stackNow} = ${balanceNow + stackNow}`)
ws.send(JSON.stringify({ t: 'stand' }))
wsB.send(JSON.stringify({ t: 'stand' }))

// standing mid-hand defers removal until the hand completes — poll the ledger
let finalChips: number | null = null
const start2 = Date.now()
while (Date.now() - start2 < 150_000) {
  const me = await fetch(`${BASE}/api/auth/me`, { headers: { cookie } })
  const meBody = (await me.json()) as { user?: { chips: number } }
  if (meBody.user && meBody.user.chips === balanceNow + stackNow) {
    finalChips = meBody.user.chips
    break
  }
  await new Promise((r) => setTimeout(r, 500))
}
if (finalChips == null) fail(`stack was never cashed out to lobby balance (expected ${balanceNow + stackNow})`)
console.log(`stood up — balance ${balanceNow} → ${finalChips} (stack ${stackNow} returned)`)

// ---------- admin surface ----------
// environment-tolerant: a fresh database lets the suite claim admin and
// exercise the full API; on production the passphrase is burned (409) so we
// only assert the security gates.
{
  const wrongClaim = await fetch(`${BASE}/api/admin/claim`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', cookie },
    body: JSON.stringify({ passphrase: 'definitely-not-it' }),
  })
  if (wrongClaim.status !== 403) fail(`wrong passphrase should be 403, got ${wrongClaim.status}`)

  const anonUsers = await fetch(`${BASE}/api/admin/users`)
  if (anonUsers.status !== 401) fail(`admin/users without session should be 401, got ${anonUsers.status}`)

  const playerUsers = await fetch(`${BASE}/api/admin/users`, { headers: { cookie } })
  if (playerUsers.status !== 403) fail(`admin/users as player should be 403, got ${playerUsers.status}`)

  // security gates for the new dashboard endpoints (run in every environment)
  const anonOverview = await fetch(`${BASE}/api/admin/overview`)
  if (anonOverview.status !== 401) fail(`admin/overview anon should be 401, got ${anonOverview.status}`)
  for (const ep of ['overview', 'hands', 'robots', 'transactions', 'tournaments', 'audit', 'broadcast', 'players/rename', 'chips/bulk']) {
    const asPlayer = await fetch(`${BASE}/api/admin/${ep}`, { headers: { cookie } })
    if (asPlayer.status !== 403) fail(`admin/${ep} as player should be 403, got ${asPlayer.status}`)
  }
  const anonRegister = await fetch(`${BASE}/api/tournaments/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: 'x' }),
  })
  if (anonRegister.status !== 401) fail(`tournament register anon should be 401, got ${anonRegister.status}`)
  console.log('admin gates: new endpoints blocked for anonymous + players ✓')

  const claim = await fetch(`${BASE}/api/admin/claim`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', cookie },
    body: JSON.stringify({ passphrase: process.env.ADMIN_PASSPHRASE ?? '' }),
  })
  if (claim.status === 403 && !process.env.ADMIN_PASSPHRASE) {
    // production runs must NOT burn the passphrase — that belongs to the
    // site owner's own account — so an absent passphrase is the expected path
    console.log('admin claim: skipped (no ADMIN_PASSPHRASE provided — correct for production)')
  } else if (claim.status === 200) {
    const claimBody = (await claim.json()) as { user?: { role?: string } }
    if (claimBody.user?.role !== 'admin') fail('claim succeeded but role is not admin')
    console.log('admin claim: OK (first claim on this database)')

    const burn = await fetch(`${BASE}/api/admin/claim`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ passphrase: process.env.ADMIN_PASSPHRASE ?? '' }),
    })
    if (burn.status !== 409) fail(`second claim should be burned 409, got ${burn.status}`)

    const list = await fetch(`${BASE}/api/admin/users`, { headers: { cookie } })
    const listBody = (await list.json()) as { users?: { username: string; role: string }[] }
    if (list.status !== 200 || !listBody.users?.some((u) => u.role === 'admin')) fail('admin users list failed')

    const give = await fetch(`${BASE}/api/admin/chips`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ userId: userId!, delta: 500, reason: 'e2e bonus' }),
    })
    const giveBody = (await give.json()) as { chips?: number }
    if (give.status !== 200 || giveBody.chips !== finalChips + 500) fail(`admin chip adjust failed: ${give.status}`)

    const take = await fetch(`${BASE}/api/admin/chips`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ userId: userId!, delta: -500, reason: 'e2e revert' }),
    })
    const takeBody = (await take.json()) as { chips?: number }
    if (take.status !== 200 || takeBody.chips !== finalChips) fail('admin chip revert failed')

    const stand = await fetch(`${BASE}/api/admin/standup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ userId: userId! }),
    })
    if (stand.status !== 200) fail(`admin standup failed: ${stand.status}`)

    console.log('admin API: users/chips/standup OK')

    // ---- dashboard overview ----
    const overview = await fetch(`${BASE}/api/admin/overview`, { headers: { cookie } })
    const overviewBody = (await overview.json()) as {
      stats?: { totalUsers?: number }
      tables?: unknown[]
      activity?: unknown[]
      onlineNow?: number
    }
    if (overview.status !== 200 || typeof overviewBody.stats?.totalUsers !== 'number') fail('admin overview failed')
    if (!Array.isArray(overviewBody.tables) || overviewBody.tables.length !== 10) fail('admin overview tables failed')
    if (!Array.isArray(overviewBody.activity)) fail('admin activity feed failed')
    console.log('admin overview: stats+activity+metrics OK')

    // ---- hand history (a hand already ran in this suite) ----
    const hands = await fetch(`${BASE}/api/admin/hands`, { headers: { cookie } })
    const handsBody = (await hands.json()) as { hands?: { id: string }[] }
    if (hands.status !== 200 || !Array.isArray(handsBody.hands)) fail('admin hands list failed')
    if (handsBody.hands!.length > 0) {
      const detail = await fetch(`${BASE}/api/admin/hand?id=${encodeURIComponent(handsBody.hands![0]!.id)}`, { headers: { cookie } })
      const detailBody = (await detail.json()) as { hand?: { log?: unknown } }
      if (detail.status !== 200 || !Array.isArray(detailBody.hand?.log)) fail('admin hand detail failed')
    }
    console.log('admin hands: list + detail OK')

    // ---- transactions ----
    const txs = await fetch(`${BASE}/api/admin/transactions`, { headers: { cookie } })
    if (txs.status !== 200) fail(`admin transactions failed: ${txs.status}`)
    console.log('admin transactions: OK')

    // ---- robots: zero bots on beginners → drained → restore defaults ----
    const robots0 = (await (await fetch(`${BASE}/api/admin/robots`, { headers: { cookie } })).json()) as {
      policy?: { enabled?: boolean }
    }
    if (robots0.policy?.enabled !== true) fail('robots policy should default to enabled')
    const robotsSet = await fetch(`${BASE}/api/admin/robots`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ enabled: true, tableCounts: { beginners: 0 } }),
    })
    if (robotsSet.status !== 200) fail('admin robots POST failed')
    const drainStart = Date.now()
    for (;;) {
      const probe = (await (await fetch(`${BASE}/api/admin/robots`, { headers: { cookie } })).json()) as {
        tables?: { tableKey: string; botsSeated: number }[]
      }
      const beg = probe.tables?.find((t) => t.tableKey === 'beginners')
      if (beg && beg.botsSeated === 0) break
      if (Date.now() - drainStart > 60_000) fail('robots did not drain after policy change')
      await new Promise((r) => setTimeout(r, 1000))
    }
    const robotsRestore = await fetch(`${BASE}/api/admin/robots`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ enabled: true, tableCounts: {} }),
    })
    if (robotsRestore.status !== 200) fail('robots restore failed')
    console.log('robots: zero-bot policy applied live, drained, defaults restored ✓')

    // ---- ban roundtrip on a throwaway account ----
    const banName = `BanMe${Math.floor(Math.random() * 100000)}`
    const banReg = await fetch(`${BASE}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: banName, password: 'ban-test-12345' }),
    })
    const banRegBody = (await banReg.json()) as { user?: { id: string } }
    if (!banReg.ok || !banRegBody.user?.id) fail('ban target registration failed')
    const banResp = await fetch(`${BASE}/api/admin/ban`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ userId: banRegBody.user.id, banned: true }),
    })
    if (banResp.status !== 200) fail(`admin ban failed: ${banResp.status}`)
    const bannedLogin = await fetch(`${BASE}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: banName, password: 'ban-test-12345' }),
    })
    if (bannedLogin.status !== 401) fail('banned user login should be 401')
    const unbanResp = await fetch(`${BASE}/api/admin/ban`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ userId: banRegBody.user.id, banned: false }),
    })
    if (unbanResp.status !== 200) fail('admin unban failed')
    const unbannedLogin = await fetch(`${BASE}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: banName, password: 'ban-test-12345' }),
    })
    if (unbannedLogin.status !== 200) fail('unbanned user login should succeed')
    console.log('ban/unban roundtrip ✓')

    // ---- omaha tables present in the lobby ----
    const lobby2 = (await (await fetch(`${BASE}/api/lobby`)).json()) as { tables?: { gameType?: string }[] }
    if (!lobby2.tables?.some((t) => t.gameType === 'omaha4')) fail('omaha4 cash table missing from lobby')
    if (!lobby2.tables?.some((t) => t.gameType === 'omaha5')) fail('omaha5 cash table missing from lobby')
    console.log('lobby: omaha4 + omaha5 tables present ✓')

    // ---- tournaments: heads-up STT full lifecycle (register → bot fill →
    // auto-start → play → finish → payout) ----
    const createT = await fetch(`${BASE}/api/admin/tournaments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({
        name: 'E2E Cup',
        gameType: 'holdem',
        kind: 'sitgo',
        buyIn: 100,
        startingStack: 200,
        seatsPerTable: 2,
        maxPlayers: 2,
        turbo: true,
      }),
    })
    if (createT.status !== 200) fail(`admin tournament create failed: ${createT.status}`)
    const createTBody = (await createT.json()) as { tournament?: { id?: string } }
    const tid = createTBody.tournament?.id
    if (!tid) fail('tournament create returned no id')

    const tReg = await fetch(`${BASE}/api/tournaments/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ id: tid }),
    })
    const tRegBody = (await tReg.json()) as { chips?: number }
    if (tReg.status !== 200 || tRegBody.chips !== finalChips - 100) fail(`tournament register failed: ${tReg.status}`)
    console.log('tournament: registered, buy-in deducted')

    // duplicate registration must fail cleanly
    const tReg2 = await fetch(`${BASE}/api/tournaments/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ id: tid }),
    })
    if (tReg2.status === 200) fail('duplicate tournament registration should fail')

    const tFill = await fetch(`${BASE}/api/admin/tournaments/fill`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ id: tid, count: 1 }),
    })
    const tFillBody = (await tFill.json()) as { added?: number }
    if (tFill.status !== 200 || tFillBody.added !== 1) fail(`tournament bot fill failed: ${tFill.status}`)
    console.log('tournament: bot filled → sitgo auto-started')

    // wait for running state
    const tStart = Date.now()
    for (;;) {
      const tList = (await (await fetch(`${BASE}/api/tournaments`, { headers: { cookie } })).json()) as {
        tournaments?: { id: string; state: string }[]
      }
      const found = tList.tournaments?.find((x) => x.id === tid)
      if (found?.state === 'running') break
      if (Date.now() - tStart > 20_000) fail(`tournament never started (state=${found?.state ?? 'none'})`)
      await new Promise((r) => setTimeout(r, 500))
    }
    console.log('tournament: running')

    const tJoin = await fetch(`${BASE}/api/tournaments/join`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ id: tid }),
    })
    const tJoinBody = (await tJoin.json()) as { tableKey?: string }
    if (tJoin.status !== 200 || !tJoinBody.tableKey) fail(`tournament join failed: ${tJoin.status}`)
    const tTableKey = tJoinBody.tableKey!
    console.log(`tournament: seat at ${tTableKey}`)

    // connect and auto-play until the tournament finishes
    const tws = new WebSocket(BASE.replace(/^http/, 'ws') + `/api/poker-socket?table=${encodeURIComponent(tTableKey)}`, {
      headers: { cookie },
    } as unknown as string[])
    const tState = { view: null as Record<string, any> | null, acted: 0 }
    tws.onmessage = (ev) => {
      let data: any
      try {
        data = JSON.parse(ev.data as string)
      } catch {
        return
      }
      if (data.t === 'state') {
        tState.view = data.view
        const v = data.view
        if (v?.actorUserId && v.selfSeat != null && v.seats?.[v.selfSeat]?.userId === v.actorUserId && v.selfOptions) {
          const o = v.selfOptions
          const type = o.canCheck ? 'check' : o.canCall && o.callAmount <= 40 ? 'call' : 'fold'
          tState.acted++
          tws.send(JSON.stringify({ t: 'action', type }))
        }
      } else if (data.t === 'err') {
        console.error('tournament ws error:', data.message)
      }
    }
    await new Promise<void>((resolve, reject) => {
      tws.onopen = () => resolve()
      setTimeout(() => reject(new Error('tournament ws open timeout')), 8000)
    })
    console.log('tournament: ws open, auto-playing')

    // play until finished (fast local DB) — cap 5 minutes
    let finishPlace: number | null = null
    let prizeWon: number | null = null
    const tPlayStart = Date.now()
    for (;;) {
      const tList = (await (await fetch(`${BASE}/api/tournaments`, { headers: { cookie } })).json()) as {
        tournaments?: { id: string; state: string; finishPlace: number | null; prizeWon: number | null }[]
      }
      const found = tList.tournaments?.find((x) => x.id === tid)
      if (found?.state === 'finished') {
        finishPlace = found.finishPlace
        prizeWon = found.prizeWon
        break
      }
      if (Date.now() - tPlayStart > 300_000) fail(`tournament never finished (acted=${tState.acted})`)
      await new Promise((r) => setTimeout(r, 1500))
    }
    tws.close()
    if (finishPlace == null || (finishPlace !== 1 && finishPlace !== 2)) fail(`bad finish place: ${finishPlace}`)
    const meFinal = await fetch(`${BASE}/api/auth/me`, { headers: { cookie } })
    const meFinalBody = (await meFinal.json()) as { user?: { chips: number } }
    const expectedChips = finishPlace === 1 ? finalChips : finalChips - 100
    if (meFinalBody.user?.chips !== expectedChips)
      fail(`payout mismatch: place ${finishPlace}, chips ${meFinalBody.user?.chips} != expected ${expectedChips}`)
    console.log(
      `tournament: finished place=${finishPlace} prize=${prizeWon ?? 0} bounty=0 chips=${meFinalBody.user?.chips} ✓`,
    )

    // cancelled-tournament refunds: create + register + cancel → refund
    const createC = await fetch(`${BASE}/api/admin/tournaments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ name: 'Cancel Me', kind: 'sitgo', buyIn: 50, startingStack: 200, seatsPerTable: 2, maxPlayers: 2 }),
    })
    const createCBody = (await createC.json()) as { tournament?: { id?: string } }
    const cid = createCBody.tournament?.id
    await fetch(`${BASE}/api/tournaments/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ id: cid }),
    })
    const beforeCancel = (await (await fetch(`${BASE}/api/auth/me`, { headers: { cookie } })).json()) as { user?: { chips: number } }
    const cancel = await fetch(`${BASE}/api/admin/tournaments/cancel`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ id: cid }),
    })
    const cancelBody = (await cancel.json()) as { refunded?: number }
    if (cancel.status !== 200 || cancelBody.refunded !== 1) fail(`cancel/refund failed: ${cancel.status}`)
    const beforeChips = beforeCancel.user?.chips
    const afterCancel = (await (await fetch(`${BASE}/api/auth/me`, { headers: { cookie } })).json()) as { user?: { chips: number } }
    if (beforeChips == null || afterCancel.user?.chips !== beforeChips + 50) fail('refund amount wrong')
    console.log('tournament: cancel + refund ✓')
  } else if (claim.status === 409) {
    console.log('admin claim: already burned on this database (expected in production)')
  } else {
    fail(`admin claim unexpected status ${claim.status}`)
  }
}

clearTimeout(failTimer)
ws.close()
try {
  wsB.close()
} catch {
  /* already closed */
}
console.log(`chat: history=${state.chatHistory} live=${state.chatMsg}`)

// ---------- godmode surface (local-only) ----------
// Runs when E2E_LOCAL_ADMIN=1: promotes player A to admin straight in the
// local D1 (no passphrase needed on a dev database) and exercises every
// godmode endpoint — including the force-logout session revocation.
if (process.env.E2E_LOCAL_ADMIN === '1') {
  const { execSync } = await import('node:child_process')
  execSync(
    `bunx wrangler d1 execute royal-felt --local --command "UPDATE User SET role='admin' WHERE id='${userId}'"`,
    { stdio: 'pipe' },
  )
  const adminCookie = cookie
  const B = userIdB!
  const jpost = async (url: string, body: unknown) => {
    const res = await fetch(`${BASE}${url}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: adminCookie },
      body: JSON.stringify(body),
    })
    return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, unknown> }
  }

  // rename + rename clash (another player's name must be rejected)
  const ren = await jpost('/api/admin/players/rename', { userId: B, username: 'e2e_renamed' })
  if (ren.status !== 200) fail(`rename failed: ${ren.status} ${JSON.stringify(ren.body)}`)
  const renClash = await jpost('/api/admin/players/rename', { userId: B, username })
  if (renClash.status === 200) fail('rename onto another player\'s name should fail')
  console.log('godmode: rename + clash-guard ✓')

  // password reset → returns a generated secret; old session must die
  const pw = await jpost('/api/admin/players/password', { userId: B })
  if (pw.status !== 200 || typeof pw.body.password !== 'string') fail(`password reset failed: ${pw.status}`)
  const meAfterPw = (await (await fetch(`${BASE}/api/auth/me`, { headers: { cookie: cookieB! } })).json()) as { user?: unknown }
  if (meAfterPw.user !== null) fail('session survived a password reset — force-logout broken')
  console.log('godmode: password reset kills sessions ✓')

  // force logout on a fresh login
  const relogin = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'e2e_renamed', password: pw.body.password }),
  })
  const reloginCookie = (relogin.headers.get('set-cookie') ?? '').split(';')[0] ?? ''
  if (!reloginCookie) fail('relogin with reset password failed')
  const lo = await jpost('/api/admin/players/logout', { userId: B })
  if (lo.status !== 200) fail(`force logout failed: ${lo.status}`)
  const meAfterLo = (await (await fetch(`${BASE}/api/auth/me`, { headers: { cookie: reloginCookie } })).json()) as { user?: unknown }
  if (meAfterLo.user !== null) fail('session survived force logout')
  console.log('godmode: force logout invalidates tokens ✓')

  // bulk chips + locate + audit trail
  const bulk = await jpost('/api/admin/chips/bulk', { delta: 777, reason: 'e2e bulk' })
  if (bulk.status !== 200 || typeof bulk.body.changed !== 'number') fail(`bulk chips failed: ${bulk.status}`)
  const loc = await jpost('/api/admin/players/locate', { userId: B })
  if (loc.status !== 200 || !Array.isArray(loc.body.seated)) fail(`locate failed: ${loc.status}`)
  const bc = await jpost('/api/admin/broadcast', { message: 'e2e announcement', target: 'lobby' })
  if (bc.status !== 200 || bc.body.ok !== true) fail(`broadcast failed: ${bc.status}`)
  const kickUnknown = await jpost('/api/admin/tables/kick', { tableKey: 'not-a-table', userId: B })
  if (kickUnknown.status !== 400) fail('kick with unknown table should 400')
  const audit = await fetch(`${BASE}/api/admin/audit`, { headers: { cookie: adminCookie } })
  const auditBody = (await audit.json()) as { log?: { action: string; target: string }[] }
  if (audit.status !== 200 || !auditBody.log?.length) fail('audit log empty after godmode actions')
  const actions = new Set(auditBody.log!.map((l) => l.action))
  for (const expected of ['chips.bulk', 'broadcast', 'player.rename', 'player.password', 'player.logout']) {
    if (!actions.has(expected)) fail(`audit missing action: ${expected}`)
  }
  console.log(`godmode: bulk(${bulk.body.changed} accounts) + locate + broadcast + kick-guard + audit trail ✓`)

  // hard delete closes the loop
  const del = await jpost('/api/admin/players/delete', { userId: B })
  if (del.status !== 200) fail(`delete failed: ${del.status}`)
  const gone = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'e2e_renamed', password: pw.body.password }),
  })
  if (gone.status !== 401) fail('deleted account still logs in')
  console.log('godmode: hard delete ✓')

  // last-admin guard: demoting the only admin must fail
  const demote = await jpost('/api/admin/players/role', { userId: userId!, role: 'player' })
  if (demote.status !== 409) fail(`last-admin demote should 409, got ${demote.status}`)
  console.log('godmode: last-admin guard ✓')
}

// ---------- self-service password change (safe on any environment) ----------
// Fresh throwaway account: change password → old session dies → the fresh
// cookie from the change response still works → relogin with new password.
{
  const pwName = `PwChg${Math.floor(Math.random() * 100000)}`
  const pwOld = 'pw-old-12345'
  const pwNew = 'pw-new-67890'
  const reg = await fetch(`${BASE}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: pwName, password: pwOld }),
  })
  const cookieOld = (reg.headers.get('set-cookie') ?? '').split(';')[0] ?? ''
  if (!reg.ok || !cookieOld) fail('password-change target registration failed')

  const noAuth = await fetch(`${BASE}/api/auth/password`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ currentPassword: pwOld, newPassword: pwNew }),
  })
  if (noAuth.status !== 401) fail(`password change without session should 401, got ${noAuth.status}`)

  const wrongCur = await fetch(`${BASE}/api/auth/password`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', cookie: cookieOld },
    body: JSON.stringify({ currentPassword: 'wrong-password', newPassword: pwNew }),
  })
  if (wrongCur.status !== 401) fail(`password change with wrong current password should 401, got ${wrongCur.status}`)

  const shortNew = await fetch(`${BASE}/api/auth/password`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', cookie: cookieOld },
    body: JSON.stringify({ currentPassword: pwOld, newPassword: 'short' }),
  })
  if (shortNew.status !== 400) fail(`password change with short new password should 400, got ${shortNew.status}`)

  const change = await fetch(`${BASE}/api/auth/password`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', cookie: cookieOld },
    body: JSON.stringify({ currentPassword: pwOld, newPassword: pwNew }),
  })
  if (change.status !== 200) fail(`password change failed: ${change.status} ${await change.text()}`)
  const cookieNew = (change.headers.get('set-cookie') ?? '').split(';')[0] ?? ''
  if (!cookieNew) fail('password change returned no fresh cookie')

  const meOld = (await (await fetch(`${BASE}/api/auth/me`, { headers: { cookie: cookieOld } })).json()) as { user?: unknown }
  if (meOld.user !== null) fail('old session survived a self-service password change')
  const meNew = (await (await fetch(`${BASE}/api/auth/me`, { headers: { cookie: cookieNew } })).json()) as { user?: { username?: string } }
  if (meNew.user?.username !== pwName) fail('fresh cookie after password change does not resolve the user')

  const relogin = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: pwName, password: pwNew }),
  })
  if (relogin.status !== 200) fail('relogin with the new password failed')
  const oldPwLogin = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: pwName, password: pwOld }),
  })
  if (oldPwLogin.status !== 401) fail('old password still logs in after change')
  console.log('self-service password change: gates + session kill + relogin ✓')
}

console.log('E2E OK ✓')
process.exit(0)
