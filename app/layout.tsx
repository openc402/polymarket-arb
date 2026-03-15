import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Polymarket BTC Arb Terminal',
  description: 'Real-time BTC Up/Down arbitrage trading terminal',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="dark">
      <body className="h-screen overflow-hidden antialiased">
        <div className="mesh-gradient" />
        <div className="mesh-gradient-accent" />
        <div className="relative z-10 h-full">
          {children}
        </div>
      </body>
    </html>
  );
}
