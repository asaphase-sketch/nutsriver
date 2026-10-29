# NutsRiver Project Charter — STANDING DIRECTIVE

> **This file is the permanent product & platform contract. Every feature, fix and
> refactor must comply. If a change violates this charter, the change is wrong.**

Adopted 2026-10-29 at the owner's direction:

> "continue improvements but with like ggpoker+pokerstars sites but play-money.
> high standards but free tier cloudflare plan for 100 user playing with no problem.
> remember that forever"

---

## 1. North star — product bar

NutsRiver is a **free play-money poker room** that must feel like the
**GGPoker / PokerStars play-money experience**: polished, fast, trustworthy.

- **Feel**: real poker room, not a demo — live lobby, seat urgency, action clocks,
  sounds, hand history, replays, leaderboards, cashier-style free top-ups.
- **Games**: No-Limit Hold'em, Omaha 4/5, cash games + tournaments (Sit & Go and
  scheduled, knockout support), 6-max and 9-max.
- **Fairness & safety first**: server-authoritative engine (fuzz-tested), no client
  trust, privacy-masked hand histories (opponents' cards visible only after
  showdown), rate limits everywhere, banned-account enforcement.
- **Legality hygiene**: chips have no monetary value, cannot be bought or cashed
  out; the disclaimer stays in the app footer. 18+ recommended messaging stays.
- **UX bar checklist for every new surface**: responsive down to phones, works on
  flaky mobile connections (auto-reconnect + state resync), no dead-end states,
  accessible focus states, English copy, no jargon without a tooltip.

## 2. Platform contract — Cloudflare FREE tier, forever

Runs entirely on the **Cloudflare Workers free plan**: Workers (static assets +
API), D1, Durable Objects (SQLite-backed), WebSockets via the Hibernation API.
**No paid upgrades. No new infrastructure dependencies.** Growth is handled by
being frugal, not by spending.

### Capacity target

**100 concurrent players** playing simultaneously with no degradation, and a
full day of that traffic staying inside the free daily allowances.

### Free-tier daily allowances (the budget)

| Resource | Free allowance | Notes for NutsRiver |
|---|---|---|
| Workers requests | 100,000/day | Static asset requests are free; API calls are the budget |
| DO requests | 100,000/day | **Incoming WS messages + alarms + DO→DO fetches all count** |
| DO duration | 13,000 GB-s/day | Hibernation keeps idle cost ≈ 0 |
| D1 rows read | 5M/day | Hand-history queries are LIMITed + cursor paginated |
| D1 rows written | 100k/day | Write at hand boundaries, not per action |

### Engineering rules (non-negotiable)

1. **Hibernation everywhere** — every WebSocket lives in a Durable Object using
   `acceptWebSocket` + hibernation. Idle sockets cost nothing; server→client
   pushes are **free** (only inbound messages count).
2. **Push over poll** — live surfaces (table, lobby, tournaments) use server
   pushes from a DO. HTTP polling exists only as a fallback when the socket is
   down, and must pause when the tab is hidden.
3. **Lobby economics** — the lobby is served by one LobbyDO that fans out to
   table DOs on an alarm, **sleeps (no alarm) when nobody is subscribed**, and
   widens its refresh cadence as viewer count grows (10s small room, 30s busy
   room). Never fan out per-client.
4. **Alarms are the only timers** — game flow (streets, showdowns, bot turns,
   timeouts) is driven by durable alarms, never `setTimeout`, so state survives
   eviction and idle tables cost zero.
5. **Bots are atmosphere, not a load source** — house bots act only while a
   human is seated; tables with no humans never deal hands and stay asleep.
6. **D1 frugality** — persist engine state in DO storage (free), write D1 rows
   only for durable facts (buy-ins, cash-outs, completed hands, tournaments).
   History/pruning jobs run on the nightly cron.
7. **Client frugality** — reconnect with backoff, resync via `hello` instead of
   re-subscribe storms, rate-limit outbound chat/actions server-side.
8. **One more table is cheaper than one more server** — seat capacity scales by
   adding `TABLE_CONFIGS` entries; an idle table DO costs ~nothing.

### Budget arithmetic at 100 CCU (why the above rules)

- Table DOs: ~20–30 alarm wakes + ~40 inbound messages per active player-hour
  → ~50k DO requests on a busy day — fits.
- LobbyDO: ≤2,880 alarms + ≤30k fan-out fetches at the 30s cadence — fits.
- Workers: lobbies/leaderboards/auth are a few thousand requests/day — fits.
- D1: thousands of writes/day vs 100k allowance — fits.

Any feature proposal that would blow these numbers must be redesigned (batch,
push, cache or drop) before it is built.

## 3. What "done" means for every task

- lint + typecheck (app & workers) + engine fuzz + build + E2E all green,
- prod E2E on the hidden `e2efelt` table passes after auto-deploy,
- browser-verified on desktop + mobile viewport with screenshots,
- worklog updated,
- **the charter still holds**.

## 4. Roadmap ladder (GGPoker/PokerStars parity)

Done: cash + tournaments engine, 2.5D felt, sounds, action clock, sit-out,
rebuy, hand history (privacy-masked), admin panel, bots policy, E2E harness.

Live room (this task): live lobby (WS push), lobby filters/sort/quick-seat,
chip leaderboard, 4-color deck, more tables (66 seats).

Next candidates, in order: hand **replay viewer** (street-by-street playback),
waitlists for full tables, personal stats page (VPIP-style from hand history),
table themes, bigger tournament schedule, localization.
