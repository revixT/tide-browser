const $ = (id) => document.getElementById(id);
const card = $('card');

window.peek.onInit(({ card: c, headerH, url }) => {
  Object.assign(card.style, { left: `${c.x}px`, top: `${c.y}px`, width: `${c.w}px`, height: `${c.h}px` });
  $('bar').style.height = `${headerH}px`;
  $('url').textContent = url;
});
window.peek.onInfo(({ title, url, loading }) => {
  $('title').textContent = title || url;
  $('url').textContent = url;
  $('load').classList.toggle('on', !!loading);
});

$('close').onclick = () => window.peek.action({ type: 'close' });
$('open').onclick = () => window.peek.action({ type: 'open' });
$('reload').onclick = () => window.peek.action({ type: 'reload' });
$('back').onclick = () => window.peek.action({ type: 'back' });
$('dim').addEventListener('mousedown', () => window.peek.action({ type: 'close' }));
addEventListener('keydown', (e) => { if (e.key === 'Escape') window.peek.action({ type: 'close' }); });
