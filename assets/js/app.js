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

  var meMarker = null;

  // Where the water level sits against the watch and critical lines.
  function gaugeHTML(st) {
    if (st.wl == null || st.warn == null || st.crit == null || st.crit <= st.warn) return '';
    var lo = Math.min(st.wl, st.warn) - 0.4, hi = Math.max(st.wl, st.crit) + 0.3;
    var pct = function (v) { return ((v - lo) / (hi - lo) * 100).toFixed(1) + '%'; };
    return '<div class="pop__gauge" style="--w:' + pct(st.warn) + ';--c:' + pct(st.crit) + '" role="img" aria-label="ระดับน้ำเทียบเกณฑ์">' +
      '<i style="left:' + pct(st.wl) + '"></i></div>' +
      '<div class="pop__gauge-lbl"><span>ปกติ</span><span>เฝ้าระวัง</span><span>วิกฤต</span></div>';
  }

  function popupHTML(st) {
    var lv = levelOf(st);
    var gap = st.crit != null && st.wl != null ? st.crit - st.wl : null;
    return '<div class="pop">' +
      '<div class="pop__name">' + esc(st.name) + '</div>' +
      '<div class="pop__river">' + esc(st.river || '') + '</div>' +
      '<div class="pop__level"><i class="dot dot--' + LEVELS[lv].color + '"></i>' + LEVELS[lv].label + '</div>' +
      '<div class="pop__wl">' + num(st.wl) + ' <small>ม.รทก.</small></div>' +
      gaugeHTML(st) +
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
      '<div class="pop__time">วัดเมื่อ ' + dateTimeTH(st.measured_at) + ' · กราฟ 6 ชม. ล่าสุด</div>' +
    '</div>';
  }

  function renderMap(stations) {
    var open = null;
    layer.eachLayer(function (m) { if (m.isPopupOpen && m.isPopupOpen()) open = m._sid; });
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
      }).bindPopup(popupHTML(st), { maxWidth: 290, autoPanPadding: [20, 20] })
        .bindTooltip(esc(st.name) + (st.wl != null ? ' · ' + num(st.wl) + ' ม.' : ''), { direction: 'top', offset: [0, -6] });
      m._level = lv;
      m._sid = st.id;
      state.markers[st.id] = m;
      if (state.visible[lv]) m.addTo(layer);
    });
    // Keep the popup someone is reading open across the auto-refresh.
    if (open != null && state.markers[open] && state.visible[state.markers[open]._level]) state.markers[open].openPopup();
  }

  function syncFilters() {
    var all = true;
    document.querySelectorAll('#filters .chip[data-level]').forEach(function (b) {
      var on = state.visible[b.dataset.level];
      b.classList.toggle('is-on', on);
      b.setAttribute('aria-pressed', on);
      if (!on) all = false;
    });
    $('filter-all').hidden = all;
    Object.keys(state.markers).forEach(function (id) {
      var m = state.markers[id];
      if (state.visible[m._level]) layer.addLayer(m); else layer.removeLayer(m);
    });
  }

  function showOnly(level) {
    Object.keys(state.visible).forEach(function (k) { state.visible[k] = k === level; });
    syncFilters();
    var pts = [];
    Object.keys(state.markers).forEach(function (id) { if (state.markers[id]._level === level) pts.push(state.markers[id].getLatLng()); });
    $('map-sec').scrollIntoView({ behavior: 'smooth', block: 'start' });
    if (pts.length) map.fitBounds(L.latLngBounds(pts), { padding: [30, 30], maxZoom: 13 });
  }

  // ---------- panels ----------
  function bkkMinutes() {
    var p = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Bangkok' }).format(new Date()).split(':');
    return +p[0] * 60 + +p[1];
  }
  function toMin(hhmm) { var p = String(hhmm).split(':'); return +p[0] * 60 + +p[1]; }

  function tideEvents(t) {
    if (!t) return [];
    return [['high_am', 'น้ำขึ้น', true], ['low_am', 'น้ำลง', false], ['high_pm', 'น้ำขึ้น', true], ['low_pm', 'น้ำลง', false]]
      .filter(function (r) { return t[r[0]] && t[r[0]].t; })
      .map(function (r) { return { label: r[1], high: r[2], t: t[r[0]].t, v: t[r[0]].v, min: toMin(t[r[0]].t) }; })
      .sort(function (a, b) { return a.min - b.min; });
  }

  function renderHero(sum) {
    var online = sum.online || 1;
    var trend = sum.up >= 10 && sum.up > sum.down * 1.5 ? 'น้ำในคลองหลายจุดกำลังขึ้น'
      : sum.down >= 10 && sum.down > sum.up * 1.5 ? 'น้ำในคลองส่วนใหญ่กำลังลด'
      : 'น้ำในคลองส่วนใหญ่ทรงตัว';
    var tone = sum.crit / online >= 0.25 || (sum.crit > 0 && sum.up > sum.down * 2 && sum.up >= 20) ? 'crit'
      : sum.crit + sum.warn > 0 ? 'warn' : 'ok';
    var hero = $('overview');
    hero.classList.remove('hero--crit', 'hero--warn', 'hero--ok');
    hero.classList.add('hero--' + tone);
    $('hero-title').textContent = trend;
    $('hero-text').textContent = (sum.crit + sum.warn > 0
      ? 'ถึงระดับวิกฤต ' + sum.crit + ' จุด และเกินระดับเฝ้าระวัง ' + sum.warn + ' จุด'
      : 'ทุกจุดวัดต่ำกว่าระดับเฝ้าระวัง') +
      ' จากจุดวัดที่ส่งค่า ' + sum.online + ' จุด · ใน 1 ชม. น้ำขึ้น ' + sum.up + ' จุด ลด ' + sum.down + ' จุด';

    var now = bkkMinutes();
    var next = tideEvents(sum.tide).filter(function (e) { return e.high && e.min >= now; })[0];
    $('hero-tide').hidden = !next;
    if (next) {
      $('hero-tide-k').textContent = 'น้ำทะเลหนุนสูงสุดรอบถัดไป';
      $('hero-tide-v').textContent = next.t + ' น. · ' + num(next.v) + ' ม.';
    }
  }

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
    document.querySelectorAll('#filters .chip[data-level]').forEach(function (b) {
      var c = b.querySelector('.count') || b.appendChild(document.createElement('span'));
      c.className = 'count';
      c.textContent = counts[b.dataset.level];
    });
  }

  function renderTide(t) {
    var el = $('tide');
    var ev = tideEvents(t);
    if (!ev.length) { el.innerHTML = '<li class="muted">ไม่มีข้อมูล</li>'; $('tide-date').textContent = ''; return; }
    $('tide-date').textContent = parseTH(t.date + ' 00:00:00').toLocaleDateString('th-TH', { day: 'numeric', month: 'long', timeZone: 'Asia/Bangkok' });
    var now = bkkMinutes();
    var nextIdx = ev.findIndex(function (e) { return e.min >= now; });
    el.innerHTML = ev.map(function (e, i) {
      var cls = i === nextIdx ? 'is-next' : e.min < now ? 'is-past' : '';
      return '<li class="' + cls + '"><div class="k">' + (e.high ? '▲ ' : '▼ ') + e.label + '</div>' +
        '<div class="v">' + num(e.v) + ' ม.</div><div class="t">' + esc(e.t) + ' น.</div></li>';
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
    el.innerHTML = list.map(function (x, i) {
      var st = x.st, lv = levelOf(st), v = Math.round(x.over * 100);
      var badge = v >= 0 ? '<span class="badge badge--crit">เกินวิกฤต ' + v + ' ซม.</span>'
        : '<span class="badge badge--' + (lv === 'warn' ? 'warn' : 'ok') + '">ต่ำกว่าวิกฤต ' + (-v) + ' ซม.</span>';
      return '<li class="is-link" data-id="' + st.id + '" tabindex="0" role="button">' +
        '<span class="rank">' + (i + 1) + '</span>' +
        '<div style="min-width:0"><div class="name">' + esc(st.name) + '</div><div class="sub">' + trendHTML(st) + '</div></div>' +
        '<div class="val">' + num(st.wl) + ' ม.<br>' + badge + '</div>' +
      '</li>';
    }).join('');
  }

  function focusStation(id) {
    var m = state.markers[id];
    if (!m) return;
    if (!state.visible[m._level]) { state.visible[m._level] = true; syncFilters(); }
    $('map-sec').scrollIntoView({ behavior: 'smooth', block: 'start' });
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

  function renderUpdated() {
    if (!state.data) return;
    var sum = state.data.summary;
    var d = parseTH(sum.latest);
    var m = d ? Math.max(0, Math.round((Date.now() - d) / 60000)) : null;
    $('updated').textContent = m == null ? '–'
      : 'อัปเดต ' + (m < 1 ? 'เมื่อสักครู่' : m < 60 ? m + ' นาทีก่อน' : timeTH(sum.latest));
    $('updated').title = 'ข้อมูลล่าสุด ' + dateTimeTH(sum.latest);
    var live = $('live');
    live.classList.toggle('is-fresh', !sum.stale && m != null && m <= 20 && state.live);
    live.classList.toggle('is-stale', !!sum.stale || !state.live || (m != null && m > 45));
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
    state.live = res.src.live;
    renderHero(sum);
    renderStats(sum, d.stations);
    renderMap(d.stations);
    renderTide(sum.tide);
    renderTop(d.stations);
    renderNotice(sum, res.src);
    renderUpdated();
    document.dispatchEvent(new CustomEvent('flood:data', { detail: d }));
  }

  function refresh() {
    var btn = $('refresh');
    btn.classList.add('is-loading');
    return load().then(render).catch(function (err) {
      console.error(err);
      var el = $('notice');
      el.hidden = false;
      el.textContent = 'โหลดข้อมูลไม่สำเร็จ ลองกดปุ่มโหลดใหม่อีกครั้ง';
      if (!state.data) $('updated').textContent = 'โหลดไม่สำเร็จ';
    }).then(function () { btn.classList.remove('is-loading'); });
  }

  // ---------- locate ----------
  function showMe(me) {
    if (meMarker) map.removeLayer(meMarker);
    meMarker = L.marker([me.lat, me.lng], {
      icon: L.divIcon({ className: '', html: '<div class="me-marker"></div>', iconSize: [16, 16], iconAnchor: [8, 8] }),
      keyboard: false, interactive: false, zIndexOffset: 1000
    }).addTo(map);
  }

  function km(a, b) {
    var x = (b.lng - a.lng) * Math.cos((a.lat + b.lat) * Math.PI / 360), y = b.lat - a.lat;
    return Math.sqrt(x * x + y * y) * 111.32;
  }

  function locate() {
    var btn = $('locate');
    var label = btn.querySelector('span');
    var say = function (msg) {
      label.textContent = msg;
      setTimeout(function () { label.textContent = 'จุดวัดใกล้ฉัน'; }, 3500);
    };
    if (!navigator.geolocation) { say('เครื่องนี้หาตำแหน่งไม่ได้'); return; }
    btn.classList.add('is-loading');
    navigator.geolocation.getCurrentPosition(function (pos) {
      btn.classList.remove('is-loading');
      var me = { lat: pos.coords.latitude, lng: pos.coords.longitude };
      showMe(me);
      var best = null, bestKm = Infinity;
      (state.data ? state.data.stations : []).forEach(function (st) {
        if (!st.online || st.lat == null) return;
        var d = km(me, st);
        if (d < bestKm) { bestKm = d; best = st; }
      });
      if (!best) { map.setView([me.lat, me.lng], 14); return; }
      var m = state.markers[best.id];
      if (!state.visible[m._level]) { state.visible[m._level] = true; syncFilters(); }
      map.fitBounds(L.latLngBounds([[me.lat, me.lng], m.getLatLng()]), { padding: [60, 60], maxZoom: 15, animate: false });
      m.openPopup();
      say('ห่างจากคุณ ' + (bestKm < 1 ? Math.round(bestKm * 1000) + ' ม.' : bestKm.toFixed(1) + ' กม.'));
    }, function (err) {
      btn.classList.remove('is-loading');
      say(err.code === 1 ? 'ไม่ได้รับอนุญาตให้ใช้ตำแหน่ง' : 'หาตำแหน่งไม่สำเร็จ');
    }, { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 });
  }

  // ---------- theme ----------
  function isDark() {
    var t = document.documentElement.dataset.theme;
    return t ? t === 'dark' : window.matchMedia && matchMedia('(prefers-color-scheme: dark)').matches;
  }

  function toggleTheme() {
    var next = isDark() ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem('theme', next); } catch (e) {}
    // Marker and sparkline colours are read from CSS variables at draw time.
    if (state.data) renderMap(state.data.stations);
  }

  // ---------- nav highlight ----------
  // The active link is the last section whose top has passed a line near the top of the viewport.
  function watchSections() {
    var links = document.querySelectorAll('.nav a');
    var ids = ['overview', 'near', 'map-sec', 'cctv'].filter(function (id) { return $(id); });
    var ticking = false;
    function update() {
      ticking = false;
      var line = Math.min(window.innerHeight * 0.35, 240), cur = ids[0];
      ids.forEach(function (id) { if ($(id).getBoundingClientRect().top <= line) cur = id; });
      // At the very bottom the last section wins even if it is short.
      if (window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 4) cur = ids[ids.length - 1];
      links.forEach(function (a) { a.classList.toggle('is-active', a.dataset.sec === cur); });
    }
    window.addEventListener('scroll', function () { if (!ticking) { ticking = true; requestAnimationFrame(update); } }, { passive: true });
    window.addEventListener('resize', update);
    update();
  }

  // ---------- events ----------
  $('refresh').addEventListener('click', refresh);
  $('theme').addEventListener('click', toggleTheme);
  $('locate').addEventListener('click', locate);

  $('filters').addEventListener('click', function (e) {
    var b = e.target.closest('.chip');
    if (!b) return;
    if (b.id === 'filter-all') {
      Object.keys(state.visible).forEach(function (k) { state.visible[k] = true; });
    } else {
      state.visible[b.dataset.level] = !state.visible[b.dataset.level];
    }
    syncFilters();
  });

  document.querySelectorAll('.stat[data-only]').forEach(function (b) {
    b.addEventListener('click', function () { showOnly(b.dataset.only); });
  });

  $('top-list').addEventListener('click', function (e) {
    var li = e.target.closest('li[data-id]');
    if (li) focusStation(li.dataset.id);
  });
  $('top-list').addEventListener('keydown', function (e) {
    var li = e.target.closest('li[data-id]');
    if (li && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); focusStation(li.dataset.id); }
  });

  if (window.matchMedia) {
    matchMedia('(prefers-color-scheme: dark)').addEventListener('change', function () {
      if (state.data && !document.documentElement.dataset.theme) renderMap(state.data.stations);
    });
  }

  // Shared with near.js and cctv.js.
  window.Flood = {
    map: map,
    data: function () { return state.data; },
    focusStation: focusStation,
    showMe: showMe,
    km: km,
    levelOf: levelOf,
    LEVELS: LEVELS
  };

  watchSections();
  document.addEventListener('visibilitychange', function () { if (!document.hidden) refresh(); });
  setInterval(function () { if (!document.hidden) refresh(); }, REFRESH_MS);
  setInterval(renderUpdated, 30000);
  refresh();
})();
