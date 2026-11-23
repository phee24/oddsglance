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
  MemoryBackend,
  PaperStore,
  STAKE_PRESETS,
  STORAGE_KEY,
  type Position,
  type StorageBackend,
} from './state'
import { fmtMoney, fmtPct, fmtSignedMoney } from './format'
import { fullText } from './screens/common'
import { buildMarketsEmptyPage, buildMarketsPage, portfolioIndex } from './screens/markets'
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

/** Bridge-backed storage; falls back to session memory when unreachable. */
class BridgeBackend implements StorageBackend {
  constructor(private readonly bridge: EvenAppBridge) {}
  async load(): Promise<string | null> {
    const v = await this.bridge.getLocalStorage(STORAGE_KEY)
    return v ? v : null
  }
  async save(value: string): Promise<void> {
    await this.bridge.setLocalStorage(STORAGE_KEY, value)
  }
}

async function pickBackend(bridge: EvenAppBridge): Promise<StorageBackend> {
  const backend = new BridgeBackend(bridge)
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
  private screen: Screen = 'markets'
  private markets: Market[] = []
  private marketsStale = false
  private marketsLoaded = false
  private readonly marketById = new Map<string, Market>()
  private detail: { market: Market; side: 0 | 1; stakeIndex: number; status: string } | null = null
  private portfolioStatus = ''
  private portfolioStale = false
  private refreshing = false
  private timer: ReturnType<typeof setInterval> | null = null
  private unsubscribe: (() => void) | null = null

  constructor(private readonly bridge: EvenAppBridge, backend: StorageBackend) {
    this.store = new PaperStore(backend)
  }

  async start(): Promise<void> {
    await this.store.init()
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

  private async refreshMarkets(): Promise<void> {
    const { markets, stale } = await this.gamma.fetchTopMarkets(8)
    if (markets.length > 0) {
      this.markets = markets
      this.marketsLoaded = true
      for (const m of markets) this.marketById.set(m.id, m)
      // Keep an open Detail screen marked to the freshest prices.
      if (this.detail) {
        const fresh = this.marketById.get(this.detail.market.id)
        if (fresh) this.detail.market = fresh
      }
    }
    this.marketsStale = stale
    if (this.screen === 'markets') await this.render()
    else if (this.screen === 'detail') await this.render()
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
      stale: this.portfolioStale,
    }
  }

  private async render(): Promise<void> {
    try {
      if (this.screen === 'markets') {
        const page = this.marketsLoaded || this.markets.length > 0
          ? buildMarketsPage(this.markets, this.marketsStale)
          : buildMarketsEmptyPage()
        await this.bridge.rebuildPageContainer(page)
      } else if (this.screen === 'detail' && this.detail) {
        await this.bridge.rebuildPageContainer(
          buildDetailPage({
            market: this.detail.market,
            side: this.detail.side,
            stakeIndex: this.detail.stakeIndex,
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
    if (index === portfolioIndex(this.markets)) {
      await this.goPortfolio()
      return
    }
    const market = this.markets[index]
    if (!market) return
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
const backend = await pickBackend(bridge)
const app = new App(bridge, backend)
await app.start()
