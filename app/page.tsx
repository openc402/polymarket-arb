'use client';
import { useEffect, useState } from 'react';
import StatsCard from '@/components/StatsCard';
import { XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, Area, AreaChart } from 'recharts';

const BASE = process.env.NEXT_PUBLIC_BASE_PATH || '';

function SkeletonCard() {
  return (
    <div className="glass-card rounded-2xl p-5 gradient-border">
      <div className="flex items-center justify-between mb-4">
        <div className="skeleton h-3 w-24" />
        <div className="skeleton h-5 w-12 rounded-full" />
      </div>
      <div className="skeleton h-8 w-32 mb-2" />
      <div className="skeleton h-3 w-20" />
    </div>
  );
}

function SkeletonChart() {
  return (
    <div className="glass-card rounded-2xl p-6 gradient-border">
      <div className="skeleton h-5 w-48 mb-6" />
      <div className="skeleton h-[350px] w-full rounded-xl" />
    </div>
  );
}

function CustomTooltip({ active, payload, label }: any) {
  if (!active || !payload?.length) return null;
  return (
    <div className="custom-tooltip">
      <p className="text-[10px] text-gray-500 mb-1">{label ? new Date(label).toLocaleString() : ''}</p>
      <p className="text-sm font-bold text-white">${payload[0].value?.toFixed(2)}</p>
    </div>
  );
}

export default function Overview() {
  const [data, setData] = useState<any>(null);

  const fetchData = () => fetch(`${BASE}/data.json`).then(r => r.json()).then(setData).catch(console.error);

  useEffect(() => {
    fetchData();
    const i = setInterval(fetchData, 30000);
    return () => clearInterval(i);
  }, []);

  if (!data) return (
    <div className="animate-fade-in">
      <div className="flex items-center justify-between mb-8">
        <div>
          <div className="skeleton h-8 w-40 mb-2" />
          <div className="skeleton h-4 w-64" />
        </div>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-5 mb-8">
        {[...Array(4)].map((_, i) => <SkeletonCard key={i} />)}
      </div>
      <SkeletonChart />
    </div>
  );

  const { portfolio, positions, history, lastScan } = data;
  const openPositions = positions?.open?.length || 0;
  const roi = portfolio.initial_balance > 0 ? ((portfolio.total_pnl / portfolio.initial_balance) * 100).toFixed(2) : '0.00';
  const winRate = portfolio.total_trades > 0 ? ((portfolio.winning_trades / portfolio.total_trades) * 100).toFixed(1) : '0';

  const historyValues = (history || []).slice(-20).map((h: any) => h.total_value);
  const pnlSpark = (positions?.closed || []).slice(-12).map((t: any) => t.pnl);

  return (
    <div className="animate-fade-in">
      {/* Header */}
      <div className="flex items-center justify-between mb-8">
        <div>
          <h2 className="text-3xl font-bold text-white tracking-tight">Dashboard</h2>
          <p className="text-sm text-gray-600 mt-1">Real-time portfolio overview</p>
        </div>
        {lastScan && (
          <div className="flex items-center gap-3 glass-card rounded-xl px-4 py-2.5">
            <div className="w-2 h-2 rounded-full bg-profit status-dot" />
            <div>
              <p className="text-[10px] text-gray-500 font-medium">Last scan</p>
              <p className="text-xs text-gray-400">{new Date(lastScan.timestamp).toLocaleTimeString()}</p>
            </div>
            <div className="h-6 w-px bg-white/5" />
            <div>
              <p className="text-[10px] text-gray-500 font-medium">Markets</p>
              <p className="text-xs text-gray-400">{lastScan.markets_scanned}</p>
            </div>
            <div className="h-6 w-px bg-white/5" />
            <div>
              <p className="text-[10px] text-gray-500 font-medium">Found</p>
              <p className="text-xs text-accent font-semibold">{lastScan.opportunities_found}</p>
            </div>
          </div>
        )}
      </div>

      {/* Stats Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-5 mb-8">
        <StatsCard
          title="Portfolio Value"
          value={`$${portfolio.balance.toFixed(2)}`}
          icon={<svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}><path strokeLinecap="round" strokeLinejoin="round" d="M2.25 18.75a60.07 60.07 0 0115.797 2.101c.727.198 1.453-.342 1.453-1.096V18.75M3.75 4.5v.75A.75.75 0 013 6h-.75m0 0v-.375c0-.621.504-1.125 1.125-1.125H20.25M2.25 6v9m18-10.5v.75c0 .414.336.75.75.75h.75m-1.5-1.5h.375c.621 0 1.125.504 1.125 1.125v9.75c0 .621-.504 1.125-1.125 1.125h-.375m1.5-1.5H21a.75.75 0 00-.75.75v.75m0 0H3.75m0 0h-.375a1.125 1.125 0 01-1.125-1.125V15m1.5 1.5v-.75A.75.75 0 003 15h-.75M15 10.5a3 3 0 11-6 0 3 3 0 016 0zm3 0h.008v.008H18V10.5zm-12 0h.008v.008H6V10.5z" /></svg>}
          trend={portfolio.total_pnl >= 0 ? 'up' : 'down'}
          subtitle={`Initial: $${portfolio.initial_balance.toFixed(0)}`}
          sparkData={historyValues}
          delay={50}
        />
        <StatsCard
          title="Total P&L"
          value={`${portfolio.total_pnl >= 0 ? '+' : ''}$${portfolio.total_pnl.toFixed(2)}`}
          icon={<svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}><path strokeLinecap="round" strokeLinejoin="round" d="M2.25 18L9 11.25l4.306 4.307a11.95 11.95 0 015.814-5.519l2.74-1.22m0 0l-5.94-2.28m5.94 2.28l-2.28 5.941" /></svg>}
          trend={portfolio.total_pnl >= 0 ? 'up' : 'down'}
          subtitle={`ROI: ${roi}%`}
          sparkData={pnlSpark}
          delay={100}
        />
        <StatsCard
          title="Active Positions"
          value={openPositions.toString()}
          icon={<svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}><path strokeLinecap="round" strokeLinejoin="round" d="M20.25 14.15v4.25c0 1.094-.787 2.036-1.872 2.18-2.087.277-4.216.42-6.378.42s-4.291-.143-6.378-.42c-1.085-.144-1.872-1.086-1.872-2.18v-4.25m16.5 0a2.18 2.18 0 00.75-1.661V8.706c0-1.081-.768-2.015-1.837-2.175a48.114 48.114 0 00-3.413-.387m4.5 8.006c-.194.165-.42.295-.673.38A23.978 23.978 0 0112 15.75c-2.648 0-5.195-.429-7.577-1.22a2.016 2.016 0 01-.673-.38m0 0A2.18 2.18 0 013 12.489V8.706c0-1.081.768-2.015 1.837-2.175a48.111 48.111 0 013.413-.387m7.5 0V5.25A2.25 2.25 0 0013.5 3h-3a2.25 2.25 0 00-2.25 2.25v.894m7.5 0a48.667 48.667 0 00-7.5 0" /></svg>}
          trend="neutral"
          subtitle={`Total trades: ${portfolio.total_trades}`}
          delay={150}
        />
        <StatsCard
          title="Win Rate"
          value={`${winRate}%`}
          icon={<svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}><path strokeLinecap="round" strokeLinejoin="round" d="M16.5 18.75h-9m9 0a3 3 0 013 3h-15a3 3 0 013-3m9 0v-3.375c0-.621-.503-1.125-1.125-1.125h-.871M7.5 18.75v-3.375c0-.621.504-1.125 1.125-1.125h.872m5.007 0H9.497m5.007 0a7.454 7.454 0 01-.982-3.172M9.497 14.25a7.454 7.454 0 00.981-3.172M5.25 4.236c-.982.143-1.954.317-2.916.52A6.003 6.003 0 007.73 9.728M5.25 4.236V4.5c0 2.108.966 3.99 2.48 5.228M5.25 4.236V2.721C7.456 2.41 9.71 2.25 12 2.25c2.291 0 4.545.16 6.75.47v1.516M18.75 4.236c.982.143 1.954.317 2.916.52A6.003 6.003 0 0016.27 9.728M18.75 4.236V4.5c0 2.108-.966 3.99-2.48 5.228m0 0a6.003 6.003 0 01-5.54 0" /></svg>}
          trend={parseFloat(winRate) > 50 ? 'up' : 'neutral'}
          subtitle={`${portfolio.winning_trades}/${portfolio.total_trades} wins`}
          delay={200}
        />
      </div>

      {/* Portfolio Chart */}
      <div className="glass-card rounded-2xl p-6 gradient-border animate-fade-in-up" style={{ animationDelay: '0.3s', opacity: 0 }}>
        <div className="flex items-center justify-between mb-6">
          <div>
            <h3 className="text-lg font-semibold text-white">Portfolio Value</h3>
            <p className="text-xs text-gray-600 mt-0.5">Historical performance</p>
          </div>
          <div className="flex items-center gap-2">
            <div className="w-2 h-2 rounded-full bg-accent" />
            <span className="text-[10px] text-gray-500 font-medium">Live</span>
          </div>
        </div>
        {history.length > 0 ? (
          <ResponsiveContainer width="100%" height={350}>
            <AreaChart data={history}>
              <defs>
                <linearGradient id="colorValue" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#6366f1" stopOpacity={0.25}/>
                  <stop offset="50%" stopColor="#8b5cf6" stopOpacity={0.1}/>
                  <stop offset="100%" stopColor="#6366f1" stopOpacity={0}/>
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.03)" vertical={false} />
              <XAxis
                dataKey="timestamp"
                tick={{ fill: '#4a5568', fontSize: 10, fontFamily: 'Inter' }}
                tickFormatter={(v) => new Date(v).toLocaleTimeString()}
                axisLine={{ stroke: 'rgba(255,255,255,0.05)' }}
                tickLine={false}
              />
              <YAxis
                tick={{ fill: '#4a5568', fontSize: 10, fontFamily: 'Inter' }}
                domain={['auto', 'auto']}
                tickFormatter={(v) => `$${v.toFixed(0)}`}
                axisLine={false}
                tickLine={false}
                width={60}
              />
              <Tooltip content={<CustomTooltip />} />
              <Area
                type="monotone"
                dataKey="total_value"
                stroke="#6366f1"
                strokeWidth={2.5}
                fill="url(#colorValue)"
                dot={false}
                activeDot={{ r: 5, fill: '#6366f1', stroke: '#050510', strokeWidth: 2 }}
              />
            </AreaChart>
          </ResponsiveContainer>
        ) : (
          <div className="h-[350px] flex items-center justify-center">
            <div className="text-center">
              <div className="w-12 h-12 rounded-2xl bg-accent/10 flex items-center justify-center mx-auto mb-3">
                <svg className="w-6 h-6 text-accent" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M3 13.125C3 12.504 3.504 12 4.125 12h2.25c.621 0 1.125.504 1.125 1.125v6.75C7.5 20.496 6.996 21 6.375 21h-2.25A1.125 1.125 0 013 19.875v-6.75z" />
                </svg>
              </div>
              <p className="text-sm text-gray-500">Waiting for chart data...</p>
              <p className="text-[10px] text-gray-700 mt-1">Run the scanner to start tracking</p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
