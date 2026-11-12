// Network-level privacy features: ad/tracker blocking, HTTPS-only upgrades,
// third-party cookie blocking and the Do-Not-Track / Global Privacy Control headers.
// Electron allows ONE listener per webRequest event per session, so everything lives here.

const BLOCKED_DOMAINS = [
  // advertising
  'doubleclick.net', 'googlesyndication.com', 'googleadservices.com', 'adservice.google.com', 'googletagservices.com',
  'adnxs.com', 'adsrvr.org', 'advertising.com', 'taboola.com', 'outbrain.com', 'criteo.com', 'criteo.net',
  'pubmatic.com', 'rubiconproject.com', 'openx.net', 'casalemedia.com', '33across.com', 'smartadserver.com',
  'yieldmo.com', 'mathtag.com', 'adform.net', 'bidswitch.net', 'sharethrough.com', 'lijit.com', 'indexww.com',
  'amazon-adsystem.com', 'moatads.com', 'adsafeprotected.com', 'serving-sys.com', 'contextweb.com', 'media.net',
  'revcontent.com', 'mgid.com', 'zedo.com', 'teads.tv', 'tapad.com', 'ads-twitter.com', 'ads.linkedin.com',
  // analytics & tracking
  'google-analytics.com', 'googletagmanager.com', 'scorecardresearch.com', 'quantserve.com', 'hotjar.com',
  'mixpanel.com', 'fullstory.com', 'crazyegg.com', 'mouseflow.com', 'segment.io', 'amplitude.com',
  'bluekai.com', 'krxd.net', 'demdex.net', 'everesttech.net', 'omtrdc.net', 'chartbeat.net', 'newrelic.com',
  'branch.io', 'adjust.com', 'appsflyer.com', 'analytics.twitter.com', 'px.ads.linkedin.com', 'bat.bing.com',
  'clarity.ms', 'ct.pinterest.com', 'analytics.tiktok.com', 'pixel.facebook.com',
];
const blocked = new Set(BLOCKED_DOMAINS);

function hostBlocked(host) {
  let h = host;
  while (h) {
    if (blocked.has(h)) return true;
    const i = h.indexOf('.');
    if (i < 0) return false;
    h = h.slice(i + 1);
  }
  return false;
}

const TWO_LEVEL = new Set(['co', 'com', 'org', 'net', 'gov', 'edu', 'ac']);
// Approximate registrable domain (no public-suffix list bundled).
function site(host) {
  const p = host.split('.');
  if (p.length <= 2) return host;
  const last = p[p.length - 1];
  const second = p[p.length - 2];
  if (last.length === 2 && TWO_LEVEL.has(second)) return p.slice(-3).join('.');
  return p.slice(-2).join('.');
}

function isLocal(host) {
  return host === 'localhost' || /^\d+\.\d+\.\d+\.\d+$/.test(host) || host.endsWith('.local') ||
    host.endsWith('.localhost') || host.includes(':');
}

function isThirdParty(d) {
  if (d.resourceType === 'mainFrame') return false;
  let top = '';
  try { top = d.webContents ? d.webContents.getURL() : ''; } catch { /* destroyed */ }
  if (!/^https?:/i.test(top)) return false;
  try { return site(new URL(d.url).hostname) !== site(new URL(top).hostname); } catch { return false; }
}

// Query parameters that exist only to follow you from link to link.
const TRACKING_PARAMS = new Set(['fbclid', 'gclid', 'gclsrc', 'dclid', 'msclkid', 'twclid', 'yclid', 'mc_eid', 'mc_cid', '_hsenc', '_hsmi',
  'igshid', 'ttclid', 'wickedid', 'vero_id', 'oly_enc_id', 'oly_anon_id', 'ck_subscriber_id', 'mkt_tok', 'srsltid', '_ga', '_gl']);
const isTrackingParam = (k) => TRACKING_PARAMS.has(k.toLowerCase()) || /^utm_/i.test(k);

function stripTracking(url) {
  let changed = false;
  for (const k of [...url.searchParams.keys()]) {
    if (isTrackingParam(k)) { url.searchParams.delete(k); changed = true; }
  }
  return changed;
}

function install(ses, { getSettings, tabForWc, onBlocked, checkDangerous, siteAllowed }) {
  ses.webRequest.onBeforeRequest((d, cb) => {
    const s = getSettings();
    let url;
    try { url = new URL(d.url); } catch { return cb({}); }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return cb({});

    if (d.resourceType === 'mainFrame' && checkDangerous) {
      // Cancelling shows our warning page: the caller picks it up from did-fail-load.
      if (checkDangerous(url, d)) return cb({ cancel: true });
    }
    if (s.stripTracking && d.resourceType === 'mainFrame' && url.search && stripTracking(url)) {
      return cb({ redirectURL: url.toString() });
    }
    if (s.httpsOnly && d.resourceType === 'mainFrame' && url.protocol === 'http:' && !isLocal(url.hostname)) {
      url.protocol = 'https:';
      return cb({ redirectURL: url.toString() });
    }
    if (s.blockAds && d.resourceType !== 'mainFrame' && hostBlocked(url.hostname)) {
      const tab = tabForWc(d.webContentsId);
      if (tab && siteAllowed && siteAllowed(tab)) return cb({}); // blocking is turned off for this site
      if (tab) onBlocked(tab, url.hostname);
      return cb({ cancel: true });
    }
    return cb({});
  });

  ses.webRequest.onBeforeSendHeaders((d, cb) => {
    const s = getSettings();
    const h = d.requestHeaders;
    if (s.sendGpc) { h['Sec-GPC'] = '1'; h.DNT = '1'; }
    if (s.blockThirdPartyCookies && isThirdParty(d)) {
      for (const k of Object.keys(h)) if (k.toLowerCase() === 'cookie') delete h[k];
    }
    cb({ requestHeaders: h });
  });

  ses.webRequest.onHeadersReceived((d, cb) => {
    if (getSettings().blockThirdPartyCookies && isThirdParty(d)) {
      const h = { ...d.responseHeaders };
      for (const k of Object.keys(h)) if (k.toLowerCase() === 'set-cookie') delete h[k];
      return cb({ responseHeaders: h });
    }
    return cb({});
  });
}

module.exports = { install, hostBlocked };
