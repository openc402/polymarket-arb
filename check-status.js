const fs = require('fs');
const lines = fs.readFileSync('data/market-history.jsonl','utf8').trim().split('\n').map(l=>JSON.parse(l));
const btc = fs.readFileSync('data/btc-snapshots.jsonl','utf8').trim().split('\n').map(l=>JSON.parse(l));
console.log('Market records:', lines.length);
console.log('BTC snapshots:', btc.length);
console.log('Last record:', lines[lines.length-1].slug, 'outcome:', lines[lines.length-1].outcome);
console.log('Last BTC price:', btc[btc.length-1].price);

// Momentum analysis
const withMom = lines.filter(r => r.momentum2mPct !== null && r.momentum2mPct !== undefined);
console.log('\n--- Momentum Analysis ---');
console.log('Records with momentum:', withMom.length);

const strong = withMom.filter(r => Math.abs(r.momentum2mPct) >= 0.05);
let sCorrect = 0;
strong.forEach(r => {
  const predicted = r.momentum2mPct > 0 ? 'Up' : 'Down';
  if (r.outcome === predicted) sCorrect++;
});
console.log('Strong (>=0.05%):', strong.length, 'Correct:', sCorrect, 'WR:', strong.length>0?(sCorrect/strong.length*100).toFixed(1)+'%':'N/A');

const tight = withMom.filter(r => Math.abs(r.momentum2mPct) >= 0.10);
let tCorrect = 0;
tight.forEach(r => {
  const predicted = r.momentum2mPct > 0 ? 'Up' : 'Down';
  if (r.outcome === predicted) tCorrect++;
});
console.log('Tight (>=0.10%):', tight.length, 'Correct:', tCorrect, 'WR:', tight.length>0?(tCorrect/tight.length*100).toFixed(1)+'%':'N/A');

// Market pricing analysis
const withPricing = lines.filter(r => r.upPriceAtOpen && r.outcome);
let pricingEdge = 0;
withPricing.forEach(r => {
  const impliedUp = r.upPriceAtOpen;
  const actualUp = r.outcome === 'Up' ? 1 : 0;
  pricingEdge += (actualUp - impliedUp);
});
console.log('\n--- Market Pricing ---');
console.log('Avg edge if always bet Up:', (pricingEdge/withPricing.length*100).toFixed(2)+'%');
