// Dangerous-site warnings. Downloads a public list of hosts that currently serve malware
// (a community mirror of abuse.ch URLhaus data), caches it on disk and checks navigations against it.
// The list is only downloaded; nothing about your browsing is ever sent anywhere.
const fs = require('fs');
const path = require('path');
const { net } = require('electron');

const LIST_URL = 'https://malware-filter.gitlab.io/malware-filter/urlhaus-filter-hosts-online.txt';
const REFRESH_MS = 12 * 60 * 60 * 1000;
// Exact host match only. Never warn on these even if a mirror lists a path on them.
const NEVER = new Set(['github.com', 'raw.githubusercontent.com', 'githubusercontent.com', 'gitlab.com', 'drive.google.com', 'docs.google.com',
  'dropbox.com', 'onedrive.live.com', 'discord.com', 'cdn.discordapp.com', 'mega.nz', 'sourceforge.net', 'archive.org', 'google.com', 'microsoft.com']);

class SafeBrowsing {
  constructor(dir) {
    this.file = path.join(dir, 'malware-hosts.json');
    this.hosts = new Set();
    this.updated = 0;
    this.timer = null;
    try {
      const j = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      this.hosts = new Set(j.hosts || []);
      this.updated = j.updated || 0;
    } catch { /* first run */ }
  }

  start() {
    if (Date.now() - this.updated > REFRESH_MS) this.refresh();
    this.timer = setInterval(() => this.refresh(), REFRESH_MS);
    this.timer.unref?.();
  }

  async refresh() {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 20000);
    try {
      const res = await net.fetch(LIST_URL, { signal: ctl.signal, credentials: 'omit' });
      if (!res.ok) return;
      const text = await res.text();
      const hosts = new Set();
      for (const line of text.split(/\r?\n/)) {
        const m = /^\s*(?:0\.0\.0\.0|127\.0\.0\.1)\s+(\S+)\s*$/.exec(line);
        if (m && !NEVER.has(m[1].toLowerCase())) hosts.add(m[1].toLowerCase());
      }
      if (hosts.size < 20) return; // a truncated or error response must not wipe a good list
      this.hosts = hosts;
      this.updated = Date.now();
      fs.writeFileSync(this.file, JSON.stringify({ updated: this.updated, hosts: [...hosts] }));
    } catch { /* offline: keep the cached list */ } finally { clearTimeout(t); }
  }

  isDangerous(host) { return this.hosts.has(String(host).toLowerCase()); }
  get count() { return this.hosts.size; }
}

module.exports = { SafeBrowsing };
