const {
  app, BrowserWindow, WebContentsView, ipcMain, Menu, dialog, session, shell, clipboard, net, powerMonitor, nativeTheme, safeStorage,
} = require('electron');
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');
const privacy = require('./privacy');
const importer = require('./importer');
const { Vault, generate: generatePassword, cleanOrigin } = require('./vault');
const { SafeBrowsing } = require('./safebrowsing');
const { Recall } = require('./recall');
const features = require('./features');
const updater = require('./updater');
const IS_MAC = process.platform === 'darwin';
let fx = null; // Tide feature hooks (features.js), created once the app is ready
let pendingOpenUrl = null; // a link macOS handed us before the window existed

// ======================================================================
// Persistence
// ======================================================================
const USER_DATA = app.getPath('userData');
// The app used to be called Nova Browser. On the first run under the new name, copy the old data folder
// (bookmarks, history, vault, settings) so nothing is lost. Caches and lock files are skipped.
(function migrateOldData() {
  try {
    const oldDir = path.join(app.getPath('appData'), 'Nova Browser');
    if (path.basename(USER_DATA) !== 'Tide Browser' || fs.existsSync(path.join(USER_DATA, 'settings.json'))) return;
    if (!fs.existsSync(oldDir)) return;
    const skip = new Set(['Cache', 'Code Cache', 'GPUCache', 'DawnGraphiteCache', 'DawnWebGPUCache', 'ShaderCache', 'GrShaderCache', 'Crashpad', 'blob_storage', 'Singleton', 'SingletonLock', 'SingletonCookie', 'SingletonSocket', 'lockfile']);
    fs.cpSync(oldDir, USER_DATA, { recursive: true, filter: (src) => !skip.has(path.basename(src)) });
  } catch {}
})();
const dataFile = (name) => path.join(USER_DATA, name);
function loadJSON(name, fallback) {
  try { return JSON.parse(fs.readFileSync(dataFile(name), 'utf8')); } catch { return fallback; }
}
const pending = {};
const saveTimers = {};
function writeNow(name) {
  if (!(name in pending)) return;
  try { fs.writeFileSync(dataFile(name), JSON.stringify(pending[name])); } catch (e) { console.error(e); }
  delete pending[name];
}
function saveJSON(name, data) {
  pending[name] = data;
  clearTimeout(saveTimers[name]);
  saveTimers[name] = setTimeout(() => writeNow(name), 400);
}
function flushSaves() { Object.keys(pending).forEach(writeNow); }

const DEFAULT_SETTINGS = {
  searchEngine: 'google',
  searchSuggestions: false,
  theme: 'dark', // dark | light | system
  startup: 'newtab', // newtab | continue | custom
  startupUrl: '',
  bookmarksBar: false,
  reduceMotion: false,
  blockAds: true,
  httpsOnly: false,
  sendGpc: true,
  blockThirdPartyCookies: false,
  askDownload: false,
  downloadDir: '',
  spellcheck: true,
  spellLang: 'en-US',
  hardwareAccel: true,
  warnDangerous: true, // warn before opening sites on the malware list
  stripTracking: true, // remove utm_*, fbclid, gclid... from links you open
  clearOnExit: false, // delete cookies and site data when Tide closes
  secureDns: 'off', // off | cloudflare | google | quad9
  pwPrompts: true, // offer to save passwords after you sign in
  pwOffer: true, // offer to create a vault the first time you sign in somewhere
  pwAutoLockMin: 15, // 0 = never
  recallEnabled: false, // keep a private, searchable copy of the text of pages you read
  recallExclude: '', // sites Recall never saves (comma separated)
  orbitMinutes: 480, // move tabs you have not used for this long into Orbits (0 = never)
  peekEnabled: true, // hold a link to preview it
  snapshotsAuto: true, // save your open tabs every 30 minutes and when you quit
  siteAllow: [], // sites where tracker blocking is turned off
  focusSites: [], focusSchedule: { enabled: false, days: [1, 2, 3, 4, 5], start: '09:00', end: '17:00' }, focusUntil: 0, focusSnoozeUntil: 0,
  shortcuts: null,
  zoom: {},
  permissions: {},
  extensions: [],
  window: null,
};
let settings = { ...DEFAULT_SETTINGS, ...loadJSON('settings.json', {}) };
const persistSettings = () => saveJSON('settings.json', settings);

// Must be decided before the app is ready.
if (settings.hardwareAccel === false) app.disableHardwareAcceleration();

// Present as plain Chrome so sites (e.g. Google sign-in) don't reject us.
app.userAgentFallback = app.userAgentFallback
  .replace(/\sElectron\/[\d.]+/, '')
  .replace(new RegExp(`\\s${app.getName()}\\/[\\d.]+`), '');

if (!app.requestSingleInstanceLock()) app.quit();

// ======================================================================
// Constants
// ======================================================================
const TOP_HEIGHT = 92; // tab strip 44 + toolbar 48
const SIDEBAR_W = 68; // floating left sidebar
const FIND_H = 36;
const BAR_H = 32; // bookmarks bar
const ENGINES = {
  google: 'https://www.google.com/search?q=',
  duckduckgo: 'https://duckduckgo.com/?q=',
  bing: 'https://www.bing.com/search?q=',
  brave: 'https://search.brave.com/search?q=',
};
const ENGINE_NAMES = { google: 'Google', duckduckgo: 'DuckDuckGo', bing: 'Bing', brave: 'Brave Search' };
const SUGGEST_ENDPOINTS = {
  google: 'https://suggestqueries.google.com/complete/search?client=firefox&q=',
  duckduckgo: 'https://duckduckgo.com/ac/?type=list&q=',
  bing: 'https://api.bing.com/osjson.aspx?query=',
  brave: 'https://search.brave.com/api/suggest?q=',
};
const searchUrl = () => ENGINES[settings.searchEngine] || ENGINES.google;
const PAGES_DIR = path.join(__dirname, 'pages');
const PAGES_URL = pathToFileURL(PAGES_DIR).href;
const INTERNAL = {};
for (const n of ['newtab', 'history', 'bookmarks', 'downloads', 'settings', 'passwords', 'warning',
  'explore', 'recall', 'orbits', 'trail', 'constellations', 'focus', 'snapshots', 'reader']) {
  INTERNAL[n] = pathToFileURL(path.join(PAGES_DIR, `${n}.html`)).href;
}
const NEWTAB_URL = INTERNAL.newtab;
const HISTORY_URL = INTERNAL.history;
const AI_URL = 'https://claude.ai/new';
const PRIVATE_PARTITION = 'incognito'; // no "persist:" prefix => in-memory only

// ======================================================================
// State
// ======================================================================
let bookmarks = loadJSON('bookmarks.json', []);
let history = loadJSON('history.json', []);
let downloads = loadJSON('downloads.json', []).map((d) => (
  d.state === 'progressing' || d.state === 'paused' ? { ...d, state: 'interrupted' } : d
));
const dlItems = new Map(); // download id -> DownloadItem (live)

let win = null;
let ui = null;
const tabs = new Map(); // id -> tab
const wcToTab = new Map(); // webContents id -> tab
let order = [];
let activeId = null;
let nextId = 1;
let htmlFullscreen = false;
let findOpen = false;
let extraOffset = 0; // animated extra height (bookmarks bar + find bar)
let extraTimer = null;
let introPlayed = false;
let sessionEnabled = false;
const closedStack = [];

// security state
const vault = new Vault(path.join(USER_DATA, 'vault.json'));
const safeBrowsing = new SafeBrowsing(USER_DATA);
const recall = new Recall(USER_DATA);
const allowSites = new Set(); // hosts the user chose to visit despite a malware warning (this session)
const certAllow = new Set(); // hosts the user chose to open despite a certificate error (this session)
const pendingWarn = new Map(); // url -> { kind, host } for requests cancelled by the malware check
const dismissedOrigins = new Set(); // origins where the user ignored an unlock prompt (this session)
let popView = null;
const pop = { mode: null, visible: false, pending: null, ctx: null };
let splashView = null; // full-window overlay that plays the paint-splash theme transition
const splash = { ready: null, done: null, running: false };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const DANGEROUS_EXT = new Set(['.exe', '.msi', '.bat', '.cmd', '.com', '.scr', '.ps1', '.psm1', '.vbs', '.vbe', '.js', '.jse', '.wsf', '.wsh', '.jar',
  '.lnk', '.hta', '.reg', '.cpl', '.msc', '.dll', '.msp', '.apk', '.appx', '.msix', '.iso', '.img', '.vhd', '.docm', '.xlsm', '.pptm',
  // macOS
  '.app', '.dmg', '.pkg', '.mpkg', '.command', '.terminal', '.sh', '.scpt', '.scptd', '.workflow', '.action', '.osax', '.webloc', '.inetloc', '.jnlp', '.dylib']);
const DNS_SERVERS = {
  cloudflare: ['https://cloudflare-dns.com/dns-query'],
  google: ['https://dns.google/dns-query'],
  quad9: ['https://dns.quad9.net/dns-query'],
};
const configuredSessions = new Set();
const extIds = new Map(); // extension path -> id

// ======================================================================
// Helpers
// ======================================================================
const isNewTab = (u) => typeof u === 'string' && (u === NEWTAB_URL || u.startsWith(`${NEWTAB_URL}#`));

function normalizeInput(raw) {
  const s = (raw || '').trim();
  if (!s) return NEWTAB_URL;
  const bm = /^browser:\/\/(\w+)(?:[/#](\w+))?\/?$/i.exec(s);
  if (bm && INTERNAL[bm[1].toLowerCase()]) return INTERNAL[bm[1].toLowerCase()] + (bm[2] ? `#${bm[2]}` : '');
  if (/^(https?|file|about|data|view-source|chrome|devtools):/i.test(s)) return s;
  if (/^[a-z]:[\\/]/i.test(s)) return pathToFileURL(s).href;
  const looksLikeHost =
    /^localhost(:\d+)?([/?#].*)?$/i.test(s) ||
    /^(\d{1,3}\.){3}\d{1,3}(:\d+)?([/?#].*)?$/.test(s) ||
    /^[^\s/]+\.[a-z]{2,}(:\d+)?([/?#]\S*)?$/i.test(s);
  if (looksLikeHost && !/\s/.test(s)) {
    return (/^localhost|^(\d{1,3}\.){3}\d{1,3}/i.test(s) ? 'http://' : 'https://') + s;
  }
  return searchUrl() + encodeURIComponent(s);
}

function displayUrl(u) {
  if (!u) return '';
  if (u.startsWith(PAGES_URL)) {
    const hash = u.includes('#') ? u.slice(u.indexOf('#') + 1) : '';
    const base = u.split(/[?#]/)[0];
    if (base === NEWTAB_URL) return '';
    for (const [name, url] of Object.entries(INTERNAL)) if (base === url) return `browser://${name}${hash && name !== 'warning' ? `#${hash}` : ''}`;
  }
  if (u.startsWith('data:text/html') && u.includes('tide-error')) return '';
  return u;
}

const isInternalSender = (e) => {
  const url = e.senderFrame && e.senderFrame.url;
  return typeof url === 'string' && url.startsWith(`${PAGES_URL}/`);
};
const isUiSender = (e) => ui && e.sender === ui.webContents;
const guardUi = (fn) => (event, ...args) => { if (isUiSender(event)) return fn(...args); };
const handleInternal = (name, fn) => ipcMain.handle(`internal:${name}`, (e, ...a) => (isInternalSender(e) ? fn(e, ...a) : undefined));
const activeTab = () => tabs.get(activeId);
const tabWc = (t) => t.view.webContents;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

function tabSnapshot(t) {
  const wc = tabWc(t);
  const dead = wc.isDestroyed();
  const url = dead ? '' : wc.getURL();
  return {
    id: t.id,
    title: t.title || displayUrl(url) || 'New Tab',
    url: displayUrl(url),
    favicon: t.favicon || '',
    loading: t.loading,
    canGoBack: dead ? false : wc.navigationHistory.canGoBack(),
    canGoForward: dead ? false : wc.navigationHistory.canGoForward(),
    bookmarked: bookmarks.some((b) => b.url === url),
    pinned: t.pinned,
    private: t.private,
    audible: t.audible,
    muted: t.muted,
    blocked: t.blocked,
    loginForm: !!t.hasLoginForm,
    articleLike: !!t.articleLike,
    zoom: dead ? 0 : wc.getZoomLevel(),
  };
}

let stateTimer = null;
function sendState() {
  clearTimeout(stateTimer);
  stateTimer = setTimeout(() => {
    if (!ui || ui.webContents.isDestroyed()) return;
    ui.webContents.send('state', {
      tabs: order.map((id) => tabSnapshot(tabs.get(id))),
      activeId,
      bookmarks,
      prefs: { bookmarksBar: settings.bookmarksBar, reduceMotion: settings.reduceMotion, blockAds: settings.blockAds, theme: settings.theme, focus: fx ? fx.focusStatus() : { active: false, until: 0 } },
    });
    const t = activeTab();
    if (win && t) win.setTitle(`${t.title || 'New Tab'} - Tide Browser`);
    saveSession();
  }, 16);
}

function saveSession() {
  if (!sessionEnabled) return;
  const list = order.map((id) => tabs.get(id)).filter((t) => !t.private);
  saveJSON('session.json', {
    tabs: list.map((t) => {
      const url = tabWc(t).getURL();
      return { url: !url || url.startsWith('data:') ? NEWTAB_URL : url, pinned: t.pinned };
    }),
    active: list.findIndex((t) => t.id === activeId),
  });
}

// ---------- layout ----------
function extraTarget() { return (settings.bookmarksBar ? BAR_H : 0) + (findOpen ? FIND_H : 0); }
function animateExtra() {
  clearInterval(extraTimer);
  const target = extraTarget();
  extraTimer = setInterval(() => {
    extraOffset += (target - extraOffset) * 0.28;
    if (Math.abs(target - extraOffset) < 0.5) { extraOffset = target; clearInterval(extraTimer); }
    layout();
  }, 16);
}

function layout() {
  if (!win) return;
  const [w, h] = win.getContentSize();
  const top = htmlFullscreen ? 0 : TOP_HEIGHT + Math.round(extraOffset);
  const left = htmlFullscreen ? 0 : SIDEBAR_W;
  // The UI view spans the whole window; tab views sit on top of it, leaving the chrome visible.
  ui.setBounds({ x: 0, y: 0, width: htmlFullscreen ? 0 : w, height: htmlFullscreen ? 0 : h });
  const t = activeTab();
  if (t) t.view.setBounds({ x: left, y: top, width: Math.max(0, w - left), height: Math.max(0, h - top) });
}

// ---------- theme ----------
// nativeTheme drives prefers-color-scheme in every page (the browser UI, internal pages and websites).
function themeColors() {
  return nativeTheme.shouldUseDarkColors
    ? { bg: '#000000', fg: '#e8eaed', surface: '#05060a' }
    : { bg: '#f3f5fb', fg: '#1c2237', surface: '#ffffff' };
}
function paintWindowChrome() {
  if (!win) return;
  const c = themeColors();
  try {
    win.setBackgroundColor(c.bg);
    if (!IS_MAC) win.setTitleBarOverlay({ color: c.bg, symbolColor: c.fg, height: 44 });
    if (ui) ui.setBackgroundColor(c.bg);
  } catch { /* window closing */ }
}
function applyThemeNow() {
  nativeTheme.themeSource = settings.theme === 'light' || settings.theme === 'system' ? settings.theme : 'dark';
  paintWindowChrome();
  sendState();
}

function createSplashView() {
  splashView = new WebContentsView({
    webPreferences: { preload: path.join(__dirname, 'splash-preload.js'), contextIsolation: true, sandbox: true },
  });
  splashView.setBackgroundColor('#00000000');
  splashView.setVisible(false);
  win.contentView.addChildView(splashView);
  splashView.webContents.on('will-navigate', (e) => e.preventDefault());
  splashView.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  splashView.webContents.loadFile(path.join(__dirname, 'ui', 'splash.html'));
}

// Paint-splash transition. Steps:
//   1. capture the window in the old theme and show that picture in a full-window overlay,
//   2. switch the real theme underneath (hidden by the overlay),
//   3. the overlay erases the old picture with an expanding paint splash that starts at `origin`.
async function themeTransition(origin) {
  const skip = !win || !ui || !splashView || splash.running || settings.reduceMotion;
  if (skip) { applyThemeNow(); return; }
  splash.running = true;
  const toDark = !nativeTheme.shouldUseDarkColors; // the theme we are about to switch to, once applied
  try {
    hideSuggest();
    hidePopover();
    const [W, H] = win.getContentSize();
    const uiImg = await ui.webContents.capturePage();
    let tab = null;
    const t = activeTab();
    if (t && !htmlFullscreen) {
      try {
        const b = t.view.getBounds();
        const img = await tabWc(t).capturePage();
        tab = { url: img.toDataURL(), x: b.x, y: b.y, w: b.width, h: b.height };
      } catch { /* the page can't be captured right now; its old look just won't be covered */ }
    }
    splashView.setBounds({ x: 0, y: 0, width: W, height: H });
    splashView.setVisible(true);
    win.contentView.addChildView(splashView); // above every other view
    await new Promise((resolve) => {
      splash.ready = resolve;
      setTimeout(resolve, 1500); // never hang if the overlay fails to answer
      splashView.webContents.send('splash:start', { ui: uiImg.toDataURL(), tab, W, H, origin, toDark });
    });
    applyThemeNow();
    await sleep(170); // let every view repaint in the new theme before the reveal starts
    await new Promise((resolve) => {
      splash.done = resolve;
      setTimeout(resolve, 3000);
      splashView.webContents.send('splash:go');
    });
  } catch {
    applyThemeNow();
  } finally {
    if (splashView && !splashView.webContents.isDestroyed()) {
      splashView.setVisible(false);
      splashView.setBounds({ x: 0, y: 0, width: 0, height: 0 });
    }
    splash.running = false;
    splash.ready = null;
    splash.done = null;
  }
}

function applyTheme(animate = false, origin = null) {
  if (animate) themeTransition(origin); else applyThemeNow();
}

ipcMain.handle('splash:ready', (e) => { if (splashView && e.sender === splashView.webContents && splash.ready) splash.ready(); });
ipcMain.handle('splash:done', (e) => { if (splashView && e.sender === splashView.webContents && splash.done) splash.done(); });
nativeTheme.on('updated', paintWindowChrome); // Windows switched between light and dark while following the system

function fadeWindowIn(from = 0) {
  let o = from;
  const timer = setInterval(() => {
    if (!win) { clearInterval(timer); return; }
    o = Math.min(1, o + (from > 0 ? 0.06 : 0.09));
    try { win.setOpacity(o); } catch { /* unsupported */ }
    if (o >= 1) clearInterval(timer);
  }, 16);
}

// ---------- history ----------
function recordHistory(url, title) {
  if (!/^https?:/i.test(url)) return;
  const last = history[0];
  if (last && last.url === url && Date.now() - last.time < 3000) { last.title = title || last.title; return; }
  history.unshift({ url, title: title || url, time: Date.now() });
  if (history.length > 5000) history.length = 5000;
  saveJSON('history.json', history);
}

// ---------- zoom (remembered per site) ----------
const hostKey = (url) => {
  try { const u = new URL(url); return /^https?:$/.test(u.protocol) ? u.hostname : ''; } catch { return ''; }
};
function applyZoom(tab) {
  const wc = tabWc(tab);
  if (wc.isDestroyed()) return;
  const k = hostKey(wc.getURL());
  if (!k) return;
  wc.setZoomLevel(settings.zoom[k] !== undefined ? settings.zoom[k] : 0);
}
function zoomTab(t, delta) {
  if (!t) return;
  const wc = tabWc(t);
  const level = delta === 0 ? 0 : clamp(wc.getZoomLevel() + delta, -4, 4);
  wc.setZoomLevel(level);
  const k = hostKey(wc.getURL());
  if (k && !t.private) {
    if (level === 0) delete settings.zoom[k]; else settings.zoom[k] = level;
    persistSettings();
  }
  sendState();
}
const zoom = (delta) => zoomTab(activeTab(), delta);

// ======================================================================
// Address bar suggestions (dropdown is its own overlay view above the page)
// ======================================================================
const SUGGEST_ROW_H = 44;
let suggestView = null;
const sg = { items: [], sel: 0, seq: 0, visible: false, hideTimer: null, rect: { x: 0, y: 0, width: 0, height: 0 } };

function createSuggestView() {
  suggestView = new WebContentsView({
    webPreferences: { preload: path.join(__dirname, 'suggest-preload.js'), contextIsolation: true, sandbox: true },
  });
  suggestView.setBackgroundColor('#00000000');
  suggestView.setVisible(false);
  win.contentView.addChildView(suggestView);
  suggestView.webContents.on('will-navigate', (e) => e.preventDefault());
  suggestView.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  suggestView.webContents.loadFile(path.join(__dirname, 'ui', 'suggest.html'));
}

function pushSuggest() {
  if (!suggestView || suggestView.webContents.isDestroyed()) return;
  const r = sg.rect;
  suggestView.setBounds({
    x: Math.round(r.x - 14),
    y: Math.round(r.y + r.height),
    width: Math.round(r.width + 28),
    height: 6 + 16 + SUGGEST_ROW_H * sg.items.length + 20,
  });
  suggestView.webContents.send('suggest:update', {
    items: sg.items.map(({ kind, title, sub }) => ({ kind, title, sub })),
    sel: sg.sel,
  });
}

function showSuggest() {
  clearTimeout(sg.hideTimer);
  if (!sg.visible) {
    sg.visible = true;
    suggestView.setVisible(true);
    win.contentView.addChildView(suggestView); // re-adding moves it above the page views
    suggestView.webContents.send('suggest:show');
  }
  pushSuggest();
}

function hideSuggest() {
  sg.seq++; // invalidates any in-flight remote lookup
  if (!sg.visible || !suggestView) return;
  sg.visible = false;
  suggestView.webContents.send('suggest:hide');
  clearTimeout(sg.hideTimer);
  sg.hideTimer = setTimeout(() => {
    if (!sg.visible && suggestView && !suggestView.webContents.isDestroyed()) {
      suggestView.setVisible(false);
      suggestView.setBounds({ x: 0, y: 0, width: 0, height: 0 });
    }
  }, 220);
}

function typedItem(text) {
  const t = text.trim();
  const target = normalizeInput(t);
  const isSearch = target === searchUrl() + encodeURIComponent(t);
  return isSearch
    ? { kind: 'search', title: t, sub: `Search ${ENGINE_NAMES[settings.searchEngine] || 'the web'}`, target, fill: t }
    : { kind: 'nav', title: t, sub: 'Open page', target, fill: t };
}

function localSuggestions(text) {
  const q = text.trim().toLowerCase();
  if (!q) return [];
  const terms = q.split(/\s+/);
  const key = (u) => u.replace(/\/$/, '');
  const matches = (title, url) => {
    const hay = `${title || ''} ${url}`.toLowerCase();
    return terms.every((t) => hay.includes(t));
  };
  const score = (title, url) => {
    let host = '';
    try { host = new URL(url).hostname.replace(/^www\./, ''); } catch { /* ignore */ }
    let s = 0;
    if (host.startsWith(q)) s += 6; else if (host.includes(q)) s += 3;
    if ((title || '').toLowerCase().startsWith(q)) s += 2;
    return s;
  };
  const seen = new Set();
  const out = [];
  for (const id of order) {
    if (id === activeId) continue;
    const t = tabs.get(id);
    const url = tabWc(t).getURL();
    if (!/^https?:/i.test(url) || !matches(t.title, url) || seen.has(key(url))) continue;
    seen.add(key(url));
    out.push({ kind: 'tab', title: t.title || url, sub: url, tabId: id, target: url, fill: url, score: score(t.title, url) + 5 });
  }
  for (const b of bookmarks) {
    if (!matches(b.title, b.url) || seen.has(key(b.url))) continue;
    seen.add(key(b.url));
    out.push({ kind: 'bookmark', title: b.title || b.url, sub: b.url, target: b.url, fill: b.url, score: score(b.title, b.url) + 3 });
  }
  history.forEach((h, i) => {
    if (!matches(h.title, h.url) || seen.has(key(h.url))) return;
    seen.add(key(h.url));
    out.push({ kind: 'history', title: h.title || h.url, sub: h.url, target: h.url, fill: h.url, score: score(h.title, h.url) - i / 5000 });
  });
  return out.sort((a, b) => b.score - a.score).slice(0, 5);
}

async function remoteSuggestions(text) {
  const endpoint = SUGGEST_ENDPOINTS[settings.searchEngine];
  if (!endpoint) return [];
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 1500);
  try {
    const res = await net.fetch(endpoint + encodeURIComponent(text), { signal: ctl.signal, credentials: 'omit' });
    const data = await res.json();
    return Array.isArray(data[1]) ? data[1].filter((x) => typeof x === 'string').slice(0, 6) : [];
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

function pickSuggest(i) {
  const it = sg.items[i];
  if (!it) return;
  hideSuggest();
  ui?.webContents.send('omni:done');
  if (it.kind === 'tab' && tabs.has(it.tabId)) { selectTab(it.tabId); return; }
  const t = activeTab();
  if (!t) return;
  tabWc(t).loadURL(it.target);
  tabWc(t).focus();
}

// ======================================================================
// Tabs
// ======================================================================
function pinnedCount() { return order.filter((id) => tabs.get(id).pinned).length; }

function createTab(rawUrl, { activate = true, isPrivate = false, pinned = false, afterId = null, openerId = null } = {}) {
  const id = nextId++;
  if (isPrivate) configureSession(session.fromPartition(PRIVATE_PARTITION), true);
  const view = new WebContentsView({
    webPreferences: {
      preload: path.join(__dirname, 'page-preload.js'),
      contextIsolation: true,
      sandbox: true,
      spellcheck: true,
      ...(isPrivate ? { partition: PRIVATE_PARTITION } : {}),
    },
  });
  view.setBackgroundColor('#ffffff');
  const tab = { id, view, title: '', favicon: '', loading: false, pinned, private: isPrivate, audible: false, muted: false, blocked: 0, hasLoginForm: false,
    lastActive: Date.now(), snippet: '', articleLike: false, blockedHosts: new Map(), trailNode: null, openerNode: null };
  tabs.set(id, tab);
  if (fx) fx.onTabCreated(tab, openerId != null ? tabs.get(openerId) : null);
  wcToTab.set(view.webContents.id, tab);
  // Stop WebRTC from revealing your local network addresses to websites.
  view.webContents.setWebRTCIPHandlingPolicy('default_public_interface_only');

  if (pinned) order.splice(pinnedCount(), 0, id);
  else if (afterId != null && order.includes(afterId)) order.splice(order.indexOf(afterId) + 1, 0, id);
  else order.push(id);

  win.contentView.addChildView(view);
  view.setVisible(false);
  wire(tab);
  view.webContents.loadURL(normalizeInput(rawUrl || NEWTAB_URL));
  if (activate) selectTab(id); else sendState();
  return id;
}

function openPrivateTab(url) { return createTab(url || `${NEWTAB_URL}#private`, { isPrivate: true }); }

function selectTab(id) {
  if (!tabs.has(id)) return;
  hideSuggest();
  if (pop.visible && activeId !== id) hidePopover();
  if (fx && activeId !== id) { fx.closePeek(); fx.closeCmd(); }
  const prevTab = tabs.get(activeId);
  if (prevTab) prevTab.lastActive = Date.now();
  tabs.get(id).lastActive = Date.now();
  activeId = id;
  for (const [tid, t] of tabs) t.view.setVisible(tid === id);
  layout();
  const wc = tabWc(tabs.get(id));
  if (isNewTab(wc.getURL()) || !wc.getURL()) {
    ui.webContents.focus();
    ui.webContents.send('focus-omnibox');
  } else {
    wc.focus();
  }
  sendState();
}

async function wipePrivateData() {
  try {
    const ses = session.fromPartition(PRIVATE_PARTITION);
    await ses.clearStorageData();
    await ses.clearCache();
  } catch { /* ignore */ }
}

function closeTab(id) {
  const t = tabs.get(id);
  if (!t) return;
  const wc = tabWc(t);
  const url = wc.getURL();
  if (!t.private && url && !isNewTab(url) && !url.startsWith('data:')) closedStack.push({ url, pinned: t.pinned });
  const idx = order.indexOf(id);
  order.splice(idx, 1);
  tabs.delete(id);
  wcToTab.delete(wc.id);
  if (fx) fx.onTabClosed(t);
  win.contentView.removeChildView(t.view);
  if (!wc.isDestroyed()) wc.close();
  if (t.private && !order.some((i) => tabs.get(i).private)) wipePrivateData();
  if (order.length === 0) {
    if (sessionEnabled) { pending['session.json'] = { tabs: [], active: -1 }; writeNow('session.json'); sessionEnabled = false; }
    win.close();
    return;
  }
  if (activeId === id) selectTab(order[Math.min(idx, order.length - 1)]);
  else sendState();
}

function cycleTab(dir) {
  const i = order.indexOf(activeId);
  selectTab(order[(i + dir + order.length) % order.length]);
}

function togglePin(id) {
  const t = tabs.get(id);
  if (!t) return;
  t.pinned = !t.pinned;
  order.splice(order.indexOf(id), 1);
  order.splice(pinnedCount(), 0, id);
  sendState();
}

function toggleMute(id) {
  const t = tabs.get(id);
  if (!t) return;
  const wc = tabWc(t);
  wc.setAudioMuted(!wc.isAudioMuted());
  t.muted = wc.isAudioMuted();
  sendState();
}

function reopenClosed() {
  const c = closedStack.pop();
  if (c) createTab(c.url, { pinned: c.pinned });
}

// ---------- warnings and external links ----------
const SAFE_SCHEMES = new Set(['http:', 'https:', 'file:', 'about:', 'data:', 'blob:', 'view-source:', 'devtools:', 'chrome-error:']);
// Windows handlers that have been used to run code from a web link.
const DANGEROUS_SCHEMES = new Set(['ms-msdt:', 'search-ms:', 'search:', 'ms-officecmd:', 'ms-appinstaller:', 'ms-cxh:', 'ms-cxh-full:',
  'ms-excel:', 'ms-word:', 'ms-powerpoint:', 'ms-access:', 'ms-publisher:', 'ms-visio:', 'ms-infopath:', 'ms-spd:', 'ms-project:', 'ms-settings-airplanemode:',
  'ms-gamingoverlay:', 'ms-retaildemo-launchbioonboarding:', 'ie:', 'microsoft-edge:', 'shell:', 'ldap:', 'mhtml:', 'ms-browser-extension:']);

function isSafeScheme(url) {
  try { return SAFE_SCHEMES.has(new URL(url).protocol); } catch { return true; }
}
function openExternalSafely(url) {
  let proto;
  try { proto = new URL(url).protocol; } catch { return; }
  if (proto === 'mailto:' || proto === 'tel:') { shell.openExternal(url); return; }
  const name = proto.replace(':', '');
  if (DANGEROUS_SCHEMES.has(proto)) { ui?.webContents.send('toast', `Blocked a link that tried to open "${name}"`); return; }
  dialog.showMessageBox(win, {
    type: 'question', buttons: ['Open', 'Cancel'], defaultId: 1, cancelId: 1,
    title: 'Open another app?', message: `This page wants to open a "${name}" link in another app.`, detail: url.slice(0, 300),
  }).then((r) => { if (r.response === 0) shell.openExternal(url); }).catch(() => {});
}
function warningUrl(kind, url, host, detail = '') {
  return `${INTERNAL.warning}?${new URLSearchParams({ kind, url, host: host || '', detail }).toString()}`;
}
function takePendingWarn(url) {
  let w = pendingWarn.get(url);
  if (w) { pendingWarn.delete(url); return w; }
  try {
    const host = new URL(url).hostname;
    for (const [k, v] of pendingWarn) if (v.host === host) { pendingWarn.delete(k); return v; }
  } catch { /* ignore */ }
  return null;
}
// Called from the network layer for every top-level navigation.
function checkDangerous(url) {
  if (fx && fx.checkFocus(url)) return true; // a site you blocked for focus time
  if (!settings.warnDangerous) return false;
  if (allowSites.has(url.hostname) || !safeBrowsing.isDangerous(url.hostname)) return false;
  pendingWarn.set(url.href, { kind: 'malware', host: url.hostname });
  return true;
}

function forgetHistoryHost(host) {
  history = history.filter((h) => { try { const x = new URL(h.url).hostname; return !(x === host || x.endsWith(`.${host}`)); } catch { return true; } });
  saveJSON('history.json', history);
}

function errorPage(url, code, desc) {
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  let host = url;
  try { host = new URL(url).host || url; } catch { /* keep */ }
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>Can't reach this page</title>
<!-- tide-error --><meta name="color-scheme" content="light dark"><style>:root{--bg:#05060a;--tx:#e8ecf5;--mu:#8a90a2;--cd:#11141d;--ab:#2a3f9a;--al:#6f8cff}
@media (prefers-color-scheme:light){:root{--bg:#f3f5fb;--tx:#1c2237;--mu:#667088;--cd:#e6eaf5;--ab:#3556d8;--al:#3556d8}}
body{font-family:Segoe UI,system-ui,sans-serif;background:var(--bg);color:var(--tx);margin:0;display:flex;align-items:center;justify-content:center;height:100vh}
.b{max-width:560px;padding:24px;animation:i .6s cubic-bezier(.16,1,.3,1)}@keyframes i{from{opacity:0;transform:translateY(16px)}}h1{font-size:24px;font-weight:500;margin:0 0 12px}p{color:var(--mu);line-height:1.5}code{background:var(--cd);padding:2px 6px;border-radius:4px}
button{margin-top:16px;background:var(--ab);color:#fff;border:1px solid var(--al);border-radius:18px;padding:9px 22px;font-size:14px;cursor:pointer}</style></head>
<body><div class="b"><h1>This site can't be reached</h1><p><b>${esc(host)}</b> refused to connect or could not be found.</p>
<p><code>${esc(desc)} (${esc(code)})</code></p><button onclick="location.href='${esc(url)}'">Try again</button></div></body></html>`;
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}

function wire(tab) {
  const wc = tabWc(tab);

  wc.on('page-title-updated', (_e, title) => {
    tab.title = title;
    if (!tab.private) recordHistory(wc.getURL(), title);
    if (fx) fx.onTitle(tab);
    sendState();
  });
  wc.on('page-favicon-updated', (_e, favs) => { tab.favicon = favs[0] || ''; sendState(); });
  wc.on('did-start-loading', () => { tab.loading = true; sendState(); });
  wc.on('did-stop-loading', () => { tab.loading = false; sendState(); });
  wc.on('did-start-navigation', (_e, _url, isInPlace, isMainFrame) => {
    if (isMainFrame && !isInPlace) {
      tab.blocked = 0;
      tab.articleLike = false;
      tab.hasLoginForm = false;
      if (fx) fx.onNavigationStart(tab);
      if (pop.visible && pop.mode !== 'save' && activeTab() === tab) hidePopover();
      sendState();
    }
  });
  wc.on('did-navigate', (_e, url) => {
    tab.favicon = '';
    tab.title = '';
    if (!tab.private) recordHistory(url, '');
    if (fx) fx.onNavigated(tab, url);
    applyZoom(tab);
    sendState();
  });
  wc.on('dom-ready', () => applyZoom(tab));
  wc.on('did-navigate-in-page', () => sendState());
  wc.on('did-fail-load', (_e, code, desc, url, isMainFrame) => {
    if (!isMainFrame || code === -3 /* aborted */ || /^data:/.test(url)) return;
    if (code === -20) { // cancelled by our malware check
      const w = takePendingWarn(url);
      if (w) { wc.loadURL(warningUrl(w.kind, url, w.host, w.detail || '')); return; }
    }
    if (code <= -200 && code >= -219) { // certificate problems
      let host = url;
      try { host = new URL(url).hostname; } catch { /* keep */ }
      wc.loadURL(warningUrl('cert', url, host, desc));
      return;
    }
    wc.loadURL(errorPage(url, code, desc));
  });
  wc.on('render-process-gone', (_e, details) => {
    if (details.reason !== 'clean-exit') wc.loadURL(errorPage(wc.getURL() || 'about:blank', details.reason, 'The page crashed'));
  });
  const updateAudio = () => {
    const a = wc.isDestroyed() ? false : wc.isCurrentlyAudible();
    if (a !== tab.audible) { tab.audible = a; sendState(); }
  };
  wc.on('media-started-playing', updateAudio);
  wc.on('media-paused', updateAudio);
  wc.on('zoom-changed', (_e, dir) => zoomTab(tab, dir === 'in' ? 0.5 : -0.5));
  wc.on('enter-html-full-screen', () => { htmlFullscreen = true; win.setFullScreen(true); layout(); });
  wc.on('leave-html-full-screen', () => { htmlFullscreen = false; win.setFullScreen(false); layout(); });
  wc.on('found-in-page', (_e, result) => {
    ui.webContents.send('find-result', { active: result.activeMatchOrdinal, total: result.matches });
  });

  wc.setWindowOpenHandler(({ url }) => {
    if (/^https?:|^about:blank/i.test(url)) createTab(url, { isPrivate: tab.private, openerId: tab.id });
    else if (!isSafeScheme(url)) openExternalSafely(url);
    return { action: 'deny' };
  });
  wc.on('before-input-event', (_e, input) => {
    if (input.type === 'keyDown' && input.key === 'Escape' && findOpen) ui.webContents.send('find-close');
  });
  // Pages may not launch other programs on their own: unknown schemes are blocked or need your OK.
  const guardScheme = (e, url) => {
    if (isSafeScheme(url)) return;
    e.preventDefault();
    openExternalSafely(url);
  };
  wc.on('will-navigate', guardScheme);
  wc.on('will-redirect', guardScheme);

  wc.on('context-menu', (_e, p) => {
    const tpl = [];
    if (p.linkURL) {
      tpl.push(
        { label: 'Open link in new tab', click: () => createTab(p.linkURL, { activate: false, isPrivate: tab.private, afterId: tab.id, openerId: tab.id }) },
        { label: 'Preview link', enabled: !!settings.peekEnabled, click: () => ui?.webContents.send('toast', 'Hold the mouse button down on a link, or Alt+click it, to preview it') },
        { label: 'Open link in private tab', click: () => openPrivateTab(p.linkURL) },
        { label: 'Save link as…', click: () => wc.downloadURL(p.linkURL) },
        { label: 'Copy link address', click: () => clipboard.writeText(p.linkURL) },
        { type: 'separator' },
      );
    }
    if (p.mediaType === 'image') {
      tpl.push(
        { label: 'Open image in new tab', click: () => createTab(p.srcURL, { isPrivate: tab.private }) },
        { label: 'Save image as…', click: () => wc.downloadURL(p.srcURL) },
        { label: 'Copy image', click: () => wc.copyImageAt(p.x, p.y) },
        { label: 'Copy image address', click: () => clipboard.writeText(p.srcURL) },
        { type: 'separator' },
      );
    }
    if ((p.mediaType === 'video' || p.mediaType === 'audio') && p.srcURL) {
      tpl.push({ label: 'Save media as…', click: () => wc.downloadURL(p.srcURL) }, { type: 'separator' });
    }
    if (p.isEditable) {
      for (const s of p.dictionarySuggestions || []) tpl.push({ label: s, click: () => wc.replaceMisspelling(s) });
      if (p.misspelledWord) tpl.push({ type: 'separator' });
      tpl.push({ role: 'undo' }, { role: 'redo' }, { type: 'separator' },
        { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }, { type: 'separator' });
    } else if (p.selectionText) {
      tpl.push(
        { role: 'copy' },
        {
          label: `Search for "${p.selectionText.slice(0, 30)}"`,
          click: () => createTab(searchUrl() + encodeURIComponent(p.selectionText), { isPrivate: tab.private }),
        },
        { type: 'separator' },
      );
    }
    tpl.push(
      { label: 'Back', enabled: wc.navigationHistory.canGoBack(), click: () => wc.navigationHistory.goBack() },
      { label: 'Forward', enabled: wc.navigationHistory.canGoForward(), click: () => wc.navigationHistory.goForward() },
      { label: 'Reload', click: () => wc.reload() },
      { type: 'separator' },
      { label: 'Save page as…', click: () => savePage() },
      { label: 'Print…', click: () => wc.print() },
      { label: 'View page source', click: () => createTab(`view-source:${wc.getURL()}`, { isPrivate: tab.private }) },
      { label: 'Inspect', click: () => wc.inspectElement(p.x, p.y) },
    );
    Menu.buildFromTemplate(tpl).popup({ window: win });
  });
}

// ======================================================================
// Page actions
// ======================================================================
async function savePage() {
  const t = activeTab();
  if (!t) return;
  const wc = tabWc(t);
  const name = (t.title || 'page').replace(/[\\/:*?"<>|]/g, '_').slice(0, 80);
  const { canceled, filePath } = await dialog.showSaveDialog(win, {
    defaultPath: path.join(app.getPath('downloads'), `${name}.html`),
    filters: [{ name: 'Web page, complete', extensions: ['html'] }, { name: 'Web page, HTML only', extensions: ['html'] }],
  });
  if (!canceled && filePath) wc.savePage(filePath, 'HTMLComplete').catch(() => {});
}

async function savePdf() {
  const t = activeTab();
  if (!t) return;
  const name = (t.title || 'page').replace(/[\\/:*?"<>|]/g, '_').slice(0, 80);
  const { canceled, filePath } = await dialog.showSaveDialog(win, {
    defaultPath: path.join(app.getPath('downloads'), `${name}.pdf`),
    filters: [{ name: 'PDF', extensions: ['pdf'] }],
  });
  if (canceled || !filePath) return;
  try {
    fs.writeFileSync(filePath, await tabWc(t).printToPDF({ printBackground: true }));
    ui?.webContents.send('toast', 'Saved as PDF');
  } catch { ui?.webContents.send('toast', 'Could not save PDF'); }
}

async function openFileDialog() {
  const { canceled, filePaths } = await dialog.showOpenDialog(win, { properties: ['openFile'] });
  if (!canceled && filePaths[0]) createTab(pathToFileURL(filePaths[0]).href);
}

async function takeScreenshot() {
  const wc = activeTab() && tabWc(activeTab());
  if (!wc) return;
  const img = await wc.capturePage();
  const dir = path.join(app.getPath('pictures'), 'Tide Screenshots');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `screenshot-${new Date().toISOString().replace(/[:.]/g, '-')}.png`);
  fs.writeFileSync(file, img.toPNG());
  clipboard.writeImage(img);
  ui?.webContents.send('toast', 'Screenshot saved and copied to clipboard');
}

function toggleBookmark() {
  const t = activeTab();
  if (!t || t.private) { if (t?.private) ui?.webContents.send('toast', 'Bookmarks are not saved from private tabs'); return; }
  const url = tabWc(t).getURL();
  if (!/^https?:/i.test(url)) return;
  const i = bookmarks.findIndex((b) => b.url === url);
  if (i >= 0) bookmarks.splice(i, 1);
  else bookmarks.push({ url, title: t.title || url, favicon: t.favicon });
  saveJSON('bookmarks.json', bookmarks);
  sendState();
}

function setBookmarksBar(on) {
  settings.bookmarksBar = !!on;
  persistSettings();
  animateExtra();
  sendState();
}

// ======================================================================
// Sessions: permissions, downloads, privacy filters
// ======================================================================
const AUTO_ALLOW = new Set(['fullscreen', 'clipboard-sanitized-write', 'pointerLock', 'keyboardLock', 'window-management']);

function configureSession(ses, isPrivate) {
  if (configuredSessions.has(ses)) return;
  configuredSessions.add(ses);

  privacy.install(ses, {
    getSettings: () => settings,
    tabForWc: (id) => wcToTab.get(id),
    onBlocked: (tab, host) => { tab.blocked++; if (fx) fx.onBlocked(tab, host); sendState(); },
    siteAllowed: (tab) => !!(fx && fx.siteAllowed(tab)),
    checkDangerous,
  });

  const tempDecisions = new Map(); // private sessions forget everything on exit
  const getDecision = (key) => (isPrivate ? tempDecisions.get(key) : settings.permissions[key]);
  const setDecision = (key, v) => {
    if (isPrivate) tempDecisions.set(key, v);
    else { settings.permissions[key] = v; persistSettings(); }
  };

  ses.setPermissionRequestHandler(async (_wc, permission, callback, details) => {
    if (AUTO_ALLOW.has(permission)) return callback(true);
    let origin = 'this page';
    try { origin = new URL(details.requestingUrl).origin; } catch { /* keep */ }
    if (origin.startsWith('file:') || origin === 'null') return callback(false);
    const key = `${origin}|${permission}`;
    const known = getDecision(key);
    if (known !== undefined) return callback(known);
    const { response } = await dialog.showMessageBox(win, {
      type: 'question', buttons: ['Allow', 'Block'], defaultId: 1, cancelId: 1,
      title: 'Permission request', message: `${origin} wants to use: ${permission}`,
    });
    setDecision(key, response === 0);
    return callback(response === 0);
  });
  ses.setPermissionCheckHandler((_wc, permission, origin) => AUTO_ALLOW.has(permission) || getDecision(`${origin}|${permission}`) === true);

  ses.on('will-download', (_e, item) => {
    const dir = settings.downloadDir && fs.existsSync(settings.downloadDir) ? settings.downloadDir : app.getPath('downloads');
    const parsed = path.parse(item.getFilename() || 'download');
    let target = path.join(dir, parsed.base);
    for (let n = 1; fs.existsSync(target); n++) target = path.join(dir, `${parsed.name} (${n})${parsed.ext}`);
    if (settings.askDownload) item.setSaveDialogOptions({ defaultPath: target });
    else item.setSavePath(target);

    // Tag the file as "downloaded from the internet" (like Chrome and Edge do) so Windows SmartScreen checks it.
    item.once('done', (_ev, state) => { if (state === 'completed') markFromInternet(item.getSavePath(), item.getURL()); });

    if (isPrivate) return; // private downloads aren't listed
    const rec = {
      id: `${Date.now()}${Math.floor(Math.random() * 1e6)}`,
      name: path.basename(target), path: settings.askDownload ? '' : target,
      url: item.getURL(), state: 'progressing', received: 0, total: item.getTotalBytes(), time: Date.now(),
      risky: DANGEROUS_EXT.has(path.extname(target).toLowerCase()),
    };
    downloads.unshift(rec);
    dlItems.set(rec.id, item);
    item.on('updated', () => {
      rec.received = item.getReceivedBytes();
      rec.total = item.getTotalBytes();
      rec.state = item.isPaused() ? 'paused' : 'progressing';
      const sp = item.getSavePath();
      if (sp) { rec.path = sp; rec.name = path.basename(sp); }
    });
    item.once('done', (_ev, state) => {
      const sp = item.getSavePath();
      if (sp) { rec.path = sp; rec.name = path.basename(sp); rec.risky = DANGEROUS_EXT.has(path.extname(sp).toLowerCase()); }
      rec.state = state;
      rec.received = item.getReceivedBytes();
      dlItems.delete(rec.id);
      saveJSON('downloads.json', downloads.slice(0, 200));
      if (state === 'completed' && sp && fx) fx.onDownloadDone(rec, sp);
      if (win) {
        win.flashFrame(true);
        ui?.webContents.send('toast', state === 'completed' ? `Downloaded ${rec.name}` : `Download ${state}: ${rec.name}`);
      }
    });
  });
}

function markFromInternet(file, url) {
  if (!file) return;
  if (IS_MAC) {
    // Quarantine flag: Gatekeeper checks the file the first time it is opened. Format is flags;hex time;app name;.
    try {
      require('child_process').execFile('/usr/bin/xattr', ['-w', 'com.apple.quarantine', `0083;${Math.floor(Date.now() / 1000).toString(16)};Tide;`, file], () => {});
    } catch { /* xattr not available */ }
    return;
  }
  if (process.platform !== 'win32') return;
  try {
    const host = /^https?:/i.test(url) ? `HostUrl=${url.slice(0, 1000)}\r\n` : '';
    fs.writeFileSync(`${file}:Zone.Identifier`, `[ZoneTransfer]\r\nZoneId=3\r\n${host}`);
  } catch { /* not NTFS, or the file moved */ }
}

async function openDownload(rec) {
  if (!rec || !rec.path || !fs.existsSync(rec.path)) return;
  if (rec.risky) {
    const { response } = await dialog.showMessageBox(win, {
      type: 'warning', buttons: ['Cancel', 'Open anyway'], defaultId: 0, cancelId: 0,
      title: 'This file can run code',
      message: `"${rec.name}" is a type of file that can harm your computer.`,
      detail: 'Only open it if you trust the website it came from and expected this download.',
    });
    if (response !== 1) return;
  }
  shell.openPath(rec.path);
}

function applyDns() {
  const servers = DNS_SERVERS[settings.secureDns];
  try {
    app.configureHostResolver(servers ? { secureDnsMode: 'secure', secureDnsServers: servers, enableBuiltInResolver: true } : { secureDnsMode: 'off' });
  } catch { /* not supported on this build */ }
}

function applySpellcheck() {
  for (const ses of [session.defaultSession, session.fromPartition(PRIVATE_PARTITION)]) {
    try {
      ses.setSpellCheckerEnabled(!!settings.spellcheck);
      if (settings.spellLang) ses.setSpellCheckerLanguages([settings.spellLang]);
    } catch { /* language unavailable */ }
  }
}

// ---------- extensions (experimental: Electron implements only part of the Chrome API) ----------
async function loadExtension(p) {
  const ses = session.defaultSession;
  const api = ses.extensions || ses;
  try {
    const ext = await api.loadExtension(p, { allowFileAccess: true });
    extIds.set(p, ext.id);
    return ext;
  } catch (e) {
    console.error('extension failed:', p, e.message);
    return null;
  }
}

// ======================================================================
// Password manager: prompts, form capture and fill
// Security rules:
//   - A page never receives a saved password except through an explicit fill that you start.
//   - Fill only happens on the exact origin (scheme, host, port) the login was saved for, and only over https.
//   - The origin always comes from the browser's own record of the frame URL, never from the page.
//   - Private tabs never offer to save.
// ======================================================================
const POP_W = 360;
const lockPanel = (wc) => {
  wc.on('will-navigate', (e) => e.preventDefault());
  wc.setWindowOpenHandler(() => ({ action: 'deny' }));
};

function createPopView() {
  popView = new WebContentsView({
    webPreferences: { preload: path.join(__dirname, 'popover-preload.js'), contextIsolation: true, sandbox: true },
  });
  popView.setBackgroundColor('#00000000');
  popView.setVisible(false);
  win.contentView.addChildView(popView);
  lockPanel(popView.webContents);
  popView.webContents.loadFile(path.join(__dirname, 'ui', 'popover.html'));
  popView.webContents.on('blur', () => {
    // Save and update prompts wait for a decision. The others close when you click away.
    setTimeout(() => {
      if (pop.visible && pop.mode !== 'save' && popView && !popView.webContents.isFocused()) hidePopover();
    }, 150);
  });
}

function placePopover(h) {
  if (!popView || !win) return;
  const [w] = win.getContentSize();
  const right = Math.max(0, w - POP_W - 6);
  const x = pop.anchorX != null ? Math.max(6, Math.min(right, Math.round(pop.anchorX))) : right;
  popView.setBounds({ x, y: TOP_HEIGHT + Math.round(extraOffset) - 4, width: POP_W, height: Math.max(80, Math.round(h)) });
}

function showPopover(mode, data, { focus = true, anchorX = null } = {}) {
  if (!popView) return;
  pop.anchorX = anchorX;
  pop.mode = mode;
  pop.visible = true;
  hideSuggest();
  popView.setVisible(true);
  win.contentView.addChildView(popView); // moves it above the page views
  placePopover(260);
  popView.webContents.send('pop:show', { mode, data });
  if (focus) popView.webContents.focus();
}

function hidePopover() {
  if (!pop.visible) return;
  pop.visible = false;
  pop.mode = null;
  pop.pending = null;
  if (popView && !popView.webContents.isDestroyed()) {
    popView.webContents.send('pop:hide');
    popView.setVisible(false);
    popView.setBounds({ x: 0, y: 0, width: 0, height: 0 });
  }
  const t = activeTab();
  if (t && !isNewTab(tabWc(t).getURL())) tabWc(t).focus();
}

const isSecureOrigin = (o) => /^https:\/\//.test(o) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(o);
const toast = (msg) => ui?.webContents.send('toast', msg);

function handleCaptured(origin, cred) {
  if (!vault.exists()) {
    if (!settings.pwOffer || dismissedOrigins.has(origin)) return;
    pop.pending = { type: 'create', origin, cred };
    showPopover('create', { origin });
    return;
  }
  if (!vault.isUnlocked()) {
    if (dismissedOrigins.has(origin)) return;
    pop.pending = { type: 'save', origin, cred };
    showPopover('unlock', { reason: 'save', origin });
    return;
  }
  offerSave(origin, cred);
}

function offerSave(origin, cred) {
  if (vault.isNever(origin)) { hidePopover(); return; }
  const ex = vault.findExact(origin, cred.username);
  if (ex && ex.password === cred.password) { vault.markUsed(ex.id); hidePopover(); return; }
  pop.pending = { type: 'save', origin, cred, id: ex ? ex.id : null };
  showPopover('save', { origin, username: cred.username, update: !!ex }, { focus: false });
}

function showFill() {
  const tab = activeTab();
  if (!tab) return;
  const origin = cleanOrigin(tabWc(tab).getURL());
  const secure = isSecureOrigin(origin);
  const items = origin && secure && vault.isUnlocked() ? vault.findForOrigin(origin).map(({ id, username }) => ({ id, username })) : [];
  showPopover('fill', { origin: origin ? origin.replace(/^https?:\/\//, '') : 'this page', items, secure });
}

function passwordButton() {
  if (pop.visible && pop.mode === 'fill') { hidePopover(); return; }
  const t = activeTab();
  if (t && t.private) { toast('Saved logins are not used in private tabs'); return; }
  if (!vault.exists()) { pop.pending = null; showPopover('create', {}); return; }
  if (!vault.isUnlocked()) { pop.pending = { type: 'fill' }; showPopover('unlock', { reason: 'fill' }); return; }
  showFill();
}

function fillLogin(id) {
  const tab = activeTab();
  if (!tab || !vault.isUnlocked()) return;
  const entry = vault.get(id);
  if (!entry) return;
  const origin = cleanOrigin(tabWc(tab).getURL());
  if (origin !== entry.origin || !isSecureOrigin(origin)) { toast('Tide only fills a login on the secure site it was saved for'); return; }
  tabWc(tab).send('pw:fill', { username: entry.username, password: entry.password });
  vault.markUsed(id);
}

function fillGenerated() {
  const tab = activeTab();
  if (!tab) return;
  tabWc(tab).send('pw:fill', { password: generatePassword({ length: 20 }), generated: true });
  toast('Strong password filled in. Tide will offer to save it when you submit.');
}

ipcMain.on('pw:captured', (e, data) => {
  const tab = wcToTab.get(e.sender.id);
  if (!tab || tab.private || !settings.pwPrompts || tab !== activeTab()) return;
  if (!e.senderFrame || e.senderFrame !== e.sender.mainFrame) return;
  const origin = cleanOrigin(e.senderFrame.url);
  if (!origin || !data || typeof data.password !== 'string' || !data.password || data.password.length > 1000) return;
  handleCaptured(origin, { username: String(data.username || '').slice(0, 300), password: data.password });
});

ipcMain.on('pw:hasForm', (e, has) => {
  const tab = wcToTab.get(e.sender.id);
  if (!tab || !e.senderFrame || e.senderFrame !== e.sender.mainFrame) return;
  tab.hasLoginForm = !!has;
  sendState();
});

ipcMain.handle('pop:size', (e, h) => {
  if (popView && e.sender === popView.webContents && pop.visible) placePopover(Number(h) || 260);
});

ipcMain.handle('pop:action', async (e, a) => {
  if (!popView || e.sender !== popView.webContents || !a) return undefined;
  const p = pop.pending;
  switch (a.type) {
    case 'dismiss':
      if (p && p.origin && (pop.mode === 'unlock' || pop.mode === 'create')) dismissedOrigins.add(p.origin);
      hidePopover();
      return undefined;
    case 'never-offer':
      settings.pwOffer = false;
      persistSettings();
      hidePopover();
      return undefined;
    case 'create': {
      const r = await vault.create(String(a.password || ''));
      if (!r.ok) return r;
      if (p && p.type === 'create') {
        try { vault.add({ origin: p.origin, username: p.cred.username, password: p.cred.password }); toast('Password saved'); } catch { /* ignore */ }
        hidePopover();
      } else { hidePopover(); createTab(INTERNAL.passwords); }
      return { ok: true };
    }
    case 'unlock': {
      const r = await vault.unlock(String(a.password || ''));
      if (!r.ok) return r;
      if (p && p.type === 'save') offerSave(p.origin, p.cred);
      else if (p && p.type === 'fill') showFill();
      else hidePopover();
      return { ok: true };
    }
    case 'save':
      if (p && p.type === 'save' && vault.isUnlocked()) {
        try {
          if (p.id) vault.update(p.id, { password: p.cred.password });
          else vault.add({ origin: p.origin, username: p.cred.username, password: p.cred.password });
          toast('Password saved');
        } catch { toast('Could not save that password'); }
      }
      hidePopover();
      return undefined;
    case 'never':
      if (p && p.origin && vault.isUnlocked()) vault.addNever(p.origin);
      hidePopover();
      return undefined;
    case 'fill': hidePopover(); fillLogin(String(a.id)); return undefined;
    case 'generate': hidePopover(); fillGenerated(); return undefined;
    case 'manage': hidePopover(); createTab(INTERNAL.passwords); return undefined;
    case 'site-block': case 'site-perm': case 'site-forget': return fx ? fx.sitePopAction(a) : undefined;
    default: return undefined;
  }
});

ipcMain.handle('pw:button', guardUi(() => passwordButton()));

// Sidebar sun/moon button: flip between dark and light (from "match Windows" it flips whatever is showing).
ipcMain.handle('theme:toggle', guardUi((origin) => {
  if (splash.running) return; // ignore clicks while a transition is playing
  settings.theme = nativeTheme.shouldUseDarkColors ? 'light' : 'dark';
  persistSettings();
  const o = origin && Number.isFinite(origin.x) && Number.isFinite(origin.y) ? { x: origin.x, y: origin.y } : null;
  applyTheme(true, o);
}));

// ---------- vault API for the passwords page ----------
handleInternal('pwStatus', () => ({
  exists: vault.exists(),
  unlocked: vault.isUnlocked(),
  wait: Math.max(0, Math.ceil((vault.lockedUntil - Date.now()) / 1000)),
}));
handleInternal('pwCreate', (_e, pw) => vault.create(String(pw || '')));
handleInternal('pwUnlock', (_e, pw) => vault.unlock(String(pw || '')));
handleInternal('pwLock', () => { vault.lock(); });
handleInternal('pwList', () => (vault.isUnlocked() ? vault.list() : null));
handleInternal('pwReveal', (_e, id) => {
  if (!vault.isUnlocked()) return null;
  const e = vault.get(String(id));
  return e ? { password: e.password, notes: e.notes } : null;
});
handleInternal('pwSave', (_e, entry) => {
  if (!vault.isUnlocked() || !entry) return { ok: false, error: 'Unlock first.' };
  try {
    if (entry.id) {
      vault.update(String(entry.id), { origin: entry.origin, username: entry.username, password: entry.password, notes: entry.notes });
      return { ok: true, id: entry.id };
    }
    return { ok: true, id: vault.add(entry) };
  } catch (err) { return { ok: false, error: err.message }; }
});
handleInternal('pwRemove', (_e, id) => { if (vault.isUnlocked()) vault.remove(String(id)); });
handleInternal('pwCopy', (_e, id, field) => {
  if (!vault.isUnlocked()) return false;
  const e = vault.get(String(id));
  if (!e) return false;
  const value = field === 'username' ? e.username : e.password;
  clipboard.writeText(value);
  if (field !== 'username') setTimeout(() => { try { if (clipboard.readText() === value) clipboard.clear(); } catch { /* ignore */ } }, 30000);
  return true;
});
handleInternal('pwGenerate', (_e, opts) => generatePassword(opts || {}));
handleInternal('pwHealth', () => (vault.isUnlocked() ? vault.health() : null));
handleInternal('pwBreachCheck', async () => {
  if (!vault.isUnlocked()) return { error: 'Unlock first.' };
  const queries = vault.breachQueries();
  const hits = [];
  try {
    for (const [prefix, suffixes] of queries) {
      const res = await net.fetch(`https://api.pwnedpasswords.com/range/${prefix}`, { headers: { 'Add-Padding': 'true' }, credentials: 'omit' });
      if (!res.ok) throw new Error('The breach service is not available right now.');
      for (const line of (await res.text()).split(/\r?\n/)) {
        const [suffix, count] = line.trim().split(':');
        if (suffix && suffixes.has(suffix) && Number(count) > 0) suffixes.get(suffix).forEach((id) => hits.push({ id, count: Number(count) }));
      }
    }
  } catch (err) { return { error: err.message || 'Could not check right now.' }; }
  return { hits, checked: queries.size };
});
handleInternal('pwImport', async () => {
  if (!vault.isUnlocked()) return { error: 'Unlock first.' };
  const { canceled, filePaths } = await dialog.showOpenDialog(win, { properties: ['openFile'], filters: [{ name: 'Passwords CSV', extensions: ['csv'] }] });
  if (canceled || !filePaths[0]) return null;
  try { return vault.importCsv(fs.readFileSync(filePaths[0], 'utf8')); } catch (err) { return { error: err.message }; }
});
handleInternal('pwExport', async (_e, master) => {
  if (!vault.isUnlocked()) return { ok: false, error: 'Unlock first.' };
  if (!(await vault.verify(String(master || '')))) return { ok: false, error: 'Wrong master password.' };
  const { canceled, filePath } = await dialog.showSaveDialog(win, { defaultPath: 'tide-passwords.csv', filters: [{ name: 'CSV', extensions: ['csv'] }] });
  if (canceled || !filePath) return { ok: false, error: '' };
  fs.writeFileSync(filePath, vault.exportCsv());
  return { ok: true };
});
handleInternal('pwChangeMaster', (_e, oldPw, newPw) => vault.changeMaster(String(oldPw || ''), String(newPw || '')));
handleInternal('pwReset', () => { vault.reset(); hidePopover(); });
handleInternal('pwClearNever', () => { if (vault.isUnlocked()) vault.clearNever(); });
handleInternal('allowSite', (_e, kind, urlStr) => {
  try {
    const u = new URL(String(urlStr));
    if (!/^https?:$/.test(u.protocol)) return;
    if (kind === 'malware') allowSites.add(u.hostname);
    else if (kind === 'cert') certAllow.add(u.host);
    else if (kind === 'focus' && fx) fx.allowFocus(u.hostname);
  } catch { /* ignore */ }
});
handleInternal('securityInfo', () => ({
  malwareHosts: safeBrowsing.count,
  malwareUpdated: safeBrowsing.updated,
  chromium: process.versions.chrome,
  electron: process.versions.electron,
  vaultExists: vault.exists(),
}));

// ---------- HTTP authentication prompt ----------
const logins = new Map(); // webContents id -> { finish, win }
function promptLogin(authInfo, callback) {
  const w = new BrowserWindow({
    parent: win || undefined, modal: !!win, width: 420, height: 290, resizable: false, minimizable: false, maximizable: false,
    title: 'Sign in', backgroundColor: themeColors().surface, autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'login-preload.js'), contextIsolation: true, sandbox: true },
  });
  w.setMenuBarVisibility(false);
  let done = false;
  const finish = (u, p) => { if (done) return; done = true; if (u === undefined) callback(); else callback(u, p); };
  logins.set(w.webContents.id, { finish, win: w });
  w.on('closed', () => { logins.delete(w.webContents.id); finish(); });
  w.loadFile(path.join(__dirname, 'ui', 'login.html'), {
    query: { host: `${authInfo.host}${authInfo.realm ? `, ${authInfo.realm}` : ''}`, proxy: authInfo.isProxy ? '1' : '' },
  });
}
ipcMain.handle('login:submit', (e, u, p) => { const c = logins.get(e.sender.id); if (c) { c.finish(String(u), String(p)); c.win.close(); } });
ipcMain.handle('login:cancel', (e) => { const c = logins.get(e.sender.id); if (c) { c.finish(); c.win.close(); } });
app.on('login', (event, _wc, _details, authInfo, callback) => { event.preventDefault(); promptLogin(authInfo, callback); });

// ======================================================================
// Window
// ======================================================================
function createWindow() {
  const ws = settings.window || {};
  const pos = Number.isFinite(ws.x) && Number.isFinite(ws.y) ? { x: ws.x, y: ws.y } : {};
  win = new BrowserWindow({
    width: ws.width || 1280,
    height: ws.height || 800,
    ...pos,
    minWidth: 480,
    minHeight: 480, // the sidebar needs this much room for all its buttons
    backgroundColor: themeColors().bg,
    title: 'Tide Browser',
    // Windows draws its own caption buttons over the tab strip. macOS keeps its traffic lights, set inside the strip.
    ...(IS_MAC
      ? { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 16, y: 15 } }
      : { titleBarStyle: 'hidden', titleBarOverlay: { color: themeColors().bg, symbolColor: themeColors().fg, height: 44 } }),
    show: false,
  });
  if (ws.maximized) win.maximize();

  ui = new WebContentsView({
    webPreferences: { preload: path.join(__dirname, 'ui-preload.js'), contextIsolation: true, sandbox: true },
  });
  ui.setBackgroundColor(themeColors().bg);
  win.contentView.addChildView(ui);
  lockPanel(ui.webContents);
  ui.webContents.loadFile(path.join(__dirname, 'ui', 'index.html'));
  createSuggestView();
  createPopView();
  createSplashView();

  win.on('resize', () => { hideSuggest(); if (fx) { fx.closePeek(); fx.closeCmd(); } if (pop.visible) placePopover(260); layout(); });
  win.on('maximize', layout);
  win.on('unmaximize', layout);
  win.on('enter-full-screen', layout);
  win.on('leave-full-screen', layout);
  win.on('close', () => {
    try { if (fx) fx.shutdown(); } catch { /* tabs already gone */ }
    try {
      settings.window = { ...win.getNormalBounds(), maximized: win.isMaximized() };
      persistSettings();
    } catch { /* ignore */ }
    flushSaves();
  });
  win.on('closed', () => { win = null; ui = null; suggestView = null; popView = null; splashView = null; tabs.clear(); wcToTab.clear(); order = []; });

  ui.webContents.once('did-finish-load', () => {
    if (settings.bookmarksBar) { extraOffset = BAR_H; }
    layout();
    try { win.setOpacity(0); } catch { /* unsupported */ }
    win.show();
    fadeWindowIn();
    const openAt = pendingOpenUrl;
    pendingOpenUrl = null;
    openStartupTabs(openAt || process.argv.slice(app.isPackaged ? 1 : 2).find((a) => /^https?:\/\//i.test(a)));
  });
}

function openStartupTabs(argvUrl) {
  const prev = loadJSON('session.json', { tabs: [], active: -1 });
  let list;
  let activeIdx;
  if (settings.startup === 'continue' && prev.tabs.length) {
    list = prev.tabs;
    activeIdx = prev.active;
  } else {
    list = prev.tabs.filter((t) => t.pinned);
    list.push({ url: settings.startup === 'custom' && settings.startupUrl ? settings.startupUrl : NEWTAB_URL });
    activeIdx = list.length - 1;
  }
  if (argvUrl) { list.push({ url: argvUrl }); activeIdx = list.length - 1; }
  const ids = list.map((t) => createTab(t.url, { activate: false, pinned: !!t.pinned }));
  selectTab(ids[clamp(activeIdx, 0, ids.length - 1)]);
  sessionEnabled = true;
  saveSession();
}

// ======================================================================
// IPC: browser UI
// ======================================================================
ipcMain.handle('tab:new', guardUi((url) => createTab(url || NEWTAB_URL)));
ipcMain.handle('tab:close', guardUi((id) => closeTab(id)));
ipcMain.handle('tab:select', guardUi((id) => selectTab(id)));
ipcMain.handle('tab:mute', guardUi((id) => toggleMute(id)));
ipcMain.handle('tab:move', guardUi((id, toIndex) => {
  const t = tabs.get(id);
  const from = order.indexOf(id);
  if (!t || from < 0) return;
  order.splice(from, 1);
  const pc = pinnedCount();
  const idx = t.pinned ? clamp(toIndex, 0, pc) : clamp(toIndex, pc, order.length);
  order.splice(idx, 0, id);
  sendState();
}));
ipcMain.handle('tab:contextmenu', guardUi((id) => {
  const t = tabs.get(id);
  if (!t) return;
  const wc = tabWc(t);
  const idx = order.indexOf(id);
  Menu.buildFromTemplate([
    { label: 'New tab', click: () => createTab(NEWTAB_URL, { afterId: id }) },
    { type: 'separator' },
    { label: 'Reload', click: () => wc.reload() },
    { label: 'Duplicate', click: () => createTab(wc.getURL(), { afterId: id, isPrivate: t.private }) },
    { label: t.pinned ? 'Unpin tab' : 'Pin tab', click: () => togglePin(id) },
    { label: t.muted ? 'Unmute site' : 'Mute site', enabled: t.audible || t.muted, click: () => toggleMute(id) },
    { type: 'separator' },
    { label: 'Close tab', click: () => closeTab(id) },
    { label: 'Close tabs to the right', enabled: idx < order.length - 1, click: () => order.slice(idx + 1).filter((x) => !tabs.get(x).pinned).forEach(closeTab) },
    { label: 'Close other tabs', click: () => order.filter((x) => x !== id && !tabs.get(x).pinned).forEach(closeTab) },
    { type: 'separator' },
    { label: 'Reopen closed tab', enabled: closedStack.length > 0, click: reopenClosed },
    ...(fx ? fx.tabMenuItems(t) : []),
  ]).popup({ window: win });
}));

ipcMain.handle('nav:go', guardUi((raw) => {
  const t = activeTab();
  if (!t) return;
  tabWc(t).loadURL(normalizeInput(raw));
  tabWc(t).focus();
}));
ipcMain.handle('nav:back', guardUi(() => { const t = activeTab(); if (t && tabWc(t).navigationHistory.canGoBack()) tabWc(t).navigationHistory.goBack(); }));
ipcMain.handle('nav:forward', guardUi(() => { const t = activeTab(); if (t && tabWc(t).navigationHistory.canGoForward()) tabWc(t).navigationHistory.goForward(); }));
ipcMain.handle('nav:reload', guardUi(() => activeTab() && tabWc(activeTab()).reload()));
ipcMain.handle('nav:stop', guardUi(() => activeTab() && tabWc(activeTab()).stop()));
ipcMain.handle('nav:home', guardUi(() => activeTab() && tabWc(activeTab()).loadURL(activeTab().private ? `${NEWTAB_URL}#private` : NEWTAB_URL)));
ipcMain.handle('nav:history', guardUi(() => createTab(HISTORY_URL)));
ipcMain.handle('nav:internal', guardUi((name) => {
  const url = INTERNAL[name];
  if (!url) return;
  const t = activeTab();
  // Reuse the current tab if it is a blank new tab, otherwise open a new one.
  if (t && isNewTab(tabWc(t).getURL()) && !t.private) tabWc(t).loadURL(url);
  else createTab(url);
}));
ipcMain.handle('nav:ai', guardUi(() => createTab(AI_URL)));
ipcMain.handle('page:screenshot', guardUi(() => takeScreenshot()));
ipcMain.handle('zoom:reset', guardUi(() => zoom(0)));
ipcMain.handle('block:toggle', guardUi(() => {
  settings.blockAds = !settings.blockAds;
  persistSettings();
  ui?.webContents.send('toast', settings.blockAds ? 'Ad and tracker blocking on' : 'Ad and tracker blocking off');
  const t = activeTab();
  if (t) tabWc(t).reload();
  sendState();
}));
ipcMain.handle('bookmark:toggle', guardUi(() => toggleBookmark()));
ipcMain.handle('bookmark:menu', guardUi((url) => {
  const b = bookmarks.find((x) => x.url === url);
  if (!b) return;
  Menu.buildFromTemplate([
    { label: 'Open', click: () => { const t = activeTab(); if (t) tabWc(t).loadURL(url); } },
    { label: 'Open in new tab', click: () => createTab(url) },
    { label: 'Open in private tab', click: () => openPrivateTab(url) },
    { type: 'separator' },
    { label: 'Copy link address', click: () => clipboard.writeText(url) },
    { label: 'Remove bookmark', click: () => { bookmarks = bookmarks.filter((x) => x.url !== url); saveJSON('bookmarks.json', bookmarks); sendState(); } },
  ]).popup({ window: win });
}));
ipcMain.handle('find:start', guardUi((text, forward = true, findNext = false) => {
  const t = activeTab();
  if (!t) return;
  if (!text) { tabWc(t).stopFindInPage('clearSelection'); return; }
  tabWc(t).findInPage(text, { forward, findNext });
}));
ipcMain.handle('find:stop', guardUi(() => {
  const t = activeTab();
  if (!t) return;
  tabWc(t).stopFindInPage('clearSelection');
  tabWc(t).focus();
}));
ipcMain.handle('find:visible', guardUi((v) => { findOpen = !!v; animateExtra(); }));
ipcMain.handle('ui:ready', guardUi(() => { sendState(); }));

ipcMain.handle('menu:main', guardUi((x, y) => {
  const wc = () => activeTab() && tabWc(activeTab());
  Menu.buildFromTemplate([
    { label: 'New tab', accelerator: 'CommandOrControl+T', click: () => createTab(NEWTAB_URL) },
    { label: 'New private tab', accelerator: 'CommandOrControl+Shift+N', click: () => openPrivateTab() },
    { label: 'Reopen closed tab', accelerator: 'CommandOrControl+Shift+T', enabled: closedStack.length > 0, click: reopenClosed },
    { type: 'separator' },
    ...(updater.status().status === 'ready' ? [{ label: `Restart to update to Tide ${updater.status().version}`, click: () => updater.install() }, { type: 'separator' }] : []),
    ...(fx ? fx.kebabItems() : []),
    { type: 'separator' },
    { label: 'Bookmarks', click: () => createTab(INTERNAL.bookmarks) },
    { label: 'History', accelerator: 'CommandOrControl+H', click: () => createTab(INTERNAL.history) },
    { label: 'Downloads', click: () => createTab(INTERNAL.downloads) },
    { label: 'Show bookmarks bar', type: 'checkbox', checked: settings.bookmarksBar, accelerator: 'CommandOrControl+Shift+B', click: (i) => setBookmarksBar(i.checked) },
    { label: 'Clear browsing data…', accelerator: 'CommandOrControl+Shift+Delete', click: () => createTab(`${INTERNAL.settings}#privacy`) },
    { label: 'Passwords', click: () => createTab(INTERNAL.passwords) },
    { label: 'Import data from another browser…', click: () => createTab(`${INTERNAL.settings}#import`) },
    { type: 'separator' },
    { label: 'Zoom in', accelerator: 'CommandOrControl+Plus', click: () => zoom(0.5) },
    { label: 'Zoom out', accelerator: 'CommandOrControl+-', click: () => zoom(-0.5) },
    { label: 'Reset zoom', accelerator: 'CommandOrControl+0', click: () => zoom(0) },
    { type: 'separator' },
    { label: 'Save page as…', accelerator: 'CommandOrControl+S', click: savePage },
    { label: 'Save as PDF…', click: savePdf },
    { label: 'Print…', accelerator: 'CommandOrControl+P', click: () => wc()?.print() },
    { label: 'Find in page', accelerator: 'CommandOrControl+F', click: () => { ui.webContents.focus(); ui.webContents.send('find-open'); } },
    { label: 'Developer tools', accelerator: 'F12', click: () => wc()?.toggleDevTools() },
    { type: 'separator' },
    { label: 'Settings', accelerator: 'CommandOrControl+,', click: () => createTab(INTERNAL.settings) },
    { label: 'Quit Tide', click: () => app.quit() },
  ]).popup({ window: win, x: Math.round(x), y: Math.round(y) });
}));

// Address bar suggestions
ipcMain.handle('omni:input', guardUi(async (text, rect) => {
  const value = String(text || '');
  if (!value.trim() || !rect) { hideSuggest(); return; }
  sg.rect = { x: +rect.x || 0, y: +rect.y || 0, width: +rect.width || 0, height: +rect.height || 0 };
  const seq = ++sg.seq;
  const items = [typedItem(value), ...localSuggestions(value)];
  sg.items = items.slice(0, 8);
  sg.sel = 0;
  showSuggest();

  const t = activeTab();
  if (settings.searchSuggestions && value.trim().length >= 2 && !(t && t.private)) {
    const remote = await remoteSuggestions(value.trim());
    if (seq !== sg.seq || !sg.visible) return; // typed more, or the list was closed
    const have = new Set(items.map((i) => i.fill.toLowerCase()));
    for (const r of remote) {
      if (items.length >= 8) break;
      if (have.has(r.toLowerCase())) continue;
      items.push({ kind: 'search', title: r, sub: '', target: searchUrl() + encodeURIComponent(r), fill: r });
    }
    sg.items = items;
    pushSuggest();
  }
}));
ipcMain.handle('omni:move', guardUi((dir) => {
  if (!sg.visible || !sg.items.length) return null;
  sg.sel = (sg.sel + (dir < 0 ? -1 : 1) + sg.items.length) % sg.items.length;
  pushSuggest();
  return sg.items[sg.sel].fill;
}));
ipcMain.handle('omni:enter', guardUi(() => {
  if (sg.visible && sg.items[sg.sel]) { pickSuggest(sg.sel); return true; }
  hideSuggest();
  return false;
}));
ipcMain.handle('omni:hide', guardUi(() => hideSuggest()));
ipcMain.handle('suggest:pick', (e, i) => {
  if (!suggestView || e.sender !== suggestView.webContents) return;
  pickSuggest(Number(i));
});

// ======================================================================
// IPC: internal pages (new tab, history, bookmarks, downloads, settings)
// ======================================================================
const BOOL = (v) => typeof v === 'boolean';
const SETTING_RULES = {
  searchEngine: (v) => typeof v === 'string' && v in ENGINES,
  searchSuggestions: BOOL,
  theme: (v) => ['dark', 'light', 'system'].includes(v),
  startup: (v) => ['newtab', 'continue', 'custom'].includes(v),
  startupUrl: (v) => typeof v === 'string' && v.length < 500,
  bookmarksBar: BOOL,
  reduceMotion: BOOL,
  blockAds: BOOL,
  httpsOnly: BOOL,
  sendGpc: BOOL,
  blockThirdPartyCookies: BOOL,
  askDownload: BOOL,
  spellcheck: BOOL,
  spellLang: (v) => typeof v === 'string' && v.length < 20,
  hardwareAccel: BOOL,
  warnDangerous: BOOL,
  stripTracking: BOOL,
  clearOnExit: BOOL,
  secureDns: (v) => ['off', 'cloudflare', 'google', 'quad9'].includes(v),
  pwPrompts: BOOL,
  pwOffer: BOOL,
  pwAutoLockMin: (v) => [0, 1, 5, 15, 30, 60].includes(v),
  recallEnabled: BOOL,
  recallExclude: (v) => typeof v === 'string' && v.length < 2000,
  orbitMinutes: (v) => [0, 60, 240, 480, 1440, 4320].includes(v),
  peekEnabled: BOOL,
  snapshotsAuto: BOOL,
};

handleInternal('introSeen', () => {
  // Returns whether the new-tab intro already played this session, and marks it played.
  const was = introPlayed;
  introPlayed = true;
  return { seen: was, reduce: !!settings.reduceMotion };
});
handleInternal('getSettings', () => ({
  ...Object.fromEntries(Object.keys(SETTING_RULES).map((k) => [k, settings[k]])),
  downloadDir: settings.downloadDir,
  meta: {
    engines: ENGINE_NAMES,
    version: app.getVersion(),
    versions: { electron: process.versions.electron, chromium: process.versions.chrome, node: process.versions.node, v8: process.versions.v8 },
    userData: USER_DATA,
    defaultDownloads: app.getPath('downloads'),
    spellLangs: session.defaultSession.availableSpellCheckerLanguages || [],
    platform: process.platform,
  },
}));
handleInternal('setSettings', (_e, patch) => {
  if (!patch || typeof patch !== 'object') return;
  const changed = [];
  for (const [k, v] of Object.entries(patch)) {
    if (SETTING_RULES[k] && SETTING_RULES[k](v) && settings[k] !== v) { settings[k] = v; changed.push(k); }
  }
  if (Array.isArray(patch.shortcuts)) {
    settings.shortcuts = patch.shortcuts
      .filter((s) => s && /^https?:\/\//i.test(s.url)).slice(0, 12)
      .map((s) => ({ url: String(s.url), title: String(s.title || '').slice(0, 40) }));
  }
  persistSettings();
  if (changed.includes('spellcheck') || changed.includes('spellLang')) applySpellcheck();
  if (changed.includes('bookmarksBar')) animateExtra();
  if (changed.includes('theme')) applyTheme(true);
  if (changed.includes('secureDns')) applyDns();
  if (changed.includes('pwAutoLockMin')) vault.setTimeoutMinutes(settings.pwAutoLockMin);
  sendState();
});
handleInternal('getShortcuts', () => settings.shortcuts || null);
handleInternal('navigate', (e, raw) => { e.sender.loadURL(normalizeInput(raw)); });
handleInternal('relaunch', () => { flushSaves(); app.relaunch(); app.exit(0); });
handleInternal('openDefaultApps', () => {
  if (IS_MAC) {
    // macOS asks the person to confirm in its own dialog. The settings pane is the fallback (macOS 13 and later).
    try { app.setAsDefaultProtocolClient('http'); app.setAsDefaultProtocolClient('https'); } catch { /* ignore */ }
    return shell.openExternal('x-apple.systempreferences:com.apple.Desktop-Settings.extension');
  }
  return shell.openExternal('ms-settings:defaultapps');
});
handleInternal('chooseDownloadDir', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'] });
  if (canceled || !filePaths[0]) return settings.downloadDir;
  settings.downloadDir = filePaths[0];
  persistSettings();
  return settings.downloadDir;
});
handleInternal('resetDownloadDir', () => { settings.downloadDir = ''; persistSettings(); return ''; });

// history
handleInternal('history', () => history.slice(0, 1000));
handleInternal('clearHistory', () => { history = []; saveJSON('history.json', history); });
handleInternal('removeHistory', (_e, url, time) => {
  history = history.filter((h) => !(h.url === url && h.time === time));
  saveJSON('history.json', history);
});

// bookmarks
handleInternal('bookmarks', () => bookmarks);
handleInternal('removeBookmark', (_e, url) => {
  bookmarks = bookmarks.filter((b) => b.url !== url);
  saveJSON('bookmarks.json', bookmarks);
  sendState();
});
handleInternal('renameBookmark', (_e, url, title) => {
  const b = bookmarks.find((x) => x.url === url);
  if (b && typeof title === 'string' && title.trim()) { b.title = title.trim().slice(0, 200); saveJSON('bookmarks.json', bookmarks); sendState(); }
  return bookmarks;
});
handleInternal('exportBookmarks', async () => {
  const { canceled, filePath } = await dialog.showSaveDialog(win, { defaultPath: 'tide-bookmarks.html', filters: [{ name: 'Bookmarks', extensions: ['html'] }] });
  if (canceled || !filePath) return false;
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const body = bookmarks.map((b) => `    <DT><A HREF="${esc(b.url)}">${esc(b.title)}</A>`).join('\n');
  fs.writeFileSync(filePath, `<!DOCTYPE NETSCAPE-Bookmark-file-1>\n<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">\n<TITLE>Bookmarks</TITLE>\n<H1>Bookmarks</H1>\n<DL><p>\n${body}\n</DL><p>\n`);
  return true;
});
handleInternal('importBookmarks', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(win, { properties: ['openFile'], filters: [{ name: 'Bookmarks', extensions: ['html', 'htm'] }] });
  if (canceled || !filePaths[0]) return bookmarks;
  const html = fs.readFileSync(filePaths[0], 'utf8');
  const unesc = (s) => s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
  const re = /<A\s+[^>]*?HREF="([^"]+)"[^>]*>([\s\S]*?)<\/A>/gi;
  let m;
  while ((m = re.exec(html))) {
    const url = unesc(m[1]);
    if (/^https?:\/\//i.test(url) && !bookmarks.some((b) => b.url === url)) bookmarks.push({ url, title: unesc(m[2]).replace(/<[^>]+>/g, '').trim() || url, favicon: '' });
  }
  saveJSON('bookmarks.json', bookmarks);
  sendState();
  return bookmarks;
});

// downloads
handleInternal('downloads', () => downloads.slice(0, 200));
handleInternal('clearDownloads', () => {
  downloads = downloads.filter((d) => d.state === 'progressing' || d.state === 'paused');
  saveJSON('downloads.json', downloads);
});
handleInternal('downloadAction', (_e, id, action) => {
  const item = dlItems.get(id);
  const rec = downloads.find((d) => d.id === id);
  if (action === 'pause' && item) item.pause();
  else if (action === 'resume' && item && item.canResume()) item.resume();
  else if (action === 'cancel' && item) item.cancel();
  else if (action === 'remove' && rec && !item) { downloads = downloads.filter((d) => d.id !== id); saveJSON('downloads.json', downloads); }
  else if (action === 'open' && rec) openDownload(rec);
  else if (action === 'show' && rec && rec.path && fs.existsSync(rec.path)) shell.showItemInFolder(rec.path);
});

// import from other browsers
function finishImport(res) {
  const added = { history: 0, bookmarks: 0, downloads: 0 };
  if (res.history.length) {
    const have = new Set(history.map((h) => `${h.url}|${h.time}`));
    for (const h of res.history) {
      const k = `${h.url}|${h.time}`;
      if (have.has(k)) continue;
      have.add(k);
      history.push({ url: h.url, title: h.title, time: h.time });
      added.history++;
    }
    history.sort((a, b) => b.time - a.time);
    if (history.length > 5000) history.length = 5000;
    saveJSON('history.json', history);
  }
  if (res.bookmarks.length) {
    for (const b of res.bookmarks) {
      if (bookmarks.some((x) => x.url === b.url)) continue;
      bookmarks.push(b);
      added.bookmarks++;
    }
    saveJSON('bookmarks.json', bookmarks);
  }
  if (res.downloads.length) {
    for (const d of res.downloads) {
      if (downloads.some((x) => x.path === d.path)) continue;
      downloads.push(d);
      added.downloads++;
    }
    downloads.sort((a, b) => b.time - a.time);
    if (downloads.length > 200) downloads.length = 200;
    saveJSON('downloads.json', downloads);
  }
  sendState();
  return { ...added, errors: res.errors };
}
handleInternal('detectBrowsers', () => importer.detectBrowsers().map((b) => ({
  id: b.id,
  name: b.name,
  profiles: b.profiles.map(({ id, name, history: h, bookmarks: bm, downloads: dl }) => ({ id, name, history: h, bookmarks: bm, downloads: dl })),
})));
handleInternal('importData', (_e, opts) => {
  // The page sends only ids; paths are looked up here so a page can never ask for an arbitrary file.
  const b = importer.detectBrowsers().find((x) => x.id === (opts && opts.browser));
  const profile = b && b.profiles.find((p) => p.id === opts.profile);
  if (!profile) return { history: 0, bookmarks: 0, downloads: 0, errors: ['That browser profile was not found.'] };
  return finishImport(importer.importFromProfile(b.id, profile, { history: !!opts.history, bookmarks: !!opts.bookmarks, downloads: !!opts.downloads }));
});
handleInternal('importFiles', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(win, {
    properties: ['openFile', 'multiSelections'],
    title: 'Choose a bookmarks .html export or a Safari History.db file',
    filters: [{ name: 'Bookmarks or Safari history', extensions: ['html', 'htm', 'db', 'sqlite'] }],
  });
  if (canceled || !filePaths.length) return null;
  return finishImport(importer.importFromFiles(filePaths));
});

// privacy: clear browsing data
handleInternal('clearData', async (_e, opts) => {
  const spans = { hour: 36e5, day: 864e5, week: 6048e5, month: 2592e6, all: Infinity };
  const span = spans[opts && opts.range] ?? Infinity;
  const cutoff = span === Infinity ? Infinity : Date.now() - span; // remove entries newer than this
  const inRange = (t) => span === Infinity || t >= cutoff;
  if (opts.history) { history = history.filter((h) => !inRange(h.time)); saveJSON('history.json', history); }
  if (opts.downloads) {
    downloads = downloads.filter((d) => d.state === 'progressing' || d.state === 'paused' || !inRange(d.time));
    saveJSON('downloads.json', downloads);
  }
  const ses = session.defaultSession;
  if (opts.cookies) await ses.clearStorageData(); // cookies + site storage (all time; Chromium can't filter by age)
  if (opts.cache) { await ses.clearCache(); try { await ses.clearCodeCaches({}); } catch { /* ignore */ } }
  sendState();
  return true;
});

// site permissions
handleInternal('getPermissions', () => Object.entries(settings.permissions).map(([key, allow]) => {
  const i = key.lastIndexOf('|');
  return { key, origin: key.slice(0, i), permission: key.slice(i + 1), allow };
}));
handleInternal('removePermission', (_e, key) => { delete settings.permissions[key]; persistSettings(); });
handleInternal('resetPermissions', () => { settings.permissions = {}; persistSettings(); });
handleInternal('getZoomSites', () => Object.entries(settings.zoom).map(([host, level]) => ({ host, percent: Math.round(100 * 1.2 ** level) })));
handleInternal('resetZoomSites', () => { settings.zoom = {}; persistSettings(); });

// extensions
handleInternal('getExtensions', () => settings.extensions);
handleInternal('addExtension', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(win, {
    properties: ['openDirectory'], title: 'Select an unpacked extension folder (contains manifest.json)',
  });
  if (canceled || !filePaths[0]) return { list: settings.extensions };
  const p = filePaths[0];
  if (settings.extensions.some((x) => x.path === p)) return { list: settings.extensions };
  const ext = await loadExtension(p);
  if (!ext) return { list: settings.extensions, error: 'That folder could not be loaded as an extension.' };
  settings.extensions.push({ path: p, name: ext.name, version: ext.version });
  persistSettings();
  return { list: settings.extensions };
});
handleInternal('removeExtension', async (_e, p) => {
  const id = extIds.get(p);
  if (id) {
    const ses = session.defaultSession;
    try { await (ses.extensions || ses).removeExtension(id); } catch { /* ignore */ }
    extIds.delete(p);
  }
  settings.extensions = settings.extensions.filter((x) => x.path !== p);
  persistSettings();
  return settings.extensions;
});

// ======================================================================
// Menu / shortcuts
// ======================================================================
function buildMenu() {
  const item = (label, accelerator, click) => ({ label, accelerator, click });
  const focusOmni = () => { ui.webContents.focus(); ui.webContents.send('focus-omnibox'); };
  const wcOf = () => activeTab() && tabWc(activeTab());
  const tabSelectors = [1, 2, 3, 4, 5, 6, 7, 8].map((n) =>
    item(`Select tab ${n}`, `CommandOrControl+${n}`, () => order[n - 1] && selectTab(order[n - 1])));
  tabSelectors.push(item('Select last tab', 'CommandOrControl+9', () => selectTab(order[order.length - 1])));

  // macOS conventions: Cmd+[ and Cmd+] for back and forward, Cmd+Y for history (Cmd+H hides the app), Ctrl+Tab for
  // the next tab (Cmd+Tab belongs to the system), Option+Cmd+I for developer tools, and a Tide menu holding Settings and Quit.
  const macAppMenu = IS_MAC ? [{
    label: app.name,
    submenu: [
      { role: 'about' }, { type: 'separator' },
      item('Settings…', 'Command+,', () => createTab(INTERNAL.settings)),
      { type: 'separator' }, { role: 'services' }, { type: 'separator' },
      { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' }, { type: 'separator' }, { role: 'quit' },
    ],
  }] : [];

  Menu.setApplicationMenu(Menu.buildFromTemplate([
    ...macAppMenu,
    {
      label: 'File',
      submenu: [
        item('New tab', 'CommandOrControl+T', () => createTab(NEWTAB_URL)),
        item('New private tab', 'CommandOrControl+Shift+N', () => openPrivateTab()),
        item('Close tab', 'CommandOrControl+W', () => closeTab(activeId)),
        item('Reopen closed tab', 'CommandOrControl+Shift+T', reopenClosed),
        item('Open file…', 'CommandOrControl+O', openFileDialog),
        item('Save page as…', 'CommandOrControl+S', savePage),
        item('Print…', 'CommandOrControl+P', () => wcOf()?.print()),
        ...(IS_MAC ? [] : [item('Quit', 'CommandOrControl+Shift+Q', () => app.quit())]),
      ],
    },
    { label: 'Edit', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
    {
      label: 'View',
      submenu: [
        item('Focus address bar', 'CommandOrControl+L', focusOmni),
        ...(IS_MAC ? [] : [item('Focus address bar (alt)', 'Alt+D', focusOmni)]), // Option+D types a symbol on a Mac
        item('Focus address bar (F6)', 'F6', focusOmni),
        item('Command bar', 'CommandOrControl+K', () => fx && fx.openCmd()),
        item('Reader view', 'F9', () => { const t = activeTab(); if (t && fx) fx.openReader(t); }),
        item('Find in page', 'CommandOrControl+F', () => { ui.webContents.focus(); ui.webContents.send('find-open'); }),
        item('Reload', 'CommandOrControl+R', () => wcOf()?.reload()),
        item('Reload (F5)', 'F5', () => wcOf()?.reload()),
        item('Hard reload', 'CommandOrControl+Shift+R', () => wcOf()?.reloadIgnoringCache()),
        item('Zoom in', 'CommandOrControl+Plus', () => zoom(0.5)),
        item('Zoom in (=)', 'CommandOrControl+=', () => zoom(0.5)),
        item('Zoom out', 'CommandOrControl+-', () => zoom(-0.5)),
        item('Actual size', 'CommandOrControl+0', () => zoom(0)),
        item('Toggle bookmarks bar', 'CommandOrControl+Shift+B', () => setBookmarksBar(!settings.bookmarksBar)),
        item('Toggle full screen', IS_MAC ? 'Control+Command+F' : 'F11', () => win.setFullScreen(!win.isFullScreen())),
        item('View source', 'CommandOrControl+U', () => { const w = wcOf(); if (w) createTab(`view-source:${w.getURL()}`, { isPrivate: activeTab().private }); }),
        item('Developer tools', 'F12', () => wcOf()?.toggleDevTools()),
        item('Developer tools (alt)', IS_MAC ? 'Alt+Command+I' : 'CommandOrControl+Shift+I', () => wcOf()?.toggleDevTools()),
      ],
    },
    {
      label: 'History',
      submenu: [
        item('Back', IS_MAC ? 'Command+[' : 'Alt+Left', () => { const h = wcOf()?.navigationHistory; if (h?.canGoBack()) h.goBack(); }),
        item('Forward', IS_MAC ? 'Command+]' : 'Alt+Right', () => { const h = wcOf()?.navigationHistory; if (h?.canGoForward()) h.goForward(); }),
        item('Show history', IS_MAC ? 'Command+Y' : 'CommandOrControl+H', () => createTab(HISTORY_URL)),
        item('Bookmark this page', 'CommandOrControl+D', toggleBookmark),
        item('Clear browsing data…', 'CommandOrControl+Shift+Delete', () => createTab(`${INTERNAL.settings}#privacy`)),
        item('Passwords', null, () => createTab(INTERNAL.passwords)),
        item('Fill saved login', 'CommandOrControl+Shift+L', passwordButton),
        item('Import data from another browser…', null, () => createTab(`${INTERNAL.settings}#import`)),
        ...(IS_MAC ? [] : [item('Settings', 'CommandOrControl+,', () => createTab(INTERNAL.settings))]), // on a Mac it lives in the Tide menu
      ],
    },
    {
      label: 'Tabs',
      submenu: [
        item('Next tab', IS_MAC ? 'Control+Tab' : 'CommandOrControl+Tab', () => cycleTab(1)),
        item('Previous tab', IS_MAC ? 'Control+Shift+Tab' : 'CommandOrControl+Shift+Tab', () => cycleTab(-1)),
        item('Next tab (alt)', IS_MAC ? 'Command+Shift+]' : 'CommandOrControl+PageDown', () => cycleTab(1)),
        item('Previous tab (alt)', IS_MAC ? 'Command+Shift+[' : 'CommandOrControl+PageUp', () => cycleTab(-1)),
        ...tabSelectors,
      ],
    },
    ...(IS_MAC ? [{ role: 'windowMenu' }] : []),
  ]));
}

// ======================================================================
// Lifecycle
// ======================================================================
app.on('second-instance', (_e, argv) => {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.focus();
  const url = argv.find((a) => /^https?:\/\//i.test(a));
  if (url) createTab(url);
});

let exitCleared = false;
app.on('before-quit', (e) => {
  flushSaves();
  vault.lock();
  if (settings.clearOnExit && !exitCleared) {
    e.preventDefault();
    exitCleared = true;
    Promise.allSettled([session.defaultSession.clearStorageData(), session.defaultSession.clearCache()]).finally(() => app.quit());
  }
});

// Certificate errors: refuse by default. A site only loads if you chose "proceed" on the warning page.
app.on('certificate-error', (event, _wc, url, _error, _cert, callback) => {
  let host = '';
  try { host = new URL(url).host; } catch { /* ignore */ }
  if (host && certAllow.has(host)) { event.preventDefault(); callback(true); return; }
  callback(false);
});

app.on('web-contents-created', (_e, contents) => {
  contents.on('will-attach-webview', (ev) => ev.preventDefault()); // nothing may embed a <webview>
});

// What features.js needs from the browser. Functions (not copies) so it always sees current state.
function buildFeatureContext() {
  return {
    electron: { ipcMain, Menu, dialog, shell, clipboard, session, net, nativeTheme, WebContentsView, safeStorage },
    settings: () => settings,
    persistSettings, loadJSON, saveJSON, writeNow,
    tabs, wcToTab,
    getOrder: () => order,
    getActiveId: () => activeId,
    activeTab, tabWc,
    getWin: () => win,
    getUi: () => ui,
    contentRect: () => {
      const [W, H] = win.getContentSize();
      const top = TOP_HEIGHT + Math.round(extraOffset);
      return { x: SIDEBAR_W, y: top, w: W - SIDEBAR_W, h: H - top };
    },
    createTab, closeTab, selectTab, togglePin, sendState, toast,
    openPrivateTab, setBookmarksBar, takeScreenshot,
    toggleTheme: () => { settings.theme = nativeTheme.shouldUseDarkColors ? 'light' : 'dark'; persistSettings(); applyTheme(true, null); },
    vault, recall,
    hideSuggest, hidePopover, showPopover,
    lockPanel, guardUi, handleInternal,
    guardScheme: (e, url) => { if (!isSafeScheme(url)) { e.preventDefault(); openExternalSafely(url); } },
    ensurePrivateSession: () => configureSession(session.fromPartition(PRIVATE_PARTITION), true),
    cleanOrigin, isNewTab, normalizeInput, displayUrl, localSuggestions,
    forgetHistoryHost,
    saveDownloads: () => saveJSON('downloads.json', downloads.slice(0, 200)),
    pendingWarn,
    INTERNAL, PRIVATE_PARTITION,
  };
}

handleInternal('updateStatus', () => updater.status());
handleInternal('updateCheck', () => { updater.check(true); return updater.status(); });
handleInternal('updateInstall', () => updater.install());

app.whenReady().then(async () => {
  fx = features.init(buildFeatureContext());
  updater.init({ toast, onChange: sendState, beforeInstall: () => { try { fx.shutdown(); } catch { /* ignore */ } flushSaves(); } });
  nativeTheme.themeSource = settings.theme === 'light' || settings.theme === 'system' ? settings.theme : 'dark';
  configureSession(session.defaultSession, false);
  applySpellcheck();
  applyDns();
  safeBrowsing.start();
  vault.setTimeoutMinutes(settings.pwAutoLockMin);
  vault.onLock = () => { if (pop.visible && pop.mode === 'fill') hidePopover(); toast('Passwords locked'); };
  powerMonitor.on('lock-screen', () => vault.lock());
  powerMonitor.on('suspend', () => vault.lock());
  buildMenu();
  createWindow();
  if (app.isPackaged) { app.setAsDefaultProtocolClient('http'); app.setAsDefaultProtocolClient('https'); }
  for (const x of settings.extensions) await loadExtension(x.path);
});

// On a Mac, closing the last window leaves the app running, and clicking its Dock icon opens a new window.
app.on('window-all-closed', () => { if (!IS_MAC) app.quit(); });
app.on('activate', () => { if (!win && app.isReady()) createWindow(); });
// Links from other apps arrive here on macOS (Windows passes them on the command line).
app.on('open-url', (e, url) => {
  e.preventDefault();
  if (!/^https?:\/\//i.test(url)) return;
  if (win && ui) { if (win.isMinimized()) win.restore(); win.focus(); createTab(url); } else pendingOpenUrl = url;
});

// Read-only handles used by automated tests.
module.exports = {
  _fx: () => fx,
  _state: () => ({ tabs, order, settings, win, wcToTab, activeId, PAGES_URL, INTERNAL }),
  _createTab: (...a) => createTab(...a),
};
