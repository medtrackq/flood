(function () {
  'use strict';

  // Camera list and images come through server.mjs, which caches what POPNIX collects.
  var LIST_URL = '/api/cams';
  var PAGE = 12;
  var OLD_MIN = 60;
  var REFRESH_MS = 2 * 60 * 1000;

  var C = { cams: [], q: '', shown: PAGE, view: null, near: null };
  var NEAR_KM = 5;
  var $ = function (id) { return document.getElementById(id); };

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function mins(c) { return Math.max(0, (Date.now() / 1000 - c.img) / 60); }

  function ago(c) {
    var m = mins(c);
    if (m < 1) return 'เมื่อสักครู่';
    if (m < 60) return Math.round(m) + ' นาทีก่อน';
    if (m < 1440) return Math.floor(m / 60) + ' ชม. ก่อน';
    return 'เกิน 1 วัน';
  }

  function hm(c) {
    return new Date(c.img * 1000).toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Bangkok' }) + ' น.';
  }

  function src(c) { return '/cam/' + c.f + '/' + encodeURIComponent(c.id) + '.jpg?t=' + c.img; }

  // Sources abbreviate inconsistently (ถนน/ถ., ซอย/ซ.), so compare on one spelling without spaces.
  function norm(s) {
    return String(s || '').toLowerCase()
      .replace(/ถนน/g, 'ถ.').replace(/ซอย/g, 'ซ.').replace(/คลอง/g, 'ค.')
      .replace(/\s+/g, '');
  }

  function prepare(cams) {
    cams.forEach(function (c) { c._text = norm(c.name + ' ' + c.detail + ' ' + c.org); });
    // Flood-watch cameras first, then fresh images, newest first; stale ones sink to the end.
    cams.sort(function (a, b) {
      return (b.flood - a.flood) ||
        ((mins(a) > OLD_MIN) - (mins(b) > OLD_MIN)) ||
        (b.img - a.img);
    });
    // A site often has several cameras under one name; show one of each before the rest.
    var seen = {}, first = [], rest = [];
    cams.forEach(function (c) { (seen[c.name] ? rest : first).push(c); seen[c.name] = true; });
    return first.concat(rest);
  }

  function km(c) {
    var x = (c.lng - C.near.lng) * Math.cos(C.near.lat * Math.PI / 180) * 111.32, y = (c.lat - C.near.lat) * 110.57;
    return Math.sqrt(x * x + y * y);
  }

  function matches() {
    if (C.near) {
      return C.cams.filter(function (c) { return c.lat != null && (c._km = km(c)) <= NEAR_KM; })
        .sort(function (a, b) { return a._km - b._km; });
    }
    var terms = C.q.split(/[\s,]+/).map(norm).filter(Boolean);
    if (!terms.length) return C.cams;
    return C.cams.filter(function (c) {
      return terms.every(function (t) { return c._text.indexOf(t) !== -1; });
    });
  }

  function tile(c) {
    var old = mins(c) > OLD_MIN;
    return '<li><button type="button" class="cc-tile" data-key="' + esc(c.f + ':' + c.id) + '">' +
      '<span class="cc-tile__img"><img src="' + esc(src(c)) + '" alt="" loading="lazy" decoding="async">' +
        '<em class="cc-age' + (old ? ' is-old' : '') + '">' + esc(ago(c)) + '</em>' +
        (c.flood ? '<em class="cc-flag">เฝ้าน้ำท่วม</em>' : '') +
      '</span>' +
      '<span class="cc-tile__name">' + esc(c.name) + '</span>' +
      '<span class="cc-tile__sub">' + (C.near ? '<b>ห่าง ' + (c._km < 1 ? Math.round(c._km * 100) * 10 + ' ม.' : c._km.toFixed(1) + ' กม.') + '</b> · ' : '') +
        esc(c.detail ? c.detail + ' · ' + c.org : c.org) + '</span>' +
    '</button></li>';
  }

  function render() {
    var list = matches();
    var shown = list.slice(0, C.shown);
    $('cc-tiles').innerHTML = shown.length ? shown.map(tile).join('')
      : '<li class="cc-empty">ไม่พบกล้องที่ตรงกับคำค้น ลองพิมพ์ชื่อถนนหรือแยกให้สั้นลง</li>';
    document.querySelectorAll('#cc-quick button').forEach(function (b) { b.classList.toggle('is-on', b.textContent === C.q); });
    $('cc-head').innerHTML = '';
    $('cc-head').textContent = C.near
      ? (list.length ? 'กล้องใกล้คุณ ' + list.length.toLocaleString('th-TH') + ' ตัวในรัศมี ' + NEAR_KM + ' กม. เรียงจากใกล้ไปไกล' : 'ไม่มีกล้องในรัศมี ' + NEAR_KM + ' กม.')
      : C.q
      ? (list.length ? 'พบ ' + list.length.toLocaleString('th-TH') + ' กล้องที่ตรงกับ "' + C.q + '"' : 'ไม่พบกล้องที่ตรงกับ "' + C.q + '"')
      : 'กล้องทั้งหมด ' + C.cams.length.toLocaleString('th-TH') + ' ตัว เรียงจากกล้องเฝ้าน้ำท่วมและภาพล่าสุด';
    if (C.near) {
      var x = document.createElement('button');
      x.type = 'button'; x.className = 'link-btn'; x.textContent = 'ดูกล้องทั้งหมด';
      x.addEventListener('click', function () { C.near = null; C.shown = PAGE; render(); });
      $('cc-head').append(' · ', x);
    }
    var more = $('cc-more');
    more.hidden = shown.length >= list.length;
    more.textContent = 'แสดงเพิ่ม (เหลืออีก ' + (list.length - shown.length).toLocaleString('th-TH') + ')';
  }

  function show(c) {
    var img = $('cc-view-img');
    img.src = src(c);
    img.alt = c.name;
    $('cc-view-name').textContent = c.name;
    $('cc-view-meta').textContent = [c.detail, c.org, 'ภาพเมื่อ ' + hm(c) + ' (' + ago(c) + ')'].filter(Boolean).join(' · ');
  }

  function open(key) {
    var list = matches();
    var i = list.findIndex(function (x) { return x.f + ':' + x.id === key; });
    if (i < 0) return;
    var dlg = $('cc-view');
    if (!dlg.showModal) { window.open(src(list[i]), '_blank', 'noopener'); return; }
    C.view = i;
    show(list[i]);
    if (!dlg.open) dlg.showModal();
  }

  // Step through the cameras matching the current search, wrapping at either end.
  function step(dir) {
    var list = matches();
    if (C.view == null || !list.length) return;
    C.view = (C.view + dir + list.length) % list.length;
    show(list[C.view]);
  }

  function load() {
    return fetch(LIST_URL, { cache: 'no-cache' }).then(function (r) {
      if (!r.ok) throw new Error(LIST_URL + ' ' + r.status);
      return r.json();
    }).then(function (d) {
      if (!d || !Array.isArray(d.cams)) throw new Error('bad payload');
      C.cams = prepare(d.cams);
      render();
    }).catch(function (err) {
      console.error(err);
      if (C.cams.length) return;
      $('cc-head').textContent = 'โหลดรายการกล้องไม่สำเร็จ (ต้องเปิดผ่าน server.mjs)';
      $('cc-tiles').innerHTML = '';
    });
  }

  // ---------- events ----------
  var typing;
  $('cc-q').addEventListener('input', function (e) {
    clearTimeout(typing);
    typing = setTimeout(function () {
      C.q = e.target.value.trim();
      C.near = null;
      C.shown = PAGE;
      render();
    }, 200);
  });

  $('cc-quick').addEventListener('click', function (e) {
    var b = e.target.closest('button');
    if (!b) return;
    var q = b.classList.contains('is-on') ? '' : b.textContent;
    $('cc-q').value = q;
    C.q = q;
    C.near = null;
    C.shown = PAGE;
    render();
  });

  $('cc-more').addEventListener('click', function () {
    C.shown += PAGE;
    render();
  });

  $('cc-tiles').addEventListener('click', function (e) {
    var b = e.target.closest('.cc-tile');
    if (b) open(b.dataset.key);
  });

  // A broken image shows a placeholder instead of the browser's broken-image icon.
  $('cc-tiles').addEventListener('error', function (e) {
    if (e.target.tagName === 'IMG') e.target.closest('.cc-tile__img').classList.add('is-broken');
  }, true);

  $('cc-view').addEventListener('click', function (e) {
    if (e.target === e.currentTarget) e.currentTarget.close(); // backdrop click
  });
  $('cc-view').addEventListener('close', function () { C.view = null; });
  $('cc-prev').addEventListener('click', function () { step(-1); });
  $('cc-next').addEventListener('click', function () { step(1); });
  $('cc-view').addEventListener('keydown', function (e) {
    if (e.key === 'ArrowLeft') { e.preventDefault(); step(-1); }
    if (e.key === 'ArrowRight') { e.preventDefault(); step(1); }
  });

  document.addEventListener('visibilitychange', function () { if (!document.hidden) load(); });
  setInterval(function () { if (!document.hidden) load(); }, REFRESH_MS);
  // Used by near.js: list cameras around a point, nearest first.
  window.FloodCams = {
    near: function (p) {
      C.near = { lat: +p.lat, lng: +p.lng };
      C.q = '';
      $('cc-q').value = '';
      C.shown = PAGE;
      render();
      $('cctv').scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  };

  load();
})();
