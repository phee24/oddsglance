// OddsGlance — bootstrap + screen router + the single EvenHub event
// subscription. All SDK traps from DESIGN.md §4 are handled here:
// event normalization inside the envelope check, double-tap exit dialog
// (mode 1) at root level, containerID/containerName pairs kept exact.

import {
  waitForEvenAppBridge,
  CreateStartUpPageContainer,
  OsEventTypeList,
  type EvenAppBridge,
  type EvenHubEvent,
} from '@evenrealities/even_hub_sdk'
import { GammaClient, type Market } from './gamma'
import {
  MAX_FOLLOWED,
  MemoryBackend,
  PaperStore,
  STAKE_PRESETS,
  STORAGE_KEY,
  WATCHLIST_KEY,
  WatchlistStore,
  type Position,
  type StorageBackend,
} from './state'
import { ALERT_THRESHOLD_PTS, alertBanner, computeAlerts, type Alert } from './alerts'
import { fmtMoney, fmtPct, fmtSignedMoney } from './format'
import { fullText } from './screens/common'
import { buildMarketsEmptyPage, buildMarketsPage, resolveMarketsRow, type MarketsView } from './screens/markets'
import { buildDetailPage, DetailAction } from './screens/detail'
import {
  backIndex,
  buildPortfolioPage,
  refreshIndex,
  resetIndex,
  type PortfolioView,
  type PositionView,
} from './screens/portfolio'

type Screen = 'markets' | 'detail' | 'portfolio'

const REFRESH_MS = 60_000
const STORAGE_PROBE_MS = 1_200

/** Bridge-backed storage for one key; falls back to session memory when unreachable. */
class BridgeBackend implements StorageBackend {
  constructor(
    private readonly bridge: EvenAppBridge,
    private readonly key: string,
  ) {}
  async load(): Promise<string | null> {
    const v = await this.bridge.getLocalStorage(this.key)
    return v ? v : null
  }
  async save(value: string): Promise<void> {
    await this.bridge.setLocalStorage(this.key, value)
  }
}

async function pickBackend(bridge: EvenAppBridge, key: string): Promise<StorageBackend> {
  const backend = new BridgeBackend(bridge, key)
  try {
    const probe = backend.load()
    const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), STORAGE_PROBE_MS))
    await Promise.race([probe, timeout])
    return backend
  } catch {
    return new MemoryBackend()
  }
}

// Reads the event type out of one envelope. CLICK_EVENT is 0 and protobuf
// omits zero-value fields, so a tap arrives with `eventType === undefined`;
// the default must be resolved INSIDE the envelope check (template pattern),
// never on an envelope that may not exist.
function eventTypeOf(envelope?: { eventType?: OsEventTypeList }): OsEventTypeList | null {
  if (!envelope) return null
  return envelope.eventType ?? OsEventTypeList.CLICK_EVENT
}

class App {
  private readonly gamma = new GammaClient()
  private readonly store: PaperStore
  private readonly watchlist: WatchlistStore
  private screen: Screen = 'markets'
  private markets: Market[] = []
  private marketsStale = false
  private marketsLoaded = false
  private marketsCursor: string | null = null
  private shownCount = 8
  private activeAlerts: Alert[] = []
  private readonly marketById = new Map<string, Market>()
  private detail: { market: Market; side: 0 | 1; stakeIndex: number; status: string } | null = null
  private portfolioStatus = ''
  private portfolioStale = false
  private refreshing = false
  private timer: ReturnType<typeof setInterval> | null = null
  private unsubscribe: (() => void) | null = null

  constructor(
    private readonly bridge: EvenAppBridge,
    backend: StorageBackend,
    watchlistBackend: StorageBackend,
  ) {
    this.store = new PaperStore(backend)
    this.watchlist = new WatchlistStore(watchlistBackend)
  }

  async start(): Promise<void> {
    await this.store.init()
    await this.watchlist.init()
    const result = await this.bridge.createStartUpPageContainer(
      new CreateStartUpPageContainer({
        containerTotalNum: 1,
        textObject: [fullText('ODDSGLANCE\nLoading live odds…')],
      }),
    )
    console.log('OddsGlance startup page:', result === 0 ? 'success' : `failed (${result})`)

    this.unsubscribe = this.bridge.onEvenHubEvent((event) => {
      void this.onEvent(event)
    })
    this.timer = setInterval(() => void this.periodicRefresh(), REFRESH_MS)
    await this.refreshMarkets()
  }

  // ---------- data ----------

  /** Markets currently shown on screen 1 (followed ones excluded). */
  private shownMarkets(): Market[] {
    const followedIds = new Set(this.watchlist.list.map(e => e.id))
    return this.markets.filter(m => !followedIds.has(m.id)).slice(0, this.shownCount)
  }

  /** Followed markets with the freshest price we have for each. */
  private followedMarkets(): Market[] {
    const out: Market[] = []
    for (const entry of this.watchlist.list) {
      const live = this.marketById.get(entry.id)
      out.push(
        live ?? {
          id: entry.id,
          question: entry.question,
          outcomes: [entry.outcomes[0], entry.outcomes[1]],
          prices: [0.5, 0.5],
          volume24hr: 0,
          endDate: null,
          closed: false,
          active: true,
        },
      )
    }
    return out
  }

  private marketsView(): MarketsView {
    return {
      followed: this.followedMarkets(),
      markets: this.shownMarkets(),
      hasMore: this.shownCount < this.markets.length || this.marketsCursor !== null,
      stale: this.marketsStale,
      alertCount: this.activeAlerts.length,
    }
  }

  /** Recompute big-move alerts from current prices. */
  private evaluateAlerts(): void {
    this.activeAlerts = computeAlerts(this.store.positions, pos => this.priceOf(pos), ALERT_THRESHOLD_PTS)
  }

  private async refreshMarkets(): Promise<void> {
    const { markets, stale, nextCursor } = await this.gamma.fetchTopMarkets(24)
    if (markets.length > 0) {
      this.markets = markets
      this.marketsLoaded = true
      this.marketsCursor = nextCursor
      for (const m of markets) this.marketById.set(m.id, m)
      // Keep an open Detail screen marked to the freshest prices.
      if (this.detail) {
        const fresh = this.marketById.get(this.detail.market.id)
        if (fresh) this.detail.market = fresh
      }
    }
    this.marketsStale = stale
    // Followed markets are refreshed by id so a market far down the volume
    // ranking still shows live odds — that is the point of following it.
    await this.refreshFollowed()
    this.evaluateAlerts()
    if (this.screen === 'markets') await this.render()
    else if (this.screen === 'detail') await this.render()
  }

  private async refreshFollowed(): Promise<void> {
    const entries = this.watchlist.list
    if (entries.length === 0) return
    const fetched = await Promise.all(entries.map(e => this.gamma.fetchMarketById(e.id)))
    for (const market of fetched) {
      if (market) this.marketById.set(market.id, market)
    }
  }

  /** Load the next volume page behind "More markets". */
  private async loadMoreMarkets(): Promise<void> {
    if (this.shownCount < this.markets.length) {
      this.shownCount += 8
      await this.render()
      return
    }
    if (!this.marketsCursor) return
    const { markets, stale, nextCursor } = await this.gamma.fetchNextMarkets(this.marketsCursor, 24)
    if (markets.length > 0) {
      const seen = new Set(this.markets.map(m => m.id))
      for (const m of markets) {
        if (!seen.has(m.id)) {
          seen.add(m.id)
          this.markets.push(m)
          this.marketById.set(m.id, m)
        }
      }
      this.marketsCursor = nextCursor
      this.shownCount += 8
    }
    this.marketsStale = stale
    await this.render()
  }

  private async refreshPortfolioData(): Promise<void> {
    const ids = [...new Set(this.store.positions.map(p => p.marketId))]
    if (ids.length > 0) {
      const fetched = await Promise.all(ids.map(id => this.gamma.fetchMarketById(id)))
      let anyFresh = false
      const byId = new Map<string, Market>()
      fetched.forEach((market, i) => {
        if (market) {
          byId.set(ids[i], market)
          this.marketById.set(ids[i], market)
          anyFresh = true
        }
      })
      const settledCount = await this.store.settleClosed(byId)
      if (settledCount > 0) {
        const notes = this.store.lastSettled
          .map(s => `${s.label} ${fmtSignedMoney(s.pnl)}`)
          .join(' · ')
        this.portfolioStatus = `Settled: ${notes}`
        this.store.lastSettled = []
      }
      this.portfolioStale = !anyFresh && ids.length > 0
    } else {
      this.portfolioStale = false
    }
    this.evaluateAlerts()
  }

  private async periodicRefresh(): Promise<void> {
    if (this.refreshing) return
    this.refreshing = true
    try {
      if (this.screen === 'portfolio') {
        await this.refreshPortfolioData()
        await this.render()
      } else {
        await this.refreshMarkets()
      }
    } finally {
      this.refreshing = false
    }
  }

  // ---------- rendering ----------

  private priceOf(pos: Position): number | undefined {
    const market = this.marketById.get(pos.marketId)
    return market ? market.prices[pos.outcomeIndex] : undefined
  }

  private portfolioView(): PortfolioView {
    const positions: PositionView[] = this.store.positions.map(position => {
      const market = this.marketById.get(position.marketId)
      return { position, priceNow: market ? market.prices[position.outcomeIndex] : null }
    })
    return {
      cash: this.store.cash,
      equity: this.store.equity(pos => this.priceOf(pos)),
      totalPnl: this.store.totalPnl(pos => this.priceOf(pos)),
      positions,
      status: this.portfolioStatus,
      alertText: this.activeAlerts.length > 0 ? alertBanner(this.activeAlerts[0]) : '',
      stale: this.portfolioStale,
    }
  }

  private async render(): Promise<void> {
    try {
      if (this.screen === 'markets') {
        const page = this.marketsLoaded || this.markets.length > 0
          ? buildMarketsPage(this.marketsView())
          : buildMarketsEmptyPage()
        await this.bridge.rebuildPageContainer(page)
      } else if (this.screen === 'detail' && this.detail) {
        await this.bridge.rebuildPageContainer(
          buildDetailPage({
            market: this.detail.market,
            side: this.detail.side,
            stakeIndex: this.detail.stakeIndex,
            followed: this.watchlist.has(this.detail.market.id),
            status: this.detail.status,
          }),
        )
      } else if (this.screen === 'portfolio') {
        await this.bridge.rebuildPageContainer(buildPortfolioPage(this.portfolioView()))
      }
    } catch (err) {
      console.warn('OddsGlance render failed:', err)
    }
  }

  private async goMarkets(): Promise<void> {
    this.screen = 'markets'
    await this.render()
    void this.refreshMarkets()
  }

  private async goPortfolio(): Promise<void> {
    this.screen = 'portfolio'
    await this.render()
    await this.refreshPortfolioData()
    await this.render()
  }

  // ---------- events ----------

  private async onEvent(event: EvenHubEvent): Promise<void> {
    const sysType = eventTypeOf(event.sysEvent)
    const textType = eventTypeOf(event.textEvent)
    const listType = eventTypeOf(event.listEvent)

    // Root-level exit: double-tap anywhere opens the system exit dialog
    // (mode 1 — a QA requirement). Checked before any click handling.
    if (
      sysType === OsEventTypeList.DOUBLE_CLICK_EVENT ||
      textType === OsEventTypeList.DOUBLE_CLICK_EVENT ||
      listType === OsEventTypeList.DOUBLE_CLICK_EVENT
    ) {
      await this.bridge.shutDownPageContainer(1)
      return
    }

    if (sysType === OsEventTypeList.SYSTEM_EXIT_EVENT || sysType === OsEventTypeList.ABNORMAL_EXIT_EVENT) {
      if (this.timer) clearInterval(this.timer)
      this.unsubscribe?.()
      return
    }

    if (!event.listEvent) return
    const index = event.listEvent.currentSelectItemIndex
    if (index === undefined || index < 0) return
    // Scroll envelopes only move the host-side selection border; a click
    // (eventType CLICK or omitted) activates the row.
    if (listType !== OsEventTypeList.CLICK_EVENT) return

    if (this.screen === 'markets') await this.onMarketsTap(index)
    else if (this.screen === 'detail') await this.onDetailTap(index)
    else if (this.screen === 'portfolio') await this.onPortfolioTap(index)
  }

  private async onMarketsTap(index: number): Promise<void> {
    if (!this.marketsLoaded && this.markets.length === 0) {
      // Empty-state rows: [Retry, Portfolio]
      if (index === 0) await this.refreshMarkets()
      else if (index === 1) await this.goPortfolio()
      return
    }
    const row = resolveMarketsRow(index, this.marketsView())
    if (!row) return
    if (row.kind === 'portfolio') {
      await this.goPortfolio()
      return
    }
    if (row.kind === 'more') {
      await this.loadMoreMarkets()
      return
    }
    const market = row.market
    const lead = market.prices[0] >= market.prices[1] ? 0 : 1
    this.detail = { market, side: lead as 0 | 1, stakeIndex: 1, status: '' }
    this.screen = 'detail'
    await this.render()
  }

  private async onDetailTap(index: number): Promise<void> {
    if (!this.detail) return
    const d = this.detail
    if (index === DetailAction.Side0 || index === DetailAction.Side1) {
      d.side = index === DetailAction.Side0 ? 0 : 1
      d.status = ''
      await this.render()
      return
    }
    if (index === DetailAction.Stake) {
      d.stakeIndex = (d.stakeIndex + 1) % STAKE_PRESETS.length
      await this.render()
      return
    }
    if (index === DetailAction.Follow) {
      if (this.watchlist.has(d.market.id)) {
        await this.watchlist.remove(d.market.id)
        d.status = 'Unfollowed — no longer pinned on Markets'
      } else {
        const added = await this.watchlist.add(d.market)
        d.status = added
          ? '★ Following — pinned on Markets, live odds'
          : `Watchlist full (max ${MAX_FOLLOWED}) — unfollow one first`
      }
      await this.render()
      return
    }
    if (index === DetailAction.Back) {
      this.detail = null
      await this.goMarkets()
      return
    }
    if (index === DetailAction.PlaceBet) {
      const stake = STAKE_PRESETS[d.stakeIndex]
      const pos = await this.store.placeBet(d.market, d.side, stake)
      if (pos) {
        d.status =
          `Position open: ${pos.outcomeLabel} ${fmtMoney(pos.stake)} @ ${fmtPct(pos.entryPrice)}` +
          ` · Cash ${fmtMoney(this.store.cash)}`
      } else {
        d.status = `Not enough paper cash for ${fmtMoney(stake)}`
      }
      await this.render()
    }
  }

  private async onPortfolioTap(index: number): Promise<void> {
    const view = this.portfolioView()
    if (index === backIndex(view)) {
      await this.goMarkets()
      return
    }
    if (index === refreshIndex(view)) {
      await this.refreshPortfolioData()
      await this.render()
      return
    }
    if (index === resetIndex(view)) {
      await this.store.reset()
      this.portfolioStatus = 'Paper funds reset to $1,000'
      await this.render()
      return
    }
    const pv = view.positions[index]
    if (!pv) return
    if (pv.priceNow === null) {
      this.portfolioStatus = 'No live price — tap Refresh prices first'
      await this.render()
      return
    }
    const value = await this.store.cashOut(pv.position.id, pv.priceNow)
    if (value !== null) {
      this.portfolioStatus =
        `Cashed out ${pv.position.outcomeLabel}: ${fmtMoney(value)}` +
        ` (${fmtSignedMoney(value - pv.position.stake)})`
    }
    await this.render()
  }
}

const bridge = await waitForEvenAppBridge()
const backend = await pickBackend(bridge, STORAGE_KEY)
const watchlistBackend = await pickBackend(bridge, WATCHLIST_KEY)
const app = new App(bridge, backend, watchlistBackend)
await app.start()
