const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const fs = require('fs');
const path = require('path');

// ─── Config ───────────────────────────────────────────────────────────────────
const PORT = 3001;
const DATA_FILE = path.join(__dirname, 'data', 'state.json');
const GAMMA_API = 'https://gamma-api.polymarket.com';
const CLOB_API = 'https://clob.polymarket.com';
const INITIAL_BALANCE = 10000;
const MIN_SPREAD_PCT = 0.5; // Auto-trade when spread > 0.5%
const TRADE_SIZE = 50; // USDC per side per trade
const SCAN_INTERVAL = 5000; // 5 seconds

// Rate limiting: track last request times
let lastGammaRequest = 0;
let lastClobRequest = 0;
const GAMMA_RATE_LIMIT = 2000; // 2 seconds between gamma requests
const CLOB_RATE_LIMIT = 1000; // 1 second between clob requests

// ─── State ────────────────────────────────────────────────────────────────────
let state = loadState();

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
      const raw = fs.readFileSync(DATA_FILE, 'utf8');
      return { ...defaultState(), ...JSON.parse(raw) };
    }
  } catch (e) {
    console.error('Failed to load state:', e.message);
  }
  return defaultState();
}

function saveState() {
  try {
    const dir = path.dirname(DATA_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(DATA_FILE, JSON.stringify(state, null, 2));
  } catch (e) {
    console.error('Failed to save state:', e.message);
  }
}

// ─── Rate-limited fetch ───────────────────────────────────────────────────────
async function fetchWithRateLimit(url, type) {
  const now = Date.now();
  if (type === 'gamma') {
    const wait = GAMMA_RATE_LIMIT - (now - lastGammaRequest);
    if (wait > 0) await sleep(wait);
    lastGammaRequest = Date.now();
  } else if (type === 'clob') {
    const wait = CLOB_RATE_LIMIT - (now - lastClobRequest);
    if (wait > 0) await sleep(wait);
    lastClobRequest = Date.now();
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timeout);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (e) {
    clearTimeout(timeout);
    throw e;
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ─── Market Discovery ─────────────────────────────────────────────────────────
function getCurrentTimestamps() {
  const now = Math.floor(Date.now() / 1000);
  // Current and next windows
  const current5m = Math.floor(now / 300) * 300;
  const current15m = Math.floor(now / 900) * 900;
  return {
    markets5m: [current5m, current5m + 300],
    markets15m: [current15m, current15m + 900],
  };
}

async function fetchMarketBySlug(slug) {
  try {
    const data = await fetchWithRateLimit(
      `${GAMMA_API}/events?slug=${slug}`,
      'gamma'
    );
    if (!data || data.length === 0) return null;
    const event = data[0];
    if (!event.markets || event.markets.length === 0) return null;
    const market = event.markets[0];

    let outcomePrices = [];
    try {
      outcomePrices = JSON.parse(market.outcomePrices || '[]');
    } catch {
      outcomePrices = [];
    }

    let clobTokenIds = [];
    try {
      clobTokenIds = JSON.parse(market.clobTokenIds || '[]');
    } catch {
      clobTokenIds = [];
    }

    return {
      slug,
      conditionId: market.conditionId,
      questionId: market.questionID,
      question: market.question || event.title,
      outcomes: market.outcomes ? JSON.parse(market.outcomes) : ['Up', 'Down'],
      outcomePrices: outcomePrices.map(Number),
      clobTokenIds,
      endDate: market.endDate || event.endDate,
      active: market.active,
      closed: market.closed,
    };
  } catch (e) {
    return null;
  }
}

async function fetchOrderbook(tokenId) {
  try {
    const data = await fetchWithRateLimit(
      `${CLOB_API}/book?token_id=${tokenId}`,
      'clob'
    );
    const bestBid = data.bids && data.bids.length > 0
      ? { price: parseFloat(data.bids[0].price), size: parseFloat(data.bids[0].size) }
      : { price: 0, size: 0 };
    const bestAsk = data.asks && data.asks.length > 0
      ? { price: parseFloat(data.asks[0].price), size: parseFloat(data.asks[0].size) }
      : { price: 0, size: 0 };
    return { bestBid, bestAsk, bids: data.bids || [], asks: data.asks || [] };
  } catch (e) {
    return { bestBid: { price: 0, size: 0 }, bestAsk: { price: 0, size: 0 }, bids: [], asks: [] };
  }
}

async function fetchBtcPrice() {
  try {
    // Use CoinGecko simple price API as a proxy for BTC/USD
    const data = await fetchWithRateLimit(
      'https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd',
      'gamma' // share gamma rate limit bucket
    );
    return data?.bitcoin?.usd || null;
  } catch {
    return null;
  }
}

// ─── Arbitrage Calculation ────────────────────────────────────────────────────
function calcArbitrage(upBook, downBook) {
  const bestAskUp = upBook.bestAsk.price;
  const bestAskDown = downBook.bestAsk.price;

  if (bestAskUp <= 0 || bestAskDown <= 0) {
    return { profitable: false, spread: 0, cost: 0, profit: 0 };
  }

  const cost = bestAskUp + bestAskDown;
  const spread = (1 - cost) * 100; // percentage profit
  const profitable = spread > MIN_SPREAD_PCT;
  const profit = profitable ? (1 - cost) * TRADE_SIZE : 0;

  return { profitable, spread, cost, profit, bestAskUp, bestAskDown };
}

// ─── Trade Execution (Paper) ──────────────────────────────────────────────────
function executeTrade(marketInfo, arb) {
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

  const trade = {
    id: `trade_${Date.now()}`,
    time: Date.now(),
    slug: marketInfo.slug,
    type: 'BUY_BOTH',
    upPrice: arb.bestAskUp,
    downPrice: arb.bestAskDown,
    cost: totalCost,
    size: TRADE_SIZE,
    spread: arb.spread,
  };
  state.trades.push(trade);
  saveState();

  console.log(`[TRADE] ${marketInfo.slug} | Spread: ${arb.spread.toFixed(2)}% | Cost: $${totalCost.toFixed(2)} | Expected: $${position.expectedProfit.toFixed(2)}`);
  return { position, trade };
}

// ─── Position Resolution ──────────────────────────────────────────────────────
function resolveExpiredPositions() {
  const now = Date.now();
  const toResolve = [];

  state.openPositions = state.openPositions.filter(pos => {
    const endTime = new Date(pos.endDate).getTime();
    if (now > endTime + 60000) { // 1 minute after end
      // In arb: buying both sides at < 1.00 guarantees profit
      // One side resolves to 1.00, other to 0.00
      const payout = pos.size; // Always get $TRADE_SIZE back (one side wins)
      const pnl = payout - pos.cost;

      pos.status = 'closed';
      pos.closeTime = now;
      pos.payout = payout;
      pos.pnl = pnl;

      state.balance += payout;
      state.totalPnl += pnl;
      state.closedPositions.push(pos);
      toResolve.push(pos);

      console.log(`[RESOLVE] ${pos.slug} | PnL: $${pnl.toFixed(2)}`);
      return false;
    }
    return true;
  });

  if (toResolve.length > 0) {
    state.portfolioHistory.push({
      time: now,
      value: state.balance + state.openPositions.reduce((sum, p) => sum + p.cost, 0),
    });
    saveState();
  }
}

// ─── Express + WebSocket Server ───────────────────────────────────────────────
const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// CORS for frontend
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  next();
});

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime() });
});

app.get('/api/state', (req, res) => {
  res.json(state);
});

app.post('/api/reset', express.json(), (req, res) => {
  state = defaultState();
  saveState();
  broadcastState();
  res.json({ status: 'reset' });
});

// ─── WebSocket Broadcasting ───────────────────────────────────────────────────
function broadcastState(extra = {}) {
  const payload = JSON.stringify({
    type: 'update',
    timestamp: Date.now(),
    state: {
      balance: state.balance,
      totalPnl: state.totalPnl,
      tradesCount: state.trades.length,
      openPositions: state.openPositions,
      closedPositions: state.closedPositions.slice(-20),
      recentTrades: state.trades.slice(-20),
      portfolioHistory: state.portfolioHistory.slice(-100),
    },
    ...extra,
  });

  wss.clients.forEach(client => {
    if (client.readyState === 1) {
      client.send(payload);
    }
  });
}

wss.on('connection', (ws) => {
  console.log('[WS] Client connected');
  // Send current state immediately
  ws.send(JSON.stringify({
    type: 'init',
    timestamp: Date.now(),
    state: {
      balance: state.balance,
      totalPnl: state.totalPnl,
      tradesCount: state.trades.length,
      openPositions: state.openPositions,
      closedPositions: state.closedPositions.slice(-20),
      recentTrades: state.trades.slice(-20),
      portfolioHistory: state.portfolioHistory.slice(-100),
    },
  }));

  ws.on('close', () => console.log('[WS] Client disconnected'));
});

// ─── Main Scanner Loop ────────────────────────────────────────────────────────
let scanCount = 0;
let currentMarkets = {};
let btcPrice = null;

async function scanOnce() {
  scanCount++;
  const timestamps = getCurrentTimestamps();
  const slugs = [
    ...timestamps.markets5m.map(ts => `btc-updown-5m-${ts}`),
    ...timestamps.markets15m.map(ts => `btc-updown-15m-${ts}`),
  ];

  const markets = {};
  const arbSignals = [];

  // Fetch markets sequentially to respect rate limits
  for (const slug of slugs) {
    const market = await fetchMarketBySlug(slug);
    if (!market || market.closed) continue;

    // Fetch orderbooks for up and down
    let upBook = { bestBid: { price: 0, size: 0 }, bestAsk: { price: 0, size: 0 }, bids: [], asks: [] };
    let downBook = { bestBid: { price: 0, size: 0 }, bestAsk: { price: 0, size: 0 }, bids: [], asks: [] };

    if (market.clobTokenIds.length >= 2) {
      upBook = await fetchOrderbook(market.clobTokenIds[0]);
      downBook = await fetchOrderbook(market.clobTokenIds[1]);
    }

    const arb = calcArbitrage(upBook, downBook);
    const timeLeft = new Date(market.endDate).getTime() - Date.now();

    const marketData = {
      ...market,
      upBook,
      downBook,
      arb,
      timeLeft,
      type: slug.includes('5m') ? '5m' : '15m',
    };

    markets[slug] = marketData;

    if (arb.profitable && timeLeft > 30000) { // At least 30s before close
      arbSignals.push(marketData);
      // Auto-execute trade
      const result = executeTrade(market, arb);
      if (result) {
        console.log(`[ARB] Auto-traded ${slug} at ${arb.spread.toFixed(2)}% spread`);
      }
    }
  }

  currentMarkets = markets;

  // Fetch BTC price every 3rd scan to save rate limit
  if (scanCount % 3 === 1) {
    btcPrice = await fetchBtcPrice();
  }

  // Resolve expired positions
  resolveExpiredPositions();

  // Update portfolio history periodically
  if (scanCount % 6 === 0) {
    const totalValue = state.balance + state.openPositions.reduce((sum, p) => sum + p.cost, 0);
    state.portfolioHistory.push({ time: Date.now(), value: totalValue });
    saveState();
  }

  // Broadcast to all connected clients
  broadcastState({
    markets: Object.values(currentMarkets),
    btcPrice,
    scanCount,
    arbSignals: arbSignals.map(m => ({
      slug: m.slug,
      spread: m.arb.spread,
      type: m.type,
    })),
  });

  const marketCount = Object.keys(markets).length;
  const arbCount = arbSignals.length;
  console.log(`[SCAN #${scanCount}] Markets: ${marketCount} | Arb signals: ${arbCount} | Balance: $${state.balance.toFixed(2)} | BTC: $${btcPrice || '?'}`);
}

async function startScanner() {
  console.log('Starting scanner...');
  while (true) {
    try {
      await scanOnce();
    } catch (e) {
      console.error('[SCAN ERROR]', e.message);
    }
    await sleep(SCAN_INTERVAL);
  }
}

// ─── Start ────────────────────────────────────────────────────────────────────
server.listen(PORT, () => {
  console.log(`
  ╔══════════════════════════════════════════════╗
  ║  Polymarket BTC Arb Bot - Backend Server     ║
  ║  HTTP:  http://localhost:${PORT}               ║
  ║  WS:    ws://localhost:${PORT}                 ║
  ║  Balance: $${state.balance.toFixed(2).padEnd(10)}                  ║
  ╚══════════════════════════════════════════════╝
  `);
  startScanner();
});
