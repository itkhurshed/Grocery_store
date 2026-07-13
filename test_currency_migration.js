const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');
const html = fs.readFileSync(path.join(__dirname, 'test_inlined.html'), 'utf-8');
let failures = 0;
function assertEq(label, actual, expected){
  const ok = actual===expected;
  console.log((ok?'PASS':'FAIL')+' - '+label+': got '+JSON.stringify(actual)+' expected '+JSON.stringify(expected));
  if(!ok) failures++;
}
function wait(ms){ return new Promise(r=>setTimeout(r,ms)); }

async function runScenario(name, seedData){
  console.log('=== Scenario: ' + name + ' ===');
  const pageErrors = [];
  const vc = new VirtualConsole();
  vc.on('jsdomError', (e) => { if (!/Not implemented/.test(e.message)) pageErrors.push('jsdomError: ' + e.message); });
  vc.on('error', (...a)=>pageErrors.push('console.error: ' + a.join(' ')));
  const dom = new JSDOM(html, {
    runScripts: 'dangerously', pretendToBeVisual: true, virtualConsole: vc, url: 'https://example.local/index.html',
    beforeParse(window){
      window.print = () => {}; window.confirm = () => true; window.alert = () => {};
      window.addEventListener('error', (e)=>pageErrors.push('WINDOW-ERROR: '+(e.error&&e.error.stack||e.message)));
      if(seedData){
        window.localStorage.setItem('gsas_data_v4', JSON.stringify(seedData));
      }
    }
  });
  const { window } = dom;
  window.HTMLCanvasElement.prototype.getContext = function(){ const noop=()=>{}; return new Proxy({}, {get:(t,p)=>(p in t?t[p]:noop)}); };
  const ev = (code) => window.eval(code);
  await wait(400);
  const currency = ev('DB.settings.currency');
  const currencyCode = ev('DB.settings.currencyCode');
  const migratedFlag = ev('DB.settings.kwdDisplayMigrated');
  console.log('  currency=' + currency, 'currencyCode=' + currencyCode, 'kwdDisplayMigrated=' + migratedFlag);
  console.log('  page errors:', pageErrors.length);
  pageErrors.forEach(e=>console.log('    ' + e));
  return { currency, currencyCode, migratedFlag, ev, window, pageErrors };
}

(async () => {
  // Scenario 1: brand-new install, no prior localStorage at all
  const s1 = await runScenario('Fresh install (no prior data)', null);
  assertEq('Fresh install defaults currencyCode to KWD', s1.currencyCode, 'KWD');
  assertEq('Fresh install defaults currency symbol to د.ك', s1.currency, 'د.ك');
  assertEq('Fresh install has zero page errors', s1.pageErrors.length, 0);

  // Scenario 2: an existing store that was already running before this update, with USD saved and no migration flag
  const legacyDB = {
    products: [{uid:'p1', name:'Legacy Product', barcode:'LP001', purchasePrice:1, sellingPrice:2, stock:10, minStock:2, openingStock:10, unit:'pcs'}],
    stockIns: [], sales: [{uid:'s1', id:'SALE-2026-0001', date:'2026-07-10', productId:'p1', qty:2, sellingPrice:2, totalAmount:4, amountDue:4, paymentMethod:'Cash', cashier:'admin', ts: Date.now()}],
    returns: [], customers: [], pos: [], notSelling: {}, users: [], counters: {}, auditLog: [], notifications: [],
    categories: [], brands: [], suppliers: [], cashbook: [], bankbook: [], coupons: [], giftcards: [], attendance: [], parkedSales: [],
    accounts: [], journal: [], expenses: [], requisitions: [], purchaseOrders: [], branches: [], transfers: [], shifts: [], payroll: [], leaves: [], bundles: [], bundleSales: [],
    rolePermissions: null,
    settings: { currency:'$', currencyCode:'USD', storeName:'My Kuwait Grocery', passwordExpiryDays:90, maxFailedAttempts:5, lockoutMinutes:15, sessionIdleTimeoutMinutes:20, maxCashierDiscountPercent:10, defaultPaperSize:'thermal80', vatRate:0, cashOpeningBalance:0, bankOpeningBalance:0, loyaltyEarnPercent:1, loyaltyPointValue:0.01 }
    // Note: intentionally NO kwdDisplayMigrated flag, and NO exchangeRates — simulates a database saved by an older version of the app before this feature existed.
  };
  const s2 = await runScenario('Existing store, previously saved with USD (pre-migration)', legacyDB);
  assertEq('Existing USD install auto-migrates currencyCode to KWD', s2.currencyCode, 'KWD');
  assertEq('Existing USD install auto-migrates currency symbol to د.ك', s2.currency, 'د.ك');
  assertEq('Migration flag now set', s2.migratedFlag, true);
  assertEq('Existing product data preserved through migration', s2.ev('DB.products.length'), 1);
  assertEq('Existing sales data preserved through migration', s2.ev('DB.sales.length'), 1);
  assertEq('Store name preserved through migration', s2.ev('DB.settings.storeName'), 'My Kuwait Grocery');
  assertEq('Existing USD install has zero page errors', s2.pageErrors.length, 0);
  // fmtMoney should now render with the KWD symbol
  const fmtSample = s2.ev('fmtMoney(4)');
  console.log('  fmtMoney(4) now renders as:', fmtSample);
  assertEq('fmtMoney uses KWD symbol after migration', fmtSample, 'د.ك4.00');

  // Scenario 3: a store that was already migrated once and explicitly chose a DIFFERENT currency afterward — must NOT be forced back to KWD
  const explicitChoiceDB = JSON.parse(JSON.stringify(legacyDB));
  explicitChoiceDB.settings.currency = '€';
  explicitChoiceDB.settings.currencyCode = 'EUR';
  explicitChoiceDB.settings.kwdDisplayMigrated = true; // already migrated once, then the owner deliberately switched to EUR
  const s3 = await runScenario('Store that already migrated once, then deliberately chose EUR', explicitChoiceDB);
  assertEq('Deliberate EUR choice after migration is respected (not forced back to KWD)', s3.currencyCode, 'EUR');
  assertEq('Deliberate EUR symbol respected', s3.currency, '€');
  assertEq('Explicit-choice scenario has zero page errors', s3.pageErrors.length, 0);

  console.log('---');
  console.log('Total assertion failures:', failures);
  process.exit(failures ? 1 : 0);
})().catch(e=>{ console.error('TEST CRASH:', e); process.exit(1); });
