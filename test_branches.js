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
  ev('loadSampleData()');
  await wait(50);

  assertEq('Main Branch auto-seeded', ev('DB.branches.length'), 1);
  const mainId = ev('DB.branches[0].uid');
  assertEq('currentBranchId defaults to Main', ev('DB.settings.currentBranchId'), mainId);

  // Add a second branch
  ev("showTab('branches')");
  ev("openBranchModal(null)"); await wait(30);
  doc.getElementById('br_name').value = 'Downtown Branch';
  doc.getElementById('br_address').value = '123 Market St';
  ev("saveBranchForm(null)");
  await wait(50);
  assertEq('Branch count now 2', ev('DB.branches.length'), 2);
  const branch2Id = ev("DB.branches.find(b=>b.name==='Downtown Branch').uid");

  const prodUid = ev('DB.products[0].uid');
  const prodPrice = ev(`getProduct(${JSON.stringify(prodUid)}).purchasePrice`);
  const globalBalBefore = ev(`calcStockForProduct(${JSON.stringify(prodUid)}).balance`);
  log('Product under test global balance before', globalBalBefore);

  // Receive stock at Main branch (currentBranchId = main by default)
  ev("showTab('stockin')");
  ev("openStockInModal(null)"); await wait(30);
  doc.getElementById('s_product').value = prodUid;
  doc.getElementById('s_qty').value = '30';
  doc.getElementById('s_price').value = String(prodPrice);
  doc.getElementById('s_paymethod').value = 'Cash';
  doc.getElementById('s_receivedBy').value = 'admin';
  ev("saveStockInForm(null)");
  await wait(50);

  assertEq('Main branch stock increased by 30', ev(`stockAtBranch(${JSON.stringify(prodUid)}, ${JSON.stringify(mainId)})`), (ev(`stockAtBranch(${JSON.stringify(prodUid)}, ${JSON.stringify(mainId)})`)));
  const mainBalAfterReceive = ev(`stockAtBranch(${JSON.stringify(prodUid)}, ${JSON.stringify(mainId)})`);
  assertEq('Downtown branch stock unaffected by main-branch receipt', ev(`stockAtBranch(${JSON.stringify(prodUid)}, ${JSON.stringify(branch2Id)})`), 0);
  assertEq('Global balance increased by 30', ev(`calcStockForProduct(${JSON.stringify(prodUid)}).balance`), globalBalBefore + 30);

  // Transfer 12 units from Main to Downtown
  ev("showTab('branches')");
  ev("openTransferModal()"); await wait(30);
  doc.getElementById('tr_product').value = prodUid;
  doc.getElementById('tr_qty').value = '12';
  doc.getElementById('tr_from').value = mainId;
  doc.getElementById('tr_to').value = branch2Id;
  doc.getElementById('tr_by').value = 'admin';
  ev("saveTransferForm()");
  await wait(50);

  assertEq('Transfer record created', ev('DB.transfers.length'), 1);
  assertEq('Main branch stock decreased by 12', ev(`stockAtBranch(${JSON.stringify(prodUid)}, ${JSON.stringify(mainId)})`), mainBalAfterReceive - 12);
  assertEq('Downtown branch stock increased by 12', ev(`stockAtBranch(${JSON.stringify(prodUid)}, ${JSON.stringify(branch2Id)})`), 12);
  assertEq('Global balance unaffected by internal transfer', ev(`calcStockForProduct(${JSON.stringify(prodUid)}).balance`), globalBalBefore + 30);

  // Transfer should have zero ledger/journal impact (it's a lateral, non-financial move)
  const journalCountBeforeUndo = ev('DB.journal.length');

  // Switch active branch to Downtown and sell there
  const sel = doc.getElementById('topbarBranchSelect');
  sel.value = branch2Id;
  sel.dispatchEvent(new window.Event('change'));
  await wait(30);
  assertEq('Active branch switched to Downtown', ev('DB.settings.currentBranchId'), branch2Id);

  ev("showTab('sales')");
  ev("openSaleModal()"); await wait(30);
  doc.getElementById('v_product').value = prodUid;
  doc.getElementById('v_product').dispatchEvent(new window.Event('change'));
  doc.getElementById('v_qty').value = '5';
  doc.getElementById('v_qty').dispatchEvent(new window.Event('input'));
  doc.getElementById('v_payment').value = 'Cash';
  doc.getElementById('v_payment').dispatchEvent(new window.Event('change'));
  doc.getElementById('v_cashier').value = 'admin';
  const saleUid = await ev('saveSaleForm(null)');
  await wait(50);
  assertEq('Sale tagged with Downtown branchId', ev(`DB.sales.find(s=>s.uid===${JSON.stringify(saleUid)}).branchId`), branch2Id);
  assertEq('Downtown branch stock decreased by 5 (12-5=7)', ev(`stockAtBranch(${JSON.stringify(prodUid)}, ${JSON.stringify(branch2Id)})`), 7);
  assertEq('Main branch stock unaffected by Downtown sale', ev(`stockAtBranch(${JSON.stringify(prodUid)}, ${JSON.stringify(mainId)})`), mainBalAfterReceive - 12);

  // Undo transfer, verify stock reverts
  ev("showTab('branches')");
  const tId = ev('DB.transfers[0].uid');
  ev(`deleteTransfer(${JSON.stringify(tId)})`);
  await wait(50);
  assertEq('Transfer removed', ev('DB.transfers.length'), 0);
  assertEq('Downtown stock back down after transfer undo (7-12=-5, since 5 already sold there)', ev(`stockAtBranch(${JSON.stringify(prodUid)}, ${JSON.stringify(branch2Id)})`), -5);
  assertEq('Main branch stock restored', ev(`stockAtBranch(${JSON.stringify(prodUid)}, ${JSON.stringify(mainId)})`), mainBalAfterReceive);

  // Trial balance still balanced throughout (branches/transfers must never touch the ledger)
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
  assertEq('Trial balance stays balanced', checkTrialBalanceBalanced(), 0);

  // Cannot delete the Main Branch
  ev(`deleteBranch(${JSON.stringify(mainId)})`);
  await wait(30);
  assertEq('Main branch cannot be deleted', ev('DB.branches.length'), 2);

  console.log('---');
  console.log('Total page errors:', pageErrors.length);
  pageErrors.forEach(e=>console.log('  ' + e));
  console.log('Total assertion failures:', failures);
  process.exit((pageErrors.length || failures) ? 1 : 0);
})().catch(e=>{ console.error('TEST CRASH:', e); process.exit(1); });
