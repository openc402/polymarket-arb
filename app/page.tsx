'use client';
import { useEffect, useState, useRef, useCallback } from 'react';

// ─── Types ───────────────────────────────────────────────────────────────────
interface OrderbookSide {
  bestBid: { price: number; size: number };
  bestAsk: { price: number; size: number };
}

interface ArbInfo {
  profitable: boolean;
  spread: number;
  cost: number;
  profit: number;
  bestAskUp?: number;
  bestAskDown?: number;
}

interface Market {
  slug: string;
  question: string;
  endDate: string;
  outcomePrices: number[];
  upBook: OrderbookSide;
  downBook: OrderbookSide;
  arb: ArbInfo;
  timeLeft: number;
  type: '5m' | '15m';
  active: boolean;
}

interface PortfolioState {
  balance: number;
  totalPnl: number;
  tradesCount: number;
  openPositions: any[];
  closedPositions: any[];
  recentTrades: any[];
  portfolioHistory: { time: number; value: number }[];
}

interface WSMessage {
  type: 'update' | 'init';
  timestamp: number;
  state: PortfolioState;
  markets?: Market[];
  btcPrice?: number | null;
  scanCount?: number;
  arbSignals?: { slug: string; spread: number; type: string }[];
}

// ─── Helpers ─────────────────────────────────────────────────────────────────
function formatCountdown(ms: number): string {
  if (ms <= 0) return 'CLOSED';
  const totalSec = Math.floor(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function formatPrice(p: number): string {
  if (!p || p === 0) return '--';
  return p.toFixed(3);
}

// ─── Countdown Hook ──────────────────────────────────────────────────────────
function useCountdown(endDate: string) {
  const [ms, setMs] = useState(() => new Date(endDate).getTime() - Date.now());
  useEffect(() => {
    const i = setInterval(() => {
      setMs(new Date(endDate).getTime() - Date.now());
    }, 1000);
    return () => clearInterval(i);
  }, [endDate]);
  return ms;
}

// ─── Market Card ─────────────────────────────────────────────────────────────
function MarketCard({ market }: { market: Market }) {
  const timeLeft = useCountdown(market.endDate);
  const isUrgent = timeLeft > 0 && timeLeft < 60000;
  const isProfitable = market.arb.profitable;

  const upBid = market.upBook.bestBid.price;
  const upAsk = market.upBook.bestAsk.price;
  const downBid = market.downBook.bestBid.price;
  const downAsk = market.downBook.bestAsk.price;
  const upSpread = upAsk > 0 && upBid > 0 ? ((upAsk - upBid) / upAsk * 100) : 0;
  const downSpread = downAsk > 0 && downBid > 0 ? ((downAsk - downBid) / downAsk * 100) : 0;

  return (
    <div className={`glass-card rounded-2xl p-5 gradient-border hover-lift ${
      isProfitable ? 'glow-box-profit' : ''
    }`}>
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <span className={`inline-flex items-center px-2.5 py-1 rounded-lg text-[10px] font-bold uppercase tracking-wider ${
            market.type === '5m'
              ? 'bg-blue-500/15 text-blue-400 border border-blue-500/20'
              : 'bg-violet-500/15 text-violet-400 border border-violet-500/20'
          }`}>
            {market.type}
          </span>
          <span className="text-[10px] text-gray-600 font-medium">BTC Up/Down</span>
        </div>
        {/* Arb Signal */}
        <div className={`flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-[10px] font-bold ${
          isProfitable
            ? 'bg-green-500/15 text-green-400 border border-green-500/20'
            : 'bg-red-500/10 text-red-400/60 border border-red-500/10'
        }`}>
          <div className={`w-2 h-2 rounded-full ${
            isProfitable ? 'bg-green-400 status-dot' : 'bg-red-400/50'
          }`} />
          {isProfitable ? `+${market.arb.spread.toFixed(2)}%` : 'NO ARB'}
        </div>
      </div>

      {/* Countdown */}
      <div className="flex items-center justify-between mb-4">
        <div className={`text-2xl font-bold tracking-tight tabular-nums ${
          timeLeft <= 0 ? 'text-gray-600' : isUrgent ? 'text-loss glow-loss' : 'text-white'
        }`}>
          {formatCountdown(timeLeft)}
        </div>
        <span className="text-[10px] text-gray-600">
          {timeLeft > 0 ? 'until close' : 'market closed'}
        </span>
      </div>

      {/* Up/Down Prices */}
      <div className="grid grid-cols-2 gap-3 mb-4">
        <div className="bg-green-500/5 border border-green-500/10 rounded-xl p-3">
          <div className="text-[10px] text-gray-500 font-semibold uppercase tracking-wider mb-1.5">Up</div>
          <div className="flex items-baseline gap-2">
            <span className="text-lg font-bold text-green-400 tabular-nums">
              {market.outcomePrices[0] != null ? (market.outcomePrices[0] * 100).toFixed(1) : '--'}
            </span>
            <span className="text-[10px] text-gray-600">%</span>
          </div>
        </div>
        <div className="bg-red-500/5 border border-red-500/10 rounded-xl p-3">
          <div className="text-[10px] text-gray-500 font-semibold uppercase tracking-wider mb-1.5">Down</div>
          <div className="flex items-baseline gap-2">
            <span className="text-lg font-bold text-red-400 tabular-nums">
              {market.outcomePrices[1] != null ? (market.outcomePrices[1] * 100).toFixed(1) : '--'}
            </span>
            <span className="text-[10px] text-gray-600">%</span>
          </div>
        </div>
      </div>

      {/* Bid/Ask Spread Visualization */}
      <div className="space-y-2">
        <div className="flex items-center justify-between text-[10px] text-gray-500 font-semibold uppercase tracking-wider">
          <span>Bid / Ask Spread</span>
        </div>
        {/* Up spread bar */}
        <div className="space-y-1">
          <div className="flex items-center justify-between text-[10px]">
            <span className="text-gray-500">Up</span>
            <span className="text-gray-400 tabular-nums">
              {formatPrice(upBid)} / {formatPrice(upAsk)}
              <span className="text-gray-600 ml-1">({upSpread.toFixed(1)}%)</span>
            </span>
          </div>
          <div className="h-1.5 bg-white/5 rounded-full overflow-hidden">
            <div className="h-full rounded-full bg-gradient-to-r from-green-500/60 to-green-400/40 transition-all duration-500"
              style={{ width: `${Math.min(Math.max(upBid * 100, 0), 100)}%` }} />
          </div>
        </div>
        {/* Down spread bar */}
        <div className="space-y-1">
          <div className="flex items-center justify-between text-[10px]">
            <span className="text-gray-500">Down</span>
            <span className="text-gray-400 tabular-nums">
              {formatPrice(downBid)} / {formatPrice(downAsk)}
              <span className="text-gray-600 ml-1">({downSpread.toFixed(1)}%)</span>
            </span>
          </div>
          <div className="h-1.5 bg-white/5 rounded-full overflow-hidden">
            <div className="h-full rounded-full bg-gradient-to-r from-red-500/60 to-red-400/40 transition-all duration-500"
              style={{ width: `${Math.min(Math.max(downBid * 100, 0), 100)}%` }} />
          </div>
        </div>
      </div>

      {/* Arb cost line */}
      {market.arb.cost > 0 && (
        <div className="mt-3 pt-3 border-t border-white/5 flex items-center justify-between text-[10px]">
          <span className="text-gray-600">Combined Ask Cost</span>
          <span className={`font-bold tabular-nums ${market.arb.cost < 1 ? 'text-green-400' : 'text-red-400'}`}>
            {market.arb.cost.toFixed(4)}
            {market.arb.cost < 1 && <span className="text-green-400/60 ml-1">(&lt;1.00)</span>}
          </span>
        </div>
      )}
    </div>
  );
}

// ─── Portfolio Stats Bar ─────────────────────────────────────────────────────
function PortfolioBar({ portfolio }: { portfolio: PortfolioState }) {
  const pnlPositive = portfolio.totalPnl >= 0;
  return (
    <div className="glass-card rounded-2xl p-5 gradient-border">
      <div className="flex items-center gap-2 mb-4">
        <div className="w-8 h-8 rounded-xl bg-accent/10 flex items-center justify-center">
          <svg className="w-4 h-4 text-accent" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 18.75a60.07 60.07 0 0115.797 2.101c.727.198 1.453-.342 1.453-1.096V18.75M3.75 4.5v.75A.75.75 0 013 6h-.75m0 0v-.375c0-.621.504-1.125 1.125-1.125H20.25M2.25 6v9m18-10.5v.75c0 .414.336.75.75.75h.75m-1.5-1.5h.375c.621 0 1.125.504 1.125 1.125v9.75c0 .621-.504 1.125-1.125 1.125h-.375m1.5-1.5H21a.75.75 0 00-.75.75v.75m0 0H3.75m0 0h-.375a1.125 1.125 0 01-1.125-1.125V15m1.5 1.5v-.75A.75.75 0 003 15h-.75M15 10.5a3 3 0 11-6 0 3 3 0 016 0zm3 0h.008v.008H18V10.5zm-12 0h.008v.008H6V10.5z" />
          </svg>
        </div>
        <div>
          <h3 className="text-sm font-semibold text-white">Portfolio</h3>
          <p className="text-[10px] text-gray-600">Live paper trading stats</p>
        </div>
      </div>
      <div className="grid grid-cols-3 gap-4">
        <div>
          <p className="text-[10px] text-gray-500 font-semibold uppercase tracking-wider mb-1">Balance</p>
          <p className="text-xl font-bold text-white tabular-nums">${portfolio.balance.toFixed(2)}</p>
        </div>
        <div>
          <p className="text-[10px] text-gray-500 font-semibold uppercase tracking-wider mb-1">Total P&L</p>
          <p className={`text-xl font-bold tabular-nums ${pnlPositive ? 'text-green-400 glow-profit' : 'text-red-400 glow-loss'}`}>
            {pnlPositive ? '+' : ''}{portfolio.totalPnl.toFixed(2)}
          </p>
        </div>
        <div>
          <p className="text-[10px] text-gray-500 font-semibold uppercase tracking-wider mb-1">Trades</p>
          <p className="text-xl font-bold text-white tabular-nums">{portfolio.tradesCount}</p>
        </div>
      </div>
      {/* Open positions count */}
      {portfolio.openPositions.length > 0 && (
        <div className="mt-4 pt-3 border-t border-white/5 flex items-center gap-2">
          <div className="w-2 h-2 rounded-full bg-accent animate-pulse" />
          <span className="text-[10px] text-gray-400">
            {portfolio.openPositions.length} open position{portfolio.openPositions.length !== 1 ? 's' : ''}
          </span>
        </div>
      )}
    </div>
  );
}

// ─── Connection Status Badge ─────────────────────────────────────────────────
function ConnectionBadge({ status }: { status: 'connecting' | 'connected' | 'disconnected' }) {
  const cfg = {
    connecting: { color: 'text-yellow-400', bg: 'bg-yellow-400/10 border-yellow-400/20', dot: 'bg-yellow-400 animate-pulse', label: 'Connecting...' },
    connected: { color: 'text-green-400', bg: 'bg-green-400/10 border-green-400/20', dot: 'bg-green-400 status-dot', label: 'Live' },
    disconnected: { color: 'text-red-400', bg: 'bg-red-400/10 border-red-400/20', dot: 'bg-red-400', label: 'Disconnected' },
  }[status];

  return (
    <div className={`flex items-center gap-2 px-3 py-1.5 rounded-lg border text-[10px] font-semibold ${cfg.bg} ${cfg.color}`}>
      <div className={`w-2 h-2 rounded-full ${cfg.dot}`} />
      {cfg.label}
    </div>
  );
}

// ─── Main Page ───────────────────────────────────────────────────────────────
export default function Overview() {
  const [portfolio, setPortfolio] = useState<PortfolioState | null>(null);
  const [markets, setMarkets] = useState<Market[]>([]);
  const [btcPrice, setBtcPrice] = useState<number | null>(null);
  const [scanCount, setScanCount] = useState(0);
  const [arbSignals, setArbSignals] = useState<{ slug: string; spread: number; type: string }[]>([]);
  const [wsStatus, setWsStatus] = useState<'connecting' | 'connected' | 'disconnected'>('connecting');
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout>>();

  const handleMessage = useCallback((msg: WSMessage) => {
    if (msg.state) setPortfolio(msg.state);
    if (msg.markets) setMarkets(msg.markets);
    if (msg.btcPrice !== undefined) setBtcPrice(msg.btcPrice);
    if (msg.scanCount !== undefined) setScanCount(msg.scanCount);
    if (msg.arbSignals) setArbSignals(msg.arbSignals);
  }, []);

  useEffect(() => {
    function connect() {
      setWsStatus('connecting');
      const ws = new WebSocket('ws://localhost:3001');
      wsRef.current = ws;

      ws.onopen = () => setWsStatus('connected');

      ws.onmessage = (e) => {
        try {
          const msg: WSMessage = JSON.parse(e.data);
          handleMessage(msg);
        } catch { /* ignore parse errors */ }
      };

      ws.onclose = () => {
        setWsStatus('disconnected');
        // Reconnect after 3 seconds
        reconnectTimer.current = setTimeout(connect, 3000);
      };

      ws.onerror = () => {
        ws.close();
      };
    }

    connect();

    return () => {
      clearTimeout(reconnectTimer.current);
      wsRef.current?.close();
    };
  }, [handleMessage]);

  // Separate markets by type
  const markets5m = markets.filter(m => m.type === '5m');
  const markets15m = markets.filter(m => m.type === '15m');
  const activeArbs = arbSignals.length;

  return (
    <div className="animate-fade-in">
      {/* Header */}
      <div className="flex items-center justify-between mb-8">
        <div>
          <h2 className="text-3xl font-bold text-white tracking-tight">Dashboard</h2>
          <p className="text-sm text-gray-600 mt-1">BTC Up/Down arbitrage scanner</p>
        </div>
        <div className="flex items-center gap-3">
          <ConnectionBadge status={wsStatus} />
          {btcPrice && (
            <div className="glass-card rounded-xl px-4 py-2 flex items-center gap-2">
              <span className="text-[10px] text-gray-500 font-semibold uppercase">BTC</span>
              <span className="text-sm font-bold text-white tabular-nums">
                ${btcPrice.toLocaleString()}
              </span>
            </div>
          )}
          {scanCount > 0 && (
            <div className="glass-card rounded-xl px-4 py-2 flex items-center gap-3">
              <div>
                <p className="text-[10px] text-gray-500 font-medium">Scans</p>
                <p className="text-xs text-gray-400 tabular-nums">{scanCount}</p>
              </div>
              <div className="h-6 w-px bg-white/5" />
              <div>
                <p className="text-[10px] text-gray-500 font-medium">Arb Signals</p>
                <p className={`text-xs font-semibold tabular-nums ${activeArbs > 0 ? 'text-green-400' : 'text-gray-500'}`}>
                  {activeArbs}
                </p>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Portfolio Stats */}
      {portfolio && (
        <div className="mb-8">
          <PortfolioBar portfolio={portfolio} />
        </div>
      )}

      {/* Markets */}
      {markets.length === 0 && wsStatus === 'connected' && (
        <div className="glass-card rounded-2xl p-12 text-center gradient-border">
          <div className="w-12 h-12 rounded-2xl bg-accent/10 flex items-center justify-center mx-auto mb-4">
            <div className="w-5 h-5 border-2 border-accent/30 border-t-accent rounded-full animate-spin" />
          </div>
          <p className="text-sm text-gray-400">Waiting for market data...</p>
          <p className="text-[10px] text-gray-600 mt-1">Server is scanning Polymarket for BTC Up/Down markets</p>
        </div>
      )}

      {markets.length === 0 && wsStatus !== 'connected' && (
        <div className="glass-card rounded-2xl p-12 text-center gradient-border">
          <div className="w-12 h-12 rounded-2xl bg-red-500/10 flex items-center justify-center mx-auto mb-4">
            <svg className="w-6 h-6 text-red-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z" />
            </svg>
          </div>
          <p className="text-sm text-gray-400">Cannot connect to server</p>
          <p className="text-[10px] text-gray-600 mt-1">Make sure the backend is running: <code className="text-accent">npm run server</code></p>
        </div>
      )}

      {/* 5-minute Markets */}
      {markets5m.length > 0 && (
        <div className="mb-8">
          <div className="flex items-center gap-2 mb-4">
            <span className="inline-flex items-center px-2.5 py-1 rounded-lg text-[10px] font-bold uppercase tracking-wider bg-blue-500/15 text-blue-400 border border-blue-500/20">5m</span>
            <h3 className="text-lg font-semibold text-white">5-Minute Markets</h3>
            <span className="text-xs text-gray-600">({markets5m.length})</span>
          </div>
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
            {markets5m.map(m => <MarketCard key={m.slug} market={m} />)}
          </div>
        </div>
      )}

      {/* 15-minute Markets */}
      {markets15m.length > 0 && (
        <div className="mb-8">
          <div className="flex items-center gap-2 mb-4">
            <span className="inline-flex items-center px-2.5 py-1 rounded-lg text-[10px] font-bold uppercase tracking-wider bg-violet-500/15 text-violet-400 border border-violet-500/20">15m</span>
            <h3 className="text-lg font-semibold text-white">15-Minute Markets</h3>
            <span className="text-xs text-gray-600">({markets15m.length})</span>
          </div>
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
            {markets15m.map(m => <MarketCard key={m.slug} market={m} />)}
          </div>
        </div>
      )}

      {/* Recent Trades */}
      {portfolio && portfolio.recentTrades.length > 0 && (
        <div className="glass-card rounded-2xl p-6 gradient-border">
          <h3 className="text-lg font-semibold text-white mb-4">Recent Trades</h3>
          <div className="overflow-x-auto">
            <table className="w-full pro-table">
              <thead>
                <tr className="text-[10px] text-gray-500 font-semibold uppercase tracking-wider">
                  <th className="text-left py-3 px-4">Time</th>
                  <th className="text-left py-3 px-4">Market</th>
                  <th className="text-right py-3 px-4">Up Ask</th>
                  <th className="text-right py-3 px-4">Down Ask</th>
                  <th className="text-right py-3 px-4">Spread</th>
                  <th className="text-right py-3 px-4">Cost</th>
                </tr>
              </thead>
              <tbody>
                {portfolio.recentTrades.slice().reverse().slice(0, 10).map((t: any) => (
                  <tr key={t.id} className="border-t border-white/5">
                    <td className="py-3 px-4 text-xs text-gray-400 tabular-nums">
                      {new Date(t.time).toLocaleTimeString()}
                    </td>
                    <td className="py-3 px-4 text-xs text-gray-300 font-medium">
                      {t.slug.replace('btc-updown-', '').slice(0, 20)}
                    </td>
                    <td className="py-3 px-4 text-xs text-green-400 text-right tabular-nums">
                      {t.upPrice?.toFixed(3) ?? '--'}
                    </td>
                    <td className="py-3 px-4 text-xs text-red-400 text-right tabular-nums">
                      {t.downPrice?.toFixed(3) ?? '--'}
                    </td>
                    <td className="py-3 px-4 text-xs text-accent text-right tabular-nums font-semibold">
                      {t.spread?.toFixed(2)}%
                    </td>
                    <td className="py-3 px-4 text-xs text-gray-300 text-right tabular-nums">
                      ${t.cost?.toFixed(2)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
