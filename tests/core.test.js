// 15분만 — 세션 로직 테스트.  실행: node tests/core.test.js
'use strict';
const assert = require('assert');
const { NapSession, DEFAULTS } = require('../web/js/core.js');

function makeVehicle(over) {
  const v = {
    signals: Object.assign({ gear: 'P', brake: false, doorOpen: false, windowsOpen: false, rearOccupied: false, cabinTempC: 23, recircOn: true, fan: 2 }, (over && over.signals) || {}),
    capabilities: Object.assign({ doorLock: true, windows: true, recirc: true, backrest: true, fan: true }, (over && over.capabilities) || {}),
    log: [],
    act(kind, value) { this.log.push(kind + ':' + value); return true; }
  };
  return v;
}
function makeVoice() {
  return { said: [], chimes: 0, speak(t) { this.said.push(t); }, stop() {}, chime() { this.chimes++; } };
}
function make(over) {
  const vehicle = makeVehicle(over);
  const voice = makeVoice();
  const records = [];
  const session = new NapSession({ vehicle, voice, store: { add: (r) => records.push(r), now: () => 0 } });
  return { vehicle, voice, session, records };
}
/** 실제 시간 ms만큼 250ms 단위로 흘려보낸다. */
function run(session, ms, step) {
  step = step || 250;
  for (let t = 0; t < ms; t += step) session.tick(step);
}
function count(log, item) { return log.filter((x) => x === item).length; }

const tests = [];
function test(name, fn) { tests.push([name, fn]); }

test('정상 흐름: 준비 → 15분 수면 → 등받이가 깨움 → 출발 준비 → 요약', () => {
  const { vehicle, voice, session, records } = make();
  assert.strictEqual(session.start().ok, true);
  assert.strictEqual(session.state.phase, 'settling');
  run(session, 12000);
  assert.strictEqual(session.state.phase, 'sleeping');
  assert.deepStrictEqual(vehicle.log, ['lockDoors:true', 'recirc:false', 'backrest:BACKWARD', 'backrest:STOP', 'dim:0.06']);
  assert.ok(/15분 뒤에 깨울게요/.test(voice.said[0]));
  run(session, 14 * 60000);
  assert.strictEqual(session.state.phase, 'sleeping', '14분에는 아직 자는 중');
  run(session, 61000);
  assert.strictEqual(session.state.phase, 'waking');
  assert.strictEqual(session.state.wakeReason, 'time');
  assert.strictEqual(voice.chimes, 1);
  assert.ok(vehicle.log.includes('backrest:FORWARD'), '깨울 때 등받이를 세운다');
  run(session, 7000);
  assert.strictEqual(count(vehicle.log, 'backrest:STOP'), 2, '눕힌 만큼 세우고 멈춘다');
  assert.strictEqual(session.reclineRatio(), 0);
  session.acknowledge();
  assert.strictEqual(session.state.phase, 'ready');
  assert.ok(vehicle.log.includes('recirc:true'), '원래 내기순환이었으면 되돌린다');
  run(session, 121000);
  assert.strictEqual(session.state.phase, 'summary');
  assert.strictEqual(records.length, 1);
  assert.strictEqual(records[0].minutes, 15);
});

test('기어가 P가 아니면 시작하지 않는다', () => {
  for (const gear of ['D', 'R', 'N', '?']) {
    const { session, vehicle } = make({ signals: { gear } });
    const r = session.start();
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.blockers[0].id, 'gear');
    assert.strictEqual(vehicle.log.length, 0, '차에 아무 명령도 보내지 않는다');
  }
});

test('문이 열려 있으면 시작하지 않는다', () => {
  const { session } = make({ signals: { doorOpen: true } });
  assert.strictEqual(session.start().blockers[0].id, 'door');
});

test('뒷좌석에 사람이 있거나 확인이 안 되면 절반만 눕힌다', () => {
  for (const rear of [true, null]) {
    const { session } = make({ signals: { rearOccupied: rear } });
    session.start();
    run(session, 12000);
    assert.strictEqual(session.state.phase, 'sleeping');
    assert.strictEqual(session.reclineRatio(), 0.5);
    assert.ok(/절반만/.test(session.state.steps.find((s) => s.id === 'recline').note));
  }
});

test('자는 중 기어가 P를 벗어나면 즉시 멈추고 시트는 움직이지 않는다', () => {
  const { session, vehicle } = make();
  session.start();
  run(session, 12000);
  vehicle.log.length = 0;
  vehicle.signals.gear = 'D';
  session.tick(250);
  assert.strictEqual(session.state.phase, 'summary');
  assert.strictEqual(session.state.wakeReason, 'gear');
  assert.ok(!vehicle.log.includes('backrest:FORWARD'), 'P가 아닐 때는 등받이를 세우지 않는다');
  assert.strictEqual(session.raiseSeat(), false, 'D에서는 등받이 세우기도 거부');
  vehicle.signals.gear = 'P';
  assert.strictEqual(session.raiseSeat(), true);
  run(session, 7000);
  assert.strictEqual(session.reclineRatio(), 0);
});

test('등받이를 세우는 도중 기어가 바뀌면 바로 멈춘다', () => {
  const { session, vehicle } = make();
  session.start();
  run(session, 12000);
  session.wakeNow();
  run(session, 1000);
  vehicle.signals.gear = 'R';
  session.tick(250);
  assert.strictEqual(vehicle.log[vehicle.log.length - 1 - vehicle.log.slice().reverse().findIndex((x) => x.startsWith('backrest'))], 'backrest:STOP');
  assert.strictEqual(session.state.phase, 'summary');
  assert.ok(session.seatLeftover() > 0, '덜 세운 만큼 기억한다');
});

test('브레이크는 뗐다가 다시 밟을 때만 깨운다', () => {
  const { session, vehicle } = make({ signals: { brake: true } });
  session.start();
  run(session, 12000);
  run(session, 5000);
  assert.strictEqual(session.state.phase, 'sleeping', '밟은 채 잠들면 깨우지 않는다');
  vehicle.signals.brake = false;
  run(session, 1000);
  vehicle.signals.brake = true;
  session.tick(250);
  assert.strictEqual(session.state.phase, 'waking');
  assert.strictEqual(session.state.wakeReason, 'brake');
});

test('실내가 30°C 이상으로 10초 이어지면 먼저 깨운다. 잠깐 튄 값은 무시한다', () => {
  const { session, vehicle, voice } = make();
  session.start();
  run(session, 12000);
  vehicle.signals.cabinTempC = 31;
  run(session, 5000);
  vehicle.signals.cabinTempC = 24;
  run(session, 20000);
  assert.strictEqual(session.state.phase, 'sleeping', '5초짜리 튐은 무시');
  vehicle.signals.cabinTempC = 32;
  run(session, 10500);
  assert.strictEqual(session.state.phase, 'waking');
  assert.strictEqual(session.state.wakeReason, 'hot');
  assert.ok(/32도까지 올라서/.test(voice.said[voice.said.length - 1]));
});

test('실내가 8°C 이하로 내려가도 먼저 깨운다', () => {
  const { session, vehicle } = make();
  session.start();
  run(session, 12000);
  vehicle.signals.cabinTempC = 6;
  run(session, 10500);
  assert.strictEqual(session.state.wakeReason, 'cold');
});

test('문이 열리면 깨운다', () => {
  const { session, vehicle } = make();
  session.start();
  run(session, 12000);
  vehicle.signals.doorOpen = true;
  session.tick(250);
  assert.strictEqual(session.state.wakeReason, 'door');
});

test('제어 기능이 없는 차: 단계는 건너뛰고, 시간 깨우기는 그대로 된다', () => {
  const { session, vehicle } = make({ capabilities: { doorLock: false, windows: false, recirc: false, backrest: false, fan: false }, signals: { windowsOpen: true } });
  session.start();
  run(session, 6000);
  assert.strictEqual(session.state.phase, 'sleeping');
  assert.deepStrictEqual(session.state.steps.map((s) => s.status), ['skipped', 'skipped', 'skipped', 'skipped', 'done']);
  assert.ok(!vehicle.log.some((x) => x.startsWith('backrest')));
  run(session, 15 * 60000 + 1000);
  assert.strictEqual(session.state.phase, 'waking');
});

test('눕히는 중 화면을 건드리면 멈추고, 깨울 때는 눕힌 만큼만 세운다', () => {
  const { session, vehicle } = make();
  session.start();
  run(session, 2100 + 2000); // 등받이가 움직이기 시작한 뒤 2초
  assert.strictEqual(session.state.seatMoving, 'BACKWARD');
  assert.strictEqual(session.stopSeatNow(), true);
  const ratio = session.reclineRatio();
  assert.ok(ratio > 0.2 && ratio < 0.5, '부분만 누움: ' + ratio);
  run(session, 2000);
  assert.strictEqual(session.state.phase, 'sleeping');
  session.wakeNow();
  run(session, 6000);
  assert.strictEqual(session.reclineRatio(), 0);
});

test('대답이 없으면 15초마다 다시 깨우고, 두 번째에는 바람을 올린다. 일어나면 되돌린다', () => {
  const { session, vehicle, voice } = make();
  session.start();
  run(session, 12000);
  session.wakeNow();
  run(session, 15250);
  assert.strictEqual(session.state.nudges, 1);
  assert.ok(!vehicle.log.includes('fan:3'));
  run(session, 15000);
  assert.strictEqual(session.state.nudges, 2);
  assert.ok(vehicle.log.includes('fan:3'), '풍량 2 → 3');
  run(session, 10 * 15000);
  assert.strictEqual(session.state.nudges, DEFAULTS.maxNudges, '최대 횟수에서 멈춘다');
  session.acknowledge();
  assert.ok(vehicle.log.includes('fan:2'), '풍량 원래대로');
  assert.ok(voice.chimes >= 3);
});

test('시간은 5~30분으로 제한한다', () => {
  const { session } = make();
  session.setMinutes(2); assert.strictEqual(session.state.minutes, 5);
  session.setMinutes(90); assert.strictEqual(session.state.minutes, 30);
  session.setMinutes(20); assert.strictEqual(session.state.minutes, 20);
});

test('시연 배속 ×60: 15분 쪽잠이 실제 15초에 끝난다', () => {
  const { session } = make();
  session.setSpeed(60);
  session.start();
  let guard = 0;
  while (session.state.phase !== 'sleeping' && guard++ < 200) session.tick(250);
  run(session, 14000);
  assert.strictEqual(session.state.phase, 'sleeping', '14초에는 아직 자는 중');
  run(session, 1500);
  assert.strictEqual(session.state.phase, 'waking');
});

test('직접 일어나면 잔 시간만 기록한다', () => {
  const { session, records } = make();
  session.start();
  run(session, 12000);
  run(session, 6 * 60000);
  session.wakeNow();
  assert.strictEqual(session.state.wakeReason, 'manual');
  session.acknowledge();
  session.finish();
  assert.strictEqual(records[0].minutes, 6);
});

test('기어 때문에 멈춘 뒤 다시 시작하면 모자란 만큼만 더 눕힌다', () => {
  const { session, vehicle } = make();
  session.start();
  run(session, 12000);
  vehicle.signals.gear = 'D';
  session.tick(250);
  vehicle.signals.gear = 'P';
  session.reset();
  vehicle.log.length = 0;
  session.start();
  run(session, 6000);
  assert.strictEqual(session.state.phase, 'sleeping');
  assert.ok(!vehicle.log.includes('backrest:BACKWARD'), '이미 누워 있으므로 더 눕히지 않는다');
  session.wakeNow();
  run(session, 7000);
  assert.strictEqual(session.reclineRatio(), 0, '깨울 때는 전부 세운다');
});

test('준비 중에 그만두면 바꾼 것을 되돌리고 처음 화면으로 간다', () => {
  const { session, vehicle } = make();
  session.start();
  run(session, 2100 + 3000);
  session.cancel();
  assert.strictEqual(session.state.phase, 'home');
  assert.ok(vehicle.log.includes('recirc:true'), '내기순환 원래대로');
  assert.strictEqual(vehicle.log[vehicle.log.length - 1], 'backrest:FORWARD');
  run(session, 4000);
  assert.strictEqual(session.reclineRatio(), 0);
  assert.strictEqual(vehicle.log[vehicle.log.length - 1], 'backrest:STOP');
});

let failed = 0;
for (const [name, fn] of tests) {
  try { fn(); console.log('  ok   ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + (e && e.message)); }
}
console.log('\n' + (tests.length - failed) + '/' + tests.length + ' 통과');
process.exit(failed ? 1 : 0);
