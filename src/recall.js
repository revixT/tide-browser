// Recall: search the text of pages you have read. Everything stays on this PC.
//   - Pages are held in an in-memory SQLite full-text index while Tide runs.
//   - On disk there is only an append-only log. Each record is encrypted with AES-256-GCM, and the key is
//     protected by Windows (DPAPI, through Electron safeStorage), so the file is not readable on its own.
//   - Deleting a page or a site writes a "delete" record; the log is rewritten (compacted) from time to time.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { safeStorage } = require('electron');

const MAX_PAGES = 5000;
const MAX_TEXT = 15000;

function ftsQuery(q) {
  const toks = String(q || '').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean).slice(0, 12);
  if (!toks.length) return '';
  return toks.map((t) => `"${t.replace(/"/g, '""')}"*`).join(' ');
}

class Recall {
  constructor(dir) {
    this.logFile = path.join(dir, 'recall.log');
    this.keyFile = path.join(dir, 'recall.key');
    this.db = null;
    this.key = null;
    this.lines = 0;
  }

  available() {
    try { require('node:sqlite'); return safeStorage.isEncryptionAvailable(); } catch { return false; }
  }

  _key() {
    if (this.key) return this.key;
    if (fs.existsSync(this.keyFile)) {
      this.key = Buffer.from(safeStorage.decryptString(fs.readFileSync(this.keyFile)), 'base64');
    } else {
      this.key = crypto.randomBytes(32);
      fs.writeFileSync(this.keyFile, safeStorage.encryptString(this.key.toString('base64')));
    }
    return this.key;
  }

  _enc(obj) {
    const iv = crypto.randomBytes(12);
    const c = crypto.createCipheriv('aes-256-gcm', this._key(), iv);
    const ct = Buffer.concat([c.update(JSON.stringify(obj), 'utf8'), c.final()]);
    return Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64');
  }

  _dec(line) {
    const b = Buffer.from(line, 'base64');
    const d = crypto.createDecipheriv('aes-256-gcm', this._key(), b.subarray(0, 12));
    d.setAuthTag(b.subarray(12, 28));
    return JSON.parse(Buffer.concat([d.update(b.subarray(28)), d.final()]).toString('utf8'));
  }

  _append(rec) {
    fs.appendFileSync(this.logFile, `${this._enc(rec)}\n`);
    this.lines++;
  }

  open() {
    if (this.db) return;
    const { DatabaseSync } = require('node:sqlite');
    this.db = new DatabaseSync(':memory:');
    this.db.exec(`
      CREATE TABLE pages(id INTEGER PRIMARY KEY, url TEXT UNIQUE, host TEXT, title TEXT, body TEXT, time INTEGER);
      CREATE VIRTUAL TABLE fts USING fts5(title, body, content='pages', content_rowid='id', tokenize='unicode61 remove_diacritics 2');
      CREATE TRIGGER pages_ai AFTER INSERT ON pages BEGIN INSERT INTO fts(rowid, title, body) VALUES (new.id, new.title, new.body); END;
      CREATE TRIGGER pages_ad AFTER DELETE ON pages BEGIN INSERT INTO fts(fts, rowid, title, body) VALUES ('delete', old.id, old.title, old.body); END;
    `);
    if (!fs.existsSync(this.logFile)) return;
    for (const line of fs.readFileSync(this.logFile, 'utf8').split('\n')) {
      if (!line) continue;
      this.lines++;
      try { this._apply(this._dec(line)); } catch { /* damaged or foreign record: skip it */ }
    }
    if (this.lines > this.count() * 2 + 400) this.compact();
  }

  _apply(r) {
    if (r.op === 'put') {
      this.db.prepare('DELETE FROM pages WHERE url = ?').run(r.url);
      this.db.prepare('INSERT INTO pages(url, host, title, body, time) VALUES (?,?,?,?,?)').run(r.url, r.host, r.title, r.body, r.time);
    } else if (r.op === 'del') this.db.prepare('DELETE FROM pages WHERE url = ?').run(r.url);
    else if (r.op === 'delhost') this.db.prepare('DELETE FROM pages WHERE host = ? OR host LIKE ?').run(r.host, `%.${r.host}`);
    else if (r.op === 'clear') this.db.exec('DELETE FROM pages');
  }

  put({ url, title, text, time }) {
    this.open();
    let host = '';
    try { host = new URL(url).hostname; } catch { return false; }
    const body = String(text || '').replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT);
    if (body.length < 120) return false;
    const rec = { op: 'put', url, host, title: String(title || url).slice(0, 300), body, time: time || Date.now() };
    this._apply(rec);
    this._append(rec);
    const over = this.count() - MAX_PAGES;
    if (over > 0) {
      for (const row of this.db.prepare('SELECT url FROM pages ORDER BY time ASC LIMIT ?').all(over)) this.remove(row.url);
    }
    return true;
  }

  remove(url) { this.open(); this._apply({ op: 'del', url }); this._append({ op: 'del', url }); }
  removeHost(host) { this.open(); this._apply({ op: 'delhost', host }); this._append({ op: 'delhost', host }); }

  clear() {
    this.open();
    this.db.exec('DELETE FROM pages');
    try { fs.rmSync(this.logFile, { force: true }); } catch { /* ignore */ }
    this.lines = 0;
  }

  count() { return this.db ? this.db.prepare('SELECT COUNT(*) AS n FROM pages').get().n : 0; }

  // q empty: newest pages. Otherwise every word must match (prefix match), best matches first.
  search(q, limit = 30) {
    this.open();
    const fq = ftsQuery(q);
    const lim = Math.max(1, Math.min(100, limit | 0));
    if (!fq) return this.db.prepare('SELECT url, host, title, time, substr(body, 1, 180) AS snip FROM pages ORDER BY time DESC LIMIT ?').all(lim);
    try {
      return this.db.prepare(`
        SELECT p.url, p.host, p.title, p.time, snippet(fts, 1, '[[', ']]', '...', 20) AS snip
        FROM fts JOIN pages p ON p.id = fts.rowid
        WHERE fts MATCH ? ORDER BY bm25(fts, 6.0, 1.0) LIMIT ?`).all(fq, lim);
    } catch { return []; }
  }

  compact() {
    const tmp = `${this.logFile}.tmp`;
    const rows = this.db.prepare('SELECT url, host, title, body, time FROM pages ORDER BY time ASC').all();
    fs.writeFileSync(tmp, rows.map((r) => this._enc({ op: 'put', ...r })).join('\n') + (rows.length ? '\n' : ''));
    fs.renameSync(tmp, this.logFile);
    this.lines = rows.length;
  }
}

module.exports = { Recall, ftsQuery, MAX_TEXT };
