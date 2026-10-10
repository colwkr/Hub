// POS keyboard: on the iPad and phone, every text field in POS uses this keyboard instead of the system one.
// It docks at the bottom, whatever you're typing in moves up above it, and the globe key hands that field back to the
// system keyboard (for dictation or autocorrect) until you leave it. Number and money fields get a number pad.
// Computers and iPads with a keyboard attached keep typing normally. A field can opt out with data-osk="off".
window.POSKeys = function (opts) {
  const scope = (opts && opts.scope) || 'body';
  const mq = window.matchMedia ? matchMedia('(hover: none) and (pointer: coarse)') : null;
  const on = () => !!(mq && mq.matches);
  const SEL = 'input[type="text"], input[type="number"], input[type="search"], input[type="email"], input[type="url"], input[type="tel"], input:not([type]), textarea';
  const svg = d => `<svg class="i" viewBox="0 0 24 24" aria-hidden="true">${d}</svg>`;
  const IC = {
    back: svg('<path d="M9 6.5h10a1.5 1.5 0 0 1 1.5 1.5v8a1.5 1.5 0 0 1-1.5 1.5H9L3.5 12z"/><path d="m11.5 10 4 4M15.5 10l-4 4"/>'),
    shift: svg('<path d="M12 4.5 4.5 12H8.5v6.5h7V12h4z"/>'),
    lock: svg('<path d="M12 4.5 4.5 11H8.5v5h7v-5h4z"/><path d="M8.5 19.5h7"/>'),
    globe: svg('<circle cx="12" cy="12" r="8"/><path d="M4 12h16M12 4c2.4 2.3 2.4 13.7 0 16M12 4c-2.4 2.3-2.4 13.7 0 16"/>'),
    hide: svg('<rect x="3.5" y="4.5" width="17" height="10" rx="2"/><path d="M7 8h.01M10 8h.01M13 8h.01M16 8h.01M8 11.5h8M9.5 17.5 12 20l2.5-2.5"/>'),
  };
  // rows of keys; a key is a character, or [action, width, label]
  const L = {
    abc: [
      ['q', 'w', 'e', 'r', 't', 'y', 'u', 'i', 'o', 'p', ['back', 1.5]],
      ['a', 's', 'd', 'f', 'g', 'h', 'j', 'k', 'l', "'", ['enter', 1.9]],
      [['shift', 1.5], 'z', 'x', 'c', 'v', 'b', 'n', 'm', ',', '.', ['shift', 1.4]],
      [['num', 1.6, '123'], ['globe', 1.1], ['space', 6.4], ['num', 1.6, '123'], ['hide', 1.3]],
    ],
    num: [
      ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0', ['back', 1.5]],
      ['-', '/', ':', ';', '(', ')', '$', '&', '@', '"', ['enter', 1.9]],
      [['sym', 1.5, '#+='], '.', ',', '?', '!', "'", '%', '+', '=', '*', ['sym', 1.4, '#+=']],
      [['abc', 1.6, 'ABC'], ['globe', 1.1], ['space', 6.4], ['abc', 1.6, 'ABC'], ['hide', 1.3]],
    ],
    sym: [
      ['[', ']', '{', '}', '#', '%', '^', '*', '+', '=', ['back', 1.5]],
      ['_', '\\', '|', '~', '<', '>', '€', '£', '¥', '•', ['enter', 1.9]],
      [['num', 1.5, '123'], '.', ',', '?', '!', "'", '`', '°', '…', '·', ['num', 1.4, '123']],
      [['abc', 1.6, 'ABC'], ['globe', 1.1], ['space', 6.4], ['abc', 1.6, 'ABC'], ['hide', 1.3]],
    ],
    pad: [['1', '2', '3'], ['4', '5', '6'], ['7', '8', '9'], [['hide', 1], '0', ['back', 1]]],
    money: [['1', '2', '3'], ['4', '5', '6'], ['7', '8', '9'], ['.', '0', ['back', 1]], [['hide', 1], ['enter', 2]]],
  };
  // phones: the narrower layout, Backspace beside M and Return on the bottom row
  const PHONE = {
    abc: [
      ['q', 'w', 'e', 'r', 't', 'y', 'u', 'i', 'o', 'p'],
      [['gap', .5], 'a', 's', 'd', 'f', 'g', 'h', 'j', 'k', 'l', ['gap', .5]],
      [['shift', 1.4], ['gap', .1], 'z', 'x', 'c', 'v', 'b', 'n', 'm', ['gap', .1], ['back', 1.4]],
      [['num', 1.3, '123'], ['globe', 1.1], ['space', 4.6], ['enter', 2]],
    ],
    num: [
      ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0'],
      ['-', '/', ':', ';', '(', ')', '$', '&', '@', '"'],
      [['sym', 1.4, '#+='], ['gap', .1], '.', ',', '?', '!', "'", ['gap', .1], ['back', 1.4]],
      [['abc', 1.3, 'ABC'], ['globe', 1.1], ['space', 4.6], ['enter', 2]],
    ],
    sym: [
      ['[', ']', '{', '}', '#', '%', '^', '*', '+', '='],
      ['_', '\\', '|', '~', '<', '>', '€', '£', '¥', '•'],
      [['num', 1.4, '123'], ['gap', .1], '.', ',', '?', '!', "'", ['gap', .1], ['back', 1.4]],
      [['abc', 1.3, 'ABC'], ['globe', 1.1], ['space', 4.6], ['enter', 2]],
    ],
  };

  let kb = null, target = null, mode = 'abc', shift = 'off', lastShift = 0, rep = null, held = null, native = null;
  const isNum = el => el && el.type === 'number';
  const padOf = el => (isNum(el) || el.dataset.oskMode === 'numeric' ? 'pad' : el.dataset.oskMode === 'decimal' ? 'money' : null);
  const isArea = el => el && el.tagName === 'TEXTAREA';
  const phone = () => window.innerWidth < 600;
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

  function build() {
    if (kb) return kb;
    kb = document.createElement('div');
    kb.id = 'osk';
    kb.className = 'osk';
    kb.setAttribute('role', 'group');
    kb.setAttribute('aria-label', 'Keyboard');
    if ('popover' in HTMLElement.prototype) kb.setAttribute('popover', 'manual');
    // keys never take the focus away from the field you're typing in
    const keep = e => { if (e.cancelable) e.preventDefault(); };
    kb.addEventListener('mousedown', keep);
    kb.addEventListener('touchstart', keep, { passive: false });
    kb.addEventListener('touchend', e => { keep(e); release(e); }, { passive: false });
    kb.addEventListener('pointerdown', press);
    kb.addEventListener('pointerup', release);
    kb.addEventListener('pointercancel', () => stopRepeat());
    kb.addEventListener('contextmenu', keep);
    return kb;
  }
  function keyHTML(k) {
    if (typeof k === 'string') {
      const ch = shift !== 'off' ? k.toUpperCase() : k;
      return `<button type="button" class="k" data-ch="${esc(ch)}" tabindex="-1" style="--w:1">${esc(ch)}</button>`;
    }
    const [act, w, label] = k;
    if (act === 'gap') return `<span class="k-gap" style="--w:${w}"></span>`;
    const lab = act === 'back' ? IC.back : act === 'shift' ? (shift === 'lock' ? IC.lock : IC.shift) : act === 'globe' ? IC.globe : act === 'hide' ? IC.hide
      : act === 'enter' ? (isArea(target) ? 'return' : 'Done') : act === 'space' ? '' : esc(label || act);
    const names = { back: 'Delete', shift: 'Shift', globe: 'Use the system keyboard', hide: 'Hide keyboard', enter: isArea(target) ? 'Return' : 'Done', space: 'Space' };
    const cls = ['k', 'k-' + act, act === 'shift' && shift !== 'off' ? 'on' : '', act === 'enter' ? 'k-go' : ''].filter(Boolean).join(' ');
    return `<button type="button" class="${cls}" data-act="${act}" tabindex="-1" style="--w:${w}" aria-label="${esc(names[act] || label || act)}"${act === 'shift' ? ` aria-pressed="${shift !== 'off'}"` : ''}>${lab}</button>`;
  }
  function draw() {
    if (!kb || !target) return;
    const pad = padOf(target), rows = pad ? L[pad] : (phone() ? PHONE : L)[mode];
    kb.classList.toggle('pad', pad);
    kb.classList.toggle('phone', phone());
    kb.innerHTML = `<div class="osk-in">${rows.map(r => `<div class="osk-row">${r.map(keyHTML).join('')}</div>`).join('')}</div>`;
  }

  /* ---------- typing ---------- */
  const fire = (el, type) => el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: type }));
  function insert(text) {
    const el = target;
    if (!el) return;
    if (isNum(el)) {
      if (!/^\d$/.test(text) || el.value.length >= 6) return;
      el.value = el.value + text; fire(el, 'insertText'); return;
    }
    if (padOf(el) === 'money' && text === '.' && el.value.includes('.')) return;
    const s = el.selectionStart ?? el.value.length, e = el.selectionEnd ?? s;
    if (el.maxLength > 0 && el.value.length - (e - s) + text.length > el.maxLength) return;
    el.setRangeText(text, s, e, 'end');
    fire(el, text === '\n' ? 'insertLineBreak' : 'insertText');
    keepCaretVisible(el);
  }
  function erase() {
    const el = target;
    if (!el) return;
    if (isNum(el)) { el.value = el.value.slice(0, -1); fire(el, 'deleteContentBackward'); return; }
    const s = el.selectionStart ?? el.value.length, e = el.selectionEnd ?? s;
    if (s !== e) el.setRangeText('', s, e, 'end');
    else if (s > 0) {
      // a whole emoji or accented letter goes in one press
      const before = el.value.slice(0, s), chars = Array.from(before), last = chars[chars.length - 1] || '';
      el.setRangeText('', s - last.length, s, 'end');
    } else return;
    fire(el, 'deleteContentBackward');
    keepCaretVisible(el);
  }
  function keepCaretVisible(el) { if (!isArea(el) && el.selectionEnd === el.value.length) el.scrollLeft = el.scrollWidth; }
  // a capital to start a name, and after a full stop
  function autoShift() {
    const el = target;
    if (!el || isNum(el) || shift === 'lock' || el.dataset.oskCaps === 'off') return;
    const s = el.selectionStart ?? el.value.length, before = el.value.slice(0, s);
    const want = !before.trim() || /[.!?]\s$/.test(before) || /\n$/.test(before);
    const next = want ? 'once' : 'off';
    if (next !== shift) { shift = next; draw(); }
  }

  /* ---------- keys ---------- */
  function press(e) {
    const b = e.target.closest && e.target.closest('.k');
    if (!b || !target) return;
    e.preventDefault();
    b.classList.add('down');
    held = b;
    const ch = b.dataset.ch, act = b.dataset.act;
    if (ch != null) {
      insert(ch);
      if (shift === 'once') { shift = 'off'; draw(); }
      if (mode !== 'abc' && ch === "'") { mode = 'abc'; draw(); }
      autoShift();
      return;
    }
    if (act === 'back') {
      if (!sendKey('Backspace')) return;
      erase(); autoShift();
      rep = setTimeout(function again() { if (!target) return; erase(); autoShift(); rep = setTimeout(again, 70); }, 420);
    }
    else if (act === 'space') {
      insert(' ');
      if (mode !== 'abc') { mode = 'abc'; draw(); }
      autoShift();
    } else if (act === 'shift') {
      const now = Date.now();
      shift = shift === 'off' ? (now - lastShift < 320 ? 'lock' : 'once') : shift === 'once' && now - lastShift < 320 ? 'lock' : 'off';
      lastShift = now; draw();
    } else if (act === 'num' || act === 'sym' || act === 'abc') { mode = act; draw(); }
    else if (act === 'enter') {
      if (!sendKey('Enter')) return;
      if (isArea(target)) { insert('\n'); autoShift(); }
      else { const el = target; hide(); el.blur(); }
    } else if (act === 'hide') { const el = target; hide(); el.blur(); }
    // the globe waits for the finger to lift: the system keyboard only opens from a finished tap
  }
  // a key event the page can act on first; false when it did (and so the keyboard does nothing more)
  function sendKey(key) {
    const el = target, ev = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
    el.dispatchEvent(ev);
    if (ev.defaultPrevented) { setTimeout(() => { const a = document.activeElement; if (a !== el && wants(a)) show(a); else if (a !== el) hide(); }, 0); return false; }
    return true;
  }
  function release(e) {
    stopRepeat();
    const b = held;
    held = null;
    if (!b) return;
    b.classList.remove('down');
    if (b.dataset.act === 'globe' && target && (e.type === 'touchend' || e.type === 'pointerup')) toNative();
  }
  function stopRepeat() { clearTimeout(rep); rep = null; if (held) held.classList.remove('down'); }
  // hand this field to the system keyboard until you leave it
  function toNative() {
    const el = target;
    if (!el) return;
    native = el;
    hide();
    el.setAttribute('inputmode', el.dataset.oskMode || (isNum(el) ? 'numeric' : 'text'));
    el.blur();
    el.focus();
  }

  /* ---------- showing it ---------- */
  function show(el) {
    build();
    target = el;
    mode = 'abc';
    shift = 'off';
    const host = el.closest('dialog') || document.body;
    if (kb.parentElement !== host) host.appendChild(kb);
    draw();
    autoShift();
    if (kb.showPopover && !kb.matches(':popover-open')) { try { kb.showPopover(); } catch (err) {} }
    kb.classList.add('up');
    document.documentElement.classList.add('osk-on');
    requestAnimationFrame(() => {
      document.documentElement.style.setProperty('--osk-h', kb.offsetHeight + 'px');
      requestAnimationFrame(() => el.scrollIntoView({ block: 'nearest', behavior: 'smooth' }));
    });
  }
  function hide() {
    stopRepeat();
    target = null;
    if (!kb) return;
    kb.classList.remove('up');
    if (kb.hidePopover && kb.matches(':popover-open')) { try { kb.hidePopover(); } catch (err) {} }
    document.documentElement.classList.remove('osk-on');
    document.documentElement.style.removeProperty('--osk-h');
  }
  const wants = el => on() && el && el.matches && el.matches(SEL) && el.closest(scope) && el.dataset.osk !== 'off' && !el.readOnly && !el.disabled;
  // the system keyboard stays away from these fields (set before they're ever tapped)
  function claim() {
    if (!on()) return;
    for (const el of document.querySelectorAll(scope)) for (const f of el.querySelectorAll(SEL)) {
      if (f.dataset.osk === 'off') continue;
      if (f.dataset.oskMode == null) f.dataset.oskMode = f.getAttribute('inputmode') || '';
      if (f !== native) f.setAttribute('inputmode', 'none');
    }
  }
  document.addEventListener('focusin', e => {
    const el = e.target;
    if (el === native) return;
    if (wants(el)) { if (el.getAttribute('inputmode') !== 'none') { native = null; claim(); } show(el); }
    else if (target) hide();
  });
  document.addEventListener('focusout', e => {
    const el = e.target;
    if (el === native) { native = null; setTimeout(claim, 0); }
    if (el !== target) return;
    // a moment later: if the focus went to another field, that field takes over
    setTimeout(() => { if (target === el && document.activeElement !== el) hide(); }, 0);
  });
  // typing on the field itself (a hardware key, or the caret moving) keeps Shift honest
  document.addEventListener('selectionchange', () => { if (target && document.activeElement === target) autoShift(); });
  document.addEventListener('close', e => { if (target && e.target.contains && e.target.contains(target)) hide(); }, true);
  window.addEventListener('resize', () => { if (target) { draw(); document.documentElement.style.setProperty('--osk-h', kb.offsetHeight + 'px'); } });
  if (mq && mq.addEventListener) mq.addEventListener('change', () => { if (!on()) { hide(); for (const f of document.querySelectorAll(`${scope} [inputmode="none"]`)) f.setAttribute('inputmode', f.dataset.oskMode || 'text'); } else claim(); });
  claim();
  let claimT = null;
  new MutationObserver(() => { if (on() && !claimT) claimT = requestAnimationFrame(() => { claimT = null; claim(); }); })
    .observe(document.body, { childList: true, subtree: true });
  return { claim, hide, active: () => !!target };
};
