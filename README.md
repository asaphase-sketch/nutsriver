# Royal Felt — Play-Money Online Poker

A free, best-practice **play-money** No-Limit Texas Hold'em poker site. Virtual chips only — nothing of monetary value can ever be bought, sold, won or redeemed.

> **Standing directive:** see [PROJECT_CHARTER.md](./PROJECT_CHARTER.md) — the product targets the
> GGPoker / PokerStars play-money experience on the Cloudflare **free plan**, sized for
> **100 concurrent players**. Every change must comply.

![stack](https://img.shields.io/badge/Cloudflare%20Workers-free%20plan-orange) ![ts](https://img.shields.io/badge/TypeScript-strict-blue) ![db](https://img.shields.io/badge/storage-D1%20%2B%20Durable%20Objects-pink)

## Features

- **No-Limit Texas Hold'em** with the full betting ruleset: blinds, min-raise tracking, incomplete all-in raises, side pots, uncalled-bet refunds, odd-chip distribution, showdown reveals.
- **Server-authoritative engine** — clients only send intents (`fold/check/call/bet/raise`); every rule decision, chip movement and card deal happens server-side. Hole cards are redacted per-viewer, so packet sniffing reveals nothing.
- **Cryptographically fair shuffling** — Fisher–Yates using rejection-sampled `crypto.getRandomValues` integers (no modulo bias).
- **Live lobby** with four stakes rooms, real-time seat/pot/hand counters and house bots that keep tables active while humans are seated (Chen-formula preflop + heuristic postflop, deliberately beatable).
- **Accounts & virtual chip ledger** — PBKDF2 password hashing, HMAC-signed httpOnly session cookies, and a full `ChipTransaction` audit trail for every chip movement. Free top-up when balance drops below 1,000 (10-min cooldown).
- **Real-time table UI** — oval felt with up to 9 seats, dealer/SB/BB buttons, bet chips, action timer bar with auto fold/check, quick-bet sizing (min / ⅓ / ½ / pot / all-in), keyboard shortcuts (F/C/R), hand log, chat, last-hand summary and a hand-rankings reference.
- **Disconnect handling** — missed actions auto-fold/check after the action timer, long disconnects stand the player up and return the stack.
- **Responsive** mobile-first layout (the table felt grows taller on small screens).

## Tech Stack

| Layer      | Choice |
|------------|--------|
| Runtime    | **Cloudflare Workers** (free plan) — static assets + API + realtime in one deploy |
| Realtime   | One **Durable Object per table** — WebSocket (Hibernation API), **durable alarms** drive hand continuations & action timers |
| State      | Engine state serialized to **DO SQLite storage** on every mutation — tables survive eviction mid-hand |
| Accounts   | **Cloudflare D1** (SQLite) — users, full chip ledger, hand history |
| Frontend   | Next.js 16 (static export) + TypeScript 5 strict + Tailwind CSS 4 + shadcn/ui |
| Auth       | PBKDF2-SHA256 (25k iters, per-user salt) + HMAC-SHA256 session cookies (WebCrypto only — no Node APIs) |
| Game AI    | Heuristic bots (Chen formula + made-hand/draw logic) |

## Architecture

```
src/
├── app/page.tsx               # single-page client: auth → lobby → table
├── components/poker/          # table view, seats, cards, action bar, panels
├── hooks/use-poker.ts         # raw-WebSocket client + all client state
└── lib/poker-engine/          # ★ the engine (framework-free, fuzz-tested)
    ├── engine.ts              # PokerTable state machine — serialization built in
    ├── handEval.ts            # 5/6/7-card evaluator
    ├── cards.ts               # crypto-secure deck + shuffle (WebCrypto)
    ├── bots.ts                # house bot AI
    └── types.ts
workers/
├── index.ts                   # router: auth API, lobby, WS upgrade, assets
├── table-do.ts                # one Durable Object per table (alarms + hibernation)
├── store.ts                   # D1 ledger (atomic guarded updates)
└── auth.ts                    # PBKDF2 + HMAC session tokens (WebCrypto)
```

### How realtime works

The browser opens one WebSocket per table (`/api/poker-socket?table=<key>`). The Worker authenticates the session cookie and forwards the upgrade to the table's Durable Object, which keeps engine state in memory, persists it on every mutation, and drives the game with **durable alarms** (action deadlines, street runouts, bot thinking time). Idle tables go to sleep (Hibernation API) and cost nothing; bot-only tables never start hands, so the free-plan quotas stretch a long way. If a DO is evicted mid-hand, the next alarm or message restores the exact engine state from storage — including the shuffled deck order.

## Getting Started (local)

```bash
bun install
bun run build          # static export → ./out (server dirs stashed temporarily)
echo "AUTH_SECRET=change-me" > .dev.vars
echo "E2E_FAST=1" >> .dev.vars   # optional: fast game timings for testing
bun run dev            # wrangler dev → http://localhost:3000 (full stack, local D1/DOs)
```

Open the app, create an account, and you start with **10,000 free chips**.

### Tests

```bash
bun run lint               # eslint
bun run typecheck          # app, strict
bun run typecheck:workers  # workers, strict
bun run sim                # evaluator unit tests + multi-thousand-hand randomized fuzz
bun run e2e                # full E2E over raw WebSocket against a running `wrangler dev`
```

CI (GitHub Actions) runs all of the above on every push and PR.

## Deploy to Cloudflare (free plan)

```bash
bun run deploy
# first time:
wrangler d1 create royal-felt          # put the returned database_id into wrangler.jsonc
wrangler d1 execute royal-felt --remote --file=workers/schema.sql  # optional; schema auto-applies
wrangler secret put AUTH_SECRET        # long random string
bun run deploy                         # → https://royal-felt.<your-subdomain>.workers.dev
```

### Auto-deploy from CI (optional)

`.github/workflows/deploy.yml` deploys to Cloudflare whenever CI passes on `main`.
Enable it by adding two repository secrets (**Settings → Secrets and variables → Actions**):

| Secret | Value |
| --- | --- |
| `CLOUDFLARE_API_TOKEN` | API token with **Edit Workers** + **D1 Edit** permissions |
| `CLOUDFLARE_ACCOUNT_ID` | Your Cloudflare account id (dashboard → Workers & Pages → right sidebar) |

## Play-Money Pledge

This project exists for entertainment and education. Chips have no monetary value, cannot be purchased, and cannot be redeemed. There is no real-money gambling anywhere in this codebase. 18+ recommended — play responsibly.
