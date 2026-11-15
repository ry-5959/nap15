// 브라우저에서 실제로 앱을 돌리며 단계별 화면을 찍는다.  실행: node tests/shots.js [outDir]
'use strict';
const path = require('path');
const fs = require('fs');
const { chromium } = require('playwright');

const out = path.resolve(process.argv[2] || path.join(__dirname, '..', 'out', 'shots'));
fs.mkdirSync(out, { recursive: true });
const url = 'file://' + path.resolve(__dirname, '..', 'web', 'index.html');

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1480, height: 860 }, deviceScaleFactor: 2 });
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(url);
  await page.waitForTimeout(600);

  const display = page.locator('#display');
  const snap = async (name, whole) => {
    await page.waitForTimeout(250);
    await (whole ? page : display).screenshot({ path: path.join(out, name + '.png') });
    console.log('shot', name);
  };
  const phase = () => page.evaluate(() => window.__napDebug.session.state.phase);
  const waitPhase = async (p, ms) => {
    await page.waitForFunction((want) => window.__napDebug.session.state.phase === want, p, { timeout: ms || 30000 });
  };

  await snap('00-page', true);
  await snap('01-home');

  // 기어 D: 시작 막힘
  await page.click('[data-gear="D"]');
  await snap('02-blocked');
  await page.click('[data-gear="P"]');

  // 60배속으로 한 사이클
  await page.click('[data-speed="60"]');
  await page.click('#start');
  await page.waitForTimeout(3600);
  await snap('03-settling');
  await waitPhase('sleeping', 20000);
  await page.waitForTimeout(1800);
  await snap('04-sleeping');
  await display.click({ position: { x: 300, y: 300 } });
  await snap('05-peek');
  await page.click('#keepSleeping');
  await waitPhase('waking', 30000);
  await page.waitForTimeout(1500);
  await snap('06-waking');
  await page.waitForTimeout(6000);
  await page.click('#ack');
  await page.waitForTimeout(700);
  await snap('07-ready');
  await page.click('#go');
  await snap('08-summary');
  await snap('09-page-after', true);
  await page.click('#home');

  // 더워져서 먼저 깨우기
  await page.click('#start');
  await waitPhase('sleeping', 20000);
  await page.fill('#tempRange', '33');
  await page.dispatchEvent('#tempRange', 'input');
  await waitPhase('waking', 20000);
  await page.waitForTimeout(800);
  await snap('10-waking-hot');
  await page.waitForTimeout(6500);
  await page.click('#ack');
  await page.click('#go');
  await page.click('#home');
  await page.fill('#tempRange', '23');
  await page.dispatchEvent('#tempRange', 'input');

  // 자는 중 기어 D
  await page.click('#start');
  await waitPhase('sleeping', 20000);
  await page.click('[data-gear="D"]');
  await page.waitForTimeout(600);
  await snap('11-gear-abort');
  console.log('phase after gear D:', await phase());
  await page.click('[data-gear="P"]');
  await page.click('#raise');
  await page.waitForTimeout(7000);
  await page.click('#home');

  // 세로 화면(좁은 앱 영역)
  await page.setViewportSize({ width: 560, height: 980 });
  await page.waitForTimeout(500);
  await snap('12-home-tall');

  console.log('console errors:', errors.length ? errors : 'none');
  await browser.close();
  process.exit(errors.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
