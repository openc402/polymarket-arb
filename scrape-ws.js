// Test: capture full WS messages to understand the protocol
const puppeteer = require('puppeteer-core');

(async () => {
  const browser = await puppeteer.launch({
    executablePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    headless: true,
    args: ['--no-sandbox']
  });
  const page = await browser.newPage();
  const client = await page.createCDPSession();
  await client.send('Network.enable');
  
  const messages = [];
  client.on('Network.webSocketFrameSent', ({response}) => {
    console.log('SENT:', response.payloadData.substring(0, 500));
  });
  client.on('Network.webSocketFrameReceived', ({response}) => {
    const msg = response.payloadData;
    try {
      const parsed = JSON.parse(msg);
      if (parsed.topic) {
        // Only log unique topics
        const key = parsed.topic + ':' + (parsed.type || '');
        if (!messages.find(m => m.key === key)) {
          messages.push({ key, topic: parsed.topic, type: parsed.type, payloadKeys: Object.keys(parsed.payload || {}) });
          console.log('TOPIC:', parsed.topic, '| TYPE:', parsed.type, '| KEYS:', Object.keys(parsed.payload || {}).join(','));
          
          // Full payload for price messages
          if (parsed.topic === 'crypto_prices_chainlink' || parsed.topic?.includes('price') || parsed.topic?.includes('market')) {
            console.log('  FULL:', JSON.stringify(parsed).substring(0, 500));
          }
        }
      }
    } catch {}
  });
  
  const now = Math.floor(Date.now() / 1000);
  const slug5m = 'btc-updown-5m-' + (Math.floor(now / 300) * 300);
  console.log('Opening:', 'https://polymarket.com/event/' + slug5m);
  
  await page.goto('https://polymarket.com/event/' + slug5m, { waitUntil: 'networkidle2', timeout: 30000 });
  
  // Wait 15s to collect messages
  await new Promise(r => setTimeout(r, 15000));
  
  console.log('\n=== ALL UNIQUE TOPICS ===');
  messages.forEach(m => console.log(m.topic, '|', m.type, '|', m.payloadKeys.join(',')));
  
  await browser.close();
})().catch(e => console.log('ERR:', e.message));
