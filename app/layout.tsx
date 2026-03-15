import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Polymarket BTC Arb Bot',
  description: 'Real-time BTC Up/Down arbitrage scanner',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="dark">
      <body className="min-h-screen antialiased">
        <div className="mesh-gradient" />
        <div className="mesh-gradient-accent" />
        <div className="relative z-10">
          {children}
        </div>
      </body>
    </html>
  );
}
