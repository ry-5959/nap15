/*
 * 15분만 — 차량·음성 연결부
 *
 *  - 안드로이드(Pleos Connect) 앱 안에서는 window.NapNative(코틀린 브리지)가 있다 → NativeVehicle
 *  - 브라우저에서는 없다 → FakeVehicle (화면 오른쪽 "가상 차량"이 값을 바꾼다)
 *
 * 두 경우 모두 core.js가 쓰는 약속(signals / capabilities / act)은 같다.
 */
(function (root) {
  'use strict';

  /* 요청 종류 → 실제로 호출되는 Pleos Connect SDK(Vehicle 2.3.2 / TextToSpeech 3.3.1) 이름 */
  var SDK_NAMES = {
    lockDoors:    function ()  { return 'Door.setDoorLock(전 좌석, true)'; },
    closeWindows: function ()  { return 'Window.setWindowPosition(열린 창문, 닫힘)'; },
    recirc:       function (v) { return 'HVAC.setHvacRecirculation(ROW_1_LEFT, ' + v + ')'; },
    backrest:     function (v) { return 'Seat.moveSeatBackrestAngle(ROW_1_LEFT, ' + v + ')'; },
    fan:          function (v) { return 'HVAC.setHvacFanSpeed(ROW_1_LEFT, ' + v + ')'; },
    dim:          function (v) { return '화면 밝기 ' + Math.round(v * 100) + '%'; },
    speak:        function (v) { return 'TextToSpeech.speak("' + (v.length > 22 ? v.slice(0, 22) + '…' : v) + '")'; }
  };

  function sdkName(kind, value) {
    return SDK_NAMES[kind] ? SDK_NAMES[kind](value) : kind + '(' + value + ')';
  }

  /* ---------- 가상 차량 ---------- */
  function FakeVehicle(onLog, onDim) {
    this.signals = {
      gear: 'P', brake: false, doorOpen: false, doorLocked: false, windowsOpen: false,
      rearOccupied: false, cabinTempC: 23, recircOn: true, fan: 2
    };
    this.capabilities = { doorLock: true, windows: true, recirc: true, backrest: true, fan: true };
    this.onLog = onLog || function () {};
    this.onDim = onDim || function () {};
    this.kind = 'fake';
  }
  FakeVehicle.prototype.act = function (kind, value) {
    var s = this.signals;
    if (kind === 'lockDoors') s.doorLocked = !!value;
    else if (kind === 'closeWindows') s.windowsOpen = false;
    else if (kind === 'recirc') s.recircOn = !!value;
    else if (kind === 'fan') s.fan = value;
    else if (kind === 'dim') this.onDim(value);
    this.onLog(sdkName(kind, value), kind);
    return true;
  };

  /* ---------- 실제 차량 (안드로이드 브리지) ---------- */
  function NativeVehicle(bridge, onLog, onDim) {
    this.bridge = bridge;
    this.signals = { gear: '?', brake: null, doorOpen: null, doorLocked: null, windowsOpen: null, rearOccupied: null, cabinTempC: null, recircOn: null, fan: null };
    this.capabilities = { doorLock: false, windows: false, recirc: false, backrest: false, fan: false };
    this.onLog = onLog || function () {};
    this.onDim = onDim || function () {};
    this.kind = 'pleos';
    this.refreshCapabilities();
  }
  NativeVehicle.prototype.refreshCapabilities = function () {
    try {
      var c = JSON.parse(this.bridge.capabilities());
      for (var k in this.capabilities) if (typeof c[k] === 'boolean') this.capabilities[k] = c[k];
    } catch (e) { /* 아직 준비 전이면 다음 신호 때 다시 읽는다 */ }
  };
  /** 코틀린 쪽에서 1초마다, 그리고 값이 바뀔 때 부른다. */
  NativeVehicle.prototype.onSignals = function (json) {
    try {
      var s = typeof json === 'string' ? JSON.parse(json) : json;
      for (var k in this.signals) if (k in s) this.signals[k] = s[k];
      if (s.capabilities) for (var c in this.capabilities) if (typeof s.capabilities[c] === 'boolean') this.capabilities[c] = s.capabilities[c];
    } catch (e) { /* 깨진 신호는 버린다 */ }
  };
  NativeVehicle.prototype.act = function (kind, value) {
    var ok = false;
    try { ok = !!this.bridge.act(kind, String(value)); } catch (e) { ok = false; }
    if (kind === 'dim') this.onDim(value);
    this.onLog(sdkName(kind, value) + (ok ? '' : '  → 보내지 못함'), kind);
    return ok;
  };

  /* ---------- 음성 ---------- */
  function Voice(bridge, onLog) {
    this.bridge = bridge || null;
    this.onLog = onLog || function () {};
    this.audio = null;
  }
  Voice.prototype.speak = function (text) {
    this.onLog(sdkName('speak', text), 'speak');
    if (this.bridge) { try { this.bridge.speak(text); } catch (e) {} return; }
    try {
      if (!root.speechSynthesis) return;
      root.speechSynthesis.cancel();
      var u = new root.SpeechSynthesisUtterance(text);
      u.lang = 'ko-KR';
      u.rate = 1;
      root.speechSynthesis.speak(u);
    } catch (e) { /* 음성이 없으면 화면 자막만 나온다 */ }
  };
  Voice.prototype.stop = function () {
    if (this.bridge) { try { this.bridge.stopSpeaking(); } catch (e) {} return; }
    try { if (root.speechSynthesis) root.speechSynthesis.cancel(); } catch (e) {}
  };
  /** 첫 터치 때 한 번 불러 소리를 낼 수 있게 한다. */
  Voice.prototype.unlock = function () {
    if (this.audio) return;
    try {
      var Ctx = root.AudioContext || root.webkitAudioContext;
      if (Ctx) this.audio = new Ctx();
    } catch (e) { this.audio = null; }
  };
  /** 깨우는 알림음: 낮은 음에서 높은 음으로 세 번. */
  Voice.prototype.chime = function () {
    var ctx = this.audio;
    if (!ctx) return;
    try {
      var t0 = ctx.currentTime;
      [523.25, 659.25, 783.99].forEach(function (hz, i) {
        var osc = ctx.createOscillator();
        var gain = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.value = hz;
        var t = t0 + i * 0.28;
        gain.gain.setValueAtTime(0.0001, t);
        gain.gain.exponentialRampToValueAtTime(0.5, t + 0.03);
        gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.5);
        osc.connect(gain); gain.connect(ctx.destination);
        osc.start(t); osc.stop(t + 0.55);
      });
    } catch (e) { /* 소리 없이 계속 */ }
  };

  /* ---------- 쪽잠 기록 (이 기기 안에만 저장) ---------- */
  function Store() { this.key = 'nap15.records'; }
  Store.prototype.now = function () { return Date.now(); };
  /* 마지막에 고른 시간을 기억해 두면 다음에는 한 번만 누르면 된다. */
  Store.prototype.lastMinutes = function () {
    try { var v = Number(root.localStorage.getItem('nap15.minutes')); return v > 0 ? v : null; } catch (e) { return null; }
  };
  Store.prototype.setLastMinutes = function (m) {
    try { root.localStorage.setItem('nap15.minutes', String(m)); } catch (e) { /* 저장이 안 돼도 동작에는 지장 없다 */ }
  };
  Store.prototype.all = function () {
    try { return JSON.parse(root.localStorage.getItem(this.key) || '[]'); } catch (e) { return []; }
  };
  Store.prototype.add = function (rec) {
    try {
      var list = this.all();
      list.push(rec);
      root.localStorage.setItem(this.key, JSON.stringify(list.slice(-200)));
    } catch (e) { /* 저장이 막혀 있어도 앱은 그대로 돈다 */ }
  };
  /** 최근 7일 동안의 쪽잠 횟수. */
  Store.prototype.weekCount = function () {
    var since = Date.now() - 7 * 24 * 3600 * 1000;
    return this.all().filter(function (r) { return r.at >= since; }).length;
  };

  root.NapVehicle = { FakeVehicle: FakeVehicle, NativeVehicle: NativeVehicle, Voice: Voice, Store: Store, sdkName: sdkName };
})(typeof self !== 'undefined' ? self : this);
