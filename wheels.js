// POS wheels: spin to pick a day, a time or a length, the same on the iPad, the phone and a Windows computer.
// Each wheel stops at its ends (no wrapping round), and each group writes into a hidden field the rest of POS reads:
//   <div data-wheel="date" data-for="f_date">      YYYY-MM-DD, or '' for no day
//   <div data-wheel="time" data-for="f_time">      HH:MM (24-hour, 5-minute steps), or '' for no time
//   <div data-wheel="duration" data-for="f_mins">  minutes in 5-minute steps, '' for none
// Spinning fires an input event on that field; after setting a field by hand, call POSWheels.sync().
window.POSWheels = (function () {
  const ITEM = 34;
  const pad = n => String(n).padStart(2, '0');
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const todayKey = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };

  // one column: native scrolling (momentum on the iPad), snapping row by row; a mouse can drag it or roll it
  function column(label, w, unit) {
    const el = document.createElement('div');
    el.className = 'wh-col';
    el.style.width = w + 'px';
    el.tabIndex = 0;
    el.setAttribute('role', 'spinbutton');
    el.setAttribute('aria-label', label);
    const c = { el, items: [], i: 0, done: -1, onPick: null };
    let t = null, drag = null, acc = 0;
    const idx = () => Math.max(0, Math.min(c.items.length - 1, Math.round(el.scrollTop / ITEM)));
    function mark(i) {
      const prev = el.querySelector('.wh-it.on');
      if (prev) prev.classList.remove('on');
      const it = el.children[i + 1];
      if (it) it.classList.add('on');
      el.setAttribute('aria-valuenow', i);
      el.setAttribute('aria-valuetext', c.items[i] ? c.items[i].t + (unit ? ' ' + unit : '') : '');
    }
    function settle() {
      clearTimeout(t);
      const i = idx();
      c.i = i; mark(i);
      if (i !== c.done) { c.done = i; if (c.onPick) c.onPick(c); }
    }
    c.setItems = (items, keep) => {
      c.items = items;
      el.innerHTML = `<div class="wh-pad"></div>${items.map((it, i) => `<div class="wh-it" data-i="${i}">${it.t}</div>`).join('')}<div class="wh-pad"></div>`;
      if (keep != null) c.set(Math.min(keep, items.length - 1));
    };
    c.set = (i, smooth) => {
      i = Math.max(0, Math.min(c.items.length - 1, i));
      c.i = i;
      if (!smooth) c.done = i;
      mark(i);
      if (smooth) el.scrollTo({ top: i * ITEM, behavior: 'smooth' });
      else el.scrollTop = i * ITEM;
    };
    c.val = () => (c.items[c.i] || {}).v;
    el.addEventListener('scroll', () => {
      mark(idx());
      clearTimeout(t);
      t = setTimeout(settle, drag ? 400 : 140);
    }, { passive: true });
    if ('onscrollend' in window) el.addEventListener('scrollend', () => { if (!drag) settle(); });
    // a mouse: drag it up and down, or roll the wheel one row per notch
    el.addEventListener('pointerdown', e => {
      if (e.pointerType !== 'mouse' || e.button !== 0) return;
      drag = { y0: e.clientY, top0: el.scrollTop, moved: false };
      el.classList.add('dragging');
      try { el.setPointerCapture(e.pointerId); } catch (err) {}
    });
    el.addEventListener('pointermove', e => {
      if (!drag) return;
      const dy = e.clientY - drag.y0;
      if (Math.abs(dy) > 3) drag.moved = true;
      el.scrollTop = drag.top0 - dy;
    });
    const endDrag = e => {
      if (!drag) return;
      const d = drag; drag = null;
      el.classList.remove('dragging');
      if (d.moved) c.set(idx(), true);
      else { const it = e.target.closest && e.target.closest('.wh-it'); if (it) c.set(+it.dataset.i, true); }
    };
    el.addEventListener('pointerup', endDrag);
    el.addEventListener('pointercancel', endDrag);
    el.addEventListener('wheel', e => {
      e.preventDefault();
      acc += e.deltaY;
      const step = Math.trunc(acc / 40);
      if (step) { acc -= step * 40; c.set(c.i + step, true); }
    }, { passive: false });
    // a finger: tap a row to go to it (a swipe scrolls natively)
    el.addEventListener('click', e => {
      if (e.pointerType === 'mouse') return;
      const it = e.target.closest('.wh-it');
      if (it) c.set(+it.dataset.i, true);
    });
    el.addEventListener('keydown', e => {
      const d = { ArrowUp: -1, ArrowDown: 1, PageUp: -5, PageDown: 5 }[e.key];
      if (d == null) return;
      e.preventDefault();
      c.set(c.i + d, true);
    });
    return c;
  }
  const range = (a, b, step = 1, fmt = String) => { const out = []; for (let v = a; v <= b; v += step) out.push({ v, t: fmt(v) }); return out; };
  const fire = input => input.dispatchEvent(new Event('input', { bubbles: true }));

  function datePicker(host, input) {
    const M = column('Month', 50), D = column('Day', 38), Y = column('Year', 58);
    host.append(M.el, D.el, Y.el);
    M.setItems(MONTHS.map((t, i) => ({ v: i + 1, t })));
    let years = [];
    const setYears = y => {
      const y0 = new Date().getFullYear(), a = Math.min(y0 - 2, y), b = Math.max(y0 + 5, y);
      if (years[0] === a && years[years.length - 1] === b) return;
      years = range(a, b);
      Y.setItems(years);
    };
    const setDays = (y, m) => { const n = new Date(y, m, 0).getDate(); if (D.items.length !== n) D.setItems(range(1, n), Math.min(D.i, n - 1)); };
    function show() {
      const v = input.value || todayKey(), [y, m, d] = v.split('-').map(Number);
      host.classList.toggle('off', !input.value);
      setYears(y); setDays(y, m);
      M.set(m - 1); Y.set(years.findIndex(x => x.v === y)); D.set(d - 1);
    }
    function pick() {
      const y = Y.val(), m = M.val();
      setDays(y, m);
      input.value = `${y}-${pad(m)}-${pad(D.val())}`;
      host.classList.remove('off');
      fire(input);
    }
    M.onPick = D.onPick = Y.onPick = pick;
    return { show };
  }

  function timePicker(host, input) {
    const H = column('Hour', 38), Mi = column('Minute', 42), P = column('AM or PM', 46);
    host.append(H.el, Mi.el, P.el);
    H.setItems(range(1, 12));
    Mi.setItems(range(0, 55, 5, pad));
    P.setItems([{ v: 0, t: 'AM' }, { v: 1, t: 'PM' }]);
    function show() {
      const v = input.value || host.dataset.default || '09:00', [h, m] = v.split(':').map(Number);
      host.classList.toggle('off', !input.value);
      H.set((h % 12 || 12) - 1); Mi.set(Math.min(11, Math.round(m / 5))); P.set(h >= 12 ? 1 : 0);
    }
    function pick() {
      const h = (H.val() % 12) + (P.val() ? 12 : 0);
      input.value = `${pad(h)}:${pad(Mi.val())}`;
      host.classList.remove('off');
      fire(input);
    }
    H.onPick = Mi.onPick = P.onPick = pick;
    return { show };
  }

  function durationPicker(host, input) {
    const H = column('Hours', 40, 'hours'), Mi = column('Minutes', 44, 'minutes');
    const u1 = document.createElement('span'), u2 = document.createElement('span');
    u1.className = u2.className = 'wh-unit'; u1.textContent = 'h'; u2.textContent = 'min';
    host.append(H.el, u1, Mi.el, u2);
    H.setItems(range(0, 23));
    Mi.setItems(range(0, 55, 5, pad));
    function show() {
      const v = Number(input.value) || 0;
      H.set(Math.min(23, Math.floor(v / 60))); Mi.set(Math.min(11, Math.round((v % 60) / 5)));
    }
    function pick() {
      const mins = H.val() * 60 + Mi.val();
      input.value = mins ? String(mins) : '';
      fire(input);
    }
    H.onPick = Mi.onPick = pick;
    return { show };
  }

  const KINDS = { date: datePicker, time: timePicker, duration: durationPicker };
  const groups = [];
  function mount(root) {
    for (const host of (root || document).querySelectorAll('[data-wheel]')) {
      if (host._wheel) continue;
      const input = document.getElementById(host.dataset.for), make = KINDS[host.dataset.wheel];
      if (!input || !make) continue;
      host.classList.add('wh-group');
      host._wheel = make(host, input);
      groups.push(host._wheel);
    }
  }
  // after a field was set some other way (the sheet opening, Today, the × button)
  function sync() { for (const g of groups) g.show(); }
  return { mount, sync };
})();
