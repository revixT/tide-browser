// Reader view: find the main article on a page and return it as plain blocks (never raw HTML),
// so the reader page can draw it safely.
// EXTRACT_SRC runs inside the web page (through webContents.executeJavaScript) and returns:
//   { ok, title, byline, site, blocks: [{ t: 'h2'|'h3'|'p'|'li'|'quote'|'pre'|'img', text?, src?, alt? }] }
const EXTRACT_SRC = `(() => {
  const BAD = 'script,style,noscript,nav,aside,footer,header,form,iframe,svg,button,select,dialog,[role="navigation"],[role="banner"],[role="complementary"],[aria-hidden="true"],.ad,.ads,.advert,.advertisement,.cookie,.popup,.newsletter,.share,.social,.related,.comments,.sidebar,.menu';
  const inBad = (el) => !!el.closest(BAD);
  const text = (el) => (el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim();

  // score every container by the paragraph text it holds
  const score = new Map();
  for (const p of document.querySelectorAll('p')) {
    if (inBad(p)) continue;
    const t = text(p);
    if (t.length < 25) continue;
    let node = p.parentElement;
    let weight = 1;
    for (let depth = 0; node && depth < 3; depth++, node = node.parentElement) {
      score.set(node, (score.get(node) || 0) + t.length * weight);
      weight *= 0.5;
    }
  }
  let best = null;
  let bestScore = 0;
  for (const [el, s] of score) {
    const links = [...el.querySelectorAll('a')].reduce((n, a) => n + text(a).length, 0);
    const total = text(el).length || 1;
    const adjusted = s * (1 - Math.min(0.9, links / total));
    const boost = el.matches('article, main, [role="main"], [itemprop="articleBody"]') ? 1.3 : 1;
    if (adjusted * boost > bestScore) { bestScore = adjusted * boost; best = el; }
  }
  if (!best || bestScore < 300) return { ok: false };

  const abs = (u) => { try { return new URL(u, location.href).href; } catch { return ''; } };
  const blocks = [];
  let last = '';
  for (const el of best.querySelectorAll('h1,h2,h3,h4,p,li,blockquote,pre,img')) {
    if (inBad(el)) continue;
    const tag = el.tagName.toLowerCase();
    if (tag === 'img') {
      const src = abs(el.currentSrc || el.src || '');
      const w = el.naturalWidth || el.width || 0;
      if (/^https?:/.test(src) && w >= 200) blocks.push({ t: 'img', src, alt: (el.alt || '').slice(0, 200) });
      continue;
    }
    if (tag === 'p' && el.closest('blockquote')) continue;
    if (tag === 'li' && el.querySelector('p')) continue;
    const t = text(el);
    if (t.length < 2 || t === last) continue;
    last = t;
    const type = tag === 'h1' || tag === 'h2' ? 'h2' : tag === 'h3' || tag === 'h4' ? 'h3' : tag === 'blockquote' ? 'quote' : tag;
    blocks.push({ t: type, text: t.slice(0, 4000) });
    if (blocks.length >= 500) break;
  }
  if (blocks.filter((b) => b.t === 'p').length < 2) return { ok: false };

  const meta = (n) => (document.querySelector('meta[name="' + n + '"], meta[property="' + n + '"]') || {}).content || '';
  const h1 = document.querySelector('h1');
  return {
    ok: true,
    title: (meta('og:title') || (h1 ? text(h1) : '') || document.title || '').slice(0, 300),
    byline: (meta('author') || meta('article:author') || '').slice(0, 200),
    site: location.hostname.replace(/^www\\./, ''),
    blocks,
  };
})()`;

// Cut a paragraph into sentences for read-aloud highlighting.
function sentences(text) {
  const parts = String(text).match(/[^.!?]+(?:[.!?]+["')\]]*|$)\s*/g);
  return (parts || [text]).map((s) => s.trim()).filter(Boolean);
}

module.exports = { EXTRACT_SRC, sentences };
