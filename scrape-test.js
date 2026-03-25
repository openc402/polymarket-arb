const puppeteer = require('puppeteer-core');

(async () => {
  const browser = await puppeteer.launch({
    executablePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    headless: true,
    args: ['--no-sandbox']
  });
  const page = await browser.newPage();
  
  // Intercept WebSocket connections
  const client = await page.createCDPSession();
  await client.send('Network.enable');
  
  const wsUrls = [];
  const wsMessages = [];
  client.on('Network.webSocketCreated', ({url}) => {
    wsUrls.push(url);
    console.log('WS CREATED:', url);
  });
  client.on('Network.webSocketFrameReceived', ({response}) => {
    if (wsMessages.length < 10) {
      wsMessages.push(response.payloadData.substring(0, 300));
    }
  });
  
  const now = Math.floor(Date.now() / 1000);
  const slug5m = 'btc-updown-5m-' + (Math.floor(now / 300) * 300);
  const url = 'https://polymarket.com/event/' + slug5m;
  console.log('Loading:', url);
  
  await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
  await new Promise(r => setTimeout(r, 8000)); // wait for WS data
  
  // Scrape visible prices
  const data = await page.evaluate(() => {
    const text = document.body.innerText;
    return { bodySnippet: text.substring(0, 2000) };
  });
  
  console.log('\n=== PAGE TEXT ===');
  console.log(data.bodySnippet);
  console.log('\n=== WS URLs ===');
  wsUrls.forEach(u => console.log(u));
  console.log('\n=== WS MESSAGES (first 10) ===');
  wsMessages.forEach(m => console.log(m));
  
  await browser.close();
})().catch(e => console.log('ERR:', e.message));
