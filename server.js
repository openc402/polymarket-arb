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
const POLYMARKET_WS_URL = 'wss://ws-live-data.polymarket.com/';
const GAMMA_RATE_LIMIT = 5000;        // 5s between gamma requests
const CLOB_RATE_LIMIT = 2000;         // 2s between clob requests
const BTC_HISTORY_MAX = 600;          // ~10 min of per-second data (covers 90s resolution wait)
const HISTORY_FILE = path.join(__dirname, 'data', 'market-history.jsonl');
const BTC_SNAPSHOTS_FILE = path.join(__dirname, 'data', 'btc-snapshots.jsonl');
const PAPER_TRADES_FILE = path.join(__dirname, 'data', 'paper-trades.jsonl');
const MOMENTUM_TRADES_FILE = path.join(__dirname, 'data', 'momentum-trades.jsonl');
const SNIPE_TRADES_FILE = path.join(__dirname, 'data', 'snipe-trades.jsonl');

// ─── Late-Snipe Paper Trading Config ─────────────────────────────────────────
const SNIPE_MIN_TIME = 30000;       // same timing as momentum (30s min)
const SNIPE_MAX_TIME = 240000;      // same timing as momentum (4min max)
const SNIPE_BET_SIZE = 50;          // $50 per bet
const SNIPE_MIN_ENTRY = 0.90;       // STRATEGY B: entry >= 90¢ only (vs momentum's 0.60)
const SNIPE_MIN_DELTA_PCT = 0.03;   // same delta threshold as before

// ─── Momentum Paper Trading Config ───────────────────────────────────────────
const MOMENTUM_THRESHOLD = 0.05;      // minimum momentum % to trigger a bet
const MOMENTUM_TIGHT = 0.10;          // tight momentum for larger bets
const MOMENTUM_BET_STANDARD = 50;     // standard bet size
const MOMENTUM_BET_TIGHT = 100;       // bet size for tight momentum signals
const MOMENTUM_WINDOW_MS = 120000;    // 2 minutes of BTC history for momentum calc
const MOMENTUM_MIN_TIME_LEFT = 30000; // don't bet if <30s left
const MOMENTUM_MAX_TIME_LEFT = 240000; // don't bet if >4min left (want to bet mid-market)
const MOMENTUM_ONLY_5M = false;       // test both 5m and 15m to compare
const MOMENTUM_MIN_ENTRY_PRICE = 0.80; // STRATEGY A: entry >= 80¢

// ─── State ────────────────────────────────────────────────────────────────────
let state = loadState();
let btcPrice = null;
let btcHistory = [];       // {time: epoch_ms, price: number}
let activeMarkets = [];    // enriched market objects
let lastGammaReq = 0;
let lastClobReq = 0;

// ─── Momentum Paper Trading State ────────────────────────────────────────────
let momentumPortfolio = {
  balance: 100,
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
  balance: 100,
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

// ─── Polymarket Live WebSocket (Chainlink BTC + real-time trades) ─────────────
let polyWs = null;
let polyReconnectTimer = null;
let subscribedSlugs = new Set(); // track which event slugs we're subscribed to

function connectPolymarketWS() {
  try {
    if (polyWs) { try { polyWs.close(); } catch {} }
    clearTimeout(polyReconnectTimer);
    subscribedSlugs.clear();

    console.log('[POLY-WS] Connecting to', POLYMARKET_WS_URL);
    polyWs = new WsClient(POLYMARKET_WS_URL);

    polyWs.on('open', () => {
      console.log('[POLY-WS] Connected - subscribing to Chainlink BTC prices');
      // Subscribe to Chainlink BTC/USD price feed (resolution source)
      const btcSub = JSON.stringify({
        action: 'subscribe',
        subscriptions: [{
          topic: 'crypto_prices_chainlink',
          type: 'update',
          filters: JSON.stringify({ symbol: 'btc/usd' }),
        }],
      });
      polyWs.send(btcSub);
      // Subscribe to any currently known market slugs
      resubscribeAllMarkets();
    });

    polyWs.on('message', (raw) => {
      try {
        const msg = raw.toString();
        // Handle non-JSON messages (PING/PONG keepalive)
        if (!msg.startsWith('{') && !msg.startsWith('[')) {
          if (msg === 'PING') {
            try { polyWs.send('PONG'); } catch {}
          }
          return;
        }
        const data = JSON.parse(msg);
        handlePolyMessage(data);
      } catch {}
    });

    polyWs.on('close', () => {
      console.log('[POLY-WS] Disconnected, reconnecting in 5s...');
      subscribedSlugs.clear();
      polyReconnectTimer = setTimeout(connectPolymarketWS, 5000);
    });

    polyWs.on('error', (err) => {
      console.warn('[POLY-WS] WS error:', err.message);
      try { polyWs.close(); } catch {}
    });

    // Send periodic ping to keep alive
    polyWs._keepAlive = setInterval(() => {
      if (polyWs && polyWs.readyState === 1) {
        try { polyWs.send('PING'); } catch {}
      }
    }, 30000);
  } catch (e) {
    console.error('[POLY-WS] Connection failed:', e.message);
    polyReconnectTimer = setTimeout(connectPolymarketWS, 5000);
  }
}

function handlePolyMessage(data) {
  // Chainlink BTC price update
  if (data.topic === 'crypto_prices_chainlink' || data.type === 'crypto_prices_chainlink') {
    const payload = data.payload || data;
    const price = parseFloat(payload.value || payload.price);
    if (!price || isNaN(price)) return;

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
    return;
  }

  // Real-time trade (orders_matched) from activity stream
  if (data.topic === 'activity' || data.type === 'orders_matched') {
    const payload = data.payload || data;
    if (!payload) return;

    const outcome = payload.outcome; // 'Up' or 'Down'
    const side = payload.side;       // 'BUY' or 'SELL'
    const price = parseFloat(payload.price);
    const slug = payload.event_slug || payload.market_slug || data.event_slug;

    if (!outcome || !price || isNaN(price)) return;

    // Update the matching active market's last trade price
    for (const market of activeMarkets) {
      if (market.slug === slug || (slug && market.slug.includes(slug))) {
        if (outcome === 'Up') {
          market.upLastPrice = price;
        } else if (outcome === 'Down') {
          market.downLastPrice = price;
        }
        market.livePriceTime = Date.now();
        break;
      }
    }
    return;
  }
}

// Subscribe to activity stream for a specific event slug
function subscribeToMarketActivity(slug) {
  if (!polyWs || polyWs.readyState !== 1) return;
  if (subscribedSlugs.has(slug)) return;

  const sub = JSON.stringify({
    action: 'subscribe',
    subscriptions: [{
      topic: 'activity',
      type: 'orders_matched',
      filters: JSON.stringify({ event_slug: slug }),
    }],
  });
  polyWs.send(sub);
  subscribedSlugs.add(slug);
  console.log(`[POLY-WS] Subscribed to trades for ${slug}`);
}

// Re-subscribe all active market slugs (after reconnect or market discovery)
function resubscribeAllMarkets() {
  for (const market of activeMarkets) {
    subscribeToMarketActivity(market.slug);
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

// (Live prices + secondary prices now handled by Polymarket WS activity stream)

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

// Find BTC price closest to a target time from btcHistory
function getHistoricalBtcPrice(targetTime) {
  if (btcHistory.length === 0) return null;
  let closest = btcHistory[0];
  let minDiff = Math.abs(targetTime - closest.time);
  for (const entry of btcHistory) {
    const diff = Math.abs(targetTime - entry.time);
    if (diff < minDiff) {
      minDiff = diff;
      closest = entry;
    }
  }
  // Only use if within 5 seconds of target
  if (minDiff <= 5000) return { price: closest.price, source: 'btcHistory', diff: minDiff };
  return null;
}

// Try to get Polymarket resolution via gamma API
async function fetchPolymarketResolution(slug) {
  try {
    const data = await rateLimitedFetch(`${GAMMA_API}/events?slug=${slug}`, 'gamma');
    if (!data || data.length === 0) return null;
    const event = data[0];
    if (!event.markets || event.markets.length === 0) return null;
    const m = event.markets[0];
    if (m.closed || m.resolved) {
      // winner is typically "Up" or "Down"
      return { winner: m.winner, source: 'polymarket' };
    }
    return null;
  } catch (e) {
    console.warn(`[RESOLVE] Failed to fetch Polymarket resolution for ${slug}: ${e.message}`);
    return null;
  }
}

// Get close BTC price: prefer historical price at endTime, then Polymarket resolution, then current price fallback
async function getResolutionPrice(bet) {
  const endTime = new Date(bet.endDate).getTime();

  // 1. Try btcHistory for price at exact market end time
  const historical = getHistoricalBtcPrice(endTime);
  if (historical) {
    console.log(`[RESOLVE] ${bet.slug}: Using btcHistory price $${historical.price} (${historical.diff}ms from endTime)`);
    return { price: historical.price, source: 'btcHistory' };
  }

  // 2. Try Polymarket resolution
  const polyRes = await fetchPolymarketResolution(bet.slug);
  if (polyRes && polyRes.winner) {
    console.log(`[RESOLVE] ${bet.slug}: Using Polymarket resolution → winner: ${polyRes.winner}`);
    return { winner: polyRes.winner, source: 'polymarket' };
  }

  // 3. Fallback to current BTC price
  if (btcPrice) {
    console.log(`[RESOLVE] ${bet.slug}: WARNING using currentPrice (fallback) $${btcPrice}`);
    return { price: btcPrice, source: 'currentPrice (fallback)' };
  }

  return null;
}

function finalizeBet(portfolio, tradesFile, label, bet, actualOutcome, won, closeBtcPrice, resolutionSource) {
  let pnl;
  if (won) {
    const shares = bet.size / bet.entryPrice;
    pnl = shares - bet.size;
    portfolio.balance += shares;
    portfolio.wins++;
  } else {
    pnl = -(bet.size * bet.entryPrice);
    portfolio.losses++;
  }

  portfolio.totalPnl += pnl;

  const refChange = bet.referencePrice && closeBtcPrice
    ? ((closeBtcPrice - bet.referencePrice) / bet.referencePrice) * 100
    : null;

  const result = {
    ...bet,
    action: 'CLOSE',
    closeBtcPrice,
    resolutionSource,
    refChangePct: refChange !== null ? refChange.toFixed(4) : 'N/A',
    actualOutcome,
    won,
    pnl: pnl.toFixed(2),
    balanceAfter: portfolio.balance.toFixed(2),
    winrate: ((portfolio.wins / (portfolio.wins + portfolio.losses)) * 100).toFixed(1),
  };

  portfolio.closedBets.push(result);
  appendJsonl(tradesFile, result);

  const emoji = won ? '✅' : '❌';
  console.log(`[${label}] ${emoji} ${bet.direction} on ${bet.slug} → ${actualOutcome} (via ${resolutionSource}) | PnL: $${pnl.toFixed(2)} | Total PnL: $${portfolio.totalPnl.toFixed(2)} | Winrate: ${result.winrate}% (${portfolio.wins}W/${portfolio.losses}L) | Balance: $${portfolio.balance.toFixed(2)}`);
}

async function resolveWithPrice(portfolio, tradesFile, label, bet) {
  const resolution = await getResolutionPrice(bet);
  if (!resolution) {
    portfolio.balance += bet.size * bet.entryPrice;
    console.log(`[${label}] REFUND ${bet.slug} - no resolution data`);
    return;
  }

  if (resolution.winner) {
    const actualOutcome = resolution.winner;
    const won = actualOutcome === bet.direction;
    finalizeBet(portfolio, tradesFile, label, bet, actualOutcome, won, btcPrice, resolution.source);
    return;
  }

  const closeBtcPrice = resolution.price;
  const refChange = bet.referencePrice && closeBtcPrice
    ? ((closeBtcPrice - bet.referencePrice) / bet.referencePrice) * 100
    : null;

  if (refChange === null) {
    portfolio.balance += bet.size * bet.entryPrice;
    console.log(`[${label}] REFUND ${bet.slug} - no reference data`);
    return;
  }

  const actualOutcome = refChange >= 0 ? 'Up' : 'Down';
  const won = actualOutcome === bet.direction;
  finalizeBet(portfolio, tradesFile, label, bet, actualOutcome, won, closeBtcPrice, resolution.source);
}

function resolveMomentumBets() {
  const now = Date.now();
  const kept = [];
  for (const bet of momentumPortfolio.openBets) {
    const endTime = new Date(bet.endDate).getTime();
    if (now <= endTime + 90000) { kept.push(bet); continue; }
    resolveWithPrice(momentumPortfolio, MOMENTUM_TRADES_FILE, 'MOMENTUM', bet);
  }
  momentumPortfolio.openBets = kept;
}

// ─── Late-Snipe Paper Trading Logic ──────────────────────────────────────────
function lateSnipeTrade() {
  if (!btcPrice) return;

  for (const market of activeMarkets) {
    // Test both 5m and 15m
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
  const kept = [];
  for (const bet of snipePortfolio.openBets) {
    const endTime = new Date(bet.endDate).getTime();
    if (now <= endTime + 90000) { kept.push(bet); continue; }
    resolveWithPrice(snipePortfolio, SNIPE_TRADES_FILE, 'SNIPE', bet);
  }
  snipePortfolio.openBets = kept;
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
      // Subscribe to WS activity for any new market slugs
      resubscribeAllMarkets();
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
  ║  Polymarket BTC Arb Bot v5.0                 ║
  ║  HTTP:  http://localhost:${PORT}               ║
  ║  WS:    ws://localhost:${PORT}                 ║
  ║  BTC:   Polymarket Chainlink (live WS)       ║
  ║  Trades: Polymarket activity stream          ║
  ║  Markets: 30s scan  | Orderbooks: 60s        ║
  ╚══════════════════════════════════════════════╝
  `);

  // Start all systems
  connectPolymarketWS();
  startBroadcastLoop();
  marketDiscoveryLoop();
  // Delay trading/orderbook loops to let market discovery populate first
  setTimeout(() => orderbookLoop(), 15000);
  setTimeout(() => momentumTradingLoop(), 20000);
  setTimeout(() => snipeTradingLoop(), 22000);
  console.log('[MOMENTUM] Paper trading active - 5m markets, threshold ≥0.05%');
  console.log('[SNIPE] Late-snipe paper trading active - 5m markets, last 10-60s, delta ≥0.03%');
});

