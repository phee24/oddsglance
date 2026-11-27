// OddsGlance — Screen 1: Markets.
// ListContainer of live binary markets: followed markets pinned first
// (★ — any market the user follows, however far down the volume ranking),
// then the hottest markets by 24h volume, then "More markets" to page
// past the first screen, then the door to Portfolio.
// Scroll moves the selection, tap opens Detail (handled in main.ts).

import { RebuildPageContainer } from '@evenrealities/even_hub_sdk'
import type { Market } from '../gamma'
import { fmtPct, shortLabel, truncateWords } from '../format'
import { headerText, itemList } from './common'

export const MARKETS_LIST_NAME = 'markets'
export const PORTFOLIO_ITEM = 'Portfolio'
export const MORE_ITEM = 'More markets ↓'

const HEADER_H = 44
const LIST_Y = 44
const LIST_H = 244

export interface MarketsView {
  /** Followed markets, with the freshest prices we have (may be stale). */
  followed: Market[]
  /** Volume-ranked markets currently shown (followed ones excluded). */
  markets: Market[]
  /** True when another volume page exists behind "More markets". */
  hasMore: boolean
  stale: boolean
  /** Open positions currently beyond the big-move threshold. */
  alertCount: number
}

export type MarketsRow =
  | { kind: 'followed'; market: Market }
  | { kind: 'market'; market: Market }
  | { kind: 'more' }
  | { kind: 'portfolio' }

/** Resolve a tapped list index to what it means. */
export function resolveMarketsRow(index: number, view: MarketsView): MarketsRow | null {
  let i = index
  if (i < view.followed.length) return { kind: 'followed', market: view.followed[i] }
  i -= view.followed.length
  if (i < view.markets.length) return { kind: 'market', market: view.markets[i] }
  i -= view.markets.length
  if (view.hasMore) {
    if (i === 0) return { kind: 'more' }
    i -= 1
  }
  if (i === 0) return { kind: 'portfolio' }
  return null
}

/** Index of the "Portfolio" row inside the items array. */
export function portfolioIndex(view: MarketsView): number {
  return view.followed.length + view.markets.length + (view.hasMore ? 1 : 0)
}

export function marketRow(market: Market): string {
  const lead = market.prices[0] >= market.prices[1] ? 0 : 1
  const q = truncateWords(market.question, 40)
  return `${q} · ${shortLabel(market.outcomes[lead])} ${fmtPct(market.prices[lead])}`
}

export function followedRow(market: Market): string {
  return `★ ${marketRow(market)}`
}

export function buildMarketsPage(view: MarketsView): RebuildPageContainer {
  const header = view.stale ? 'ODDSGLANCE (STALE) — last odds' : 'ODDSGLANCE — top by 24h volume'
  const alertSuffix = view.alertCount > 0 ? ` · ⚠ ${view.alertCount} alert${view.alertCount > 1 ? 's' : ''}` : ''
  const items = view.followed.map(followedRow)
  for (const m of view.markets) items.push(marketRow(m))
  if (view.hasMore) items.push(MORE_ITEM)
  items.push(PORTFOLIO_ITEM)
  return new RebuildPageContainer({
    containerTotalNum: 2,
    textObject: [headerText(header + alertSuffix, HEADER_H)],
    listObject: [itemList(MARKETS_LIST_NAME, LIST_Y, LIST_H, items)],
  })
}

/** Shown when the feed is empty and there is no cache to fall back on. */
export function buildMarketsEmptyPage(): RebuildPageContainer {
  return new RebuildPageContainer({
    containerTotalNum: 2,
    textObject: [headerText('ODDSGLANCE\nNo markets — check connection', HEADER_H + 22)],
    listObject: [itemList(MARKETS_LIST_NAME, LIST_Y + 22, LIST_H - 22, ['Retry', PORTFOLIO_ITEM])],
  })
}
