// OddsGlance — big-move alerts for open paper positions.
// Pure logic, no SDK imports: given positions + live prices, report every
// position whose price moved at least ALERT_THRESHOLD_PTS points (0.10)
// away from its entry price. The glasses app itself cannot notify while
// closed (DESIGN.md §4.8 — no background push on device), so this module
// drives the in-app alert banner while the app is open; the same threshold
// rule is reused by the Telegram relay in tools/telegram-alerts/, which
// keeps watching — and pinging the user's phone — after the app closes.

import type { Position } from './state'

/** A move of 10 points (e.g. 62% -> 72%) counts as "big". */
export const ALERT_THRESHOLD_PTS = 10

export interface Alert {
  positionId: string
  /** Short label for the banner, e.g. "YES Fed cut". */
  label: string
  /** Signed move in points: +12 means the outcome price rose 12 pts. */
  movePts: number
  direction: 'up' | 'down'
  /** Unrealized PnL at the live price. */
  pnl: number
}

/**
 * Every open position whose live price moved >= thresholdPts points from
 * entry. Positions without a live price are skipped (never alerted on
 * stale data). Sorted by absolute move, biggest first.
 */
export function computeAlerts(
  positions: readonly Position[],
  priceOf: (pos: Position) => number | undefined,
  thresholdPts: number = ALERT_THRESHOLD_PTS,
): Alert[] {
  const alerts: Alert[] = []
  for (const pos of positions) {
    const priceNow = priceOf(pos)
    if (priceNow === undefined || !Number.isFinite(priceNow)) continue
    const movePts = (priceNow - pos.entryPrice) * 100
    // Epsilon: 0.72 - 0.62 is 9.999999999999998 in floats, not 10.
    if (Math.abs(movePts) + 1e-9 < thresholdPts) continue
    const value = pos.shares * priceNow
    alerts.push({
      positionId: pos.id,
      label: `${pos.outcomeLabel} ${pos.question}`,
      movePts: Math.round(movePts),
      direction: movePts > 0 ? 'up' : 'down',
      pnl: value - pos.stake,
    })
  }
  alerts.sort((a, b) => Math.abs(b.movePts) - Math.abs(a.movePts))
  return alerts
}

/** One-line banner text for the worst (first) active alert. */
export function alertBanner(alert: Alert): string {
  const arrow = alert.direction === 'up' ? '▲' : '▼'
  const sign = alert.movePts > 0 ? '+' : ''
  return `⚠ ALERT: ${alert.label} ${arrow} ${sign}${alert.movePts} pts`
}
