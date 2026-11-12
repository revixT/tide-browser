const box = document.getElementById('box');
const hl = document.getElementById('hl');
const ROW_H = 44;

const ICONS = {
  search: '<svg viewBox="0 0 24 24"><circle cx="10.5" cy="10.5" r="6.5" fill="none" stroke="currentColor" stroke-width="1.7"/><path d="M15.5 15.5L20.5 20.5" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>',
  nav: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.5" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M3.5 12h17M12 3.5c2.6 2.6 3.6 5.4 3.6 8.5s-1 5.9-3.6 8.5c-2.6-2.6-3.6-5.4-3.6-8.5s1-5.9 3.6-8.5z" fill="none" stroke="currentColor" stroke-width="1.4"/></svg>',
  history: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.5" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M12 7v5.2l3.2 2" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>',
  bookmark: '<svg viewBox="0 0 24 24"><path d="M12 3.2l2.6 5.5 6 .8-4.4 4.2 1.1 6-5.3-2.9-5.3 2.9 1.1-6L3.4 9.5l6-.8z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg>',
  tab: '<svg viewBox="0 0 24 24"><g fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"><rect x="3.5" y="6.5" width="17" height="12" rx="2.5"/><path d="M3.5 10.5h17M8 6.5v-2h5v2"/></g></svg>',
};
const HINTS = { tab: 'Switch to tab', bookmark: 'Bookmark' };

let items = [];
let sel = 0;
let hover = -1;
const rows = [];

function setActive() {
  const idx = hover >= 0 ? hover : sel;
  rows.forEach((r, i) => r.classList.toggle('on', i === idx));
  if (idx >= 0 && idx < items.length) {
    hl.style.opacity = 1;
    hl.style.transform = `translateY(${idx * ROW_H}px)`;
  } else {
    hl.style.opacity = 0;
  }
}

function fill(row, it) {
  row.querySelector('.ic').innerHTML = ICONS[it.kind] || ICONS.search;
  row.querySelector('.title').textContent = it.title;
  row.querySelector('.sub').textContent = it.sub || '';
  const hint = row.querySelector('.hint');
  hint.textContent = HINTS[it.kind] || '';
  hint.style.display = HINTS[it.kind] ? '' : 'none';
}

function makeRow(i) {
  const row = document.createElement('div');
  row.className = 'row enter';
  row.style.setProperty('--i', i);
  row.innerHTML = '<div class="ic"></div><div class="txt"><span class="title"></span><span class="sub"></span></div><span class="hint"></span>';
  // mousedown (not click) so the pick lands before the address bar loses focus
  row.addEventListener('mousedown', (e) => { if (e.button === 0) { e.preventDefault(); window.suggest.pick(rows.indexOf(row)); } });
  row.addEventListener('mouseenter', () => { hover = rows.indexOf(row); setActive(); });
  return row;
}

function render() {
  while (rows.length < items.length) {
    const row = makeRow(rows.length);
    rows.push(row);
    box.appendChild(row);
  }
  while (rows.length > items.length) rows.pop().remove();
  items.forEach((it, i) => fill(rows[i], it));
  setActive();
}

box.addEventListener('mouseleave', () => { hover = -1; setActive(); });

window.suggest.onShow(() => {
  box.classList.remove('out');
  box.classList.remove('in');
  void box.offsetWidth; // restart the entrance animation
  box.classList.add('in');
  // fresh list: rebuild rows so they stagger in
  rows.splice(0).forEach((r) => r.remove());
  hover = -1;
});
window.suggest.onHide(() => {
  box.classList.remove('in');
  box.classList.add('out');
});
window.suggest.onUpdate((data) => {
  items = data.items;
  sel = data.sel;
  render();
});
