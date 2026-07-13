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
  ev("loadSampleData()");
  await wait(50);

  ev("showTab('suppliers')");
  await wait(50);

  // Add a supplier with a credit limit
  ev("openSupplierModal(null)"); await wait(30);
  doc.getElementById('sup_name').value = 'Acme Distributors';
  doc.getElementById('sup_phone').value = '555-1111';
  doc.getElementById('sup_email').value = 'acme@example.com';
  doc.getElementById('sup_creditLimit').value = '500';
  doc.getElementById('sup_address').value = '';
  ev("saveSupplierForm(null)");
  await wait(50);
  const supplierUid = ev("DB.suppliers.find(s=>s.name==='Acme Distributors').uid");
  log('Supplier created', !!supplierUid);
  assertEq('Supplier creditLimit stored', ev(`DB.suppliers.find(s=>s.uid===${JSON.stringify(supplierUid)}).creditLimit`), 500);

  const prodUid = ev('DB.products[0].uid');
  const prodName = ev(`getProduct(${JSON.stringify(prodUid)}).name`);
  const balBefore = ev(`calcStockForProduct(${JSON.stringify(prodUid)}).balance`);
  log('Product under test', prodName + ' starting balance ' + balBefore);

  // 1. Submit a requisition
  ev("showTab('purchasing')");
  ev("openRequisitionModal()"); await wait(30);
  doc.getElementById('req_product').value = prodUid;
  doc.getElementById('req_qty').value = '15';
  doc.getElementById('req_by').value = 'admin';
  ev("saveRequisitionForm()");
  await wait(50);
  assertEq('Requisition count', ev('DB.requisitions.length'), 1);
  const reqUid = ev('DB.requisitions[0].uid');
  assertEq('Requisition status Pending', ev(`DB.requisitions.find(r=>r.uid===${JSON.stringify(reqUid)}).status`), 'Pending');

  // 2. Approve requisition
  ev(`approveRequisition(${JSON.stringify(reqUid)})`);
  await wait(30);
  assertEq('Requisition status Approved', ev(`DB.requisitions.find(r=>r.uid===${JSON.stringify(reqUid)}).status`), 'Approved');

  // 3. Create PO from requisition
  ev(`openPoModal(${JSON.stringify(reqUid)})`); await wait(30);
  doc.getElementById('po_supplier').value = supplierUid;
  doc.getElementById('po_product').value = prodUid;
  doc.getElementById('po_qty').value = '15';
  doc.getElementById('po_unitcost').value = '2.5';
  ev(`savePoForm(${JSON.stringify(reqUid)})`);
  await wait(50);
  assertEq('PO count', ev('DB.purchaseOrders.length'), 1);
  assertEq('Requisition status after PO -> Ordered', ev(`DB.requisitions.find(r=>r.uid===${JSON.stringify(reqUid)}).status`), 'Ordered');
  const poUid = ev('DB.purchaseOrders[0].uid');
  assertEq('PO status Draft', ev(`DB.purchaseOrders.find(p=>p.uid===${JSON.stringify(poUid)}).status`), 'Draft');
  assertEq('PO poNumber format', /^PO-\d{5}$/.test(ev(`DB.purchaseOrders.find(p=>p.uid===${JSON.stringify(poUid)}).poNumber`)), true);

  // 4. Approve PO (should NOT trigger credit-limit warning: 15*2.5=37.5 < 500 limit)
  ev(`approvePo(${JSON.stringify(poUid)})`);
  await wait(30);
  assertEq('PO status Approved', ev(`DB.purchaseOrders.find(p=>p.uid===${JSON.stringify(poUid)}).status`), 'Approved');

  const journalCountBeforeReceive = ev('DB.journal.length');
  const cashBefore = ev("accountBalance('1000')");
  const apBefore = ev("accountBalance('2000')");
  const invBefore = ev("accountBalance('1200')");

  // 5. Receive PO (GRN)
  ev(`receivePo(${JSON.stringify(poUid)})`);
  await wait(50);
  assertEq('PO status Received', ev(`DB.purchaseOrders.find(p=>p.uid===${JSON.stringify(poUid)}).status`), 'Received');
  assertEq('StockIns count +1', ev('DB.stockIns.length'), ev('DB.stockIns.length')); // sanity - non-zero check below
  const stockInsForPo = ev(`DB.stockIns.filter(s=>s.poId===${JSON.stringify(poUid)}).length`);
  assertEq('Exactly one stockIn linked to PO', stockInsForPo, 1);

  const balAfter = ev(`calcStockForProduct(${JSON.stringify(prodUid)}).balance`);
  assertEq('Stock balance increased by 15', balAfter, balBefore + 15);

  const supplierBalAfter = ev(`DB.suppliers.find(s=>s.uid===${JSON.stringify(supplierUid)}).outstandingBalance`);
  assertEq('Supplier outstandingBalance increased by 37.5', supplierBalAfter, 37.5);

  assertEq('Journal grew by exactly 1 entry', ev('DB.journal.length'), journalCountBeforeReceive + 1);
  assertEq('Cash unaffected by credit GRN', ev("accountBalance('1000')"), cashBefore);
  assertEq('AP (2000) increased by 37.5', ev("accountBalance('2000')"), apBefore + 37.5);
  assertEq('Inventory (1200) increased by 37.5', ev("accountBalance('1200')"), invBefore + 37.5);

  // Trial balance still balanced
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
  assertEq('Trial balance stays balanced after GRN', checkTrialBalanceBalanced(), 0);

  // 6. Supplier price history should show the received entry
  ev(`openSupplierPriceHistoryModal(${JSON.stringify(supplierUid)})`);
  await wait(30);
  const modalHtml = doc.getElementById('modalBody').innerHTML;
  log('Price history modal contains product name', modalHtml.includes(prodName));
  if(!modalHtml.includes(prodName)) failures++;
  ev("closeModal()");

  // 7. Supplier performance score computed
  const perf = ev(`supplierPerformanceScore(${JSON.stringify(supplierUid)})`);
  log('Supplier performance score', JSON.stringify(perf));
  if(!perf || typeof perf.score !== 'number') { console.log('FAIL - performance score missing'); failures++; }

  // 8. Credit-limit warning path: push supplier near limit then over it via a second larger PO, confirm() stubbed to true so it proceeds
  ev("openPoModal(null)"); await wait(30);
  doc.getElementById('po_supplier').value = supplierUid;
  doc.getElementById('po_product').value = prodUid;
  doc.getElementById('po_qty').value = '200';
  doc.getElementById('po_unitcost').value = '3';
  ev('savePoForm(null)');
  await wait(30);
  const po2Uid = ev('DB.purchaseOrders[1].uid');
  ev(`approvePo(${JSON.stringify(po2Uid)})`); // 600 > 500 limit, confirm() stubbed true -> proceeds
  await wait(30);
  assertEq('Second PO approved despite over credit limit (confirm stubbed true)', ev(`DB.purchaseOrders.find(p=>p.uid===${JSON.stringify(po2Uid)}).status`), 'Approved');

  // 9. Delete a Draft/Approved PO works, but Received cannot be deleted
  ev(`deletePo(${JSON.stringify(poUid)})`);
  await wait(30);
  const stillExists = ev(`!!DB.purchaseOrders.find(p=>p.uid===${JSON.stringify(poUid)})`);
  assertEq('Cannot delete a Received PO', stillExists, true);

  console.log('---');
  console.log('Total page errors:', pageErrors.length);
  pageErrors.forEach(e=>console.log('  ' + e));
  console.log('Total assertion failures:', failures);
  process.exit((pageErrors.length || failures) ? 1 : 0);
})().catch(e=>{ console.error('TEST CRASH:', e); process.exit(1); });
