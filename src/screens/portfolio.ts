// OddsGlance — Screen 3: Portfolio.
// Header: equity / cash / total PnL + settled notices + the paper-trading
// disclaimer. List: one row per open position (tap = cash out at the
// current odds — the row itself shows the live value before the tap),
// then Refresh / Reset / Back actions.

import { RebuildPageContainer } from '@evenrealities/even_hub_sdk'
import type { Position } from '../state'
import { positionPnl } from '../state'
import { fmtMoney, fmtPct, fmtSignedMoney, truncateWords } from '../format'
import { headerText, itemList } from './common'

export const PORTFOLIO_LIST_NAME = 'portfolio'

const HEADER_H = 92
const LIST_Y = 92
const LIST_H = 196

export interface PositionView {
  position: Position
  /** Live price for the position's outcome; null when refresh failed. */
  priceNow: number | null
}

export interface PortfolioView {
  cash: number
  equity: number
  totalPnl: number
  positions: PositionView[]
  /** e.g. "Cashed out YES: +$27.50" or "Settled: NO +$25.00". */
  status: string
  /** Big-move banner, e.g. "⚠ ALERT: YES Fed cut ▲ +12 pts". Empty when none. */
  alertText: string
  stale: boolean
}

/** Action rows sit after the position rows (plus the empty-state row). */
export function actionBase(view: PortfolioView): number {
  return view.positions.length === 0 ? 1 : view.positions.length
}
export function refreshIndex(view: PortfolioView): number {
  return actionBase(view)
}
export function resetIndex(view: PortfolioView): number {
  return actionBase(view) + 1
}
export function backIndex(view: PortfolioView): number {
  return actionBase(view) + 2
}

export function positionRow(view: PositionView): string {
  const { position, priceNow } = view
  const q = truncateWords(position.question, 22)
  if (priceNow === null) {
    return `${position.outcomeLabel} ${q} in ${fmtPct(position.entryPrice)} now —`
  }
  const pnl = fmtSignedMoney(positionPnl(position, priceNow))
  return `${position.outcomeLabel} ${q} in ${fmtPct(position.entryPrice)} now ${fmtPct(priceNow)} ${pnl}`
}

export function buildPortfolioPage(view: PortfolioView): RebuildPageContainer {
  const lines = [
    `PORTFOLIO (PAPER)${view.stale ? ' (STALE)' : ''}`,
    `Equity ${fmtMoney(view.equity)} · Cash ${fmtMoney(view.cash)} · PnL ${fmtSignedMoney(view.totalPnl)}`,
  ]
  if (view.alertText) lines.push(view.alertText)
  if (view.status) lines.push(view.status)
  lines.push('Paper trading demo — not financial advice.')

  const items = view.positions.map(positionRow)
  if (view.positions.length === 0) items.push('No open positions')
  items.push('Refresh prices', 'Reset paper funds', 'Back to markets')

  return new RebuildPageContainer({
    containerTotalNum: 2,
    textObject: [headerText(lines.join('\n'), HEADER_H)],
    listObject: [itemList(PORTFOLIO_LIST_NAME, LIST_Y, LIST_H, items)],
  })
}
