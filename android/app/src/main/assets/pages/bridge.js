// Tide for Android: the page API. Same names as the desktop window.tidePage where they overlap.
// The app injects `tideBridge` only into pages on Tide's own origin; websites never see it.
(() => {
  const B = window.tideBridge;
  const pending = new Map();
  let n = 0;
  if (B) {
    B.addEventListener('message', (e) => {
      let m;
      try { m = JSON.parse(e.data); } catch { return; }
      if (m.event) { dispatchEvent(new CustomEvent('tide:' + m.event, { detail: m.data })); return; }
      const p = pending.get(m.id);
      if (!p) return;
      pending.delete(m.id);
      if ('error' in m) p.rej(new Error(m.error)); else p.res(m.result);
    });
  }
  const call = (cmd, args = {}) => new Promise((res, rej) => {
    if (!B) return rej(new Error('Tide is not available on this page'));
    const id = ++n;
    pending.set(id, { res, rej });
    B.postMessage(JSON.stringify({ id, cmd, args }));
  });

  window.tidePage = {
    introSeen: () => call('introSeen'),
    navigate: (q) => call('navigate', { q }),
    openTab: (q) => call('openTab', { q }),
    isPrivate: () => call('isPrivate'),
    getShortcuts: () => call('getShortcuts'),
    getSettings: () => call('getSettings'),
    setSettings: (o) => call('setSettings', o),
    getHistory: () => call('getHistory'),
    removeHistory: (url, time) => call('removeHistory', { url, time }),
    clearHistory: () => call('clearHistory'),
    getBookmarks: () => call('getBookmarks'),
    removeBookmark: (url) => call('removeBookmark', { url }),
    renameBookmark: (url, title) => call('renameBookmark', { url, title }),
    getDownloads: () => call('getDownloads'),
    openDownload: (id) => call('openDownload', { id }),
    removeDownload: (id) => call('removeDownload', { id }),
    cancelDownload: (id) => call('cancelDownload', { id }),
    showDownloadsFolder: () => call('showDownloadsFolder'),
    clearData: (o) => call('clearData', o),
    openDefaultApps: () => call('openDefaultApps'),
    openUrl: (url) => call('openUrl', { url }),
    allowSite: (kind, url) => call('allowSite', { kind, url }),
    info: () => call('info'),
    orbitsList: () => call('orbitsList'),
    orbitSweep: () => new Promise((res) => {
      addEventListener('tide:orbitSwept', (e) => res(e.detail.n), { once: true });
      call('orbitSweep').catch(() => res(0));
    }),
    orbitRestore: (id) => call('orbitRestore', { id }),
    orbitRemove: (id) => call('orbitRemove', { id }),
    orbitClear: () => call('orbitClear'),
    trailGet: () => call('trailGet'),
    trailClear: () => call('trailClear'),
    snapshotsList: () => call('snapshotsList'),
    snapshotSave: () => call('snapshotSave'),
    snapshotDelete: (id) => call('snapshotDelete', { id }),
    snapshotRestore: (id, index) => call('snapshotRestore', { id, index: Number.isInteger(index) ? index : null }),
    focusGet: () => call('focusGet'),
    focusSet: (patch) => call('focusSet', patch),
    focusStart: (minutes) => call('focusStart', { minutes }),
    focusStop: () => call('focusStop'),
    readerDoc: () => call('readerDoc'),
    speak: (text, rate, id) => call('speak', { text, rate, id: String(id) }),
    speechStop: () => call('speechStop'),
  };

  // In the panel, the page's own header gets a back button that closes the panel.
  if (/[?&]panel=1/.test(location.search)) {
    document.documentElement.classList.add('in-panel');
    const addBack = () => {
      const top = document.querySelector('header.bar .top') || document.querySelector('header.bar');
      if (!top || top.querySelector('.panel-back')) return;
      const b = document.createElement('button');
      b.className = 'panel-back';
      b.setAttribute('aria-label', 'Close');
      b.innerHTML = '<svg viewBox="0 0 24 24"><path d="M19 12H5M11 5.5L4.5 12l6.5 6.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';
      b.onclick = () => call('closePanel');
      top.prepend(b);
    };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', addBack); else addBack();
  }

  // Honour "Reduce motion" from Tide's settings on every page.
  if (!document.documentElement.hasAttribute('data-no-reduce')) {
    call('getSettings').then((s) => { if (s && s.reduceMotion) document.documentElement.classList.add('reduce'); }).catch(() => {});
  }
})();
