const WebSocket = require('ws');

const now = Math.floor(Date.now() / 1000);
const slug5m = 'btc-updown-5m-' + (Math.floor(now / 300) * 300);

const ws = new WebSocket('wss://ws-live-data.polymarket.com/');

ws.on('open', () => {
  console.log('Connected to Polymarket WS!');
  ws.send(JSON.stringify({
    action: "subscribe",
    subscriptions: [
      { topic: "activity", type: "orders_matched", filters: JSON.stringify({ event_slug: slug5m }) },
      { topic: "crypto_prices_chainlink", type: "update", filters: JSON.stringify({ symbol: "btc/usd" }) }
    ]
  }));
  console.log('Subscribed to:', slug5m);
});

let priceCount = 0;
let tradeCount = 0;

ws.on('message', (data) => {
  let msg;
  try { msg = JSON.parse(data.toString()); } catch { return; }
  
  if (msg.topic === 'crypto_prices_chainlink') {
    priceCount++;
    if (priceCount <= 5 || priceCount % 10 === 0) {
      console.log(`[CHAINLINK] $${msg.payload.value.toFixed(2)} @ ${new Date(msg.payload.timestamp).toISOString()}`);
    }
  }
  
  if (msg.topic === 'activity' && msg.type === 'orders_matched') {
    tradeCount++;
    const p = msg.payload;
    console.log(`[TRADE] ${p.outcome} ${p.side} @ ${p.price} | Size: $${p.size} | ${p.name}`);
  }
});

ws.on('close', (code) => console.log('Closed:', code));
ws.on('error', (e) => console.log('Error:', e.message));

// Run for 30 seconds
setTimeout(() => {
  console.log(`\nSummary: ${priceCount} price updates, ${tradeCount} trades in 30s`);
  ws.close();
  process.exit();
}, 30000);
