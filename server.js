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

const MARKET_SCAN_INTERVAL = 90000;   // 90s between market discovery
const ORDERBOOK_INTERVAL = 30000;     // 30s between orderbook refreshes
const GAMMA_RATE_LIMIT = 5000;        // 5s between gamma requests
const CLOB_RATE_LIMIT = 2000;         // 2s between clob requests
const BTC_HISTORY_MAX = 300;          // ~5 min of per-second data

// ─── State ────────────────────────────────────────────────────────────────────
let state = loadState();
let btcPrice = null;
let btcHistory = [];       // {time: epoch_ms, price: number}
let activeMarkets = [];    // enriched market objects
let lastGammaReq = 0;
let lastClobReq = 0;

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
  const current15m = Math.floor(now / 900) * 900;
  const prev5m = current5m - 300;
  const prev15m = current15m - 900;

  return [
    { slug: `btc-updown-5m-${current5m}`, type: '5m', ts: current5m },
    { slug: `btc-updown-5m-${prev5m}`, type: '5m', ts: prev5m },
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

// ─── Arb Calc & Paper Trading ─────────────────────────────────────────────────
function calcArbitrage(upBook, downBook) {
  const bestAskUp = upBook.bestAsk.price;
  const bestAskDown = downBook.bestAsk.price;
  if (bestAskUp <= 0 || bestAskDown <= 0) {
    return { profitable: false, spread: 0, cost: 0, profit: 0 };
  }
  const cost = bestAskUp + bestAskDown;
  const spread = (1 - cost) * 100;
  const profitable = spread > MIN_SPREAD_PCT;
  const profit = profitable ? (1 - cost) * TRADE_SIZE : 0;
  return { profitable, spread, cost, profit, bestAskUp, bestAskDown };
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
        if (market.clobTokenIds.length >= 2) {
          const upBook = await fetchOrderbook(market.clobTokenIds[0]);
          const downBook = await fetchOrderbook(market.clobTokenIds[1]);
          market.upBook = upBook;
          market.downBook = downBook;
          market.arb = calcArbitrage(upBook, downBook);
          market.timeLeft = new Date(market.endDate).getTime() - Date.now();

          // Auto-trade on arb
          if (market.arb.profitable && market.timeLeft > 30000) {
            executeTrade(market, market.arb);
          }
        }
      }

      resolveExpiredPositions();
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
      markets: activeMarkets.map(m => ({
        slug: m.slug,
        question: m.question,
        endDate: m.endDate,
        outcomePrices: m.outcomePrices || [],
        upBook: m.upBook || { bestBid: { price: 0, size: 0 }, bestAsk: { price: 0, size: 0 } },
        downBook: m.downBook || { bestBid: { price: 0, size: 0 }, bestAsk: { price: 0, size: 0 } },
        arb: m.arb || { profitable: false, spread: 0, cost: 0, profit: 0 },
        timeLeft: new Date(m.endDate).getTime() - Date.now(),
        type: m.type,
        active: m.active,
        clobTokenIds: m.clobTokenIds,
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
  ║  Polymarket BTC Arb Bot v3.0                 ║
  ║  HTTP:  http://localhost:${PORT}               ║
  ║  WS:    ws://localhost:${PORT}                 ║
  ║  BTC:   Binance real-time WebSocket          ║
  ║  Markets: 90s scan | Orderbooks: 30s scan    ║
  ╚══════════════════════════════════════════════╝
  `);

  // Start all systems
  connectBinance();
  startBroadcastLoop();
  marketDiscoveryLoop();
  // Delay orderbook loop to let market discovery populate first
  setTimeout(() => orderbookLoop(), 10000);
});
