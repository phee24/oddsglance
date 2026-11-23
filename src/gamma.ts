// OddsGlance — Polymarket Gamma API client (public, keyless, read-only).
// No SDK imports: this module runs in the WebView and in plain Node tests.
//
// Endpoint choice (verified live 23 Nov 2026):
// - List + single-market refresh both use `/markets/keyset`. The classic
//   `/markets` endpoint carries `deprecation: true` / `sunset: 2026-05-01`
//   headers, so keyset is the safe primary. Keyset answers
//   `{ markets: [...], next_cursor }` and — unlike classic `/markets` —
//   returns `outcomes` / `outcomePrices` as real arrays. The parser below
//   still accepts the classic JSON-string form defensively (SPEC §3).

export interface Market {
  id: string
  question: string
  /** Exactly two outcome labels, e.g. ["Yes", "No"] or team names. */
  outcomes: [string, string]
  /** Prices in (0, 1) for list markets; a refreshed closed market may be 0/1. */
  prices: [number, number]
  volume24hr: number
  endDate: string | null
  closed: boolean
  active: boolean
}

export const GAMMA_BASE = 'https://gamma-api.polymarket.com'

type FetchImpl = typeof fetch

const FETCH_TIMEOUT_MS = 12_000

async function fetchJson(url: string, fetchImpl: FetchImpl): Promise<unknown> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS)
  try {
    const res = await fetchImpl(url, { signal: ctrl.signal })
    if (!res.ok) throw new Error(`Gamma HTTP ${res.status}`)
    return (await res.json()) as unknown
  } finally {
    clearTimeout(timer)
  }
}

/** outcomes / outcomePrices arrive as arrays (keyset) or JSON strings (classic). */
function parseStringArray(value: unknown): string[] | null {
  let v: unknown = value
  if (typeof v === 'string') {
    try {
      v = JSON.parse(v) as unknown
    } catch {
      return null
    }
  }
  if (!Array.isArray(v)) return null
  const out: string[] = []
  for (const item of v) {
    if (typeof item !== 'string' || item.length === 0) return null
    out.push(item)
  }
  return out
}

function parsePriceArray(value: unknown): number[] | null {
  let v: unknown = value
  if (typeof v === 'string') {
    try {
      v = JSON.parse(v) as unknown
    } catch {
      return null
    }
  }
  if (!Array.isArray(v)) return null
  const out: number[] = []
  for (const item of v) {
    const n = typeof item === 'number' ? item : typeof item === 'string' ? Number(item) : NaN
    if (!Number.isFinite(n)) return null
    out.push(n)
  }
  return out
}

/**
 * Normalize one raw Gamma market. Returns null for anything that is not a
 * clean binary market — malformed entries are filtered, never crashed on.
 * `allowExtreme` permits prices of exactly 0/1 (a refreshed market that has
 * since closed/resolved); list display always uses the strict form.
 */
export function parseMarket(raw: unknown, allowExtreme = false): Market | null {
  if (typeof raw !== 'object' || raw === null) return null
  const m = raw as Record<string, unknown>

  const id = typeof m.id === 'string' ? m.id : typeof m.id === 'number' ? String(m.id) : null
  const question = typeof m.question === 'string' ? m.question : null
  if (!id || !question) return null

  const outcomes = parseStringArray(m.outcomes)
  const prices = parsePriceArray(m.outcomePrices)
  if (!outcomes || outcomes.length !== 2) return null
  if (!prices || prices.length !== 2) return null
  for (const p of prices) {
    if (allowExtreme ? p < 0 || p > 1 : p <= 0 || p >= 1) return null
  }

  const vol = typeof m.volume24hr === 'number' ? m.volume24hr : Number(m.volume24hr)
  return {
    id,
    question,
    outcomes: [outcomes[0], outcomes[1]],
    prices: [prices[0], prices[1]],
    volume24hr: Number.isFinite(vol) ? vol : 0,
    endDate: typeof m.endDate === 'string' ? m.endDate : null,
    closed: m.closed === true,
    active: m.active !== false,
  }
}

function keysetMarkets(payload: unknown): { raws: unknown[]; nextCursor: string | null } {
  if (Array.isArray(payload)) return { raws: payload, nextCursor: null }
  if (typeof payload === 'object' && payload !== null) {
    const p = payload as Record<string, unknown>
    const raws = Array.isArray(p.markets) ? p.markets : []
    const nextCursor = typeof p.next_cursor === 'string' && p.next_cursor ? p.next_cursor : null
    return { raws, nextCursor }
  }
  return { raws: [], nextCursor: null }
}

export interface TopMarketsResult {
  markets: Market[]
  /** True when this is last-good cached data because the live fetch failed. */
  stale: boolean
}

export class GammaClient {
  private lastGood: Market[] = []
  private readonly fetchImpl: FetchImpl

  constructor(fetchImpl: FetchImpl = fetch) {
    this.fetchImpl = fetchImpl
  }

  /**
   * Top active binary markets by 24h volume. Fetches a wider page than the
   * UI needs so non-binary/malformed entries can be filtered without
   * starving the list; follows one keyset cursor if the first page filters
   * down too far. On network failure returns the last-good cache (stale).
   */
  async fetchTopMarkets(limit = 8): Promise<TopMarketsResult> {
    const pageSize = Math.max(limit * 3, 24)
    const base =
      `${GAMMA_BASE}/markets/keyset?active=true&closed=false` +
      `&order=volume24hr&ascending=false&limit=${pageSize}`
    try {
      const found: Market[] = []
      const seen = new Set<string>()
      let url: string | null = base
      for (let page = 0; page < 2 && url; page++) {
        const payload: unknown = await fetchJson(url, this.fetchImpl)
        const { raws, nextCursor } = keysetMarkets(payload)
        for (const raw of raws) {
          const market = parseMarket(raw)
          if (market && !seen.has(market.id)) {
            seen.add(market.id)
            found.push(market)
          }
        }
        if (found.length >= limit || !nextCursor) break
        url = `${base}&after_cursor=${encodeURIComponent(nextCursor)}`
      }
      const markets = found.slice(0, limit)
      if (markets.length > 0) this.lastGood = markets
      return { markets, stale: false }
    } catch {
      if (this.lastGood.length > 0) return { markets: this.lastGood, stale: true }
      return { markets: [], stale: true }
    }
  }

  /**
   * Refresh one market by id (Detail + Portfolio PnL). Allows extreme
   * prices so a market that closed since the bet was placed still parses —
   * that is how settlement detects the final price. Null on any failure.
   */
  async fetchMarketById(id: string): Promise<Market | null> {
    try {
      const payload: unknown = await fetchJson(
        `${GAMMA_BASE}/markets/keyset?id=${encodeURIComponent(id)}`,
        this.fetchImpl,
      )
      const { raws } = keysetMarkets(payload)
      for (const raw of raws) {
        const market = parseMarket(raw, true)
        if (market && market.id === id) return market
      }
      return null
    } catch {
      return null
    }
  }

  /** Seed/inspect the last-good cache (tests + stale rendering). */
  get cachedMarkets(): Market[] {
    return this.lastGood
  }
}
