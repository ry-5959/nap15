/* 15분만 — 화면 */
(function () {
  'use strict';

  var Core = window.NapCore;
  var V = window.NapVehicle;
  var $ = function (id) { return document.getElementById(id); };

  var appEl = $('app');
  var displayEl = $('display');
  var dimmerEl = $('dimmer');
  var captionEl = $('caption');
  var logEl = $('log');
  var t0 = Date.now();

  /* ---------- 차량·음성 연결 ---------- */
  var bridge = window.NapNative || null;
  if (bridge) document.body.classList.add('native');

  function addLog(text, kind) {
    if (!logEl) return;
    var li = document.createElement('li');
    var sec = Math.floor((Date.now() - t0) / 1000);
    var time = document.createElement('time');
    time.textContent = Core.formatClock(sec * 1000);
    var span = document.createElement('span');
    span.textContent = text;
    li.className = 'k-' + (kind || 'etc');
    li.appendChild(time); li.appendChild(span);
    logEl.appendChild(li);
    while (logEl.children.length > 80) logEl.removeChild(logEl.firstChild);
    logEl.scrollTop = logEl.scrollHeight;
  }

  function onDim(level) {
    // 브라우저에서는 실제 화면 밝기를 못 바꾸므로 검은 막으로 흉내 낸다.
    dimmerEl.style.opacity = String(Math.max(0, Math.min(0.55, (1 - level) * 0.55)));
  }

  var vehicle = bridge ? new V.NativeVehicle(bridge, addLog, onDim) : new V.FakeVehicle(addLog, onDim);
  var voice = new V.Voice(bridge, addLog);
  var store = new V.Store();
  var session = new Core.NapSession({ vehicle: vehicle, voice: voice, store: store });

  // 코틀린 쪽에서 부르는 진입점
  window.__nap = {
    onSignals: function (json) { if (vehicle.onSignals) vehicle.onSignals(json); renderLive(); },
    onSdkTrace: function (line) { addLog(String(line), 'sdk'); }
  };
  window.__napDebug = { session: session, vehicle: vehicle };

  /* ---------- 등받이 그림 ---------- */
  var SEAT_SVG =
    '<svg class="seat" viewBox="0 0 600 340" role="img" aria-label="운전석 등받이 상태">' +
      '<path class="s-line" d="M36 300 H564"/>' +
      '<path class="s-line" d="M60 300 V216 Q64 190 104 186 H140"/>' +
      '<path class="s-line" d="M122 196 L164 170"/>' +
      '<path class="s-wheel" d="M154 132 L186 200"/>' +
      '<g class="s-rear"><rect x="474" y="242" width="86" height="24" rx="12"/><rect x="540" y="124" width="24" height="136" rx="12" transform="rotate(10 552 250)"/><circle class="s-person" cx="520" cy="196" r="20"/></g>' +
      '<path class="s-line" d="M236 280 V300 M330 280 V300"/>' +
      '<rect class="s-body" x="222" y="268" width="122" height="12" rx="6"/>' +
      '<rect class="s-body" x="208" y="236" width="142" height="32" rx="15" transform="rotate(4 279 252)"/>' +
      '<g class="s-back">' +
        '<rect class="s-body" x="341" y="96" width="6" height="14"/>' +
        '<rect class="s-body" x="330" y="64" width="28" height="36" rx="11"/>' +
        '<rect class="s-body" x="327" y="106" width="34" height="154" rx="16"/>' +
      '</g>' +
      '<circle class="s-hinge" cx="344" cy="252" r="5"/>' +
    '</svg>';
  Array.prototype.forEach.call(document.querySelectorAll('[data-seat]'), function (el) { el.innerHTML = SEAT_SVG; });
  var seatBacks = document.querySelectorAll('.s-back');

  /* ---------- 시각 표시 ---------- */
  function clockText(date) {
    var h = date.getHours();
    var m = date.getMinutes();
    var ap = h < 12 ? '오전' : '오후';
    var h12 = h % 12; if (h12 === 0) h12 = 12;
    return ap + ' ' + h12 + ':' + (m < 10 ? '0' : '') + m;
  }

  function chip(text, tone) { return '<li class="chip ' + tone + '">' + text + '</li>'; }

  function chipsHtml() {
    var s = vehicle.signals;
    var out = '';
    if (s.gear === 'P') out += chip('기어 P', 'ok');
    else if (s.gear === '?' || s.gear == null) out += chip('기어 확인 안 됨', 'bad');
    else out += chip('기어 ' + s.gear, 'bad');

    if (s.doorOpen === true) out += chip('문 열림', 'bad');
    else if (s.doorLocked === true) out += chip('문 잠김', 'ok');
    else if (s.doorOpen === false) out += chip('문 닫힘', 'ok');

    if (typeof s.cabinTempC === 'number') {
      var t = Math.round(s.cabinTempC);
      var bad = t >= session.cfg.hotC || t <= session.cfg.coldC;
      out += chip('실내 ' + t + '°C', bad ? 'warn' : 'plain');
    }
    if (s.recircOn === false) out += chip('외기 유입', 'ok');
    else if (s.recircOn === true) out += chip('내기 순환', 'plain');

    if (s.rearOccupied === true) out += chip('뒷좌석에 사람', 'warn');
    else if (s.rearOccupied == null) out += chip('뒷좌석 확인 안 됨', 'warn');
    if (s.windowsOpen === true) out += chip('창문 열림', 'warn');
    return out;
  }

  var last = { chips: '', phase: '', caption: '', angle: '' };
  var sleepStartedAt = Date.now();
  var captionTimer = null;

  function showCaption(text) {
    if (!text) return;
    captionEl.textContent = text;
    captionEl.classList.add('on');
    clearTimeout(captionTimer);
    captionTimer = setTimeout(function () { captionEl.classList.remove('on'); }, Math.max(4500, text.length * 130));
  }

  var STATUS_TEXT = { pending: '', doing: '하는 중', done: '완료', skipped: '건너뜀', failed: '실패' };

  /* 단계가 바뀔 때만 다시 그리는 부분 */
  function renderPhase(st) {
    if (st.phase === 'sleeping' && last.phase !== 'sleeping') sleepStartedAt = Date.now();
    last.phase = st.phase;
    appEl.setAttribute('data-phase', st.phase);

    if (st.caption && st.caption !== last.caption) { last.caption = st.caption; showCaption(st.caption); }

    if (st.phase === 'settling') {
      var html = '';
      for (var i = 0; i < st.steps.length; i++) {
        var step = st.steps[i];
        html += '<li class="' + step.status + '"><span class="step-name">' + step.label + '</span>' +
          '<span class="step-state">' + (step.note || STATUS_TEXT[step.status]) + '</span></li>';
      }
      $('steps').innerHTML = html;
    }

    if (st.phase === 'sleeping') {
      var s = vehicle.signals;
      var guard = [];
      if (s.doorLocked === true) guard.push('문 잠김');
      if (s.recircOn === false) guard.push('외기 유입');
      guard.push('지켜보는 중');
      $('sleepGuard').textContent = guard.join('  ·  ');
      $('peek').hidden = !st.peek;
    }

    if (st.phase === 'waking') {
      var titles = {
        time: '일어날 시간이에요',
        manual: '일어날게요',
        brake: '깨셨네요',
        door: '문이 열렸어요',
        hot: '실내가 더워요',
        cold: '실내가 추워요'
      };
      $('wakeTitle').textContent = titles[st.wakeReason] || '일어날 시간이에요';
      var lead = st.seatMoving ? '등받이를 세우고 있어요.' : '등받이를 세웠어요.';
      if (st.wakeReason === 'hot' || st.wakeReason === 'cold') lead = '실내가 ' + Math.round(st.wakeTempC) + '°C라서 먼저 깨웠어요. ' + lead;
      if (session.seatLeftover() === 0 && !st.seatMoving && !vehicle.capabilities.backrest) lead = '등받이를 직접 세워 주세요.';
      $('wakeLead').textContent = lead;
      $('stopSeat').hidden = !st.seatMoving;
    }

    if (st.phase === 'summary') {
      var mins = Math.round(st.sleptMs / 60000);
      $('sumTitle').textContent = st.wakeReason === 'gear' ? '쪽잠을 멈췄어요' : (mins >= 1 ? mins + '분 잤어요' : '잠깐 쉬었어요');
      $('sumLead').textContent = st.wakeReason === 'gear' ? '기어가 P를 벗어났어요.' : '안전 운전하세요.';
      var notes = '';
      for (var n = 0; n < st.notes.length; n++) notes += '<li>' + st.notes[n] + '</li>';
      $('sumNotes').innerHTML = notes;
      var week = store.weekCount();
      $('tally').textContent = week > 0 ? '최근 7일 동안 ' + week + '번 쉬어 갔어요.' : '';
    }
  }

  /* 매 틱마다 가볍게 다시 그리는 부분 */
  function renderLive() {
    var st = session.state;
    var chips = chipsHtml();
    if (chips !== last.chips) { last.chips = chips; $('chips').innerHTML = chips; }

    var angle = (14 + 50 * session.reclineRatio()).toFixed(2);
    if (angle !== last.angle) {
      last.angle = angle;
      for (var b = 0; b < seatBacks.length; b++) seatBacks[b].setAttribute('transform', 'rotate(' + angle + ' 344 252)');
    }
    appEl.classList.toggle('seat-moving', !!st.seatMoving);
    appEl.classList.toggle('rear-on', vehicle.signals.rearOccupied === true);
    var badge = $('demoBadge');
    if (session.speed > 1) { badge.hidden = false; badge.textContent = '시연 ' + session.speed + '배속'; } else badge.hidden = true;

    if (st.phase === 'home') {
      var blockers = session.blockers();
      var cautions = session.cautions();
      var wakeText = clockText(new Date(Date.now() + st.minutes * 60000)) + '에 깨워요';
      // 시작할 수 없을 때는 이유를 버튼 안에 바로 보여 준다(다른 곳을 찾아 읽지 않게).
      var sub = blockers.length ? blockers[0].text : wakeText;
      $('minutes').textContent = st.minutes;
      $('wakeAt').textContent = sub;
      $('start').disabled = blockers.length > 0;
      $('start').setAttribute('aria-label', st.minutes + '분 자기. ' + sub);
      var presets = $('presets').children;
      for (var i = 0; i < presets.length; i++) presets[i].setAttribute('aria-pressed', String(Number(presets[i].getAttribute('data-min')) === st.minutes));
      var caution = !blockers.length && cautions.length ? cautions[0].text : '';
      $('blocker').textContent = caution;
      $('blocker').className = 'blocker' + (caution ? ' warn' : '');
    } else if (st.phase === 'sleeping') {
      $('sleepClock').textContent = Core.formatClock(st.napLeftMs);
      $('sleepUntil').textContent = clockText(new Date(sleepStartedAt + st.napTotalMs)) + '에 깨워요';
    } else if (st.phase === 'waking') {
      $('stopSeat').hidden = !st.seatMoving;
    } else if (st.phase === 'ready') {
      var sec = Math.ceil(st.readyLeftMs / 1000);
      $('readyClock').textContent = Math.floor(sec / 60) + ':' + (sec % 60 < 10 ? '0' : '') + (sec % 60);
    } else if (st.phase === 'summary') {
      var left = session.seatLeftover() > 0;
      $('raise').hidden = !left;
      $('raise').disabled = vehicle.signals.gear !== 'P' || !!st.seatMoving;
    }
  }

  session.subscribe(function (st) { renderPhase(st); renderLive(); });

  /* ---------- 조작 ---------- */
  var remembered = store.lastMinutes();
  if (remembered) session.setMinutes(remembered);
  $('presets').addEventListener('click', function (e) {
    var b = e.target.closest('button'); if (!b) return;
    session.setMinutes(Number(b.getAttribute('data-min')));
  });
  $('start').addEventListener('click', function () {
    voice.unlock();
    if (vehicle.refreshCapabilities) vehicle.refreshCapabilities();
    store.setLastMinutes(session.state.minutes);
    session.start();
    renderLive();
  });
  $('cancelSettle').addEventListener('click', function () { session.cancel(); });
  $('wakeNow').addEventListener('click', function (e) { e.stopPropagation(); session.wakeNow(); });
  $('keepSleeping').addEventListener('click', function (e) { e.stopPropagation(); session.setPeek(false); });
  $('ack').addEventListener('click', function () { session.acknowledge(); });
  $('stopSeat').addEventListener('click', function () { session.stopSeatNow(); });
  $('go').addEventListener('click', function () { session.finish(); });
  $('home').addEventListener('click', function () { session.reset(); });
  $('raise').addEventListener('click', function () { session.raiseSeat(); });

  var peekTimer = null;
  displayEl.addEventListener('pointerdown', function (e) {
    var st = session.state;
    var onButton = !!e.target.closest('button');
    // 등받이가 눕는 중에는 화면 어디를 눌러도 멈춘다.
    if (st.phase === 'settling' && st.seatMoving && !onButton) { session.stopSeatNow(); return; }
    if (st.phase === 'sleeping' && !onButton && !st.peek) {
      session.setPeek(true);
      clearTimeout(peekTimer);
      peekTimer = setTimeout(function () { session.setPeek(false); }, 7000);
    }
  });

  /* ---------- 가상 차량 패널 (브라우저에서만) ---------- */
  if (!bridge) {
    var gearSeg = $('gearSeg');
    var speedSeg = $('speedSeg');
    var syncSeg = function (seg, attr, value) {
      for (var i = 0; i < seg.children.length; i++) seg.children[i].setAttribute('aria-pressed', String(seg.children[i].getAttribute(attr) === String(value)));
    };
    gearSeg.addEventListener('click', function (e) {
      var b = e.target.closest('button'); if (!b) return;
      vehicle.signals.gear = b.getAttribute('data-gear');
      syncSeg(gearSeg, 'data-gear', vehicle.signals.gear);
      addLog('기어 → ' + vehicle.signals.gear + '  (Gear.registerGearSelection)', 'in');
      renderLive();
    });
    speedSeg.addEventListener('click', function (e) {
      var b = e.target.closest('button'); if (!b) return;
      session.setSpeed(Number(b.getAttribute('data-speed')));
      syncSeg(speedSeg, 'data-speed', session.speed);
    });
    syncSeg(gearSeg, 'data-gear', 'P');
    syncSeg(speedSeg, 'data-speed', 1);

    $('tempRange').addEventListener('input', function (e) {
      vehicle.signals.cabinTempC = Number(e.target.value);
      $('tempOut').textContent = e.target.value + '°C';
      renderLive();
    });
    var toggle = function (id, apply, label) {
      $(id).addEventListener('click', function () {
        var on = $(id).getAttribute('aria-pressed') !== 'true';
        $(id).setAttribute('aria-pressed', String(on));
        apply(on);
        if (label) addLog(label(on), 'in');
        renderLive();
      });
    };
    toggle('tBrake', function (on) { vehicle.signals.brake = on; }, function (on) { return '브레이크 ' + (on ? '밟음' : '뗌') + '  (Brake.registerBrakePedalStatus)'; });
    toggle('tDoor', function (on) { vehicle.signals.doorOpen = on; if (on) vehicle.signals.doorLocked = false; }, function (on) { return '문 ' + (on ? '열림' : '닫힘') + '  (Door.registerDoorPosition)'; });
    toggle('tRear', function (on) { vehicle.signals.rearOccupied = on; }, function (on) { return '뒷좌석 ' + (on ? '사람 있음' : '비어 있음') + '  (Seat.getCurrentSeatOccupancy)'; });
    toggle('tWindow', function (on) { vehicle.signals.windowsOpen = on; }, function (on) { return '창문 ' + (on ? '열림' : '닫힘') + '  (Window.registerWindowPosition)'; });
    toggle('tManual', function (on) { vehicle.capabilities.backrest = !on; }, null);
  }

  /* ---------- 화면 크기에 맞춰 글자·간격 단위(--u)를 정한다 ---------- */
  function fit() {
    var r = displayEl.getBoundingClientRect();
    var tall = r.width / Math.max(1, r.height) < 1.15;
    appEl.classList.toggle('tall', tall);
    var base = tall ? r.width / 62 : Math.min(r.width / 100, r.height / 60);
    appEl.style.setProperty('--u', base.toFixed(3) + 'px');
  }
  if (window.ResizeObserver) new ResizeObserver(fit).observe(displayEl);
  window.addEventListener('resize', fit);
  fit();

  /* ---------- 시간 흐름 ---------- */
  var lastTick = Date.now();
  setInterval(function () {
    var now = Date.now();
    var dt = now - lastTick;
    lastTick = now;
    session.tick(dt);
    renderLive();
  }, 125);

  renderPhase(session.state);
  renderLive();
})();
