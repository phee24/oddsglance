// OddsGlance — paper portfolio store + persistence.
// No SDK imports: storage is injected behind a tiny backend interface.
// In the app the backend is the Even bridge (`setLocalStorage` /
// `getLocalStorage`); in tests / plain-browser dev it is in-memory.
// All trade math lives here as pure functions so it is unit-testable.

import type { Market } from './gamma'

export const STARTING_CASH = 1000
export const STAKE_PRESETS = [10, 25, 50, 100] as const
export const STORAGE_KEY = 'oddsglance.portfolio.v1'

export interface Position {
  id: string
  marketId: string
  question: string
  outcomeLabel: string
  outcomeIndex: 0 | 1
  stake: number
  entryPrice: number
  shares: number
  openedAt: number
}

export interface PortfolioState {
  cash: number
  positions: Position[]
}

export interface StorageBackend {
  load(): Promise<string | null>
  save(value: string): Promise<void>
}

/** Session-only fallback used when the Even bridge storage is unavailable. */
export class MemoryBackend implements StorageBackend {
  private value: string | null = null
  async load(): Promise<string | null> {
    return this.value
  }
  async save(value: string): Promise<void> {
    this.value = value
  }
}

/** Current value of a position at a live price: shares × price. */
export function positionValue(pos: Position, priceNow: number): number {
  return pos.shares * priceNow
}

/** PnL of a position at a live price: value − stake. */
export function positionPnl(pos: Position, priceNow: number): number {
  return positionValue(pos, priceNow) - pos.stake
}

function defaultState(): PortfolioState {
  return { cash: STARTING_CASH, positions: [] }
}

function sanitizeState(raw: unknown): PortfolioState | null {
  if (typeof raw !== 'object' || raw === null) return null
  const s = raw as Record<string, unknown>
  if (typeof s.cash !== 'number' || !Number.isFinite(s.cash) || s.cash < 0) return null
  if (!Array.isArray(s.positions)) return null
  const positions: Position[] = []
  for (const item of s.positions) {
    if (typeof item !== 'object' || item === null) return null
    const p = item as Record<string, unknown>
    const valid =
      typeof p.id === 'string' &&
      typeof p.marketId === 'string' &&
      typeof p.question === 'string' &&
      typeof p.outcomeLabel === 'string' &&
      (p.outcomeIndex === 0 || p.outcomeIndex === 1) &&
      typeof p.stake === 'number' && Number.isFinite(p.stake) && p.stake > 0 &&
      typeof p.entryPrice === 'number' && p.entryPrice > 0 && p.entryPrice < 1 &&
      typeof p.shares === 'number' && Number.isFinite(p.shares) && p.shares > 0 &&
      typeof p.openedAt === 'number'
    if (!valid) return null
    positions.push(item as unknown as Position)
  }
  return { cash: s.cash, positions }
}

export class PaperStore {
  private state: PortfolioState = defaultState()
  private readonly backend: StorageBackend
  /** Transient summaries of positions settled since the last render. */
  lastSettled: { label: string; pnl: number }[] = []

  constructor(backend: StorageBackend) {
    this.backend = backend
  }

  /** Load persisted state; falls back to a fresh $1,000 paper account. */
  async init(): Promise<void> {
    try {
      const raw = await this.backend.load()
      if (raw) {
        const parsed = sanitizeState(JSON.parse(raw) as unknown)
        if (parsed) {
          this.state = parsed
          return
        }
      }
    } catch {
      // Corrupt or unavailable storage -> fresh account, never crash.
    }
    this.state = defaultState()
  }

  get cash(): number {
    return this.state.cash
  }

  get positions(): readonly Position[] {
    return this.state.positions
  }

  canAfford(stake: number): boolean {
    return stake > 0 && stake <= this.state.cash
  }

  /**
   * Place a paper bet: shares = stake / entryPrice. Returns the position,
   * or null when the stake is invalid / exceeds paper cash. One position per
   * bet — a second bet on the same market is a separate position (SPEC §5).
   */
  async placeBet(market: Market, outcomeIndex: 0 | 1, stake: number): Promise<Position | null> {
    const entryPrice = market.prices[outcomeIndex]
    if (!this.canAfford(stake)) return null
    if (!(entryPrice > 0 && entryPrice < 1)) return null
    const pos: Position = {
      id: `${market.id}-${Date.now()}`,
      marketId: market.id,
      question: market.question,
      outcomeLabel: market.outcomes[outcomeIndex],
      outcomeIndex,
      stake,
      entryPrice,
      shares: stake / entryPrice,
      openedAt: Date.now(),
    }
    this.state.cash -= stake
    this.state.positions.push(pos)
    await this.persist()
    return pos
  }

  /** Cash out at the current price. Returns the credited value, or null. */
  async cashOut(positionId: string, priceNow: number): Promise<number | null> {
    const idx = this.state.positions.findIndex(p => p.id === positionId)
    if (idx < 0 || !Number.isFinite(priceNow) || priceNow < 0 || priceNow > 1) return null
    const [pos] = this.state.positions.splice(idx, 1)
    const value = positionValue(pos, priceNow)
    this.state.cash += value
    await this.persist()
    return value
  }

  /**
   * Settle every position whose market has closed, at its final price
   * (0 or 1). Returns how many positions settled. Summaries land in
   * `lastSettled` so the UI can say what happened.
   */
  async settleClosed(marketsById: ReadonlyMap<string, Market>): Promise<number> {
    let settled = 0
    const remaining: Position[] = []
    for (const pos of this.state.positions) {
      const market = marketsById.get(pos.marketId)
      if (market && market.closed) {
        const finalPrice = market.prices[pos.outcomeIndex]
        const value = positionValue(pos, finalPrice)
        this.state.cash += value
        this.lastSettled.push({
          label: pos.outcomeLabel,
          pnl: value - pos.stake,
        })
        settled += 1
      } else {
        remaining.push(pos)
      }
    }
    if (settled > 0) {
      this.state.positions = remaining
      await this.persist()
    }
    return settled
  }

  /**
   * Mark-to-market equity: cash + Σ live position values.
   * `priceOf` resolves the live price for a position's own outcome (two
   * positions on the same market can sit on opposite sides, so a bare
   * marketId -> price map would be ambiguous). Missing price -> entry.
   */
  equity(priceOf: (pos: Position) => number | undefined): number {
    let total = this.state.cash
    for (const pos of this.state.positions) {
      total += positionValue(pos, priceOf(pos) ?? pos.entryPrice)
    }
    return total
  }

  /** Total unrealized PnL across open positions at live prices. */
  totalPnl(priceOf: (pos: Position) => number | undefined): number {
    let total = 0
    for (const pos of this.state.positions) {
      total += positionPnl(pos, priceOf(pos) ?? pos.entryPrice)
    }
    return total
  }

  /** Back to a fresh $1,000 paper account (Portfolio screen action). */
  async reset(): Promise<void> {
    this.state = defaultState()
    this.lastSettled = []
    await this.persist()
  }

  private async persist(): Promise<void> {
    try {
      await this.backend.save(JSON.stringify(this.state))
    } catch {
      // Persistence is best-effort; the in-memory state stays authoritative
      // for this session even if the bridge write fails.
    }
  }
}
