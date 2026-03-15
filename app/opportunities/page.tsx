'use client';
import { useEffect, useState, useCallback } from 'react';

const GAMMA_API = 'https://gamma-api.polymarket.com';

interface Opportunity {
  market_id: string;
  question: string;
  yes_price: number;
  no_price: number;
  spread: number;
  volume: number;
  liquidity: number;
}

function SkeletonRow() {
  return (
    <tr className="border-b border-white/[0.03]">
      <td className="px-5 py-4"><div className="skeleton h-4 w-64" /></td>
      <td className="px-5 py-4"><div className="skeleton h-4 w-16 ml-auto" /></td>
      <td className="px-5 py-4"><div className="skeleton h-4 w-16 ml-auto" /></td>
      <td className="px-5 py-4"><div className="skeleton h-4 w-16 ml-auto" /></td>
      <td className="px-5 py-4"><div className="skeleton h-4 w-16 ml-auto" /></td>
      <td className="px-5 py-4"><div className="skeleton h-4 w-16 ml-auto" /></td>
      <td className="px-5 py-4"><div className="skeleton h-4 w-16 ml-auto" /></td>
    </tr>
  );
}

export default function Opportunities() {
  const [opps, setOpps] = useState<Opportunity[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null);

  const fetchLive = useCallback(async () => {
    try {
      setError(null);
      const res = await fetch(`${GAMMA_API}/markets?active=true&closed=false&limit=100`);
      if (!res.ok) throw new Error(`API error: ${res.status}`);
      const markets = await res.json();

      const found: Opportunity[] = [];
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
          const [yesBook, noBook] = await Promise.all([
            fetch(`https://clob.polymarket.com/book?token_id=${tokenIds[0]}`).then(r => r.json()),
            fetch(`https://clob.polymarket.com/book?token_id=${tokenIds[1]}`).then(r => r.json()),
          ]);

          const yesAsks = yesBook.asks || [];
          const noAsks = noBook.asks || [];
          if (!yesAsks.length || !noAsks.length) continue;

          yesAsks.sort((a: any, b: any) => parseFloat(a.price) - parseFloat(b.price));
          noAsks.sort((a: any, b: any) => parseFloat(a.price) - parseFloat(b.price));

          const yesAsk = parseFloat(yesAsks[0].price);
          const noAsk = parseFloat(noAsks[0].price);
          const spread = 1 - (yesAsk + noAsk);

          if (spread > -0.05) {
            found.push({
              market_id: m.id || m.conditionId,
              question: m.question,
              yes_price: yesAsk,
              no_price: noAsk,
              spread,
              volume: parseFloat(m.volume || 0),
              liquidity: parseFloat(m.liquidity || 0),
            });
          }
        } catch { continue; }

        await new Promise(r => setTimeout(r, 100));
      }

      found.sort((a, b) => b.spread - a.spread);
      setOpps(found);
      setLastRefresh(new Date());
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchLive();
    const i = setInterval(fetchLive, 60000);
    return () => clearInterval(i);
  }, [fetchLive]);

  return (
    <div className="animate-fade-in">
      {/* Header */}
      <div className="flex items-center justify-between mb-8">
        <div>
          <h2 className="text-3xl font-bold text-white tracking-tight">Live Opportunities</h2>
          <p className="text-sm text-gray-600 mt-1">Real-time arbitrage scanner from Polymarket orderbooks</p>
        </div>
        <div className="flex items-center gap-3">
          {loading && (
            <div className="flex items-center gap-2 text-xs text-accent">
              <div className="w-4 h-4 border-2 border-accent/30 border-t-accent rounded-full animate-spin" />
              Scanning...
            </div>
          )}
          <div className="glass-card rounded-xl px-4 py-2 flex items-center gap-2">
            <div className={`w-2 h-2 rounded-full ${opps.length > 0 ? 'bg-profit' : 'bg-gray-600'}`} />
            <span className="text-xs text-gray-400 font-medium">{opps.length} found</span>
          </div>
          <button
            onClick={() => { setLoading(true); fetchLive(); }}
            className="glass-card rounded-xl px-4 py-2 text-xs font-medium text-accent hover:bg-accent/10 transition-all duration-300 flex items-center gap-2"
          >
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0l3.181 3.183a8.25 8.25 0 0013.803-3.7M4.031 9.865a8.25 8.25 0 0113.803-3.7l3.181 3.182" />
            </svg>
            Refresh
          </button>
        </div>
      </div>

      {/* Error */}
      {error && (
        <div className="glass-card rounded-2xl p-4 mb-6 border-loss/20 bg-loss/5">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-xl bg-loss/10 flex items-center justify-center">
              <svg className="w-4 h-4 text-loss" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m9-.75a9 9 0 11-18 0 9 9 0 0118 0zm-9 3.75h.008v.008H12v-.008z" />
              </svg>
            </div>
            <p className="text-sm text-loss">{error}</p>
          </div>
        </div>
      )}

      {/* Table */}
      <div className="glass-table rounded-2xl overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full pro-table">
            <thead>
              <tr className="border-b border-white/[0.05]">
                <th className="text-left text-[10px] font-semibold text-gray-500 uppercase tracking-wider px-6 py-4">Market</th>
                <th className="text-right text-[10px] font-semibold text-gray-500 uppercase tracking-wider px-6 py-4">Yes</th>
                <th className="text-right text-[10px] font-semibold text-gray-500 uppercase tracking-wider px-6 py-4">No</th>
                <th className="text-right text-[10px] font-semibold text-gray-500 uppercase tracking-wider px-6 py-4">Total</th>
                <th className="text-right text-[10px] font-semibold text-gray-500 uppercase tracking-wider px-6 py-4">Spread</th>
                <th className="text-right text-[10px] font-semibold text-gray-500 uppercase tracking-wider px-6 py-4">Est. Profit/$100</th>
                <th className="text-right text-[10px] font-semibold text-gray-500 uppercase tracking-wider px-6 py-4">Volume</th>
              </tr>
            </thead>
            <tbody>
              {loading && opps.length === 0 ? (
                [...Array(5)].map((_, i) => <SkeletonRow key={i} />)
              ) : opps.length === 0 ? (
                <tr>
                  <td colSpan={7} className="text-center py-16">
                    <div className="w-12 h-12 rounded-2xl bg-accent/10 flex items-center justify-center mx-auto mb-3">
                      <svg className="w-6 h-6 text-accent" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-5.197-5.197m0 0A7.5 7.5 0 105.196 5.196a7.5 7.5 0 0010.607 10.607z" />
                      </svg>
                    </div>
                    <p className="text-sm text-gray-500">No opportunities found</p>
                    <p className="text-[10px] text-gray-700 mt-1">Markets are being scanned continuously</p>
                  </td>
                </tr>
              ) : (
                opps.map((opp, i) => {
                  const total = opp.yes_price + opp.no_price;
                  const profitPer100 = (opp.spread * 100).toFixed(2);
                  const isHot = opp.spread > 0.03;
                  return (
                    <tr
                      key={i}
                      className={`border-b border-white/[0.03] transition-all duration-300 animate-fade-in-up ${
                        isHot ? 'bg-profit/[0.03]' : ''
                      }`}
                      style={{ animationDelay: `${i * 50}ms`, opacity: 0 }}
                    >
                      <td className="px-6 py-4">
                        <div className="flex items-center gap-3">
                          {isHot && (
                            <div className="w-6 h-6 rounded-lg bg-profit/10 flex items-center justify-center flex-shrink-0">
                              <svg className="w-3.5 h-3.5 text-profit" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                                <path strokeLinecap="round" strokeLinejoin="round" d="M15.362 5.214A8.252 8.252 0 0112 21 8.25 8.25 0 016.038 7.048 6.51 6.51 0 007.5 9a4.5 4.5 0 104.5-4.5c0-.61-.122-1.19-.342-1.72a6.487 6.487 0 003.704 1.934z" />
                              </svg>
                            </div>
                          )}
                          <p className="text-sm text-gray-300 font-medium leading-snug">{opp.question.length > 80 ? opp.question.substring(0, 80) + '...' : opp.question}</p>
                        </div>
                      </td>
                      <td className="text-right px-6 py-4 text-sm font-mono text-profit font-medium">${opp.yes_price.toFixed(3)}</td>
                      <td className="text-right px-6 py-4 text-sm font-mono text-loss font-medium">${opp.no_price.toFixed(3)}</td>
                      <td className="text-right px-6 py-4 text-sm font-mono text-gray-400">${total.toFixed(3)}</td>
                      <td className="text-right px-6 py-4">
                        <span className={`inline-flex items-center px-2.5 py-1 rounded-lg text-xs font-bold ${
                          isHot ? 'text-profit bg-profit/10 glow-profit' : 'text-accent bg-accent/10'
                        }`}>
                          {(opp.spread * 100).toFixed(2)}%
                        </span>
                      </td>
                      <td className="text-right px-6 py-4">
                        <span className="text-sm font-mono text-profit font-semibold glow-profit">${profitPer100}</span>
                      </td>
                      <td className="text-right px-6 py-4 text-xs text-gray-600 font-medium">${(opp.volume / 1000).toFixed(0)}k</td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Footer */}
      <div className="flex items-center justify-between mt-4">
        <p className="text-[10px] text-gray-700">Data fetched live from Polymarket API. Auto-refreshes every 60s.</p>
        {lastRefresh && (
          <p className="text-[10px] text-gray-700">Last refresh: {lastRefresh.toLocaleTimeString()}</p>
        )}
      </div>
    </div>
  );
}
