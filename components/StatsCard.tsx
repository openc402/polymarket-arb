'use client';
import { useEffect, useState, useRef } from 'react';

interface StatsCardProps {
  title: string;
  value: string;
  subtitle?: string;
  trend?: 'up' | 'down' | 'neutral';
  icon: React.ReactNode;
  sparkData?: number[];
  delay?: number;
}

function MiniSparkline({ data, color }: { data: number[]; color: string }) {
  if (!data || data.length < 2) return null;
  const min = Math.min(...data);
  const max = Math.max(...data);
  const range = max - min || 1;
  const h = 32;
  const w = 80;
  const points = data.map((v, i) => {
    const x = (i / (data.length - 1)) * w;
    const y = h - ((v - min) / range) * h;
    return `${x},${y}`;
  }).join(' ');

  return (
    <svg width={w} height={h} className="opacity-40">
      <defs>
        <linearGradient id={`spark-${color}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity={0.3} />
          <stop offset="100%" stopColor={color} stopOpacity={0} />
        </linearGradient>
      </defs>
      <polyline
        points={points}
        fill="none"
        stroke={color}
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <polygon
        points={`0,${h} ${points} ${w},${h}`}
        fill={`url(#spark-${color})`}
      />
    </svg>
  );
}

function TrendArrow({ trend }: { trend: 'up' | 'down' | 'neutral' }) {
  if (trend === 'up') return (
    <div className="flex items-center gap-1 text-[10px] font-semibold text-profit bg-profit/10 px-2 py-0.5 rounded-full">
      <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 19.5l15-15m0 0H8.25m11.25 0v11.25" />
      </svg>
    </div>
  );
  if (trend === 'down') return (
    <div className="flex items-center gap-1 text-[10px] font-semibold text-loss bg-loss/10 px-2 py-0.5 rounded-full">
      <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 4.5l15 15m0 0V8.25m0 11.25H8.25" />
      </svg>
    </div>
  );
  return (
    <div className="flex items-center gap-1 text-[10px] font-semibold text-gray-500 bg-gray-500/10 px-2 py-0.5 rounded-full">
      <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 12h-15" />
      </svg>
    </div>
  );
}

export default function StatsCard({ title, value, subtitle, trend = 'neutral', icon, sparkData, delay = 0 }: StatsCardProps) {
  const [visible, setVisible] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const timer = setTimeout(() => setVisible(true), delay);
    return () => clearTimeout(timer);
  }, [delay]);

  const trendColor = trend === 'up' ? 'text-profit' : trend === 'down' ? 'text-loss' : 'text-gray-300';
  const glowClass = trend === 'up' ? 'glow-profit' : trend === 'down' ? 'glow-loss' : '';
  const boxGlow = trend === 'up' ? 'glow-box-profit' : trend === 'down' ? 'glow-box-loss' : '';
  const sparkColor = trend === 'up' ? '#00ff88' : trend === 'down' ? '#ff4466' : '#6366f1';

  return (
    <div
      ref={ref}
      className={`relative glass-card rounded-2xl p-5 overflow-hidden gradient-border hover-lift ${boxGlow} transition-all duration-500 ${
        visible ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-4'
      }`}
    >
      <div className="flex items-start justify-between mb-4">
        <div className="flex items-center gap-2">
          <span className="text-gray-500">{icon}</span>
          <span className="text-[11px] font-semibold text-gray-500 uppercase tracking-wider">{title}</span>
        </div>
        <TrendArrow trend={trend} />
      </div>

      <div className="flex items-end justify-between">
        <div>
          <div className={`text-2xl font-bold tracking-tight ${trendColor} ${glowClass}`}>
            {value}
          </div>
          {subtitle && (
            <p className="text-[11px] text-gray-600 mt-1.5 font-medium">{subtitle}</p>
          )}
        </div>
        {sparkData && sparkData.length > 1 && (
          <MiniSparkline data={sparkData} color={sparkColor} />
        )}
      </div>
    </div>
  );
}
