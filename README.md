# OddsGlance

**Live Polymarket odds on Even G2 glasses — glance, tap, paper-trade.**

OddsGlance shows the hottest binary Polymarket markets at a glance on the Even Realities G2 lens (576×288), lets you place a **paper bet with one tap**, and tracks your paper portfolio with **live PnL**. Read *and* write — with zero real money, no API keys, and no backend.

- **Hackathon:** Heads Up: Even Realities Hackathon (DoraHacks)
- **Track:** 02 · Crypto & DeFi (Polymarket)
- **Demo video:** ≤3 min, recorded in the Even Hub simulator (link added on the DoraHacks BUIDL page)
- **Packaged build:** `oddsglance.ehpk` (in this repo, produced by `evenhub pack`)

## The problem

Checking prediction-market odds means pulling out your phone and opening a dense trading UI just to read one number. Odds are glance data — one question, one percentage — and glasses are the right surface for them. OddsGlance is built for that: one screen, a few words, one action.

## Features

- **Live markets, at a glance** — the 8 hottest active binary markets on Polymarket, ranked by 24h volume, each shown as question + leading outcome + live odds %. Data refreshes on open and every 60 seconds while the app runs.
- **Market detail** — full question, both outcomes with live odds, 24h volume, and end date.
- **Paper bet in one tap** — tap to pick a side, scroll to pick a stake ($10 / $25 / $50 / $100 paper), one tap to place. Positions are stored on-device.
- **Paper portfolio with live PnL** — equity, cash, and total PnL; each position marked to live odds (entry vs. now). Tap a position to cash out at current odds. Resolved markets settle automatically at the final price.
- **Resilient by design** — if the network fails, the last good data is shown with a `STALE` marker instead of a crash; malformed or non-binary markets are filtered out safely.
- **Safe by design** — 100% paper trading. No wallet, no real funds, no API keys, no backend, no accounts. In-app disclaimer: *Paper trading demo — not financial advice.*

You start with **$1,000 in paper funds**.

## How it works

```
Polymarket Gamma API (public, keyless, read-only)
  GET /markets/keyset?active=true&closed=false&order=volume24hr&ascending=false
        ← top binary markets by 24h volume (keyset paging via after_cursor)
  GET /markets/keyset?id={id}   ← live refresh of one market (detail & PnL)
        │
        ▼
OddsGlance (Vite + TypeScript + @evenrealities/even_hub_sdk)
  Screen 1  Markets    — ListContainer: 8 markets + odds %
  Screen 2  Detail     — both outcomes, volume, paper-bet flow
  Screen 3  Portfolio  — positions, live PnL, cash out
        │
        ▼
Even G2 lens (576×288) — scroll to choose, tap to act
```

- The app fetches market data directly from `gamma-api.polymarket.com` (whitelisted in `app.json`; the API returns `Access-Control-Allow-Origin: *`, so no proxy or backend is needed). It uses the **`/markets/keyset`** endpoint family — the classic `/markets` endpoints are deprecated (sunset May 1, 2026) and are not used anywhere.
- The Gamma API is quirky: `outcomes`/`outcomePrices` may arrive as native arrays (keyset) or as JSON strings inside JSON (classic). The parser accepts both, and only markets with exactly 2 outcomes and valid prices (0 < p < 1) are shown.
- Paper-trading math: buying a position gives `shares = stake / entryPrice`; current value is `shares × currentPrice`; PnL is `value − stake`. Cashing out credits the current value to paper cash. A market that closes settles at its final price (0 or 1).
- Paper balance and positions persist on-device between sessions via the Even bridge storage API (`setLocalStorage` / `getLocalStorage`, key `oddsglance.portfolio.v1`), with an in-memory fallback for local browser testing. Persistence was verified in the simulator within a session.

## Run it (simulator — no glasses needed)

Prerequisites: Node.js 20+ (built and tested with v24.22.1) and the Even Hub tools.

```bash
npm install -g @evenrealities/evenhub-cli @evenrealities/evenhub-simulator
git clone <this repo>
cd <repo folder>
npm install
npm run dev                              # Vite dev server → http://localhost:5173
npm run simulate                         # Even Hub simulator on the dev server
```

In the simulator: scroll to move the selection, click to tap, double-click for the system exit dialog.

Other scripts:

```bash
npm run build        # type-check (tsc strict) + production build to dist/
npm run test:logic   # 33-assertion logic test suite (parsing, paper math, live API)
npm run pack         # build + `evenhub pack app.json dist` → .ehpk package
```

## Project structure

```
app.json            Even Hub manifest (network whitelist: gamma-api.polymarket.com)
index.html          Vite entry (from the official template, unmodified)
package.json        Scripts: dev / build / pack / simulate / test:logic
public/icon.png     Greyscale app icon
src/
  main.ts           Bootstrap (waitForEvenAppBridge), screen router, event handling
  gamma.ts          Polymarket Gamma API client (/markets/keyset): fetch, parse, normalize, last-good cache
  state.ts          Paper portfolio store (balance, positions) + bridge-storage persistence
  format.ts         Odds %, currency, date, and text-truncation formatting
  screens/
    common.ts       Shared screen helpers
    markets.ts      Screen 1: market list
    detail.ts       Screen 2: market detail + paper-bet flow
    portfolio.ts    Screen 3: positions, PnL, cash out
test/
  logic.test.cjs    Logic test suite (33 assertions, incl. live Gamma checks)
qa-screenshots/     Simulator QA captures (markets, detail, bet placed, portfolio)
oddsglance.ehpk     Packaged build (evenhub pack)
```

## What existed before Nov 23 (hackathon rules disclosure)

Per the hackathon rule *"Build during the hackathon. Open-source libraries and existing APIs are allowed; say in your README what existed before Nov 23"*:

**Existed before Nov 23, 2026:**
- Planning documents only: a feasibility assessment, a technical specification, and design notes for this concept.
- Documented research checks against the public Polymarket Gamma API (endpoint behavior and CORS headers — notes, no code).
- A README skeleton and empty folder structure.

**Did NOT exist before Nov 23:** all application code, the `app.json` manifest, project configuration, and assets. Everything was built during the build week (Nov 23–29, 2026), starting from the official Even Hub `minimal` template.

**Pre-existing third-party resources used (allowed):**
- Even Hub SDK and official templates — © Even Realities, MIT License.
- Polymarket Gamma API — public, keyless, read-only market data.

## Safety

- Paper trading only — this app never moves real money and never connects a wallet.
- No API keys or secrets are used or committed.
- This is a demo, **not financial advice**.

## License

Project code: MIT. Even Hub templates/SDK: MIT (Even Realities).
