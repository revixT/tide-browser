// Reads history, bookmarks and download lists from other browsers' profile folders.
// Read-only: databases are copied to a temp folder first and the originals are never touched.
const fs = require('fs');
const os = require('os');
const path = require('path');

const LOCAL = process.env.LOCALAPPDATA || '';
const ROAM = process.env.APPDATA || '';
const MAX_HISTORY = 5000;
const WEBKIT_EPOCH_MS = 11644473600000; // 1601-01-01 to 1970-01-01
const COCOA_EPOCH_S = 978307200; // 1970-01-01 to 2001-01-01 (Safari)

const CHROMIUM = {
  chrome: { name: 'Google Chrome', dir: path.join(LOCAL, 'Google', 'Chrome', 'User Data') },
  edge: { name: 'Microsoft Edge', dir: path.join(LOCAL, 'Microsoft', 'Edge', 'User Data') },
  brave: { name: 'Brave', dir: path.join(LOCAL, 'BraveSoftware', 'Brave-Browser', 'User Data') },
};
const FIREFOX_ROOT = path.join(ROAM, 'Mozilla', 'Firefox');

const exists = (p) => { try { return fs.existsSync(p); } catch { return false; } };
const isWeb = (u) => typeof u === 'string' && /^https?:\/\//i.test(u);

// ---------- detection ----------
function chromiumProfiles(dir) {
  if (!exists(dir)) return [];
  let cache = {};
  try { cache = JSON.parse(fs.readFileSync(path.join(dir, 'Local State'), 'utf8')).profile.info_cache || {}; } catch { /* no names */ }
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!e.isDirectory() || (e.name !== 'Default' && !/^Profile \d+$/.test(e.name))) continue;
    const p = path.join(dir, e.name);
    const history = exists(path.join(p, 'History'));
    const bookmarks = exists(path.join(p, 'Bookmarks'));
    if (!history && !bookmarks) continue;
    out.push({ id: e.name, name: (cache[e.name] && cache[e.name].name) || e.name, path: p, history, bookmarks, downloads: history });
  }
  return out;
}

function firefoxProfiles() {
  const ini = path.join(FIREFOX_ROOT, 'profiles.ini');
  if (!exists(ini)) return [];
  const sections = [];
  let cur = null;
  for (const line of fs.readFileSync(ini, 'utf8').split(/\r?\n/)) {
    const sec = /^\[(.+)\]$/.exec(line.trim());
    if (sec) { cur = { _name: sec[1] }; sections.push(cur); continue; }
    const kv = /^([^=]+)=(.*)$/.exec(line);
    if (kv && cur) cur[kv[1].trim()] = kv[2].trim();
  }
  const out = [];
  for (const s of sections) {
    if (!/^Profile/i.test(s._name) || !s.Path) continue;
    const p = s.IsRelative === '0' ? s.Path : path.join(FIREFOX_ROOT, s.Path);
    if (!exists(path.join(p, 'places.sqlite'))) continue;
    out.push({ id: s._name, name: s.Name || s.Path, path: p, history: true, bookmarks: true, downloads: false });
  }
  return out;
}

function detectBrowsers() {
  const list = [];
  for (const [id, b] of Object.entries(CHROMIUM)) {
    const profiles = chromiumProfiles(b.dir);
    if (profiles.length) list.push({ id, name: b.name, profiles });
  }
  const ff = firefoxProfiles();
  if (ff.length) list.push({ id: 'firefox', name: 'Mozilla Firefox', profiles: ff });
  return list;
}

// ---------- sqlite helpers ----------
function openCopy(file) {
  const { DatabaseSync } = require('node:sqlite');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tide-import-'));
  const base = path.join(tmp, 'db.sqlite');
  try {
    fs.copyFileSync(file, base);
  } catch (e) {
    fs.rmSync(tmp, { recursive: true, force: true });
    const err = new Error('locked');
    err.code = 'LOCKED';
    throw err;
  }
  for (const ext of ['-wal', '-shm']) {
    if (exists(file + ext)) { try { fs.copyFileSync(file + ext, base + ext); } catch { /* ignore */ } }
  }
  const db = new DatabaseSync(base);
  return { db, close: () => { try { db.close(); } catch { /* ignore */ } fs.rmSync(tmp, { recursive: true, force: true }); } };
}

function query(file, sql) {
  const h = openCopy(file);
  try {
    const st = h.db.prepare(sql);
    // Chromium stores microsecond timestamps around 1.3e16, past JavaScript's safe integer range.
    // Integers come back as BigInt, and the parsers convert them with Number().
    st.setReadBigInts(true);
    return st.all();
  } finally { h.close(); }
}

// ---------- parsers ----------
function chromiumHistory(profilePath) {
  const rows = query(path.join(profilePath, 'History'),
    `SELECT url, title, last_visit_time FROM urls WHERE last_visit_time > 0 AND hidden = 0 ORDER BY last_visit_time DESC LIMIT ${MAX_HISTORY}`);
  return rows.filter((r) => isWeb(r.url)).map((r) => ({
    url: r.url, title: r.title || r.url, time: Math.round(Number(r.last_visit_time) / 1000 - WEBKIT_EPOCH_MS),
  }));
}

function chromiumBookmarks(profilePath) {
  const root = JSON.parse(fs.readFileSync(path.join(profilePath, 'Bookmarks'), 'utf8')).roots || {};
  const out = [];
  const walk = (node) => {
    if (!node) return;
    if (node.type === 'url' && isWeb(node.url)) out.push({ url: node.url, title: node.name || node.url, favicon: '' });
    (node.children || []).forEach(walk);
  };
  Object.values(root).forEach(walk);
  return out;
}

function chromiumDownloads(profilePath) {
  const rows = query(path.join(profilePath, 'History'),
    'SELECT target_path, tab_url, total_bytes, received_bytes, end_time FROM downloads WHERE state = 1 AND end_time > 0 ORDER BY end_time DESC LIMIT 500');
  return rows.filter((r) => r.target_path).map((r, i) => ({
    id: `imp${Date.now()}${i}`, name: path.basename(r.target_path), path: r.target_path, url: r.tab_url || '',
    state: 'completed', received: Number(r.received_bytes) || 0, total: Number(r.total_bytes) || 0,
    time: Math.round(Number(r.end_time) / 1000 - WEBKIT_EPOCH_MS),
  }));
}

function firefoxHistory(profilePath) {
  const rows = query(path.join(profilePath, 'places.sqlite'),
    `SELECT url, title, last_visit_date FROM moz_places WHERE last_visit_date IS NOT NULL AND url LIKE 'http%' ORDER BY last_visit_date DESC LIMIT ${MAX_HISTORY}`);
  return rows.filter((r) => isWeb(r.url)).map((r) => ({ url: r.url, title: r.title || r.url, time: Math.round(Number(r.last_visit_date) / 1000) }));
}

function firefoxBookmarks(profilePath) {
  const rows = query(path.join(profilePath, 'places.sqlite'),
    "SELECT p.url AS url, b.title AS title FROM moz_bookmarks b JOIN moz_places p ON b.fk = p.id WHERE b.type = 1 AND p.url LIKE 'http%'");
  return rows.filter((r) => isWeb(r.url)).map((r) => ({ url: r.url, title: r.title || r.url, favicon: '' }));
}

function safariHistory(file) {
  const rows = query(file,
    `SELECT i.url AS url, MAX(v.visit_time) AS t,
       (SELECT title FROM history_visits WHERE history_item = i.id ORDER BY visit_time DESC LIMIT 1) AS title
     FROM history_items i JOIN history_visits v ON v.history_item = i.id GROUP BY i.id ORDER BY t DESC LIMIT ${MAX_HISTORY}`);
  return rows.filter((r) => isWeb(r.url)).map((r) => ({ url: r.url, title: r.title || r.url, time: Math.round((Number(r.t) + COCOA_EPOCH_S) * 1000) }));
}

// Netscape bookmarks HTML (what Safari, Chrome, Firefox and Edge export).
function htmlBookmarks(file) {
  const html = fs.readFileSync(file, 'utf8');
  const unesc = (s) => s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
  const out = [];
  const re = /<A\s+[^>]*?HREF="([^"]+)"[^>]*>([\s\S]*?)<\/A>/gi;
  let m;
  while ((m = re.exec(html))) {
    const url = unesc(m[1]);
    if (isWeb(url)) out.push({ url, title: unesc(m[2]).replace(/<[^>]+>/g, '').trim() || url, favicon: '' });
  }
  return out;
}

// ---------- public API ----------
const friendly = (e) => (e.code === 'LOCKED' ? 'The file is in use. Close that browser and try again.' : e.message || 'Could not read the data.');

// what: { history, bookmarks, downloads }. Returns { history, bookmarks, downloads, errors }.
function importFromProfile(browserId, profile, what) {
  const out = { history: [], bookmarks: [], downloads: [], errors: [] };
  const run = (key, label, fn) => {
    if (!what[key]) return;
    try { out[key] = fn(); } catch (e) { out.errors.push(`${label}: ${friendly(e)}`); }
  };
  if (browserId === 'firefox') {
    run('history', 'History', () => firefoxHistory(profile.path));
    run('bookmarks', 'Bookmarks', () => firefoxBookmarks(profile.path));
  } else {
    run('history', 'History', () => chromiumHistory(profile.path));
    run('bookmarks', 'Bookmarks', () => chromiumBookmarks(profile.path));
    run('downloads', 'Download history', () => chromiumDownloads(profile.path));
  }
  return out;
}

// Files picked by the user: bookmarks .html (Safari export and others) or Safari's History.db.
function importFromFiles(files) {
  const out = { history: [], bookmarks: [], downloads: [], errors: [] };
  for (const f of files) {
    const name = path.basename(f);
    try {
      if (/\.html?$/i.test(name)) out.bookmarks.push(...htmlBookmarks(f));
      else if (/\.(db|sqlite)$/i.test(name)) out.history.push(...safariHistory(f));
      else out.errors.push(`${name}: not a supported file (use a bookmarks .html export or Safari's History.db).`);
    } catch (e) { out.errors.push(`${name}: ${friendly(e)}`); }
  }
  return out;
}

module.exports = { detectBrowsers, importFromProfile, importFromFiles };
