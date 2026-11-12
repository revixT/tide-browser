const card = document.getElementById('card');
const KEY = '<svg viewBox="0 0 24 24"><g fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="15" r="4"/><path d="M11 12.5L20 4M16 8l2.5 2.5M14 10l2 2"/></g></svg>';

const h = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
const btn = (label, cls, fn) => { const b = h('button', cls, label); b.onclick = fn; return b; };
const title = (text) => { const t = h('h1'); t.innerHTML = KEY; t.appendChild(document.createTextNode(text)); return t; };
const site = (origin) => { const s = h('span', 'site', origin.replace(/^https?:\/\//, '')); return s; };
const fit = () => requestAnimationFrame(() => window.pop.size(card.offsetHeight + 18));

function bits(pw) {
  let pool = 0;
  if (/[a-z]/.test(pw)) pool += 26;
  if (/[A-Z]/.test(pw)) pool += 26;
  if (/\d/.test(pw)) pool += 10;
  if (/[^A-Za-z0-9]/.test(pw)) pool += 32;
  return pw.length * Math.log2(Math.max(pool, 2));
}

function render(mode, d) {
  card.textContent = '';
  card.style.animation = 'none';
  void card.offsetWidth;
  card.style.animation = '';

  if (mode === 'unlock') {
    card.appendChild(title('Unlock your passwords'));
    const p = h('p');
    p.append(d.reason === 'save' ? 'Unlock to save the password you just entered for ' : 'Enter your master password to use saved logins');
    if (d.reason === 'save' && d.origin) p.appendChild(site(d.origin));
    card.appendChild(p);
    const input = h('input'); input.type = 'password'; input.placeholder = 'Master password'; input.autocomplete = 'off';
    const err = h('div', 'err');
    const go = btn('Unlock', 'p', async () => {
      go.disabled = true; err.textContent = '';
      const r = await window.pop.action({ type: 'unlock', password: input.value });
      go.disabled = false;
      if (r && !r.ok) { err.textContent = r.wait ? `${r.error} Try again in ${r.wait}s.` : r.error; input.select(); fit(); }
    });
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') go.click(); if (e.key === 'Escape') window.pop.action({ type: 'dismiss' }); });
    card.append(input, err, Object.assign(h('div', 'row'), {}));
    card.lastChild.append(btn('Cancel', 'q', () => window.pop.action({ type: 'dismiss' })), go);
    setTimeout(() => input.focus(), 30);
  } else if (mode === 'create') {
    card.appendChild(title('Protect your passwords'));
    const p = h('p');
    p.append(d.origin ? 'Create a master password to save your login for ' : 'Create a master password. Tide encrypts every saved password with it. ');
    if (d.origin) p.appendChild(site(d.origin));
    p.append(' There is no reset: if you forget it, nobody, including us, can recover your passwords.');
    card.appendChild(p);
    const a = h('input'); a.type = 'password'; a.placeholder = 'Master password (10+ characters)'; a.autocomplete = 'off';
    const meter = h('div', 'meter'); const bar = h('i'); meter.appendChild(bar);
    const hint = h('div', 'hint');
    const b = h('input'); b.type = 'password'; b.placeholder = 'Repeat master password'; b.autocomplete = 'off';
    const err = h('div', 'err');
    a.addEventListener('input', () => {
      const v = bits(a.value); const pct = Math.min(100, Math.round(v / 80 * 100));
      bar.style.width = `${pct}%`; bar.style.background = v < 40 ? 'var(--bad)' : v < 60 ? 'var(--warn)' : 'var(--ok)';
      hint.textContent = !a.value ? '' : v < 40 ? 'Too easy to guess. Try a few random words.' : v < 60 ? 'Okay. A longer phrase is better.' : 'Strong.';
    });
    const go = btn(d.origin ? 'Create and save' : 'Create', 'p', async () => {
      if (a.value !== b.value) { err.textContent = 'The two passwords do not match.'; fit(); return; }
      go.disabled = true; err.textContent = '';
      const r = await window.pop.action({ type: 'create', password: a.value });
      go.disabled = false;
      if (r && !r.ok) { err.textContent = r.error; fit(); }
    });
    b.addEventListener('keydown', (e) => { if (e.key === 'Enter') go.click(); });
    const row = h('div', 'row');
    if (d.origin) row.append(btn("Don't ask again", 'q', () => window.pop.action({ type: 'never-offer' })));
    row.append(btn('Not now', 'q', () => window.pop.action({ type: 'dismiss' })), go);
    card.append(a, meter, hint, b, err, row);
    setTimeout(() => a.focus(), 30);
  } else if (mode === 'save') {
    card.appendChild(title(d.update ? 'Update password?' : 'Save password?'));
    const p = h('p');
    p.append(d.update ? 'Replace the saved password for ' : 'Save the login for ');
    p.appendChild(site(d.origin));
    card.appendChild(p);
    const u = h('div'); u.style.cssText = 'padding:8px 12px;border-radius:12px;background:rgb(var(--ov) / .04);margin-bottom:6px';
    u.append(`${d.username || '(no username)'}   `); u.appendChild(h('span', 'dots', '••••••••'));
    card.appendChild(u);
    const row = h('div', 'row');
    row.append(btn('Never for this site', 'q', () => window.pop.action({ type: 'never' })), btn('Not now', 'q', () => window.pop.action({ type: 'dismiss' })), btn(d.update ? 'Update' : 'Save', 'p', () => window.pop.action({ type: 'save' })));
    card.appendChild(row);
  } else if (mode === 'site') {
    const hh = h('h1');
    hh.innerHTML = KEY.replace(/<circle[^>]*\/><path[^>]*\/>/, '<rect x="5" y="10.5" width="14" height="9.5" rx="2.2"/><path d="M8 10.5V8a4 4 0 0 1 8 0v2.5"/>');
    hh.appendChild(document.createTextNode(d.host));
    const grade = h('span', `grade g${d.grade}`, d.grade);
    grade.title = `Privacy grade ${d.grade} (${d.score}/100). An estimate from the connection, trackers, cookies and permissions.`;
    hh.appendChild(grade);
    card.appendChild(hh);
    const kv = (k, v, cls) => { const r = h('div', 'kv'); r.append(h('span', 'k', k), h('span', `v ${cls || ''}`, v)); card.appendChild(r); return r; };
    kv('Connection', d.https ? 'Secure (https)' : 'Not secure (http)', d.https ? 'ok' : 'bad');
    kv('Trackers and ads stopped', d.blocked ? String(d.blocked) : 'None seen', d.blocked ? 'ok' : '');
    if (d.blockedHosts.length) {
      const chips = h('div', 'chips');
      for (const b of d.blockedHosts) chips.appendChild(h('span', 'chip', `${b.host} ${b.count > 1 ? `x${b.count}` : ''}`.trim()));
      card.appendChild(chips);
    }
    kv('Cookies this site has stored', String(d.cookieCount));
    if (d.perms.length) {
      card.appendChild(h('div', 'sub', 'Saved permissions'));
      for (const p of d.perms) {
        const r = h('div', 'kv');
        r.append(h('span', 'k', p.name), h('span', `v ${p.allow ? 'ok' : 'bad'}`, p.allow ? 'Allowed' : 'Blocked'));
        const x = h('button', 'mini', '✕'); x.title = 'Forget this decision';
        x.onclick = () => window.pop.action({ type: 'site-perm', key: p.key, anchorX: d.anchorX });
        r.appendChild(x); card.appendChild(r);
      }
    }
    const sw = h('label', 'swrow');
    const cb = h('input'); cb.type = 'checkbox'; cb.checked = !d.allowed; cb.disabled = !d.blockOn;
    cb.onchange = () => window.pop.action({ type: 'site-block', anchorX: d.anchorX });
    sw.append(cb, h('span', '', d.blockOn ? 'Block trackers and ads on this site' : 'Blocking is off in Settings'));
    card.appendChild(sw);
    const row = h('div', 'row');
    const forget = h('button', '', 'Forget this site');
    let armed = false;
    forget.onclick = () => {
      if (!armed) { armed = true; forget.textContent = 'Click again to delete its data'; forget.classList.add('danger'); setTimeout(() => { armed = false; forget.textContent = 'Forget this site'; forget.classList.remove('danger'); }, 4000); return; }
      window.pop.action({ type: 'site-forget' });
    };
    row.append(forget, btn('Done', 'p', () => window.pop.action({ type: 'dismiss' })));
    card.appendChild(row);
    card.appendChild(h('p', 'note', 'Forgetting a site deletes its cookies, stored data, saved permissions, zoom, history and Recall entries.'));
  } else if (mode === 'fill') {
    card.appendChild(title('Saved logins'));
    const p = h('p'); p.appendChild(site(d.origin)); card.appendChild(p);
    if (!d.items.length) {
      const none = h('p', '', d.secure ? 'No saved logins for this site yet.' : 'Tide only fills passwords on secure (https) pages.');
      card.appendChild(none);
    }
    d.items.forEach((it, i) => {
      const row = h('div', 'item'); row.style.setProperty('--i', i);
      row.append(h('span', 'u', it.username || '(no username)'), h('span', 'go', 'Fill'));
      row.onclick = () => window.pop.action({ type: 'fill', id: it.id });
      card.appendChild(row);
    });
    const foot = h('div', 'row');
    foot.append(btn('Suggest strong password', 'q', () => window.pop.action({ type: 'generate' })), btn('Manage', 'p', () => window.pop.action({ type: 'manage' })));
    card.appendChild(foot);
  }
  fit();
}

window.pop.onShow(({ mode, data }) => render(mode, data || {}));
window.pop.onHide(() => { card.textContent = ''; });
addEventListener('keydown', (e) => { if (e.key === 'Escape') window.pop.action({ type: 'dismiss' }); });
