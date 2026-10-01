(function () {
  'use strict';

  var F = window.Flood;
  if (!F) return;

  var RADIUS_KM = 3;       // edge of the radar
  var LIST_N = 5;
  var ROADS_URL = '/api/roads';
  var ROADS_MS = 2 * 60 * 1000;
  var STORE = 'near';

  var ROAD_LEVELS = {
    flood: { label: 'ท่วม', color: 'crit' },
    slight: { label: 'มีน้ำ', color: 'warn' },
    dry: { label: 'ปกติ', color: 'ok' },
    off: { label: 'ขัดข้อง', color: 'off' }
  };

  var N = { me: null, roads: null, picking: false, pickLayer: null };
  var $ = function (id) { return document.getElementById(id); };

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function dist(d) { return d < 1 ? Math.round(d * 100) * 10 + ' ม.' : d.toFixed(1) + ' กม.'; }
  function m2(v) { return v == null ? '–' : Number(v).toFixed(2); }

  // Offset in km east (x) and north (y) of the user.
  function offset(p) {
    return {
      x: (p.lng - N.me.lng) * Math.cos(N.me.lat * Math.PI / 180) * 111.32,
      y: (p.lat - N.me.lat) * 110.57
    };
  }

  function withDistance(list) {
    return list.filter(function (p) { return p.lat != null && p.lng != null; })
      .map(function (p) { var o = offset(p); return { p: p, x: o.x, y: o.y, d: Math.sqrt(o.x * o.x + o.y * o.y) }; })
      .sort(function (a, b) { return a.d - b.d; });
  }

  // ---------- radar ----------
  function buildSweep() {
    // A fan of thin wedges fading behind the leading line reads as a radar trail.
    var g = document.querySelector('.radar__sweep');
    var html = '', steps = 10, span = 60;
    for (var i = 0; i < steps; i++) {
      var a0 = -(i * span / steps) * Math.PI / 180, a1 = -((i + 1) * span / steps) * Math.PI / 180;
      html += '<path d="M0 0L' + (100 * Math.cos(a0)).toFixed(2) + ' ' + (100 * Math.sin(a0)).toFixed(2) +
        'A100 100 0 0 0 ' + (100 * Math.cos(a1)).toFixed(2) + ' ' + (100 * Math.sin(a1)).toFixed(2) +
        'Z" fill-opacity="' + (0.32 * (1 - i / steps)).toFixed(3) + '"/>';
    }
    html += '<line x1="0" y1="0" x2="100" y2="0"/>' +
      '<animateTransform attributeName="transform" type="rotate" from="0" to="360" dur="4s" repeatCount="indefinite"/>';
    g.innerHTML = html;
    if (window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches) $('radar-svg').pauseAnimations();
  }

  function drawRadar(canals, roads) {
    var k = 92 / RADIUS_KM; // the 3 km ring sits inside the disc so edge dots aren't clipped
    var html = '';
    roads.filter(function (r) { return r.d <= RADIUS_KM; }).forEach(function (r) {
      var lv = ROAD_LEVELS[r.p.level] || ROAD_LEVELS.off;
      html += '<rect class="rd rd--' + lv.color + '" x="' + (r.x * k - 3).toFixed(1) + '" y="' + (-r.y * k - 3).toFixed(1) + '" width="6" height="6" rx="1">' +
        '<title>' + esc(r.p.name) + ' · ' + lv.label + ' · ห่าง ' + dist(r.d) + '</title></rect>';
    });
    canals.filter(function (c) { return c.d <= RADIUS_KM; }).forEach(function (c, i) {
      var lv = F.levelOf(c.p), cx = (c.x * k).toFixed(1), cy = (-c.y * k).toFixed(1);
      var hot = lv === 'crit' || lv === 'warn';
      html += '<g class="cd cd--' + F.LEVELS[lv].color + (hot ? ' is-hot' : '') + '" data-id="' + c.p.id + '" transform="translate(' + cx + ' ' + cy + ')">' +
        (hot ? '<circle class="cd__ping" r="5"/>' : '') +
        '<circle r="' + (i < LIST_N ? 6 : 3.6) + '"/>' +
        (i < LIST_N ? '<text y="2.6" text-anchor="middle">' + (i + 1) + '</text>' : '') +
        '<title>' + esc(c.p.name) + ' · ' + F.LEVELS[lv].label + ' · ห่าง ' + dist(c.d) + '</title></g>';
    });
    $('radar-dots').innerHTML = html;
  }

  // ---------- summary + lists ----------
  function summarise(canals, roads) {
    var inC = canals.filter(function (c) { return c.d <= RADIUS_KM && c.p.online && c.p.wl != null; });
    var inR = roads.filter(function (r) { return r.d <= RADIUS_KM && r.p.level !== 'off'; });
    var up = 0, down = 0, crit = 0, warn = 0;
    inC.forEach(function (c) {
      if (c.p.trend === 'up') up++;
      if (c.p.trend === 'down') down++;
      var lv = F.levelOf(c.p);
      if (lv === 'crit') crit++;
      if (lv === 'warn') warn++;
    });
    var wet = inR.filter(function (r) { return r.p.level === 'flood' || r.p.level === 'slight'; });
    var deepest = wet.reduce(function (m, r) { return Math.max(m, r.p.depth || 0); }, 0);

    var title, tone;
    if (!inC.length) { title = 'ไม่มีจุดวัดคลองในรัศมี 3 กม.'; tone = ''; }
    else if (up > down) { title = 'น้ำในคลองรอบตัวคุณ <em class="t-up">กำลังขึ้น</em>'; tone = 'up'; }
    else if (down > up) { title = 'น้ำในคลองรอบตัวคุณ <em class="t-down">กำลังลด</em>'; tone = 'down'; }
    else { title = 'น้ำในคลองรอบตัวคุณ <em class="t-flat">ทรงตัว</em>'; tone = 'flat'; }
    var parts = [];
    // Water on the road matters more to someone heading out, so it takes the headline and the canal trend moves down.
    if (wet.length) {
      if (tone) parts.push('น้ำในคลอง' + { up: 'กำลังขึ้น', down: 'กำลังลด', flat: 'ทรงตัว' }[tone]);
      title = 'ถนนรอบตัวคุณ <em class="t-up">มีน้ำ ' + wet.length + ' จุด</em>';
    }
    if (inC.length) parts.push(inC.length + ' จุดวัดคลองที่ส่งค่า' + (crit ? ' · วิกฤต ' + crit + ' จุด' : '') + (warn ? ' · เฝ้าระวัง ' + warn + ' จุด' : ''));
    if (inR.length) parts.push(wet.length ? 'ถนน: ลึกสุด ' + deepest + ' ซม.' : 'ถนน ' + inR.length + ' จุดวัด น้ำไม่เกิน 5 ซม.');
    else parts.push(N.roads ? 'ไม่มีจุดวัดน้ำบนถนนในรัศมีนี้' : 'กำลังโหลดข้อมูลถนน…');

    $('near-title-text').innerHTML = title;
    $('near-sub').textContent = parts.join(' · ');
    $('radar').dataset.tone = tone;
  }

  function trend(p) {
    if (p.trend === 'up') return '<span class="trend-up">▲ ' + m2(p.delta) + ' ม.</span>';
    if (p.trend === 'down') return '<span class="trend-down">▼ ' + m2(Math.abs(p.delta)) + ' ม.</span>';
    return '<span class="muted">' + (p.delta == null ? '–' : m2(p.delta) + ' ม.') + '</span>';
  }

  function canalRow(c, i) {
    var p = c.p, lv = F.levelOf(p), col = F.LEVELS[lv].color;
    var short = { crit: 'วิกฤต', warn: 'เฝ้าระวัง', ok: 'ปกติ', unk: 'ไม่มีเกณฑ์', off: 'ขัดข้อง' }[lv];
    return '<li><button type="button" class="near-row" data-station="' + p.id + '">' +
      '<span class="near-num near-num--' + col + '">' + (i + 1) + '</span>' +
      '<span class="near-main"><span class="near-name">' + esc(p.name) + '</span>' +
        '<span class="near-sub">' + esc(p.river || '') + ' · ห่าง ' + dist(c.d) + '</span></span>' +
      '<span class="near-val"><b>' + m2(p.wl) + '</b> <small>ม.</small><span class="near-meta">' + trend(p) +
        ' <span class="badge badge--' + (col === 'off' || col === 'unk' ? 'muted' : col) + '">' + short + '</span></span></span>' +
    '</button></li>';
  }

  function roadRow(r) {
    var p = r.p, lv = ROAD_LEVELS[p.level] || ROAD_LEVELS.off;
    var depth = p.level === 'off' || p.depth == null ? '–' : (p.grp === 2 && p.depth >= 20 ? '≥20' : p.depth);
    return '<li><button type="button" class="near-row" data-lat="' + p.lat + '" data-lng="' + p.lng + '" data-road="' + esc(p.code) + '">' +
      '<span class="near-sq near-sq--' + lv.color + '"></span>' +
      '<span class="near-main"><span class="near-name">' + esc(p.name) + '</span>' +
        '<span class="near-sub">เขต' + esc(p.district || '') + ' · ห่าง ' + dist(r.d) + '</span></span>' +
      '<span class="near-val"><b>' + depth + '</b> <small>ซม.</small><span class="near-meta">' +
        '<span class="badge badge--' + (lv.color === 'off' ? 'muted' : lv.color) + '">' + lv.label + '</span></span></span>' +
    '</button></li>';
  }

  function render() {
    if (!N.me) return;
    var data = F.data();
    var canals = withDistance(data ? data.stations : []);
    var roads = withDistance(N.roads || []);
    drawRadar(canals, roads);
    summarise(canals, roads);
    $('near-canals').innerHTML = canals.length
      ? canals.slice(0, LIST_N).map(canalRow).join('')
      : '<li class="near-empty">กำลังโหลดข้อมูลคลอง…</li>';
    $('near-roads').innerHTML = !N.roads ? '<li class="near-empty">กำลังโหลดข้อมูลถนน…</li>'
      : roads.slice(0, LIST_N).map(roadRow).join('');
    $('near-map').disabled = false;
    $('near-cams').disabled = false;
  }

  // ---------- location ----------
  function setMe(me, label) {
    N.me = { lat: +me.lat, lng: +me.lng, label: label };
    try { localStorage.setItem(STORE, JSON.stringify(N.me)); } catch (e) {}
    $('near-where').textContent = 'จุดวัดน้ำในรัศมี 3 กม. รอบ' + (label || 'ตำแหน่งที่เลือก');
    F.showMe(N.me);
    $('near').classList.add('is-scanning');
    render();
    loadRoads();
  }

  function gps() {
    var btn = $('near-gps'), span = btn.querySelector('span');
    var say = function (msg) { span.textContent = msg; setTimeout(function () { span.textContent = 'ตำแหน่งของฉัน'; }, 3500); };
    if (!navigator.geolocation) { say('เครื่องนี้หาตำแหน่งไม่ได้'); return; }
    btn.classList.add('is-loading');
    navigator.geolocation.getCurrentPosition(function (pos) {
      btn.classList.remove('is-loading');
      setMe({ lat: pos.coords.latitude, lng: pos.coords.longitude }, 'ตำแหน่งของคุณ');
    }, function (err) {
      btn.classList.remove('is-loading');
      say(err.code === 1 ? 'ไม่ได้รับอนุญาต ลองเลือกบนแผนที่' : 'หาตำแหน่งไม่สำเร็จ');
    }, { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 });
  }

  // Next click on the map becomes the scan centre.
  function pick() {
    var map = F.map;
    N.picking = true;
    $('map-sec').classList.add('is-picking');
    $('map-sec').scrollIntoView({ behavior: 'smooth', block: 'start' });
    map.once('click', function (e) {
      N.picking = false;
      $('map-sec').classList.remove('is-picking');
      setMe({ lat: e.latlng.lat, lng: e.latlng.lng }, 'จุดที่เลือก');
      $('near').scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  }

  function showArea() {
    if (!N.me) return;
    var map = F.map;
    if (N.pickLayer) map.removeLayer(N.pickLayer);
    N.pickLayer = L.circle([N.me.lat, N.me.lng], { radius: RADIUS_KM * 1000, color: getComputedStyle(document.documentElement).getPropertyValue('--accent').trim(), weight: 1.5, fillOpacity: 0.06, interactive: false }).addTo(map);
    $('map-sec').scrollIntoView({ behavior: 'smooth', block: 'start' });
    map.fitBounds(N.pickLayer.getBounds(), { padding: [10, 10], animate: false });
  }

  function loadRoads() {
    return fetch(ROADS_URL, { cache: 'no-cache' }).then(function (r) {
      if (!r.ok) throw new Error(ROADS_URL + ' ' + r.status);
      return r.json();
    }).then(function (d) {
      if (!d || !Array.isArray(d.roads)) throw new Error('bad payload');
      N.roads = d.roads;
      render();
    }).catch(function (err) {
      console.error(err);
      if (!N.roads) { N.roads = []; render(); }
    });
  }

  // ---------- events ----------
  $('near-gps').addEventListener('click', gps);
  $('near-pick').addEventListener('click', pick);
  $('near-map').addEventListener('click', showArea);
  $('near-cams').addEventListener('click', function () {
    if (N.me && window.FloodCams) window.FloodCams.near(N.me);
  });

  $('near').addEventListener('click', function (e) {
    var row = e.target.closest('[data-station], .cd[data-id]');
    if (row) { F.focusStation(row.dataset.station || row.dataset.id); return; }
    var road = e.target.closest('[data-road]');
    if (road) {
      $('map-sec').scrollIntoView({ behavior: 'smooth', block: 'start' });
      F.map.setView([+road.dataset.lat, +road.dataset.lng], 16, { animate: false });
    }
  });

  document.addEventListener('flood:data', render);
  document.addEventListener('visibilitychange', function () { if (!document.hidden && N.me) loadRoads(); });
  setInterval(function () { if (!document.hidden && N.me) loadRoads(); }, ROADS_MS);

  buildSweep();
  // Pick up where the visitor left off.
  try {
    var saved = JSON.parse(localStorage.getItem(STORE) || 'null');
    if (saved && isFinite(saved.lat) && isFinite(saved.lng)) setMe(saved, saved.label);
  } catch (e) {}
})();
