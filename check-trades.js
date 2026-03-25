const fs = require('fs');
const lines = fs.readFileSync('data/momentum-trades.jsonl','utf8').trim().split('\n').map(l=>JSON.parse(l));
const closed = lines.filter(t=>t.action==='CLOSE');
const wins = closed.filter(t=>t.won);
const losses = closed.filter(t=>!t.won);
console.log('=== ALL TRADES ===');
console.log(`Closed: ${closed.length} | W: ${wins.length} | L: ${losses.length} | WR: ${(wins.length/closed.length*100).toFixed(1)}%`);

const filtered = closed.filter(t=>t.entryPrice>=0.6);
const fw = filtered.filter(t=>t.won);
console.log('=== FILTERED >= 0.60 ===');
console.log(`Closed: ${filtered.length} | W: ${fw.length} | L: ${filtered.length-fw.length} | WR: ${(fw.length/filtered.length*100).toFixed(1)}%`);

const open = lines.filter(t=>t.action==='OPEN' && !lines.some(c=>c.action==='CLOSE' && c.slug===t.slug && c.entryTime===t.entryTime));
console.log(`Open positions: ${open.length}`);
if(open.length) open.forEach(o=>console.log(`  ${o.direction} ${o.slug} entry@${o.entryPrice}`));

console.log(`Last balance: ${closed[closed.length-1]?.balanceAfter}`);

// New trades since filter restart at 08:10
const cutoff = new Date('2026-03-25T07:10:00Z').getTime(); // 08:10 Paris = 07:10 UTC
const newClosed = closed.filter(t=>t.entryTime>=cutoff);
const nw = newClosed.filter(t=>t.won);
console.log('=== SINCE 08:10 (filtered run) ===');
console.log(`Closed: ${newClosed.length} | W: ${nw.length} | L: ${newClosed.length-nw.length} | WR: ${newClosed.length?((nw.length/newClosed.length*100).toFixed(1)+'%'):'N/A'}`);

// Trades by entry price bucket
console.log('=== BY ENTRY PRICE BUCKET ===');
for(const [lo,hi] of [[0.5,0.6],[0.6,0.7],[0.7,0.8],[0.8,0.9],[0.9,1.0]]) {
  const b = closed.filter(t=>t.entryPrice>=lo && t.entryPrice<hi);
  if(b.length===0) continue;
  const bw = b.filter(t=>t.won).length;
  console.log(`  ${lo.toFixed(1)}-${hi.toFixed(1)}: ${b.length} trades, ${bw}W/${b.length-bw}L, WR: ${(bw/b.length*100).toFixed(1)}%`);
}
