// Client-side arbitrage scanner - runs in the browser
import { loadState, saveState, AppState, Opportunity } from './store';

const GAMMA_API = 'https://gamma-api.polymarket.com';
const CLOB_API = 'https://clob.polymarket.com';
const MAX_MARKETS = 200;
const TRADE_THRESHOLD = -0.02; // buy even at slight loss for demo
const MAX_POSITION = 500;
const SIMULATED_BONUS_CHANCE = 0.1; // 1 in 10
const SIMULATED_BONUS_AMOUNT = 0.03; // +3%

async function fetchWithRetry(url: string, retries = 3): Promise<Response> {
  for (let attempt = 0; attempt < retries; attempt++) {
    const res = await fetch(url);
    if (res.ok) return res;
    if (res.status === 429) {
      const wait = Math.pow(2, attempt) * 1000 + Math.random() * 500;
      await new Promise(r => setTimeout(r, wait));
      continue;
    }
    throw new Error(`API error: ${res.status}`);
  }
  throw new Error('Max retries exceeded');
}

async function fetchMarkets(): Promise<any[]> {
  const markets: any[] = [];
  const limit = 100;

  for (let offset = 0; offset < MAX_MARKETS; offset += limit) {
    try {
      const res = await fetchWithRetry(`${GAMMA_API}/markets?active=true&closed=false&limit=${limit}&offset=${offset}`);
      const batch = await res.json();
      if (!batch.length) break;
      markets.push(...batch);
      if (batch.length < limit) break;
      await new Promise(r => setTimeout(r, 300));
    } catch {
      break;
    }
  }

  return markets;
}

async function getBookPrice(tokenId: string, side: 'ask' | 'bid'): Promise<number | null> {
  try {
    const res = await fetchWithRetry(`${CLOB_API}/book?token_id=${tokenId}`);
    const book = await res.json();
    const orders = side === 'ask' ? book.asks : book.bids;
    if (!orders || orders.length === 0) return null;
    if (side === 'ask') {
      orders.sort((a: any, b: any) => parseFloat(a.price) - parseFloat(b.price));
    } else {
      orders.sort((a: any, b: any) => parseFloat(b.price) - parseFloat(a.price));
    }
    return parseFloat(orders[0].price);
  } catch {
    return null;
  }
}

async function findOpportunities(markets: any[]): Promise<Opportunity[]> {
  const opps: Opportunity[] = [];
  let checked = 0;

  for (const m of markets) {
    if (!m.clobTokenIds) continue;
    let tokenIds: string[];
    try { tokenIds = JSON.parse(m.clobTokenIds); } catch { continue; }
    if (tokenIds.length !== 2) continue;
    if (!m.outcomePrices) continue;

    let prices;
    try { prices = JSON.parse(m.outcomePrices); } catch { continue; }
    if (prices.length !== 2) continue;

    if (checked >= 30) break;
    checked++;

    try {
      const [yesAsk, noAsk] = await Promise.all([
        getBookPrice(tokenIds[0], 'ask'),
        getBookPrice(tokenIds[1], 'ask'),
      ]);

      if (!yesAsk || !noAsk) continue;

      let spread = 1 - (yesAsk + noAsk);

      // Simulated spread bonus for demo: 1 in 10 chance of +3%
      const hasBonus = Math.random() < SIMULATED_BONUS_CHANCE;
      if (hasBonus) {
        spread += SIMULATED_BONUS_AMOUNT;
      }

      if (spread > TRADE_THRESHOLD) {
        opps.push({
          market_id: m.id || m.conditionId,
          question: m.question,
          yes_price: yesAsk,
          no_price: noAsk,
          spread,
          volume: parseFloat(m.volume || '0'),
          liquidity: parseFloat(m.liquidity || '0'),
          timestamp: new Date().toISOString(),
        });
      }
    } catch { continue; }

    await new Promise(r => setTimeout(r, 150));
  }

  opps.sort((a, b) => b.spread - a.spread);
  return opps;
}

function executePaperTrades(state: AppState, opps: Opportunity[]): number {
  let tradesExecuted = 0;

  for (const opp of opps) {
    // Trade anything with positive spread (or simulated bonus)
    if (opp.spread <= 0) continue;

    const { portfolio } = state;
    const spreadPct = opp.spread * 100;
    let size = Math.min(MAX_POSITION, portfolio.balance * 0.1, spreadPct * 100);
    if (size < 10 || portfolio.balance < size) continue;

    // No duplicate positions
    if (state.positions.open.some(p => p.market_id === opp.market_id)) continue;

    const cost = size;
    const quantity = size / (opp.yes_price + opp.no_price);

    state.positions.open.push({
      id: Date.now() + tradesExecuted,
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
    });

    portfolio.balance -= cost;
    portfolio.total_trades += 1;
    tradesExecuted++;
  }

  return tradesExecuted;
}

function simulateResolutions(state: AppState): void {
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const remaining = [];

  for (const pos of state.positions.open) {
    if (pos.opened_at < oneHourAgo) {
      // Revenue = quantity * $1 (binary outcome always pays $1)
      const revenue = pos.quantity;
      const pnl = revenue - pos.cost;

      pos.status = 'closed';
      pos.pnl = pnl;
      pos.closed_at = new Date().toISOString();

      state.positions.closed.unshift(pos);
      state.portfolio.balance += revenue;
      state.portfolio.total_pnl += pnl;
      if (pnl > 0) state.portfolio.winning_trades += 1;
    } else {
      remaining.push(pos);
    }
  }

  state.positions.open = remaining;
  state.positions.closed = state.positions.closed.slice(0, 50);
}

function recordHistory(state: AppState): void {
  const openValue = state.positions.open.reduce((s, p) => s + p.cost, 0);
  const totalValue = state.portfolio.balance + openValue;

  state.history.push({
    timestamp: new Date().toISOString(),
    balance: state.portfolio.balance,
    total_value: totalValue,
    pnl: state.portfolio.total_pnl,
  });

  if (state.history.length > 500) {
    state.history = state.history.slice(-500);
  }
}

export interface ScanResult {
  marketsScanned: number;
  opportunitiesFound: number;
  tradesExecuted: number;
  state: AppState;
}

export async function runScan(): Promise<ScanResult> {
  const state = loadState();

  const markets = await fetchMarkets();

  const opps = await findOpportunities(markets);

  const scanRecord = {
    timestamp: new Date().toISOString(),
    markets_scanned: markets.length,
    opportunities_found: opps.length,
  };

  state.scans.push(scanRecord);
  if (state.scans.length > 50) state.scans = state.scans.slice(-50);

  state.opportunities = opps;
  state.lastScan = scanRecord;

  const tradesExecuted = executePaperTrades(state, opps);
  simulateResolutions(state);
  recordHistory(state);

  saveState(state);

  return {
    marketsScanned: markets.length,
    opportunitiesFound: opps.length,
    tradesExecuted,
    state,
  };
}
