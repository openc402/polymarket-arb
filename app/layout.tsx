import './globals.css';
import type { Metadata } from 'next';
import Sidebar from '@/components/Sidebar';

export const metadata: Metadata = {
  title: 'Poly Arb | Arbitrage Scanner',
  description: 'Real-time Polymarket arbitrage scanner & paper trading dashboard',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="dark">
      <body className="flex min-h-screen bg-dark-950 font-sans antialiased">
        {/* Animated mesh gradient background */}
        <div className="mesh-gradient" />
        <div className="mesh-gradient-accent" />

        <Sidebar />
        <main className="relative z-10 flex-1 ml-72 p-10">
          {children}
        </main>
      </body>
    </html>
  );
}
