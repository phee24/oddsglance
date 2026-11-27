# OddsGlance Telegram alerts relay

Watches Polymarket markets and pings you on Telegram when one moves a lot —
even while the glasses app is closed.

## Why this exists

The Even G2 app cannot run in the background or push anything while it is
closed (DESIGN.md §4.8 — no background push on device). So the "tell me
when my position moves while the app is shut" half of the feature has to
live outside the glasses. This script is that half: it polls the same
public Gamma API the app uses, applies the same 10-point big-move rule as
`src/alerts.ts`, and sends one Telegram message per crossing.

The in-app half (while the app is open): the Markets header shows
`⚠ N alerts` and the Portfolio screen shows the alert banner for the
biggest mover. Same rule, same threshold, two surfaces.

## Setup (5 minutes, no server)

1. **Make a bot:** message [@BotFather](https://t.me/BotFather) on
   Telegram, send `/newbot`, follow the prompts, copy the bot token.
2. **Get your chat id:** message your new bot once (any text), then open
   `https://api.telegram.org/bot<TOKEN>/getUpdates` in a browser and copy
   the `chat.id` number. (Or ask [@userinfobot](https://t.me/userinfobot).)
3. **List the markets:** copy `config.example.json` to `config.json` and
   replace the id with the market ids you care about — the number at the
   end of a `polymarket.com/event/...` URL. Same ids the app's watchlist
   uses. Optional per-market `thresholdPts` (default 10 = a 10-point move,
   e.g. 62% → 72%).
4. **Run it:**
   ```
   TELEGRAM_BOT_TOKEN=... TELEGRAM_CHAT_ID=... node notify.mjs
   ```
   Add `--once` for a single pass (good for testing), `--dry-run` to print
   the message instead of sending it.
5. **Keep it running:** leave the terminal open, or run it as a systemd
   service / under `pm2` / on any always-on machine. Poll interval:
   `pollSeconds` in `config.json` (default 60).

## What it sends

One message per threshold crossing, then it re-baselines so the next alert
needs another full move (no spam every minute):

```
⚠ OddsGlance alert
Will the Fed cut rates in December?
Yes 62% → 74% (▲ +12 pts)
https://polymarket.com/event/fed-cut-rates-december
```

Closed markets are skipped (the app's auto-settle covers positions there).

## Safety

- **Read-only:** the relay only fetches public odds. No wallet, no funds,
  no Polymarket account, no real-money betting anywhere in OddsGlance.
- **Secrets:** the bot token and chat id live only in environment
  variables — never in `config.json`. `config.json` and `state.json`
  (price baselines) are gitignored; do not commit them.
- **No dependencies:** plain Node.js 20+ (`fetch` only). No `npm install`.
