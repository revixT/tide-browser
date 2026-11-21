// Shared by the browser's internal pages: honour the "reduce motion" preference.
if (window.tidePage) {
  window.tidePage.getSettings().then((s) => {
    if (s && s.reduceMotion) document.documentElement.classList.add('reduce');
  }).catch(() => {});
}

// In the panel (Tide pages open over the browser, not in a tab), the page's header gets a back button.
if (/[?&]panel=1/.test(location.search)) {
  document.documentElement.classList.add('in-panel');
  const css = document.createElement('style');
  css.textContent = `
    .panel-back { width: 36px; height: 36px; margin: 0 -2px 0 -10px; flex: none; border: 0; border-radius: 50%; background: none; color: var(--text);
      display: grid; place-items: center; cursor: pointer; transition: background .2s, transform .3s cubic-bezier(.34,1.56,.64,1); }
    .panel-back svg { width: 20px; height: 20px; }
    .panel-back:hover { background: rgb(var(--ov) / .08); transform: translateX(-2px); }
    .panel-back:active { transform: scale(.9); }
    html.in-panel body { animation: panelIn .45s cubic-bezier(.16,1,.3,1); }
    @keyframes panelIn { from { opacity: 0; } }
    html.reduce.in-panel body { animation: none; }`;
  document.head.appendChild(css);
  const addBack = () => {
    const bar = document.querySelector('header.bar');
    if (!bar || bar.querySelector('.panel-back')) return;
    const b = document.createElement('button');
    b.className = 'panel-back';
    b.title = 'Close (Esc)';
    b.setAttribute('aria-label', 'Close');
    b.innerHTML = '<svg viewBox="0 0 24 24"><path d="M19 12H5M11 5.5L4.5 12l6.5 6.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    b.onclick = () => window.tidePage && window.tidePage.closePanel();
    bar.prepend(b);
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', addBack); else addBack();
}
