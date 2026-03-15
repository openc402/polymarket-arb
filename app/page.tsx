'use client';
import { useEffect, useState, useRef, useCallback } from 'react';
import {
  AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer,
  CartesianGrid, ReferenceLine,
} from 'recharts';

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

interface PricePoint {
  time: string;
  price: number;
  timestamp: number;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────
function formatCountdown(ms: number): string {
  if (ms <= 0) return 'CLOSED';
  const totalSec = Math.floor(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function useCountdown(endDate: string) {
  const [ms, setMs] = useState(() => new Date(endDate).getTime() - Date.now());
  useEffect(() => {
    const i = setInterval(() => setMs(new Date(endDate).getTime() - Date.now()), 1000);
    return () => clearInterval(i);
  }, [endDate]);
  return ms;
}

function useClock() {
  const [now, setNow] = useState(new Date());
  useEffect(() => {
    const i = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(i);
  }, []);
  return now;
}

// ─── Custom Chart Tooltip ────────────────────────────────────────────────────
function ChartTooltip({ active, payload }: any) {
  if (!active || !payload?.[0]) return null;
  const d = payload[0].payload as PricePoint;
  return (
    <div className="custom-tooltip" style={{ background: 'rgba(10,10,25,0.95)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 10, padding: '10px 14px' }}>
      <p style={{ color: '#888', fontSize: 10, marginBottom: 4 }}>{d.time}</p>
      <p style={{ color: '#fff', fontSize: 16, fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>
        ${d.price.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
      </p>
    </div>
  );
}

// ─── Main Terminal ───────────────────────────────────────────────────────────
export default function Terminal() {
  const [portfolio, setPortfolio] = useState<PortfolioState | null>(null);
  const [markets, setMarkets] = useState<Market[]>([]);
  const [btcPrice, setBtcPrice] = useState<number | null>(null);
  const [prevBtcPrice, setPrevBtcPrice] = useState<number | null>(null);
  const [priceHistory, setPriceHistory] = useState<PricePoint[]>([]);
  const [scanCount, setScanCount] = useState(0);
  const [wsStatus, setWsStatus] = useState<'connecting' | 'connected' | 'disconnected'>('connecting');
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout>>();
  const now = useClock();

  const handleMessage = useCallback((msg: WSMessage) => {
    if (msg.state) setPortfolio(msg.state);
    if (msg.markets) setMarkets(msg.markets);
    if (msg.btcPrice != null) {
      setBtcPrice(prev => {
        setPrevBtcPrice(prev);
        return msg.btcPrice!;
      });
      setPriceHistory(prev => {
        const point: PricePoint = {
          time: new Date().toLocaleTimeString(),
          price: msg.btcPrice!,
          timestamp: Date.now(),
        };
        const next = [...prev, point];
        return next.length > 200 ? next.slice(-200) : next;
      });
    }
    if (msg.scanCount !== undefined) setScanCount(msg.scanCount);
  }, []);

  useEffect(() => {
    function connect() {
      setWsStatus('connecting');
      const ws = new WebSocket('ws://localhost:3001');
      wsRef.current = ws;
      ws.onopen = () => setWsStatus('connected');
      ws.onmessage = (e) => {
        try { handleMessage(JSON.parse(e.data)); } catch {}
      };
      ws.onclose = () => {
        setWsStatus('disconnected');
        reconnectTimer.current = setTimeout(connect, 3000);
      };
      ws.onerror = () => ws.close();
    }
    connect();
    return () => { clearTimeout(reconnectTimer.current); wsRef.current?.close(); };
  }, [handleMessage]);

  // Derived
  const markets5m = markets.filter(m => m.type === '5m');
  const markets15m = markets.filter(m => m.type === '15m');
  const priceUp = btcPrice != null && prevBtcPrice != null ? btcPrice >= prevBtcPrice : true;
  const priceChange24h = priceHistory.length >= 2
    ? ((priceHistory[priceHistory.length - 1].price - priceHistory[0].price) / priceHistory[0].price * 100)
    : 0;
  const chartColor = priceUp ? '#00ff88' : '#ff4757';
  const winRate = portfolio
    ? portfolio.closedPositions.length > 0
      ? (portfolio.closedPositions.filter((p: any) => (p.pnl ?? 0) > 0).length / portfolio.closedPositions.length * 100)
      : 0
    : 0;

  // Chart domain
  const prices = priceHistory.map(p => p.price);
  const minPrice = prices.length ? Math.min(...prices) : 0;
  const maxPrice = prices.length ? Math.max(...prices) : 100000;
  const pricePad = (maxPrice - minPrice) * 0.1 || 100;

  const statusDot = wsStatus === 'connected' ? 'bg-[#00ff88]' : wsStatus === 'connecting' ? 'bg-yellow-400 animate-pulse' : 'bg-[#ff4757]';

  return (
    <div className="h-full flex flex-col" style={{ fontFamily: 'system-ui, -apple-system, sans-serif' }}>
      {/* ═══ TOP BAR ═══ */}
      <div className="flex items-center justify-between px-5 py-3 border-b border-white/[0.06]" style={{ background: 'rgba(10,10,25,0.8)', backdropFilter: 'blur(20px)' }}>
        <div className="flex items-center gap-6">
          <div className="flex items-center gap-3">
            <span className="text-xs font-bold tracking-widest text-[#6c5ce7] uppercase">ARB Terminal</span>
            <div className="h-4 w-px bg-white/10" />
          </div>
          {/* BTC Price */}
          <div className="flex items-center gap-3">
            <span className="text-xs text-gray-500 font-semibold">BTC/USD</span>
            <span className={`text-2xl font-bold tabular-nums num-transition ${priceUp ? 'text-[#00ff88]' : 'text-[#ff4757]'}`}
              style={{ textShadow: priceUp ? '0 0 20px rgba(0,255,136,0.4)' : '0 0 20px rgba(255,71,87,0.4)' }}>
              ${btcPrice?.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }) ?? '---'}
            </span>
            {priceHistory.length >= 2 && (
              <span className={`text-sm font-semibold tabular-nums ${priceChange24h >= 0 ? 'text-[#00ff88]' : 'text-[#ff4757]'}`}>
                {priceChange24h >= 0 ? '+' : ''}{priceChange24h.toFixed(2)}%
              </span>
            )}
          </div>
        </div>
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-2 text-xs text-gray-500">
            <span>Scans: <span className="text-gray-300 tabular-nums">{scanCount}</span></span>
          </div>
          <div className="flex items-center gap-2">
            <div className={`w-2 h-2 rounded-full ${statusDot}`} style={wsStatus === 'connected' ? { boxShadow: '0 0 8px rgba(0,255,136,0.6)' } : {}} />
            <span className="text-xs text-gray-500">{wsStatus === 'connected' ? 'Live' : wsStatus === 'connecting' ? 'Connecting...' : 'Offline'}</span>
          </div>
          <div className="h-4 w-px bg-white/10" />
          <span className="text-xs text-gray-500 tabular-nums">{now.toLocaleTimeString()}</span>
        </div>
      </div>

      {/* ═══ MAIN CONTENT ═══ */}
      <div className="flex flex-1 min-h-0">

        {/* ═══ LEFT PANEL (70%) ═══ */}
        <div className="flex flex-col" style={{ width: '70%', borderRight: '1px solid rgba(255,255,255,0.06)' }}>

          {/* ── BTC CHART ── */}
          <div className="flex-1 min-h-0 p-4">
            <div className="h-full rounded-xl overflow-hidden" style={{ background: 'rgba(10,10,25,0.7)', border: '1px solid rgba(255,255,255,0.06)' }}>
              {priceHistory.length < 2 ? (
                <div className="h-full flex items-center justify-center">
                  <div className="text-center">
                    <div className="w-10 h-10 border-2 border-[#6c5ce7]/30 border-t-[#6c5ce7] rounded-full animate-spin mx-auto mb-3" />
                    <p className="text-sm text-gray-500">Waiting for price data...</p>
                  </div>
                </div>
              ) : (
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={priceHistory} margin={{ top: 20, right: 30, bottom: 20, left: 20 }}>
                    <defs>
                      <linearGradient id="priceGrad" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor={chartColor} stopOpacity={0.3} />
                        <stop offset="50%" stopColor={chartColor} stopOpacity={0.1} />
                        <stop offset="100%" stopColor={chartColor} stopOpacity={0} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.04)" />
                    <XAxis
                      dataKey="time"
                      tick={{ fill: '#555', fontSize: 10 }}
                      axisLine={{ stroke: 'rgba(255,255,255,0.06)' }}
                      tickLine={false}
                      interval="preserveStartEnd"
                      minTickGap={60}
                    />
                    <YAxis
                      domain={[minPrice - pricePad, maxPrice + pricePad]}
                      tick={{ fill: '#555', fontSize: 10 }}
                      axisLine={{ stroke: 'rgba(255,255,255,0.06)' }}
                      tickLine={false}
                      tickFormatter={(v: number) => `$${v.toLocaleString()}`}
                      width={80}
                    />
                    <Tooltip content={<ChartTooltip />} />
                    {priceHistory.length > 0 && (
                      <ReferenceLine
                        y={priceHistory[0].price}
                        stroke="rgba(108,92,231,0.3)"
                        strokeDasharray="4 4"
                      />
                    )}
                    <Area
                      type="monotone"
                      dataKey="price"
                      stroke={chartColor}
                      strokeWidth={2}
                      fill="url(#priceGrad)"
                      dot={false}
                      activeDot={{ r: 4, fill: chartColor, stroke: '#050510', strokeWidth: 2 }}
                      isAnimationActive={false}
                    />
                  </AreaChart>
                </ResponsiveContainer>
              )}
            </div>
          </div>

          {/* ── MARKET CARDS (below chart) ── */}
          <div className="px-4 pb-4 grid grid-cols-2 gap-4" style={{ height: '220px', minHeight: '220px' }}>
            {/* 5-min card */}
            <MarketPanel label="5 MIN" color="#3b82f6" markets={markets5m} />
            {/* 15-min card */}
            <MarketPanel label="15 MIN" color="#8b5cf6" markets={markets15m} />
          </div>
        </div>

        {/* ═══ RIGHT PANEL (30%) ═══ */}
        <div className="flex flex-col min-h-0 overflow-y-auto" style={{ width: '30%', background: 'rgba(8,8,20,0.5)' }}>

          {/* ── PORTFOLIO SUMMARY ── */}
          <div className="p-4 border-b border-white/[0.06]">
            <h3 className="text-[10px] font-bold uppercase tracking-widest text-gray-500 mb-3">Portfolio</h3>
            <div className="space-y-3">
              <div className="flex justify-between items-baseline">
                <span className="text-xs text-gray-500">Balance</span>
                <span className="text-lg font-bold text-white tabular-nums">
                  ${portfolio?.balance.toFixed(2) ?? '0.00'}
                </span>
              </div>
              <div className="flex justify-between items-baseline">
                <span className="text-xs text-gray-500">P&L</span>
                <span className={`text-lg font-bold tabular-nums num-transition ${
                  (portfolio?.totalPnl ?? 0) >= 0 ? 'text-[#00ff88]' : 'text-[#ff4757]'
                }`} style={{
                  textShadow: (portfolio?.totalPnl ?? 0) >= 0
                    ? '0 0 16px rgba(0,255,136,0.5)'
                    : '0 0 16px rgba(255,71,87,0.5)'
                }}>
                  {(portfolio?.totalPnl ?? 0) >= 0 ? '+' : ''}{(portfolio?.totalPnl ?? 0).toFixed(2)}
                </span>
              </div>
              <div className="flex justify-between items-baseline">
                <span className="text-xs text-gray-500">Win Rate</span>
                <span className="text-sm font-semibold text-white tabular-nums">{winRate.toFixed(1)}%</span>
              </div>
              <div className="flex justify-between items-baseline">
                <span className="text-xs text-gray-500">Trades</span>
                <span className="text-sm font-semibold text-white tabular-nums">{portfolio?.tradesCount ?? 0}</span>
              </div>
            </div>
          </div>

          {/* ── OPEN POSITIONS ── */}
          <div className="p-4 border-b border-white/[0.06] flex-shrink-0">
            <h3 className="text-[10px] font-bold uppercase tracking-widest text-gray-500 mb-3">
              Open Positions
              {portfolio && portfolio.openPositions.length > 0 && (
                <span className="ml-2 text-[#6c5ce7]">{portfolio.openPositions.length}</span>
              )}
            </h3>
            <div className="space-y-2 max-h-[200px] overflow-y-auto">
              {(!portfolio || portfolio.openPositions.length === 0) ? (
                <p className="text-xs text-gray-600 italic">No open positions</p>
              ) : (
                portfolio.openPositions.map((pos: any, i: number) => {
                  const pnl = pos.pnl ?? pos.unrealizedPnl ?? 0;
                  const isProfit = pnl >= 0;
                  return (
                    <div key={pos.id ?? i} className="flex items-center justify-between py-2 px-3 rounded-lg" style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.04)' }}>
                      <div>
                        <p className="text-xs text-gray-300 font-medium">
                          {(pos.slug ?? pos.market ?? 'Position').replace('btc-updown-', '').slice(0, 18)}
                        </p>
                        <p className="text-[10px] text-gray-600">{pos.side ?? pos.type ?? '--'}</p>
                      </div>
                      <span className={`text-sm font-bold tabular-nums ${isProfit ? 'text-[#00ff88]' : 'text-[#ff4757]'}`}
                        style={{ textShadow: isProfit ? '0 0 10px rgba(0,255,136,0.4)' : '0 0 10px rgba(255,71,87,0.4)' }}>
                        {isProfit ? '+' : ''}{pnl.toFixed(2)}
                      </span>
                    </div>
                  );
                })
              )}
            </div>
          </div>

          {/* ── RECENT CLOSED TRADES ── */}
          <div className="p-4 flex-1 min-h-0">
            <h3 className="text-[10px] font-bold uppercase tracking-widest text-gray-500 mb-3">Recent Trades</h3>
            <div className="space-y-1 overflow-y-auto" style={{ maxHeight: 'calc(100% - 24px)' }}>
              {(!portfolio || portfolio.recentTrades.length === 0) ? (
                <p className="text-xs text-gray-600 italic">No recent trades</p>
              ) : (
                portfolio.recentTrades.slice().reverse().slice(0, 10).map((t: any, i: number) => {
                  const pnl = t.pnl ?? t.profit ?? t.spread ?? 0;
                  const isProfit = pnl >= 0;
                  return (
                    <div key={t.id ?? i} className="flex items-center justify-between py-2 px-3 rounded-lg hover:bg-white/[0.02] transition-colors">
                      <div className="flex items-center gap-2">
                        <div className={`w-1.5 h-1.5 rounded-full ${isProfit ? 'bg-[#00ff88]' : 'bg-[#ff4757]'}`} />
                        <div>
                          <p className="text-xs text-gray-400">
                            {(t.slug ?? t.market ?? '').replace('btc-updown-', '').slice(0, 16)}
                          </p>
                          <p className="text-[10px] text-gray-600 tabular-nums">
                            {t.time ? new Date(t.time).toLocaleTimeString() : '--'}
                          </p>
                        </div>
                      </div>
                      <span className={`text-xs font-bold tabular-nums ${isProfit ? 'text-[#00ff88]' : 'text-[#ff4757]'}`}>
                        {isProfit ? '+' : ''}{pnl.toFixed(3)}
                      </span>
                    </div>
                  );
                })
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Market Panel (inline helper, not a separate file) ───────────────────────
function MarketPanel({ label, color, markets }: { label: string; color: string; markets: Market[] }) {
  const market = markets[0]; // show the most relevant one
  return (
    <div className="rounded-xl p-4 flex flex-col" style={{ background: 'rgba(10,10,25,0.7)', border: '1px solid rgba(255,255,255,0.06)' }}>
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <span className="text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded" style={{ background: `${color}20`, color, border: `1px solid ${color}30` }}>
            {label}
          </span>
          <span className="text-[10px] text-gray-600">BTC Up/Down</span>
        </div>
        {market?.arb.profitable && (
          <span className="text-[10px] font-bold text-[#00ff88] px-2 py-0.5 rounded" style={{ background: 'rgba(0,255,136,0.1)', border: '1px solid rgba(0,255,136,0.2)' }}>
            ARB +{market.arb.spread.toFixed(2)}%
          </span>
        )}
      </div>

      {!market ? (
        <div className="flex-1 flex items-center justify-center">
          <p className="text-xs text-gray-600">No active markets</p>
        </div>
      ) : (
        <MarketContent market={market} />
      )}
    </div>
  );
}

function MarketContent({ market }: { market: Market }) {
  const timeLeft = useCountdown(market.endDate);
  const isUrgent = timeLeft > 0 && timeLeft < 30000;
  const upPct = market.outcomePrices[0] != null ? (market.outcomePrices[0] * 100) : 0;
  const downPct = market.outcomePrices[1] != null ? (market.outcomePrices[1] * 100) : 0;

  return (
    <>
      {/* Countdown */}
      <div className="flex items-center justify-between mb-3">
        <span className={`text-xl font-bold tabular-nums ${
          timeLeft <= 0 ? 'text-gray-600' : isUrgent ? 'text-[#ff4757] animate-pulse-red' : 'text-white'
        }`} style={isUrgent ? { textShadow: '0 0 12px rgba(255,71,87,0.6)' } : {}}>
          {formatCountdown(timeLeft)}
        </span>
        <span className="text-[10px] text-gray-600">{timeLeft > 0 ? 'until close' : 'closed'}</span>
      </div>

      {/* Price bars */}
      <div className="flex gap-3 flex-1">
        <div className="flex-1">
          <div className="flex items-baseline justify-between mb-1">
            <span className="text-[10px] text-gray-500 font-semibold uppercase">Up</span>
            <span className="text-sm font-bold text-[#00ff88] tabular-nums">{upPct.toFixed(1)}%</span>
          </div>
          <div className="h-2 rounded-full overflow-hidden" style={{ background: 'rgba(0,255,136,0.08)' }}>
            <div className="h-full rounded-full transition-all duration-500" style={{ width: `${Math.min(upPct, 100)}%`, background: 'linear-gradient(90deg, #00ff88, #00cc6a)' }} />
          </div>
          <div className="text-[10px] text-gray-600 mt-1 tabular-nums">
            Bid {market.upBook.bestBid.price.toFixed(3)} / Ask {market.upBook.bestAsk.price.toFixed(3)}
          </div>
        </div>
        <div className="flex-1">
          <div className="flex items-baseline justify-between mb-1">
            <span className="text-[10px] text-gray-500 font-semibold uppercase">Down</span>
            <span className="text-sm font-bold text-[#ff4757] tabular-nums">{downPct.toFixed(1)}%</span>
          </div>
          <div className="h-2 rounded-full overflow-hidden" style={{ background: 'rgba(255,71,87,0.08)' }}>
            <div className="h-full rounded-full transition-all duration-500" style={{ width: `${Math.min(downPct, 100)}%`, background: 'linear-gradient(90deg, #ff4757, #cc3a47)' }} />
          </div>
          <div className="text-[10px] text-gray-600 mt-1 tabular-nums">
            Bid {market.downBook.bestBid.price.toFixed(3)} / Ask {market.downBook.bestAsk.price.toFixed(3)}
          </div>
        </div>
      </div>

      {/* Arb spread indicator */}
      {market.arb.cost > 0 && (
        <div className="mt-2 pt-2 border-t border-white/[0.04] flex items-center justify-between">
          <span className="text-[10px] text-gray-600">Combined Cost</span>
          <span className={`text-xs font-bold tabular-nums ${market.arb.cost < 1 ? 'text-[#00ff88]' : 'text-[#ff4757]'}`}>
            {market.arb.cost.toFixed(4)}
          </span>
        </div>
      )}
    </>
  );
}
