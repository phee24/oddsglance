// OddsGlance — formatting helpers (pure, no SDK / no DOM).
// Odds are always whole percents, money always `$` + thousands separators,
// PnL always signed. See DESIGN.md §3.

/** 0.625 -> "63%" (whole percent, rounded). A live (unsettled) price never
 * displays as 0% or 100% — it is clamped to 1–99; only a true 0/1 shows. */
export function fmtPct(price: number): string {
  if (!Number.isFinite(price)) return '—%'
  const pct = Math.round(price * 100)
  if (price > 0 && price < 1) return `${Math.min(99, Math.max(1, pct))}%`
  return `${pct}%`
}

/** 1250 -> "$1,250"; 62.5 -> "$63" (whole dollars by default). */
export function fmtMoney(value: number, decimals = 0): string {
  if (!Number.isFinite(value)) return '$—'
  const fixed = value.toFixed(decimals)
  const [intPart, fracPart] = fixed.split('.')
  const neg = intPart.startsWith('-')
  const digits = neg ? intPart.slice(1) : intPart
  const grouped = digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  return `$${neg ? '-' : ''}${grouped}${fracPart ? `.${fracPart}` : ''}`
}

/** Position-sized money with cents: 1.2 -> "$1.20", -1.7 -> "-$1.70". */
export function fmtMoney2(value: number): string {
  if (!Number.isFinite(value)) return '$—'
  const sign = value < 0 ? '-' : ''
  return `${sign}$${Math.abs(value).toFixed(2)}`
}

/** Signed PnL: 1.2 -> "+$1.20", -1.7 -> "-$1.70", 0 -> "+$0.00". */
export function fmtSignedMoney(value: number): string {
  if (!Number.isFinite(value)) return '$—'
  if (value < 0) return fmtMoney2(value)
  return `+${fmtMoney2(value)}`
}

/**
 * Truncate at a word boundary and end with "…" so a question never loses a
 * number or symbol mid-token (DESIGN.md §3). Returns the text unchanged when
 * it already fits.
 */
export function truncateWords(text: string, max: number): string {
  if (text.length <= max) return text
  const hard = text.slice(0, max)
  const lastSpace = hard.lastIndexOf(' ')
  const cut = lastSpace > Math.floor(max * 0.5) ? hard.slice(0, lastSpace) : hard
  return `${cut.trimEnd()}…`
}

/** Outcome label for tight list rows: max ~10 chars, char-truncated. */
export function shortLabel(label: string, max = 10): string {
  if (label.length <= max) return label
  return `${label.slice(0, max - 1)}…`
}

/** "2026-12-10T17:00:00Z" -> "Dec 10". Falls back to "" on bad input. */
export function fmtDate(iso: string | null | undefined): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  return `${months[d.getUTCMonth()]} ${d.getUTCDate()}`
}
