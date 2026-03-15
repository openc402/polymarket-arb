'use client';
import { useEffect, useState } from 'react';

const BASE = process.env.NEXT_PUBLIC_BASE_PATH || '';

function SkeletonRow({ cols }: { cols: number }) {
  return (
    <tr className="border-b border-white/[0.03]">
      {[...Array(cols)].map((_, i) => (
        <td key={i} className="px-6 py-4"><div className="skeleton h-4 w-20 ml-auto first:ml-0" /></td>
      ))}
    </tr>
  );
}

export default function Positions() {
  const [data, setData] = useState<any>(null);

  const fetchData = () => fetch(`${BASE}/data.json`).then(r => r.json()).then(setData).catch(console.error);

  useEffect(() => {
    fetchData();
    const i = setInterval(fetchData, 30000);
    return () => clearInterval(i);
  }, []);

  const open = data?.positions?.open || [];
  const closed = data?.positions?.closed || [];
  const isLoading = !data;

  return (
    <div className="animate-fade-in">
      {/* Header */}
      <div className="flex items-center justify-between mb-8">
        <div>
          <h2 className="text-3xl font-bold text-white tracking-tight">Positions</h2>
          <p className="text-sm text-gray-600 mt-1">Open and closed arbitrage positions</p>
        </div>
        <div className="flex items-center gap-3">
          <div className="glass-card rounded-xl px-4 py-2 flex items-center gap-2">
            <div className="w-2 h-2 rounded-full bg-profit status-dot" />
            <span className="text-xs text-gray-400 font-medium">{open.length} open</span>
          </div>
          <div className="glass-card rounded-xl px-4 py-2 flex items-center gap-2">
            <div className="w-2 h-2 rounded-full bg-gray-600" />
            <span className="text-xs text-gray-400 font-medium">{closed.length} closed</span>
          </div>
        </div>
      </div>

      {/* Open Positions */}
      <div className="mb-10">
        <div className="flex items-center gap-3 mb-4">
          <div className="w-8 h-8 rounded-xl bg-profit/10 flex items-center justify-center">
            <div className="w-2.5 h-2.5 rounded-full bg-profit status-dot" />
          </div>
          <div>
            <h3 className="text-base font-semibold text-white">Open Positions</h3>
            <p className="text-[10px] text-gray-600">{open.length} active trades</p>
          </div>
        </div>
        <div className="glass-table rounded-2xl overflow-hidden">
          <table className="w-full pro-table">
            <thead>
              <tr className="border-b border-white/[0.05]">
                <th className="text-left text-[10px] font-semibold text-gray-500 uppercase tracking-wider px-6 py-4">Market</th>
                <th className="text-right text-[10px] font-semibold text-gray-500 uppercase tracking-wider px-6 py-4">Yes Price</th>
                <th className="text-right text-[10px] font-semibold text-gray-500 uppercase tracking-wider px-6 py-4">No Price</th>
                <th className="text-right text-[10px] font-semibold text-gray-500 uppercase tracking-wider px-6 py-4">Spread</th>
                <th className="text-right text-[10px] font-semibold text-gray-500 uppercase tracking-wider px-6 py-4">Cost</th>
                <th className="text-right text-[10px] font-semibold text-gray-500 uppercase tracking-wider px-6 py-4">Opened</th>
              </tr>
            </thead>
            <tbody>
              {isLoading ? (
                [...Array(3)].map((_, i) => <SkeletonRow key={i} cols={6} />)
              ) : open.length === 0 ? (
                <tr>
                  <td colSpan={6} className="text-center py-12">
                    <div className="w-10 h-10 rounded-2xl bg-white/[0.03] flex items-center justify-center mx-auto mb-3">
                      <svg className="w-5 h-5 text-gray-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M20.25 7.5l-.625 10.632a2.25 2.25 0 01-2.247 2.118H6.622a2.25 2.25 0 01-2.247-2.118L3.75 7.5m6 4.125l2.25 2.25m0 0l2.25 2.25M12 13.875l2.25-2.25M12 13.875l-2.25 2.25M3.375 7.5h17.25c.621 0 1.125-.504 1.125-1.125v-1.5c0-.621-.504-1.125-1.125-1.125H3.375c-.621 0-1.125.504-1.125 1.125v1.5c0 .621.504 1.125 1.125 1.125z" />
                      </svg>
                    </div>
                    <p className="text-sm text-gray-600">No open positions</p>
                  </td>
                </tr>
              ) : open.map((pos: any, i: number) => (
                <tr
                  key={pos.id}
                  className="border-b border-white/[0.03] animate-fade-in-up"
                  style={{ animationDelay: `${i * 50}ms`, opacity: 0 }}
                >
                  <td className="px-6 py-4">
                    <div className="flex items-center gap-2">
                      <div className="w-1.5 h-1.5 rounded-full bg-profit animate-pulse flex-shrink-0" />
                      <p className="text-sm text-gray-300 font-medium">{pos.question.substring(0, 70)}</p>
                    </div>
                  </td>
                  <td className="text-right px-6 py-4 text-sm font-mono text-profit font-medium">${pos.yes_price.toFixed(3)}</td>
                  <td className="text-right px-6 py-4 text-sm font-mono text-loss font-medium">${pos.no_price.toFixed(3)}</td>
                  <td className="text-right px-6 py-4">
                    <span className="text-xs font-bold text-accent bg-accent/10 px-2.5 py-1 rounded-lg">{(pos.spread * 100).toFixed(2)}%</span>
                  </td>
                  <td className="text-right px-6 py-4 text-sm font-mono text-gray-300">${pos.cost.toFixed(2)}</td>
                  <td className="text-right px-6 py-4 text-xs text-gray-600">{new Date(pos.opened_at).toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Closed Positions */}
      <div>
        <div className="flex items-center gap-3 mb-4">
          <div className="w-8 h-8 rounded-xl bg-white/[0.03] flex items-center justify-center">
            <svg className="w-4 h-4 text-gray-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75L11.25 15 15 9.75M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
          </div>
          <div>
            <h3 className="text-base font-semibold text-white">Closed Positions</h3>
            <p className="text-[10px] text-gray-600">{closed.length} completed trades</p>
          </div>
        </div>
        <div className="glass-table rounded-2xl overflow-hidden">
          <table className="w-full pro-table">
            <thead>
              <tr className="border-b border-white/[0.05]">
                <th className="text-left text-[10px] font-semibold text-gray-500 uppercase tracking-wider px-6 py-4">Market</th>
                <th className="text-right text-[10px] font-semibold text-gray-500 uppercase tracking-wider px-6 py-4">Entry</th>
                <th className="text-right text-[10px] font-semibold text-gray-500 uppercase tracking-wider px-6 py-4">Cost</th>
                <th className="text-right text-[10px] font-semibold text-gray-500 uppercase tracking-wider px-6 py-4">P&L</th>
                <th className="text-right text-[10px] font-semibold text-gray-500 uppercase tracking-wider px-6 py-4">Closed</th>
              </tr>
            </thead>
            <tbody>
              {isLoading ? (
                [...Array(3)].map((_, i) => <SkeletonRow key={i} cols={5} />)
              ) : closed.length === 0 ? (
                <tr>
                  <td colSpan={5} className="text-center py-12">
                    <p className="text-sm text-gray-600">No closed positions yet</p>
                  </td>
                </tr>
              ) : closed.map((pos: any, i: number) => (
                <tr
                  key={pos.id}
                  className="border-b border-white/[0.03] animate-fade-in-up"
                  style={{ animationDelay: `${i * 50}ms`, opacity: 0 }}
                >
                  <td className="px-6 py-4 text-sm text-gray-300 font-medium">{pos.question.substring(0, 70)}</td>
                  <td className="text-right px-6 py-4 text-xs text-gray-500 font-mono">
                    <span className="text-profit">Y:{pos.yes_price.toFixed(3)}</span>
                    <span className="text-gray-700 mx-1">/</span>
                    <span className="text-loss">N:{pos.no_price.toFixed(3)}</span>
                  </td>
                  <td className="text-right px-6 py-4 text-sm font-mono text-gray-400">${pos.cost.toFixed(2)}</td>
                  <td className="text-right px-6 py-4">
                    <span className={`text-sm font-bold ${
                      pos.pnl >= 0 ? 'text-profit glow-profit' : 'text-loss glow-loss'
                    }`}>
                      {pos.pnl >= 0 ? '+' : ''}${pos.pnl.toFixed(2)}
                    </span>
                  </td>
                  <td className="text-right px-6 py-4 text-xs text-gray-600">{pos.closed_at ? new Date(pos.closed_at).toLocaleString() : '-'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
