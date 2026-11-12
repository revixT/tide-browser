const $ = (id) => document.getElementById(id);
const tabsEl = $('tabs');
const glow = $('tab-glow');
const sideGlow = $('side-glow');
const omnibox = $('omnibox');
const findBar = $('find-bar');
const findInput = $('find-input');
const EASE = 'cubic-bezier(.22,1,.36,1)';
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

let state = { tabs: [], activeId: null, bookmarks: [] };
let editing = false;
let dragId = null;
let toastTimer = null;
let firstTabsRender = true;
const tabEls = new Map(); // id -> element (live tabs only)
let domOrder = []; // live tab ids in DOM order

// stagger index for launch animation
document.querySelectorAll('#toolbar > .ib').forEach((el, i) => el.style.setProperty('--i', i));
document.querySelectorAll('#sidebar > button').forEach((el, i) => el.style.setProperty('--i', i));

const svgIcon = (name) => {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  const u = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  u.setAttribute('href', `#i-${name}`);
  s.appendChild(u);
  return s;
};

const TIDE_PAGES = new Set(['recall', 'orbits', 'trail', 'constellations', 'focus', 'snapshots', 'reader']);
function pageOf(url) {
  if (!url) return 'home';
  const m = /^browser:\/\/(\w+)/.exec(url);
  if (!m) return '';
  return TIDE_PAGES.has(m[1]) ? 'explore' : m[1];
}

// ---------- tab elements ----------
function iconNode(t) {
  if (t.loading) {
    const sp = document.createElement('div');
    sp.className = 'spinner';
    return sp;
  }
  if (t.favicon) {
    const img = document.createElement('img');
    img.className = 'fav';
    img.src = t.favicon;
    img.onerror = () => { const b = document.createElement('div'); b.className = 'fav blank'; img.replaceWith(b); };
    return img;
  }
  const d = document.createElement('div');
  d.className = 'fav blank';
  return d;
}

function createTabEl(t) {
  const el = document.createElement('div');
  el.className = 'tab';
  el.draggable = true;
  const id = t.id;

  const slot = document.createElement('div');
  slot.className = 'slot';
  const title = document.createElement('div');
  title.className = 'title';
  const close = document.createElement('button');
  close.className = 'close';
  close.title = 'Close tab';
  close.appendChild(svgIcon('x'));
  close.onclick = (e) => { e.stopPropagation(); tide.closeTab(id); };
  const aud = document.createElement('button');
  aud.className = 'aud';
  aud.appendChild(svgIcon('speaker'));
  aud.onclick = (e) => { e.stopPropagation(); tide.muteTab(id); };
  aud.onmousedown = (e) => e.stopPropagation();
  el.append(slot, title, aud, close);

  el.onmousedown = (e) => {
    if (e.button === 1) { e.preventDefault(); tide.closeTab(id); }
    else if (e.button === 0) tide.selectTab(id);
  };
  el.oncontextmenu = (e) => { e.preventDefault(); tide.tabMenu(id); };
  el.ondragstart = (e) => { dragId = id; e.dataTransfer.effectAllowed = 'move'; };
  el.ondragover = (e) => { e.preventDefault(); el.classList.add('drag-over'); };
  el.ondragleave = () => el.classList.remove('drag-over');
  el.ondrop = (e) => {
    e.preventDefault();
    el.classList.remove('drag-over');
    if (dragId != null && dragId !== id) tide.moveTab(dragId, state.tabs.findIndex((x) => x.id === id));
    dragId = null;
  };
  return el;
}

function updateTabEl(el, t) {
  el.classList.toggle('active', t.id === state.activeId);
  el.classList.toggle('pinned', !!t.pinned);
  el.classList.toggle('private', !!t.private);
  const audio = !!(t.audible || t.muted);
  el.classList.toggle('audio', audio);
  const aud = el.querySelector('.aud');
  aud.classList.toggle('muted', !!t.muted);
  aud.title = t.muted ? 'Unmute tab' : 'Mute tab';
  aud.querySelector('use').setAttribute('href', t.muted ? '#i-muted' : '#i-speaker');
  const titleEl = el.querySelector('.title');
  if (titleEl.textContent !== t.title) titleEl.textContent = t.title;
  el.title = t.title;
  const key = t.loading ? 'L' : t.favicon || 'B';
  if (el._iconKey !== key) {
    el._iconKey = key;
    const slot = el.querySelector('.slot');
    slot.replaceChildren(iconNode(t));
    slot.style.animation = 'none';
    void slot.offsetWidth; // restart the pop-in
    slot.style.animation = '';
  }
}

function liveSiblingBefore(el) {
  let p = el.previousElementSibling;
  while (p && !(p.classList.contains('tab') && !p.classList.contains('ghost'))) p = p.previousElementSibling;
  return p;
}

function animateTabIn(el) {
  if (reduceMotion) return;
  el.animate(
    [
      { flexBasis: '0px', minWidth: '0px', opacity: 0, transform: 'scale(.6) translateY(10px)', filter: 'blur(6px)' },
      { flexBasis: el.classList.contains('pinned') ? '44px' : '240px', minWidth: el.classList.contains('pinned') ? '44px' : '40px', opacity: 1, transform: 'none', filter: 'blur(0)' },
    ],
    { duration: 520, easing: 'cubic-bezier(.34,1.3,.5,1)' },
  );
}

function animateTabOut(el) {
  el.classList.add('ghost');
  el.style.pointerEvents = 'none';
  if (reduceMotion) { el.remove(); return; }
  const w = el.offsetWidth;
  const a = el.animate(
    [
      { flexBasis: `${w}px`, minWidth: '0px', paddingLeft: '14px', paddingRight: '8px', opacity: 1, transform: 'scale(1)', filter: 'blur(0)' },
      { flexBasis: '0px', minWidth: '0px', paddingLeft: '0px', paddingRight: '0px', opacity: 0, transform: 'scale(.55) translateY(8px)', filter: 'blur(5px)' },
    ],
    { duration: 340, easing: EASE, fill: 'forwards' },
  );
  a.onfinish = () => el.remove();
}

// ---------- the gliding glow pill ----------
function placeGlow() {
  const el = tabEls.get(state.activeId);
  if (!el) { glow.style.opacity = 0; return; }
  const first = glow.dataset.ready !== '1';
  glow.classList.toggle('priv', el.classList.contains('private'));
  if (first) glow.style.transition = 'none';
  glow.style.left = `${el.offsetLeft}px`;
  glow.style.top = `${el.offsetTop}px`;
  glow.style.width = `${el.offsetWidth}px`;
  glow.style.height = `${el.offsetHeight}px`;
  glow.style.opacity = 1;
  if (first) { void glow.offsetWidth; glow.style.transition = ''; glow.dataset.ready = '1'; }
}
let glowRaf = 0;
let glowUntil = 0;
function trackGlow(ms = 750) {
  glowUntil = performance.now() + ms;
  if (glowRaf) return;
  const loop = () => {
    placeGlow();
    glowRaf = performance.now() < glowUntil ? requestAnimationFrame(loop) : 0;
  };
  loop();
}
window.addEventListener('resize', () => trackGlow(300));

function renderTabs() {
  const ids = state.tabs.map((t) => t.id);
  const idSet = new Set(ids);

  // remember where surviving tabs are, for reorder animation
  const before = new Map();
  for (const id of domOrder) if (idSet.has(id)) before.set(id, tabEls.get(id).getBoundingClientRect().left);
  const survivorsBefore = domOrder.filter((id) => idSet.has(id));

  // closing
  for (const [id, el] of [...tabEls]) {
    if (!idSet.has(id)) { tabEls.delete(id); animateTabOut(el); }
  }

  // create / position / update
  const entering = [];
  let prev = null;
  for (const t of state.tabs) {
    let el = tabEls.get(t.id);
    if (!el) {
      el = createTabEl(t);
      tabEls.set(t.id, el);
      entering.push(el);
    }
    const expectedPrev = prev;
    if (el.parentNode !== tabsEl || liveSiblingBefore(el) !== expectedPrev) {
      tabsEl.insertBefore(el, expectedPrev ? expectedPrev.nextSibling : glow.nextSibling);
    }
    updateTabEl(el, t);
    prev = el;
  }
  domOrder = ids;

  if (!firstTabsRender) entering.forEach(animateTabIn);
  else entering.forEach((el, i) => {
    // launch: the very first tab(s) drop in with a delay so they follow the chrome choreography
    if (reduceMotion) return;
    el.animate(
      [{ opacity: 0, transform: 'translateY(-18px) scale(.7)', filter: 'blur(6px)' }, { opacity: 1, transform: 'none', filter: 'blur(0)' }],
      { duration: 800, delay: 450 + i * 90, easing: 'cubic-bezier(.34,1.4,.5,1)', fill: 'backwards' },
    );
  });
  if (state.tabs.length) firstTabsRender = false;

  // reorder (drag) animation
  const survivorsAfter = ids.filter((id) => before.has(id));
  if (!reduceMotion && survivorsBefore.join() !== survivorsAfter.join()) {
    for (const [id, left] of before) {
      const el = tabEls.get(id);
      const dx = left - el.getBoundingClientRect().left;
      if (Math.abs(dx) > 1) el.animate([{ transform: `translateX(${dx}px)` }, { transform: 'none' }], { duration: 420, easing: EASE });
    }
  }

  trackGlow();
}

// ---------- sidebar glow ----------
let sideReady = false;
function placeSideGlow(current) {
  const btn = [...document.querySelectorAll('#sidebar > button')].find((b) => b.dataset.page === current);
  if (!btn) { sideGlow.style.opacity = 0; return; }
  if (!sideReady) sideGlow.style.transition = 'none';
  sideGlow.style.top = `${btn.offsetTop}px`;
  sideGlow.style.opacity = 1;
  if (!sideReady) { void sideGlow.offsetWidth; sideGlow.style.transition = ''; sideReady = true; }
}

// ---------- focus timer chip ----------
let focusUntil = 0;
function tickFocus() {
  const chip = $('focus-chip');
  const left = focusUntil - Date.now();
  if (focusUntil && left > 0) {
    const s = Math.floor(left / 1000);
    const h = Math.floor(s / 3600); const m = Math.floor((s % 3600) / 60); const sec = s % 60;
    const pad = (n) => String(n).padStart(2, '0');
    $('focus-time').textContent = `Focus ${h ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`}`;
    chip.hidden = false;
  } else chip.hidden = true;
}
setInterval(tickFocus, 1000);

// ---------- address bar: security icon, zoom pill, blocker shield ----------
function updateSiteIcon() {
  const active = state.tabs.find((t) => t.id === state.activeId);
  const url = active ? active.url : '';
  let kind = 'search';
  if (!editing) {
    if (/^https:/i.test(url)) kind = 'lock';
    else if (/^http:/i.test(url)) kind = 'warn';
  }
  $('site-use').setAttribute('href', `#i-${kind}`);
  const wrap = $('omnibox-wrap');
  wrap.classList.toggle('secure', kind === 'lock');
  wrap.classList.toggle('insecure', kind === 'warn');
  wrap.title = kind === 'lock' ? 'Connection is secure (HTTPS)' : kind === 'warn' ? 'Not secure (HTTP)' : '';
}

const lastBlocked = new Map();
function updateOmniExtras(active) {
  const pill = $('zoom-pill');
  const lvl = active ? active.zoom : 0;
  if (Math.abs(lvl) > 0.01) {
    pill.hidden = false;
    pill.textContent = `${Math.round(100 * Math.pow(1.2, lvl))}%`;
  } else pill.hidden = true;

  const shield = $('shield');
  const count = active ? active.blocked : 0;
  const on = state.prefs ? state.prefs.blockAds : true;
  shield.classList.toggle('off', !on);
  $('shield-count').textContent = on && count ? String(count) : '';
  shield.title = on ? `Ad and tracker blocking on${count ? ` - ${count} blocked on this page` : ''} (click to turn off)` : 'Ad and tracker blocking off (click to turn on)';
  if (active && count > (lastBlocked.get(active.id) || 0)) {
    shield.classList.remove('bump');
    void shield.offsetWidth;
    shield.classList.add('bump');
  }
  if (active) lastBlocked.set(active.id, count);
}

// ---------- bookmarks bar ----------
let barKey = '';
function renderBookmarksBar() {
  const key = JSON.stringify(state.bookmarks.map((b) => [b.url, b.title, b.favicon]));
  if (key === barKey) return;
  barKey = key;
  const bar = $('bm-bar');
  bar.textContent = '';
  if (!state.bookmarks.length) {
    const hint = document.createElement('span');
    hint.className = 'bm-empty';
    hint.textContent = 'Bookmark pages with Ctrl+D and they will show up here';
    bar.appendChild(hint);
    return;
  }
  for (const b of state.bookmarks) {
    const el = document.createElement('div');
    el.className = 'bmi';
    el.title = `${b.title}\n${b.url}`;
    if (b.favicon) {
      const img = document.createElement('img');
      img.src = b.favicon;
      img.onerror = () => img.remove();
      el.appendChild(img);
    }
    const label = document.createElement('span');
    label.textContent = b.title;
    el.appendChild(label);
    el.onclick = () => tide.go(b.url);
    el.onauxclick = (e) => { if (e.button === 1) tide.newTab(b.url); };
    el.oncontextmenu = (e) => { e.preventDefault(); tide.bookmarkMenu(b.url); };
    bar.appendChild(el);
  }
}

// ---------- main render ----------
let starKey = '';
let starWas = false;

function render() {
  const active = state.tabs.find((t) => t.id === state.activeId);
  const prefs = state.prefs || {};
  document.documentElement.classList.toggle('bar', !!prefs.bookmarksBar);
  document.documentElement.classList.toggle('reduce', !!prefs.reduceMotion);
  renderTabs();
  renderBookmarksBar();
  updateSiteIcon();
  updateOmniExtras(active);
  $('key').classList.toggle('has', !!(active && active.loginForm && !active.private));
  $('reader').hidden = !(active && active.articleLike);
  focusUntil = prefs.focus && prefs.focus.active ? prefs.focus.until : 0;
  tickFocus();

  $('back').disabled = !(active && active.canGoBack);
  $('forward').disabled = !(active && active.canGoForward);
  const loading = !!(active && active.loading);
  $('reload-use').setAttribute('href', loading ? '#i-x' : '#i-reload');
  $('reload').title = loading ? 'Stop' : 'Reload (Ctrl+R)';
  $('progress').classList.toggle('on', loading);

  const star = $('star');
  const bookmarked = !!(active && active.bookmarked);
  const key = active ? `${active.id}:${active.url}` : '';
  if (key === starKey && bookmarked && !starWas) {
    star.classList.remove('pop');
    void star.offsetWidth;
    star.classList.add('pop');
  }
  starKey = key;
  starWas = bookmarked;
  star.classList.toggle('on', bookmarked);
  star.style.visibility = active && /^https?:/i.test(active.url) ? 'visible' : 'hidden';

  if (!editing && document.activeElement !== omnibox) omnibox.value = active ? active.url : '';

  const current = active ? pageOf(active.url) : '';
  document.querySelectorAll('#sidebar > button').forEach((b) => b.classList.toggle('active', b.dataset.page === current));
  placeSideGlow(current);
}

// ---------- events ----------
tide.onState((s) => { state = s; render(); });
tide.onFocusOmnibox(() => { omnibox.focus(); omnibox.select(); });
tide.onToast((msg) => {
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 3500);
});

// click ripples
document.addEventListener('pointerdown', (e) => {
  const b = e.target.closest('.ib, #sidebar > button, #logo');  if (!b || b.disabled) return;
  const r = b.getBoundingClientRect();
  const size = Math.max(r.width, r.height) * 1.6;
  const rip = document.createElement('span');
  rip.className = 'rip';
  rip.style.cssText = `width:${size}px;height:${size}px;left:${e.clientX - r.left - size / 2}px;top:${e.clientY - r.top - size / 2}px`;
  b.appendChild(rip);
  rip.addEventListener('animationend', () => rip.remove());
});

$('logo').onclick = () => tide.home();
$('new-tab').onclick = () => tide.newTab();
$('back').onclick = () => tide.back();
$('forward').onclick = () => tide.forward();
$('reload').onclick = () => {
  const active = state.tabs.find((t) => t.id === state.activeId);
  if (active && active.loading) { tide.stop(); return; }
  const svg = $('reload').querySelector('svg');
  svg.classList.remove('spin');
  void svg.getBoundingClientRect();
  svg.classList.add('spin');
  tide.reload();
};
$('star').onclick = () => tide.toggleBookmark();
$('ai').onclick = () => tide.openAI();
$('shot').onclick = () => {
  const b = $('shot');
  b.classList.remove('flash');
  void b.offsetWidth;
  b.classList.add('flash');
  tide.screenshot();
};
$('dl').onclick = () => tide.openInternal('downloads');
$('key').onclick = () => tide.passwordButton();
$('menu').onclick = () => {
  const r = $('menu').getBoundingClientRect();
  tide.mainMenu(r.right - 220, r.bottom + 4);
};
document.querySelectorAll('#sidebar > button').forEach((b) => {
  b.onclick = () => {
    if (b.dataset.action === 'theme') {
      // The paint splash spreads outward from the middle of this button.
      const r = b.getBoundingClientRect();
      tide.toggleTheme({ x: r.left + r.width / 2, y: r.top + r.height / 2 });
    }
    else if (b.dataset.page === 'home') tide.home();
    else tide.openInternal(b.dataset.page);
  };
});
// Tooltip for the theme button follows the current theme.
const darkQuery = matchMedia('(prefers-color-scheme: dark)');
const updateThemeTip = () => { $('theme-btn').title = darkQuery.matches ? 'Switch to light mode' : 'Switch to dark mode'; };
darkQuery.addEventListener('change', updateThemeTip);
updateThemeTip();

omnibox.addEventListener('focus', () => { editing = true; updateSiteIcon(); omnibox.select(); });
$('zoom-pill').onclick = () => tide.resetZoom();
// The padlock and the shield both open the site privacy panel, lined up under whichever you clicked.
document.querySelector('#omnibox-wrap .oi').addEventListener('click', (e) => {
  if (editing) return;
  e.stopPropagation();
  tide.siteOpen(document.querySelector('#omnibox-wrap .oi').getBoundingClientRect().left - 8);
});
$('shield').onclick = () => tide.siteOpen($('shield').getBoundingClientRect().right - 360);
$('reader').onclick = () => tide.openReader();
$('focus-chip').onclick = () => tide.openInternal('focus');
omnibox.addEventListener('blur', () => { editing = false; tide.omniHide(); render(); });

// Suggestions: the dropdown lives in its own overlay view, owned by the main process.
function omniRect() {
  const r = $('omnibox-wrap').getBoundingClientRect();
  return { x: r.left, y: r.top, width: r.width, height: r.height };
}
omnibox.addEventListener('input', () => tide.omniInput(omnibox.value, omniRect()));
tide.onOmniDone(() => { editing = false; omnibox.blur(); });

omnibox.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    tide.omniMove(e.key === 'ArrowUp' ? -1 : 1).then((fill) => {
      if (fill == null) { tide.omniInput(omnibox.value, omniRect()); return; }
      omnibox.value = fill;
      omnibox.setSelectionRange(fill.length, fill.length);
    });
  } else if (e.key === 'Enter') {
    const value = omnibox.value;
    tide.omniEnter(value).then((handled) => {
      if (handled) return;
      editing = false;
      omnibox.blur();
      tide.go(value);
    });
  } else if (e.key === 'Escape') {
    tide.omniHide();
    const active = state.tabs.find((t) => t.id === state.activeId);
    omnibox.value = active ? active.url : '';
    omnibox.select();
  }
});

$('tabstrip').addEventListener('dblclick', (e) => {
  if (e.target === $('tabstrip')) tide.newTab();
});

// ---------- find in page ----------
let findCloseTimer = null;
function openFind() {
  clearTimeout(findCloseTimer);
  findBar.hidden = false;
  findBar.classList.remove('out');
  findBar.classList.remove('in');
  void findBar.offsetWidth;
  findBar.classList.add('in');
  tide.findVisible(true);
  findInput.focus();
  findInput.select();
}
function closeFind() {
  if (findBar.hidden || findBar.classList.contains('out')) return;
  findBar.classList.remove('in');
  findBar.classList.add('out');
  $('find-count').textContent = '';
  tide.findVisible(false);
  tide.stopFind();
  findCloseTimer = setTimeout(() => { findBar.hidden = true; findBar.classList.remove('out'); }, 230);
}
tide.onFindOpen(openFind);
tide.onFindClose(closeFind);
tide.onFindResult(({ active, total }) => {
  $('find-count').textContent = total ? `${active}/${total}` : 'No results';
});
findInput.addEventListener('input', () => tide.find(findInput.value, true, false));
findInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') tide.find(findInput.value, !e.shiftKey, true);
  else if (e.key === 'Escape') closeFind();
});
$('find-next').onclick = () => tide.find(findInput.value, true, true);
$('find-prev').onclick = () => tide.find(findInput.value, false, true);
$('find-close').onclick = closeFind;

tide.ready();
