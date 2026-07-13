const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');
const nodeCrypto = require('crypto');
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
Object.defineProperty(window.crypto, 'subtle', { value: nodeCrypto.webcrypto.subtle, configurable: true });
const ev = (code) => window.eval(code);
function wait(ms){ return new Promise(r=>setTimeout(r,ms)); }
let failures = 0;

(async () => {
  await wait(400);
  doc = window.document;
  doc.getElementById('loginUsername').value='admin';
  doc.getElementById('loginPassword').value='admin123';
  ev('doLogin()');
  await wait(200);
  ev('loadSampleData()');
  await wait(50);

  // Click through every single nav tab and confirm no error is thrown and the panel becomes visible with content rendered
  const tabs = Array.from(doc.querySelectorAll('.navbtn')).map(b=>b.dataset.tab);
  console.log('Total nav tabs found:', tabs.length);
  console.log(tabs.join(', '));

  for(const tab of tabs){
    const before = pageErrors.length;
    ev(`showTab(${JSON.stringify(tab)})`);
    await wait(30);
    const panel = doc.getElementById('tab-'+tab);
    const isActive = panel && panel.classList.contains('active');
    const newErrors = pageErrors.length - before;
    console.log((isActive && newErrors===0 ? 'PASS' : 'FAIL') + ` - Tab "${tab}" shows without errors (active=${isActive}, newErrors=${newErrors})`);
    if(!isActive || newErrors>0) failures++;
  }

  // Exercise every "open X modal" function defined by the app without submitting, just to ensure the modal HTML builds without throwing
  const modalOpeners = [
    "openProductModal(null)", "openStockInModal(null)", "openSaleModal()", "openReturnModal()",
    "openCustomerModal(null)", "openSupplierModal(null)", "openRequisitionModal()", "openPoModal(null)",
    "openBundleModal(null)", "openBranchModal(null)", "openTransferModal()", "openCouponModal()",
    "openGiftCardModal()", "openExpenseModal()", "openCashBankAmountModal('cash','In')",
    "openRunPayrollModal()", "openLeaveModal()", "openUserModal(null)", "openEnroll2faModal()",
  ];
  for(const call of modalOpeners){
    const before = pageErrors.length;
    let threw = false;
    try{ ev(call); }catch(e){ threw = true; console.log('EXCEPTION in ' + call + ':', e.message); }
    await wait(20);
    const bodyHtml = doc.getElementById('modalBody') ? doc.getElementById('modalBody').innerHTML : '';
    const newErrors = pageErrors.length - before;
    const ok = !threw && newErrors===0 && bodyHtml.length>0;
    console.log((ok?'PASS':'FAIL') + ` - Modal opener "${call}" builds without error (bodyLen=${bodyHtml.length}, newErrors=${newErrors})`);
    if(!ok) failures++;
    ev('closeModal()');
    await wait(10);
  }

  // Verify renderAll() itself runs clean multiple times in a row (idempotency / no leaked state issues)
  for(let i=0;i<3;i++){
    const before = pageErrors.length;
    ev('renderAll()');
    await wait(20);
    const newErrors = pageErrors.length - before;
    console.log((newErrors===0?'PASS':'FAIL') + ` - renderAll() pass ${i+1} clean`);
    if(newErrors>0) failures++;
  }

  // Verify a full data round-trip through localStorage persistence (save -> reload -> same counts)
  const beforeCounts = ev(`({products:DB.products.length, sales:DB.sales.length, suppliers:DB.suppliers.length, bundles:DB.bundles.length, branches:DB.branches.length, journal:DB.journal.length, shifts:DB.shifts.length, payroll:DB.payroll.length, leaves:DB.leaves.length})`);
  ev('saveDB()');
  const raw = ev(`localStorage.getItem(LS_KEY)`);
  const reparsed = JSON.parse(raw);
  const afterCounts = {
    products: reparsed.products.length, sales: reparsed.sales.length, suppliers: reparsed.suppliers.length,
    bundles: reparsed.bundles.length, branches: reparsed.branches.length, journal: reparsed.journal.length,
    shifts: reparsed.shifts.length, payroll: reparsed.payroll.length, leaves: reparsed.leaves.length,
  };
  console.log('Before save:', JSON.stringify(beforeCounts));
  console.log('After localStorage round-trip:', JSON.stringify(afterCounts));
  const roundTripOk = JSON.stringify(beforeCounts)===JSON.stringify(afterCounts);
  console.log((roundTripOk?'PASS':'FAIL') + ' - Full data survives localStorage save/reload round-trip');
  if(!roundTripOk) failures++;

  console.log('---');
  console.log('Total page errors:', pageErrors.length);
  pageErrors.forEach(e=>console.log('  ' + e));
  console.log('Total assertion failures:', failures);
  process.exit((pageErrors.length || failures) ? 1 : 0);
})().catch(e=>{ console.error('TEST CRASH:', e); process.exit(1); });
