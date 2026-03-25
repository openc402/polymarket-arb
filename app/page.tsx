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
  upLastPrice: number | null;
  downLastPrice: number | null;
  upMid: number | null;
  downMid: number | null;
  upBuy: number | null;
  upSell: number | null;
  downBuy: number | null;
  downSell: number | null;
  livePriceTime: number | null;
  upBook: OrderbookSide;
  downBook: OrderbookSide;
  arb: ArbInfo;
  timeLeft: number;
  type: '5m' | '15m';
  active: boolean;
  referencePrice: number | null;
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

interface PricePoint {
  time: string;
  price: number;
  timestamp: number;
}

interface SnipeBet {
  slug: string;
  direction: string;
  size: number;
  entryPrice: number;
  deltaPct: string;
  timeBeforeEnd: number;
  entryTime: number;
  won?: boolean;
  pnl?: string;
  actualOutcome?: string;
}

interface SnipeState {
  balance: number;
  totalPnl: number;
  trades: number;
  wins: number;
  losses: number;
  winrate: string;
  openBets: SnipeBet[];
  recentClosed: SnipeBet[];
}

interface WSMessage {
  type: 'update';
  data: {
    btcPrice: number | null;
    btcHistory: { time: number; price: number }[];
    markets: Market[];
    portfolio: PortfolioState;
    snipe?: SnipeState;
  };
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
  const [snipe, setSnipe] = useState<SnipeState | null>(null);
  const [markets, setMarkets] = useState<Market[]>([]);
  const [btcPrice, setBtcPrice] = useState<number | null>(null);
  const [prevBtcPrice, setPrevBtcPrice] = useState<number | null>(null);
  const [priceHistory, setPriceHistory] = useState<PricePoint[]>([]);
  const [wsStatus, setWsStatus] = useState<'connecting' | 'connected' | 'disconnected'>('connecting');
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout>>();
  const now = useClock();

  const handleMessage = useCallback((msg: WSMessage) => {
    try {
      if (msg.data.portfolio) setPortfolio(msg.data.portfolio);
      if (msg.data.snipe) setSnipe(msg.data.snipe);
      if (msg.data.markets) setMarkets(msg.data.markets);
      if (msg.data.btcPrice != null) {
        setBtcPrice(prev => {
          setPrevBtcPrice(prev);
          return msg.data.btcPrice!;
        });
      }
      // Convert server btcHistory to chart format
      if (msg.data.btcHistory && msg.data.btcHistory.length > 0) {
        setPriceHistory(
          msg.data.btcHistory.map((p: { time: number; price: number }) => ({
            time: new Date(p.time).toLocaleTimeString(),
            price: p.price,
            timestamp: p.time,
          }))
        );
      }
    } catch {}
  }, []);

  useEffect(() => {
    function connect() {
      setWsStatus('connecting');
      const ws = new WebSocket(`ws://${window.location.host}`);
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

  // Derived — filter out expired/closed markets
  const liveMarkets = markets.filter(m => new Date(m.endDate).getTime() > Date.now());
  // Pick the soonest-expiring market per type (the one currently active, not the future one)
  const markets5m = liveMarkets.filter(m => m.type === '5m').sort((a, b) => new Date(a.endDate).getTime() - new Date(b.endDate).getTime()).slice(0, 1);
  const markets15m = liveMarkets.filter(m => m.type === '15m').sort((a, b) => new Date(a.endDate).getTime() - new Date(b.endDate).getTime()).slice(0, 1);
  const priceUp = btcPrice != null && prevBtcPrice != null ? btcPrice >= prevBtcPrice : true;
  const priceChange = priceHistory.length >= 2
    ? ((priceHistory[priceHistory.length - 1].price - priceHistory[0].price) / priceHistory[0].price * 100)
    : 0;
  const chartColor = priceUp ? '#00ff88' : '#ff4757';
  const winRate = portfolio
    ? portfolio.closedPositions.length > 0
      ? (portfolio.closedPositions.filter((p: any) => (p.pnl ?? 0) > 0).length / portfolio.closedPositions.length * 100)
      : 0
    : 0;

  // Chart domain — include reference prices so lines are always visible
  const refPrices = liveMarkets.map(m => m.referencePrice).filter((p): p is number => p != null);
  const allChartPrices = [...priceHistory.map(p => p.price), ...refPrices];
  const minPrice = allChartPrices.length ? Math.min(...allChartPrices) : 0;
  const maxPrice = allChartPrices.length ? Math.max(...allChartPrices) : 100000;
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
              <span className={`text-sm font-semibold tabular-nums ${priceChange >= 0 ? 'text-[#00ff88]' : 'text-[#ff4757]'}`}>
                {priceChange >= 0 ? '+' : ''}{priceChange.toFixed(3)}%
              </span>
            )}
            <span className="text-[10px] text-gray-600 ml-1">Binance</span>
          </div>
        </div>
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-2 text-xs text-gray-500">
            <span>Markets: <span className="text-gray-300 tabular-nums">{markets.length}</span></span>
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
              <div className="px-4 pt-3 pb-1 flex items-center justify-between">
                <span className="text-[10px] font-bold uppercase tracking-wider text-gray-500">BTC/USD — Last 5 min</span>
                <span className="text-[10px] text-gray-600 tabular-nums">{priceHistory.length} data points</span>
              </div>
              {priceHistory.length < 2 ? (
                <div className="h-full flex items-center justify-center pb-10">
                  <div className="text-center">
                    <div className="w-10 h-10 border-2 border-[#6c5ce7]/30 border-t-[#6c5ce7] rounded-full animate-spin mx-auto mb-3" />
                    <p className="text-sm text-gray-500">Connecting to Binance...</p>
                    <p className="text-xs text-gray-600 mt-1">Real-time BTC price stream</p>
                  </div>
                </div>
              ) : (
                <ResponsiveContainer width="100%" height="90%">
                  <AreaChart data={priceHistory} margin={{ top: 10, right: 30, bottom: 20, left: 20 }}>
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
                    {/* Show one reference line per market type — use first live market with a reference price */}
                    {(() => {
                      const ref5m = markets5m.find(m => m.referencePrice != null);
                      return ref5m ? (
                        <ReferenceLine
                          key="ref5m"
                          y={ref5m.referencePrice!}
                          stroke="#00d4ff"
                          strokeDasharray="6 4"
                          strokeWidth={1.5}
                          label={{ value: `5m: $${ref5m.referencePrice!.toLocaleString()}`, position: 'right', fill: '#00d4ff', fontSize: 10, fontWeight: 600 }}
                        />
                      ) : null;
                    })()}
                    {(() => {
                      const ref15m = markets15m.find(m => m.referencePrice != null);
                      return ref15m ? (
                        <ReferenceLine
                          key="ref15m"
                          y={ref15m.referencePrice!}
                          stroke="#ff9f43"
                          strokeDasharray="6 4"
                          strokeWidth={1.5}
                          label={{ value: `15m: $${ref15m.referencePrice!.toLocaleString()}`, position: 'left', fill: '#ff9f43', fontSize: 10, fontWeight: 600 }}
                        />
                      ) : null;
                    })()}
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

          {/* ── MARKET CARDS (5m and 15m side by side) ── */}
          <div className="px-4 pb-4 grid grid-cols-2 gap-4" style={{ height: '220px', minHeight: '220px' }}>
            <MarketPanel label="5 MIN" color="#3b82f6" markets={markets5m} btcPrice={btcPrice} />
            <MarketPanel label="15 MIN" color="#8b5cf6" markets={markets15m} btcPrice={btcPrice} />
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
          <div className="p-4 border-b border-white/[0.06]">
            <h3 className="text-[10px] font-bold uppercase tracking-widest text-gray-500 mb-3">Recent Trades</h3>
            <div className="space-y-1 overflow-y-auto" style={{ maxHeight: '180px' }}>
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

          {/* ── SNIPE STRATEGY ── */}
          <div className="p-4 flex-1 min-h-0">
            <h3 className="text-[10px] font-bold uppercase tracking-widest mb-3" style={{ color: '#ff9f43' }}>
              Snipe Strategy
              <span className="ml-2 text-[10px] font-normal text-gray-600">Last 60s</span>
            </h3>
            {snipe ? (
              <>
                <div className="space-y-2 mb-3">
                  <div className="flex justify-between items-baseline">
                    <span className="text-xs text-gray-500">Balance</span>
                    <span className="text-sm font-bold text-white tabular-nums">${snipe.balance.toFixed(2)}</span>
                  </div>
                  <div className="flex justify-between items-baseline">
                    <span className="text-xs text-gray-500">P&L</span>
                    <span className={`text-sm font-bold tabular-nums ${snipe.totalPnl >= 0 ? 'text-[#00ff88]' : 'text-[#ff4757]'}`}>
                      {snipe.totalPnl >= 0 ? '+' : ''}{snipe.totalPnl.toFixed(2)}
                    </span>
                  </div>
                  <div className="flex justify-between items-baseline">
                    <span className="text-xs text-gray-500">Win Rate</span>
                    <span className="text-xs font-semibold text-white tabular-nums">
                      {snipe.winrate}% ({snipe.wins}W/{snipe.losses}L)
                    </span>
                  </div>
                  <div className="flex justify-between items-baseline">
                    <span className="text-xs text-gray-500">Trades</span>
                    <span className="text-xs font-semibold text-white tabular-nums">{snipe.trades}</span>
                  </div>
                </div>
                {/* Open snipe bets */}
                {snipe.openBets.length > 0 && (
                  <div className="mb-2">
                    <p className="text-[10px] text-gray-600 uppercase tracking-wider mb-1">Open</p>
                    {snipe.openBets.map((b, i) => (
                      <div key={i} className="flex items-center justify-between py-1.5 px-2 rounded-lg mb-1" style={{ background: 'rgba(255,159,67,0.08)', border: '1px solid rgba(255,159,67,0.15)' }}>
                        <div>
                          <span className="text-xs font-semibold" style={{ color: '#ff9f43' }}>{b.direction}</span>
                          <span className="text-[10px] text-gray-500 ml-1">@ {(b.entryPrice * 100).toFixed(0)}c</span>
                        </div>
                        <span className="text-[10px] text-gray-500 tabular-nums">{(b.timeBeforeEnd / 1000).toFixed(0)}s | {b.deltaPct}%</span>
                      </div>
                    ))}
                  </div>
                )}
                {/* Recent closed snipe trades */}
                <div className="space-y-1 overflow-y-auto" style={{ maxHeight: '150px' }}>
                  {snipe.recentClosed.length === 0 ? (
                    <p className="text-xs text-gray-600 italic">No snipe trades yet</p>
                  ) : (
                    snipe.recentClosed.slice().reverse().slice(0, 8).map((t, i) => {
                      const pnl = parseFloat(t.pnl ?? '0');
                      const isProfit = pnl >= 0;
                      return (
                        <div key={i} className="flex items-center justify-between py-1.5 px-2 rounded-lg hover:bg-white/[0.02] transition-colors">
                          <div className="flex items-center gap-2">
                            <div className={`w-1.5 h-1.5 rounded-full ${isProfit ? 'bg-[#00ff88]' : 'bg-[#ff4757]'}`} />
                            <div>
                              <p className="text-[10px] text-gray-400">
                                {t.direction} @ {(t.entryPrice * 100).toFixed(0)}c
                              </p>
                              <p className="text-[9px] text-gray-600 tabular-nums">
                                {(t.timeBeforeEnd / 1000).toFixed(0)}s before | delta {t.deltaPct}%
                              </p>
                            </div>
                          </div>
                          <span className={`text-xs font-bold tabular-nums ${isProfit ? 'text-[#00ff88]' : 'text-[#ff4757]'}`}>
                            {isProfit ? '+' : ''}{pnl.toFixed(2)}
                          </span>
                        </div>
                      );
                    })
                  )}
                </div>
              </>
            ) : (
              <p className="text-xs text-gray-600 italic">Waiting for data...</p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Market Panel ────────────────────────────────────────────────────────────
function MarketPanel({ label, color, markets, btcPrice }: { label: string; color: string; markets: Market[]; btcPrice: number | null }) {
  // Show up to 2 markets
  const market = markets.length > 0 ? markets[0] : null;
  const hasMultiple = markets.length > 1;

  return (
    <div className="rounded-xl p-4 flex flex-col" style={{ background: 'rgba(10,10,25,0.7)', border: '1px solid rgba(255,255,255,0.06)' }}>
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <span className="text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded" style={{ background: `${color}20`, color, border: `1px solid ${color}30` }}>
            {label}
          </span>
          <span className="text-[10px] text-gray-600">BTC Up/Down</span>
          {hasMultiple && (
            <span className="text-[10px] text-gray-600 ml-1">+{markets.length - 1} more</span>
          )}
        </div>
        {market?.arb?.profitable && (
          <span className="text-[10px] font-bold text-[#00ff88] px-2 py-0.5 rounded" style={{ background: 'rgba(0,255,136,0.1)', border: '1px solid rgba(0,255,136,0.2)' }}>
            ARB +{market.arb.spread.toFixed(2)}%
          </span>
        )}
      </div>

      {!market ? (
        <div className="flex-1 flex items-center justify-center">
          <div className="text-center">
            <p className="text-xs text-gray-600">Scanning for markets...</p>
            <p className="text-[10px] text-gray-700 mt-1">Next scan in ~90s</p>
          </div>
        </div>
      ) : (
        <MarketContent market={market} btcPrice={btcPrice} />
      )}
    </div>
  );
}

function MarketContent({ market, btcPrice }: { market: Market; btcPrice: number | null }) {
  const rawTimeLeft = useCountdown(market.endDate);
  const maxDuration = market.type === '5m' ? 300000 : 900000;
  const timeLeft = Math.min(rawTimeLeft, maxDuration);
  const isUrgent = timeLeft > 0 && timeLeft < 30000;

  // Last trade price is the TRUE price — matches what Polymarket displays
  const upLast = market.upLastPrice;
  const downLast = market.downLastPrice;
  const hasLast = upLast != null && downLast != null;

  // Midpoint as fallback
  const upMid = market.upMid;
  const downMid = market.downMid;
  const hasMid = upMid != null && downMid != null;

  // Primary display: last trade price > midpoint > buy price
  const upCents = upLast != null ? upLast * 100 : upMid != null ? upMid * 100 : market.upBuy != null ? market.upBuy * 100 : null;
  const downCents = downLast != null ? downLast * 100 : downMid != null ? downMid * 100 : market.downBuy != null ? market.downBuy * 100 : null;
  const hasPrice = hasLast || hasMid;

  // Direction vs reference price
  const refPrice = market.referencePrice;
  const hasDirection = refPrice != null && btcPrice != null;
  const isUp = hasDirection ? btcPrice! >= refPrice! : null;
  const priceDiff = hasDirection ? btcPrice! - refPrice! : 0;
  const priceDiffPct = hasDirection && refPrice ? (Math.abs(priceDiff) / refPrice * 100) : 0;

  // Proportional bar widths from primary prices
  const upVal = upCents ?? 50;
  const downVal = downCents ?? 50;
  const total = upVal + downVal;
  const upBarPct = total > 0 ? (upVal / total) * 100 : 50;
  const downBarPct = total > 0 ? (downVal / total) * 100 : 50;

  return (
    <>
      {/* Reference price + Current price */}
      {refPrice != null && (
        <div className="mb-2 py-1.5 px-2 rounded-lg" style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.06)' }}>
          <div className="flex items-center justify-between mb-1">
            <span className="text-[10px] text-gray-500 font-semibold">Price to beat</span>
            <span className="text-sm font-bold text-white tabular-nums">
              ${refPrice.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 0 })}
            </span>
          </div>
          {hasDirection && (
            <div className="flex items-center justify-between">
              <span className="text-[10px] text-gray-500 font-semibold">Current</span>
              <span className={`text-sm font-bold tabular-nums ${isUp ? 'text-[#00ff88]' : 'text-[#ff4757]'}`}
                style={{ textShadow: isUp ? '0 0 10px rgba(0,255,136,0.4)' : '0 0 10px rgba(255,71,87,0.4)' }}>
                ${btcPrice!.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 0 })}
                {' '}{isUp ? '▲' : '▼'} ${Math.abs(priceDiff).toFixed(0)} ({priceDiffPct.toFixed(2)}%)
              </span>
            </div>
          )}
        </div>
      )}

      {/* Countdown + mid price */}
      <div className="flex items-center justify-between mb-2">
        <span className={`text-lg font-bold tabular-nums ${
          timeLeft <= 0 ? 'text-gray-600' : isUrgent ? 'text-[#ff4757] animate-pulse-red' : 'text-white'
        }`} style={isUrgent ? { textShadow: '0 0 12px rgba(255,71,87,0.6)' } : {}}>
          {formatCountdown(timeLeft)}
        </span>
        <span className="text-[10px] tabular-nums flex items-center gap-2">
          {hasPrice && <span className="text-[#00ff88] font-bold">LIVE</span>}
          {hasLast && <span className="text-gray-500">Last trade</span>}
          {!hasLast && hasMid && <span className="text-gray-500">Mid: {(upMid! + downMid!).toFixed(3)}</span>}
        </span>
      </div>

      {/* Up / Down prices — last trade price (matches Polymarket) */}
      <div className="flex gap-3 mb-1">
        <div className="flex-1">
          <div className="flex items-baseline justify-between mb-1">
            <span className="text-[10px] text-gray-500 font-semibold uppercase">Up</span>
            <span className="text-xl font-bold text-[#00ff88] tabular-nums"
              style={{ textShadow: '0 0 12px rgba(0,255,136,0.3)' }}>
              {upCents != null ? `${upCents.toFixed(0)}\u00A2` : '\u2014'}
            </span>
          </div>
          {market.upBuy != null && upLast != null && Math.abs(market.upBuy - upLast) > 0.005 && (
            <div className="text-[9px] text-gray-500 tabular-nums">
              Buy {(market.upBuy * 100).toFixed(1)}&cent; / Sell {market.upSell != null ? `${(market.upSell * 100).toFixed(1)}` : '—'}&cent;
            </div>
          )}
        </div>
        <div className="flex-1">
          <div className="flex items-baseline justify-between mb-1">
            <span className="text-[10px] text-gray-500 font-semibold uppercase">Down</span>
            <span className="text-xl font-bold text-[#ff4757] tabular-nums"
              style={{ textShadow: '0 0 12px rgba(255,71,87,0.3)' }}>
              {downCents != null ? `${downCents.toFixed(0)}\u00A2` : '\u2014'}
            </span>
          </div>
          {market.downBuy != null && downLast != null && Math.abs(market.downBuy - downLast) > 0.005 && (
            <div className="text-[9px] text-gray-500 tabular-nums">
              Buy {(market.downBuy * 100).toFixed(1)}&cent; / Sell {market.downSell != null ? `${(market.downSell * 100).toFixed(1)}` : '—'}&cent;
            </div>
          )}
        </div>
      </div>

      {/* Proportional Up vs Down bar */}
      <div className="flex h-2.5 rounded-full overflow-hidden mb-1" style={{ background: 'rgba(255,255,255,0.04)' }}>
        <div className="h-full rounded-l-full transition-all duration-500" style={{ width: `${upBarPct}%`, background: 'linear-gradient(90deg, #00ff88, #00cc6a)' }} />
        <div className="h-full rounded-r-full transition-all duration-500" style={{ width: `${downBarPct}%`, background: 'linear-gradient(90deg, #ff4757, #cc3a47)' }} />
      </div>

      {/* Arb / cost info */}
      {market.arb && market.arb.cost > 0 && (
        <div className="mt-1 pt-1 border-t border-white/[0.04] flex items-center justify-between">
          <span className="text-[10px] text-gray-600">Arb Cost</span>
          <span className={`text-xs font-bold tabular-nums ${market.arb.cost < 1 ? 'text-[#00ff88]' : 'text-[#ff4757]'}`}>
            {market.arb.cost.toFixed(4)} {market.arb.spread > 0 ? `(+${market.arb.spread.toFixed(2)}%)` : ''}
          </span>
        </div>
      )}
    </>
  );
}
