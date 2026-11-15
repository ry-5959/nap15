// 차량(WebView) 모드 점검: window.NapNative 를 흉내 내어 화면이 네이티브 다리와 제대로 주고받는지 본다.
// 실행: NODE_PATH=<playwright 위치> node tests/native-mode.js [outDir]
'use strict';
const path = require('path');
const fs = require('fs');
const assert = require('assert');
const { chromium } = require('playwright');

const out = path.resolve(process.argv[2] || path.join(__dirname, '..', 'out', 'shots'));
fs.mkdirSync(out, { recursive: true });
const url = 'file://' + path.resolve(__dirname, '..', 'web', 'index.html');

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 2 });
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error' && !/fonts\.g/.test(m.text())) errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));

  // 코틀린 NapBridge 와 같은 모양의 가짜 다리
  await page.addInitScript(() => {
    window.__acts = [];
    window.__spoken = [];
    window.NapNative = {
      act: (kind, value) => { window.__acts.push(kind + ':' + value); return kind !== 'closeWindows'; },
      speak: (t) => { window.__spoken.push(t); },
      stopSpeaking: () => {},
      capabilities: () => JSON.stringify({ doorLock: true, windows: false, recirc: true, backrest: true, fan: true }),
    };
  });
  await page.goto(url);
  await page.waitForTimeout(500);
  const signals = (s) => page.evaluate((x) => window.__nap.onSignals(JSON.stringify(x)), s);
  const phase = () => page.evaluate(() => window.__napDebug.session.state.phase);
  const base = { brake: false, doorOpen: false, doorLocked: false, windowsOpen: false, rearOccupied: false, cabinTempC: 22.5, recircOn: true, fan: 2,
    capabilities: { doorLock: true, windows: false, recirc: true, backrest: true, fan: true } };

  assert.ok(await page.evaluate(() => document.body.classList.contains('native')), '네이티브 모드 표시');
  assert.strictEqual(await page.evaluate(() => window.__napDebug.vehicle.kind), 'pleos');

  // 1) 기어를 아직 모를 때는 시작이 막힌다
  await page.click('#start', { force: true }).catch(() => {});
  assert.strictEqual(await phase(), 'home', '기어 모름 → 시작 안 함');
  await page.screenshot({ path: path.join(out, 'native-01-unknown-gear.png') });

  // 2) 차량 신호가 들어오면 시작된다
  await signals(Object.assign({ gear: 'P' }, base));
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(out, 'native-02-home.png') });
  await page.evaluate(() => window.__napDebug.session.setSpeed(60));
  await page.click('#start');
  assert.strictEqual(await phase(), 'settling');
  await page.waitForFunction(() => window.__napDebug.session.state.phase === 'sleeping', null, { timeout: 20000 });
  const acts = await page.evaluate(() => window.__acts.slice());
  assert.deepStrictEqual(acts.filter((a) => !a.startsWith('dim')),
    ['lockDoors:true', 'recirc:false', 'backrest:BACKWARD', 'backrest:STOP'], '창문 제어가 없는 차: ' + acts.join(' | '));
  assert.ok(acts.some((a) => a.startsWith('dim:')), '화면 어둡게 요청');
  await page.screenshot({ path: path.join(out, 'native-03-sleeping.png') });

  // 3) 자는 중 문이 열리면 깨운다
  await signals(Object.assign({ gear: 'P' }, base, { doorOpen: true, doorLocked: false }));
  await page.waitForFunction(() => window.__napDebug.session.state.phase === 'waking', null, { timeout: 5000 });
  const st = await page.evaluate(() => window.__napDebug.session.state.wakeReason);
  assert.strictEqual(st, 'door');
  await page.waitForTimeout(800);
  await page.screenshot({ path: path.join(out, 'native-04-waking-door.png') });
  const spoken = await page.evaluate(() => window.__spoken.slice());
  assert.ok(spoken.length >= 2, '음성 안내가 다리로 전달됨: ' + spoken.length);
  const after = await page.evaluate(() => window.__acts.slice());
  assert.ok(after.includes('backrest:FORWARD'), '깨울 때 등받이 세우기');

  // 4) 기어가 P를 벗어나면 즉시 멈춘다
  await signals(Object.assign({ gear: 'D' }, base));
  await page.waitForFunction(() => window.__napDebug.session.state.phase === 'summary', null, { timeout: 5000 });

  console.log('acts:', after.join(' | '));
  console.log('spoken:', spoken.length, '문장');
  console.log('console errors:', errors.length ? errors : 'none');
  assert.strictEqual(errors.length, 0);
  await browser.close();
  console.log('네이티브 모드 점검 통과');
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
