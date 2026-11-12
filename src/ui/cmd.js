const input = document.getElementById('in');
const list = document.getElementById('list');
const hl = document.getElementById('hl');
const card = document.getElementById('card');
const ROW = 46;

const svg = (p) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${p}</svg>`;
const ICONS = {
  tab: svg('<rect x="3.5" y="6.5" width="17" height="12" rx="2.5"/><path d="M3.5 10.5h17"/>'),
  action: svg('<path d="M13 3L5 13.5h6L10 21l8-10.5h-6z"/>'),
  bookmark: svg('<path d="M12 3.2l2.6 5.5 6 .8-4.4 4.2 1.1 6-5.3-2.9-5.3 2.9 1.1-6L3.4 9.5l6-.8z"/>'),
  history: svg('<circle cx="12" cy="12" r="8.5"/><path d="M12 7v5.2l3.2 2"/>'),
  recall: svg('<path d="M4 5.5h16M4 10h10M4 14.5h7"/><circle cx="17" cy="16.5" r="3.2"/><path d="M19.4 18.9l2 2"/>'),
  orbit: svg('<circle cx="12" cy="12" r="2.4"/><ellipse cx="12" cy="12" rx="9" ry="4" transform="rotate(-25 12 12)"/>'),
  search: svg('<circle cx="10.5" cy="10.5" r="6.5"/><path d="M15.5 15.5L20.5 20.5"/>'),
  nav: svg('<circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17M12 3.5c2.6 2.6 3.6 5.4 3.6 8.5s-1 5.9-3.6 8.5c-2.6-2.6-3.6-5.4-3.6-8.5s1-5.9 3.6-8.5z"/>'),
};
const TAGS = { tab: 'Switch to tab', action: 'Action', orbit: 'Orbits', recall: 'Recall', bookmark: 'Bookmark', history: 'History' };

let items = [];
let sel = 0;
let seq = 0;
const rows = [];

function setSel(i) {
  sel = Math.max(0, Math.min(items.length - 1, i));
  rows.forEach((r, k) => r.classList.toggle('on', k === sel));
  if (items.length) { hl.style.opacity = 1; hl.style.transform = `translateY(${sel * ROW}px)`; } else hl.style.opacity = 0;
}

function fit() { requestAnimationFrame(() => window.cmd.size(card.offsetHeight + 34)); }

function render(first) {
  rows.splice(0).forEach((r) => r.remove());
  list.querySelectorAll('.empty').forEach((e) => e.remove());
  if (!items.length) {
    const e = document.createElement('div'); e.className = 'empty'; e.textContent = 'Nothing found'; list.appendChild(e);
  }
  items.forEach((it, i) => {
    const r = document.createElement('div');
    r.className = 'row'; r.style.setProperty('--i', first ? i : 0);
    const ic = document.createElement('div'); ic.className = 'ic'; ic.innerHTML = ICONS[it.kind] || ICONS.search;
    const t = document.createElement('div'); t.className = 't';
    const b = document.createElement('b'); b.textContent = it.title;
    const s = document.createElement('span'); s.textContent = it.sub || '';
    t.append(b, s);
    r.append(ic, t);
    if (TAGS[it.kind]) { const g = document.createElement('div'); g.className = 'tag'; g.textContent = TAGS[it.kind]; r.appendChild(g); }
    r.addEventListener('mouseenter', () => setSel(i));
    r.addEventListener('mousedown', (e) => { e.preventDefault(); window.cmd.run(i); });
    list.appendChild(r);
    rows.push(r);
  });
  setSel(0);
  fit();
}

async function refresh(first) {
  const my = ++seq;
  const res = await window.cmd.query(input.value);
  if (my !== seq) return; // a newer keystroke already replaced this answer
  items = res;
  render(first);
}

input.addEventListener('input', () => refresh(false));
input.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowDown') { e.preventDefault(); setSel(sel + 1); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); setSel(sel - 1); }
  else if (e.key === 'Enter') { e.preventDefault(); if (items.length) window.cmd.run(sel); }
  else if (e.key === 'Escape') { e.preventDefault(); window.cmd.close(); }
});

window.cmd.onShow(() => {
  card.style.animation = 'none';
  void card.offsetWidth;
  card.style.animation = '';
  input.value = '';
  refresh(true);
  setTimeout(() => input.focus(), 20);
});
window.cmd.onHide(() => { input.value = ''; });
