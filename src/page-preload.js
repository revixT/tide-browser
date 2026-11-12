const { contextBridge, ipcRenderer } = require('electron');

// Exposed to every page, but the main process only honours "internal:*" calls
// when they come from the browser's own internal pages (file:// .../pages/).
const call = (c) => (...a) => ipcRenderer.invoke(`internal:${c}`, ...a);
// Websites never see this bridge; only local (file://) pages such as the settings page do.
if (location.protocol === 'file:') contextBridge.exposeInMainWorld('tidePage', {
  introSeen: call('introSeen'),
  navigate: call('navigate'),
  getShortcuts: call('getShortcuts'),
  getSettings: call('getSettings'),
  setSettings: call('setSettings'),
  // bookmarks
  getBookmarks: call('bookmarks'),
  removeBookmark: call('removeBookmark'),
  renameBookmark: call('renameBookmark'),
  exportBookmarks: call('exportBookmarks'),
  importBookmarks: call('importBookmarks'),
  // history
  getHistory: call('history'),
  clearHistory: call('clearHistory'),
  removeHistory: call('removeHistory'),
  // downloads
  getDownloads: call('downloads'),
  clearDownloads: call('clearDownloads'),
  downloadAction: call('downloadAction'),
  // import
  detectBrowsers: call('detectBrowsers'),
  importData: call('importData'),
  importFiles: call('importFiles'),
  // settings pages
  clearData: call('clearData'),
  getPermissions: call('getPermissions'),
  removePermission: call('removePermission'),
  resetPermissions: call('resetPermissions'),
  getZoomSites: call('getZoomSites'),
  resetZoomSites: call('resetZoomSites'),
  getExtensions: call('getExtensions'),
  addExtension: call('addExtension'),
  removeExtension: call('removeExtension'),
  chooseDownloadDir: call('chooseDownloadDir'),
  resetDownloadDir: call('resetDownloadDir'),
  openDefaultApps: call('openDefaultApps'),
  relaunch: call('relaunch'),
  // Tide features
  orbitsList: call('orbitsList'), orbitSweep: call('orbitSweep'), orbitRestore: call('orbitRestore'), orbitRemove: call('orbitRemove'), orbitClear: call('orbitClear'),
  trailGet: call('trailGet'), trailClear: call('trailClear'),
  snapshotsList: call('snapshotsList'), snapshotSave: call('snapshotSave'), snapshotDelete: call('snapshotDelete'), snapshotRestore: call('snapshotRestore'),
  constGet: call('constGet'), constSave: call('constSave'),
  focusGet: call('focusGet'), focusSet: call('focusSet'), focusStart: call('focusStart'), focusStop: call('focusStop'),
  recallStatus: call('recallStatus'), recallSearch: call('recallSearch'), recallRemove: call('recallRemove'), recallClear: call('recallClear'),
  readerDoc: call('readerDoc'),
  vtStatus: call('vtStatus'), setVtKey: call('setVtKey'),
  updateStatus: call('updateStatus'), updateCheck: call('updateCheck'), updateInstall: call('updateInstall'),
  // security
  allowSite: call('allowSite'),
  securityInfo: call('securityInfo'),
  // password vault (the page never gets the key; saved passwords come back one at a time, on request)
  pwStatus: call('pwStatus'),
  pwCreate: call('pwCreate'),
  pwUnlock: call('pwUnlock'),
  pwLock: call('pwLock'),
  pwList: call('pwList'),
  pwReveal: call('pwReveal'),
  pwSave: call('pwSave'),
  pwRemove: call('pwRemove'),
  pwCopy: call('pwCopy'),
  pwGenerate: call('pwGenerate'),
  pwHealth: call('pwHealth'),
  pwBreachCheck: call('pwBreachCheck'),
  pwImport: call('pwImport'),
  pwExport: call('pwExport'),
  pwChangeMaster: call('pwChangeMaster'),
  pwReset: call('pwReset'),
  pwClearNever: call('pwClearNever'),
});

// ---------- login form detection and fill (top frame of web pages only) ----------
// This script only reports "a password field exists" and what you typed when you submit a login.
// The origin is never taken from here: the main process reads it from the frame itself.
if (/^https?:$/.test(location.protocol)) {
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
  };
  const passwordInputs = () => [...document.querySelectorAll('input[type="password"]')].filter(visible);
  const TEXT_TYPES = new Set(['text', 'email', 'tel', '']);
  const usernameFor = (pw) => {
    const scope = pw.form || document;
    const all = [...scope.querySelectorAll('input')].filter((i) => i !== pw && TEXT_TYPES.has((i.getAttribute('type') || 'text').toLowerCase()) && visible(i));
    const before = all.filter((i) => i.compareDocumentPosition(pw) & Node.DOCUMENT_POSITION_FOLLOWING);
    return before[before.length - 1] || all[0] || null;
  };

  let lastSent = 0;
  const capture = (scope) => {
    const root = scope && scope.querySelectorAll ? scope : document;
    const filled = [...root.querySelectorAll('input[type="password"]')].filter((p) => p.value);
    if (!filled.length) return;
    let pw = filled[filled.length - 1];
    if (filled.length > 1) { // "new password" + "repeat": the value that appears twice
      const vals = filled.map((p) => p.value);
      pw = filled.find((p, i) => vals.indexOf(p.value) !== i) || pw;
    }
    const now = Date.now();
    if (now - lastSent < 800) return;
    lastSent = now;
    const u = usernameFor(pw);
    ipcRenderer.send('pw:captured', { username: u ? u.value : '', password: pw.value });
  };

  document.addEventListener('submit', (e) => capture(e.target), true);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target && e.target.type === 'password') capture(e.target.form || document);
  }, true);
  document.addEventListener('click', (e) => {
    const b = e.target && e.target.closest ? e.target.closest('button, input[type="submit"], [role="button"]') : null;
    if (!b) return;
    const looksLikeSubmit = b.matches('[type="submit"]') || (b.tagName === 'BUTTON' && !b.hasAttribute('type') && b.form) ||
      /log\s?in|sign\s?in|submit|continue|next|register|sign\s?up|create/i.test(b.textContent || b.value || '');
    if (looksLikeSubmit) capture(b.form || b.closest('form') || document);
  }, true);

  let lastHas = null;
  let timer = null;
  const report = () => {
    const has = passwordInputs().length > 0;
    if (has !== lastHas) { lastHas = has; ipcRenderer.send('pw:hasForm', has); }
  };
  const schedule = () => { clearTimeout(timer); timer = setTimeout(report, 400); };
  window.addEventListener('DOMContentLoaded', () => {
    report();
    new MutationObserver(schedule).observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['type', 'style', 'class', 'hidden'] });
  });
  window.addEventListener('load', report);

  const setValue = (el, v) => {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, v);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  };
  ipcRenderer.on('pw:fill', (_e, d) => {
    if (!d || typeof d.password !== 'string') return;
    const pws = passwordInputs();
    if (!pws.length) return;
    const target = pws.find((p) => p === document.activeElement) || pws[0];
    if (d.username) { const u = usernameFor(target); if (u) setValue(u, String(d.username)); }
    const group = d.generated ? pws.filter((p) => p.form === target.form) : [target];
    group.forEach((p) => setValue(p, d.password));
  });
}

// ---------- page text and "hold a link to peek" (top frame of web pages only) ----------
// 1. Sends the page's readable text to the browser, for Recall, Orbit summaries and the reader button.
//    The browser decides whether to keep it: private tabs, login pages and sensitive sites are skipped there.
// 2. Detects "hold a link" and Alt+click so the browser can open a preview (Peek).
if (/^https?:$/.test(location.protocol)) {
  const collect = () => {
    const desc = (document.querySelector('meta[name="description"], meta[property="og:description"]') || {}).content || '';
    let text = '';
    try { text = (document.body && document.body.innerText) || ''; } catch { /* not ready */ }
    const longParas = [...document.querySelectorAll('p')].filter((p) => (p.innerText || '').length >= 80).length;
    return {
      title: document.title,
      desc: String(desc).slice(0, 300),
      text: text.slice(0, 20000),
      hasPassword: !!document.querySelector('input[type="password"]'),
      articleLike: longParas >= 3 && text.length > 1200,
    };
  };
  window.addEventListener('load', () => setTimeout(() => ipcRenderer.send('page:content', collect()), 2500));

  let pressTimer = null;
  let sx = 0;
  let sy = 0;
  let suppress = false;
  const linkOf = (e) => (e.target && e.target.closest ? e.target.closest('a[href]') : null);
  const clearPress = () => { clearTimeout(pressTimer); pressTimer = null; };

  document.addEventListener('mousedown', (e) => {
    if (e.button !== 0 || e.altKey) return;
    const a = linkOf(e);
    if (!a) return;
    sx = e.clientX;
    sy = e.clientY;
    clearPress();
    pressTimer = setTimeout(() => {
      pressTimer = null;
      suppress = true; // the click that ends this press must not navigate
      ipcRenderer.send('peek:open', { url: a.href });
    }, 500);
  }, true);
  document.addEventListener('mousemove', (e) => {
    if (pressTimer && (Math.abs(e.clientX - sx) > 6 || Math.abs(e.clientY - sy) > 6)) clearPress();
  }, true);
  document.addEventListener('mouseup', clearPress, true);
  document.addEventListener('dragstart', clearPress, true);
  document.addEventListener('click', (e) => {
    if (suppress) { suppress = false; e.preventDefault(); e.stopPropagation(); return; }
    const a = linkOf(e);
    if (a && e.altKey && !e.ctrlKey && !e.shiftKey) {
      e.preventDefault();
      e.stopPropagation();
      ipcRenderer.send('peek:open', { url: a.href });
    }
  }, true);
}
