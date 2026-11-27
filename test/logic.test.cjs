// OddsGlance core-logic tests (run 23 Nov 2026, Node 24).
// Covers: Gamma parsing (keyset + classic shapes, malformed filtering),
// client cache/stale behavior, paper-trade math, settlement, persistence.
const assert = require('node:assert')
const { GammaClient, parseMarket } = require('/tmp/og-test/gamma.js')
const { PaperStore, MemoryBackend, WatchlistStore, MAX_FOLLOWED, positionValue, positionPnl, STARTING_CASH } = require('/tmp/og-test/state.js')
const { computeAlerts, alertBanner, ALERT_THRESHOLD_PTS } = require('/tmp/og-test/alerts.js')
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

  console.log('[GammaClient paging]')
  const page1 = {
    markets: [keysetRaw, { ...keysetRaw, id: '555', question: 'Third?', outcomePrices: ['0.2', '0.8'] }],
    next_cursor: 'CUR1',
  }
  const page2 = {
    markets: [{ ...keysetRaw, id: '666', question: 'Fourth?', outcomePrices: ['0.7', '0.3'] }],
    next_cursor: null,
  }
  const pagingFetch = async (url) => ({
    ok: true, status: 200,
    json: async () => (String(url).includes('after_cursor=CUR1') ? page2 : page1),
  })
  const pagingClient = new GammaClient(pagingFetch)
  const firstPage = await pagingClient.fetchTopMarkets(2)
  ok('first page returns cursor', firstPage.markets.length === 2 && firstPage.nextCursor === 'CUR1')
  const nextPage = await pagingClient.fetchNextMarkets(firstPage.nextCursor, 1)
  ok('next page follows cursor', nextPage.markets.length === 1 && nextPage.markets[0].id === '666' && nextPage.nextCursor === null)
  const noCursor = await pagingClient.fetchNextMarkets(null, 8)
  ok('null cursor -> empty page, no fetch', noCursor.markets.length === 0 && noCursor.nextCursor === null)

  console.log('[WatchlistStore]')
  const wlBackend = new MemoryBackend()
  const wl = new WatchlistStore(wlBackend)
  await wl.init()
  ok('watchlist starts empty', wl.list.length === 0 && !wl.has('111'))
  ok('add follows', (await wl.add(m1)) === true && wl.has('111') && wl.list.length === 1)
  ok('re-add same market rejected', (await wl.add(m1)) === false && wl.list.length === 1)
  ok('remove unfollows', (await wl.remove('111')) === true && !wl.has('111'))
  ok('remove unknown rejected', (await wl.remove('111')) === false)
  await wl.add(m1)
  const wl2 = new WatchlistStore(wlBackend)
  await wl2.init()
  ok('watchlist survives reload', wl2.has('111') && wl2.list[0].question === m1.question)
  const badBackend = new MemoryBackend()
  await badBackend.save('[{"id":123}]')
  const wlBad = new WatchlistStore(badBackend)
  await wlBad.init()
  ok('corrupt watchlist -> empty, no crash', wlBad.list.length === 0)
  const fullBackend = new MemoryBackend()
  const wlFull = new WatchlistStore(fullBackend)
  await wlFull.init()
  for (let i = 0; i < MAX_FOLLOWED; i++) {
    await wlFull.add({ ...m1, id: `f${i}` })
  }
  ok('watchlist caps at MAX_FOLLOWED', wlFull.list.length === MAX_FOLLOWED && (await wlFull.add({ ...m1, id: 'overflow' })) === false)

  console.log('[computeAlerts]')
  const alertStore = new PaperStore(new MemoryBackend())
  await alertStore.init()
  const alertPos = await alertStore.placeBet(m1, 0, 25) // entry 0.62
  const noMove = computeAlerts(alertStore.positions, () => 0.65)
  ok('3 pts move -> no alert', noMove.length === 0)
  const bigMove = computeAlerts(alertStore.positions, () => 0.75)
  ok('13 pts move -> alert up', bigMove.length === 1 && bigMove[0].direction === 'up' && bigMove[0].movePts === 13)
  const bigDrop = computeAlerts(alertStore.positions, () => 0.50)
  ok('12 pts drop -> alert down', bigDrop.length === 1 && bigDrop[0].direction === 'down' && bigDrop[0].movePts === -12)
  const exact = computeAlerts(alertStore.positions, () => 0.72)
  ok('exactly threshold fires', exact.length === 1)
  const noPrice = computeAlerts(alertStore.positions, () => undefined)
  ok('no live price -> no alert', noPrice.length === 0)
  ok('alertBanner formats', alertBanner(bigMove[0]).includes('⚠ ALERT') && alertBanner(bigMove[0]).includes('+13 pts'))
  ok('threshold constant is 10 pts', ALERT_THRESHOLD_PTS === 10)

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
