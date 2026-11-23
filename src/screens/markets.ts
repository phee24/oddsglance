// OddsGlance — Screen 1: Markets.
// ListContainer of the top binary markets by 24h volume: truncated question
// + leading outcome label + odds %. Last item is the door to Portfolio.
// Scroll moves the selection, tap opens Detail (handled in main.ts).

import { RebuildPageContainer } from '@evenrealities/even_hub_sdk'
import type { Market } from '../gamma'
import { fmtPct, shortLabel, truncateWords } from '../format'
import { headerText, itemList } from './common'

export const MARKETS_LIST_NAME = 'markets'
export const PORTFOLIO_ITEM = 'Portfolio'

const HEADER_H = 44
const LIST_Y = 44
const LIST_H = 244

/** Index of the "Portfolio" row inside the items array. */
export function portfolioIndex(markets: readonly Market[]): number {
  return markets.length
}

export function marketRow(market: Market): string {
  const lead = market.prices[0] >= market.prices[1] ? 0 : 1
  const q = truncateWords(market.question, 40)
  return `${q} · ${shortLabel(market.outcomes[lead])} ${fmtPct(market.prices[lead])}`
}

export function buildMarketsPage(markets: readonly Market[], stale: boolean): RebuildPageContainer {
  const header = stale ? 'ODDSGLANCE (STALE) — last odds' : 'ODDSGLANCE — top by 24h volume'
  const items = markets.map(marketRow)
  items.push(PORTFOLIO_ITEM)
  return new RebuildPageContainer({
    containerTotalNum: 2,
    textObject: [headerText(header, HEADER_H)],
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
