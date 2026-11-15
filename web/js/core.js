/*
 * 15분만 — 쪽잠 세션 로직 (화면·차량과 분리된 순수 로직)
 *
 * 브라우저에서는 window.NapCore, Node 테스트에서는 require()로 쓴다.
 * 시간은 tick(dtMs)로만 흐르므로 테스트에서 원하는 만큼 빨리 감을 수 있다.
 *
 * 차량(vehicle) 쪽 약속:
 *   vehicle.signals      현재 차량 신호. 모르는 값은 null.
 *     { gear:'P'|'R'|'N'|'D'|'?', brake, doorOpen, windowsOpen, rearOccupied,
 *       cabinTempC, recircOn, fan }
 *   vehicle.capabilities { doorLock, windows, recirc, backrest, fan }  (true = 제어 가능)
 *   vehicle.act(kind, value) -> boolean   제어 요청을 차에 보냈으면 true
 *     kind: 'lockDoors' | 'closeWindows' | 'recirc'(bool) | 'backrest'('BACKWARD'|'FORWARD'|'STOP')
 *           | 'fan'(int) | 'dim'(0..1)
 * 음성(voice) 쪽 약속: voice.speak(text), voice.stop(), voice.chime()
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.NapCore = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var DEFAULTS = {
    minutes: 15,
    minMinutes: 5,
    maxMinutes: 30,          // 30분을 넘기면 깊은 잠에 들어 깬 뒤 더 멍해진다
    reclineMs: 6000,         // 등받이를 끝까지 눕히는 데 쓰는 이동 시간(실제 시간)
    stepGapMs: 700,          // 준비 단계 사이 간격
    hotC: 30,                // 실내가 이 온도 이상이면 먼저 깨운다
    coldC: 8,                // 실내가 이 온도 이하면 먼저 깨운다
    tempHoldMs: 10000,       // 온도가 이 시간 동안 계속 벗어나야 깨운다(센서 튐 방지)
    nudgeEveryMs: 15000,     // 대답이 없으면 이 간격으로 다시 깨운다
    maxNudges: 6,
    fanBoostAtNudge: 2,      // 이 횟수째 다시 깨울 때 바람을 한 단계 올린다
    readyMs: 120000          // 깬 뒤 출발 전 몸 깨우는 시간
  };

  var STEP_DEFS = [
    { id: 'lock',    label: '문 잠그기' },
    { id: 'windows', label: '열린 창문 닫기' },
    { id: 'air',     label: '바깥 공기 들이기' },
    { id: 'recline', label: '등받이 눕히기' },
    { id: 'dark',    label: '화면 어둡게' }
  ];

  function pad2(n) { return (n < 10 ? '0' : '') + n; }

  function formatClock(ms) {
    var total = Math.max(0, Math.ceil(ms / 1000));
    return pad2(Math.floor(total / 60)) + ':' + pad2(total % 60);
  }

  function NapSession(opts) {
    this.vehicle = opts.vehicle;
    this.voice = opts.voice || { speak: function () {}, stop: function () {}, chime: function () {} };
    this.store = opts.store || null;
    this.cfg = Object.assign({}, DEFAULTS, opts.config || {});
    this.listeners = [];
    this.speed = 1;
    this.state = this._homeState(this.cfg.minutes);
  }

  NapSession.prototype._homeState = function (minutes) {
    return {
      phase: 'home',
      minutes: minutes,
      napLeftMs: 0,
      napTotalMs: 0,
      steps: [],
      wakeReason: null,
      wakeTempC: null,
      nudges: 0,
      readyLeftMs: 0,
      sleptMs: 0,
      caption: '',
      peek: false,
      notes: [],
      seatMoving: null
    };
  };

  NapSession.prototype.subscribe = function (fn) { this.listeners.push(fn); };

  NapSession.prototype._emit = function () {
    for (var i = 0; i < this.listeners.length; i++) this.listeners[i](this.state);
  };

  NapSession.prototype._say = function (text) {
    this.state.caption = text;
    this.voice.speak(text);
  };

  NapSession.prototype.setSpeed = function (x) { this.speed = x > 0 ? x : 1; };

  NapSession.prototype.setMinutes = function (m) {
    if (this.state.phase !== 'home') return;
    var v = Math.round(m);
    if (v < this.cfg.minMinutes) v = this.cfg.minMinutes;
    if (v > this.cfg.maxMinutes) v = this.cfg.maxMinutes;
    this.state.minutes = v;
    this._emit();
  };

  /** 지금 시작할 수 없는 이유. 비어 있으면 시작할 수 있다. */
  NapSession.prototype.blockers = function () {
    var s = this.vehicle.signals;
    var out = [];
    if (s.gear === '?' || s.gear === null || s.gear === undefined) out.push({ id: 'gear', text: '기어 상태를 확인할 수 없어 시작하지 않아요.' });
    else if (s.gear !== 'P') out.push({ id: 'gear', text: '기어를 P에 두면 시작할 수 있어요.' });
    if (s.doorOpen === true) out.push({ id: 'door', text: '문을 닫으면 시작할 수 있어요.' });
    return out;
  };

  /** 시작은 막지 않지만 미리 알려 줄 것. */
  NapSession.prototype.cautions = function () {
    var s = this.vehicle.signals;
    var out = [];
    if (typeof s.cabinTempC === 'number') {
      if (s.cabinTempC >= this.cfg.hotC) out.push({ id: 'hot', text: '실내가 ' + Math.round(s.cabinTempC) + '°C예요. 에어컨을 켜고 주무세요.' });
      else if (s.cabinTempC <= this.cfg.coldC) out.push({ id: 'cold', text: '실내가 ' + Math.round(s.cabinTempC) + '°C예요. 히터를 켜고 주무세요.' });
    }
    return out;
  };

  NapSession.prototype.start = function () {
    if (this.state.phase !== 'home') return { ok: false, blockers: [] };
    var blockers = this.blockers();
    if (blockers.length) return { ok: false, blockers: blockers };

    var s = this.vehicle.signals;
    var cap = this.vehicle.capabilities || {};
    var st = this.state;
    st.phase = 'settling';
    st.napTotalMs = st.minutes * 60000;
    st.napLeftMs = st.napTotalMs;
    st.sleptMs = 0;
    st.notes = [];
    st.steps = STEP_DEFS.map(function (d) { return { id: d.id, label: d.label, status: 'pending', note: '' }; });

    this._settleMs = 0;
    this._stepIndex = 0;
    this._tempBadMs = 0;
    this._nudgeMs = 0;
    this._fanBoosted = false;
    this._snapshot = {
      recircOn: typeof s.recircOn === 'boolean' ? s.recircOn : null,
      fan: typeof s.fan === 'number' ? s.fan : null
    };
    // 뒷좌석에 사람이 있거나 확인이 안 되면 등받이를 절반만 눕힌다.
    var half = s.rearOccupied !== false;
    // 지난번에 세우지 못한 만큼은 이미 누워 있다고 보고, 모자란 만큼만 더 눕힌다.
    var carry = this._seat ? this._seat.reclinedMs : 0;
    var target = cap.backrest ? (half ? this.cfg.reclineMs / 2 : this.cfg.reclineMs) : 0;
    this._seat = { moving: null, leftMs: 0, reclinedMs: carry, planMs: Math.max(0, target - carry), half: half };
    this._brakeArmed = false;
    this._dirty = true;
    this._emit();
    return { ok: true, blockers: [] };
  };

  NapSession.prototype._step = function (id) {
    for (var i = 0; i < this.state.steps.length; i++) if (this.state.steps[i].id === id) return this.state.steps[i];
    return null;
  };

  NapSession.prototype._runSettleStep = function (id) {
    this._dirty = true;
    var v = this.vehicle;
    var cap = v.capabilities || {};
    var s = v.signals;
    var step = this._step(id);
    var ok;
    if (id === 'lock') {
      if (!cap.doorLock) { step.status = 'skipped'; step.note = '이 차는 앱으로 문을 잠글 수 없어요. 직접 잠가 주세요.'; return; }
      ok = v.act('lockDoors', true);
      step.status = ok ? 'done' : 'failed';
    } else if (id === 'windows') {
      if (s.windowsOpen !== true) { step.status = 'done'; step.note = '모두 닫혀 있어요'; return; }
      if (!cap.windows) { step.status = 'skipped'; step.note = '창문이 열려 있어요. 직접 닫아 주세요.'; return; }
      ok = v.act('closeWindows', true);
      step.status = ok ? 'done' : 'failed';
    } else if (id === 'air') {
      if (!cap.recirc) { step.status = 'skipped'; step.note = '공조를 외기 유입으로 직접 바꿔 주세요.'; return; }
      ok = v.act('recirc', false);
      step.status = ok ? 'done' : 'failed';
    } else if (id === 'recline') {
      if (!cap.backrest) { step.status = 'skipped'; step.note = '수동 시트는 직접 눕혀 주세요.'; return; }
      if (!this._seat.planMs) { step.status = 'done'; step.note = '이미 누워 있어요'; return; }
      ok = v.act('backrest', 'BACKWARD');
      if (!ok) { step.status = 'failed'; this._seat.planMs = 0; return; }
      step.status = 'doing';
      step.note = this._seat.half
        ? (s.rearOccupied === true ? '뒷좌석에 사람이 있어 절반만 눕혀요' : '뒷좌석 확인이 안 돼 절반만 눕혀요')
        : '';
      this._seat.moving = 'BACKWARD';
      this._seat.leftMs = this._seat.planMs;
      this.state.seatMoving = 'BACKWARD';
    } else if (id === 'dark') {
      v.act('dim', 0.06);
      step.status = 'done';
    }
  };

  NapSession.prototype._stopSeat = function () {
    if (!this._seat || !this._seat.moving) return;
    this.vehicle.act('backrest', 'STOP');
    this._dirty = true;
    this._seat.moving = null;
    this._seat.leftMs = 0;
    this.state.seatMoving = null;
  };

  /** 등받이가 움직이는 중에 화면을 건드리면 즉시 멈춘다. */
  NapSession.prototype.stopSeatNow = function () {
    if (!this._seat || !this._seat.moving) return false;
    var wasReclining = this._seat.moving === 'BACKWARD';
    this._stopSeat();
    if (wasReclining) {
      var step = this._step('recline');
      if (step) { step.status = 'done'; step.note = '여기서 멈췄어요'; }
    }
    this._emit();
    return true;
  };

  NapSession.prototype._advanceSeat = function (dt) {
    var seat = this._seat;
    if (!seat || !seat.moving) return;
    var used = Math.min(dt, seat.leftMs);
    seat.leftMs -= used;
    if (seat.moving === 'BACKWARD') seat.reclinedMs += used;
    else seat.reclinedMs = Math.max(0, seat.reclinedMs - used);
    if (seat.leftMs <= 0) {
      var was = seat.moving;
      this._stopSeat();
      if (was === 'BACKWARD') {
        var step = this._step('recline');
        if (step && step.status === 'doing') step.status = 'done';
      }
    }
  };

  NapSession.prototype._enterSleeping = function () {
    var st = this.state;
    st.phase = 'sleeping';
    var locked = this._step('lock').status === 'done';
    var air = this._step('air').status === 'done';
    var parts = [st.minutes + '분 뒤에 깨울게요.'];
    if (locked && air) parts.push('문은 잠갔고, 바깥 공기가 들어오게 해뒀어요.');
    else if (locked) parts.push('문은 잠갔어요.');
    else if (air) parts.push('바깥 공기가 들어오게 해뒀어요.');
    parts.push('편히 주무세요.');
    this._say(parts.join(' '));
  };

  NapSession.prototype._abortForGear = function () {
    var st = this.state;
    this._stopSeat();
    this.vehicle.act('dim', 1);
    this._restoreCabin();
    st.wakeReason = 'gear';
    st.phase = 'summary';
    st.peek = false;
    st.notes = ['기어가 P가 아니어서 바로 멈췄어요.'];
    if (this._seat && this._seat.reclinedMs > 0) st.notes.push('등받이는 움직이지 않았어요. 출발 전에 직접 세워 주세요.');
    this._say('기어가 P가 아니에요. 쪽잠을 멈췄어요. 등받이를 확인하세요.');
    this._record();
  };

  NapSession.prototype._restoreCabin = function () {
    var cap = this.vehicle.capabilities || {};
    var snap = this._snapshot || {};
    if (cap.recirc && snap.recircOn === true) this.vehicle.act('recirc', true);
    if (cap.fan && this._fanBoosted && snap.fan !== null) this.vehicle.act('fan', snap.fan);
    this._fanBoosted = false;
  };

  NapSession.prototype._wakeLine = function (reason) {
    var st = this.state;
    if (reason === 'time') return st.minutes + '분 지났어요. 일어날 시간이에요. 등받이를 세울게요.';
    if (reason === 'brake') return '깨셨네요. 등받이를 세울게요.';
    if (reason === 'door') return '문이 열려서 깨웠어요. 등받이를 세울게요.';
    if (reason === 'hot') return '실내가 ' + Math.round(st.wakeTempC) + '도까지 올라서 먼저 깨웠어요. 등받이를 세울게요.';
    if (reason === 'cold') return '실내가 ' + Math.round(st.wakeTempC) + '도까지 내려가서 먼저 깨웠어요. 등받이를 세울게요.';
    return '일어날게요. 등받이를 세울게요.';
  };

  NapSession.prototype._enterWaking = function (reason) {
    var st = this.state;
    st.phase = 'waking';
    st.wakeReason = reason;
    st.peek = false;
    st.nudges = 0;
    st.sleptMs = st.napTotalMs - Math.max(0, st.napLeftMs);
    this._nudgeMs = 0;
    this.vehicle.act('dim', 1);
    this.voice.chime();
    // 눕힌 만큼만 다시 세운다. 등받이가 먼저 깨운다.
    if (this._seat.reclinedMs > 0 && this.vehicle.act('backrest', 'FORWARD')) {
      this._seat.moving = 'FORWARD';
      this._seat.leftMs = this._seat.reclinedMs;
      st.seatMoving = 'FORWARD';
    }
    this._say(this._wakeLine(reason));
  };

  /** 자는 중에 직접 일어나기. */
  NapSession.prototype.wakeNow = function () {
    if (this.state.phase === 'settling') {
      // 준비 중에 그만두기: 눕힌 만큼 세우고 깨우기 단계로 간다.
      this._stopSeat();
      this.state.napLeftMs = this.state.napTotalMs;
      this._enterWaking('manual');
      this._emit();
      return;
    }
    if (this.state.phase !== 'sleeping') return;
    this._enterWaking('manual');
    this._emit();
  };

  /** 준비 중에 그만두기: 바꾼 것을 되돌리고 처음 화면으로 간다. 눕힌 만큼은 다시 세운다. */
  NapSession.prototype.cancel = function () {
    if (this.state.phase !== 'settling') return;
    var minutes = this.state.minutes;
    this.voice.stop();
    this._stopSeat();
    this._restoreCabin();
    this.vehicle.act('dim', 1);
    this.state = this._homeState(minutes);
    this.raiseSeat();
    this._emit();
  };

  NapSession.prototype.setPeek = function (on) {
    if (this.state.phase !== 'sleeping') return;
    this.state.peek = !!on;
    this.vehicle.act('dim', on ? 1 : 0.06);
    this._emit();
  };

  /** "일어났어요" */
  NapSession.prototype.acknowledge = function () {
    var st = this.state;
    if (st.phase !== 'waking') return;
    this.voice.stop();
    this._restoreCabin();
    st.phase = 'ready';
    st.readyLeftMs = this.cfg.readyMs;
    this._say('출발 전에 2분만 몸을 깨워요. 기지개를 켜고 물을 한 모금 드세요.');
    this._emit();
  };

  /** "지금 출발" 또는 출발 준비 시간이 끝났을 때. */
  NapSession.prototype.finish = function () {
    var st = this.state;
    if (st.phase !== 'ready') return;
    st.phase = 'summary';
    st.notes = [];
    this._say('잘 쉬셨어요. 안전 운전하세요.');
    this._record();
    this._emit();
  };

  NapSession.prototype.reset = function () {
    var minutes = this.state.minutes;
    this.voice.stop();
    this._stopSeat();
    this.vehicle.act('dim', 1);
    this.state = this._homeState(minutes);
    this._emit();
  };

  /** 남아 있는 눕힘을 되돌린다(기어가 P일 때만). 요약 화면의 "등받이 세우기". */
  NapSession.prototype.raiseSeat = function () {
    var seat = this._seat;
    if (!seat || seat.moving || seat.reclinedMs <= 0) return false;
    if (this.vehicle.signals.gear !== 'P') return false;
    if (!this.vehicle.act('backrest', 'FORWARD')) return false;
    seat.moving = 'FORWARD';
    seat.leftMs = seat.reclinedMs;
    this.state.seatMoving = 'FORWARD';
    this._emit();
    return true;
  };

  NapSession.prototype.seatLeftover = function () {
    return this._seat ? this._seat.reclinedMs : 0;
  };

  NapSession.prototype._record = function () {
    if (!this.store) return;
    try {
      this.store.add({ minutes: Math.round(this.state.sleptMs / 60000), reason: this.state.wakeReason, at: this.store.now ? this.store.now() : 0 });
    } catch (e) { /* 기록은 없어도 된다 */ }
  };

  NapSession.prototype.tick = function (dtMs) {
    var st = this.state;
    var s = this.vehicle.signals;
    var before = st.phase + '|' + Math.ceil(st.napLeftMs / 1000) + '|' + Math.ceil(st.readyLeftMs / 1000) + '|' + st.seatMoving + '|' + st.nudges;

    if (st.phase === 'home' || st.phase === 'summary') {
      // 쉬는 화면에서도 "등받이 세우기"가 움직이는 중일 수 있다. P를 벗어나면 멈춘다.
      if (this._seat && this._seat.moving) {
        if (s.gear !== 'P') this._stopSeat(); else this._advanceSeat(dtMs);
        if (!this._seat.moving) this._emit();
      }
      return;
    }

    // 1) 어떤 단계든 기어가 P를 벗어나면 즉시 멈춘다. 주행 중에는 시트를 움직이지 않는다.
    if (s.gear !== 'P') {
      if (st.phase === 'ready') { this._stopSeat(); st.phase = 'summary'; st.notes = []; this._record(); }
      else this._abortForGear();
      this._emit();
      return;
    }

    this._advanceSeat(dtMs);

    if (st.phase === 'settling') {
      this._settleMs += dtMs;
      while (this._stepIndex < STEP_DEFS.length) {
        var def = STEP_DEFS[this._stepIndex];
        if (def.id === 'dark') {
          // 등받이가 다 누울 때까지 기다렸다가 화면을 끈다.
          if (this._seat.moving) break;
          if (this._settleMs < this._stepIndex * this.cfg.stepGapMs) break;
        } else if (this._settleMs < this._stepIndex * this.cfg.stepGapMs) break;
        this._runSettleStep(def.id);
        this._stepIndex++;
      }
      if (this._stepIndex >= STEP_DEFS.length && !this._seat.moving) this._enterSleeping();
    } else if (st.phase === 'sleeping') {
      st.napLeftMs -= dtMs * this.speed;
      var reason = null;
      // 브레이크는 "뗐다가 다시 밟았을 때"만 일어난 것으로 본다(밟은 채 잠든 경우 제외).
      if (s.brake !== true) this._brakeArmed = true;
      if (s.brake === true && this._brakeArmed) reason = 'brake';
      else if (s.doorOpen === true) reason = 'door';
      if (!reason && typeof s.cabinTempC === 'number') {
        var hot = s.cabinTempC >= this.cfg.hotC;
        var cold = s.cabinTempC <= this.cfg.coldC;
        if (hot || cold) {
          this._tempBadMs += dtMs;
          if (this._tempBadMs >= this.cfg.tempHoldMs) { reason = hot ? 'hot' : 'cold'; st.wakeTempC = s.cabinTempC; }
        } else this._tempBadMs = 0;
      }
      if (!reason && st.napLeftMs <= 0) { st.napLeftMs = 0; reason = 'time'; }
      if (reason) this._enterWaking(reason);
    } else if (st.phase === 'waking') {
      this._nudgeMs += dtMs;
      if (this._nudgeMs >= this.cfg.nudgeEveryMs && st.nudges < this.cfg.maxNudges) {
        this._nudgeMs = 0;
        st.nudges++;
        this.voice.chime();
        var cap = this.vehicle.capabilities || {};
        if (st.nudges === this.cfg.fanBoostAtNudge && cap.fan && this._snapshot.fan !== null && !this._fanBoosted) {
          this._fanBoosted = this.vehicle.act('fan', this._snapshot.fan + 1);
        }
        this._say('일어나세요. 화면의 일어났어요 버튼을 눌러 주세요.');
      }
    } else if (st.phase === 'ready') {
      st.readyLeftMs -= dtMs * this.speed;
      if (st.readyLeftMs <= 0) { st.readyLeftMs = 0; this.finish(); return; }
    }

    var after = st.phase + '|' + Math.ceil(st.napLeftMs / 1000) + '|' + Math.ceil(st.readyLeftMs / 1000) + '|' + st.seatMoving + '|' + st.nudges;
    if (after !== before || this._dirty) { this._dirty = false; this._emit(); }
  };

  /** 등받이가 지금 얼마나 누워 있는지 0..1 (화면 그림용 추정값). */
  NapSession.prototype.reclineRatio = function () {
    if (!this._seat) return 0;
    return Math.max(0, Math.min(1, this._seat.reclinedMs / this.cfg.reclineMs));
  };

  return { NapSession: NapSession, DEFAULTS: DEFAULTS, STEP_DEFS: STEP_DEFS, formatClock: formatClock };
});
