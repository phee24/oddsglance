// OddsGlance — Screen 2: Detail + paper bet.
// Header text shows the full question, both odds, 24h volume and end date.
// The action list is the whole bet flow with glasses input only:
//   tap a side row -> select that side
//   tap the stake row -> cycle the stake preset ($10/$25/$50/$100)
//   tap PLACE PAPER BET -> confirm (one tap, no layered dialogs)
//   tap Back -> Markets
// (A single text container cannot report *where* it was tapped, so the
// DESIGN.md sketch's tap-zones are realized as list rows — same flow,
// same gestures: scroll to choose, tap to act.)

import { RebuildPageContainer } from '@evenrealities/even_hub_sdk'
import type { Market } from '../gamma'
import { STAKE_PRESETS } from '../state'
import { fmtDate, fmtMoney, fmtPct } from '../format'
import { headerText, itemList } from './common'

export const DETAIL_LIST_NAME = 'detail'

const HEADER_H = 128
const LIST_Y = 128
const LIST_H = 160

/** Row indices in the detail action list. */
export const DetailAction = {
  Side0: 0,
  Side1: 1,
  Stake: 2,
  Follow: 3,
  PlaceBet: 4,
  Back: 5,
} as const

export interface DetailView {
  market: Market
  side: 0 | 1
  stakeIndex: number
  /** True when this market is on the user's watchlist. */
  followed: boolean
  /** Status line under the market facts (bet result, errors, position info). */
  status: string
}

export function buildDetailPage(view: DetailView): RebuildPageContainer {
  const { market, side, stakeIndex, followed, status } = view
  const stake = STAKE_PRESETS[stakeIndex] ?? STAKE_PRESETS[0]
  const lines = [
    market.question,
    `${market.outcomes[0]} ${fmtPct(market.prices[0])} · ${market.outcomes[1]} ${fmtPct(market.prices[1])}`,
    `Vol 24h ${fmtMoney(market.volume24hr)}${market.endDate ? ` · Ends ${fmtDate(market.endDate)}` : ''}`,
  ]
  if (status) lines.push(status)

  const mark = (s: 0 | 1) => (side === s ? '>' : ' ')
  const items = [
    `${mark(0)} ${market.outcomes[0]} ${fmtPct(market.prices[0])}`,
    `${mark(1)} ${market.outcomes[1]} ${fmtPct(market.prices[1])}`,
    `Stake: ${fmtMoney(stake)} — tap to change`,
    followed ? '★ Following — tap to unfollow' : '☆ Follow this market',
    'PLACE PAPER BET',
    'Back to markets',
  ]
  return new RebuildPageContainer({
    containerTotalNum: 2,
    textObject: [headerText(lines.join('\n'), HEADER_H)],
    listObject: [itemList(DETAIL_LIST_NAME, LIST_Y, LIST_H, items)],
  })
}
