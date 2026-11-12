// Tide's own features. main.js hands in a `ctx` object (browser state and helpers) and gets back hooks.
//   Orbits         inactive tabs move to a searchable shelf
//   Trail          a tree of how you got from page to page
//   Snapshots      automatic saves of your open tabs
//   Constellations star-map boards of saved pages
//   Focus          block distracting sites on a timer or schedule
//   Site panel     what a site did, plus "forget this site"
//   Peek           hold a link to preview it
//   Command bar    Ctrl+K to find or do anything
//   Reader         clean article view with read-aloud
//   Downloads      SHA-256 fingerprint and optional VirusTotal lookup (only the hash is sent)
const path = require('path');
const crypto = require('crypto');
const fs = require('fs');
const { EXTRACT_SRC } = require('./reader');

const uuid = () => crypto.randomUUID();
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

function init(ctx) {
  const { ipcMain, Menu, session, net, WebContentsView, safeStorage } = ctx.electron;
  const S = () => ctx.settings();
  const toast = (m) => ctx.toast(m);
  const isWeb = (u) => /^https?:\/\//i.test(u || '');

  // ====================================================================
  // Orbits
  // ====================================================================
  let orbits = ctx.loadJSON('orbits.json', []);
  const saveOrbits = () => ctx.saveJSON('orbits.json', orbits);

  function archiveTab(tab) {
    const url = ctx.tabWc(tab).getURL();
    if (!isWeb(url)) return false;
    orbits.unshift({
      id: uuid(), url, title: tab.title || url, favicon: tab.favicon || '', summary: tab.snippet || '',
      archivedAt: Date.now(), lastActive: tab.lastActive || Date.now(),
    });
    if (orbits.length > 500) orbits.length = 500;
    saveOrbits();
    ctx.closeTab(tab.id);
    return true;
  }

  function eligibleForOrbit(t) {
    return t && t.id !== ctx.getActiveId() && !t.pinned && !t.private && !t.audible && !t.loading && isWeb(ctx.tabWc(t).getURL());
  }

  function sweepOrbits(force = false) {
    const mins = S().orbitMinutes;
    if (!force && !mins) return 0;
    const limit = (mins || 0) * 60000;
    const now = Date.now();
    let n = 0;
    for (const id of [...ctx.getOrder()]) {
      const t = ctx.tabs.get(id);
      if (!eligibleForOrbit(t) || ctx.getOrder().length <= 1) continue;
      if (!force && now - (t.lastActive || now) < limit) continue;
      if (archiveTab(t)) n++;
    }
    if (n) toast(`Moved ${n} tab${n > 1 ? 's' : ''} to Orbits`);
    return n;
  }
  const orbitTimer = setInterval(() => sweepOrbits(false), 60000);
  orbitTimer.unref?.();

  ctx.handleInternal('orbitsList', () => orbits);
  ctx.handleInternal('orbitSweep', () => sweepOrbits(true));
  ctx.handleInternal('orbitRestore', (_e, id) => {
    const i = orbits.findIndex((o) => o.id === id);
    if (i < 0) return false;
    const [o] = orbits.splice(i, 1);
    saveOrbits();
    ctx.createTab(o.url);
    return true;
  });
  ctx.handleInternal('orbitRemove', (_e, id) => { orbits = orbits.filter((o) => o.id !== id); saveOrbits(); });
  ctx.handleInternal('orbitClear', () => { orbits = []; saveOrbits(); });

  // ====================================================================
  // Trail
  // ====================================================================
  let trail = ctx.loadJSON('trail.json', []);
  const trailById = new Map(trail.map((n) => [n.id, n]));
  const saveTrail = () => ctx.saveJSON('trail.json', trail);

  function trailAdd(tab, url) {
    if (tab.private || !isWeb(url)) return;
    const cur = tab.trailNode && trailById.get(tab.trailNode);
    if (cur && cur.url === url) return; // reload
    const node = { id: uuid(), url, title: '', time: Date.now(), parent: (cur && cur.id) || tab.openerNode || null };
    trail.push(node);
    trailById.set(node.id, node);
    tab.trailNode = node.id;
    if (trail.length > 1500) {
      for (const n of trail.splice(0, 200)) trailById.delete(n.id);
    }
    saveTrail();
  }
  function trailTitle(tab) {
    const n = tab.trailNode && trailById.get(tab.trailNode);
    if (n && tab.title) { n.title = tab.title.slice(0, 200); saveTrail(); }
  }
  ctx.handleInternal('trailGet', () => trail);
  ctx.handleInternal('trailClear', () => { trail = []; trailById.clear(); saveTrail(); });

  // ====================================================================
  // Snapshots
  // ====================================================================
  let snaps = ctx.loadJSON('snapshots.json', []);
  let lastSig = '';
  function takeSnapshot(reason) {
    const items = ctx.getOrder().map((id) => ctx.tabs.get(id)).filter((t) => t && !t.private)
      .map((t) => ({ url: ctx.tabWc(t).getURL(), title: t.title || '', pinned: !!t.pinned })).filter((x) => isWeb(x.url));
    if (!items.length) return null;
    const sig = items.map((x) => x.url).join('\n');
    if (reason !== 'manual' && sig === lastSig) return null;
    lastSig = sig;
    const s = { id: uuid(), time: Date.now(), reason, tabs: items };
    snaps.unshift(s);
    if (snaps.length > 40) snaps.length = 40;
    ctx.saveJSON('snapshots.json', snaps);
    return s;
  }
  const snapTimer = setInterval(() => { if (S().snapshotsAuto) takeSnapshot('auto'); }, 30 * 60000);
  snapTimer.unref?.();
  setTimeout(() => { if (S().snapshotsAuto) takeSnapshot('auto'); }, 2 * 60000).unref?.();

  ctx.handleInternal('snapshotsList', () => snaps);
  ctx.handleInternal('snapshotSave', () => { const s = takeSnapshot('manual'); if (s) toast('Snapshot saved'); return !!s; });
  ctx.handleInternal('snapshotDelete', (_e, id) => { snaps = snaps.filter((s) => s.id !== id); ctx.saveJSON('snapshots.json', snaps); });
  ctx.handleInternal('snapshotRestore', (_e, id, index) => {
    const s = snaps.find((x) => x.id === id);
    if (!s) return 0;
    const list = Number.isInteger(index) ? [s.tabs[index]].filter(Boolean) : s.tabs;
    let first = null;
    for (const t of list) { const tid = ctx.createTab(t.url, { activate: false, pinned: !!t.pinned && !Number.isInteger(index) }); if (first == null) first = tid; }
    if (first != null) ctx.selectTab(first);
    return list.length;
  });

  // ====================================================================
  // Constellations
  // ====================================================================
  // Kept in memory: saves to disk are delayed a moment, so reading the file back would show stale data.
  let constState = null;
  const readConst = () => {
    if (!constState) {
      const d = ctx.loadJSON('constellations.json', { list: [] });
      constState = d && Array.isArray(d.list) ? d : { list: [] };
    }
    return constState;
  };
  const writeConst = (data) => { constState = data; ctx.saveJSON('constellations.json', data); };
  function sanitizeConst(data) {
    const list = (Array.isArray(data && data.list) ? data.list : []).slice(0, 50).map((c) => ({
      id: String((c && c.id) || uuid()).slice(0, 64),
      name: String((c && c.name) || 'Constellation').slice(0, 60),
      created: Number(c && c.created) || Date.now(),
      stars: (Array.isArray(c && c.stars) ? c.stars : []).slice(0, 200).filter((s) => s && isWeb(s.url)).map((s) => ({
        id: String(s.id || uuid()).slice(0, 64), url: String(s.url).slice(0, 2000), title: String(s.title || s.url).slice(0, 200),
        favicon: isWeb(s.favicon) ? String(s.favicon).slice(0, 2000) : '', x: clamp(Number(s.x) || 0, 0, 1), y: clamp(Number(s.y) || 0, 0, 1),
      })),
      links: (Array.isArray(c && c.links) ? c.links : []).slice(0, 600).filter((l) => Array.isArray(l) && l.length === 2).map((l) => [String(l[0]).slice(0, 64), String(l[1]).slice(0, 64)]),
    }));
    return { list };
  }
  function addToConstellation(tab, id) {
    const url = ctx.tabWc(tab).getURL();
    if (!isWeb(url)) { toast('Only web pages can be added'); return; }
    const data = readConst();
    let c = id && data.list.find((x) => x.id === id);
    if (!c) {
      c = { id: uuid(), name: `Constellation ${data.list.length + 1}`, created: Date.now(), stars: [], links: [] };
      data.list.push(c);
    }
    if (c.stars.some((s) => s.url === url)) { toast(`Already in "${c.name}"`); return; }
    const prev = c.stars[c.stars.length - 1];
    const star = { id: uuid(), url, title: tab.title || url, favicon: tab.favicon || '', x: clamp(0.5 + (Math.random() - 0.5) * 0.7, 0.08, 0.92), y: clamp(0.5 + (Math.random() - 0.5) * 0.7, 0.1, 0.9) };
    c.stars.push(star);
    if (prev) c.links.push([prev.id, star.id]);
    writeConst(sanitizeConst(data));
    toast(`Added to "${c.name}"`);
  }
  const constellationMenu = (tab) => {
    const data = readConst();
    return [
      ...data.list.map((c) => ({ label: c.name, click: () => addToConstellation(tab, c.id) })),
      ...(data.list.length ? [{ type: 'separator' }] : []),
      { label: 'New constellation', click: () => addToConstellation(tab, null) },
    ];
  };
  ctx.handleInternal('constGet', () => readConst());
  ctx.handleInternal('constSave', (_e, data) => { const clean = sanitizeConst(data); writeConst(clean); return clean; });

  // ====================================================================
  // Focus mode
  // ====================================================================
  const allowUntil = new Map(); // host -> time the "continue anyway" pass ends
  const hhmm = (s) => { const m = /^(\d{1,2}):(\d{2})$/.exec(String(s)); return m ? clamp(+m[1], 0, 23) * 60 + clamp(+m[2], 0, 59) : 0; };
  function scheduleWindow() {
    const sc = S().focusSchedule;
    if (!sc || !sc.enabled || !Array.isArray(sc.days)) return null;
    const d = new Date();
    const mins = d.getHours() * 60 + d.getMinutes();
    const s = hhmm(sc.start);
    const e = hhmm(sc.end);
    const inside = s <= e ? mins >= s && mins < e : mins >= s || mins < e;
    if (!inside || !sc.days.includes(d.getDay())) return null;
    const endMins = e <= mins ? e + 1440 : e;
    const end = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, endMins, 0, 0).getTime();
    return { end };
  }
  function focusEnd() {
    const manual = S().focusUntil || 0;
    const sched = scheduleWindow();
    const snooze = S().focusSnoozeUntil || 0;
    const ends = [];
    if (manual > Date.now()) ends.push(manual);
    if (sched && Date.now() >= snooze) ends.push(sched.end);
    return ends.length ? Math.max(...ends) : 0;
  }
  const focusActive = () => focusEnd() > Date.now();
  const focusStatus = () => ({ active: focusActive(), until: focusActive() ? focusEnd() : 0 });
  const siteListed = (host) => (S().focusSites || []).some((s) => host === s || host.endsWith(`.${s}`));

  function checkFocus(url) {
    if (!focusActive() || !siteListed(url.hostname)) return false;
    const exp = allowUntil.get(url.hostname);
    if (exp && exp > Date.now()) return false;
    const mins = Math.max(1, Math.round((focusEnd() - Date.now()) / 60000));
    ctx.pendingWarn.set(url.href, { kind: 'focus', host: url.hostname, detail: String(mins) });
    return true;
  }
  function cleanHost(h) {
    const v = String(h || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').split(/[/?#:]/)[0];
    return /^[a-z0-9.-]+\.[a-z]{2,}$/.test(v) ? v : '';
  }
  ctx.handleInternal('focusGet', () => ({
    sites: S().focusSites || [],
    schedule: S().focusSchedule || { enabled: false, days: [1, 2, 3, 4, 5], start: '09:00', end: '17:00' },
    ...focusStatus(),
  }));
  ctx.handleInternal('focusSet', (_e, patch) => {
    if (Array.isArray(patch && patch.sites)) S().focusSites = [...new Set(patch.sites.map(cleanHost).filter(Boolean))].slice(0, 100);
    if (patch && patch.schedule) {
      const sc = patch.schedule;
      S().focusSchedule = {
        enabled: !!sc.enabled,
        days: (Array.isArray(sc.days) ? sc.days : []).map(Number).filter((d) => d >= 0 && d <= 6),
        start: /^\d{1,2}:\d{2}$/.test(sc.start) ? sc.start : '09:00',
        end: /^\d{1,2}:\d{2}$/.test(sc.end) ? sc.end : '17:00',
      };
      S().focusSnoozeUntil = 0;
    }
    ctx.persistSettings();
    ctx.sendState();
    return focusStatus();
  });
  ctx.handleInternal('focusStart', (_e, minutes) => {
    const m = clamp(Number(minutes) || 25, 1, 600);
    S().focusUntil = Date.now() + m * 60000;
    ctx.persistSettings();
    ctx.sendState();
    toast(`Focus on for ${m} minutes`);
    return focusStatus();
  });
  ctx.handleInternal('focusStop', () => {
    S().focusUntil = 0;
    const sched = scheduleWindow();
    if (sched) S().focusSnoozeUntil = sched.end; // end today's scheduled session too
    ctx.persistSettings();
    ctx.sendState();
    return focusStatus();
  });
  let lastFocusActive = false;
  const focusTimer = setInterval(() => {
    const a = focusActive();
    if (a !== lastFocusActive) { lastFocusActive = a; ctx.sendState(); }
  }, 20000);
  focusTimer.unref?.();

  // ====================================================================
  // Site panel and "forget this site"
  // ====================================================================
  const sessionFor = (tab) => (tab.private ? session.fromPartition(ctx.PRIVATE_PARTITION) : session.defaultSession);

  async function siteInfo(tab) {
    const url = ctx.tabWc(tab).getURL();
    const origin = ctx.cleanOrigin(url);
    if (!origin) return null;
    const host = new URL(origin).hostname;
    let cookieCount = 0;
    try { cookieCount = (await sessionFor(tab).cookies.get({ url: origin })).length; } catch { /* ignore */ }
    const hosts = [...(tab.blockedHosts || new Map()).entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([h, n]) => ({ host: h, count: n }));
    const perms = Object.entries(S().permissions).filter(([k]) => k.startsWith(`${origin}|`)).map(([k, v]) => ({ key: k, name: k.slice(origin.length + 1), allow: v }));
    const https = origin.startsWith('https:');
    const allowed = (S().siteAllow || []).includes(host);
    const blocked = tab.blocked || 0;
    let score = 100;
    if (!https) score -= 40;
    score -= allowed ? Math.min(30, blocked * 2) : Math.min(10, Math.floor(blocked / 5));
    if (cookieCount > 15) score -= 10;
    if (cookieCount > 40) score -= 10;
    for (const p of perms) if (p.allow && /media|camera|microphone|geolocation|notifications/.test(p.name)) score -= 5;
    score = clamp(score, 0, 100);
    const grade = score >= 90 ? 'A' : score >= 75 ? 'B' : score >= 60 ? 'C' : score >= 40 ? 'D' : 'F';
    return { host, origin, https, cookieCount, blocked, blockedHosts: hosts, perms, allowed, grade, score, blockOn: S().blockAds, private: !!tab.private };
  }

  async function forgetSite(tab) {
    const origin = ctx.cleanOrigin(ctx.tabWc(tab).getURL());
    if (!origin) return;
    const host = new URL(origin).hostname;
    const ses = sessionFor(tab);
    try {
      for (const c of await ses.cookies.get({})) {
        const d = String(c.domain || '').replace(/^\./, '');
        if (d === host || host.endsWith(`.${d}`) || d.endsWith(`.${host}`)) {
          try { await ses.cookies.remove(`${c.secure ? 'https' : 'http'}://${d}${c.path || '/'}`, c.name); } catch { /* ignore */ }
        }
      }
      await ses.clearStorageData({ origin });
    } catch { /* ignore */ }
    for (const k of Object.keys(S().permissions)) if (k.startsWith(`${origin}|`)) delete S().permissions[k];
    delete S().zoom[host];
    S().siteAllow = (S().siteAllow || []).filter((h) => h !== host);
    ctx.persistSettings();
    ctx.forgetHistoryHost(host);
    try { ctx.recall.removeHost(host); } catch { /* recall off */ }
    orbits = orbits.filter((o) => { try { return new URL(o.url).hostname !== host; } catch { return true; } });
    saveOrbits();
    toast(`Forgot ${host}`);
    ctx.tabWc(tab).reload();
  }

  ipcMain.handle('site:open', ctx.guardUi(async (anchorX) => {
    const tab = ctx.activeTab();
    if (!tab) return;
    const info = await siteInfo(tab);
    if (!info) { toast('There is nothing to show for this page'); return; }
    info.anchorX = anchorX;
    ctx.showPopover('site', info, { anchorX });
  }));

  async function sitePopAction(a) {
    const tab = ctx.activeTab();
    if (!tab) return undefined;
    const info0 = await siteInfo(tab);
    if (!info0) return undefined;
    if (a.type === 'site-block') {
      const list = new Set(S().siteAllow || []);
      if (list.has(info0.host)) list.delete(info0.host); else list.add(info0.host);
      S().siteAllow = [...list];
      ctx.persistSettings();
      ctx.tabWc(tab).reload();
    } else if (a.type === 'site-perm') {
      delete S().permissions[String(a.key)];
      ctx.persistSettings();
    } else if (a.type === 'site-forget') {
      ctx.hidePopover();
      await forgetSite(tab);
      return undefined;
    }
    const fresh = await siteInfo(tab);
    if (fresh) { fresh.anchorX = a.anchorX; ctx.showPopover('site', fresh, { anchorX: a.anchorX, focus: true }); }
    return undefined;
  }

  // ====================================================================
  // Downloads: fingerprint and optional VirusTotal lookup
  // ====================================================================
  const getVtKey = () => {
    try { return S().vtKeyEnc ? safeStorage.decryptString(Buffer.from(S().vtKeyEnc, 'base64')) : ''; } catch { return ''; }
  };
  ctx.handleInternal('vtStatus', () => ({ set: !!S().vtKeyEnc }));
  ctx.handleInternal('setVtKey', (_e, key) => {
    const k = String(key || '').trim();
    if (!k) { delete S().vtKeyEnc; } else if (/^[A-Za-z0-9]{20,100}$/.test(k) && safeStorage.isEncryptionAvailable()) {
      S().vtKeyEnc = safeStorage.encryptString(k).toString('base64');
    } else return { ok: false, error: 'That does not look like a VirusTotal API key.' };
    ctx.persistSettings();
    return { ok: true };
  });

  function hashFile(file) {
    return new Promise((resolve, reject) => {
      const h = crypto.createHash('sha256');
      fs.createReadStream(file).on('data', (d) => h.update(d)).on('end', () => resolve(h.digest('hex'))).on('error', reject);
    });
  }

  async function onDownloadDone(rec, file) {
    try {
      rec.sha256 = await hashFile(file);
      const key = getVtKey();
      if (key) {
        const res = await net.fetch(`https://www.virustotal.com/api/v3/files/${rec.sha256}`, { headers: { 'x-apikey': key }, credentials: 'omit' });
        if (res.status === 404) rec.vt = { unknown: true };
        else if (res.status === 429) rec.vt = { error: 'VirusTotal is rate limiting this key. Try again later.' };
        else if (res.ok) {
          const st = (await res.json()).data.attributes.last_analysis_stats || {};
          const total = Object.values(st).reduce((a, b) => a + b, 0);
          rec.vt = { malicious: st.malicious || 0, suspicious: st.suspicious || 0, total };
          if (rec.vt.malicious > 0) { rec.risky = true; toast(`${rec.vt.malicious} security engines flagged ${rec.name}`); }
        } else rec.vt = { error: 'VirusTotal could not be reached.' };
      }
    } catch { /* leave the record as it was */ }
    ctx.saveDownloads();
  }

  // ====================================================================
  // Reader view
  // ====================================================================
  const readerDocs = new Map(); // tab id -> extracted article
  async function openReader(tab) {
    const wc = ctx.tabWc(tab);
    const url = wc.getURL();
    if (!isWeb(url)) { toast('Reader view works on web pages'); return; }
    let doc = null;
    try { doc = await wc.executeJavaScript(EXTRACT_SRC); } catch { /* page blocked it */ }
    if (!doc || !doc.ok) { toast('No article found on this page'); return; }
    doc.sourceUrl = url;
    readerDocs.set(tab.id, doc);
    wc.loadURL(ctx.INTERNAL.reader);
  }
  ctx.handleInternal('readerDoc', (e) => { const t = ctx.wcToTab.get(e.sender.id); return t ? readerDocs.get(t.id) || null : null; });
  ipcMain.handle('reader:open', ctx.guardUi(() => { const t = ctx.activeTab(); if (t) openReader(t); }));

  // ====================================================================
  // Peek (hold a link to preview it)
  // ====================================================================
  let peek = null;
  const HEADER = 50;
  function peekGeometry() {
    const r = ctx.contentRect();
    const cw = Math.round(r.w * 0.84);
    const ch = Math.round(r.h * 0.88);
    return { r, card: { x: Math.round((r.w - cw) / 2), y: Math.round((r.h - ch) / 2), w: cw, h: ch } };
  }
  function peekWebBounds(scale = 1) {
    const g = peekGeometry();
    const w = Math.round(g.card.w * scale);
    const h = Math.round((g.card.h - HEADER) * scale);
    const cx = g.r.x + g.card.x + g.card.w / 2;
    const cy = g.r.y + g.card.y + HEADER + (g.card.h - HEADER) / 2;
    return { x: Math.round(cx - w / 2), y: Math.round(cy - h / 2), width: w, height: h };
  }
  function closePeek() {
    if (!peek) return;
    const p = peek;
    peek = null;
    clearInterval(p.timer);
    const win = ctx.getWin();
    for (const v of [p.web, p.frame]) {
      try { win && win.contentView.removeChildView(v); } catch { /* gone */ }
      try { if (!v.webContents.isDestroyed()) v.webContents.close(); } catch { /* gone */ }
    }
  }
  function openPeek(tab, url) {
    const win = ctx.getWin();
    if (!win || !isWeb(url)) return;
    closePeek();
    ctx.hideSuggest();
    ctx.hidePopover();
    closeCmd();
    if (tab.private) ctx.ensurePrivateSession();
    const g = peekGeometry();
    const frame = new WebContentsView({ webPreferences: { preload: path.join(__dirname, 'peek-preload.js'), contextIsolation: true, sandbox: true } });
    frame.setBackgroundColor('#00000000');
    ctx.lockPanel(frame.webContents);
    const web = new WebContentsView({ webPreferences: { contextIsolation: true, sandbox: true, ...(tab.private ? { partition: ctx.PRIVATE_PARTITION } : {}) } });
    web.setBackgroundColor('#ffffff');
    try { web.setBorderRadius(12); } catch { /* older Electron */ }
    web.webContents.setWebRTCIPHandlingPolicy('default_public_interface_only');
    win.contentView.addChildView(frame);
    win.contentView.addChildView(web);
    frame.setBounds({ x: g.r.x, y: g.r.y, width: g.r.w, height: g.r.h });
    web.setBounds(peekWebBounds(0.9));
    peek = { frame, web, tabId: tab.id, private: !!tab.private, timer: null };

    const info = () => {
      if (!peek || peek.web !== web || web.webContents.isDestroyed() || frame.webContents.isDestroyed()) return;
      frame.webContents.send('peek:info', { title: web.webContents.getTitle(), url: web.webContents.getURL(), loading: web.webContents.isLoading() });
    };
    for (const ev of ['page-title-updated', 'did-navigate', 'did-navigate-in-page', 'did-start-loading', 'did-stop-loading']) web.webContents.on(ev, info);
    web.webContents.setWindowOpenHandler(({ url: u }) => { if (isWeb(u)) web.webContents.loadURL(u); return { action: 'deny' }; });
    web.webContents.on('will-navigate', (e, u) => ctx.guardScheme(e, u));
    web.webContents.on('before-input-event', (_e, input) => { if (input.type === 'keyDown' && input.key === 'Escape') closePeek(); });
    web.webContents.loadURL(url);
    frame.webContents.once('did-finish-load', () => {
      if (!peek || peek.frame !== frame) return;
      frame.webContents.send('peek:init', { card: g.card, headerH: HEADER, url });
      frame.webContents.focus();
    });
    frame.webContents.loadFile(path.join(__dirname, 'ui', 'peek.html'));

    // grow the page into place while the frame fades in
    const t0 = Date.now();
    peek.timer = setInterval(() => {
      if (!peek || peek.web !== web) return;
      const t = Math.min(1, (Date.now() - t0) / 240);
      const e = 1 - (1 - t) ** 3;
      web.setBounds(peekWebBounds(0.9 + 0.1 * e));
      if (t >= 1) clearInterval(peek.timer);
    }, 16);
  }
  ipcMain.on('peek:open', (e, data) => {
    const tab = ctx.wcToTab.get(e.sender.id);
    if (!tab || !S().peekEnabled || !e.senderFrame || e.senderFrame !== e.sender.mainFrame || tab !== ctx.activeTab()) return;
    if (!data || !isWeb(data.url)) return;
    openPeek(tab, String(data.url));
  });
  ipcMain.handle('peek:action', (e, a) => {
    if (!peek || e.sender !== peek.frame.webContents || !a) return;
    const p = peek;
    if (a.type === 'close') closePeek();
    else if (a.type === 'reload') p.web.webContents.reload();
    else if (a.type === 'back') { if (p.web.webContents.navigationHistory.canGoBack()) p.web.webContents.navigationHistory.goBack(); }
    else if (a.type === 'open') {
      const url = p.web.webContents.getURL();
      const priv = p.private;
      closePeek();
      ctx.createTab(url, { isPrivate: priv });
    }
  });

  // ====================================================================
  // Command bar (Ctrl+K)
  // ====================================================================
  let cmdView = null;
  let cmdItems = [];
  let cmdOpen = false;
  const CMD_W = 660;

  function placeCmd(h) {
    const win = ctx.getWin();
    if (!cmdView || !win) return;
    const [W] = win.getContentSize();
    cmdView.setBounds({ x: Math.max(0, Math.round((W - CMD_W) / 2)), y: 58, width: CMD_W, height: Math.max(90, Math.round(h)) });
  }
  function closeCmd() {
    if (!cmdOpen) return;
    cmdOpen = false;
    if (cmdView && !cmdView.webContents.isDestroyed()) {
      cmdView.webContents.send('cmd:hide');
      cmdView.setVisible(false);
      cmdView.setBounds({ x: 0, y: 0, width: 0, height: 0 });
    }
    const t = ctx.activeTab();
    if (t && !ctx.isNewTab(ctx.tabWc(t).getURL())) ctx.tabWc(t).focus();
  }
  function ensureCmdView() {
    if (cmdView) return;
    cmdView = new WebContentsView({ webPreferences: { preload: path.join(__dirname, 'cmd-preload.js'), contextIsolation: true, sandbox: true } });
    cmdView.setBackgroundColor('#00000000');
    cmdView.setVisible(false);
    ctx.getWin().contentView.addChildView(cmdView);
    ctx.lockPanel(cmdView.webContents);
    cmdView.webContents.loadFile(path.join(__dirname, 'ui', 'cmd.html'));
    cmdView.webContents.on('blur', () => setTimeout(() => { if (cmdOpen && cmdView && !cmdView.webContents.isFocused()) closeCmd(); }, 150));
  }
  function openCmd() {
    if (!ctx.getWin()) return;
    ensureCmdView();
    if (cmdOpen) { closeCmd(); return; }
    ctx.hideSuggest();
    ctx.hidePopover();
    closePeek();
    cmdOpen = true;
    cmdView.setVisible(true);
    ctx.getWin().contentView.addChildView(cmdView);
    placeCmd(120);
    cmdView.webContents.send('cmd:show');
    cmdView.webContents.focus();
  }

  const actions = () => {
    const tab = ctx.activeTab();
    const page = (name) => () => ctx.createTab(ctx.INTERNAL[name]);
    return [
      { title: 'New tab', kw: 'open blank', run: () => ctx.createTab(ctx.INTERNAL.newtab) },
      { title: 'New private tab', kw: 'incognito', run: () => ctx.openPrivateTab() },
      { title: 'Reader view', kw: 'article read clean aloud', run: () => tab && openReader(tab) },
      { title: 'Close duplicate tabs', kw: 'clean up same', run: () => {
        const seen = new Set(); let n = 0;
        for (const id of [...ctx.getOrder()]) { const t = ctx.tabs.get(id); if (!t || t.private) continue; const u = ctx.tabWc(t).getURL(); if (!isWeb(u)) continue; if (seen.has(u) && id !== ctx.getActiveId()) { ctx.closeTab(id); n++; } else seen.add(u); }
        toast(n ? `Closed ${n} duplicate tab${n > 1 ? 's' : ''}` : 'No duplicate tabs');
      } },
      { title: 'Mute all tabs', kw: 'sound audio quiet', run: () => { for (const t of ctx.tabs.values()) { try { ctx.tabWc(t).setAudioMuted(true); t.muted = true; } catch { /* closing */ } } ctx.sendState(); } },
      { title: 'Send other tabs to Orbits', kw: 'archive declutter', run: () => { const n = sweepOrbits(true); if (!n) toast('No tabs to move'); } },
      { title: tab && tab.pinned ? 'Unpin this tab' : 'Pin this tab', kw: 'pin', run: () => tab && ctx.togglePin(tab.id) },
      { title: 'Reload page', kw: 'refresh', run: () => tab && ctx.tabWc(tab).reload() },
      { title: 'Switch between light and dark', kw: 'theme dark light mode', run: () => ctx.toggleTheme() },
      { title: 'Add page to a constellation', kw: 'save board star', run: () => tab && Menu.buildFromTemplate(constellationMenu(tab)).popup({ window: ctx.getWin() }) },
      { title: 'Show how I got here', kw: 'trail path history tree', run: () => tab && openTrailFor(tab) },
      { title: 'Start focus for 25 minutes', kw: 'focus pomodoro block distractions', run: () => { S().focusUntil = Date.now() + 25 * 60000; ctx.persistSettings(); ctx.sendState(); toast('Focus on for 25 minutes'); } },
      { title: 'Stop focus', kw: 'focus end', run: () => { S().focusUntil = 0; ctx.persistSettings(); ctx.sendState(); } },
      { title: 'Save a session snapshot now', kw: 'backup tabs', run: () => { if (takeSnapshot('manual')) toast('Snapshot saved'); } },
      { title: 'Take a screenshot', kw: 'capture', run: () => ctx.takeScreenshot() },
      { title: 'Lock password vault', kw: 'passwords lock', run: () => ctx.vault.lock() },
      { title: 'Show or hide bookmarks bar', kw: 'bookmarks', run: () => ctx.setBookmarksBar(!S().bookmarksBar) },
      { title: 'Clear browsing data', kw: 'delete history cookies cache', run: () => ctx.createTab(`${ctx.INTERNAL.settings}#privacy`) },
      { title: 'Open Settings', kw: 'preferences options', run: page('settings') },
      { title: 'Open Passwords', kw: 'vault logins', run: page('passwords') },
      { title: 'Open History', kw: '', run: page('history') },
      { title: 'Open Bookmarks', kw: '', run: page('bookmarks') },
      { title: 'Open Downloads', kw: 'files', run: page('downloads') },
      { title: 'Open Recall', kw: 'search everything read pages', run: page('recall') },
      { title: 'Open Orbits', kw: 'archived tabs shelf', run: page('orbits') },
      { title: 'Open Trail', kw: 'how i got here', run: page('trail') },
      { title: 'Open Constellations', kw: 'boards stars', run: page('constellations') },
      { title: 'Open Focus', kw: 'block sites schedule', run: page('focus') },
      { title: 'Open Snapshots', kw: 'restore sessions', run: page('snapshots') },
      { title: 'Open Explore', kw: 'features home hub', run: page('explore') },
    ];
  };

  function openTrailFor(tab) {
    ctx.createTab(`${ctx.INTERNAL.trail}${tab.trailNode ? `#n=${tab.trailNode}` : ''}`);
  }

  function buildCmdItems(text) {
    const q = String(text || '').trim().toLowerCase();
    const words = q.split(/\s+/).filter(Boolean);
    const matches = (hay) => words.every((w) => hay.includes(w));
    const score = (title) => (words.length && title.toLowerCase().startsWith(words[0]) ? 2 : 0) + (words.length && title.toLowerCase().includes(` ${words[0]}`) ? 1 : 0);
    const items = [];
    let tabsList = ctx.getOrder().map((id) => ctx.tabs.get(id)).filter(Boolean);
    // With nothing typed, show only the most recently used tabs so the actions below them stay visible.
    if (!words.length) tabsList = tabsList.sort((a, b) => (b.lastActive || 0) - (a.lastActive || 0)).slice(0, 5);
    for (const t of tabsList) {
      const url = ctx.tabWc(t).getURL();
      const title = t.title || ctx.displayUrl(url) || 'New Tab';
      if (t.id === ctx.getActiveId() && q) continue;
      if (!words.length || matches(`${title} ${url}`.toLowerCase())) {
        items.push({ kind: 'tab', title, sub: ctx.displayUrl(url) || 'New tab page', s: 30 + score(title), run: () => ctx.selectTab(t.id) });
      }
    }
    for (const a of actions()) {
      if (!words.length ? false : matches(`${a.title} ${a.kw}`.toLowerCase())) items.push({ kind: 'action', title: a.title, sub: 'Action', s: 20 + score(a.title), run: a.run });
    }
    if (!words.length) {
      for (const a of actions().slice(0, 4)) items.push({ kind: 'action', title: a.title, sub: 'Action', s: 10, run: a.run });
    } else {
      for (const o of orbits) {
        if (matches(`${o.title} ${o.url}`.toLowerCase())) items.push({ kind: 'orbit', title: o.title, sub: 'In Orbits. Click to restore', s: 12, run: () => { orbits = orbits.filter((x) => x.id !== o.id); saveOrbits(); ctx.createTab(o.url); } });
      }
      for (const s of ctx.localSuggestions(q).filter((x) => x.kind !== 'tab')) {
        items.push({ kind: s.kind, title: s.title, sub: s.sub, s: 10, run: () => { const t = ctx.activeTab(); if (t) ctx.tabWc(t).loadURL(s.target); } });
      }
      if (S().recallEnabled) {
        try {
          for (const r of ctx.recall.search(q, 4)) items.push({ kind: 'recall', title: r.title, sub: r.snip.replace(/\[\[|\]\]/g, ''), s: 8, run: () => { const t = ctx.activeTab(); if (t) ctx.tabWc(t).loadURL(r.url); } });
        } catch { /* recall unavailable */ }
      }
      items.push({ kind: 'search', title: `Search for "${text.trim()}"`, sub: 'Web search', s: 1, run: () => ctx.createTab(ctx.normalizeInput(text)) });
    }
    return items.sort((a, b) => b.s - a.s).slice(0, 9);
  }

  ipcMain.handle('cmd:query', (e, text) => {
    if (!cmdView || e.sender !== cmdView.webContents) return [];
    cmdItems = buildCmdItems(text);
    return cmdItems.map(({ kind, title, sub }) => ({ kind, title, sub }));
  });
  ipcMain.handle('cmd:run', (e, i) => {
    if (!cmdView || e.sender !== cmdView.webContents) return;
    const it = cmdItems[Number(i)];
    closeCmd();
    if (it) { try { it.run(); } catch { /* an action failed; nothing to undo */ } }
  });
  ipcMain.handle('cmd:close', (e) => { if (cmdView && e.sender === cmdView.webContents) closeCmd(); });
  ipcMain.handle('cmd:size', (e, h) => { if (cmdView && e.sender === cmdView.webContents && cmdOpen) placeCmd(Number(h) || 120); });

  // ====================================================================
  // Page content (Recall, Orbit summaries, reader button)
  // ====================================================================
  const SENSITIVE_HOST = /(bank|paypal|venmo|chase|wellsfargo|citibank|capitalone|schwab|fidelity|vanguard|coinbase|binance|mychart|patient|healthcare|insurance|irs\.gov|turbotax)/i;
  function recallAllowed(host) {
    if (!S().recallEnabled || SENSITIVE_HOST.test(host)) return false;
    const ex = String(S().recallExclude || '').toLowerCase().split(/[\s,;]+/).filter(Boolean);
    return !ex.some((d) => host === d || host.endsWith(`.${d}`));
  }
  ipcMain.on('page:content', (e, d) => {
    const tab = ctx.wcToTab.get(e.sender.id);
    if (!tab || !e.senderFrame || e.senderFrame !== e.sender.mainFrame || !d || typeof d.text !== 'string') return;
    const url = e.senderFrame.url;
    if (!isWeb(url)) return;
    tab.snippet = String(d.desc || d.text).replace(/\s+/g, ' ').trim().slice(0, 220);
    const article = !!d.articleLike && !d.hasPassword;
    if (article !== tab.articleLike) { tab.articleLike = article; ctx.sendState(); }
    if (tab.private || d.hasPassword) return;
    let host = '';
    try { host = new URL(url).hostname; } catch { return; }
    if (!recallAllowed(host)) return;
    try { ctx.recall.put({ url, title: String(d.title || '').slice(0, 300), text: d.text.slice(0, 20000) }); } catch { /* recall unavailable */ }
  });

  ctx.handleInternal('recallStatus', () => ({ enabled: !!S().recallEnabled, available: ctx.recall.available(), count: S().recallEnabled || ctx.recall.db ? (() => { try { ctx.recall.open(); return ctx.recall.count(); } catch { return 0; } })() : 0 }));
  ctx.handleInternal('recallSearch', (_e, q) => {
    try { return ctx.recall.available() ? ctx.recall.search(q, 40) : []; } catch { return []; }
  });
  ctx.handleInternal('recallRemove', (_e, url) => { try { ctx.recall.remove(String(url)); } catch { /* ignore */ } });
  ctx.handleInternal('recallClear', () => { try { ctx.recall.clear(); } catch { /* ignore */ } });

  // ====================================================================
  // Hooks for main.js
  // ====================================================================
  return {
    onTabCreated(tab, opener) { tab.lastActive = Date.now(); if (opener && opener.trailNode) tab.openerNode = opener.trailNode; },
    onTabClosed(tab) { readerDocs.delete(tab.id); },
    onNavigated(tab, url) { trailAdd(tab, url); },
    onTitle(tab) { trailTitle(tab); },
    onBlocked(tab, host) { if (!tab.blockedHosts) tab.blockedHosts = new Map(); tab.blockedHosts.set(host, (tab.blockedHosts.get(host) || 0) + 1); },
    onNavigationStart(tab) { tab.blockedHosts = new Map(); },
    siteAllowed(tab) { try { return (S().siteAllow || []).includes(new URL(ctx.tabWc(tab).getURL()).hostname); } catch { return false; } },
    onDownloadDone,
    checkFocus,
    allowFocus(host) { allowUntil.set(host, Date.now() + 10 * 60000); },
    focusStatus,
    closePeek,
    closeCmd,
    openCmd,
    openReader,
    sitePopAction,
    tabMenuItems(tab) {
      return [
        { type: 'separator' },
        { label: 'Send to Orbits', enabled: eligibleForOrbit(tab) || (tab.id === ctx.getActiveId() && isWeb(ctx.tabWc(tab).getURL()) && ctx.getOrder().length > 1 && !tab.pinned && !tab.private), click: () => { if (ctx.getOrder().length > 1) archiveTab(tab); } },
        { label: 'Add to constellation', submenu: constellationMenu(tab), enabled: isWeb(ctx.tabWc(tab).getURL()) },
        { label: 'Show how I got here', click: () => openTrailFor(tab) },
      ];
    },
    kebabItems() {
      return [
        { label: 'Command bar', accelerator: 'CommandOrControl+K', click: openCmd },
        { label: 'Reader view', accelerator: 'F9', click: () => { const t = ctx.activeTab(); if (t) openReader(t); } },
        { label: 'Explore Tide', click: () => ctx.createTab(ctx.INTERNAL.explore) },
      ];
    },
    shutdown() { if (S().snapshotsAuto) takeSnapshot('quit'); },
    // exposed for tests
    _test: { sweepOrbits, takeSnapshot, buildCmdItems, siteInfo, forgetSite, trailAdd, checkFocus, focusActive, recallAllowed, addToConstellation, sanitizeConst, orbitsRef: () => orbits, trailRef: () => trail, snapsRef: () => snaps },
  };
}

module.exports = { init };
