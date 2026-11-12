// Encrypted password vault.
//   - Master password -> scrypt (N=2^17, r=8, p=1) -> 256-bit key. The master password is never stored.
//   - Vault contents are encrypted with AES-256-GCM; the KDF header is authenticated as AAD.
//   - The key lives only in memory while unlocked and is wiped on lock.
//   - Wrong-password attempts are rate limited.
// JavaScript cannot guarantee that decrypted strings are wiped from memory; the vault limits how
// long they stay (auto-lock) and never sends them to a page except on an explicit fill.
const crypto = require('crypto');
const fs = require('fs');
const { promisify } = require('util');

const scrypt = promisify(crypto.scrypt);
const KDF = { N: 131072, r: 8, p: 1, keyLen: 32 };
const MIN_MASTER = 10;
const DAY = 864e5;

const charsets = {
  lower: 'abcdefghijkmnopqrstuvwxyz',
  lowerAmb: 'abcdefghijklmnopqrstuvwxyz',
  upper: 'ABCDEFGHJKLMNPQRSTUVWXYZ',
  upperAmb: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ',
  digits: '23456789',
  digitsAmb: '0123456789',
  symbols: '!@#$%^&*()-_=+[]{};:,.?',
};

function generate(opts = {}) {
  const length = Math.max(8, Math.min(128, Number(opts.length) || 20));
  const amb = !!opts.ambiguous;
  const pools = [];
  if (opts.lower !== false) pools.push(amb ? charsets.lowerAmb : charsets.lower);
  if (opts.upper !== false) pools.push(amb ? charsets.upperAmb : charsets.upper);
  if (opts.digits !== false) pools.push(amb ? charsets.digitsAmb : charsets.digits);
  if (opts.symbols !== false) pools.push(charsets.symbols);
  if (!pools.length) pools.push(charsets.lower);
  const all = pools.join('');
  const chars = pools.map((p) => p[crypto.randomInt(p.length)]); // at least one of each class
  while (chars.length < length) chars.push(all[crypto.randomInt(all.length)]);
  for (let i = chars.length - 1; i > 0; i--) { // Fisher-Yates with a CSPRNG
    const j = crypto.randomInt(i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join('');
}

// Rough strength estimate in bits (length and character classes). Good enough to flag weak passwords.
function strengthBits(pw) {
  if (!pw) return 0;
  let pool = 0;
  if (/[a-z]/.test(pw)) pool += 26;
  if (/[A-Z]/.test(pw)) pool += 26;
  if (/\d/.test(pw)) pool += 10;
  if (/[^A-Za-z0-9]/.test(pw)) pool += 32;
  let bits = pw.length * Math.log2(Math.max(pool, 2));
  if (/^(.)\1+$/.test(pw)) bits = Math.min(bits, 8);
  if (/(password|qwerty|letmein|123456|iloveyou|admin|welcome)/i.test(pw)) bits = Math.min(bits, 28);
  const unique = new Set(pw).size;
  if (unique < pw.length / 2) bits *= 0.7;
  return Math.round(bits);
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let cur = '';
  let q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(cur); cur = ''; }
    else if (c === '\n') { row.push(cur); rows.push(row); row = []; cur = ''; }
    else if (c !== '\r') cur += c;
  }
  if (cur.length || row.length) { row.push(cur); rows.push(row); }
  return rows.filter((r) => r.some((x) => x.length));
}
const csvCell = (s) => {
  let v = String(s == null ? '' : s);
  if (/^[=+\-@\t\r]/.test(v)) v = `'${v}`; // stop spreadsheet formula injection
  return /[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
};

function cleanOrigin(u) {
  try {
    const url = new URL(u);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return '';
    return url.origin;
  } catch { return ''; }
}

class Vault {
  constructor(file) {
    this.file = file;
    this.key = null;
    this.data = null;
    this.hdr = null; // header JSON string (also the AAD)
    this.timer = null;
    this.timeoutMs = 15 * 60 * 1000;
    this.fails = 0;
    this.lockedUntil = 0;
    this.onLock = () => {};
  }

  exists() { return fs.existsSync(this.file); }
  isUnlocked() { return !!this.key; }
  setTimeoutMinutes(min) { this.timeoutMs = min > 0 ? min * 60 * 1000 : 0; this.touch(); }

  touch() {
    clearTimeout(this.timer);
    if (this.key && this.timeoutMs > 0) this.timer = setTimeout(() => this.lock(), this.timeoutMs);
  }

  lock() {
    clearTimeout(this.timer);
    const was = !!this.key;
    if (this.key) this.key.fill(0);
    this.key = null;
    this.data = null;
    if (was) this.onLock();
  }

  async _derive(master, salt, kdf) {
    return scrypt(String(master).normalize('NFKC'), salt, kdf.keyLen, { N: kdf.N, r: kdf.r, p: kdf.p, maxmem: 512 * 1024 * 1024 });
  }

  _seal() {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.key, iv);
    cipher.setAAD(Buffer.from(this.hdr));
    const ct = Buffer.concat([cipher.update(Buffer.from(JSON.stringify(this.data), 'utf8')), cipher.final()]);
    const out = JSON.stringify({ hdr: this.hdr, iv: iv.toString('base64'), ct: ct.toString('base64'), tag: cipher.getAuthTag().toString('base64') });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, out);
    if (fs.existsSync(this.file)) { try { fs.copyFileSync(this.file, `${this.file}.bak`); } catch { /* ignore */ } }
    fs.renameSync(tmp, this.file);
  }

  _open(key, file) {
    const f = JSON.parse(fs.readFileSync(file, 'utf8'));
    const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(f.iv, 'base64'));
    d.setAAD(Buffer.from(f.hdr));
    d.setAuthTag(Buffer.from(f.tag, 'base64'));
    const pt = Buffer.concat([d.update(Buffer.from(f.ct, 'base64')), d.final()]);
    return { data: JSON.parse(pt.toString('utf8')), hdr: f.hdr };
  }

  async create(master) {
    if (this.exists()) return { ok: false, error: 'A vault already exists.' };
    if (typeof master !== 'string' || master.length < MIN_MASTER) return { ok: false, error: `Use at least ${MIN_MASTER} characters.` };
    if (strengthBits(master) < 40) return { ok: false, error: 'That master password is too easy to guess. Add more words or characters.' };
    const salt = crypto.randomBytes(16);
    this.hdr = JSON.stringify({ v: 1, kdf: { ...KDF, salt: salt.toString('base64') } });
    this.key = await this._derive(master, salt, KDF);
    this.data = { entries: [], never: [] };
    this._seal();
    this.touch();
    return { ok: true };
  }

  async unlock(master) {
    if (!this.exists()) return { ok: false, error: 'No vault yet.' };
    const now = Date.now();
    if (now < this.lockedUntil) return { ok: false, wait: Math.ceil((this.lockedUntil - now) / 1000), error: 'Too many attempts.' };
    if (this.key) return { ok: true };
    try {
      const f = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      const hdr = JSON.parse(f.hdr);
      const key = await this._derive(master, Buffer.from(hdr.kdf.salt, 'base64'), hdr.kdf);
      const opened = this._open(key, this.file);
      this.key = key;
      this.data = opened.data;
      this.hdr = opened.hdr;
      this.fails = 0;
      this.touch();
      return { ok: true };
    } catch {
      this.fails++;
      if (this.fails >= 3) this.lockedUntil = Date.now() + Math.min(2 ** (this.fails - 3), 30) * 1000;
      return { ok: false, error: 'Wrong master password.', wait: Math.max(0, Math.ceil((this.lockedUntil - Date.now()) / 1000)) };
    }
  }

  async verify(master) {
    if (!this.key) return false;
    const hdr = JSON.parse(this.hdr);
    const k = await this._derive(master, Buffer.from(hdr.kdf.salt, 'base64'), hdr.kdf);
    const ok = k.length === this.key.length && crypto.timingSafeEqual(k, this.key);
    k.fill(0);
    return ok;
  }

  async changeMaster(oldPw, newPw) {
    if (!this.key) return { ok: false, error: 'Unlock the vault first.' };
    if (!(await this.verify(oldPw))) return { ok: false, error: 'Current master password is wrong.' };
    if (typeof newPw !== 'string' || newPw.length < MIN_MASTER || strengthBits(newPw) < 40) return { ok: false, error: 'The new master password is too weak. Use a longer phrase.' };
    const salt = crypto.randomBytes(16);
    const hdr = JSON.stringify({ v: 1, kdf: { ...KDF, salt: salt.toString('base64') } });
    const key = await this._derive(newPw, salt, KDF);
    this.key.fill(0);
    this.key = key;
    this.hdr = hdr;
    this._seal();
    this.touch();
    return { ok: true };
  }

  reset() {
    this.lock();
    for (const f of [this.file, `${this.file}.bak`, `${this.file}.tmp`]) { try { fs.rmSync(f, { force: true }); } catch { /* ignore */ } }
    this.fails = 0;
    this.lockedUntil = 0;
  }

  _need() { if (!this.key) throw new Error('locked'); this.touch(); }

  // ----- entries -----
  list() {
    this._need();
    return this.data.entries.map(({ id, origin, username, notes, created, updated, used }) => ({ id, origin, username, hasNotes: !!notes, created, updated, used }));
  }
  get(id) { this._need(); return this.data.entries.find((e) => e.id === id) || null; }
  findForOrigin(origin) { this._need(); return this.data.entries.filter((e) => e.origin === origin); }
  findExact(origin, username) { this._need(); return this.data.entries.find((e) => e.origin === origin && e.username === username) || null; }

  add(e) {
    this._need();
    const origin = cleanOrigin(e.origin);
    if (!origin || typeof e.password !== 'string' || !e.password) throw new Error('A site and a password are required.');
    const username = String(e.username || '').slice(0, 300);
    const now = Date.now();
    const existing = this.data.entries.find((x) => x.origin === origin && x.username === username);
    if (existing) {
      existing.password = e.password;
      if (typeof e.notes === 'string') existing.notes = e.notes.slice(0, 2000);
      existing.updated = now;
      this._seal();
      return existing.id;
    }
    const id = crypto.randomUUID();
    this.data.entries.push({ id, origin, username, password: e.password, notes: String(e.notes || '').slice(0, 2000), created: now, updated: now, used: 0 });
    this._seal();
    return id;
  }

  update(id, patch) {
    this._need();
    const e = this.data.entries.find((x) => x.id === id);
    if (!e) throw new Error('Not found.');
    if (patch.origin !== undefined) { const o = cleanOrigin(patch.origin); if (!o) throw new Error('Enter a valid web address.'); e.origin = o; }
    if (patch.username !== undefined) e.username = String(patch.username).slice(0, 300);
    if (patch.password !== undefined && patch.password !== e.password) { if (!patch.password) throw new Error('Password cannot be empty.'); e.password = patch.password; e.updated = Date.now(); }
    if (patch.notes !== undefined) e.notes = String(patch.notes).slice(0, 2000);
    this._seal();
  }

  remove(id) {
    this._need();
    this.data.entries = this.data.entries.filter((e) => e.id !== id);
    this._seal();
  }

  markUsed(id) {
    this._need();
    const e = this.data.entries.find((x) => x.id === id);
    if (e) { e.used = Date.now(); this._seal(); }
  }

  isNever(origin) { this._need(); return this.data.never.includes(origin); }
  addNever(origin) { this._need(); if (!this.data.never.includes(origin)) { this.data.never.push(origin); this._seal(); } }
  clearNever() { this._need(); this.data.never = []; this._seal(); }

  // ----- import / export -----
  importCsv(text) {
    this._need();
    const rows = parseCsv(String(text));
    if (rows.length < 2) return { added: 0, updated: 0, skipped: 0 };
    const head = rows[0].map((h) => h.trim().toLowerCase().replace(/^﻿/, ''));
    const col = (...names) => head.findIndex((h) => names.includes(h));
    const iUrl = col('url', 'origin', 'login_uri', 'website', 'site');
    const iUser = col('username', 'login', 'login_username', 'user');
    const iPass = col('password', 'login_password');
    const iNote = col('note', 'notes');
    if (iUrl < 0 || iPass < 0) throw new Error('This file needs "url" and "password" columns.');
    let added = 0; let updated = 0; let skipped = 0;
    for (const r of rows.slice(1)) {
      const origin = cleanOrigin(r[iUrl] || '');
      const password = r[iPass] || '';
      if (!origin || !password) { skipped++; continue; }
      const username = iUser >= 0 ? (r[iUser] || '') : '';
      const ex = this.data.entries.find((x) => x.origin === origin && x.username === username);
      if (ex) { if (ex.password !== password) { ex.password = password; ex.updated = Date.now(); updated++; } else skipped++; continue; }
      const now = Date.now();
      this.data.entries.push({ id: crypto.randomUUID(), origin, username, password, notes: iNote >= 0 ? (r[iNote] || '').slice(0, 2000) : '', created: now, updated: now, used: 0 });
      added++;
    }
    this._seal();
    return { added, updated, skipped };
  }

  exportCsv() {
    this._need();
    const lines = ['name,url,username,password,note'];
    for (const e of this.data.entries) {
      let name = e.origin;
      try { name = new URL(e.origin).hostname; } catch { /* keep */ }
      lines.push([name, e.origin, e.username, e.password, e.notes].map(csvCell).join(','));
    }
    return `${lines.join('\r\n')}\r\n`;
  }

  // ----- security check -----
  health() {
    this._need();
    const now = Date.now();
    const byPw = new Map();
    for (const e of this.data.entries) {
      const h = crypto.createHash('sha256').update(e.password).digest('hex');
      if (!byPw.has(h)) byPw.set(h, []);
      byPw.get(h).push(e.id);
    }
    const reused = [...byPw.values()].filter((ids) => ids.length > 1).flat();
    const weak = this.data.entries.filter((e) => strengthBits(e.password) < 45).map((e) => e.id);
    const old = this.data.entries.filter((e) => now - e.updated > 365 * DAY).map((e) => e.id);
    return { total: this.data.entries.length, reused, weak, old };
  }

  // SHA-1 prefixes for the Have I Been Pwned range API (k-anonymity: only 5 characters leave the app).
  breachQueries() {
    this._need();
    const map = new Map(); // prefix -> [{suffix, ids}]
    for (const e of this.data.entries) {
      const sha = crypto.createHash('sha1').update(e.password).digest('hex').toUpperCase();
      const prefix = sha.slice(0, 5);
      const suffix = sha.slice(5);
      if (!map.has(prefix)) map.set(prefix, new Map());
      const m = map.get(prefix);
      if (!m.has(suffix)) m.set(suffix, []);
      m.get(suffix).push(e.id);
    }
    return map;
  }
}

module.exports = { Vault, generate, strengthBits, cleanOrigin, MIN_MASTER };
