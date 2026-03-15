const fs = require('fs');
const path = require('path');

const GAMMA_API = 'https://gamma-api.polymarket.com';
const SCAN_INTERVAL = 30_000;
const MIN_SPREAD = -0.05;
const MAX_POSITION = 500;
const DATA_FILE = path.join(__dirname, 'public', 'data.json');

function loadData() {
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch {
    return {
      portfolio: { balance: 10000, initial_balance: 10000, total_trades: 0, winning_trades: 0, total_pnl: 0 },
      positions: { open: [], closed: [] },
      history: [],
      scans: [],
      opportunities: [],
      lastScan: null,
    };
  }
}

function saveData(data) {
  const dir = path.dirname(DATA_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

async function fetchMarkets() {
  const markets = [];
  let offset = 0;
  const limit = 100;

  while (true) {
    const url = `${GAMMA_API}/markets?active=true&closed=false&limit=${limit}&offset=${offset}`;
    const res = await fetch(url);
    if (!res.ok) { console.error(`API error: ${res.status}`); break; }
    const batch = await res.json();
    if (!batch.length) break;
    markets.push(...batch);
    offset += limit;
    if (batch.length < limit) break;
    await new Promise(r => setTimeout(r, 200));
  }

  return markets;
}

function parseOutcomePrices(market) {
  try {
    if (market.outcomePrices) {
      const prices = JSON.parse(market.outcomePrices);
      if (prices.length === 2) {
        return { yes: parseFloat(prices[0]), no: parseFloat(prices[1]) };
      }
    }
  } catch {}
  return null;
}

async function getBookPrice(tokenId, side) {
  try {
    const res = await fetch(`https://clob.polymarket.com/book?token_id=${tokenId}`);
    if (!res.ok) return null;
    const book = await res.json();
    const orders = side === 'ask' ? book.asks : book.bids;
    if (!orders || orders.length === 0) return null;
    if (side === 'ask') {
      orders.sort((a, b) => parseFloat(a.price) - parseFloat(b.price));
    } else {
      orders.sort((a, b) => parseFloat(b.price) - parseFloat(a.price));
    }
    return parseFloat(orders[0].price);
  } catch { return null; }
}

async function findOpportunities(markets) {
  const opps = [];
  let checked = 0;

  for (const m of markets) {
    if (!m.clobTokenIds) continue;
    let tokenIds;
    try { tokenIds = JSON.parse(m.clobTokenIds); } catch { continue; }
    if (tokenIds.length !== 2) continue;

    const mid = parseOutcomePrices(m);
    if (!mid) continue;

    if (checked >= 50) break;
    checked++;

    const [yesAsk, noAsk] = await Promise.all([
      getBookPrice(tokenIds[0], 'ask'),
      getBookPrice(tokenIds[1], 'ask')
    ]);

    if (!yesAsk || !noAsk) continue;

    const total = yesAsk + noAsk;
    const spread = 1 - total;

    if (spread > MIN_SPREAD) {
      opps.push({
        market_id: m.id || m.conditionId,
        question: m.question,
        yes_price: yesAsk,
        no_price: noAsk,
        spread,
        volume: parseFloat(m.volume || 0),
        liquidity: parseFloat(m.liquidity || 0),
        timestamp: new Date().toISOString(),
      });
    }

    await new Promise(r => setTimeout(r, 100));
  }

  opps.sort((a, b) => b.spread - a.spread);
  return opps;
}

function executePaperTrade(data, opp) {
  const { portfolio } = data;

  const spreadPct = opp.spread * 100;
  let size = Math.min(MAX_POSITION, portfolio.balance * 0.1, spreadPct * 100);
  if (size < 10 || portfolio.balance < size) return null;

  const cost = size;
  const quantity = size / (opp.yes_price + opp.no_price);

  // Check for duplicate
  if (data.positions.open.some(p => p.market_id === opp.market_id)) return null;

  const position = {
    id: Date.now(),
    market_id: opp.market_id,
    question: opp.question,
    yes_price: opp.yes_price,
    no_price: opp.no_price,
    spread: opp.spread,
    quantity,
    cost,
    status: 'open',
    pnl: 0,
    opened_at: new Date().toISOString(),
    closed_at: null,
  };

  data.positions.open.push(position);
  portfolio.balance -= cost;
  portfolio.total_trades += 1;

  console.log(`  📈 TRADE: "${opp.question.substring(0, 60)}..." | Spread: ${(opp.spread * 100).toFixed(2)}% | Size: $${cost.toFixed(2)}`);
  return { cost };
}

function simulateResolutions(data) {
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const toClose = [];
  const remaining = [];

  for (const pos of data.positions.open) {
    if (pos.opened_at < oneHourAgo) {
      toClose.push(pos);
    } else {
      remaining.push(pos);
    }
  }

  for (const pos of toClose) {
    const revenue = pos.quantity;
    const pnl = revenue - pos.cost;

    pos.status = 'closed';
    pos.pnl = pnl;
    pos.closed_at = new Date().toISOString();

    data.positions.closed.unshift(pos);
    data.portfolio.balance += revenue;
    data.portfolio.total_pnl += pnl;
    if (pnl > 0) data.portfolio.winning_trades += 1;

    console.log(`  ✅ RESOLVED: "${pos.question.substring(0, 50)}..." | P&L: $${pnl.toFixed(2)}`);
  }

  data.positions.open = remaining;
  // Keep only last 50 closed
  data.positions.closed = data.positions.closed.slice(0, 50);
}

function recordHistory(data) {
  const openValue = data.positions.open.reduce((s, p) => s + p.cost, 0);
  const totalValue = data.portfolio.balance + openValue;

  data.history.push({
    timestamp: new Date().toISOString(),
    balance: data.portfolio.balance,
    total_value: totalValue,
    pnl: data.portfolio.total_pnl,
  });

  // Keep last 500 history entries
  if (data.history.length > 500) {
    data.history = data.history.slice(-500);
  }
}

async function scan() {
  const data = loadData();
  const startTime = Date.now();

  console.log(`\n🔍 [${new Date().toISOString()}] Scanning Polymarket...`);

  try {
    const markets = await fetchMarkets();
    console.log(`  Found ${markets.length} active markets`);

    console.log(`  Checking orderbooks for up to 50 markets...`);

    const opps = await findOpportunities(markets);
    console.log(`  Found ${opps.length} arbitrage opportunities (spread > ${MIN_SPREAD * 100}%)`);

    const scanRecord = {
      timestamp: new Date().toISOString(),
      markets_scanned: markets.length,
      opportunities_found: opps.length,
    };

    data.scans.push(scanRecord);
    // Keep last 50 scans
    if (data.scans.length > 50) data.scans = data.scans.slice(-50);

    data.opportunities = opps;
    data.lastScan = scanRecord;

    // Execute paper trades
    for (const opp of opps) {
      if (opp.spread > 0.005) {
        executePaperTrade(data, opp);
      }
    }

    simulateResolutions(data);
    recordHistory(data);

    // Print top opportunities
    if (opps.length > 0) {
      console.log('\n  Top opportunities:');
      for (const opp of opps.slice(0, 5)) {
        console.log(`    ${(opp.spread * 100).toFixed(2)}% | Yes: $${opp.yes_price.toFixed(3)} + No: $${opp.no_price.toFixed(3)} | "${opp.question.substring(0, 70)}"`);
      }
    }

    console.log(`\n  💰 Portfolio: $${data.portfolio.balance.toFixed(2)} | P&L: $${data.portfolio.total_pnl.toFixed(2)} | Trades: ${data.portfolio.total_trades}`);

    saveData(data);
  } catch (err) {
    console.error(`  Error: ${err.message}`);
  }

  const elapsed = Date.now() - startTime;
  console.log(`  Scan completed in ${elapsed}ms`);
}

// Main loop
console.log('🚀 Polymarket Arbitrage Scanner');
console.log(`  Scan interval: ${SCAN_INTERVAL / 1000}s`);
console.log(`  Min spread: ${MIN_SPREAD * 100}%`);
console.log(`  Max position: $${MAX_POSITION}`);
console.log(`  Data file: ${DATA_FILE}`);

scan();
setInterval(scan, SCAN_INTERVAL);
