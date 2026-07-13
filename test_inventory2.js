const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');
const html = fs.readFileSync(path.join(__dirname, 'test_inlined.html'), 'utf-8');
const vc = new VirtualConsole();
const pageErrors = [];
vc.on('jsdomError', (e) => { if (!/Not implemented/.test(e.message)) pageErrors.push('jsdomError: ' + e.message); });
vc.on('error', (...a)=>pageErrors.push('console.error: ' + a.join(' ')));
const dom = new JSDOM(html, { runScripts: 'dangerously', pretendToBeVisual: true, virtualConsole: vc, url: 'https://example.local/index.html' });
const { window } = dom;
window.print = () => {}; window.confirm = () => true; window.alert = () => {};
window.HTMLCanvasElement.prototype.getContext = function(){ const noop=()=>{}; return new Proxy({}, {get:(t,p)=>(p in t?t[p]:noop)}); };
window.addEventListener('error', (e)=>pageErrors.push('WINDOW-ERROR: '+(e.error&&e.error.stack||e.message)));
const ev = (code) => window.eval(code);
function wait(ms){ return new Promise(r=>setTimeout(r,ms)); }
function log(l,v){ console.log(l+':', v); }
function round2(n){ return Math.round(n*100)/100; }
let failures = 0;
function assertEq(label, actual, expected){
  const ok = Math.abs(Number(actual)-Number(expected))<0.01 || actual===expected;
  console.log((ok?'PASS':'FAIL')+' - '+label+': got '+JSON.stringify(actual)+' expected '+JSON.stringify(expected));
  if(!ok) failures++;
}

(async () => {
  await wait(400);
  doc = window.document;
  doc.getElementById('loginUsername').value='admin';
  doc.getElementById('loginPassword').value='admin123';
  ev('doLogin()');
  await wait(200);

  // ---------- Create two controlled products for FIFO/LIFO/WeightedAvg testing ----------
  ev("showTab('products')");
  ev("openProductModal(null)"); await wait(30);
  doc.getElementById('f_name').value = 'Test Widget A';
  doc.getElementById('f_barcode').value = 'WIDGETA001';
  doc.getElementById('f_purchasePrice').value = '10';
  doc.getElementById('f_sellingPrice').value = '20';
  doc.getElementById('f_minStock').value = '2';
  doc.getElementById('f_openingStock').value = '0';
  ev("saveProductForm(null)");
  await wait(50);
  const widgetA = ev("DB.products.find(p=>p.name==='Test Widget A').uid");

  ev("openProductModal(null)"); await wait(30);
  doc.getElementById('f_name').value = 'Test Widget B';
  doc.getElementById('f_barcode').value = 'WIDGETB001';
  doc.getElementById('f_purchasePrice').value = '5';
  doc.getElementById('f_sellingPrice').value = '9';
  doc.getElementById('f_minStock').value = '2';
  doc.getElementById('f_openingStock').value = '0';
  ev("saveProductForm(null)");
  await wait(50);
  const widgetB = ev("DB.products.find(p=>p.name==='Test Widget B').uid");
  log('Widgets created', widgetA && widgetB);

  // Build FIFO layers for Widget A: receive 10 @ $10, then 10 @ $14 (two batches, different dates via ts ordering)
  ev("showTab('stockin')");
  function receiveStock(productId, qty, price){
    ev("openStockInModal(null)");
    doc.getElementById('s_product').value = productId;
    doc.getElementById('s_qty').value = String(qty);
    doc.getElementById('s_price').value = String(price);
    doc.getElementById('s_paymethod').value = 'Cash';
    doc.getElementById('s_receivedBy').value = 'admin';
    ev("saveStockInForm(null)");
  }
  receiveStock(widgetA, 10, 10);
  await wait(20);
  receiveStock(widgetA, 10, 14);
  await wait(20);
  // Sell 12 units of Widget A (should consume all 10 of the $10 layer + 2 of the $14 layer under FIFO)
  ev("showTab('sales')");
  ev("openSaleModal()"); await wait(30);
  doc.getElementById('v_product').value = widgetA;
  doc.getElementById('v_product').dispatchEvent(new window.Event('change'));
  doc.getElementById('v_qty').value = '12';
  doc.getElementById('v_qty').dispatchEvent(new window.Event('input'));
  doc.getElementById('v_payment').value = 'Cash';
  doc.getElementById('v_payment').dispatchEvent(new window.Event('change'));
  doc.getElementById('v_cashier').value = 'admin';
  await ev('saveSaleForm(null)');
  await wait(50);

  // Remaining should be 8 units: FIFO -> all from the $14 layer (8 * 14 = 112, unit cost 14)
  const fifoResult = ev(`computeValuationForProduct(${JSON.stringify(widgetA)}, 'FIFO')`);
  log('FIFO valuation for Widget A', JSON.stringify(fifoResult));
  assertEq('FIFO qtyOnHand', fifoResult.qtyOnHand, 8);
  assertEq('FIFO unitCost (remaining $14 layer)', fifoResult.unitCost, 14);
  assertEq('FIFO totalValue', fifoResult.totalValue, 112);

  // LIFO -> last-in first consumed: 10 @ $14 consumed first (all of it, since 12 issued), then 2 @ $10 -> remaining 8 @ $10 = 80
  const lifoResult = ev(`computeValuationForProduct(${JSON.stringify(widgetA)}, 'LIFO')`);
  log('LIFO valuation for Widget A', JSON.stringify(lifoResult));
  assertEq('LIFO qtyOnHand', lifoResult.qtyOnHand, 8);
  assertEq('LIFO unitCost (remaining $10 layer)', lifoResult.unitCost, 10);
  assertEq('LIFO totalValue', lifoResult.totalValue, 80);

  // WeightedAvg -> avg cost of 20 units = (10*10+10*14)/20 = 12; after selling 12, remaining 8 still valued at $12 avg = 96
  const avgResult = ev(`computeValuationForProduct(${JSON.stringify(widgetA)}, 'WeightedAvg')`);
  log('WeightedAvg valuation for Widget A', JSON.stringify(avgResult));
  assertEq('WeightedAvg qtyOnHand', avgResult.qtyOnHand, 8);
  assertEq('WeightedAvg unitCost', avgResult.unitCost, 12);
  assertEq('WeightedAvg totalValue', avgResult.totalValue, 96);

  // ---------- Bundles ----------
  receiveStock(widgetB, 50, 5);
  await wait(30);
  ev("showTab('bundles')");
  ev("openBundleModal(null)"); await wait(30);
  doc.getElementById('bdl_name').value = 'Combo Pack';
  doc.getElementById('bdl_price').value = '30';
  // Default row already has one component select (first product in list) - set it to Widget A qty 1, then add a row for Widget B qty 2
  const firstSelect = doc.querySelector('#bundleCompRows .bundle-comp-product');
  firstSelect.value = widgetA;
  doc.querySelector('#bundleCompRows .bundle-comp-qty').value = '1';
  ev('addBundleCompRow()');
  await wait(20);
  const rows = doc.querySelectorAll('#bundleCompRows .field-row');
  const secondSelect = rows[1].querySelector('.bundle-comp-product');
  secondSelect.value = widgetB;
  rows[1].querySelector('.bundle-comp-qty').value = '2';
  ev("saveBundleForm(null)");
  await wait(50);
  assertEq('Bundle count', ev('DB.bundles.length'), 1);
  const bundleUid = ev('DB.bundles[0].uid');

  const makeableBefore = ev(`bundleMakeableQty(DB.bundles.find(b=>b.uid===${JSON.stringify(bundleUid)}))`);
  log('Bundle makeable qty (limited by Widget A: 8 available / 1 needed = 8, Widget B: 50/2=25)', makeableBefore);
  assertEq('Makeable qty limited by Widget A stock', makeableBefore, 8);

  const journalCountBefore = ev('DB.journal.length');
  const cashBefore = ev("accountBalance('1000')");
  const invBefore = ev("accountBalance('1200')");

  ev(`openSellBundleModal(${JSON.stringify(bundleUid)})`); await wait(30);
  doc.getElementById('bs_qty').value = '3';
  doc.getElementById('bs_payment').value = 'Cash';
  doc.getElementById('bs_cashier').value = 'admin';
  ev(`saveBundleSale(${JSON.stringify(bundleUid)})`);
  await wait(50);

  assertEq('Bundle sales count', ev('DB.bundleSales.length'), 1);
  const bsUid = ev('DB.bundleSales[0].uid');
  assertEq('Bundle sale total (3 x 30)', ev(`DB.bundleSales.find(x=>x.uid===${JSON.stringify(bsUid)}).totalAmount`), 90);
  // COGS = 3 * (1*14 + 2*5) = 3 * 24 = 72 (Widget A remaining cost is $14/unit after FIFO... but bundleUnitCost uses p.purchasePrice field, not FIFO valuation - check what that field actually holds)
  const bsCogs = ev(`DB.bundleSales.find(x=>x.uid===${JSON.stringify(bsUid)}).cogs`);
  log('Bundle sale COGS recorded', bsCogs);

  const widgetABalAfter = ev(`calcStockForProduct(${JSON.stringify(widgetA)}).balance`);
  const widgetBBalAfter = ev(`calcStockForProduct(${JSON.stringify(widgetB)}).balance`);
  assertEq('Widget A stock reduced by 3 (1 per bundle x 3)', widgetABalAfter, 8-3);
  assertEq('Widget B stock reduced by 6 (2 per bundle x 3)', widgetBBalAfter, 50-6);

  assertEq('Journal grew by exactly 1 entry for bundle sale', ev('DB.journal.length'), journalCountBefore + 1);
  assertEq('Cash increased by bundle sale total', ev("accountBalance('1000')"), cashBefore + 90);
  assertEq('Inventory decreased by COGS', ev("accountBalance('1200')"), invBefore - bsCogs);

  function checkTrialBalanceBalanced(){
    const tb = ev('trialBalance()');
    let totalDr=0, totalCr=0;
    tb.forEach(a=>{
      const isDebitNormal = (a.type==='Asset'||a.type==='Expense');
      const dr = isDebitNormal && a.balance>=0 ? a.balance : (!isDebitNormal && a.balance<0 ? -a.balance : 0);
      const cr = !isDebitNormal && a.balance>=0 ? a.balance : (isDebitNormal && a.balance<0 ? -a.balance : 0);
      totalDr += dr; totalCr += cr;
    });
    return round2(totalDr-totalCr);
  }
  assertEq('Trial balance stays balanced after bundle sale', checkTrialBalanceBalanced(), 0);

  // Undo the bundle sale and verify full reversal
  ev(`deleteBundleSale(${JSON.stringify(bsUid)})`);
  await wait(50);
  assertEq('Bundle sales count after undo', ev('DB.bundleSales.length'), 0);
  assertEq('Widget A stock restored', ev(`calcStockForProduct(${JSON.stringify(widgetA)}).balance`), 8);
  assertEq('Widget B stock restored', ev(`calcStockForProduct(${JSON.stringify(widgetB)}).balance`), 50);
  assertEq('Cash restored after undo', ev("accountBalance('1000')"), cashBefore);
  assertEq('Trial balance still balanced after undo', checkTrialBalanceBalanced(), 0);

  console.log('---');
  console.log('Total page errors:', pageErrors.length);
  pageErrors.forEach(e=>console.log('  ' + e));
  console.log('Total assertion failures:', failures);
  process.exit((pageErrors.length || failures) ? 1 : 0);
})().catch(e=>{ console.error('TEST CRASH:', e); process.exit(1); });
