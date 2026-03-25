const express = require('express');
const http = require('http');
const { WebSocketServer, WebSocket: WsClient } = require('ws');
const fs = require('fs');
const path = require('path');

// ─── Config ───────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, 'data', 'state.json');
const CLOB_API = 'https://clob.polymarket.com';
const GAMMA_API = 'https://gamma-api.polymarket.com';
const INITIAL_BALANCE = 10000;
const MIN_SPREAD_PCT = 0.5;
const TRADE_SIZE = 50;

const MARKET_SCAN_INTERVAL = 30000;   // 30s between market discovery (faster for 5min transitions)
const ORDERBOOK_INTERVAL = 60000;     // 60s between orderbook refreshes (depth info only)
const LIVE_PRICE_INTERVAL = 1000;     // 1s between live last-trade-price fetches (lightweight endpoint ~50ms)
const GAMMA_RATE_LIMIT = 5000;        // 5s between gamma requests
const CLOB_RATE_LIMIT = 2000;         // 2s between clob requests
const BTC_HISTORY_MAX = 300;          // ~5 min of per-second data
const HISTORY_FILE = path.join(__dirname, 'data', 'market-history.jsonl');
const BTC_SNAPSHOTS_FILE = path.join(__dirname, 'data', 'btc-snapshots.jsonl');
const PAPER_TRADES_FILE = path.join(__dirname, 'data', 'paper-trades.jsonl');
const MOMENTUM_TRADES_FILE = path.join(__dirname, 'data', 'momentum-trades.jsonl');
const SNIPE_TRADES_FILE = path.join(__dirname, 'data', 'snipe-trades.jsonl');

// ─── Late-Snipe Paper Trading Config ─────────────────────────────────────────
const SNIPE_MIN_TIME = 10000;       // 10s before end (minimum - too close is risky)
const SNIPE_MAX_TIME = 60000;       // 60s before end (maximum - last minute only)
const SNIPE_BET_SIZE = 50;          // $50 per snipe bet
const SNIPE_MIN_ENTRY = 0.80;       // STRONG signal only - entry must be >= 80¢
const SNIPE_MIN_DELTA_PCT = 0.05;   // BTC must be at least 0.05% away from reference price (strong move)

// ─── Momentum Paper Trading Config ───────────────────────────────────────────
const MOMENTUM_THRESHOLD = 0.05;      // minimum momentum % to trigger a bet
const MOMENTUM_TIGHT = 0.10;          // tight momentum for larger bets
const MOMENTUM_BET_STANDARD = 50;     // standard bet size
const MOMENTUM_BET_TIGHT = 100;       // bet size for tight momentum signals
const MOMENTUM_WINDOW_MS = 120000;    // 2 minutes of BTC history for momentum calc
const MOMENTUM_MIN_TIME_LEFT = 30000; // don't bet if <30s left
const MOMENTUM_MAX_TIME_LEFT = 240000; // don't bet if >4min left (want to bet mid-market)
const MOMENTUM_ONLY_5M = true;        // only trade 5m markets (15m showed weak signal)
const MOMENTUM_MIN_ENTRY_PRICE = 0.60; // skip trades with entry < 0.60 (35.7% WR vs 75%+ above)

// ─── State ────────────────────────────────────────────────────────────────────
let state = loadState();
let btcPrice = null;
let btcHistory = [];       // {time: epoch_ms, price: number}
let activeMarkets = [];    // enriched market objects
let lastGammaReq = 0;
let lastClobReq = 0;

// ─── Momentum Paper Trading State ────────────────────────────────────────────
let momentumPortfolio = {
  balance: 10000,
  totalPnl: 0,
  trades: 0,
  wins: 0,
  losses: 0,
  openBets: [],       // { slug, direction, size, entryTime, entryPrice, referencePrice, endDate, momentum }
  closedBets: [],     // resolved bets with pnl
};
const momentumBetted = new Set(); // slugs we've already bet on (avoid double-betting)

// ─── Late-Snipe Paper Trading State ──────────────────────────────────────────
let snipePortfolio = {
  balance: 10000,
  totalPnl: 0,
  trades: 0,
  wins: 0,
  losses: 0,
  openBets: [],     // { slug, direction, size, entryTime, entryPrice, referencePrice, endDate, deltaPct, timeBeforeEnd }
  closedBets: [],   // resolved bets with pnl
};
const snipeBetted = new Set(); // slugs we've already sniped (avoid double-betting)

function defaultState() {
  return {
    balance: INITIAL_BALANCE,
    totalPnl: 0,
    trades: [],
    openPositions: [],
    closedPositions: [],
    portfolioHistory: [{ time: Date.now(), value: INITIAL_BALANCE }],
  };
}

function loadState() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      return { ...defaultState(), ...JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')) };
    }
  } catch (e) { console.error('[STATE] Load failed:', e.message); }
  return defaultState();
}

// ─── Historical Data Collection ───────────────────────────────────────────────
const trackedMarkets = new Map(); // slug -> { openPrice, openTime, upPriceAtOpen, downPriceAtOpen }

function appendJsonl(file, obj) {
  try {
    const dir = path.dirname(file);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(file, JSON.stringify(obj) + '\n');
  } catch (e) { console.error('[HISTORY] Write failed:', e.message); }
}

function snapshotBtcPrice() {
  if (!btcPrice) return;
  const now = Date.now();
  // Log every 30s
  if (!snapshotBtcPrice._last || now - snapshotBtcPrice._last >= 30000) {
    snapshotBtcPrice._last = now;
    appendJsonl(BTC_SNAPSHOTS_FILE, { time: now, price: btcPrice });
  }
}

function trackMarketOpen(market) {
  if (!market.slug || trackedMarkets.has(market.slug)) return;
  trackedMarkets.set(market.slug, {
    slug: market.slug,
    type: market.type,
    question: market.question,
    openTime: Date.now(),
    openBtcPrice: btcPrice,
    referencePrice: market.referencePrice,
    upPriceAtOpen: market.upLastPrice || market.outcomePrices?.[0] || null,
    downPriceAtOpen: market.downLastPrice || market.outcomePrices?.[1] || null,
    endDate: market.endDate,
  });
  console.log(`[HISTORY] Tracking market open: ${market.slug} | BTC: $${btcPrice}`);
}

function checkMarketResolutions() {
  const now = Date.now();
  for (const [slug, tracked] of trackedMarkets) {
    const endTime = new Date(tracked.endDate).getTime();
    // Check 90s after end (give time for resolution)
    if (now > endTime + 90000) {
      const closeBtcPrice = btcPrice;
      const btcChange = tracked.openBtcPrice && closeBtcPrice
        ? ((closeBtcPrice - tracked.openBtcPrice) / tracked.openBtcPrice) * 100
        : null;
      const refChange = tracked.referencePrice && closeBtcPrice
        ? ((closeBtcPrice - tracked.referencePrice) / tracked.referencePrice) * 100
        : null;
      const outcome = refChange !== null ? (refChange >= 0 ? 'Up' : 'Down') : 'unknown';

      // Get BTC price history around market period
      const marketDuration = endTime - new Date(tracked.openTime).getTime();
      const relevantHistory = btcHistory.filter(h => h.time >= tracked.openTime - 60000 && h.time <= endTime + 60000);
      const momentum2m = relevantHistory.length > 2
        ? ((relevantHistory[relevantHistory.length - 1].price - relevantHistory[Math.max(0, relevantHistory.length - 121)].price) / relevantHistory[Math.max(0, relevantHistory.length - 121)].price) * 100
        : null;

      const record = {
        slug,
        type: tracked.type,
        openTime: tracked.openTime,
        endTime,
        openBtcPrice: tracked.openBtcPrice,
        closeBtcPrice,
        referencePrice: tracked.referencePrice,
        btcChangePct: btcChange,
        refChangePct: refChange,
        outcome,
        momentum2mPct: momentum2m,
        upPriceAtOpen: tracked.upPriceAtOpen,
        downPriceAtOpen: tracked.downPriceAtOpen,
      };

      appendJsonl(HISTORY_FILE, record);
      console.log(`[HISTORY] Market resolved: ${slug} → ${outcome} | BTC Δ: ${btcChange?.toFixed(4)}% | Ref Δ: ${refChange?.toFixed(4)}%`);
      trackedMarkets.delete(slug);
    }
  }
}

// ─── State persistence ────────────────────────────────────────────────────────
function saveState() {
  try {
    const dir = path.dirname(DATA_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(DATA_FILE, JSON.stringify(state, null, 2));
  } catch (e) { console.error('[STATE] Save failed:', e.message); }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ─── Rate-limited fetch ───────────────────────────────────────────────────────
async function rateLimitedFetch(url, type) {
  try {
    const now = Date.now();
    if (type === 'gamma') {
      const wait = GAMMA_RATE_LIMIT - (now - lastGammaReq);
      if (wait > 0) await sleep(wait);
      lastGammaReq = Date.now();
    } else if (type === 'clob') {
      const wait = CLOB_RATE_LIMIT - (now - lastClobReq);
      if (wait > 0) await sleep(wait);
      lastClobReq = Date.now();
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timeout);
    if (!res.ok) {
      if (res.status === 429) {
        console.warn(`[RATE LIMIT] ${type} 429, backing off 15s`);
        await sleep(15000);
      }
      return null;
    }
    return await res.json();
  } catch (e) {
    console.warn(`[FETCH] ${type} error: ${e.message}`);
    return null;
  }
}

// ─── Binance WebSocket for real-time BTC price ────────────────────────────────
let binanceWs = null;
let binanceReconnectTimer = null;

function connectBinance() {
  try {
    if (binanceWs) { try { binanceWs.close(); } catch {} }
    clearTimeout(binanceReconnectTimer);

    console.log('[BINANCE] Connecting to wss://stream.binance.com:9443/ws/btcusdt@trade');
    binanceWs = new WsClient('wss://stream.binance.com:9443/ws/btcusdt@trade');

    binanceWs.on('open', () => {
      console.log('[BINANCE] Connected - receiving real-time BTC prices');
    });

    binanceWs.on('message', (raw) => {
      try {
        const data = JSON.parse(raw.toString());
        const price = parseFloat(data.p);
        if (!price || isNaN(price)) return;

        const prev = btcPrice;
        btcPrice = price;

        // Throttle history to ~1 entry per second
        const now = Date.now();
        const lastEntry = btcHistory[btcHistory.length - 1];
        if (!lastEntry || now - lastEntry.time >= 1000) {
          btcHistory.push({ time: now, price });
          if (btcHistory.length > BTC_HISTORY_MAX) {
            btcHistory = btcHistory.slice(-BTC_HISTORY_MAX);
          }
        }
      } catch {}
    });

    binanceWs.on('close', () => {
      console.log('[BINANCE] Disconnected, reconnecting in 5s...');
      binanceReconnectTimer = setTimeout(connectBinance, 5000);
    });

    binanceWs.on('error', (err) => {
      console.warn('[BINANCE] WS error:', err.message);
      try { binanceWs.close(); } catch {}
    });
  } catch (e) {
    console.error('[BINANCE] Connection failed:', e.message);
    binanceReconnectTimer = setTimeout(connectBinance, 5000);
  }
}

// ─── Market Discovery ─────────────────────────────────────────────────────────
function getMarketSlugs() {
  const now = Math.floor(Date.now() / 1000);
  const current5m = Math.floor(now / 300) * 300;
  const next5m = current5m + 300;
  const current15m = Math.floor(now / 900) * 900;
  const next15m = current15m + 900;
  const prev5m = current5m - 300;
  const prev15m = current15m - 900;

  return [
    { slug: `btc-updown-5m-${next5m}`, type: '5m', ts: next5m },
    { slug: `btc-updown-5m-${current5m}`, type: '5m', ts: current5m },
    { slug: `btc-updown-5m-${prev5m}`, type: '5m', ts: prev5m },
    { slug: `btc-updown-15m-${next15m}`, type: '15m', ts: next15m },
    { slug: `btc-updown-15m-${current15m}`, type: '15m', ts: current15m },
    { slug: `btc-updown-15m-${prev15m}`, type: '15m', ts: prev15m },
  ];
}

async function fetchMarket(slug) {
  try {
    const data = await rateLimitedFetch(`${GAMMA_API}/events?slug=${slug}`, 'gamma');
    if (!data || data.length === 0) return null;
    const event = data[0];
    if (!event.markets || event.markets.length === 0) return null;
    const m = event.markets[0];

    let outcomePrices = [];
    try { outcomePrices = JSON.parse(m.outcomePrices || '[]'); } catch { outcomePrices = []; }
    let clobTokenIds = [];
    try { clobTokenIds = JSON.parse(m.clobTokenIds || '[]'); } catch { clobTokenIds = []; }

    // Try to extract reference price from market description
    let referencePrice = null;
    const desc = m.description || event.description || '';
    const priceMatch = desc.match(/\$([0-9,]+(?:\.[0-9]+)?)/);
    if (priceMatch) {
      referencePrice = parseFloat(priceMatch[1].replace(/,/g, ''));
      if (isNaN(referencePrice)) referencePrice = null;
    }
    // Fallback: use current BTC price at time of discovery
    if (!referencePrice && btcPrice) {
      referencePrice = btcPrice;
    }

    return {
      slug,
      conditionId: m.conditionId,
      question: m.question || event.title,
      outcomes: m.outcomes ? JSON.parse(m.outcomes) : ['Up', 'Down'],
      outcomePrices: outcomePrices.map(Number),
      clobTokenIds,
      endDate: m.endDate || event.endDate,
      active: m.active,
      closed: m.closed,
      referencePrice,
    };
  } catch (e) {
    console.warn(`[MARKET] Failed to fetch ${slug}:`, e.message);
    return null;
  }
}

async function fetchOrderbook(tokenId) {
  try {
    const data = await rateLimitedFetch(`${CLOB_API}/book?token_id=${tokenId}`, 'clob');
    if (!data) return { bestBid: { price: 0, size: 0 }, bestAsk: { price: 0, size: 0 }, bids: [], asks: [] };
    const bestBid = data.bids?.length > 0
      ? { price: parseFloat(data.bids[0].price), size: parseFloat(data.bids[0].size) }
      : { price: 0, size: 0 };
    const bestAsk = data.asks?.length > 0
      ? { price: parseFloat(data.asks[0].price), size: parseFloat(data.asks[0].size) }
      : { price: 0, size: 0 };
    return { bestBid, bestAsk, bids: data.bids || [], asks: data.asks || [] };
  } catch (e) {
    return { bestBid: { price: 0, size: 0 }, bestAsk: { price: 0, size: 0 }, bids: [], asks: [] };
  }
}

// ─── Direct fetch for last-trade-price (no rate limiting, ~50ms response) ────
async function fetchLastTradePrice(tokenId) {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    const res = await fetch(`${CLOB_API}/last-trade-price?token_id=${tokenId}`, { signal: controller.signal });
    clearTimeout(timeout);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

// ─── Rate-limited CLOB fetch for midpoint/buy/sell (uses clob rate limit) ────
async function fetchClobPrice(endpoint, tokenId, params) {
  try {
    let url = `${CLOB_API}/${endpoint}?token_id=${tokenId}`;
    if (params) url += `&${params}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timeout);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

// ─── Live last-trade-price fetch (parallel, no rate limit) ───────────────────
async function fetchLivePrices(market) {
  if (!market.clobTokenIds || market.clobTokenIds.length < 2) return;
  const upToken = market.clobTokenIds[0];
  const downToken = market.clobTokenIds[1];
  if (!upToken || !downToken || upToken === downToken) return;

  // Fetch BOTH tokens' last-trade-price in PARALLEL - no rate limit delay
  const [upLastRes, downLastRes] = await Promise.all([
    fetchLastTradePrice(upToken),
    fetchLastTradePrice(downToken),
  ]);

  // Last trade price is the PRIMARY display price (matches Polymarket's "Up Xc" / "Down Xc")
  const upLastVal = upLastRes?.price != null ? parseFloat(upLastRes.price) : null;
  const downLastVal = downLastRes?.price != null ? parseFloat(downLastRes.price) : null;
  market.upLastPrice = upLastVal && upLastVal > 0 ? upLastVal : null;
  market.downLastPrice = downLastVal && downLastVal > 0 ? downLastVal : null;
  market.livePriceTime = Date.now();
}

// ─── Secondary price data (midpoint, buy/sell) - fetched less frequently ─────
async function fetchSecondaryPrices(market) {
  if (!market.clobTokenIds || market.clobTokenIds.length < 2) return;
  const upToken = market.clobTokenIds[0];
  const downToken = market.clobTokenIds[1];
  if (!upToken || !downToken || upToken === downToken) return;

  const [upMidRes, downMidRes, upBuyRes, upSellRes, downBuyRes, downSellRes] = await Promise.all([
    fetchClobPrice('midpoint', upToken),
    fetchClobPrice('midpoint', downToken),
    fetchClobPrice('price', upToken, 'side=buy'),
    fetchClobPrice('price', upToken, 'side=sell'),
    fetchClobPrice('price', downToken, 'side=buy'),
    fetchClobPrice('price', downToken, 'side=sell'),
  ]);

  market.upMid = upMidRes?.mid != null ? parseFloat(upMidRes.mid) : null;
  market.downMid = downMidRes?.mid != null ? parseFloat(downMidRes.mid) : null;

  const upBuyVal = upBuyRes?.price != null ? parseFloat(upBuyRes.price) : null;
  const upSellVal = upSellRes?.price != null ? parseFloat(upSellRes.price) : null;
  const downBuyVal = downBuyRes?.price != null ? parseFloat(downBuyRes.price) : null;
  const downSellVal = downSellRes?.price != null ? parseFloat(downSellRes.price) : null;
  market.upBuy = upBuyVal && upBuyVal > 0 ? upBuyVal : null;
  market.upSell = upSellVal && upSellVal > 0 ? upSellVal : null;
  market.downBuy = downBuyVal && downBuyVal > 0 ? downBuyVal : null;
  market.downSell = downSellVal && downSellVal > 0 ? downSellVal : null;
}

// ─── Live Price Loop (every 1s - last-trade-price only, parallel, no rate limit)
async function livePriceLoop() {
  while (true) {
    try {
      const active = activeMarkets.filter(m => new Date(m.endDate).getTime() > Date.now());
      // Fetch all markets' last-trade-prices in parallel
      await Promise.all(active.map(market => fetchLivePrices(market)));
      const count = active.filter(m => m.livePriceTime).length;
      if (count > 0) console.log(`[LIVE PRICES] Updated ${count} markets (1s interval)`);
    } catch (e) {
      console.error('[LIVE PRICES] Error:', e.message);
    }
    await sleep(LIVE_PRICE_INTERVAL);
  }
}

// ─── Secondary Price Loop (every 10s - midpoint, buy/sell for spread info) ───
async function secondaryPriceLoop() {
  while (true) {
    try {
      for (const market of activeMarkets) {
        const endTime = new Date(market.endDate).getTime();
        if (endTime <= Date.now()) continue;
        await fetchSecondaryPrices(market);
      }
    } catch (e) {
      console.error('[SECONDARY PRICES] Error:', e.message);
    }
    await sleep(10000);
  }
}

// ─── Arb Calc & Paper Trading ─────────────────────────────────────────────────
function calcArbitrage(upBook, downBook, outcomePrices) {
  const bookAskUp = upBook.bestAsk.price;
  const bookAskDown = downBook.bestAsk.price;
  const hasOrderbook = bookAskUp > 0 && bookAskDown > 0;

  // Use orderbook asks if available, otherwise fall back to outcomePrices (mid-market)
  const bestAskUp = hasOrderbook ? bookAskUp : (outcomePrices?.[0] || 0);
  const bestAskDown = hasOrderbook ? bookAskDown : (outcomePrices?.[1] || 0);

  if (bestAskUp <= 0 || bestAskDown <= 0) {
    return { profitable: false, spread: 0, cost: 0, profit: 0, source: 'none' };
  }
  const cost = bestAskUp + bestAskDown;
  const spread = (1 - cost) * 100;
  const profitable = spread > MIN_SPREAD_PCT;
  const profit = profitable ? (1 - cost) * TRADE_SIZE : 0;
  return { profitable, spread, cost, profit, bestAskUp, bestAskDown, source: hasOrderbook ? 'orderbook' : 'outcomePrices' };
}

function executeTrade(marketInfo, arb) {
  try {
    if (state.balance < TRADE_SIZE * arb.cost) return null;
    const totalCost = TRADE_SIZE * arb.cost;
    const position = {
      id: `pos_${Date.now()}`,
      slug: marketInfo.slug,
      question: marketInfo.question,
      entryTime: Date.now(),
      endDate: marketInfo.endDate,
      upPrice: arb.bestAskUp,
      downPrice: arb.bestAskDown,
      cost: totalCost,
      size: TRADE_SIZE,
      expectedProfit: TRADE_SIZE - totalCost,
      spread: arb.spread,
      status: 'open',
    };
    state.balance -= totalCost;
    state.openPositions.push(position);
    state.trades.push({
      id: `trade_${Date.now()}`,
      time: Date.now(),
      slug: marketInfo.slug,
      type: 'BUY_BOTH',
      upPrice: arb.bestAskUp,
      downPrice: arb.bestAskDown,
      cost: totalCost,
      size: TRADE_SIZE,
      spread: arb.spread,
    });
    saveState();
    console.log(`[TRADE] ${marketInfo.slug} | Spread: ${arb.spread.toFixed(2)}% | Cost: $${totalCost.toFixed(2)}`);
    return position;
  } catch (e) {
    console.error('[TRADE] Error:', e.message);
    return null;
  }
}

function resolveExpiredPositions() {
  try {
    const now = Date.now();
    let changed = false;
    state.openPositions = state.openPositions.filter(pos => {
      const endTime = new Date(pos.endDate).getTime();
      if (now > endTime + 60000) {
        const payout = pos.size;
        const pnl = payout - pos.cost;
        pos.status = 'closed';
        pos.closeTime = now;
        pos.payout = payout;
        pos.pnl = pnl;
        state.balance += payout;
        state.totalPnl += pnl;
        state.closedPositions.push(pos);
        changed = true;
        console.log(`[RESOLVE] ${pos.slug} | PnL: $${pnl.toFixed(2)}`);
        return false;
      }
      return true;
    });
    if (changed) {
      state.portfolioHistory.push({
        time: now,
        value: state.balance + state.openPositions.reduce((s, p) => s + p.cost, 0),
      });
      saveState();
    }
  } catch (e) {
    console.error('[RESOLVE] Error:', e.message);
  }
}

// ─── Momentum Paper Trading Logic ─────────────────────────────────────────────
function calcMomentum() {
  if (btcHistory.length < 10) return null;
  const now = Date.now();
  const windowStart = now - MOMENTUM_WINDOW_MS;
  const relevant = btcHistory.filter(h => h.time >= windowStart);
  if (relevant.length < 5) return null;
  const oldest = relevant[0].price;
  const newest = relevant[relevant.length - 1].price;
  return ((newest - oldest) / oldest) * 100;
}

function checkMomentumBets() {
  const momentum = calcMomentum();
  if (momentum === null) return;

  const absMomentum = Math.abs(momentum);
  if (absMomentum < MOMENTUM_THRESHOLD) return;

  const direction = momentum > 0 ? 'Up' : 'Down';
  const isTight = absMomentum >= MOMENTUM_TIGHT;
  const betSize = isTight ? MOMENTUM_BET_TIGHT : MOMENTUM_BET_STANDARD;

  for (const market of activeMarkets) {
    if (MOMENTUM_ONLY_5M && market.type !== '5m') continue;
    if (momentumBetted.has(market.slug)) continue;

    const endTime = new Date(market.endDate).getTime();
    const timeLeft = endTime - Date.now();
    if (timeLeft < MOMENTUM_MIN_TIME_LEFT || timeLeft > MOMENTUM_MAX_TIME_LEFT) continue;
    if (!market.referencePrice) continue;

    // Check we have enough balance
    if (momentumPortfolio.balance < betSize) continue;

    // Get entry price (what we'd pay for the outcome token)
    const entryPrice = direction === 'Up'
      ? (market.upLastPrice || market.outcomePrices?.[0] || 0.5)
      : (market.downLastPrice || market.outcomePrices?.[1] || 0.5);

    // Skip low-entry trades (data shows < 0.60 has 35.7% WR = losing money)
    if (entryPrice < MOMENTUM_MIN_ENTRY_PRICE) {
      console.log(`[MOMENTUM] SKIP ${direction} on ${market.slug} | Entry ${entryPrice.toFixed(3)} < ${MOMENTUM_MIN_ENTRY_PRICE} min threshold`);
      continue;
    }

    // Place the virtual bet
    const bet = {
      slug: market.slug,
      type: market.type,
      direction,
      size: betSize,
      entryTime: Date.now(),
      entryPrice,
      referencePrice: market.referencePrice,
      endDate: market.endDate,
      btcPriceAtEntry: btcPrice,
      momentum: momentum.toFixed(4),
      signal: isTight ? 'tight' : 'strong',
    };

    momentumPortfolio.balance -= betSize * entryPrice;
    momentumPortfolio.openBets.push(bet);
    momentumPortfolio.trades++;
    momentumBetted.add(market.slug);

    console.log(`[MOMENTUM] BET ${direction} on ${market.slug} | Size: $${betSize} @ ${entryPrice.toFixed(3)} | Momentum: ${momentum.toFixed(4)}% (${isTight ? 'TIGHT' : 'strong'}) | Balance: $${momentumPortfolio.balance.toFixed(2)}`);
    appendJsonl(MOMENTUM_TRADES_FILE, { ...bet, action: 'OPEN' });
  }
}

function resolveMomentumBets() {
  const now = Date.now();
  momentumPortfolio.openBets = momentumPortfolio.openBets.filter(bet => {
    const endTime = new Date(bet.endDate).getTime();
    if (now <= endTime + 90000) return true; // not resolved yet

    // Determine actual outcome
    const closeBtcPrice = btcPrice;
    const refChange = bet.referencePrice && closeBtcPrice
      ? ((closeBtcPrice - bet.referencePrice) / bet.referencePrice) * 100
      : null;

    if (refChange === null) {
      // Can't determine outcome, refund
      momentumPortfolio.balance += bet.size * bet.entryPrice;
      console.log(`[MOMENTUM] REFUND ${bet.slug} - no reference data`);
      return false;
    }

    const actualOutcome = refChange >= 0 ? 'Up' : 'Down';
    const won = actualOutcome === bet.direction;

    let pnl;
    if (won) {
      // Payout = size (bet $50 at 0.5 → get 100 shares → payout $100 if win, but we spent $25)
      // Actually: we buy `shares = betSize` worth of outcome tokens at entryPrice
      // Shares bought = betSize (dollar amount) / no, cost = betSize * entryPrice
      // If win: payout = betSize (each share pays $1, we have betSize*entryPrice cost for betSize*entryPrice/entryPrice...
      // Simpler: cost = betSize * entryPrice. If win, payout = betSize. pnl = betSize - cost.
      const cost = bet.size * bet.entryPrice;
      const payout = bet.size; // $1 per share, we bought bet.size shares... no.
      // Let me reconsider: we spend $betSize to buy shares at entryPrice.
      // Shares = betSize / entryPrice. If win, each share pays $1. Payout = betSize / entryPrice.
      // Wait no - on Polymarket, you spend e.g. 50¢ per share. If you win, each share pays $1.
      // So: cost = $betSize total. Shares = betSize / entryPrice. Payout = shares * $1 = betSize / entryPrice.
      const shares = bet.size / bet.entryPrice;
      pnl = shares - bet.size; // payout minus what we originally "spent" ($betSize)
      momentumPortfolio.balance += shares; // get payout
      momentumPortfolio.wins++;
    } else {
      // Lose everything
      pnl = -(bet.size * bet.entryPrice); // already deducted
      // Actually we already deducted betSize * entryPrice from balance. Loss = that amount.
      pnl = -(bet.size * bet.entryPrice);
      momentumPortfolio.losses++;
    }

    momentumPortfolio.totalPnl += pnl;

    const result = {
      ...bet,
      action: 'CLOSE',
      closeBtcPrice,
      refChangePct: refChange.toFixed(4),
      actualOutcome,
      won,
      pnl: pnl.toFixed(2),
      balanceAfter: momentumPortfolio.balance.toFixed(2),
      winrate: ((momentumPortfolio.wins / (momentumPortfolio.wins + momentumPortfolio.losses)) * 100).toFixed(1),
    };

    momentumPortfolio.closedBets.push(result);
    appendJsonl(MOMENTUM_TRADES_FILE, result);

    const emoji = won ? '✅' : '❌';
    console.log(`[MOMENTUM] ${emoji} ${bet.direction} on ${bet.slug} → ${actualOutcome} | PnL: $${pnl.toFixed(2)} | Total PnL: $${momentumPortfolio.totalPnl.toFixed(2)} | Winrate: ${result.winrate}% (${momentumPortfolio.wins}W/${momentumPortfolio.losses}L) | Balance: $${momentumPortfolio.balance.toFixed(2)}`);
    return false;
  });
}

// ─── Late-Snipe Paper Trading Logic ──────────────────────────────────────────
function lateSnipeTrade() {
  if (!btcPrice) return;

  for (const market of activeMarkets) {
    if (market.type !== '5m') continue;
    if (snipeBetted.has(market.slug)) continue;
    if (!market.referencePrice) continue;

    const endTime = new Date(market.endDate).getTime();
    const timeLeft = endTime - Date.now();
    if (timeLeft < SNIPE_MIN_TIME || timeLeft > SNIPE_MAX_TIME) continue;

    // Calculate delta: how far BTC has moved from reference price
    const delta = ((btcPrice - market.referencePrice) / market.referencePrice) * 100;
    const absDelta = Math.abs(delta);
    if (absDelta < SNIPE_MIN_DELTA_PCT) continue;

    const direction = delta > 0 ? 'Up' : 'Down';

    // Get entry price from last-trade-price
    const entryPrice = direction === 'Up'
      ? (market.upLastPrice || market.outcomePrices?.[0] || 0.5)
      : (market.downLastPrice || market.outcomePrices?.[1] || 0.5);

    if (entryPrice < SNIPE_MIN_ENTRY) {
      console.log(`[SNIPE] SKIP ${direction} on ${market.slug} | Entry ${entryPrice.toFixed(3)} < ${SNIPE_MIN_ENTRY} min threshold`);
      continue;
    }

    if (snipePortfolio.balance < SNIPE_BET_SIZE * entryPrice) continue;

    const bet = {
      slug: market.slug,
      type: market.type,
      direction,
      size: SNIPE_BET_SIZE,
      entryTime: Date.now(),
      entryPrice,
      referencePrice: market.referencePrice,
      endDate: market.endDate,
      btcPriceAtEntry: btcPrice,
      deltaPct: delta.toFixed(4),
      timeBeforeEnd: timeLeft,
    };

    snipePortfolio.balance -= SNIPE_BET_SIZE * entryPrice;
    snipePortfolio.openBets.push(bet);
    snipePortfolio.trades++;
    snipeBetted.add(market.slug);

    console.log(`[SNIPE] BET ${direction} on ${market.slug} | Size: $${SNIPE_BET_SIZE} @ ${entryPrice.toFixed(3)} | Delta: ${delta.toFixed(4)}% | TimeLeft: ${(timeLeft/1000).toFixed(0)}s | Balance: $${snipePortfolio.balance.toFixed(2)}`);
    appendJsonl(SNIPE_TRADES_FILE, { ...bet, action: 'OPEN' });
  }
}

function resolveSnipeBets() {
  const now = Date.now();
  snipePortfolio.openBets = snipePortfolio.openBets.filter(bet => {
    const endTime = new Date(bet.endDate).getTime();
    if (now <= endTime + 90000) return true; // not resolved yet

    const closeBtcPrice = btcPrice;
    const refChange = bet.referencePrice && closeBtcPrice
      ? ((closeBtcPrice - bet.referencePrice) / bet.referencePrice) * 100
      : null;

    if (refChange === null) {
      snipePortfolio.balance += bet.size * bet.entryPrice;
      console.log(`[SNIPE] REFUND ${bet.slug} - no reference data`);
      return false;
    }

    const actualOutcome = refChange >= 0 ? 'Up' : 'Down';
    const won = actualOutcome === bet.direction;

    let pnl;
    if (won) {
      const shares = bet.size / bet.entryPrice;
      pnl = shares - bet.size;
      snipePortfolio.balance += shares;
      snipePortfolio.wins++;
    } else {
      pnl = -(bet.size * bet.entryPrice);
      snipePortfolio.losses++;
    }

    snipePortfolio.totalPnl += pnl;

    const result = {
      ...bet,
      action: 'CLOSE',
      closeBtcPrice,
      refChangePct: refChange.toFixed(4),
      actualOutcome,
      won,
      pnl: pnl.toFixed(2),
      balanceAfter: snipePortfolio.balance.toFixed(2),
      winrate: ((snipePortfolio.wins / (snipePortfolio.wins + snipePortfolio.losses)) * 100).toFixed(1),
    };

    snipePortfolio.closedBets.push(result);
    appendJsonl(SNIPE_TRADES_FILE, result);

    const emoji = won ? '✅' : '❌';
    console.log(`[SNIPE] ${emoji} ${bet.direction} on ${bet.slug} → ${actualOutcome} | PnL: $${pnl.toFixed(2)} | Total PnL: $${snipePortfolio.totalPnl.toFixed(2)} | Winrate: ${result.winrate}% (${snipePortfolio.wins}W/${snipePortfolio.losses}L) | Balance: $${snipePortfolio.balance.toFixed(2)}`);
    return false;
  });
}

// ─── Snipe Loop (every 5s - needs to be fast to catch the window) ────────────
async function snipeTradingLoop() {
  while (true) {
    try {
      lateSnipeTrade();
      resolveSnipeBets();
    } catch (e) {
      console.error('[SNIPE] Error:', e.message);
    }
    await sleep(5000);
  }
}

// ─── Momentum Loop (every 15s) ───────────────────────────────────────────────
async function momentumTradingLoop() {
  while (true) {
    try {
      checkMomentumBets();
      resolveMomentumBets();
    } catch (e) {
      console.error('[MOMENTUM] Error:', e.message);
    }
    await sleep(15000);
  }
}

// ─── Market Discovery Loop (every 90s) ───────────────────────────────────────
async function marketDiscoveryLoop() {
  while (true) {
    try {
      const slugEntries = getMarketSlugs();
      const discovered = [];

      for (const entry of slugEntries) {
        const market = await fetchMarket(entry.slug);
        if (market && !market.closed) {
          discovered.push({ ...market, type: entry.type });
        }
      }

      activeMarkets = discovered;
      // Track market opens for historical data
      discovered.forEach(m => trackMarketOpen(m));
      console.log(`[DISCOVERY] Found ${discovered.length} active markets (${discovered.filter(m=>m.type==='5m').length} x 5m, ${discovered.filter(m=>m.type==='15m').length} x 15m)`);
    } catch (e) {
      console.error('[DISCOVERY] Error:', e.message);
    }
    await sleep(MARKET_SCAN_INTERVAL);
  }
}

// ─── Orderbook Refresh Loop (every 30s) ──────────────────────────────────────
async function orderbookLoop() {
  while (true) {
    try {
      for (const market of activeMarkets) {
        try {
          // Skip expired markets
          const endTime = new Date(market.endDate).getTime();
          if (endTime <= Date.now()) continue;

          // Need at least 2 distinct token IDs
          if (market.clobTokenIds.length < 2) {
            console.warn(`[ORDERBOOK] ${market.slug}: fewer than 2 token IDs, skipping`);
            continue;
          }
          const upTokenId = market.clobTokenIds[0];
          const downTokenId = market.clobTokenIds[1];
          if (!upTokenId || !downTokenId) {
            console.warn(`[ORDERBOOK] ${market.slug}: empty token ID, skipping`);
            continue;
          }
          if (upTokenId === downTokenId) {
            console.warn(`[ORDERBOOK] ${market.slug}: duplicate token IDs, skipping`);
            continue;
          }

          const upBook = await fetchOrderbook(upTokenId);
          const downBook = await fetchOrderbook(downTokenId);
          market.upBook = upBook;
          market.downBook = downBook;
          market.arb = calcArbitrage(upBook, downBook, market.outcomePrices);
          market.timeLeft = endTime - Date.now();

          // Auto-trade on arb
          if (market.arb.profitable && market.timeLeft > 30000) {
            executeTrade(market, market.arb);
          }
        } catch (e) {
          console.warn(`[ORDERBOOK] Failed for ${market.slug}: ${e.message}`);
        }
      }

      resolveExpiredPositions();
      // Check for market resolutions and log historical data
      checkMarketResolutions();
      snapshotBtcPrice();
    } catch (e) {
      console.error('[ORDERBOOK] Error:', e.message);
    }
    await sleep(ORDERBOOK_INTERVAL);
  }
}

// ─── Broadcast Loop (every 1s) ───────────────────────────────────────────────
function buildPayload() {
  return JSON.stringify({
    type: 'update',
    data: {
      btcPrice,
      btcHistory: btcHistory.slice(-BTC_HISTORY_MAX),
      markets: activeMarkets
        .filter(m => new Date(m.endDate).getTime() > Date.now())
        .map(m => ({
          slug: m.slug,
          question: m.question,
          endDate: m.endDate,
          outcomePrices: m.outcomePrices || [],
          upLastPrice: m.upLastPrice ?? null,
          downLastPrice: m.downLastPrice ?? null,
          upMid: m.upMid ?? null,
          downMid: m.downMid ?? null,
          upBuy: m.upBuy ?? null,
          upSell: m.upSell ?? null,
          downBuy: m.downBuy ?? null,
          downSell: m.downSell ?? null,
          livePriceTime: m.livePriceTime ?? null,
          upBook: m.upBook || { bestBid: { price: 0, size: 0 }, bestAsk: { price: 0, size: 0 } },
          downBook: m.downBook || { bestBid: { price: 0, size: 0 }, bestAsk: { price: 0, size: 0 } },
          arb: m.arb || { profitable: false, spread: 0, cost: 0, profit: 0 },
          timeLeft: new Date(m.endDate).getTime() - Date.now(),
          type: m.type,
          active: m.active,
          clobTokenIds: m.clobTokenIds,
          referencePrice: m.referencePrice,
        })),
      portfolio: {
        balance: state.balance,
        totalPnl: state.totalPnl,
        tradesCount: state.trades.length,
        openPositions: state.openPositions,
        closedPositions: state.closedPositions.slice(-20),
        recentTrades: state.trades.slice(-20),
        portfolioHistory: state.portfolioHistory.slice(-100),
      },
      momentum: {
        balance: momentumPortfolio.balance,
        totalPnl: momentumPortfolio.totalPnl,
        trades: momentumPortfolio.trades,
        wins: momentumPortfolio.wins,
        losses: momentumPortfolio.losses,
        winrate: momentumPortfolio.wins + momentumPortfolio.losses > 0
          ? ((momentumPortfolio.wins / (momentumPortfolio.wins + momentumPortfolio.losses)) * 100).toFixed(1)
          : 'N/A',
        openBets: momentumPortfolio.openBets,
        recentClosed: momentumPortfolio.closedBets.slice(-20),
        currentMomentum: calcMomentum()?.toFixed(4) || null,
      },
      snipe: {
        balance: snipePortfolio.balance,
        totalPnl: snipePortfolio.totalPnl,
        trades: snipePortfolio.trades,
        wins: snipePortfolio.wins,
        losses: snipePortfolio.losses,
        winrate: snipePortfolio.wins + snipePortfolio.losses > 0
          ? ((snipePortfolio.wins / (snipePortfolio.wins + snipePortfolio.losses)) * 100).toFixed(1)
          : 'N/A',
        openBets: snipePortfolio.openBets,
        recentClosed: snipePortfolio.closedBets.slice(-20),
      },
    },
  });
}

function startBroadcastLoop() {
  setInterval(() => {
    try {
      const payload = buildPayload();
      wss.clients.forEach(client => {
        if (client.readyState === 1) {
          client.send(payload);
        }
      });
    } catch (e) {
      console.error('[BROADCAST] Error:', e.message);
    }
  }, 1000);
}

// ─── Express + WebSocket Server ───────────────────────────────────────────────
const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  next();
});

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime(), btcPrice, marketsCount: activeMarkets.length });
});

app.get('/api/state', (req, res) => {
  res.json(state);
});

app.get('/api/history', (req, res) => {
  try {
    if (!fs.existsSync(HISTORY_FILE)) return res.json({ records: [], count: 0 });
    const lines = fs.readFileSync(HISTORY_FILE, 'utf8').trim().split('\n').filter(Boolean);
    const records = lines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    res.json({ records, count: records.length, tracking: Array.from(trackedMarkets.keys()) });
  } catch (e) { res.json({ error: e.message }); }
});

app.get('/api/momentum', (req, res) => {
  res.json({
    ...momentumPortfolio,
    currentMomentum: calcMomentum(),
    closedBets: momentumPortfolio.closedBets.slice(-50),
  });
});

app.get('/api/snipe', (req, res) => {
  res.json({
    ...snipePortfolio,
    closedBets: snipePortfolio.closedBets.slice(-50),
  });
});

app.post('/api/reset', express.json(), (req, res) => {
  state = defaultState();
  saveState();
  res.json({ status: 'reset' });
});

// Serve frontend static files from out/
app.use(express.static(path.join(__dirname, 'out')));
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  const filePath = path.join(__dirname, 'out', req.path === '/' ? 'index.html' : req.path + '.html');
  if (fs.existsSync(filePath)) return res.sendFile(filePath);
  const indexPath = path.join(__dirname, 'out', 'index.html');
  if (fs.existsSync(indexPath)) return res.sendFile(indexPath);
  next();
});

wss.on('connection', (ws) => {
  console.log('[WS] Client connected');
  try { ws.send(buildPayload()); } catch {}
  ws.on('close', () => console.log('[WS] Client disconnected'));
});

// ─── Start Everything ─────────────────────────────────────────────────────────
process.on('uncaughtException', (err) => {
  console.error('[UNCAUGHT]', err.message, err.stack?.substring(0, 500));
});
process.on('unhandledRejection', (err) => {
  console.error('[UNHANDLED]', err?.message || err);
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`
  ╔══════════════════════════════════════════════╗
  ║  Polymarket BTC Arb Bot v4.0                 ║
  ║  HTTP:  http://localhost:${PORT}               ║
  ║  WS:    ws://localhost:${PORT}                 ║
  ║  BTC:   Binance real-time WebSocket          ║
  ║  Live prices: 1s  | Orderbooks: 60s          ║
  ║  Markets: 30s scan                           ║
  ╚══════════════════════════════════════════════╝
  `);

  // Start all systems
  connectBinance();
  startBroadcastLoop();
  marketDiscoveryLoop();
  // Delay price loops to let market discovery populate first
  setTimeout(() => livePriceLoop(), 8000);
  setTimeout(() => secondaryPriceLoop(), 10000);
  setTimeout(() => orderbookLoop(), 15000);
  setTimeout(() => momentumTradingLoop(), 20000);
  setTimeout(() => snipeTradingLoop(), 22000);
  console.log('[MOMENTUM] Paper trading active - 5m markets, threshold ≥0.05%');
  console.log('[SNIPE] Late-snipe paper trading active - 5m markets, last 10-60s, delta ≥0.03%');
});
