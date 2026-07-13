const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');
const html = fs.readFileSync(path.join(__dirname, 'test_inlined.html'), 'utf-8');
const vc = new VirtualConsole();
const pageErrors = [];
vc.on('jsdomError', (e) => { if (!/Not implemented/.test(e.message)) pageErrors.push('jsdomError: ' + e.message); });
vc.on('error', (...a)=>pageErrors.push('console.error: ' + a.join(' ')));
const dom = new JSDOM(html, { runScripts: 'dangerously', pretendToBeVisual: true, virtualConsole: vc, url: 'https://example.local/index.html',
  beforeParse(window){ window.print=()=>{}; window.confirm=()=>true; window.alert=()=>{}; }
});
const { window } = dom;
window.HTMLCanvasElement.prototype.getContext = function(){ const noop=()=>{}; return new Proxy({}, {get:(t,p)=>(p in t?t[p]:noop)}); };
window.addEventListener('error', (e)=>pageErrors.push('WINDOW-ERROR: '+(e.error&&e.error.stack||e.message)));
const ev = (code) => window.eval(code);
function wait(ms){ return new Promise(r=>setTimeout(r,ms)); }
let failures = 0;
function assertEq(label, actual, expected){
  const ok = actual===expected;
  console.log((ok?'PASS':'FAIL')+' - '+label+': got '+JSON.stringify(actual)+' expected '+JSON.stringify(expected));
  if(!ok) failures++;
}
function assertTrue(label, cond){
  console.log((cond?'PASS':'FAIL')+' - '+label);
  if(!cond) failures++;
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

  // --- fmtMoney now uses plain English ISO code, no bidi-glitching native symbol ---
  assertEq('fmtMoney uses English KWD code suffix', ev('fmtMoney(14)'), '14.00 KWD');
  assertTrue('fmtMoney output contains only ASCII characters', /^[\x00-\x7F]*$/.test(ev('fmtMoney(14)')));

  // --- All 20 currencies present with flags ---
  const codes = ev('PAYMENT_CURRENCIES.map(c=>c.code)');
  const expected = ['KWD','USD','EUR','GBP','CHF','CAD','AUD','NZD','JPY','CNY','HKD','SGD','INR','PKR','BDT','SAR','AED','QAR','BHD','OMR'];
  assertEq('PAYMENT_CURRENCIES has all 20 expected codes in order', JSON.stringify(codes), JSON.stringify(expected));
  const missingFlags = ev("PAYMENT_CURRENCIES.filter(c=>!c.flag).map(c=>c.code)");
  assertEq('Every currency has a flag emoji', JSON.stringify(missingFlags), '[]');

  // --- DEFAULT_EXCHANGE_RATES has a rate for every currency ---
  const missingRates = ev("PAYMENT_CURRENCIES.filter(c=>DEFAULT_EXCHANGE_RATES[c.code]==null).map(c=>c.code)");
  assertEq('Every currency has a default exchange rate', JSON.stringify(missingRates), '[]');

  // --- Sale form: payment currency select includes flags and all codes ---
  ev("showTab('sales')");
  ev("openSaleModal()"); await wait(30);
  const selHtml = doc.getElementById('v_paymentCurrency').innerHTML;
  assertTrue('Payment currency select includes CHF', selHtml.includes('CHF'));
  assertTrue('Payment currency select includes OMR', selHtml.includes('OMR'));
  assertTrue('Payment currency select includes a flag emoji (Kuwait)', selHtml.includes('🇰🇼'));
  ev('closeModal()');

  // --- fmtForeign returns plain number, no duplicated code (since every call site already labels the code) ---
  const foreignVal = ev("fmtForeign(10, 'USD')");
  assertTrue('fmtForeign returns a plain number string, no embedded code', /^\d+\.\d{2}$/.test(foreignVal));

  // --- Settings > Payment Currency Conversion panel now dynamically covers all 19 non-KWD currencies ---
  ev("showTab('reports')");
  await wait(50);
  const fieldCount = doc.querySelectorAll('#exchangeRateFields .field').length;
  assertEq('Exchange rate fields rendered for all 19 non-KWD currencies', fieldCount, 19);
  const chfInput = doc.getElementById('fx_CHF');
  assertTrue('fx_CHF input exists and is pre-filled', !!chfInput && Number(chfInput.value) > 0);
  const omrInput = doc.getElementById('fx_OMR');
  assertTrue('fx_OMR input exists and is pre-filled', !!omrInput && Number(omrInput.value) > 0);

  // --- Editing and saving a new rate round-trips correctly ---
  chfInput.value = '2.5';
  const btn = doc.querySelector('[data-act="save-exchange-rates"]');
  btn.dispatchEvent(new window.Event('click', {bubbles:true}));
  await wait(30);
  assertEq('Edited CHF rate persisted to DB.settings.exchangeRates', ev('DB.settings.exchangeRates.CHF'), 2.5);
  assertEq('getExchangeRate reflects the edited rate', ev("getExchangeRate('CHF')"), 2.5);

  // --- Full currency conversion round trip through a real sale using a newly-added currency (QAR) ---
  ev("showTab('sales')");
  ev("openSaleModal()"); await wait(30);
  const prodUid = ev('DB.products[0].uid');
  doc.getElementById('v_product').value = prodUid;
  doc.getElementById('v_product').dispatchEvent(new window.Event('change'));
  doc.getElementById('v_qty').value = '2';
  doc.getElementById('v_qty').dispatchEvent(new window.Event('input'));
  doc.getElementById('v_payment').value = 'Cash';
  doc.getElementById('v_payment').dispatchEvent(new window.Event('change'));
  doc.getElementById('v_paymentCurrency').value = 'QAR';
  doc.getElementById('v_paymentCurrency').dispatchEvent(new window.Event('change', {bubbles:true}));
  doc.getElementById('v_cashier').value = 'admin';
  const saleUid = await ev('saveSaleForm(null)');
  await wait(50);
  assertTrue('Sale with QAR payment currency saved', !!saleUid);
  assertEq('Sale recorded paymentCurrency = QAR', ev(`DB.sales.find(s=>s.uid===${JSON.stringify(saleUid)}).paymentCurrency`), 'QAR');
  const totalKWD = ev(`DB.sales.find(s=>s.uid===${JSON.stringify(saleUid)}).totalAmount`);
  const foreignAmt = ev(`DB.sales.find(s=>s.uid===${JSON.stringify(saleUid)}).paymentAmountForeign`);
  const expectedForeign = ev(`convertFromKWD(${totalKWD}, 'QAR')`);
  assertEq('paymentAmountForeign correctly converted via QAR rate', foreignAmt, expectedForeign);

  console.log('---');
  console.log('Total page errors:', pageErrors.length);
  pageErrors.forEach(e=>console.log('  ' + e));
  console.log('Total assertion failures:', failures);
  process.exit((pageErrors.length || failures) ? 1 : 0);
})().catch(e=>{ console.error('TEST CRASH:', e); process.exit(1); });
