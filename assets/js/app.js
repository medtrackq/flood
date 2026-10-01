(function () {
  'use strict';

  // Tried in order: the local proxy (server.mjs), POPNIX directly, then the bundled snapshot.
  var SOURCES = [
    { url: '/api/overview', live: true },
    { url: 'https://flood.pop.in.th/api_overview.php', live: true },
    { url: 'data/overview.json', live: false }
  ];
  var REFRESH_MS = 2 * 60 * 1000;
  var BKK = [13.7563, 100.5018];

  var LEVELS = {
    crit: { label: 'ถึงระดับวิกฤต', color: 'crit' },
    warn: { label: 'เกินระดับเฝ้าระวัง', color: 'warn' },
    ok: { label: 'ปกติ', color: 'ok' },
    unk: { label: 'ไม่มีเกณฑ์เทียบ', color: 'unk' },
    off: { label: 'ขัดข้อง / ไม่ส่งค่า', color: 'off' }
  };
  var ORDER = { off: 0, unk: 1, ok: 2, warn: 3, crit: 4 };

  var state = { data: null, markers: {}, visible: { crit: true, warn: true, ok: true, unk: true, off: true } };
  var $ = function (id) { return document.getElementById(id); };

  // ---------- helpers ----------
  function css(name) { return getComputedStyle(document.documentElement).getPropertyValue('--' + name).trim(); }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function num(v, digits) { return v == null ? '–' : Number(v).toFixed(digits == null ? 2 : digits); }

  function cm(delta) {
    if (delta == null) return '–';
    var v = Math.round(delta * 100);
    return (v > 0 ? '+' : '') + v + ' ซม.';
  }

  // API times are Thai local time (UTC+7) without a zone suffix.
  function parseTH(s) { return s ? new Date(s.replace(' ', 'T') + '+07:00') : null; }

  function timeTH(s) {
    var d = parseTH(s);
    return d ? d.toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Bangkok' }) + ' น.' : '–';
  }

  function dateTimeTH(s) {
    var d = parseTH(s);
    return d ? d.toLocaleString('th-TH', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Bangkok' }) + ' น.' : '–';
  }

  function levelOf(st) { return st.online ? (LEVELS[st.level] ? st.level : 'unk') : 'off'; }

  function trendHTML(st) {
    if (st.trend === 'up') return '<span class="trend-up">▲ ' + cm(st.delta) + '</span>';
    if (st.trend === 'down') return '<span class="trend-down">▼ ' + cm(st.delta) + '</span>';
    if (st.trend === 'flat') return 'ทรงตัว (' + cm(st.delta) + ')';
    return '–';
  }

  function sparkSVG(values, st) {
    var pts = (values || []).filter(function (v) { return v != null; });
    if (pts.length < 2) return '';
    var lo = Math.min.apply(null, pts), hi = Math.max.apply(null, pts);
    // Keep the thresholds in view when they are close, so the line reads against them.
    [st.warn, st.crit].forEach(function (t) { if (t != null && Math.abs(t - (lo + hi) / 2) < 0.6) { lo = Math.min(lo, t); hi = Math.max(hi, t); } });
    var pad = (hi - lo) * 0.1 || 0.05; lo -= pad; hi += pad;
    var W = 240, H = 44;
    var y = function (v) { return (H - (v - lo) / (hi - lo) * H).toFixed(1); };
    var d = pts.map(function (v, i) { return (i ? 'L' : 'M') + (i / (pts.length - 1) * W).toFixed(1) + ' ' + y(v); }).join('');
    var lines = [['warn', st.warn], ['crit', st.crit]].filter(function (t) { return t[1] != null && t[1] >= lo && t[1] <= hi; })
      .map(function (t) { return '<line x1="0" x2="' + W + '" y1="' + y(t[1]) + '" y2="' + y(t[1]) + '" stroke="' + css(t[0]) + '" stroke-width="1" stroke-dasharray="3 3"/>'; }).join('');
    return '<svg class="pop__spark" viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none" aria-label="ระดับน้ำ 6 ชั่วโมงล่าสุด">' + lines +
      '<path d="' + d + '" fill="none" stroke="' + css('accent') + '" stroke-width="2" vector-effect="non-scaling-stroke"/></svg>';
  }

  // ---------- map ----------
  var map = L.map('map', { zoomControl: true, attributionControl: true }).setView(BKK, 11);
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 18,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
  }).addTo(map);
  var layer = L.layerGroup().addTo(map);

  function popupHTML(st) {
    var lv = levelOf(st);
    var gap = st.crit != null && st.wl != null ? st.crit - st.wl : null;
    return '<div class="pop">' +
      '<div class="pop__name">' + esc(st.name) + '</div>' +
      '<div class="pop__river">' + esc(st.river || '') + '</div>' +
      '<div class="pop__level"><i class="dot dot--' + LEVELS[lv].color + '"></i>' + LEVELS[lv].label + '</div>' +
      '<div class="pop__wl">' + num(st.wl) + ' <small>ม.รทก.</small></div>' +
      '<dl>' +
        '<dt>เทียบ 1 ชม. ก่อน</dt><dd>' + trendHTML(st) + '</dd>' +
        '<dt>เทียบเมื่อวาน</dt><dd>' + cm(st.delta_day) + '</dd>' +
        '<dt>ระดับเฝ้าระวัง</dt><dd>' + num(st.warn) + '</dd>' +
        '<dt>ระดับวิกฤต</dt><dd>' + num(st.crit) + '</dd>' +
        (gap != null ? '<dt>' + (gap >= 0 ? 'ต่ำกว่าวิกฤต' : 'สูงกว่าวิกฤต') + '</dt><dd>' + Math.abs(Math.round(gap * 100)) + ' ซม.</dd>' : '') +
        '<dt>ระดับตลิ่ง</dt><dd>' + num(st.bank) + '</dd>' +
        '<dt>สูงสุดวันนี้</dt><dd>' + num(st.max_day) + '</dd>' +
      '</dl>' +
      sparkSVG(st.spark, st) +
      '<div class="pop__time">วัดเมื่อ ' + dateTimeTH(st.measured_at) + '</div>' +
    '</div>';
  }

  function renderMap(stations) {
    layer.clearLayers();
    state.markers = {};
    stations.slice().sort(function (a, b) { return ORDER[levelOf(a)] - ORDER[levelOf(b)]; }).forEach(function (st) {
      if (st.lat == null || st.lng == null) return;
      var lv = levelOf(st);
      var off = lv === 'off';
      var m = L.circleMarker([st.lat, st.lng], {
        radius: lv === 'crit' ? 8 : lv === 'warn' ? 7 : 6,
        color: off ? css('off') : css('surface'),
        weight: off ? 2 : 1.5,
        fillColor: css(LEVELS[lv].color),
        fillOpacity: off ? 0 : 0.95
      }).bindPopup(popupHTML(st), { maxWidth: 280, autoPanPadding: [16, 16] })
        .bindTooltip(esc(st.name) + (st.wl != null ? ' · ' + num(st.wl) + ' ม.' : ''), { direction: 'top', offset: [0, -6] });
      m._level = lv;
      state.markers[st.id] = m;
      if (state.visible[lv]) m.addTo(layer);
    });
  }

  function applyFilters() {
    Object.keys(state.markers).forEach(function (id) {
      var m = state.markers[id];
      if (state.visible[m._level]) layer.addLayer(m); else layer.removeLayer(m);
    });
  }

  // ---------- panels ----------
  function renderStats(sum, stations) {
    $('s-crit').textContent = sum.crit;
    $('s-warn').textContent = sum.warn;
    $('s-up').textContent = sum.up;
    $('s-down').textContent = sum.down;
    $('s-flat').textContent = 'ทรงตัว ' + sum.flat + ' จุด';
    $('s-online').textContent = sum.online + '/' + sum.stations;
    $('s-offline').textContent = 'ขัดข้อง ' + sum.offline + ' จุด';

    var counts = { crit: 0, warn: 0, ok: 0, unk: 0, off: 0 };
    stations.forEach(function (st) { counts[levelOf(st)]++; });
    document.querySelectorAll('#filters .chip').forEach(function (b) {
      var c = b.querySelector('.count') || b.appendChild(document.createElement('span'));
      c.className = 'count';
      c.textContent = counts[b.dataset.level];
    });
  }

  function renderTide(t) {
    var el = $('tide');
    if (!t) { el.innerHTML = '<li class="muted">ไม่มีข้อมูล</li>'; return; }
    $('tide-date').textContent = parseTH(t.date + ' 00:00:00').toLocaleDateString('th-TH', { day: 'numeric', month: 'long', timeZone: 'Asia/Bangkok' });
    var rows = [['high_am', 'น้ำขึ้น (เช้า)'], ['low_am', 'น้ำลง (เช้า)'], ['high_pm', 'น้ำขึ้น (บ่าย)'], ['low_pm', 'น้ำลง (บ่าย)']];
    el.innerHTML = rows.filter(function (r) { return t[r[0]]; }).map(function (r) {
      var x = t[r[0]];
      return '<li><div class="k">' + r[1] + '</div><div class="v">' + num(x.v) + ' ม.</div><div class="t">' + esc(x.t) + ' น.</div></li>';
    }).join('');
  }

  function renderTop(stations) {
    var list = stations
      .filter(function (st) { return st.online && st.wl != null && st.crit != null; })
      .map(function (st) { return { st: st, over: st.wl - st.crit }; })
      .sort(function (a, b) { return b.over - a.over; })
      .slice(0, 8);
    var el = $('top-list');
    if (!list.length) { el.innerHTML = '<li class="muted">ไม่มีข้อมูล</li>'; return; }
    el.innerHTML = list.map(function (x) {
      var st = x.st, lv = levelOf(st), v = Math.round(x.over * 100);
      return '<li class="is-link" data-id="' + st.id + '" tabindex="0">' +
        '<i class="dot dot--' + LEVELS[lv].color + '"></i>' +
        '<div style="min-width:0"><div class="name">' + esc(st.name) + '</div><div class="sub">' + trendHTML(st) + '</div></div>' +
        '<div class="val">' + num(st.wl) + ' ม.<small>' + (v >= 0 ? 'เกินวิกฤต ' : 'ต่ำกว่าวิกฤต ') + Math.abs(v) + ' ซม.</small></div>' +
      '</li>';
    }).join('');
  }

  function focusStation(id) {
    var m = state.markers[id];
    if (!m) return;
    if (!state.visible[m._level]) {
      state.visible[m._level] = true;
      document.querySelector('#filters .chip[data-level="' + m._level + '"]').classList.add('is-on');
      layer.addLayer(m);
    }
    document.getElementById('map').scrollIntoView({ behavior: 'smooth', block: 'center' });
    // Without animation so the popup's auto-pan measures the final view.
    map.setView(m.getLatLng(), Math.max(map.getZoom(), 14), { animate: false });
    m.openPopup();
  }

  function renderNotice(sum, src) {
    var msgs = [];
    if (!src.live) msgs.push('เชื่อมต่อแหล่งข้อมูลสดไม่ได้ กำลังแสดงข้อมูลตัวอย่างที่บันทึกไว้');
    if (sum.stale) msgs.push('ข้อมูลล่าสุดเก่ากว่า 45 นาที ต้นทางอาจขัดข้อง');
    if (sum.scrape_failing) msgs.push('รอบล่าสุดดึงข้อมูลจากต้นทางไม่สำเร็จ');
    var el = $('notice');
    el.hidden = !msgs.length;
    el.textContent = msgs.join(' · ');
  }

  // ---------- data ----------
  function fetchJSON(url) {
    return fetch(url, { cache: 'no-cache' }).then(function (r) {
      if (!r.ok) throw new Error(url + ' ' + r.status);
      return r.json();
    }).then(function (d) {
      if (!d || !d.summary || !Array.isArray(d.stations)) throw new Error(url + ' bad payload');
      return d;
    });
  }

  function load(i) {
    i = i || 0;
    var src = SOURCES[i];
    return fetchJSON(src.url).then(function (d) { return { data: d, src: src }; }, function (err) {
      if (i + 1 < SOURCES.length) return load(i + 1);
      throw err;
    });
  }

  function render(res) {
    var d = res.data, sum = d.summary;
    state.data = d;
    renderStats(sum, d.stations);
    renderMap(d.stations);
    renderTide(sum.tide);
    renderTop(d.stations);
    renderNotice(sum, res.src);
    $('updated').textContent = 'ข้อมูลล่าสุด ' + timeTH(sum.latest) + ' · จุดวัด ' + sum.stations + ' จุด';
  }

  function refresh() {
    var btn = $('refresh');
    btn.classList.add('is-loading');
    return load().then(render).catch(function (err) {
      console.error(err);
      var el = $('notice');
      el.hidden = false;
      el.textContent = 'โหลดข้อมูลไม่สำเร็จ ลองใหม่อีกครั้ง';
      if (!state.data) $('updated').textContent = 'โหลดข้อมูลไม่สำเร็จ';
    }).then(function () { btn.classList.remove('is-loading'); });
  }

  // ---------- events ----------
  $('refresh').addEventListener('click', refresh);

  $('filters').addEventListener('click', function (e) {
    var b = e.target.closest('.chip');
    if (!b) return;
    var lv = b.dataset.level;
    state.visible[lv] = !state.visible[lv];
    b.classList.toggle('is-on', state.visible[lv]);
    applyFilters();
  });

  $('top-list').addEventListener('click', function (e) {
    var li = e.target.closest('li[data-id]');
    if (li) focusStation(li.dataset.id);
  });
  $('top-list').addEventListener('keydown', function (e) {
    var li = e.target.closest('li[data-id]');
    if (li && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); focusStation(li.dataset.id); }
  });

  // Marker colours come from CSS variables, so redraw when the colour scheme flips.
  if (window.matchMedia) {
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', function () {
      if (state.data) renderMap(state.data.stations);
    });
  }

  document.addEventListener('visibilitychange', function () { if (!document.hidden) refresh(); });
  setInterval(function () { if (!document.hidden) refresh(); }, REFRESH_MS);
  refresh();
})();
