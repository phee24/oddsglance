// OddsGlance Telegram alerts relay — watches Polymarket markets and pings
// you on Telegram when one moves a lot, even while the glasses app is
// closed.
//
// Why a relay exists at all: the Even G2 app cannot run in the background
// or push anything while closed (DESIGN.md §4.8), so the "notify me while
// the app is shut" half of the feature has to live outside the glasses.
// This tiny script is that half: it polls the same public Gamma API the
// app uses, applies the same 10-point big-move rule as src/alerts.ts, and
// sends one Telegram message per crossing. No server, no database, no
// wallet, no real money — the relay only READS public odds.
//
// Usage:
//   1. Talk to @BotFather on Telegram, /newbot, copy the bot token.
//   2. Message your bot once, then get your chat id from
//      https://api.telegram.org/bot<TOKEN>/getUpdates (or @userinfobot).
//   3. cp config.example.json config.json and list the market ids you care
//      about (the number at the end of a polymarket.com/event/... URL, or
//      the id shown in the app's watchlist flow — same market ids).
//   4. TELEGRAM_BOT_TOKEN=... TELEGRAM_CHAT_ID=... node notify.mjs
//      (add --once for a single pass; --dry-run prints instead of sending)
//   5. Keep it running: `node notify.mjs` in a terminal, or a systemd
//      service / cron that restarts it. Poll interval: config pollSeconds.
//
// Secrets live ONLY in environment variables — never in config.json.
// config.json and state.json are gitignored; do not commit them.

import { readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const GAMMA_BASE = 'https://gamma-api.polymarket.com'
const FETCH_TIMEOUT_MS = 12_000
const DEFAULT_THRESHOLD_PTS = 10

const here = dirname(fileURLToPath(import.meta.url))
const args = process.argv.slice(2)
const once = args.includes('--once')
const dryRun = args.includes('--dry-run')
const configFlag = args.find((a) => a.startsWith('--config='))
const configPath = configFlag ? configFlag.slice('--config='.length) : join(here, 'config.json')
const statePath = join(here, 'state.json')

function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`)
}

async function fetchJson(url) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS)
  try {
    const res = await fetch(url, { signal: ctrl.signal })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return await res.json()
  } finally {
    clearTimeout(timer)
  }
}

function parseMarket(raw) {
  if (typeof raw !== 'object' || raw === null) return null
  const id = typeof raw.id === 'string' ? raw.id : typeof raw.id === 'number' ? String(raw.id) : null
  const question = typeof raw.question === 'string' ? raw.question : null
  if (!id || !question) return null
  const parseArr = (v) => {
    if (typeof v === 'string') {
      try {
        v = JSON.parse(v)
      } catch {
        return null
      }
    }
    return Array.isArray(v) ? v : null
  }
  const outcomes = parseArr(raw.outcomes)
  const pricesRaw = parseArr(raw.outcomePrices)
  if (!outcomes || outcomes.length !== 2 || !pricesRaw || pricesRaw.length !== 2) return null
  const prices = pricesRaw.map(Number)
  if (prices.some((p) => !Number.isFinite(p) || p < 0 || p > 1)) return null
  return {
    id,
    question,
    outcomes: [outcomes[0], outcomes[1]],
    prices: [prices[0], prices[1]],
    slug: typeof raw.slug === 'string' ? raw.slug : null,
    closed: raw.closed === true,
  }
}

async function fetchMarketById(id) {
  const payload = await fetchJson(`${GAMMA_BASE}/markets/keyset?id=${encodeURIComponent(id)}`)
  const raws = Array.isArray(payload) ? payload : Array.isArray(payload?.markets) ? payload.markets : []
  for (const raw of raws) {
    const m = parseMarket(raw)
    if (m && m.id === id) return m
  }
  return null
}

async function sendTelegram(token, chatId, text) {
  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text }),
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`Telegram HTTP ${res.status}: ${body.slice(0, 200)}`)
  }
}

async function loadState() {
  if (!existsSync(statePath)) return { baselines: {} }
  try {
    const raw = JSON.parse(await readFile(statePath, 'utf8'))
    if (typeof raw === 'object' && raw !== null && typeof raw.baselines === 'object' && raw.baselines !== null) {
      return { baselines: raw.baselines }
    }
  } catch {
    // Corrupt state -> start fresh, never crash the loop.
  }
  return { baselines: {} }
}

async function saveState(state) {
  await writeFile(statePath, JSON.stringify(state, null, 2) + '\n')
}

async function main() {
  const token = process.env.TELEGRAM_BOT_TOKEN || ''
  const chatId = process.env.TELEGRAM_CHAT_ID || ''
  if (!dryRun && (!token || !chatId)) {
    console.error('Missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID. See README.md. (--dry-run skips sending.)')
    process.exit(2)
  }
  let config
  try {
    config = JSON.parse(await readFile(configPath, 'utf8'))
  } catch {
    console.error(`Cannot read ${configPath}. Copy config.example.json to config.json and fill in market ids.`)
    process.exit(2)
  }
  const markets = Array.isArray(config.markets) ? config.markets : []
  if (markets.length === 0) {
    console.error('config.json has no markets. Add at least one { "id": "..." } entry.')
    process.exit(2)
  }
  const pollSeconds = Number(config.pollSeconds) > 0 ? Number(config.pollSeconds) : 60
  const state = await loadState()

  async function pass() {
    for (const entry of markets) {
      const id = String(entry.id)
      const threshold = Number(entry.thresholdPts) > 0 ? Number(entry.thresholdPts) : DEFAULT_THRESHOLD_PTS
      let market
      try {
        market = await fetchMarketById(id)
      } catch (err) {
        log(`${id}: fetch failed (${err.message}) — retry next poll`)
        continue
      }
      if (!market) {
        log(`${id}: not found — check the id`)
        continue
      }
      if (market.closed) {
        log(`${id}: closed — skipping (in-app auto-settle covers positions)`)
        continue
      }
      // Track the leading side: the price a holder of that side cares about.
      const lead = market.prices[0] >= market.prices[1] ? 0 : 1
      const priceNow = market.prices[lead]
      const baseline = state.baselines[id]
      if (baseline === undefined) {
        state.baselines[id] = priceNow
        log(`${id}: baseline set ${market.outcomes[lead]} ${(priceNow * 100).toFixed(0)}% — "${market.question.slice(0, 60)}"`)
        continue
      }
      const movePts = (priceNow - baseline) * 100
      if (Math.abs(movePts) + 1e-9 < threshold) continue
      const sign = movePts > 0 ? '+' : ''
      const arrow = movePts > 0 ? '▲' : '▼'
      const lines = [
        `⚠ OddsGlance alert`,
        market.question,
        `${market.outcomes[lead]} ${(baseline * 100).toFixed(0)}% → ${(priceNow * 100).toFixed(0)}% (${arrow} ${sign}${Math.round(movePts)} pts)`,
      ]
      if (market.slug) lines.push(`https://polymarket.com/event/${market.slug}`)
      const text = lines.join('\n')
      if (dryRun) {
        log(`[dry-run] would send:\n${text}`)
      } else {
        try {
          await sendTelegram(token, chatId, text)
          log(`${id}: alert sent (${sign}${Math.round(movePts)} pts)`)
        } catch (err) {
          log(`${id}: Telegram send failed (${err.message}) — baseline kept, will retry`)
          continue
        }
      }
      // Re-baseline after an alert so the next one needs another full
      // threshold move instead of re-firing every poll.
      state.baselines[id] = priceNow
    }
    if (!dryRun) await saveState(state)
  }

  await pass()
  if (once) return
  log(`Watching ${markets.length} market(s), polling every ${pollSeconds}s. Ctrl+C to stop.`)
  // eslint-disable-next-line no-constant-condition
  while (true) {
    await new Promise((resolve) => setTimeout(resolve, pollSeconds * 1000))
    await pass()
  }
}

main().catch((err) => {
  console.error('Fatal:', err)
  process.exit(1)
})
