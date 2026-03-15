# ⚡ Polymarket Arbitrage Bot

Paper trading bot that scans Polymarket for Yes/No arbitrage opportunities.

## How it works
- Scans all active binary markets every 30s
- Finds markets where Yes + No < $0.98 (2% spread = guaranteed profit)
- Auto-buys both sides with virtual $10,000 USDC
- When market resolves → cash out at $1 per pair

## Setup
```bash
npm install
```

## Run
```bash
# Terminal 1: Start the scanner
npm run scanner

# Terminal 2: Start the dashboard
npm run dev
```

Dashboard: http://localhost:3000
