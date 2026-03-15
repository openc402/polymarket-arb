'use client';
import { useEffect, useState } from 'react';
import { XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, AreaChart, Area, BarChart, Bar } from 'recharts';

const BASE = process.env.NEXT_PUBLIC_BASE_PATH || '';

function StatBox({ label, value, color = 'text-white', icon }: { label: string; value: string; color?: string; icon: React.ReactNode }) {
  return (
    <div className="glass-card rounded-2xl p-5 gradient-border hover-lift">
      <div className="flex items-center gap-2 mb-3">
        <span className="text-gray-600">{icon}</span>
        <p className="text-[10px] font-semibold text-gray-500 uppercase tracking-wider">{label}</p>
      </div>
      <p className={`text-2xl font-bold ${color} tracking-tight`}>{value}</p>
    </div>
  );
}

function CustomTooltipPnl({ active, payload, label }: any) {
  if (!active || !payload?.length) return null;
  return (
    <div className="custom-tooltip">
      <p className="text-[10px] text-gray-500 mb-1">{label ? new Date(label).toLocaleDateString() : ''}</p>
      <p className={`text-sm font-bold ${payload[0].value >= 0 ? 'text-profit' : 'text-loss'}`}>
        {payload[0].value >= 0 ? '+' : ''}${payload[0].value?.toFixed(2)}
      </p>
    </div>
  );
}

function CustomTooltipScans({ active, payload, label }: any) {
  if (!active || !payload?.length) return null;
  return (
    <div className="custom-tooltip">
      <p className="text-[10px] text-gray-500 mb-1">{label ? new Date(label).toLocaleTimeString() : ''}</p>
      <p className="text-sm font-bold text-accent">{payload[0].value} opportunities</p>
    </div>
  );
}

export default function History() {
  const [data, setData] = useState<any>(null);

  useEffect(() => {
    fetch(`${BASE}/data.json`).then(r => r.json()).then(setData).catch(console.error);
  }, []);

  const trades = data?.positions?.closed || [];
  const scans = data?.scans || [];

  let cumPnl = 0;
  const pnlData = [...trades].reverse().map((t: any) => {
    cumPnl += t.pnl;
    return { date: t.closed_at, pnl: cumPnl, tradePnl: t.pnl };
  });

  const avgSpread = trades.length > 0
    ? (trades.reduce((s: number, t: any) => s + t.spread, 0) / trades.length * 100).toFixed(2)
    : '0';

  const isLoading = !data;

  return (
    <div className="animate-fade-in">
      {/* Header */}
      <div className="mb-8">
        <h2 className="text-3xl font-bold text-white tracking-tight">Trading History</h2>
        <p className="text-sm text-gray-600 mt-1">Performance analytics and scan activity</p>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-5 mb-8">
        {isLoading ? (
          [...Array(3)].map((_, i) => (
            <div key={i} className="glass-card rounded-2xl p-5 gradient-border">
              <div className="skeleton h-3 w-24 mb-3" />
              <div className="skeleton h-8 w-20" />
            </div>
          ))
        ) : (
          <>
            <StatBox
              label="Total Trades"
              value={trades.length.toString()}
              icon={<svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}><path strokeLinecap="round" strokeLinejoin="round" d="M7.5 21L3 16.5m0 0L7.5 12M3 16.5h13.5m0-13.5L21 7.5m0 0L16.5 12M21 7.5H7.5" /></svg>}
            />
            <StatBox
              label="Avg Spread Captured"
              value={`${avgSpread}%`}
              color="text-accent glow-accent"
              icon={<svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}><path strokeLinecap="round" strokeLinejoin="round" d="M3.75 3v11.25A2.25 2.25 0 006 16.5h2.25M3.75 3h-1.5m1.5 0h16.5m0 0h1.5m-1.5 0v11.25A2.25 2.25 0 0118 16.5h-2.25m-7.5 0h7.5m-7.5 0l-1 3m8.5-3l1 3m0 0l.5 1.5m-.5-1.5h-9.5m0 0l-.5 1.5" /></svg>}
            />
            <StatBox
              label="Total Scans"
              value={scans.length.toString()}
              icon={<svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}><path strokeLinecap="round" strokeLinejoin="round" d="M7.5 14.25v2.25m3-4.5v4.5m3-6.75v6.75m3-9v9M6 20.25h12A2.25 2.25 0 0020.25 18V6A2.25 2.25 0 0018 3.75H6A2.25 2.25 0 003.75 6v12A2.25 2.25 0 006 20.25z" /></svg>}
            />
          </>
        )}
      </div>

      {/* Cumulative P&L Chart */}
      <div className="glass-card rounded-2xl p-6 gradient-border mb-6 animate-fade-in-up" style={{ animationDelay: '0.2s', opacity: 0 }}>
        <div className="flex items-center justify-between mb-6">
          <div>
            <h3 className="text-lg font-semibold text-white">Cumulative P&L</h3>
            <p className="text-xs text-gray-600 mt-0.5">Profit and loss over time</p>
          </div>
          {pnlData.length > 0 && (
            <span className={`text-sm font-bold px-3 py-1.5 rounded-xl ${
              cumPnl >= 0 ? 'text-profit bg-profit/10' : 'text-loss bg-loss/10'
            }`}>
              {cumPnl >= 0 ? '+' : ''}${cumPnl.toFixed(2)}
            </span>
          )}
        </div>
        {isLoading ? (
          <div className="skeleton h-[300px] w-full rounded-xl" />
        ) : pnlData.length > 0 ? (
          <ResponsiveContainer width="100%" height={300}>
            <AreaChart data={pnlData}>
              <defs>
                <linearGradient id="colorPnl" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#00ff88" stopOpacity={0.2}/>
                  <stop offset="100%" stopColor="#00ff88" stopOpacity={0}/>
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.03)" vertical={false} />
              <XAxis
                dataKey="date"
                tick={{ fill: '#4a5568', fontSize: 10, fontFamily: 'Inter' }}
                tickFormatter={(v) => v ? new Date(v).toLocaleDateString() : ''}
                axisLine={{ stroke: 'rgba(255,255,255,0.05)' }}
                tickLine={false}
              />
              <YAxis
                tick={{ fill: '#4a5568', fontSize: 10, fontFamily: 'Inter' }}
                tickFormatter={(v) => `$${v.toFixed(0)}`}
                axisLine={false}
                tickLine={false}
                width={50}
              />
              <Tooltip content={<CustomTooltipPnl />} />
              <Area
                type="monotone"
                dataKey="pnl"
                stroke="#00ff88"
                strokeWidth={2.5}
                fill="url(#colorPnl)"
                dot={false}
                activeDot={{ r: 5, fill: '#00ff88', stroke: '#050510', strokeWidth: 2 }}
              />
            </AreaChart>
          </ResponsiveContainer>
        ) : (
          <div className="h-[300px] flex items-center justify-center">
            <div className="text-center">
              <div className="w-10 h-10 rounded-2xl bg-white/[0.03] flex items-center justify-center mx-auto mb-3">
                <svg className="w-5 h-5 text-gray-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 18L9 11.25l4.306 4.307a11.95 11.95 0 015.814-5.519l2.74-1.22" />
                </svg>
              </div>
              <p className="text-sm text-gray-600">No closed trades yet</p>
            </div>
          </div>
        )}
      </div>

      {/* Scan Activity Chart */}
      <div className="glass-card rounded-2xl p-6 gradient-border animate-fade-in-up" style={{ animationDelay: '0.35s', opacity: 0 }}>
        <div className="flex items-center justify-between mb-6">
          <div>
            <h3 className="text-lg font-semibold text-white">Scan Activity</h3>
            <p className="text-xs text-gray-600 mt-0.5">Opportunities found per scan</p>
          </div>
          {scans.length > 0 && (
            <span className="text-xs text-gray-500 font-medium">{scans.length} scans total</span>
          )}
        </div>
        {isLoading ? (
          <div className="skeleton h-[200px] w-full rounded-xl" />
        ) : scans.length > 0 ? (
          <ResponsiveContainer width="100%" height={200}>
            <BarChart data={scans}>
              <defs>
                <linearGradient id="colorBar" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#6366f1" stopOpacity={0.8}/>
                  <stop offset="100%" stopColor="#8b5cf6" stopOpacity={0.3}/>
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
                axisLine={false}
                tickLine={false}
                width={30}
              />
              <Tooltip content={<CustomTooltipScans />} />
              <Bar
                dataKey="opportunities_found"
                fill="url(#colorBar)"
                radius={[6, 6, 0, 0]}
                name="Opportunities"
              />
            </BarChart>
          </ResponsiveContainer>
        ) : (
          <div className="h-[200px] flex items-center justify-center">
            <div className="text-center">
              <div className="w-10 h-10 rounded-2xl bg-white/[0.03] flex items-center justify-center mx-auto mb-3">
                <svg className="w-5 h-5 text-gray-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M7.5 14.25v2.25m3-4.5v4.5m3-6.75v6.75m3-9v9" />
                </svg>
              </div>
              <p className="text-sm text-gray-600">Waiting for scan data...</p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
