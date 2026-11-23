// OddsGlance core-logic tests (run 23 Nov 2026, Node 24).
// Covers: Gamma parsing (keyset + classic shapes, malformed filtering),
// client cache/stale behavior, paper-trade math, settlement, persistence.
const assert = require('node:assert')
const { GammaClient, parseMarket } = require('/tmp/og-test/gamma.js')
const { PaperStore, MemoryBackend, positionValue, positionPnl, STARTING_CASH } = require('/tmp/og-test/state.js')
const { fmtPct, fmtMoney, fmtSignedMoney, truncateWords } = require('/tmp/og-test/format.js')

let passed = 0
function ok(name, cond) {
  assert.ok(cond, name)
  passed++
  console.log('  ok -', name)
}
const approx = (a, b, eps = 1e-9) => Math.abs(a - b) < eps

async function main() {
  console.log('[format]')
  ok('fmtPct', fmtPct(0.625) === '63%' && fmtPct(0.5) === '50%')
  ok('fmtPct clamps live prices', fmtPct(0.996) === '99%' && fmtPct(0.004) === '1%' && fmtPct(1) === '100%' && fmtPct(0) === '0%')
  ok('fmtMoney', fmtMoney(1250) === '$1,250' && fmtMoney(646814) === '$646,814')
  ok('fmtSignedMoney', fmtSignedMoney(1.2) === '+$1.20' && fmtSignedMoney(-1.7) === '-$1.70')
  ok('truncateWords', truncateWords('Will the Fed cut rates in December?', 20).endsWith('…'))

  console.log('[parseMarket]')
  const keysetRaw = {
    id: '111', question: 'Q keyset?', outcomes: ['Yes', 'No'],
    outcomePrices: ['0.62', '0.38'], volume24hr: 1234.5, endDate: '2026-12-10T00:00:00Z',
    closed: false, active: true,
  }
  const m1 = parseMarket(keysetRaw)
  ok('keyset array shape parses', m1 && m1.prices[0] === 0.62 && m1.outcomes[1] === 'No')

  const classicRaw = { ...keysetRaw, id: '222', outcomes: '["Alpha","Beta"]', outcomePrices: '["0.3","0.7"]' }
  const m2 = parseMarket(classicRaw)
  ok('classic JSON-string shape parses', m2 && m2.outcomes[0] === 'Alpha' && m2.prices[1] === 0.7)

  ok('3 outcomes rejected', parseMarket({ ...keysetRaw, outcomes: ['A', 'B', 'C'], outcomePrices: ['0.3', '0.3', '0.4'] }) === null)
  ok('broken JSON rejected', parseMarket({ ...keysetRaw, outcomes: '[not json' }) === null)
  ok('price 0 rejected (strict)', parseMarket({ ...keysetRaw, outcomePrices: ['0', '1'] }) === null)
  const settled = parseMarket({ ...keysetRaw, outcomePrices: ['0', '1'], closed: true }, true)
  ok('price 0/1 allowed when allowExtreme', settled && settled.prices[1] === 1 && settled.closed === true)
  ok('price >1 rejected even loose', parseMarket({ ...keysetRaw, outcomePrices: ['1.2', '0.5'] }, true) === null)
  ok('missing question rejected', parseMarket({ ...keysetRaw, question: undefined }) === null)

  console.log('[GammaClient with mock fetch]')
  const page = {
    markets: [
      keysetRaw,
      { ...keysetRaw, id: '333', outcomes: ['A', 'B', 'C'], outcomePrices: ['0.2', '0.3', '0.5'] },
      { ...keysetRaw, id: '444', question: 'Second?', outcomePrices: ['0.9', '0.1'], volume24hr: 10 },
    ],
    next_cursor: null,
  }
  const mockFetch = async () => ({ ok: true, status: 200, json: async () => page })
  const client = new GammaClient(mockFetch)
  const top = await client.fetchTopMarkets(8)
  ok('mock list filters non-binary', top.markets.length === 2 && top.stale === false)
  const failing = new GammaClient(async () => { throw new Error('net down') })
  const downFresh = await failing.fetchTopMarkets(8)
  ok('network fail with no cache -> empty + stale', downFresh.markets.length === 0 && downFresh.stale === true)
  const cachedClient = new GammaClient(async (url) => {
    if (String(url).includes('id=')) throw new Error('down')
    return { ok: true, status: 200, json: async () => page }
  })
  await cachedClient.fetchTopMarkets(8)
  const one = await cachedClient.fetchMarketById('111')
  ok('fetchMarketById failure -> null (no crash)', one === null)

  console.log('[PaperStore math + persistence]')
  const backend = new MemoryBackend()
  const store = new PaperStore(backend)
  await store.init()
  ok('fresh cash = 1000', store.cash === STARTING_CASH && store.positions.length === 0)

  const market = m1 // price 0.62 / 0.38
  const pos = await store.placeBet(market, 0, 25)
  ok('bet placed', !!pos)
  ok('shares = stake/price', approx(pos.shares, 25 / 0.62))
  ok('cash deducted', approx(store.cash, 975))
  ok('value @0.65', approx(positionValue(pos, 0.65), (25 / 0.62) * 0.65))
  ok('pnl @0.65', approx(positionPnl(pos, 0.65), (25 / 0.62) * 0.65 - 25))
  ok('over-cash bet rejected', (await store.placeBet(market, 1, 5000)) === null && store.positions.length === 1)
  ok('equity resolver', approx(store.equity(p => (p.id === pos.id ? 0.65 : undefined)), 975 + (25 / 0.62) * 0.65))

  const credited = await store.cashOut(pos.id, 0.65)
  ok('cash out credits value', approx(credited, (25 / 0.62) * 0.65) && approx(store.cash, 975 + credited) && store.positions.length === 0)

  // Settlement: bet NO @0.38, market closes with NO -> price 1.
  const pos2 = await store.placeBet(market, 1, 38)
  const closedMap = new Map([['111', { ...market, closed: true, prices: [0, 1] }]])
  const settledCount = await store.settleClosed(closedMap)
  ok('closed position settles at final price', settledCount === 1 && store.positions.length === 0 && approx(store.cash, 975 + credited - 38 + 100))
  ok('settled summary recorded', store.lastSettled.length === 1 && approx(store.lastSettled[0].pnl, 62))

  // Persistence round-trip through the same backend.
  const pos3 = await store.placeBet(market, 0, 62)
  const store2 = new PaperStore(backend)
  await store2.init()
  ok('state survives reload', store2.positions.length === 1 && approx(store2.cash, store.cash) && store2.positions[0].id === pos3.id)

  await store2.reset()
  const store3 = new PaperStore(backend)
  await store3.init()
  ok('reset persists', store3.cash === STARTING_CASH && store3.positions.length === 0)

  console.log('[LIVE Gamma]')
  const live = new GammaClient()
  const liveTop = await live.fetchTopMarkets(8)
  ok('live list returns markets', liveTop.markets.length >= 5 && liveTop.stale === false)
  ok('live list all binary in (0,1)', liveTop.markets.every(m => m.prices.every(p => p > 0 && p < 1) && m.outcomes.length === 2))
  const vols = liveTop.markets.map(m => m.volume24hr)
  ok('live list sorted by volume desc', vols.every((v, i) => i === 0 || vols[i - 1] >= v))
  const first = liveTop.markets[0]
  const single = await live.fetchMarketById(first.id)
  ok('live single refresh matches id', !!single && single.id === first.id)
  console.log('  live sample:', first.id, '|', first.question.slice(0, 48), '|', first.outcomes.join('/'), first.prices.join('/'))

  console.log(`\nALL TESTS PASSED (${passed} assertions)`)
}

main().catch((e) => {
  console.error('TEST FAILURE:', e)
  process.exit(1)
})
