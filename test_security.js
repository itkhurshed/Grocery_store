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
// jsdom's window.crypto lacks .subtle (Web Crypto's async API) — polyfill with Node's own webcrypto implementation for this test run only.
// This mirrors what every real browser (Chrome/Firefox/Edge/Safari) provides natively, including on file:// origins.
Object.defineProperty(window.crypto, 'subtle', { value: nodeCrypto.webcrypto.subtle, configurable: true });
const ev = (code) => window.eval(code);
function wait(ms){ return new Promise(r=>setTimeout(r,ms)); }
function log(l,v){ console.log(l+':', v); }
let failures = 0;
function assertEq(label, actual, expected){
  const ok = actual===expected || JSON.stringify(actual)===JSON.stringify(expected);
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

  // ---------- TOTP core correctness (RFC 6238 test vector) ----------
  // RFC 6238 Appendix B test vector uses SHA1, 8-digit codes with the ASCII secret "12345678901234567890" (base32: GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ)
  // Our implementation uses 6 digits (Google-Authenticator-compatible default), so we verify against a known base32 secret + a fixed Unix time
  // by cross-checking with Node's own crypto HMAC-SHA1 computed independently (not reusing the app's own code) for the same counter.
  function independentTotp(base32Secret, timeMs){
    const decoded = ev(`base32Decode(${JSON.stringify(base32Secret)})`); // reuse app's base32 decode (already covered by round-trip test below)
    const keyBytes = Buffer.from(Object.values(decoded));
    const counter = Math.floor(timeMs/1000/30);
    const counterBuf = Buffer.alloc(8);
    counterBuf.writeUInt32BE(counter >>> 0, 4);
    const hmac = nodeCrypto.createHmac('sha1', keyBytes).update(counterBuf).digest();
    const offset = hmac[hmac.length-1] & 0xf;
    const code = ((hmac[offset]&0x7f)<<24 | (hmac[offset+1]&0xff)<<16 | (hmac[offset+2]&0xff)<<8 | (hmac[offset+3]&0xff)) % 1000000;
    return String(code).padStart(6,'0');
  }
  const testSecret = ev('generateTotpSecret()');
  log('Generated TOTP secret', testSecret);
  assertTrue('Secret is valid base32 (only A-Z2-7)', /^[A-Z2-7]+$/.test(testSecret));
  const fixedTime = 1751000000000; // arbitrary fixed timestamp
  const appCode = await ev(`computeTotp(${JSON.stringify(testSecret)}, ${fixedTime})`);
  const independentCode = independentTotp(testSecret, fixedTime);
  assertEq('App TOTP computation matches independent Node crypto HMAC-SHA1 computation', appCode, independentCode);

  // Base32 round-trip
  const rtBytes = ev(`Array.from(base32Decode(base32Encode(new Uint8Array([1,2,3,4,5,255,128,0]))))`);
  assertEq('base32 encode/decode round-trip', rtBytes, [1,2,3,4,5,255,128,0]);

  // verifyTotp accepts the current valid code and rejects a wrong one
  const currentValid = await ev(`computeTotp(${JSON.stringify(testSecret)})`);
  const acceptsValid = await ev(`verifyTotp(${JSON.stringify(testSecret)}, ${JSON.stringify(currentValid)})`);
  assertTrue('verifyTotp accepts a currently-valid code', acceptsValid);
  const rejectsWrong = await ev(`verifyTotp(${JSON.stringify(testSecret)}, '000000')`);
  // there's an astronomically small chance '000000' is actually correct; treat as pass either way logged
  log('verifyTotp on ~always-wrong code 000000 (expect false)', rejectsWrong);

  // ---------- Full enrollment + login-gate flow through the actual UI ----------
  ev("showTab('reports')");
  await wait(30);
  assertEq('2FA initially disabled for admin', ev('currentUser.twoFactorEnabled'), undefined);

  ev("openEnroll2faModal()");
  await wait(30);
  const pendingSecret = ev('window._pending2faSecret');
  assertTrue('Enrollment modal generated a pending secret', !!pendingSecret);
  const modalHtml = doc.getElementById('modalBody').innerHTML;
  assertTrue('Enrollment modal shows an img (QR code)', modalHtml.includes('<img'));
  assertTrue('Enrollment modal shows the manual key', modalHtml.includes(pendingSecret));

  const enrollCode = await ev(`computeTotp(window._pending2faSecret)`);
  doc.getElementById('tf_confirmCode').value = enrollCode;
  await ev('confirmEnroll2fa()');
  await wait(50);
  assertEq('2FA now enabled on the user record', ev("DB.users.find(u=>u.username==='admin').twoFactorEnabled"), true);
  assertEq('2FA secret stored', ev("DB.users.find(u=>u.username==='admin').twoFactorSecret"), pendingSecret);

  // Log out and log back in — should now be gated by the 2FA challenge screen
  ev('doLogout()');
  await wait(50);
  doc.getElementById('loginUsername').value='admin';
  doc.getElementById('loginPassword').value='admin123';
  ev('doLogin()');
  await wait(100);
  assertTrue('2FA challenge box is now visible after correct password', !doc.getElementById('twofaBox').classList.contains('hidden'));
  assertTrue('App screen still hidden (not logged in yet)', doc.getElementById('app').classList.contains('hidden'));

  // Wrong code should be rejected
  doc.getElementById('twofaCode').value = '111111';
  await ev('verify2faAndLogin()');
  await wait(50);
  assertTrue('App still hidden after wrong 2FA code', doc.getElementById('app').classList.contains('hidden'));

  // Correct code should log in
  const loginCode = await ev(`computeTotp(${JSON.stringify(pendingSecret)})`);
  doc.getElementById('twofaCode').value = loginCode;
  await ev('verify2faAndLogin()');
  await wait(100);
  assertTrue('App visible after correct 2FA code', !doc.getElementById('app').classList.contains('hidden'));
  assertEq('currentUser set after 2FA login', ev('currentUser.username'), 'admin');

  // Disable 2FA
  ev("showTab('reports')");
  await ev('disable2fa()');
  await wait(50);
  assertEq('2FA disabled again', ev("DB.users.find(u=>u.username==='admin').twoFactorEnabled"), false);

  // ---------- AES-GCM encrypted backup round-trip ----------
  const originalProductCount = ev('DB.products.length');
  const originalSaleCount = ev('DB.sales.length');
  const passphrase = 'Test-Passphrase-123!';
  const encJson = await ev(`(async()=>{
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const key = await deriveAesKey(${JSON.stringify(passphrase)}, salt);
    const plaintext = new TextEncoder().encode(JSON.stringify(DB));
    const ciphertext = await crypto.subtle.encrypt({name:'AES-GCM', iv}, key, plaintext);
    return JSON.stringify({ format:'FreshMartEncryptedBackup', version:1, salt: bytesToBase64(salt), iv: bytesToBase64(iv), data: bytesToBase64(new Uint8Array(ciphertext)) });
  })()`);
  const payload = JSON.parse(encJson);
  assertEq('Encrypted payload format tag correct', payload.format, 'FreshMartEncryptedBackup');
  assertTrue('Ciphertext is non-trivial base64', payload.data.length > 100);
  assertTrue('Ciphertext does not contain plaintext product data', !encJson.includes('Coca Cola'));

  // Decrypt with correct passphrase — should recover exact original DB
  const decryptedJson = await ev(`(async()=>{
    const payload = ${JSON.stringify(payload)};
    const salt = base64ToBytes(payload.salt);
    const iv = base64ToBytes(payload.iv);
    const key = await deriveAesKey(${JSON.stringify(passphrase)}, salt);
    const ciphertext = base64ToBytes(payload.data);
    const plainBuf = await crypto.subtle.decrypt({name:'AES-GCM', iv}, key, ciphertext);
    return new TextDecoder().decode(plainBuf);
  })()`);
  const decrypted = JSON.parse(decryptedJson);
  assertEq('Decrypted product count matches original', decrypted.products.length, originalProductCount);
  assertEq('Decrypted sales count matches original', decrypted.sales.length, originalSaleCount);

  // Decrypt with WRONG passphrase should fail (AES-GCM auth tag mismatch throws)
  let wrongPassphraseThrew = false;
  try{
    await ev(`(async()=>{
      const payload = ${JSON.stringify(payload)};
      const salt = base64ToBytes(payload.salt);
      const iv = base64ToBytes(payload.iv);
      const key = await deriveAesKey('WRONG-passphrase', salt);
      const ciphertext = base64ToBytes(payload.data);
      await crypto.subtle.decrypt({name:'AES-GCM', iv}, key, ciphertext);
    })()`);
  }catch(e){ wrongPassphraseThrew = true; }
  assertTrue('Decryption with wrong passphrase throws (auth tag mismatch)', wrongPassphraseThrew);

  console.log('---');
  console.log('Total page errors:', pageErrors.length);
  pageErrors.forEach(e=>console.log('  ' + e));
  console.log('Total assertion failures:', failures);
  process.exit((pageErrors.length || failures) ? 1 : 0);
})().catch(e=>{ console.error('TEST CRASH:', e); process.exit(1); });
