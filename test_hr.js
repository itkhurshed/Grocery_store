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

  // ---------- Set admin's HR fields (base salary + commission) ----------
  ev("showTab('users')");
  const adminUid = ev("DB.users.find(u=>u.username==='admin').uid");
  ev(`openUserModal(${JSON.stringify(adminUid)})`); await wait(30);
  doc.getElementById('u_baseSalary').value = '1000';
  doc.getElementById('u_commissionPercent').value = '5';
  ev(`saveUserForm(${JSON.stringify(adminUid)})`);
  await wait(50);
  assertEq('Base salary saved', ev(`DB.users.find(u=>u.uid===${JSON.stringify(adminUid)}).baseSalary`), 1000);
  assertEq('Commission % saved', ev(`DB.users.find(u=>u.uid===${JSON.stringify(adminUid)}).commissionPercent`), 5);

  // ---------- Shift open/close ----------
  ev("showTab('hr')");
  await wait(30);
  assertEq('No open shift initially', ev("!!activeShiftForUser(currentUser.uid)"), false);
  ev("openShift()"); await wait(30);
  doc.getElementById('sh_float').value = '100';
  ev("saveOpenShift()");
  await wait(50);
  assertEq('Shift count 1', ev('DB.shifts.length'), 1);
  const shiftUid = ev('DB.shifts[0].uid');
  assertEq('Shift status Open', ev(`DB.shifts.find(s=>s.uid===${JSON.stringify(shiftUid)}).status`), 'Open');

  // Make a cash sale during the shift
  const prodUid = ev('DB.products[0].uid');
  ev("showTab('sales')");
  ev("openSaleModal()"); await wait(30);
  doc.getElementById('v_product').value = prodUid;
  doc.getElementById('v_product').dispatchEvent(new window.Event('change'));
  doc.getElementById('v_qty').value = '2';
  doc.getElementById('v_qty').dispatchEvent(new window.Event('input'));
  doc.getElementById('v_payment').value = 'Cash';
  doc.getElementById('v_payment').dispatchEvent(new window.Event('change'));
  doc.getElementById('v_cashier').value = 'admin';
  await ev('saveSaleForm(null)');
  await wait(50);
  const saleTotal = ev('DB.sales[DB.sales.length-1].totalAmount');
  log('Cash sale total during shift', saleTotal);

  const expectedNow = ev(`computeExpectedCash(DB.shifts.find(s=>s.uid===${JSON.stringify(shiftUid)}))`);
  assertEq('Expected cash = opening float + cash sale', expectedNow, round2(100+saleTotal));

  // Close shift with a $5 shortage
  ev("showTab('hr')");
  ev(`openCloseShiftModal(${JSON.stringify(shiftUid)})`); await wait(30);
  const countedCash = round2(expectedNow - 5);
  doc.getElementById('sh_counted').value = String(countedCash);
  ev(`saveCloseShift(${JSON.stringify(shiftUid)})`);
  await wait(50);
  const closedShift = ev(`DB.shifts.find(s=>s.uid===${JSON.stringify(shiftUid)})`);
  assertEq('Shift status Closed', closedShift.status, 'Closed');
  assertEq('Variance is -5', closedShift.variance, -5);
  assertEq('Can open a new shift after closing', ev("!!activeShiftForUser(currentUser.uid)"), false);

  // ---------- Payroll ----------
  const journalCountBeforePayroll = ev('DB.journal.length');
  const bankBefore = ev("accountBalance('1010')");
  const now = new Date();
  const period = now.getFullYear() + '-' + String(now.getMonth()+1).padStart(2,'0');
  ev("openRunPayrollModal()"); await wait(30);
  doc.getElementById('pr_period').value = period;
  doc.getElementById('pr_paysource').value = 'Bank';
  ev("runPayrollForPeriod()");
  await wait(50);
  assertEq('Payroll record created for admin', ev(`DB.payroll.filter(p=>p.username==='admin' && p.period===${JSON.stringify(period)}).length`), 1);
  const payRec = ev(`DB.payroll.find(p=>p.username==='admin' && p.period===${JSON.stringify(period)})`);
  log('Payroll record for admin', JSON.stringify(payRec));
  assertEq('Base salary matches', payRec.baseSalary, 1000);
  // Commission = 5% of admin's total sales this month (includes the sale made above, plus any sample data sales by admin this month)
  const adminSalesThisMonth = ev(`DB.sales.filter(s=>s.cashier==='admin' && s.date>=${JSON.stringify(period+'-01')}).reduce((a,s)=>a+s.totalAmount,0)`);
  assertEq('Commission = 5% of admin sales this period', payRec.commission, round2(adminSalesThisMonth*0.05));
  assertEq('Net pay = base + commission', payRec.netPay, round2(1000 + payRec.commission));

  assertEq('Journal grew by 1 for payroll run', ev('DB.journal.length'), journalCountBeforePayroll + 1);
  assertEq('Bank decreased by net pay total', ev("accountBalance('1010')"), round2(bankBefore - payRec.netPay));

  // Running payroll again for the same period should skip (already exists)
  ev("openRunPayrollModal()"); await wait(30);
  doc.getElementById('pr_period').value = period;
  doc.getElementById('pr_paysource').value = 'Bank';
  ev("runPayrollForPeriod()");
  await wait(50);
  assertEq('No duplicate payroll record for same employee/period', ev(`DB.payroll.filter(p=>p.username==='admin' && p.period===${JSON.stringify(period)}).length`), 1);

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
  assertEq('Trial balance stays balanced after payroll', checkTrialBalanceBalanced(), 0);

  // ---------- Leave management ----------
  ev("showTab('hr')");
  ev("openLeaveModal()"); await wait(30);
  doc.getElementById('lv_user').value = adminUid;
  doc.getElementById('lv_type').value = 'Annual';
  doc.getElementById('lv_from').value = '2026-08-01';
  doc.getElementById('lv_to').value = '2026-08-05';
  doc.getElementById('lv_reason').value = 'Vacation';
  ev("saveLeaveForm()");
  await wait(50);
  assertEq('Leave request created', ev('DB.leaves.length'), 1);
  const leaveUid = ev('DB.leaves[0].uid');
  assertEq('Leave days computed (Aug 1-5 = 5 days)', ev(`DB.leaves.find(l=>l.uid===${JSON.stringify(leaveUid)}).days`), 5);
  assertEq('Leave status Pending', ev(`DB.leaves.find(l=>l.uid===${JSON.stringify(leaveUid)}).status`), 'Pending');

  ev(`approveLeave(${JSON.stringify(leaveUid)})`);
  await wait(30);
  assertEq('Leave status Approved', ev(`DB.leaves.find(l=>l.uid===${JSON.stringify(leaveUid)}).status`), 'Approved');

  console.log('---');
  console.log('Total page errors:', pageErrors.length);
  pageErrors.forEach(e=>console.log('  ' + e));
  console.log('Total assertion failures:', failures);
  process.exit((pageErrors.length || failures) ? 1 : 0);
})().catch(e=>{ console.error('TEST CRASH:', e); process.exit(1); });
